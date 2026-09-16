'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');

function loadMigration() {
  try {
    return require('../migrations/021_organization_role_governance');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 021 has not been implemented');
    }
    throw error;
  }
}

function openV20() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS.filter(
      (registered) => registered.version <= 20
    )
  });
  return db;
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

test('migration 021 upgrades v20 deterministically without changing membership role checks', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 21);
  assert.equal(migration.name, '021_organization_role_governance');
  assert.equal(migration.sourcePath, 'migrations/021_organization_role_governance.js');

  const db = openV20();
  try {
    db.exec(`
      INSERT INTO organizations (id,code,name,created_at)
      VALUES (20,'ambiguous-owner','Ambiguous Owner','2026-09-15 00:00:00');
      INSERT INTO users (id,username,password_hash,display_name,role,is_active)
      VALUES
        (20,'admin-two','hash','Admin Two','admin',1),
        (21,'admin-three','hash','Admin Three','admin',1),
        (22,'late-member','hash','Late Member','user',1);
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES
        (20,20,'org_admin','active'),
        (20,21,'org_admin','active');
    `);
    const organizationMembershipSql = db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='organization_memberships'"
    ).get().sql;
    const teamMembershipSql = db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='team_memberships'"
    ).get().sql;

    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationGate.REGISTERED_MIGRATIONS
    });

    assert.equal(db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 21);
    assert.deepEqual(tableColumns(db, 'organization_authority'), [
      'org_id',
      'owner_user_id',
      'created_by',
      'created_at'
    ]);
    assert.deepEqual(tableColumns(db, 'organization_member_policy'), [
      'org_id',
      'user_id',
      'access_mode',
      'created_at',
      'updated_at'
    ]);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM organization_member_policy').get().count,
      db.prepare('SELECT COUNT(*) AS count FROM organization_memberships').get().count
    );
    assert.deepEqual(
      db.prepare('SELECT org_id,owner_user_id,created_by FROM organization_authority ORDER BY org_id').all(),
      [{ org_id: 1, owner_user_id: 1, created_by: 1 }]
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM organization_authority WHERE org_id=20').get().count,
      0
    );
    assert.equal(
      db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='organization_memberships'").get().sql,
      organizationMembershipSql
    );
    assert.equal(
      db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='team_memberships'").get().sql,
      teamMembershipSql
    );

    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (20,22,'member','active')
    `).run();
    assert.deepEqual(
      db.prepare('SELECT access_mode FROM organization_member_policy WHERE org_id=20 AND user_id=22').get(),
      { access_mode: 'read_write' }
    );

    assert.doesNotThrow(() => migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationGate.REGISTERED_MIGRATIONS
    }));
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=21").get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('migration 021 database guards keep the owner active, read-write, unique, and immutable', () => {
  const migration = loadMigration();
  const db = openV20();
  try {
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationGate.REGISTERED_MIGRATIONS
    });

    assert.throws(
      () => db.prepare("UPDATE organization_member_policy SET access_mode='read_only' WHERE org_id=1 AND user_id=1").run(),
      /owner.*read.only/i
    );
    assert.throws(
      () => db.prepare("UPDATE organization_memberships SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE org_id=1 AND user_id=1").run(),
      /owner.*active/i
    );
    assert.throws(
      () => db.prepare('UPDATE users SET is_active=0 WHERE id=1').run(),
      /owner.*active/i
    );
    assert.throws(
      () => db.prepare('DELETE FROM organization_member_policy WHERE org_id=1 AND user_id=1').run(),
      /owner.*policy/i
    );
    assert.throws(
      () => db.prepare('UPDATE organization_authority SET owner_user_id=2 WHERE org_id=1').run(),
      /owner.*immutable/i
    );
    assert.throws(
      () => db.prepare('DELETE FROM organization_authority WHERE org_id=1').run(),
      /owner.*immutable/i
    );
    assert.throws(
      () => db.prepare('INSERT OR REPLACE INTO organization_authority (org_id,owner_user_id,created_by) VALUES (1,2,1)').run(),
      /owner.*already initialized|owner.*immutable/i
    );
  } finally {
    db.close();
  }
});

test('migration 021 rejects a partial object set before making changes', () => {
  const migration = loadMigration();
  const db = openV20();
  try {
    db.exec('CREATE TABLE organization_member_policy (org_id INTEGER PRIMARY KEY) STRICT');
    assert.throws(() => migration.apply(db), /partial 021 object exists: organization_member_policy/);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='organization_authority'").get().count,
      0
    );
  } finally {
    db.close();
  }
});
