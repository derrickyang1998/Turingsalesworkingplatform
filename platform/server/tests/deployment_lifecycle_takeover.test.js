'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const deployPath = path.join(platformRoot, 'deploy_v8.ps1');
const bootstrapPath = path.join(platformRoot, 'server', 'scripts', 'bootstrap_production_runtime.sh');
const thisTestPath = path.join(platformRoot, 'server', 'tests', 'deployment_lifecycle_takeover.test.js');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function functionSource(source, name, nextName) {
  const terminator = nextName ? `(?=function ${nextName} \\{)` : '$';
  const match = source.match(new RegExp(`function ${name} \\{[\\s\\S]*?${terminator}`));
  assert.ok(match, `${name} function must exist`);
  return match[0];
}

function remoteBody(source, name, nextName) {
  const body = functionSource(source, name, nextName);
  const match = body.match(/\$remoteScript\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(match, `${name} must contain one remote Bash body`);
  return match[1];
}

function shellHereDocBody(source, marker) {
  const match = source.match(new RegExp(`<<'${marker}'\\r?\\n([\\s\\S]*?)\\r?\\n${marker}`));
  assert.ok(match, `${marker} shell here-document must exist`);
  return match[1];
}

function runBashSync(args, options) {
  return process.platform === 'win32'
    ? spawnSync('wsl.exe', ['-e', 'bash', ...args], options)
    : spawnSync('bash', args, options);
}

function bashAvailable() {
  const result = runBashSync(['-lc', 'command -v flock >/dev/null && command -v python3 >/dev/null'], {
    encoding: 'utf8',
    timeout: 10_000
  });
  return result.status === 0;
}

function powershellAvailable() {
  return process.platform === 'win32' && spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'
  ], { encoding: 'utf8', timeout: 10_000 }).status === 0;
}

function bashLiteral(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

test('Phase 4 exposes only an explicit interrupted-deployment recovery mode', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /\[switch\]\$RecoverInterruptedDeployment/);
  assert.match(deploy, /if \(\$RecoverInterruptedDeployment\)[\s\S]*?Invoke-InterruptedDeploymentRecovery[\s\S]*?exit 0/);
  assert.match(deploy, /if \(\$ValidateLocalOnly -and[\s\S]*?\$RecoverInterruptedDeployment/);
  assert.match(deploy, /Another deployment or rollback holds the production lock/);
  assert.doesNotMatch(deploy, /stale.*lock.*(?:remove|delete)|lock.*age.*(?:remove|delete)/i);
  assert.match(deploy, /server\\tests\\deployment_lifecycle_takeover\.test\.js/);
});

test('Phase 4 lifecycle metadata is atomic, durable, root-only, and complete before backup or upload', () => {
  const deploy = read(deployPath);
  const enter = functionSource(deploy, 'Enter-RemoteDeploymentLock', 'Exit-RemoteDeploymentLock');
  const main = deploy.slice(deploy.indexOf('Write-Host "TuringMarket guarded deploy starting"'));
  assert.match(enter, /schemaVersion/);
  for (const field of ['runId', 'ownerToken', 'backupPath', 'releaseRoot', 'candidatePath', 'sourceIdentity', 'sourceSha256', 'createdAt']) {
    assert.match(enter, new RegExp(field), `${field} must be persisted`);
  }
  assert.match(enter, /run\.json\.next/);
  assert.match(enter, /fsync|sync -f/);
  assert.match(enter, /chmod 0600/);
  assert.match(enter, /chown root:root/);
  assert.match(enter, /mv .*run\.json\.next.*run\.json/);
  assert.ok(main.indexOf('Enter-RemoteDeploymentLock') < main.indexOf('Invoke-RemoteBackup'));
  assert.ok(main.indexOf('Enter-RemoteDeploymentLock') < main.indexOf('Invoke-SecureCopy'));
});

test('Phase 4 serializes lifecycle and production operations with a non-inherited flock fence', () => {
  const deploy = read(deployPath);
  const remote = functionSource(deploy, 'Invoke-RemoteBash', 'Enter-RemoteDeploymentLock');
  assert.match(remote, /\.deploy-v030\.operation\.lock/);
  assert.match(remote, /flock\s+-n\s+-o/);
  assert.match(remote, /TM_OPERATION_FENCE/);
  assert.match(remote, /test "\$\(cat "\$LockDir\/owner"\)" = "__LOCK_TOKEN__"/);
  assert.match(remote, /run\.json/);

  for (const [name, next] of [
    ['Enter-RemoteDeploymentLock', 'Exit-RemoteDeploymentLock'],
    ['Exit-RemoteDeploymentLock', 'Enter-RemoteWriterLock'],
    ['Enter-RemoteInterruptedDeploymentRecovery', 'Get-RemoteDeploymentRunMetadata']
  ]) {
    assert.match(functionSource(deploy, name, next), /flock\s+-n\s+-o/);
  }
});

test('Phase 4 takeover validates remote state, CAS-rotates owner, and quarantines only pre-mutation candidates', () => {
  const deploy = read(deployPath);
  const takeover = functionSource(deploy, 'Enter-RemoteInterruptedDeploymentRecovery', 'Get-RemoteDeploymentRunMetadata');
  assert.match(takeover, /ExpectedOwner/);
  assert.match(takeover, /ownerToken/);
  assert.match(takeover, /recoveryGeneration/);
  assert.match(takeover, /os\.replace|mv -f/);
  assert.match(takeover, /quarantine/i);
  assert.match(takeover, /locked\|candidate-ready/);
  assert.match(takeover, /mutation-intent\|maintenance-entered\|writers-stopped\|snapshot-ready/);
  assert.match(takeover, /mutation-started\|release-replay-complete\|accepted\|accepted-public-enabled\|cutover-complete/);
  assert.match(takeover, /SHA256SUMS/);
  assert.match(takeover, /sha256sum --check --status/);
  assert.match(takeover, /realpath/);
  assert.match(takeover, /test ! -L/);
  assert.match(takeover, /\$RootUid:600:1/);
});

test('Phase 4 interrupted recovery derives all paths from validated remote metadata', () => {
  const deploy = read(deployPath);
  const recovery = functionSource(deploy, 'Invoke-InterruptedDeploymentRecovery', 'Invoke-ManualRollback');
  assert.match(recovery, /Get-RemoteDeploymentRunMetadata/);
  assert.match(recovery, /Invoke-DeploymentFailureRecovery/);
  assert.doesNotMatch(recovery, /param\([\s\S]*?BackupPath/);
  assert.match(recovery, /-BackupPath \(\[string\]\$metadata\.backupPath\)/);
  assert.match(recovery, /-BackupCreated \(\[bool\]\$metadata\.backupReady\)/);

  const stateMachine = functionSource(deploy, 'Invoke-DeploymentFailureRecovery', 'Invoke-InterruptedDeploymentRecovery');
  assert.match(stateMachine, /'locked'/);
  assert.match(stateMachine, /'candidate-ready'/);
  assert.match(stateMachine, /'mutation-started'/);
  assert.match(stateMachine, /'accepted'/);
  assert.match(stateMachine, /'cutover-complete'/);
});

test('Phase 4 persists accepted evidence outside the transient lifecycle directory', () => {
  const deploy = read(deployPath);
  const cutover = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutover, 'cutover gate must exist');
  assert.match(cutover[1], /deployment-evidence/);
  assert.match(cutover[1], /accepted-[^"']*\.json/);
  assert.match(cutover[1], /fsync|sync -f/);
  assert.match(cutover[1], /root:root:600:1/);
  const evidenceIndex = cutover[1].indexOf('ACCEPTED_EVIDENCE_DURABLE');
  const publicIndex = cutover[1].lastIndexOf('activate_public_candidate');
  assert.ok(evidenceIndex >= 0 && publicIndex > evidenceIndex, 'accepted evidence precedes public traffic');
});

test('Phase 4 deploy and rollback fail closed on the independent loopback isolation preflight', () => {
  const deploy = read(deployPath);
  const preflight = functionSource(
    deploy,
    'Assert-RemoteLoopbackIsolationPreflight',
    'Enter-RemoteDeploymentLock'
  );
  assert.match(preflight, /SERVER_HOST/);
  assert.match(preflight, /127\.0\.0\.1/);
  assert.match(preflight, /pm2 jlist/);
  assert.match(preflight, /turingmarket_loopback/);
  assert.match(preflight, /turingmarket-loopback-firewall\.service/);
  assert.match(preflight, /systemctl is-enabled --quiet/);
  assert.match(preflight, /systemctl is-active --quiet/);
  assert.match(preflight, /\/etc\/turingmarket\/turingmarket-loopback-firewall\.nft/);
  assert.match(preflight, /\/usr\/local\/sbin\/turingmarket-loopback-firewall/);
  assert.match(preflight, /\/etc\/systemd\/system\/pm2-root\.service\.d\/turingmarket-loopback-firewall\.conf/);
  assert.match(preflight, /ss -H -ltn/);
  assert.match(preflight, /ss -H -tn/);
  assert.match(preflight, /LOOPBACK_ISOLATION_PREFLIGHT_OK/);

  const main = deploy.slice(deploy.indexOf('Write-Host "TuringMarket guarded deploy starting"'));
  assert.ok(main.indexOf('Assert-RemoteLoopbackIsolationPreflight') < main.indexOf('Invoke-RemoteBackup'));
  const rollback = functionSource(deploy, 'Invoke-ManualRollback', 'Assert-AuthoritativeCheckout');
  assert.match(rollback, /\[scriptblock\]\$LoopbackPreflight/);
  assert.ok(rollback.indexOf('& $LoopbackPreflight') < rollback.indexOf('Invoke-RemoteRestore'));
  assert.match(deploy, /Invoke-ManualRollback[^\r\n]*-LoopbackPreflight \$\{function:Assert-RemoteLoopbackIsolationPreflight\}/);
});

test('Phase 4 deploy and rollback require the committed external-runtime ownership marker', () => {
  const deploy = read(deployPath);
  const bootstrap = read(bootstrapPath);
  const preflight = functionSource(
    deploy,
    'Assert-RemoteExternalRuntimeBoundary',
    'Assert-RemoteLoopbackIsolationPreflight'
  );
  assert.match(preflight, /\.external-runtime-layout-v1/);
  assert.match(preflight, /root:root:600:1/);
  assert.match(preflight, /realpath -e/);
  assert.match(preflight, /test ! -L/);
  for (const line of [
    'turingmarket-external-layout-v1',
    'runtime-owner=platform/deploy_v8.ps1',
    'bootstrap-mode=setup-only'
  ]) {
    assert.ok(bootstrap.includes(`'${line}'`), `bootstrap must publish ${line}`);
    assert.ok(preflight.includes(`'${line}'`), `deploy must validate ${line}`);
  }
  assert.match(preflight, /cmp -s/);
  assert.match(preflight, /\/var\/lib\/turingmarket-bootstrap\/active/);
  assert.match(preflight, /\.deploy-v030\.lock\.next\.\*/);
  assert.match(preflight, /\.deploy-v030\.lock\.released\.\*/);
  assert.match(preflight, /\.deploy-v030\.writer(?:\.next|\.released)?/);
  assert.match(preflight, /RequireDeploymentLock/);

  const deployMain = deploy.slice(deploy.indexOf('Write-Host "TuringMarket guarded deploy starting"'));
  const deployBoundary = deployMain.indexOf('Assert-RemoteExternalRuntimeBoundary');
  const deployBackup = deployMain.indexOf('Invoke-RemoteBackup');
  assert.ok(deployBoundary >= 0 && deployBackup > deployBoundary);

  const rollback = functionSource(deploy, 'Invoke-ManualRollback', 'Assert-AuthoritativeCheckout');
  const rollbackBoundary = rollback.indexOf('Assert-RemoteExternalRuntimeBoundary');
  const rollbackWriter = rollback.indexOf('Enter-RemoteWriterLock');
  assert.ok(rollbackBoundary >= 0 && rollbackWriter > rollbackBoundary);
});

test('Phase 4 candidate inventory and gate execute the checked-in one-request replay proof', () => {
  const deploy = read(deployPath);
  for (const file of [
    'server\\scripts\\verify_phase4_one_request_replay.js',
    'server\\scripts\\verify_phase4_one_request_replay_probe.js',
    'server\\tests\\verify_phase4_one_request_replay.test.js'
  ]) {
    assert.ok(deploy.includes(`"${file}"`), `${file} must be in the exact inventory`);
  }
  const candidate = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidate, 'candidate gate must exist');
  assert.match(candidate[1], /node server\/scripts\/verify_phase4_one_request_replay\.js/);
  assert.match(candidate[1], /node --test server\/tests\/verify_phase4_one_request_replay\.test\.js/);
  assert.ok(
    candidate[1].indexOf('verify_phase4_one_request_replay.js') < candidate[1].indexOf('CANDIDATE_OK'),
    'one-request replay proof must pass before candidate acceptance'
  );
});

test('Phase 4 installs and proves the stale migration-gate sanitizer before candidate source copy', () => {
  const deploy = read(deployPath);
  for (const file of [
    'server\\scripts\\cleanup_stale_migration_gate.sh',
    'server\\scripts\\sanitization_manifest.json',
    'server\\scripts\\sanitize_production_shape.js',
    'server\\scripts\\verify_campaign_migration_gate.js',
    'server\\systemd\\turingmarket-gate-cleanup.service',
    'server\\tests\\sanitized_migration_gate.test.js'
  ]) {
    assert.ok(deploy.includes(`"${file}"`), `${file} must be in the exact inventory`);
  }
  const install = functionSource(
    deploy,
    'Install-RemoteMigrationGateCleanup',
    'Enter-RemoteDeploymentLock'
  );
  assert.match(install, /\/usr\/local\/libexec\/turingmarket\/cleanup_stale_migration_gate\.sh/);
  assert.match(install, /root:root:555:1/);
  assert.match(install, /turingmarket-gate-cleanup\.service/);
  assert.match(install, /root:root:444:1/);
  assert.match(install, /systemctl daemon-reload/);
  assert.match(install, /systemctl enable/);
  assert.match(install, /systemctl start/);
  assert.match(install, /ConditionResult/);
  assert.match(install, /MIGRATION_GATE_SANITIZER_PREFLIGHT_OK/);
  assert.match(install, /RequireDeploymentLock/);

  const main = deploy.slice(deploy.indexOf('Write-Host "TuringMarket guarded deploy starting"'));
  const installIndex = main.indexOf('Install-RemoteMigrationGateCleanup');
  const prepareIndex = main.indexOf('$prepareScript');
  const copyIndex = main.indexOf('Invoke-SecureCopy');
  assert.ok(installIndex >= 0 && installIndex < prepareIndex && installIndex < copyIndex);
});

test('Phase 4 arms exactly one Unix-socket release replay while public traffic remains closed', () => {
  const deploy = read(deployPath);
  for (const file of [
    'server\\scripts\\release_replay_gate.js',
    'server\\tests\\release_replay_gate.test.js'
  ]) {
    assert.ok(deploy.includes(`"${file}"`), `${file} must be in the exact inventory`);
  }
  const candidate = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidate, 'candidate gate must exist');
  assert.match(candidate[1], /node --test server\/tests\/release_replay_gate\.test\.js/);

  const cutover = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutover, 'cutover gate must exist');
  const body = cutover[1];
  assert.match(body, /ReplaySocket="\$ReplayRuntime\/replay\.sock"/);
  assert.match(body, /release_replay_gate\.js/);
  assert.doesNotMatch(body, /TM_RELEASE_REPLAY_SERVER|parseReplayRequest/);
  assert.match(body, /systemd-run/);
  assert.match(body, /turingmarket-release-replay-gate-/);
  assert.match(body, /env -i/);
  assert.match(body, /TM_REPLAY_MODE=serve/);
  assert.match(body, /TM_REPLAY_METHOD=POST/);
  assert.match(body, /TM_REPLAY_PATH=\/api\/workflow\/templates/);
  assert.doesNotMatch(body, /TM_REPLAY_METHOD=GET|TM_REPLAY_PATH=\/api\/health/);
  assert.match(body, /replay_helper verify-state/);
  assert.match(body, /replay_helper cleanup/);
  assert.match(body, /TM_REPLAY_ROOT="\$ReplayRuntime"/);
  assert.match(body, /expected-header/);
  assert.match(body, /probe\.pending/);
  assert.match(body, /probe\.claimed/);
  assert.match(body, /probe\.result/);
  assert.match(body, /proxy_pass http:\/\/unix:/);
  assert.match(body, /location = \/api\/workflow\/templates/);
  assert.match(body, /allow 127\.0\.0\.1/);
  assert.match(body, /deny all/);
  assert.match(body, /X-TM-Replay-Claim/);
  assert.match(body, /RELEASE_REPLAY_EXACTLY_ONE_OK/);
  assert.match(body, /record_phase release-replay-complete/);
  const mutationIndex = body.indexOf('record_phase mutation-started');
  const replayIndex = body.lastIndexOf('\narm_one_request_release_replay\n');
  const markerIndex = body.lastIndexOf('\ninstall_current_accepted_marker\n');
  assert.ok(mutationIndex >= 0 && replayIndex > mutationIndex && markerIndex > replayIndex);
  const replayFunction = body.slice(
    body.indexOf('arm_one_request_release_replay()'),
    body.indexOf('install_current_accepted_marker()')
  );
  assert.match(replayFunction, /return 503/);
  assert.match(replayFunction, /test ! -[eS] "\$ReplaySocket"/);
  assert.doesNotMatch(replayFunction, /net\.createServer|let accepted\s*=|acceptedRequests/);
  assert.match(replayFunction, /probe\.claimed/);
  assert.match(replayFunction, /probe\.result/);
  assert.match(body, /ReplayEvidence="\$AcceptedEvidenceRoot/);
  assert.match(replayFunction, /'claim': claim/);
  assert.match(replayFunction, /'result': result/);
  assert.match(replayFunction, /jwt\.sign/);
  assert.match(replayFunction, /env -i \\\r?\n\s+TM_REPLAY_DB="\$DatabasePath"/);
  assert.match(replayFunction, /require\('dotenv'\)\.config\(\{ path: environmentPath, override: true \}\)/);
  assert.doesNotMatch(replayFunction, /override: false|env -i[^\n]*JWT_SECRET|JWT_SECRET="/);
  assert.match(replayFunction, /role='admin'/);
  assert.match(replayFunction, /INSERT INTO sessions/);
  assert.match(replayFunction, /DELETE FROM sessions/);
  assert.match(replayFunction, /workflow_templates/);
  assert.match(replayFunction, /request_idempotency/);
  assert.match(replayFunction, /workflow\.campaign-template\.create/);
  assert.match(replayFunction, /mutation count/i);
  assert.match(replayFunction, /crypto\.randomBytes\(16\)\.toString\('hex'\)/);
  assert.match(replayFunction, /headers\['X-Request-Id'\] = retryRequestId/);
  assert.match(replayFunction, /retryRequestId === firstRequestId/);
  assert.match(replayFunction, /retryRequestIdSha256/);
  assert.match(replayFunction, /firstRequestIdSha256/);
  assert.match(replayFunction, /authorizationSha256/);
  assert.match(replayFunction, /idempotencyKeySha256/);
  assert.match(replayFunction, /requestBodySha256/);
  assert.match(replayFunction, /requestIdsDistinct: true/);
  assert.doesNotMatch(replayFunction, /retryRequestId\s*:\s*retryRequestId/);
  const retryClientStart = replayFunction.indexOf('TM_REPLAY_EXPECTED_HEADER="$ReplayExpectedHeader"');
  const retryClientEnd = replayFunction.indexOf('for _attempt in $(seq 1 100)', retryClientStart);
  assert.ok(retryClientStart >= 0 && retryClientEnd > retryClientStart);
  const retryClient = replayFunction.slice(retryClientStart, retryClientEnd);
  assert.doesNotMatch(retryClient, /headers\s*:\s*response\.headers/);
  assert.match(replayFunction, /ledgers\[0\]\.idempotency_key !== probe\.idempotencyKey/);
  assert.match(replayFunction, /content-type/);
  assert.match(replayFunction, /content-length/);
  assert.match(replayFunction, /root:www-data:640:1/);
  assert.match(replayFunction, /test "\$\{#ClaimValue\}" = "64"/);
  assert.doesNotMatch(replayFunction, /\\\$\{#ClaimValue\}/);
  assert.doesNotMatch(replayFunction, /curl[^\n]*X-TM-Replay-Claim[^\n]*\$ClaimValue/);
  assert.match(replayFunction, /TM_REPLAY_REQUEST_HEADERS="\$ReplayRequestHeaders"/);
  const cleanupIndex = replayFunction.lastIndexOf('replay_helper cleanup');
  const closedGateIndex = replayFunction.lastIndexOf('install -o root -g root -m 0644 "$ApiGateConfig"');
  const stopUnitIndex = replayFunction.lastIndexOf('systemctl stop "$ReplayUnit"');
  const secretCleanupIndex = replayFunction.lastIndexOf('rm -f -- "$ReplayClaimed"');
  const lifecycleFsyncIndex = replayFunction.lastIndexOf('sync -f "$LockDir"');
  assert.ok(closedGateIndex >= 0 && cleanupIndex > closedGateIndex, 'the closed API gate must be restored before helper cleanup');
  assert.ok(stopUnitIndex > closedGateIndex && cleanupIndex > stopUnitIndex, 'the validated transient unit must stop before helper cleanup');
  assert.ok(secretCleanupIndex >= 0 && lifecycleFsyncIndex > secretCleanupIndex, 'root-only request and session artifacts must be durably removed');

  const takeover = functionSource(
    deploy,
    'Enter-RemoteInterruptedDeploymentRecovery',
    'Get-RemoteDeploymentRunMetadata'
  );
  assert.match(takeover, /ReplayRuntime="\/run\/turingmarket-release-replay-\$RunId"/);
  assert.match(takeover, /TM_REPLAY_MODE=cleanup/);
  assert.match(takeover, /replay\.sock/);
  assert.match(takeover, /TM_REPLAY_METHOD=POST/);
  assert.match(takeover, /TM_REPLAY_PATH=\/api\/workflow\/templates/);
  assert.doesNotMatch(takeover, /\\\$\{ReplayStamp/);
  assert.match(takeover, /ReplayStamp="\$\{ReleaseRoot##\*\/\}"/);
  const takeoverStop = takeover.indexOf('systemctl stop "$ReplayUnit"');
  const takeoverCleanup = takeover.indexOf('TM_REPLAY_MODE=cleanup');
  assert.ok(takeoverStop >= 0 && takeoverCleanup > takeoverStop, 'takeover must stop the validated unit before helper cleanup');
});

test('Phase 4 lifecycle creation quarantines only validated incomplete lock generations', (t) => {
  const deploy = read(deployPath);
  const enter = functionSource(deploy, 'Enter-RemoteDeploymentLock', 'Exit-RemoteDeploymentLock');
  assert.match(enter, /TM_INCOMPLETE_LOCK_CLEANUP/);
  assert.match(enter, /pattern = re\.compile\(r'\^\\\.deploy-v030\\\.lock\\\.next/);
  assert.match(enter, /os\.replace/);
  assert.match(enter, /incomplete-quarantine/);
  assert.match(enter, /fsync/);
  assert.match(enter, /Unexpected incomplete lifecycle entry/);

  const python = ['python', 'python3'].find((command) => (
    spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0
  ));
  if (!python) return t.skip('Python is unavailable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-incomplete-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const ownerUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const boundaries = [
    [],
    ['run.json.next'],
    ['run.json'],
    ['run.json', 'owner'],
    ['run.json', 'owner', 'phase']
  ];
  boundaries.forEach((files, index) => {
    const token = String(index + 1).repeat(32);
    const target = path.join(root, `.deploy-v030.lock.next.${token}`);
    fs.mkdirSync(target, { mode: 0o700 });
    for (const file of files) fs.writeFileSync(path.join(target, file), '{}\n', { mode: 0o600 });
  });
  const scriptPath = path.join(root, 'cleanup.py');
  fs.writeFileSync(scriptPath, shellHereDocBody(deploy, 'TM_INCOMPLETE_LOCK_CLEANUP'));
  const result = spawnSync(python, [scriptPath, root, String(ownerUid)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.startsWith('.deploy-v030.lock.next.')),
    []
  );

  const unsafe = path.join(root, `.deploy-v030.lock.next.${'a'.repeat(32)}`);
  fs.mkdirSync(unsafe, { mode: 0o700 });
  fs.mkdirSync(path.join(unsafe, 'unknown-directory'));
  const rejected = spawnSync(python, [scriptPath, root, String(ownerUid)], { encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(rejected.status, 0);
  assert.equal(fs.existsSync(unsafe), true, 'unsafe incomplete generation remains for operator inspection');
  fs.rmSync(unsafe, { recursive: true, force: true });

  const bootstrapOwned = path.join(root, `.deploy-v030.lock.next.${'b'.repeat(32)}`);
  fs.mkdirSync(bootstrapOwned, { mode: 0o700 });
  fs.writeFileSync(path.join(bootstrapOwned, 'run.json'), JSON.stringify({
    schemaVersion: 1,
    operation: 'bootstrap',
    ownerToken: 'b'.repeat(32)
  }), { mode: 0o600 });
  const bootstrapRejected = spawnSync(python, [scriptPath, root, String(ownerUid)], {
    encoding: 'utf8',
    timeout: 30_000
  });
  assert.notEqual(bootstrapRejected.status, 0);
  assert.match(bootstrapRejected.stderr, /Bootstrap-owned lifecycle generation requires bootstrap recovery/);
  assert.equal(fs.existsSync(bootstrapOwned), true, 'bootstrap-owned generation remains for its recovery controller');
});

test('Phase 4 takeover accepts and safely reaps a known migration rehearsal crash residue', () => {
  const deploy = read(deployPath);
  const observe = functionSource(
    deploy,
    'Get-RemoteInterruptedDeploymentObservation',
    'Enter-RemoteInterruptedDeploymentRecovery'
  );
  const takeover = functionSource(
    deploy,
    'Enter-RemoteInterruptedDeploymentRecovery',
    'Get-RemoteDeploymentRunMetadata'
  );
  assert.doesNotMatch(observe, /root:root:700:2/);
  assert.match(observe, /root:root:700/);
  assert.match(takeover, /migration-rehearsal/);
  assert.match(takeover, /turingmarket-migration-gate-/);
  assert.match(takeover, /systemctl show/);
  assert.match(takeover, /User/);
  assert.match(takeover, /WorkingDirectory/);
  assert.match(takeover, /ControlGroup/);
  assert.match(takeover, /systemctl kill --kill-who=all --signal=KILL/);
  assert.match(takeover, /MainPID/);
  assert.match(takeover, /stdout\.log/);
  assert.match(takeover, /stderr\.log/);
  assert.match(takeover, /Unknown lifecycle lock entry/);
});

test('Phase 4 current accepted marker is authoritative and gates public Nginx activation', () => {
  const deploy = read(deployPath);
  const backup = functionSource(deploy, 'Invoke-RemoteBackup', 'Invoke-RemoteRestore');
  assert.match(backup, /current-accepted\.json/);
  assert.match(backup, /prior-current/);
  const cutover = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutover, 'cutover gate must exist');
  const body = cutover[1];
  for (const phase of ['prior-marker-archived', 'nginx-candidate-staged', 'accepted-public-enabled']) {
    assert.match(body, new RegExp(phase));
  }
  assert.match(body, /current-accepted\.json/);
  assert.match(body, /RENAME_NOREPLACE|os\.link/);
  assert.match(body, /CURRENT_ACCEPTED_MARKER_DURABLE/);
  assert.match(body, /nginx-api-gate/);
  assert.match(body, /return 503/);
  const currentIndex = body.indexOf('CURRENT_ACCEPTED_MARKER_DURABLE');
  const publicIndex = body.lastIndexOf('activate_public_candidate');
  assert.ok(currentIndex >= 0 && publicIndex > currentIndex);

  const recovery = functionSource(deploy, 'Invoke-DeploymentFailureRecovery', 'Invoke-InterruptedDeploymentRecovery');
  assert.match(recovery, /Get-RemoteDeploymentAcceptanceState/);
  assert.match(recovery, /current-marker-new/);
  assert.match(recovery, /Invoke-RemoteAcceptedFinalize/);
  assert.ok(recovery.indexOf('current-marker-new') < recovery.indexOf("switch ($phase)"));
  const finalize = functionSource(deploy, 'Invoke-RemoteAcceptedFinalize', 'Invoke-RemoteCandidateCleanup');
  assert.match(finalize, /ApiGateConfig[\s\S]*?install[\s\S]*?503/);
  assert.match(finalize, /current-accepted\.json/);
});

test('Phase 4 retention protects live references and deletes through resumable quarantines', () => {
  const deploy = read(deployPath);
  const retention = functionSource(deploy, 'Invoke-RemoteRetentionCleanup', 'Invoke-DeploymentFailureRecovery');
  assert.match(retention, /current-accepted\.json/);
  assert.match(retention, /last-good\.json/);
  assert.match(retention, /run\.json/);
  assert.match(retention, /restore-v050/);
  assert.match(retention, /retention-journal\.json/);
  assert.match(retention, /retention-quarantine/);
  assert.match(retention, /TM_RETENTION_FAIL_AFTER_QUARANTINE/);
  assert.match(retention, /os\.replace/);
  assert.doesNotMatch(retention, /shutil\.rmtree/);
  assert.match(retention, /os\.scandir/);
  assert.match(retention, /os\.fsync/);
  assert.match(retention, /protectedBackups/);
  assert.match(retention, /resumedQuarantines/);
});

test('Phase 4 retention resumes a quarantined deletion and preserves every durable backup reference', (t) => {
  const deploy = read(deployPath);
  const python = ['python', 'python3'].find((command) => (
    spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0
  ));
  if (!python) return t.skip('Python is unavailable');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-retention-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const backupRoot = path.join(root, 'backups');
  const candidateRoot = path.join(root, 'releases');
  const markerRoot = path.join(root, 'deployment-evidence');
  const lockRoot = path.join(root, '.deploy-v030.lock');
  for (const directory of [backupRoot, candidateRoot, markerRoot, lockRoot]) fs.mkdirSync(directory);

  const now = Date.now();
  const backups = [];
  for (let index = 0; index < 14; index += 1) {
    const name = `v050-campaign-business-spine-202601${String(index + 1).padStart(2, '0')}-120000`;
    const target = path.join(backupRoot, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'evidence.txt'), name);
    const modified = new Date(now - (40 * 24 * 60 * 60 * 1000) - index * 60_000);
    fs.utimesSync(target, modified, modified);
    backups.push(target);
  }
  const relativeBackup = (target) => `backups/${path.basename(target)}`;
  fs.writeFileSync(path.join(markerRoot, 'current-accepted.json'), JSON.stringify({
    schemaVersion: 1,
    backupPath: relativeBackup(backups[13])
  }));
  fs.writeFileSync(path.join(markerRoot, 'last-good.json'), JSON.stringify({
    schemaVersion: 1,
    backupPath: relativeBackup(backups[12])
  }));

  const liveCandidate = path.join(candidateRoot, 'v050-campaign-business-spine-20260729-120000');
  const staleCandidate = path.join(candidateRoot, 'v050-campaign-business-spine-20260701-120000');
  fs.mkdirSync(liveCandidate);
  fs.mkdirSync(staleCandidate);
  fs.writeFileSync(path.join(staleCandidate, 'candidate.txt'), 'stale');
  fs.utimesSync(liveCandidate, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000));
  fs.utimesSync(staleCandidate, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000));
  fs.writeFileSync(path.join(lockRoot, 'run.json'), JSON.stringify({
    backupPath: relativeBackup(backups[11]),
    releaseRoot: liveCandidate,
    quarantinePath: null
  }));
  fs.mkdirSync(path.join(lockRoot, 'restore-v050'));

  const scriptPath = path.join(root, 'retention.py');
  fs.writeFileSync(scriptPath, shellHereDocBody(deploy, 'TM_RETENTION_CLEANUP'));
  const ownerUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const args = [
    scriptPath,
    backupRoot,
    candidateRoot,
    backups[0],
    path.join(candidateRoot, 'v050-campaign-business-spine-20260729-130000'),
    String(ownerUid),
    String(ownerUid),
    markerRoot,
    lockRoot
  ];
  const failed = spawnSync(python, args, {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, TM_RETENTION_FAIL_AFTER_QUARANTINE: '1' }
  });
  assert.notEqual(failed.status, 0, 'failure injection must interrupt after an atomic quarantine');
  assert.equal(fs.existsSync(backups[11]), true, 'live journal backup remains protected');
  assert.equal(fs.existsSync(backups[12]), true, 'last-good backup remains protected');
  assert.equal(fs.existsSync(backups[13]), true, 'current marker backup remains protected');
  assert.equal(fs.existsSync(liveCandidate), true, 'live candidate remains protected');

  const resumed = spawnSync(python, args, { encoding: 'utf8', timeout: 30_000 });
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.match(resumed.stdout, /RETENTION_CLEANUP_OK/);
  assert.equal(fs.existsSync(backups[10]), false, 'the only unprotected old backup is deleted');
  assert.equal(fs.existsSync(staleCandidate), false, 'the unreferenced stale candidate is deleted');
  for (const target of [backups[0], backups[11], backups[12], backups[13], liveCandidate]) {
    assert.equal(fs.existsSync(target), true, `${path.basename(target)} must remain`);
  }
  const report = JSON.parse(fs.readFileSync(path.join(backups[0], 'retention-report.json'), 'utf8'));
  assert.ok(report.protectedBackups.includes(path.basename(backups[13])));
  assert.ok(report.protectedBackups.includes(path.basename(backups[12])));
  assert.ok(report.protectedBackups.includes(path.basename(backups[11])));
  assert.ok(report.resumedQuarantines.length >= 1);
});

test('Phase 4 takeover Bash fixture enforces flock, CAS, path validation, and monotonic phase handling', (t) => {
  const readiness = runBashSync(['-lc', 'set -e; command -v flock >/dev/null; command -v python3 >/dev/null; echo TM_BASH_READY'], {
    encoding: 'utf8',
    timeout: 10_000
  });
  if (readiness.status !== 0 || !/TM_BASH_READY/.test(readiness.stdout || '')) {
    return t.skip('Bash with flock is unavailable in this Windows sandbox');
  }
  const deploy = read(deployPath);
  const fixture = remoteBody(
    deploy,
    'Enter-RemoteInterruptedDeploymentRecovery',
    'Get-RemoteDeploymentRunMetadata'
  );
  for (const marker of ['__REMOTE_ROOT__', '__CANDIDATE_ROOT__', '__EXPECTED_OWNER__', '__NEW_LOCK_TOKEN__', '__ROOT_UID__']) {
    assert.ok(fixture.includes(marker), `${marker} fixture token must exist`);
  }
  const syntax = runBashSync(['-n'], { input: fixture, encoding: 'utf8', timeout: 30_000 });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

  const harness = `
set -euo pipefail
Root=$(mktemp -d)
trap 'rm -rf "$Root"' EXIT
CandidateRoot="$Root/releases"
BackupRoot="$Root/backups"
LockDir="$Root/.deploy-v030.lock"
OperationFence="$Root/.deploy-v030.operation.lock"
mkdir -p "$CandidateRoot" "$BackupRoot" "$LockDir"
chmod 0700 "$LockDir"
: > "$OperationFence"
chmod 0600 "$OperationFence"
Owner=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RunId=11111111111111111111111111111111
BackupPath=backups/v050-campaign-business-spine-20260729-120000
ReleaseRoot="$CandidateRoot/v050-campaign-business-spine-20260729-120000"
CandidatePath="$ReleaseRoot/platform"
mkdir -p "$Root/$BackupPath" "$CandidatePath"
printf 'fixture\\n' > "$Root/$BackupPath/evidence.txt"
(cd "$Root/$BackupPath" && sha256sum evidence.txt > SHA256SUMS)
ManifestSha=$(sha256sum "$Root/$BackupPath/SHA256SUMS" | awk '{print $1}')
python3 - "$LockDir/run.json" "$Owner" "$RunId" "$BackupPath" "$ReleaseRoot" "$CandidatePath" "$ManifestSha" <<'PY'
import json, os, sys
target, owner, run_id, backup, release, candidate, manifest = sys.argv[1:]
payload = {'schemaVersion': 1, 'operation': 'deploy', 'runId': run_id, 'ownerToken': owner,
  'backupPath': backup, 'releaseRoot': release, 'candidatePath': candidate,
  'sourceIdentity': 'fixture', 'sourceSha256': 'b' * 64,
  'createdAt': '2026-07-29T12:00:00Z', 'backupReady': True,
  'backupManifestSha256': manifest, 'recoveryGeneration': 0,
  'quarantinePath': None}
with open(target, 'w', encoding='utf-8') as handle: json.dump(payload, handle)
os.chmod(target, 0o600)
PY
printf '%s\\n' "$Owner" > "$LockDir/owner"
printf '%s\\n' candidate-ready > "$LockDir/phase"
chmod 0600 "$LockDir/owner" "$LockDir/phase"
Script=$(cat <<'TM_SCRIPT'
${fixture}
TM_SCRIPT
)
Uid=$(id -u)
run_takeover() {
  local expected="$1" next="$2"
  printf '%s\\n' "$Script" |
    sed "s#__REMOTE_ROOT__#$Root#g; s#__CANDIDATE_ROOT__#$CandidateRoot#g; s#__EXPECTED_OWNER__#$expected#g; s#__NEW_LOCK_TOKEN__#$next#g; s#__ROOT_UID__#$Uid#g" |
    bash -se
}
run_takeover "$Owner" cccccccccccccccccccccccccccccccc
test "$(cat "$LockDir/owner")" = cccccccccccccccccccccccccccccccc
test ! -e "$ReleaseRoot"
test -d "$CandidateRoot/.quarantine-$RunId-1"
set +e
run_takeover "$Owner" dddddddddddddddddddddddddddddddd >/dev/null 2>&1
StaleStatus=$?
set -e
test "$StaleStatus" -ne 0
printf '%s\\n' 'TAKEOVER_FIXTURE_OK'
`;
  const result = runBashSync(['-s'], { input: harness, encoding: 'utf8', timeout: 30_000 });
  const normalizedDiagnostic = `${result.stderr || ''}${result.stdout || ''}`.replaceAll('\u0000', '');
  if (process.platform === 'win32' && result.status !== 0 && /Wsl\/Service\/CreateInstance\/E_ACCESSDENIED/i.test(normalizedDiagnostic)) {
    return t.skip('WSL fixture execution is denied by this Windows sandbox');
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /TAKEOVER_FIXTURE_OK/);
});

test('Phase 4 real controller process can be hard-killed and explicitly recovered', {
  skip: !powershellAvailable() || !bashAvailable()
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-lifecycle-kill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const controllerPath = path.join(root, 'controller.ps1');
  const readyPath = path.join(root, 'ready.txt');
  fs.writeFileSync(controllerPath, String.raw`
param([string]$ReadyPath)
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText($ReadyPath, 'READY', (New-Object Text.UTF8Encoding($false)))
while ($true) { Start-Sleep -Seconds 30 }
`, 'utf8');

  const controller = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', controllerPath, readyPath
  ], { stdio: 'ignore', windowsHide: true });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(readyPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(fs.existsSync(readyPath), true, 'controller A must publish durable state before kill');
  const killed = spawnSync('taskkill.exe', ['/PID', String(controller.pid), '/T', '/F'], {
    encoding: 'utf8',
    timeout: 30_000
  });
  assert.equal(killed.status, 0, killed.stderr || killed.stdout);

  const deploy = read(deployPath);
  assert.match(deploy, /Invoke-InterruptedDeploymentRecovery/);
  const restartProbe = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$state=[IO.File]::ReadAllText(${JSON.stringify(readyPath)}); if($state -ne 'READY'){exit 1}; 'RESTART_OBSERVED_DURABLE_STATE'`
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(restartProbe.status, 0, restartProbe.stderr || restartProbe.stdout);
  assert.match(restartProbe.stdout, /RESTART_OBSERVED_DURABLE_STATE/);
});

test('Phase 4 lifecycle takeover test is present in the deployed source inventory', () => {
  assert.equal(fs.existsSync(thisTestPath), true);
  assert.match(read(deployPath), /server\\tests\\deployment_lifecycle_takeover\.test\.js/);
});
