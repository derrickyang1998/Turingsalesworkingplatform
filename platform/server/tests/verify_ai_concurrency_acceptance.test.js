'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const migration = require('../migrations/030_ai_provider_concurrency_reservation');
const { createAIConcurrencyService } = require('../services/ai_concurrency_service');
const { resolveOrganizationScope } = require('../services/organization_access_service');
const { provisionReleaseSmokeIdentity } = require('../scripts/provision_release_smoke_identity');
const {
  resolveAcceptanceActor,
  runAcceptance
} = require('../scripts/verify_ai_concurrency_acceptance');

const platformRoot = path.join(__dirname, '..', '..');
const serverEntry = path.join(platformRoot, 'server', 'server.js');
const TEST_JWT_SECRET = 'N7CiYIrosB8AK7AfEHtMt_fe3hbx8YRJFncgLgcW9I8';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function startActualServer() {
  const port = await reservePort();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ai-actual-server-'));
  const dbPath = path.join(directory, 'runtime.db');
  const output = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TM_DISABLE_DOTENV: '1',
      SERVER_HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: dbPath,
      UPLOAD_SANDBOX_SPOOL_ROOT: path.join(directory, 'upload-sandbox'),
      TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
      JWT_SECRET: TEST_JWT_SECRET,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Actual server exited early (${child.exitCode}).\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return {
          baseUrl,
          dbPath,
          output: () => output.join(''),
          async close() {
            await stopChild(child);
            fs.rmSync(directory, { recursive: true, force: true });
          }
        };
      }
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopChild(child);
  throw new Error(`Timed out waiting for actual server.\n${output.join('')}`);
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ai-acceptance-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,role TEXT NOT NULL,email TEXT,department TEXT,api_quota INTEGER NOT NULL DEFAULT 50000,
      is_active INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL,
      PRIMARY KEY (org_id,user_id)
    ) STRICT;
    CREATE TABLE teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,org_id INTEGER NOT NULL,code TEXT NOT NULL,name TEXT NOT NULL,
      UNIQUE (org_id,id),UNIQUE (org_id,code)
    ) STRICT;
    CREATE TABLE team_memberships (
      org_id INTEGER NOT NULL,team_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL,
      revoked_at TEXT,PRIMARY KEY (org_id,team_id,user_id),
      FOREIGN KEY (org_id,team_id) REFERENCES teams (org_id,id),
      FOREIGN KEY (org_id,user_id) REFERENCES organization_memberships (org_id,user_id)
    ) STRICT;
    CREATE TABLE organization_member_policy (
      org_id INTEGER NOT NULL,user_id INTEGER NOT NULL,access_mode TEXT NOT NULL,
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
    INSERT INTO users (id,username,password_hash,display_name,role,email,department,api_quota,is_active)
    VALUES (1,'derrick','protected-owner-hash','Derrick','admin',NULL,'management',50000,1);
    INSERT INTO organizations VALUES (10,'turingmarket-default','Alpha');
    INSERT INTO organization_memberships VALUES (10,1,'org_admin','active');
    INSERT INTO organization_member_policy VALUES (10,1,'read_write');
    CREATE TRIGGER organization_membership_policy_insert
    AFTER INSERT ON organization_memberships
    BEGIN
      INSERT INTO organization_member_policy (org_id,user_id,access_mode)
      VALUES (NEW.org_id,NEW.user_id,'read_write');
    END;
  `);
  provisionReleaseSmokeIdentity(db, {
    organizationId: 10,
    createPasswordHash: () => '$2b$12$opaque-random-smoke-hash'
  });
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

async function startAcceptanceHttpServer(db, jwtSecret) {
  const server = http.createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    try {
      const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization || '');
      if (!match) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: 'No token provided' }));
        return;
      }
      const token = match[1];
      const decoded = jwt.verify(token, jwtSecret);
      const session = db.prepare(`
        SELECT user_id FROM sessions
        WHERE token=? AND expires_at>datetime('now')
      `).get(token);
      const user = session && db.prepare(`
        SELECT id,role FROM users WHERE id=? AND is_active=1
      `).get(decoded.userId);
      const scope = user && resolveOrganizationScope(db, {
        userId: user.id,
        repairMissing: false
      });
      if (!scope || !scope.ok) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: 'Organization access unavailable' }));
        return;
      }
      createAIConcurrencyService(db).acquire({
        organizationId: scope.authContext.organization.id,
        actorUserId: user.id,
        operationKey: 'http:release-acceptance'
      });
      response.statusCode = 500;
      response.end(JSON.stringify({ code: 'EXPECTED_CONCURRENCY_REJECTION' }));
    } catch (error) {
      if (error && error.name === 'AIConcurrencyServiceError') {
        response.statusCode = error.statusCode;
        response.setHeader('retry-after', String(error.retryAfter));
        response.end(JSON.stringify({ code: error.code, error: error.message }));
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'Authentication required' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

test('AI concurrency acceptance resolves only the dedicated release smoke actor', () => {
  const state = fixture();
  try {
    assert.deepEqual(resolveAcceptanceActor(state.db), {
      userId: 2,
      organizationId: 10,
      role: 'admin',
      username: 'release-smoke'
    });
    state.db.prepare('DELETE FROM team_memberships WHERE user_id=2').run();
    assert.throws(
      () => resolveAcceptanceActor(state.db),
      /dedicated release smoke/i
    );
  } finally {
    state.close();
  }
});

function rejectionStub(db, response = null) {
  return async function(_url, _token, _body) {
    const service = createAIConcurrencyService(db);
    assert.throws(
      () => service.acquire({ organizationId: 10, actorUserId: 2, operationKey: 'http:rejected' }),
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
      actor: { userId: 2, organizationId: 10, role: 'admin', username: 'release-smoke' },
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

test('production acceptance reaches the concurrency gate through real loopback auth and organization scope', async () => {
  const state = fixture();
  const jwtSecret = 'acceptance-test-secret';
  const server = await startAcceptanceHttpServer(state.db, jwtSecret);
  try {
    const evidence = await runAcceptance({
      db: state.db,
      actor: resolveAcceptanceActor(state.db),
      jwtSecret,
      runId: 'c'.repeat(32),
      evidencePath: state.evidencePath,
      baseUrl: server.baseUrl
    });
    assert.deepEqual(evidence.rejection, {
      status: 429,
      code: 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED',
      retryAfter: evidence.rejection.retryAfter,
      businessWrites: 0,
      tokenWrites: 0
    });
    assert.ok(evidence.rejection.retryAfter >= 1 && evidence.rejection.retryAfter <= 135);
  } finally {
    await server.close();
    state.close();
  }
});

test('production acceptance reaches the concurrency gate through the real server router', async () => {
  const server = await startActualServer();
  const db = new Database(server.dbPath);
  db.pragma('foreign_keys = ON');
  const evidencePath = path.join(path.dirname(server.dbPath), 'actual-acceptance.json');
  try {
    provisionReleaseSmokeIdentity(db, {
      organizationId: 1,
      createPasswordHash: () => bcrypt.hashSync('test-only-unused-password', 4)
    });
    const actor = resolveAcceptanceActor(db);
    const evidence = await runAcceptance({
      db,
      actor,
      jwtSecret: TEST_JWT_SECRET,
      runId: 'd'.repeat(32),
      evidencePath,
      baseUrl: server.baseUrl
    });
    assert.equal(evidence.rejection.status, 429);
    assert.equal(evidence.rejection.code, 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED');
  } finally {
    db.close();
    await server.close();
  }
});

test('failed production acceptance still releases reservations, removes its session, and restores policy', async () => {
  const state = fixture();
  try {
    await assert.rejects(runAcceptance({
      db: state.db,
      actor: { userId: 2, organizationId: 10, role: 'admin', username: 'release-smoke' },
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
