'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

function loadService() {
  try {
    return require('../services/plan_entitlement_service');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('plan entitlement service has not been implemented');
    }
    throw error;
  }
}

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (org_id,user_id)
    ) STRICT;
    CREATE TABLE plan_catalog (
      code TEXT PRIMARY KEY,
      name_zh TEXT NOT NULL,
      name_en TEXT NOT NULL,
      catalog_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      display_order INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE plan_module_entitlements (
      plan_code TEXT NOT NULL,
      module_code TEXT NOT NULL,
      PRIMARY KEY (plan_code,module_code)
    ) STRICT;
    CREATE TABLE organization_plan_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      plan_code TEXT NOT NULL,
      assignment_version INTEGER NOT NULL,
      assigned_by INTEGER,
      reason TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    CREATE UNIQUE INDEX ux_test_plan_version
      ON organization_plan_assignments(org_id,assignment_version);
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    INSERT INTO users (id,role,is_active) VALUES
      (1,'admin',1),(2,'user',1),(3,'admin',0),(4,'user',1);
    INSERT INTO organizations (id,code,name) VALUES
      (10,'alpha','Alpha'),(20,'beta','Beta');
    INSERT INTO organization_memberships (org_id,user_id,status) VALUES
      (10,1,'active'),(10,2,'active'),(20,1,'active'),(20,4,'revoked');
    INSERT INTO plan_catalog
      (code,name_zh,name_en,catalog_version,status,display_order)
    VALUES
      ('crm_core','客户关系核心版','CRM Core',1,'active',10),
      ('legacy_full','完整兼容版','Legacy Full',1,'active',20),
      ('retired','已停用','Retired',1,'inactive',30);
    INSERT INTO plan_module_entitlements (plan_code,module_code) VALUES
      ('crm_core','crm.customer'),
      ('crm_core','crm.opportunity'),
      ('crm_core','crm.contact'),
      ('crm_core','crm.task'),
      ('legacy_full','crm.customer'),
      ('legacy_full','crm.opportunity'),
      ('legacy_full','crm.contact'),
      ('legacy_full','crm.task'),
      ('legacy_full','campaign.performance'),
      ('legacy_full','campaign.customer_report'),
      ('legacy_full','influencer.data');
    INSERT INTO organization_plan_assignments
      (org_id,plan_code,assignment_version,source)
    VALUES
      (10,'legacy_full',1,'migration_backfill'),
      (20,'legacy_full',1,'migration_backfill');
  `);
  return { db, service: loadService().createPlanEntitlementService(db) };
}

test('lists the immutable plan catalog only for a live platform administrator and audits the privileged read', () => {
  const { db, service } = fixture();
  try {
    assert.throws(
      () => service.listCatalog({ actorUserId: 2 }),
      (error) => error.code === 'PLAN_ADMIN_FORBIDDEN' && error.status === 403
    );
    const result = service.listCatalog({
      actorUserId: 1,
      requestId: 'catalog-read',
      ipAddress: '127.0.0.1'
    });
    assert.equal(result.catalog_version, 1);
    assert.deepEqual(result.plans.map((plan) => plan.code), ['crm_core', 'legacy_full']);
    assert.deepEqual(result.plans[0].modules, [
      'crm.contact',
      'crm.customer',
      'crm.opportunity',
      'crm.task'
    ]);
    const audit = db.prepare(`
      SELECT action,module,details FROM activity_log ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(audit.action, 'admin_plan_catalog_viewed');
    assert.equal(audit.module, 'plan_entitlements');
    assert.equal(JSON.parse(audit.details).request_id, 'catalog-read');
  } finally {
    db.close();
  }
});
test('returns the active organization plan only to an active member and fails closed on missing policy', () => {
  const { db, service } = fixture();
  try {
    assert.deepEqual(service.currentForMember({ actorUserId: 2, organizationId: 10 }), {
      organization_id: 10,
      plan_code: 'legacy_full',
      name_zh: '完整兼容版',
      name_en: 'Legacy Full',
      catalog_version: 1,
      assignment_version: 1,
      modules: [
        'campaign.customer_report',
        'campaign.performance',
        'crm.contact',
        'crm.customer',
        'crm.opportunity',
        'crm.task',
        'influencer.data'
      ]
    });
    assert.throws(
      () => service.currentForMember({ actorUserId: 4, organizationId: 20 }),
      (error) => error.code === 'PLAN_ENTITLEMENT_FORBIDDEN' && error.status === 403
    );
    db.prepare('DELETE FROM organization_plan_assignments WHERE org_id=10').run();
    assert.throws(
      () => service.currentForMember({ actorUserId: 2, organizationId: 10 }),
      (error) => error.code === 'ENTITLEMENT_POLICY_UNAVAILABLE' && error.status === 503
    );
  } finally {
    db.close();
  }
});

test('atomically assigns a plan with optimistic versioning, history, and bounded audit', () => {
  const { db, service } = fixture();
  try {
    const changed = service.assignForAdmin({
      actorUserId: 1,
      organizationId: 10,
      planCode: 'crm_core',
      expectedVersion: 1,
      reason: 'Pilot CRM-only workspace',
      requestId: 'plan-change-1',
      ipAddress: '127.0.0.1'
    });
    assert.equal(changed.changed, true);
    assert.equal(changed.assignment_version, 2);
    assert.equal(changed.plan_code, 'crm_core');
    assert.deepEqual(
      db.prepare(`
        SELECT plan_code,assignment_version,assigned_by,source
        FROM organization_plan_assignments WHERE org_id=10 ORDER BY assignment_version
      `).all(),
      [
        { plan_code: 'legacy_full', assignment_version: 1, assigned_by: null, source: 'migration_backfill' },
        { plan_code: 'crm_core', assignment_version: 2, assigned_by: 1, source: 'admin_assignment' }
      ]
    );
    const details = JSON.parse(db.prepare(`
      SELECT details FROM activity_log WHERE action='organization_plan_assigned'
    `).get().details);
    assert.deepEqual(details.before, { plan_code: 'legacy_full', assignment_version: 1 });
    assert.deepEqual(details.after, { plan_code: 'crm_core', assignment_version: 2 });
    assert.equal(details.reason, 'Pilot CRM-only workspace');

    const replay = service.assignForAdmin({
      actorUserId: 1,
      organizationId: 10,
      planCode: 'crm_core',
      expectedVersion: 2,
      reason: 'Same assignment'
    });
    assert.equal(replay.changed, false);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='organization_plan_assigned'").get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('rejects stale, unauthorized, unknown, inactive, and malformed assignments without mutation', () => {
  const { db, service } = fixture();
  try {
    const cases = [
      [{ actorUserId: 2, organizationId: 10, planCode: 'crm_core', expectedVersion: 1, reason: 'x' }, 'PLAN_ADMIN_FORBIDDEN', 403],
      [{ actorUserId: 1, organizationId: 10, planCode: 'missing', expectedVersion: 1, reason: 'x' }, 'PLAN_NOT_FOUND', 404],
      [{ actorUserId: 1, organizationId: 10, planCode: 'retired', expectedVersion: 1, reason: 'x' }, 'PLAN_NOT_ACTIVE', 409],
      [{ actorUserId: 1, organizationId: 999, planCode: 'crm_core', expectedVersion: 1, reason: 'x' }, 'ORGANIZATION_NOT_FOUND', 404],
      [{ actorUserId: 1, organizationId: 10, planCode: 'crm_core', expectedVersion: 9, reason: 'x' }, 'PLAN_ASSIGNMENT_VERSION_CONFLICT', 409],
      [{ actorUserId: 1, organizationId: 10, planCode: 'crm_core', expectedVersion: 1, reason: '' }, 'INVALID_PLAN_ASSIGNMENT', 400]
    ];
    for (const [input, code, status] of cases) {
      assert.throws(
        () => service.assignForAdmin(input),
        (error) => error.code === code && error.status === status,
        code
      );
    }
    assert.deepEqual(
      db.prepare(`
        SELECT plan_code,assignment_version FROM organization_plan_assignments
        WHERE org_id=10 ORDER BY assignment_version DESC LIMIT 1
      `).get(),
      { plan_code: 'legacy_full', assignment_version: 1 }
    );
  } finally {
    db.close();
  }
});

test('rolls back the assignment when its audit cannot be persisted', () => {
  const { db, service } = fixture();
  try {
    db.exec(`
      CREATE TRIGGER reject_plan_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.action='organization_plan_assigned'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;
    `);
    assert.throws(
      () => service.assignForAdmin({
        actorUserId: 1,
        organizationId: 10,
        planCode: 'crm_core',
        expectedVersion: 1,
        reason: 'Must roll back'
      }),
      (error) => error.code === 'PLAN_AUDIT_FAILED' && error.status === 500
    );
    assert.deepEqual(
      db.prepare(`
        SELECT plan_code,assignment_version FROM organization_plan_assignments
        WHERE org_id=10 ORDER BY assignment_version
      `).all(),
      [{ plan_code: 'legacy_full', assignment_version: 1 }]
    );
  } finally {
    db.close();
  }
});
