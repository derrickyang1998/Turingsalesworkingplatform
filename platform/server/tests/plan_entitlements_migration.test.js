'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_THROUGH_V26 = migrationGate.REGISTERED_MIGRATIONS.filter(
  (registered) => registered.version <= 26
);
const MIGRATIONS_THROUGH_V27 = Object.freeze([
  ...MIGRATIONS_THROUGH_V26,
  Object.freeze({
    version: 27,
    name: '027_plan_catalog_module_entitlements',
    sourcePath: 'migrations/027_plan_catalog_module_entitlements.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);

const ALL_MODULES = Object.freeze([
  'campaign.customer_report',
  'campaign.performance',
  'crm.contact',
  'crm.customer',
  'crm.opportunity',
  'crm.task',
  'influencer.data'
]);
const CRM_MODULES = Object.freeze([
  'crm.contact',
  'crm.customer',
  'crm.opportunity',
  'crm.task'
]);

function loadMigration() {
  try {
    return require('../migrations/027_plan_catalog_module_entitlements');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 027 has not been implemented');
    }
    throw error;
  }
}

function openV26() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS_THROUGH_V26
  });
  return db;
}

test('migration 027 seeds immutable plans and backfills every existing organization without behavior loss', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 27);
  assert.equal(migration.name, '027_plan_catalog_module_entitlements');
  assert.equal(migration.sourcePath, 'migrations/027_plan_catalog_module_entitlements.js');

  const db = openV26();
  try {
    db.prepare(`
      INSERT INTO organizations (id,code,name,created_at)
      VALUES (20,'second-company','Second Company','2026-09-20 00:00:00')
    `).run();

    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V27
    });

    assert.equal(db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 27);
    assert.deepEqual(
      db.prepare(`
        SELECT code,name_zh,name_en,catalog_version,status,display_order
        FROM plan_catalog ORDER BY display_order,code
      `).all(),
      [
        {
          code: 'crm_core',
          name_zh: '客户关系核心版',
          name_en: 'CRM Core',
          catalog_version: 1,
          status: 'active',
          display_order: 10
        },
        {
          code: 'legacy_full',
          name_zh: '完整兼容版',
          name_en: 'Legacy Full',
          catalog_version: 1,
          status: 'active',
          display_order: 20
        }
      ]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT module_code FROM plan_module_entitlements
        WHERE plan_code='legacy_full' ORDER BY module_code
      `).all().map((row) => row.module_code),
      ALL_MODULES
    );
    assert.deepEqual(
      db.prepare(`
        SELECT module_code FROM plan_module_entitlements
        WHERE plan_code='crm_core' ORDER BY module_code
      `).all().map((row) => row.module_code),
      CRM_MODULES
    );
    assert.deepEqual(
      db.prepare(`
        SELECT org_id,plan_code,assignment_version,source
        FROM organization_plan_assignments ORDER BY org_id,id
      `).all(),
      [
        { org_id: 1, plan_code: 'legacy_full', assignment_version: 1, source: 'migration_backfill' },
        { org_id: 20, plan_code: 'legacy_full', assignment_version: 1, source: 'migration_backfill' }
      ]
    );

    assert.doesNotThrow(() => migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V27
    }));
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=27').get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('migration 027 assigns legacy_full to newly created organizations and enforces catalog and assignment guards', () => {
  const db = openV26();
  try {
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: MIGRATIONS_THROUGH_V27
    });

    db.prepare(`
      INSERT INTO organizations (id,code,name,created_at)
      VALUES (30,'new-company','New Company','2026-09-20 00:00:00')
    `).run();
    assert.deepEqual(
      db.prepare(`
        SELECT plan_code,assignment_version,source,assigned_by
        FROM organization_plan_assignments WHERE org_id=30
      `).get(),
      {
        plan_code: 'legacy_full',
        assignment_version: 1,
        source: 'organization_default',
        assigned_by: null
      }
    );

    assert.throws(
      () => db.prepare("UPDATE plan_catalog SET name_en='Changed' WHERE code='legacy_full'").run(),
      /plan catalog is immutable/i
    );
    assert.throws(
      () => db.prepare("DELETE FROM plan_module_entitlements WHERE plan_code='legacy_full'").run(),
      /plan entitlements are immutable/i
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO plan_module_entitlements (plan_code,module_code)
        VALUES ('crm_core','campaign.performance')
      `).run(),
      /plan entitlements are immutable/i
    );
    assert.throws(() => db.prepare(`
      UPDATE organization_plan_assignments
      SET status='superseded',superseded_at=CURRENT_TIMESTAMP
      WHERE org_id=30 AND status='active'
    `).run());
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM organization_plan_assignments WHERE org_id=30').get().count,
      1
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO organization_plan_assignments
          (org_id,plan_code,assignment_version,assigned_by,reason,source)
        VALUES (30,'crm_core',3,1,'Skipped version','admin_assignment')
      `).run(),
      /assignment is invalid/i
    );
    db.prepare(`
      INSERT INTO organization_plan_assignments
        (org_id,plan_code,assignment_version,assigned_by,reason,source)
      VALUES (30,'crm_core',2,1,'Approved CRM pilot','admin_assignment')
    `).run();
    assert.deepEqual(
      db.prepare(`
        SELECT plan_code,assignment_version
        FROM organization_plan_assignments
        WHERE org_id=30
        ORDER BY assignment_version DESC
        LIMIT 1
      `).get(),
      { plan_code: 'crm_core', assignment_version: 2 }
    );
    assert.throws(
      () => db.prepare("UPDATE organization_plan_assignments SET plan_code='legacy_full' WHERE org_id=30 AND assignment_version=2").run(),
      /assignment history is immutable/i
    );
    assert.throws(
      () => db.prepare("DELETE FROM organization_plan_assignments WHERE org_id=30").run(),
      /assignment history is immutable/i
    );
  } finally {
    db.close();
  }
});

test('migration 027 rejects a partial object set before creating any remaining objects', () => {
  const migration = loadMigration();
  const db = openV26();
  try {
    db.exec('CREATE TABLE plan_catalog (code TEXT PRIMARY KEY) STRICT');
    assert.throws(() => migration.apply(db), /partial 027 object exists: plan_catalog/);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='organization_plan_assignments'").get().count,
      0
    );
  } finally {
    db.close();
  }
});
