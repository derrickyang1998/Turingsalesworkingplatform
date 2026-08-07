'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const proofScript = path.join(
  serverRoot,
  'scripts',
  'verify_phase4_one_request_replay.js'
);

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
    migration_versions: [1, 2, 3, 4, 5],
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
