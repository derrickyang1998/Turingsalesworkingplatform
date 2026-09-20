'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_THROUGH_V27 = migrationGate.REGISTERED_MIGRATIONS.filter(
  (registered) => registered.version <= 27
);
const MIGRATIONS_THROUGH_V28 = Object.freeze([
  ...MIGRATIONS_THROUGH_V27,
  Object.freeze({
    version: 28,
    name: '028_subscription_expiry',
    sourcePath: 'migrations/028_subscription_expiry.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);

function loadMigration() {
  try {
    return require('../migrations/028_subscription_expiry');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 028 has not been implemented');
    }
    throw error;
  }
}

function openV27() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS_THROUGH_V27
  });
  return db;
}

test('migration 028 backfills every organization with a perpetual append-only term', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 28);
  assert.equal(migration.name, '028_subscription_expiry');
  assert.equal(migration.sourcePath, 'migrations/028_subscription_expiry.js');

  const db = openV27();
  try {
    db.prepare(`
      INSERT INTO organizations (id,code,name,created_at)
      VALUES (20,'second-company','Second Company','2026-09-20 00:00:00')
    `).run();
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V28
    });

    assert.equal(db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 28);
    assert.deepEqual(db.prepare(`
      SELECT org_id,term_version,expires_at,changed_by,reason,source
      FROM organization_subscription_terms ORDER BY org_id,term_version
    `).all(), [
      {
        org_id: 1,
        term_version: 1,
        expires_at: null,
        changed_by: null,
        reason: null,
        source: 'migration_backfill'
      },
      {
        org_id: 20,
        term_version: 1,
        expires_at: null,
        changed_by: null,
        reason: null,
        source: 'migration_backfill'
      }
    ]);

    assert.doesNotThrow(() => migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V28
    }));
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=28').get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('migration 028 defaults new organizations and enforces canonical contiguous immutable history', () => {
  const db = openV27();
  try {
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V28
    });
    db.prepare(`
      INSERT INTO organizations (id,code,name,created_at)
      VALUES (30,'new-company','New Company','2026-09-20 00:00:00')
    `).run();
    assert.deepEqual(db.prepare(`
      SELECT term_version,expires_at,changed_by,reason,source
      FROM organization_subscription_terms WHERE org_id=30
    `).get(), {
      term_version: 1,
      expires_at: null,
      changed_by: null,
      reason: null,
      source: 'organization_default'
    });

    for (const expiresAt of [
      '2099-01-01 00:00:00',
      '2099-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00+00:00',
      '2099-01-01T24:00:00Z',
      '2099-13-01T00:00:00Z'
    ]) {
      assert.throws(() => db.prepare(`
        INSERT INTO organization_subscription_terms
          (org_id,term_version,expires_at,changed_by,reason,source)
        VALUES (30,2,?,1,'Invalid timestamp','admin_update')
      `).run(expiresAt));
    }
    assert.throws(() => db.prepare(`
      INSERT INTO organization_subscription_terms
        (org_id,term_version,expires_at,changed_by,reason,source)
      VALUES (30,3,'2099-01-01T00:00:00Z',1,'Skipped version','admin_update')
    `).run(), /subscription term is invalid/i);

    db.prepare(`
      INSERT INTO organization_subscription_terms
        (org_id,term_version,expires_at,changed_by,reason,source)
      VALUES (30,2,'2099-01-01T00:00:00Z',1,'Approved renewal','admin_update')
    `).run();
    assert.deepEqual(db.prepare(`
      SELECT term_version,expires_at FROM organization_subscription_terms
      WHERE org_id=30 ORDER BY term_version DESC LIMIT 1
    `).get(), { term_version: 2, expires_at: '2099-01-01T00:00:00Z' });
    assert.throws(() => db.prepare(`
      INSERT INTO organization_subscription_terms
        (org_id,term_version,expires_at,changed_by,reason,source)
      VALUES (30,3,'2099-01-01T00:00:00Z',1,'Duplicate term','admin_update')
    `).run(), /subscription term is invalid/i);
    assert.throws(
      () => db.prepare("UPDATE organization_subscription_terms SET expires_at=NULL WHERE org_id=30 AND term_version=2").run(),
      /subscription term history is immutable/i
    );
    assert.throws(
      () => db.prepare('DELETE FROM organization_subscription_terms WHERE org_id=30').run(),
      /subscription term history is immutable/i
    );
  } finally {
    db.close();
  }
});

test('migration 028 keeps plan and subscription history versions independent', () => {
  const db = openV27();
  try {
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V28
    });
    assert.deepEqual(db.prepare(`
      SELECT
        (SELECT MAX(assignment_version) FROM organization_plan_assignments WHERE org_id=1) AS plan_version,
        (SELECT MAX(term_version) FROM organization_subscription_terms WHERE org_id=1) AS term_version
    `).get(), { plan_version: 1, term_version: 1 });

    db.prepare(`
      INSERT INTO organization_subscription_terms
        (org_id,term_version,expires_at,changed_by,reason,source)
      VALUES (1,2,'2099-01-01T00:00:00Z',1,'Independent renewal','admin_update')
    `).run();
    assert.deepEqual(db.prepare(`
      SELECT
        (SELECT MAX(assignment_version) FROM organization_plan_assignments WHERE org_id=1) AS plan_version,
        (SELECT MAX(term_version) FROM organization_subscription_terms WHERE org_id=1) AS term_version
    `).get(), { plan_version: 1, term_version: 2 });

    const currentPlan = db.prepare(`
      SELECT plan_code FROM organization_plan_assignments
      WHERE org_id=1 ORDER BY assignment_version DESC LIMIT 1
    `).get().plan_code;
    const nextPlan = currentPlan === 'legacy_full' ? 'crm_core' : 'legacy_full';
    db.prepare(`
      INSERT INTO organization_plan_assignments
        (org_id,plan_code,assignment_version,assigned_by,reason,source)
      VALUES (1,?,2,1,'Independent plan change','admin_assignment')
    `).run(nextPlan);
    assert.deepEqual(db.prepare(`
      SELECT
        (SELECT MAX(assignment_version) FROM organization_plan_assignments WHERE org_id=1) AS plan_version,
        (SELECT MAX(term_version) FROM organization_subscription_terms WHERE org_id=1) AS term_version
    `).get(), { plan_version: 2, term_version: 2 });
  } finally {
    db.close();
  }
});

test('migration 028 rejects partial objects before creating remaining schema', () => {
  const migration = loadMigration();
  const db = openV27();
  try {
    db.exec('CREATE TABLE organization_subscription_terms (id INTEGER PRIMARY KEY) STRICT');
    assert.throws(
      () => migration.apply(db),
      /partial 028 object exists: organization_subscription_terms/
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='organization_subscription_default_after_insert'").get().count,
      0
    );
  } finally {
    db.close();
  }
});
