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

test('production server serves browser assets but denies private platform files', { timeout: 30000 }, async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-public-static-'));
  const outputChunks = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'test.db'),
      JWT_SECRET: 'public-static-security-test-secret'
    },
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
      ['/data/influencer_schema.json', 200],
      ['/client/', 404],
      ['/client/core/', 404],
      ['/client/shared/', 404],
      ['/client/unknown.js', 404],
      ['/client/core/navigation.js/extra', 404],
      ['/client/core/%6eavigation.js', 404],
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
  const commandLines = deploy.split(/\r?\n/).filter((line) => /\b(?:ssh|scp)\s+-i\b/.test(line));

  assert.match(deploy, /\$SERVER\s*=\s*\$env:TURINGMARKET_SERVER\b/);
  assert.match(deploy, /TURINGMARKET_SERVER/);
  assert.match(deploy, /throw\s+"[^"]*TURINGMARKET_SERVER/);
  assert.doesNotMatch(deploy, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  assert.doesNotMatch(deploy, /^\s*Write-(?:Host|Output|Information|Warning|Verbose|Debug).*?(?:\$SERVER|\$\{SERVER\}|TURINGMARKET_SERVER|root@|https?:\/\/)/gmi);
  assert.equal(commandLines.length >= 1, true, 'deploy script should keep guarded scp invocation explicit');
  for (const line of commandLines) {
    assert.match(line, /-o\s+BatchMode=yes\b/, `${line} must force BatchMode`);
    assert.match(line, /-o\s+StrictHostKeyChecking=yes\b/, `${line} must fail closed on unknown SSH host keys`);
  }
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

test('guarded deploy creates complete v030 backups with client assets, SQLite, and checksums', () => {
  const deploy = readDeployScript();
  const backupBlock = extractRemoteBackupBlock(deploy);

  assert.match(deploy, /\$backupDir\s*=\s*"backups\/v030-baseline-consolidation-\$stamp"/);
  assert.match(backupBlock, /files\.present/);
  assert.match(backupBlock, /files\.absent/);
  assert.match(backupBlock, /client\/shared\/build_info\.js/);
  assert.match(backupBlock, /client\/core\/navigation\.js/);
  assert.match(backupBlock, /require\('better-sqlite3'\)/);
  assert.match(backupBlock, /database\.backup\(/);
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

test('guarded deploy can invalidate and verify all production sessions', () => {
  const deploy = readDeployScript();
  assert.doesNotMatch(deploy, /\[switch\]\$InvalidateSessions/);
  assert.match(deploy, /\[switch\]\$PreserveSessions/);
  assert.match(deploy, /if \(\$PreserveSessions\) \{ "0" \} else \{ "1" \}/);
  assert.match(deploy, /DELETE FROM sessions/);
  assert.match(deploy, /SESSIONS_REMAINING=0/);
});
