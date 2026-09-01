#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const GATE = 'phase4-task9-one-request-replay';
const PROBE_PROTOCOL = 'tm-phase4-one-request-replay-probe-v1';
const TARGET_PATH = '/api/workflow/templates';
const REQUEST_ID = 'phase4-one-request-replay-0001';
const IDEMPOTENCY_KEY = 'phase4.one-request.replay.v1';
const TEMPLATE_NAME = 'Phase 4 one-request replay proof';
const JWT_SECRET = crypto
  .createHash('sha256')
  .update('phase4-one-request-replay-isolated-fixture-v1')
  .digest('base64url');
const ALLOWED_FAULTS = new Set([
  'none',
  'parser-bypass',
  'auth-bypass',
  'mutation-bypass',
  'network-bypass'
]);

const serverRoot = path.resolve(__dirname, '..');
const platformRoot = path.resolve(serverRoot, '..');
const serverEntry = path.join(serverRoot, 'server.js');
const probeEntry = path.join(
  serverRoot,
  'scripts',
  'verify_phase4_one_request_replay_probe.js'
);

class VerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new VerificationError(code, message);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function fixtureEnvironment({ dbPath, fault, port, tempDir }) {
  const allowedInherited = new Set([
    'APPDATA',
    'COMSPEC',
    'HOME',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'WINDIR'
  ]);
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (allowedInherited.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  }
  return Object.assign(environment, {
    NODE_ENV: 'test',
    TM_DISABLE_DOTENV: '1',
    SERVER_HOST: '127.0.0.1',
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET,
    UPLOAD_DIR: path.join(tempDir, 'uploads'),
    TMP_DIR: path.join(tempDir, 'runtime-tmp'),
    PPT_CACHE_DIR: path.join(tempDir, 'ppt-cache'),
    TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
    UPLOAD_SANDBOX_SPOOL_ROOT: path.join(tempDir, 'upload-spool'),
    TM_PHASE4_ONE_REQUEST_REPLAY_MODE: '1',
    TM_PHASE4_ONE_REQUEST_REPLAY_FAULT: fault,
    TM_PHASE4_ONE_REQUEST_REPLAY_USER_ID: '1',
    TZ: 'UTC'
  });
}

function startServer({ dbPath, fault, port, tempDir }) {
  const output = [];
  const probeEvents = [];
  const child = spawn(
    process.execPath,
    ['--require', probeEntry, serverEntry],
    {
      cwd: platformRoot,
      env: fixtureEnvironment({ dbPath, fault, port, tempDir }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    }
  );
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  child.on('message', (message) => {
    if (message && message.protocol === PROBE_PROTOCOL) probeEvents.push(message);
  });
  return {
    child,
    output: () => Buffer.concat(output).toString('utf8'),
    probeEvents
  };
}

function healthRequest(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/health',
      method: 'GET',
      agent: false
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

async function waitForHealth(server, port) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `real Express server exited before health (${server.child.exitCode}): ${server.output()}`
      );
    }
    try {
      if (await healthRequest(port) === 200) return;
    } catch (_error) {
      // The isolated server is still starting and migrating its fixture.
    }
    await delay(100);
  }
  throw new Error(`real Express server health timed out: ${server.output()}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    delay(3_000)
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), delay(2_000)]);
  }
}

function countProofRows(db) {
  return {
    workflow_templates: db.prepare(`
      SELECT COUNT(*) AS count
      FROM workflow_templates
      WHERE name=? AND module='campaign'
    `).get(TEMPLATE_NAME).count,
    idempotency_rows: db.prepare(`
      SELECT COUNT(*) AS count
      FROM request_idempotency
      WHERE scope='workflow.campaign-template.create'
        AND idempotency_key LIKE ?
    `).get(`${IDEMPOTENCY_KEY}%`).count
  };
}

function seedFixture(dbPath) {
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const migrationVersions = db.prepare(`
      SELECT version
      FROM schema_migrations
      ORDER BY version
    `).all().map((row) => row.version);
    assert.deepEqual(
      migrationVersions,
      [1, 2, 3, 4, 5, 6, 7, 8],
      'isolated fixture must use the current production migration chain'
    );

    const identity = db.prepare(`
      SELECT
        user.id AS user_id,
        user.username,
        membership.org_id,
        team_membership.team_id
      FROM users user
      JOIN organization_memberships membership
        ON membership.user_id=user.id AND membership.status='active'
      JOIN team_memberships team_membership
        ON team_membership.user_id=user.id
       AND team_membership.org_id=membership.org_id
       AND team_membership.status='active'
      WHERE user.is_active=1 AND user.role='admin'
      ORDER BY user.id,team_membership.team_id
      LIMIT 1
    `).get();
    if (!identity || identity.user_id !== 1) {
      fail(
        'PHASE4_FIXTURE_IDENTITY_FAILED',
        'isolated migration did not create the expected deterministic admin identity'
      );
    }

    const token = jwt.sign(
      { userId: identity.user_id, purpose: 'phase4-one-request-replay' },
      JWT_SECRET,
      { algorithm: 'HS256', noTimestamp: true }
    );
    db.prepare(`
      INSERT INTO sessions (user_id,token,ip_address,expires_at)
      VALUES (?,?,'127.0.0.1','2099-01-01 00:00:00')
    `).run(identity.user_id, token);

    return {
      identity,
      token,
      migrationVersions,
      baseline: countProofRows(db)
    };
  } finally {
    db.close();
  }
}

function workflowTemplatePayload() {
  return {
    name: TEMPLATE_NAME,
    description: 'Deterministic Phase 4 replay verification fixture',
    module: 'campaign',
    category: 'approval',
    nodes: [],
    edges: []
  };
}

function sendOwnedRequest({ body, port, token }) {
  const requestBodySha256 = sha256(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: TARGET_PATH,
      method: 'POST',
      agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
        'X-Request-Id': REQUEST_ID,
        'Idempotency-Key': IDEMPOTENCY_KEY,
        Connection: 'close'
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('aborted', () => reject(new Error('owned response aborted')));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        requestBodySha256
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function waitForProbeAttempt(server, attempt) {
  for (let check = 0; check < 120; check += 1) {
    if (server.probeEvents.some((event) => (
      event.attempt === attempt && event.kind === 'request-finished'
    ))) return;
    if (server.child.exitCode !== null) {
      throw new Error(`real Express server exited during request proof: ${server.output()}`);
    }
    await delay(25);
  }
  throw new Error(`request probe did not finish attempt ${attempt}`);
}

function readPostState(dbPath, fixture) {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma('busy_timeout = 5000');
    const current = countProofRows(db);
    const mutation = Object.fromEntries(
      Object.keys(current).map((key) => [key, current[key] - fixture.baseline[key]])
    );
    const ledgers = db.prepare(`
      SELECT
        id,user_id,campaign_id,scope,idempotency_key,state,status_code,
        response_kind,response_json
      FROM request_idempotency
      WHERE scope='workflow.campaign-template.create'
        AND idempotency_key LIKE ?
      ORDER BY id
    `).all(`${IDEMPOTENCY_KEY}%`);
    const templates = db.prepare(`
      SELECT
        id,name,module,category,version,is_active,created_by,nodes,edges
      FROM workflow_templates
      WHERE name=? AND module='campaign'
      ORDER BY id
    `).all(TEMPLATE_NAME);
    const migrationVersions = db.prepare(`
      SELECT version
      FROM schema_migrations
      ORDER BY version
    `).all().map((row) => row.version);
    const quickCheck = db.prepare('PRAGMA quick_check').get().quick_check;
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    return {
      mutation,
      ledgers,
      templates,
      migrationVersions,
      quickCheck,
      foreignKeyViolations
    };
  } finally {
    db.close();
  }
}

function eventsForAttempt(probeEvents, attempt) {
  return probeEvents
    .filter((event) => event.attempt === attempt)
    .sort((left, right) => left.sequence - right.sequence);
}

function verifyBypassRemoval(probeEvents) {
  let phase4BodyConsumptions = 0;
  let jwtVerifications = 0;
  let globalJsonBodyConsumptions = 0;
  let globalUrlencodedBodyConsumptions = 0;
  let authBeforeBody = true;

  for (const attempt of [1, 2]) {
    const events = eventsForAttempt(probeEvents, attempt);
    const entered = events.filter((event) => event.kind === 'request-enter');
    const jsonParsers = events.filter((event) => (
      event.kind === 'global-parser-finished' && event.parser === 'json'
    ));
    const urlencodedParsers = events.filter((event) => (
      event.kind === 'global-parser-finished' && event.parser === 'urlencoded'
    ));
    const jwtEvents = events.filter((event) => event.kind === 'jwt-verify');
    const phase4Listeners = events.filter((event) => (
      event.kind === 'body-listener' && event.source === 'phase4'
    ));
    const globalListeners = events.filter((event) => (
      event.kind === 'body-listener' && event.source === 'global'
    ));
    const otherListeners = events.filter((event) => (
      event.kind === 'body-listener' && event.source === 'other'
    ));

    if (entered.length !== 1 || jsonParsers.length !== 1 || urlencodedParsers.length !== 1) {
      fail(
        'PHASE4_PROBE_EVIDENCE_INCOMPLETE',
        `request attempt ${attempt} did not traverse the complete production parser boundary`
      );
    }

    const jsonConsumed = jsonParsers.some((event) => (
      event.data_listeners_added !== 0 ||
      event.body_value_present ||
      event.readable_ended
    ));
    const urlencodedConsumed = urlencodedParsers.some((event) => (
      event.data_listeners_added !== 0 ||
      event.body_value_present ||
      event.readable_ended
    ));
    if (jsonConsumed) globalJsonBodyConsumptions += 1;
    if (urlencodedConsumed) globalUrlencodedBodyConsumptions += 1;
    if (jsonConsumed || urlencodedConsumed || globalListeners.length !== 0) {
      fail(
        'PHASE4_GLOBAL_PARSER_BYPASS_DETECTED',
        `global JSON parser consumed owned request body on attempt ${attempt}`
      );
    }
    if (otherListeners.length !== 0) {
      fail(
        'PHASE4_BODY_OWNERSHIP_FAILED',
        `an unclassified request body consumer was present on attempt ${attempt}`
      );
    }
    if (jwtEvents.length !== 1 || entered[0].authorization_present !== true) {
      fail(
        'PHASE4_AUTH_BYPASS_DETECTED',
        `attempt ${attempt} did not perform exactly one JWT verification before body consumption`
      );
    }
    if (phase4Listeners.length !== 1) {
      fail(
        'PHASE4_BODY_OWNERSHIP_FAILED',
        `Phase 4 did not exclusively consume the request body on attempt ${attempt}`
      );
    }
    if (jwtEvents[0].sequence >= phase4Listeners[0].sequence) authBeforeBody = false;
    phase4BodyConsumptions += phase4Listeners.length;
    jwtVerifications += jwtEvents.length;
  }

  if (!authBeforeBody) {
    fail(
      'PHASE4_AUTH_ORDER_FAILED',
      'JWT verification did not precede Phase 4 request body consumption'
    );
  }
  const requestEnters = probeEvents.filter((event) => event.kind === 'request-enter');
  if (requestEnters.length !== 2) {
    fail(
      'PHASE4_REQUEST_CARDINALITY_FAILED',
      `expected two transmissions of one logical request, observed ${requestEnters.length}`
    );
  }

  return {
    globalJsonBodyConsumptions,
    globalUrlencodedBodyConsumptions,
    phase4BodyConsumptions,
    jwtVerifications,
    authBeforeBody
  };
}

function verifyExternalNetworkIsolation(probeEvents) {
  const attempts = probeEvents.filter(
    (event) => event.kind === 'external-network-attempt'
  );
  if (attempts.length !== 0) {
    const transports = attempts
      .map((event) => `${event.transport}:${event.host || '<implicit>'}`)
      .join(',');
    fail(
      'PHASE4_EXTERNAL_NETWORK_ATTEMPTED',
      `isolated Express proof attempted non-loopback networking (${transports})`
    );
  }
  return {
    guard: 'preload-fail-closed',
    externalNetworkAttempts: attempts.length
  };
}

function verifyMutation(state, fixture) {
  const { mutation } = state;
  if (
    mutation.workflow_templates !== 1 ||
    mutation.idempotency_rows !== 1
  ) {
    fail(
      'PHASE4_MUTATION_CARDINALITY_FAILED',
      `expected exactly one workflow template mutation and one idempotency row; observed ${mutation.workflow_templates}/${mutation.idempotency_rows}`
    );
  }
  if (state.ledgers.length !== 1 || state.templates.length !== 1) {
    fail(
      'PHASE4_MUTATION_EVIDENCE_FAILED',
      'one-request mutation evidence was not uniquely retained'
    );
  }
  const ledger = state.ledgers[0];
  const template = state.templates[0];
  if (
    ledger.user_id !== fixture.identity.user_id ||
    ledger.campaign_id !== null ||
    ledger.idempotency_key !== IDEMPOTENCY_KEY ||
    ledger.state !== 'completed' ||
    ledger.status_code !== 200 ||
    ledger.response_kind !== 'json' ||
    template.created_by !== fixture.identity.user_id ||
    template.name !== TEMPLATE_NAME ||
    template.module !== 'campaign' ||
    template.category !== 'approval' ||
    template.version !== 1 ||
    template.is_active !== 0 ||
    template.nodes !== '[]' ||
    template.edges !== '[]'
  ) {
    fail(
      'PHASE4_MUTATION_EVIDENCE_FAILED',
      'retained workflow template, authentication, and idempotency evidence did not agree'
    );
  }
  return { ledger, template };
}

function stableResponseFrame(response) {
  const contentType = String(response.headers['content-type'] || '');
  const contentLength = String(response.headers['content-length'] || '');
  const requestId = String(response.headers['x-request-id'] || '');
  return Buffer.concat([
    Buffer.from(
      `status:${response.statusCode}\ncontent-type:${contentType}\ncontent-length:${contentLength}\nx-request-id:${requestId}\n\n`,
      'utf8'
    ),
    response.body
  ]);
}

function verifyReplay(first, second, evidence, fixture) {
  for (const [label, response] of [['first', first], ['retry', second]]) {
    if (response.statusCode !== 200) {
      fail(
        'PHASE4_REPLAY_HTTP_FAILED',
        `${label} transmission returned HTTP ${response.statusCode}: ${response.body.toString('utf8')}`
      );
    }
    if (response.headers['x-request-id'] !== REQUEST_ID) {
      fail(
        'PHASE4_REPLAY_REQUEST_ID_FAILED',
        `${label} transmission did not retain the Phase 4 request ID`
      );
    }
    if (Number(response.headers['content-length']) !== response.body.length) {
      fail(
        'PHASE4_REPLAY_LENGTH_FAILED',
        `${label} transmission content length did not match its response bytes`
      );
    }
  }

  const firstFrame = stableResponseFrame(first);
  const secondFrame = stableResponseFrame(second);
  if (!firstFrame.equals(secondFrame)) {
    fail(
      'PHASE4_REPLAY_BYTES_FAILED',
      'same-key retry was not byte-equivalent to the original stable response frame' +
        ` (first=${sha256(firstFrame)}, retry=${sha256(secondFrame)}, ` +
        `first_body=${sha256(first.body)}, retry_body=${sha256(second.body)}, ` +
        `first_type=${first.headers['content-type'] || ''}, ` +
        `retry_type=${second.headers['content-type'] || ''}, ` +
        `first_length=${first.headers['content-length'] || ''}, ` +
        `retry_length=${second.headers['content-length'] || ''}, ` +
        `first_request_id=${first.headers['x-request-id'] || ''}, ` +
        `retry_request_id=${second.headers['x-request-id'] || ''})`
    );
  }
  const retainedBytes = Buffer.from(evidence.ledger.response_json, 'utf8');
  if (!first.body.equals(retainedBytes) || !second.body.equals(retainedBytes)) {
    fail(
      'PHASE4_REPLAY_LEDGER_BYTES_FAILED',
      'HTTP response bytes did not equal the retained idempotency response bytes'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(first.body.toString('utf8'));
  } catch (_error) {
    fail('PHASE4_REPLAY_JSON_FAILED', 'workflow template replay response was not valid JSON');
  }
  if (
    !parsed ||
    Object.keys(parsed).length !== 1 ||
    parsed.id !== evidence.template.id ||
    evidence.template.created_by !== fixture.identity.user_id
  ) {
    fail(
      'PHASE4_REPLAY_PAYLOAD_FAILED',
      'workflow template replay response did not represent the authenticated fixture mutation'
    );
  }

  return {
    statusCode: first.statusCode,
    responseBytes: firstFrame.length,
    responseSha256: sha256(firstFrame),
    fallbackRequestIds: [first, second].filter(
      (response) => response.headers['x-request-id'] !== REQUEST_ID
    ).length
  };
}

function verifyIntegrity(state) {
  if (
    state.quickCheck !== 'ok' ||
    state.foreignKeyViolations !== 0 ||
    JSON.stringify(state.migrationVersions) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8])
  ) {
    fail(
      'PHASE4_FIXTURE_INTEGRITY_FAILED',
      'isolated migrated SQLite fixture failed integrity verification'
    );
  }
}

async function verifyPhase4OneRequestReplay(options = {}) {
  const fault = options.fault || 'none';
  if (!ALLOWED_FAULTS.has(fault)) {
    fail('PHASE4_INVALID_FAULT', `unsupported proof fault: ${fault}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-replay-'));
  const dbPath = path.join(tempDir, 'fixture.db');
  const port = await reservePort();
  const server = startServer({ dbPath, fault, port, tempDir });
  try {
    await waitForHealth(server, port);
    const fixture = seedFixture(dbPath);
    const logicalRequestBody = Buffer.from(
      JSON.stringify(workflowTemplatePayload()),
      'utf8'
    );
    const firstWireBody = Buffer.from(logicalRequestBody);
    const secondWireBody = Buffer.from(logicalRequestBody);

    const first = await sendOwnedRequest({
      body: firstWireBody,
      port,
      token: fixture.token
    });
    await waitForProbeAttempt(server, 1);
    const second = await sendOwnedRequest({
      body: secondWireBody,
      port,
      token: fixture.token
    });
    await waitForProbeAttempt(server, 2);

    const state = readPostState(dbPath, fixture);
    const bypass = verifyBypassRemoval(server.probeEvents);
    const networkIsolation = verifyExternalNetworkIsolation(server.probeEvents);
    const evidence = verifyMutation(state, fixture);
    const replay = verifyReplay(first, second, evidence, fixture);
    verifyIntegrity(state);

    return {
      schema_version: 1,
      gate: GATE,
      ok: true,
      assembly: {
        kind: 'real-express-server',
        entry: path.basename(serverEntry),
        isolated_migrated_sqlite: true,
        loopback_only: true,
        external_network_requests: networkIsolation.externalNetworkAttempts,
        network_guard: networkIsolation.guard
      },
      request: {
        method: 'POST',
        path: TARGET_PATH,
        logical_owned_mutating_requests: 1,
        transmission_attempts: 2,
        identical_wire_body:
          firstWireBody.equals(secondWireBody) &&
          first.requestBodySha256 === second.requestBodySha256,
        authenticated_attempts: bypass.jwtVerifications,
        idempotency_key_reused: true
      },
      replay: {
        status_code: replay.statusCode,
        byte_equivalent: true,
        ledger_byte_equivalent: true,
        response_sha256: replay.responseSha256,
        response_bytes: replay.responseBytes
      },
      mutation: state.mutation,
      bypass_removal: {
        global_json_body_consumptions: bypass.globalJsonBodyConsumptions,
        global_urlencoded_body_consumptions:
          bypass.globalUrlencodedBodyConsumptions,
        phase4_body_consumptions: bypass.phase4BodyConsumptions,
        jwt_verifications: bypass.jwtVerifications,
        auth_before_body_on_every_attempt: bypass.authBeforeBody,
        fallback_request_ids: replay.fallbackRequestIds
      },
      integrity: {
        migration_versions: state.migrationVersions,
        quick_check: state.quickCheck,
        foreign_key_violations: state.foreignKeyViolations
      }
    };
  } finally {
    await stopServer(server.child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseCommandLine(argv) {
  let fault = 'none';
  for (const argument of argv) {
    if (argument.startsWith('--fault=')) {
      fault = argument.slice('--fault='.length);
    } else {
      fail('PHASE4_INVALID_ARGUMENT', `unsupported argument: ${argument}`);
    }
  }
  return { fault };
}

async function main() {
  try {
    const report = await verifyPhase4OneRequestReplay(
      parseCommandLine(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${JSON.stringify({
      schema_version: 1,
      gate: GATE,
      ok: false,
      code: error && error.code || 'PHASE4_ONE_REQUEST_REPLAY_FAILED',
      message: error && error.message || 'Phase 4 one-request replay proof failed'
    })}\n`);
  }
}

if (require.main === module) main();

module.exports = {
  ALLOWED_FAULTS,
  VerificationError,
  verifyPhase4OneRequestReplay,
  _testing: Object.freeze({ fixtureEnvironment })
};
