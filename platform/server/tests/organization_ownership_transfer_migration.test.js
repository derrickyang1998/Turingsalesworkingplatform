'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');

function migrationsThroughV22(migration) {
  return [
    ...migrationGate.REGISTERED_MIGRATIONS.filter((registered) => registered.version <= 21),
    migration
  ];
}

function loadMigration() {
  try {
    return require('../migrations/022_organization_ownership_transfer');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 022 has not been implemented');
    }
    throw error;
  }
}

function openV21() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS.filter(
      (registered) => registered.version <= 21
    )
  });
  return db;
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function seedCandidates(db) {
  db.exec(`
    INSERT INTO users (id,username,password_hash,display_name,role,is_active)
    VALUES
      (22,'next-owner','hash','Next Owner','user',1),
      (23,'ordinary-actor','hash','Ordinary Actor','user',1),
      (24,'inactive-owner','hash','Inactive Owner','user',0),
      (25,'readonly-owner','hash','Read Only Owner','user',1);
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES
      (1,22,'member','active'),
      (1,23,'member','active'),
      (1,24,'member','active'),
      (1,25,'member','active');
    UPDATE organization_member_policy
    SET access_mode='read_only'
    WHERE org_id=1 AND user_id=25;
  `);
}

test('migration 022 preserves ownership lineage and installs deterministic transfer columns', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 22);
  assert.equal(migration.name, '022_organization_ownership_transfer');
  assert.equal(migration.sourcePath, 'migrations/022_organization_ownership_transfer.js');

  const db = openV21();
  try {
    const before = db.prepare(`
      SELECT org_id,owner_user_id,created_by,created_at
      FROM organization_authority
      ORDER BY org_id
    `).all();
    seedCandidates(db);

    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationsThroughV22(migration)
    });

    assert.equal(db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 22);
    assert.deepEqual(tableColumns(db, 'organization_authority'), [
      'org_id',
      'owner_user_id',
      'created_by',
      'created_at',
      'updated_by',
      'updated_at',
      'version'
    ]);
    const after = db.prepare(`
      SELECT org_id,owner_user_id,created_by,created_at,updated_by,updated_at,version
      FROM organization_authority
      ORDER BY org_id
    `).all();
    assert.deepEqual(
      after.map((row) => ({
        org_id: row.org_id,
        owner_user_id: row.owner_user_id,
        created_by: row.created_by,
        created_at: row.created_at
      })),
      before
    );
    assert.ok(after.every((row) => row.updated_by === row.created_by));
    assert.ok(after.every((row) => row.updated_at === row.created_at));
    assert.ok(after.every((row) => row.version === 1));
    assert.deepEqual(
      db.prepare(`
        SELECT wr,strict
        FROM pragma_table_list
        WHERE schema='main' AND name='organization_authority'
      `).get(),
      { wr: 1, strict: 1 }
    );
    assert.deepEqual(
      db.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type='trigger' AND (
          name LIKE 'organization_authority_%'
          OR name LIKE 'organization_member_policy_%'
          OR name LIKE 'organization_membership_owner_%'
          OR name IN ('organization_membership_policy_insert','organization_owner_user_active_guard')
        )
        ORDER BY name
      `).all().map((row) => row.name),
      [
        'organization_authority_actor_guard',
        'organization_authority_creation_immutable',
        'organization_authority_no_delete',
        'organization_authority_no_replace_insert',
        'organization_authority_no_update',
        'organization_authority_scope_insert',
        'organization_authority_target_guard',
        'organization_authority_version_guard',
        'organization_member_policy_delete_guard',
        'organization_member_policy_owner_delete_guard',
        'organization_member_policy_owner_read_only_guard',
        'organization_membership_owner_delete_guard',
        'organization_membership_owner_status_guard',
        'organization_membership_policy_insert',
        'organization_owner_user_active_guard'
      ]
    );
    assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_organization_authority_owner'").get().sql,
      'CREATE INDEX idx_organization_authority_owner\n    ON organization_authority(owner_user_id,org_id)');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);

    assert.doesNotThrow(() => migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationsThroughV22(migration)
    }));
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=22').get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('migration 022 guards transfers at the database boundary', () => {
  const migration = loadMigration();
  const db = openV21();
  try {
    seedCandidates(db);
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationsThroughV22(migration)
    });

    assert.doesNotThrow(() => db.prepare(`
      UPDATE organization_authority
      SET owner_user_id=22,updated_by=1,updated_at=CURRENT_TIMESTAMP,version=version+1
      WHERE org_id=1
    `).run());
    assert.deepEqual(
      db.prepare('SELECT owner_user_id,updated_by,version FROM organization_authority WHERE org_id=1').get(),
      { owner_user_id: 22, updated_by: 1, version: 2 }
    );

    assert.throws(
      () => db.prepare(`
        UPDATE organization_authority
        SET owner_user_id=23,updated_by=23,updated_at=CURRENT_TIMESTAMP,version=version+1
        WHERE org_id=1
      `).run(),
      /actor|owner|administrator/i
    );
    assert.throws(
      () => db.prepare(`
        UPDATE organization_authority
        SET owner_user_id=24,updated_by=22,updated_at=CURRENT_TIMESTAMP,version=version+1
        WHERE org_id=1
      `).run(),
      /active.*read.write/i
    );
    assert.throws(
      () => db.prepare(`
        UPDATE organization_authority
        SET owner_user_id=25,updated_by=22,updated_at=CURRENT_TIMESTAMP,version=version+1
        WHERE org_id=1
      `).run(),
      /active.*read.write/i
    );
    assert.throws(
      () => db.prepare(`
        UPDATE organization_authority
        SET owner_user_id=23,updated_by=22,updated_at=CURRENT_TIMESTAMP,version=version+2
        WHERE org_id=1
      `).run(),
      /version/i
    );
    assert.throws(
      () => db.prepare(`
        UPDATE organization_authority
        SET updated_by=22,updated_at=CURRENT_TIMESTAMP,version=version+1
        WHERE org_id=1
      `).run(),
      /owner.*change/i
    );
    assert.throws(
      () => db.prepare(`
        UPDATE organization_authority
        SET created_by=22,owner_user_id=23,updated_by=22,updated_at=CURRENT_TIMESTAMP,version=version+1
        WHERE org_id=1
      `).run(),
      /creation.*immutable/i
    );
    assert.throws(
      () => db.prepare('DELETE FROM organization_authority WHERE org_id=1').run(),
      /owner.*immutable/i
    );
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});
