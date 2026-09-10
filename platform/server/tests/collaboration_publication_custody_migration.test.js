'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migration = require('../migrations/017_collaboration_publication_custody');

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
  '016_collaboration_contract_documents'
]);
const MIGRATIONS = Object.freeze(MIGRATION_NAMES.map((name, index) => Object.freeze({
  version: index + 2,
  name,
  sourcePath: `migrations/${name}.js`,
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})));

function openV16(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  }), { status: 'managed', currentVersion: 16 });
  return db;
}

test('migration 017 creates strict append-only publication custody with explicit deliverable identities', (t) => {
  const db = openV16(t);
  migration.apply(db);

  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='collaboration_publication_custody'").get();
  assert.ok(table);
  assert.match(table.sql, /STRICT$/);
  assert.deepEqual(
    db.prepare("PRAGMA table_info('collaboration_publication_custody')").all().map((column) => column.name),
    [
      'id', 'org_id', 'campaign_id', 'collaboration_id', 'publication_id',
      'deliverable_key', 'registration_mode', 'review_submission_entry_id',
      'review_decision_entry_id', 'publication_relation_link_id', 'knowledge_entry_id',
      'confirmed_url', 'final_url_sha256', 'published_at', 'publication_note',
      'confirmed_by', 'confirmed_at', 'created_at'
    ]
  );
  for (const name of [
    'ux_collaboration_publication_custody_deliverable',
    'ux_collaboration_publication_custody_publication',
    'collaboration_publication_custody_no_update',
    'collaboration_publication_custody_no_delete',
    'collaboration_publication_custody_scope_insert',
    'collaboration_publication_custody_knowledge_insert'
  ]) {
    assert.ok(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(name), name);
  }
});

test('migration 017 manifest and production registries expose schema version 17', () => {
  assert.equal(migration.version, 17);
  assert.equal(migration.name, '017_collaboration_publication_custody');
  assert.equal(migration.sourcePath, 'migrations/017_collaboration_publication_custody.js');
  assert.ok(migration.schemaManifest.columns.collaboration_publication_custody);

  const dbSource = fs.readFileSync(path.join(SERVER_ROOT, 'db.js'), 'utf8');
  const verifierSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'verify_campaign_migration_gate.js'), 'utf8');
  const sanitizerSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'sanitize_production_shape.js'), 'utf8');
  const trustedSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'trusted_production_source_gate.js'), 'utf8');
  const deploySource = fs.readFileSync(path.join(SERVER_ROOT, '..', 'deploy_v8.ps1'), 'utf8');
  assert.match(dbSource, /version:\s*17,[\s\S]*name:\s*'017_collaboration_publication_custody'/);
  assert.match(verifierSource, /version:\s*17,[\s\S]*name:\s*'017_collaboration_publication_custody'/);
  assert.match(sanitizerSource, /version:\s*17,[\s\S]*name:\s*'017_collaboration_publication_custody'/);
  assert.match(trustedSource, /server\/migrations\/017_collaboration_publication_custody\.js/);
  assert.match(deploySource, /server\\migrations\\017_collaboration_publication_custody\.js/);
});
