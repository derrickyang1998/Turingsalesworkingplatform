'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

function loadProvisioner() {
  try {
    return require('../scripts/provision_release_smoke_identity');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('release smoke identity provisioner has not been implemented');
    }
    throw error;
  }
}

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',email TEXT,department TEXT,
      api_quota INTEGER DEFAULT 50000,created_at TEXT DEFAULT CURRENT_TIMESTAMP,last_login TEXT,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE organizations (id INTEGER PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL);
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,revoked_at TEXT,
      PRIMARY KEY (org_id,user_id)
    );
    CREATE TABLE organization_member_policy (
      org_id INTEGER NOT NULL,user_id INTEGER NOT NULL,access_mode TEXT NOT NULL DEFAULT 'read_write',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (org_id,user_id)
    ) WITHOUT ROWID;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,action TEXT NOT NULL,module TEXT,
      details TEXT,ip_address TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (
      id,username,password_hash,display_name,role,email,department,api_quota,is_active
    ) VALUES (1,'derrick','protected-owner-hash','Derrick','admin',NULL,'management',50000,1);
    INSERT INTO organizations VALUES (10,'alpha','Alpha');
    INSERT INTO organization_memberships (org_id,user_id,role_code,status) VALUES (10,1,'org_admin','active');
    INSERT INTO organization_member_policy (org_id,user_id,access_mode) VALUES (10,1,'read_write');
    CREATE TRIGGER organization_membership_policy_insert
    AFTER INSERT ON organization_memberships
    BEGIN
      INSERT INTO organization_member_policy (org_id,user_id,access_mode)
      VALUES (NEW.org_id,NEW.user_id,'read_write');
    END;
  `);
  return db;
}

test('provisions a dedicated non-login release smoke identity without changing protected credentials', () => {
  const db = fixture();
  try {
    const { provisionReleaseSmokeIdentity } = loadProvisioner();
    const result = provisionReleaseSmokeIdentity(db, {
      organizationId: 10,
      createPasswordHash: () => '$2b$12$opaque-random-smoke-hash'
    });
    assert.deepEqual(result, { status: 'created', username: 'release-smoke' });
    assert.equal(db.prepare("SELECT password_hash FROM users WHERE username='derrick'").get().password_hash, 'protected-owner-hash');
    const smoke = db.prepare(`
      SELECT username,password_hash,role,department,api_quota,is_active
      FROM users WHERE username='release-smoke'
    `).get();
    assert.deepEqual(smoke, {
      username: 'release-smoke',
      password_hash: '$2b$12$opaque-random-smoke-hash',
      role: 'admin',
      department: 'platform_release',
      api_quota: 0,
      is_active: 1
    });
    const membership = db.prepare(`
      SELECT role_code,status,access_mode
      FROM organization_memberships membership
      JOIN organization_member_policy policy USING (org_id,user_id)
      WHERE membership.org_id=10 AND membership.user_id=(SELECT id FROM users WHERE username='release-smoke')
    `).get();
    assert.deepEqual(membership, { role_code: 'org_admin', status: 'active', access_mode: 'read_write' });
    const audit = db.prepare("SELECT action,module,details FROM activity_log WHERE action='release_smoke_identity_provisioned'").get();
    assert.equal(audit.module, 'security');
    assert.equal(JSON.parse(audit.details).username, 'release-smoke');
    assert.doesNotMatch(audit.details, /password|hash|secret/i);
  } finally {
    db.close();
  }
});

test('reuses an exact release smoke identity without rotating its password hash', () => {
  const db = fixture();
  try {
    const { provisionReleaseSmokeIdentity } = loadProvisioner();
    provisionReleaseSmokeIdentity(db, {
      organizationId: 10,
      createPasswordHash: () => '$2b$12$first-smoke-hash'
    });
    const result = provisionReleaseSmokeIdentity(db, {
      organizationId: 10,
      createPasswordHash: () => {
        throw new Error('idempotent path must not generate or rotate a credential');
      }
    });
    assert.deepEqual(result, { status: 'existing', username: 'release-smoke' });
    assert.equal(
      db.prepare("SELECT password_hash FROM users WHERE username='release-smoke'").get().password_hash,
      '$2b$12$first-smoke-hash'
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='release_smoke_identity_provisioned'").get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('fails closed on a conflicting release smoke identity without repairing or rotating it', () => {
  const db = fixture();
  try {
    const { provisionReleaseSmokeIdentity } = loadProvisioner();
    db.prepare(`
      INSERT INTO users (username,password_hash,display_name,role,department,api_quota,is_active)
      VALUES ('release-smoke','conflicting-hash','Release Smoke','user','platform_release',0,1)
    `).run();
    assert.throws(
      () => provisionReleaseSmokeIdentity(db, {
        organizationId: 10,
        createPasswordHash: () => '$2b$12$must-not-be-used'
      }),
      /RELEASE_SMOKE_IDENTITY_CONFLICT/
    );
    assert.equal(
      db.prepare("SELECT password_hash FROM users WHERE username='release-smoke'").get().password_hash,
      'conflicting-hash'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity_log').get().count, 0);
  } finally {
    db.close();
  }
});

test('rolls back every release smoke row when the membership policy trigger is unavailable', () => {
  const db = fixture();
  try {
    const { provisionReleaseSmokeIdentity } = loadProvisioner();
    db.exec('DROP TRIGGER organization_membership_policy_insert;');
    assert.throws(
      () => provisionReleaseSmokeIdentity(db, {
        organizationId: 10,
        createPasswordHash: () => '$2b$12$must-be-rolled-back'
      }),
      /RELEASE_SMOKE_POLICY_PROVISION_FAILED/
    );
    assert.equal(db.prepare("SELECT password_hash FROM users WHERE username='derrick'").get().password_hash, 'protected-owner-hash');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE username='release-smoke'").get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_memberships WHERE user_id<>1').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_member_policy WHERE user_id<>1').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity_log').get().count, 0);
  } finally {
    db.close();
  }
});
