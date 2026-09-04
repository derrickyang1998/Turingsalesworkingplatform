'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migration = require('../migrations/013_customer_report_snapshot');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATION_NAMES = Object.freeze([
  '002_campaign_business_spine',
  '003_campaign_workflow_dispatch_evidence',
  '004_knowledge_capacity_observability',
  '005_knowledge_custody_projection',
  '006_crm_sales_workspace',
  '007_knowledge_governance',
  '008_feishu_bitable_outbox',
  '009_feishu_bitable_retry_lineage',
  '010_performance_manual_foundation',
  '011_performance_feishu_connection_config',
  '012_performance_ai_review_audit',
  '013_customer_report_snapshot'
]);
const MIGRATIONS = Object.freeze(MIGRATION_NAMES.map((name, index) => Object.freeze({
  version: index + 2,
  name,
  sourcePath: `migrations/${name}.js`,
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function openAtV12() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS.slice(0, -1)
  });
  return db;
}

function upgradeToV13(db) {
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  });
}

function createSnapshotFixture(db) {
  const identity = db.prepare(`
    SELECT organization.id AS orgId,user.id AS userId,team_membership.team_id AS teamId
    FROM organizations organization
    JOIN organization_memberships membership
      ON membership.org_id=organization.id AND membership.status='active'
    JOIN users user ON user.id=membership.user_id AND user.is_active=1
    JOIN team_memberships team_membership
      ON team_membership.org_id=organization.id
     AND team_membership.user_id=user.id
     AND team_membership.status='active'
    WHERE organization.code='turingmarket-default' AND user.role<>'admin'
    ORDER BY user.id,team_membership.team_id
    LIMIT 1
  `).get();
  assert.ok(identity, 'fixture requires an active non-admin organization member');

  const fixture = { ...identity, customerId: 813001, opportunityId: 813002, campaignId: 813003, entryId: 813004 };
  db.prepare(`
    INSERT INTO customers (id,brand_name,company_name,stage,source,created_by,assigned_to,is_public)
    VALUES (@customerId,'Snapshot customer','Snapshot customer Ltd','qualified','snapshot-test',@userId,@userId,0)
  `).run(fixture);
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by)
    VALUES (@opportunityId,@customerId,'Snapshot opportunity','proposal',1000,50,'Snapshot product','influencer',@userId)
  `).run(fixture);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@orgId,'Snapshot campaign',@customerId,@opportunityId,@userId,@teamId,'lead','active',1
    )
  `).run(fixture);
  const content = 'Approved campaign review evidence.';
  db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      title,summary,tags_json,visibility,business_type,business_id,metadata_json,
      source_identity_sha256,content_sha256
    ) VALUES (
      @entryId,'campaign_review','campaign_review',@sourceId,'campaign review',@content,@userId,0,
      'Snapshot review','Approved review','["snapshot"]','team','campaign',@businessId,'{"schema_version":1}',
      @sourceIdentitySha256,@contentSha256
    )
  `).run({
    ...fixture,
    sourceId: `${fixture.campaignId}:813005`,
    content,
    businessId: String(fixture.campaignId),
    sourceIdentitySha256: sha256('snapshot-review-source'),
    contentSha256: sha256(content)
  });
  return fixture;
}

function snapshotParams(fixture, overrides = {}) {
  return {
    id: 813005,
    orgId: fixture.orgId,
    campaignId: fixture.campaignId,
    createdBy: fixture.userId,
    sourceKnowledgeEntryId: fixture.entryId,
    reportContractVersion: 'customer_safe_v1',
    redactionPolicyVersion: 'customer-safe-v1',
    selectedMetric: 'engagement_rate',
    sourceReviewContentSha256: sha256('review-content'),
    sourceReviewSnapshotHash: sha256('review-snapshot'),
    currentEvidenceSnapshotHash: sha256('current-evidence'),
    requestFingerprint: sha256('request-fingerprint'),
    reportSha256: sha256('report'),
    reportJson: '{"status":"complete"}',
    ...overrides
  };
}

function insertSnapshot(db, params) {
  return db.prepare(`
    INSERT INTO customer_report_snapshots (
      id,org_id,campaign_id,created_by,source_knowledge_entry_id,report_contract_version,
      redaction_policy_version,selected_metric,source_review_content_sha256,source_review_snapshot_hash,
      current_evidence_snapshot_hash,request_fingerprint,report_sha256,report_json
    ) VALUES (
      @id,@orgId,@campaignId,@createdBy,@sourceKnowledgeEntryId,@reportContractVersion,
      @redactionPolicyVersion,@selectedMetric,@sourceReviewContentSha256,@sourceReviewSnapshotHash,
      @currentEvidenceSnapshotHash,@requestFingerprint,@reportSha256,@reportJson
    )
  `).run(params);
}

test('migration 013 upgrades v12 with the immutable customer report snapshot schema', () => {
  const db = openAtV12();
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 12);
    upgradeToV13(db);

    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 13);
    upgradeToV13(db);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 13);
    assert.deepEqual(
      db.prepare('PRAGMA table_info(customer_report_snapshots)').all().map((column) => column.name),
      [
        'id', 'org_id', 'campaign_id', 'created_by', 'source_knowledge_entry_id',
        'report_contract_version', 'redaction_policy_version', 'selected_metric',
        'source_review_content_sha256', 'source_review_snapshot_hash',
        'current_evidence_snapshot_hash', 'request_fingerprint', 'report_sha256',
        'report_json', 'created_at'
      ]
    );
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'customer_report_snapshots%' OR name='idx_customer_report_snapshots_campaign_created' ORDER BY name").all().map((row) => row.name),
      [
        'customer_report_snapshots',
        'customer_report_snapshots_no_delete',
        'customer_report_snapshots_no_update',
        'idx_customer_report_snapshots_campaign_created'
      ]
    );
    const tableSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='customer_report_snapshots'").get().sql;
    assert.match(tableSql, /STRICT$/);
    assert.match(tableSql, /UNIQUE\(org_id,campaign_id,request_fingerprint\)/);
    assert.match(tableSql, /length\(source_review_content_sha256\)=64/);
    assert.match(tableSql, /json_valid\(report_json\) AND json_type\(report_json\)='object'/);
    assert.match(tableSql, /FOREIGN KEY\(org_id,campaign_id\) REFERENCES campaigns\(org_id,id\) ON UPDATE RESTRICT ON DELETE RESTRICT/);
  } finally {
    db.close();
  }
});

test('migration 013 rejects missing prerequisites before creating partial objects', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE campaigns (org_id INTEGER NOT NULL,id INTEGER NOT NULL,PRIMARY KEY (org_id,id)) STRICT;
      CREATE TABLE organization_memberships (org_id INTEGER NOT NULL,user_id INTEGER NOT NULL,PRIMARY KEY (org_id,user_id)) STRICT;
    `);
    assert.throws(() => migration.apply(db), /013 requires knowledge_entries/);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'customer_report_snapshots%'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test('customer report snapshots are append-only and enforce request uniqueness and foreign keys', () => {
  const db = openAtV12();
  try {
    upgradeToV13(db);
    const fixture = createSnapshotFixture(db);
    const valid = snapshotParams(fixture);
    insertSnapshot(db, valid);

    assert.throws(() => db.prepare('UPDATE customer_report_snapshots SET selected_metric=? WHERE id=?').run('reach', valid.id), /customer report snapshots are append-only/);
    assert.throws(() => db.prepare('DELETE FROM customer_report_snapshots WHERE id=?').run(valid.id), /customer report snapshots are append-only/);
    assert.throws(() => insertSnapshot(db, snapshotParams(fixture, { id: valid.id + 1 })), /UNIQUE constraint failed/);
    assert.throws(() => insertSnapshot(db, snapshotParams(fixture, { id: valid.id + 2, campaignId: valid.campaignId + 1, requestFingerprint: sha256('other-campaign') })), /FOREIGN KEY constraint failed/);
    assert.throws(() => insertSnapshot(db, snapshotParams(fixture, { id: valid.id + 3, createdBy: 9007199254740991, requestFingerprint: sha256('other-user') })), /FOREIGN KEY constraint failed/);
    assert.throws(() => insertSnapshot(db, snapshotParams(fixture, { id: valid.id + 4, sourceKnowledgeEntryId: valid.sourceKnowledgeEntryId + 1, requestFingerprint: sha256('other-entry') })), /FOREIGN KEY constraint failed/);
    assert.throws(() => insertSnapshot(db, snapshotParams(fixture, { id: valid.id + 5, requestFingerprint: sha256('malformed-json'), reportJson: 'not-json' })), /CHECK constraint failed/);
    assert.throws(() => insertSnapshot(db, snapshotParams(fixture, { id: valid.id + 6, requestFingerprint: sha256('array-json'), reportJson: '[]' })), /CHECK constraint failed/);
    assert.throws(() => insertSnapshot(db, snapshotParams(fixture, {
      id: valid.id + 7,
      requestFingerprint: sha256('oversized-json'),
      reportJson: JSON.stringify({ summary: 'x'.repeat(524288) })
    })), /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

test('v13 is registered and included in the trusted deployment source list', () => {
  const dbSource = require('node:fs').readFileSync(path.join(SERVER_ROOT, 'db.js'), 'utf8');
  const deploySource = require('node:fs').readFileSync(path.join(SERVER_ROOT, '..', 'deploy_v8.ps1'), 'utf8');
  assert.match(dbSource, /version:\s*13,[\s\S]*name:\s*'013_customer_report_snapshot',[\s\S]*engineVersion:\s*1/);
  assert.match(deploySource, /server\\migrations\\013_customer_report_snapshot\.js/);
});
