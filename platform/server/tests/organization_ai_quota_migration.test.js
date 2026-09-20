'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_THROUGH_V28 = migrationGate.REGISTERED_MIGRATIONS.filter(
  (registered) => registered.version <= 28
);
const MIGRATIONS_THROUGH_V29 = Object.freeze([
  ...MIGRATIONS_THROUGH_V28,
  Object.freeze({
    version: 29,
    name: '029_organization_monthly_ai_quota',
    sourcePath: 'migrations/029_organization_monthly_ai_quota.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);

function loadMigration() {
  try {
    return require('../migrations/029_organization_monthly_ai_quota');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 029 has not been implemented');
    }
    throw error;
  }
}

function openV28() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS_THROUGH_V28
  });
  return db;
}

test('migration 029 backfills unlimited monthly quota without changing the usage ledger', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 29);
  assert.equal(migration.name, '029_organization_monthly_ai_quota');
  assert.equal(migration.sourcePath, 'migrations/029_organization_monthly_ai_quota.js');

  const db = openV28();
  try {
    db.prepare(`
      INSERT INTO organizations (id,code,name,created_at)
      VALUES (20,'second-company','Second Company','2026-09-21 00:00:00')
    `).run();
    const beforeUsage = db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count;
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V29
    });

    assert.equal(db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 29);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count, beforeUsage);
    assert.deepEqual(db.prepare(`
      SELECT org_id,policy_version,monthly_limit,changed_by,reason,source
      FROM organization_ai_quota_policies ORDER BY org_id,policy_version
    `).all(), [
      {
        org_id: 1,
        policy_version: 1,
        monthly_limit: null,
        changed_by: null,
        reason: null,
        source: 'migration_backfill'
      },
      {
        org_id: 20,
        policy_version: 1,
        monthly_limit: null,
        changed_by: null,
        reason: null,
        source: 'migration_backfill'
      }
    ]);
    assert.ok(db.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type='index' AND name='idx_token_usage_org_created'
    `).get());
    assert.doesNotThrow(() => migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V29
    }));
  } finally {
    db.close();
  }
});

test('migration 029 defaults new organizations and enforces contiguous immutable policy history', () => {
  const db = openV28();
  try {
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V29
    });
    db.prepare(`
      INSERT INTO organizations (id,code,name,created_at)
      VALUES (30,'new-company','New Company','2026-09-21 00:00:00')
    `).run();
    assert.deepEqual(db.prepare(`
      SELECT policy_version,monthly_limit,changed_by,reason,source
      FROM organization_ai_quota_policies WHERE org_id=30
    `).get(), {
      policy_version: 1,
      monthly_limit: null,
      changed_by: null,
      reason: null,
      source: 'organization_default'
    });

    assert.throws(() => db.prepare(`
      INSERT INTO organization_ai_quota_policies
        (org_id,policy_version,monthly_limit,changed_by,reason,source)
      VALUES (30,3,5000,1,'Skipped version','admin_update')
    `).run(), /organization AI quota policy is invalid/i);
    db.prepare(`
      INSERT INTO organization_ai_quota_policies
        (org_id,policy_version,monthly_limit,changed_by,reason,source)
      VALUES (30,2,5000,1,'Approved monthly limit','admin_update')
    `).run();
    assert.throws(() => db.prepare(`
      INSERT INTO organization_ai_quota_policies
        (org_id,policy_version,monthly_limit,changed_by,reason,source)
      VALUES (30,3,5000,1,'No-op limit','admin_update')
    `).run(), /organization AI quota policy is invalid/i);
    assert.throws(
      () => db.prepare('UPDATE organization_ai_quota_policies SET monthly_limit=6000 WHERE org_id=30').run(),
      /organization AI quota policy history is immutable/i
    );
    assert.throws(
      () => db.prepare('DELETE FROM organization_ai_quota_policies WHERE org_id=30').run(),
      /organization AI quota policy history is immutable/i
    );
  } finally {
    db.close();
  }
});

test('migration 029 rejects partial schema objects before applying', () => {
  const migration = loadMigration();
  const db = openV28();
  try {
    db.exec('CREATE TABLE organization_ai_quota_policies (id INTEGER PRIMARY KEY) STRICT');
    assert.throws(
      () => migration.apply(db),
      /partial 029 object exists: organization_ai_quota_policies/
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='organization_ai_quota_default_after_insert'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test('migration 029 rejects non-canonical historical usage timestamps and guards future inserts', () => {
  const dirty = openV28();
  try {
    const membership = dirty.prepare(`
      SELECT org_id,user_id FROM organization_memberships
      WHERE status='active' ORDER BY org_id,user_id LIMIT 1
    `).get();
    dirty.prepare(`
      INSERT INTO token_usage
        (org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      membership.org_id,
      membership.user_id,
      'deepseek-chat',
      1,
      1,
      2,
      'invalid_timestamp_probe',
      '2026-09-21T00:00:00Z'
    );
    assert.throws(
      () => migrationService.runMigrations(dirty, {
        rootDir: SERVER_ROOT,
        registeredMigrations: MIGRATIONS_THROUGH_V29
      }),
      /non-canonical token usage timestamp/i
    );
  } finally {
    dirty.close();
  }

  const clean = openV28();
  try {
    migrationService.runMigrations(clean, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V29
    });
    const membership = clean.prepare(`
      SELECT org_id,user_id FROM organization_memberships
      WHERE status='active' ORDER BY org_id,user_id LIMIT 1
    `).get();
    assert.throws(() => clean.prepare(`
      INSERT INTO token_usage
        (org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      membership.org_id,
      membership.user_id,
      'deepseek-chat',
      1,
      1,
      2,
      'invalid_timestamp_probe',
      '2026-09-21T00:00:00Z'
    ), /token usage timestamp must be canonical UTC seconds/i);
  } finally {
    clean.close();
  }
});
