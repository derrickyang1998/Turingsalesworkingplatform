'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const migration = require('../migrations/030_ai_provider_concurrency_reservation');
const { createAIConcurrencyService } = require('../services/ai_concurrency_service');
const { runAcceptance } = require('../scripts/verify_ai_concurrency_acceptance');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ai-acceptance-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL) STRICT;
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL,
      PRIMARY KEY (org_id,user_id)
    ) STRICT;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,action TEXT NOT NULL,module TEXT,
      details TEXT,ip_address TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,token TEXT UNIQUE NOT NULL,
      ip_address TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,expires_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE ai_conversations (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE ai_messages (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE ai_references (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE token_usage (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE knowledge_entries (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE web_search_cache (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE proposals (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE request_idempotency (id INTEGER PRIMARY KEY) STRICT;
    INSERT INTO users VALUES (1,'derrick','admin',1);
    INSERT INTO organizations VALUES (10,'alpha','Alpha');
    INSERT INTO organization_memberships VALUES (10,1,'org_admin','active');
  `);
  migration.apply(db);
  return {
    db,
    directory,
    evidencePath: path.join(directory, 'acceptance.json'),
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function rejectionStub(db, response = null) {
  return async function(_url, _token, _body) {
    const service = createAIConcurrencyService(db);
    assert.throws(
      () => service.acquire({ organizationId: 10, actorUserId: 1, operationKey: 'http:rejected' }),
      (error) => error.code === 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED'
    );
    return response || {
      status: 429,
      retryAfter: '135',
      body: { code: 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED' }
    };
  };
}

test('production acceptance rejects the occupied slot, proves no business writes, and restores policy', async () => {
  const state = fixture();
  try {
    const evidence = await runAcceptance({
      db: state.db,
      actor: { userId: 1, organizationId: 10, role: 'admin' },
      jwtSecret: 'acceptance-test-secret',
      runId: 'a'.repeat(32),
      evidencePath: state.evidencePath,
      baseUrl: 'http://127.0.0.1:3002',
      httpPost: rejectionStub(state.db)
    });
    assert.equal(evidence.rejection.code, 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED');
    assert.deepEqual(evidence.original, { limit: 10, policyVersion: 1, active: 0 });
    assert.equal(evidence.restored.limit, 10);
    assert.equal(evidence.restored.active, 0);
    assert.deepEqual(evidence.controlled, {
      completed: true,
      state: 'released',
      providerCompleted: true,
      terminal: true,
      events: ['acquired', 'dispatch_authorized', 'provider_completed', 'released']
    });
    const controlledReservation = state.db.prepare(`
      SELECT state,provider_completed_at,terminal_at
      FROM ai_provider_reservations
      WHERE org_id=? AND operation_key=?
    `).all(10, `deployment_acceptance:controlled:${'a'.repeat(32)}`);
    assert.equal(controlledReservation.length, 1);
    assert.equal(controlledReservation[0].state, 'released');
    assert.ok(controlledReservation[0].provider_completed_at);
    assert.ok(controlledReservation[0].terminal_at);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM ai_provider_reservations WHERE state='active'").get().count, 0);
    assert.equal(JSON.parse(fs.readFileSync(state.evidencePath, 'utf8')).runId, 'a'.repeat(32));
  } finally {
    state.close();
  }
});

test('failed production acceptance still releases reservations, removes its session, and restores policy', async () => {
  const state = fixture();
  try {
    await assert.rejects(runAcceptance({
      db: state.db,
      actor: { userId: 1, organizationId: 10, role: 'admin' },
      jwtSecret: 'acceptance-test-secret',
      runId: 'b'.repeat(32),
      evidencePath: state.evidencePath,
      baseUrl: 'http://127.0.0.1:3002',
      httpPost: rejectionStub(state.db, { status: 500, retryAfter: null, body: { code: 'WRONG' } })
    }), /exact concurrency rejection contract/);
    const service = createAIConcurrencyService(state.db);
    const restored = service.projectOrganizationConcurrency({ organizationId: 10 });
    assert.equal(restored.limit, 10);
    assert.equal(restored.active, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    assert.equal(fs.existsSync(state.evidencePath), false);
  } finally {
    state.close();
  }
});
