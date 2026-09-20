'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

function loadService() {
  try {
    return require('../services/subscription_expiry_service');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('subscription expiry service has not been implemented');
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
    CREATE TABLE organization_subscription_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      term_version INTEGER NOT NULL,
      expires_at TEXT,
      changed_by INTEGER,
      reason TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    CREATE UNIQUE INDEX ux_test_subscription_version
      ON organization_subscription_terms(org_id,term_version);
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
    INSERT INTO organization_subscription_terms
      (org_id,term_version,expires_at,source)
    VALUES
      (10,1,NULL,'migration_backfill'),
      (20,1,'2000-01-01T00:00:00Z','migration_backfill');
  `);
  return {
    db,
    service: loadService().createSubscriptionExpiryService(db, {
      now: () => new Date('2026-09-20T12:00:00Z')
    })
  };
}

test('projects perpetual, active, and expired subscription states only for active members', () => {
  const { db, service } = fixture();
  try {
    assert.deepEqual(service.currentForMember({ actorUserId: 2, organizationId: 10 }), {
      organization_id: 10,
      expires_at: null,
      term_version: 1,
      status: 'perpetual'
    });
    assert.deepEqual(service.projectOrganization({ organizationId: 20 }), {
      organization_id: 20,
      expires_at: '2000-01-01T00:00:00Z',
      term_version: 1,
      status: 'expired'
    });
    db.prepare(`
      INSERT INTO organization_subscription_terms
        (org_id,term_version,expires_at,changed_by,reason,source)
      VALUES (10,2,'2099-01-01T00:00:00Z',1,'Future term','admin_update')
    `).run();
    assert.equal(service.projectOrganization({ organizationId: 10 }).status, 'active');
    assert.throws(
      () => service.currentForMember({ actorUserId: 4, organizationId: 20 }),
      (error) => error.code === 'SUBSCRIPTION_FORBIDDEN' && error.status === 403
    );
  } finally {
    db.close();
  }
});

test('updates expiry with optimistic versioning, append-only history, idempotence, and atomic audit', () => {
  const { db, service } = fixture();
  try {
    const changed = service.updateForAdmin({
      actorUserId: 1,
      organizationId: 10,
      expiresAt: '2099-01-01T00:00:00Z',
      expectedVersion: 1,
      reason: 'Annual subscription approved',
      requestId: 'subscription-change-1',
      ipAddress: '127.0.0.1'
    });
    assert.deepEqual(changed, {
      organization_id: 10,
      expires_at: '2099-01-01T00:00:00Z',
      term_version: 2,
      status: 'active',
      changed: true
    });
    assert.deepEqual(db.prepare(`
      SELECT term_version,expires_at,changed_by,source
      FROM organization_subscription_terms WHERE org_id=10 ORDER BY term_version
    `).all(), [
      { term_version: 1, expires_at: null, changed_by: null, source: 'migration_backfill' },
      { term_version: 2, expires_at: '2099-01-01T00:00:00Z', changed_by: 1, source: 'admin_update' }
    ]);
    const audit = db.prepare(`
      SELECT user_id,action,module,details,ip_address FROM activity_log
      WHERE action='organization_subscription_expiry_changed'
    `).get();
    assert.equal(audit.user_id, 1);
    assert.equal(audit.action, 'organization_subscription_expiry_changed');
    assert.equal(audit.module, 'subscription_expiry');
    assert.equal(audit.ip_address, '127.0.0.1');
    const auditDetails = JSON.parse(audit.details);
    assert.equal(auditDetails.schema_version, 1);
    assert.equal(auditDetails.actor_user_id, 1);
    assert.equal(auditDetails.organization_id, 10);
    assert.equal(auditDetails.reason, 'Annual subscription approved');
    assert.equal(auditDetails.request_id, 'subscription-change-1');
    assert.deepEqual(auditDetails.before, { expires_at: null, term_version: 1 });
    assert.deepEqual(auditDetails.after, {
      expires_at: '2099-01-01T00:00:00Z',
      term_version: 2
    });

    const replay = service.updateForAdmin({
      actorUserId: 1,
      organizationId: 10,
      expiresAt: '2099-01-01T00:00:00Z',
      expectedVersion: 2,
      reason: 'No change'
    });
    assert.equal(replay.changed, false);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='organization_subscription_expiry_changed'").get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('rejects unauthorized, stale, missing, and malformed updates without mutation', () => {
  const { db, service } = fixture();
  try {
    const cases = [
      [{ actorUserId: 2, organizationId: 10, expiresAt: null, expectedVersion: 1, reason: 'x' }, 'SUBSCRIPTION_ADMIN_FORBIDDEN', 403],
      [{ actorUserId: 1, organizationId: 999, expiresAt: null, expectedVersion: 1, reason: 'x' }, 'ORGANIZATION_NOT_FOUND', 404],
      [{ actorUserId: 1, organizationId: 10, expiresAt: null, expectedVersion: 9, reason: 'x' }, 'SUBSCRIPTION_TERM_VERSION_CONFLICT', 409],
      [{ actorUserId: 1, organizationId: 10, expiresAt: '2099-01-01T00:00:00.000Z', expectedVersion: 1, reason: 'x' }, 'INVALID_SUBSCRIPTION_TERM', 400],
      [{ actorUserId: 1, organizationId: 10, expiresAt: '2099-13-01T00:00:00Z', expectedVersion: 1, reason: 'x' }, 'INVALID_SUBSCRIPTION_TERM', 400],
      [{ actorUserId: 1, organizationId: 10, expiresAt: null, expectedVersion: 1, reason: '' }, 'INVALID_SUBSCRIPTION_TERM', 400]
    ];
    for (const [input, code, status] of cases) {
      assert.throws(
        () => service.updateForAdmin(input),
        (error) => error.code === code && error.status === status,
        code
      );
    }
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM organization_subscription_terms WHERE org_id=10').get().count,
      1
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='organization_subscription_expiry_changed'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test('fails closed on missing policy and rolls back when audit persistence fails', () => {
  const { db, service } = fixture();
  try {
    db.prepare('DELETE FROM organization_subscription_terms WHERE org_id=20').run();
    assert.throws(
      () => service.projectOrganization({ organizationId: 20 }),
      (error) => error.code === 'SUBSCRIPTION_POLICY_UNAVAILABLE' && error.status === 503
    );
    db.exec(`
      CREATE TRIGGER reject_subscription_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.action='organization_subscription_expiry_changed'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;
    `);
    assert.throws(
      () => service.updateForAdmin({
        actorUserId: 1,
        organizationId: 10,
        expiresAt: '2099-01-01T00:00:00Z',
        expectedVersion: 1,
        reason: 'Must roll back'
      }),
      (error) => error.code === 'SUBSCRIPTION_AUDIT_FAILED' && error.status === 500
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM organization_subscription_terms WHERE org_id=10').get().count,
      1
    );
  } finally {
    db.close();
  }
});
