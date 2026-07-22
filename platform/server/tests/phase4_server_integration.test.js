'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const Database = require('better-sqlite3');

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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited early (${child.exitCode}).\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_error) {
      // The test server is still starting.
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

async function jsonRequest(baseUrl, requestPath, options = {}) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    options.headers || {}
  );
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(baseUrl + requestPath, {
    method: options.method || 'GET',
    headers,
    body: Object.hasOwn(options, 'body')
      ? JSON.stringify(options.body)
      : undefined
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null,
    text
  };
}

async function startTestServer(prefix) {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tempDir, 'test.db');
  const outputChunks = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      TM_DISABLE_DOTENV: '1',
      SERVER_HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'phase4-server-integration-test-secret',
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, () => outputChunks.join(''));
  return {
    baseUrl,
    child,
    dbPath,
    tempDir,
    output: () => outputChunks.join(''),
    async close() {
      await stopChild(child);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function rawExchange(port, bytes, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw HTTP exchange timed out'));
    }, timeoutMs);
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('login and auth me preserve the user object and add current auth context', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-auth-context-');
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());
    assert.deepEqual(Object.keys(login.body).sort(), [
      'auth_context',
      'token',
      'user'
    ]);
    assert.deepEqual(Object.keys(login.body.auth_context.organization), [
      'id',
      'code',
      'name',
      'role_code'
    ]);
    assert.equal(login.body.auth_context.organization.code, 'turingmarket-default');
    assert.equal(login.body.auth_context.organization.role_code, 'org_admin');
    assert.equal(Array.isArray(login.body.auth_context.teams), true);
    assert.equal(login.body.auth_context.teams.length > 0, true);
    for (const team of login.body.auth_context.teams) {
      assert.deepEqual(Object.keys(team), [
        'id',
        'code',
        'name',
        'role_code'
      ]);
    }

    const me = await jsonRequest(server.baseUrl, '/api/auth/me', {
      token: login.body.token
    });
    assert.equal(me.response.status, 200);
    assert.deepEqual(me.body.user, login.body.user);
    assert.deepEqual(me.body.auth_context, login.body.auth_context);
  } finally {
    await server.close();
  }
});

test('production user writers synchronize identity state and protect the user directory', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-identity-writers-');
  try {
    const adminLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(
      adminLogin.response.status,
      200,
      adminLogin.text + '\n' + server.output()
    );

    const created = await jsonRequest(server.baseUrl, '/api/admin/users', {
      method: 'POST',
      token: adminLogin.body.token,
      body: {
        username: 'identity-user',
        password: 'IdentityUser1!Safe',
        display_name: 'Identity User',
        role: 'user',
        department: 'Sales',
        email: 'identity@example.invalid'
      }
    });
    assert.equal(created.response.status, 200, created.text);
    assert.deepEqual(Object.keys(created.body).sort(), ['id', 'message']);
    const createdUserId = Number(created.body.id);
    assert.equal(Number.isSafeInteger(createdUserId), true);

    let inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.deepEqual(
        inspection.prepare(`
          SELECT role_code,status
          FROM organization_memberships
          WHERE user_id=?
        `).get(createdUserId),
        { role_code: 'member', status: 'active' }
      );
      assert.deepEqual(
        inspection.prepare(`
          SELECT membership.role_code,membership.status,team.name
          FROM team_memberships membership
          JOIN teams team
            ON team.org_id=membership.org_id
           AND team.id=membership.team_id
          WHERE membership.user_id=? AND membership.status='active'
        `).all(createdUserId),
        [{ role_code: 'member', status: 'active', name: 'Sales' }]
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM activity_log
          WHERE action='identity_state_changed'
            AND module='identity'
            AND json_extract(details,'$.subject_user_id')=?
            AND json_extract(details,'$.reason')='user_create'
        `).get(createdUserId).count,
        1
      );
    } finally {
      inspection.close();
    }

    const memberLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'identity-user', password: 'IdentityUser1!Safe' }
    });
    assert.equal(memberLogin.response.status, 200, memberLogin.text);

    const promoted = await jsonRequest(
      server.baseUrl,
      `/api/admin/users/${createdUserId}`,
      {
        method: 'PUT',
        token: adminLogin.body.token,
        body: {
          role: 'admin',
          department: 'Leadership'
        }
      }
    );
    assert.equal(promoted.response.status, 200, promoted.text);
    assert.deepEqual(promoted.body, { success: true });

    const revokedAfterPromotion = await jsonRequest(
      server.baseUrl,
      '/api/auth/me',
      { token: memberLogin.body.token }
    );
    assert.equal(revokedAfterPromotion.response.status, 401);

    inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(
        inspection.prepare('SELECT role FROM users WHERE id=?')
          .get(createdUserId).role,
        'admin'
      );
      assert.deepEqual(
        inspection.prepare(`
          SELECT role_code,status
          FROM organization_memberships
          WHERE user_id=?
        `).get(createdUserId),
        { role_code: 'org_admin', status: 'active' }
      );
      assert.deepEqual(
        inspection.prepare(`
          SELECT membership.role_code,membership.status,team.name
          FROM team_memberships membership
          JOIN teams team
            ON team.org_id=membership.org_id
           AND team.id=membership.team_id
          WHERE membership.user_id=?
          ORDER BY membership.status,team.name
        `).all(createdUserId),
        [
          { role_code: 'team_lead', status: 'active', name: 'Leadership' },
          { role_code: 'team_lead', status: 'revoked', name: 'Sales' }
        ]
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM sessions
          WHERE user_id=?
        `).get(createdUserId).count,
        0
      );
    } finally {
      inspection.close();
    }

    const registered = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      token: adminLogin.body.token,
      body: {
        username: 'directory-member',
        password: 'DirectoryMember1!Safe',
        display_name: 'Directory Member',
        role: 'user',
        department: 'Sales',
        email: 'directory@example.invalid'
      }
    });
    assert.equal(registered.response.status, 200, registered.text);
    const registeredUserId = Number(registered.body.id);

    const directoryMemberLogin = await jsonRequest(
      server.baseUrl,
      '/api/auth/login',
      {
        method: 'POST',
        body: {
          username: 'directory-member',
          password: 'DirectoryMember1!Safe'
        }
      }
    );
    assert.equal(directoryMemberLogin.response.status, 200);

    const forbiddenDirectory = await jsonRequest(
      server.baseUrl,
      '/api/users',
      { token: directoryMemberLogin.body.token }
    );
    assert.equal(forbiddenDirectory.response.status, 403);
    assert.deepEqual(forbiddenDirectory.body, { error: 'Admin only' });

    const adminDirectory = await jsonRequest(server.baseUrl, '/api/users', {
      token: adminLogin.body.token
    });
    assert.equal(adminDirectory.response.status, 200);
    assert.equal(Array.isArray(adminDirectory.body.users), true);

    const promotedLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'identity-user', password: 'IdentityUser1!Safe' }
    });
    assert.equal(promotedLogin.response.status, 200);

    const deactivated = await jsonRequest(
      server.baseUrl,
      `/api/admin/users/${createdUserId}`,
      {
        method: 'DELETE',
        token: adminLogin.body.token
      }
    );
    assert.equal(deactivated.response.status, 200, deactivated.text);
    assert.deepEqual(deactivated.body, { success: true });

    const revokedAfterDeactivation = await jsonRequest(
      server.baseUrl,
      '/api/auth/me',
      { token: promotedLogin.body.token }
    );
    assert.equal(revokedAfterDeactivation.response.status, 401);

    inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(
        inspection.prepare('SELECT is_active FROM users WHERE id=?')
          .get(createdUserId).is_active,
        0
      );
      assert.deepEqual(
        inspection.prepare(`
          SELECT DISTINCT status
          FROM organization_memberships
          WHERE user_id=?
          UNION
          SELECT DISTINCT status
          FROM team_memberships
          WHERE user_id=?
        `).all(createdUserId, createdUserId),
        [{ status: 'revoked' }]
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM activity_log
          WHERE action='identity_state_changed'
            AND module='identity'
            AND json_extract(details,'$.subject_user_id')=?
        `).get(createdUserId).count,
        3
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM organization_memberships
          WHERE user_id=? AND status='active'
        `).get(registeredUserId).count,
        1
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM team_memberships
          WHERE user_id=? AND status='active'
        `).get(registeredUserId).count,
        1
      );
    } finally {
      inspection.close();
    }
  } finally {
    await server.close();
  }
});

test('production user writers preserve the SQLite ID high-water mark and reject noncanonical path IDs', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-user-id-boundary-');
  try {
    const adminLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(
      adminLogin.response.status,
      200,
      adminLogin.text + '\n' + server.output()
    );

    const setup = new Database(server.dbPath);
    try {
      const updated = setup.prepare(`
        UPDATE sqlite_sequence
        SET seq=500
        WHERE name='users'
      `).run();
      assert.equal(updated.changes, 1);
    } finally {
      setup.close();
    }

    const created = await jsonRequest(server.baseUrl, '/api/admin/users', {
      method: 'POST',
      token: adminLogin.body.token,
      body: {
        username: 'high-water-user',
        password: 'HighWaterUser1!Safe',
        display_name: 'High Water User',
        role: 'user',
        department: 'Sales',
        email: 'high-water@example.invalid'
      }
    });
    assert.equal(created.response.status, 200, created.text);
    assert.equal(created.body.id, 501);

    for (const rawId of ['0501', '+501', '501.0', '9007199254740992']) {
      const malformed = await jsonRequest(
        server.baseUrl,
        `/api/admin/users/${rawId}`,
        {
          method: 'PUT',
          token: adminLogin.body.token,
          body: { role: 'admin' }
        }
      );
      assert.equal(malformed.response.status, 400, rawId + ': ' + malformed.text);
      assert.deepEqual(malformed.body, { error: 'Invalid user id' });
    }

    const malformedDelete = await jsonRequest(
      server.baseUrl,
      '/api/admin/users/0501',
      {
        method: 'DELETE',
        token: adminLogin.body.token
      }
    );
    assert.equal(malformedDelete.response.status, 400, malformedDelete.text);
    assert.deepEqual(malformedDelete.body, { error: 'Invalid user id' });

    const malformedReset = await jsonRequest(
      server.baseUrl,
      '/api/admin/users/reset-password/0501',
      {
        method: 'POST',
        token: adminLogin.body.token,
        body: { password: 'WronglyCoerced1!Safe' }
      }
    );
    assert.equal(malformedReset.response.status, 400, malformedReset.text);
    assert.deepEqual(malformedReset.body, { error: 'Invalid user id' });

    const originalPasswordStillWorks = await jsonRequest(
      server.baseUrl,
      '/api/auth/login',
      {
        method: 'POST',
        body: {
          username: 'high-water-user',
          password: 'HighWaterUser1!Safe'
        }
      }
    );
    assert.equal(
      originalPasswordStillWorks.response.status,
      200,
      originalPasswordStillWorks.text
    );

    const inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.deepEqual(
        inspection.prepare(`
          SELECT id,role,is_active
          FROM users
          WHERE id=501
        `).get(),
        { id: 501, role: 'user', is_active: 1 }
      );
      assert.equal(
        inspection.prepare(`
          SELECT seq
          FROM sqlite_sequence
          WHERE name='users'
        `).get().seq,
        501
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM activity_log
          WHERE action='identity_state_changed'
            AND module='identity'
            AND json_extract(details,'$.subject_user_id')=501
        `).get().count,
        1
      );
    } finally {
      inspection.close();
    }
  } finally {
    await server.close();
  }
});

test('owned campaign ingress authenticates before reading a slow JSON body', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-auth-first-');
  try {
    const port = Number(new URL(server.baseUrl).port);
    const startedAt = Date.now();
    const response = await rawExchange(port, [
      'POST /api/campaigns HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Content-Length: 65536',
      'X-Request-Id: auth-first-campaign-request',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    assert.equal(Date.now() - startedAt < 1000, true);
    assert.match(response, /^HTTP\/1\.1 401\b/);
    assert.match(response, /\r\nX-Request-Id: auth-first-campaign-request\r\n/i);
    assert.match(response, /\r\nConnection: close\r\n/i);
    assert.match(response, /"code":"AUTHENTICATION_REQUIRED"/);
    assert.match(response, /"request_id":"auth-first-campaign-request"/);
  } finally {
    await server.close();
  }
});

test('noncanonical campaign paths stay inside authentication and request admission', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-noncanonical-paths-');
  try {
    const port = Number(new URL(server.baseUrl).port);
    const startedAt = Date.now();
    const response = await rawExchange(port, [
      'PATCH /API/CAMPAIGNS/foo/ HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Content-Length: 65536',
      'X-Request-Id: noncanonical-auth-first',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    assert.equal(Date.now() - startedAt < 1000, true);
    assert.match(response, /^HTTP\/1\.1 401\b/);
    assert.match(response, /\r\nX-Request-Id: noncanonical-auth-first\r\n/i);
    assert.match(response, /\r\nConnection: close\r\n/i);
    assert.match(response, /"code":"AUTHENTICATION_REQUIRED"/);
    assert.match(response, /"request_id":"noncanonical-auth-first"/);

    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());

    for (const requestPath of [
      '/api/campaigns/07',
      '/api/campaigns/foo',
      '/api/campaigns/+7'
    ]) {
      const malformed = await jsonRequest(server.baseUrl, requestPath, {
        token: login.body.token,
        headers: { 'X-Request-Id': 'malformed-campaign-path' }
      });
      assert.equal(malformed.response.status, 400, malformed.text);
      assert.equal(malformed.body.code, 'INVALID_CAMPAIGN_INPUT');
      assert.equal(malformed.body.request_id, 'malformed-campaign-path');
      assert.equal(
        malformed.response.headers.get('x-request-id'),
        'malformed-campaign-path'
      );
    }

    const trailing = await jsonRequest(server.baseUrl, '/api/campaigns/7/', {
      token: login.body.token,
      headers: { 'X-Request-Id': 'trailing-campaign-path' }
    });
    assert.equal(trailing.response.status, 404, trailing.text);
    assert.equal(trailing.body.code, 'CAMPAIGN_NOT_FOUND');
    assert.equal(trailing.body.request_id, 'trailing-campaign-path');
  } finally {
    await server.close();
  }
});

test('production server mounts the authenticated campaign route module', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-campaign-mount-');
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());

    const campaigns = await jsonRequest(
      server.baseUrl,
      '/api/campaigns?limit=1&offset=0',
      { token: login.body.token }
    );
    assert.equal(campaigns.response.status, 200, campaigns.text);
    assert.deepEqual(Object.keys(campaigns.body), [
      'items',
      'total',
      'limit',
      'offset'
    ]);
    assert.equal(campaigns.body.limit, 1);
    assert.equal(campaigns.body.offset, 0);
    assert.equal(Array.isArray(campaigns.body.items), true);
  } finally {
    await server.close();
  }
});
