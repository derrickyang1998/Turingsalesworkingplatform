'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const deployPath = path.join(platformRoot, 'deploy_v8.ps1');
const manifestPath = path.join(repoRoot, 'docs', 'baselines', 'v0.2.9', 'ui-ppt-manifest.json');
const screenshotRoot = path.join(repoRoot, 'docs', 'baselines', 'v0.2.9', 'screenshots');
const visualEvidenceRoot = path.join(repoRoot, 'docs', 'product', 'evidence', '2026-07-phase3-post');
const visualProvenancePath = path.join(visualEvidenceRoot, 'raw-contact-sheet-manifest.json');
const attributesPath = path.join(repoRoot, '.gitattributes');
const trustedSourceManifestPath = path.join(platformRoot, 'server', 'scripts', 'trusted_production_source_manifest.json');
const publicReleaseGuardPath = path.join(platformRoot, 'server', 'scripts', 'public_release_guard.sh');
const phase3EvidenceGeneratorPath = path.join(platformRoot, 'server', 'scripts', 'generate_phase3_visual_evidence_manifest.js');
const docs = [
  path.join(platformRoot, 'DEPLOY.md'),
  path.join(repoRoot, 'CLAUDE_CODE_MIGRATION.md')
];

const AUTHORITATIVE_CHECKOUT = String.raw`C:\Users\29272\Documents\在线商务平台-github-sync`;
const AUTHORITATIVE_BRANCH = 'codex/v0.7.0-ai-knowledge-proposal-ppt-loop-production';
const RELEASE_SLUG = 'v060-crm-sales-workspace';
const APP_BUILD = '20260811-v060-crm-sales-workspace';
const APP_QUERY = '20260811v060crmsalesworkspace';
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

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hereDocBody(source, marker) {
  const expression = new RegExp(`node <<'${marker}'\\r?\\n([\\s\\S]*?)\\r?\\n${marker}`);
  const match = source.match(expression);
  assert.ok(match, `${marker} here-document must exist`);
  return match[1];
}

function shellHereDocBody(source, marker) {
  const expression = new RegExp(`<<'${marker}'\\r?\\n([\\s\\S]*?)\\r?\\n${marker}`);
  const match = source.match(expression);
  assert.ok(match, `${marker} shell here-document must exist`);
  return match[1];
}

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source must exist before ${nextName}`);
  return source.slice(start, end);
}

function pythonFileMetadata(python, targets) {
  const result = spawnSync(python, [
    '-c',
    'import json,os,stat,sys; print(json.dumps([{"uid":s.st_uid,"gid":s.st_gid,"mode":format(stat.S_IMODE(s.st_mode),"04o")} for s in [os.lstat(p) for p in sys.argv[1:]]]))',
    ...targets
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function rootLinuxAvailable() {
  const command = process.platform === 'win32'
    ? ['wsl.exe', ['-u', 'root', '-e', 'bash', '-lc', 'test "$(id -u)" = 0 && command -v python3 >/dev/null']]
    : ['bash', ['-lc', 'test "$(id -u)" = 0 && command -v python3 >/dev/null']];
  return spawnSync(command[0], command[1], { encoding: 'utf8', timeout: 10_000 }).status === 0;
}

function nativeSystemdRootAvailable() {
  const probe = 'test "$(id -u)" = 0 && test -d /run/systemd/system && systemctl show --property=Version >/dev/null 2>&1';
  const command = process.platform === 'win32'
    ? ['wsl.exe', ['-u', 'root', '-e', 'bash', '-lc', probe]]
    : ['bash', ['-lc', probe]];
  return spawnSync(command[0], command[1], { encoding: 'utf8', timeout: 10_000 }).status === 0;
}

function runRootLinuxScript(script) {
  return process.platform === 'win32'
    ? spawnSync('wsl.exe', ['-u', 'root', '-e', 'bash', '-s'], {
      encoding: 'utf8', input: script, timeout: 30_000
    })
    : spawnSync('bash', ['-s'], { encoding: 'utf8', input: script, timeout: 30_000 });
}

function safeGitEnvironment(overrides = {}) {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: repoRoot,
    ...overrides
  };
}

test('Task 12 trusted production source and deployed shell scripts use LF line endings', () => {
  const trustedManifest = JSON.parse(read(trustedSourceManifestPath));
  const deployedShellPaths = [
    'platform/server/scripts/bootstrap_production_runtime.sh',
    'platform/server/scripts/cleanup_stale_migration_gate.sh',
    'platform/server/scripts/parse_upload_sandbox.sh'
  ];
  const trustedPaths = [
    'platform/server/scripts/trusted_production_source_gate.js',
    'platform/server/scripts/trusted_production_source_manifest.json',
    ...trustedManifest.files.map((entry) => `platform/${entry.path}`),
    ...deployedShellPaths
  ];
  const attributeLines = new Set(read(attributesPath).split(/\r?\n/).filter(Boolean));
  const manifestHashes = new Map(
    trustedManifest.files.map((entry) => [`platform/${entry.path}`, entry.sha256])
  );
  for (const trustedPath of trustedPaths) {
    assert.equal(
      attributeLines.has(`${trustedPath} text eol=lf`),
      true,
      `${trustedPath} must have an exact eol=lf rule`
    );
    const bytes = fs.readFileSync(path.join(repoRoot, ...trustedPath.split('/')));
    assert.equal(bytes.includes(13), false, `${trustedPath} must contain LF bytes only`);
    const expectedHash = manifestHashes.get(trustedPath);
    if (expectedHash) {
      assert.equal(sha256Buffer(bytes), expectedHash, `${trustedPath} must match its trusted manifest hash`);
    }
  }
});

function gitBlob(commit, source) {
  const result = spawnSync('git', ['show', `${commit}:${source}`], {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    env: safeGitEnvironment()
  });
  const diagnostic = result.error
    ? result.error.message
    : Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr || '').trim();
  assert.equal(
    result.status,
    0,
    `git blob must exist for ${source}${diagnostic ? `: ${diagnostic}` : ''}`
  );
  return result.stdout;
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

function relativeRequireTargets(filePath) {
  const targets = [];
  const source = read(filePath);
  const pattern = /\brequire\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const base = path.resolve(path.dirname(filePath), match[2]);
    const candidates = path.extname(base)
      ? [base]
      : [`${base}.js`, `${base}.json`, path.join(base, 'index.js')];
    const resolved = candidates.find((candidate) => fs.existsSync(candidate));
    if (
      resolved &&
      fs.statSync(resolved).isFile() &&
      path.relative(platformRoot, resolved).split(path.sep)[0] !== '..'
    ) {
      targets.push(posix(path.relative(platformRoot, resolved)));
    }
  }
  return [...new Set(targets)].sort();
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

test('Phase 4 docs identify the authoritative source, branch, runtime, and PM2 entry', () => {
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

test('Phase 4 docs lock public assets, preview, build markers, backup, rollback, and verification', () => {
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
    `backups/${RELEASE_SLUG}-<timestamp>`,
    `-RollbackBackup backups/${RELEASE_SLUG}-<timestamp> -RestoreDatabase -ConfirmDataLoss`,
    'PPT_CACHE_DIR',
    '/api/health',
    '/m0',
    '/m4',
    '/admin',
    '/server/server.js'
  ]) {
    assert.ok(source.includes(marker), `documentation must include ${marker}`);
  }
  assert.match(source, /verify_phase4_one_request_replay\.js/i,
    'bounded candidate replay verifier must be documented');
  assert.match(source, /verify_phase4_one_request_replay\.test\.js/i,
    'bounded candidate replay tests must be documented');
  assert.match(source, /release_replay_gate\.test\.js/i,
    'bounded release replay tests must be documented');
  assert.match(source, /Full non-browser regression[\s\S]*phase closeout/i,
    'phase-closeout regression policy must be documented');
  assert.doesNotMatch(source, /(?:tvly|sk)-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
});

test('Phase 4 deploy source guards the exact branch and locked build contract', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /\[string\]\$RollbackBackup/);
  assert.ok(
    deploy.includes(`$EXPECTED_BRANCH = "${AUTHORITATIVE_BRANCH}"`),
    'deploy script must guard the authoritative v0.7 branch'
  );
  assert.match(deploy, /git\s+-C\s+\$REPO_DIR\s+branch\s+--show-current/);
  assert.match(deploy, /git\s+-C\s+\$REPO_DIR\s+status\s+--porcelain/);
  assert.match(deploy, /if \(\$currentBranch -ne \$EXPECTED_BRANCH\)/, 'branch lock must also run during local validation');
  assert.match(deploy, /if \(-not \$ValidateLocalOnly\) \{[\s\S]*?git -C \$REPO_DIR status --porcelain[\s\S]*?dirty tracked worktree/);
  assert.match(deploy, /Assert-AuthoritativeCheckout[\s\S]*?Assert-LocalReleaseSource[\s\S]*?\$SERVER = Get-RemoteServer/);
  assert.match(deploy, new RegExp(`backups/${RELEASE_SLUG.replaceAll('-', '\\-')}-\\$stamp`));
  assert.match(deploy, new RegExp(APP_BUILD));
  assert.match(deploy, new RegExp(APP_QUERY));
  assert.match(deploy, new RegExp(PPT_BUILD));
  assert.match(deploy, new RegExp(PPT_QUERY));
  assert.match(deploy, new RegExp(PPT_SHA256));
  assert.doesNotMatch(deploy, /codex\/ai-knowledge-foundation|v0210-security|sql\.js/);
});

test('Task 12 local deploy preflight executes under Windows PowerShell 5.1 without network access', {
  skip: process.platform !== 'win32'
}, (t) => {
  const deploy = read(deployPath);
  assert.match(deploy, /\$normalizedInput\s*=\s*\$InputText\s+-replace\s+"`r`n\?",\s*"`n"/);
  assert.match(deploy, /-InputText\s+"set -euo pipefail`r`n"/);
  assert.match(deploy, /\$transportResult\s*=\s*Invoke-NativeWithUtf8Input[\s\S]*?-CaptureOutput/);
  assert.match(deploy, /TRANSPORT_OK/);
  const expectedBranch = deploy.match(/\$EXPECTED_BRANCH\s*=\s*"([^"]+)"/);
  assert.ok(expectedBranch, 'deploy script must declare its authoritative branch');
  const currentBranch = spawnSync('git', ['-C', repoRoot, 'branch', '--show-current'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: safeGitEnvironment()
  });
  assert.equal(currentBranch.status, 0, currentBranch.stderr || currentBranch.stdout);
  if (currentBranch.stdout.trim() !== expectedBranch[1]) {
    t.skip(`runtime preflight requires authoritative branch ${expectedBranch[1]}`);
    return;
  }
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
    timeout: 120_000,
    env: safeGitEnvironment()
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /LOCAL_DEPLOY_PREFLIGHT_OK/);
});

test('Task 12 remote Bash transport uploads the complete payload before stdin-free execution', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(['Invoke-RemoteBash'], String.raw`
$script:SSH_KEY = 'C:\fixture\deploy-key'
$script:SERVER = 'example.invalid'
$script:CapturedCalls = New-Object 'Collections.Generic.List[object]'
function Invoke-NativeWithUtf8Input {
  param(
    [string]$FileName,
    [string[]]$ArgumentList,
    [string]$InputText,
    [string]$FailureMessage,
    [int]$TimeoutSeconds,
    [switch]$CaptureOutput
  )
  $script:CapturedCalls.Add([pscustomobject]@{
    FileName = $FileName
    Arguments = @($ArgumentList)
    Input = $InputText
    CaptureOutput = [bool]$CaptureOutput
  })
  if ($CaptureOutput) { return 'REMOTE_OUTPUT' }
}
$lf = [string][char]10
$payload = 'set -euo pipefail' + $lf + 'exit 19' + $lf + (('# unread payload padding' * 20000) -join $lf)
$capturedResult = Invoke-RemoteBash -Script $payload -FailureMessage 'early failure probe' -TimeoutSeconds 30 -CaptureOutput
if ($capturedResult -cne 'REMOTE_OUTPUT') { throw 'Execution output was not returned to the caller' }
if ($script:CapturedCalls.Count -ne 2) { throw 'Remote transport must use one upload connection and one execution connection' }
$upload = $script:CapturedCalls[0]
$execution = $script:CapturedCalls[1]
if ($upload.FileName -cne 'ssh.exe' -or $execution.FileName -cne 'ssh.exe') { throw 'Both transport phases must use the pinned SSH client' }
if ($upload.Input -cne $payload) { throw 'Upload stdin must contain only the complete remote payload' }
if ($execution.Input -cne '') { throw 'Execution SSH stdin must be empty' }
if ($upload.CaptureOutput) { throw 'Upload connection must not capture execution output' }
if (-not $execution.CaptureOutput) { throw 'Execution connection must preserve caller output capture' }
$uploadCommand = [string]$upload.Arguments[$upload.Arguments.Count - 1]
$executionCommand = [string]$execution.Arguments[$execution.Arguments.Count - 1]
if ($uploadCommand -notmatch "^bash -c 'set -euo pipefail") {
  throw 'Remote upload command must be supplied as an SSH command argument'
}
if ($uploadCommand -notmatch 'RemoteScript=/run/turingmarket-remote-script-[a-f0-9]{32}') {
  throw 'Remote payload was not uploaded to a bounded runtime file'
}
foreach ($required in @(
  'cat > "$RemoteScript"',
  'test ! -L "$RemoteScript"',
  'root:root:600:1',
  'set -o noclobber',
  'sha256sum --check --status'
)) {
  if (-not $uploadCommand.Contains($required)) { throw "Remote upload control missing: $required" }
}
if ($executionCommand -notmatch 'RemoteScript=/run/turingmarket-remote-script-[a-f0-9]{32}') {
  throw 'Remote execution did not reference the bounded runtime file'
}
$uploadPath = [regex]::Match($uploadCommand, 'RemoteScript=(/run/turingmarket-remote-script-[a-f0-9]{32})').Groups[1].Value
$executionPath = [regex]::Match($executionCommand, 'RemoteScript=(/run/turingmarket-remote-script-[a-f0-9]{32})').Groups[1].Value
if ($uploadPath -cne $executionPath) { throw 'Upload and execution must use the same runtime file' }
foreach ($required in @(
  'trap cleanup_remote_script EXIT HUP INT TERM',
  'sha256sum --check --status',
  '/bin/bash -e -- "$RemoteScript" </dev/null'
)) {
  if (-not $executionCommand.Contains($required)) { throw "Remote execution control missing: $required" }
}
if ($execution.Arguments -notcontains '-n') { throw 'Execution SSH must disconnect standard input' }
if ($upload.Arguments -contains '-n') { throw 'Upload SSH must retain its payload input' }
foreach ($phase in @($upload, $execution)) {
  if ($phase.Arguments -notcontains 'ServerAliveInterval=15' -or
      $phase.Arguments -notcontains 'ServerAliveCountMax=12') {
    throw 'Every remote Bash transport phase must keep the encrypted SSH session active'
  }
}
if ($uploadCommand.Contains('exit 19') -or $uploadCommand.Contains('# unread payload padding') -or
    $executionCommand.Contains('exit 19') -or $executionCommand.Contains('# unread payload padding')) {
  throw 'Remote payload must not be interpolated into either SSH command'
}
Write-Output 'REMOTE_UPLOAD_EXEC_OK'
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /REMOTE_UPLOAD_EXEC_OK/);
});

test('Task 12 remote Bash transport removes the uploaded runtime file after execution transport failure', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(['Invoke-RemoteBash'], String.raw`
$script:SSH_KEY = 'C:\fixture\deploy-key'
$script:SERVER = 'example.invalid'
$script:CapturedCalls = New-Object 'Collections.Generic.List[object]'
function Invoke-NativeWithUtf8Input {
  param(
    [string]$FileName,
    [string[]]$ArgumentList,
    [AllowEmptyString()][string]$InputText,
    [string]$FailureMessage,
    [int]$TimeoutSeconds,
    [switch]$CaptureOutput
  )
  $script:CapturedCalls.Add([pscustomobject]@{
    Arguments = @($ArgumentList)
    Input = $InputText
    FailureMessage = $FailureMessage
  })
  if ($script:CapturedCalls.Count -eq 2) { throw 'EXECUTION_TRANSPORT_FAILURE' }
}
try {
  Invoke-RemoteBash -Script 'exit 19' -FailureMessage 'expected execution failure' -TimeoutSeconds 30
  throw 'UNSAFE_CONTINUATION_AFTER_EXECUTION_FAILURE'
}
catch {
  if ($_.Exception.Message -notmatch 'EXECUTION_TRANSPORT_FAILURE') { throw }
}
if ($script:CapturedCalls.Count -ne 3) { throw 'Execution failure must trigger a separate cleanup connection' }
$uploadCommand = [string]$script:CapturedCalls[0].Arguments[-1]
$cleanup = $script:CapturedCalls[2]
$cleanupCommand = [string]$cleanup.Arguments[-1]
$uploadPath = [regex]::Match($uploadCommand, 'RemoteScript=(/run/turingmarket-remote-script-[a-f0-9]{32})').Groups[1].Value
$cleanupPath = [regex]::Match($cleanupCommand, 'RemoteScript=(/run/turingmarket-remote-script-[a-f0-9]{32})').Groups[1].Value
if ([string]::IsNullOrWhiteSpace($uploadPath) -or $cleanupPath -cne $uploadPath) {
  throw 'Cleanup must target only the uploaded runtime file'
}
if ($cleanup.Arguments -notcontains '-n' -or $cleanup.Input -cne '') {
  throw 'Cleanup connection must disconnect standard input'
}
if ($cleanup.Arguments -notcontains 'ServerAliveInterval=15' -or
    $cleanup.Arguments -notcontains 'ServerAliveCountMax=12') {
  throw 'Cleanup connection must retain the deployment SSH keepalive policy'
}
if (-not $cleanupCommand.Contains('rm -f -- "$RemoteScript"')) {
  throw 'Cleanup command must remove the exact bounded runtime file'
}
Write-Output 'REMOTE_FAILURE_CLEANUP_OK'
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /REMOTE_FAILURE_CLEANUP_OK/);
  assert.doesNotMatch(result.stdout, /UNSAFE_CONTINUATION_AFTER_EXECUTION_FAILURE/);
});

test('Phase 4 deployment mode routing requires explicit destructive restore consent before remote access', {
  skip: process.platform !== 'win32'
}, () => {
  const safeEnvironment = safeGitEnvironment({
    TURINGMARKET_SERVER: '',
    USERPROFILE: os.tmpdir()
  });
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
  const reject = (args, pattern) => {
    const result = run(args);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, `${args.join(' ')} must be rejected`);
    assert.match(output, pattern);
    assert.doesNotMatch(output, /TURINGMARKET_SERVER environment variable is required/);
  };

  reject(
    ['-ValidateLocalOnly', '-RollbackBackup', `backups/${RELEASE_SLUG}-20260714-120000`],
    /ValidateLocalOnly cannot be combined with rollback or restore controls/
  );
  reject(['-RestoreDatabase'], /RestoreDatabase requires -RollbackBackup/);
  reject(['-ConfirmDataLoss'], /ConfirmDataLoss requires -RestoreDatabase/);
  reject(
    ['-RollbackBackup', `backups/${RELEASE_SLUG}-20260714-120000`],
    /RollbackBackup requires -RestoreDatabase/
  );
  reject(
    ['-RollbackBackup', `backups/${RELEASE_SLUG}-20260714-120000`, '-RestoreDatabase'],
    /RestoreDatabase requires -ConfirmDataLoss/
  );
  reject(
    [
      '-RollbackBackup',
      `backups/${RELEASE_SLUG}-20260714-120000`,
      '-RestoreDatabase',
      '-ConfirmDataLoss',
      '-PreserveSessions'
    ],
    /Phase 4 deployment rejects session preservation/
  );
  reject(['-PreserveSessions'], /Phase 4 deployment rejects session preservation/);

  for (const value of ['', '   ']) {
    reject(['-RollbackBackup', value], /Rollback backup must match/);
  }
  for (const value of ['14', '301']) {
    const invalid = run(['-MaintenanceTimeoutSeconds', value]);
    assert.notEqual(invalid.status, 0);
    assert.doesNotMatch(`${invalid.stdout}\n${invalid.stderr}`, /TURINGMARKET_SERVER environment variable is required/);
  }
});

test('Task 12 deploy inventory includes every client asset and bounded remote-gate dependency', () => {
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

  for (const file of [
    'server/scripts/verify_phase4_one_request_replay.js',
    'server/tests/verify_phase4_one_request_replay.test.js',
    'server/tests/release_replay_gate.test.js',
    'server/tests/deployment-browser-smoke.config.js',
    'server/tests/deployment-browser-smoke.spec.js'
  ]) {
    assert.equal(fileSet.has(file), true, `${file} must be uploaded before the bounded remote gate`);
  }
  const deployedJavaScript = files.filter((file) => file.endsWith('.js'));
  for (const sourceFile of deployedJavaScript) {
    const absolute = path.join(platformRoot, ...sourceFile.split('/'));
    if (!fs.existsSync(absolute)) continue;
    for (const dependency of relativeRequireTargets(absolute)) {
      assert.equal(
        fileSet.has(dependency),
        true,
        `${sourceFile} requires ${dependency}, which must be deployed`
      );
    }
  }
  const migrations = walkFiles(path.join(platformRoot, 'server', 'migrations'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => `server/migrations/${file}`);
  for (const migration of migrations) {
    assert.equal(fileSet.has(migration), true, `${migration} must be deployed for migration discovery`);
  }
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
    'docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md'
  ]) {
    assert.equal(rootFiles.has(file), true, `${file} must be promoted as repository documentation`);
  }

  const candidateOnlyFiles = new Set(powerShellArrayEntries(deploy, 'CANDIDATE_ONLY_FILES'));
  for (const file of [
    '.gitattributes',
    'docs/baselines/v0.2.9/ui-ppt-manifest.json',
    'docs/product/turingmarket-design-system.md',
    'docs/product/2026-07-phase3-visual-change-record.md',
    'docs/product/2026-07-phase3-accessibility-residual-risks.md',
    'docs/product/evidence/2026-07-phase3-post/raw-contact-sheet-manifest.json',
    'docs/product/evidence/2026-07-phase3-post/fixture-1440-1.png',
    'docs/product/evidence/2026-07-phase3-post/fixture-1920-1.png',
    'docs/product/evidence/2026-07-phase3-post/fixture-mobile-1.png'
  ]) {
    assert.equal(candidateOnlyFiles.has(file), true, `${file} must be uploaded only for candidate verification`);
    assert.equal(rootFiles.has(file), false, `${file} must not be promoted or rollback-owned`);
  }
  assert.match(deploy, /\$script:CANDIDATE_ONLY_FILES\s*\+=\s*\$screenshots/);
  assert.doesNotMatch(deploy, /\$script:ROOT_RELATIVE_FILES\s*\+=\s*\$screenshots/);
  assert.match(deploy, /foreach \(\$entry in \$CandidateOnlyEntries\) \{[\s\S]*?Kind = 'CandidateOnly'[\s\S]*?RemoteRelativePath = Convert-ToRemotePath \$relativePath[\s\S]*?IncludedInBackup = \$false/);
  assert.match(deploy, /-CandidateOnlyEntries \(\[object\[\]\]\$CANDIDATE_ONLY_FILES\.Clone\(\)\)/);
  assert.match(deploy, /git -C \$REPO_DIR ls-files --error-unmatch -- \$trackedPath/);
});

test('Phase 4 deploy backup and rollback are complete, checksummed, and share one restore path', () => {
  const deploy = read(deployPath);
  assert.match(deploy, new RegExp(`\\$backupDir\\s*=\\s*"backups/${RELEASE_SLUG}-\\$stamp"`));
  assert.match(deploy, /function Assert-RollbackBackupPath/);
  assert.match(deploy, new RegExp(`\\^backups/${RELEASE_SLUG}-\\\\d\\{8\\}-\\\\d\\{6\\}\\$`));
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
  assert.match(deploy, /# RESTORE_DATABASE_AND_PPT_CACHE/);
  assert.match(deploy, /# INVALIDATE_SESSIONS/);
  assert.match(deploy, /# RESTORE_MAINTENANCE/);
  assert.match(deploy, /# RESTORE_NGINX/);
  assert.match(deploy, /# RESTORE_PROCESS/);
  assert.match(deploy, /# RESTORE_HEALTH/);
  assert.match(deploy, /# RESTORE_PUBLIC_GATE/);
  assert.ok(deploy.indexOf('# RESTORE_MAINTENANCE') < deploy.indexOf('pm2 stop turingmarket'));
  assert.ok(deploy.indexOf('# RESTORE_CODE') < deploy.indexOf('# RESTORE_DATABASE_AND_PPT_CACHE'));
  assert.ok(deploy.indexOf('# RESTORE_DATABASE_AND_PPT_CACHE') < deploy.indexOf('# INVALIDATE_SESSIONS'));
  assert.ok(deploy.indexOf('# INVALIDATE_SESSIONS') < deploy.indexOf('# RESTORE_PROCESS'));
  assert.ok(deploy.indexOf('# RESTORE_PROCESS') < deploy.indexOf('# RESTORE_HEALTH'));
  assert.ok(deploy.indexOf('# RESTORE_HEALTH') < deploy.indexOf('# RESTORE_NGINX'));
  assert.ok(deploy.indexOf('# RESTORE_NGINX') < deploy.indexOf('# RESTORE_PUBLIC_GATE'));
  assert.match(deploy, /# RESTORE_PUBLIC_GATE[\s\S]*?run_exact_public_nginx_gate - 80/);
  assert.equal((deploy.match(/Invoke-RemoteRestore\s+-BackupPath/g) || []).length >= 2, true, 'manual and automatic rollback use the same function');
  assert.match(deploy, /function Invoke-DeploymentFailureRecovery[\s\S]*?'mutation-started'[\s\S]*?Invoke-RemoteRestore\s+-BackupPath\s+\$BackupPath\s+-RestoreDatabase/);
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

test('cleanup control replay tolerates operational atime drift without weakening file integrity', () => {
  const deploy = read(deployPath);
  const restore = functionSource(
    deploy,
    'Get-MigrationGateCleanupControlRestoreScript',
    'Get-Pm2PersistenceVerifier'
  );
  const verifyFile = restore.match(/def verify_file\([\s\S]*?(?=def verify_convergence)/);
  assert.ok(verifyFile, 'cleanup control replay must define a final file verifier');
  assert.match(restore, /os\.utime\(temporary, ns=\(record\['atimeNs'\], record\['mtimeNs'\]\)/,
    'replay should initially restore the captured timestamps');
  assert.doesNotMatch(verifyFile[0], /st_atime_ns/,
    'systemd and cleanup execution may legitimately advance access time after restoration');
  for (const immutableCheck of [
    /metadata\.st_uid != record\['uid'\]/,
    /metadata\.st_gid != record\['gid'\]/,
    /metadata\.st_size != record\['size'\]/,
    /metadata\.st_mtime_ns != record\['mtimeNs'\]/,
    /hashlib\.sha256\(payload\)\.hexdigest\(\) != record\['sha256'\]/
  ]) {
    assert.match(verifyFile[0], immutableCheck);
  }
});

test('migration cleanup restore replay converges canonical topologies after every durable interruption', {
  skip: !rootLinuxAvailable()
}, () => {
  const deploy = read(deployPath);
  const restoreBody = shellHereDocBody(deploy, 'TM_MIGRATION_CLEANUP_CONTROL_REPLAY');
  const backupBody = shellHereDocBody(deploy, 'TM_MIGRATION_CLEANUP_CONTROL_BACKUP');
  const result = runRootLinuxScript(`
set -euo pipefail
umask 077
Root="$(mktemp -d /root/tm-cleanup-control-replay-XXXXXX)"
trap 'rm -rf -- "$Root"' EXIT
cat > "$Root/restore.py" <<'TM_RESTORE_REPLAY_FIXTURE_BODY'
${restoreBody}
TM_RESTORE_REPLAY_FIXTURE_BODY
cat > "$Root/backup.py" <<'TM_BACKUP_TOPOLOGY_FIXTURE_BODY'
${backupBody}
TM_BACKUP_TOPOLOGY_FIXTURE_BODY
cat > "$Root/systemctl" <<'TM_SYSTEMCTL_FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TM_FIXTURE_SYSTEMCTL_LOG"
case "$1" in
  daemon-reload|stop) exit 0 ;;
  is-active) exit 3 ;;
  is-enabled)
    Unit="$TM_FIXTURE_SYSTEMD_ROOT/turingmarket-gate-cleanup.service"
    Link="$TM_FIXTURE_SYSTEMD_ROOT/multi-user.target.wants/turingmarket-gate-cleanup.service"
    if [ -f "$Unit" ] && [ -L "$Link" ] && [ "$(readlink "$Link")" = "$Unit" ]; then
      printf '%s\\n' enabled
      exit 0
    fi
    printf '%s\\n' not-found
    exit 1
    ;;
  show)
    Unit="$TM_FIXTURE_SYSTEMD_ROOT/turingmarket-gate-cleanup.service"
    Property=''
    for Argument in "$@"; do case "$Argument" in --property=*) Property="\${Argument#--property=}" ;; esac; done
    case "$Property" in
      Id) printf '%s\\n' turingmarket-gate-cleanup.service ;;
      Names) printf '%s\\n' "\${TM_FIXTURE_NAMES:-turingmarket-gate-cleanup.service}" ;;
      LoadState) if test -f "$Unit"; then printf '%s\\n' loaded; else printf '%s\\n' not-found; fi ;;
      FragmentPath) if test -f "$Unit"; then printf '%s\\n' "\${TM_FIXTURE_FRAGMENT_PATH:-$Unit}"; else printf '\\n'; fi ;;
      DropInPaths)
        if test -n "\${TM_FIXTURE_DROPIN_PATHS+x}"; then
          printf '%s\\n' "$TM_FIXTURE_DROPIN_PATHS"
        elif test -f "$Unit" && test -f "$TM_FIXTURE_BARRIER"; then
          printf '%s\\n' "$TM_FIXTURE_BARRIER"
        else
          printf '\\n'
        fi
        if test -n "\${TM_FIXTURE_SUBSTITUTE_PARENT:-}" && test ! -e "$TM_FIXTURE_SUBSTITUTE_PARENT.done"; then
          mv "$TM_FIXTURE_SUBSTITUTE_PARENT" "$TM_FIXTURE_SUBSTITUTE_PARENT.original"
          ln -s "$TM_FIXTURE_SUBSTITUTE_TARGET" "$TM_FIXTURE_SUBSTITUTE_PARENT"
          : > "$TM_FIXTURE_SUBSTITUTE_PARENT.done"
        fi
        ;;
      *) exit 64 ;;
    esac
    ;;
  *) exit 64 ;;
esac
TM_SYSTEMCTL_FIXTURE
chmod 0700 "$Root/systemctl"

make_case() {
  local CaseRoot="$1"
  local Kind="$2"
  local Backup="$CaseRoot/backup"
  local Live="$CaseRoot/live"
  local Systemd="$CaseRoot/systemd"
  local Helper="$Live/cleanup.sh"
  local Unit="$Systemd/turingmarket-gate-cleanup.service"
  local Link="$Systemd/multi-user.target.wants/turingmarket-gate-cleanup.service"
  mkdir -p "$Backup" "$Live" "$Systemd/multi-user.target.wants" "$CaseRoot/journal"
  chmod 0700 "$Backup" "$CaseRoot/journal"
  chmod 0755 "$Live" "$Systemd" "$Systemd/multi-user.target.wants"
  printf 'candidate-helper\\n' > "$Helper"
  printf 'candidate-unit\\n' > "$Unit"
  chmod 0555 "$Helper"
  chmod 0444 "$Unit"
  ln -s "$Unit" "$Link"
  python3 - "$Backup" "$Kind" <<'PY'
import hashlib
import json
import os
import sys

root, kind = sys.argv[1:]
timestamp = 1700000000000000000
def record(name, mode, payload):
    with open(os.path.join(root, name + '.bytes'), 'wb') as handle:
        handle.write(payload)
    os.chmod(os.path.join(root, name + '.bytes'), 0o600)
    return {'present': True, 'uid': 0, 'gid': 0, 'mode': mode, 'size': len(payload),
            'sha256': hashlib.sha256(payload).hexdigest(), 'atimeNs': timestamp, 'mtimeNs': timestamp}
unit_name = 'turingmarket-gate-cleanup.service'
if kind == 'canonical-absent-v1':
    topology = {'kind': kind, 'unitName': unit_name, 'enablement': 'not-found',
                'relatedLinks': [], 'dropIns': []}
    helper = {'present': False}
    unit = {'present': False}
else:
    topology = {'kind': kind, 'unitName': unit_name, 'enablement': 'enabled',
                'relatedLinks': [{'path': 'multi-user.target.wants/' + unit_name,
                                  'target': os.path.join(os.path.dirname(root), 'systemd', unit_name)}],
                'dropIns': []}
    helper = record('helper', 0o555, b'prior-helper\\n')
    unit = record('unit', 0o444, b'prior-unit\\n')
state = {'schemaVersion': 2, 'topology': topology,
         'topologySha256': hashlib.sha256(json.dumps(topology, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
         'helper': helper, 'unit': unit}
with open(os.path.join(root, 'state.json'), 'w', encoding='utf-8') as handle:
    json.dump(state, handle, sort_keys=True, separators=(',', ':'))
    handle.write('\\n')
PY
}

run_restore() {
  local Script="$1"
  local CaseRoot="$2"
  local Backup="$CaseRoot/backup"
  local Helper="$CaseRoot/live/cleanup.sh"
  local Unit="$CaseRoot/systemd/turingmarket-gate-cleanup.service"
  local State="$Backup/state.json"
  local HelperSha UnitSha
  HelperSha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["helper"].get("sha256", "0" * 64))' "$State")"
  UnitSha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["unit"].get("sha256", "0" * 64))' "$State")"
  export TM_FIXTURE_SYSTEMD_ROOT="$CaseRoot/systemd"
  export TM_FIXTURE_SYSTEMCTL_LOG="$CaseRoot/systemctl.log"
  export TM_FIXTURE_BARRIER="$CaseRoot/systemd/turingmarket-gate-cleanup.service.d/00-turingmarket-restore-barrier.conf"
  export TM_CLEANUP_TEST_SYSTEMD_SEARCH_ROOTS="$CaseRoot/systemd:$CaseRoot/run/systemd/system:$CaseRoot/usr/local/lib/systemd/system:$CaseRoot/usr/lib/systemd/system:$CaseRoot/lib/systemd/system"
  python3 "$Script" "$State" "$Backup" "$Helper" "$Unit" "$CaseRoot/systemd" \
    "$CaseRoot/systemd/turingmarket-gate-cleanup.service.d/00-turingmarket-restore-barrier.conf" \
    "$CaseRoot/journal" "$CaseRoot/journal/restore.json" "$CaseRoot/journal/release" \
    "$Root/systemctl" turingmarket-gate-cleanup.service "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$HelperSha" "$UnitSha"
}

for Kind in canonical-absent-v1 canonical-trusted-enabled-v1; do
  for Phase in barrier-armed quiesced helper-restored unit-restored topology-restored converged barrier-cleared; do
    CaseRoot="$Root/$Kind-$Phase"
    make_case "$CaseRoot" "$Kind"
    sed "s/persist_phase('$Phase')/persist_phase('$Phase'); raise SystemExit(86)/" "$Root/restore.py" > "$CaseRoot/interrupted.py"
    if run_restore "$CaseRoot/interrupted.py" "$CaseRoot"; then
      echo "Interruption fixture unexpectedly converged at $Phase" >&2
      exit 1
    fi
    test -f "$CaseRoot/journal/restore.json"
    run_restore "$Root/restore.py" "$CaseRoot"
    test ! -e "$CaseRoot/journal/restore.json"
    test ! -e "$CaseRoot/systemd/turingmarket-gate-cleanup.service.d"
    if [ "$Kind" = canonical-absent-v1 ]; then
      test ! -e "$CaseRoot/live/cleanup.sh"
      test ! -e "$CaseRoot/systemd/turingmarket-gate-cleanup.service"
      test ! -e "$CaseRoot/systemd/multi-user.target.wants/turingmarket-gate-cleanup.service"
    else
      test "$(cat "$CaseRoot/live/cleanup.sh")" = prior-helper
      test "$(cat "$CaseRoot/systemd/turingmarket-gate-cleanup.service")" = prior-unit
      test "$(readlink "$CaseRoot/systemd/multi-user.target.wants/turingmarket-gate-cleanup.service")" = "$CaseRoot/systemd/turingmarket-gate-cleanup.service"
    fi
  done
done

for CrashPoint in link-created link-replaced before-link-directory-fsync; do
  CaseRoot="$Root/intra-phase-$CrashPoint"
  make_case "$CaseRoot" canonical-trusted-enabled-v1
  rm -f -- "$CaseRoot/systemd/multi-user.target.wants/turingmarket-gate-cleanup.service"
  python3 - "$Root/restore.py" "$CaseRoot/interrupted.py" "$CrashPoint" <<'PY'
import sys

source_path, destination_path, crash_point = sys.argv[1:]
source = open(source_path, encoding='utf-8').read()
needles = {
    'link-created': "                os.symlink(canonical_link_target, temporary_name, dir_fd=link_parent_descriptor)\\n",
    'link-replaced': "                os.replace(temporary_name, canonical_name, src_dir_fd=link_parent_descriptor, dst_dir_fd=link_parent_descriptor)\\n",
    'before-link-directory-fsync': (
        "                os.replace(temporary_name, canonical_name, src_dir_fd=link_parent_descriptor, dst_dir_fd=link_parent_descriptor)\\n"
        "            os.fsync(link_parent_descriptor)\\n"
    ),
}
needle = needles[crash_point]
if source.count(needle) != 1:
    raise SystemExit(f'Expected one replay crash injection point for {crash_point}')
replacement = needle + "                raise SystemExit(86)\\n"
if crash_point == 'before-link-directory-fsync':
    replacement = needle.replace(
        "            os.fsync(link_parent_descriptor)\\n",
        "            raise SystemExit(86)\\n            os.fsync(link_parent_descriptor)\\n",
    )
open(destination_path, 'w', encoding='utf-8', newline='\\n').write(source.replace(needle, replacement))
PY
  if run_restore "$CaseRoot/interrupted.py" "$CaseRoot"; then
    echo "Intra-phase interruption unexpectedly converged at $CrashPoint" >&2
    exit 1
  fi
  test -f "$CaseRoot/journal/restore.json"
  run_restore "$Root/restore.py" "$CaseRoot"
  test ! -e "$CaseRoot/journal/restore.json"
  test ! -e "$CaseRoot/systemd/multi-user.target.wants/turingmarket-gate-cleanup.service.restore.next"
  test "$(readlink "$CaseRoot/systemd/multi-user.target.wants/turingmarket-gate-cleanup.service")" = "$CaseRoot/systemd/turingmarket-gate-cleanup.service"
done

WrongResidue="$Root/wrong-residue"
make_case "$WrongResidue" canonical-trusted-enabled-v1
rm -f -- "$WrongResidue/systemd/multi-user.target.wants/turingmarket-gate-cleanup.service"
ln -s /tmp/not-the-cleanup-unit "$WrongResidue/systemd/multi-user.target.wants/turingmarket-gate-cleanup.service.restore.next"
if run_restore "$Root/restore.py" "$WrongResidue"; then
  echo 'Wrong-target cleanup topology residue was accepted' >&2
  exit 1
fi

EffectiveFragment="$Root/effective-fragment"
make_case "$EffectiveFragment" canonical-trusted-enabled-v1
export TM_FIXTURE_FRAGMENT_PATH="$EffectiveFragment/run/systemd/system/turingmarket-gate-cleanup.service"
if run_restore "$Root/restore.py" "$EffectiveFragment"; then
  echo 'Effective fragment substitution was accepted' >&2
  exit 1
fi
unset TM_FIXTURE_FRAGMENT_PATH
test ! -e "$EffectiveFragment/journal/restore.json"
test ! -e "$EffectiveFragment/systemd/turingmarket-gate-cleanup.service.d"

EffectiveDropIn="$Root/effective-dropin"
make_case "$EffectiveDropIn" canonical-trusted-enabled-v1
export TM_FIXTURE_DROPIN_PATHS="$EffectiveDropIn/run/systemd/system/service.d/99-evil.conf"
if run_restore "$Root/restore.py" "$EffectiveDropIn"; then
  echo 'Effective drop-in substitution was accepted' >&2
  exit 1
fi
unset TM_FIXTURE_DROPIN_PATHS
test ! -e "$EffectiveDropIn/journal/restore.json"

EffectiveAlias="$Root/effective-alias"
make_case "$EffectiveAlias" canonical-trusted-enabled-v1
export TM_FIXTURE_NAMES='turingmarket-gate-cleanup.service cleanup-alias.service'
if run_restore "$Root/restore.py" "$EffectiveAlias"; then
  echo 'Effective unit alias was accepted' >&2
  exit 1
fi
unset TM_FIXTURE_NAMES
test ! -e "$EffectiveAlias/journal/restore.json"

GlobalDropIn="$Root/global-dropin"
make_case "$GlobalDropIn" canonical-trusted-enabled-v1
mkdir -p "$GlobalDropIn/run/systemd/system/service.d"
printf '[Service]\\nEnvironment=UNTRUSTED=1\\n' > "$GlobalDropIn/run/systemd/system/service.d/99-evil.conf"
if run_restore "$Root/restore.py" "$GlobalDropIn"; then
  echo 'Global service drop-in outside /etc was accepted' >&2
  exit 1
fi
test ! -e "$GlobalDropIn/journal/restore.json"

WritableParent="$Root/writable-parent"
make_case "$WritableParent" canonical-trusted-enabled-v1
chmod 0777 "$WritableParent/live"
if run_restore "$Root/restore.py" "$WritableParent"; then
  echo 'Writable cleanup parent was accepted' >&2
  exit 1
fi
test ! -e "$WritableParent/journal/restore.json"
test ! -e "$WritableParent/systemd/turingmarket-gate-cleanup.service.d"

SymlinkParent="$Root/symlink-parent"
make_case "$SymlinkParent" canonical-trusted-enabled-v1
mv "$SymlinkParent/live" "$SymlinkParent/live-real"
ln -s "$SymlinkParent/live-real" "$SymlinkParent/live"
if run_restore "$Root/restore.py" "$SymlinkParent"; then
  echo 'Symlinked cleanup parent was accepted' >&2
  exit 1
fi
test ! -e "$SymlinkParent/journal/restore.json"
test ! -e "$SymlinkParent/systemd/turingmarket-gate-cleanup.service.d"

Substitution="$Root/substitution"
make_case "$Substitution" canonical-trusted-enabled-v1
mkdir -p "$Substitution/attacker"
chmod 0755 "$Substitution/attacker"
export TM_FIXTURE_SUBSTITUTE_PARENT="$Substitution/live"
export TM_FIXTURE_SUBSTITUTE_TARGET="$Substitution/attacker"
if run_restore "$Root/restore.py" "$Substitution"; then
  echo 'Cleanup parent substitution was accepted' >&2
  exit 1
fi
unset TM_FIXTURE_SUBSTITUTE_PARENT TM_FIXTURE_SUBSTITUTE_TARGET
test ! -e "$Substitution/journal/restore.json"
test ! -e "$Substitution/systemd/turingmarket-gate-cleanup.service.d"

Unsupported="$Root/unsupported"
mkdir -p "$Unsupported/backup" "$Unsupported/live" "$Unsupported/systemd/multi-user.target.wants"
chmod 0700 "$Unsupported/backup"
chmod 0755 "$Unsupported/live" "$Unsupported/systemd" "$Unsupported/systemd/multi-user.target.wants"
printf 'trusted-helper\\n' > "$Unsupported/live/cleanup.sh"
printf 'trusted-unit\\n' > "$Unsupported/systemd/turingmarket-gate-cleanup.service"
chmod 0555 "$Unsupported/live/cleanup.sh"
chmod 0444 "$Unsupported/systemd/turingmarket-gate-cleanup.service"
if python3 "$Root/backup.py" "$Unsupported/backup" "$Unsupported/live/cleanup.sh" \
  "$Unsupported/systemd/turingmarket-gate-cleanup.service" disabled "$Unsupported/systemd" \
  turingmarket-gate-cleanup.service "$(sha256sum "$Unsupported/live/cleanup.sh" | awk '{print $1}')" \
  "$(sha256sum "$Unsupported/systemd/turingmarket-gate-cleanup.service" | awk '{print $1}')"; then
  echo 'Unsupported disabled topology was accepted' >&2
  exit 1
fi
printf '%s\\n' 'MIGRATION_CLEANUP_REPLAY_FIXTURE_OK'
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /MIGRATION_CLEANUP_REPLAY_FIXTURE_OK/);
});

test('native systemd fixture exposes exact absent and single-link enabled topologies', {
  skip: !nativeSystemdRootAvailable()
}, () => {
  const result = runRootLinuxScript(`
set -euo pipefail
UnitName="turingmarket-cleanup-contract-fixture-$$.service"
Unit="/etc/systemd/system/$UnitName"
Link="/etc/systemd/system/multi-user.target.wants/$UnitName"
RunDropInDir="/run/systemd/system/$UnitName.d"
RunDropIn="$RunDropInDir/99-adversarial.conf"
AliasName="turingmarket-cleanup-contract-alias-$$.service"
Alias="/run/systemd/system/$AliasName"
cleanup() {
  systemctl disable --now "$UnitName" >/dev/null 2>&1 || true
  rm -f -- "$Link" "$Unit" "$Alias" "$RunDropIn"
  rmdir "$RunDropInDir" >/dev/null 2>&1 || true
  rm -rf -- "/etc/systemd/system/$UnitName.d"
  systemctl daemon-reload >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
test "$(systemctl is-enabled "$UnitName" 2>/dev/null || true)" = not-found
test ! -e "$Unit"
test ! -e "$Link"
cat > "$Unit" <<'TM_SYSTEMD_TOPOLOGY_UNIT'
[Unit]
Description=TuringMarket cleanup topology contract fixture

[Service]
Type=oneshot
ExecStart=/bin/true

[Install]
WantedBy=multi-user.target
TM_SYSTEMD_TOPOLOGY_UNIT
chmod 0444 "$Unit"
systemctl daemon-reload
systemctl enable "$UnitName" >/dev/null
test "$(systemctl is-enabled "$UnitName")" = enabled
test "$(systemctl is-active "$UnitName" 2>/dev/null || true)" != active
test -L "$Link"
test "$(readlink "$Link")" = "$Unit"
test "$(find /etc/systemd/system -type l -name "$UnitName" -printf '%p\\n' | wc -l)" = 1
test ! -e "/etc/systemd/system/$UnitName.d"
test "$(systemctl show "$UnitName" --property=FragmentPath --value)" = "$Unit"
test -z "$(systemctl show "$UnitName" --property=DropInPaths --value)"
test "$(systemctl show "$UnitName" --property=Names --value)" = "$UnitName"
mkdir -p "$RunDropInDir"
cat > "$RunDropIn" <<'TM_ADVERSARIAL_DROPIN'
[Service]
Environment=UNTRUSTED_EFFECTIVE_DROPIN=1
TM_ADVERSARIAL_DROPIN
systemctl daemon-reload
test "$(systemctl show "$UnitName" --property=DropInPaths --value)" = "$RunDropIn"
rm -f -- "$RunDropIn"
rmdir "$RunDropInDir"
ln -s "$Unit" "$Alias"
systemctl daemon-reload
Names="$(systemctl show "$UnitName" --property=Names --value)"
case " $Names " in *" $UnitName "*) ;; *) exit 1 ;; esac
case " $Names " in *" $AliasName "*) ;; *) exit 1 ;; esac
rm -f -- "$Alias"
systemctl daemon-reload
test "$(systemctl show "$UnitName" --property=Names --value)" = "$UnitName"
printf '%s\\n' 'NATIVE_SYSTEMD_CANONICAL_TOPOLOGY_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /NATIVE_SYSTEMD_CANONICAL_TOPOLOGY_OK/);
});

test('migration cleanup control contract rejects non-canonical topology and replays every durable restore phase', () => {
  const deploy = read(deployPath);
  const backupMatch = deploy.match(/function Invoke-RemoteBackup[\s\S]*?(?=function Restore-RemoteMigrationGateCleanupControl)/);
  const restoreMatch = deploy.match(/function Restore-RemoteMigrationGateCleanupControl[\s\S]*?(?=function Get-Pm2PersistenceVerifier)/);
  assert.ok(backupMatch, 'remote backup function must exist');
  assert.ok(restoreMatch, 'cleanup control restore function must exist');
  const backup = backupMatch[0];
  const restore = restoreMatch[0];

  assert.match(backup, /canonical-absent-v1/);
  assert.match(backup, /canonical-trusted-enabled-v1/);
  assert.match(backup, /Unsupported cleanup control topology/);
  assert.match(backup, /topologySha256/);
  assert.match(backup, /relatedLinks/);
  assert.match(backup, /dropIns/);
  assert.match(backup, /is-enabled.*not-found|not-found.*is-enabled/s);
  assert.match(backup, /is-enabled.*enabled|enabled.*is-enabled/s);

  assert.match(restore, /restore\.json/);
  assert.match(restore, /schemaVersion/);
  assert.match(restore, /restoreIdentity/);
  assert.match(restore, /backupTopologySha256/);
  assert.match(restore, /phase/);
  assert.match(restore, /os\.fsync/);
  assert.match(restore, /daemon-reload/);
  assert.match(restore, /is-active/);
  assert.match(restore, /is-enabled/);
  assert.match(restore, /relatedLinks/);
  assert.match(restore, /dropIns/);
  assert.match(restore, /phase_rank/);
  assert.match(restore, /barrier-cleared/);
  assert.match(restore, /os\.unlink\(journal_path\)/);
});

test('cleanup control validates PID 1 effective identity and trusted parent chains before first mutation', () => {
  const deploy = read(deployPath);
  const install = functionSource(deploy, 'Install-RemoteMigrationGateCleanup', 'Enter-RemoteDeploymentLock');
  const backup = functionSource(deploy, 'Invoke-RemoteBackup', 'Restore-RemoteMigrationGateCleanupControl');
  const restore = functionSource(deploy, 'Get-MigrationGateCleanupControlRestoreScript', 'Get-Pm2PersistenceVerifier');

  for (const [label, source] of [['install', install], ['backup', backup], ['restore', restore]]) {
    assert.match(source, /\/usr\/bin\/systemctl/,
      `${label} must use the fixed systemctl path for effective-unit verification`);
    assert.match(source, /FragmentPath/,
      `${label} must verify PID 1's effective fragment`);
    assert.match(source, /DropInPaths/,
      `${label} must verify PID 1's effective drop-ins`);
    assert.match(source, /Names/,
      `${label} must reject effective aliases`);
  }
  for (const root of [
    '/etc/systemd/system',
    '/run/systemd/system',
    '/usr/local/lib/systemd/system',
    '/usr/lib/systemd/system',
    '/lib/systemd/system',
  ]) {
    assert.match(restore, new RegExp(root.replaceAll('/', '\\/')),
      `restore must inspect systemd search root ${root}`);
  }
  assert.match(restore, /preflight_parent_identities/);
  assert.match(restore, /O_NOFOLLOW/);
  assert.match(restore, /dir_fd/);
  assert.match(restore, /st_dev[\s\S]*?st_ino/);
  const preflightIndex = restore.indexOf('preflight_parent_identities');
  const journalMutationIndex = restore.indexOf("persist_phase('barrier-armed')");
  assert.ok(preflightIndex >= 0 && journalMutationIndex > preflightIndex,
    'all cleanup-control parent chains must be captured before journal/barrier mutation');
});

test('rollback public enablement fails closed for errors, exits, and termination signals', () => {
  const deploy = read(deployPath);
  const restoreMatch = deploy.match(/function Invoke-RemoteRestore[\s\S]*?(?=function Invoke-RemotePreMutationResume)/);
  assert.ok(restoreMatch, 'remote restore function must exist');
  const restore = restoreMatch[0];

  assert.match(restore, /recover_restore_public_failure\(\)/);
  assert.match(restore, /trap 'recover_restore_public_failure \$\?' ERR EXIT/);
  assert.match(restore, /trap 'recover_restore_public_failure 129' HUP/);
  assert.match(restore, /trap 'recover_restore_public_failure 130' INT/);
  assert.match(restore, /trap 'recover_restore_public_failure 143' TERM/);
  assert.match(restore, /trap - ERR EXIT HUP INT TERM/);
  assert.match(restore, /PublicGuardHelper="\$TrustedSourceBundle\/server\/scripts\/public_release_guard\.sh"/);
  assert.match(restore, /public_release_guard arm[\s\S]*?--controller-pid "\$\$"/);
  assert.match(restore, /public_release_guard close/);
  assert.match(restore, /public_release_guard disarm/);

  const armed = restore.indexOf("trap 'recover_restore_public_failure $?'");
  const publicSwap = restore.indexOf('mv -Tf "$RestorePublicLink" /etc/nginx/sites-enabled/turingmarket');
  const verified = restore.indexOf('record_restore_step public-verified');
  const disarmed = restore.indexOf('trap - ERR EXIT HUP INT TERM', verified);
  assert.ok(armed >= 0 && publicSwap > armed, 'rollback guard must be armed before the public symlink swap');
  assert.ok(verified > publicSwap && disarmed > verified, 'rollback guard must remain armed through durable public verification');
});

test('initial cutover keeps a durable fail-closed public guard through final acceptance checks', () => {
  const deploy = read(deployPath);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'production cutover gate must exist');
  const cutover = cutoverMatch[1];

  assert.match(cutover, /PublicGateGuard="\$LockDir\/public-gate-guard"/);
  assert.match(cutover, /cutover_exit_guard\(\)/);
  assert.match(cutover, /trap 'cutover_exit_guard \$\?' ERR EXIT/);
  assert.match(cutover, /trap 'cutover_exit_guard 129' HUP/);
  assert.match(cutover, /trap 'cutover_exit_guard 130' INT/);
  assert.match(cutover, /trap 'cutover_exit_guard 143' TERM/);
  assert.match(cutover, /PublicGuardHelper="\$TrustedSourceBundle\/server\/scripts\/public_release_guard\.sh"/);
  assert.match(cutover, /public_release_guard arm[\s\S]*?--controller-pid "\$\$"/);
  assert.match(cutover, /public_release_guard close/);
  assert.match(cutover, /public_release_guard disarm/);

  const armedFlag = cutover.indexOf('public_gate_armed=1');
  const closedGuard = cutover.indexOf('public_release_guard close', armedFlag);
  const armedGuard = cutover.indexOf('public_release_guard arm', closedGuard);
  const publicActivation = cutover.indexOf('activate_public_candidate', armedGuard);
  const exactGate = cutover.lastIndexOf('run_exact_public_nginx_gate - 80');
  const finalFacts = cutover.indexOf('assert_final_acceptance_facts', exactGate);
  const disarmedGuard = cutover.indexOf('public_release_guard disarm', finalFacts);
  const disarmedFlag = cutover.indexOf('public_gate_armed=0', disarmedGuard);
  assert.ok(
    armedFlag >= 0 && closedGuard > armedFlag && armedGuard > closedGuard && publicActivation > armedGuard,
    'cutover must initialize a closed state before arming the durable guard and activating public traffic'
  );
  assert.ok(exactGate > publicActivation && finalFacts > exactGate, 'public checks must precede guard completion');
  assert.ok(disarmedGuard > finalFacts && disarmedFlag > disarmedGuard, 'cutover guard may disarm only after durable final verification');
});

test('all public activation paths use the trusted independent watchdog and persistent Nginx start barrier', () => {
  const deploy = read(deployPath);
  const guard = read(publicReleaseGuardPath);
  assert.equal(
    (deploy.match(/PublicGuardHelper="\$TrustedSourceBundle\/server\/scripts\/public_release_guard\.sh"/g) || []).length,
    5,
    'cutover, accepted finalization, rollback, pre-mutation resume, and interrupted takeover must use the same trusted guard'
  );
  assert.equal((deploy.match(/public_release_guard arm/g) || []).length, 4);
  assert.equal((deploy.match(/public_release_guard verify-armed/g) || []).length, 4,
    'each public link swap must be immediately preceded by an active identity check');
  assert.equal((deploy.match(/public_release_guard disarm/g) || []).length, 4);
  for (const link of ['RestorePublicLink', 'ResumePublicLink', 'LockDir/nginx-finalize-new.link', 'LockDir/nginx-public.link']) {
    const escaped = link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      deploy,
      new RegExp(`public_release_guard verify-armed[\\s\\S]{0,500}?mv -Tf "\\$${escaped}" /etc/nginx/sites-enabled/turingmarket`),
      `public link ${link} must swap only after exact active watchdog verification`
    );
  }
  assert.equal(
    (deploy.match(/\/usr\/bin\/env -i PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin \/bin\/bash --noprofile --norc "\$PublicGuardHelper" "\$@"/g) || []).length,
    5,
    'all 0444 trusted guard wrappers must invoke the helper through Bash'
  );
  assert.equal((deploy.match(/90-turingmarket-public-guard\.conf/g) || []).length >= 1, true);
  assert.match(guard, /Restart=on-failure/);
  assert.match(guard, /--property="User=root"/,
    'the transient public watchdog must expose an exact root User property for takeover validation');
  assert.doesNotMatch(guard, /RuntimeMaxSec=5m/);
  assert.match(guard, /verify_armed_guard\(\)/);
  assert.match(guard, /armed\|\$GuardUnit\|\$ControllerPid\|\$ControllerStartTicks\|\$DeadlineEpoch/);
  for (const property of ['Id', 'Names', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath', 'RuntimeMaxUSec']) {
    assert.match(guard, new RegExp(`show_unit_property ${property}`));
  }
  assert.match(
    guard,
    /ReconciledRecord="\$\(run_state_transaction reconcile verified "\$BoundArmedPayload"\)"/
  );
  assert.match(
    guard,
    /"\$BoundArmedPayload"\) verify_armed_guard \|\| return 1 ;;/,
    'disarm must revalidate the exact active watchdog unless a verified residue already converged'
  );
  assert.match(guard, /esac\s*\n\s*write_guard_state verified/);
  assert.match(
    guard,
    /"\$INSTALL"[^\r\n]*"\$MaintenanceConfig"[\s\S]*?"\$SYNC" -f "\$MaintenanceConfig"[\s\S]*?"\$SYNC" -f "\$\(dirname "\$MaintenanceConfig"\)"/
  );
  assert.match(
    guard,
    /"\$MV" -Tf "\$RecoveryLink" "\$SiteLink"[\s\S]*?"\$SYNC" -f "\$\(dirname "\$RecoveryLink"\)"[\s\S]*?"\$SYNC" -f "\$\(dirname "\$SiteLink"\)"/
  );
  const watchdogInactive = guard.indexOf('Public release watchdog did not stop after verification');
  const postWatchdogState = guard.indexOf('PostWatchdogState="$(read_guard_state)"');
  const removeDropIn = guard.indexOf('"$RM" -f -- "$DropIn"', postWatchdogState);
  assert.ok(
    watchdogInactive >= 0 && postWatchdogState > watchdogInactive && removeDropIn > postWatchdogState,
    'disarm must lock-read verified after watchdog exit and before removing the start barrier'
  );
  assert.match(guard, /test "\$PostWatchdogState" = verified[\s\S]*?Public guard state changed after watchdog exit/);
  assert.match(guard, /ExecStartPre=\/bin\/bash --noprofile --norc [^\r\n]*assert-start-allowed/);
  assert.match(guard, /\/bin\/bash --noprofile --norc[\s\S]*?"\$SelfPath" watch/);
  assert.match(guard, /nginx-resume-maintenance\.conf\.next/);
  assert.match(guard, /turingmarket-\(cutover\|restore\|resume\|finalize\)-public-guard/);
});

test('Phase 4 backup and restore bind one verified SQLite and private PPT cache unit', () => {
  const deploy = read(deployPath);
  const backupMatch = deploy.match(/function Invoke-RemoteBackup[\s\S]*?(?=function Invoke-RemoteRestore)/);
  const restoreMatch = deploy.match(/function Invoke-RemoteRestore[\s\S]*?(?=function Invoke-RemoteCandidateCleanup)/);
  assert.ok(backupMatch, 'remote backup function must exist');
  assert.ok(restoreMatch, 'remote restore function must exist');
  const backup = backupMatch[0];
  const restore = restoreMatch[0];

  for (const source of [backup, restore]) {
    assert.match(source, /PptCacheDir="\/var\/lib\/turingmarket\/ppt-cache"/);
    assert.match(source, /database\/turingmarket\.db/);
    assert.match(source, /ppt-cache\.sha256/);
    assert.match(source, /database\.sha256/);
    assert.match(source, /sha256sum --check --status/);
  }
  assert.match(backup, /test ! -L "\$PptCacheDir"/);
  assert.match(backup, /stat -c '%U:%G:%a' "\$PptCacheDir"/);
  assert.match(backup, /ppt-cache\.present/);
  assert.match(backup, /ppt-cache\.absent/);
  assert.match(backup, /if \[ -e "\$PptCacheDir" \] \|\| \[ -L "\$PptCacheDir" \]/);
  assert.match(backup, /cp -a -- "\$PptCacheDir\/\." "\$BackupAbsolute\/ppt-cache\/"/);
  assert.match(backup, /find "\$BackupAbsolute\/ppt-cache"[\s\S]*?-type f[\s\S]*?sha256sum/);
  assert.match(backup, /const backup = new Database\(destination, \{ fileMustExist: true \}\)/);
  assert.match(backup, /backup\.pragma\('journal_mode = DELETE', \{ simple: true \}\)/);
  assert.ok(
    backup.indexOf("backup.pragma('journal_mode = DELETE'") < backup.indexOf("backup.pragma('quick_check'"),
    'backup must normalize WAL mode before opening a single-file rollback contract'
  );

  assert.match(restore, /\[switch\]\$RestoreDatabase/);
  assert.match(restore, /if \(-not \$RestoreDatabase\)/);
  assert.match(restore, /DatabaseStage="\$DatabaseDir\/\.turingmarket\.db\.restore\./);
  assert.match(restore, /PptCacheStage="\$PptCacheParent\/\.ppt-cache\.restore\./);
  assert.match(restore, /rm -f -- "\$DatabasePath-journal" "\$DatabasePath-wal" "\$DatabasePath-shm"/);
  assert.match(restore, /DELETE FROM sessions/);
  assert.match(restore, /SESSIONS_REMAINING=0/);
  assert.match(restore, /ppt-cache\.absent/);
  assert.match(restore, /ppt-cache\.present/);
  assert.match(restore, /record_restore_step cache-origin-restored/);
  assert.match(restore, /rmdir -- "\$PptCacheDir"/);
  assert.match(
    restore,
    /if \[ "\$PptCacheOrigin" = absent \] && \[ ! -e "\$PptCacheDir" \]; then[\s\S]*?install -d -o root -g root -m 0700 "\$PptCacheDir"/
  );
  assert.ok(
    restore.indexOf('install -d -o root -g root -m 0700 "$PptCacheDir"') <
      restore.indexOf('record_restore_step preflight-verified'),
    'rollback replay must recreate the absent-origin exchange peer before mutation steps resume'
  );
  assert.ok(restore.indexOf('DELETE FROM sessions') < restore.indexOf('# RESTORE_PROCESS'));
});

test('Phase 4 restore capacity is proven from the immutable snapshot before a writer lock is acquired', () => {
  const deploy = read(deployPath);
  const capacityMatch = deploy.match(
    /function Assert-RemoteRestoreCapacity \{[\s\S]*?(?=function Invoke-RemoteRestore)/
  );
  assert.ok(capacityMatch, 'remote restore capacity preflight must exist');
  const capacity = capacityMatch[0];

  assert.match(capacity, /TrustedSourceBundle="__TRUSTED_SOURCE_BUNDLE__"/);
  assert.match(capacity, /server\/scripts\/check_cutover_capacity\.py/);
  assert.match(capacity, /sha256sum --check --status SHA256SUMS/);
  assert.match(capacity, /--mode restore/);
  assert.match(capacity, /--restore-snapshot "\$RestoreUnit"/);
  assert.match(capacity, /RESTORE_CAPACITY_OK/);
  assert.match(capacity, /report\.get\('mode'\) != 'restore'/);
  assert.match(capacity, /Invoke-RemoteBash[\s\S]*?-RequireDeploymentLock/);
  assert.doesNotMatch(capacity, /-RequireWriterLock/);

  const manualMatch = deploy.match(/function Invoke-ManualRollback \{[\s\S]*?(?=function Assert-AuthoritativeCheckout)/);
  assert.ok(manualMatch, 'manual rollback function must exist');
  const manual = manualMatch[0];
  assert.ok(
    manual.indexOf('Assert-RemoteRestoreCapacity -BackupPath $BackupPath') <
      manual.indexOf('Enter-RemoteWriterLock'),
    'restore capacity must be accepted before manual rollback closes the writer gate'
  );
});

test('Phase 4 persists the verified PM2 projection before any recovery or cutover reopens public traffic', () => {
  const deploy = read(deployPath);
  const verifierMatch = deploy.match(
    /function Get-Pm2PersistenceVerifier \{[\s\S]*?(?=function Assert-RemoteRestoreCapacity)/
  );
  assert.ok(verifierMatch, 'PM2 persistence verifier must exist');
  assert.match(verifierMatch[0], /persist_pm2_dump\(\)/);
  assert.match(verifierMatch[0], /assert_pm2_startup_service\(\)/);
  assert.match(verifierMatch[0], /systemctl is-enabled --quiet pm2-root\.service/);
  assert.match(verifierMatch[0], /ExecStart=\/usr\/lib\/node_modules\/pm2\/bin\/pm2 resurrect/);
  assert.match(verifierMatch[0], /pm2 save/);
  assert.match(verifierMatch[0], /\/root\/\.pm2\/dump\.pm2/);
  assert.match(verifierMatch[0], /PM2_DUMP_PERSISTED/);
  assert.ok(
    verifierMatch[0].indexOf('assert_pm2_startup_service') < verifierMatch[0].indexOf('pm2 save'),
    'PM2 startup service must be verified before persisting a restart dump'
  );
  const extractFunction = (name, nextName) => {
    const match = deploy.match(new RegExp(`function ${name} \\{[\\s\\S]*?(?=function ${nextName})`));
    assert.ok(match, `${name} function must exist`);
    return match[0];
  };
  const restore = extractFunction('Invoke-RemoteRestore', 'Invoke-RemotePreMutationResume');
  const resume = extractFunction('Invoke-RemotePreMutationResume', 'Get-RemoteDeploymentAcceptanceState');
  const finalize = extractFunction('Invoke-RemoteAcceptedFinalize', 'Invoke-RemoteCandidateCleanup');
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'production cutover gate must exist');
  const cutover = cutoverMatch[1];

  for (const [name, source] of [
    ['rollback', restore],
    ['pre-mutation resume', resume],
    ['accepted finalize', finalize],
    ['cutover', cutover]
  ]) {
    assert.match(source, /__PM2_PERSISTENCE_VERIFIER__/);
    assert.match(source, /\npersist_pm2_dump\r?\n/);
  }

  const callIndex = (source) => source.lastIndexOf('\npersist_pm2_dump\n');
  assert.ok(restore.indexOf('record_restore_step health-verified') < callIndex(restore));
  assert.ok(callIndex(restore) < restore.indexOf('# RESTORE_NGINX'));
  assert.ok(callIndex(resume) < resume.indexOf('mv -Tf "$ResumePublicLink" /etc/nginx/sites-enabled/turingmarket'));
  assert.ok(callIndex(finalize) < finalize.indexOf('nginx-finalize-new.link'));
  assert.ok(cutover.indexOf('LOOPBACK_CANDIDATE_HEALTH_OK') < callIndex(cutover));
  assert.ok(callIndex(cutover) < cutover.lastIndexOf('\nrecord_acceptance_facts\n'));
  assert.equal((deploy.match(/\.Replace\('__PM2_PERSISTENCE_VERIFIER__', \$pm2PersistenceVerifier\)/g) || []).length, 4);
});

test('Phase 4 rollback recreates PM2 from the restored ecosystem without stale managed environment keys', () => {
  const deploy = read(deployPath);
  const verifierMatch = deploy.match(
    /function Get-Pm2PersistenceVerifier \{[\s\S]*?(?=function Assert-RemoteRestoreCapacity)/
  );
  assert.ok(verifierMatch, 'PM2 persistence helper must exist');
  const verifier = verifierMatch[0];
  assert.match(verifier, /restart_pm2_from_ecosystem_exactly\(\)/);
  assert.match(verifier, /pm2 delete turingmarket/);
  assert.match(verifier, /env -u NODE_ENV[\s\S]*?-u PPT_CACHE_DIR[\s\S]*?pm2 start ecosystem\.config\.js/);

  const restore = deploy.match(/function Invoke-RemoteRestore \{[\s\S]*?(?=function Invoke-RemotePreMutationResume)/)?.[0];
  const resume = deploy.match(/function Invoke-RemotePreMutationResume \{[\s\S]*?(?=function Get-RemoteDeploymentAcceptanceState)/)?.[0];
  assert.ok(restore && resume, 'rollback and pre-mutation recovery functions must exist');
  for (const [label, source] of [['rollback', restore], ['pre-mutation recovery', resume]]) {
    assert.match(source, /restart_pm2_from_ecosystem_exactly/);
    assert.doesNotMatch(source, /pm2 restart ecosystem\.config\.js --only turingmarket --update-env/,
      `${label} must not retain removed ecosystem keys through PM2 restart`);
  }
  assert.match(
    resume,
    /if \[ "\$Phase" = mutation-intent \] \|\| \[ "\$Phase" = maintenance-entered \]; then[\s\S]*?curl -fsS http:\/\/localhost:3002\/api\/health[\s\S]*?else\s+restart_pm2_from_ecosystem_exactly\s+fi/,
    'pre-stop recovery must preserve admitted requests while later recovery recreates PM2 exactly'
  );
});

test('Phase 4 validates the authoritative JWT environment before candidate preparation', () => {
  const deploy = read(deployPath);
  const runtimeConfigPath = path.join(platformRoot, 'server', 'config', 'runtime_config.js');
  const verifierMatch = deploy.match(
    /function Assert-RemoteAuthoritativeRuntimeEnvironment \{[\s\S]*?(?=function Assert-RemoteLoopbackIsolationPreflight)/
  );
  assert.ok(verifierMatch, 'authoritative runtime environment verifier must exist');
  const verifier = verifierMatch[0];
  assert.match(verifier, /param\(\[Parameter\(Mandatory = \$true\)\]\[object\]\$DeploymentPlan\)/);
  assert.match(verifier, /GetByRemoteRelativePath/);
  assert.match(verifier, /\.ToBase64\(\)/);
  assert.match(deploy, new RegExp(
    `\\$EXPECTED_TRUSTED_RUNTIME_CONFIG_SHA256\\s*=\\s*"${sha256(runtimeConfigPath)}"`
  ));
  assert.match(verifier, /\$EXPECTED_TRUSTED_RUNTIME_CONFIG_SHA256/);
  assert.match(verifier, /createHash\('sha256'\)/);
  assert.match(verifier, /\/etc\/turingmarket\/turingmarket\.env/);
  assert.match(verifier, /root:root:600:1/);
  assert.doesNotMatch(verifier, /TrustedSourceBundle/);
  assert.match(verifier, /loadPlatformEnvironment/);
  assert.match(verifier, /validateNetworkRuntimeConfig/);
  assert.match(verifier, /AUTHORITATIVE_RUNTIME_ENVIRONMENT_OK/);
  assert.doesNotMatch(verifier, /console\.log\([^\n]*jwtSecret|process\.stdout\.write\([^\n]*jwtSecret/);

  const installIndex = deploy.indexOf('Install-RemoteTrustedProductionSourceGate -DeploymentPlan $deploymentActionPlan');
  const environmentIndex = deploy.indexOf(
    'Assert-RemoteAuthoritativeRuntimeEnvironment -DeploymentPlan $deploymentActionPlan',
    installIndex
  );
  const prepareIndex = deploy.indexOf("$prepareScript = @'", environmentIndex);
  assert.ok(installIndex >= 0 && environmentIndex > installIndex && prepareIndex > environmentIndex,
    'runtime environment must be validated from the pinned deployment plan before candidate preparation');
});

test('Phase 4 checks parser readiness with candidate application code before process restart', () => {
  const deploy = read(deployPath);
  const cutoverIndex = deploy.indexOf('record_phase mutation-intent');
  const installIndex = deploy.indexOf('install_parser_appliance', cutoverIndex);
  const readinessIndex = deploy.indexOf('APPLICATION_PARSER_CHECKED_IN_OK', installIndex);
  const sessionIndex = deploy.indexOf('# INVALIDATE_SESSIONS', readinessIndex);
  const restartIndex = deploy.indexOf('restart_pm2_from_ecosystem_exactly', readinessIndex);
  assert.ok(
    cutoverIndex >= 0 && installIndex > cutoverIndex && readinessIndex > installIndex &&
      sessionIndex > readinessIndex && restartIndex > sessionIndex,
    'candidate application readiness must run after parser installation and before the exact PM2 projection starts'
  );

  const readiness = deploy.slice(installIndex, sessionIndex);
  assert.match(readiness, /DB_PATH="\$DatabasePath" node <<'NODE'/);
  assert.match(readiness, /verifyCheckedInArtifacts/);
  assert.match(readiness, /verifyInstalledParserArtifacts/);
  assert.match(readiness, /readSystemdProperties/);
  assert.match(readiness, /const database = require\('\.\/db'\)/);
  assert.match(readiness, /APPLICATION_DATABASE_MIGRATIONS_OK/);
  assert.match(readiness, /recoverParserAdmissionsInTransaction/);
  assert.match(readiness, /APPLICATION_PARSER_RUNTIME_OK/);
  assert.match(readiness, /APPLICATION_PARSER_SYSTEMD_OK/);
  assert.match(readiness, /APPLICATION_PARSER_ADMISSIONS_OK/);
  assert.match(readiness, /APPLICATION_PARSER_READINESS_PREFLIGHT_OK/);
  assert.ok(
    readiness.indexOf('APPLICATION_DATABASE_MIGRATIONS_OK') <
      readiness.indexOf('recoverParserAdmissionsInTransaction'),
    'candidate database migrations must complete before parser admission recovery'
  );
  assert.doesNotMatch(readiness, /new Database\('\/var\/lib\/turingmarket\/db\/turingmarket\.db'\)/);
  assert.doesNotMatch(readiness, /error\.message|error\.stack/);
});

test('Phase 4 pre-mutation recovery removes a first-install PPT cache before restarting the prior release', () => {
  const deploy = read(deployPath);
  const resumeMatch = deploy.match(/function Invoke-RemotePreMutationResume[\s\S]*?(?=function Get-RemoteDeploymentAcceptanceState)/);
  assert.ok(resumeMatch, 'pre-mutation recovery function must exist');
  const resume = resumeMatch[0];
  assert.match(resume, /ppt-cache\.absent/);
  assert.match(resume, /ppt-cache\.present/);
  assert.match(resume, /find "\$PptCacheDir" -mindepth 1 -print -quit/);
  assert.match(resume, /rmdir -- "\$PptCacheDir"/);
  const cacheRestoreIndex = resume.indexOf('rmdir -- "$PptCacheDir"');
  const processRestartIndex = resume.indexOf('restart_pm2_from_ecosystem_exactly');
  assert.ok(
    cacheRestoreIndex >= 0 && processRestartIndex > cacheRestoreIndex,
    'the prior release must not restart until first-install cache state is restored'
  );
});

test('Phase 4 rollback restores only the quiesced cutover snapshot and reapplies its security overlay', () => {
  const deploy = read(deployPath);
  const restoreMatch = deploy.match(/function Invoke-RemoteRestore[\s\S]*?(?=function Invoke-RemoteCandidateCleanup)/);
  assert.ok(restoreMatch, 'remote restore function must exist');
  const restore = restoreMatch[0];

  assert.match(restore, /RestoreUnit="\$BackupAbsolute\/cutover-snapshot"/);
  assert.match(restore, /test -d "\$RestoreUnit"/);
  assert.match(restore, /cd "\$RestoreUnit"[\s\S]*?sha256sum --check --status SHA256SUMS/);
  assert.match(restore, /sha256sum --check --status security-overlay\.sha256/);
  assert.match(restore, /install -o root -g root -m 0600 "\$RestoreUnit\/database\/turingmarket\.db" "\$DatabaseStage"/);
  assert.match(restore, /TM_SECURITY_OVERLAY="\$RestoreUnit\/security-overlay\.json"/);
  assert.match(restore, /SECURITY_OVERLAY_APPLIED=/);
  assert.match(restore, /rollback-disabled/);
  assert.doesNotMatch(restore, /install -o root -g root -m 0600 "\$BackupAbsolute\/database\/turingmarket\.db"/);
  assert.doesNotMatch(restore, /cp -a -- "\$BackupAbsolute\/ppt-cache\/\." "\$PptCacheStage\/"/);
});

test('Phase 4 security overlay restore is exact and disables restored users absent at cutover', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-security-overlay-'));
  const databasePath = path.join(directory, 'restore.db');
  const overlayPath = path.join(directory, 'security-overlay.json');
  const scriptPath = path.join(directory, 'apply-overlay.js');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));

  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL,
      role TEXT NOT NULL,
      department TEXT,
      api_quota INTEGER NOT NULL
    );
  `);
  const insert = database.prepare(`
    INSERT INTO users (id, username, password_hash, is_active, role, department, api_quota)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(1, 'derrick', 'stale-hash', 0, 'user', 'old', 0);
  insert.run(2, 'operator', 'operator-old', 1, 'admin', 'old', 999);
  insert.run(3, 'removed-admin', 'removed-hash', 1, 'admin', 'ops', 999);
  database.close();

  fs.writeFileSync(overlayPath, JSON.stringify({
    schemaVersion: 1,
    match: ['id', 'username'],
    users: [
      {
        id: 1,
        username: 'derrick',
        password_hash: 'current-hash',
        is_active: 1,
        role: 'admin',
        department: 'sales',
        api_quota: 100
      },
      {
        id: 2,
        username: 'operator',
        password_hash: 'operator-current',
        is_active: 1,
        role: 'user',
        department: null,
        api_quota: 20
      }
    ]
  }), 'utf8');
  fs.writeFileSync(scriptPath, hereDocBody(read(deployPath), 'TM_APPLY_SECURITY_OVERLAY'));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.join(platformRoot, 'server'),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_PATH: path.join(platformRoot, 'server', 'node_modules'),
      TM_RESTORE_DB: databasePath,
      TM_SECURITY_OVERLAY: overlayPath
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /SECURITY_OVERLAY_APPLIED=2/);
  assert.match(result.stdout, /SECURITY_OVERLAY_DISABLED=1/);

  const restored = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(restored.prepare(`
      SELECT id, username, password_hash, is_active, role, department, api_quota
      FROM users
      ORDER BY id
    `).all(), [
      { id: 1, username: 'derrick', password_hash: 'current-hash', is_active: 1, role: 'admin', department: 'sales', api_quota: 100 },
      { id: 2, username: 'operator', password_hash: 'operator-current', is_active: 1, role: 'user', department: null, api_quota: 20 },
      { id: 3, username: 'removed-admin', password_hash: 'removed-hash', is_active: 0, role: 'user', department: 'rollback-disabled', api_quota: 0 }
    ]);
  } finally {
    restored.close();
  }
});

test('Phase 4 rollback persists a source-bound replay journal across every mutation boundary', () => {
  const deploy = read(deployPath);
  const restoreMatch = deploy.match(/function Invoke-RemoteRestore[\s\S]*?(?=function Invoke-RemoteCandidateCleanup)/);
  assert.ok(restoreMatch, 'remote restore function must exist');
  const restore = restoreMatch[0];

  assert.match(restore, /RestoreStateDir="\$LockDir\/restore-v050"/);
  assert.match(restore, /RestoreIdentity="\$RestoreStateDir\/identity"/);
  assert.match(restore, /RestoreStep="\$RestoreStateDir\/step"/);
  assert.match(restore, /ExpectedRestoreIdentity=/);
  assert.match(restore, /record_restore_step\(\)/);
  assert.match(restore, /TM_RESTORE_FAIL_AFTER_STEP/);
  assert.match(restore, /sync -f "\$RestoreStep"/);
  assert.match(restore, /sync -f "\$RestoreStateDir"/);

  const steps = [
    'preflight-verified',
    'maintenance-entered',
    'service-stopped',
    'code-restored',
    'data-staged',
    'database-restored',
    'cache-restored',
    'cache-origin-restored',
    'security-reapplied',
    'sessions-invalidated',
    'process-restored',
    'health-verified',
    'nginx-restored',
    'public-verified'
  ];
  let previous = -1;
  for (const step of steps) {
    const index = restore.indexOf(`record_restore_step ${step}`);
    assert.ok(index > previous, `${step} must be durably ordered in the restore journal`);
    previous = index;
  }
  assert.ok(restore.indexOf('record_restore_step database-restored') > restore.indexOf('mv -f "$DatabaseStage" "$DatabasePath"'));
  assert.ok(restore.indexOf('record_restore_step cache-restored') > restore.indexOf('atomic PPT cache exchange failed'));
  assert.ok(restore.indexOf('record_restore_step security-reapplied') > restore.indexOf('TM_APPLY_SECURITY_OVERLAY'));
  assert.ok(restore.indexOf('record_restore_step health-verified') < restore.indexOf('ROLLBACK_OK'));
});

test('Phase 4 cutover binds the SQLite binary ledger to the exact PPT cache tree', (t) => {
  const deploy = read(deployPath);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  const restoreMatch = deploy.match(/function Invoke-RemoteRestore[\s\S]*?(?=function Invoke-RemotePreMutationResume)/);
  assert.ok(cutoverMatch, 'production cutover gate must exist');
  assert.ok(restoreMatch, 'remote restore function must exist');
  const cutover = cutoverMatch[1];
  const restore = restoreMatch[0];

  assert.match(cutover, /TM_PPT_LEDGER_TOOL/);
  assert.match(cutover, /response_cache_key,response_sha256,response_bytes/);
  assert.match(cutover, /ppt-ledger\.json/);
  assert.match(cutover, /ppt-ledger\.sha256/);
  assert.match(cutover, /PPT_LEDGER_BUILD_OK/);
  assert.ok(cutover.indexOf('PPT_LEDGER_BUILD_OK') < cutover.indexOf('CUTOVER_SNAPSHOT_OK'));
  assert.match(restore, /ppt-ledger\.json/);
  assert.match(restore, /ppt-ledger\.sha256/);
  assert.match(restore, /TM_PPT_LEDGER_MODE=verify/);
  assert.match(restore, /PPT_LEDGER_VERIFY_OK/);
  assert.ok(restore.indexOf('PPT_LEDGER_VERIFY_OK') < restore.indexOf('record_restore_step data-staged'));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ppt-ledger-'));
  const databasePath = path.join(directory, 'ledger.db');
  const cacheRoot = path.join(directory, 'ppt-cache');
  const ledgerPath = path.join(directory, 'ppt-ledger.json');
  const toolPath = path.join(directory, 'verify-ppt-ledger.js');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  fs.mkdirSync(cacheRoot, { mode: 0o700 });

  const cacheKey = crypto.createHash('sha256').update('cache-key').digest('hex');
  const bytes = Buffer.from('ppt-cache-contract', 'utf8');
  const responseSha256 = sha256Buffer(bytes);
  const cacheShard = path.join(cacheRoot, cacheKey.slice(0, 2));
  fs.mkdirSync(cacheShard, { mode: 0o700 });
  fs.writeFileSync(path.join(cacheShard, `${cacheKey}.pptx`), bytes, { mode: 0o600 });
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE request_idempotency (
      id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      response_kind TEXT,
      response_cache_key TEXT,
      response_sha256 TEXT,
      response_bytes INTEGER,
      response_content_type TEXT,
      response_filename TEXT
    );
  `);
  database.prepare(`
    INSERT INTO request_idempotency (
      id,state,response_kind,response_cache_key,response_sha256,response_bytes,
      response_content_type,response_filename
    ) VALUES (1,'completed','binary',?,?,?,?,?)
  `).run(
    cacheKey,
    responseSha256,
    bytes.length,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'proposal.pptx'
  );
  database.close();

  fs.writeFileSync(toolPath, shellHereDocBody(cutover, 'TM_PPT_LEDGER_TOOL'));
  const baseEnvironment = {
    ...process.env,
    NODE_PATH: path.join(platformRoot, 'server', 'node_modules'),
    TM_PPT_LEDGER_DB: databasePath,
    TM_PPT_CACHE_ROOT: cacheRoot,
    TM_PPT_LEDGER_PATH: ledgerPath
  };
  const build = spawnSync(process.execPath, [toolPath], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...baseEnvironment, TM_PPT_LEDGER_MODE: 'build' }
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.match(build.stdout, /PPT_LEDGER_BUILD_OK/);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.deepEqual(ledger, {
    schemaVersion: 1,
    naming: '<first-2>/<response_cache_key>.pptx',
    artifacts: [{
      cacheKey,
      fileName: `${cacheKey.slice(0, 2)}/${cacheKey}.pptx`,
      sha256: responseSha256,
      bytes: bytes.length,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      references: [{ ledgerId: 1, filename: 'proposal.pptx', state: 'completed' }]
    }]
  });
  const verify = spawnSync(process.execPath, [toolPath], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...baseEnvironment, TM_PPT_LEDGER_MODE: 'verify' }
  });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /PPT_LEDGER_VERIFY_OK/);

  fs.writeFileSync(path.join(cacheRoot, 'orphan.pptx'), 'orphan', { mode: 0o600 });
  const orphan = spawnSync(process.execPath, [toolPath], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...baseEnvironment, TM_PPT_LEDGER_MODE: 'verify' }
  });
  assert.notEqual(orphan.status, 0);
  assert.match(orphan.stderr, /PPT cache (?:file|entry) is not represented by SQLite/);

  const legacyRoot = path.join(directory, 'legacy');
  const legacyDatabasePath = path.join(legacyRoot, 'legacy.db');
  const legacyCacheRoot = path.join(legacyRoot, 'ppt-cache');
  const legacyLedgerPath = path.join(legacyRoot, 'ppt-ledger.json');
  fs.mkdirSync(legacyCacheRoot, { recursive: true, mode: 0o700 });
  const legacyDatabase = new Database(legacyDatabasePath);
  legacyDatabase.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  legacyDatabase.close();
  const legacyBuild = spawnSync(process.execPath, [toolPath], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...baseEnvironment,
      TM_PPT_LEDGER_MODE: 'build',
      TM_PPT_LEDGER_DB: legacyDatabasePath,
      TM_PPT_CACHE_ROOT: legacyCacheRoot,
      TM_PPT_LEDGER_PATH: legacyLedgerPath
    }
  });
  assert.equal(legacyBuild.status, 0, legacyBuild.stderr || legacyBuild.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyLedgerPath, 'utf8')), {
    schemaVersion: 1,
    naming: '<first-2>/<response_cache_key>.pptx',
    artifacts: []
  });

  const partialDatabasePath = path.join(legacyRoot, 'partial.db');
  const partialLedgerPath = path.join(legacyRoot, 'partial-ledger.json');
  const partialDatabase = new Database(partialDatabasePath);
  partialDatabase.exec(`
    CREATE TABLE request_idempotency (
      id INTEGER PRIMARY KEY,
      state TEXT NOT NULL
    )
  `);
  partialDatabase.close();
  const partialBuild = spawnSync(process.execPath, [toolPath], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...baseEnvironment,
      TM_PPT_LEDGER_MODE: 'build',
      TM_PPT_LEDGER_DB: partialDatabasePath,
      TM_PPT_CACHE_ROOT: legacyCacheRoot,
      TM_PPT_LEDGER_PATH: partialLedgerPath
    }
  });
  assert.equal(partialBuild.status, 0, partialBuild.stderr || partialBuild.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(partialLedgerPath, 'utf8')).artifacts, []);
});

test('Phase 4 source gate runs checksum-pinned sanitization before two migration rehearsals outside the candidate', () => {
  const deploy = read(deployPath);
  const candidateMatch = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate-only gate must exist');
  const gate = candidateMatch[1];

  assert.match(gate, /MigrationRehearsalRoot="\$LockDir\/migration-rehearsal"/);
  assert.match(gate, /install -d -o root -g root -m 0700 "\$MigrationRehearsalRoot"/);
  assert.match(gate, /command -v systemd-run/);
  assert.match(gate, /MigrationUnit="turingmarket-migration-gate-/);
  const migrationMatch = gate.match(/timeout --signal=KILL 41m systemd-run([\s\S]*?)RehearsalStatus=\$\?/);
  assert.ok(migrationMatch, 'trusted migration transient unit must exist');
  const migration = migrationMatch[0];
  assert.match(migration, /--uid="\$GateUser"/);
  for (const property of [
    'PrivateNetwork=yes',
    'PrivatePIDs=yes',
    'PrivateMounts=yes',
    'ProtectHome=yes',
    'ProtectSystem=strict',
    'NoNewPrivileges=yes',
    'RestrictNamespaces=yes',
    'KillMode=control-group'
  ]) {
    assert.ok(migration.includes(property), `migration sandbox must enforce ${property}`);
  }
  assert.match(migration, /InaccessiblePaths=\/root \/etc\/turingmarket \/var\/lib\/turingmarket\/db \/var\/lib\/turingmarket\/ppt-cache/);
  assert.match(migration, /StandardOutput=file:\$RehearsalStdout/);
  assert.match(migration, /StandardError=file:\$RehearsalStderr/);
  assert.doesNotMatch(migration, /systemd-run[^\n]*(?:--pipe|-P)/);
  assert.doesNotMatch(gate, /HOME="\/root"/);
  assert.doesNotMatch(gate, /TM_REHEARSAL_SOURCE_DB="\$ProductionBackupDb"/);
  assert.match(gate, /TrustedSourceGate="__TRUSTED_SOURCE_GATE__"/);
  assert.match(gate, /TrustedSourceBundle="__TRUSTED_SOURCE_BUNDLE__"/);
  assert.match(gate, /TrustedSourceRuntime="__TRUSTED_SOURCE_RUNTIME__"/);
  assert.match(gate, /sha256sum "\$TrustedSourceGate"/);
  assert.match(gate, /timeout --signal=KILL 41m systemd-run/);
  assert.match(gate, /RuntimeMaxSec=40m/);
  assert.match(gate, /"\$TrustedSourceGate" sanitize-and-verify/);
  assert.match(gate, /--bundle-root "\$TrustedSourceBundle"/);
  assert.match(gate, /--dependency-root "\$TrustedDependencyRoot"/);
  assert.match(gate, /--source "\$TrustedSourceCopy"/);
  assert.match(gate, /--sanitized-source "\$SchemaDb"/);
  assert.match(gate, /--work-dir "\$MigrationWork"/);
  assert.match(gate, /--expected-self-sha256 "\$ExpectedTrustedSourceGateSha256"/);
  assert.match(gate, /--expected-manifest-sha256 "\$ExpectedTrustedSourceManifestSha256"/);
  assert.doesNotMatch(gate, /TM_REHEARSAL_VERIFIER="\$CandidateDir/);
  assert.doesNotMatch(gate, /require\(verifierPath\)/);
  assert.doesNotMatch(gate, /migratedSource\.backup\(secondPath\)/);
  assert.match(gate, /tm-trusted-production-source-verdict-v1/);
  assert.match(gate, /systemctl show "\$MigrationUnit\.service" --property=ControlGroup/);
  assert.match(gate, /cgroup\.procs/);
  assert.match(gate, /PPT_MANIFEST_SHA256_BEFORE/);
  assert.match(gate, /PPT_MANIFEST_SHA256_AFTER/);
  assert.match(gate, /SOURCE_BACKUP_SHA256_AFTER/);
  assert.match(gate, /TRUSTED_SOURCE_SHA256_BEFORE/);
  assert.match(gate, /TRUSTED_SOURCE_SHA256_AFTER/);
  assert.match(gate, /TRUSTED_SOURCE_DEV_INO_BEFORE/);
  assert.match(gate, /TRUSTED_SOURCE_DEV_INO_AFTER/);
  assert.match(gate, /rm -rf -- "\$MigrationRehearsalRoot"/);
  assert.ok(gate.indexOf('sanitize-and-verify') < gate.indexOf("TM_UNPRIVILEGED_GATE"));
});

test('Phase 4 deployment removes candidate sanitizer and report from the trusted verdict data flow', () => {
  const deploy = read(deployPath);
  const candidateMatch = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate-only gate must exist');
  const gate = candidateMatch[1];

  assert.match(gate, /"\$TrustedSourceGate" stage/);
  assert.match(gate, /--candidate-root "\$CandidateDir"/);
  assert.match(gate, /--bundle-root "\$TrustedSourceBundle"/);
  assert.match(gate, /"\$TrustedSourceGate" sanitize-and-verify/);
  assert.match(gate, /--uid="\$GateUser" --gid="\$GateUser"/);
  assert.match(gate, /PrivateNetwork=yes/);
  assert.match(gate, /ReadOnlyPaths=\$CandidateDir \$TrustedSourceInputRoot \$TrustedSourceBundle/);
  assert.match(gate, /ReadWritePaths=\$TestRoot/);
  assert.match(gate, /InaccessiblePaths=[^\n]*\$BackupAbsolute/);
  assert.match(gate, /TrustedSourceInputBase="\/run\/turingmarket-production-source-trust"/);
  assert.match(gate, /TrustedSourceInputRoot="\$TrustedSourceInputBase\/deployment-__STAMP__"/);
  assert.doesNotMatch(gate, /TrustedSourceInputRoot="\$RemoteRoot\//);
  assert.match(gate, /install -d -o root -g "\$GateUser" -m 0710 "\$TrustedSourceInputBase"/);
  assert.match(gate, /chmod 0510 "\$TrustedSourceInputRoot"/);
  assert.match(gate, /stat -c '%U:%G:%a:%h' "\$TrustedSourceCopy"\)" = "root:\$GateUser:440:1"/);
  assert.match(gate, /runuser -u "\$GateUser" -- test ! -r "\$TrustedSourceInputRoot"/);
  assert.match(gate, /runuser -u "\$GateUser" -- test -r "\$TrustedSourceCopy"/);
  assert.doesNotMatch(gate, /node "\$CandidateDir\/server\/scripts\/sanitize_production_shape\.js"/);
  assert.doesNotMatch(gate, /SanitizerUnit|SanitizerSource|SanitizerOutput|SanitizerStatus/);
  assert.doesNotMatch(gate, /--manifest "\$CandidateDir\/server\/scripts\/sanitization_manifest\.json"/);
  assert.match(gate, /install -o root -g "\$GateUser" -m 0440 "\$ProductionBackupDb" "\$TrustedSourceCopy"/);
  assert.match(gate, /--source "\$TrustedSourceCopy"/);
  assert.doesNotMatch(gate, /--source "\$ProductionBackupDb"/);
  assert.doesNotMatch(gate, /TM_SANITIZER_REPORT/);
  assert.ok(gate.indexOf('sanitize-and-verify') < gate.indexOf('TM_UNPRIVILEGED_GATE'));
  assert.match(gate, /SOURCE_BACKUP_SHA256_BEFORE[\s\S]*?SOURCE_BACKUP_SHA256_AFTER/);
  assert.match(gate, /test "\$SOURCE_BACKUP_SHA256_BEFORE" = "\$SOURCE_BACKUP_SHA256_AFTER"/);
  assert.match(gate, /runuser -u "\$GateUser" -- test ! -r "\$ProductionBackupDb"/);
  assert.doesNotMatch(gate, /TM_BUILD_SANITIZED_SCHEMA_DB/);
});

test('candidate dependency and test writes are confined to a verified aggregate byte and inode bounded tmpfs', () => {
  const deploy = read(deployPath);
  const candidateMatch = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate-only gate must exist');
  const gate = candidateMatch[1];

  assert.match(gate, /TestRootMaxBytes="6442450944"/);
  assert.match(gate, /TestRootMaxInodes="262144"/);
  assert.match(gate, /mount -t tmpfs -o "nodev,nosuid,size=\$TestRootMaxBytes,nr_inodes=\$TestRootMaxInodes/);
  assert.match(gate, /findmnt -n -o FSTYPE --target "\$TestRoot"/);
  assert.match(gate, /ReleaseTraversalRelaxed=0/);
  assert.match(gate, /chmod 0711 "\$ReleaseRoot"/);
  assert.match(gate, /ReleaseTraversalRelaxed=1/);
  assert.match(gate, /chmod 0711 "\$ReleaseRoot\/tmp"/);
  assert.match(gate, /runuser -u "\$GateUser" -- test ! -r "\$CandidateDir"/);
  assert.match(gate, /runuser -u "\$GateUser" -- test -d "\$DependencyStageRoot"/);
  assert.match(gate, /restore_release_traversal\(\)/);
  assert.match(gate, /ReleaseRootValid=0/);
  assert.match(gate, /ReleaseTmpValid=0/);
  assert.match(
    gate,
    /if \[ "\$ReleaseRootValid" = "1" \]; then\s+if \[ -e "\$ReleaseRoot\/tmp" \] \|\| \[ -L "\$ReleaseRoot\/tmp" \]; then/
  );
  assert.match(gate, /chmod 0700 "\$ReleaseRoot\/tmp"/);
  assert.match(gate, /chmod 0700 "\$ReleaseRoot"/);
  assert.match(
    gate,
    /if test -d "\$ReleaseRoot" &&\s+test ! -L "\$ReleaseRoot" &&\s+test "\$\(stat -c '%U:%G:%a' "\$ReleaseRoot" 2>\/dev\/null\)" = "root:root:700" &&\s+test -d "\$ReleaseRoot\/tmp" &&\s+test ! -L "\$ReleaseRoot\/tmp" &&\s+test "\$\(stat -c '%U:%G:%a' "\$ReleaseRoot\/tmp" 2>\/dev\/null\)" = "root:root:700"; then\s+rmdir -- "\$ReleaseRoot\/tmp" \|\| CleanupStatus=1\s+else\s+CleanupStatus=1\s+fi/
  );
  assert.match(gate, /df -B1 --output=size "\$TestRoot"/);
  assert.match(gate, /df --output=itotal "\$TestRoot"/);
  assert.doesNotMatch(gate, /df -i --output=itotal/);
  assert.match(gate, /test "\$ActualTestRootBytes" -le "\$TestRootMaxBytes"/);
  assert.match(gate, /test "\$ActualTestRootInodes" -le "\$TestRootMaxInodes"/);
  assert.match(gate, /DependencyCopyByteReserveFloor="536870912"/);
  assert.match(gate, /DependencyCopyInodeReserveFloor="16384"/);
  assert.match(gate, /du -sb --apparent-size -- "\$DependencyRoot\/node_modules" "\$DependencyServerRoot\/node_modules"/);
  assert.match(gate, /find "\$DependencyRoot\/node_modules" "\$DependencyServerRoot\/node_modules" -xdev -printf '\.'/);
  assert.match(gate, /find "\$DependencyRoot\/node_modules" "\$DependencyServerRoot\/node_modules" -xdev -type f -links \+1 -print -quit/);
  assert.match(gate, /TargetBlockSize="\$\(stat -f -c '%S' "\$CandidateDir"\)"/);
  assert.match(gate, /os\.listxattr\(path, follow_symlinks=False\)/);
  assert.match(gate, /allocated_bytes \+= max\(block_size, \(\(status\.st_size \+ block_size - 1\) \/\/ block_size\) \* block_size\)/);
  assert.match(gate, /test "\$DependencyCopyMeasuredInodes" = "\$DependencyCopyInodes"/);
  assert.match(gate, /DependencyCopyByteBase="\$DependencyCopyAllocatedBytes"/);
  assert.match(gate, /if \[ "\$DependencyCopyByteBase" -lt "\$TestRootMaxBytes" \]; then[\s\S]*?DependencyCopyByteBase="\$TestRootMaxBytes"/);
  assert.match(gate, /DependencyCopyInodeBase="\$DependencyCopyInodes"/);
  assert.match(gate, /if \[ "\$DependencyCopyInodeBase" -lt "\$TestRootMaxInodes" \]; then[\s\S]*?DependencyCopyInodeBase="\$TestRootMaxInodes"/);
  assert.match(gate, /df -B1 --output=avail "\$CandidateDir"/);
  assert.match(gate, /df --output=iavail "\$CandidateDir"/);
  assert.doesNotMatch(gate, /df -i --output=iavail/);
  assert.match(gate, /test "\$TargetAvailableBytes" -ge "\$DependencyCopyRequiredBytes"/);
  assert.match(gate, /test "\$TargetAvailableInodes" -ge "\$DependencyCopyRequiredInodes"/);
  assert.match(gate, /cleanup_candidate_dependency_copy\(\)/);
  assert.match(gate, /if \[ "\$CleanupStatus" = "0" \]; then DependencyCopyCleanupArmed=0; fi/);
  assert.match(gate, /DependencyCopyCleanupArmed=1[\s\S]*?cp -a -- "\$DependencyRoot\/node_modules"/);
  assert.match(gate, /cleanup_test_root\(\) \{[\s\S]*?PreserveCandidateDependencies="\$\{1:-0\}"/);
  assert.match(gate, /if \[ "\$PreserveCandidateDependencies" != "1" \]; then[\s\S]*?cleanup_candidate_dependency_copy/);
  assert.match(gate, /if ! cleanup_test_root 1; then[\s\S]*?cleanup_candidate_dependency_copy \|\| true[\s\S]*?exit 1[\s\S]*?fi[\s\S]*?DependencyCopyCleanupArmed=0/);
  assert.match(gate, /trap 'cleanup_candidate_gate \$\?' EXIT/);
  assert.match(gate, /umount -- "\$TestRoot"/);
  assert.match(gate, /mountpoint -q "\$TestRoot"/);
  assert.match(gate, /unmount_test_root\(\) \{[\s\S]*?for _attempt in \$\(seq 1 50\)[\s\S]*?findmnt -n -o FSTYPE --mountpoint "\$TestRoot"[\s\S]*?test "\$TestRootFsType" = "tmpfs"[\s\S]*?umount -- "\$TestRoot"[\s\S]*?sleep 0\.2/);
  assert.doesNotMatch(gate, /umount\s+(?:--lazy|-l)\b/);
  assert.ok(
    gate.indexOf('ReleaseTraversalRelaxed=1') <
      gate.indexOf('chmod 0711 "$ReleaseRoot"') &&
      gate.indexOf('chmod 0711 "$ReleaseRoot"') <
        gate.indexOf('chmod 0711 "$ReleaseRoot/tmp"') &&
      gate.indexOf('chmod 0711 "$ReleaseRoot/tmp"') <
      gate.indexOf('systemd-run --quiet --wait --pipe --unit="$DependencyUnit"'),
    'candidate release traversal cleanup must be armed before admission and before the unprivileged dependency unit starts'
  );
  assert.ok(gate.indexOf('mount -t tmpfs') < gate.indexOf('npm ci --ignore-scripts'));
  assert.ok(gate.indexOf('test "$TargetAvailableBytes" -ge "$DependencyCopyRequiredBytes"') < gate.indexOf('cp -a -- "$DependencyRoot/node_modules"'));
  assert.ok(gate.lastIndexOf('\nif ! cleanup_test_root 1; then\n') > gate.indexOf('TM_UNPRIVILEGED_GATE'));
});

test('candidate tmpfs cleanup retries a verified busy mount without lazy unmount', {
  skip: spawnSync('bash', ['--version'], { encoding: 'utf8' }).status !== 0
}, () => {
  const deploy = read(deployPath);
  const candidateMatch = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate-only gate must exist');
  const functionMatch = candidateMatch[1].match(/unmount_test_root\(\) \{\r?\n([\s\S]*?)\r?\n\}\r?\n\r?\ncleanup_test_root\(\)/);
  assert.ok(functionMatch, 'candidate tmpfs unmount helper must exist');
  const harness = `
set -euo pipefail
TestRoot=/verified/candidate/tmpfs
AttemptFile="$(mktemp)"
trap 'rm -f "$AttemptFile"' EXIT
printf '0\\n' > "$AttemptFile"
mountpoint() {
  test "$1" = "-q"
  test "$2" = "$TestRoot"
  test "$(cat "$AttemptFile")" -lt 3
}
findmnt() {
  test "$1 $2 $3 $4" = "-n -o FSTYPE --mountpoint"
  test "$5" = "$TestRoot"
  printf 'tmpfs\\n'
}
umount() {
  test "$1" = "--"
  test "$2" = "$TestRoot"
  Attempt="$(( $(cat "$AttemptFile") + 1 ))"
  printf '%s\\n' "$Attempt" > "$AttemptFile"
  test "$Attempt" -ge 3
}
sleep() {
  test "$1" = "0.2"
}
unmount_test_root() {
${functionMatch[1]}
}
unmount_test_root
test "$(cat "$AttemptFile")" = "3"
printf 'BUSY_TMPFS_RETRY_OK\\n'
`;
  const result = spawnSync('bash', ['-s'], { input: harness, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /BUSY_TMPFS_RETRY_OK/);
});

test('Phase 4 candidate gate remains valid Bash after isolation hardening', {
  skip: spawnSync('bash', ['--version'], { encoding: 'utf8' }).status !== 0
}, () => {
  const candidateMatch = read(deployPath).match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate-only gate must exist');
  const result = spawnSync('bash', ['-n'], {
    encoding: 'utf8',
    input: candidateMatch[1],
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Phase 4 refuses to continue unless candidate validation durably commits candidate-ready', () => {
  const deploy = read(deployPath);
  const main = deploy.slice(deploy.indexOf('Write-Host "TuringMarket guarded deploy starting"'));
  const candidate = main.indexOf('Invoke-RemoteBash -Script $candidateGate');
  const assertion = main.indexOf('Assert-RemoteCandidateReady', candidate);
  const parser = main.indexOf('Invoke-RemoteParserCandidatePreparation', candidate);
  assert.ok(candidate >= 0, 'candidate validation invocation must exist');
  assert.ok(assertion > candidate, 'candidate-ready must be asserted after candidate validation');
  assert.ok(parser > assertion, 'parser preparation must remain blocked behind candidate-ready');
});

test('Phase 4 candidate-ready postcondition rejects an uncommitted remote phase', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(['Assert-RemoteCandidateReady'], String.raw`
$script:ObservedPhase = 'locked'
function Get-RemoteDeploymentPhase {
  param([switch]$DeploymentLockOnly)
  if (-not $DeploymentLockOnly) { throw 'Candidate readiness must use the lifecycle lock only' }
  return $script:ObservedPhase
}
$rejected = $false
try { Assert-RemoteCandidateReady } catch { $rejected = $true }
if (-not $rejected) { throw 'A non-ready candidate phase was accepted' }
$script:ObservedPhase = 'candidate-ready'
Assert-RemoteCandidateReady
Write-Output 'CANDIDATE_READY_POSTCONDITION_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /CANDIDATE_READY_POSTCONDITION_OK/);
});

test('Task 12 deploy validates an isolated candidate and atomically exchanges it while PM2 is stopped', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /\$remoteCandidateDir\s*=\s*"\$remoteReleaseRoot\/platform"/);
  const pinnedInputMatch = deploy.match(/function Invoke-NativeWithPinnedInput[\s\S]*?(?=function Assert-ImmutableDeploymentActionPlan)/);
  assert.ok(pinnedInputMatch, 'pinned native-input function must exist');
  assert.match(pinnedInputMatch[0], /\$Record\.CopyTo\(\$process\.StandardInput\.BaseStream\)/);
  const uploadMatch = deploy.match(/function Invoke-PinnedDeploymentUpload[\s\S]*?(?=function Assert-TrustedProductionSourceArtifacts)/);
  assert.ok(uploadMatch, 'pinned deployment upload function must exist');
  const upload = uploadMatch[0];
  assert.match(upload, /\$Record -isnot \[PinnedDeploymentActionRecord\]/);
  assert.ok(upload.includes("if ($Record.RemoteRelativePath -notmatch '^[A-Za-z0-9._/@-]+$' -or $Record.RemoteRelativePath -match '(^|/)\\.\\.?(/|$)') {"));
  assert.ok(upload.includes("if ($Record.ExpectedSha256 -notmatch '^[0-9a-f]{64}$') {"));
  assert.ok(upload.includes(`$remotePath = "$($RemoteRoot.TrimEnd('/'))/$($Record.RemoteRelativePath)"`));
  assert.match(upload, /Invoke-NativeWithPinnedInput\s+`\r?\n\s*-Record \$Record\s+`/);
  assert.doesNotMatch(upload, /\bSourcePath\b|\bscp(?:\.exe)?\b/i);
  assert.doesNotMatch(
    upload,
    /\b(?:Get-Content|Copy-Item|Get-Item|Resolve-Path)\b|\[(?:System\.)?IO\.File\]::(?:Open|OpenRead|ReadAllBytes|ReadAllText)\b|\bNew-Object\s+(?:System\.)?IO\.FileStream\b/i
  );
  assert.match(deploy, /foreach \(\$record in \$deploymentActionPlan\.Records\) \{\s*Invoke-PinnedDeploymentUpload -Record \$record -RemoteRoot \$remoteReleaseRoot\s*\}/);
  assert.doesNotMatch(upload, /\$REMOTE_DIR\b/);
  assert.doesNotMatch(deploy, /Invoke-PinnedDeploymentUpload\s+-Record\s+\$\w+\s+-RemoteRoot\s+\$REMOTE_DIR\b/);
  assert.match(deploy, /renameat2/);
  assert.match(deploy, /RENAME_EXCHANGE/);
  assert.match(deploy, /pm2 stop turingmarket[\s\S]*?renameat2[\s\S]*?restart_pm2_from_ecosystem_exactly/);
  assert.match(deploy, /TM_DISABLE_DOTENV=1/);
  assert.match(deploy, /SCHEMA_RUNTIME_DB="\$SCHEMA_RUNTIME_DIR\/schema\.db"/);
  assert.match(deploy, /install -m 0600 "\$SCHEMA_DB" "\$SCHEMA_RUNTIME_DB"/);
  assert.match(deploy, /DB_PATH="\$SCHEMA_RUNTIME_DB"/);
  assert.match(deploy, /\^\[A-Za-z0-9\]\[A-Za-z0-9\.-\]\{0,252\}\$/);
});

test('production replay reuses the server JWT runtime contract before database or request work', () => {
  const deploy = read(deployPath);
  const start = deploy.indexOf("const environmentPath = fs.realpathSync(process.env.TM_REPLAY_ENV);");
  const shellEnd = deploy.lastIndexOf('    "$NodeBin" <<\'NODE\'', start);
  const shellStart = deploy.lastIndexOf('  cd "$LiveDir/server"', shellEnd);
  const end = deploy.indexOf('const probePath = process.env.TM_REPLAY_PROBE;', start);
  assert.ok(start !== -1 && end > start, 'production replay environment preflight must exist');
  const replayPreflight = deploy.slice(start, end);

  assert.ok(shellStart !== -1 && shellEnd > shellStart, 'production replay shell environment must exist');
  assert.match(deploy.slice(shellStart, shellEnd), /env -i\s+\\[\s\S]*?NODE_ENV=production\s+\\/);
  assert.match(replayPreflight, /require\('dotenv'\)\.config\(\{ path: environmentPath, override: true \}\)/);
  assert.match(replayPreflight, /require\('\.\/config\/runtime_config'\)/);
  assert.match(replayPreflight, /validateNetworkRuntimeConfig\(process\.env\)/);
  assert.ok(
    replayPreflight.indexOf("require('dotenv').config") < replayPreflight.indexOf("require('./config/runtime_config')"),
    'authoritative environment must load before the shared JWT runtime contract executes'
  );
  assert.doesNotMatch(replayPreflight, /jwtSecret\.length|please-change|Production JWT secret is unavailable/);

  const validation = deploy.indexOf('validateNetworkRuntimeConfig(process.env)', start);
  const databaseMutation = deploy.indexOf('const database = new Database(', validation);
  const requestWork = deploy.indexOf('const first = await request(requestHeaders, body);', validation);
  assert.ok(validation !== -1 && databaseMutation > validation, 'JWT validation must precede replay database access');
  assert.ok(requestWork > validation, 'JWT validation must precede replay HTTP work');
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
  assert.equal((deploy.match(/\$LockDir\/phase\.next/g) || []).length, 3, 'only the writer-protected cutover may write, fsync, and rename an existing phase');
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
  assert.match(cutoverMatch[1], /trap 'cutover_exit_guard \$\?' ERR EXIT/);
  assert.match(cutoverMatch[1], /cutover_exit_guard\(\)[\s\S]*?release_writer/);
  assert.ok(cutoverMatch[1].indexOf('mutation-intent') < cutoverMatch[1].indexOf('cp --'), 'uncertain phase precedes the first production mutation');
  assert.ok(cutoverMatch[1].indexOf('mutation-started') > cutoverMatch[1].indexOf('CUTOVER_SNAPSHOT_OK'), 'started phase follows the quiesced rollback snapshot');
  assert.ok(cutoverMatch[1].indexOf('mutation-started') > cutoverMatch[1].indexOf('pm2 stop turingmarket'), 'started phase follows verified PM2 shutdown');
  assert.ok(cutoverMatch[1].indexOf('cutover-complete') > cutoverMatch[1].indexOf('SESSIONS_REMAINING=0'), 'completion phase follows all production gates');
  assert.match(deploy, /catch\s*\{[\s\S]*?Invoke-DeploymentFailureRecovery\s+-BackupPath\s+\$backupDir/);
  assert.equal((deploy.match(/Enter-RemoteDeploymentLock/g) || []).length >= 3, true, 'function plus deploy and rollback lock acquisition');
  assert.equal((deploy.match(/Exit-RemoteDeploymentLock/g) || []).length >= 3, true, 'function plus success and handled-failure release');
});

test('Phase 4 cutover invalidates every session before the candidate service starts', () => {
  const deploy = read(deployPath);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'production cutover gate must exist');
  const cutover = cutoverMatch[1];
  const sessionIndex = cutover.indexOf('DELETE FROM sessions');
  const restartIndex = cutover.indexOf('restart_pm2_from_ecosystem_exactly');

  assert.ok(sessionIndex > cutover.indexOf('pm2 stop turingmarket'), 'sessions clear only after writers stop');
  assert.ok(restartIndex > sessionIndex, 'candidate must not start before sessions are cleared');
  assert.match(cutover, /SESSIONS_REMAINING=0/);
  assert.doesNotMatch(cutover, /__INVALIDATE_SESSIONS__/);
});

test('Phase 4 cutover quiesces traffic and writers before replacing the stale rollback snapshot', () => {
  const deploy = read(deployPath);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'production cutover gate must exist');
  const cutover = cutoverMatch[1];

  const maintenanceIndex = cutover.indexOf('ALL_TRAFFIC_MAINTENANCE_OK');
  const stopIndex = cutover.indexOf('pm2 stop turingmarket');
  const checkpointIndex = cutover.indexOf('wal_checkpoint(TRUNCATE)');
  const snapshotIndex = cutover.indexOf('CUTOVER_SNAPSHOT_OK');
  const mutationIndex = cutover.indexOf('record_phase mutation-started');
  const exchangeIndex = cutover.indexOf('RENAME_EXCHANGE');
  assert.ok(maintenanceIndex >= 0, 'cutover must prove all-traffic maintenance');
  assert.ok(stopIndex > maintenanceIndex, 'maintenance must close admission before PM2 stops');
  assert.ok(checkpointIndex > stopIndex, 'WAL checkpoint must run after all writers stop');
  assert.ok(snapshotIndex > checkpointIndex, 'fresh DB/cache snapshot must follow WAL quiescence');
  assert.ok(mutationIndex > snapshotIndex, 'production mutation cannot start before the fresh snapshot is durable');
  assert.ok(exchangeIndex > mutationIndex, 'release exchange follows durable mutation state');

  assert.match(cutover, /return 503/);
  assert.match(cutover, /Retry-After/);
  assert.match(cutover, /for request_path in \/api\/health \/api\/auth\/login \/m0; do[\s\S]*?expect_maintenance 503 "\$request_path"/);
  assert.match(cutover, /PM2_WRITERS_STOPPED/);
  assert.match(cutover, /command -v ss/);
  assert.match(cutover, /ss -H -ltnp/);
  assert.match(cutover, /TM_LIVE_DIR="\$LiveDir" node/);
  assert.match(cutover, /pm_exec_path/);
  assert.match(cutover, /A live-release PM2 writer survived shutdown/);
  assert.match(cutover, /CutoverSnapshot="\$BackupAbsolute\/cutover-snapshot"/);
  assert.match(cutover, /cache_manifest\(\) \{\s*local root="\$1"/);
  assert.match(cutover, /security-overlay\.json/);
  assert.match(cutover, /password_hash,is_active,role,department,api_quota/);
  assert.match(cutover, /database\.sha256/);
  assert.match(cutover, /ppt-cache\.sha256/);
  assert.match(cutover, /sha256sum --check --status/);
});

test('Phase 4 accepted marker is durable before public traffic is restored', () => {
  const deploy = read(deployPath);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'production cutover gate must exist');
  const cutover = cutoverMatch[1];
  const loopbackHealthIndex = cutover.indexOf('LOOPBACK_CANDIDATE_HEALTH_OK');
  const acceptedWriteIndex = cutover.indexOf('record_phase accepted');
  const acceptedSyncIndex = cutover.indexOf('ACCEPTED_MARKER_DURABLE');
  const publicReloadIndex = cutover.lastIndexOf('activate_public_candidate');

  assert.ok(loopbackHealthIndex >= 0, 'candidate must pass loopback health before acceptance');
  assert.ok(acceptedWriteIndex > loopbackHealthIndex, 'accepted phase follows private health');
  assert.ok(acceptedSyncIndex > acceptedWriteIndex, 'accepted marker must be fsynced');
  assert.ok(publicReloadIndex > acceptedSyncIndex, 'public traffic resumes only after durable acceptance');
  assert.ok(cutover.indexOf('record_phase cutover-complete') > publicReloadIndex);
  assert.match(cutover, /PUBLIC_TRAFFIC_RESTORED/);
  assert.match(cutover, /AcceptedMarker="\$LockDir\/accepted"/);
  assert.match(cutover, /sync -f "\$AcceptedMarker"/);
  assert.match(cutover, /sync -f "\$LockDir"/);
});

test('Phase 4 cutover gate remains valid Bash after snapshot and acceptance hardening', {
  skip: spawnSync('bash', ['--version'], { encoding: 'utf8' }).status !== 0
}, () => {
  const cutoverMatch = read(deployPath).match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'production cutover gate must exist');
  const result = spawnSync('bash', ['-n'], {
    encoding: 'utf8',
    input: cutoverMatch[1],
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Phase 4 rollback and recovery gates remain valid Bash', {
  skip: spawnSync('bash', ['--version'], { encoding: 'utf8' }).status !== 0
}, () => {
  const deploy = read(deployPath);
  for (const [name, nextName] of [
    ['Install-RemoteMigrationGateCleanup', 'Enter-RemoteDeploymentLock'],
    ['Invoke-RemoteBackup', 'Restore-RemoteMigrationGateCleanupControl'],
    ['Restore-RemoteMigrationGateCleanupControl', 'Get-Pm2PersistenceVerifier'],
    ['Invoke-RemoteRestore', 'Invoke-RemotePreMutationResume'],
    ['Invoke-RemotePreMutationResume', 'Invoke-RemoteAcceptedFinalize'],
    ['Invoke-RemoteAcceptedFinalize', 'Invoke-RemoteCandidateCleanup'],
    ['Invoke-RemoteCandidateCleanup', 'Invoke-DeploymentFailureRecovery']
  ]) {
    const expression = new RegExp(`function ${name} \\{[\\s\\S]*?(?=function ${nextName})`);
    const functionMatch = deploy.match(expression);
    assert.ok(functionMatch, `${name} function must exist`);
    const scriptMatch = functionMatch[0].match(/\$remoteScript\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
    assert.ok(scriptMatch, `${name} remote Bash body must exist`);
    const result = spawnSync('bash', ['-n'], {
      encoding: 'utf8',
      input: scriptMatch[1],
      timeout: 30_000
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`);
  }
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

test('trusted source stale sweep removes interrupted copies without reading production or backup paths', (t) => {
  const deploy = read(deployPath);
  const sweepFunction = deploy.match(/function Invoke-RemoteTrustedSourceInputSweep \{[\s\S]*?\r?\n\}/);
  assert.ok(sweepFunction, 'the deployment script must define the trusted source stale sweep');
  assert.match(sweepFunction[0], /\/run\/turingmarket-production-source-trust/);
  assert.match(sweepFunction[0], /TM_TRUSTED_SOURCE_SWEEP/);
  assert.match(sweepFunction[0], /-RequireDeploymentLock/);
  assert.doesNotMatch(sweepFunction[0], /Production(?:Live|Backup)Db|BackupPath|\/root|\/var\/lib\/turingmarket\/db/);
  assert.match(deploy, /python3 - "\$TrustedSourceInputBase" 0 "\$GateGroupGid" 0710 0700,0510 0440/);

  const python = ['python', 'python3'].find((command) => (
    spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0
  ));
  if (!python) return t.skip('Python is unavailable');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-source-sweep-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const trustRoot = path.join(directory, 'trust-root');
  const interruptedRoot = path.join(trustRoot, 'deployment-20260731-120000');
  const completeRoot = path.join(trustRoot, 'deployment-20260731-120001');
  const sourceCopy = path.join(completeRoot, 'source.db');
  const liveDatabase = path.join(directory, 'live-production.db');
  const backupDatabase = path.join(directory, 'rollback-backup.db');
  fs.mkdirSync(interruptedRoot, { recursive: true });
  fs.mkdirSync(completeRoot);
  fs.writeFileSync(sourceCopy, 'stale immutable source bytes');
  fs.writeFileSync(liveDatabase, 'live bytes must remain private');
  fs.writeFileSync(backupDatabase, 'backup bytes must remain private');

  const [rootMetadata, interruptedMetadata, completeMetadata, sourceMetadata] = pythonFileMetadata(
    python,
    [trustRoot, interruptedRoot, completeRoot, sourceCopy]
  );
  const runModes = [...new Set([interruptedMetadata.mode, completeMetadata.mode])].join(',');
  const scriptPath = path.join(directory, 'trusted-source-sweep.py');
  fs.writeFileSync(scriptPath, shellHereDocBody(deploy, 'TM_TRUSTED_SOURCE_SWEEP'));
  const result = spawnSync(python, [
    scriptPath,
    trustRoot,
    String(rootMetadata.uid),
    String(rootMetadata.gid),
    rootMetadata.mode,
    runModes,
    sourceMetadata.mode
  ], { encoding: 'utf8', timeout: 30_000 });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^TRUSTED_SOURCE_STALE_SWEEP_REMOVED=2\s*$/);
  assert.equal(fs.existsSync(interruptedRoot), false);
  assert.equal(fs.existsSync(completeRoot), false);
  assert.equal(fs.readFileSync(liveDatabase, 'utf8'), 'live bytes must remain private');
  assert.equal(fs.readFileSync(backupDatabase, 'utf8'), 'backup bytes must remain private');
});

test('trusted source stale sweep validates the complete inventory before deleting any stale copy', (t) => {
  const deploy = read(deployPath);
  const python = ['python', 'python3'].find((command) => (
    spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0
  ));
  if (!python) return t.skip('Python is unavailable');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-source-sweep-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const trustRoot = path.join(directory, 'trust-root');
  const validRoot = path.join(trustRoot, 'deployment-20260731-120002');
  const invalidRoot = path.join(trustRoot, 'deployment-20260731-120003');
  const validSource = path.join(validRoot, 'source.db');
  fs.mkdirSync(validRoot, { recursive: true });
  fs.mkdirSync(invalidRoot);
  fs.writeFileSync(validSource, 'valid stale copy');
  fs.writeFileSync(path.join(invalidRoot, 'unexpected.txt'), 'must fail closed');

  const [rootMetadata, validMetadata, invalidMetadata, sourceMetadata] = pythonFileMetadata(
    python,
    [trustRoot, validRoot, invalidRoot, validSource]
  );
  const runModes = [...new Set([validMetadata.mode, invalidMetadata.mode])].join(',');
  const scriptPath = path.join(directory, 'trusted-source-sweep.py');
  fs.writeFileSync(scriptPath, shellHereDocBody(deploy, 'TM_TRUSTED_SOURCE_SWEEP'));
  const result = spawnSync(python, [
    scriptPath,
    trustRoot,
    String(rootMetadata.uid),
    String(rootMetadata.gid),
    rootMetadata.mode,
    runModes,
    sourceMetadata.mode
  ], { encoding: 'utf8', timeout: 30_000 });

  assert.notEqual(result.status, 0, 'unexpected stale-copy inventory must fail closed');
  assert.equal(fs.existsSync(validSource), true, 'validation must complete before the first unlink');
  assert.equal(fs.existsSync(path.join(invalidRoot, 'unexpected.txt')), true);
});

test('recovery reads the pre-writer phase under the lifecycle lock and keeps later probes writer-protected', {
  skip: process.platform !== 'win32'
}, () => {
  const recovery = functionSource(
    read(deployPath),
    'Invoke-DeploymentFailureRecovery',
    'Invoke-InterruptedDeploymentRecovery'
  );
  assert.match(recovery, /\$preWriterPhase\s*=\s*Get-RemoteDeploymentPhase\s+-DeploymentLockOnly/);

  const result = runPowerShellFunctionHarness(['Get-RemoteDeploymentPhase'], String.raw`
$script:deploymentLockToken = 'lifecycle-owner'
$script:deploymentWriterToken = $null
$script:Calls = New-Object 'Collections.Generic.List[string]'
$script:RemotePhase = 'locked'
function Invoke-RemoteBash {
  param(
    [string]$Script,
    [string]$FailureMessage,
    [switch]$RequireDeploymentLock,
    [switch]$RequireWriterLock,
    [switch]$CaptureOutput
  )
  if (-not $RequireDeploymentLock -or -not $CaptureOutput) {
    throw 'Phase probes must remain lifecycle-locked and captured'
  }
  if ($RequireWriterLock) {
    if ([string]::IsNullOrWhiteSpace($script:deploymentWriterToken)) {
      throw 'Writer-protected phase probe ran without a writer token'
    }
    $script:Calls.Add('writer-protected')
  }
  else {
    $script:Calls.Add('lifecycle-only')
  }
  return $script:RemotePhase
}
if ((Get-RemoteDeploymentPhase -DeploymentLockOnly) -ne 'locked') { throw 'Unexpected lifecycle-only phase' }
$script:deploymentWriterToken = 'writer-owner'
if ((Get-RemoteDeploymentPhase) -ne 'locked') { throw 'Unexpected writer-protected phase' }
$script:RemotePhase = 'LOCKED'
$threw = $false
try { Get-RemoteDeploymentPhase -DeploymentLockOnly } catch { $threw = $true }
if (-not $threw) { throw 'Wrong-case lifecycle phase must fail closed' }
$actual = $script:Calls -join ','
if ($actual -ne 'lifecycle-only,writer-protected,lifecycle-only') { throw "Unexpected phase probe guards: $actual" }
Write-Output 'RECOVERY_PHASE_GUARDS_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /RECOVERY_PHASE_GUARDS_OK/);
});

test('Task 12 executable recovery state machine resumes pre-mutation phases and never rolls back an accepted release', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(['Invoke-DeploymentFailureRecovery'], String.raw`
$script:Actions = New-Object 'Collections.Generic.List[string]'
$script:Phase = 'locked'
$script:SweepFails = $false
$script:ProbeFails = $false
$script:RestoreFails = $false
$script:RestoreFailuresRemaining = 0
$script:CleanupFails = $false
$script:WriterEnterFails = $false
$script:AcceptanceStateOverride = $null
function Get-RemoteDeploymentPhase {
  if ($script:ProbeFails) { throw 'phase unavailable' }
  return $script:Phase
}
function Get-RemoteDeploymentAcceptanceState {
  if ($null -ne $script:AcceptanceStateOverride) { return $script:AcceptanceStateOverride }
  if (@('accepted', 'accepted-public-enabled', 'cutover-complete') -ccontains $script:Phase) {
    return 'current-marker-new'
  }
  return 'current-marker-absent'
}
function Invoke-RemoteRestore {
  param([string]$BackupPath, [switch]$RestoreDatabase)
  if (-not $RestoreDatabase) { throw 'database restore required' }
  $script:Actions.Add('restore')
  if ($script:RestoreFailuresRemaining -gt 0) {
    $script:RestoreFailuresRemaining -= 1
    throw 'transient restore failure'
  }
  if ($script:RestoreFails) { throw 'restore failed' }
}
function Start-Sleep {
  param([int]$Seconds)
  $script:Actions.Add('sleep')
}
function Invoke-RemoteCandidateCleanup {
  param([string]$ReleaseRoot)
  $script:Actions.Add('cleanup')
  if ($script:CleanupFails) { throw 'cleanup failed' }
}
function Invoke-RemotePreMutationResume {
  param([string]$BackupPath)
  $script:Actions.Add('resume-old')
}
function Restore-RemoteMigrationGateCleanupControl {
  param([string]$BackupPath)
  $script:Actions.Add('control-restore')
}
function Invoke-RemoteAcceptedFinalize {
  param([string]$ReleaseRoot)
  $script:Actions.Add('finalize-new')
}
function Invoke-RemoteRetentionCleanup {
  param([string]$BackupPath, [string]$ReleaseRoot)
  $script:Actions.Add('retention')
}
function Invoke-RemoteTrustedSourceInputSweep {
  $script:Actions.Add('source-sweep')
  if ($script:SweepFails) { throw 'trusted source sweep failed' }
}
function Assert-RemoteRestoreCapacity {
  param([string]$BackupPath)
  $script:Actions.Add('capacity')
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
  $script:SweepFails = $false
  $script:ProbeFails = $false
  $script:RestoreFails = $false
  $script:RestoreFailuresRemaining = 0
  $script:CleanupFails = $false
  $script:WriterEnterFails = $false
  $script:AcceptanceStateOverride = $null
}
function Assert-Actions {
  param([string]$Expected)
  $actual = $script:Actions -join ','
  if ($actual -ne $Expected) { throw "Expected actions '$Expected'; got '$actual'" }
}
foreach ($phase in @('locked', 'candidate-ready')) {
  Reset-Case
  $script:Phase = $phase
  Invoke-DeploymentFailureRecovery -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
  Assert-Actions 'source-sweep,writer-enter,control-restore,cleanup,exit'
}
Reset-Case
$script:Phase = 'cutover-complete'
Invoke-DeploymentFailureRecovery -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
Assert-Actions 'source-sweep,writer-enter,finalize-new,retention,cleanup,exit'
foreach ($phase in @('mutation-intent', 'maintenance-entered', 'writers-stopped', 'snapshot-ready')) {
  Reset-Case
  $script:Phase = $phase
  Invoke-DeploymentFailureRecovery -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
  Assert-Actions 'source-sweep,writer-enter,resume-old,cleanup,exit'
}
Reset-Case
$script:Phase = 'mutation-started'
Invoke-DeploymentFailureRecovery -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
Assert-Actions 'source-sweep,capacity,writer-enter,restore,cleanup,exit'

Reset-Case
$script:Phase = 'mutation-started'
$script:RestoreFailuresRemaining = 1
Invoke-DeploymentFailureRecovery -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
Assert-Actions 'source-sweep,capacity,writer-enter,restore,sleep,restore,cleanup,exit'

Reset-Case
$script:Phase = 'accepted'
Invoke-DeploymentFailureRecovery -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
Assert-Actions 'source-sweep,writer-enter,finalize-new,retention,exit'

Reset-Case
$script:Phase = 'ACCEPTED'
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Wrong-case recovery phase must fail closed' }
Assert-Actions 'source-sweep,writer-enter'

Reset-Case
$script:Phase = 'accepted'
$script:AcceptanceStateOverride = 'CURRENT-MARKER-NEW'
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Wrong-case recovery acceptance marker must fail closed' }
Assert-Actions 'source-sweep,writer-enter'

Reset-Case
$script:Phase = 'mutation-started'
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $false } catch { $threw = $true }
if (-not $threw) { throw 'Missing backup must fail closed' }
Assert-Actions 'source-sweep'

Reset-Case
$script:ProbeFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Unknown remote phase must fail closed' }
Assert-Actions 'source-sweep'

Reset-Case
$script:Phase = 'mutation-started'
$script:RestoreFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Restore failure must fail closed' }
Assert-Actions 'source-sweep,capacity,writer-enter,restore,sleep,restore,sleep,restore'

Reset-Case
$script:Phase = 'candidate-ready'
$script:CleanupFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Cleanup failure must fail closed' }
Assert-Actions 'source-sweep,writer-enter,control-restore,cleanup'

Reset-Case
$script:SweepFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'A failed stale source sweep must fail recovery closed' }
Assert-Actions 'source-sweep'

Reset-Case
$script:WriterEnterFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'An active writer must block recovery' }
Assert-Actions 'source-sweep,writer-enter'
Write-Output 'RECOVERY_STATE_MACHINE_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /RECOVERY_STATE_MACHINE_OK/);
});

test('Phase 4 cutover success is revalidated from the durable lifecycle and accepted marker before retention', {
  skip: process.platform !== 'win32'
}, () => {
  const deploy = read(deployPath);
  assert.match(deploy, /function Assert-RemoteCutoverComplete/);
  assert.match(
    deploy,
    /Invoke-RemoteBash -Script \$cutoverGate[\s\S]*?Assert-RemoteCutoverComplete[\s\S]*?Invoke-RemoteRetentionCleanup/
  );

  const result = runPowerShellFunctionHarness(['Assert-RemoteCutoverComplete'], String.raw`
$script:Phase = 'candidate-ready'
$script:Acceptance = 'current-marker-absent'
$script:AcceptanceCalls = 0
function Get-RemoteDeploymentPhase {
  param([switch]$DeploymentLockOnly)
  if (-not $DeploymentLockOnly) { throw 'Cutover phase probe must only require the deployment lock' }
  return $script:Phase
}
function Get-RemoteDeploymentAcceptanceState {
  param([switch]$DeploymentLockOnly)
  if (-not $DeploymentLockOnly) { throw 'Post-cutover acceptance probe must only require the deployment lock' }
  $script:AcceptanceCalls += 1
  return $script:Acceptance
}

$threw = $false
try { Assert-RemoteCutoverComplete } catch { $threw = $true }
if (-not $threw) { throw 'Candidate-ready must not be accepted as a completed cutover' }
if ($script:AcceptanceCalls -ne 0) { throw 'Acceptance must not be probed before cutover-complete is durable' }

$script:Phase = 'CUTOVER-COMPLETE'
$threw = $false
try { Assert-RemoteCutoverComplete } catch { $threw = $true }
if (-not $threw) { throw 'Wrong-case lifecycle phase must fail closed' }
if ($script:AcceptanceCalls -ne 0) { throw 'Wrong-case lifecycle phase must not probe acceptance' }

$script:Phase = 'cutover-complete'
$threw = $false
try { Assert-RemoteCutoverComplete } catch { $threw = $true }
if (-not $threw) { throw 'A missing current marker must not be accepted as a completed cutover' }
if ($script:AcceptanceCalls -ne 1) { throw 'Acceptance marker was not probed exactly once' }

$script:Acceptance = 'CURRENT-MARKER-NEW'
$threw = $false
try { Assert-RemoteCutoverComplete } catch { $threw = $true }
if (-not $threw) { throw 'Wrong-case accepted marker must fail closed' }
if ($script:AcceptanceCalls -ne 2) { throw 'Wrong-case accepted marker was not probed exactly once' }

$script:Acceptance = 'current-marker-new'
Assert-RemoteCutoverComplete
if ($script:AcceptanceCalls -ne 3) { throw 'Successful acceptance marker was not probed exactly once' }
Write-Output 'CUTOVER_POSTCONDITION_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /CUTOVER_POSTCONDITION_OK/);
});

test('Phase 4 acceptance probe keeps writer protection by default and permits deployment-only post-cutover verification', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(['Get-RemoteDeploymentAcceptanceState'], String.raw`
$script:REMOTE_ROOT = '/root/turingmarket'
$script:TRUSTED_SOURCE_BUNDLE_REMOTE_PATH = '/usr/local/libexec/turingmarket/source'
$script:EXPECTED_TRUSTED_PARSER_VERIFIER_SHA256 = ('a' * 64)
$script:Calls = New-Object 'Collections.Generic.List[string]'
function Invoke-RemoteBash {
  param(
    [string]$Script,
    [string]$FailureMessage,
    [switch]$RequireDeploymentLock,
    [switch]$RequireWriterLock,
    [switch]$CaptureOutput
  )
  if (-not $RequireDeploymentLock -or -not $CaptureOutput) {
    throw 'Acceptance probe must remain deployment-locked and captured'
  }
  if ($RequireWriterLock) { $script:Calls.Add('writer') }
  else { $script:Calls.Add('deployment-only') }
  return 'current-marker-new'
}

if ((Get-RemoteDeploymentAcceptanceState) -cne 'current-marker-new') {
  throw 'Default acceptance probe returned an unexpected state'
}
if ((Get-RemoteDeploymentAcceptanceState -DeploymentLockOnly) -cne 'current-marker-new') {
  throw 'Post-cutover acceptance probe returned an unexpected state'
}
$actual = $script:Calls -join ','
if ($actual -cne 'writer,deployment-only') { throw "Unexpected acceptance probe guards: $actual" }
Write-Output 'ACCEPTANCE_PROBE_GUARDS_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ACCEPTANCE_PROBE_GUARDS_OK/);
});

test('Phase 4 retention requires its explicit remote success marker before returning', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness([
    'Assert-RollbackBackupPath',
    'Invoke-RemoteRetentionCleanup'
  ], String.raw`
$script:REMOTE_ROOT = '/root/turingmarket'
$script:CANDIDATE_ROOT = '/var/lib/turingmarket-gate/releases'
$script:GATE_USER = 'turingmarket-gate'
$script:RemoteResult = ''
$script:Calls = 0
function Invoke-RemoteBash {
  param(
    [string]$Script,
    [string]$FailureMessage,
    [switch]$RequireDeploymentLock,
    [switch]$RequireWriterLock,
    [switch]$CaptureOutput
  )
  if (-not $RequireDeploymentLock -or $RequireWriterLock -or -not $CaptureOutput) {
    throw 'Retention confirmation must be deployment-locked, writer-free, and captured'
  }
  $script:Calls += 1
  return $script:RemoteResult
}

$backup = 'backups/v060-crm-sales-workspace-20260820-230240'
$release = '/var/lib/turingmarket-gate/releases/v060-crm-sales-workspace-20260820-230240'
$threw = $false
try { Invoke-RemoteRetentionCleanup -BackupPath $backup -ReleaseRoot $release } catch { $threw = $true }
if (-not $threw) { throw 'Missing retention marker must fail closed' }

$script:RemoteResult = 'retention_cleanup_ok'
$threw = $false
try { Invoke-RemoteRetentionCleanup -BackupPath $backup -ReleaseRoot $release } catch { $threw = $true }
if (-not $threw) { throw 'Wrong-case retention marker must fail closed' }

$script:RemoteResult = 'diagnostic' + [Environment]::NewLine + 'RETENTION_CLEANUP_OK'
Invoke-RemoteRetentionCleanup -BackupPath $backup -ReleaseRoot $release
if ($script:Calls -ne 3) { throw 'Unexpected retention invocation count' }
Write-Output 'RETENTION_CONFIRMATION_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /RETENTION_CONFIRMATION_OK/);
});

test('Phase 4 retention cleanup keeps a rollback floor and removes only validated stale deployment artifacts', (t) => {
  const deploy = read(deployPath);
  assert.match(deploy, /function Invoke-RemoteRetentionCleanup/);
  assert.match(deploy, /TM_RETENTION_CLEANUP/);
  assert.match(deploy, /backupKeepCount\s*=\s*10/);
  assert.match(deploy, /backupMaxAgeSeconds\s*=\s*30 \* 24 \* 60 \* 60/);
  assert.match(deploy, /candidateMaxAgeSeconds\s*=\s*24 \* 60 \* 60/);
  assert.match(deploy, /retention-report\.json/);
  assert.match(deploy, /Invoke-RemoteAcceptedFinalize[\s\S]*?Invoke-RemoteRetentionCleanup/);
  assert.match(deploy, /'cutover-complete'[\s\S]*?Invoke-RemoteRetentionCleanup/);
  assert.match(deploy, /Invoke-RemoteBash -Script \$cutoverGate[\s\S]*?Invoke-RemoteRetentionCleanup[\s\S]*?Exit-RemoteDeploymentLock/);

  const python = ['python', 'python3'].find((command) => (
    spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0
  ));
  if (!python) return t.skip('Python is unavailable');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-retention-'));
  const backupRoot = path.join(directory, 'backups');
  const candidateRoot = path.join(directory, 'releases');
  fs.mkdirSync(backupRoot);
  fs.mkdirSync(candidateRoot);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));

  const now = Date.now();
  const backupNames = [];
  for (let index = 0; index < 12; index += 1) {
    const name = `v060-crm-sales-workspace-202601${String(index + 1).padStart(2, '0')}-120000`;
    const target = path.join(backupRoot, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'evidence.txt'), name);
    const modified = new Date(now - (40 * 24 * 60 * 60 * 1000) - index * 60_000);
    fs.utimesSync(target, modified, modified);
    backupNames.push(name);
  }
  const currentBackup = path.join(backupRoot, backupNames[0]);
  const freshCandidate = path.join(candidateRoot, 'v060-crm-sales-workspace-20260729-120000');
  const staleCandidate = path.join(candidateRoot, 'v060-crm-sales-workspace-20260701-120000');
  fs.mkdirSync(freshCandidate);
  fs.mkdirSync(staleCandidate);
  fs.writeFileSync(path.join(staleCandidate, 'candidate.txt'), 'stale');
  fs.utimesSync(freshCandidate, new Date(now), new Date(now));
  fs.utimesSync(staleCandidate, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000));

  const scriptPath = path.join(directory, 'retention.py');
  fs.writeFileSync(scriptPath, shellHereDocBody(deploy, 'TM_RETENTION_CLEANUP'));
  const ownerUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const result = spawnSync(python, [
    scriptPath,
    backupRoot,
    candidateRoot,
    currentBackup,
    path.join(candidateRoot, 'v060-crm-sales-workspace-20260729-130000'),
    String(ownerUid),
    String(ownerUid)
  ], {
    encoding: 'utf8',
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /RETENTION_CLEANUP_OK/);
  assert.equal(fs.existsSync(currentBackup), true);
  assert.equal(fs.existsSync(freshCandidate), true);
  assert.equal(fs.existsSync(staleCandidate), false);
  const remainingBackups = fs.readdirSync(backupRoot)
    .filter((name) => /^v060-crm-sales-workspace-/.test(name));
  assert.equal(remainingBackups.length, 10);
  const report = JSON.parse(fs.readFileSync(path.join(currentBackup, 'retention-report.json'), 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.policy, {
    backupKeepCount: 10,
    backupMaxAgeSeconds: 30 * 24 * 60 * 60,
    candidateMaxAgeSeconds: 24 * 60 * 60
  });
  assert.equal(report.removedBackups.length, 2);
  assert.deepEqual(report.removedCandidates, [path.basename(staleCandidate)]);
});

test('Phase 4 executable manual rollback requires database restore consent before acquiring the remote lock', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(['Assert-RollbackBackupPath', 'Invoke-ManualRollback'], String.raw`
$script:Actions = New-Object 'Collections.Generic.List[string]'
function Get-RemoteServer { $script:Actions.Add('server'); return 'example.test' }
function Enter-RemoteDeploymentLock { $script:Actions.Add('enter') }
function Assert-RemoteExternalRuntimeBoundary { $script:Actions.Add('boundary') }
function Assert-RemoteLoopbackIsolationPreflight { $script:Actions.Add('loopback') }
function Assert-RemoteRestoreCapacity { $script:Actions.Add('capacity') }
function Enter-RemoteWriterLock { $script:Actions.Add('writer-enter') }
function Invoke-RemoteRestore {
  param([string]$BackupPath, [switch]$RestoreDatabase)
  if (-not $RestoreDatabase) { throw 'database restore required' }
  $script:Actions.Add('restore')
}
function Restore-RemoteMigrationGateCleanupControl {
  param([string]$BackupPath)
  $script:Actions.Add('control-restore')
}
function Exit-RemoteDeploymentLock {
  param([switch]$ReleaseWriterLock)
  if (-not $ReleaseWriterLock) { throw 'writer and deployment locks must release atomically' }
  $script:Actions.Add('exit')
}
$threw = $false
try { Invoke-ManualRollback -BackupPath 'backups/v060-crm-sales-workspace-bad' -RestoreDatabase -ConfirmDataLoss } catch { $threw = $true }
if (-not $threw) { throw 'Invalid backup path must be rejected' }
if ($script:Actions.Count -ne 0) { throw "Invalid path performed actions: $($script:Actions -join ',')" }

$threw = $false
try { Invoke-ManualRollback -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' } catch { $threw = $true }
if (-not $threw) { throw 'Code-only Phase 4 rollback must be rejected' }
if ($script:Actions.Count -ne 0) { throw "Code-only rollback performed actions: $($script:Actions -join ',')" }

$threw = $false
try { Invoke-ManualRollback -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -RestoreDatabase } catch { $threw = $true }
if (-not $threw) { throw 'Unconfirmed database restore must be rejected' }
if ($script:Actions.Count -ne 0) { throw "Unconfirmed restore performed actions: $($script:Actions -join ',')" }

Invoke-ManualRollback -BackupPath 'backups/v060-crm-sales-workspace-20260714-120000' -RestoreDatabase -ConfirmDataLoss
  if (($script:Actions -join ',') -ne 'server,enter,boundary,loopback,capacity,writer-enter,restore,exit') { throw "Unexpected valid rollback actions: $($script:Actions -join ',')" }
Write-Output 'MANUAL_ROLLBACK_PREFLIGHT_OK'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /MANUAL_ROLLBACK_PREFLIGHT_OK/);
});

test('Task 12 remote deploy gate runs bounded replay tests and exact route/static smoke before success', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /npm ci --ignore-scripts/);
  assert.match(deploy, /node node_modules\/playwright-deploy\/cli\.js install chromium/);
  assert.match(deploy, /TM_DISABLE_DOTENV=1/);
  assert.match(deploy, /DB_PATH=/);
  const candidateMatch = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate-only gate must exist');
  const candidateGate = candidateMatch[1];
  assert.match(candidateGate, /node server\/scripts\/verify_phase4_one_request_replay\.js/);
  assert.match(candidateGate, /node --test server\/tests\/verify_phase4_one_request_replay\.test\.js/);
  assert.match(candidateGate, /node --test server\/tests\/release_replay_gate\.test\.js/);
  assert.doesNotMatch(candidateGate, /tests\/\*\.test\.js/);
  assert.doesNotMatch(deploy, /npm test -- --test-concurrency=1/);
  assert.ok(
    deploy.indexOf('node node_modules/playwright-deploy/cli.js install chromium') <
      deploy.indexOf('node node_modules/playwright-deploy/cli.js test -c server/tests/deployment-browser-smoke.config.js'),
    'Chromium must be installed before the bounded browser smoke launches'
  );
  assert.match(deploy, /node node_modules\/playwright-deploy\/cli\.js test -c server\/tests\/deployment-browser-smoke\.config\.js/);
  assert.doesNotMatch(deploy, /npx\s+playwright|playwright-deploy\/cli\.js test -c server\/tests\/browser-baseline\.config\.js/);
  assert.match(deploy, /restart_pm2_from_ecosystem_exactly/);
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

test('Phase 3 evidence compares current captures with frozen screenshot bytes from the source commit', () => {
  const generatorSource = read(phase3EvidenceGeneratorPath);
  assert.match(generatorSource, /const frozenBuffer = readGitBlob\(sourceCommit, slot\.path\)/);
  assert.doesNotMatch(generatorSource, /const frozenBuffer = fs\.readFileSync\(frozenPath\)/);
});

test('Task 12 frozen manifest retains approved v0.4 visual and PPT evidence', () => {
  const manifest = JSON.parse(read(manifestPath));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.baseline.release, 'v0.4.0-product-shell-and-design-system');
  assert.equal(manifest.preEdit.files.appJs.sha256, PRE_EDIT_APP_SHA256);
  assert.equal(manifest.preEdit.buildMarkers.app, '20260630-auth-upload-fix');
  assert.equal(manifest.files.appJs.sha256, 'a54d6d632363a615ea809b4c1307c724cc18d14ad0643f5caa40ae8171d74837');
  assert.equal(manifest.files.pptJs.sha256, PPT_SHA256);
  assert.equal(manifest.buildMarkers.app, '20260714-v040-product-shell-design-system');
  assert.equal(manifest.buildMarkers.ppt, PPT_BUILD);
  assert.equal(manifest.scriptCacheKeys.app, '20260714v040productshelldesignsystem');
  assert.equal(manifest.scriptCacheKeys.ppt, PPT_QUERY);
  assert.deepEqual(manifest.duplicateInventory.duplicates, ['esc']);
  assert.equal(manifest.screenshotSlots.length, 72);
  for (const slot of manifest.screenshotSlots) {
    assert.equal(slot.sha256, sha256(path.join(repoRoot, ...slot.path.split('/'))), `${slot.path} hash must match its controlled file`);
  }

  const comparison = manifest.postEditComparison;
  assert.equal(comparison.fileCount, 72);
  assert.equal(comparison.comparisonMode, 'reviewed-shared-shell-redesign');
  assert.equal(comparison.approvalRecord, 'docs/product/2026-07-phase3-visual-change-record.md');
  assert.equal(comparison.reviewStatus, 'approved');
  assert.equal(comparison.maxDiffPixelRatio, null);
  assert.equal(comparison.withinThreshold, null);
  assert.ok(comparison.totalDiffPixels > 0);
  assert.ok(comparison.maxObservedDiffRatio > 0 && comparison.maxObservedDiffRatio <= 1);
  assert.equal(comparison.screenshots.length, 72);

  assert.match(read(attributesPath), /^platform\/app\.js text eol=lf$/m);
  const generatorSource = read(phase3EvidenceGeneratorPath);
  assert.match(generatorSource, /spawnSync\('git', \['show', `\$\{sourceCommit\}:\$\{source\}`\]/);
  assert.match(generatorSource, /workspaceBuffer\.equals\(commitBuffer\)/);
  const hasGitObjects = fs.existsSync(path.join(repoRoot, '.git'));
  for (const file of Object.values(manifest.files)) {
    assert.equal(file.sourceCommit, comparison.sourceCommit, `${file.source} must name its source commit`);
    assert.equal(file.sourceCommitSha256, file.sha256, `${file.source} must retain its source-commit hash`);
    assert.equal(file.sourceCommitBytes, file.bytes, `${file.source} must retain its source-commit byte count`);
    if (hasGitObjects) {
      const blob = gitBlob(comparison.sourceCommit, file.source);
      assert.equal(sha256Buffer(blob), file.sha256, `${file.source} must match the recorded commit blob`);
      assert.equal(blob.length, file.bytes, `${file.source} byte count must match the recorded commit blob`);
    }
  }

  const provenance = JSON.parse(read(visualProvenancePath));
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.source, comparison.source);
  assert.equal(provenance.rawCaptureCount, 72);
  assert.equal(provenance.contactSheetCount, 9);
  assert.equal(provenance.rawCaptures.length, 72);
  assert.equal(provenance.contactSheets.length, 9);
  const rawByPath = new Map(provenance.rawCaptures.map((entry) => [entry.path, entry]));
  assert.equal(rawByPath.size, 72);
  const sheetByName = new Map(provenance.contactSheets.map((entry) => [entry.name, entry]));
  assert.equal(sheetByName.size, 9);
  for (const sheet of provenance.contactSheets) {
    const sheetPath = path.join(visualEvidenceRoot, sheet.name);
    assert.equal(sheet.sha256, sha256(sheetPath), `${sheet.name} hash must match the committed contact sheet`);
    assert.equal(sheet.rawCaptures.length, 8);
  }

  const expectedPaths = walkFiles(screenshotRoot).filter((file) => file.endsWith('.png'));
  const actualPaths = comparison.screenshots.map((entry) => entry.path.replace('docs/baselines/v0.2.9/screenshots/', '')).sort();
  assert.deepEqual(actualPaths, expectedPaths);
  const preEditByPath = new Map(manifest.preEdit.screenshotSlots.map((entry) => [entry.path, entry]));
  for (const entry of comparison.screenshots) {
    const relative = entry.path.replace('docs/baselines/v0.2.9/screenshots/', '');
    assert.equal(entry.preEditSha256, preEditByPath.get(entry.path).sha256);
    if (hasGitObjects) {
      assert.equal(sha256Buffer(gitBlob(comparison.sourceCommit, entry.path)), entry.preEditSha256);
    }
    const raw = rawByPath.get(relative);
    assert.ok(raw, `${relative} must be mapped to a committed contact sheet`);
    assert.equal(entry.postEditSha256, raw.sha256);
    assert.ok(sheetByName.has(raw.contactSheet));
    assert.ok(sheetByName.get(raw.contactSheet).rawCaptures.includes(relative));
    assert.ok(entry.diffPixelRatio >= 0 && entry.diffPixelRatio <= 1);
    assert.ok(Number.isInteger(entry.diffPixels) && entry.diffPixels >= 0);
    assert.ok(Number.isInteger(entry.rawDiffPixels) && entry.rawDiffPixels >= entry.diffPixels);
  }
});
