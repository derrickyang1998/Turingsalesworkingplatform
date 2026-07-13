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
  const match = deploy.match(/\$backupDir\s*=\s*"backups\/v0210-security-\$stamp"\r?\n(?<block>[\s\S]*?)\r?\nforeach \(\$file in \$FILES\)/);
  assert.ok(match, 'deploy script must define a remote backup block before uploads begin');
  return match.groups.block;
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
  assert.match(deploy, /if \(!? nginx -t|if ! nginx -t/);
  assert.match(deploy, /\$REMOTE_DIR\/\$backupDir\/nginx\/turingmarket\.conf/);
});

test('guarded deploy keeps production host external and SSH host checking enabled', () => {
  const deploy = readDeployScript();
  const commandLines = deploy.split(/\r?\n/).filter((line) => /^\s*(ssh|scp)\b/.test(line));

  assert.match(deploy, /\$SERVER\s*=\s*\$env:TURINGMARKET_SERVER\b/);
  assert.match(deploy, /TURINGMARKET_SERVER/);
  assert.match(deploy, /throw\s+"[^"]*TURINGMARKET_SERVER/);
  assert.doesNotMatch(deploy, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  assert.doesNotMatch(deploy, /^\s*Write-(?:Host|Output|Information|Warning|Verbose|Debug).*?(?:\$SERVER|\$\{SERVER\}|TURINGMARKET_SERVER|root@|https?:\/\/)/gmi);
  assert.equal(commandLines.length >= 3, true, 'deploy script should keep ssh/scp commands explicit');
  for (const line of commandLines) {
    assert.match(line, /-o\s+BatchMode=yes\b/, `${line} must force BatchMode`);
    assert.match(line, /-o\s+StrictHostKeyChecking=yes\b/, `${line} must fail closed on unknown SSH host keys`);
  }
  assert.doesNotMatch(deploy, /StrictHostKeyChecking\s*=\s*no/i);
  assert.doesNotMatch(deploy, /UserKnownHostsFile\s*=\s*(?:NUL|\/dev\/null)/i);
});

test('guarded deploy creates v0210-security backups for security-critical files with tree structure', () => {
  const deploy = readDeployScript();
  const backupBlock = extractRemoteBackupBlock(deploy);

  assert.match(deploy, /\$backupDir\s*=\s*"backups\/v0210-security-\$stamp"/);
  assert.match(backupBlock, /mkdir -p server\/scripts server\/services server\/tests/);
  assert.match(backupBlock, /mkdir -p \$backupDir\/nginx \$backupDir\/server\/scripts \$backupDir\/server\/services \$backupDir\/server\/tests/);
  assert.match(deploy, /cp server\/server\.js \$backupDir\/server\/server\.js/);
  assert.match(deploy, /if \[ -f client\/core\/navigation\.js \]; then\s*cp client\/core\/navigation\.js \$backupDir\/client\/core\/navigation\.js;\s*fi/);
  assert.match(deploy, /cp server\/services\/credential_rotation_service\.js \$backupDir\/server\/services\/credential_rotation_service\.js/);
  assert.match(deploy, /cp server\/scripts\/rotate_user_credentials\.js \$backupDir\/server\/scripts\/rotate_user_credentials\.js/);
  assert.match(deploy, /cp -L \/etc\/nginx\/sites-enabled\/turingmarket \$backupDir\/nginx\/turingmarket\.conf/);
  assert.match(deploy, /\$REMOTE_DIR\/\$backupDir\/nginx\/turingmarket\.conf/);
});

test('guarded deploy fails closed if remote backup or final remote verification fails', () => {
  const deploy = readDeployScript();

  assert.match(
    deploy,
    /ssh[\s\S]*?\r?\nif \(\$LASTEXITCODE -ne 0\) \{\r?\n\s*throw "Remote backup failed/,
    'remote backup ssh must be checked before uploads begin'
  );
  assert.match(
    deploy,
    /"@\r?\nif \(\$LASTEXITCODE -ne 0\) \{\r?\n\s*throw "Remote deploy verification failed/,
    'final remote verification ssh must be checked before reporting completion'
  );
  assert.match(deploy, /Write-Host "Deploy complete"/);
});

test('guarded deploy does not swallow required backup failures and guards optional backup files', () => {
  const deploy = readDeployScript();
  const backupBlock = extractRemoteBackupBlock(deploy);

  assert.doesNotMatch(
    backupBlock,
    /cp index\.html app\.js ppt\.js CHANGELOG\.md \$backupDir\/[^\n;]*(?:\|\|\s*true)/,
    'required top-level backup files must not be hidden behind || true'
  );
  assert.doesNotMatch(
    backupBlock,
    /cp server\/server\.js \$backupDir\/server\/server\.js[^\n;]*(?:\|\|\s*true)/,
    'required server backup files must not be hidden behind || true'
  );
  assert.match(backupBlock, /cp index\.html app\.js ppt\.js CHANGELOG\.md \$backupDir\//);
  assert.match(backupBlock, /cp server\/server\.js \$backupDir\/server\/server\.js/);
  assert.match(
    backupBlock,
    /if \[ -f server\/services\/credential_rotation_service\.js \]; then\s*cp server\/services\/credential_rotation_service\.js \$backupDir\/server\/services\/credential_rotation_service\.js;\s*fi/
  );
  assert.match(
    backupBlock,
    /if \[ -f server\/scripts\/rotate_user_credentials\.js \]; then\s*cp server\/scripts\/rotate_user_credentials\.js \$backupDir\/server\/scripts\/rotate_user_credentials\.js;\s*fi/
  );
});

test('guarded deploy can invalidate and verify all production sessions', () => {
  const deploy = readDeployScript();
  assert.doesNotMatch(deploy, /\[switch\]\$InvalidateSessions/);
  assert.match(deploy, /\[switch\]\$PreserveSessions/);
  assert.match(deploy, /if \(\$PreserveSessions\) \{ "0" \} else \{ "1" \}/);
  assert.match(deploy, /DELETE FROM sessions/);
  assert.match(deploy, /SESSIONS_REMAINING=0/);
});
