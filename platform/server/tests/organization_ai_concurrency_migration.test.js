'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

function loadMigration() {
  try {
    return require('../migrations/030_ai_provider_concurrency_reservation');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 030 has not been implemented');
    }
    throw error;
  }
}

function baseDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL, is_active INTEGER NOT NULL) STRICT;
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL) STRICT;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    INSERT INTO users VALUES (1,'admin',1),(2,'user',1);
    INSERT INTO organizations VALUES (10,'alpha','Alpha'),(20,'beta','Beta');
  `);
  return db;
}

test('migration 030 backfills default concurrency policies and defaults new organizations', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 30);
  assert.equal(migration.name, '030_ai_provider_concurrency_reservation');
  assert.equal(migration.sourcePath, 'migrations/030_ai_provider_concurrency_reservation.js');
  const db = baseDatabase();
  try {
    migration.apply(db);
    assert.deepEqual(db.prepare(`
      SELECT org_id,policy_version,concurrency_limit,changed_by,reason,source
      FROM organization_ai_concurrency_policies ORDER BY org_id
    `).all(), [
      { org_id: 10, policy_version: 1, concurrency_limit: 10, changed_by: null, reason: null, source: 'migration_backfill' },
      { org_id: 20, policy_version: 1, concurrency_limit: 10, changed_by: null, reason: null, source: 'migration_backfill' }
    ]);
    db.prepare("INSERT INTO organizations VALUES (30,'gamma','Gamma')").run();
    assert.deepEqual(db.prepare(`
      SELECT policy_version,concurrency_limit,source
      FROM organization_ai_concurrency_policies WHERE org_id=30
    `).get(), { policy_version: 1, concurrency_limit: 10, source: 'organization_default' });
  } finally {
    db.close();
  }
});

test('migration 030 enforces append-only policy and event history plus reservation state transitions', () => {
  const db = baseDatabase();
  try {
    loadMigration().apply(db);
    assert.throws(() => db.prepare(`
      INSERT INTO organization_ai_concurrency_policies
        (org_id,policy_version,concurrency_limit,changed_by,reason,source)
      VALUES (10,3,8,1,'skip','admin_update')
    `).run(), /concurrency policy is invalid/i);
    assert.throws(() => db.prepare(`
      INSERT INTO organization_ai_concurrency_policies
        (org_id,policy_version,concurrency_limit,changed_by,reason,source)
      VALUES (10,2,65,1,'too high','admin_update')
    `).run(), /CHECK constraint/i);
    db.prepare(`
      INSERT INTO organization_ai_concurrency_policies
        (org_id,policy_version,concurrency_limit,changed_by,reason,source)
      VALUES (10,2,0,1,'maintenance','admin_update')
    `).run();
    assert.throws(() => db.prepare(`
      UPDATE organization_ai_concurrency_policies SET concurrency_limit=1 WHERE org_id=10
    `).run(), /immutable/i);

    db.prepare(`
      INSERT INTO ai_provider_reservations (
        reservation_id,org_id,actor_user_id,operation_key,fence_token,state,
        acquired_at,provider_deadline_at,reclaim_after
      ) VALUES ('r1',10,2,'chat:1','secret-token','active',
        '2026-09-21 00:00:00','2026-09-21 00:02:00','2026-09-21 00:02:15')
    `).run();
    assert.throws(() => db.prepare(`
      UPDATE ai_provider_reservations SET org_id=20 WHERE reservation_id='r1'
    `).run(), /identity is immutable/i);
    db.prepare(`
      UPDATE ai_provider_reservations
      SET state='released',terminal_at='2026-09-21 00:00:10'
      WHERE reservation_id='r1'
    `).run();
    assert.throws(() => db.prepare(`
      UPDATE ai_provider_reservations SET state='active',terminal_at=NULL WHERE reservation_id='r1'
    `).run(), /terminal/i);

    db.prepare(`
      INSERT INTO ai_provider_reservation_events
        (reservation_id,org_id,event_type,event_at,metadata_json)
      VALUES ('r1',10,'released','2026-09-21 00:00:10','{}')
    `).run();
    assert.throws(() => db.prepare(`
      UPDATE ai_provider_reservation_events SET event_type='acquired' WHERE id=1
    `).run(), /append-only/i);
    assert.throws(() => db.prepare('DELETE FROM ai_provider_reservation_events WHERE id=1').run(), /append-only/i);
  } finally {
    db.close();
  }
});
