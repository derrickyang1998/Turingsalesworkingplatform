'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function loadService() {
  try {
    return require('../services/ai_concurrency_service');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') assert.fail('AI concurrency service has not been implemented');
    throw error;
  }
}

function fixture(options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL, is_active INTEGER NOT NULL) STRICT;
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY (org_id,user_id)
    ) STRICT;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL,
      module TEXT NOT NULL, details TEXT, ip_address TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    INSERT INTO users VALUES (1,'admin',1),(2,'user',1),(3,'user',1),(4,'admin',0);
    INSERT INTO organizations VALUES (10,'alpha','Alpha'),(20,'beta','Beta');
    INSERT INTO organization_memberships VALUES
      (10,1,'org_admin','active'),(10,2,'member','active'),(20,3,'member','active');
  `);
  require('../migrations/030_ai_provider_concurrency_reservation').apply(db);
  let nowMs = Date.parse('2026-09-21T00:00:00Z');
  let tokenSequence = 0;
  const service = loadService().createAIConcurrencyService(db, {
    now: () => new Date(nowMs),
    randomToken: () => `token-${++tokenSequence}`,
    randomId: () => `reservation-${tokenSequence + 1}`,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout
  });
  return { db, service, advance(milliseconds) { nowMs += milliseconds; } };
}

function setLimit(db, limit, version = 2) {
  db.prepare(`
    INSERT INTO organization_ai_concurrency_policies
      (org_id,policy_version,concurrency_limit,changed_by,reason,source)
    VALUES (10,?,?,1,'test limit','admin_update')
  `).run(version, limit);
}

test('acquire is durable, enforces the organization limit, and has no administrator bypass', () => {
  const { db, service } = fixture();
  try {
    setLimit(db, 1);
    const permit = service.acquire({ organizationId: 10, actorUserId: 1, operationKey: 'chat:request-1' });
    assert.equal(permit.organization_id, 10);
    assert.equal(permit.fence_token, 'token-1');
    assert.equal(permit.provider_deadline_at, '2026-09-21T00:02:00Z');
    assert.equal(permit.reclaim_after, '2026-09-21T00:02:15Z');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_reservations WHERE state='active'").get().count, 1);
    assert.throws(
      () => service.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'chat:request-2' }),
      (error) => error.status === 429 && error.code === 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED' &&
        /不会消耗 Token/.test(error.message) &&
        Number.isSafeInteger(error.retryAfter) && error.retryAfter >= 1 && error.retryAfter <= 135
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_reservation_events WHERE event_type='rejected'").get().count, 1);
  } finally {
    db.close();
  }
});

test('authorization and terminal operations require the live fence token', () => {
  const { db, service } = fixture();
  try {
    const permit = service.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'strategy:1' });
    assert.throws(
      () => service.authorizeDispatch({ reservationId: permit.reservation_id, fenceToken: 'stale' }),
      (error) => error.status === 409 && error.code === 'AI_CONCURRENCY_RESERVATION_FENCE_MISMATCH'
    );
    const authorized = service.authorizeDispatch({
      reservationId: permit.reservation_id,
      fenceToken: permit.fence_token,
      provider: 'deepseek'
    });
    assert.equal(authorized.authorized, true);
    service.markProviderCompleted({
      reservationId: permit.reservation_id,
      fenceToken: permit.fence_token,
      provider: 'deepseek'
    });
    assert.equal(db.prepare("SELECT state FROM ai_provider_reservations WHERE reservation_id=?").get(permit.reservation_id).state, 'active');
    assert.throws(
      () => service.release({ reservationId: permit.reservation_id, fenceToken: 'stale' }),
      (error) => error.code === 'AI_CONCURRENCY_RESERVATION_FENCE_MISMATCH'
    );
    assert.equal(service.release({ reservationId: permit.reservation_id, fenceToken: permit.fence_token }).state, 'released');
    assert.equal(service.release({ reservationId: permit.reservation_id, fenceToken: permit.fence_token }).state, 'released');
    assert.throws(
      () => service.authorizeDispatch({ reservationId: permit.reservation_id, fenceToken: permit.fence_token }),
      (error) => error.code === 'AI_CONCURRENCY_RESERVATION_NOT_ACTIVE'
    );
  } finally {
    db.close();
  }
});

test('expired work is reclaimed lazily only after deadline plus grace and stale owners stay fenced', () => {
  const { db, service, advance } = fixture();
  try {
    setLimit(db, 1);
    const abandoned = service.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'proposal:old' });
    advance(120001);
    assert.throws(
      () => service.authorizeDispatch({ reservationId: abandoned.reservation_id, fenceToken: abandoned.fence_token }),
      (error) => error.code === 'AI_CONCURRENCY_PROVIDER_DEADLINE_EXCEEDED'
    );
    assert.throws(
      () => service.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'proposal:early' }),
      (error) => error.code === 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED'
    );
    advance(15000);
    const replacement = service.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'proposal:new' });
    assert.equal(db.prepare('SELECT state FROM ai_provider_reservations WHERE reservation_id=?').get(abandoned.reservation_id).state, 'timed_out');
    assert.notEqual(replacement.fence_token, abandoned.fence_token);
    assert.throws(
      () => service.release({ reservationId: abandoned.reservation_id, fenceToken: abandoned.fence_token }),
      (error) => error.code === 'AI_CONCURRENCY_RESERVATION_NOT_ACTIVE'
    );
  } finally {
    db.close();
  }
});

test('projects disabled, full, draining and available states and restricts member reads', () => {
  const { db, service } = fixture();
  try {
    setLimit(db, 2);
    const first = service.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'one' });
    const second = service.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'two' });
    assert.equal(service.projectOrganizationConcurrency({ organizationId: 10 }).status, 'full');
    db.prepare(`
      INSERT INTO organization_ai_concurrency_policies
        (org_id,policy_version,concurrency_limit,changed_by,reason,source)
      VALUES (10,3,1,1,'drain','admin_update')
    `).run();
    const draining = service.currentOrganizationConcurrency({ actorUserId: 2, organizationId: 10 });
    assert.deepEqual({ active: draining.active, limit: draining.limit, available: draining.available, over: draining.over_capacity, status: draining.status },
      { active: 2, limit: 1, available: 0, over: 1, status: 'draining' });
    assert.throws(
      () => service.currentOrganizationConcurrency({ actorUserId: 3, organizationId: 10 }),
      (error) => error.status === 403 && error.code === 'AI_ORGANIZATION_CONCURRENCY_FORBIDDEN'
    );
    service.release({ reservationId: first.reservation_id, fenceToken: first.fence_token });
    service.release({ reservationId: second.reservation_id, fenceToken: second.fence_token });
    db.prepare(`
      INSERT INTO organization_ai_concurrency_policies
        (org_id,policy_version,concurrency_limit,changed_by,reason,source)
      VALUES (10,4,0,1,'stop','admin_update')
    `).run();
    assert.equal(service.projectOrganizationConcurrency({ organizationId: 10 }).status, 'disabled');
  } finally {
    db.close();
  }
});

test('updates policy with optimistic versioning and atomic append-only audit', () => {
  const { db, service } = fixture();
  try {
    const changed = service.updateOrganizationConcurrencyPolicy({
      actorUserId: 1,
      organizationId: 10,
      concurrencyLimit: 64,
      expectedVersion: 1,
      reason: 'Emergency capacity increase',
      requestId: 'capacity-1',
      ipAddress: '127.0.0.1'
    });
    assert.equal(changed.limit, 64);
    assert.equal(changed.policy_version, 2);
    assert.equal(changed.changed, true);
    const audit = db.prepare("SELECT details FROM activity_log WHERE action='organization_ai_concurrency_changed'").get();
    assert.deepEqual(JSON.parse(audit.details), {
      schema_version: 1,
      actor_user_id: 1,
      organization_id: 10,
      reason: 'Emergency capacity increase',
      request_id: 'capacity-1',
      before: { concurrency_limit: 10, policy_version: 1 },
      after: { concurrency_limit: 64, policy_version: 2 }
    });
    assert.throws(
      () => service.updateOrganizationConcurrencyPolicy({ actorUserId: 1, organizationId: 10, concurrencyLimit: 8, expectedVersion: 1, reason: 'stale' }),
      (error) => error.status === 409 && error.code === 'AI_ORGANIZATION_CONCURRENCY_VERSION_CONFLICT'
    );
    assert.throws(
      () => service.updateOrganizationConcurrencyPolicy({ actorUserId: 2, organizationId: 10, concurrencyLimit: 8, expectedVersion: 2, reason: 'forbidden' }),
      (error) => error.status === 403 && error.code === 'AI_ORGANIZATION_CONCURRENCY_ADMIN_FORBIDDEN'
    );
    assert.throws(
      () => service.updateOrganizationConcurrencyPolicy({ actorUserId: 1, organizationId: 10, concurrencyLimit: 65, expectedVersion: 2, reason: 'invalid' }),
      (error) => error.status === 400 && error.code === 'AI_ORGANIZATION_CONCURRENCY_INVALID'
    );
  } finally {
    db.close();
  }
});

test('runWithPermit closes successful and failed operations before returning', async () => {
  const { db, service } = fixture();
  try {
    const result = await service.runWithPermit({
      organizationId: 10,
      actorUserId: 2,
      operationKey: 'chat:wrapped-success',
      provider: 'deepseek'
    }, async (permit) => ({ reservationId: permit.reservation_id }));
    assert.match(result.reservationId, /^reservation-/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_reservations WHERE state='active'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_reservation_events WHERE event_type='provider_completed'").get().count, 1);

    await assert.rejects(
      service.runWithPermit({
        organizationId: 10,
        actorUserId: 2,
        operationKey: 'chat:wrapped-failure'
      }, async () => { throw new Error('provider failed'); }),
      /provider failed/
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_reservations WHERE state='active'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_reservation_events WHERE event_type='released'").get().count, 2);
  } finally {
    db.close();
  }
});

test('runWithPermit supplies a deadline signal, fences late completion, and releases the slot', async () => {
  let scheduled = null;
  const { db, service, advance } = fixture({
    setTimeout(callback, delay) {
      scheduled = { callback, delay };
      return 41;
    },
    clearTimeout() {}
  });
  try {
    const outcome = service.runWithPermit({
      organizationId: 10,
      actorUserId: 2,
      operationKey: 'chat:deadline-signal',
      provider: 'deepseek'
    }, async (permit) => {
      assert.equal(permit.signal instanceof AbortSignal, true);
      assert.equal(permit.deadlineAt, Date.parse('2026-09-21T00:02:00Z'));
      assert.equal(typeof permit.assertActive, 'function');
      assert.ok(scheduled);
      assert.equal(scheduled.delay, 120000);
      advance(120000);
      scheduled.callback();
      assert.equal(permit.signal.aborted, true);
      assert.throws(
        () => permit.assertActive(),
        (error) => error.code === 'AI_CONCURRENCY_PROVIDER_DEADLINE_EXCEEDED'
      );
      return 'late-result';
    });

    await assert.rejects(
      outcome,
      (error) => error.status === 409 && error.code === 'AI_CONCURRENCY_PROVIDER_DEADLINE_EXCEEDED'
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_reservations WHERE state='active'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_provider_reservation_events WHERE event_type='provider_completed'").get().count, 0);
  } finally {
    db.close();
  }
});

test('two database connections cannot both acquire the final organization slot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ai-concurrency-'));
  const databasePath = path.join(directory, 'concurrency.sqlite');
  const firstDb = new Database(databasePath);
  const secondDb = new Database(databasePath);
  try {
    firstDb.pragma('journal_mode = WAL');
    firstDb.pragma('foreign_keys = ON');
    firstDb.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL, is_active INTEGER NOT NULL) STRICT;
      CREATE TABLE organizations (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL) STRICT;
      CREATE TABLE organization_memberships (
        org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY (org_id,user_id)
      ) STRICT;
      CREATE TABLE activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL,
        module TEXT NOT NULL, details TEXT, ip_address TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      INSERT INTO users VALUES (1,'admin',1),(2,'user',1);
      INSERT INTO organizations VALUES (10,'alpha','Alpha');
      INSERT INTO organization_memberships VALUES (10,1,'org_admin','active'),(10,2,'member','active');
    `);
    require('../migrations/030_ai_provider_concurrency_reservation').apply(firstDb);
    setLimit(firstDb, 1);
    const first = loadService().createAIConcurrencyService(firstDb, {
      randomToken: () => 'first-token',
      randomId: () => 'first-reservation'
    });
    const second = loadService().createAIConcurrencyService(secondDb, {
      randomToken: () => 'second-token',
      randomId: () => 'second-reservation'
    });

    const permit = first.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'connection:first' });
    assert.throws(
      () => second.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'connection:second' }),
      (error) => error.status === 429 && error.code === 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED'
    );
    first.release({ reservationId: permit.reservation_id, fenceToken: permit.fence_token });
  } finally {
    secondDb.close();
    firstDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
