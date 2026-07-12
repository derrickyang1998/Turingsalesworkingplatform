const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const {
  passwordPolicyErrors,
  generateTemporaryPassword,
  rotateUserPasswords
} = require('../services/credential_rotation_service');

const platformRoot = path.join(__dirname, '..', '..');
const serverEntry = path.join(platformRoot, 'server', 'server.js');
const dbEntry = path.join(platformRoot, 'server', 'db.js');
const cliEntry = path.join(platformRoot, 'server', 'scripts', 'rotate_user_credentials.js');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-credential-rotation-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-admin-password';
  delete process.env.DEFAULT_ADMIN_USERNAME;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

function credentialAuditCount(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM activity_log WHERE action = ?').get('credential_rotation').count;
}

function getUser(db, username) {
  return db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
}

function insertSession(db, userId, token) {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (user_id, token, ip_address, expires_at) VALUES (?, ?, ?, ?)').run(userId, token, '127.0.0.1', expiresAt);
}

function assertNoSecretLeak(value, secrets) {
  const text = JSON.stringify(value);
  secrets.forEach(function(secret) {
    assert.equal(text.includes(secret), false, 'secret leaked: ' + secret);
  });
  assert.doesNotMatch(text, /\$2[aby]\$/i);
  assert.doesNotMatch(text, /password/i);
}

function assertRotationResult(result, expectedUserIds, expectedSessionsRevoked) {
  assert.deepEqual(Object.keys(result).sort(), ['rotatedUsers', 'sessionsRevoked']);
  assert.equal(Array.isArray(result.rotatedUsers), true);
  assert.equal(result.rotatedUsers.every(Number.isInteger), true);
  assert.deepEqual(result.rotatedUsers, expectedUserIds);
  assert.equal(result.sessionsRevoked, expectedSessionsRevoked);
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

async function jsonRequest(baseUrl, requestPath, options) {
  options = options || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: options.method || 'GET',
    headers,
    body: Object.prototype.hasOwnProperty.call(options, 'body') ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_error) {
      body = { raw: text };
    }
  }
  return { status: response.status, body, text };
}

async function waitForFreshJwtSecond() {
  const deadline = Date.now() + 2000;
  while (Date.now() % 1000 > 50) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for a fresh JWT timestamp second');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readAdminResetAudits(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT user_id, action, module, details, ip_address
      FROM activity_log
      WHERE action = ?
      ORDER BY id
    `).all('admin_reset_password');
  } finally {
    db.close();
  }
}

function readUserByUsername(dbPath, username) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  } finally {
    db.close();
  }
}

function readUserSessionCount(dbPath, userId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(userId).count;
  } finally {
    db.close();
  }
}

function recordEqual(failures, label, actual, expected) {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

function recordNoSecretValue(failures, label, value, secrets) {
  const text = JSON.stringify(value);
  secrets.forEach(function(secret) {
    if (text.includes(secret)) failures.push(`${label}: leaked secret ${secret}`);
  });
  if (/\$2[aby]\$/i.test(text)) failures.push(`${label}: leaked bcrypt hash`);
}

function openDatabase(dbPath, options) {
  return new Database(dbPath, options || {});
}

function createCliFixture() {
  const db = freshDb();
  const dbPath = process.env.DB_PATH;
  const zhangwei = getUser(db, 'zhangwei');
  const wangfang = getUser(db, 'wangfang');
  insertSession(db, zhangwei.id, 'cli-zhangwei-session');
  insertSession(db, wangfang.id, 'cli-wangfang-session');
  const snapshot = {
    zhangweiHash: zhangwei.password_hash,
    wangfangHash: wangfang.password_hash,
    sessionCount: db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
    auditCount: credentialAuditCount(db)
  };
  db.close();
  return { dbPath, snapshot };
}

function runCredentialCli(fixture, input) {
  const options = {
    cwd: platformRoot,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      DB_PATH: fixture.dbPath,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure'
    }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  };
  if (arguments.length === 2) options.input = input;
  return spawnSync(process.execPath, [cliEntry], options);
}

function cleanupCliFixture(fixture) {
  [fixture.dbPath, fixture.dbPath + '-wal', fixture.dbPath + '-shm'].forEach(function(filePath) {
    fs.rmSync(filePath, { force: true });
  });
}

function cleanupDbFiles(dbPath) {
  [dbPath, dbPath + '-wal', dbPath + '-shm'].forEach(function(filePath) {
    fs.rmSync(filePath, { force: true });
  });
}

function isolatedServerEnv(overrides) {
  const env = Object.assign({}, process.env);
  ['DB_PATH', 'NODE_ENV', 'DEFAULT_ADMIN_USERNAME', 'DEFAULT_ADMIN_PASSWORD'].forEach(function(key) {
    delete env[key];
  });
  Object.keys(env).forEach(function(key) {
    if (/^USER_PASSWORD_/i.test(key)) delete env[key];
  });
  return Object.assign(env, overrides || {});
}

function requireDbInChild(env) {
  return spawnSync(process.execPath, ['-e', 'const db = require(process.env.TM_DB_ENTRY); db.close();'], {
    cwd: platformRoot,
    env: isolatedServerEnv(Object.assign({ TM_DB_ENTRY: dbEntry }, env || {})),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
}

function readUserCount(dbPath) {
  if (!fs.existsSync(dbPath)) return 0;
  const db = openDatabase(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  } catch (error) {
    if (/no such table/i.test(error.message)) return 0;
    throw error;
  } finally {
    db.close();
  }
}

function assertCliSummaryOnly(result, expectedRotatedUsers, expectedSessionsRevoked) {
  assert.equal(result.stdout, [
    `ROTATED_USERS=${expectedRotatedUsers}`,
    `SESSIONS_REVOKED=${expectedSessionsRevoked}`,
    'PASSWORD_VALUES_PRINTED=0',
    ''
  ].join('\n'));
  assert.equal(result.stderr, '');
}

function assertCliDidNotPrintSecrets(result, secrets) {
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  secrets.forEach(function(secret) {
    assert.equal(combinedOutput.includes(secret), false, 'CLI output leaked password value: ' + secret);
  });
  assert.doesNotMatch(combinedOutput, /\$2[aby]\$/i);
}

function assertCliFailurePreservedSnapshot(fixture, result, secrets) {
  assert.notEqual(result.status, 0);
  assertCliSummaryOnly(result, 0, 0);
  assertCliDidNotPrintSecrets(result, secrets);

  const db = openDatabase(fixture.dbPath, { readonly: true });
  try {
    assert.equal(getUser(db, 'zhangwei').password_hash, fixture.snapshot.zhangweiHash);
    assert.equal(getUser(db, 'wangfang').password_hash, fixture.snapshot.wangfangHash);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, fixture.snapshot.sessionCount);
    assert.equal(credentialAuditCount(db), fixture.snapshot.auditCount);
  } finally {
    db.close();
  }
}

test('stdin-only credential rotation CLI rejects invalid inputs without partial mutation or secret output', () => {
  const cases = [
    {
      label: 'no stdin input',
      input: undefined,
      secrets: []
    },
    {
      label: 'malformed JSON',
      input: '{"actor_username":',
      secrets: []
    },
    {
      label: 'weak password',
      input: JSON.stringify({
        actor_username: 'admin',
        invalidate_all_sessions: true,
        rotations: [
          { username: 'zhangwei', password: 'ValidZhang1!Secure' },
          { username: 'wangfang', password: 'weak' }
        ],
        reason: 'cli weak password test'
      }),
      secrets: ['ValidZhang1!Secure', 'weak']
    },
    {
      label: 'unknown target user',
      input: JSON.stringify({
        actor_username: 'admin',
        invalidate_all_sessions: true,
        rotations: [
          { username: 'zhangwei', password: 'ValidZhang1!Secure' },
          { username: 'missing-user', password: 'MissingUser1!Secure' }
        ],
        reason: 'cli unknown user test'
      }),
      secrets: ['ValidZhang1!Secure', 'MissingUser1!Secure']
    },
    {
      label: 'actor mismatch',
      input: JSON.stringify({
        actor_username: 'zhangwei',
        invalidate_all_sessions: true,
        rotations: [
          { username: 'zhangwei', password: 'ValidZhang1!Secure' },
          { username: 'wangfang', password: 'ValidWang2!Secure' }
        ],
        reason: 'cli actor mismatch test'
      }),
      secrets: ['ValidZhang1!Secure', 'ValidWang2!Secure']
    }
  ];

  cases.forEach(function(cliCase) {
    const fixture = createCliFixture();
    const result = cliCase.input === undefined
      ? runCredentialCli(fixture)
      : runCredentialCli(fixture, cliCase.input);
    assertCliFailurePreservedSnapshot(fixture, result, cliCase.secrets, cliCase.label);
    cleanupCliFixture(fixture);
  });
});

test('stdin-only credential rotation CLI rotates two users atomically and prints only sanitized summary lines', () => {
  const fixture = createCliFixture();
  const zhangweiPassword = 'CliRotateZhang1!Secure';
  const wangfangPassword = 'CliRotateWang2!Secure';
  const result = runCredentialCli(fixture, JSON.stringify({
    actor_username: 'admin',
    invalidate_all_sessions: true,
    rotations: [
      { username: 'zhangwei', password: zhangweiPassword },
      { username: 'wangfang', password: wangfangPassword }
    ],
    reason: 'cli success rotation test'
  }));

  assert.equal(result.status, 0, `CLI failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  assertCliSummaryOnly(result, 2, 2);
  assertCliDidNotPrintSecrets(result, [zhangweiPassword, wangfangPassword]);

  const db = openDatabase(fixture.dbPath, { readonly: true });
  try {
    const zhangweiAfter = getUser(db, 'zhangwei');
    const wangfangAfter = getUser(db, 'wangfang');
    assert.notEqual(zhangweiAfter.password_hash, fixture.snapshot.zhangweiHash);
    assert.notEqual(wangfangAfter.password_hash, fixture.snapshot.wangfangHash);
    assert.equal(bcrypt.compareSync(zhangweiPassword, zhangweiAfter.password_hash), true);
    assert.equal(bcrypt.compareSync(wangfangPassword, wangfangAfter.password_hash), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);

    const audits = db.prepare('SELECT details FROM activity_log WHERE action = ? ORDER BY id').all('credential_rotation');
    assert.equal(audits.length, 2);
    audits.forEach(function(row) {
      assertNoSecretLeak(JSON.parse(row.details), [zhangweiPassword, wangfangPassword]);
    });
  } finally {
    db.close();
    cleanupCliFixture(fixture);
  }
});

test('two same-user logins within one JWT second return distinct session tokens', { timeout: 30000 }, async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-login-jti-route-'));
  const dbPath = path.join(tempDir, 'test.db');
  const outputChunks = [];
  const memberPassword = 'SameSecond1!Secure';
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'same-second-login-test-secret',
      USER_PASSWORD_ZHANGWEI: memberPassword
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child, () => outputChunks.join(''));
    await waitForFreshJwtSecond();

    const loginRequest = () => jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'zhangwei', password: memberPassword }
    });
    const [firstLogin, secondLogin] = await Promise.all([loginRequest(), loginRequest()]);

    assert.equal(firstLogin.status, 200, `first same-second login failed: ${firstLogin.text}`);
    assert.equal(secondLogin.status, 200, `second same-second login failed: ${secondLogin.text}\n${outputChunks.join('')}`);
    const firstPayload = jwt.decode(firstLogin.body.token);
    const secondPayload = jwt.decode(secondLogin.body.token);
    assert.equal(firstPayload.iat, secondPayload.iat, 'test precondition: both tokens must be issued in the same JWT second');
    assert.notEqual(firstLogin.body.token, secondLogin.body.token);
    assert.equal(typeof firstPayload.jti, 'string');
    assert.equal(typeof secondPayload.jti, 'string');
    assert.notEqual(firstPayload.jti, secondPayload.jti);
  } finally {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('admin reset route rejects weak passwords, revokes the old token, supports new login, and writes sanitized audit IPs', { timeout: 30000 }, async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-credential-route-'));
  const dbPath = path.join(tempDir, 'test.db');
  const outputChunks = [];
  const oldPassword = 'OldZhang1!Secure';
  const newPassword = 'NewZhang2!Secure';
  const weakPassword = 'weak';
  const forwardedIp = '198.51.100.42';
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'credential-route-test-secret',
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure',
      USER_PASSWORD_ZHANGWEI: oldPassword
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child, () => outputChunks.join(''));

    const adminLogin = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(adminLogin.status, 200, 'admin login should succeed before route checks');
    await waitForFreshJwtSecond();
    const memberLogin = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'zhangwei', password: oldPassword }
    });
    assert.equal(memberLogin.status, 200, 'member login should establish an old token before reset');

    const adminToken = adminLogin.body.token;
    const oldMemberToken = memberLogin.body.token;
    const memberId = memberLogin.body.user.id;
    const actorId = adminLogin.body.user.id;

    const reset = await jsonRequest(baseUrl, `/api/admin/users/reset-password/${memberId}`, {
      method: 'POST',
      token: adminToken,
      headers: { 'X-Forwarded-For': forwardedIp },
      body: { password: newPassword }
    });
    const newPasswordLogin = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'zhangwei', password: newPassword }
    });
    const oldTokenMe = await jsonRequest(baseUrl, '/api/auth/me', { token: oldMemberToken });
    const oldPasswordLogin = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'zhangwei', password: oldPassword }
    });
    const weakReset = await jsonRequest(baseUrl, `/api/admin/users/reset-password/${memberId}`, {
      method: 'POST',
      token: adminToken,
      body: { password: weakPassword }
    });
    const unknownReset = await jsonRequest(baseUrl, '/api/admin/users/reset-password/99999999', {
      method: 'POST',
      token: adminToken,
      body: { password: 'UnknownUser1!Secure' }
    });
    const audits = readAdminResetAudits(dbPath);

    const failures = [];
    recordEqual(failures, 'valid reset status', reset.status, 200);
    recordEqual(failures, 'valid reset success flag', reset.body.success, true);
    recordEqual(failures, 'valid reset revoked sessions', reset.body.sessions_revoked, 1);
    recordEqual(failures, 'valid reset hides caller-supplied temporary password', Object.prototype.hasOwnProperty.call(reset.body, 'temporary_password'), false);
    recordNoSecretValue(failures, 'valid reset response', reset.body, [newPassword]);
    recordEqual(failures, 'old token /api/auth/me status after reset', oldTokenMe.status, 401);
    recordEqual(failures, 'old password login status after reset', oldPasswordLogin.status, 401);
    recordEqual(failures, 'new password login status after reset', newPasswordLogin.status, 200);
    if (newPasswordLogin.status === 200) {
      const oldPayload = jwt.decode(oldMemberToken);
      const newPayload = jwt.decode(newPasswordLogin.body.token);
      recordEqual(failures, 'old and immediate new token JWT second', newPayload.iat, oldPayload.iat);
      if (newPasswordLogin.body.token === oldMemberToken) failures.push('immediate new login recreated the captured old token');
      if (typeof newPayload.jti !== 'string') failures.push('immediate new login token is missing a string jti');
      if (newPayload.jti === oldPayload.jti) failures.push('immediate new login reused the old token jti');
    }
    recordEqual(failures, 'weak supplied password reset status', weakReset.status, 400);
    recordNoSecretValue(failures, 'weak reset response', weakReset.body, [weakPassword]);
    recordEqual(failures, 'unknown user reset status', unknownReset.status, 404);
    recordEqual(failures, 'admin_reset_password audit row count', audits.length, 1);
    if (audits.length === 1) {
      const audit = audits[0];
      let details = {};
      try {
        details = JSON.parse(audit.details);
      } catch (_error) {
        failures.push('admin_reset_password audit details: not valid JSON');
      }
      recordEqual(failures, 'audit actor row user_id', audit.user_id, actorId);
      recordEqual(failures, 'audit action', audit.action, 'admin_reset_password');
      recordEqual(failures, 'audit module', audit.module, 'security');
      recordEqual(failures, 'audit forwarded IP', audit.ip_address, forwardedIp);
      recordEqual(failures, 'audit detail actorUserId', details.actorUserId, actorId);
      recordEqual(failures, 'audit detail targetUserId', details.targetUserId, memberId);
      recordEqual(failures, 'audit detail targetUsername', details.targetUsername, 'zhangwei');
      recordEqual(failures, 'audit detail sessionsRevoked', details.sessionsRevoked, 1);
      assertNoSecretLeak(details, [oldPassword, newPassword, weakPassword]);
    }

    if (failures.length) assert.fail(failures.join('\n'));
  } finally {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('admin reset route redacts caller password when it collides with the audited target username', { timeout: 30000 }, async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-credential-route-redaction-'));
  const dbPath = path.join(tempDir, 'test.db');
  const outputChunks = [];
  const collidingSecret = 'CollisionRoute3!Secure';
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'credential-route-redaction-test-secret',
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child, () => outputChunks.join(''));

    const adminLogin = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(adminLogin.status, 200, 'admin login should succeed before redaction route check');

    const createUser = await jsonRequest(baseUrl, '/api/admin/users', {
      method: 'POST',
      token: adminLogin.body.token,
      body: {
        username: collidingSecret,
        display_name: 'Collision Route User',
        role: 'user',
        password: 'InitialRoute4!Secure'
      }
    });
    assert.equal(createUser.status, 200, 'admin should create a target with a password-like username');

    const reset = await jsonRequest(baseUrl, `/api/admin/users/reset-password/${createUser.body.id}`, {
      method: 'POST',
      token: adminLogin.body.token,
      body: { password: collidingSecret }
    });
    assert.equal(reset.status, 200, 'colliding password still satisfies policy and should reset');

    const audits = readAdminResetAudits(dbPath).filter(function(row) {
      const details = JSON.parse(row.details);
      return details.targetUserId === createUser.body.id;
    });
    assert.equal(audits.length, 1);
    const details = JSON.parse(audits[0].details);
    assert.equal(details.targetUserId, createUser.body.id);
    assert.equal(details.targetUsername, '[REDACTED]');
    assertNoSecretLeak(details, [collidingSecret]);
  } finally {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('admin reset route rejects a weak password equal to the target username without leaking or mutating state', { timeout: 30000 }, async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-credential-route-weak-collision-'));
  const dbPath = path.join(tempDir, 'test.db');
  const outputChunks = [];
  const targetUsername = 'zhangwei';
  const oldPassword = 'CollisionOld1!Secure';
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'credential-route-weak-collision-test-secret',
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure',
      USER_PASSWORD_ZHANGWEI: oldPassword
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child, () => outputChunks.join(''));

    const adminLogin = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(adminLogin.status, 200, 'admin login should succeed before weak collision reset check');
    const memberLogin = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: targetUsername, password: oldPassword }
    });
    assert.equal(memberLogin.status, 200, 'member login should create a session before rejected reset');

    const beforeUser = readUserByUsername(dbPath, targetUsername);
    const beforeSessionCount = readUserSessionCount(dbPath, beforeUser.id);
    const reset = await jsonRequest(baseUrl, `/api/admin/users/reset-password/${beforeUser.id}`, {
      method: 'POST',
      token: adminLogin.body.token,
      body: { password: targetUsername }
    });
    const afterUser = readUserByUsername(dbPath, targetUsername);

    assert.equal(reset.status, 400);
    assert.equal(JSON.stringify(reset.body).includes(targetUsername), false);
    assert.doesNotMatch(JSON.stringify(reset.body), /\$2[aby]\$/i);
    assert.equal(afterUser.password_hash, beforeUser.password_hash);
    assert.equal(readUserSessionCount(dbPath, beforeUser.id), beforeSessionCount);
    assert.equal(bcrypt.compareSync(oldPassword, afterUser.password_hash), true);
    assert.equal(readAdminResetAudits(dbPath).length, 0);
  } finally {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('admin user creation routes reject weak supplied passwords and generate policy-compliant temporary passwords', { timeout: 30000 }, async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-user-create-policy-route-'));
  const dbPath = path.join(tempDir, 'test.db');
  const outputChunks = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'user-create-policy-route-test-secret',
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child, () => outputChunks.join(''));

    const adminLogin = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(adminLogin.status, 200, 'admin login should succeed before user creation route checks');
    const adminToken = adminLogin.body.token;

    const createRouteCases = [
      { route: '/api/admin/users', weakUsername: 'weak_admin_users_route', generatedUsername: 'generated_admin_users_route' },
      { route: '/api/auth/register', weakUsername: 'weak_auth_register_route', generatedUsername: 'generated_auth_register_route' }
    ];

    for (const routeCase of createRouteCases) {
      const weakPassword = 'weak';
      const weakCreate = await jsonRequest(baseUrl, routeCase.route, {
        method: 'POST',
        token: adminToken,
        body: {
          username: routeCase.weakUsername,
          display_name: routeCase.weakUsername,
          role: 'user',
          password: weakPassword
        }
      });
      assert.equal(weakCreate.status, 400, `${routeCase.route} should reject a weak supplied password`);
      assert.equal(readUserByUsername(dbPath, routeCase.weakUsername), undefined, `${routeCase.route} should not create a weak-password user`);
      const weakCreateText = JSON.stringify(weakCreate.body);
      assert.equal(weakCreateText.includes(weakPassword), false);
      assert.doesNotMatch(weakCreateText, /\$2[aby]\$/i);

      const generatedCreate = await jsonRequest(baseUrl, routeCase.route, {
        method: 'POST',
        token: adminToken,
        body: {
          username: routeCase.generatedUsername,
          display_name: routeCase.generatedUsername,
          role: 'user'
        }
      });
      assert.equal(generatedCreate.status, 200, `${routeCase.route} should create a user without a caller-supplied password`);
      assert.equal(typeof generatedCreate.body.temporary_password, 'string');
      assert.deepEqual(passwordPolicyErrors(generatedCreate.body.temporary_password), []);

      const createdUser = readUserByUsername(dbPath, routeCase.generatedUsername);
      assert.ok(createdUser, `${routeCase.route} should persist the generated-password user`);
      assert.equal(bcrypt.compareSync(generatedCreate.body.temporary_password, createdUser.password_hash), true);
    }
  } finally {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production empty DB rejects weak DEFAULT_ADMIN_PASSWORD before inserting any user', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-prod-seed-admin-policy-'));
  const dbPath = path.join(tempDir, 'test.db');
  const weakPassword = 'weakpass';
  try {
    const result = requireDbInChild({
      NODE_ENV: 'production',
      DB_PATH: dbPath,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: weakPassword
    });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0, output);
    assert.match(output, /Password policy failed/);
    assert.equal(output.includes(weakPassword), false);
    assert.doesNotMatch(output, /\$2[aby]\$/i);
    assert.equal(readUserCount(dbPath), 0);
  } finally {
    cleanupDbFiles(dbPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production empty DB rejects weak supplied USER_PASSWORD values before inserting any user', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-prod-seed-user-policy-'));
  const dbPath = path.join(tempDir, 'test.db');
  const weakPassword = 'weakpass';
  try {
    const result = requireDbInChild({
      NODE_ENV: 'production',
      DB_PATH: dbPath,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminSeed1!Secure',
      USER_PASSWORD_ZHANGWEI: weakPassword
    });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0, output);
    assert.match(output, /Password policy failed/);
    assert.equal(output.includes(weakPassword), false);
    assert.doesNotMatch(output, /\$2[aby]\$/i);
    assert.equal(readUserCount(dbPath), 0);
  } finally {
    cleanupDbFiles(dbPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production startup with an existing admin ignores weak legacy seed env', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-prod-existing-admin-policy-'));
  const dbPath = path.join(tempDir, 'test.db');
  try {
    const initial = requireDbInChild({
      NODE_ENV: 'production',
      DB_PATH: dbPath,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminSeed1!Secure'
    });
    assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`);
    const seededUserCount = readUserCount(dbPath);
    assert.equal(seededUserCount > 0, true);

    const restart = requireDbInChild({
      NODE_ENV: 'production',
      DB_PATH: dbPath,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'weakpass',
      USER_PASSWORD_ZHANGWEI: 'weakpass'
    });
    assert.equal(restart.status, 0, `${restart.stdout}\n${restart.stderr}`);
    assert.equal(readUserCount(dbPath), seededUserCount);
  } finally {
    cleanupDbFiles(dbPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('auth me accepts valid tokens only through Authorization Bearer headers', { timeout: 30000 }, async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-auth-me-bearer-only-'));
  const dbPath = path.join(tempDir, 'test.db');
  const outputChunks = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'auth-me-bearer-only-test-secret',
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child, () => outputChunks.join(''));

    const adminLogin = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(adminLogin.status, 200, 'admin login should succeed before auth/me route checks');

    const token = adminLogin.body.token;
    const queryTokenMe = await jsonRequest(baseUrl, `/api/auth/me?token=${encodeURIComponent(token)}`);
    const rawAuthorizationMe = await jsonRequest(baseUrl, '/api/auth/me', {
      headers: { Authorization: token }
    });
    const bearerMe = await jsonRequest(baseUrl, '/api/auth/me', { token });

    assert.equal(queryTokenMe.status, 401);
    assert.equal(rawAuthorizationMe.status, 401);
    assert.equal(bearerMe.status, 200);
    assert.equal(bearerMe.body.user.username, 'admin');
  } finally {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('password policy reports short passwords and missing required categories', () => {
  assert.deepEqual(passwordPolicyErrors('Aa1!Aa1!Aa1!'), []);
  assert.deepEqual(passwordPolicyErrors('Aa1!'), ['Password must be at least 12 characters long.']);
  assert.deepEqual(passwordPolicyErrors('lowercase1!x'), ['Password must include an uppercase letter.']);
  assert.deepEqual(passwordPolicyErrors('UPPERCASE1!X'), ['Password must include a lowercase letter.']);
  assert.deepEqual(passwordPolicyErrors('NoDigitsHere!'), ['Password must include a digit.']);
  assert.deepEqual(passwordPolicyErrors('NoSymbol1234'), ['Password must include a symbol.']);
});

test('temporary passwords are long and satisfy every required category', () => {
  for (let index = 0; index < 25; index += 1) {
    const password = generateTemporaryPassword();
    assert.equal(password.length >= 20, true);
    assert.deepEqual(passwordPolicyErrors(password), []);
  }
});

function assertPolicyRejectionDoesNotMutate(password, expectedError) {
  const db = freshDb();
  try {
    const user = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get('zhangwei');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (user_id, token, ip_address, expires_at) VALUES (?, ?, ?, ?)').run(user.id, 'weak-session', '127.0.0.1', expiresAt);

    const before = {
      hash: user.password_hash,
      sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
      audits: credentialAuditCount(db)
    };

    assert.throws(function() {
      rotateUserPasswords(db, {
        actorUserId: 1,
        rotations: [{ username: 'zhangwei', password: password }],
        invalidateAllSessions: true,
        ipAddress: '127.0.0.1',
        reason: 'policy test'
      });
    }, expectedError);

    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id).password_hash, before.hash);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, before.sessions);
    assert.equal(credentialAuditCount(db), before.audits);
  } finally {
    db.close();
  }
}

[
  { category: 'minimum length', password: 'TooShort1!', error: /at least 12 characters/ },
  { category: 'uppercase', password: 'lowercase123!', error: /uppercase letter/ },
  { category: 'lowercase', password: 'UPPERCASE123!', error: /lowercase letter/ },
  { category: 'digit', password: 'NoDigitsHere!', error: /include a digit/ },
  { category: 'symbol', password: 'NoSymbol1234', error: /include a symbol/ }
].forEach(function(policyCase) {
  test('rotation rejects missing ' + policyCase.category + ' before mutating users, sessions, or audit logs', () => {
    assertPolicyRejectionDoesNotMutate(policyCase.password, policyCase.error);
  });
});

test('rotation policy rejection does not leak the target username when it equals the supplied password', () => {
  const db = freshDb();
  try {
    const targetUsername = 'zhangwei';
    const user = getUser(db, targetUsername);
    insertSession(db, user.id, 'weak-collision-session');
    const before = {
      hash: user.password_hash,
      sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(user.id).count,
      audits: credentialAuditCount(db)
    };

    assert.throws(function() {
      rotateUserPasswords(db, {
        actorUserId: 1,
        rotations: [{ username: targetUsername, password: targetUsername }],
        invalidateAllSessions: true,
        ipAddress: '127.0.0.1',
        reason: 'weak username collision'
      });
    }, function(error) {
      assert.match(error.message, /Password policy failed/);
      assert.equal(error.message.includes(targetUsername), false);
      assert.doesNotMatch(error.message, /\$2[aby]\$/i);
      return true;
    });

    assert.equal(getUser(db, targetUsername).password_hash, before.hash);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(user.id).count, before.sessions);
    assert.equal(credentialAuditCount(db), before.audits);
  } finally {
    db.close();
  }
});

test('multi-user rotation changes hashes, revokes affected sessions, and writes sanitized audit rows', () => {
  const db = freshDb();
  const actor = getUser(db, 'admin');
  const zhangwei = getUser(db, 'zhangwei');
  const wangfang = getUser(db, 'wangfang');
  const liming = getUser(db, 'liming');
  insertSession(db, zhangwei.id, 'zhangwei-session-1');
  insertSession(db, zhangwei.id, 'zhangwei-session-2');
  insertSession(db, wangfang.id, 'wangfang-session-1');
  insertSession(db, liming.id, 'liming-session-1');

  const rotations = [
    { username: 'zhangwei', password: 'RotatedZhang1!Secure' },
    { username: 'wangfang', password: 'RotatedWang2!Secure' }
  ];
  const result = rotateUserPasswords(db, {
    actorUserId: actor.id,
    rotations,
    invalidateAllSessions: false,
    ipAddress: '10.0.0.9',
    reason: 'incident response'
  });

  assertRotationResult(result, [zhangwei.id, wangfang.id], 3);
  assertNoSecretLeak(result, rotations.map(function(rotation) { return rotation.password; }));

  const zhangweiAfter = getUser(db, 'zhangwei');
  const wangfangAfter = getUser(db, 'wangfang');
  assert.notEqual(zhangweiAfter.password_hash, zhangwei.password_hash);
  assert.notEqual(wangfangAfter.password_hash, wangfang.password_hash);
  assert.equal(bcrypt.compareSync(rotations[0].password, zhangweiAfter.password_hash), true);
  assert.equal(bcrypt.compareSync(rotations[1].password, wangfangAfter.password_hash), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id IN (?, ?)').get(zhangwei.id, wangfang.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(liming.id).count, 1);

  const audits = db.prepare('SELECT user_id, action, module, details, ip_address FROM activity_log WHERE action = ? ORDER BY id').all('credential_rotation');
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map(function(row) { return JSON.parse(row.details).targetUsername; }).sort(), ['wangfang', 'zhangwei']);
  audits.forEach(function(row) {
    const details = JSON.parse(row.details);
    assert.equal(row.user_id, actor.id);
    assert.equal(row.module, 'security');
    assert.equal(row.ip_address, '10.0.0.9');
    assert.equal(details.actorUserId, actor.id);
    assert.equal(details.reason, 'incident response');
    assert.equal(details.invalidateAllSessions, false);
    assert.equal(typeof details.targetUserId, 'number');
    assertNoSecretLeak(details, rotations.map(function(rotation) { return rotation.password; }));
  });

  db.close();
});

test('rotation redacts every supplied password from audit strings while preserving incident reason', () => {
  const db = freshDb();
  try {
    const actor = getUser(db, 'admin');
    const rotations = [
      { username: 'zhangwei', password: 'ReasonLeakZhang1!Secure' },
      { username: 'wangfang', password: 'ReasonLeakWang2!Secure' }
    ];
    const secrets = rotations.map(function(rotation) { return rotation.password; });

    rotateUserPasswords(db, {
      actorUserId: actor.id,
      rotations: rotations,
      invalidateAllSessions: false,
      ipAddress: '10.0.0.12/' + secrets[1],
      reason: 'Incident 42 exposed ' + secrets[0] + ' and ' + secrets[1] + '; SOC requested forced rotation.'
    });

    const audits = db.prepare(`
      SELECT action, module, details, ip_address
      FROM activity_log
      WHERE action = ?
      ORDER BY id
    `).all('credential_rotation');
    assert.equal(audits.length, 2);
    audits.forEach(function(row) {
      Object.entries(row).forEach(function(entry) {
        const field = entry[0];
        const value = entry[1];
        if (typeof value !== 'string') return;
        secrets.forEach(function(secret) {
          assert.equal(value.includes(secret), false, 'secret leaked in audit field: ' + field);
        });
      });

      const details = JSON.parse(row.details);
      assert.equal(details.reason, 'Incident 42 exposed [REDACTED] and [REDACTED]; SOC requested forced rotation.');
      assert.equal(row.ip_address, '10.0.0.12/[REDACTED]');
    });
  } finally {
    db.close();
  }
});

test('rotation result cannot leak a password that equals another target username', () => {
  const db = freshDb();
  try {
    const actor = getUser(db, 'admin');
    const zhangwei = getUser(db, 'zhangwei');
    const collidingUsername = 'CollisionUser1!Secure';
    const collisionUserId = Number(db.prepare(`
      INSERT INTO users (username, password_hash, display_name, role, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).run(
      collidingUsername,
      bcrypt.hashSync('ExistingCollision3!Secure', 10),
      'Collision User',
      'user'
    ).lastInsertRowid);
    const rotations = [
      { username: zhangwei.username, password: collidingUsername },
      { username: collidingUsername, password: 'ReplacementCollision2!Secure' }
    ];
    const secrets = rotations.map(function(rotation) { return rotation.password; });

    const result = rotateUserPasswords(db, {
      actorUserId: actor.id,
      rotations: rotations,
      invalidateAllSessions: false,
      ipAddress: '10.0.0.13',
      reason: 'username collision regression'
    });

    assertNoSecretLeak(result, secrets);
    assertRotationResult(result, [zhangwei.id, collisionUserId], 0);

    const audits = db.prepare('SELECT details FROM activity_log WHERE action = ? ORDER BY id').all('credential_rotation');
    const details = audits.map(function(row) { return JSON.parse(row.details); });
    assert.deepEqual(details.map(function(entry) { return entry.targetUserId; }), [zhangwei.id, collisionUserId]);
    assert.equal(details[1].targetUsername, '[REDACTED]');
    details.forEach(function(entry) {
      assert.equal(entry.reason, 'username collision regression');
      assertNoSecretLeak(entry, secrets);
    });
  } finally {
    db.close();
  }
});

test('rotation can revoke all active sessions when requested', () => {
  const db = freshDb();
  const actor = getUser(db, 'admin');
  const zhangwei = getUser(db, 'zhangwei');
  const liming = getUser(db, 'liming');
  insertSession(db, zhangwei.id, 'zhangwei-global-rotation');
  insertSession(db, liming.id, 'liming-global-rotation');

  const result = rotateUserPasswords(db, {
    actorUserId: actor.id,
    rotations: [{ username: 'zhangwei', password: 'GlobalRotate1!Secure' }],
    invalidateAllSessions: true,
    ipAddress: '10.0.0.10',
    reason: 'global revocation'
  });

  assertRotationResult(result, [zhangwei.id], 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  const audit = db.prepare('SELECT details FROM activity_log WHERE action = ?').get('credential_rotation');
  assert.equal(JSON.parse(audit.details).invalidateAllSessions, true);

  db.close();
});

test('rotation rolls back password and session changes when audit logging fails', () => {
  const db = freshDb();
  const actor = getUser(db, 'admin');
  const zhangwei = getUser(db, 'zhangwei');
  const wangfang = getUser(db, 'wangfang');
  insertSession(db, zhangwei.id, 'atomic-zhangwei');
  insertSession(db, wangfang.id, 'atomic-wangfang');
  db.exec(`
    CREATE TRIGGER fail_credential_rotation_audit
    BEFORE INSERT ON activity_log
    WHEN NEW.action = 'credential_rotation'
    BEGIN
      SELECT RAISE(ABORT, 'audit offline');
    END;
  `);

  assert.throws(function() {
    rotateUserPasswords(db, {
      actorUserId: actor.id,
      rotations: [
        { username: 'zhangwei', password: 'AtomicZhang1!Secure' },
        { username: 'wangfang', password: 'AtomicWang2!Secure' }
      ],
      invalidateAllSessions: false,
      ipAddress: '10.0.0.11',
      reason: 'atomicity test'
    });
  }, /audit offline/);

  assert.equal(getUser(db, 'zhangwei').password_hash, zhangwei.password_hash);
  assert.equal(getUser(db, 'wangfang').password_hash, wangfang.password_hash);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
  assert.equal(credentialAuditCount(db), 0);

  db.close();
});
