const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const platformRoot = path.join(__dirname, '..', '..');
const serverEntry = path.join(platformRoot, 'server', 'server.js');
const deployScriptPath = path.join(platformRoot, 'deploy_v8.ps1');
const TEST_JWT_SECRET = 'aonMA-R-MHsTFr-HNF7JwPd3da1Vo8hXV2wmeb4y4m0';
const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir',
  'TEMP', 'TMP', 'ComSpec', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE',
  'PROCESSOR_ARCHITECTURE', 'SystemDrive'
]);

function isolatedChildEnvironment(overrides, sourceEnvironment = process.env) {
  const environment = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(sourceEnvironment, key)) {
      environment[key] = sourceEnvironment[key];
    }
  }
  return Object.assign(environment, overrides);
}

function readDeployScript() {
  return fs.readFileSync(deployScriptPath, 'utf8');
}

function extractRemoteBackupBlock(deploy) {
  const start = deploy.indexOf('function Invoke-RemoteBackup');
  const end = deploy.indexOf('function Invoke-RemoteRestore');
  assert.ok(start !== -1 && end > start, 'deploy script must define backup before restore');
  return deploy.slice(start, end);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited early (${child.exitCode}).\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_error) {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for test server.\n${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('network child OS environment excludes inherited secrets and application configuration', () => {
  const environment = isolatedChildEnvironment({}, {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    NODE_OPTIONS: '--require inherited-hook.js',
    DEEPSEEK_API_KEY: 'inherited-deepseek-key',
    TAVILY_API_KEY: 'inherited-tavily-key',
    TM_ENV_FILE: 'C:\\untrusted.env',
    DB_PATH: 'C:\\production.db'
  });

  assert.deepEqual(environment, {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp'
  });
  for (const key of [
    'NODE_OPTIONS',
    'DEEPSEEK_API_KEY',
    'TAVILY_API_KEY',
    'TM_ENV_FILE',
    'DB_PATH'
  ]) {
    assert.equal(Object.hasOwn(environment, key), false, `${key} was inherited`);
  }
});

test('production server serves browser assets but denies private platform files', { timeout: 30000 }, async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-public-static-'));
  const outputChunks = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: isolatedChildEnvironment({
      NODE_ENV: 'test',
      TM_DISABLE_DOTENV: '1',
      SERVER_HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'test.db'),
      UPLOAD_SANDBOX_SPOOL_ROOT: path.join(tempDir, 'upload-sandbox'),
      TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
      JWT_SECRET: TEST_JWT_SECRET
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child, () => outputChunks.join(''));

    const expectedStatuses = new Map([
      ['/app.js', 200],
      ['/ppt.js', 200],
      ['/client/shared/build_info.js', 200],
      ['/client/core/navigation.js', 200],
      ['/client/core/accessibility.js', 200],
      ['/client/core/shell.js', 200],
      ['/client/styles/tokens.css', 200],
      ['/client/styles/components.css', 200],
      ['/client/styles/layout.css', 200],
      ['/data/influencer_schema.json', 200],
      ['/client/', 404],
      ['/client/core/', 404],
      ['/client/shared/', 404],
      ['/client/unknown.js', 404],
      ['/client/core/navigation.js/extra', 404],
      ['/client/core/%6eavigation.js', 404],
      ['/client/core/accessibility.js/extra', 404],
      ['/client/core/%61ccessibility.js', 404],
      ['/client/styles/tokens.css/extra', 404],
      ['/client/styles/%74okens.css', 404],
      ['/client/../server/server.js', 404],
      ['/client/%2e%2e/server/server.js', 404],
      ['/client/%252e%252e/server/server.js', 404],
      ['/client/shared/%2e%2e/%2e%2e/server/server.js', 404],
      ['/client/shared%5c..%5c..%5cserver%5cserver.js', 404],
      ['/client/shared/build_info.js%5c..%5cunknown.js', 404],
      ['/client/shared/%62uild_info.js', 404],
      ['/server/server.js', 404],
      ['/server/db/turingmarket.db', 404],
      ['/server/db/turingmarket.db-wal', 404],
      ['/deploy_v8.ps1', 404],
      ['/DEPLOY.md', 404],
      ['/data/%2e%2e/server/server.js', 404],
      ['/.env', 404],
      ['/%2eenv', 404],
      ['/Dockerfile', 404],
      ['/api', 404],
      ['/api/not-a-real-endpoint', 404]
    ]);

    for (const [requestPath, expectedStatus] of expectedStatuses) {
      const response = await fetch(`${baseUrl}${requestPath}`, {
        method: 'HEAD',
        redirect: 'manual'
      });
      assert.equal(response.status, expectedStatus, `${requestPath} should return ${expectedStatus}`);
    }
  } finally {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('nginx config blocks private platform paths before proxying', () => {
  const configPath = path.join(platformRoot, 'nginx', 'turingmarket.conf');
  assert.equal(fs.existsSync(configPath), true, 'versioned Nginx config must exist');
  const config = fs.readFileSync(configPath, 'utf8');
  assert.match(config, /server\|uploads\|tmp\|backups\|node_modules\|docs\|nginx/);
  assert.match(config, /deploy_v8\\\.ps1/);
  assert.match(config, /Dockerfile\|Procfile\|Makefile/);
  assert.match(config, /location ~ \(\^\|\/\)\\\./);
  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:3002/);
});

test('guarded deploy validates and installs the versioned nginx config', () => {
  const deploy = readDeployScript();
  assert.match(deploy, /nginx\\turingmarket\.conf/);
  assert.match(deploy, /nginx -t/);
  assert.match(deploy, /systemctl reload nginx/);
  assert.match(deploy, /sites-available\/turingmarket/);
  assert.match(deploy, /set -euo pipefail[\s\S]*?nginx -t/);
  assert.match(deploy, /\$BackupAbsolute\/nginx\/turingmarket\.conf/);
});

test('guarded deploy keeps production host external and SSH host checking enabled', () => {
  const deploy = readDeployScript();
  const deployWithoutLoopback = deploy.replace(/\b127\.0\.0\.1\b/g, '');
  const uploadStart = deploy.indexOf('function Invoke-PinnedDeploymentUpload');
  const uploadEnd = deploy.indexOf('function Assert-TrustedProductionSourceArtifacts');
  assert.ok(uploadStart !== -1 && uploadEnd > uploadStart, 'pinned upload helper must exist');
  const pinnedUpload = deploy.slice(uploadStart, uploadEnd);

  assert.match(deploy, /\$SERVER\s*=\s*\$env:TURINGMARKET_SERVER\b/);
  assert.match(deploy, /TURINGMARKET_SERVER/);
  assert.match(deploy, /throw\s+"[^"]*TURINGMARKET_SERVER/);
  assert.doesNotMatch(deployWithoutLoopback, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  assert.doesNotMatch(deploy, /^\s*Write-(?:Host|Output|Information|Warning|Verbose|Debug).*?(?:\$SERVER|\$\{SERVER\}|TURINGMARKET_SERVER|root@|https?:\/\/)/gmi);
  assert.match(pinnedUpload, /-FileName 'ssh'/);
  assert.match(pinnedUpload, /'-o', 'BatchMode=yes'/);
  assert.match(pinnedUpload, /'-o', 'StrictHostKeyChecking=yes'/);
  assert.doesNotMatch(deploy, /\bscp(?:\.exe)?\b/i);
  assert.match(deploy, /Invoke-NativeWithUtf8Input -FileName 'ssh\.exe'/);
  assert.match(deploy, /RedirectStandardInput\s*=\s*\$inputPath/);
  assert.match(deploy, /\$normalizedInput\s*=\s*\$InputText\s+-replace\s+"`r`n\?",\s*"`n"/);
  assert.match(deploy, /WriteAllText\(\$inputPath, \$normalizedInput, \(New-Object Text\.UTF8Encoding\(\$false\)\)\)/);
  assert.match(deploy, /function Assert-Utf8StandardInputTransport/);
  assert.match(deploy, /hasBom[\s\S]*?input\.toString\('utf8'\)/);
  assert.doesNotMatch(deploy, /\$Script\s*\|\s*ssh\b/);
  assert.doesNotMatch(deploy, /StrictHostKeyChecking\s*=\s*no/i);
  assert.doesNotMatch(deploy, /UserKnownHostsFile\s*=\s*(?:NUL|\/dev\/null)/i);
});

test('guarded deploy creates complete v050 backups with client assets, SQLite, PPT cache, and checksums', () => {
  const deploy = readDeployScript();
  const backupBlock = extractRemoteBackupBlock(deploy);
  const assetsStart = deploy.indexOf('$requiredPublicAssets = @(');
  const assetsEnd = deploy.indexOf('function Invoke-RemoteBackup');
  assert.ok(assetsStart !== -1 && assetsEnd > assetsStart, 'required public asset inventory must precede backup');
  const requiredAssets = deploy.slice(assetsStart, assetsEnd);

  assert.match(deploy, /\$backupDir\s*=\s*"backups\/v050-campaign-business-spine-\$stamp"/);
  assert.match(backupBlock, /files\.present/);
  assert.match(backupBlock, /files\.absent/);
  for (const asset of [
    'client/shared/build_info.js',
    'client/core/navigation.js',
    'client/core/accessibility.js',
    'client/core/shell.js',
    'client/styles/tokens.css',
    'client/styles/components.css',
    'client/styles/layout.css'
  ]) {
    assert.ok(requiredAssets.includes(`"${asset}"`), `${asset} must remain in the required public asset inventory`);
  }
  assert.match(backupBlock, /foreach \(\$record in \$DeploymentPlan\.Records\)/);
  assert.match(backupBlock, /\$record\.RequiredPublicAsset/);
  assert.match(backupBlock, /\$record\.IncludedInBackup/);
  assert.match(backupBlock, /__PLATFORM_MANIFEST__/);
  assert.match(backupBlock, /require\('better-sqlite3'\)/);
  assert.match(backupBlock, /database\.backup\(/);
  assert.match(backupBlock, /PptCacheDir="\/var\/lib\/turingmarket\/ppt-cache"/);
  assert.match(backupBlock, /ppt-cache\.sha256/);
  assert.match(backupBlock, /SHA256SUMS/);
  assert.match(backupBlock, /cp -L \/etc\/nginx\/sites-enabled\/turingmarket "\$BackupAbsolute\/nginx\/turingmarket\.conf"/);
  assert.match(deploy, /\$BackupAbsolute\/nginx\/turingmarket\.conf/);
});

test('guarded deploy fails closed and automatically invokes the reviewed restore path', () => {
  const deploy = readDeployScript();

  assert.match(deploy, /Invoke-RemoteBackup\s+-BackupPath\s+\$backupDir/);
  assert.match(deploy, /function Invoke-DeploymentFailureRecovery[\s\S]*?'mutation-started'[\s\S]*?Invoke-RemoteRestore\s+-BackupPath\s+\$BackupPath/);
  assert.match(deploy, /catch\s*\{[\s\S]*?Invoke-DeploymentFailureRecovery\s+-BackupPath\s+\$backupDir[\s\S]*?throw/);
  assert.equal((deploy.match(/Invoke-RemoteRestore\s+-BackupPath/g) || []).length >= 2, true);
  assert.match(deploy, /Write-Host "Deploy complete"/);
});

test('guarded deploy records present and absent files instead of swallowing backup failures', () => {
  const deploy = readDeployScript();
  const backupBlock = extractRemoteBackupBlock(deploy);

  assert.doesNotMatch(backupBlock, /\|\|\s*true/);
  assert.match(backupBlock, /if \[ -f "\$file" \]/);
  assert.match(backupBlock, /printf '%s\\n' "\$file" >> "\$BackupAbsolute\/files\.present"/);
  assert.match(backupBlock, /printf '%s\\n' "\$file" >> "\$BackupAbsolute\/files\.absent"/);
  assert.match(backupBlock, /cp -- "\$file" "\$BackupAbsolute\/platform\/\$file"/);
});

test('guarded deploy always invalidates and verifies all production sessions before restart', () => {
  const deploy = readDeployScript();
  assert.doesNotMatch(deploy, /\[switch\]\$InvalidateSessions/);
  assert.match(deploy, /\[switch\]\$PreserveSessions/);
  assert.match(deploy, /if \(\$PreserveSessions\) \{[\s\S]*?throw "Phase 4 deployment rejects session preservation\."/);
  assert.doesNotMatch(deploy, /if \(\$PreserveSessions\) \{ "0" \} else \{ "1" \}/);
  assert.match(deploy, /DELETE FROM sessions/);
  assert.match(deploy, /SESSIONS_REMAINING=0/);
  const restore = deploy.match(/function Invoke-RemoteRestore[\s\S]*?(?=function Invoke-RemotePreMutationResume)/);
  const cutover = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(restore, 'rollback gate must exist');
  assert.ok(cutover, 'cutover gate must exist');
  for (const source of [restore[0], cutover[1]]) {
    assert.equal((source.match(/DELETE FROM sessions(?! WHERE)/g) || []).length, 1);
    assert.ok(source.indexOf('DELETE FROM sessions') < source.indexOf('pm2 restart ecosystem.config.js'));
    assert.ok(source.indexOf('SESSIONS_REMAINING=0') < source.indexOf('pm2 restart ecosystem.config.js'));
  }
});
