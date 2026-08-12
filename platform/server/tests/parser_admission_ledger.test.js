'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const idempotency = require('../services/idempotency_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const IDEMPOTENCY_SERVICE_PATH = path.join(
  SERVER_ROOT,
  'services',
  'idempotency_service.js'
);
const DATABASE_MODULE_PATH = require.resolve('better-sqlite3');
const CAMPAIGN_MIGRATIONS = Object.freeze([Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})]);
const PARSER_SCOPE = 'parser.knowledge-upload.admission';
const PPT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function deterministicHex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function migrateDatabase(db) {
  db.pragma('busy_timeout = 5000');
  assert.deepEqual(
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: CAMPAIGN_MIGRATIONS
    }),
    { status: 'managed', currentVersion: 2 }
  );
}

function openDatabase(t, filename = ':memory:') {
  const db = new Database(filename);
  migrateDatabase(db);
  t.after(() => {
    if (db.open) db.close();
  });
  return db;
}

function temporaryDatabasePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-parser-ledger-'));
  return path.join(directory, 'ledger.sqlite');
}

function activePrincipal(db) {
  const row = db.prepare(`
    SELECT org_id AS organizationId,user_id AS actorUserId
    FROM organization_memberships
    WHERE status='active'
    ORDER BY org_id,user_id
    LIMIT 1
  `).get();
  assert.ok(row);
  return row;
}

function parserInput(principal, label, overrides = {}) {
  return {
    organizationId: principal.organizationId,
    actorUserId: principal.actorUserId,
    campaignId: null,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: PARSER_SCOPE,
    key: `parser-${deterministicHex(`key:${label}`).slice(0, 32)}`,
    requestHash: deterministicHex(`request:${label}`),
    expectedEventCount: 0,
    operationTimeoutSeconds: 90,
    ...overrides
  };
}

function reserveParser(db, input) {
  return db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, input)
  )).immediate();
}

function sqliteDate(db, modifier) {
  return db.prepare('SELECT datetime(CURRENT_TIMESTAMP,?) AS value')
    .get(modifier).value;
}

function insertProcessingParser(db, input, label, {
  createdModifier = '-1 minute',
  leaseModifier = '+1 minute',
  deadlineModifier = '+90 seconds',
  leaseToken = deterministicHex(`token:${label}`),
  reservationNonce = deterministicHex(`nonce:${label}`),
  storedReservationNonce = reservationNonce,
  auditFingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  })
} = {}) {
  const createdAt = sqliteDate(db, createdModifier);
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,lease_until,lease_token,created_at,updated_at,
      operation_deadline
    ) VALUES (
      @organizationId,@actorUserId,NULL,NULL,NULL,@scope,
      @key,@reservationNonce,@requestHash,@auditFingerprint,
      0,'processing',@leaseUntil,@leaseToken,@createdAt,@createdAt,
      @operationDeadline
    )
  `).run({
    ...input,
    reservationNonce: storedReservationNonce,
    auditFingerprint,
    leaseUntil: sqliteDate(db, leaseModifier),
    leaseToken,
    createdAt,
    operationDeadline: sqliteDate(db, deadlineModifier)
  });
  return {
    ledgerId: Number(result.lastInsertRowid),
    requestHash: input.requestHash,
    leaseToken,
    reservationNonce: storedReservationNonce,
    auditFingerprint
  };
}

function insertFailedParser(db, input, label, {
  createdModifier = '-3 minutes',
  updatedModifier = '-2 minutes',
  deadlineModifier = '-90 seconds',
  expiresModifier = '+23 hours'
} = {}) {
  const reservationNonce = deterministicHex(`nonce:${label}`);
  const auditFingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,created_at,updated_at,operation_deadline,
      expires_at
    ) VALUES (
      @organizationId,@actorUserId,NULL,NULL,NULL,@scope,
      @key,@reservationNonce,@requestHash,@auditFingerprint,
      0,'failed',@createdAt,@updatedAt,@operationDeadline,@expiresAt
    )
  `).run({
    ...input,
    reservationNonce,
    auditFingerprint,
    createdAt: sqliteDate(db, createdModifier),
    updatedAt: sqliteDate(db, updatedModifier),
    operationDeadline: sqliteDate(db, deadlineModifier),
    expiresAt: sqliteDate(db, expiresModifier)
  });
  return Number(result.lastInsertRowid);
}

function insertCompletedAdmission(db, input, label, {
  createdModifier = '-2 days',
  updatedModifier = '-25 hours',
  deadlineModifier = '-47 hours',
  expiresModifier = '-1 hour'
} = {}) {
  const reservationNonce = deterministicHex(`nonce:${label}`);
  const auditFingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,status_code,response_kind,created_at,updated_at,
      operation_deadline,expires_at
    ) VALUES (
      @organizationId,@actorUserId,NULL,NULL,NULL,@scope,
      @key,@reservationNonce,@requestHash,@auditFingerprint,
      0,'completed',200,'admission',@createdAt,@updatedAt,
      @operationDeadline,@expiresAt
    )
  `).run({
    ...input,
    reservationNonce,
    auditFingerprint,
    createdAt: sqliteDate(db, createdModifier),
    updatedAt: sqliteDate(db, updatedModifier),
    operationDeadline: sqliteDate(db, deadlineModifier),
    expiresAt: sqliteDate(db, expiresModifier)
  });
  return Number(result.lastInsertRowid);
}

function insertExpiredBinary(db, principal, label) {
  const scope = 'proposal.ppt.generate.unlinked.admission';
  const key = `binary-${deterministicHex(`key:${label}`).slice(0, 32)}`;
  const requestHash = deterministicHex(`request:${label}`);
  const reservationNonce = deterministicHex(`nonce:${label}`);
  const auditFingerprint = sqliteDigest.auditFingerprint({
    organizationId: principal.organizationId,
    actorUserId: principal.actorUserId,
    scope,
    key,
    requestHash,
    reservationNonce
  });
  const response = Buffer.from(`ppt:${label}`, 'utf8');
  const responseSha256 = sqliteDigest.sha256Hex(response);
  const responseFilename = 'restart-sentinel.pptx';
  const responseHeadersJson = JSON.stringify({
    'Content-Type': PPT_CONTENT_TYPE,
    'Content-Disposition': `attachment; filename="${responseFilename}"`,
    'Content-Length': String(response.length),
    ETag: `"${responseSha256}"`,
    'Cache-Control': 'private, max-age=0, no-store'
  });
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,status_code,response_kind,response_headers_json,
      response_cache_key,response_sha256,response_bytes,response_content_type,
      response_filename,created_at,updated_at,operation_deadline,expires_at
    ) VALUES (
      @organizationId,@actorUserId,NULL,NULL,NULL,@scope,
      @key,@reservationNonce,@requestHash,@auditFingerprint,
      0,'completed',200,'binary',@responseHeadersJson,
      @responseCacheKey,@responseSha256,@responseBytes,@responseContentType,
      @responseFilename,@createdAt,@updatedAt,@operationDeadline,@expiresAt
    )
  `).run({
    ...principal,
    scope,
    key,
    reservationNonce,
    requestHash,
    auditFingerprint,
    responseHeadersJson,
    responseCacheKey: deterministicHex(`cache:${label}`),
    responseSha256,
    responseBytes: response.length,
    responseContentType: PPT_CONTENT_TYPE,
    responseFilename,
    createdAt: sqliteDate(db, '-40 days'),
    updatedAt: sqliteDate(db, '-31 days'),
    operationDeadline: sqliteDate(db, '-39 days'),
    expiresAt: sqliteDate(db, '-1 day')
  });
  return Number(result.lastInsertRowid);
}

function completionOptions(reservation, input, overrides = {}) {
  return {
    ledgerId: reservation.ledgerId,
    requestHash: input.requestHash,
    leaseToken: reservation.leaseToken,
    ...overrides
  };
}

function ledgerRow(db, ledgerId) {
  return db.prepare(`
    SELECT * FROM request_idempotency WHERE id=?
  `).get(ledgerId);
}

function runCompletionWorker(filename, options, barrier) {
  const source = String.raw`
    'use strict';
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.databaseModulePath);
    const idempotency = require(workerData.servicePath);
    const db = new Database(workerData.filename);
    db.pragma('busy_timeout = 5000');
    const gate = new Int32Array(workerData.barrier);
    const arrived = Atomics.add(gate, 0, 1) + 1;
    if (arrived >= 2) Atomics.notify(gate, 0, 2);
    while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, 1, 5000);
    try {
      const result = db.transaction(() => (
        idempotency.completeAdmissionInTransaction(db, workerData.options)
      )).immediate();
      parentPort.postMessage({ ok: true, result });
    } catch (error) {
      parentPort.postMessage({
        ok: false,
        error: {
          name: error && error.name,
          statusCode: error && error.statusCode,
          code: error && error.code,
          message: error && error.message
        }
      });
    } finally {
      db.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        filename,
        options,
        barrier,
        databaseModulePath: DATABASE_MODULE_PATH,
        servicePath: IDEMPOTENCY_SERVICE_PATH
      }
    });
    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`completion worker exited ${code}`));
      }
    });
  });
}

test('parser admission APIs are exported and mutation APIs require an outer transaction', () => {
  assert.equal(typeof idempotency.completeAdmissionInTransaction, 'function');
  assert.equal(typeof idempotency.recoverParserAdmissionsInTransaction, 'function');
  for (const name of [
    'completeAdmissionInTransaction',
    'recoverParserAdmissionsInTransaction'
  ]) {
    assert.throws(
      () => idempotency[name]({ inTransaction: false }, {}),
      (error) => (
        error instanceof TypeError &&
        error.message === 'idempotency mutation requires an active transaction'
      )
    );
  }
});

test('completion rejects a wrong token and a nonce-bound fingerprint mismatch', (t) => {
  const db = openDatabase(t);
  const principal = activePrincipal(db);
  const input = parserInput(principal, 'owner-fences');
  const reservation = reserveParser(db, input);

  assert.throws(
    () => db.transaction(() => (
      idempotency.completeAdmissionInTransaction(db, completionOptions(
        reservation,
        input,
        { leaseToken: deterministicHex('wrong-token') }
      ))
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 409 &&
      error.code === 'IDEMPOTENCY_IN_PROGRESS'
    )
  );
  assert.equal(ledgerRow(db, reservation.ledgerId).state, 'processing');

  const forgedInput = parserInput(principal, 'forged-fingerprint');
  const forged = insertProcessingParser(db, forgedInput, 'forged-fingerprint', {
    storedReservationNonce: deterministicHex('different-stored-nonce')
  });
  assert.throws(
    () => db.transaction(() => (
      idempotency.completeAdmissionInTransaction(db, completionOptions(
        forged,
        forgedInput
      ))
    )).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 500 &&
      error.code === 'AUDIT_PERSISTENCE_FAILED'
    )
  );
  assert.equal(ledgerRow(db, forged.ledgerId).state, 'processing');
});

test('completion rejects expired leases and immutable operation deadlines', (t) => {
  const db = openDatabase(t);
  const principal = activePrincipal(db);
  const cases = [
    {
      label: 'expired-lease',
      leaseModifier: '-1 second',
      deadlineModifier: '+1 minute'
    },
    {
      label: 'expired-deadline',
      leaseModifier: '-1 second',
      deadlineModifier: '-1 second'
    }
  ];

  for (const fixture of cases) {
    const input = parserInput(principal, fixture.label);
    const reservation = insertProcessingParser(db, input, fixture.label, fixture);
    assert.throws(
      () => db.transaction(() => (
        idempotency.completeAdmissionInTransaction(
          db,
          completionOptions(reservation, input)
        )
      )).immediate(),
      (error) => (
        error.name === 'IdempotencyServiceError' &&
        error.statusCode === 409 &&
        error.code === 'IDEMPOTENCY_IN_PROGRESS'
      )
    );
    assert.equal(ledgerRow(db, reservation.ledgerId).state, 'processing');
  }
});

test('completion creates a zero-event retained accounting result and conflicts on changed bytes', (t) => {
  const db = openDatabase(t);
  const principal = activePrincipal(db);
  const input = parserInput(principal, 'retained-replay');
  const reservation = reserveParser(db, input);
  const expected = {
    state: 'retained',
    ledgerId: reservation.ledgerId,
    responseKind: 'admission',
    replayable: false
  };

  const completed = db.transaction(() => (
    idempotency.completeAdmissionInTransaction(
      db,
      completionOptions(reservation, input)
    )
  )).immediate();
  assert.deepEqual(completed, expected);
  assert.deepEqual(idempotency.inspectRetained(db, input), expected);
  assert.deepEqual(
    db.transaction(() => (
      idempotency.reserveProcessingInTransaction(db, input)
    )).immediate(),
    expected
  );
  assert.deepEqual(
    idempotency.inspectRetained(db, {
      ...input,
      requestHash: deterministicHex('changed-upload-bytes')
    }),
    {
      state: 'conflict',
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    }
  );

  const row = ledgerRow(db, reservation.ledgerId);
  assert.equal(row.state, 'completed');
  assert.equal(row.status_code, 200);
  assert.equal(row.response_kind, 'admission');
  assert.equal(row.response_json, null);
  assert.equal(row.response_headers_json, null);
  assert.equal(row.response_cache_key, null);
  assert.equal(row.response_sha256, null);
  assert.equal(row.response_bytes, null);
  assert.equal(row.response_content_type, null);
  assert.equal(row.response_filename, null);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_events
      WHERE org_id=? AND actor_user_id=? AND audit_fingerprint=?
    `).get(
      principal.organizationId,
      principal.actorUserId,
      reservation.auditFingerprint
    ).count,
    0
  );
  assert.equal(
    db.prepare(`
      SELECT datetime(expires_at)=datetime(updated_at,'+1 day') AS valid
      FROM request_idempotency WHERE id=?
    `).get(reservation.ledgerId).valid,
    1
  );
});

test('a stale finalizer conflict rolls back its business write after lease recovery', (t) => {
  const db = openDatabase(t);
  const principal = activePrincipal(db);
  const input = parserInput(principal, 'final-conflict');
  const stale = insertProcessingParser(db, input, 'final-conflict', {
    leaseModifier: '-1 second',
    deadlineModifier: '+1 minute'
  });
  const recovered = db.transaction(() => (
    idempotency.recoverExpiredInTransaction(db, input)
  )).immediate();
  assert.equal(recovered.state, 'reserved');
  assert.notEqual(recovered.leaseToken, stale.leaseToken);
  db.exec(`
    CREATE TABLE parser_business_effect (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT
  `);

  assert.throws(
    () => db.transaction(() => {
      db.prepare(`
        INSERT INTO parser_business_effect (value) VALUES ('must-roll-back')
      `).run();
      idempotency.completeAdmissionInTransaction(
        db,
        completionOptions(stale, input)
      );
    }).immediate(),
    (error) => (
      error.name === 'IdempotencyServiceError' &&
      error.statusCode === 409 &&
      error.code === 'IDEMPOTENCY_IN_PROGRESS'
    )
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM parser_business_effect').get().count,
    0
  );
  const row = ledgerRow(db, stale.ledgerId);
  assert.equal(row.state, 'processing');
  assert.equal(row.lease_token, recovered.leaseToken);
});

test('an outer transaction rollback restores both admission ownership and business state', (t) => {
  const db = openDatabase(t);
  const principal = activePrincipal(db);
  const input = parserInput(principal, 'outer-rollback');
  const reservation = reserveParser(db, input);
  db.exec(`
    CREATE TABLE parser_business_effect (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT
  `);

  assert.throws(
    () => db.transaction(() => {
      db.prepare(`
        INSERT INTO parser_business_effect (value) VALUES ('rolled-back')
      `).run();
      idempotency.completeAdmissionInTransaction(
        db,
        completionOptions(reservation, input)
      );
      throw new Error('force application rollback');
    }).immediate(),
    /force application rollback/
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM parser_business_effect').get().count,
    0
  );
  const row = ledgerRow(db, reservation.ledgerId);
  assert.equal(row.state, 'processing');
  assert.equal(row.lease_token, reservation.leaseToken);
  assert.equal(row.response_kind, null);
});

test('restart recovery terminalizes due parser rows, deletes expired accounting, and preserves binary expiry evidence', (t) => {
  const filename = temporaryDatabasePath();
  const beforeRestart = new Database(filename);
  migrateDatabase(beforeRestart);
  const principal = activePrincipal(beforeRestart);
  const processingInput = parserInput(principal, 'restart-processing');
  const processing = insertProcessingParser(
    beforeRestart,
    processingInput,
    'restart-processing',
    { leaseModifier: '-1 minute', deadlineModifier: '-1 second' }
  );
  const failedInput = parserInput(principal, 'restart-failed');
  const failedId = insertFailedParser(beforeRestart, failedInput, 'restart-failed');
  const expiredAdmissionInput = parserInput(principal, 'restart-admission');
  const expiredAdmissionId = insertCompletedAdmission(
    beforeRestart,
    expiredAdmissionInput,
    'restart-admission'
  );
  const liveInput = parserInput(principal, 'restart-live');
  const live = reserveParser(beforeRestart, liveInput);
  const binaryId = insertExpiredBinary(beforeRestart, principal, 'restart-binary');
  const binaryBefore = ledgerRow(beforeRestart, binaryId);
  beforeRestart.close();

  const restarted = new Database(filename);
  restarted.pragma('busy_timeout = 5000');
  t.after(() => {
    if (restarted.open) restarted.close();
  });
  t.after(() => fs.rmSync(path.dirname(filename), { recursive: true, force: true }));
  const recovered = restarted.transaction(() => (
    idempotency.recoverParserAdmissionsInTransaction(restarted)
  )).immediate();
  assert.deepEqual(recovered, {
    scanned: 3,
    terminalized: 2,
    deleted: 1
  });

  for (const ledgerId of [processing.ledgerId, failedId]) {
    const row = ledgerRow(restarted, ledgerId);
    assert.equal(row.state, 'completed');
    assert.equal(row.status_code, 503);
    assert.equal(row.response_kind, 'json');
    assert.equal(row.lease_until, null);
    assert.equal(row.lease_token, null);
    assert.equal(
      restarted.prepare(`
        SELECT datetime(expires_at)=datetime(updated_at,'+30 days') AS valid
        FROM request_idempotency WHERE id=?
      `).get(ledgerId).valid,
      1
    );
  }
  assert.equal(ledgerRow(restarted, expiredAdmissionId), undefined);
  const liveRow = ledgerRow(restarted, live.ledgerId);
  assert.equal(liveRow.state, 'processing');
  assert.equal(liveRow.lease_token, live.leaseToken);
  assert.deepEqual(ledgerRow(restarted, binaryId), binaryBefore);
});

test('two database connections race to one retained admission completion', async (t) => {
  const filename = temporaryDatabasePath();
  const db = openDatabase(t, filename);
  t.after(() => fs.rmSync(path.dirname(filename), { recursive: true, force: true }));
  db.pragma('journal_mode = WAL');
  const principal = activePrincipal(db);
  const input = parserInput(principal, 'two-connection-race');
  const reservation = reserveParser(db, input);
  const options = completionOptions(reservation, input);
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);

  const outcomes = await Promise.all([
    runCompletionWorker(filename, options, barrier),
    runCompletionWorker(filename, options, barrier)
  ]);
  const winners = outcomes.filter((outcome) => outcome.ok);
  const losers = outcomes.filter((outcome) => !outcome.ok);
  assert.equal(winners.length, 1);
  assert.deepEqual(winners[0].result, {
    state: 'retained',
    ledgerId: reservation.ledgerId,
    responseKind: 'admission',
    replayable: false
  });
  assert.equal(losers.length, 1);
  assert.deepEqual(losers[0].error, {
    name: 'IdempotencyServiceError',
    statusCode: 409,
    code: 'IDEMPOTENCY_IN_PROGRESS',
    message: 'Idempotency lease is no longer owned by this operation.'
  });
  assert.deepEqual(idempotency.inspectRetained(db, input), winners[0].result);
});
