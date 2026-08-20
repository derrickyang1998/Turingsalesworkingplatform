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

function runRootBashSync(args, options) {
  return process.platform === 'win32'
    ? spawnSync('wsl.exe', ['-u', 'root', '-e', 'bash', ...args], options)
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
  assert.ok(main.indexOf('Enter-RemoteDeploymentLock') < main.indexOf('Invoke-PinnedDeploymentUpload'));
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

test('Phase 4 takeover validates remote state, CAS-rotates owner, and reclaims only a canonical stale writer', () => {
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
  assert.match(takeover, /WriterDir="\$RemoteRoot\/\.deploy-v030\.writer"/);
  assert.match(takeover, /WriterQuarantine/);
  assert.match(takeover, /Unexpected stale writer lock inventory/);
  assert.ok(
    takeover.indexOf("metadata['ownerToken'] = newOwner") < takeover.indexOf('mv -T "$WriterDir" "$WriterQuarantine"'),
    'the owner CAS must invalidate the prior controller before stale writer reclamation'
  );
});

test('Phase 4 observes every durable cutover phase before interrupted recovery takeover', () => {
  const deploy = read(deployPath);
  const observation = functionSource(
    deploy,
    'Get-RemoteInterruptedDeploymentObservation',
    'Enter-RemoteInterruptedDeploymentRecovery'
  );
  const takeover = functionSource(
    deploy,
    'Enter-RemoteInterruptedDeploymentRecovery',
    'Get-RemoteDeploymentRunMetadata'
  );
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'cutover gate must exist');
  const takeoverCase = takeover.match(/case "\$Phase" in([\s\S]*?)esac/);
  assert.ok(takeoverCase, 'takeover must validate the persisted phase');
  const recordedPhases = Array.from(
    cutoverMatch[1].matchAll(/\brecord_phase\s+([a-z0-9-]+)/g),
    (match) => match[1]
  );
  assert.ok(recordedPhases.length > 0, 'cutover must persist lifecycle phases');
  for (const phase of new Set(recordedPhases)) {
    assert.ok(observation.includes(`'${phase}'`), `${phase} must be accepted by lifecycle observation`);
    assert.match(takeoverCase[1], new RegExp(`(?:^|[|\\s])${phase}(?:[|)\\s])`, 'm'), `${phase} must be accepted by takeover`);
  }
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
  assert.match(preflight, /#!\/bin\/bash -p/);
  assert.doesNotMatch(preflight, /#!\/usr\/bin\/env bash/);
  assert.match(preflight, /ss -H -ltn/);
  assert.match(preflight, /ss -H -tn/);
  assert.match(preflight, /LOOPBACK_ISOLATION_PREFLIGHT_OK/);

  const main = deploy.slice(deploy.indexOf('Write-Host "TuringMarket guarded deploy starting"'));
  assert.ok(main.indexOf('Assert-RemoteLoopbackIsolationPreflight') < main.indexOf('Invoke-RemoteBackup'));
  const rollback = functionSource(deploy, 'Invoke-ManualRollback', 'Assert-AuthoritativeCheckout');
  assert.doesNotMatch(rollback, /\[scriptblock\]/i);
  assert.doesNotMatch(rollback, /&\s*\$[A-Za-z_][A-Za-z0-9_]*/);
  assert.ok(
    rollback.indexOf('Assert-RemoteLoopbackIsolationPreflight') < rollback.indexOf('Invoke-RemoteRestore')
  );
  assert.match(deploy, /Invoke-ManualRollback -BackupPath \$RollbackBackup -RestoreDatabase -ConfirmDataLoss/);
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

test('Phase 4 installs the trusted migration sanitizer only after upload verification and recoverable backup', () => {
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
  const trustedBundleStage = functionSource(
    deploy,
    'Stage-RemoteTrustedProductionSourceBundle',
    'Invoke-RemoteTrustedSourceInputSweep'
  );
  assert.match(trustedBundleStage, /\/usr\/bin\/node "\$TrustedSourceGate" stage/);
  assert.match(trustedBundleStage, /--candidate-root "\$CandidateDir"/);
  assert.match(trustedBundleStage, /--bundle-root "\$TrustedSourceBundle"/);
  assert.match(trustedBundleStage, /ExpectedGateSha256/);
  assert.match(trustedBundleStage, /ExpectedManifestSha256/);
  assert.match(trustedBundleStage, /ExpectedVerifierSha256/);
  assert.match(trustedBundleStage, /root:root:555/);
  assert.match(trustedBundleStage, /RequireDeploymentLock/);
  assert.doesNotMatch(install, /DeploymentPlan|cleanupBase64|unitBase64/);
  assert.match(install, /TrustedSourceBundle="__TRUSTED_SOURCE_BUNDLE__"/);
  assert.match(install, /\$TrustedSourceBundle\/server\/scripts\/cleanup_stale_migration_gate\.sh/);
  assert.match(install, /\$TrustedSourceBundle\/server\/systemd\/turingmarket-gate-cleanup\.service/);
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
  const verifyIndex = main.indexOf('Candidate upload checksum verification failed');
  const trustedBundleIndex = main.indexOf('Stage-RemoteTrustedProductionSourceBundle');
  const backupIndex = main.indexOf('Invoke-RemoteBackup');
  const candidateGateIndex = main.indexOf('$candidateGate');
  assert.ok(
    verifyIndex >= 0 && trustedBundleIndex > verifyIndex && backupIndex > trustedBundleIndex &&
      installIndex > backupIndex && candidateGateIndex > installIndex,
    'upload checksum, trusted bundle staging, and recoverable backup must precede cleanup installation and candidate execution'
  );
});

test('Phase 4 restores the migration cleanup control plane on every rejected or rollback path', () => {
  const deploy = read(deployPath);
  const backup = functionSource(deploy, 'Invoke-RemoteBackup', 'Get-Pm2PersistenceVerifier');
  const restoreControl = functionSource(
    deploy,
    'Restore-RemoteMigrationGateCleanupControl',
    'Get-Pm2PersistenceVerifier'
  );
  const recovery = functionSource(
    deploy,
    'Invoke-DeploymentFailureRecovery',
    'Invoke-InterruptedDeploymentRecovery'
  );
  const rollback = functionSource(deploy, 'Invoke-ManualRollback', 'Assert-AuthoritativeCheckout');

  assert.match(backup, /ControlBackup="\$BackupAbsolute\/control-plane\/migration-gate-cleanup"/);
  assert.match(backup, /state_path = os\.path\.join\(backup_root, 'state\.json'\)/);
  assert.match(backup, /snapshot\('helper', helper_path, 0o555, expected_helper_sha256\)/);
  assert.match(backup, /snapshot\('unit', unit_path, 0o444, expected_unit_sha256\)/);
  assert.match(backup, /f'\{label\}\.bytes'/);
  assert.match(backup, /systemctl is-enabled/);
  assert.match(backup, /canonical-absent-v1/);
  assert.match(backup, /canonical-trusted-enabled-v1/);
  assert.match(backup, /topologySha256/);
  assert.match(backup, /os\.path\.join\(systemd_root, 'multi-user\.target\.wants', unit_name\)/);
  assert.match(backup, /\/etc\/systemd\/system\/turingmarket-gate-cleanup\.service/);
  assert.doesNotMatch(backup, /enabled\|disabled\|static\|indirect\|not-found/);
  assert.match(restoreControl, /TM_MIGRATION_CLEANUP_CONTROL_REPLAY/);
  assert.match(restoreControl, /os\.replace/);
  assert.match(restoreControl, /if not record\['present'\]/);
  assert.match(restoreControl, /os\.unlink/);
  assert.match(restoreControl, /os\.chown/);
  assert.match(restoreControl, /os\.chmod/);
  assert.match(restoreControl, /st_atime_ns/);
  assert.match(restoreControl, /st_mtime_ns/);
  assert.match(restoreControl, /os\.listxattr/);
  assert.match(restoreControl, /00-turingmarket-restore-barrier\.conf/);
  assert.match(restoreControl, /ConditionPathExists=\/var\/lib\/turingmarket\/migration-gate-cleanup-control\/release/);
  assert.match(restoreControl, /JournalRoot="\/var\/lib\/turingmarket\/migration-gate-cleanup-control"/);
  assert.match(restoreControl, /Journal="\$JournalRoot\/restore\.json"/);
  for (const phase of [
    'barrier-armed',
    'quiesced',
    'helper-restored',
    'unit-restored',
    'topology-restored',
    'converged',
    'barrier-cleared'
  ]) {
    assert.match(restoreControl, new RegExp(phase), `${phase} must be a durable replay phase`);
  }
  const barrierIndex = restoreControl.indexOf("persist_phase('barrier-armed')");
  const quiescedIndex = restoreControl.indexOf("persist_phase('quiesced')");
  const helperIndex = restoreControl.indexOf("restore_file('helper'");
  const unitIndex = restoreControl.indexOf("restore_file('unit'");
  const convergedIndex = restoreControl.indexOf("persist_phase('converged')");
  const barrierClearIndex = restoreControl.indexOf("persist_phase('barrier-cleared')");
  assert.ok(barrierIndex >= 0 && quiescedIndex > barrierIndex, 'barrier and journal must be durable before quiescence');
  assert.ok(helperIndex > quiescedIndex && unitIndex > helperIndex, 'both control files restore only after verified quiescence');
  assert.ok(convergedIndex > unitIndex && barrierClearIndex > convergedIndex, 'barrier clears only after exact convergence');
  assert.match(restoreControl, /CONTROL_PLANE_RESTORED/);
  for (const phase of ['locked', 'candidate-ready', 'mutation-intent', 'mutation-started']) {
    const phaseIndex = recovery.indexOf(`'${phase}'`);
    assert.ok(phaseIndex >= 0, `${phase} recovery branch must exist`);
  }
  assert.equal(
    (recovery.match(/Restore-RemoteMigrationGateCleanupControl/g) || []).length,
    2,
    'only non-mutated rejection paths use the standalone control restore'
  );
  for (const [phase, nextPhase] of [
    ['cutover-complete', 'accepted'],
    ['accepted', 'accepted-public-enabled'],
    ['accepted-public-enabled', 'default']
  ]) {
    const startAnchor = `\n        '${phase}' {`;
    const endAnchor = nextPhase === 'default'
      ? '\n        default {'
      : `\n        '${nextPhase}' {`;
    const startIndex = recovery.indexOf(startAnchor);
    const endIndex = recovery.indexOf(endAnchor, startIndex + startAnchor.length);
    assert.ok(startIndex >= 0 && endIndex > startIndex, `${phase} recovery branch must be bounded`);
    const retainedBranch = recovery.slice(startIndex, endIndex);
    assert.doesNotMatch(
      retainedBranch,
      /Restore-RemoteMigrationGateCleanupControl/,
      `${phase} must retain the newly accepted trusted cleanup control`
    );
  }
  assert.match(rollback, /Invoke-RemoteRestore/);
  assert.doesNotMatch(rollback, /Restore-RemoteMigrationGateCleanupControl/);
});

test('Phase 4 rollback keeps public Nginx closed through control convergence in automatic, resume, and manual paths', () => {
  const deploy = read(deployPath);
  const restore = functionSource(deploy, 'Invoke-RemoteRestore', 'Invoke-RemotePreMutationResume');
  const resume = functionSource(deploy, 'Invoke-RemotePreMutationResume', 'Get-RemoteDeploymentAcceptanceState');
  const recovery = functionSource(deploy, 'Invoke-DeploymentFailureRecovery', 'Invoke-InterruptedDeploymentRecovery');
  const manual = functionSource(deploy, 'Invoke-ManualRollback', 'Assert-AuthoritativeCheckout');

  for (const [label, source, publicLink] of [
    ['automatic rollback', restore, 'mv -Tf "$RestorePublicLink" /etc/nginx/sites-enabled/turingmarket'],
    ['pre-mutation resume', resume, 'mv -Tf "$ResumePublicLink" /etc/nginx/sites-enabled/turingmarket']
  ]) {
    const durableMaintenanceIndex = source.indexOf('# PUBLIC_GUARD_DURABLE_MAINTENANCE');
    const closeIndex = source.indexOf('public_release_guard close', durableMaintenanceIndex);
    const guardIndex = source.indexOf('public_release_guard arm');
    const processIndex = source.indexOf('persist_pm2_dump');
    const controlIndex = source.lastIndexOf('\nrestore_migration_gate_cleanup_control\n');
    const publicIndex = source.indexOf(publicLink);
    const exactGateIndex = source.indexOf('run_exact_public_nginx_gate', publicIndex);
    const disarmIndex = source.indexOf('public_release_guard disarm', exactGateIndex);
    assert.ok(
      durableMaintenanceIndex >= 0 && closeIndex > durableMaintenanceIndex && guardIndex > closeIndex,
      `${label} must enter fail-closed maintenance through the trusted guard before arming the watchdog`
    );
    assert.ok(guardIndex >= 0 && processIndex > guardIndex, `${label} must arm the watchdog before application recovery`);
    assert.ok(controlIndex > processIndex && publicIndex > controlIndex, `${label} must converge control before public link activation`);
    assert.ok(exactGateIndex > publicIndex && disarmIndex > exactGateIndex, `${label} must keep the guard through exact public verification`);
  }

  assert.match(
    recovery,
    /Invoke-RemoteRestore -BackupPath \$BackupPath -RestoreDatabase[\s\S]*?break[\s\S]*?Invoke-RemoteCandidateCleanup/,
    'automatic rollback must complete its guarded transaction before candidate cleanup'
  );
  assert.match(
    recovery,
    /Invoke-RemotePreMutationResume -BackupPath \$BackupPath\s+Invoke-RemoteCandidateCleanup/,
    'pre-mutation resume must complete its guarded transaction before candidate cleanup'
  );
  assert.match(manual, /Invoke-RemoteRestore/);
  assert.doesNotMatch(manual, /Restore-RemoteMigrationGateCleanupControl/);
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
  assert.match(replayFunction, /os\.replace\(temporary, target\)/);
  assert.doesNotMatch(replayFunction, /os\.link\(/);
  const currentMarkerFunction = body.slice(
    body.indexOf('install_current_accepted_marker()'),
    body.indexOf('assert_final_acceptance_facts()')
  );
  assert.match(currentMarkerFunction, /os\.replace\(temporary, current\)/);
  assert.doesNotMatch(currentMarkerFunction, /os\.link\(/);
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
  assert.match(takeover, /TrustedSourceBundle="__TRUSTED_SOURCE_BUNDLE__"/);
  assert.match(takeover, /systemctl show "\$MigrationUnit" --property=WorkingDirectory --value\)" = "\$TrustedSourceBundle\/server"/);
  assert.doesNotMatch(takeover, /WorkingDirectory --value\)" = "\$CandidatePathForUnit\/server"/);
  assert.match(takeover, /Replace\('__TRUSTED_SOURCE_BUNDLE__', \$TRUSTED_SOURCE_BUNDLE_REMOTE_PATH\)/);
  assert.match(takeover, /ControlGroup/);
  assert.match(takeover, /systemctl kill --kill-who=all --signal=KILL/);
  assert.match(takeover, /MainPID/);
  assert.match(takeover, /stdout\.log/);
  assert.match(takeover, /stderr\.log/);
  assert.match(takeover, /Unknown lifecycle lock entry/);
});

test('Phase 4 takeover inventory admits only an exact secure public guard transaction lock', (t) => {
  const deploy = read(deployPath);
  const takeover = remoteBody(
    deploy,
    'Enter-RemoteInterruptedDeploymentRecovery',
    'Get-RemoteDeploymentRunMetadata'
  );
  assert.match(takeover, /rootGid = grp\.getgrnam\('root'\)\.gr_gid/);
  assert.match(takeover, /wwwDataGid = grp\.getgrnam\('www-data'\)\.gr_gid/);
  assert.match(takeover, /lockStatus\.st_gid != rootGid/);
  assert.match(takeover, /metadata\.st_gid != wwwDataGid/);
  assert.doesNotMatch(takeover, /expectedGid\s*=/);

  const readiness = runRootBashSync(['-lc', 'test "$(id -u)" = 0 && command -v python3 >/dev/null && getent group www-data >/dev/null'], {
    encoding: 'utf8', timeout: 10_000
  });
  if (readiness.status !== 0) {
    return t.skip('native root Linux with Python and www-data is unavailable');
  }

  const match = takeover.match(/LifecycleResidue="\$\(python3[\s\S]*?<<'PY'\r?\n([\s\S]*?)\r?\nPY\r?\n\)"/);
  assert.ok(match, 'takeover lifecycle inventory Python must exist');
  const inventory = match[1];
  const harness = `
set -euo pipefail
Root="$(mktemp -d)"
LockDir="$Root/lock"
Inventory="$Root/inventory.py"
trap 'rm -rf -- "$Root"' EXIT
cat > "$Inventory" <<'PY'
${inventory}
PY
reset_lock() {
  rm -rf -- "$LockDir"
  mkdir -p "$LockDir"
  chmod 0700 "$LockDir"
  chown 0:0 "$LockDir"
}
run_inventory() {
  python3 "$Inventory" "$LockDir" 0
}
expect_reject() {
  set +e
  run_inventory >"$Root/reject.out" 2>"$Root/reject.err"
  status=$?
  set -e
  test "$status" != 0
}
create_replay_and_lock() {
  order="$1"
  lock_group="$2"
  reset_lock
  if [ "$order" = replay-first ]; then
    install -o root -g www-data -m 0640 /dev/null "$LockDir/nginx-release-replay.conf"
    install -o root -g "$lock_group" -m 0600 /dev/null "$LockDir/public-gate-guard.transaction-lock"
  else
    install -o root -g "$lock_group" -m 0600 /dev/null "$LockDir/public-gate-guard.transaction-lock"
    install -o root -g www-data -m 0640 /dev/null "$LockDir/nginx-release-replay.conf"
  fi
}

reset_lock
install -o root -g root -m 0600 /dev/null "$LockDir/public-gate-guard.transaction-lock"
test "$(run_inventory)" = clean

for order in replay-first lock-first; do
  create_replay_and_lock "$order" root
  test "$(run_inventory)" = clean

  create_replay_and_lock "$order" www-data
  expect_reject
done

reset_lock
printf x > "$Root/target"
chmod 0600 "$Root/target"
ln -s "$Root/target" "$LockDir/public-gate-guard.transaction-lock"
expect_reject

reset_lock
install -o root -g root -m 0600 /dev/null "$Root/target"
ln "$Root/target" "$LockDir/public-gate-guard.transaction-lock"
expect_reject

reset_lock
install -o root -g root -m 0644 /dev/null "$LockDir/public-gate-guard.transaction-lock"
expect_reject

reset_lock
install -o 1 -g 1 -m 0600 /dev/null "$LockDir/public-gate-guard.transaction-lock"
expect_reject

reset_lock
printf x > "$LockDir/public-gate-guard.transaction-lock"
chmod 0600 "$LockDir/public-gate-guard.transaction-lock"
chown 0:0 "$LockDir/public-gate-guard.transaction-lock"
expect_reject

reset_lock
install -o root -g root -m 0600 /dev/null "$LockDir/public-gate-guard.transaction-lock"
python3 -c "import os; os.setxattr('$LockDir/public-gate-guard.transaction-lock', b'user.tm_attack', b'1', follow_symlinks=False)"
expect_reject

reset_lock
install -o root -g root -m 0600 /dev/null "$LockDir/public-gate-guard.transaction-lock.next"
expect_reject

printf '%s\n' TAKEOVER_PUBLIC_GUARD_LOCK_INVENTORY_OK
`;
  const result = runRootBashSync(['-s'], { input: harness, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /TAKEOVER_PUBLIC_GUARD_LOCK_INVENTORY_OK/);
});

test('Phase 4 takeover accepts only the executable public guard family and lifecycle phase matrix', () => {
  const takeover = remoteBody(
    read(deployPath),
    'Enter-RemoteInterruptedDeploymentRecovery',
    'Get-RemoteDeploymentRunMetadata'
  );
  const match = takeover.match(/validate_public_guard_unit_for_phase\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'takeover must define one independently executable family/phase validator');
  const token = '0123456789abcdef0123456789abcdef';
  const otherToken = 'fedcba9876543210fedcba9876543210';
  const allowed = [
    ['locked', 'resume'], ['candidate-ready', 'resume'],
    ['mutation-intent', 'resume'], ['maintenance-entered', 'resume'],
    ['writers-stopped', 'resume'], ['snapshot-ready', 'resume'],
    ['prior-marker-archived', 'resume'], ['nginx-candidate-staged', 'resume'],
    ['mutation-started', 'restore'], ['release-replay-complete', 'restore'],
    ['accepted', 'cutover'], ['accepted', 'finalize'],
    ['accepted-public-enabled', 'cutover'], ['accepted-public-enabled', 'finalize'],
    ['cutover-complete', 'finalize'],
  ];
  const allowedKeys = new Set(allowed.map(([phase, family]) => `${phase}:${family}`));
  const phases = [...new Set(allowed.map(([phase]) => phase))];
  const families = ['cutover', 'restore', 'resume', 'finalize'];
  const calls = [];
  for (const phase of phases) {
    for (const family of families) {
      const expectation = allowedKeys.has(`${phase}:${family}`) ? 'accept' : 'reject';
      const familyToken = family === 'cutover' || family === 'finalize' ? token : otherToken;
      calls.push(`${expectation} ${bashLiteral(phase)} ${bashLiteral(`turingmarket-${family}-public-guard-${familyToken}.service`)}`);
    }
  }
  calls.push(`reject accepted ${bashLiteral(`turingmarket-cutover-public-guard-${otherToken}.service`)}`);
  calls.push(`reject accepted ${bashLiteral(`turingmarket-finalize-public-guard-${otherToken}.service`)}`);
  calls.push(`reject accepted ${bashLiteral('turingmarket-cutover-public-guard-short.service')}`);
  calls.push(`reject accepted ${bashLiteral(`turingmarket-unknown-public-guard-${token}.service`)}`);
  const harness = `
set -euo pipefail
RunId=${bashLiteral(token)}
${match[0]}
accept() { validate_public_guard_unit_for_phase "$1" "$2"; }
reject() { if validate_public_guard_unit_for_phase "$1" "$2"; then exit 1; fi; }
${calls.join('\n')}
printf '%s\n' PUBLIC_GUARD_PHASE_MATRIX_OK
`;
  const result = runBashSync(['-s'], { input: harness, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PUBLIC_GUARD_PHASE_MATRIX_OK/);
});

test('Phase 4 takeover treats only a missing state inode as lock-only recovery', () => {
  const takeover = remoteBody(
    read(deployPath), 'Enter-RemoteInterruptedDeploymentRecovery', 'Get-RemoteDeploymentRunMetadata'
  );
  const validator = takeover.match(/validate_public_guard_unit_for_phase\(\) \{[\s\S]*?\n\}/);
  const drain = takeover.match(/drain_public_guard_unit\(\) \{[\s\S]*?\n\}/);
  const block = takeover.match(/if \[ -e "\$LockDir\/public-gate-guard\.transaction-lock" \]; then\n([\s\S]*?)\nfi\n\nfor CandidateUnitKind/);
  assert.ok(validator && drain && block, 'takeover guard block must be independently executable');
  const executableBlock = block[1]
    .replace('ExpectedPublicGuardSha256="__TRUSTED_PUBLIC_GUARD_SHA256__"', 'ExpectedPublicGuardSha256="$ExpectedHash"');
  const harness = `
set -euo pipefail
Root="$(mktemp -d)"
trap 'rm -rf -- "$Root"' EXIT
LockDir="$Root/lock"
TrustedSourceBundle="$Root/trusted"
mkdir -p "$LockDir" "$TrustedSourceBundle/server/scripts"
chmod 0700 "$LockDir"
cat > "$TrustedSourceBundle/server/scripts/public_release_guard.sh" <<'SH'
#!/bin/bash
set -euo pipefail
mode="$1"; shift
state=''
while test "$#" -gt 0; do
  case "$1" in --state-file) state="$2"; shift 2 ;; *) shift ;; esac
done
test -n "$state"
case "$mode" in
  read-record) : > "$state.read-called"; exit 42 ;;
  close) printf 'closed\n' > "$state"; chmod 0600 "$state"; : > "$state.close-called" ;;
  *) exit 64 ;;
esac
SH
chmod 0444 "$TrustedSourceBundle/server/scripts/public_release_guard.sh"
ExpectedHash="$(sha256sum "$TrustedSourceBundle/server/scripts/public_release_guard.sh" | awk '{print $1}')"
Phase=accepted
RunId=0123456789abcdef0123456789abcdef
systemctl() {
  case "$1" in list-units) return 0 ;; *) echo 'unexpected systemctl call' >&2; return 1 ;; esac
}
${validator[0]}
${drain[0]}
run_guard_block() {
${executableBlock}
}

install -o root -g root -m 0600 /dev/null "$LockDir/public-gate-guard.transaction-lock"
test ! -e "$LockDir/public-gate-guard"
run_guard_block
test "$(cat "$LockDir/public-gate-guard")" = closed
test -e "$LockDir/public-gate-guard.close-called"
test ! -e "$LockDir/public-gate-guard.read-called"

rm -f -- "$LockDir/public-gate-guard" "$LockDir/public-gate-guard.close-called"
printf 'closed\n' > "$LockDir/public-gate-guard"
chmod 0600 "$LockDir/public-gate-guard"
set +e
( set -e; run_guard_block ) >/dev/null 2>&1
status=$?
set -e
test "$status" != 0
test -e "$LockDir/public-gate-guard.read-called"
test ! -e "$LockDir/public-gate-guard.close-called"
test "$(cat "$LockDir/public-gate-guard")" = closed
printf '%s\n' PUBLIC_GUARD_LOCK_ONLY_RECOVERY_OK
`;
  const result = runRootBashSync(['-s'], { input: harness, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PUBLIC_GUARD_LOCK_ONLY_RECOVERY_OK/);
});

test('Phase 4 takeover exact public guard drain rejects hostile transient identity', () => {
  const takeover = remoteBody(
    read(deployPath), 'Enter-RemoteInterruptedDeploymentRecovery', 'Get-RemoteDeploymentRunMetadata'
  );
  const validator = takeover.match(/validate_public_guard_unit_for_phase\(\) \{[\s\S]*?\n\}/);
  const drain = takeover.match(/drain_public_guard_unit\(\) \{[\s\S]*?\n\}/);
  assert.ok(validator && drain, 'takeover public guard validator and drain functions must exist');
  const unit = 'turingmarket-cutover-public-guard-0123456789abcdef0123456789abcdef.service';
  const harness = `
set -euo pipefail
Phase=accepted
RunId=0123456789abcdef0123456789abcdef
Log="$(mktemp)"
UserValue=root
systemctl() {
  printf '%s\n' "$*" >> "$Log"
  case "$1" in
    show)
      property=''; for argument in "$@"; do case "$argument" in --property=*) property="\${argument#--property=}" ;; esac; done
      case "$property" in
        LoadState) printf '%s\n' loaded ;;
        User) printf '%s\n' "$UserValue" ;;
        FragmentPath) printf '/run/systemd/transient/%s\n' "$2" ;;
        ControlGroup) printf '/system.slice/%s\n' "$2" ;;
        MainPID) printf '%s\n' 0 ;;
      esac ;;
    stop|kill|reset-failed) return 0 ;;
  esac
}
${validator[0]}
${drain[0]}
drain_public_guard_unit ${bashLiteral(unit)}
grep -Fqx 'stop ${unit}' "$Log"
grep -Fqx 'kill --kill-who=all --signal=KILL ${unit}' "$Log"
UserValue=nobody
set +e
( set -e; drain_public_guard_unit ${bashLiteral(unit)} ) >/dev/null 2>&1
hostile_status=$?
set -e
test "$hostile_status" != 0
printf '%s\n' PUBLIC_GUARD_EXACT_DRAIN_OK
`;
  const result = runBashSync(['-s'], { input: harness, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PUBLIC_GUARD_EXACT_DRAIN_OK/);
});

test('Phase 4 takeover rejects a wrong trusted guard hash before helper bytes execute', () => {
  const takeover = remoteBody(
    read(deployPath), 'Enter-RemoteInterruptedDeploymentRecovery', 'Get-RemoteDeploymentRunMetadata'
  );
  const match = takeover.match(/PublicGuardHelper="\$TrustedSourceBundle\/server\/scripts\/public_release_guard\.sh"[\s\S]*?test "\$\(sha256sum "\$PublicGuardHelper" \| awk '\{print \$1\}'\)" = "\$ExpectedPublicGuardSha256"/);
  assert.ok(match, 'takeover must contain the complete helper trust checkpoint');
  const harness = `
set -euo pipefail
Root="$(mktemp -d)"
trap 'rm -rf -- "$Root"' EXIT
TrustedSourceBundle="$Root/trusted"
mkdir -p "$TrustedSourceBundle/server/scripts"
cat > "$TrustedSourceBundle/server/scripts/public_release_guard.sh" <<'SH'
#!/bin/bash
touch "$TM_HELPER_EXECUTED"
SH
chmod 0444 "$TrustedSourceBundle/server/scripts/public_release_guard.sh"
export TM_HELPER_EXECUTED="$Root/executed"
set +e
(
  set -e
  ${match[0]}
  /bin/bash "$PublicGuardHelper"
)
status=$?
set -e
test "$status" != 0
test ! -e "$TM_HELPER_EXECUTED"
printf '%s\n' PUBLIC_GUARD_WRONG_HASH_REJECTED
`;
  const result = runRootBashSync(['-s'], { input: harness, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PUBLIC_GUARD_WRONG_HASH_REJECTED/);
});

test('Phase 4 takeover trusted-reads, closes, and exactly drains every public guard before recovery mutation', () => {
  const takeover = functionSource(
    read(deployPath),
    'Enter-RemoteInterruptedDeploymentRecovery',
    'Get-RemoteDeploymentRunMetadata'
  );
  assert.match(takeover, /'public-gate-guard\.transaction-lock'/);
  assert.match(takeover, /os\.O_NOFOLLOW/);
  assert.match(takeover, /stat\.S_ISREG/);
  assert.match(takeover, /st_uid != expectedUid/);
  assert.match(takeover, /lockStatus\.st_gid != rootGid/);
  assert.match(takeover, /stat\.S_IMODE\([^)]*\.st_mode\) != 0o600/);
  assert.match(takeover, /st_nlink != 1/);
  assert.match(takeover, /st_size != 0/);
  assert.match(takeover, /os\.listxattr\([^)]*\)/);

  assert.match(takeover, /PublicGuardHelper="\$TrustedSourceBundle\/server\/scripts\/public_release_guard\.sh"/);
  assert.match(takeover, /ExpectedPublicGuardSha256="__TRUSTED_PUBLIC_GUARD_SHA256__"/);
  assert.match(takeover, /stat -c '%U:%G:%a:%h' "\$PublicGuardHelper"[\s\S]*?root:root:444:1/);
  assert.match(takeover, /sha256sum "\$PublicGuardHelper"[\s\S]*?"\$ExpectedPublicGuardSha256"/);
  assert.match(takeover, /PublicGuardStateFile="\$LockDir\/public-gate-guard"/);
  assert.match(takeover, /public_release_guard read-record --state-file "\$PublicGuardStateFile"/);
  assert.match(takeover, /else\s+PublicGuardRecord="absent"/);
  assert.match(takeover, /CapturedPublicGuardUnit/);
  assert.match(takeover, /public_release_guard close[\s\S]*?--state-file "\$LockDir\/public-gate-guard"[\s\S]*?--maintenance-source "\$LockDir\/nginx-api-gate\.conf"[\s\S]*?--maintenance-config \/etc\/nginx\/sites-available\/turingmarket-maintenance[\s\S]*?--recovery-link "\$LockDir\/nginx-public-guard\.link"[\s\S]*?--site-link \/etc\/nginx\/sites-enabled\/turingmarket/);
  assert.match(takeover, /systemctl list-units --all --type=service --no-legend --plain --no-pager/);
  assert.match(takeover, /validate_public_guard_unit_for_phase "\$Phase" "\$PublicGuardUnit"/);
  assert.match(takeover, /systemctl show "\$PublicGuardUnit" --property=User --value[\s\S]*?= "root"/);
  assert.match(takeover, /systemctl show "\$PublicGuardUnit" --property=FragmentPath --value[\s\S]*?= "\/run\/systemd\/transient\/\$PublicGuardUnit"/);
  assert.match(takeover, /systemctl show "\$PublicGuardUnit" --property=ControlGroup --value[\s\S]*?"\/system\.slice\/\$PublicGuardUnit"/);
  assert.match(takeover, /systemctl stop "\$PublicGuardUnit"/);
  assert.match(takeover, /systemctl kill --kill-who=all --signal=KILL "\$PublicGuardUnit"/);
  assert.match(takeover, /test ! -s "\/sys\/fs\/cgroup\$PublicGuardControlGroup\/cgroup\.procs"/);
  assert.match(takeover, /systemctl show "\$PublicGuardUnit" --property=MainPID[\s\S]*?= "0"/);

  const closeIndex = takeover.indexOf('public_release_guard close');
  const drainIndex = takeover.lastIndexOf('drain_public_guard_unit "$PublicGuardUnit"');
  const candidateDrainIndex = takeover.indexOf('for CandidateUnitKind in candidate-dependency');
  const ownerCasIndex = takeover.indexOf('target, expectedOwner, newOwner, generationRaw, quarantinePath');
  assert.ok(closeIndex >= 0 && drainIndex > closeIndex, 'maintenance close must precede watchdog drain');
  assert.ok(candidateDrainIndex > drainIndex, 'watchdog drain must precede candidate cleanup');
  assert.ok(ownerCasIndex > drainIndex, 'watchdog drain must precede owner CAS');
  assert.doesNotMatch(takeover, /systemctl (?:stop|kill)[^\r\n]*\*/);
  assert.match(takeover, /Replace\('__TRUSTED_PUBLIC_GUARD_SHA256__', \$EXPECTED_TRUSTED_PUBLIC_GUARD_SHA256\)/);
});

test('Phase 4 cutover-complete recovery executably finalizes public state before retention', {
  skip: !powershellAvailable() ? 'requires Windows PowerShell' : false,
}, () => {
  const recovery = functionSource(
    read(deployPath), 'Invoke-DeploymentFailureRecovery', 'Invoke-InterruptedDeploymentRecovery'
  );
  const script = `
$ErrorActionPreference = 'Stop'
$script:calls = New-Object System.Collections.Generic.List[string]
function Invoke-RemoteTrustedSourceInputSweep { $script:calls.Add('sweep') }
function Get-RemoteDeploymentPhase { 'cutover-complete' }
function Enter-RemoteWriterLock { $script:calls.Add('writer') }
function Get-RemoteDeploymentAcceptanceState { 'current-marker-new' }
function Invoke-RemoteAcceptedFinalize { param([string]$ReleaseRoot); $script:calls.Add('finalize') }
function Invoke-RemoteRetentionCleanup { param([string]$BackupPath,[string]$ReleaseRoot); $script:calls.Add('retention') }
function Invoke-RemoteCandidateCleanup { param([string]$ReleaseRoot); $script:calls.Add('candidate') }
function Exit-RemoteDeploymentLock { param([switch]$ReleaseWriterLock); $script:calls.Add('release') }
${recovery}
Invoke-DeploymentFailureRecovery -BackupPath backup -ReleaseRoot release -BackupCreated $true
$actual = $script:calls -join ','
if ($actual -ne 'sweep,writer,finalize,retention,candidate,release') { throw "Unexpected calls: $actual" }
'CUTOVER_COMPLETE_FINALIZED'
`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /CUTOVER_COMPLETE_FINALIZED/);
  const finalize = functionSource(read(deployPath), 'Invoke-RemoteAcceptedFinalize', 'Invoke-RemoteCandidateCleanup');
  assert.match(finalize, /mutation-started\|release-replay-complete\|accepted\|accepted-public-enabled\|cutover-complete/);

  const finalizerShell = remoteBody(
    read(deployPath), 'Invoke-RemoteAcceptedFinalize', 'Invoke-RemoteCandidateCleanup'
  );
  const syntax = spawnSync('bash', ['-n'], { input: finalizerShell, encoding: 'utf8', timeout: 30_000 });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

  const armedFlag = finalizerShell.indexOf('finalize_public_gate_armed=1');
  const failureTrap = finalizerShell.indexOf("trap 'recover_accepted_finalize_public_failure $?' ERR EXIT", armedFlag);
  const trustedClose = finalizerShell.indexOf('public_release_guard close', failureTrap);
  const guardArm = finalizerShell.indexOf('public_release_guard arm', trustedClose);
  const pm2Restart = finalizerShell.indexOf('pm2 restart ecosystem.config.js', guardArm);
  const healthWait = finalizerShell.indexOf('for attempt in $(seq 1 __PARSER_STARTUP_TIMEOUT_SECONDS__)', pm2Restart);
  const identityCheck = finalizerShell.indexOf('public_release_guard verify-armed', healthWait);
  const publicSwap = finalizerShell.indexOf('mv -Tf "$LockDir/nginx-finalize-new.link" /etc/nginx/sites-enabled/turingmarket', identityCheck);
  const exactPublicGate = finalizerShell.indexOf('run_exact_public_nginx_gate - 80', publicSwap);
  const finalPm2Facts = finalizerShell.indexOf('FinalPm2Projection="$(project_pm2_acceptance)"', exactPublicGate);
  const guardDisarm = finalizerShell.indexOf('public_release_guard disarm', finalPm2Facts);
  assert.ok(
    armedFlag >= 0 && failureTrap > armedFlag && trustedClose > failureTrap && guardArm > trustedClose,
    'accepted finalization must trap failures, close public traffic through the trusted helper, and arm the watchdog'
  );
  assert.ok(
    pm2Restart > guardArm && healthWait > pm2Restart,
    'accepted finalization must durably arm maintenance before any PM2 mutation or health wait'
  );
  assert.ok(
    identityCheck > healthWait && publicSwap > identityCheck && exactPublicGate > publicSwap,
    'accepted finalization must verify the guard before public activation and then verify exact public Nginx state'
  );
  assert.ok(
    finalPm2Facts > exactPublicGate && guardDisarm > finalPm2Facts,
    'accepted finalization may disarm only after exact public and PM2 facts converge'
  );
  assert.doesNotMatch(
    finalizerShell,
    /install -o root -g root -m 0644 "\$ApiGateConfig" "\$MaintenanceConfig"/,
    'accepted finalization must not maintain a second incomplete Nginx closing path'
  );
});

test('Phase 4 takeover validates and drains interrupted candidate gate services', () => {
  const deploy = read(deployPath);
  const takeover = functionSource(
    deploy,
    'Enter-RemoteInterruptedDeploymentRecovery',
    'Get-RemoteDeploymentRunMetadata'
  );

  assert.match(takeover, /\[\[ "\$RunStamp" =~ \^\[0-9\]\{8\}-\[0-9\]\{6\}\$ \]\]/);
  assert.match(takeover, /test "\$CandidatePathForUnit" = "\$CandidateRoot\/v060-crm-sales-workspace-\$RunStamp\/platform"/);
  assert.match(takeover, /for CandidateUnitKind in candidate-dependency candidate-dependency-build candidate-offline/);
  assert.match(takeover, /CandidateUnit="turingmarket-\$CandidateUnitKind-\$RunStamp\.service"/);
  assert.match(takeover, /systemctl show "\$CandidateUnit" --property=User[\s\S]*?= "turingmarket-gate"/);
  assert.match(takeover, /candidate-dependency\) ExpectedWorkingDirectory="\$TestRootForUnit\/dependency-stage"/);
  assert.match(takeover, /candidate-dependency-build\) ExpectedWorkingDirectory="\$TestRootForUnit\/dependency-stage\/server"/);
  assert.match(takeover, /candidate-offline\) ExpectedWorkingDirectory="\$CandidatePathForUnit"/);
  assert.match(takeover, /systemctl show "\$CandidateUnit" --property=WorkingDirectory[\s\S]*?= "\$ExpectedWorkingDirectory"/);
  assert.match(takeover, /CandidateControlGroup="\$\(systemctl show "\$CandidateUnit" --property=ControlGroup --value\)"/);
  assert.match(takeover, /"\/system\.slice\/\$CandidateUnit"/);
  assert.match(takeover, /systemctl kill --kill-who=all --signal=KILL "\$CandidateUnit"/);
  assert.match(takeover, /test ! -s "\/sys\/fs\/cgroup\$CandidateControlGroup\/cgroup\.procs"/);
  assert.match(takeover, /systemctl show "\$CandidateUnit" --property=MainPID[\s\S]*?= "0"/);

  const candidateDrainIndex = takeover.indexOf('for CandidateUnitKind in candidate-dependency candidate-dependency-build candidate-offline');
  const phaseRecoveryIndex = takeover.indexOf('if [ "$LifecycleResidue" = "migration-rehearsal" ]');
  assert.ok(candidateDrainIndex >= 0 && phaseRecoveryIndex > candidateDrainIndex);
});

test('Phase 4 takeover and candidate cleanup unmount only the exact interrupted candidate tmpfs before quarantine or deletion', () => {
  const deploy = read(deployPath);
  const takeover = functionSource(
    deploy,
    'Enter-RemoteInterruptedDeploymentRecovery',
    'Get-RemoteDeploymentRunMetadata'
  );
  const cleanup = functionSource(
    deploy,
    'Invoke-RemoteCandidateCleanup',
    'Invoke-RemoteRetentionCleanup'
  );

  for (const source of [takeover, cleanup]) {
    assert.match(source, /unmount_candidate_test_tmpfs\(\)/);
    assert.match(source, /\/proc\/self\/mountinfo/);
    assert.match(source, /findmnt -n -o FSTYPE --mountpoint "\$CandidateTestMount"/);
    assert.match(source, /test "\$CandidateTestFsType" = "tmpfs"/);
    assert.match(source, /umount -- "\$CandidateTestMount"/);
    assert.match(source, /for _attempt in \$\(seq 1 50\)[\s\S]*?umount -- "\$CandidateTestMount"[\s\S]*?sleep 0\.2/);
    assert.match(source, /! mountpoint -q "\$CandidateTestMount"/);
    assert.doesNotMatch(source, /umount\s+(?:--lazy|-l)\b/);
    assert.match(source, /Unexpected nested candidate mount/);
    assert.match(source, /if mount_path == release:[\s\S]*?Unexpected candidate release mount/);
  }

  const takeoverUnmount = takeover.indexOf('unmount_candidate_test_tmpfs "$ReleaseRootForUnit" "$TestRootForUnit"');
  const quarantineMove = takeover.indexOf('mv "$ReleaseRoot" "$QuarantinePath"');
  assert.ok(takeoverUnmount >= 0 && quarantineMove > takeoverUnmount, 'takeover must unmount before quarantine');

  const cleanupUnmount = cleanup.indexOf('unmount_candidate_test_tmpfs "$ReleaseRoot"');
  const cleanupDelete = cleanup.indexOf('rm -rf --one-file-system -- "$ReleaseRoot"');
  assert.ok(cleanupUnmount >= 0 && cleanupDelete > cleanupUnmount, 'candidate cleanup must unmount before deletion');
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
  assert.match(body, /os\.replace\(temporary, current\)/);
  assert.doesNotMatch(body, /os\.link\(/);
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
  assert.match(recovery, /switch -CaseSensitive \(\$phase\)/);
  assert.ok(recovery.indexOf('current-marker-new') < recovery.indexOf("switch -CaseSensitive ($phase)"));
  const finalize = functionSource(deploy, 'Invoke-RemoteAcceptedFinalize', 'Invoke-RemoteCandidateCleanup');
  assert.match(finalize, /public_release_guard close[\s\S]*?public_release_guard arm/);
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
    const name = `v060-crm-sales-workspace-202601${String(index + 1).padStart(2, '0')}-120000`;
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

  const liveCandidate = path.join(candidateRoot, 'v060-crm-sales-workspace-20260729-120000');
  const staleCandidate = path.join(candidateRoot, 'v060-crm-sales-workspace-20260701-120000');
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
    path.join(candidateRoot, 'v060-crm-sales-workspace-20260729-130000'),
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
WriterDir="$Root/.deploy-v030.writer"
OperationFence="$Root/.deploy-v030.operation.lock"
mkdir -p "$CandidateRoot" "$BackupRoot" "$LockDir"
chmod 0700 "$LockDir"
mkdir "$WriterDir"
chmod 0700 "$WriterDir"
printf '%s\n' eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee > "$WriterDir/owner"
chmod 0600 "$WriterDir/owner"
: > "$OperationFence"
chmod 0600 "$OperationFence"
Owner=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RunId=11111111111111111111111111111111
BackupPath=backups/v060-crm-sales-workspace-20260729-120000
ReleaseRoot="$CandidateRoot/v060-crm-sales-workspace-20260729-120000"
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
printf '%s\n' unsafe > "$WriterDir/unexpected"
chmod 0600 "$WriterDir/unexpected"
RunJsonBefore="$(sha256sum "$LockDir/run.json" | awk '{print $1}')"
set +e
run_takeover "$Owner" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb >/dev/null 2>&1
UnsafeWriterStatus=$?
set -e
test "$UnsafeWriterStatus" -ne 0
test "$(cat "$LockDir/owner")" = "$Owner"
test "$(sha256sum "$LockDir/run.json" | awk '{print $1}')" = "$RunJsonBefore"
test -d "$ReleaseRoot"
test -d "$WriterDir"
rm -f -- "$WriterDir/unexpected"
run_takeover "$Owner" cccccccccccccccccccccccccccccccc
test "$(cat "$LockDir/owner")" = cccccccccccccccccccccccccccccccc
test ! -e "$ReleaseRoot"
test -d "$CandidateRoot/.quarantine-$RunId-1"
test ! -e "$WriterDir"
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
