'use strict';

const {
  DELIVERY_CONTEXT_FIELD,
  TARGET_KINDS,
  UUID_PATTERN,
  PerformanceFeishuContractError,
  decorateRecords,
  readContext
} = require('./performance_feishu_contract');

const RECONCILIATION_CODES = new Set([
  'FEISHU_PROVIDER_UNAVAILABLE',
  'FEISHU_WRITE_RESULT_INCOMPLETE',
  'FEISHU_OUTBOX_FINALIZATION_FAILED',
  'FEISHU_OUTBOX_RECEIPT_INVALID'
]);

class PerformanceFeishuDeliveryServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceFeishuDeliveryServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new PerformanceFeishuDeliveryServiceError(statusCode, code, message, details);
}

function operationId(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(normalized)) {
    throw serviceError(400, 'PERFORMANCE_FEISHU_IDEMPOTENCY_REQUIRED', 'A UUID Idempotency-Key is required for performance Feishu delivery.');
  }
  return normalized;
}

function targetKind(body) {
  if (body === undefined) return 'current_state';
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) {
    throw serviceError(400, 'PERFORMANCE_FEISHU_REQUEST_INVALID', 'Performance Feishu delivery body is invalid.');
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'snapshot_kind') ||
      (body.snapshot_kind !== undefined && !TARGET_KINDS.includes(body.snapshot_kind))) {
    throw serviceError(400, 'PERFORMANCE_FEISHU_REQUEST_INVALID', 'snapshot_kind must be current_state or daily_snapshot.');
  }
  return body.snapshot_kind || 'current_state';
}

function providerFailure(error) {
  const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{3,100}$/.test(error.code)
    ? error.code
    : 'FEISHU_SYNC_FAILED';
  return {
    code,
    statusCode: Number.isSafeInteger(error && error.statusCode) ? error.statusCode : 502,
    message: error && error.message ? error.message : 'Feishu performance delivery failed.'
  };
}

function isReconciliationRequired(failure) {
  return RECONCILIATION_CODES.has(failure.code);
}

function persistenceErrorCode(error) {
  if (error && typeof error.code === 'string' && /^[A-Z0-9_]{3,100}$/.test(error.code)) {
    return error.code;
  }
  return 'FEISHU_PERFORMANCE_RETRY_INVALID';
}

function deliveryBody(result, delivery) {
  return {
    configured: true,
    mode: result.mode,
    target_kind: result.target_kind,
    synced: result.synced,
    records: result.records,
    delivery
  };
}

function createPerformanceFeishuDeliveryService(options = {}) {
  const projectionService = options.projectionService;
  const connectionService = options.connectionService;
  const feishuClient = options.feishuClient;
  const outboxService = options.outboxService;
  if (!projectionService || typeof projectionService.prepareDelivery !== 'function') {
    throw new TypeError('A performance Feishu projection service is required.');
  }
  if (!connectionService || typeof connectionService.getDeliveryConfiguration !== 'function') {
    throw new TypeError('A performance Feishu connection service is required.');
  }
  if (!feishuClient || typeof feishuClient.syncPerformanceSnapshot !== 'function') {
    throw new TypeError('A performance Feishu client is required.');
  }
  if (!outboxService || typeof outboxService.reserve !== 'function' ||
      typeof outboxService.complete !== 'function' || typeof outboxService.fail !== 'function' ||
      typeof outboxService.retry !== 'function') {
    throw new TypeError('A Feishu Bitable outbox service is required.');
  }

  function reserveDelivery(input, records, target) {
    return outboxService.reserve({
      userId: input.userId,
      campaignId: input.campaignId,
      operationId: input.operationId,
      records
    });
  }

  function replayResult(reservation) {
    if (reservation.state === 'replay') {
      return {
        statusCode: 200,
        body: {
          configured: true,
          replayed: true,
          synced: reservation.delivery.record_count,
          records: reservation.delivery.record_count,
          delivery: reservation.delivery
        }
      };
    }
    if (reservation.state === 'failed') {
      return {
        statusCode: 409,
        body: {
          error: 'This performance Feishu delivery previously failed. Use the explicit retry workflow.',
          code: 'PERFORMANCE_FEISHU_RETRY_REQUIRED',
          delivery: reservation.delivery
        }
      };
    }
    if (reservation.state === 'processing') {
      return {
        statusCode: 202,
        body: {
          error: 'This performance Feishu delivery requires reconciliation before another write is attempted.',
          code: 'PERFORMANCE_FEISHU_RECONCILIATION_REQUIRED',
          delivery: reservation.delivery
        }
      };
    }
    return null;
  }

  async function execute(input, configuration, reservation, targetKindValue) {
    let result;
    try {
      result = await feishuClient.syncPerformanceSnapshot({
        configuration,
        records: reservation.records || input.records,
        operationId: input.operationId,
        targetKind: targetKindValue
      });
    } catch (caught) {
      const failure = providerFailure(caught);
      if (isReconciliationRequired(failure)) {
        return {
          statusCode: 202,
          body: {
            error: 'Performance Feishu delivery requires reconciliation before another write is attempted.',
            code: 'PERFORMANCE_FEISHU_RECONCILIATION_REQUIRED',
            delivery: reservation.delivery
          }
        };
      }
      const delivery = outboxService.fail({
        deliveryId: reservation.delivery.id,
        reservationToken: reservation.reservationToken,
        errorCode: failure.code
      });
      throw Object.assign(caught, { delivery });
    }

    if (!result || result.configured !== true) {
      const delivery = outboxService.fail({
        deliveryId: reservation.delivery.id,
        reservationToken: reservation.reservationToken,
        errorCode: 'FEISHU_BITABLE_WRITE_NOT_AVAILABLE'
      });
      return {
        statusCode: 200,
        body: {
          configured: false,
          mode: result && result.mode || 'performance_bitable',
          records: result && result.records || reservation.delivery.record_count,
          message: result && result.message || 'Performance Feishu Bitable write is not available. CSV fallback is ready for manual upload.',
          delivery
        }
      };
    }

    let delivery;
    try {
      delivery = outboxService.complete({
        deliveryId: reservation.delivery.id,
        reservationToken: reservation.reservationToken,
        remoteRecordIds: result.remoteRecordIds
      });
    } catch (caught) {
      const failure = providerFailure(caught);
      return {
        statusCode: 202,
        body: {
          error: 'Performance Feishu delivery requires reconciliation before another write is attempted.',
          code: 'PERFORMANCE_FEISHU_RECONCILIATION_REQUIRED',
          delivery: reservation.delivery,
          failure_code: failure.code
        }
      };
    }
    return { statusCode: 200, body: deliveryBody(result, delivery) };
  }

  async function sync(input = {}) {
    const normalizedOperationId = operationId(input.operationId);
    const selectedTargetKind = targetKind(input.body);
    const prepared = projectionService.prepareDelivery({
      userId: input.userId,
      campaignId: input.campaignId,
      targetKind: selectedTargetKind
    });
    const records = decorateRecords(prepared.records, {
      schema_version: 1,
      configuration_id: prepared.configuration.id,
      configuration_version: prepared.configuration.version,
      target_kind: selectedTargetKind
    });
    const reservation = reserveDelivery({ ...input, operationId: normalizedOperationId }, records, selectedTargetKind);
    const replay = replayResult(reservation);
    if (replay) return replay;
    return execute({ ...input, operationId: normalizedOperationId, records }, prepared.configuration, {
      ...reservation,
      records
    }, selectedTargetKind);
  }

  async function retry(input = {}) {
    const normalizedOperationId = operationId(input.operationId);
    if (typeof input.reason !== 'string' || !input.reason.trim()) {
      throw serviceError(400, 'PERFORMANCE_FEISHU_RETRY_REASON_INVALID', 'A retry reason is required.');
    }
    const reservation = outboxService.retry({
      userId: input.userId,
      campaignId: input.campaignId,
      deliveryId: input.deliveryId,
      operationId: normalizedOperationId,
      reason: input.reason
    });
    const replay = replayResult(reservation);
    if (replay) return replay;
    let context;
    let configuration;
    try {
      context = readContext(reservation.records);
      configuration = connectionService.getDeliveryConfiguration({
        userId: input.userId,
        campaignId: input.campaignId,
        configurationId: context.configuration_id
      });
      if (Number(configuration.version) !== context.configuration_version) {
        throw new PerformanceFeishuContractError(
          'PERFORMANCE_FEISHU_DELIVERY_CONTEXT_INVALID',
          'The approved Feishu mapping version is unavailable for retry.'
        );
      }
    } catch (caught) {
      const delivery = outboxService.fail({
        deliveryId: reservation.delivery.id,
        reservationToken: reservation.reservationToken,
        errorCode: persistenceErrorCode(caught)
      });
      throw Object.assign(caught, { delivery });
    }
    return execute({ ...input, operationId: normalizedOperationId }, configuration, reservation, context.target_kind);
  }

  return Object.freeze({ sync, retry });
}

module.exports = {
  DELIVERY_CONTEXT_FIELD,
  PerformanceFeishuDeliveryServiceError,
  createPerformanceFeishuDeliveryService
};
