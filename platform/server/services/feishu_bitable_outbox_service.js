'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');

const { canonicalJsonBytes } = require('./sqlite_digest_service');
const { getCampaignAccess } = require('./campaign_access_service');

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{3,100}$/;
const MAX_RECORDS = 500;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_RETRY_REASON_LENGTH = 280;
const SAFE_RETRY_FAILURE_CODES = new Set([
  'FEISHU_BITABLE_WRITE_NOT_AVAILABLE',
  'FEISHU_BITABLE_SCHEMA_MISMATCH',
  'FEISHU_IDEMPOTENCY_REQUIRED',
  'FEISHU_BATCH_LIMIT_EXCEEDED',
  'FEISHU_OUTBOX_SNAPSHOT_INVALID',
  'FEISHU_OUTBOX_RECORDS_INVALID',
  'FEISHU_OUTBOX_PAYLOAD_TOO_LARGE'
]);

class FeishuBitableOutboxError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'FeishuBitableOutboxError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function error(statusCode, code, message) {
  return new FeishuBitableOutboxError(statusCode, code, message);
}

function positiveInteger(value) {
  if (Number.isSafeInteger(value) && value > 0 && value <= SAFE_MAX) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value) return parsed;
  }
  return null;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function snapshotPayload(records) {
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_RECORDS) {
    throw error(422, 'FEISHU_OUTBOX_RECORDS_INVALID', 'Feishu Bitable delivery records are invalid.');
  }
  for (const record of records) {
    if (!plainObject(record) || Object.keys(record).length !== 1 || !Object.hasOwn(record, 'fields') || !plainObject(record.fields)) {
      throw error(422, 'FEISHU_OUTBOX_RECORDS_INVALID', 'Feishu Bitable delivery records are invalid.');
    }
    const fieldNames = Object.keys(record.fields);
    if (fieldNames.length < 1 || fieldNames.length > 20 || fieldNames.some(function(name) {
      return typeof name !== 'string' || name.length < 1 || name.length > 200;
    })) {
      throw error(422, 'FEISHU_OUTBOX_RECORDS_INVALID', 'Feishu Bitable delivery records are invalid.');
    }
  }
  let bytes;
  try {
    bytes = canonicalJsonBytes(records);
  } catch (caught) {
    throw error(422, 'FEISHU_OUTBOX_RECORDS_INVALID', 'Feishu Bitable delivery records are invalid.');
  }
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw error(413, 'FEISHU_OUTBOX_PAYLOAD_TOO_LARGE', 'Feishu Bitable delivery payload is too large.');
  }
  const json = bytes.toString('utf8');
  let normalized;
  try {
    normalized = JSON.parse(json);
  } catch (caught) {
    throw error(422, 'FEISHU_OUTBOX_RECORDS_INVALID', 'Feishu Bitable delivery records are invalid.');
  }
  return Object.freeze({
    json,
    hash: crypto.createHash('sha256').update('turingmarket.feishu-bitable-outbox.v1\u0000').update(bytes).digest('hex'),
    recordCount: normalized.length
  });
}

function requireCampaignWrite(db, userId, campaignId) {
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) {
    throw error(access.status || 403, access.code || 'CAMPAIGN_FORBIDDEN', 'Campaign access is unavailable.');
  }
  if (!access.permissions.write) {
    throw error(
      409,
      access.campaign.operational_status === 'cancelled' ? 'CAMPAIGN_CANCELLED' : 'CAMPAIGN_ON_HOLD',
      'Campaign is not writable.'
    );
  }
  return access;
}

function requireCampaignRead(db, userId, campaignId) {
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) {
    throw error(access.status || 403, access.code || 'CAMPAIGN_FORBIDDEN', 'Campaign access is unavailable.');
  }
  return access;
}

function requireCampaignReconciliationAccess(db, userId, campaignId) {
  const access = requireCampaignRead(db, userId, campaignId);
  if (access.role !== 'owner' && access.role !== 'org_admin') {
    throw error(403, 'FEISHU_OUTBOX_RECONCILIATION_FORBIDDEN', 'Feishu delivery reconciliation is not available.');
  }
  return access;
}

function requireCampaignRetryAccess(db, userId, campaignId) {
  const access = requireCampaignWrite(db, userId, campaignId);
  if (access.role !== 'owner' && access.role !== 'org_admin') {
    throw error(403, 'FEISHU_OUTBOX_RETRY_FORBIDDEN', 'Feishu delivery retry is not available.');
  }
  return access;
}

function retryReason(value) {
  if (typeof value !== 'string') {
    throw error(400, 'FEISHU_OUTBOX_RETRY_REASON_INVALID', 'A retry reason is required.');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_RETRY_REASON_LENGTH) {
    throw error(400, 'FEISHU_OUTBOX_RETRY_REASON_INVALID', 'A retry reason is required.');
  }
  return normalized;
}

function retryableFailure(errorCode) {
  return SAFE_RETRY_FAILURE_CODES.has(errorCode || '');
}

function parseRemoteRecordIds(value, expectedCount) {
  if (!Array.isArray(value) || value.length !== expectedCount || value.some(function(id) {
    return typeof id !== 'string' || id.length < 1 || id.length > 255;
  }) || new Set(value).size !== expectedCount) {
    throw error(502, 'FEISHU_OUTBOX_RECEIPT_INVALID', 'Feishu did not confirm every record in the batch.');
  }
  return value.slice();
}

function publicDelivery(row) {
  let remoteIds = [];
  try {
    remoteIds = JSON.parse(row.remote_record_ids_json);
  } catch (caught) {
    throw error(500, 'FEISHU_OUTBOX_PERSISTENCE_FAILED', 'Feishu delivery record is invalid.');
  }
  if (!Array.isArray(remoteIds)) {
    throw error(500, 'FEISHU_OUTBOX_PERSISTENCE_FAILED', 'Feishu delivery record is invalid.');
  }
  const delivery = {
    id: Number(row.id),
    campaign_id: Number(row.campaign_id),
    status: row.status,
    record_count: Number(row.record_count),
    remote_record_count: remoteIds.length,
    last_error_code: row.last_error_code || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
    failed_at: row.failed_at || null
  };
  if (row.retry_of_delivery_id !== undefined && row.retry_of_delivery_id !== null) {
    delivery.retry_of_delivery_id = Number(row.retry_of_delivery_id);
  }
  if (row.retry_delivery_id !== undefined && row.retry_delivery_id !== null) {
    delivery.retry_delivery_id = Number(row.retry_delivery_id);
  }
  if (row.status === 'failed') {
    delivery.retry_available = retryableFailure(row.last_error_code) && !delivery.retry_delivery_id;
  }
  return delivery;
}

function createFeishuBitableOutboxService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('Feishu Bitable outbox requires a database.');
  }

  function readExisting(access, userId, operationId) {
    return db.prepare(`
      SELECT *
      FROM feishu_bitable_outbox
      WHERE org_id=? AND actor_user_id=? AND operation_id=?
      LIMIT 1
    `).get(access.organization.id, userId, operationId) || null;
  }

  function readPublicDelivery(deliveryId) {
    const row = db.prepare(`
      SELECT delivery.*,
        retry_source.failed_delivery_id AS retry_of_delivery_id,
        retry_child.retry_delivery_id AS retry_delivery_id
      FROM feishu_bitable_outbox delivery
      LEFT JOIN feishu_bitable_outbox_retries retry_source
        ON retry_source.retry_delivery_id=delivery.id
      LEFT JOIN feishu_bitable_outbox_retries retry_child
        ON retry_child.failed_delivery_id=delivery.id
      WHERE delivery.id=?
      LIMIT 1
    `).get(deliveryId);
    if (!row) {
      throw error(500, 'FEISHU_OUTBOX_PERSISTENCE_FAILED', 'Feishu delivery record is invalid.');
    }
    return publicDelivery(row);
  }

  function insertReservation(access, userId, campaignId, operationId, payload) {
    const reservationToken = crypto.randomBytes(32).toString('hex');
    const insert = db.prepare(`
      INSERT INTO feishu_bitable_outbox (
        org_id,campaign_id,actor_user_id,operation_id,reservation_token,
        payload_sha256,payload_json,record_count
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      access.organization.id,
      campaignId,
      userId,
      operationId,
      reservationToken,
      payload.hash,
      payload.json,
      payload.recordCount
    );
    return Object.freeze({
      reservationToken,
      row: db.prepare('SELECT * FROM feishu_bitable_outbox WHERE id=?').get(insert.lastInsertRowid)
    });
  }

  function storedPayload(row) {
    let records;
    try {
      records = JSON.parse(row.payload_json);
    } catch (caught) {
      throw error(500, 'FEISHU_OUTBOX_PERSISTENCE_FAILED', 'Feishu delivery record is invalid.');
    }
    const payload = snapshotPayload(records);
    if (payload.hash !== row.payload_sha256 || payload.recordCount !== Number(row.record_count)) {
      throw error(500, 'FEISHU_OUTBOX_PERSISTENCE_FAILED', 'Feishu delivery record is invalid.');
    }
    return Object.freeze({
      hash: payload.hash,
      json: payload.json,
      recordCount: payload.recordCount,
      records: JSON.parse(payload.json)
    });
  }

  function reserve(options) {
    options = options || {};
    const userId = positiveInteger(options.userId);
    const campaignId = positiveInteger(options.campaignId);
    const operationId = typeof options.operationId === 'string' ? options.operationId.trim().toLowerCase() : '';
    if (userId === null || campaignId === null || !UUID_PATTERN.test(operationId)) {
      throw error(400, 'FEISHU_OUTBOX_REQUEST_INVALID', 'Feishu Bitable delivery request is invalid.');
    }
    const payload = snapshotPayload(options.records);
    return db.transaction(function() {
      const access = requireCampaignWrite(db, userId, campaignId);
      const existing = readExisting(access, userId, operationId);
      if (existing) {
        if (existing.campaign_id !== campaignId || existing.payload_sha256 !== payload.hash) {
          throw error(409, 'FEISHU_OUTBOX_IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for another Feishu delivery.');
        }
        const delivery = publicDelivery(existing);
        if (existing.status === 'succeeded') return { state: 'replay', delivery };
        if (existing.status === 'failed') return { state: 'failed', delivery };
        return { state: 'processing', delivery };
      }
      const reservation = insertReservation(access, userId, campaignId, operationId, payload);
      return {
        state: 'reserved',
        reservationToken: reservation.reservationToken,
        delivery: publicDelivery(reservation.row)
      };
    })();
  }

  function terminalUpdate(options, terminalState) {
    options = options || {};
    const deliveryId = positiveInteger(options.deliveryId);
    const reservationToken = typeof options.reservationToken === 'string' ? options.reservationToken : '';
    if (deliveryId === null || !HEX_64.test(reservationToken)) {
      throw error(400, 'FEISHU_OUTBOX_REQUEST_INVALID', 'Feishu Bitable delivery request is invalid.');
    }
    return db.transaction(function() {
      const existing = db.prepare('SELECT * FROM feishu_bitable_outbox WHERE id=?').get(deliveryId);
      if (!existing || existing.reservation_token !== reservationToken || existing.status !== 'pending') {
        throw error(409, 'FEISHU_OUTBOX_FINALIZATION_FAILED', 'Feishu delivery could not persist its terminal outcome.');
      }
      let update;
      if (terminalState === 'succeeded') {
        const remoteRecordIds = parseRemoteRecordIds(options.remoteRecordIds, existing.record_count);
        update = db.prepare(`
          UPDATE feishu_bitable_outbox
          SET status='succeeded',remote_record_ids_json=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP
          WHERE id=? AND reservation_token=? AND status='pending'
        `).run(JSON.stringify(remoteRecordIds), deliveryId, reservationToken);
      } else {
        const errorCode = typeof options.errorCode === 'string' ? options.errorCode.trim() : '';
        if (!ERROR_CODE_PATTERN.test(errorCode)) {
          throw error(400, 'FEISHU_OUTBOX_ERROR_INVALID', 'Feishu delivery failure is invalid.');
        }
        update = db.prepare(`
          UPDATE feishu_bitable_outbox
          SET status='failed',last_error_code=?,updated_at=CURRENT_TIMESTAMP,failed_at=CURRENT_TIMESTAMP
          WHERE id=? AND reservation_token=? AND status='pending'
        `).run(errorCode, deliveryId, reservationToken);
      }
      if (update.changes !== 1) {
        throw error(409, 'FEISHU_OUTBOX_FINALIZATION_FAILED', 'Feishu delivery could not persist its terminal outcome.');
      }
      return readPublicDelivery(deliveryId);
    })();
  }

  function complete(options) {
    return terminalUpdate(options, 'succeeded');
  }

  function fail(options) {
    return terminalUpdate(options, 'failed');
  }

  function retry(options) {
    options = options || {};
    const userId = positiveInteger(options.userId);
    const campaignId = positiveInteger(options.campaignId);
    const deliveryId = positiveInteger(options.deliveryId);
    const operationId = typeof options.operationId === 'string' ? options.operationId.trim().toLowerCase() : '';
    if (userId === null || campaignId === null || deliveryId === null || !UUID_PATTERN.test(operationId)) {
      throw error(400, 'FEISHU_OUTBOX_REQUEST_INVALID', 'Feishu Bitable delivery request is invalid.');
    }
    const reason = retryReason(options.reason);
    return db.transaction(function() {
      const access = requireCampaignRetryAccess(db, userId, campaignId);
      const source = db.prepare(`
        SELECT *
        FROM feishu_bitable_outbox
        WHERE id=? AND org_id=? AND campaign_id=?
        LIMIT 1
      `).get(deliveryId, access.organization.id, campaignId);
      if (!source) {
        throw error(404, 'FEISHU_OUTBOX_DELIVERY_NOT_FOUND', 'Feishu delivery record is unavailable.');
      }
      const existingLink = db.prepare(`
        SELECT retry_delivery_id,actor_user_id,reason
        FROM feishu_bitable_outbox_retries
        WHERE failed_delivery_id=? AND org_id=? AND campaign_id=?
        LIMIT 1
      `).get(deliveryId, access.organization.id, campaignId);
      if (existingLink) {
        const child = db.prepare('SELECT * FROM feishu_bitable_outbox WHERE id=?').get(existingLink.retry_delivery_id);
        if (
          child &&
          existingLink.actor_user_id === userId &&
          child.actor_user_id === userId &&
          child.operation_id === operationId &&
          existingLink.reason === reason
        ) {
          return {
            state: 'replay',
            delivery: publicDelivery({ ...child, retry_of_delivery_id: source.id }),
            sourceDelivery: publicDelivery({ ...source, retry_delivery_id: child.id }),
            records: storedPayload(child).records
          };
        }
        if (child && child.actor_user_id === userId && child.operation_id === operationId) {
          throw error(
            409,
            'FEISHU_OUTBOX_IDEMPOTENCY_CONFLICT',
            'Idempotency-Key cannot be replayed with a different retry reason.'
          );
        }
        throw error(409, 'FEISHU_OUTBOX_RETRY_ALREADY_CREATED', 'A retry delivery already exists for this failed receipt.');
      }
      if (source.status !== 'failed') {
        throw error(409, 'FEISHU_OUTBOX_RETRY_NOT_REQUIRED', 'Feishu delivery is not eligible for retry.');
      }
      if (!retryableFailure(source.last_error_code)) {
        throw error(409, 'FEISHU_OUTBOX_RETRY_RECONCILIATION_REQUIRED', 'Feishu delivery cannot be retried without reconciliation.');
      }
      if (readExisting(access, userId, operationId)) {
        throw error(409, 'FEISHU_OUTBOX_IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for another Feishu delivery.');
      }
      const payload = storedPayload(source);
      const reservation = insertReservation(access, userId, campaignId, operationId, payload);
      db.prepare(`
        INSERT INTO feishu_bitable_outbox_retries (
          org_id,campaign_id,failed_delivery_id,retry_delivery_id,actor_user_id,reason
        ) VALUES (?,?,?,?,?,?)
      `).run(
        access.organization.id,
        campaignId,
        source.id,
        reservation.row.id,
        userId,
        reason
      );
      return {
        state: 'reserved',
        reservationToken: reservation.reservationToken,
        delivery: publicDelivery({ ...reservation.row, retry_of_delivery_id: source.id }),
        sourceDelivery: publicDelivery({ ...source, retry_delivery_id: reservation.row.id }),
        records: payload.records
      };
    })();
  }

  function reconcile(options) {
    options = options || {};
    const userId = positiveInteger(options.userId);
    const campaignId = positiveInteger(options.campaignId);
    const deliveryId = positiveInteger(options.deliveryId);
    if (userId === null || campaignId === null || deliveryId === null) {
      throw error(400, 'FEISHU_OUTBOX_REQUEST_INVALID', 'Feishu Bitable delivery request is invalid.');
    }
    return db.transaction(function() {
      const access = requireCampaignReconciliationAccess(db, userId, campaignId);
      const existing = db.prepare(`
        SELECT *
        FROM feishu_bitable_outbox
        WHERE id=? AND org_id=? AND campaign_id=?
        LIMIT 1
      `).get(deliveryId, access.organization.id, campaignId);
      if (!existing) {
        throw error(404, 'FEISHU_OUTBOX_DELIVERY_NOT_FOUND', 'Feishu delivery record is unavailable.');
      }
      if (existing.status !== 'pending') {
        throw error(409, 'FEISHU_OUTBOX_RECONCILIATION_NOT_REQUIRED', 'Feishu delivery is already finalized.');
      }
      const remoteRecordIds = parseRemoteRecordIds(options.remoteRecordIds, existing.record_count);
      const update = db.prepare(`
        UPDATE feishu_bitable_outbox
        SET status='succeeded',remote_record_ids_json=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP
        WHERE id=? AND org_id=? AND campaign_id=? AND status='pending'
      `).run(JSON.stringify(remoteRecordIds), deliveryId, access.organization.id, campaignId);
      if (update.changes !== 1) {
        throw error(409, 'FEISHU_OUTBOX_FINALIZATION_FAILED', 'Feishu delivery could not persist its terminal outcome.');
      }
      return readPublicDelivery(deliveryId);
    })();
  }

  function list(options) {
    options = options || {};
    const userId = positiveInteger(options.userId);
    const campaignId = positiveInteger(options.campaignId);
    const requestedLimit = options.limit === undefined ? 5 : Number(options.limit);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 50 ? requestedLimit : null;
    if (userId === null || campaignId === null || limit === null) {
      throw error(400, 'FEISHU_OUTBOX_REQUEST_INVALID', 'Feishu Bitable delivery request is invalid.');
    }
    const access = requireCampaignRead(db, userId, campaignId);
    return db.prepare(`
      SELECT delivery.*,
        retry_source.failed_delivery_id AS retry_of_delivery_id,
        retry_child.retry_delivery_id AS retry_delivery_id
      FROM feishu_bitable_outbox delivery
      LEFT JOIN feishu_bitable_outbox_retries retry_source
        ON retry_source.retry_delivery_id=delivery.id
      LEFT JOIN feishu_bitable_outbox_retries retry_child
        ON retry_child.failed_delivery_id=delivery.id
      WHERE delivery.org_id=? AND delivery.campaign_id=?
      ORDER BY delivery.updated_at DESC,delivery.id DESC
      LIMIT ?
    `).all(access.organization.id, campaignId, limit).map(publicDelivery);
  }

  return Object.freeze({ reserve, complete, fail, retry, reconcile, list });
}

module.exports = {
  FeishuBitableOutboxError,
  createFeishuBitableOutboxService
};
