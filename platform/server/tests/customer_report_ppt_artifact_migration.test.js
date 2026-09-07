'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migration = require('../migrations/014_customer_report_ppt_artifact');

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
  '013_customer_report_snapshot',
  '014_customer_report_ppt_artifact'
]);
const MIGRATIONS = Object.freeze(MIGRATION_NAMES.map((name, index) => Object.freeze({
  version: index + 2,
  name,
  sourcePath: `migrations/${name}.js`,
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})));

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function openAtV13() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS.slice(0, -1)
  });
  return db;
}

function upgradeToV14(db) {
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

  const fixture = {
    ...identity,
    customerId: 814001,
    opportunityId: 814002,
    campaignId: 814003,
    entryId: 814004,
    snapshotId: 814005
  };
  db.prepare(`
    INSERT INTO customers (id,brand_name,company_name,stage,source,created_by,assigned_to,is_public)
    VALUES (@customerId,'PPT artifact customer','PPT artifact customer Ltd','qualified','ppt-artifact-test',@userId,@userId,0)
  `).run(fixture);
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by)
    VALUES (@opportunityId,@customerId,'PPT artifact opportunity','proposal',1000,50,'PPT artifact product','influencer',@userId)
  `).run(fixture);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@orgId,'PPT artifact campaign',@customerId,@opportunityId,@userId,@teamId,'lead','active',1
    )
  `).run(fixture);
  const content = 'Confirmed customer report source.';
  db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      title,summary,tags_json,visibility,business_type,business_id,metadata_json,
      source_identity_sha256,content_sha256
    ) VALUES (
      @entryId,'campaign_review','campaign_review',@sourceId,'campaign review',@content,@userId,0,
      'PPT artifact source','Approved review','["ppt-artifact"]','team','campaign',@businessId,'{"schema_version":1}',
      @sourceIdentitySha256,@contentSha256
    )
  `).run({
    ...fixture,
    sourceId: `${fixture.campaignId}:814006`,
    content,
    businessId: String(fixture.campaignId),
    sourceIdentitySha256: sha256('ppt-artifact-source'),
    contentSha256: sha256(content)
  });
  const report = JSON.stringify({
    contract_version: 'customer_safe_v1',
    redaction_policy_version: 'customer-safe-v1',
    status: 'sealed',
    sections: {}
  });
  fixture.reportSha256 = sha256('customer-report-artifact-source');
  db.prepare(`
    INSERT INTO customer_report_snapshots (
      id,org_id,campaign_id,created_by,source_knowledge_entry_id,report_contract_version,
      redaction_policy_version,selected_metric,source_review_content_sha256,source_review_snapshot_hash,
      current_evidence_snapshot_hash,request_fingerprint,report_sha256,report_json
    ) VALUES (
      @snapshotId,@orgId,@campaignId,@userId,@entryId,'customer_safe_v1',
      'customer-safe-v1','views',@sourceContentHash,@sourceSnapshotHash,
      @currentEvidenceHash,@requestFingerprint,@reportSha256,@reportJson
    )
  `).run({
    ...fixture,
    sourceContentHash: sha256('source-content'),
    sourceSnapshotHash: sha256('source-snapshot'),
    currentEvidenceHash: sha256('current-evidence'),
    requestFingerprint: sha256('report-request'),
    reportJson: report
  });
  return fixture;
}

function artifactParams(fixture, overrides = {}) {
  return {
    orgId: fixture.orgId,
    campaignId: fixture.campaignId,
    snapshotId: fixture.snapshotId,
    userId: fixture.userId,
    reportContractVersion: 'customer_safe_v1',
    redactionPolicyVersion: 'customer-safe-v1',
    pptContractVersion: 'customer-report-ppt-v1',
    snapshotReportSha256: fixture.reportSha256,
    artifactCacheKey: sha256('artifact-cache-key'),
    artifactSha256: sha256('artifact-bytes'),
    artifactBytes: 512,
    ...overrides
  };
}

function insertArtifact(db, params) {
  return db.prepare(`
    INSERT INTO customer_report_ppt_artifacts (
      org_id,campaign_id,snapshot_id,created_by,report_contract_version,
      redaction_policy_version,ppt_contract_version,snapshot_report_sha256,
      artifact_cache_key,artifact_sha256,artifact_bytes
    ) VALUES (
      @orgId,@campaignId,@snapshotId,@userId,@reportContractVersion,
      @redactionPolicyVersion,@pptContractVersion,@snapshotReportSha256,
      @artifactCacheKey,@artifactSha256,@artifactBytes
    )
  `).run(params);
}

test('migration 014 upgrades v13 with an immutable customer report PPT artifact schema', () => {
  const db = openAtV13();
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 13);
    upgradeToV14(db);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 14);
    upgradeToV14(db);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 14);
    assert.deepEqual(
      db.prepare('PRAGMA table_info(customer_report_ppt_artifacts)').all().map((column) => column.name),
      [
        'id', 'org_id', 'campaign_id', 'snapshot_id', 'created_by',
        'report_contract_version', 'redaction_policy_version', 'ppt_contract_version',
        'snapshot_report_sha256', 'artifact_cache_key', 'artifact_sha256',
        'artifact_bytes', 'created_at'
      ]
    );
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'customer_report_ppt_artifacts%' OR name='idx_customer_report_ppt_artifacts_campaign_created' ORDER BY name").all().map((row) => row.name),
      [
        'customer_report_ppt_artifacts',
        'customer_report_ppt_artifacts_no_delete',
        'customer_report_ppt_artifacts_no_update',
        'customer_report_ppt_artifacts_snapshot_scope_insert',
        'idx_customer_report_ppt_artifacts_campaign_created'
      ]
    );
    const tableSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='customer_report_ppt_artifacts'").get().sql;
    assert.match(tableSql, /STRICT$/);
    assert.match(tableSql, /UNIQUE\(org_id,campaign_id,snapshot_id,ppt_contract_version\)/);
    assert.match(tableSql, /UNIQUE\(artifact_cache_key\)/);
    assert.match(tableSql, /FOREIGN KEY\(snapshot_id\) REFERENCES customer_report_snapshots\(id\)/);
    assert.match(tableSql, /length\(artifact_sha256\)=64/);
  } finally {
    db.close();
  }
});

test('customer report PPT artifacts are append-only and tied to the sealed snapshot lineage', () => {
  const db = openAtV13();
  try {
    upgradeToV14(db);
    const fixture = createSnapshotFixture(db);
    const valid = artifactParams(fixture);
    const result = insertArtifact(db, valid);
    const artifactId = Number(result.lastInsertRowid);

    assert.throws(
      () => db.prepare('UPDATE customer_report_ppt_artifacts SET artifact_bytes=? WHERE id=?').run(513, artifactId),
      /customer report PPT artifacts are append-only/
    );
    assert.throws(
      () => db.prepare('DELETE FROM customer_report_ppt_artifacts WHERE id=?').run(artifactId),
      /customer report PPT artifacts are append-only/
    );
    assert.throws(
      () => insertArtifact(db, artifactParams(fixture, { artifactCacheKey: sha256('duplicate-snapshot') })),
      /UNIQUE constraint failed/
    );
    assert.throws(
      () => insertArtifact(db, artifactParams(fixture, {
        snapshotId: fixture.snapshotId + 1,
        artifactCacheKey: sha256('missing-snapshot')
      })),
      /customer report PPT artifact snapshot lineage is invalid/
    );
    assert.throws(
      () => insertArtifact(db, artifactParams(fixture, {
        snapshotReportSha256: sha256('wrong-snapshot-lineage'),
        artifactCacheKey: sha256('wrong-snapshot-lineage-cache')
      })),
      /customer report PPT artifact snapshot lineage is invalid/
    );
    assert.throws(
      () => insertArtifact(db, artifactParams(fixture, {
        artifactBytes: 3,
        artifactCacheKey: sha256('invalid-artifact-bytes')
      })),
      /CHECK constraint failed/
    );
  } finally {
    db.close();
  }
});

test('migration 014 rejects missing prerequisites before creating partial objects', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE customer_report_snapshots (id INTEGER PRIMARY KEY) STRICT;');
    assert.throws(() => migration.apply(db), /014 requires/);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'customer_report_ppt_artifacts%'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test('v14 is registered and included in the trusted deployment source list', () => {
  const dbSource = fs.readFileSync(path.join(SERVER_ROOT, 'db.js'), 'utf8');
  const deploySource = fs.readFileSync(path.join(SERVER_ROOT, '..', 'deploy_v8.ps1'), 'utf8');
  const trustedSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'trusted_production_source_gate.js'), 'utf8');
  assert.match(dbSource, /version:\s*14,[\s\S]*name:\s*'014_customer_report_ppt_artifact',[\s\S]*engineVersion:\s*1/);
  assert.match(deploySource, /server\\migrations\\014_customer_report_ppt_artifact\.js/);
  assert.match(trustedSource, /server\/migrations\/014_customer_report_ppt_artifact\.js/);
});
