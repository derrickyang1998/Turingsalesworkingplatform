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

test('production registers all six shared workflow policies and classifies malformed, missing, and linked IDs before parsers', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-workflow-owner-');
  try {
    const missing = await jsonRequest(
      server.baseUrl,
      '/api/workflow/tasks/880099/approve',
      { method: 'POST', headers: { 'X-Request-Id': 'missing-workflow-task' } }
    );
    assert.equal(missing.response.status, 401, missing.text);
    assert.deepEqual(missing.body, { error: 'No token provided' });
    assert.equal(missing.response.headers.get('x-request-id'), null);

    const malformed = await jsonRequest(
      server.baseUrl,
      '/api/workflow/tasks/01/approve',
      { method: 'POST', headers: { 'X-Request-Id': 'malformed-workflow-task' } }
    );
    assert.equal(malformed.response.status, 401, malformed.text);
    assert.equal(malformed.body.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(malformed.body.request_id, 'malformed-workflow-task');
    assert.equal(
      malformed.response.headers.get('x-request-id'),
      'malformed-workflow-task'
    );

    const inspection = new Database(server.dbPath);
    let linkedTaskId;
    try {
      inspection.pragma('busy_timeout = 5000');
      const identity = inspection.prepare(`
        SELECT user.id AS user_id,membership.org_id,team.team_id
        FROM users user
        JOIN organization_memberships membership
          ON membership.user_id=user.id AND membership.status='active'
        JOIN team_memberships team
          ON team.user_id=user.id AND team.org_id=membership.org_id
         AND team.status='active'
        WHERE user.is_active=1
        ORDER BY CASE WHEN membership.role_code='org_admin' THEN 0 ELSE 1 END,user.id
        LIMIT 1
      `).get();
      assert.ok(identity);
      inspection.prepare(`
        INSERT INTO customers (id,brand_name,company_name,stage,source,created_by,assigned_to)
        VALUES (880001,'Classifier brand','Classifier company','qualified','test',?,?)
      `).run(identity.user_id, identity.user_id);
      inspection.prepare(`
        INSERT INTO opportunities (
          id,customer_id,name,stage,value,win_probability,product_name,
          channel_type,created_by
        ) VALUES (880002,880001,'Classifier opportunity','proposal',1,50,'Test','influencer',?)
      `).run(identity.user_id);
      inspection.prepare(`
        INSERT INTO campaigns (
          id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
          lifecycle_state,operational_status,row_version
        ) VALUES (880003,?,'Classifier campaign',880001,880002,?,?,'lead','active',1)
      `).run(identity.org_id, identity.user_id, identity.team_id);
      inspection.prepare(`
        INSERT INTO workflow_templates (
          id,name,description,module,category,nodes,edges,version,is_active,created_by
        ) VALUES (880004,'Classifier workflow','','customer','approval','[]','[]',1,1,?)
      `).run(identity.user_id);
      const instanceId = Number(inspection.prepare(`
        INSERT INTO workflow_instances (
          template_id,business_type,business_id,current_node_id,status,node_data,started_by
        ) VALUES (880004,'customer',880001,'legacy-node','active','{}',?)
      `).run(identity.user_id).lastInsertRowid);
      linkedTaskId = Number(inspection.prepare(`
        INSERT INTO workflow_tasks (
          instance_id,node_id,node_type,title,description,assignee_id,status
        ) VALUES (?,'legacy-node','task','Classifier task','',?,'pending')
      `).run(instanceId, identity.user_id).lastInsertRowid);
      const linkId = Number(inspection.prepare(
        'SELECT COALESCE(MAX(id),0)+1 AS id FROM campaign_record_links'
      ).get().id);
      inspection.prepare(`
        INSERT INTO campaign_record_links (
          id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
          created_by,metadata_json
        ) VALUES (?,?,880003,'workflow_instance',?,?,'workflow',?,'{}')
      `).run(
        linkId,
        identity.org_id,
        '8'.repeat(64),
        String(instanceId),
        identity.user_id
      );
    } finally {
      inspection.close();
    }

    const linked = await jsonRequest(
      server.baseUrl,
      `/api/workflow/tasks/${linkedTaskId}/approve`,
      { method: 'POST', headers: { 'X-Request-Id': 'linked-workflow-task' } }
    );
    assert.equal(linked.response.status, 401, linked.text);
    assert.equal(linked.body.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(linked.body.request_id, 'linked-workflow-task');
    assert.equal(linked.response.headers.get('x-request-id'), 'linked-workflow-task');

    for (const requestPath of [
      '/api/workflow/tasks/nope/approve',
      '/api/workflow/tasks/nope/reject',
      '/api/workflow/tasks/nope/complete',
      '/api/workflow/instances/nope/pause',
      '/api/workflow/instances/nope/resume',
      '/api/workflow/instances/nope/cancel'
    ]) {
      const response = await jsonRequest(server.baseUrl, requestPath, {
        method: 'POST',
        headers: { 'X-Request-Id': 'shared-workflow-policy' }
      });
      assert.equal(response.response.status, 401, `${requestPath}: ${response.text}`);
      assert.equal(response.body.code, 'AUTHENTICATION_REQUIRED');
      assert.equal(response.response.headers.get('x-request-id'), 'shared-workflow-policy');
    }
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

test('production registers reassignment policy and proves auth-first parser and campaign route ownership', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-reassignment-policy-');
  try {
    const port = Number(new URL(server.baseUrl).port);
    const startedAt = Date.now();
    const unauthenticated = await rawExchange(port, [
      'POST /api/campaigns/1/workflow-tasks/1/reassign HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Content-Length: 65536',
      'X-Request-Id: reassignment-auth-first',
      'Idempotency-Key: reassignment-auth-first-key',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    assert.equal(Date.now() - startedAt < 1000, true);
    assert.match(unauthenticated, /^HTTP\/1\.1 401\b/);
    assert.match(unauthenticated, /\r\nX-Request-Id: reassignment-auth-first\r\n/i);
    assert.match(unauthenticated, /"code":"AUTHENTICATION_REQUIRED"/);

    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());

    const malformedPath = await jsonRequest(
      server.baseUrl,
      '/api/campaigns/01/workflow-tasks/1/reassign',
      {
        method: 'POST',
        token: login.body.token,
        headers: {
          'X-Request-Id': 'reassignment-malformed-path',
          'Idempotency-Key': 'reassignment-malformed-path-key'
        },
        body: {}
      }
    );
    assert.equal(malformedPath.response.status, 400, malformedPath.text);
    assert.equal(malformedPath.body.code, 'INVALID_CAMPAIGN_INPUT');
    assert.equal(malformedPath.body.request_id, 'reassignment-malformed-path');

    const wrongMediaResponse = await fetch(
      `${server.baseUrl}/api/campaigns/1/workflow-tasks/1/reassign`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${login.body.token}`,
          'Content-Type': 'text/plain',
          'X-Request-Id': 'reassignment-wrong-media',
          'Idempotency-Key': 'reassignment-wrong-media-key'
        },
        body: '{}'
      }
    );
    const wrongMedia = await wrongMediaResponse.json();
    assert.equal(wrongMediaResponse.status, 415);
    assert.equal(wrongMedia.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(wrongMedia.request_id, 'reassignment-wrong-media');

    const malformedJsonResponse = await fetch(
      `${server.baseUrl}/api/campaigns/1/workflow-tasks/1/reassign`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${login.body.token}`,
          'Content-Type': 'application/json',
          'X-Request-Id': 'reassignment-malformed-json',
          'Idempotency-Key': 'reassignment-malformed-json-key'
        },
        body: '{'
      }
    );
    const malformedJson = await malformedJsonResponse.json();
    assert.equal(malformedJsonResponse.status, 400);
    assert.equal(malformedJson.code, 'INVALID_REQUEST_BODY');
    assert.equal(malformedJson.request_id, 'reassignment-malformed-json');

    const missing = await jsonRequest(
      server.baseUrl,
      '/api/campaigns/900719/workflow-tasks/900720/reassign',
      {
        method: 'POST',
        token: login.body.token,
        headers: {
          'X-Request-Id': 'reassignment-route-proof',
          'Idempotency-Key': 'reassignment-route-proof-key'
        },
        body: {
          expected_task_status: 'pending',
          expected_instance_status: 'active',
          expected_assignment_version: 1,
          assignee_id: login.body.user.id,
          assignee_role: null,
          reason: 'Route registration proof'
        }
      }
    );
    assert.equal(missing.response.status, 404, missing.text);
    assert.equal(missing.body.code, 'CAMPAIGN_NOT_FOUND');
    assert.equal(missing.body.request_id, 'reassignment-route-proof');
  } finally {
    await server.close();
  }
});
