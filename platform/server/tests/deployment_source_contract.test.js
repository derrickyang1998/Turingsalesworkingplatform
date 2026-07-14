'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const deployPath = path.join(platformRoot, 'deploy_v8.ps1');
const manifestPath = path.join(repoRoot, 'docs', 'baselines', 'v0.2.9', 'ui-ppt-manifest.json');
const screenshotRoot = path.join(repoRoot, 'docs', 'baselines', 'v0.2.9', 'screenshots');
const docs = [
  path.join(platformRoot, 'DEPLOY.md'),
  path.join(repoRoot, 'CLAUDE_CODE_MIGRATION.md'),
  path.join(repoRoot, 'docs', 'handoff', '2026-06-30', 'OPERATIONS.md')
];

const AUTHORITATIVE_CHECKOUT = String.raw`C:\Users\29272\Documents\在线商务平台-github-sync`;
const AUTHORITATIVE_BRANCH = 'codex/v0.4.0-product-shell-and-design-system';
const APP_BUILD = '20260714-v040-product-shell-design-system';
const APP_QUERY = '20260714v040productshelldesignsystem';
const PPT_BUILD = '20260702-v916-kb-bridge-client-cn';
const PPT_QUERY = '20260702v916kbbridge';
const PPT_SHA256 = 'f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e';
const PRE_EDIT_APP_SHA256 = 'e8d2ee19f44e11c6441afe3535dde0ec7b24f3aaeb5693e152a6349ed6ef18fd';

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function posix(filePath) {
  return filePath.split(path.sep).join('/');
}

function walkFiles(root, current = root, result = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, absolute, result);
    else if (entry.isFile()) result.push(posix(path.relative(root, absolute)));
  }
  return result.sort();
}

function powerShellArrayEntries(source, variableName) {
  const match = source.match(new RegExp(`\\$${variableName}\\s*=\\s*@\\((?<body>[\\s\\S]*?)\\r?\\n\\)`));
  assert.ok(match, `$${variableName} array must exist`);
  return Array.from(match.groups.body.matchAll(/"([^"\r\n]+)"/g), (entry) => entry[1].replace(/\\/g, '/'));
}

function runPowerShellFunctionHarness(functionNames, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-deploy-state-machine-'));
  const harnessPath = path.join(root, 'harness.ps1');
  const names = functionNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ');
  const harness = `
param([Parameter(Mandatory = $true)][string]$DeployPath)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($DeployPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors[0].Message) }
$wanted = @(${names})
$definitions = New-Object 'Collections.Generic.List[string]'
foreach ($name in $wanted) {
  $matches = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true))
  if ($matches.Count -ne 1) { throw "Expected one function named $name; found $($matches.Count)" }
  $definitions.Add($matches[0].Extent.Text)
}
Invoke-Expression ($definitions -join "\r\n")
${body}
`;
  fs.writeFileSync(harnessPath, harness, 'utf8');
  try {
    return spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      harnessPath,
      deployPath
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('Task 12 docs identify the authoritative source, branch, runtime, and PM2 entry', () => {
  for (const documentPath of docs) {
    assert.equal(fs.existsSync(documentPath), true, `${documentPath} must exist`);
    const source = read(documentPath);
    assert.ok(source.includes(AUTHORITATIVE_CHECKOUT), `${documentPath} authoritative checkout`);
    assert.ok(source.includes(AUTHORITATIVE_BRANCH), `${documentPath} authoritative branch`);
    assert.match(source, /Express\s*5/i, `${documentPath} Express 5`);
    assert.match(source, /better-sqlite3/i, `${documentPath} better-sqlite3`);
    assert.match(source, /platform\/ecosystem\.config\.js|platform\\ecosystem\.config\.js/);
    assert.match(source, /server\/server\.js|server\\server\.js/);
    assert.match(source, /turingmarket/);
    assert.doesNotMatch(source, /codex\/ai-knowledge-foundation|codex\/phase-2-customer-pipeline|master \(force push\)|DB_TYPE=sql\.js|SQLite via `?sql\.js/i);
  }
});

test('Task 12 docs lock public assets, preview, build markers, backup, rollback, and verification', () => {
  const source = docs.map(read).join('\n');
  for (const marker of [
    '/client/shared/build_info.js',
    '/client/core/navigation.js',
    '/client/core/accessibility.js',
    '/client/core/shell.js',
    '/client/styles/tokens.css',
    '/client/styles/components.css',
    '/client/styles/layout.css',
    '?preview=v030',
    APP_BUILD,
    APP_QUERY,
    PPT_BUILD,
    PPT_QUERY,
    PPT_SHA256,
    'backups/v040-product-shell-design-system-<timestamp>',
    '-RollbackBackup backups/v040-product-shell-design-system-<timestamp>',
    '/api/health',
    '/m0',
    '/m4',
    '/admin',
    '/server/server.js'
  ]) {
    assert.ok(source.includes(marker), `documentation must include ${marker}`);
  }
  assert.match(
    source,
    /cd server\s*\r?\n\s*NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH=\S+ node --test --test-concurrency=1 tests\/\*\.test\.js/i,
    'isolated remote full Node test must be documented'
  );
  assert.doesNotMatch(source, /(?:tvly|sk)-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
});

test('Task 12 deploy source guards the exact branch and locked build contract', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /\[string\]\$RollbackBackup/);
  assert.ok(
    deploy.includes(`$EXPECTED_BRANCH = "${AUTHORITATIVE_BRANCH}"`),
    'deploy script must guard the authoritative v0.4 branch'
  );
  assert.match(deploy, /git\s+-C\s+\$REPO_DIR\s+branch\s+--show-current/);
  assert.match(deploy, /git\s+-C\s+\$REPO_DIR\s+status\s+--porcelain/);
  assert.match(deploy, new RegExp(APP_BUILD));
  assert.match(deploy, new RegExp(APP_QUERY));
  assert.match(deploy, new RegExp(PPT_BUILD));
  assert.match(deploy, new RegExp(PPT_QUERY));
  assert.match(deploy, new RegExp(PPT_SHA256));
  assert.doesNotMatch(deploy, /codex\/ai-knowledge-foundation|v0210-security|sql\.js/);
});

test('Task 12 local deploy preflight executes under Windows PowerShell 5.1 without network access', {
  skip: process.platform !== 'win32'
}, () => {
  const deploy = read(deployPath);
  assert.match(deploy, /\$normalizedInput\s*=\s*\$InputText\s+-replace\s+"`r`n\?",\s*"`n"/);
  assert.match(deploy, /-InputText\s+"set -euo pipefail`r`n"/);
  assert.match(deploy, /\$transportResult\s*=\s*Invoke-NativeWithUtf8Input[\s\S]*?-CaptureOutput/);
  assert.match(deploy, /TRANSPORT_OK/);
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    deployPath,
    '-ValidateLocalOnly'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /LOCAL_DEPLOY_PREFLIGHT_OK/);
});

test('Task 12 deployment mode routing rejects ambiguous or empty rollback requests before remote access', {
  skip: process.platform !== 'win32'
}, () => {
  const safeEnvironment = {
    ...process.env,
    TURINGMARKET_SERVER: '',
    USERPROFILE: os.tmpdir()
  };
  const run = (args) => spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    deployPath,
    ...args
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: safeEnvironment
  });

  const combined = run(['-ValidateLocalOnly', '-RollbackBackup', 'backups/v040-product-shell-design-system-20260714-120000']);
  assert.notEqual(combined.status, 0);
  assert.match(`${combined.stdout}\n${combined.stderr}`, /ValidateLocalOnly cannot be combined with RollbackBackup/);
  assert.doesNotMatch(`${combined.stdout}\n${combined.stderr}`, /TURINGMARKET_SERVER environment variable is required/);

  for (const value of ['', '   ']) {
    const invalid = run(['-RollbackBackup', value]);
    assert.notEqual(invalid.status, 0);
    assert.match(`${invalid.stdout}\n${invalid.stderr}`, /Rollback backup must match/);
    assert.doesNotMatch(`${invalid.stdout}\n${invalid.stderr}`, /TURINGMARKET_SERVER environment variable is required/);
  }
});

test('Task 12 deploy inventory includes every client asset and remote full-test dependency', () => {
  const deploy = read(deployPath);
  const files = powerShellArrayEntries(deploy, 'FILES');
  const fileSet = new Set(files);
  const clientFiles = walkFiles(path.join(platformRoot, 'client')).map((file) => `client/${file}`);
  for (const file of clientFiles) assert.equal(fileSet.has(file), true, `${file} must be deployed`);

  for (const file of [
    'package.json',
    'package-lock.json',
    'ecosystem.config.js',
    'server/package.json',
    'server/package-lock.json',
    'server/config/runtime_config.js',
    'server/routes_workflow.js',
    'server/workflow_engine.js',
    'server/scripts/update_ui_baseline.js',
    'server/scripts/compare_ui_baseline_runs.js',
    'server/scripts/bootstrap_production_browser_state.js',
    'server/scripts/capture_production_browser_baseline.js',
    'server/scripts/lib/production_browser_evidence.js',
    'server/tests/fixtures/browser-baseline-data.json',
    'server/tests/fixtures/frontend-active-definitions.json',
    'server/tests/fixtures/task-9-upload-header-contract.json',
    'server/tests/fixtures/start_browser_fixture_server.js',
    'server/tests/helpers/browser_fixture.js',
    'server/tests/helpers/safe_fixture_paths.js',
    'server/tests/deployment-browser-smoke.config.js',
    'server/tests/deployment-browser-smoke.spec.js'
  ]) {
    assert.equal(fileSet.has(file), true, `${file} must support remote verification`);
  }

  const nodeTests = fs.readdirSync(path.join(platformRoot, 'server', 'tests'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `server/tests/${name}`);
  for (const file of nodeTests) assert.equal(fileSet.has(file), true, `${file} must be uploaded before remote npm test`);
  assert.equal(fileSet.has('server/server_full.js'), false, 'historical server_full.js is not a production deploy input');

  const rootFiles = new Set(powerShellArrayEntries(deploy, 'ROOT_RELATIVE_FILES'));
  for (const file of [
    '.gitignore',
    '.env.example',
    'CHANGELOG.md',
    'CLAUDE_CODE_MIGRATION.md',
    'docs/runbooks/credential-rotation.md',
    'docs/handoff/2026-06-30/SECURITY.md',
    'docs/handoff/2026-06-30/OPERATIONS.md',
    'docs/superpowers/plans/2026-07-12-phase-1-credential-rotation.md',
    'docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md',
    'docs/baselines/v0.2.9/ui-ppt-manifest.json'
  ]) {
    assert.equal(rootFiles.has(file), true, `${file} must support remote full tests`);
  }
});

test('Task 12 deploy backup and rollback are complete, checksummed, and share one restore path', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /\$backupDir\s*=\s*"backups\/v040-product-shell-design-system-\$stamp"/);
  assert.match(deploy, /function Assert-RollbackBackupPath/);
  assert.match(deploy, /\^backups\/v040-product-shell-design-system-\\d\{8\}-\\d\{6\}\$/);
  assert.match(deploy, /function Invoke-RemoteBackup/);
  assert.match(deploy, /function Invoke-RemoteRestore/);
  assert.match(deploy, /files\.present/);
  assert.match(deploy, /files\.absent/);
  assert.match(deploy, /require\('better-sqlite3'\)/);
  assert.match(deploy, /database\.backup\(/);
  assert.match(deploy, /tar -czf "\$BackupAbsolute\/server-node_modules\.tgz"/);
  assert.match(deploy, /SHA256SUMS/);
  assert.match(deploy, /sha256sum --check --status|sha256sum -c/);
  assert.match(deploy, /# RESTORE_CODE/);
  assert.match(deploy, /# RESTORE_NGINX/);
  assert.match(deploy, /# RESTORE_PROCESS/);
  assert.match(deploy, /# RESTORE_HEALTH/);
  assert.ok(deploy.indexOf('# RESTORE_CODE') < deploy.indexOf('# RESTORE_NGINX'));
  assert.ok(deploy.indexOf('# RESTORE_NGINX') < deploy.indexOf('# RESTORE_PROCESS'));
  assert.ok(deploy.indexOf('# RESTORE_PROCESS') < deploy.indexOf('# RESTORE_HEALTH'));
  assert.equal((deploy.match(/Invoke-RemoteRestore\s+-BackupPath/g) || []).length >= 2, true, 'manual and automatic rollback use the same function');
  assert.match(deploy, /function Invoke-DeploymentFailureRecovery[\s\S]*?'mutation-started'[\s\S]*?Invoke-RemoteRestore\s+-BackupPath\s+\$BackupPath/);
  assert.match(deploy, /catch\s*\{[\s\S]*?Invoke-DeploymentFailureRecovery\s+-BackupPath\s+\$backupDir[\s\S]*?throw/);
  assert.match(deploy, /rm -rf server\/node_modules[\s\S]*?tar -xzf "\$BackupAbsolute\/server-node_modules\.tgz"/);
  assert.doesNotMatch(deploy, /Path\]::GetRelativePath|Path\.GetRelativePath/);
  assert.match(deploy, /test ! -e "\$BackupAbsolute"/);
  assert.match(deploy, /cd "__REMOTE_DIR__\/server"[\s\S]*?require\('better-sqlite3'\)/);
  assert.match(deploy, /tar -czf "\$BackupAbsolute\/root-node_modules\.tgz"/);
  assert.match(deploy, /pm2 stop turingmarket[\s\S]*?# RESTORE_CODE/);
  assert.doesNotMatch(deploy, /pm2 stop turingmarket\s*\|\|\s*true/);
  assert.match(deploy, /pm2 describe turingmarket[\s\S]*?execFileSync\('pm2', \['jlist'\][\s\S]*?status !== 'stopped'[\s\S]*?# RESTORE_CODE/);
});

test('Task 12 deploy validates an isolated candidate and atomically exchanges it while PM2 is stopped', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /\$remoteCandidateDir\s*=\s*"\$remoteReleaseRoot\/platform"/);
  assert.match(deploy, /\$remotePath\s*=\s*"\$remoteCandidateDir\/\$\(Convert-ToRemotePath \$file\)"/);
  assert.doesNotMatch(deploy, /\$remotePath\s*=\s*"\$REMOTE_DIR\/\$\(Convert-ToRemotePath \$file\)"/);
  assert.match(deploy, /renameat2/);
  assert.match(deploy, /RENAME_EXCHANGE/);
  assert.match(deploy, /pm2 stop turingmarket[\s\S]*?renameat2[\s\S]*?pm2 (?:restart|start)/);
  assert.match(deploy, /TM_DISABLE_DOTENV=1/);
  assert.match(deploy, /DB_PATH="\$TestDb"/);
  assert.match(deploy, /\^\[A-Za-z0-9\]\[A-Za-z0-9\.-\]\{0,252\}\$/);
});

test('Task 12 candidate rejection cannot stop production and all remote mutations hold one deploy lock', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /function Enter-RemoteDeploymentLock/);
  assert.match(deploy, /mkdir "\$LockDir"/);
  assert.match(deploy, /function Exit-RemoteDeploymentLock/);
  assert.match(deploy, /function Enter-RemoteWriterLock/);
  assert.match(deploy, /function Exit-RemoteDeploymentLock[\s\S]*?\[switch\]\$ReleaseWriterLock/);
  assert.match(deploy, /else\s*\{?[\s\S]*?test ! -e "\$WriterDir"/, 'normal lifecycle unlock must reject a surviving writer mutex');
  const exitLockMatch = deploy.match(/function Exit-RemoteDeploymentLock[\s\S]*?(?=function Enter-RemoteWriterLock)/);
  assert.ok(exitLockMatch, 'deployment lock release function must exist');
  assert.match(exitLockMatch[0], /RetiredDir="\$LockDir\.released\.__LOCK_TOKEN__"/);
  assert.match(exitLockMatch[0], /mv "\$LockDir" "\$RetiredDir"[\s\S]*?rm -rf "\$RetiredDir"/);
  assert.match(exitLockMatch[0], /WriterDir="__REMOTE_ROOT__\/\.deploy-v030\.writer"/);
  assert.ok(exitLockMatch[0].indexOf('mv "$LockDir" "$RetiredDir"') < exitLockMatch[0].indexOf('mv "$WriterDir" "$RetiredWriterDir"'), 'lifecycle generation retires before releasing the stable writer');
  assert.doesNotMatch(exitLockMatch[0], /rm -rf "\$LockDir"/);
  const enterWriterMatch = deploy.match(/function Enter-RemoteWriterLock[\s\S]*?(?=function Get-RemoteDeploymentPhase)/);
  assert.ok(enterWriterMatch, 'writer acquisition function must exist');
  assert.match(enterWriterMatch[0], /WriterDir="__REMOTE_ROOT__\/\.deploy-v030\.writer"/);
  assert.ok(enterWriterMatch[0].lastIndexOf('test "$(cat "$LockDir/owner")" = "__LOCK_TOKEN__"') > enterWriterMatch[0].indexOf('mkdir "$WriterDir"'), 'recovery and rollback writer acquisition rechecks the lifecycle generation');
  assert.match(deploy, /function Get-RemoteDeploymentPhase/);
  assert.doesNotMatch(deploy, /function Set-RemoteDeploymentPhase|Set-RemoteDeploymentPhase\s+-Phase/);
  assert.equal((deploy.match(/\$LockDir\/phase\.next/g) || []).length, 2, 'only the writer-protected cutover may update an existing phase');
  assert.match(deploy, /function Invoke-DeploymentFailureRecovery/);
  assert.match(deploy, /\$deploymentLockToken\s*=\s*\[Guid\]::NewGuid/);
  assert.match(deploy, /\$deploymentWriterToken\s*=\s*\[Guid\]::NewGuid/);
  assert.doesNotMatch(deploy, /\$liveMutationStarted/);
  assert.match(deploy, /printf '%s\\n' "locked" > "\$LockDir\/phase"/);

  const candidateMatch = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate-only gate must exist');
  assert.ok(cutoverMatch, 'production cutover gate must exist');
  assert.doesNotMatch(candidateMatch[1], /pm2 stop|systemctl reload nginx|python3 - "\$LiveDir" "\$CandidateDir"/);
  assert.match(cutoverMatch[1], /pm2 stop turingmarket/);
  assert.match(cutoverMatch[1], /RENAME_EXCHANGE/);
  assert.ok(cutoverMatch[1].indexOf('mkdir "$WriterDir"') < cutoverMatch[1].indexOf('mutation-intent'), 'cutover owns the writer lock before recording mutation intent');
  assert.match(cutoverMatch[1], /trap release_writer EXIT/);
  assert.ok(cutoverMatch[1].indexOf('mutation-intent') < cutoverMatch[1].indexOf('cp --'), 'uncertain phase precedes the first production mutation');
  assert.ok(cutoverMatch[1].indexOf('mutation-started') > cutoverMatch[1].indexOf('cp --'), 'started phase follows the first production mutation');
  assert.ok(cutoverMatch[1].indexOf('mutation-started') < cutoverMatch[1].indexOf('pm2 stop turingmarket'), 'started phase precedes PM2 shutdown');
  assert.ok(cutoverMatch[1].indexOf('cutover-complete') > cutoverMatch[1].indexOf('SESSIONS_REMAINING=0'), 'completion phase follows all production gates');
  assert.match(deploy, /catch\s*\{[\s\S]*?Invoke-DeploymentFailureRecovery\s+-BackupPath\s+\$backupDir/);
  assert.equal((deploy.match(/Enter-RemoteDeploymentLock/g) || []).length >= 3, true, 'function plus deploy and rollback lock acquisition');
  assert.equal((deploy.match(/Exit-RemoteDeploymentLock/g) || []).length >= 3, true, 'function plus success and handled-failure release');
});

test('Task 12 delayed cutover cannot cross into a replacement deployment-lock generation', {
  skip: spawnSync('bash', ['--version'], { encoding: 'utf8' }).status !== 0
}, () => {
  const deploy = read(deployPath);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'production cutover gate must exist');
  const mutationIndex = cutoverMatch[1].indexOf('record_phase mutation-intent');
  assert.ok(mutationIndex > 0, 'cutover must record mutation intent');
  const acquisitionPrefix = cutoverMatch[1].slice(0, mutationIndex);
  assert.match(acquisitionPrefix, /WriterDir="\$RemoteRoot\/\.deploy-v030\.writer"/);
  const writerAcquireIndex = acquisitionPrefix.indexOf('mkdir "$WriterDir"');
  const ownerRecheckIndex = acquisitionPrefix.lastIndexOf('test "$(cat "$LockDir/owner")" = "__LOCK_TOKEN__"');
  assert.ok(writerAcquireIndex >= 0 && ownerRecheckIndex > writerAcquireIndex, 'cutover must recheck its parent generation after acquiring the stable writer');

  const executablePrefix = acquisitionPrefix
    .replaceAll('__REMOTE_ROOT__', '$Root')
    .replaceAll('__LOCK_TOKEN__', 'generation-a')
    .replaceAll('__WRITER_TOKEN__', 'writer-a');
  const harness = `
set -u
Root=$(mktemp -d)
cleanup() { rm -rf "$Root"; }
trap cleanup EXIT
mkdir "$Root/.deploy-v030.lock"
printf '%s\\n' 'generation-b' > "$Root/.deploy-v030.lock/owner"
printf '%s\\n' 'candidate-ready' > "$Root/.deploy-v030.lock/phase"
set +e
Output=$(
${executablePrefix}
echo MUTATION_REACHED
2>&1
)
Status=$?
set -e
if [ "$Status" -eq 0 ]; then
  echo "Delayed cutover unexpectedly succeeded" >&2
  exit 1
fi
case "$Output" in
  *MUTATION_REACHED*) echo "Delayed cutover reached mutation intent" >&2; exit 1 ;;
esac
test ! -e "$Root/.deploy-v030.writer"
test "$(cat "$Root/.deploy-v030.lock/phase")" = 'candidate-ready'
echo ABA_GENERATION_REJECTED
`;
  const result = spawnSync('bash', ['-s'], { input: harness, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ABA_GENERATION_REJECTED/);
});

test('Task 12 executable recovery state machine never mutates production for a pre-cutover failure', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(['Invoke-DeploymentFailureRecovery'], String.raw`
$script:Actions = New-Object 'Collections.Generic.List[string]'
$script:Phase = 'locked'
$script:ProbeFails = $false
$script:RestoreFails = $false
$script:CleanupFails = $false
$script:WriterEnterFails = $false
function Get-RemoteDeploymentPhase {
  if ($script:ProbeFails) { throw 'phase unavailable' }
  return $script:Phase
}
function Invoke-RemoteRestore {
  param([string]$BackupPath)
  $script:Actions.Add('restore')
  if ($script:RestoreFails) { throw 'restore failed' }
}
function Invoke-RemoteCandidateCleanup {
  param([string]$ReleaseRoot)
  $script:Actions.Add('cleanup')
  if ($script:CleanupFails) { throw 'cleanup failed' }
}
function Enter-RemoteWriterLock {
  $script:Actions.Add('writer-enter')
  if ($script:WriterEnterFails) { throw 'writer active' }
}
function Exit-RemoteDeploymentLock {
  param([switch]$ReleaseWriterLock)
  if (-not $ReleaseWriterLock) { throw 'writer and deployment locks must release atomically' }
  $script:Actions.Add('exit')
}
function Reset-Case {
  $script:Actions.Clear()
  $script:ProbeFails = $false
  $script:RestoreFails = $false
  $script:CleanupFails = $false
  $script:WriterEnterFails = $false
}
function Assert-Actions {
  param([string]$Expected)
  $actual = $script:Actions -join ','
  if ($actual -ne $Expected) { throw "Expected actions '$Expected'; got '$actual'" }
}
foreach ($phase in @('locked', 'candidate-ready', 'cutover-complete')) {
  Reset-Case
  $script:Phase = $phase
  Invoke-DeploymentFailureRecovery -BackupPath 'backups/v040-product-shell-design-system-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
  Assert-Actions 'writer-enter,cleanup,exit'
}
Reset-Case
$script:Phase = 'mutation-started'
Invoke-DeploymentFailureRecovery -BackupPath 'backups/v040-product-shell-design-system-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
Assert-Actions 'writer-enter,restore,cleanup,exit'

Reset-Case
$script:Phase = 'mutation-started'
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $false } catch { $threw = $true }
if (-not $threw) { throw 'Missing backup must fail closed' }
Assert-Actions 'writer-enter'

Reset-Case
$script:ProbeFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Unknown remote phase must fail closed' }
Assert-Actions 'writer-enter'

Reset-Case
$script:Phase = 'mutation-intent'
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Uncertain mutation phase must retain the lock' }
Assert-Actions 'writer-enter'

Reset-Case
$script:Phase = 'mutation-started'
$script:RestoreFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Restore failure must fail closed' }
Assert-Actions 'writer-enter,restore'

Reset-Case
$script:Phase = 'candidate-ready'
$script:CleanupFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Cleanup failure must fail closed' }
Assert-Actions 'writer-enter,cleanup'

Reset-Case
$script:WriterEnterFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'An active writer must block recovery' }
Assert-Actions 'writer-enter'
Write-Output 'RECOVERY_STATE_MACHINE_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /RECOVERY_STATE_MACHINE_OK/);
});

test('Task 12 executable manual rollback validates the backup before acquiring the remote lock', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(['Assert-RollbackBackupPath', 'Invoke-ManualRollback'], String.raw`
$script:Actions = New-Object 'Collections.Generic.List[string]'
function Get-RemoteServer { $script:Actions.Add('server'); return 'example.test' }
function Enter-RemoteDeploymentLock { $script:Actions.Add('enter') }
function Enter-RemoteWriterLock { $script:Actions.Add('writer-enter') }
function Invoke-RemoteRestore { param([string]$BackupPath); $script:Actions.Add('restore') }
function Exit-RemoteDeploymentLock {
  param([switch]$ReleaseWriterLock)
  if (-not $ReleaseWriterLock) { throw 'writer and deployment locks must release atomically' }
  $script:Actions.Add('exit')
}
$threw = $false
try { Invoke-ManualRollback -BackupPath 'backups/v040-product-shell-design-system-bad' } catch { $threw = $true }
if (-not $threw) { throw 'Invalid backup path must be rejected' }
if ($script:Actions.Count -ne 0) { throw "Invalid path performed actions: $($script:Actions -join ',')" }
Invoke-ManualRollback -BackupPath 'backups/v040-product-shell-design-system-20260714-120000'
if (($script:Actions -join ',') -ne 'server,enter,writer-enter,restore,exit') { throw "Unexpected valid rollback actions: $($script:Actions -join ',')" }
Write-Output 'MANUAL_ROLLBACK_PREFLIGHT_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /MANUAL_ROLLBACK_PREFLIGHT_OK/);
});

test('Task 12 remote deploy gate runs full tests and exact route/static smoke before success', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /npm ci --ignore-scripts/);
  assert.match(deploy, /node node_modules\/playwright-deploy\/cli\.js install chromium/);
  assert.match(deploy, /TM_DISABLE_DOTENV=1/);
  assert.match(deploy, /DB_PATH=/);
  assert.match(deploy, /cd server[\s\S]*?node --test --test-concurrency=1 tests\/\*\.test\.js/);
  assert.doesNotMatch(deploy, /npm test -- --test-concurrency=1/);
  assert.ok(
    deploy.indexOf('node node_modules/playwright-deploy/cli.js install chromium') <
      deploy.indexOf('node --test --test-concurrency=1 tests/*.test.js'),
    'Chromium must be installed before the full Node suite launches browser-backed tests'
  );
  assert.match(deploy, /node node_modules\/playwright-deploy\/cli\.js test -c server\/tests\/deployment-browser-smoke\.config\.js/);
  assert.doesNotMatch(deploy, /npx\s+playwright|playwright-deploy\/cli\.js test -c server\/tests\/browser-baseline\.config\.js/);
  assert.match(deploy, /pm2 start ecosystem\.config\.js --only turingmarket|pm2 restart ecosystem\.config\.js --only turingmarket/);
  for (const route of ['/api/health', '/m0', '/m0-detail', '/m4', '/admin']) {
    assert.ok(deploy.includes(route), `route smoke must include ${route}`);
  }
  for (const asset of [
    '/client/shared/build_info.js',
    '/client/core/navigation.js',
    '/client/core/accessibility.js',
    '/client/core/shell.js',
    '/client/styles/tokens.css',
    '/client/styles/components.css',
    '/client/styles/layout.css'
  ]) {
    assert.ok(deploy.includes(asset), `public allowlist smoke must include ${asset}`);
  }
  for (const denied of ['/client/unknown.js', '/server/server.js']) {
    assert.ok(deploy.includes(denied), `private path smoke must include ${denied}`);
  }
  assert.match(deploy, /DEPLOY_OK/);
});

test('Task 12 manifest retains pre-edit hashes and records current post-edit comparison', () => {
  const manifest = JSON.parse(read(manifestPath));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.baseline.release, 'v0.4.0-product-shell-and-design-system');
  assert.equal(manifest.preEdit.files.appJs.sha256, PRE_EDIT_APP_SHA256);
  assert.equal(manifest.preEdit.buildMarkers.app, '20260630-auth-upload-fix');
  assert.equal(manifest.files.appJs.sha256, sha256(path.join(platformRoot, 'app.js')));
  assert.equal(manifest.files.pptJs.sha256, PPT_SHA256);
  assert.equal(manifest.buildMarkers.app, APP_BUILD);
  assert.equal(manifest.buildMarkers.ppt, PPT_BUILD);
  assert.equal(manifest.scriptCacheKeys.app, APP_QUERY);
  assert.equal(manifest.scriptCacheKeys.ppt, PPT_QUERY);
  assert.deepEqual(manifest.duplicateInventory.duplicates, ['esc']);
  assert.equal(manifest.screenshotSlots.length, 72);
  for (const slot of manifest.screenshotSlots) {
    assert.equal(slot.sha256, sha256(path.join(repoRoot, ...slot.path.split('/'))), `${slot.path} hash must match its controlled file`);
  }

  const comparison = manifest.postEditComparison;
  assert.equal(comparison.fileCount, 72);
  assert.equal(comparison.maxDiffPixelRatio, 0.005);
  assert.equal(comparison.withinThreshold, true);
  assert.equal(comparison.totalDiffPixels, 0);
  assert.ok(comparison.maxObservedDiffRatio <= comparison.maxDiffPixelRatio);
  assert.equal(comparison.screenshots.length, 72);

  const expectedPaths = walkFiles(screenshotRoot).filter((file) => file.endsWith('.png'));
  const actualPaths = comparison.screenshots.map((entry) => entry.path.replace('docs/baselines/v0.2.9/screenshots/', '')).sort();
  assert.deepEqual(actualPaths, expectedPaths);
  for (const entry of comparison.screenshots) {
    const relative = entry.path.replace('docs/baselines/v0.2.9/screenshots/', '');
    assert.equal(entry.preEditSha256, sha256(path.join(screenshotRoot, ...relative.split('/'))));
    assert.match(entry.postEditSha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.diffPixelRatio <= comparison.maxDiffPixelRatio);
  }
});
