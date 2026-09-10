'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migration = require('../migrations/018_collaboration_publication_lifecycle');

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
  '014_customer_report_ppt_artifact',
  '015_influencer_saved_views',
  '016_collaboration_contract_documents',
  '017_collaboration_publication_custody'
]);
const MIGRATIONS = Object.freeze(MIGRATION_NAMES.map((name, index) => Object.freeze({
  version: index + 2,
  name,
  sourcePath: `migrations/${name}.js`,
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})));

function openV17(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  }), { status: 'managed', currentVersion: 17 });
  return db;
}

test('migration 018 creates one immutable ordered publication lifecycle ledger', (t) => {
  const db = openV17(t);
  migration.apply(db);

  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='collaboration_publication_lifecycle_versions'").get();
  assert.ok(table);
  assert.match(table.sql, /STRICT$/);

  assert.deepEqual(
    db.prepare("PRAGMA table_info('collaboration_publication_lifecycle_versions')").all().map((column) => column.name),
    [
      'id', 'org_id', 'campaign_id', 'collaboration_id', 'custody_id', 'lifecycle_version',
      'previous_version_id', 'action', 'tracking_state', 'publication_id', 'effective_url',
      'effective_url_sha256', 'canonical_identity', 'platform', 'platform_content_id',
      'effective_published_at', 'correction_kind', 'registration_mode', 'reason',
      'knowledge_entry_id', 'collaboration_row_version_observed', 'acted_by', 'acted_at', 'created_at'
    ]
  );

  for (const triggerName of [
    'collaboration_publication_lifecycle_no_update',
    'collaboration_publication_lifecycle_no_delete',
    'collaboration_publication_lifecycle_chain_insert',
    'collaboration_publication_lifecycle_knowledge_insert',
    'performance_metric_observations_lifecycle_insert'
  ]) {
    assert.ok(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(triggerName), triggerName);
  }
});

test('migration 018 manifest and production registries expose schema version 18', () => {
  assert.equal(migration.version, 18);
  assert.equal(migration.name, '018_collaboration_publication_lifecycle');
  assert.equal(migration.sourcePath, 'migrations/018_collaboration_publication_lifecycle.js');
  assert.ok(migration.schemaManifest.columns.collaboration_publication_lifecycle_versions);
  assert.ok(migration.schemaManifest.triggers.performance_metric_observations_lifecycle_insert);

  const dbSource = fs.readFileSync(path.join(SERVER_ROOT, 'db.js'), 'utf8');
  const verifierSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'verify_campaign_migration_gate.js'), 'utf8');
  const sanitizerSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'sanitize_production_shape.js'), 'utf8');
  const trustedSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'trusted_production_source_gate.js'), 'utf8');
  const deploySource = fs.readFileSync(path.join(SERVER_ROOT, '..', 'deploy_v8.ps1'), 'utf8');
  assert.match(dbSource, /version:\s*18,[\s\S]*name:\s*'018_collaboration_publication_lifecycle'/);
  assert.match(verifierSource, /version:\s*18,[\s\S]*name:\s*'018_collaboration_publication_lifecycle'/);
  assert.match(sanitizerSource, /version:\s*18,[\s\S]*name:\s*'018_collaboration_publication_lifecycle'/);
  assert.match(trustedSource, /server\/migrations\/018_collaboration_publication_lifecycle\.js/);
  assert.match(deploySource, /server\\migrations\\018_collaboration_publication_lifecycle\.js/);
});
