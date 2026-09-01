'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const proofScript = path.join(
  serverRoot,
  'scripts',
  'verify_phase4_one_request_replay.js'
);
const proof = require(proofScript);

test('proof binds every server startup write path to its isolated temp directory', () => {
  const tempDir = path.join('isolated', 'phase4-proof');
  const environment = proof._testing.fixtureEnvironment({
    dbPath: path.join(tempDir, 'fixture.db'),
    fault: 'none',
    port: 43187,
    tempDir
  });

  assert.equal(environment.UPLOAD_DIR, path.join(tempDir, 'uploads'));
  assert.equal(environment.TMP_DIR, path.join(tempDir, 'runtime-tmp'));
  assert.equal(environment.PPT_CACHE_DIR, path.join(tempDir, 'ppt-cache'));
  assert.equal(environment.TM_PHASE4_ONE_REQUEST_REPLAY_MODE, '1');
  assert.equal(
    environment.UPLOAD_SANDBOX_SPOOL_ROOT,
    path.join(tempDir, 'upload-spool')
  );
});

test('local-worker proof bypasses production-only parser readiness without changing it', () => {
  const serverSource = fs.readFileSync(path.join(serverRoot, 'server.js'), 'utf8');
  assert.match(
    serverSource,
    /const readiness = PHASE4_ONE_REQUEST_REPLAY_MODE\s*\?\s*localUploadReadinessSnapshot\(\)\s*:\s*await assertUploadSandboxStartupReady/
  );
});

test('replay-only readiness snapshot rejects the marker outside the IPC proof process', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-no-ipc-'));
  const environment = proof._testing.fixtureEnvironment({
    dbPath: path.join(tempDir, 'fixture.db'),
    fault: 'none',
    port: 43187,
    tempDir
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(serverRoot, 'server.js')], {
        cwd: serverRoot,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const output = [];
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('non-IPC replay marker rejection timed out'));
      }, 10_000);
      timer.unref();
      child.stdout.on('data', (chunk) => output.push(chunk));
      child.stderr.on('data', (chunk) => output.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output: Buffer.concat(output).toString('utf8') });
      });
    });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Invalid Phase 4 one-request replay configuration/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function lastJsonLine(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.notEqual(lines.length, 0, 'proof process must emit a JSON result');
  return JSON.parse(lines.at(-1));
}

function runProof(fault = null) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    environment.NODE_ENV = 'test';
    environment.TM_DISABLE_DOTENV = '1';

    const args = [proofScript];
    if (fault) args.push(`--fault=${fault}`);
    const child = spawn(process.execPath, args, {
      cwd: serverRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`proof process timed out for fault=${fault || 'none'}`));
    }, 60_000);
    timer.unref();

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

test('real Express assembly proves one mutation and a byte-equivalent authenticated replay', {
  timeout: 70_000
}, async () => {
  const result = await runProof();
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');

  const report = lastJsonLine(result.stdout);
  assert.equal(report.schema_version, 1);
  assert.equal(report.gate, 'phase4-task9-one-request-replay');
  assert.equal(report.ok, true);
  assert.deepEqual(report.assembly, {
    kind: 'real-express-server',
    entry: 'server.js',
    isolated_migrated_sqlite: true,
    loopback_only: true,
    external_network_requests: 0,
    network_guard: 'preload-fail-closed'
  });
  assert.deepEqual(report.request, {
    method: 'POST',
    path: '/api/workflow/templates',
    logical_owned_mutating_requests: 1,
    transmission_attempts: 2,
    identical_wire_body: true,
    authenticated_attempts: 2,
    idempotency_key_reused: true
  });
  assert.equal(report.replay.status_code, 200);
  assert.equal(report.replay.byte_equivalent, true);
  assert.equal(report.replay.ledger_byte_equivalent, true);
  assert.match(report.replay.response_sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.replay.response_bytes > 0, true);
  assert.deepEqual(report.mutation, {
    workflow_templates: 1,
    idempotency_rows: 1
  });
  assert.deepEqual(report.bypass_removal, {
    global_json_body_consumptions: 0,
    global_urlencoded_body_consumptions: 0,
    phase4_body_consumptions: 2,
    jwt_verifications: 2,
    auth_before_body_on_every_attempt: true,
    fallback_request_ids: 0
  });
  assert.deepEqual(report.integrity, {
    migration_versions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    quick_check: 'ok',
    foreign_key_violations: 0
  });
});

test('proof fails when a global JSON parser is deliberately allowed to consume the owned body', {
  timeout: 70_000
}, async () => {
  const result = await runProof('parser-bypass');
  assert.equal(result.code, 1, result.stdout || result.stderr);
  assert.equal(result.stdout, '');
  const failure = lastJsonLine(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'PHASE4_GLOBAL_PARSER_BYPASS_DETECTED');
  assert.match(failure.message, /global JSON parser consumed/i);
});

test('proof fails when request identity is deliberately injected ahead of JWT authentication', {
  timeout: 70_000
}, async () => {
  const result = await runProof('auth-bypass');
  assert.equal(result.code, 1, result.stdout || result.stderr);
  assert.equal(result.stdout, '');
  const failure = lastJsonLine(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'PHASE4_AUTH_BYPASS_DETECTED');
  assert.match(failure.message, /JWT verification/i);
});

test('proof fails when the replay key is deliberately rewritten to create a second mutation', {
  timeout: 70_000
}, async () => {
  const result = await runProof('mutation-bypass');
  assert.equal(result.code, 1, result.stdout || result.stderr);
  assert.equal(result.stdout, '');
  const failure = lastJsonLine(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'PHASE4_MUTATION_CARDINALITY_FAILED');
  assert.match(failure.message, /expected exactly one workflow template mutation/i);
});

test('proof fails when the real server attempts non-loopback networking', {
  timeout: 70_000
}, async () => {
  const result = await runProof('network-bypass');
  assert.equal(result.code, 1, result.stdout || result.stderr);
  assert.equal(result.stdout, '');
  const failure = lastJsonLine(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'PHASE4_EXTERNAL_NETWORK_ATTEMPTED');
  assert.match(failure.message, /non-loopback networking/i);
});
