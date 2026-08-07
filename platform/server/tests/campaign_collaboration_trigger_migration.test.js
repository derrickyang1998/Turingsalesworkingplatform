'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');
const V5_MIGRATIONS = migrationGate.REGISTERED_MIGRATIONS;
const V4_MIGRATIONS = Object.freeze(
  V5_MIGRATIONS.filter((migration) => migration.version <= 4)
);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function openDatabase(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  return db;
}

function migrateTo(db, registeredMigrations, currentVersion) {
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations
  }), { status: 'managed', currentVersion });
}

function seedSettlementFixture(db) {
  const actor = db.prepare(`
    SELECT membership.org_id AS orgId,membership.team_id AS teamId,
      membership.user_id AS userId
    FROM team_memberships membership
    JOIN organizations organization ON organization.id=membership.org_id
    WHERE organization.code='turingmarket-default'
      AND membership.status='active'
    ORDER BY membership.user_id,membership.team_id
    LIMIT 1
  `).get();
  const influencer = db.prepare(`
    SELECT id FROM influencers WHERE is_active=1 ORDER BY id LIMIT 1
  `).get();
  assert.ok(actor);
  assert.ok(influencer);

  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (95001,'Trigger Brand','Trigger Brand Ltd','qualified','migration-test',?,?)
  `).run(actor.userId, actor.userId);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (95001,95001,'Trigger opportunity','proposal',1000,75,'Trigger Product','influencer',?)
  `).run(actor.userId);
  db.prepare(`
    INSERT INTO demands (
      id,user_id,brand_name,company_name,product_name,industry,budget,target_market,
      platform,status,data_json
    ) VALUES (
      95001,?,'Trigger Brand','Trigger Brand Ltd','Trigger Product','3C','$1000',
      'US','YouTube','confirmed','{"source":"migration-trigger-test"}'
    )
  `).run(actor.userId);
  db.prepare(`
    INSERT INTO collaborations (
      id,demand_id,influencer_id,user_id,status,cost_quoted,cost_actual,
      row_version,cost_actual_confirmed
    ) VALUES (95001,95001,?,?,'completed',100,100,1,1)
  `).run(influencer.id, actor.userId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (95001,?,'Trigger Campaign',95001,95001,?,?,'published','active',1)
  `).run(actor.orgId, actor.userId, actor.teamId);

  const bundleId = sha256('campaign-collaboration-trigger-migration');
  const insertLink = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,95001,'collaboration',?,'95001',?,?, '{}')
  `);
  for (const relationType of ['order', 'execution', 'publication', 'settlement']) {
    insertLink.run(actor.orgId, bundleId, relationType, actor.userId);
  }

  return { campaignId: 95001, collaborationId: 95001 };
}

function assertSingleReplacementTrigger(db) {
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_schema
    WHERE type='trigger' AND name='campaign_settled_collaboration_cost_guard'
  `).get().count, 1);
}

function assertLifecycleAwareGuard(db, fixture) {
  assert.equal(db.prepare(`
    UPDATE collaborations
    SET cost_actual=125,cost_actual_confirmed=0,row_version=row_version+1
    WHERE id=?
  `).run(fixture.collaborationId).changes, 1);
  assert.deepEqual(db.prepare(`
    SELECT cost_actual,cost_actual_confirmed,row_version
    FROM collaborations WHERE id=?
  `).get(fixture.collaborationId), {
    cost_actual: 125,
    cost_actual_confirmed: 0,
    row_version: 2
  });

  db.prepare(`
    UPDATE collaborations SET cost_actual_confirmed=1 WHERE id=?
  `).run(fixture.collaborationId);
  for (const lifecycleState of ['settled', 'reviewed']) {
    db.prepare(`
      UPDATE campaigns SET lifecycle_state=? WHERE id=?
    `).run(lifecycleState, fixture.campaignId);
    assert.throws(
      () => db.prepare(`
        UPDATE collaborations
        SET cost_actual=cost_actual+1,cost_actual_confirmed=0
        WHERE id=?
      `).run(fixture.collaborationId),
      /settled campaign collaboration cost must remain confirmed/
    );
  }

  db.prepare(`
    UPDATE campaigns SET lifecycle_state='published' WHERE id=?
  `).run(fixture.campaignId);
  assert.throws(
    () => db.prepare(`
      UPDATE collaborations SET status='live' WHERE id=?
    `).run(fixture.collaborationId),
    /published or settled collaboration must remain completed/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE collaborations SET status='cancelled' WHERE id=?
    `).run(fixture.collaborationId),
    /cancelled collaboration cannot retain active campaign aliases/
  );
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
}

test('empty database reaches v5 with the lifecycle-aware collaboration cost guard', (t) => {
  const db = openDatabase(t);
  migrateTo(db, V5_MIGRATIONS, 5);
  const fixture = seedSettlementFixture(db);

  assertSingleReplacementTrigger(db);
  assertLifecycleAwareGuard(db, fixture);
});

test('v4 to v5 replaces the legacy collaboration cost guard without weakening old guards', (t) => {
  const db = openDatabase(t);
  migrateTo(db, V4_MIGRATIONS, 4);
  const fixture = seedSettlementFixture(db);

  assert.throws(
    () => db.prepare(`
      UPDATE collaborations
      SET cost_actual=125,cost_actual_confirmed=0,row_version=row_version+1
      WHERE id=?
    `).run(fixture.collaborationId),
    /settled campaign collaboration cost must remain confirmed/
  );

  migrateTo(db, V5_MIGRATIONS, 5);
  assertSingleReplacementTrigger(db);
  assertLifecycleAwareGuard(db, fixture);
});
