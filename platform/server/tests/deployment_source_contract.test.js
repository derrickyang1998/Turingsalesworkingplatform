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
const phase3EvidenceGeneratorPath = path.join(platformRoot, 'server', 'scripts', 'generate_phase3_visual_evidence_manifest.js');
const docs = [
  path.join(platformRoot, 'DEPLOY.md'),
  path.join(repoRoot, 'CLAUDE_CODE_MIGRATION.md')
];

const AUTHORITATIVE_CHECKOUT = String.raw`C:\Users\29272\Documents\在线商务平台-github-sync`;
const AUTHORITATIVE_BRANCH = 'codex/v0.5.0-campaign-business-spine';
const RELEASE_SLUG = 'v050-campaign-business-spine';
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

function pythonFileMetadata(python, targets) {
  const result = spawnSync(python, [
    '-c',
    'import json,os,stat,sys; print(json.dumps([{"uid":s.st_uid,"gid":s.st_gid,"mode":format(stat.S_IMODE(s.st_mode),"04o")} for s in [os.lstat(p) for p in sys.argv[1:]]]))',
    ...targets
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
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
  assert.match(
    source,
    /cd server\s*\r?\n\s*NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH=\S+ node --test --test-concurrency=1 tests\/\*\.test\.js/i,
    'isolated remote full Node test must be documented'
  );
  assert.doesNotMatch(source, /(?:tvly|sk)-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
});

test('Phase 4 deploy source guards the exact branch and locked build contract', () => {
  const deploy = read(deployPath);
  assert.match(deploy, /\[string\]\$RollbackBackup/);
  assert.ok(
    deploy.includes(`$EXPECTED_BRANCH = "${AUTHORITATIVE_BRANCH}"`),
    'deploy script must guard the authoritative v0.5 branch'
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
    timeout: 120_000,
    env: safeGitEnvironment()
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /LOCAL_DEPLOY_PREFLIGHT_OK/);
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
  assert.match(deploy, /# RESTORE_NGINX/);
  assert.match(deploy, /# RESTORE_PROCESS/);
  assert.match(deploy, /# RESTORE_HEALTH/);
  assert.ok(deploy.indexOf('# RESTORE_CODE') < deploy.indexOf('# RESTORE_DATABASE_AND_PPT_CACHE'));
  assert.ok(deploy.indexOf('# RESTORE_DATABASE_AND_PPT_CACHE') < deploy.indexOf('# INVALIDATE_SESSIONS'));
  assert.ok(deploy.indexOf('# INVALIDATE_SESSIONS') < deploy.indexOf('# RESTORE_NGINX'));
  assert.ok(deploy.indexOf('# RESTORE_NGINX') < deploy.indexOf('# RESTORE_PROCESS'));
  assert.ok(deploy.indexOf('# RESTORE_PROCESS') < deploy.indexOf('# RESTORE_HEALTH'));
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
  assert.match(backup, /cp -a -- "\$PptCacheDir\/\." "\$BackupAbsolute\/ppt-cache\/"/);
  assert.match(backup, /find "\$BackupAbsolute\/ppt-cache"[\s\S]*?-type f[\s\S]*?sha256sum/);

  assert.match(restore, /\[switch\]\$RestoreDatabase/);
  assert.match(restore, /if \(-not \$RestoreDatabase\)/);
  assert.match(restore, /DatabaseStage="\$DatabaseDir\/\.turingmarket\.db\.restore\./);
  assert.match(restore, /PptCacheStage="\$PptCacheParent\/\.ppt-cache\.restore\./);
  assert.match(restore, /rm -f -- "\$DatabasePath-journal" "\$DatabasePath-wal" "\$DatabasePath-shm"/);
  assert.match(restore, /DELETE FROM sessions/);
  assert.match(restore, /SESSIONS_REMAINING=0/);
  assert.ok(restore.indexOf('DELETE FROM sessions') < restore.indexOf('# RESTORE_PROCESS'));
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
    'service-stopped',
    'code-restored',
    'data-staged',
    'database-restored',
    'cache-restored',
    'security-reapplied',
    'sessions-invalidated',
    'nginx-restored',
    'process-restored',
    'health-verified'
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
  fs.writeFileSync(path.join(cacheRoot, `${cacheKey}.pptx`), bytes, { mode: 0o600 });
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
    naming: '<response_cache_key>.pptx',
    artifacts: [{
      cacheKey,
      fileName: `${cacheKey}.pptx`,
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
  assert.match(orphan.stderr, /PPT cache file is not represented by SQLite/);
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
  assert.match(gate, /--uid="\$GateUser"/);
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
    assert.ok(gate.includes(property), `migration sandbox must enforce ${property}`);
  }
  assert.match(gate, /InaccessiblePaths=\/root \/etc\/turingmarket \/var\/lib\/turingmarket\/db \/var\/lib\/turingmarket\/ppt-cache/);
  assert.match(gate, /StandardOutput=file:\$RehearsalStdout/);
  assert.match(gate, /StandardError=file:\$RehearsalStderr/);
  assert.doesNotMatch(gate, /systemd-run[^\n]*(?:--pipe|-P)/);
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
  assert.ok(upload.includes("if ($Record.RemoteRelativePath -notmatch '^[A-Za-z0-9._/-]+$' -or $Record.RemoteRelativePath -match '(^|/)\\.\\.?(/|$)') {"));
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
  assert.match(deploy, /pm2 stop turingmarket[\s\S]*?renameat2[\s\S]*?pm2 (?:restart|start)/);
  assert.match(deploy, /TM_DISABLE_DOTENV=1/);
  assert.match(deploy, /DB_PATH="\$TestDb"/);
  assert.match(deploy, /\^\[A-Za-z0-9\]\[A-Za-z0-9\.-\]\{0,252\}\$/);
});

test('production replay reuses the server JWT runtime contract before database or request work', () => {
  const deploy = read(deployPath);
  const start = deploy.indexOf("const environmentPath = fs.realpathSync(process.env.TM_REPLAY_ENV);");
  const end = deploy.indexOf('const probePath = process.env.TM_REPLAY_PROBE;', start);
  assert.ok(start !== -1 && end > start, 'production replay environment preflight must exist');
  const replayPreflight = deploy.slice(start, end);

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
  assert.match(cutoverMatch[1], /trap release_writer EXIT/);
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
  const restartIndex = cutover.indexOf('pm2 restart ecosystem.config.js');

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
  assert.match(cutover, /expect_maintenance 503 \/api\/health/);
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
function Get-RemoteDeploymentPhase {
  if ($script:ProbeFails) { throw 'phase unavailable' }
  return $script:Phase
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
}
function Assert-Actions {
  param([string]$Expected)
  $actual = $script:Actions -join ','
  if ($actual -ne $Expected) { throw "Expected actions '$Expected'; got '$actual'" }
}
foreach ($phase in @('locked', 'candidate-ready')) {
  Reset-Case
  $script:Phase = $phase
  Invoke-DeploymentFailureRecovery -BackupPath 'backups/v050-campaign-business-spine-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
  Assert-Actions 'source-sweep,writer-enter,cleanup,exit'
}
Reset-Case
$script:Phase = 'cutover-complete'
Invoke-DeploymentFailureRecovery -BackupPath 'backups/v050-campaign-business-spine-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
Assert-Actions 'source-sweep,writer-enter,retention,cleanup,exit'
foreach ($phase in @('mutation-intent', 'maintenance-entered', 'writers-stopped', 'snapshot-ready')) {
  Reset-Case
  $script:Phase = $phase
  Invoke-DeploymentFailureRecovery -BackupPath 'backups/v050-campaign-business-spine-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
  Assert-Actions 'source-sweep,writer-enter,resume-old,cleanup,exit'
}
Reset-Case
$script:Phase = 'mutation-started'
Invoke-DeploymentFailureRecovery -BackupPath 'backups/v050-campaign-business-spine-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
Assert-Actions 'source-sweep,writer-enter,restore,cleanup,exit'

Reset-Case
$script:Phase = 'mutation-started'
$script:RestoreFailuresRemaining = 1
Invoke-DeploymentFailureRecovery -BackupPath 'backups/v050-campaign-business-spine-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
Assert-Actions 'source-sweep,writer-enter,restore,sleep,restore,cleanup,exit'

Reset-Case
$script:Phase = 'accepted'
Invoke-DeploymentFailureRecovery -BackupPath 'backups/v050-campaign-business-spine-20260714-120000' -ReleaseRoot '/var/lib/turingmarket-gate/releases/test' -BackupCreated $true
Assert-Actions 'source-sweep,writer-enter,finalize-new,retention,exit'

Reset-Case
$script:Phase = 'mutation-started'
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $false } catch { $threw = $true }
if (-not $threw) { throw 'Missing backup must fail closed' }
Assert-Actions 'source-sweep,writer-enter'

Reset-Case
$script:ProbeFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Unknown remote phase must fail closed' }
Assert-Actions 'source-sweep,writer-enter'

Reset-Case
$script:Phase = 'mutation-started'
$script:RestoreFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Restore failure must fail closed' }
Assert-Actions 'source-sweep,writer-enter,restore,sleep,restore,sleep,restore'

Reset-Case
$script:Phase = 'candidate-ready'
$script:CleanupFails = $true
$threw = $false
try { Invoke-DeploymentFailureRecovery -BackupPath 'x' -ReleaseRoot 'y' -BackupCreated $true } catch { $threw = $true }
if (-not $threw) { throw 'Cleanup failure must fail closed' }
Assert-Actions 'source-sweep,writer-enter,cleanup'

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
    const name = `v050-campaign-business-spine-202601${String(index + 1).padStart(2, '0')}-120000`;
    const target = path.join(backupRoot, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'evidence.txt'), name);
    const modified = new Date(now - (40 * 24 * 60 * 60 * 1000) - index * 60_000);
    fs.utimesSync(target, modified, modified);
    backupNames.push(name);
  }
  const currentBackup = path.join(backupRoot, backupNames[0]);
  const freshCandidate = path.join(candidateRoot, 'v050-campaign-business-spine-20260729-120000');
  const staleCandidate = path.join(candidateRoot, 'v050-campaign-business-spine-20260701-120000');
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
    path.join(candidateRoot, 'v050-campaign-business-spine-20260729-130000'),
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
    .filter((name) => /^v050-campaign-business-spine-/.test(name));
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
function Enter-RemoteWriterLock { $script:Actions.Add('writer-enter') }
function Invoke-RemoteRestore {
  param([string]$BackupPath, [switch]$RestoreDatabase)
  if (-not $RestoreDatabase) { throw 'database restore required' }
  $script:Actions.Add('restore')
}
function Exit-RemoteDeploymentLock {
  param([switch]$ReleaseWriterLock)
  if (-not $ReleaseWriterLock) { throw 'writer and deployment locks must release atomically' }
  $script:Actions.Add('exit')
}
$threw = $false
try { Invoke-ManualRollback -BackupPath 'backups/v050-campaign-business-spine-bad' -RestoreDatabase -ConfirmDataLoss } catch { $threw = $true }
if (-not $threw) { throw 'Invalid backup path must be rejected' }
if ($script:Actions.Count -ne 0) { throw "Invalid path performed actions: $($script:Actions -join ',')" }

$threw = $false
try { Invoke-ManualRollback -BackupPath 'backups/v050-campaign-business-spine-20260714-120000' } catch { $threw = $true }
if (-not $threw) { throw 'Code-only Phase 4 rollback must be rejected' }
if ($script:Actions.Count -ne 0) { throw "Code-only rollback performed actions: $($script:Actions -join ',')" }

$threw = $false
try { Invoke-ManualRollback -BackupPath 'backups/v050-campaign-business-spine-20260714-120000' -RestoreDatabase } catch { $threw = $true }
if (-not $threw) { throw 'Unconfirmed database restore must be rejected' }
if ($script:Actions.Count -ne 0) { throw "Unconfirmed restore performed actions: $($script:Actions -join ',')" }

Invoke-ManualRollback -BackupPath 'backups/v050-campaign-business-spine-20260714-120000' -RestoreDatabase -ConfirmDataLoss
if (($script:Actions -join ',') -ne 'server,enter,boundary,loopback,writer-enter,restore,exit') { throw "Unexpected valid rollback actions: $($script:Actions -join ',')" }
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

test('Phase 3 evidence compares current captures with frozen screenshot bytes from the source commit', () => {
  const generatorSource = read(phase3EvidenceGeneratorPath);
  assert.match(generatorSource, /const frozenBuffer = readGitBlob\(sourceCommit, slot\.path\)/);
  assert.doesNotMatch(generatorSource, /const frozenBuffer = fs\.readFileSync\(frozenPath\)/);
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
