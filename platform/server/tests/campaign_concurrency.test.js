const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CAMPAIGN_MIGRATIONS = Object.freeze([Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})]);

const MUTATING_PRIMITIVES = Object.freeze([
  'reserveProcessingInTransaction',
  'renewLeaseInTransaction',
  'completeJsonInTransaction',
  'failInternalInTransaction',
  'recoverExpiredInTransaction'
]);
const DEADLINE_RESPONSE = Object.freeze({
  error: 'Idempotent operation deadline expired.',
  code: 'IDEMPOTENCY_EXPIRED',
  request_id: 'idempotency-recovery'
});

function openCampaignDatabase(t, filename = ':memory:') {
  const db = new Database(filename);
  db.pragma('busy_timeout = 5000');
  t.after(() => {
    if (db.open) db.close();
  });
  assert.deepEqual(
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: CAMPAIGN_MIGRATIONS
    }),
    { status: 'managed', currentVersion: 2 }
  );
  return db;
}

function seedCampaign(db, suffix = '') {
  const actor = db.prepare(`
    SELECT membership.org_id AS organizationId,
      membership.team_id AS teamId,
      membership.user_id AS actorUserId
    FROM team_memberships membership
    JOIN organizations organization ON organization.id=membership.org_id
    WHERE organization.code='turingmarket-default'
      AND membership.status='active'
    ORDER BY membership.user_id,membership.team_id
    LIMIT 1
  `).get();
  assert.ok(actor);

  const customerId = 8101;
  const opportunityId = 8201;
  const campaignId = 8301;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (?,?,?,'qualified','task-5c',?,?)
  `).run(
    customerId,
    `Task 5C Brand${suffix}`,
    `Task 5C Company${suffix}`,
    actor.actorUserId,
    actor.actorUserId
  );
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (?,?,'Task 5C Opportunity','proposal',10000,80,'Task 5C Product','influencer',?)
  `).run(opportunityId, customerId, actor.actorUserId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,'Task 5C Campaign',?,?,?,?, 'lead','active',1)
  `).run(
    campaignId,
    actor.organizationId,
    customerId,
    opportunityId,
    actor.actorUserId,
    actor.teamId
  );

  return { ...actor, customerId, opportunityId, campaignId };
}

function requestInput(context, overrides = {}) {
  const scope = overrides.scope || 'campaign.update';
  const key = overrides.key || 'task5c-request-0001';
  const requestHash = overrides.requestHash || sqliteDigest.requestHash({
    method: 'PATCH',
    path: `/api/campaigns/${context.campaignId}`,
    campaignId: context.campaignId,
    kind: 'json',
    payload: { name: 'Task 5C Campaign' }
  });
  return {
    organizationId: context.organizationId,
    actorUserId: context.actorUserId,
    campaignId: context.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope,
    key,
    requestHash,
    expectedEventCount: 0,
    operationTimeoutSeconds: 60,
    ...overrides
  };
}

function sqliteDate(db, modifier = null) {
  return modifier === null
    ? db.prepare('SELECT CURRENT_TIMESTAMP AS value').get().value
    : db.prepare('SELECT datetime(CURRENT_TIMESTAMP,?) AS value').get(modifier).value;
}

function deterministicHex(label) {
  return sqliteDigest.sha256Hex(Buffer.from(label, 'utf8'));
}

function seedSecondaryCampaign(db, context, campaignId = context.campaignId + 1) {
  const result = db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    )
    SELECT
      ?,org_id,'Task 5C Secondary Campaign',customer_id,opportunity_id,
      owner_user_id,team_id,lifecycle_state,operational_status,1
    FROM campaigns
    WHERE id=?
  `).run(campaignId, context.campaignId);
  assert.equal(result.changes, 1);
  return campaignId;
}

function canonicalLinkMovedMetadata(sourceCampaignId, destinationCampaignId, overrides = {}) {
  return sqliteDigest.canonicalJsonBytes({
    source_bundle_id: deterministicHex('task5c-link-moved-source-bundle'),
    destination_bundle_id: deterministicHex('task5c-link-moved-destination-bundle'),
    relation_types: ['knowledge', 'review'],
    record_type: 'knowledge_entry',
    record_id: '4201',
    source_campaign_id: sourceCampaignId,
    destination_campaign_id: destinationCampaignId,
    revoked_link_ids: [9101, 9102],
    replacement_link_ids: [9201, 9202],
    ...overrides
  }).toString('utf8');
}

function insertLinkMovedEvent(db, {
  context,
  campaignId,
  metadataJson,
  correlationId,
  auditFingerprint
}) {
  return db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (
      ?,?,'link_moved',NULL,NULL,?,
      'Task 5C reciprocal link correction','project_workspace',?,?,?
    )
  `).run(
    context.organizationId,
    campaignId,
    context.actorUserId,
    metadataJson,
    correlationId,
    auditFingerprint
  );
}

function createReservationWorker(workerData) {
  const worker = new Worker(`
    'use strict';
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.databaseModulePath);
    const idempotency = require(workerData.servicePath);
    const db = new Database(workerData.dbPath);
    db.pragma('busy_timeout = 5000');
    parentPort.postMessage({ type: 'ready' });
    parentPort.once('message', (message) => {
      if (!message || message.type !== 'start') {
        parentPort.postMessage({
          type: 'failure',
          error: {
            name: 'WorkerProtocolError',
            message: 'invalid reservation worker command'
          }
        });
        db.close();
        parentPort.close();
        return;
      }
      try {
        const result = db.transaction(() => (
          idempotency.reserveProcessingInTransaction(db, workerData.input)
        )).immediate();
        parentPort.postMessage({ type: 'result', result });
      } catch (error) {
        parentPort.postMessage({
          type: 'failure',
          error: {
            name: error && error.name,
            message: error && error.message,
            code: error && error.code,
            statusCode: error && error.statusCode
          }
        });
      } finally {
        db.close();
        parentPort.close();
      }
    });
  `, {
    eval: true,
    workerData
  });
  let readySettled = false;
  let resultSettled = false;
  let resolveReady;
  let rejectReady;
  let resolveResult;
  let rejectResult;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on('message', (message) => {
    if (message && message.type === 'ready' && !readySettled) {
      readySettled = true;
      resolveReady();
    } else if (message && message.type === 'result' && !resultSettled) {
      resultSettled = true;
      resolveResult(message.result);
    } else if (message && message.type === 'failure' && !resultSettled) {
      resultSettled = true;
      const error = new Error(message.error && message.error.message);
      Object.assign(error, message.error);
      rejectResult(error);
    }
  });
  worker.once('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
  });
  worker.once('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`reservation worker exited with code ${code}`);
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      if (!resultSettled) {
        resultSettled = true;
        rejectResult(error);
      }
    } else if (!resultSettled) {
      resultSettled = true;
      rejectResult(new Error('reservation worker exited without a result'));
    }
  });
  return { worker, ready, result };
}

function createCampaignServiceWorker(workerData) {
  const worker = new Worker(`
    'use strict';
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.databaseModulePath);
    const { createCampaignService } = require(workerData.servicePath);
    const db = new Database(workerData.dbPath);
    db.pragma('busy_timeout = 10000');
    const service = createCampaignService(db);
    parentPort.postMessage({ type: 'ready' });
    parentPort.once('message', (message) => {
      if (!message || message.type !== 'start') {
        parentPort.postMessage({
          type: 'result',
          outcome: {
            ok: false,
            error: {
              name: 'WorkerProtocolError',
              message: 'invalid campaign worker command'
            }
          }
        });
        db.close();
        parentPort.close();
        return;
      }
      try {
        parentPort.postMessage({
          type: 'result',
          outcome: {
            ok: true,
            value: service.createCampaign(workerData.input)
          }
        });
      } catch (error) {
        parentPort.postMessage({
          type: 'result',
          outcome: {
            ok: false,
            error: {
              name: error && error.name,
              message: error && error.message,
              code: error && error.code,
              statusCode: error && error.statusCode
            }
          }
        });
      } finally {
        db.close();
        parentPort.close();
      }
    });
  `, {
    eval: true,
    workerData
  });
  let readySettled = false;
  let resultSettled = false;
  let resolveReady;
  let rejectReady;
  let resolveResult;
  let rejectResult;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on('message', (message) => {
    if (message && message.type === 'ready' && !readySettled) {
      readySettled = true;
      resolveReady();
    } else if (message && message.type === 'result' && !resultSettled) {
      resultSettled = true;
      resolveResult(message.outcome);
    }
  });
  worker.once('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
  });
  worker.once('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`campaign worker exited with code ${code}`);
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      if (!resultSettled) {
        resultSettled = true;
        rejectResult(error);
      }
    } else if (!resultSettled) {
      resultSettled = true;
      rejectResult(new Error('campaign worker exited without a result'));
    }
  });
  return { worker, ready, result };
}

function insertProcessingLedger(db, input, label, {
  createdModifier = '-2 minutes',
  leaseModifier = '-1 minute',
  deadlineModifier = '+5 minutes'
} = {}) {
  const reservationNonce = deterministicHex(`nonce:${label}`);
  const leaseToken = deterministicHex(`lease:${label}`);
  const fingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const createdAt = sqliteDate(db, createdModifier);
  const operationDeadline = sqliteDate(db, deadlineModifier);
  const leaseUntil = sqliteDate(db, leaseModifier);
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,lease_until,lease_token,created_at,updated_at,
      operation_deadline
    ) VALUES (
      @organizationId,@actorUserId,@campaignId,@secondaryCampaignId,@resourceClaim,
      @scope,@key,@reservationNonce,@requestHash,@auditFingerprint,
      @expectedEventCount,'processing',@leaseUntil,@leaseToken,@createdAt,@createdAt,
      @operationDeadline
    )
  `).run({
    ...input,
    reservationNonce,
    auditFingerprint: fingerprint,
    leaseUntil,
    leaseToken,
    createdAt,
    operationDeadline
  });
  return {
    ledgerId: Number(result.lastInsertRowid),
    reservationNonce,
    auditFingerprint: fingerprint,
    leaseToken,
    leaseUntil,
    operationDeadline
  };
}

function insertExpiredProcessingLedger(db, input, label) {
  return insertProcessingLedger(db, input, label);
}

function insertFailedLedger(db, input, label, {
  createdModifier = '-10 minutes',
  updatedModifier = '-6 minutes',
  deadlineModifier = '-5 minutes',
  expiresModifier = '+1 day'
} = {}) {
  const reservationNonce = deterministicHex(`nonce:${label}`);
  const fingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const createdAt = sqliteDate(db, createdModifier);
  const updatedAt = sqliteDate(db, updatedModifier);
  const operationDeadline = sqliteDate(db, deadlineModifier);
  const expiresAt = sqliteDate(db, expiresModifier);
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,created_at,updated_at,operation_deadline,expires_at
    ) VALUES (
      @organizationId,@actorUserId,@campaignId,@secondaryCampaignId,@resourceClaim,
      @scope,@key,@reservationNonce,@requestHash,@auditFingerprint,
      @expectedEventCount,'failed',@createdAt,@updatedAt,@operationDeadline,@expiresAt
    )
  `).run({
    ...input,
    reservationNonce,
    auditFingerprint: fingerprint,
    createdAt,
    updatedAt,
    operationDeadline,
    expiresAt
  });
  return {
    ledgerId: Number(result.lastInsertRowid),
    reservationNonce,
    auditFingerprint: fingerprint,
    operationDeadline,
    expiresAt
  };
}

function insertCompletedJsonLedger(db, input, label, {
  statusCode = 200,
  responseBody = { retained: true },
  createdModifier = '-40 days',
  updatedModifier = '-31 days',
  deadlineModifier = '-39 days',
  expiresModifier = '-1 day'
} = {}) {
  const reservationNonce = deterministicHex(`nonce:${label}`);
  const fingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const createdAt = sqliteDate(db, createdModifier);
  const updatedAt = sqliteDate(db, updatedModifier);
  const operationDeadline = sqliteDate(db, deadlineModifier);
  const expiresAt = sqliteDate(db, expiresModifier);
  const responseJson = sqliteDigest.canonicalJsonBytes(responseBody).toString('utf8');
  const responseHeadersJson = '{"Content-Type":"application/json; charset=utf-8"}';
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,status_code,response_kind,response_json,
      response_headers_json,created_at,updated_at,operation_deadline,expires_at
    ) VALUES (
      @organizationId,@actorUserId,@campaignId,@secondaryCampaignId,@resourceClaim,
      @scope,@key,@reservationNonce,@requestHash,@auditFingerprint,
      @expectedEventCount,'completed',@statusCode,'json',@responseJson,
      @responseHeadersJson,@createdAt,@updatedAt,@operationDeadline,@expiresAt
    )
  `).run({
    ...input,
    reservationNonce,
    auditFingerprint: fingerprint,
    statusCode,
    responseJson,
    responseHeadersJson,
    createdAt,
    updatedAt,
    operationDeadline,
    expiresAt
  });
  return {
    ledgerId: Number(result.lastInsertRowid),
    reservationNonce,
    auditFingerprint: fingerprint,
    operationDeadline,
    expiresAt
  };
}

function insertCompletedBinaryLedger(db, input, label, {
  createdModifier = '-40 days',
  updatedModifier = '-31 days',
  deadlineModifier = '-39 days',
  expiresModifier = '-1 day'
} = {}) {
  const reservationNonce = deterministicHex(`nonce:${label}`);
  const fingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const responseBytes = Buffer.from('task5c-pptx', 'utf8');
  const artifact = {
    statusCode: 200,
    responseKind: 'binary',
    responseHeadersJson: JSON.stringify({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': 'attachment; filename="task5c.pptx"',
      'Content-Length': String(responseBytes.length),
      ETag: `"${sqliteDigest.sha256Hex(responseBytes)}"`,
      'Cache-Control': 'private, max-age=0, no-store'
    }),
    responseCacheKey: deterministicHex(`cache:${label}`),
    responseSha256: sqliteDigest.sha256Hex(responseBytes),
    responseBytes: responseBytes.length,
    responseContentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    responseFilename: 'task5c.pptx',
    createdAt: sqliteDate(db, createdModifier),
    updatedAt: sqliteDate(db, updatedModifier),
    operationDeadline: sqliteDate(db, deadlineModifier),
    expiresAt: sqliteDate(db, expiresModifier)
  };
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,status_code,response_kind,response_headers_json,
      response_cache_key,response_sha256,response_bytes,response_content_type,
      response_filename,created_at,updated_at,operation_deadline,expires_at
    ) VALUES (
      @organizationId,@actorUserId,@campaignId,@secondaryCampaignId,@resourceClaim,
      @scope,@key,@reservationNonce,@requestHash,@auditFingerprint,
      @expectedEventCount,'completed',@statusCode,@responseKind,@responseHeadersJson,
      @responseCacheKey,@responseSha256,@responseBytes,@responseContentType,
      @responseFilename,@createdAt,@updatedAt,@operationDeadline,@expiresAt
    )
  `).run({
    ...input,
    reservationNonce,
    auditFingerprint: fingerprint,
    ...artifact
  });
  return {
    ledgerId: Number(result.lastInsertRowid),
    reservationNonce,
    auditFingerprint: fingerprint,
    ...artifact
  };
}

function insertCompletedAdmissionLedger(db, input, label, {
  createdModifier = '-2 hours',
  updatedModifier = '-1 hour',
  deadlineModifier = '-90 minutes',
  expiresModifier = '+23 hours'
} = {}) {
  const reservationNonce = deterministicHex(`nonce:${label}`);
  const fingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const createdAt = sqliteDate(db, createdModifier);
  const updatedAt = sqliteDate(db, updatedModifier);
  const operationDeadline = sqliteDate(db, deadlineModifier);
  const expiresAt = sqliteDate(db, expiresModifier);
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,status_code,response_kind,created_at,updated_at,
      operation_deadline,expires_at
    ) VALUES (
      @organizationId,@actorUserId,@campaignId,@secondaryCampaignId,@resourceClaim,
      @scope,@key,@reservationNonce,@requestHash,@auditFingerprint,
      @expectedEventCount,'completed',200,'admission',@createdAt,@updatedAt,
      @operationDeadline,@expiresAt
    )
  `).run({
    ...input,
    reservationNonce,
    auditFingerprint: fingerprint,
    createdAt,
    updatedAt,
    operationDeadline,
    expiresAt
  });
  return {
    ledgerId: Number(result.lastInsertRowid),
    reservationNonce,
    auditFingerprint: fingerprint,
    operationDeadline,
    expiresAt
  };
}

test('idempotency core exposes the accepted primitives and every mutation requires an outer transaction', () => {
  const idempotency = require('../services/idempotency_service');

  assert.equal(typeof idempotency.inspectRetained, 'function');
  for (const name of MUTATING_PRIMITIVES) {
    assert.equal(typeof idempotency[name], 'function');
    assert.throws(
      () => idempotency[name]({ inTransaction: false }, {}),
      (error) => (
        error instanceof TypeError &&
        error.message === 'idempotency mutation requires an active transaction'
      )
    );
  }
});

test('reservation persists one nonce-bound processing identity with a bounded lease and separate deadline', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context);

  assert.deepEqual(idempotency.inspectRetained(db, input), { state: 'absent' });
  const reservation = db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, input)
  )).immediate();

  assert.equal(reservation.state, 'reserved');
  assert.ok(Number.isSafeInteger(reservation.ledgerId) && reservation.ledgerId > 0);
  assert.match(reservation.reservationNonce, /^[0-9a-f]{64}$/);
  assert.match(reservation.leaseToken, /^[0-9a-f]{64}$/);
  assert.equal(
    reservation.auditFingerprint,
    sqliteDigest.auditFingerprint({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      reservationNonce: reservation.reservationNonce
    })
  );

  const row = db.prepare(`
    SELECT
      id,org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,lease_token,lease_until,created_at,
      operation_deadline,expires_at,
      unixepoch(lease_until)-unixepoch(created_at) AS lease_seconds,
      unixepoch(operation_deadline)-unixepoch(created_at) AS operation_seconds
    FROM request_idempotency
    WHERE id=?
  `).get(reservation.ledgerId);
  assert.deepEqual(row, {
    id: reservation.ledgerId,
    org_id: input.organizationId,
    user_id: input.actorUserId,
    campaign_id: input.campaignId,
    secondary_campaign_id: null,
    resource_claim: null,
    scope: input.scope,
    idempotency_key: input.key,
    reservation_nonce: reservation.reservationNonce,
    request_hash: input.requestHash,
    audit_fingerprint: reservation.auditFingerprint,
    expected_event_count: 0,
    state: 'processing',
    lease_token: reservation.leaseToken,
    lease_until: reservation.leaseUntil,
    created_at: row.created_at,
    operation_deadline: reservation.operationDeadline,
    expires_at: null,
    lease_seconds: 60,
    operation_seconds: 60
  });
  assert.equal(row.lease_until, row.operation_deadline);

  const retained = idempotency.inspectRetained(db, input);
  assert.equal(retained.state, 'processing');
  assert.equal(retained.ledgerId, reservation.ledgerId);
  assert.equal(retained.recoverable, false);
  assert.ok(Number.isSafeInteger(retained.retryAfterSeconds));
  assert.ok(retained.retryAfterSeconds >= 1 && retained.retryAfterSeconds <= 60);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
    1
  );
});

test('two concurrent immediate reservations produce one durable winner and one processing observation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-task5c-race-'));
  const dbPath = path.join(tempRoot, 'campaign.db');
  const setup = new Database(dbPath);
  const workers = [];
  let verifier;
  try {
    assert.deepEqual(
      migrationService.runMigrations(setup, {
        rootDir: SERVER_ROOT,
        registeredMigrations: CAMPAIGN_MIGRATIONS
      }),
      { status: 'managed', currentVersion: 2 }
    );
    setup.pragma('journal_mode = WAL');
    const context = seedCampaign(setup, ' Race');
    const input = requestInput(context, {
      key: 'task5c-concurrent-winner',
      requestHash: deterministicHex('task5c-concurrent-winner-request')
    });
    setup.close();

    for (let index = 0; index < 2; index += 1) {
      workers.push(createReservationWorker({
        databaseModulePath: require.resolve('better-sqlite3'),
        servicePath: path.join(
          SERVER_ROOT,
          'services',
          'idempotency_service.js'
        ),
        dbPath,
        input
      }));
    }
    await Promise.all(workers.map(({ ready }) => ready));
    for (const { worker } of workers) worker.postMessage({ type: 'start' });
    const results = await Promise.all(workers.map(({ result }) => result));

    assert.deepEqual(
      results.map(({ state }) => state).sort(),
      ['processing', 'reserved']
    );
    const reserved = results.find(({ state }) => state === 'reserved');
    const observed = results.find(({ state }) => state === 'processing');
    assert.equal(observed.ledgerId, reserved.ledgerId);
    assert.equal(observed.recoverable, false);
    assert.ok(observed.retryAfterSeconds >= 1);

    verifier = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = verifier.prepare(`
      SELECT
        id,state,reservation_nonce,request_hash,audit_fingerprint,
        lease_token,lease_until,operation_deadline
      FROM request_idempotency
    `).get();
    assert.deepEqual(row, {
      id: reserved.ledgerId,
      state: 'processing',
      reservation_nonce: reserved.reservationNonce,
      request_hash: input.requestHash,
      audit_fingerprint: reserved.auditFingerprint,
      lease_token: reserved.leaseToken,
      lease_until: reserved.leaseUntil,
      operation_deadline: reserved.operationDeadline
    });
    assert.equal(
      reserved.auditFingerprint,
      sqliteDigest.auditFingerprint({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        scope: input.scope,
        key: input.key,
        requestHash: input.requestHash,
        reservationNonce: reserved.reservationNonce
      })
    );
  } finally {
    await Promise.allSettled(
      workers.map(({ worker }) => worker.terminate())
    );
    if (verifier && verifier.open) verifier.close();
    if (setup.open) setup.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('one outer immediate transaction reserves mutates audits and completes without exposing processing', () => {
  const idempotency = require('../services/idempotency_service');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-task5c-sync-'));
  const dbPath = path.join(tempRoot, 'campaign.db');
  const db = new Database(dbPath);
  let observer;
  try {
    assert.deepEqual(
      migrationService.runMigrations(db, {
        rootDir: SERVER_ROOT,
        registeredMigrations: CAMPAIGN_MIGRATIONS
      }),
      { status: 'managed', currentVersion: 2 }
    );
    db.pragma('journal_mode = WAL');
    const context = seedCampaign(db);
    observer = new Database(dbPath, { readonly: true, fileMustExist: true });
    observer.pragma('busy_timeout = 5000');

    const input = requestInput(context, {
      scope: 'campaign.transition',
      key: 'task5c-sync-transition',
      expectedEventCount: 1,
      requestHash: sqliteDigest.requestHash({
        method: 'POST',
        path: `/api/campaigns/${context.campaignId}/transitions`,
        campaignId: context.campaignId,
        kind: 'json',
        payload: {
          expected_state: 'lead',
          expected_version: 1,
          next_state: 'qualified',
          reason: 'Task 5C qualified'
        }
      })
    });
    const responseBody = {
      success: true,
      campaign_id: context.campaignId,
      lifecycle_state: 'qualified',
      row_version: 2
    };

    const completed = db.transaction(() => {
      const reservation = idempotency.reserveProcessingInTransaction(db, input);
      assert.equal(reservation.state, 'reserved');
      assert.equal(
        observer.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
        0,
        'an uncommitted reservation must not become a standalone visible processing row'
      );
      assert.equal(
        db.prepare(`
          UPDATE campaigns
          SET lifecycle_state='qualified',row_version=2,updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND org_id=? AND lifecycle_state='lead' AND row_version=1
        `).run(context.campaignId, context.organizationId).changes,
        1
      );
      db.prepare(`
        INSERT INTO campaign_events (
          org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
          reason,source,metadata_json,correlation_id,audit_fingerprint
        ) VALUES (
          ?,?,'lifecycle_transition','lead','qualified',?,
          'Task 5C qualified','project_workspace',?,
          'task5c-sync-transition',?
        )
      `).run(
        context.organizationId,
        context.campaignId,
        context.actorUserId,
        JSON.stringify({ previous_version: 1, next_version: 2 }),
        reservation.auditFingerprint
      );
      const result = idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: input.requestHash,
        leaseToken: reservation.leaseToken,
        statusCode: 200,
        responseBody
      });
      assert.equal(
        observer.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
        0,
        'completion must remain inside the same uncommitted outer transaction'
      );
      return result;
    }).immediate();

    assert.deepEqual(completed, {
      state: 'replay',
      ledgerId: completed.ledgerId,
      statusCode: 200,
      responseKind: 'json',
      responseBody,
      responseHeaders: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
    assert.ok(Number.isSafeInteger(completed.ledgerId));
    const visible = observer.prepare(`
      SELECT
        state,status_code,response_kind,response_json,response_headers_json,
        lease_until,lease_token,expires_at,operation_deadline,updated_at,
        unixepoch(expires_at)-unixepoch(updated_at) AS retention_seconds
      FROM request_idempotency
    `).get();
    assert.deepEqual(visible, {
      state: 'completed',
      status_code: 200,
      response_kind: 'json',
      response_json: sqliteDigest.canonicalJsonBytes(responseBody).toString('utf8'),
      response_headers_json: '{"Content-Type":"application/json; charset=utf-8"}',
      lease_until: null,
      lease_token: null,
      expires_at: visible.expires_at,
      operation_deadline: visible.operation_deadline,
      updated_at: visible.updated_at,
      retention_seconds: 30 * 24 * 60 * 60
    });
    assert.notEqual(visible.expires_at, visible.operation_deadline);
    assert.deepEqual(idempotency.inspectRetained(db, input), completed);
    const second = db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, input)
    )).immediate();
    assert.deepEqual(second, completed);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
      1
    );
  } finally {
    if (observer && observer.open) observer.close();
    if (db.open) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('retained keys replay only the same hash and immutable reservation identity', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context, { key: 'task5c-replay-identity' });
  const responseBody = { success: true, campaign_id: context.campaignId };

  const completed = db.transaction(() => {
    const reservation = idempotency.reserveProcessingInTransaction(db, input);
    return idempotency.completeJsonInTransaction(db, {
      ledgerId: reservation.ledgerId,
      requestHash: input.requestHash,
      leaseToken: reservation.leaseToken,
      statusCode: 200,
      responseBody
    });
  }).immediate();
  assert.deepEqual(idempotency.inspectRetained(db, input), completed);

  const omittedPrimary = {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    secondaryCampaignId: null,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash
  };
  for (const lookup of [
    () => idempotency.inspectRetained(db, omittedPrimary),
    () => db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, omittedPrimary)
    )).immediate()
  ]) {
    assert.throws(
      lookup,
      (error) => (
        error instanceof TypeError &&
        error.message === 'invalid idempotency input'
      ),
      'a campaign-bound retry must carry its authorized primary campaign'
    );
  }

  const changedHash = requestInput(context, {
    key: input.key,
    requestHash: sqliteDigest.requestHash({
      method: 'PATCH',
      path: `/api/campaigns/${context.campaignId}`,
      campaignId: context.campaignId,
      kind: 'json',
      payload: { name: 'Changed intent' }
    })
  });
  const conflict = {
    state: 'conflict',
    statusCode: 409,
    code: 'IDEMPOTENCY_KEY_REUSED'
  };
  assert.deepEqual(idempotency.inspectRetained(db, changedHash), conflict);
  assert.deepEqual(
    db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, changedHash)
    )).immediate(),
    conflict
  );

  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    )
    SELECT
      id+1,org_id,'Task 5C Sibling',customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    FROM campaigns
    WHERE id=?
  `).run(context.campaignId);
  assert.deepEqual(
    idempotency.inspectRetained(db, {
      ...input,
      campaignId: context.campaignId + 1
    }),
    conflict,
    'a hostile same-hash identity substitution must not replay another campaign'
  );
  assert.deepEqual(
    db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, {
        ...input,
        campaignId: context.campaignId + 1
      })
    )).immediate(),
    conflict
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
    1
  );
});

test('lost collaboration alias response replays stored event metadata before retry-time outcome derivation', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const original = requestInput(context, {
    scope: 'collaboration.update.linked',
    key: 'task5c-collaboration-lost-response',
    requestHash: deterministicHex('task5c-collaboration-lost-response'),
    expectedEventCount: 1
  });
  const responseBody = {
    success: true,
    campaign_id: context.campaignId,
    row_version: 2,
    active_relations: ['order', 'execution']
  };
  const retained = insertCompletedJsonLedger(
    db,
    original,
    'task5c-collaboration-lost-response',
    {
      responseBody,
      createdModifier: '-2 hours',
      updatedModifier: '-1 hour',
      deadlineModifier: '-90 minutes',
      expiresModifier: '+29 days'
    }
  );
  const retryAfterStateChange = {
    ...original,
    expectedEventCount: 0
  };
  const expected = {
    state: 'replay',
    ledgerId: retained.ledgerId,
    statusCode: 200,
    responseKind: 'json',
    responseBody,
    responseHeaders: {
      'Content-Type': 'application/json; charset=utf-8'
    },
    campaignId: context.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    expectedEventCount: 1
  };

  assert.deepEqual(
    idempotency.inspectRetained(db, {
      organizationId: original.organizationId,
      actorUserId: original.actorUserId,
      campaignId: original.campaignId,
      scope: original.scope,
      key: original.key,
      requestHash: original.requestHash
    }),
    expected
  );
  assert.deepEqual(
    db.transaction(() => (
      idempotency.reserveProcessingInTransaction(
        db,
        retryAfterStateChange
      )
    )).immediate(),
    expected,
    'same-key replay must use stored successful-outcome metadata'
  );
});

test('linked PPT lost response replays before resource claim derivation', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const original = requestInput(context, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-ppt-replay-before-claim',
    requestHash: deterministicHex('task5c-ppt-replay-before-claim-request'),
    resourceClaim: deterministicHex('task5c-ppt-replay-before-claim-resource'),
    expectedEventCount: 1
  });
  const binary = insertCompletedBinaryLedger(
    db,
    original,
    'task5c-ppt-replay-before-claim',
    {
      createdModifier: '-2 days',
      updatedModifier: '-1 day',
      deadlineModifier: '-47 hours',
      expiresModifier: '+29 days'
    }
  );
  const beforeClaimDerivation = {
    organizationId: original.organizationId,
    actorUserId: original.actorUserId,
    campaignId: original.campaignId,
    scope: original.scope,
    key: original.key,
    requestHash: original.requestHash
  };
  const expected = {
    state: 'replay',
    ledgerId: binary.ledgerId,
    statusCode: 200,
    responseKind: 'binary',
    responseCacheKey: binary.responseCacheKey,
    responseSha256: binary.responseSha256,
    responseBytes: binary.responseBytes,
    responseContentType: binary.responseContentType,
    responseFilename: binary.responseFilename,
    campaignId: context.campaignId,
    secondaryCampaignId: null,
    resourceClaim: original.resourceClaim,
    expectedEventCount: 1
  };

  assert.deepEqual(
    idempotency.inspectRetained(db, beforeClaimDerivation),
    expected
  );
  assert.deepEqual(
    db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, beforeClaimDerivation)
    )).immediate(),
    expected,
    'transactional same-key lookup must precede new claim validation'
  );
});

test('internal failure is token-fenced, response-free, and retained separately from the work deadline', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context, {
    key: 'task5c-internal-failure',
    operationTimeoutSeconds: 300
  });

  let originalOperationDeadline;
  const failed = db.transaction(() => {
    const reservation = idempotency.reserveProcessingInTransaction(db, input);
    originalOperationDeadline = reservation.operationDeadline;
    return idempotency.failInternalInTransaction(db, {
      ledgerId: reservation.ledgerId,
      requestHash: input.requestHash,
      leaseToken: reservation.leaseToken
    });
  }).immediate();
  assert.deepEqual(failed, {
    state: 'processing',
    ledgerId: failed.ledgerId,
    recoverable: true,
    retryAfterSeconds: 0,
    fromFailed: true
  });

  const row = db.prepare(`
    SELECT
      state,lease_until,lease_token,status_code,response_kind,response_json,
      response_headers_json,response_cache_key,response_sha256,response_bytes,
      response_content_type,response_filename,operation_deadline,expires_at,updated_at,
      unixepoch(expires_at)-unixepoch(updated_at) AS retention_seconds,
      unixepoch(operation_deadline)-unixepoch(updated_at) AS remaining_work_seconds
    FROM request_idempotency
    WHERE id=?
  `).get(failed.ledgerId);
  const {
    remaining_work_seconds: remainingWorkSeconds,
    ...persistedFailure
  } = row;
  assert.deepEqual(persistedFailure, {
    state: 'failed',
    lease_until: null,
    lease_token: null,
    status_code: null,
    response_kind: null,
    response_json: null,
    response_headers_json: null,
    response_cache_key: null,
    response_sha256: null,
    response_bytes: null,
    response_content_type: null,
    response_filename: null,
    operation_deadline: originalOperationDeadline,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
    retention_seconds: 24 * 60 * 60
  });
  assert.equal(row.operation_deadline, originalOperationDeadline);
  assert.ok(
    Number.isSafeInteger(remainingWorkSeconds) &&
      remainingWorkSeconds > 0 &&
      remainingWorkSeconds <= 300,
    `remaining work seconds must stay within 1..300; got ${remainingWorkSeconds}`
  );
  assert.notEqual(row.expires_at, row.operation_deadline);
  assert.deepEqual(idempotency.inspectRetained(db, input), failed);
});

test('expired processing lease recovery rotates only the token and fences the stale worker', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context, { key: 'task5c-expired-lease' });
  const expired = insertExpiredProcessingLedger(
    db,
    input,
    'task5c-expired-lease'
  );

  assert.deepEqual(idempotency.inspectRetained(db, input), {
    state: 'processing',
    ledgerId: expired.ledgerId,
    recoverable: true,
    retryAfterSeconds: 0
  });
  const recovered = db.transaction(() => (
    idempotency.recoverExpiredInTransaction(db, input)
  )).immediate();
  assert.equal(recovered.state, 'reserved');
  assert.equal(recovered.ledgerId, expired.ledgerId);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.fromFailed, false);
  assert.equal(recovered.reservationNonce, expired.reservationNonce);
  assert.equal(recovered.auditFingerprint, expired.auditFingerprint);
  assert.notEqual(recovered.leaseToken, expired.leaseToken);
  assert.match(recovered.leaseToken, /^[0-9a-f]{64}$/);
  assert.equal(recovered.operationDeadline, expired.operationDeadline);
  assert.ok(
    db.prepare(`
      SELECT
        datetime(lease_until)>CURRENT_TIMESTAMP
          AND datetime(lease_until)<=datetime(operation_deadline) AS valid
      FROM request_idempotency
      WHERE id=?
    `).get(expired.ledgerId).valid
  );

  assert.throws(
    () => db.transaction(() => (
      idempotency.completeJsonInTransaction(db, {
        ledgerId: expired.ledgerId,
        requestHash: input.requestHash,
        leaseToken: expired.leaseToken,
        statusCode: 200,
        responseBody: { stale: true }
      })
    )).immediate(),
    (error) => (
      error.code === 'IDEMPOTENCY_IN_PROGRESS' &&
      error.statusCode === 409 &&
      !error.message.includes(expired.leaseToken)
    )
  );
  const completed = db.transaction(() => (
    idempotency.completeJsonInTransaction(db, {
      ledgerId: recovered.ledgerId,
      requestHash: input.requestHash,
      leaseToken: recovered.leaseToken,
      statusCode: 200,
      responseBody: { recovered: true }
    })
  )).immediate();
  assert.equal(completed.state, 'replay');
  assert.deepEqual(completed.responseBody, { recovered: true });
});

test('lease renewal uses exact ownership and extends only toward the immutable deadline', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context, { key: 'task5c-lease-renewal' });
  const processing = insertProcessingLedger(
    db,
    input,
    'task5c-lease-renewal',
    {
      createdModifier: '-1 minute',
      leaseModifier: '+30 seconds',
      deadlineModifier: '+5 minutes'
    }
  );

  const renewed = db.transaction(() => (
    idempotency.renewLeaseInTransaction(db, {
      ledgerId: processing.ledgerId,
      requestHash: input.requestHash,
      leaseToken: processing.leaseToken
    })
  )).immediate();
  assert.equal(renewed.state, 'processing');
  assert.equal(renewed.ledgerId, processing.ledgerId);
  assert.equal(renewed.leaseToken, processing.leaseToken);
  assert.equal(renewed.renewed, true);
  assert.ok(renewed.leaseUntil > processing.leaseUntil);
  assert.equal(renewed.operationDeadline, processing.operationDeadline);
  assert.deepEqual(
    db.prepare(`
      SELECT
        lease_token=? AS same_token,
        datetime(lease_until)>datetime(?) AS extended,
        datetime(lease_until)<=datetime(operation_deadline) AS capped
      FROM request_idempotency
      WHERE id=?
    `).get(
      processing.leaseToken,
      processing.leaseUntil,
      processing.ledgerId
    ),
    { same_token: 1, extended: 1, capped: 1 }
  );

  const noOp = db.transaction(() => (
    idempotency.renewLeaseInTransaction(db, {
      ledgerId: processing.ledgerId,
      requestHash: input.requestHash,
      leaseToken: processing.leaseToken
    })
  )).immediate();
  assert.deepEqual(noOp, {
    ...renewed,
    renewed: false
  });
  const hostileToken = deterministicHex('hostile-renewal-token');
  assert.throws(
    () => db.transaction(() => (
      idempotency.renewLeaseInTransaction(db, {
        ledgerId: processing.ledgerId,
        requestHash: input.requestHash,
        leaseToken: hostileToken
      })
    )).immediate(),
    (error) => (
      error.code === 'IDEMPOTENCY_IN_PROGRESS' &&
      error.statusCode === 409 &&
      !error.message.includes(hostileToken)
    )
  );
});

test('renew and both reclaim paths map trigger persistence faults to audited 500 errors', (t) => {
  const idempotency = require('../services/idempotency_service');

  const renewalDb = openCampaignDatabase(t);
  const renewalContext = seedCampaign(renewalDb, ' Renewal Fault');
  const renewalInput = requestInput(renewalContext, {
    key: 'task5c-renewal-persistence-fault'
  });
  const renewal = insertProcessingLedger(
    renewalDb,
    renewalInput,
    'task5c-renewal-persistence-fault',
    {
      createdModifier: '-1 minute',
      leaseModifier: '+30 seconds',
      deadlineModifier: '+5 minutes'
    }
  );
  renewalDb.exec(`
    CREATE TRIGGER task5c_renewal_persistence_fault
    BEFORE UPDATE OF lease_until ON request_idempotency
    WHEN OLD.id=${renewal.ledgerId}
      AND NEW.lease_token=OLD.lease_token
      AND datetime(NEW.lease_until)>datetime(OLD.lease_until)
    BEGIN
      SELECT RAISE(ABORT,'task5c renewal persistence fault');
    END
  `);
  assert.throws(
    () => renewalDb.transaction(() => (
      idempotency.renewLeaseInTransaction(renewalDb, {
        ledgerId: renewal.ledgerId,
        requestHash: renewalInput.requestHash,
        leaseToken: renewal.leaseToken
      })
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 500 &&
      error.code === 'AUDIT_PERSISTENCE_FAILED' &&
      error.message ===
        'Idempotency lease renewal could not be persisted safely.' &&
      !error.message.includes(renewal.leaseToken) &&
      !error.message.includes('task5c renewal')
    )
  );
  assert.equal(
    renewalDb.prepare('SELECT lease_until FROM request_idempotency WHERE id=?')
      .get(renewal.ledgerId).lease_until,
    renewal.leaseUntil
  );
  renewalDb.exec(`
    DROP TRIGGER task5c_renewal_persistence_fault;
    CREATE TRIGGER task5c_renewal_cas_loser
    BEFORE UPDATE OF lease_until ON request_idempotency
    WHEN OLD.id=${renewal.ledgerId}
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
  assert.throws(
    () => renewalDb.transaction(() => (
      idempotency.renewLeaseInTransaction(renewalDb, {
        ledgerId: renewal.ledgerId,
        requestHash: renewalInput.requestHash,
        leaseToken: renewal.leaseToken
      })
    )).immediate(),
    (error) => (
      error.statusCode === 409 &&
      error.code === 'IDEMPOTENCY_IN_PROGRESS' &&
      error.message === 'Idempotency lease renewal lost its reservation race.'
    )
  );

  const failedDb = openCampaignDatabase(t);
  const failedContext = seedCampaign(failedDb, ' Failed Fault');
  const failedInput = requestInput(failedContext, {
    key: 'task5c-failed-persistence-fault',
    operationTimeoutSeconds: 300
  });
  const failed = insertFailedLedger(
    failedDb,
    failedInput,
    'task5c-failed-persistence-fault',
    { deadlineModifier: '+5 minutes' }
  );
  failedDb.exec(`
    CREATE TRIGGER task5c_failed_reclaim_persistence_fault
    BEFORE UPDATE OF state,lease_until,lease_token ON request_idempotency
    WHEN OLD.id=${failed.ledgerId}
      AND OLD.state='failed'
      AND NEW.state='processing'
    BEGIN
      SELECT RAISE(ABORT,'task5c failed reclaim persistence fault');
    END
  `);
  assert.throws(
    () => failedDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(failedDb, failedInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 500 &&
      error.code === 'AUDIT_PERSISTENCE_FAILED' &&
      error.message ===
        'Failed idempotency reclaim could not be persisted safely.' &&
      !error.message.includes('task5c failed reclaim')
    )
  );
  assert.deepEqual(
    failedDb.prepare(`
      SELECT state,lease_until,lease_token
      FROM request_idempotency
      WHERE id=?
    `).get(failed.ledgerId),
    { state: 'failed', lease_until: null, lease_token: null }
  );
  failedDb.exec(`
    DROP TRIGGER task5c_failed_reclaim_persistence_fault;
    CREATE TRIGGER task5c_failed_reclaim_cas_loser
    BEFORE UPDATE OF state,lease_until,lease_token ON request_idempotency
    WHEN OLD.id=${failed.ledgerId}
      AND OLD.state='failed'
      AND NEW.state='processing'
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
  assert.throws(
    () => failedDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(failedDb, failedInput)
    )).immediate(),
    (error) => (
      error.statusCode === 409 &&
      error.code === 'IDEMPOTENCY_IN_PROGRESS' &&
      error.message === 'Failed idempotency reclaim lost its reservation race.'
    )
  );

  const expiredDb = openCampaignDatabase(t);
  const expiredContext = seedCampaign(expiredDb, ' Expired Fault');
  const expiredInput = requestInput(expiredContext, {
    key: 'task5c-expired-persistence-fault'
  });
  const expired = insertExpiredProcessingLedger(
    expiredDb,
    expiredInput,
    'task5c-expired-persistence-fault'
  );
  expiredDb.exec(`
    CREATE TRIGGER task5c_expired_reclaim_persistence_fault
    BEFORE UPDATE OF lease_until,lease_token ON request_idempotency
    WHEN OLD.id=${expired.ledgerId}
      AND OLD.state='processing'
      AND NEW.lease_token<>OLD.lease_token
    BEGIN
      SELECT RAISE(ABORT,'task5c expired reclaim persistence fault');
    END
  `);
  assert.throws(
    () => expiredDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(expiredDb, expiredInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 500 &&
      error.code === 'AUDIT_PERSISTENCE_FAILED' &&
      error.message ===
        'Idempotency lease recovery could not be persisted safely.' &&
      !error.message.includes(expired.leaseToken) &&
      !error.message.includes('task5c expired reclaim')
    )
  );
  assert.deepEqual(
    expiredDb.prepare(`
      SELECT state,lease_until,lease_token
      FROM request_idempotency
      WHERE id=?
    `).get(expired.ledgerId),
    {
      state: 'processing',
      lease_until: expired.leaseUntil,
      lease_token: expired.leaseToken
    }
  );
  expiredDb.exec(`
    DROP TRIGGER task5c_expired_reclaim_persistence_fault;
    CREATE TRIGGER task5c_expired_reclaim_cas_loser
    BEFORE UPDATE OF lease_until,lease_token ON request_idempotency
    WHEN OLD.id=${expired.ledgerId}
      AND OLD.state='processing'
      AND NEW.lease_token<>OLD.lease_token
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
  assert.throws(
    () => expiredDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(expiredDb, expiredInput)
    )).immediate(),
    (error) => (
      error.statusCode === 409 &&
      error.code === 'IDEMPOTENCY_IN_PROGRESS' &&
      error.message === 'Idempotency lease recovery lost its reservation race.'
    )
  );
});

test('deadline recovery terminalizes processing and failed rows as the same zero-event JSON 503', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const processingInput = requestInput(context, {
    key: 'task5c-processing-deadline'
  });
  const failedInput = requestInput(context, {
    scope: 'campaign.transition',
    key: 'task5c-failed-deadline',
    expectedEventCount: 1,
    requestHash: sqliteDigest.requestHash({
      method: 'POST',
      path: `/api/campaigns/${context.campaignId}/transitions`,
      campaignId: context.campaignId,
      kind: 'json',
      payload: {
        expected_state: 'lead',
        expected_version: 1,
        next_state: 'qualified',
        reason: 'Deadline fixture'
      }
    })
  });
  const processing = insertProcessingLedger(
    db,
    processingInput,
    'task5c-processing-deadline',
    {
      createdModifier: '-10 minutes',
      leaseModifier: '-6 minutes',
      deadlineModifier: '-5 minutes'
    }
  );
  const failed = insertFailedLedger(
    db,
    failedInput,
    'task5c-failed-deadline'
  );

  const processingResult = db.transaction(() => (
    idempotency.recoverExpiredInTransaction(db, processingInput)
  )).immediate();
  const failedResult = db.transaction(() => (
    idempotency.recoverExpiredInTransaction(db, failedInput)
  )).immediate();
  for (const [result, fixture, input] of [
    [processingResult, processing, processingInput],
    [failedResult, failed, failedInput]
  ]) {
    assert.deepEqual(result, {
      state: 'replay',
      ledgerId: fixture.ledgerId,
      statusCode: 503,
      responseKind: 'json',
      responseBody: DEADLINE_RESPONSE,
      responseHeaders: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
    assert.deepEqual(idempotency.inspectRetained(db, input), result);
    const row = db.prepare(`
      SELECT
        state,status_code,response_kind,response_json,response_headers_json,
        lease_until,lease_token,operation_deadline,expires_at,updated_at,
        unixepoch(expires_at)-unixepoch(updated_at) AS retention_seconds
      FROM request_idempotency
      WHERE id=?
    `).get(fixture.ledgerId);
    assert.deepEqual(row, {
      state: 'completed',
      status_code: 503,
      response_kind: 'json',
      response_json: sqliteDigest.canonicalJsonBytes(
        DEADLINE_RESPONSE
      ).toString('utf8'),
      response_headers_json: '{"Content-Type":"application/json; charset=utf-8"}',
      lease_until: null,
      lease_token: null,
      operation_deadline: fixture.operationDeadline,
      expires_at: row.expires_at,
      updated_at: row.updated_at,
      retention_seconds: 30 * 24 * 60 * 60
    });
  }
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_events
      WHERE audit_fingerprint IN (?,?)
    `).get(
      processing.auditFingerprint,
      failed.auditFingerprint
    ).count,
    0
  );
});

test('retained internal failure reclaims before deadline without changing immutable evidence', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context, {
    key: 'task5c-failed-reclaim',
    operationTimeoutSeconds: 300
  });

  let original;
  db.transaction(() => {
    original = idempotency.reserveProcessingInTransaction(db, input);
    idempotency.failInternalInTransaction(db, {
      ledgerId: original.ledgerId,
      requestHash: input.requestHash,
      leaseToken: original.leaseToken
    });
  }).immediate();
  const reclaimed = db.transaction(() => (
    idempotency.recoverExpiredInTransaction(db, input)
  )).immediate();
  assert.equal(reclaimed.state, 'reserved');
  assert.equal(reclaimed.ledgerId, original.ledgerId);
  assert.equal(reclaimed.recovered, true);
  assert.equal(reclaimed.fromFailed, true);
  assert.equal(reclaimed.reservationNonce, original.reservationNonce);
  assert.equal(reclaimed.auditFingerprint, original.auditFingerprint);
  assert.equal(reclaimed.operationDeadline, original.operationDeadline);
  assert.notEqual(reclaimed.leaseToken, original.leaseToken);
  assert.deepEqual(
    db.prepare(`
      SELECT
        state,reservation_nonce,audit_fingerprint,operation_deadline,
        lease_token,expires_at,
        datetime(lease_until)>CURRENT_TIMESTAMP AS live_lease,
        datetime(lease_until)<=datetime(operation_deadline) AS capped
      FROM request_idempotency
      WHERE id=?
    `).get(original.ledgerId),
    {
      state: 'processing',
      reservation_nonce: original.reservationNonce,
      audit_fingerprint: original.auditFingerprint,
      operation_deadline: original.operationDeadline,
      lease_token: reclaimed.leaseToken,
      expires_at: null,
      live_lease: 1,
      capped: 1
    }
  );

  const completed = db.transaction(() => (
    idempotency.completeJsonInTransaction(db, {
      ledgerId: reclaimed.ledgerId,
      requestHash: input.requestHash,
      leaseToken: reclaimed.leaseToken,
      statusCode: 200,
      responseBody: { reclaimed: true }
    })
  )).immediate();
  assert.deepEqual(completed.responseBody, { reclaimed: true });
});

test('failed reclaim enforces projected standard PPT and parser processing caps', (t) => {
  const idempotency = require('../services/idempotency_service');

  const standardDb = openCampaignDatabase(t);
  const standardContext = seedCampaign(standardDb, ' Standard Reclaim');
  const standardFailedInput = requestInput(standardContext, {
    key: 'task5c-standard-failed-cap',
    operationTimeoutSeconds: 300,
    requestHash: deterministicHex('task5c-standard-failed-cap-request')
  });
  const standardFailed = insertFailedLedger(
    standardDb,
    standardFailedInput,
    'task5c-standard-failed-cap',
    { deadlineModifier: '+5 minutes' }
  );
  for (let index = 0; index < 8; index += 1) {
    const input = requestInput(standardContext, {
      key: `task5c-standard-live-${String(index).padStart(2, '0')}`,
      requestHash: deterministicHex(`task5c-standard-live:${index}`)
    });
    standardDb.transaction(() => (
      idempotency.reserveProcessingInTransaction(standardDb, input)
    )).immediate();
  }
  assert.throws(
    () => standardDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(
        standardDb,
        standardFailedInput
      )
    )).immediate(),
    (error) => (
      error.statusCode === 429 &&
      error.code === 'IDEMPOTENCY_RATE_LIMITED'
    )
  );
  assert.equal(
    standardDb.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(standardFailed.ledgerId).state,
    'failed'
  );

  const pptDb = openCampaignDatabase(t);
  const pptContext = seedCampaign(pptDb, ' PPT Reclaim');
  const pptFailedInput = requestInput(pptContext, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-ppt-failed-cap',
    requestHash: deterministicHex('task5c-ppt-failed-cap-request'),
    resourceClaim: deterministicHex('task5c-ppt-failed-cap-claim'),
    expectedEventCount: 1,
    operationTimeoutSeconds: 300
  });
  const pptFailed = insertFailedLedger(
    pptDb,
    pptFailedInput,
    'task5c-ppt-failed-cap',
    { deadlineModifier: '+5 minutes' }
  );
  for (let index = 0; index < 2; index += 1) {
    const input = requestInput(pptContext, {
      scope: 'proposal.ppt.generate.linked',
      key: `task5c-ppt-live-${String(index).padStart(2, '0')}`,
      requestHash: deterministicHex(`task5c-ppt-live:${index}`),
      resourceClaim: deterministicHex(`task5c-ppt-live-claim:${index}`),
      expectedEventCount: 1
    });
    pptDb.transaction(() => (
      idempotency.reserveProcessingInTransaction(pptDb, input)
    )).immediate();
  }
  assert.throws(
    () => pptDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(pptDb, pptFailedInput)
    )).immediate(),
    (error) => (
      error.statusCode === 429 &&
      error.code === 'PPT_GENERATION_RATE_LIMITED'
    )
  );
  assert.equal(
    pptDb.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(pptFailed.ledgerId).state,
    'failed'
  );

  const parserDb = openCampaignDatabase(t);
  const parserContext = seedCampaign(parserDb, ' Parser Reclaim');
  const parserFailedInput = requestInput(parserContext, {
    campaignId: null,
    scope: 'parser.knowledge-upload.admission',
    key: 'task5c-parser-failed-cap',
    requestHash: deterministicHex('task5c-parser-failed-cap-request'),
    expectedEventCount: 0,
    operationTimeoutSeconds: 90
  });
  const parserFailed = insertFailedLedger(
    parserDb,
    parserFailedInput,
    'task5c-parser-failed-cap',
    { deadlineModifier: '+5 minutes' }
  );
  const parserLiveInput = {
    ...parserFailedInput,
    key: 'task5c-parser-live-cap',
    requestHash: deterministicHex('task5c-parser-live-cap-request')
  };
  parserDb.transaction(() => (
    idempotency.reserveProcessingInTransaction(parserDb, parserLiveInput)
  )).immediate();
  assert.throws(
    () => parserDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(parserDb, parserFailedInput)
    )).immediate(),
    (error) => (
      error.statusCode === 429 &&
      error.code === 'IDEMPOTENCY_RATE_LIMITED'
    )
  );
  assert.equal(
    parserDb.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(parserFailed.ledgerId).state,
    'failed'
  );
});

test('failed reclaim does not recharge hourly starts or retained storage across quota profiles', (t) => {
  const idempotency = require('../services/idempotency_service');

  const standardDb = openCampaignDatabase(t);
  const standardContext = seedCampaign(standardDb, ' Standard Accounting');
  const standardFailedInput = requestInput(standardContext, {
    key: 'task5c-standard-accounting-failed',
    requestHash: deterministicHex('task5c-standard-accounting-failed-request'),
    operationTimeoutSeconds: 300
  });
  insertFailedLedger(
    standardDb,
    standardFailedInput,
    'task5c-standard-accounting-failed',
    { deadlineModifier: '+5 minutes' }
  );
  for (let index = 0; index < 499; index += 1) {
    const input = requestInput(standardContext, {
      key: `task5c-standard-retained-${String(index).padStart(3, '0')}`,
      requestHash: deterministicHex(`task5c-standard-retained:${index}`)
    });
    insertCompletedJsonLedger(
      standardDb,
      input,
      `task5c-standard-retained:${index}`,
      index < 199
        ? {
          createdModifier: '-30 minutes',
          updatedModifier: '-20 minutes',
          deadlineModifier: '-25 minutes',
          expiresModifier: '+29 days'
        }
        : {
          createdModifier: '-2 hours',
          updatedModifier: '-1 hour',
          deadlineModifier: '-90 minutes',
          expiresModifier: '+29 days'
        }
    );
  }
  assert.deepEqual(
    standardDb.prepare(`
      SELECT
        SUM(CASE
          WHEN user_id=? AND scope='campaign.update'
          THEN 1 ELSE 0
        END) AS retained,
        SUM(CASE
          WHEN user_id=?
            AND datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
          THEN 1 ELSE 0
        END) AS hourly,
        SUM(CASE
          WHEN user_id=? AND state='processing'
          THEN 1 ELSE 0
        END) AS processing
      FROM request_idempotency
    `).get(
      standardContext.actorUserId,
      standardContext.actorUserId,
      standardContext.actorUserId
    ),
    { retained: 500, hourly: 200, processing: 0 }
  );
  assert.equal(
    standardDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(
        standardDb,
        standardFailedInput
      )
    )).immediate().state,
    'reserved'
  );

  const pptDb = openCampaignDatabase(t);
  const pptContext = seedCampaign(pptDb, ' PPT Accounting');
  const pptFailedInput = requestInput(pptContext, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-ppt-accounting-failed',
    requestHash: deterministicHex('task5c-ppt-accounting-failed-request'),
    resourceClaim: deterministicHex('task5c-ppt-accounting-failed-claim'),
    expectedEventCount: 1,
    operationTimeoutSeconds: 300
  });
  insertFailedLedger(
    pptDb,
    pptFailedInput,
    'task5c-ppt-accounting-failed',
    { deadlineModifier: '+5 minutes' }
  );
  for (let index = 0; index < 50; index += 1) {
    const input = requestInput(pptContext, {
      scope: 'proposal.ppt.generate.linked',
      key: `task5c-ppt-artifact-${String(index).padStart(2, '0')}`,
      requestHash: deterministicHex(`task5c-ppt-artifact:${index}`),
      resourceClaim: deterministicHex(`task5c-ppt-artifact-claim:${index}`),
      expectedEventCount: 1
    });
    insertCompletedBinaryLedger(
      pptDb,
      input,
      `task5c-ppt-artifact:${index}`,
      index < 19
        ? {
          createdModifier: '-30 minutes',
          updatedModifier: '-20 minutes',
          deadlineModifier: '-25 minutes',
          expiresModifier: '+29 days'
        }
        : {
          createdModifier: '-2 days',
          updatedModifier: '-1 day',
          deadlineModifier: '-47 hours',
          expiresModifier: '+29 days'
        }
    );
  }
  assert.deepEqual(
    pptDb.prepare(`
      SELECT
        SUM(CASE
          WHEN user_id=? AND state='completed' AND response_kind='binary'
          THEN 1 ELSE 0
        END) AS artifacts,
        SUM(CASE
          WHEN user_id=?
            AND datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
          THEN 1 ELSE 0
        END) AS hourly,
        SUM(CASE
          WHEN user_id=? AND state='processing'
          THEN 1 ELSE 0
        END) AS processing
      FROM request_idempotency
      WHERE scope IN (
        'proposal.ppt.generate.linked',
        'proposal.ppt.generate.unlinked.admission'
      )
    `).get(
      pptContext.actorUserId,
      pptContext.actorUserId,
      pptContext.actorUserId
    ),
    { artifacts: 50, hourly: 20, processing: 0 }
  );
  assert.equal(
    pptDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(pptDb, pptFailedInput)
    )).immediate().state,
    'reserved'
  );

  const parserDb = openCampaignDatabase(t);
  const parserContext = seedCampaign(parserDb, ' Parser Accounting');
  const parserFailedInput = requestInput(parserContext, {
    campaignId: null,
    scope: 'parser.knowledge-upload.admission',
    key: 'task5c-parser-accounting-failed',
    requestHash: deterministicHex('task5c-parser-accounting-failed-request'),
    expectedEventCount: 0,
    operationTimeoutSeconds: 90
  });
  insertFailedLedger(
    parserDb,
    parserFailedInput,
    'task5c-parser-accounting-failed',
    { deadlineModifier: '+5 minutes' }
  );
  for (let index = 0; index < 19; index += 1) {
    const input = {
      ...parserFailedInput,
      key: `task5c-parser-admission-${String(index).padStart(2, '0')}`,
      requestHash: deterministicHex(`task5c-parser-admission:${index}`)
    };
    insertCompletedAdmissionLedger(
      parserDb,
      input,
      `task5c-parser-admission:${index}`,
      {
        createdModifier: '-30 minutes',
        updatedModifier: '-20 minutes',
        deadlineModifier: '-25 minutes',
        expiresModifier: '+23 hours'
      }
    );
  }
  assert.deepEqual(
    parserDb.prepare(`
      SELECT
        SUM(CASE
          WHEN user_id=?
            AND datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
          THEN 1 ELSE 0
        END) AS hourly,
        SUM(CASE
          WHEN user_id=? AND state='processing'
          THEN 1 ELSE 0
        END) AS processing
      FROM request_idempotency
      WHERE scope IN (
        'parser.knowledge-upload.admission',
        'parser.influencer-upload.admission',
        'parser.demand-parse.admission'
      )
    `).get(
      parserContext.actorUserId,
      parserContext.actorUserId
    ),
    { hourly: 20, processing: 0 }
  );
  assert.equal(
    parserDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(
        parserDb,
        parserFailedInput
      )
    )).immediate().state,
    'reserved'
  );
});

test('failed PPT reclaim classifies a processing claim owner after same-key precedence', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db, ' PPT Reclaim Claim');
  const resourceClaim = deterministicHex('task5c-ppt-reclaim-processing-claim');
  const failedInput = requestInput(context, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-ppt-reclaim-processing-failed',
    requestHash: deterministicHex('task5c-ppt-reclaim-processing-failed-request'),
    resourceClaim,
    expectedEventCount: 1,
    operationTimeoutSeconds: 300
  });
  const failed = insertFailedLedger(
    db,
    failedInput,
    'task5c-ppt-reclaim-processing-failed',
    { deadlineModifier: '+5 minutes' }
  );
  const winnerInput = {
    ...failedInput,
    key: 'task5c-ppt-reclaim-processing-winner',
    requestHash: deterministicHex('task5c-ppt-reclaim-processing-winner-request')
  };
  const winner = insertProcessingLedger(
    db,
    winnerInput,
    'task5c-ppt-reclaim-processing-winner',
    {
      createdModifier: '-1 minute',
      leaseModifier: '+2 minutes',
      deadlineModifier: '+5 minutes'
    }
  );

  assert.deepEqual(
    db.transaction(() => (
      idempotency.recoverExpiredInTransaction(db, {
        ...failedInput,
        requestHash: deterministicHex(
          'task5c-ppt-reclaim-processing-changed-request'
        )
      })
    )).immediate(),
    {
      state: 'conflict',
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    },
    'same-key hash conflict must precede resource-claim classification'
  );

  const expectedRetryAfterSeconds = db.prepare(`
    SELECT MAX(
      1,
      unixepoch(lease_until)-unixepoch(CURRENT_TIMESTAMP)
    ) AS value
    FROM request_idempotency
    WHERE id=?
  `).get(winner.ledgerId).value;
  assert.throws(
    () => db.transaction(() => (
      idempotency.recoverExpiredInTransaction(db, failedInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 409 &&
      error.code === 'PPT_GENERATION_IN_PROGRESS' &&
      error.message ===
        'PPT generation is already in progress for this resource.' &&
      error.retryAfterSeconds === expectedRetryAfterSeconds &&
      Number.isSafeInteger(error.retryAfterSeconds) &&
      error.retryAfterSeconds >= 1 &&
      !error.message.includes(resourceClaim) &&
      !error.message.includes(winner.leaseToken) &&
      !Object.hasOwn(error, 'details')
    )
  );
  assert.equal(
    db.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(failed.ledgerId).state,
    'failed'
  );
});

test('failed PPT reclaim classifies binary claims while unrelated trigger faults remain 500', (t) => {
  const idempotency = require('../services/idempotency_service');

  for (const state of ['completed', 'expiring']) {
    const db = openCampaignDatabase(t);
    const context = seedCampaign(db, ` PPT Reclaim ${state}`);
    const resourceClaim = deterministicHex(
      `task5c-ppt-reclaim-${state}-claim`
    );
    const failedInput = requestInput(context, {
      scope: 'proposal.ppt.generate.linked',
      key: `task5c-ppt-reclaim-${state}-failed`,
      requestHash: deterministicHex(
        `task5c-ppt-reclaim-${state}-failed-request`
      ),
      resourceClaim,
      expectedEventCount: 1,
      operationTimeoutSeconds: 300
    });
    const failed = insertFailedLedger(
      db,
      failedInput,
      `task5c-ppt-reclaim-${state}-failed`,
      { deadlineModifier: '+5 minutes' }
    );
    const winnerInput = {
      ...failedInput,
      key: `task5c-ppt-reclaim-${state}-winner`,
      requestHash: deterministicHex(
        `task5c-ppt-reclaim-${state}-winner-request`
      )
    };
    const winner = insertCompletedBinaryLedger(
      db,
      winnerInput,
      `task5c-ppt-reclaim-${state}-winner`,
      state === 'completed'
        ? {
          createdModifier: '-2 days',
          updatedModifier: '-1 day',
          deadlineModifier: '-47 hours',
          expiresModifier: '+29 days'
        }
        : undefined
    );
    if (state === 'expiring') {
      assert.equal(
        db.transaction(() => (
          idempotency.recoverExpiredInTransaction(db, winnerInput)
        )).immediate().cleanup,
        'binary'
      );
      assert.equal(
        db.prepare('SELECT state FROM request_idempotency WHERE id=?')
          .get(winner.ledgerId).state,
        'expiring'
      );
    }

    assert.throws(
      () => db.transaction(() => (
        idempotency.recoverExpiredInTransaction(db, failedInput)
      )).immediate(),
      (error) => (
        error.name === 'IdempotencyServiceError' &&
        error.statusCode === 409 &&
        error.code === 'RECORD_ALREADY_LINKED' &&
        error.message === 'The retained PPT resource is already linked.' &&
        !Object.hasOwn(error, 'retryAfterSeconds') &&
        !Object.hasOwn(error, 'details') &&
        !error.message.includes(resourceClaim)
      ),
      state
    );
    assert.equal(
      db.prepare('SELECT state FROM request_idempotency WHERE id=?')
        .get(failed.ledgerId).state,
      'failed'
    );
  }

  const faultDb = openCampaignDatabase(t);
  const faultContext = seedCampaign(faultDb, ' PPT Reclaim Fault');
  const faultClaim = deterministicHex('task5c-ppt-reclaim-unrelated-claim');
  const faultInput = requestInput(faultContext, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-ppt-reclaim-unrelated-failed',
    requestHash: deterministicHex('task5c-ppt-reclaim-unrelated-failed-request'),
    resourceClaim: faultClaim,
    expectedEventCount: 1,
    operationTimeoutSeconds: 300
  });
  const failed = insertFailedLedger(
    faultDb,
    faultInput,
    'task5c-ppt-reclaim-unrelated-failed',
    { deadlineModifier: '+5 minutes' }
  );
  faultDb.exec(`
    CREATE TRIGGER task5c_ppt_reclaim_unrelated_fault
    BEFORE UPDATE OF state ON request_idempotency
    BEGIN
      SELECT RAISE(ABORT,'task5c unrelated reclaim persistence fault');
    END
  `);
  assert.throws(
    () => faultDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(faultDb, faultInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 500 &&
      error.code === 'AUDIT_PERSISTENCE_FAILED' &&
      error.message ===
        'Failed idempotency reclaim could not be persisted safely.' &&
      !Object.hasOwn(error, 'retryAfterSeconds') &&
      !Object.hasOwn(error, 'details') &&
      !error.message.includes(faultClaim) &&
      !error.message.includes('task5c unrelated')
    )
  );
  assert.equal(
    faultDb.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(failed.ledgerId).state,
    'failed'
  );
});

test('expired completed JSON is deleted before changed-hash reuse gets a new nonce and fingerprint', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const originalInput = requestInput(context, {
    key: 'task5c-json-expiry-reuse'
  });
  const expired = insertCompletedJsonLedger(
    db,
    originalInput,
    'task5c-json-expiry-reuse'
  );
  const reusedInput = requestInput(context, {
    key: originalInput.key,
    requestHash: sqliteDigest.requestHash({
      method: 'PATCH',
      path: `/api/campaigns/${context.campaignId}`,
      campaignId: context.campaignId,
      kind: 'json',
      payload: { name: 'Retained key reused after expiry' }
    })
  });

  assert.deepEqual(idempotency.inspectRetained(db, reusedInput), {
    state: 'expired',
    ledgerId: expired.ledgerId,
    statusCode: 410,
    code: 'IDEMPOTENCY_EXPIRED',
    cleanup: 'delete'
  });
  const reused = db.transaction(() => {
    assert.deepEqual(
      idempotency.recoverExpiredInTransaction(db, reusedInput),
      {
        state: 'absent',
        expired: true,
        deleted: true
      }
    );
    return idempotency.reserveProcessingInTransaction(db, reusedInput);
  }).immediate();
  assert.equal(reused.state, 'reserved');
  assert.notEqual(reused.reservationNonce, expired.reservationNonce);
  assert.notEqual(reused.auditFingerprint, expired.auditFingerprint);
  assert.equal(
    reused.auditFingerprint,
    sqliteDigest.auditFingerprint({
      organizationId: reusedInput.organizationId,
      actorUserId: reusedInput.actorUserId,
      scope: reusedInput.scope,
      key: reusedInput.key,
      requestHash: reusedInput.requestHash,
      reservationNonce: reused.reservationNonce
    })
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
    1
  );
});

test('expired binary becomes resumable expiring while preserving every artifact field byte-for-byte', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const resourceClaim = deterministicHex('task5c-binary-resource-claim');
  const input = requestInput(context, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-binary-expiry',
    resourceClaim,
    expectedEventCount: 1
  });
  const binary = insertCompletedBinaryLedger(
    db,
    input,
    'task5c-binary-expiry'
  );
  const changedHashInput = {
    ...input,
    requestHash: deterministicHex('changed-binary-request-hash')
  };
  const expired = {
    state: 'expired',
    ledgerId: binary.ledgerId,
    statusCode: 410,
    code: 'IDEMPOTENCY_EXPIRED',
    cleanup: 'binary'
  };
  const artifactProjection = () => db.prepare(`
    SELECT
      status_code,response_kind,response_json,response_headers_json,
      response_cache_key,response_sha256,response_bytes,response_content_type,
      response_filename,expires_at
    FROM request_idempotency
    WHERE id=?
  `).get(binary.ledgerId);
  const before = artifactProjection();

  assert.deepEqual(idempotency.inspectRetained(db, changedHashInput), expired);
  assert.deepEqual(
    db.transaction(() => (
      idempotency.recoverExpiredInTransaction(db, changedHashInput)
    )).immediate(),
    expired
  );
  assert.equal(
    db.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(binary.ledgerId).state,
    'expiring'
  );
  assert.deepEqual(artifactProjection(), before);
  assert.deepEqual(idempotency.inspectRetained(db, input), expired);
  assert.deepEqual(
    db.transaction(() => (
      idempotency.recoverExpiredInTransaction(db, input)
    )).immediate(),
    expired,
    'resuming expiring must not mutate or delete artifact evidence'
  );
  assert.deepEqual(artifactProjection(), before);
  assert.deepEqual(
    db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, input)
    )).immediate(),
    expired
  );
});

test('expired retained deletion maps trigger aborts to 500 and zero-change CAS to 409', (t) => {
  const idempotency = require('../services/idempotency_service');

  const faultDb = openCampaignDatabase(t);
  const faultContext = seedCampaign(faultDb, ' deletion abort');
  const faultInput = requestInput(faultContext, {
    key: 'task5c-expired-delete-abort',
    requestHash: deterministicHex('task5c-expired-delete-abort-request')
  });
  const fault = insertCompletedJsonLedger(
    faultDb,
    faultInput,
    'task5c-expired-delete-abort'
  );
  faultDb.exec(`
    CREATE TRIGGER task5c_expired_delete_abort
    BEFORE DELETE ON request_idempotency
    BEGIN
      SELECT RAISE(ABORT,'task5c expired deletion persistence fault');
    END
  `);
  assert.throws(
    () => faultDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(faultDb, faultInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 500 &&
      error.code === 'AUDIT_PERSISTENCE_FAILED' &&
      error.message ===
        'Expired idempotency cleanup could not be persisted safely.' &&
      !error.message.includes('task5c')
    )
  );
  assert.equal(
    faultDb.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(fault.ledgerId).state,
    'completed'
  );

  const raceDb = openCampaignDatabase(t);
  const raceContext = seedCampaign(raceDb, ' deletion race');
  const raceInput = requestInput(raceContext, {
    key: 'task5c-expired-delete-ignore',
    requestHash: deterministicHex('task5c-expired-delete-ignore-request')
  });
  const raced = insertCompletedJsonLedger(
    raceDb,
    raceInput,
    'task5c-expired-delete-ignore'
  );
  raceDb.exec(`
    CREATE TRIGGER task5c_expired_delete_ignore
    BEFORE DELETE ON request_idempotency
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
  assert.throws(
    () => raceDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(raceDb, raceInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 409 &&
      error.code === 'IDEMPOTENCY_IN_PROGRESS' &&
      error.message ===
        'Expired idempotency cleanup lost its reservation race.'
    )
  );
  assert.equal(
    raceDb.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(raced.ledgerId).state,
    'completed'
  );
});

test('binary expiry transition maps trigger aborts to 500 and zero-change CAS to 409', (t) => {
  const idempotency = require('../services/idempotency_service');

  const faultDb = openCampaignDatabase(t);
  const faultContext = seedCampaign(faultDb, ' binary abort');
  const faultInput = requestInput(faultContext, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-binary-expiry-abort',
    requestHash: deterministicHex('task5c-binary-expiry-abort-request'),
    resourceClaim: deterministicHex('task5c-binary-expiry-abort-claim'),
    expectedEventCount: 1
  });
  const fault = insertCompletedBinaryLedger(
    faultDb,
    faultInput,
    'task5c-binary-expiry-abort'
  );
  faultDb.exec(`
    CREATE TRIGGER task5c_binary_expiry_abort
    BEFORE UPDATE OF state ON request_idempotency
    BEGIN
      SELECT RAISE(ABORT,'task5c binary expiry persistence fault');
    END
  `);
  assert.throws(
    () => faultDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(faultDb, faultInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 500 &&
      error.code === 'AUDIT_PERSISTENCE_FAILED' &&
      error.message ===
        'Binary idempotency expiry could not be persisted safely.' &&
      !error.message.includes('task5c')
    )
  );
  assert.equal(
    faultDb.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(fault.ledgerId).state,
    'completed'
  );

  const raceDb = openCampaignDatabase(t);
  const raceContext = seedCampaign(raceDb, ' binary race');
  const raceInput = requestInput(raceContext, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-binary-expiry-ignore',
    requestHash: deterministicHex('task5c-binary-expiry-ignore-request'),
    resourceClaim: deterministicHex('task5c-binary-expiry-ignore-claim'),
    expectedEventCount: 1
  });
  const raced = insertCompletedBinaryLedger(
    raceDb,
    raceInput,
    'task5c-binary-expiry-ignore'
  );
  raceDb.exec(`
    CREATE TRIGGER task5c_binary_expiry_ignore
    BEFORE UPDATE OF state ON request_idempotency
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
  assert.throws(
    () => raceDb.transaction(() => (
      idempotency.recoverExpiredInTransaction(raceDb, raceInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 409 &&
      error.code === 'IDEMPOTENCY_IN_PROGRESS' &&
      error.message ===
        'Binary idempotency expiry lost its reservation race.'
    )
  );
  assert.equal(
    raceDb.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(raced.ledgerId).state,
    'completed'
  );
});

test('retained binary replays typed artifact metadata while admission remains accounting-only', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const binaryInput = requestInput(context, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-binary-replay',
    resourceClaim: deterministicHex('task5c-binary-replay-resource'),
    expectedEventCount: 1,
    requestHash: deterministicHex('task5c-binary-replay-request')
  });
  const binary = insertCompletedBinaryLedger(
    db,
    binaryInput,
    'task5c-binary-replay',
    {
      createdModifier: '-2 days',
      updatedModifier: '-1 day',
      deadlineModifier: '-47 hours',
      expiresModifier: '+29 days'
    }
  );
  const binaryReplay = {
    state: 'replay',
    ledgerId: binary.ledgerId,
    statusCode: 200,
    responseKind: 'binary',
    responseCacheKey: binary.responseCacheKey,
    responseSha256: binary.responseSha256,
    responseBytes: binary.responseBytes,
    responseContentType: binary.responseContentType,
    responseFilename: binary.responseFilename
  };
  assert.deepEqual(idempotency.inspectRetained(db, binaryInput), binaryReplay);
  assert.deepEqual(
    db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, binaryInput)
    )).immediate(),
    binaryReplay
  );
  assert.deepEqual(
    idempotency.inspectRetained(db, {
      ...binaryInput,
      requestHash: deterministicHex('task5c-binary-replay-conflict')
    }),
    {
      state: 'conflict',
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    }
  );

  const admissionInput = requestInput(context, {
    campaignId: null,
    scope: 'proposal.ppt.generate.unlinked.admission',
    key: 'task5c-admission-retained',
    expectedEventCount: 0,
    requestHash: deterministicHex('task5c-admission-retained-request')
  });
  const admission = insertCompletedAdmissionLedger(
    db,
    admissionInput,
    'task5c-admission-retained'
  );
  const accountingOnly = {
    state: 'retained',
    ledgerId: admission.ledgerId,
    responseKind: 'admission',
    replayable: false
  };
  assert.deepEqual(
    idempotency.inspectRetained(db, admissionInput),
    accountingOnly
  );
  assert.deepEqual(
    db.transaction(() => (
      idempotency.recoverExpiredInTransaction(db, admissionInput)
    )).immediate(),
    accountingOnly
  );
});

test('PPT claim trigger classifies a processing winner with exact lease retry metadata', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const resourceClaim = deterministicHex('task5c-ppt-trigger-processing-claim');
  const winnerInput = requestInput(context, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-ppt-trigger-winner',
    requestHash: deterministicHex('task5c-ppt-trigger-winner-request'),
    resourceClaim,
    expectedEventCount: 1
  });
  const winner = db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, winnerInput)
  )).immediate();
  const loserInput = {
    ...winnerInput,
    key: 'task5c-ppt-trigger-loser',
    requestHash: deterministicHex('task5c-ppt-trigger-loser-request')
  };
  const expectedRetryAfterSeconds = db.prepare(`
    SELECT MAX(
      1,
      unixepoch(lease_until)-unixepoch(CURRENT_TIMESTAMP)
    ) AS value
    FROM request_idempotency
    WHERE id=?
  `).get(winner.ledgerId).value;

  assert.throws(
    () => db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, loserInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 409 &&
      error.code === 'PPT_GENERATION_IN_PROGRESS' &&
      error.message ===
        'PPT generation is already in progress for this resource.' &&
      error.retryAfterSeconds === expectedRetryAfterSeconds &&
      Number.isSafeInteger(error.retryAfterSeconds) &&
      error.retryAfterSeconds >= 1 &&
      !error.message.includes(resourceClaim) &&
      !error.message.includes(winner.leaseToken)
    )
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
    1
  );
});

test('PPT claim trigger classifies retained binary and expiring claims without misclassifying unrelated triggers', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);

  for (const state of ['completed', 'expiring']) {
    const resourceClaim = deterministicHex(`task5c-ppt-trigger-${state}-claim`);
    const winnerInput = requestInput(context, {
      scope: 'proposal.ppt.generate.linked',
      key: `task5c-ppt-${state}-winner`,
      requestHash: deterministicHex(`task5c-ppt-${state}-winner-request`),
      resourceClaim,
      expectedEventCount: 1
    });
    const winner = insertCompletedBinaryLedger(
      db,
      winnerInput,
      `task5c-ppt-${state}-winner`,
      state === 'completed'
        ? {
          createdModifier: '-2 days',
          updatedModifier: '-1 day',
          deadlineModifier: '-47 hours',
          expiresModifier: '+29 days'
        }
        : undefined
    );
    if (state === 'expiring') {
      const disposition = db.transaction(() => (
        idempotency.recoverExpiredInTransaction(db, winnerInput)
      )).immediate();
      assert.equal(disposition.cleanup, 'binary');
      assert.equal(
        db.prepare('SELECT state FROM request_idempotency WHERE id=?')
          .get(winner.ledgerId).state,
        'expiring'
      );
    }
    const loserInput = {
      ...winnerInput,
      key: `task5c-ppt-${state}-loser`,
      requestHash: deterministicHex(`task5c-ppt-${state}-loser-request`)
    };
    assert.throws(
      () => db.transaction(() => (
        idempotency.reserveProcessingInTransaction(db, loserInput)
      )).immediate(),
      (error) => (
        error.name === 'IdempotencyServiceError' &&
        error.statusCode === 409 &&
        error.code === 'RECORD_ALREADY_LINKED' &&
        error.message === 'The retained PPT resource is already linked.' &&
        !Object.hasOwn(error, 'retryAfterSeconds') &&
        !error.message.includes(resourceClaim)
      )
    );
  }

  db.exec(`
    CREATE TRIGGER task5c_unrelated_reservation_fault
    BEFORE INSERT ON request_idempotency
    WHEN NEW.idempotency_key='task5c-unrelated-trigger'
    BEGIN
      SELECT RAISE(ABORT,'task5c unrelated reservation fault');
    END
  `);
  const unrelatedInput = requestInput(context, {
    scope: 'proposal.ppt.generate.linked',
    key: 'task5c-unrelated-trigger',
    requestHash: deterministicHex('task5c-unrelated-trigger-request'),
    resourceClaim: deterministicHex('task5c-unrelated-trigger-claim'),
    expectedEventCount: 1
  });
  assert.throws(
    () => db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, unrelatedInput)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 400 &&
      error.code === 'INVALID_CAMPAIGN_INPUT' &&
      error.code !== 'PPT_GENERATION_IN_PROGRESS' &&
      error.code !== 'RECORD_ALREADY_LINKED'
    )
  );
});

test('non-PPT concurrency quota admits eight per user and checks retained keys before rejecting the ninth', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const reservations = [];

  for (let index = 0; index < 8; index += 1) {
    const input = requestInput(context, {
      key: `task5c-concurrency-${String(index).padStart(2, '0')}`,
      requestHash: deterministicHex(`task5c-concurrency-request:${index}`)
    });
    reservations.push({
      input,
      reservation: db.transaction(() => (
        idempotency.reserveProcessingInTransaction(db, input)
      )).immediate()
    });
  }
  assert.ok(reservations.every(({ reservation }) => reservation.state === 'reserved'));
  assert.deepEqual(
    db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, reservations[0].input)
    )).immediate(),
    {
      state: 'processing',
      ledgerId: reservations[0].reservation.ledgerId,
      recoverable: false,
      retryAfterSeconds: idempotency.inspectRetained(
        db,
        reservations[0].input
      ).retryAfterSeconds
    },
    'same-key lookup must run before quota admission'
  );

  const ninth = requestInput(context, {
    key: 'task5c-concurrency-08',
    requestHash: deterministicHex('task5c-concurrency-request:8')
  });
  assert.throws(
    () => db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, ninth)
    )).immediate(),
    (error) => (
      error.statusCode === 429 &&
      error.code === 'IDEMPOTENCY_RATE_LIMITED' &&
      !error.message.includes(ninth.key) &&
      !error.message.includes(ninth.requestHash)
    )
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
    8
  );
});

test('JSON completion enforces projected retained UTF-8 byte quotas without consuming the lease', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const retainedPayload = { data: 'a'.repeat(1048480) };

  for (let index = 0; index < 32; index += 1) {
    const input = requestInput(context, {
      key: `task5c-bytes-${String(index).padStart(3, '0')}`,
      requestHash: deterministicHex(`task5c-bytes-request:${index}`)
    });
    insertCompletedJsonLedger(
      db,
      input,
      `task5c-bytes:${index}`,
      {
        responseBody: retainedPayload,
        createdModifier: '-2 hours',
        updatedModifier: '-1 hour',
        deadlineModifier: '-90 minutes',
        expiresModifier: '+29 days'
      }
    );
  }
  const existingBytes = db.prepare(`
    SELECT SUM(length(CAST(response_json AS BLOB))) AS bytes
    FROM request_idempotency
    WHERE user_id=? AND scope='campaign.update'
      AND state='completed' AND response_kind='json'
  `).get(context.actorUserId).bytes;
  assert.ok(existingBytes < 32 * 1024 * 1024);

  const input = requestInput(context, {
    key: 'task5c-bytes-projected',
    requestHash: deterministicHex('task5c-bytes-projected-request')
  });
  const reservation = db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, input)
  )).immediate();
  const responseBody = { data: 'b'.repeat(5000) };
  assert.ok(
    existingBytes + sqliteDigest.canonicalJsonBytes(responseBody).length >
      32 * 1024 * 1024
  );
  assert.throws(
    () => db.transaction(() => (
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: input.requestHash,
        leaseToken: reservation.leaseToken,
        statusCode: 200,
        responseBody
      })
    )).immediate(),
    (error) => (
      error.statusCode === 507 &&
      error.code === 'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED' &&
      !error.message.includes(input.key) &&
      !error.message.includes(input.requestHash)
    )
  );
  assert.deepEqual(
    db.prepare(`
      SELECT state,lease_token,status_code,response_kind,response_json,expires_at
      FROM request_idempotency
      WHERE id=?
    `).get(reservation.ledgerId),
    {
      state: 'processing',
      lease_token: reservation.leaseToken,
      status_code: null,
      response_kind: null,
      response_json: null,
      expires_at: null
    }
  );
});

test('campaign-create inspection resolves the stored campaign for reauthorization without requiring a generated ID', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context, {
    scope: 'campaign.create',
    key: 'task5c-campaign-create',
    expectedEventCount: 1,
    requestHash: sqliteDigest.requestHash({
      method: 'POST',
      path: '/api/campaigns',
      campaignId: null,
      kind: 'json',
      payload: {
        name: 'Task 5C Campaign',
        opportunity_id: context.opportunityId,
        owner_user_id: context.actorUserId,
        team_id: context.teamId
      }
    })
  });
  const reservation = db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, input)
  )).immediate();
  const lookup = {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash
  };

  assert.deepEqual(idempotency.inspectRetained(db, lookup), {
    state: 'retained',
    ledgerId: reservation.ledgerId,
    campaignId: context.campaignId
  });
  assert.equal(idempotency.inspectRetained(db, input).state, 'processing');
  const conflict = idempotency.inspectRetained(db, {
    ...input,
    requestHash: deterministicHex('task5c-create-changed-hash')
  });
  assert.deepEqual(conflict, {
    state: 'conflict',
    statusCode: 409,
    code: 'IDEMPOTENCY_KEY_REUSED'
  });
  assert.equal(Object.hasOwn(conflict, 'campaignId'), false);
});

test('POST /api/campaigns serializes same-key workers into replay or changed-hash conflict', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-create-race-'));
  const dbPath = path.join(directory, 'campaign-create.sqlite');
  const db = openCampaignDatabase(t, dbPath);
  t.after(() => {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  db.pragma('journal_mode = WAL');
  const context = seedCampaign(db);
  const databaseModulePath = require.resolve('better-sqlite3');
  const servicePath = path.resolve(
    __dirname,
    '../services/campaign_service.js'
  );

  async function race(inputOne, inputTwo) {
    const workers = [
      createCampaignServiceWorker({
        databaseModulePath,
        servicePath,
        dbPath,
        input: inputOne
      }),
      createCampaignServiceWorker({
        databaseModulePath,
        servicePath,
        dbPath,
        input: inputTwo
      })
    ];
    await Promise.all(workers.map((entry) => entry.ready));
    workers.forEach((entry) => entry.worker.postMessage({ type: 'start' }));
    return Promise.all(workers.map((entry) => entry.result));
  }

  const sameKey = 'campaign-create-worker-same-hash';
  const sameBody = {
    name: 'Concurrent same-hash campaign',
    opportunity_id: context.opportunityId,
    owner_user_id: context.actorUserId,
    team_id: context.teamId
  };
  const sameOutcomes = await race(
    {
      userId: context.actorUserId,
      requestId: 'campaign-worker-same-one',
      idempotencyKey: sameKey,
      body: sameBody
    },
    {
      userId: context.actorUserId,
      requestId: 'campaign-worker-same-two',
      idempotencyKey: sameKey,
      body: sameBody
    }
  );
  assert.ok(sameOutcomes.every((outcome) => outcome.ok));
  assert.ok(sameOutcomes.every((outcome) => outcome.value.status === 201));
  assert.deepEqual(sameOutcomes[0].value.body, sameOutcomes[1].value.body);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM campaigns WHERE name=?')
      .get(sameBody.name).count,
    1
  );
  assert.deepEqual(
    db.prepare(`
      SELECT
        COUNT(*) AS ledgers,
        (
          SELECT COUNT(*)
          FROM campaign_events event
          WHERE event.audit_fingerprint=MAX(ledger.audit_fingerprint)
        ) AS events
      FROM request_idempotency ledger
      WHERE ledger.scope='campaign.create' AND ledger.idempotency_key=?
    `).get(sameKey),
    { ledgers: 1, events: 1 }
  );

  const changedKey = 'campaign-create-worker-changed-hash';
  const changedBodies = [
    {
      name: 'Concurrent changed-hash campaign A',
      opportunity_id: context.opportunityId,
      owner_user_id: context.actorUserId,
      team_id: context.teamId
    },
    {
      name: 'Concurrent changed-hash campaign B',
      opportunity_id: context.opportunityId,
      owner_user_id: context.actorUserId,
      team_id: context.teamId
    }
  ];
  const changedOutcomes = await race(
    {
      userId: context.actorUserId,
      requestId: 'campaign-worker-changed-one',
      idempotencyKey: changedKey,
      body: changedBodies[0]
    },
    {
      userId: context.actorUserId,
      requestId: 'campaign-worker-changed-two',
      idempotencyKey: changedKey,
      body: changedBodies[1]
    }
  );
  const changedSuccesses = changedOutcomes.filter((outcome) => outcome.ok);
  const changedConflicts = changedOutcomes.filter((outcome) => (
    !outcome.ok &&
    outcome.error.statusCode === 409 &&
    outcome.error.code === 'IDEMPOTENCY_KEY_REUSED'
  ));
  assert.equal(changedSuccesses.length, 1);
  assert.equal(changedSuccesses[0].value.status, 201);
  assert.equal(changedConflicts.length, 1);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaigns
      WHERE name IN (?,?)
    `).get(changedBodies[0].name, changedBodies[1].name).count,
    1
  );
  assert.deepEqual(
    db.prepare(`
      SELECT
        COUNT(*) AS ledgers,
        (
          SELECT COUNT(*)
          FROM campaign_events event
          WHERE event.audit_fingerprint=MAX(ledger.audit_fingerprint)
        ) AS events
      FROM request_idempotency ledger
      WHERE ledger.scope='campaign.create' AND ledger.idempotency_key=?
    `).get(changedKey),
    { ledgers: 1, events: 1 }
  );
});

test('null-campaign admission and template lookup require an explicit null campaign identity', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const admissionInput = requestInput(context, {
    campaignId: null,
    scope: 'proposal.ppt.generate.unlinked.admission',
    key: 'task5c-null-campaign-admission',
    requestHash: deterministicHex('task5c-null-campaign-admission-request')
  });
  const admission = insertCompletedAdmissionLedger(
    db,
    admissionInput,
    'task5c-null-campaign-admission'
  );
  const admissionLookup = {
    organizationId: admissionInput.organizationId,
    actorUserId: admissionInput.actorUserId,
    campaignId: null,
    scope: admissionInput.scope,
    key: admissionInput.key,
    requestHash: admissionInput.requestHash
  };
  assert.deepEqual(idempotency.inspectRetained(db, admissionLookup), {
    state: 'retained',
    ledgerId: admission.ledgerId,
    responseKind: 'admission',
    replayable: false,
    campaignId: null,
    secondaryCampaignId: null,
    resourceClaim: null,
    expectedEventCount: 0
  });

  const templateLookup = {
    organizationId: context.organizationId,
    actorUserId: context.actorUserId,
    campaignId: null,
    scope: 'workflow.campaign-template.create',
    key: 'task5c-null-campaign-template',
    requestHash: deterministicHex('task5c-null-campaign-template-request')
  };
  assert.deepEqual(
    idempotency.inspectRetained(db, templateLookup),
    { state: 'absent' }
  );

  for (const lookup of [admissionLookup, templateLookup]) {
    const omittedCampaign = { ...lookup };
    delete omittedCampaign.campaignId;
    assert.throws(
      () => idempotency.inspectRetained(db, omittedCampaign),
      (error) => (
        error instanceof TypeError &&
        error.message === 'invalid idempotency input'
      )
    );
    assert.throws(
      () => idempotency.inspectRetained(db, {
        ...lookup,
        campaignId: context.campaignId
      }),
      (error) => (
        error instanceof TypeError &&
        error.message === 'invalid idempotency input'
      )
    );
  }
});

test('hostile core inputs are rejected without invoking accessors or exposing SQLite details', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  let getterCalls = 0;
  const accessorInput = {};
  Object.defineProperty(accessorInput, 'organizationId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return context.organizationId;
    }
  });
  assert.throws(
    () => idempotency.inspectRetained(db, accessorInput),
    (error) => (
      error instanceof TypeError &&
      error.message === 'invalid idempotency input'
    )
  );
  assert.equal(getterCalls, 0);

  const hostileProxy = new Proxy({}, {
    ownKeys() {
      throw new Error('hostile proxy trap');
    }
  });
  assert.throws(
    () => idempotency.inspectRetained(db, hostileProxy),
    (error) => (
      error instanceof TypeError &&
      error.message === 'invalid idempotency input' &&
      !error.message.includes('hostile')
    )
  );

  const boundedInput = requestInput(context, {
    key: 'task5c-hostile-bounds'
  });
  for (const invalid of [
    { ...boundedInput, organizationId: 0 },
    { ...boundedInput, actorUserId: Number.MAX_SAFE_INTEGER + 1 },
    { ...boundedInput, operationTimeoutSeconds: 0 },
    { ...boundedInput, operationTimeoutSeconds: 601 },
    { ...boundedInput, key: 'short' },
    { ...boundedInput, requestHash: 'A'.repeat(64) },
    { ...boundedInput, expectedEventCount: 1 },
    { ...boundedInput, source: 'forged-client-source' }
  ]) {
    assert.throws(
      () => db.transaction(() => (
        idempotency.reserveProcessingInTransaction(db, invalid)
      )).immediate(),
      (error) => (
        error instanceof TypeError &&
        error.message === 'invalid idempotency input'
      )
    );
  }

  const missingCampaign = requestInput(context, {
    campaignId: context.campaignId + 99999,
    key: 'task5c-hostile-missing-campaign',
    requestHash: deterministicHex('task5c-hostile-missing-campaign-request')
  });
  assert.throws(
    () => db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, missingCampaign)
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 400 &&
      error.code === 'INVALID_CAMPAIGN_INPUT' &&
      error.message === 'Idempotency reservation identity was rejected.' &&
      !/sqlite|foreign|constraint|request_hash|campaign_id/i.test(error.message)
    )
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
    0
  );

  const input = requestInput(context, {
    key: 'task5c-hostile-json-document'
  });
  const reservation = db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, input)
  )).immediate();
  const accessorBody = {};
  Object.defineProperty(accessorBody, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return reservation.leaseToken;
    }
  });
  assert.throws(
    () => db.transaction(() => (
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: input.requestHash,
        leaseToken: reservation.leaseToken,
        statusCode: 200,
        responseBody: accessorBody
      })
    )).immediate(),
    (error) => (
      error instanceof TypeError &&
      error.message === 'invalid idempotency input' &&
      !error.message.includes(reservation.leaseToken)
    )
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(
    db.prepare(`
      SELECT state,lease_token,status_code,response_kind
      FROM request_idempotency
      WHERE id=?
    `).get(reservation.ledgerId),
    {
      state: 'processing',
      lease_token: reservation.leaseToken,
      status_code: null,
      response_kind: null
    }
  );

  const prototypeInput = requestInput(context, {
    key: 'task5c-hostile-prototype-key',
    requestHash: deterministicHex('task5c-hostile-prototype-request')
  });
  const prototypeReservation = db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, prototypeInput)
  )).immediate();
  const prototypeBody = JSON.parse(
    '{"__proto__":{"task5cPolluted":true},"safe":true}'
  );
  const prototypeReplay = db.transaction(() => (
    idempotency.completeJsonInTransaction(db, {
      ledgerId: prototypeReservation.ledgerId,
      requestHash: prototypeInput.requestHash,
      leaseToken: prototypeReservation.leaseToken,
      statusCode: 200,
      responseBody: prototypeBody
    })
  )).immediate();
  assert.equal(Object.hasOwn(prototypeReplay.responseBody, '__proto__'), true);
  assert.deepEqual(prototypeReplay.responseBody, prototypeBody);
  assert.equal(Object.prototype.task5cPolluted, undefined);
});

test('JSON completion enforces successful event cardinality and zero-event error cardinality', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context, {
    scope: 'campaign.transition',
    key: 'task5c-event-cardinality',
    expectedEventCount: 1
  });
  const reservation = db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, input)
  )).immediate();

  assert.throws(
    () => db.transaction(() => (
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: input.requestHash,
        leaseToken: reservation.leaseToken,
        statusCode: 200,
        responseBody: { success: true }
      })
    )).immediate(),
    (error) => (
      error.statusCode === 500 &&
      error.code === 'AUDIT_PERSISTENCE_FAILED' &&
      !error.message.includes(input.key) &&
      !error.message.includes(reservation.leaseToken)
    )
  );
  assert.equal(
    db.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(reservation.ledgerId).state,
    'processing'
  );

  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (
      ?,?,'lifecycle_transition','lead','qualified',?,
      'Task 5C cardinality','project_workspace',?,
      'task5c-cardinality-event',?
    )
  `).run(
    context.organizationId,
    context.campaignId,
    context.actorUserId,
    JSON.stringify({ previous_version: 1, next_version: 2 }),
    reservation.auditFingerprint
  );
  assert.throws(
    () => db.transaction(() => (
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: input.requestHash,
        leaseToken: reservation.leaseToken,
        statusCode: 409,
        responseBody: {
          error: 'Campaign state changed.',
          code: 'STALE_CAMPAIGN_STATE',
          request_id: 'task5c-cardinality-error'
        }
      })
    )).immediate(),
    (error) => (
      error.statusCode === 500 &&
      error.code === 'AUDIT_PERSISTENCE_FAILED'
    )
  );
  assert.equal(
    db.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(reservation.ledgerId).state,
    'processing'
  );

  const errorInput = requestInput(context, {
    scope: 'campaign.transition',
    key: 'task5c-zero-event-error',
    expectedEventCount: 1,
    requestHash: deterministicHex('task5c-zero-event-error-request')
  });
  const errorResult = db.transaction(() => {
    const errorReservation = idempotency.reserveProcessingInTransaction(
      db,
      errorInput
    );
    return idempotency.completeJsonInTransaction(db, {
      ledgerId: errorReservation.ledgerId,
      requestHash: errorInput.requestHash,
      leaseToken: errorReservation.leaseToken,
      statusCode: 409,
      responseBody: {
        error: 'Campaign state changed.',
        code: 'STALE_CAMPAIGN_STATE',
        request_id: 'task5c-zero-event-error'
      }
    });
  }).immediate();
  assert.equal(errorResult.state, 'replay');
  assert.equal(errorResult.statusCode, 409);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_events
      WHERE audit_fingerprint=?
    `).get(
      db.prepare(`
        SELECT audit_fingerprint
        FROM request_idempotency
        WHERE id=?
      `).get(errorResult.ledgerId).audit_fingerprint
    ).count,
    0
  );
});

test('outer rollback removes reservation business mutation event and completion together', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context, {
    scope: 'campaign.transition',
    key: 'task5c-outer-rollback',
    expectedEventCount: 1,
    requestHash: deterministicHex('task5c-outer-rollback-request')
  });

  assert.throws(
    () => db.transaction(() => {
      const reservation = idempotency.reserveProcessingInTransaction(db, input);
      db.prepare(`
        UPDATE campaigns
        SET lifecycle_state='qualified',row_version=2
        WHERE id=? AND lifecycle_state='lead' AND row_version=1
      `).run(context.campaignId);
      db.prepare(`
        INSERT INTO campaign_events (
          org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
          reason,source,metadata_json,correlation_id,audit_fingerprint
        ) VALUES (
          ?,?,'lifecycle_transition','lead','qualified',?,
          'Task 5C rollback','project_workspace',?,
          'task5c-rollback-event',?
        )
      `).run(
        context.organizationId,
        context.campaignId,
        context.actorUserId,
        JSON.stringify({ previous_version: 1, next_version: 2 }),
        reservation.auditFingerprint
      );
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: input.requestHash,
        leaseToken: reservation.leaseToken,
        statusCode: 200,
        responseBody: { success: true }
      });
      throw new Error('task5c injected rollback');
    }).immediate(),
    /task5c injected rollback/
  );
  assert.deepEqual(
    db.prepare(`
      SELECT lifecycle_state,row_version
      FROM campaigns
      WHERE id=?
    `).get(context.campaignId),
    { lifecycle_state: 'lead', row_version: 1 }
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_events').get().count, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
    0
  );
});

test('cross-campaign link correction completes only with one identical reciprocal event per campaign', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const secondaryCampaignId = seedSecondaryCampaign(db, context);
  const input = requestInput(context, {
    scope: 'campaign.link.correct',
    key: 'task5c-reciprocal-link-moved',
    requestHash: deterministicHex('task5c-reciprocal-link-moved-request'),
    secondaryCampaignId,
    expectedEventCount: 2
  });
  const metadataJson = canonicalLinkMovedMetadata(
    context.campaignId,
    secondaryCampaignId
  );

  const completed = db.transaction(() => {
    const reservation = idempotency.reserveProcessingInTransaction(db, input);
    insertLinkMovedEvent(db, {
      context,
      campaignId: context.campaignId,
      metadataJson,
      correlationId: 'task5c-link-move-source',
      auditFingerprint: reservation.auditFingerprint
    });
    insertLinkMovedEvent(db, {
      context,
      campaignId: secondaryCampaignId,
      metadataJson,
      correlationId: 'task5c-link-move-destination',
      auditFingerprint: reservation.auditFingerprint
    });
    return idempotency.completeJsonInTransaction(db, {
      ledgerId: reservation.ledgerId,
      requestHash: input.requestHash,
      leaseToken: reservation.leaseToken,
      statusCode: 200,
      responseBody: {
        success: true,
        source_campaign_id: context.campaignId,
        destination_campaign_id: secondaryCampaignId
      }
    });
  }).immediate();

  assert.equal(completed.state, 'replay');
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(
    db.prepare(`
      SELECT campaign_id AS campaignId,event_type AS eventType,
        metadata_json AS metadataJson
      FROM campaign_events
      WHERE audit_fingerprint=(
        SELECT audit_fingerprint
        FROM request_idempotency
        WHERE id=?
      )
      ORDER BY campaign_id
    `).all(completed.ledgerId),
    [
      {
        campaignId: context.campaignId,
        eventType: 'link_moved',
        metadataJson
      },
      {
        campaignId: secondaryCampaignId,
        eventType: 'link_moved',
        metadataJson
      }
    ]
  );

  const identityBase = {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash
  };
  const conflict = {
    state: 'conflict',
    statusCode: 409,
    code: 'IDEMPOTENCY_KEY_REUSED'
  };
  assert.throws(
    () => idempotency.inspectRetained(db, {
      ...identityBase,
      secondaryCampaignId
    }),
    (error) => (
      error instanceof TypeError &&
      error.message === 'invalid idempotency input'
    ),
    'cross-campaign replay must carry the authorized primary campaign'
  );
  assert.deepEqual(
    idempotency.inspectRetained(db, {
      ...identityBase,
      campaignId: context.campaignId + 99,
      secondaryCampaignId
    }),
    conflict
  );
  assert.throws(
    () => idempotency.inspectRetained(db, {
      ...identityBase,
      campaignId: context.campaignId
    }),
    (error) => (
      error instanceof TypeError &&
      error.message === 'invalid idempotency input'
    ),
    'cross-campaign replay must carry the authorized destination campaign'
  );
  assert.deepEqual(
    idempotency.inspectRetained(db, {
      ...identityBase,
      campaignId: context.campaignId,
      secondaryCampaignId: secondaryCampaignId + 99
    }),
    conflict
  );

  const lostResponseReplay = db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, {
      ...identityBase,
      campaignId: context.campaignId,
      secondaryCampaignId
    })
  )).immediate();
  assert.equal(lostResponseReplay.state, 'replay');
  assert.equal(lostResponseReplay.expectedEventCount, 2);
  assert.equal(lostResponseReplay.campaignId, context.campaignId);
  assert.equal(lostResponseReplay.secondaryCampaignId, secondaryCampaignId);
});

test('same-campaign link correction requires an explicit null secondary identity', (t) => {
  const idempotency = require('../services/idempotency_service');
  const db = openCampaignDatabase(t);
  const context = seedCampaign(db);
  const input = requestInput(context, {
    scope: 'campaign.link.correct',
    key: 'task5c-link-correction-null-secondary',
    requestHash: deterministicHex('task5c-link-correction-null-secondary-request'),
    secondaryCampaignId: null,
    expectedEventCount: 1
  });
  const retained = insertCompletedJsonLedger(
    db,
    input,
    'task5c-link-correction-null-secondary',
    {
      responseBody: { success: true, revoked: true },
      createdModifier: '-2 hours',
      updatedModifier: '-1 hour',
      deadlineModifier: '-90 minutes',
      expiresModifier: '+29 days'
    }
  );
  const lookup = {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    campaignId: input.campaignId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash
  };

  assert.throws(
    () => idempotency.inspectRetained(db, lookup),
    (error) => (
      error instanceof TypeError &&
      error.message === 'invalid idempotency input'
    )
  );
  const replay = idempotency.inspectRetained(db, {
    ...lookup,
    secondaryCampaignId: null
  });
  assert.equal(replay.state, 'replay');
  assert.equal(replay.ledgerId, retained.ledgerId);
});

test('cross-campaign link correction rejects incomplete duplicate-side and mismatched reciprocal events atomically', (t) => {
  const idempotency = require('../services/idempotency_service');
  const scenarios = [
    {
      name: 'missing reciprocal event',
      key: 'task5c-link-move-missing',
      arrange(db, context, secondaryCampaignId, reservation, metadataJson) {
        insertLinkMovedEvent(db, {
          context,
          campaignId: context.campaignId,
          metadataJson,
          correlationId: 'task5c-link-missing-source',
          auditFingerprint: reservation.auditFingerprint
        });
        idempotency.completeJsonInTransaction(db, {
          ledgerId: reservation.ledgerId,
          requestHash: deterministicHex('task5c-link-move-missing-request'),
          leaseToken: reservation.leaseToken,
          statusCode: 200,
          responseBody: { success: true }
        });
      },
      validate(error) {
        return (
          error.name === 'IdempotencyServiceError' &&
          error.statusCode === 500 &&
          error.code === 'AUDIT_PERSISTENCE_FAILED' &&
          error.message ===
            'Idempotency audit event cardinality did not match the reserved outcome.'
        );
      }
    },
    {
      name: 'duplicate primary event',
      key: 'task5c-link-move-duplicate-primary',
      arrange(db, context, secondaryCampaignId, reservation, metadataJson) {
        insertLinkMovedEvent(db, {
          context,
          campaignId: context.campaignId,
          metadataJson,
          correlationId: 'task5c-link-duplicate-one',
          auditFingerprint: reservation.auditFingerprint
        });
        insertLinkMovedEvent(db, {
          context,
          campaignId: context.campaignId,
          metadataJson,
          correlationId: 'task5c-link-duplicate-two',
          auditFingerprint: reservation.auditFingerprint
        });
      },
      validate(error) {
        return (
          error.code === 'SQLITE_CONSTRAINT_TRIGGER' &&
          /campaign_events are append-only/.test(error.message)
        );
      }
    },
    {
      name: 'mismatched reciprocal metadata',
      key: 'task5c-link-move-metadata-mismatch',
      arrange(db, context, secondaryCampaignId, reservation, metadataJson) {
        insertLinkMovedEvent(db, {
          context,
          campaignId: context.campaignId,
          metadataJson,
          correlationId: 'task5c-link-mismatch-source',
          auditFingerprint: reservation.auditFingerprint
        });
        insertLinkMovedEvent(db, {
          context,
          campaignId: secondaryCampaignId,
          metadataJson: canonicalLinkMovedMetadata(
            context.campaignId,
            secondaryCampaignId,
            { replacement_link_ids: [9201, 9203] }
          ),
          correlationId: 'task5c-link-mismatch-destination',
          auditFingerprint: reservation.auditFingerprint
        });
      },
      validate(error) {
        return (
          error.code === 'SQLITE_CONSTRAINT_TRIGGER' &&
          /campaign event request fingerprint is not reserved/.test(error.message)
        );
      }
    }
  ];

  for (const scenario of scenarios) {
    const db = openCampaignDatabase(t);
    const context = seedCampaign(db, ` ${scenario.name}`);
    const secondaryCampaignId = seedSecondaryCampaign(db, context);
    const requestHash = deterministicHex(`${scenario.key}-request`);
    const input = requestInput(context, {
      scope: 'campaign.link.correct',
      key: scenario.key,
      requestHash,
      secondaryCampaignId,
      expectedEventCount: 2
    });
    const metadataJson = canonicalLinkMovedMetadata(
      context.campaignId,
      secondaryCampaignId
    );

    assert.throws(
      () => db.transaction(() => {
        const reservation = idempotency.reserveProcessingInTransaction(db, input);
        scenario.arrange(
          db,
          context,
          secondaryCampaignId,
          reservation,
          metadataJson
        );
      }).immediate(),
      scenario.validate,
      scenario.name
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
      0,
      `${scenario.name} ledger rollback`
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM campaign_events').get().count,
      0,
      `${scenario.name} event rollback`
    );
  }
});
