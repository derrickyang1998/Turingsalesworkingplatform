'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');
const migration = require('../migrations/020_organization_methodology_promotion');

const SERVER_ROOT = path.resolve(__dirname, '..');

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

test('migration 020 creates append-only request, decision, and organization custody ledgers', () => {
  assert.equal(migration.version, 20);
  assert.equal(migration.name, '020_organization_methodology_promotion');
  assert.equal(migration.sourcePath, 'migrations/020_organization_methodology_promotion.js');

  const db = new Database(':memory:');
  try {
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationGate.REGISTERED_MIGRATIONS
    });

    assert.deepEqual(tableColumns(db, 'organization_knowledge_custody'), [
      'knowledge_entry_id',
      'org_id',
      'custody_type',
      'created_by',
      'created_at'
    ]);
    assert.deepEqual(tableColumns(db, 'organization_methodology_promotion_requests'), [
      'id',
      'org_id',
      'source_campaign_id',
      'source_knowledge_entry_id',
      'requested_by',
      'first_approved_by',
      'expected_governance_version',
      'dedupe_sha256',
      'dimensions_json',
      'supersedes_knowledge_entry_id',
      'request_reason',
      'created_at'
    ]);
    assert.deepEqual(tableColumns(db, 'organization_methodology_promotion_decisions'), [
      'id',
      'request_id',
      'org_id',
      'decision',
      'decided_by',
      'decision_reason',
      'target_knowledge_entry_id',
      'supersedes_knowledge_entry_id',
      'created_at'
    ]);

    for (const name of [
      'ux_organization_methodology_request_source',
      'ux_organization_methodology_decision_request',
      'idx_organization_methodology_request_org',
      'idx_organization_methodology_decision_target',
      'idx_organization_knowledge_custody_org',
      'organization_methodology_requests_no_update',
      'organization_methodology_requests_no_delete',
      'organization_methodology_decisions_no_update',
      'organization_methodology_decisions_no_delete',
      'organization_knowledge_custody_no_update',
      'organization_knowledge_custody_no_delete'
    ]) {
      assert.equal(
        db.prepare('SELECT 1 AS present FROM sqlite_schema WHERE name=?').get(name).present,
        1,
        name
      );
    }
    assert.equal(db.pragma('foreign_key_check').length, 0);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    db.close();
  }
});
