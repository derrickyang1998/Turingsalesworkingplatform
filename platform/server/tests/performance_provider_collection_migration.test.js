'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migration = require('../migrations/019_performance_provider_collection');

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
  '017_collaboration_publication_custody',
  '018_collaboration_publication_lifecycle'
]);
const MIGRATIONS = Object.freeze(MIGRATION_NAMES.map((name, index) => Object.freeze({
  version: index + 2,
  name,
  sourcePath: `migrations/${name}.js`,
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})));

function openV18(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  }), { status: 'managed', currentVersion: 18 });
  return db;
}

test('migration 019 adds immutable provider runs and observations without replacing manual observations', (t) => {
  const db = openV18(t);
  const manualObservationSql = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='performance_metric_observations'"
  ).get().sql;

  migration.apply(db);

  assert.equal(
    db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='performance_metric_observations'").get().sql,
    manualObservationSql
  );
  for (const tableName of [
    'performance_provider_collection_claims',
    'performance_provider_quota_reservations',
    'performance_provider_collection_runs',
    'performance_provider_observations'
  ]) {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(tableName);
    assert.ok(row, tableName);
    assert.match(row.sql, /STRICT$/);
  }
  for (const triggerName of [
    'performance_provider_collection_claims_no_update',
    'performance_provider_quota_reservations_no_update',
    'performance_provider_quota_reservations_no_delete',
    'performance_provider_collection_runs_no_update',
    'performance_provider_collection_runs_no_delete',
    'performance_provider_observations_no_update',
    'performance_provider_observations_no_delete',
    'performance_provider_observations_scope_insert'
  ]) {
    assert.ok(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(triggerName), triggerName);
  }
});

test('migration 019 manifest and production registries expose schema version 19', () => {
  assert.equal(migration.version, 19);
  assert.equal(migration.name, '019_performance_provider_collection');
  assert.equal(migration.sourcePath, 'migrations/019_performance_provider_collection.js');
  assert.ok(migration.schemaManifest.columns.performance_provider_collection_claims);
  assert.ok(migration.schemaManifest.columns.performance_provider_quota_reservations);
  assert.ok(migration.schemaManifest.columns.performance_provider_collection_runs);
  assert.ok(migration.schemaManifest.columns.performance_provider_observations);

  const dbSource = fs.readFileSync(path.join(SERVER_ROOT, 'db.js'), 'utf8');
  const verifierSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'verify_campaign_migration_gate.js'), 'utf8');
  const sanitizerSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'sanitize_production_shape.js'), 'utf8');
  const trustedSource = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'trusted_production_source_gate.js'), 'utf8');
  const deploySource = fs.readFileSync(path.join(SERVER_ROOT, '..', 'deploy_v8.ps1'), 'utf8');
  assert.match(dbSource, /version:\s*19,[\s\S]*name:\s*'019_performance_provider_collection'/);
  assert.match(verifierSource, /version:\s*19,[\s\S]*name:\s*'019_performance_provider_collection'/);
  assert.match(sanitizerSource, /version:\s*19,[\s\S]*name:\s*'019_performance_provider_collection'/);
  assert.match(trustedSource, /server\/migrations\/019_performance_provider_collection\.js/);
  assert.match(deploySource, /server\\migrations\\019_performance_provider_collection\.js/);
});
