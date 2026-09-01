'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const {
  FeishuBitableOutboxError,
  createFeishuBitableOutboxService
} = require('../services/feishu_bitable_outbox_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = Object.freeze([
  ['002_campaign_business_spine', 2],
  ['003_campaign_workflow_dispatch_evidence', 3],
  ['004_knowledge_capacity_observability', 4],
  ['005_knowledge_custody_projection', 5],
  ['006_crm_sales_workspace', 6],
  ['007_knowledge_governance', 7],
  ['008_feishu_bitable_outbox', 8]
].map(function(entry) {
  return Object.freeze({
    version: entry[1],
    name: entry[0],
    sourcePath: 'migrations/' + entry[0] + '.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  });
}));

function openDatabase(t) {
  const db = new Database(':memory:');
  t.after(function() { if (db.open) db.close(); });
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  }), { status: 'managed', currentVersion: 8 });
  return db;
}

function identity(db, userId) {
  const row = db.prepare(`
    SELECT user.id AS user_id,membership.org_id,team.team_id
    FROM users user
    JOIN organization_memberships membership
      ON membership.user_id=user.id AND membership.status='active'
    JOIN team_memberships team
      ON team.user_id=user.id AND team.org_id=membership.org_id AND team.status='active'
    WHERE user.id=?
    ORDER BY team.team_id
    LIMIT 1
  `).get(userId);
  assert.ok(row, 'missing test identity');
  return row;
}

function createCampaign(db, owner, id, name) {
  const customerId = id + 1;
  const opportunityId = id + 2;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (?,?,?,'qualified','test',?,?)
  `).run(customerId, name + ' brand', name + ' company', owner.user_id, owner.user_id);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (?,?,'Outbox opportunity','proposal',1000,60,'Product','influencer',?)
  `).run(opportunityId, customerId, owner.user_id);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,?,?,?,?,?,'lead','active',1)
  `).run(id, owner.org_id, name, customerId, opportunityId, owner.user_id, owner.team_id);
  return id;
}

const OPERATION_ID = '5fcb52f9-e94a-4318-8a22-8eb4dc1bc94b';
const DELIVERY_RECORDS = Object.freeze([
  Object.freeze({
    fields: Object.freeze({
      '网红频道名称': '@creator-one',
      '网红频道链接': 'https://example.test/creator-one',
      '项目&客户': 'Launch campaign'
    })
  }),
  Object.freeze({
    fields: Object.freeze({
      '网红频道名称': '@creator-two',
      '网红频道链接': 'https://example.test/creator-two',
      '项目&客户': 'Launch campaign'
    })
  })
]);

function assertDelivery(delivery, expected) {
  assert.deepEqual({
    id: delivery.id,
    campaign_id: delivery.campaign_id,
    status: delivery.status,
    record_count: delivery.record_count,
    remote_record_count: delivery.remote_record_count,
    last_error_code: delivery.last_error_code
  }, expected);
  assert.match(delivery.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(delivery.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
}

test('campaign-scoped Bitable outbox preserves an exact successful receipt for a repeated UUID', (t) => {
  const db = openDatabase(t);
  const owner = identity(db, 2);
  const campaignId = createCampaign(db, owner, 8101, 'Bitable outbox campaign');
  const service = createFeishuBitableOutboxService(db);

  const reservation = service.reserve({
    userId: owner.user_id,
    campaignId,
    operationId: OPERATION_ID,
    records: DELIVERY_RECORDS
  });
  assert.equal(reservation.state, 'reserved');
  assert.equal(reservation.delivery.status, 'pending');
  assert.equal(reservation.delivery.record_count, 2);

  const completed = service.complete({
    deliveryId: reservation.delivery.id,
    reservationToken: reservation.reservationToken,
    remoteRecordIds: ['rec_bitable_1', 'rec_bitable_2']
  });
  assertDelivery(completed, {
    id: reservation.delivery.id,
    campaign_id: campaignId,
    status: 'succeeded',
    record_count: 2,
    remote_record_count: 2,
    last_error_code: null
  });
  assert.match(completed.completed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(completed.failed_at, null);

  const replay = service.reserve({
    userId: owner.user_id,
    campaignId,
    operationId: OPERATION_ID,
    records: DELIVERY_RECORDS
  });
  assert.equal(replay.state, 'replay');
  assert.deepEqual(replay.delivery, completed);

  const stored = db.prepare(`
    SELECT status,record_count,remote_record_ids_json,payload_json
    FROM feishu_bitable_outbox
    WHERE id=?
  `).get(reservation.delivery.id);
  assert.deepEqual(JSON.parse(stored.remote_record_ids_json), ['rec_bitable_1', 'rec_bitable_2']);
  assert.equal(JSON.parse(stored.payload_json).length, 2);
  assert.equal(stored.status, 'succeeded');

  assert.throws(function() {
    db.prepare(`
      UPDATE feishu_bitable_outbox
      SET remote_record_ids_json='["rec_rewritten_1","rec_rewritten_2"]'
      WHERE id=?
    `).run(reservation.delivery.id);
  }, /terminal receipt is immutable/);

  db.pragma('recursive_triggers = OFF');
  assert.throws(function() {
    db.prepare(`
      INSERT OR REPLACE INTO feishu_bitable_outbox (
        id,org_id,campaign_id,actor_user_id,operation_id,reservation_token,
        payload_sha256,payload_json,record_count,status,remote_record_ids_json,
        created_at,updated_at,completed_at
      )
      SELECT
        id,org_id,campaign_id,actor_user_id,operation_id,reservation_token,
        payload_sha256,payload_json,record_count,status,
        '["rec_replaced_1","rec_replaced_2"]',created_at,updated_at,completed_at
      FROM feishu_bitable_outbox
      WHERE id=?
    `).run(reservation.delivery.id);
  }, /cannot replace an existing feishu outbox receipt/);
});

test('campaign-scoped Bitable outbox persists a safe provider failure and refuses a mismatched UUID replay', (t) => {
  const db = openDatabase(t);
  const owner = identity(db, 2);
  const campaignId = createCampaign(db, owner, 8201, 'Bitable failed delivery');
  const service = createFeishuBitableOutboxService(db);

  const reservation = service.reserve({
    userId: owner.user_id,
    campaignId,
    operationId: OPERATION_ID,
    records: DELIVERY_RECORDS
  });
  const failed = service.fail({
    deliveryId: reservation.delivery.id,
    reservationToken: reservation.reservationToken,
    errorCode: 'FEISHU_PROVIDER_UNAVAILABLE'
  });
  assertDelivery(failed, {
    id: reservation.delivery.id,
    campaign_id: campaignId,
    status: 'failed',
    record_count: 2,
    remote_record_count: 0,
    last_error_code: 'FEISHU_PROVIDER_UNAVAILABLE'
  });
  assert.equal(failed.completed_at, null);
  assert.match(failed.failed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const repeatedFailure = service.reserve({
    userId: owner.user_id,
    campaignId,
    operationId: OPERATION_ID,
    records: DELIVERY_RECORDS
  });
  assert.equal(repeatedFailure.state, 'failed');
  assert.deepEqual(repeatedFailure.delivery, failed);

  assert.throws(function() {
    service.reserve({
      userId: owner.user_id,
      campaignId,
      operationId: OPERATION_ID,
      records: [DELIVERY_RECORDS[0]]
    });
  }, function(error) {
    return error instanceof FeishuBitableOutboxError && error.code === 'FEISHU_OUTBOX_IDEMPOTENCY_CONFLICT';
  });
});

test('campaign-scoped Bitable outbox rejects duplicate remote record IDs and lets an owner reconcile an uncertain pending delivery', (t) => {
  const db = openDatabase(t);
  const owner = identity(db, 2);
  const campaignId = createCampaign(db, owner, 8301, 'Bitable reconciliation delivery');
  const service = createFeishuBitableOutboxService(db);
  const reservation = service.reserve({
    userId: owner.user_id,
    campaignId,
    operationId: '93a7e8ed-02e6-48a4-8b0e-64f348450c8b',
    records: DELIVERY_RECORDS
  });

  assert.throws(function() {
    service.complete({
      deliveryId: reservation.delivery.id,
      reservationToken: reservation.reservationToken,
      remoteRecordIds: ['rec_duplicate', 'rec_duplicate']
    });
  }, function(error) {
    return error instanceof FeishuBitableOutboxError && error.code === 'FEISHU_OUTBOX_RECEIPT_INVALID';
  });
  assert.equal(db.prepare('SELECT status FROM feishu_bitable_outbox WHERE id=?').get(reservation.delivery.id).status, 'pending');

  assert.throws(function() {
    db.prepare(`
      UPDATE feishu_bitable_outbox
      SET status='succeeded',remote_record_ids_json='["rec_duplicate","rec_duplicate"]',
        updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(reservation.delivery.id);
  }, /remote record IDs must be unique/);

  const reconciled = service.reconcile({
    userId: owner.user_id,
    campaignId,
    deliveryId: reservation.delivery.id,
    remoteRecordIds: ['rec_reconciled_1', 'rec_reconciled_2']
  });
  assertDelivery(reconciled, {
    id: reservation.delivery.id,
    campaign_id: campaignId,
    status: 'succeeded',
    record_count: 2,
    remote_record_count: 2,
    last_error_code: null
  });
});
