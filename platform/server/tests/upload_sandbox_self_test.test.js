'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runnerPath = path.join(
  __dirname,
  '..',
  'scripts',
  'upload_sandbox_self_test.js'
);

assert.ok(fs.existsSync(runnerPath), 'production upload sandbox self-test runner is required');

const {
  PRESSURE_ERRNOS,
  REQUIRED_SELF_TESTS,
  assertCompleteSelfTestResult,
  containsNormalizedMarker,
  composeRawSelfTestObservations,
  composeSelfTestResult,
  createParserAcceptanceFixtures,
  createSelfTestSystemdController,
  executeProductionSelfTests,
  normalizeSystemdProperties,
  parseDeclaredSyscallDenyTokens,
  runtimeSourceArtifactPath,
  runCli,
  runDiagnosticCli,
  validateAggregateEvidence,
  validateParserAcceptanceEvidence,
  validatePressureEvidence,
  validateResultMetadataEvidence,
  validateSelfTestManifest
} = require(runnerPath);

test('release manifest accepts the pinned systemd template artifact and rejects unsafe names', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'systemd', 'turingmarket-parser.manifest.json'),
    'utf8'
  ));

  assert.strictEqual(validateSelfTestManifest(manifest), manifest);
  assert.throws(
    () => validateSelfTestManifest({
      ...manifest,
      artifacts: {
        ...manifest.artifacts,
        'systemd/turingmarket-parser@.service:unsafe': 'a'.repeat(64)
      }
    }),
    /parser runtime manifest is invalid/
  );
});

test('systemd 259 slice evidence accepts the removed CPUAccounting property', () => {
  assert.deepEqual(
    normalizeSystemdProperties(
      'turingmarket-parser.slice',
      {
        FragmentPath: '/etc/systemd/system/turingmarket-parser.slice',
        MemoryAccounting: 'yes',
        TasksAccounting: 'yes'
      },
      {
        FragmentPath: '/etc/systemd/system/turingmarket-parser.slice',
        MemoryAccounting: 'yes',
        CPUAccounting: 'yes',
        TasksAccounting: 'yes'
      }
    ),
    {
      FragmentPath: '/etc/systemd/system/turingmarket-parser.slice',
      MemoryAccounting: 'yes',
      CPUAccounting: 'yes',
      TasksAccounting: 'yes'
    }
  );
});

const EXPECTED_DENY_TOKENS = Object.freeze([
  '@mount',
  'accept', 'accept4', 'bind', 'connect', 'getpeername', 'getsockname',
  'getsockopt', 'listen', 'recv', 'recvfrom', 'recvmmsg', 'recvmmsg_time64',
  'recvmsg', 'send', 'sendmmsg', 'sendmsg', 'sendto', 'setsockopt', 'socket',
  'socketcall', '@aio', 'io_uring_setup', 'io_uring_enter', 'io_uring_register',
  '@chown', '@privileged', '@raw-io', '@reboot', '@swap', '@resources',
  '@obsolete', '@debug', '@clock', 'chmod', 'fchmod', 'fchmodat', 'fchmodat2',
  'setxattr', 'lsetxattr', 'fsetxattr', 'removexattr', 'lremovexattr',
  'fremovexattr', 'utime', 'utimes', 'futimesat', 'utimensat'
]);

const SOCKET_OPERATIONS = Object.freeze([
  'filesystem_af_unix_bind',
  'abstract_af_unix_connect',
  'journald_dev_log_send',
  'journald_native_send',
  'journald_stdout_send',
  'syslog_dev_log_send',
  'inet4_tcp_connect',
  'inet4_udp_connect',
  'inet6_tcp_connect'
]);
const AIO_OPERATIONS = Object.freeze([
  'io_uring_setup_socket_path',
  'io_uring_enter_socket_path',
  'io_uring_register_socket_path'
]);
const PID_OPERATIONS = Object.freeze([
  'peer_proc_visibility',
  'peer_fd_directory_visibility',
  'peer_fd_read_open',
  'peer_fd_write_open'
]);

function writableEvidence() {
  return {
    version: 1,
    contract: 'tm-parser-writable-filesystem-v1',
    socket_contract: 'tm-parser-no-sockets-v1',
    mount_info_sha256: 'a'.repeat(64),
    allowed_writable_paths: ['/scratch', '/output/result.json'],
    denied_write_paths: [
      '/dev',
      '/dev/hugepages',
      '/dev/mqueue',
      '/dev/pts',
      '/dev/shm',
      '/tmp',
      '/var/tmp'
    ],
    unexpected_writable_paths: [],
    audited_rw_mounts: 2,
    host_log_socket_paths: [
      '/dev/log',
      '/run/systemd/journal/dev-log',
      '/run/systemd/journal/socket',
      '/run/systemd/journal/stdout'
    ],
    present_host_log_socket_paths: [],
    host_log_socket_mounts: [],
    socket_denial_evidence: SOCKET_OPERATIONS.map((operation) => ({
      operation,
      errno: 'EPERM'
    })),
    aio_denial_evidence: AIO_OPERATIONS.map((operation) => ({
      operation,
      errno: 'EPERM'
    })),
    pid_namespace: {
      contract: 'tm-parser-private-pids-v1',
      self_pid: 1,
      visible_pids: [1]
    }
  };
}

function membership(index, mainPid) {
  const id = String(index).repeat(32);
  const sliceControlGroup = '/turingmarket.slice/turingmarket-parser.slice';
  const controlGroup = `${sliceControlGroup}/turingmarket-parser@${id}.service`;
  return {
    unit_name: `turingmarket-parser@${id}.service`,
    main_pid: mainPid,
    slice: 'turingmarket-parser.slice',
    control_group: controlGroup,
    proc_control_group: controlGroup,
    cgroup_exists: true,
    cgroup_procs: [mainPid],
    host_pid_changed: false
  };
}

function pidProof(peerPid) {
  return {
    contract: 'tm-parser-sibling-proc-fd-denial-v1',
    peer_pid: peerPid,
    self_pid: 1,
    visible_pids: [1],
    evidence: PID_OPERATIONS.map((operation) => ({ operation, errno: 'ENOENT' }))
  };
}

function pressureEvidence(contract, errno = 'ENOSPC') {
  return {
    contract,
    denied: true,
    errno,
    limit_bytes: 10 * 1024 * 1024,
    attempted_bytes: 11 * 1024 * 1024
  };
}

function completeEvidence() {
  const memberships = [membership(1, 4101), membership(2, 4102)];
  return {
    manifest_verified: true,
    installed_runtime_verified: true,
    systemd_service_verified: true,
    systemd_slice_verified: true,
    identity: {
      user: 'turingmarket-parser',
      group: 'turingmarket-parser',
      home: '/nonexistent',
      shell: '/usr/sbin/nologin',
      locked: true,
      supplementary_groups: [],
      uid: 64123,
      gid: 64123
    },
    expected_identity: {
      user: 'turingmarket-parser',
      group: 'turingmarket-parser',
      home: '/nonexistent',
      shell: '/usr/sbin/nologin',
      locked: true,
      supplementary_groups: []
    },
    writable: writableEvidence(),
    pid_proofs: [pidProof(4102), pidProof(4101)],
    aggregate: {
      slice_properties_verified: true,
      slice_control_group: '/turingmarket.slice/turingmarket-parser.slice',
      memberships
    },
    pressure: {
      scratch: pressureEvidence('scratch-pressure-v1'),
      output: pressureEvidence('output-pressure-v1', 'EFBIG')
    },
    parser_acceptance: [
      {
        format: 'xlsx', filename: 'parser-self-test.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        parser: 'xlsx-openxml', marker: 'TM_XLSX_MARKER_604', marker_found: true,
        ocr_used: false
      },
      {
        format: 'pptx', filename: 'parser-self-test.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        parser: 'pptx-openxml', marker: 'TM_PPTX_MARKER_604', marker_found: true,
        ocr_used: false
      },
      {
        format: 'bmp', filename: 'parser-self-test.bmp', mime: 'image/bmp',
        parser: 'local-rapidocr', marker: 'OCR 123', marker_found: true,
        ocr_used: true
      }
    ],
    syscall_policy: {
      contract: 'tm-parser-syscall-deny-v1',
      declared_deny_tokens: [...EXPECTED_DENY_TOKENS],
      verified_deny_tokens: [...EXPECTED_DENY_TOKENS],
      representative_denials: [
        { operation: 'filesystem_af_unix_bind', token: 'socket', errno: 'EPERM' },
        { operation: 'inet4_tcp_connect', token: 'connect', errno: 'EPERM' },
        { operation: 'io_uring_setup_socket_path', token: 'io_uring_setup', errno: 'EPERM' }
      ]
    },
    result_metadata_checks: [true, true, true, true, true]
  };
}

function rawObservationInputs(overrides = {}) {
  return {
    manifestSha256: 'a'.repeat(64),
    runtimeTree: {
      format: 'tm-parser-runtime-tree-v1',
      sha256: 'b'.repeat(64),
      files: 4,
      directories: 2,
      bytes: 100
    },
    effectiveProperties: {
      'turingmarket-parser@.service': { User: 'turingmarket-parser' },
      'turingmarket-parser.slice': { MemoryAccounting: 'yes' }
    },
    evidence: completeEvidence(),
    ...overrides
  };
}

test('minimal parser fixtures are real XLSX, PPTX, and raster payloads with fixed markers', () => {
  const fixtures = createParserAcceptanceFixtures();
  assert.deepEqual(fixtures.map(({ format, filename, marker }) => ({ format, filename, marker })), [
    { format: 'xlsx', filename: 'parser-self-test.xlsx', marker: 'TM_XLSX_MARKER_604' },
    { format: 'pptx', filename: 'parser-self-test.pptx', marker: 'TM_PPTX_MARKER_604' },
    { format: 'bmp', filename: 'parser-self-test.bmp', marker: 'OCR 123' }
  ]);
  assert.equal(fixtures[0].buffer.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(fixtures[1].buffer.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(fixtures[2].buffer.subarray(0, 2).toString('ascii'), 'BM');
  assert.equal(fixtures[2].buffer.readUInt32LE(30), 0, 'BMP fixture must be uncompressed');
  assert.ok(fixtures.every((fixture) => fixture.buffer.length > 100));
});

test('parser acceptance evidence requires actual format parsers and OCR inference marker matches', () => {
  const evidence = completeEvidence().parser_acceptance;
  assert.equal(validateParserAcceptanceEvidence(evidence), true);
  assert.equal(validateParserAcceptanceEvidence(evidence.map((item) => (
    item.format === 'xlsx' ? { ...item, marker_found: false } : item
  ))), false);
  assert.equal(validateParserAcceptanceEvidence(evidence.map((item) => (
    item.format === 'bmp' ? { ...item, parser: 'image-ocr', ocr_used: false } : item
  ))), false);
});

test('parser acceptance treats OCR line wrapping as equivalent whitespace', () => {
  assert.equal(
    containsNormalizedMarker && containsNormalizedMarker('OCR\n123', 'OCR 123'),
    true
  );
});

test('manifest syscall policy accounts for every declared deny token and rejects omissions', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'systemd', 'turingmarket-parser.manifest.json'),
    'utf8'
  ));
  const filter = manifest.effective_properties['turingmarket-parser@.service'].SystemCallFilter;
  assert.deepEqual(parseDeclaredSyscallDenyTokens(filter), EXPECTED_DENY_TOKENS);

  const evidence = completeEvidence();
  evidence.syscall_policy.verified_deny_tokens.pop();
  const result = composeSelfTestResult(evidence);
  assert.equal(result.syscall_denial, false);
});

test('exact concrete evidence composes the required all-true result', () => {
  const result = composeSelfTestResult(completeEvidence());
  assert.deepEqual(Object.keys(result), REQUIRED_SELF_TESTS);
  assert.ok(REQUIRED_SELF_TESTS.every((name) => result[name] === true));
  assert.strictEqual(assertCompleteSelfTestResult(result), result);
});

test('self-test emits canonical raw observations instead of an authorizing boolean projection', () => {
  assert.equal(typeof composeRawSelfTestObservations, 'function');
  const input = rawObservationInputs();
  const raw = composeRawSelfTestObservations(input);
  assert.deepEqual(Object.keys(raw), [
    'format', 'manifest_sha256', 'runtime_tree', 'effective_properties',
    'parser_acceptance', 'self_tests'
  ]);
  assert.equal(raw.format, 'tm-parser-self-test-observations-v1');
  assert.equal(raw.manifest_sha256, input.manifestSha256);
  assert.deepEqual(raw.runtime_tree, input.runtimeTree);
  assert.deepEqual(raw.effective_properties, input.effectiveProperties);
  assert.deepEqual(raw.parser_acceptance, [
    {
      format: 'xlsx', parser: 'xlsx-openxml', marker: 'TM_XLSX_MARKER_604',
      marker_found: true, ocr_used: false
    },
    {
      format: 'pptx', parser: 'pptx-openxml', marker: 'TM_PPTX_MARKER_604',
      marker_found: true, ocr_used: false
    },
    {
      format: 'bmp', parser: 'local-rapidocr', marker: 'OCR 123',
      marker_found: true, ocr_used: true
    }
  ]);
  assert.deepEqual(raw.self_tests, composeSelfTestResult(input.evidence));
});

test('raw observations reject malformed identity, policy, parser and self-test evidence', () => {
  const valid = rawObservationInputs();
  const invalidRuntime = { ...valid.runtimeTree, root: '/runtime-root' };
  const invalidPolicy = {
    ...valid.effectiveProperties,
    'attacker.service': { User: 'root' }
  };
  const invalidParserEvidence = completeEvidence();
  invalidParserEvidence.parser_acceptance[0].marker_found = false;
  const incompleteEvidence = completeEvidence();
  delete incompleteEvidence.installed_runtime_verified;

  assert.throws(() => composeRawSelfTestObservations({
    ...valid,
    manifestSha256: 'A'.repeat(64)
  }), /manifest SHA-256/);
  assert.throws(() => composeRawSelfTestObservations({
    ...valid,
    runtimeTree: invalidRuntime
  }), /rootless runtime tree/);
  assert.throws(() => composeRawSelfTestObservations({
    ...valid,
    effectiveProperties: invalidPolicy
  }), /effective properties/);
  assert.throws(() => composeRawSelfTestObservations({
    ...valid,
    evidence: invalidParserEvidence
  }), /parser acceptance/);
  assert.throws(() => composeRawSelfTestObservations({
    ...valid,
    evidence: incompleteEvidence
  }), /self-test evidence is incomplete/);
});

test('incomplete trust evidence cannot compose an all-true result', () => {
  const evidence = completeEvidence();
  delete evidence.installed_runtime_verified;
  const result = composeSelfTestResult(evidence);
  assert.equal(result.identity, false);
  assert.ok(REQUIRED_SELF_TESTS.some((name) => result[name] === false));
  assert.throws(() => assertCompleteSelfTestResult(result), /self-test evidence is incomplete/);
});

test('forged PID and cgroup observations do not satisfy aggregate or sibling proofs', () => {
  const evidence = completeEvidence();
  evidence.aggregate.memberships[0].proc_control_group = '/attacker.slice';
  evidence.pid_proofs[0].evidence.pop();
  const result = composeSelfTestResult(evidence);
  assert.equal(validateAggregateEvidence(evidence.aggregate), false);
  assert.equal(result.pid_namespace_sibling_fd_denial, false);
  assert.equal(result.aggregate_memory_pressure, false);
  assert.equal(result.aggregate_cpu_pressure, false);
  assert.equal(result.aggregate_task_pressure, false);
});

test('PID proofs use namespace-local peer PID when systemd MainPID is a host shim', () => {
  const evidence = completeEvidence();
  evidence.aggregate.memberships[0].host_pid_changed = true;
  evidence.aggregate.memberships[1].host_pid_changed = true;
  evidence.pid_proofs[0].peer_pid = 3001;
  evidence.pid_proofs[1].peer_pid = 3002;
  const result = composeSelfTestResult(evidence);
  assert.equal(result.pid_namespace_sibling_fd_denial, true);
});

test('pressure evidence requires the exact real probe protocol and kernel denial', () => {
  for (const errno of PRESSURE_ERRNOS) {
    assert.equal(validatePressureEvidence(pressureEvidence('scratch-pressure-v1', errno), 'scratch-pressure-v1'), true);
  }
  assert.equal(validatePressureEvidence(pressureEvidence('scratch-pressure-v1', 'LIMIT_ENFORCED'), 'scratch-pressure-v1'), false);
  assert.equal(validatePressureEvidence({
    ...pressureEvidence('scratch-pressure-v1'),
    attempted_bytes: 1
  }, 'scratch-pressure-v1'), false);
  assert.equal(validatePressureEvidence({
    ...pressureEvidence('scratch-pressure-v1'),
    extra: 'forged'
  }, 'scratch-pressure-v1'), false);
});

test('result metadata must retain the staged inode, parser ownership and lifecycle times', () => {
  const expectation = {
    dev: 7,
    ino: 19,
    uid: 64123,
    gid: 64123,
    lifecycle_started_ms: 10_000,
    observed_at_ms: 12_000,
    max_bytes: 1024
  };
  const metadata = {
    isRegular: true,
    dev: 7,
    ino: 19,
    uid: 64123,
    gid: 64123,
    mode: 0o600,
    nlink: 1,
    size: 128,
    mtimeMs: 11_000,
    ctimeMs: 11_000,
    xattrs: []
  };
  assert.equal(validateResultMetadataEvidence(metadata, expectation), true);
  assert.equal(validateResultMetadataEvidence({ ...metadata, ino: 20 }, expectation), false);
  assert.equal(validateResultMetadataEvidence({ ...metadata, mode: 0o640 }, expectation), false);
  assert.equal(validateResultMetadataEvidence({ ...metadata, xattrs: ['user.payload'] }, expectation), false);
});

test('CLI accepts only the trusted Linux root controller with --json and emits exactly one JSON object', async () => {
  const writes = { stdout: [], stderr: [] };
  const expected = composeRawSelfTestObservations(rawObservationInputs());
  const code = await runCli(['--json'], {
    platform: 'linux',
    getuid: () => 0,
    execute: async () => expected,
    writeStdout: (value) => writes.stdout.push(value),
    writeStderr: (value) => writes.stderr.push(value)
  });
  assert.equal(code, 0);
  assert.equal(writes.stderr.length, 0);
  assert.equal(writes.stdout.length, 1);
  assert.deepEqual(JSON.parse(writes.stdout[0]), expected);
  assert.equal(writes.stdout[0].trim().split(/\r?\n/).length, 1);
});

test('CLI rejects a bare all-true boolean projection', async () => {
  const writes = { stdout: [], stderr: [] };
  const code = await runCli(['--json'], {
    platform: 'linux',
    getuid: () => 0,
    execute: async () => composeSelfTestResult(completeEvidence()),
    writeStdout: (value) => writes.stdout.push(value),
    writeStderr: (value) => writes.stderr.push(value)
  });
  assert.equal(code, 1);
  assert.deepEqual(writes.stdout, []);
  assert.deepEqual(writes.stderr, ['upload sandbox self-test failed\n']);
});

test('CLI rejects unknown arguments and unsupported privilege without executing probes', async () => {
  for (const scenario of [
    { argv: ['--json', '--verbose'], platform: 'linux', uid: 0 },
    { argv: ['--json'], platform: 'win32', uid: 0 },
    { argv: ['--json'], platform: 'linux', uid: 64123 }
  ]) {
    let executed = false;
    const writes = { stdout: [], stderr: [] };
    const code = await runCli(scenario.argv, {
      platform: scenario.platform,
      getuid: () => scenario.uid,
      execute: async () => {
        executed = true;
        return composeSelfTestResult(completeEvidence());
      },
      writeStdout: (value) => writes.stdout.push(value),
      writeStderr: (value) => writes.stderr.push(value)
    });
    assert.notEqual(code, 0);
    assert.equal(executed, false);
    assert.deepEqual(writes.stdout, []);
    assert.equal(writes.stderr.length, 1);
  }
});

test('production self-test runs only as the trusted root controller', async () => {
  for (const scenario of [
    { uid: 0, expectedCode: 0, expectedExecutions: 1 },
    { uid: 64123, expectedCode: 65, expectedExecutions: 0 }
  ]) {
    let executions = 0;
    const writes = { stdout: [], stderr: [] };
    const code = await runCli(['--json'], {
      platform: 'linux',
      getuid: () => scenario.uid,
      execute: async () => {
        executions += 1;
        return composeRawSelfTestObservations(rawObservationInputs());
      },
      writeStdout: (value) => writes.stdout.push(value),
      writeStderr: (value) => writes.stderr.push(value)
    });
    assert.equal(code, scenario.expectedCode, `uid ${scenario.uid}`);
    assert.equal(executions, scenario.expectedExecutions, `uid ${scenario.uid}`);
    if (scenario.expectedCode === 0) {
      assert.equal(writes.stdout.length, 1);
      assert.deepEqual(writes.stderr, []);
    } else {
      assert.deepEqual(writes.stdout, []);
      assert.equal(writes.stderr.length, 1);
    }
  }
});

test('CLI failures do not disclose exception content or write partial JSON', async () => {
  const writes = { stdout: [], stderr: [] };
  const code = await runCli(['--json'], {
    platform: 'linux',
    getuid: () => 0,
    execute: async () => {
      throw new Error('secret=/root/private payload=customer-body');
    },
    writeStdout: (value) => writes.stdout.push(value),
    writeStderr: (value) => writes.stderr.push(value)
  });
  assert.equal(code, 1);
  assert.deepEqual(writes.stdout, []);
  assert.deepEqual(writes.stderr, ['upload sandbox self-test failed\n']);
});

test('diagnostic CLI requires an explicit trusted root Linux environment path', async () => {
  const writes = [];
  assert.equal(await runDiagnosticCli(['--diagnose'], {
    platform: 'linux',
    getuid: () => 0,
    execute: async () => composeRawSelfTestObservations(rawObservationInputs()),
    writeStderr: (value) => writes.push(value)
  }), 0);
  assert.deepEqual(writes, []);
  assert.equal(await runDiagnosticCli(['--diagnose'], {
    platform: 'linux',
    getuid: () => 0,
    execute: async () => { throw new Error('diagnostic-stage'); },
    writeStderr: (value) => writes.push(value)
  }), 1);
  assert.match(writes[0], /diagnostic-stage/);
  assert.equal(await runDiagnosticCli(['--diagnose'], {
    platform: 'linux',
    getuid: () => 64123
  }), 65);
  assert.equal(await runDiagnosticCli(['--json'], {
    platform: 'linux',
    getuid: () => 0
  }), 64);
});

test('production runner requests a concrete measured runtime identity', async () => {
  const calls = [];
  const stop = new Error('stop-after-runtime-measurement');
  const runtimeTree = {
    format: 'tm-parser-runtime-tree-v1',
    root: '/var/lib/turingmarket-parser/runtime-root',
    sha256: 'b'.repeat(64),
    files: 4,
    directories: 2,
    bytes: 100
  };
  const sandbox = {
    loadRuntimeManifest() {
      return {
        manifestSha256: 'a'.repeat(64),
        manifest: {
          identity: {},
          effective_properties: {},
          runtime_tree: runtimeTree
        }
      };
    },
    async verifyRuntimeSourceArtifacts() {},
    async verifyInstalledParserArtifacts() {},
    async verifyParserRuntimeTree(root, expected, options) {
      calls.push({ root, expected, options });
      throw stop;
    },
    runCommandNoDisclosure() {}
  };

  await assert.rejects(
    executeProductionSelfTests({ platform: 'linux', getuid: () => 0, sandbox }),
    (error) => error === stop
  );
  assert.equal(stop.selfTestStage, 'observe:runtime-tree');
  assert.deepEqual(calls, [{
    root: runtimeTree.root,
    expected: runtimeTree,
    options: { requireRootOwnership: true }
  }]);
});

test('self-test parser lifecycle stays on the diagnostic command boundary', async () => {
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: args[0] === 'show'
        ? 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nControlGroup=\n'
        : ''
    };
  };
  const controller = createSelfTestSystemdController(runCommand);
  const unit = `turingmarket-parser@${'a'.repeat(32)}.service`;

  await controller.start(unit, { timeoutMs: 7_000 });
  await controller.kill(unit);
  await controller.stop(unit);
  await controller.resetFailed(unit);
  await controller.assertCollected(unit);

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['/usr/bin/systemctl', ['start', unit]],
    ['/usr/bin/systemctl', ['kill', '--kill-who=all', '--signal=KILL', unit]],
    ['/usr/bin/systemctl', ['stop', unit]],
    ['/usr/bin/systemctl', ['reset-failed', unit]],
    ['/usr/bin/systemctl', [
      'show',
      unit,
      '--no-pager',
      '--property=LoadState,ActiveState,SubState,ControlGroup'
    ]]
  ]);
  assert.equal(calls[0].options.timeoutMs, 7_000);
  assert.equal(calls[4].options.captureStdout, true);
});

test('self-test cleanup accepts an already collected loaded template instance', async () => {
  const calls = [];
  const runCommand = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'reset-failed') throw new Error('unit not loaded');
    return {
      stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nControlGroup=\n'
    };
  };
  const controller = createSelfTestSystemdController(runCommand);
  await controller.resetFailed(`turingmarket-parser@${'b'.repeat(32)}.service`);
  assert.deepEqual(calls.map((args) => args[0]), ['reset-failed', 'show']);
});

test('production runner verifies the explicit release manifest against installed runtime sources', async () => {
  const calls = [];
  const stop = new Error('stop-after-verification');
  const sandbox = {
    loadRuntimeManifest(options) {
      calls.push(['load', options]);
      return {
        manifestSha256: 'a'.repeat(64),
        manifest: { identity: {}, effective_properties: {} }
      };
    },
    async verifyRuntimeSourceArtifacts(manifest) {
      calls.push(['runtime', manifest]);
      throw stop;
    },
    runCommandNoDisclosure() {}
  };
  await assert.rejects(
    executeProductionSelfTests({
      platform: 'linux',
      getuid: () => 0,
      sandbox,
      manifestPath: '/release/server/systemd/turingmarket-parser.manifest.json',
      serverRoot: '/release/server'
    }),
    (error) => error === stop
  );
  assert.equal(stop.selfTestStage, 'verify:runtime-source-artifacts');
  assert.deepEqual(calls, [
    ['load', {
      manifestPath: '/release/server/systemd/turingmarket-parser.manifest.json',
      serverRoot: '/release/server'
    }],
    ['runtime', { identity: {}, effective_properties: {} }]
  ]);
});

test('trusted controller maps source-manifest artifacts to their installed runtime locations', () => {
  assert.equal(
    runtimeSourceArtifactPath('parser-runtime/package.json'),
    '/var/lib/turingmarket-parser/runtime-root/opt/turingmarket-parser/app/package.json'
  );
  assert.equal(
    runtimeSourceArtifactPath('parser-runtime/package-lock.json'),
    '/var/lib/turingmarket-parser/runtime-root/opt/turingmarket-parser/app/package-lock.json'
  );
  assert.equal(
    runtimeSourceArtifactPath('scripts/parse_upload_sandbox.sh'),
    '/var/lib/turingmarket-parser/runtime-root/usr/local/libexec/turingmarket/parse_upload_sandbox.sh'
  );
  assert.throws(
    () => runtimeSourceArtifactPath('systemd/turingmarket-parser@.service'),
    /not a runtime payload/i
  );
});

test('runner source has an executable shebang and a non-shell child-process contract', () => {
  const source = fs.readFileSync(runnerPath, 'utf8');
  assert.match(source, /^#!\/usr\/bin\/env node\r?\n'use strict';/);
  assert.doesNotMatch(source, /\bexec(?:File)?Sync\s*\(/);
  assert.doesNotMatch(source, /\bshell\s*:\s*true/);
  assert.doesNotMatch(source, /parserServiceCandidates|loadSandboxApi|require\(candidate\)/);
  assert.match(source, /function createTrustedSelfTestSandbox\(/);
  assert.match(source, /function createTrustedJobController\(/);
  assert.match(source, /require\.main === module/);
});
