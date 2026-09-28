'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DELIVERY_CONTEXT_FIELD,
  createPerformanceFeishuDeliveryService
} = require('../services/performance_feishu_delivery_service');

const OPERATION_ID = 'd6c42da2-1c45-45db-9cbe-1bd06d5250b5';
const CONFIGURATION = Object.freeze({
  id: 11,
  version: 2,
  status: 'approved',
  bitable_app_token: 'basc_perf',
  current_table_id: 'tbl_current',
  daily_snapshot_table_id: 'tbl_daily',
  field_mapping: Object.freeze({
    'content.original_url': '视频链接',
    'latest_observation.observed_at': '观测时间'
  })
});

function delivery(id, status) {
  return {
    id,
    campaign_id: 7,
    status,
    record_count: 1,
    remote_record_count: status === 'succeeded' ? 1 : 0,
    last_error_code: null
  };
}

function createFixture(overrides = {}) {
  const calls = [];
  const projectionService = overrides.projectionService || {
    prepareDelivery(input) {
      calls.push(['prepare', input]);
      return {
        target_kind: input.targetKind,
        configuration: CONFIGURATION,
        records: [{ fields: { 视频链接: 'https://example.test/video', 观测时间: '2026-09-28T00:00:00.000Z' } }]
      };
    }
  };
  const outboxService = overrides.outboxService || {
    reserve(input) {
      calls.push(['reserve', input]);
      return { state: 'reserved', reservationToken: 'a'.repeat(64), delivery: delivery(31, 'pending') };
    },
    complete(input) {
      calls.push(['complete', input]);
      return delivery(31, 'succeeded');
    },
    fail(input) {
      calls.push(['fail', input]);
      return { ...delivery(31, 'failed'), last_error_code: input.errorCode };
    },
    retry(input) {
      calls.push(['retry', input]);
      return {
        state: 'reserved',
        reservationToken: 'b'.repeat(64),
        delivery: delivery(32, 'pending'),
        records: [{
          fields: {
            视频链接: 'https://example.test/video',
            观测时间: '2026-09-28T00:00:00.000Z',
            [DELIVERY_CONTEXT_FIELD]: JSON.stringify({
              schema_version: 1,
              configuration_id: 11,
              configuration_version: 2,
              target_kind: 'daily_snapshot'
            })
          }
        }]
      };
    }
  };
  const connectionService = overrides.connectionService || {
    getDeliveryConfiguration(input) {
      calls.push(['configuration', input]);
      return CONFIGURATION;
    }
  };
  const feishuClient = overrides.feishuClient || {
    async syncPerformanceSnapshot(input) {
      calls.push(['provider', input]);
      return { configured: true, mode: 'bitable', target_kind: input.targetKind, synced: 1, records: 1, remoteRecordIds: ['rec_perf_1'] };
    }
  };
  const service = createPerformanceFeishuDeliveryService({
    projectionService,
    connectionService,
    feishuClient,
    outboxService
  });
  return { calls, service };
}

test('performance sync persists the approved mapping context in the outbox and completes the Feishu receipt', async () => {
  const { calls, service } = createFixture();

  const result = await service.sync({
    userId: 9,
    campaignId: 7,
    operationId: OPERATION_ID,
    body: { snapshot_kind: 'daily_snapshot' }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.configured, true);
  assert.equal(result.body.delivery.status, 'succeeded');
  assert.deepEqual(calls[0], ['prepare', { userId: 9, campaignId: 7, targetKind: 'daily_snapshot' }]);
  assert.equal(calls[1][0], 'reserve');
  assert.equal(calls[1][1].records[0].fields[DELIVERY_CONTEXT_FIELD], JSON.stringify({
    schema_version: 1,
    configuration_id: 11,
    configuration_version: 2,
    target_kind: 'daily_snapshot'
  }));
  assert.equal(calls[2][0], 'provider');
  assert.equal(calls[2][1].configuration, CONFIGURATION);
  assert.equal(calls[3][0], 'complete');
  assert.deepEqual(calls[3][1].remoteRecordIds, ['rec_perf_1']);
});

test('performance sync returns a pending reconciliation result when the provider outcome is ambiguous', async () => {
  const { calls, service } = createFixture({
    feishuClient: {
      async syncPerformanceSnapshot() {
        const error = new Error('provider unavailable');
        error.name = 'FeishuClientError';
        error.code = 'FEISHU_PROVIDER_UNAVAILABLE';
        error.statusCode = 502;
        throw error;
      }
    }
  });

  const result = await service.sync({ userId: 9, campaignId: 7, operationId: OPERATION_ID, body: {} });

  assert.equal(result.statusCode, 202);
  assert.equal(result.body.code, 'PERFORMANCE_FEISHU_RECONCILIATION_REQUIRED');
  assert.equal(calls.some(([name]) => name === 'fail'), false);
});

test('performance retry reuses the configuration version captured in the original snapshot', async () => {
  const { calls, service } = createFixture();

  const result = await service.retry({
    userId: 9,
    campaignId: 7,
    deliveryId: 31,
    operationId: OPERATION_ID,
    reason: '已确认飞书未重复写入',
    configurationId: 11
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.delivery.status, 'succeeded');
  assert.deepEqual(calls.find(([name]) => name === 'configuration'), ['configuration', {
    userId: 9,
    campaignId: 7,
    configurationId: 11
  }]);
  assert.equal(calls.filter(([name]) => name === 'provider').length, 1);
});

test('performance sync finalizes an unconfigured provider as a CSV-fallback failure without writing externally', async () => {
  const { calls, service } = createFixture({
    feishuClient: {
      async syncPerformanceSnapshot() {
        return {
          configured: false,
          mode: 'performance_bitable',
          records: 1,
          message: 'Performance Feishu Bitable write is not enabled.'
        };
      }
    }
  });

  const result = await service.sync({ userId: 9, campaignId: 7, operationId: OPERATION_ID, body: {} });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.configured, false);
  assert.equal(result.body.delivery.status, 'failed');
  assert.equal(result.body.delivery.last_error_code, 'FEISHU_BITABLE_WRITE_NOT_AVAILABLE');
  assert.equal(calls.some(([name]) => name === 'complete'), false);
});

test('performance retry finalizes a failed receipt when its approved mapping is no longer available', async () => {
  const { calls, service } = createFixture({
    connectionService: {
      getDeliveryConfiguration() {
        const error = new Error('approved mapping unavailable');
        error.code = 'PERFORMANCE_FEISHU_CONNECTION_NOT_APPROVED';
        error.statusCode = 409;
        throw error;
      }
    }
  });

  await assert.rejects(
    service.retry({
      userId: 9,
      campaignId: 7,
      deliveryId: 31,
      operationId: OPERATION_ID,
      reason: '映射版本已失效，记录失败原因'
    }),
    (error) => error.code === 'PERFORMANCE_FEISHU_CONNECTION_NOT_APPROVED' &&
      error.delivery && error.delivery.status === 'failed'
  );
  assert.equal(calls.some(([name]) => name === 'provider'), false);
  assert.equal(calls.filter(([name]) => name === 'fail').length, 1);
});
