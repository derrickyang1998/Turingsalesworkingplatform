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
  return {
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
      const row = db.prepare('SELECT * FROM feishu_bitable_outbox WHERE id=?').get(insert.lastInsertRowid);
      return { state: 'reserved', reservationToken, delivery: publicDelivery(row) };
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
      return publicDelivery(db.prepare('SELECT * FROM feishu_bitable_outbox WHERE id=?').get(deliveryId));
    })();
  }

  function complete(options) {
    return terminalUpdate(options, 'succeeded');
  }

  function fail(options) {
    return terminalUpdate(options, 'failed');
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
      return publicDelivery(db.prepare('SELECT * FROM feishu_bitable_outbox WHERE id=?').get(deliveryId));
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
      SELECT *
      FROM feishu_bitable_outbox
      WHERE org_id=? AND campaign_id=?
      ORDER BY updated_at DESC,id DESC
      LIMIT ?
    `).all(access.organization.id, campaignId, limit).map(publicDelivery);
  }

  return Object.freeze({ reserve, complete, fail, reconcile, list });
}

module.exports = {
  FeishuBitableOutboxError,
  createFeishuBitableOutboxService
};
