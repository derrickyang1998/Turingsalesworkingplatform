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
      ['/data/influencer_schema.json', 200],
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
  const deploy = fs.readFileSync(path.join(platformRoot, 'deploy_v8.ps1'), 'utf8');
  assert.match(deploy, /nginx\\turingmarket\.conf/);
  assert.match(deploy, /nginx -t/);
  assert.match(deploy, /systemctl reload nginx/);
  assert.match(deploy, /sites-available\/turingmarket/);
  assert.match(deploy, /if \(!? nginx -t|if ! nginx -t/);
  assert.match(deploy, /nginx-turingmarket\.conf/);
});

test('guarded deploy can invalidate and verify all production sessions', () => {
  const deploy = fs.readFileSync(path.join(platformRoot, 'deploy_v8.ps1'), 'utf8');
  assert.doesNotMatch(deploy, /\[switch\]\$InvalidateSessions/);
  assert.match(deploy, /\[switch\]\$PreserveSessions/);
  assert.match(deploy, /if \(\$PreserveSessions\) \{ "0" \} else \{ "1" \}/);
  assert.match(deploy, /DELETE FROM sessions/);
  assert.match(deploy, /SESSIONS_REMAINING=0/);
});
