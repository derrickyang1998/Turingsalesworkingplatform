'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const gate = require('../scripts/release_replay_gate');
const linuxReplayProofAvailable = process.platform === 'linux'
  || (process.platform === 'win32' && process.env.TM_RUN_WSL_REPLAY_TESTS === '1');
const linuxReplayProofSkip = linuxReplayProofAvailable
  ? false
  : 'requires native Linux or an explicitly enabled WSL replay environment';

const requestPolicy = Object.freeze({
  method: 'POST',
  path: '/api/campaigns/campaign-1/proposal-draft',
  claimHeaderName: 'x-tm-replay-claim',
  expectedClaim: Buffer.from('one-use-claim', 'utf8'),
  maxBodyBytes: 16,
  maxHeaderBytes: 4096
});

function rawRequest({
  method = 'POST',
  target = '/api/campaigns/campaign-1/proposal-draft',
  headers = [],
  body = '',
  claim = 'one-use-claim',
  contentLength = Buffer.byteLength(body),
  connection = 'close'
} = {}) {
  const baseHeaders = [
    'Host: replay.internal',
    `Content-Length: ${contentLength}`
  ];
  if (connection !== null) baseHeaders.push(`Connection: ${connection}`);
  if (claim !== null) baseHeaders.push(`X-TM-Replay-Claim: ${claim}`);
  return Buffer.from(
    `${method} ${target} HTTP/1.1\r\n${baseHeaders.concat(headers).join('\r\n')}\r\n\r\n${body}`,
    'latin1'
  );
}

test('parseReplayRequest accepts only the exact bounded origin-form request', () => {
  const parsed = gate.parseReplayRequest(rawRequest({ body: '{"ok":true}' }), requestPolicy);

  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.pathDigest.length, 64);
  assert.equal(parsed.requestDigest.length, 64);
  assert.equal(parsed.bodyDigest.length, 64);
  assert.equal(parsed.bodyBytes, 11);
  assert.equal(parsed.forwardHeaders.some(([name]) => name === 'x-tm-replay-claim'), false);
  assert.equal(parsed.forwardHeaders.some(([name]) => name === 'connection'), false);
});

test('parseReplayRequest fails closed for route, claim, framing and protocol bypasses', () => {
  const cases = [
    ['wrong method', rawRequest({ method: 'PUT' }), 'METHOD_MISMATCH'],
    ['CONNECT', rawRequest({ method: 'CONNECT' }), 'CONNECT_FORBIDDEN'],
    ['wrong path', rawRequest({ target: '/api/other' }), 'PATH_MISMATCH'],
    ['absolute form', rawRequest({ target: 'http://127.0.0.1/api/campaigns' }), 'ABSOLUTE_FORM_FORBIDDEN'],
    ['missing claim', rawRequest({ claim: null }), 'CLAIM_REQUIRED'],
    ['wrong claim', rawRequest({ claim: 'wrong' }), 'CLAIM_MISMATCH'],
    ['duplicate claim', rawRequest({ headers: ['X-TM-Replay-Claim: one-use-claim'] }), 'DUPLICATE_HEADER'],
    ['upgrade', rawRequest({ headers: ['Upgrade: websocket'] }), 'UPGRADE_FORBIDDEN'],
    ['transfer encoding', rawRequest({ headers: ['Transfer-Encoding: chunked'] }), 'TRANSFER_ENCODING_FORBIDDEN'],
    ['body over bound', rawRequest({ body: '0123456789abcdefg' }), 'BODY_TOO_LARGE'],
    ['short framing', rawRequest({ body: 'abc', contentLength: 4 }), 'FRAMING_MISMATCH'],
    ['pipelining', Buffer.concat([rawRequest(), rawRequest()]), 'PIPELINING_FORBIDDEN']
  ];

  for (const [name, bytes, code] of cases) {
    assert.throws(
      () => gate.parseReplayRequest(bytes, requestPolicy),
      (error) => error instanceof gate.GateError && error.code === code,
      name
    );
  }
});

test('parseReplayRequest rejects invalid field syntax and strips connection-nominated headers', () => {
  const withoutHost = Buffer.from(
    rawRequest().toString('latin1').replace('Host: replay.internal\r\n', ''),
    'latin1'
  );
  const cases = [
    ['missing host', withoutHost, 'HOST_REQUIRED'],
    ['invalid field name', rawRequest({ headers: ['Bad(Name): value'] }), 'MALFORMED_HEADER'],
    ['control in field value', rawRequest({ headers: ['X-Value: before\0after'] }), 'MALFORMED_HEADER'],
    ['expect continue', rawRequest({ headers: ['Expect: 100-continue'] }), 'EXPECT_FORBIDDEN']
  ];
  for (const [name, bytes, code] of cases) {
    assert.throws(
      () => gate.parseReplayRequest(bytes, requestPolicy),
      (error) => error instanceof gate.GateError && error.code === code,
      name
    );
  }

  const parsed = gate.parseReplayRequest(rawRequest({
    connection: 'close, x-forward-me',
    headers: ['X-Forward-Me: private-internal-value']
  }), requestPolicy);
  assert.equal(parsed.forwardHeaders.some(([name]) => name === 'x-forward-me'), false);
});

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writePrivate(filePath, value) {
  fs.writeFileSync(filePath, value, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(filePath, 0o600);
}

function withSwapAtPrivateOpen(filePath, swap, action) {
  const target = path.resolve(filePath);
  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  const maybeSwap = (candidate) => {
    if (swapped || typeof candidate !== 'string' || path.resolve(candidate) !== target) return;
    swapped = true;
    swap();
  };
  fs.openSync = function openSyncWithSwap(candidate, ...args) {
    maybeSwap(candidate);
    return originalOpenSync.call(fs, candidate, ...args);
  };
  fs.readFileSync = function readFileSyncWithSwap(candidate, ...args) {
    maybeSwap(candidate);
    return originalReadFileSync.call(fs, candidate, ...args);
  };
  try {
    action();
  } finally {
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(swapped, true, 'test fixture did not reach the private-file reopen boundary');
}

function makeGateFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-release-replay-'));
  const root = path.join(parent, 'gate');
  fs.mkdirSync(root, { mode: 0o710 });
  fs.chmodSync(root, 0o710);
  const stat = fs.statSync(root);
  const config = {
    root,
    socketPath: path.join(root, 'replay.sock'),
    expectedHeaderPath: path.join(root, 'expected-header'),
    pendingPath: path.join(root, 'probe.pending'),
    claimedPath: path.join(root, 'probe.claimed'),
    claimStagePath: path.join(root, 'probe.claim-evidence'),
    resultPath: path.join(root, 'probe.result'),
    pidPath: path.join(root, 'probe.pid'),
    nginxBypassPath: path.join(root, 'nginx-bypass.conf'),
    method: requestPolicy.method,
    path: requestPolicy.path,
    claimHeaderName: requestPolicy.claimHeaderName,
    sourceDigest: 'a'.repeat(64),
    runDigest: digest('release-run-1'),
    expectedClaimDigest: digest(requestPolicy.expectedClaim),
    candidatePort: 39001,
    maxBodyBytes: requestPolicy.maxBodyBytes,
    maxHeaderBytes: requestPolicy.maxHeaderBytes,
    maxResponseBytes: 4096,
    timeoutMs: 1000,
    identity: {
      rootUid: stat.uid,
      rootGid: stat.gid,
      wwwDataGid: stat.gid
    },
    allowNonPosixTestPlatform: process.platform === 'win32'
  };
  writePrivate(config.expectedHeaderPath, requestPolicy.expectedClaim);
  writePrivate(config.pendingPath, JSON.stringify({
    schema_version: 1,
    source_digest: config.sourceDigest,
    run_digest: config.runDigest
  }));
  writePrivate(config.nginxBypassPath, 'return 503;\n');
  return {
    config,
    dispose() {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  };
}

test('claimReplay performs one durable no-replace transition and permanently closes replay', () => {
  const fixture = makeGateFixture();
  try {
    const parsed = gate.parseReplayRequest(rawRequest({ body: '{"ok":true}' }), requestPolicy);
    const evidence = gate.claimReplay(fixture.config, parsed);

    assert.equal(evidence.schema_version, 1);
    assert.equal(evidence.source_digest, fixture.config.sourceDigest);
    assert.equal(evidence.run_digest, fixture.config.runDigest);
    assert.equal(evidence.request_digest, parsed.requestDigest);
    assert.equal(fs.existsSync(fixture.config.pendingPath), false);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(fixture.config.claimedPath).mode & 0o777, 0o600);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.config.claimedPath, 'utf8')), evidence);
    assert.equal(fs.readFileSync(fixture.config.claimedPath, 'utf8').includes('one-use-claim'), false);
    assert.equal(fs.readFileSync(fixture.config.claimedPath, 'utf8').includes('{"ok":true}'), false);
    assert.throws(
      () => gate.claimReplay(fixture.config, parsed),
      (error) => error instanceof gate.GateError && error.code === 'ALREADY_CLAIMED'
    );
  } finally {
    fixture.dispose();
  }
});

test('claimReplay crash points preserve the fail-closed restart boundary', () => {
  const cases = [
    ['before-claim', false, true, 'armed'],
    ['after-claim-before-unlink', true, true, 'claimed-interrupted'],
    ['after-unlink-before-forward', true, false, 'claimed']
  ];
  for (const [point, hasClaim, hasPending, state] of cases) {
    const fixture = makeGateFixture();
    try {
      const parsed = gate.parseReplayRequest(rawRequest(), requestPolicy);
      assert.throws(
        () => gate.claimReplay(fixture.config, parsed, {
          point,
          action() {
            throw new Error(`crash:${point}`);
          }
        }),
        new RegExp(`crash:${point}`)
      );
      assert.equal(fs.existsSync(fixture.config.claimedPath), hasClaim, point);
      assert.equal(fs.existsSync(fixture.config.pendingPath), hasPending, point);
      assert.equal(gate.validateGateState(fixture.config), state, point);
      if (hasClaim) {
        assert.throws(
          () => gate.claimReplay(fixture.config, parsed),
          (error) => error instanceof gate.GateError && error.code === 'ALREADY_CLAIMED',
          point
        );
      }
    } finally {
      fixture.dispose();
    }
  }
});

test('partial claimed evidence is permanently closed and cleanup repairs it from the durable stage', () => {
  const cases = ['after-claim-open-before-write', 'during-claim-write'];
  for (const point of cases) {
    const fixture = makeGateFixture();
    try {
      const parsed = gate.parseReplayRequest(rawRequest(), requestPolicy);
      assert.throws(
        () => gate.claimReplay(fixture.config, parsed, {
          point,
          action() {
            throw new Error(`crash:${point}`);
          }
        }),
        new RegExp(`crash:${point}`)
      );
      assert.equal(fs.existsSync(fixture.config.claimedPath), true);
      assert.equal(fs.existsSync(fixture.config.pendingPath), true);
      assert.equal(fs.existsSync(fixture.config.claimStagePath), true);
      assert.equal(gate.validateGateState(fixture.config), 'claimed-interrupted');
      assert.throws(
        () => gate.claimReplay(fixture.config, parsed),
        (error) => error instanceof gate.GateError && error.code === 'ALREADY_CLAIMED'
      );

      const cleanup = gate.cleanupGate(fixture.config);
      assert.equal(cleanup.ok, true);
      assert.equal(fs.existsSync(fixture.config.claimStagePath), false);
      const repaired = JSON.parse(fs.readFileSync(fixture.config.claimedPath, 'utf8'));
      assert.equal(repaired.request_digest, parsed.requestDigest);
      assert.equal(repaired.source_digest, fixture.config.sourceDigest);
    } finally {
      fixture.dispose();
    }
  }

  const modulePath = path.join(__dirname, '..', 'scripts', 'release_replay_gate.js');
  const childProgram = [
    "const gate = require(process.env.TM_TEST_GATE_MODULE);",
    'const config = JSON.parse(process.env.TM_TEST_GATE_CONFIG);',
    'const request = JSON.parse(process.env.TM_TEST_GATE_REQUEST);',
    'const point = process.env.TM_TEST_GATE_FAULT;',
    'gate.claimReplay(config, request, { point, action() { process.exit(86); } });'
  ].join(' ');
  for (const point of [
    'before-claim',
    'after-claim-open-before-write',
    'during-claim-write',
    'after-claim-before-unlink',
    'after-unlink-before-forward'
  ]) {
    const fixture = makeGateFixture();
    try {
      const parsed = gate.parseReplayRequest(rawRequest(), requestPolicy);
      const child = spawnSync(process.execPath, ['-e', childProgram], {
        env: {
          TM_TEST_GATE_MODULE: modulePath,
          TM_TEST_GATE_CONFIG: JSON.stringify(fixture.config),
          TM_TEST_GATE_REQUEST: JSON.stringify({
            requestDigest: parsed.requestDigest,
            pathDigest: parsed.pathDigest,
            bodyDigest: parsed.bodyDigest
          }),
          TM_TEST_GATE_FAULT: point
        },
        encoding: 'utf8',
        timeout: 5000
      });
      assert.equal(child.error, undefined, child.error && child.error.stack);
      assert.equal(child.signal, null, child.stderr || child.stdout);
      assert.equal(child.status, 86, point);
      if (point === 'before-claim') {
        assert.equal(gate.validateGateState(fixture.config), 'armed');
      } else {
        assert.equal(fs.existsSync(fixture.config.claimedPath), true, point);
        assert.match(gate.validateGateState(fixture.config), /^claimed/, point);
        assert.throws(
          () => gate.claimReplay(fixture.config, parsed),
          (error) => error instanceof gate.GateError && error.code === 'ALREADY_CLAIMED',
          point
        );
      }
      assert.equal(gate.cleanupGate(fixture.config).ok, true, point);
    } finally {
      fixture.dispose();
    }
  }
});

test('atomic private publication recovers exact stage and same-inode link residues', () => {
  const points = ['after-audit-stage-fsync', 'after-audit-link-before-unlink'];
  for (const point of points) {
    const fixture = makeGateFixture();
    try {
      const evidence = {
        schema_version: 1,
        outcome: 'forwarded',
        source_digest: fixture.config.sourceDigest,
        run_digest: fixture.config.runDigest,
        request_digest: 'c'.repeat(64)
      };
      assert.throws(
        () => gate.writeAtomicPrivate(fixture.config.resultPath, evidence, fixture.config, {
          point,
          action() {
            throw new Error(`crash:${point}`);
          }
        }),
        new RegExp(`crash:${point}`)
      );

      assert.equal(gate.writeAtomicPrivate(fixture.config.resultPath, evidence, fixture.config), true);
      assert.equal(fs.statSync(fixture.config.resultPath).nlink, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(fixture.config.resultPath, 'utf8')), evidence);
      assert.equal(
        fs.readdirSync(fixture.config.root).some((name) => name.startsWith('.atomic-')),
        false
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('gate state rejects hard-linked private files before a claim transition', () => {
  const fixture = makeGateFixture();
  const alias = path.join(path.dirname(fixture.config.root), 'header-alias');
  try {
    fs.linkSync(fixture.config.expectedHeaderPath, alias);
    assert.throws(
      () => gate.validateGateState(fixture.config),
      (error) => error instanceof gate.GateError && error.code === 'UNSAFE_STATE_FILE'
    );
    assert.equal(fs.existsSync(fixture.config.claimedPath), false);
  } finally {
    fixture.dispose();
  }
});

test('private reads fail closed when a validated file is swapped to a symlink', { skip: linuxReplayProofSkip }, () => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(
      '^private reads fail closed when a validated file is swapped to a symlink$'
    );
    return;
  }
  const fixture = makeGateFixture();
  const originalPath = path.join(path.dirname(fixture.config.root), 'expected-header-original');
  try {
    withSwapAtPrivateOpen(fixture.config.expectedHeaderPath, () => {
      fs.renameSync(fixture.config.expectedHeaderPath, originalPath);
      fs.symlinkSync(originalPath, fixture.config.expectedHeaderPath);
    }, () => {
      assert.throws(
        () => gate.validateGateState(fixture.config),
        (error) => error instanceof gate.GateError && error.code === 'PRIVATE_FILE_RACE'
      );
    });
  } finally {
    fixture.dispose();
  }
});

test('private reads fail closed when a validated file is replaced by another regular inode', { skip: linuxReplayProofSkip }, () => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(
      '^private reads fail closed when a validated file is replaced by another regular inode$'
    );
    return;
  }
  const fixture = makeGateFixture();
  const parent = path.dirname(fixture.config.root);
  const originalPath = path.join(parent, 'expected-header-original');
  const replacementPath = path.join(parent, 'expected-header-replacement');
  try {
    writePrivate(replacementPath, requestPolicy.expectedClaim);
    withSwapAtPrivateOpen(fixture.config.expectedHeaderPath, () => {
      fs.renameSync(fixture.config.expectedHeaderPath, originalPath);
      fs.renameSync(replacementPath, fixture.config.expectedHeaderPath);
    }, () => {
      assert.throws(
        () => gate.validateGateState(fixture.config),
        (error) => error instanceof gate.GateError && error.code === 'PRIVATE_FILE_RACE'
      );
    });
  } finally {
    fixture.dispose();
  }
});

test('root validation rejects a same-device mount identity substitution', { skip: linuxReplayProofSkip }, () => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl('^root validation rejects a same-device mount identity substitution$');
    return;
  }
  const fixture = makeGateFixture();
  const root = path.resolve(fixture.config.root);
  const parent = path.dirname(root);
  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  const originalCloseSync = fs.closeSync;
  const descriptorPaths = new Map();
  try {
    assert.equal(fs.statSync(root).dev, fs.statSync(parent).dev);
    fs.openSync = function trackedOpenSync(candidate, ...args) {
      const descriptor = originalOpenSync.call(fs, candidate, ...args);
      if (typeof candidate === 'string') descriptorPaths.set(descriptor, path.resolve(candidate));
      return descriptor;
    };
    fs.readFileSync = function mountAwareReadFileSync(candidate, ...args) {
      if (typeof candidate === 'string') {
        const match = /^\/proc\/self\/fdinfo\/([0-9]+)$/.exec(candidate);
        const openedPath = match && descriptorPaths.get(Number(match[1]));
        if (openedPath === root) return Buffer.from('mnt_id:\t902\n', 'utf8');
        if (openedPath === parent) return Buffer.from('mnt_id:\t901\n', 'utf8');
      }
      return originalReadFileSync.call(fs, candidate, ...args);
    };
    fs.closeSync = function trackedCloseSync(descriptor) {
      descriptorPaths.delete(descriptor);
      return originalCloseSync.call(fs, descriptor);
    };

    assert.throws(
      () => gate.validateGateState(fixture.config),
      (error) => error instanceof gate.GateError && error.code === 'MOUNT_SUBSTITUTION'
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
    fs.closeSync = originalCloseSync;
    fixture.dispose();
  }
});

test('loadConfig accepts only explicit environment inputs and keeps secrets out of configuration', () => {
  const root = path.resolve(os.tmpdir(), 'tm-release-replay-config');
  const config = gate.loadConfig({
    TM_REPLAY_MODE: 'verify-state',
    TM_REPLAY_ROOT: root,
    TM_REPLAY_METHOD: 'POST',
    TM_REPLAY_PATH: requestPolicy.path,
    TM_REPLAY_HEADER_NAME: requestPolicy.claimHeaderName,
    TM_REPLAY_HEADER_SHA256: digest(requestPolicy.expectedClaim),
    TM_REPLAY_SOURCE_SHA256: 'b'.repeat(64),
    TM_REPLAY_RUN_ID: 'release-run-config',
    TM_REPLAY_CANDIDATE_PORT: '39002',
    TM_REPLAY_WWW_DATA_GID: '33',
    TM_REPLAY_MAX_BODY_BYTES: '16',
    TM_REPLAY_MAX_HEADER_BYTES: '4096',
    TM_REPLAY_MAX_RESPONSE_BYTES: '8192',
    TM_REPLAY_TIMEOUT_MS: '2000',
    TM_REPLAY_NGINX_BYPASS_PATH: path.join(root, 'nginx-bypass.conf')
  });

  assert.equal(config.mode, 'verify-state');
  assert.equal(config.socketPath, path.join(root, 'replay.sock'));
  assert.equal(config.runDigest, digest('release-run-config'));
  assert.deepEqual(config.identity, { rootUid: 0, rootGid: 0, wwwDataGid: 33 });
  assert.equal(JSON.stringify(config).includes('one-use-claim'), false);
  assert.throws(
    () => gate.loadConfig({ TM_REPLAY_MODE: 'serve', PATH: 'unexpected' }),
    (error) => error instanceof gate.GateError && error.code === 'UNSANITIZED_ENVIRONMENT'
  );
});

test('process identity matching binds PID evidence to boot, starttime, executable and exact run', () => {
  const config = { sourceDigest: 'd'.repeat(64), runDigest: 'e'.repeat(64) };
  const recorded = {
    schema_version: 1,
    pid: 4242,
    source_digest: config.sourceDigest,
    run_digest: config.runDigest,
    boot_id_digest: '1'.repeat(64),
    process_start_ticks: '987654',
    executable_digest: '2'.repeat(64),
    script_digest: '3'.repeat(64)
  };
  const observed = {
    pid: 4242,
    bootIdDigest: recorded.boot_id_digest,
    processStartTicks: recorded.process_start_ticks,
    executableDigest: recorded.executable_digest,
    scriptDigest: recorded.script_digest,
    environmentSourceDigest: config.sourceDigest,
    environmentRunDigest: config.runDigest,
    environmentMode: 'serve'
  };
  assert.equal(gate.processIdentityMatches(recorded, observed, config), true);
  for (const [field, value] of [
    ['bootIdDigest', '4'.repeat(64)],
    ['processStartTicks', '987655'],
    ['executableDigest', '5'.repeat(64)],
    ['scriptDigest', '6'.repeat(64)],
    ['environmentSourceDigest', '7'.repeat(64)],
    ['environmentRunDigest', '8'.repeat(64)],
    ['environmentMode', 'cleanup']
  ]) {
    assert.equal(gate.processIdentityMatches(recorded, { ...observed, [field]: value }, config), false, field);
  }
});

test('cleanupGate is idempotent, removes every live bypass input and preserves audit evidence', () => {
  const fixture = makeGateFixture();
  try {
    const parsed = gate.parseReplayRequest(rawRequest(), requestPolicy);
    gate.claimReplay(fixture.config, parsed);

    const first = gate.cleanupGate(fixture.config);
    const second = gate.cleanupGate(fixture.config);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fs.existsSync(fixture.config.socketPath), false);
    assert.equal(fs.existsSync(fixture.config.pendingPath), false);
    assert.equal(fs.existsSync(fixture.config.expectedHeaderPath), false);
    assert.equal(fs.existsSync(fixture.config.nginxBypassPath), false);
    assert.equal(fs.existsSync(fixture.config.pidPath), false);
    assert.equal(fs.existsSync(fixture.config.claimedPath), true);
    assert.equal(fs.existsSync(fixture.config.resultPath), true);
    const result = JSON.parse(fs.readFileSync(fixture.config.resultPath, 'utf8'));
    assert.equal(result.schema_version, 1);
    assert.equal(result.outcome, 'cleaned');
    assert.equal(result.source_digest, fixture.config.sourceDigest);
    assert.equal(result.run_digest, fixture.config.runDigest);
  } finally {
    fixture.dispose();
  }
});

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('forwardToCandidate uses explicit loopback once and strips claim and hop-by-hop headers', async () => {
  const observed = [];
  const candidate = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      observed.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(201, {
        'content-type': 'application/json',
        connection: 'keep-alive, x-candidate-internal',
        'x-candidate-internal': 'must-not-forward'
      });
      response.end('{"created":true}');
    });
  });
  const address = await listen(candidate, { host: '127.0.0.1', port: 0 });
  try {
    const parsed = gate.parseReplayRequest(rawRequest({ body: '{"ok":true}' }), requestPolicy);
    const response = await gate.forwardToCandidate({
      ...requestPolicy,
      candidatePort: address.port,
      maxResponseBytes: 1024,
      maxHeaderBytes: 4096,
      timeoutMs: 1000
    }, parsed);

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.toString('utf8'), '{"created":true}');
    assert.equal(observed.length, 1);
    assert.equal(observed[0].headers['x-tm-replay-claim'], undefined);
    assert.equal(observed[0].headers.connection, 'close');
    assert.equal(observed[0].body, '{"ok":true}');
    assert.equal(response.headers.some(([name]) => name === 'connection'), false);
    assert.equal(response.headers.some(([name]) => name === 'x-candidate-internal'), false);
  } finally {
    await close(candidate);
  }
});

function unixRequest(socketPath, bytes) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    socket.on('connect', () => socket.end(bytes));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => resolve({ error, bytes: Buffer.concat(chunks) }));
    socket.on('close', () => resolve({ error: null, bytes: Buffer.concat(chunks) }));
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function runLinuxTestThroughWsl(testName, timeout = 60_000) {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
  assert.equal(
    path.resolve(repositoryRoot, 'platform', 'server', 'tests', 'release_replay_gate.test.js'),
    __filename,
    'WSL runner must derive the repository root from this test file'
  );
  const converted = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', repositoryRoot], {
    encoding: 'utf8',
    timeout: 15_000
  });
  assert.equal(converted.error, undefined, converted.error && converted.error.stack);
  assert.equal(converted.signal, null, converted.stderr || converted.stdout);
  assert.equal(converted.status, 0, converted.stderr || converted.stdout);
  const linuxRoot = converted.stdout.replace(/\0/g, '').trim();
  const command = [
    'set -euo pipefail',
    'node_bin="$(command -v node || find "$HOME" -type f -path "*/bin/node" -perm -111 -print -quit)"',
    'test -n "$node_bin"',
    `cd ${shellQuote(linuxRoot)}`,
    `"$node_bin" --test --test-name-pattern=${shellQuote(testName)} platform/server/tests/release_replay_gate.test.js`
  ].join('; ');
  const result = spawnSync('wsl.exe', ['-e', 'bash', '-lc', command], {
    encoding: 'utf8',
    timeout
  });
  const diagnostics = [
    result.error && result.error.stack,
    result.signal && `signal=${result.signal}`,
    result.stdout,
    result.stderr
  ].filter(Boolean).join('\n');
  assert.equal(result.error, undefined, diagnostics);
  assert.equal(result.signal, null, diagnostics);
  assert.equal(result.status, 0, diagnostics);
  assert.match(result.stdout, /# pass 1\b/);
  assert.match(result.stdout, /# fail 0\b/);
}

function spawnServingHelper(fixture) {
  const scriptPath = path.join(path.dirname(fixture.config.root), 'serving-helper.js');
  const modulePath = path.join(__dirname, '..', 'scripts', 'release_replay_gate.js');
  if (!fs.existsSync(scriptPath)) {
    fs.writeFileSync(scriptPath, [
      "'use strict';",
      'const gate = require(process.env.TM_TEST_GATE_MODULE);',
      'const config = JSON.parse(process.env.TM_TEST_GATE_CONFIG);',
      'gate.serveGate(config).then(() => {',
      "  process.stdout.write('ready\\n');",
      '}).catch((error) => {',
      "  process.stderr.write(`${error && error.code ? error.code : 'GATE_FAILURE'}\\n`);",
      '  process.exitCode = 1;',
      '});'
    ].join('\n'), { mode: 0o600, flag: 'wx' });
  }
  return spawn(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: {
      ...process.env,
      TM_TEST_GATE_MODULE: modulePath,
      TM_TEST_GATE_CONFIG: JSON.stringify(fixture.config),
      TM_REPLAY_MODE: 'serve',
      TM_REPLAY_SOURCE_SHA256: fixture.config.sourceDigest,
      TM_REPLAY_RUN_ID: 'release-run-1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function waitForChildOutput(child, pattern, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error(
      `Timed out waiting for child output: stdout=${stdout} stderr=${stderr}`
    )), timeout);
    const onStdout = (chunk) => {
      stdout += chunk.toString('utf8');
      if (pattern.test(stdout)) finish();
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code, signal) => finish(new Error(
      `Child exited before expected output: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`
    ));
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    }
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForChildExit(child, timeout = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for child exit')), timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function collectChildResult(child, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(
      `Timed out waiting for child exit: stdout=${stdout} stderr=${stderr}`
    )), timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('cleanup requires the transient unit to stop a live serving helper and never signals it', { skip: linuxReplayProofSkip }, async () => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(
      '^cleanup requires the transient unit to stop a live serving helper and never signals it$'
    );
    return;
  }
  const fixture = makeGateFixture();
  const helper = spawnServingHelper(fixture);
  try {
    await waitForChildOutput(helper, /ready\n/);

    assert.throws(
      () => gate.cleanupGate(fixture.config),
      (error) => error instanceof gate.GateError && error.code === 'HELPER_STILL_RUNNING'
    );
    assert.equal(helper.exitCode, null);
    assert.equal(helper.signalCode, null);
    assert.equal(fs.existsSync(fixture.config.pidPath), true);
    assert.equal(fs.existsSync(fixture.config.socketPath), true);

    helper.kill('SIGTERM');
    await waitForChildExit(helper);
    assert.equal(gate.cleanupGate(fixture.config).ok, true);
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) {
      helper.kill('SIGKILL');
      await waitForChildExit(helper).catch(() => {});
    }
    fixture.dispose();
  }
});

test('cleanup rejects a live unowned PID without signalling that process', { skip: linuxReplayProofSkip }, async () => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl('^cleanup rejects a live unowned PID without signalling that process$');
    return;
  }
  const fixture = makeGateFixture();
  const sentinelPath = path.join(path.dirname(fixture.config.root), 'unrelated-process.js');
  fs.writeFileSync(sentinelPath, [
    "'use strict';",
    "process.stdout.write('ready\\n');",
    'setInterval(() => {}, 1000);'
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  const sentinel = spawn(process.execPath, [sentinelPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForChildOutput(sentinel, /ready\n/);
    writePrivate(fixture.config.pidPath, `${JSON.stringify({
      schema_version: 1,
      source_digest: fixture.config.sourceDigest,
      run_digest: fixture.config.runDigest,
      pid: sentinel.pid,
      boot_id_digest: '1'.repeat(64),
      process_start_ticks: '1',
      executable_digest: '2'.repeat(64),
      script_digest: '3'.repeat(64)
    })}\n`);

    assert.throws(
      () => gate.cleanupGate(fixture.config),
      (error) => error instanceof gate.GateError && error.code === 'PID_NOT_OWNED'
    );
    assert.equal(sentinel.exitCode, null);
    assert.equal(sentinel.signalCode, null);
    assert.equal(fs.existsSync(fixture.config.pidPath), true);

    sentinel.kill('SIGTERM');
    await waitForChildExit(sentinel);
    assert.equal(gate.cleanupGate(fixture.config).ok, true);
  } finally {
    if (sentinel.exitCode === null && sentinel.signalCode === null) {
      sentinel.kill('SIGKILL');
      await waitForChildExit(sentinel).catch(() => {});
    }
    fixture.dispose();
  }
});

test('abrupt helper crash during an in-flight candidate response remains claimed after restart', { skip: linuxReplayProofSkip }, async () => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(
      '^abrupt helper crash during an in-flight candidate response remains claimed after restart$',
      90_000
    );
    return;
  }
  const fixture = makeGateFixture();
  let helper;
  let restart;
  let candidate;
  let requestAttempt;
  let releaseInFlight;
  const inFlight = new Promise((resolve) => {
    releaseInFlight = resolve;
  });
  let candidateRequests = 0;
  try {
    candidate = http.createServer((request, response) => {
      candidateRequests += 1;
      request.resume();
      request.once('end', () => {
        response.writeHead(200, { 'content-length': '64' });
        response.write('partial-candidate-response', releaseInFlight);
      });
    });
    const address = await listen(candidate, { host: '127.0.0.1', port: 0 });
    fixture.config.candidatePort = address.port;
    helper = spawnServingHelper(fixture);
    await waitForChildOutput(helper, /ready\n/);

    requestAttempt = unixRequest(fixture.config.socketPath, rawRequest());
    await Promise.race([
      inFlight,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Candidate response never became in-flight')),
        5000
      ))
    ]);
    assert.equal(candidateRequests, 1);

    helper.kill('SIGKILL');
    await waitForChildExit(helper);
    await requestAttempt;
    assert.equal(fs.existsSync(fixture.config.claimedPath), true);
    assert.equal(fs.existsSync(fixture.config.pendingPath), false);

    restart = spawnServingHelper(fixture);
    const restartResult = await collectChildResult(restart);
    assert.equal(restartResult.code, 1, restartResult.stderr || restartResult.stdout);
    assert.equal(restartResult.signal, null);
    assert.match(restartResult.stderr, /ALREADY_CLAIMED/);
    assert.equal(candidateRequests, 1);
    assert.match(gate.validateGateState(fixture.config), /^claimed/);
    assert.equal(gate.cleanupGate(fixture.config).ok, true);
  } finally {
    for (const child of [helper, restart]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child).catch(() => {});
      }
    }
    if (requestAttempt) await requestAttempt.catch(() => {});
    if (candidate) await close(candidate);
    fixture.dispose();
  }
});

test('Unix socket gate permits one concurrent claimant and a second request never reaches candidate', { skip: linuxReplayProofSkip }, async () => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(
      '^Unix socket gate permits one concurrent claimant and a second request never reaches candidate$'
    );
    return;
  }
  const fixture = makeGateFixture();
  let candidateRequests = 0;
  const candidate = http.createServer((request, response) => {
    candidateRequests += 1;
    request.resume();
    request.on('end', () => response.end('candidate-ok'));
  });
  const address = await listen(candidate, { host: '127.0.0.1', port: 0 });
  fixture.config.candidatePort = address.port;
  let runtime;
  try {
    const stagedRequest = gate.parseReplayRequest(rawRequest(), requestPolicy);
    gate.writeAtomicPrivate(fixture.config.claimStagePath, {
      schema_version: 1,
      source_digest: fixture.config.sourceDigest,
      run_digest: fixture.config.runDigest,
      request_digest: stagedRequest.requestDigest,
      path_digest: stagedRequest.pathDigest,
      body_digest: stagedRequest.bodyDigest,
      expected_claim_digest: fixture.config.expectedClaimDigest
    }, fixture.config);
    assert.equal(gate.validateGateState(fixture.config), 'armed-staged');
    runtime = await gate.serveGate(fixture.config, { writePid: false });
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => unixRequest(fixture.config.socketPath, rawRequest()))
    );
    assert.equal(candidateRequests, 1);
    assert.equal(attempts.filter((attempt) => / 200 /.test(attempt.bytes.toString('latin1'))).length, 1);

    await unixRequest(fixture.config.socketPath, rawRequest()).catch(() => null);
    assert.equal(candidateRequests, 1);
    await runtime.close();
    runtime = null;
    const cleanup = gate.cleanupGate(fixture.config);
    assert.equal(cleanup.ok, true);
    assert.equal(fs.existsSync(fixture.config.socketPath), false);
    assert.equal(fs.existsSync(fixture.config.pendingPath), false);
    assert.equal(fs.existsSync(fixture.config.expectedHeaderPath), false);
    assert.equal(fs.existsSync(fixture.config.nginxBypassPath), false);
    assert.equal(fs.existsSync(fixture.config.claimedPath), true);
    assert.equal(fs.existsSync(fixture.config.resultPath), true);
  } finally {
    if (runtime) await runtime.close();
    await close(candidate);
    fixture.dispose();
  }
});

test('release gate source contract pins secure modes, exclusive claim syscalls and Unix-only listening', () => {
  assert.deepEqual(gate.FILE_MODES, {
    parent: 0o710,
    socket: 0o660,
    privateFile: 0o600,
    nginxBypass: 0o640
  });
  const sourcePath = path.join(__dirname, '..', 'scripts', 'release_replay_gate.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.match(source, /fs\.constants\.O_CREAT\s*\|[\s\S]*fs\.constants\.O_EXCL\s*\|[\s\S]*fs\.constants\.O_NOFOLLOW/);
  assert.match(source, /fs\.fsyncSync\(descriptor\)/);
  assert.match(source, /server\.listen\(config\.socketPath/);
  assert.doesNotMatch(source, /server\.listen\([^\r\n]*candidatePort/);
  assert.doesNotMatch(source, /net\.createServer\([\s\S]{0,200}\.listen\([^\r\n]*(?:127\.0\.0\.1|candidatePort)/);
});

test('CLI rejects argv configuration without echoing the supplied value', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'release_replay_gate.js');
  const secret = 'must-not-appear-in-output';
  const result = spawnSync(process.execPath, [scriptPath, `--claim=${secret}`], {
    cwd: path.join(__dirname, '..'),
    env: {},
    encoding: 'utf8',
    timeout: 5000
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes(secret), false);
  assert.deepEqual(JSON.parse(result.stderr.trim()), {
    ok: false,
    code: 'ARGV_FORBIDDEN'
  });
});
