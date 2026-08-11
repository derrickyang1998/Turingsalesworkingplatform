const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { resolveOrganizationScope } = require('../services/organization_access_service');

const LEGACY_CREDENTIAL_LENGTH = 10;
const LEGACY_CREDENTIAL_SHA256 = '0f92bb29dad79e922a92eba3deb0e6be044632fa5aca97a748adb7659d382c6a';
const PRIVATE_ROTATION_ROOT = 'D:\\主盘\\图灵集市\\图灵商务平台开发\\99-private';
const PRIVATE_ROTATION_PAYLOAD_PATH = PRIVATE_ROTATION_ROOT + '\\rotation-payload-v0.2.10.private.json';

function containsLegacyCredential(content) {
  const normalized = content.toLowerCase();
  for (let index = 0; index <= normalized.length - LEGACY_CREDENTIAL_LENGTH; index++) {
    const candidate = normalized.slice(index, index + LEGACY_CREDENTIAL_LENGTH);
    const fingerprint = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex');
    if (fingerprint === LEGACY_CREDENTIAL_SHA256) return true;
  }
  return false;
}

function freshDb(options) {
  options = options || {};
  const dbPath = path.join(os.tmpdir(), `tm-security-crm-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-admin-password';
  if (Object.prototype.hasOwnProperty.call(options, 'DEFAULT_ADMIN_USERNAME')) {
    process.env.DEFAULT_ADMIN_USERNAME = options.DEFAULT_ADMIN_USERNAME;
  } else {
    process.env.DEFAULT_ADMIN_USERNAME = 'admin';
  }
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

function mountCustomerRoutes(db) {
  const routes = {};
  const app = {};
  ['get', 'post', 'put', 'delete'].forEach(function(method) {
    app[method] = function(routePath) {
      routes[method.toUpperCase() + ' ' + routePath] = Array.prototype.slice.call(arguments, 1);
    };
  });
  const authMiddleware = function(req, res, next) { next(); };
  require('../routes_customers')(app, db, authMiddleware);
  Object.defineProperty(routes, 'db', { value: db });
  return routes;
}

function activeAuthContext(db, userId) {
  const result = resolveOrganizationScope(db, {
    userId,
    repairMissing: false,
    actorUserId: userId,
    requestId: 'crm-security-context'
  });
  return result && result.ok === true ? result.authContext : {};
}

function activeOrgTeam(db, userId) {
  const row = db.prepare(`
    SELECT om.org_id,tm.team_id
    FROM organization_memberships om
    JOIN team_memberships tm
      ON tm.org_id=om.org_id
     AND tm.user_id=om.user_id
     AND tm.status='active'
    WHERE om.user_id=? AND om.status='active'
    ORDER BY om.org_id,tm.team_id
    LIMIT 1
  `).get(userId);
  assert.ok(row, `active organization/team required for user ${userId}`);
  return { orgId: Number(row.org_id), teamId: Number(row.team_id) };
}

function hardDeleteProblem(requestId = 'crm-delete-test-request') {
  return {
    type: 'https://api.turingmarket.example/problems/crm-hard-delete-unavailable',
    title: 'CRM hard delete is unavailable',
    status: 409,
    code: 'CRM_HARD_DELETE_UNAVAILABLE',
    request_id: requestId,
    instance: `urn:turingmarket:request:${requestId}`
  };
}

function invoke(routes, key, opts) {
  opts = opts || {};
  const handlers = routes[key];
  assert.ok(handlers, 'route not found: ' + key);
  const req = {
    user: opts.user || { id: 2, role: 'user' },
    authContext: opts.authContext || activeAuthContext(routes.db, (opts.user || { id: 2 }).id),
    params: opts.params || {},
    query: opts.query || {},
    body: opts.body || {},
    headers: opts.headers || {},
    requestId: opts.requestId || 'crm-delete-test-request',
    ip: '127.0.0.1'
  };
  let statusCode = 200;
  let payload;
  const res = {
    status: function(code) { statusCode = code; return this; },
    json: function(value) { payload = value; return this; }
  };
  let index = 0;
  function next() {
    const handler = handlers[index++];
    if (!handler) return;
    if (handler.length >= 3) handler(req, res, next);
    else handler(req, res);
  }
  next();
  return { statusCode, payload };
}

function readRepoFile(repoRoot, relativePath) {
  const file = path.join(repoRoot, ...relativePath.split('/'));
  assert.equal(fs.existsSync(file), true, relativePath + ' should exist');
  return fs.readFileSync(file, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFencedCodeBlocks(markdown, language) {
  const blocks = [];
  const fencePattern = new RegExp('```' + language + '\\s*\\r?\\n([\\s\\S]*?)```', 'gi');
  let match;
  while ((match = fencePattern.exec(markdown)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

test('credential rotation runbook and public configuration docs keep the security contract', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const gitignore = readRepoFile(repoRoot, '.gitignore');
  const runbook = readRepoFile(repoRoot, 'docs/runbooks/credential-rotation.md');
  const envExample = readRepoFile(repoRoot, '.env.example');
  const deploy = readRepoFile(repoRoot, 'platform/DEPLOY.md');
  const security = readRepoFile(repoRoot, 'docs/handoff/2026-06-30/SECURITY.md');
  const operations = readRepoFile(repoRoot, 'docs/handoff/2026-06-30/OPERATIONS.md');
  const allDocs = [runbook, envExample, deploy, security, operations].join('\n');
  const privateRootPattern = escapeRegExp(PRIVATE_ROTATION_ROOT);
  const privatePayloadPattern = escapeRegExp(PRIVATE_ROTATION_PAYLOAD_PATH);

  assert.match(runbook, /Credential Rotation Runbook[\s\S]*凭据轮换运行手册/);
  assert.match(runbook, /STDIN-ONLY CLI[\s\S]*仅标准输入 CLI/);
  assert.doesNotMatch(runbook, /node\s+scripts\/rotate_user_credentials\.js\s*<\s*/);
  assert.match(runbook, /SESSION REVOCATION VERIFICATION[\s\S]*会话撤销验证/);
  assert.match(runbook, /SELECT COUNT\(\*\) AS count FROM sessions/);
  assert.match(runbook, /Provider Evidence Classification[\s\S]*第三方服务证据分类/);
  assert.match(runbook, /DeepSeek[\s\S]*Tavily[\s\S]*Feishu/);
  assert.match(runbook, /D:\\主盘\\图灵集市\\图灵商务平台开发\\99-private/);
  assert.match(runbook, /Protected Backup[\s\S]*受保护备份/);
  assert.match(runbook, /Rollback Rule[\s\S]*must never restore old password hashes[\s\S]*不得恢复旧密码/);
  assert.match(runbook, /\.env\.bak[\s\S]*清理/);
  assert.match(runbook, /Evidence Retention[\s\S]*证据留存/);
  assert.match(gitignore, /^rotation-payload\*\.private\.json$/m);
  assert.match(gitignore, /^\*\*\/rotation-payload\*\.private\.json$/m);
  assert.doesNotMatch(allDocs, /\.\/rotation-payload(?:[\w.-]*)?\.private\.json/);
  assert.doesNotMatch(allDocs, /(?<!v0\.2\.10)\brotation-payload\.private\.json\b/);
  assert.match(
    runbook,
    new RegExp("\\$payloadPath\\s*=\\s*'" + privatePayloadPattern + "'[\\s\\S]*Get-Content\\s+-Raw\\s+-Encoding\\s+UTF8\\s+-LiteralPath\\s+\\$payloadPath\\s*\\|\\s*node\\s+scripts/rotate_user_credentials\\.js")
  );
  assert.match(
    runbook,
    new RegExp("\\$payloadPath\\s*=\\s*'" + privatePayloadPattern + "'[\\s\\S]*\\$productionHost\\s*=\\s*'<production-host>'[\\s\\S]*Get-Content\\s+-Raw\\s+-Encoding\\s+UTF8\\s+-LiteralPath\\s+\\$payloadPath\\s*\\|\\s*ssh\\s+\\$productionHost[\\s\\S]*node\\s+scripts/rotate_user_credentials\\.js")
  );
  assert.match(deploy, new RegExp(privatePayloadPattern));
  assert.match(operations, new RegExp(privatePayloadPattern));
  assert.match(runbook, new RegExp('icacls\\s+"' + privateRootPattern + '"\\s+/inheritance:r'));
  assert.match(runbook, new RegExp('icacls\\s+"' + privateRootPattern + '"[\\s\\S]*/grant:r\\s+"\\$\\{env:USERNAME\\}:\\(OI\\)\\(CI\\)F"'));
  assert.match(runbook, new RegExp('icacls\\s+"' + privateRootPattern + '"[\\s\\S]*/remove:g[\\s\\S]*Users[\\s\\S]*Authenticated Users[\\s\\S]*Everyone'));

  const powershellRotationBlocks = extractFencedCodeBlocks(runbook, 'powershell')
    .filter(function(block) { return /rotate_user_credentials\.js/.test(block); });
  assert.ok(powershellRotationBlocks.length > 0, 'runbook should include PowerShell rotation examples');
  powershellRotationBlocks.forEach(function(block) {
    assert.doesNotMatch(
      block,
      /(^|\s)<\s*(?:"|'|\.|[A-Za-z]:\\|\$payloadPath)/m,
      'PowerShell rotation examples must pipe UTF-8 payload content instead of using input redirection'
    );
    assert.match(block, new RegExp("\\$payloadPath\\s*=\\s*'" + privatePayloadPattern + "'"));
    assert.match(
      block,
      /Get-Content\s+-Raw\s+-Encoding\s+UTF8\s+-LiteralPath\s+\$payloadPath\s*\|\s*(node|ssh)\b/
    );
    if (/ssh\b/.test(block)) {
      assert.match(block, /\$productionHost\s*=\s*'<production-host>'/);
      assert.match(block, /\|\s*ssh\s+\$productionHost\b/);
    }
  });

  ['DEFAULT_ADMIN_USERNAME', 'FEISHU_WEBHOOK_URL', 'WEB_SEARCH_PROVIDER'].forEach(function(name) {
    assert.match(envExample, new RegExp('^' + name + '=', 'm'), '.env.example should declare ' + name);
    assert.match(allDocs, new RegExp(name), 'docs should mention ' + name);
  });
  const webSearchProviderLines = envExample
    .split(/\r?\n/)
    .filter(function(line) { return line.startsWith('WEB_SEARCH_PROVIDER='); });
  assert.deepEqual(
    webSearchProviderLines,
    ['WEB_SEARCH_PROVIDER=replace_with_provider_name'],
    'WEB_SEARCH_PROVIDER must be a single placeholder-only example'
  );
  assert.match(envExample, /real production values remain server-side[\s\S]*真实生产值仅保存在服务器端/i);
  assert.doesNotMatch(envExample, /DEFAULT_ADMIN_PASSWORD=(?!replace_with_private_value|$).+/);

  assert.match(deploy, /Express 5 \+ SQLite \(better-sqlite3\)/);
  assert.doesNotMatch(deploy, /sql\.js/);
  assert.match(operations, /current production platform[\s\S]*Express \+ SQLite[\s\S]*当前生产平台/);
  assert.match(operations, /C:\\Users\\29272\\Documents\\在线商务平台-github-sync/);
  assert.doesNotMatch(operations, /当前 .*仓库是静态前端版本/);
  assert.match(allDocs, /ppt\.js\?v=20260702v916kbbridge/);
  assert.match(allDocs, /window\.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"/);
  assert.match(security, /private credential destination[\s\S]*私有凭据目标目录/i);
});

test('security test source cannot reconstruct the legacy password from array fragments', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(
    source,
    /\b(?:const|let|var)\s+legacyPassword\s*=\s*\[[\s\S]*?\]\s*\.join\s*\(\s*(['"])\1\s*\)/,
    'security test source must not reconstruct the legacy password from array fragments'
  );
});

test('public files and admin APIs do not expose the legacy default password', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const optionalFiles = [
    path.join(repoRoot, 'README.md'),
    path.join(repoRoot, 'TURINGMARKET_KEYS.md'),
    path.join(repoRoot, 'CLAUDE_CODE_MIGRATION.md'),
    path.join(repoRoot, 'platform', 'install.sh'),
    path.join(repoRoot, 'platform', 'server', 'server_full.js'),
    path.join(repoRoot, 'platform', 'server', 'test_v8.js')
  ];
  const requiredFiles = [
    path.join(repoRoot, '.env.example'),
    path.join(repoRoot, 'docs', 'runbooks', 'credential-rotation.md'),
    path.join(repoRoot, 'docs', 'handoff', '2026-06-30', 'SECURITY.md'),
    path.join(repoRoot, 'docs', 'handoff', '2026-06-30', 'OPERATIONS.md'),
    path.join(repoRoot, 'docs', 'superpowers', 'plans', '2026-07-12-phase-1-credential-rotation.md'),
    path.join(repoRoot, 'docs', 'superpowers', 'plans', '2026-07-12-turingmarket-platform-roadmap.md'),
    path.join(repoRoot, 'platform', 'index.html'),
    path.join(repoRoot, 'platform', 'app.js'),
    path.join(repoRoot, 'platform', 'DEPLOY.md'),
    path.join(repoRoot, 'platform', 'deploy_v8.ps1'),
    path.join(repoRoot, 'platform', 'server', 'server.js'),
    path.join(repoRoot, 'platform', 'server', 'db.js')
  ];
  requiredFiles.forEach(function(file) {
    assert.equal(fs.existsSync(file), true, file + ' should exist for legacy password scanning');
  });
  const files = requiredFiles.concat(optionalFiles.filter(function(file) { return fs.existsSync(file); }));
  files.forEach(function(file) {
    assert.equal(
      containsLegacyCredential(fs.readFileSync(file, 'utf8')),
      false,
      file + ' exposes the legacy default password'
    );
  });
});

test('crm customer detail is team-readable while mutations remain owner-scoped', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);
  const owner = { id: 2, role: 'user' };
  const other = { id: 3, role: 'user' };
  const scope = activeOrgTeam(db, owner.id);
  db.prepare(`
    INSERT OR IGNORE INTO team_memberships (
      org_id,team_id,user_id,role_code,status,created_at
    ) VALUES (?,?,?,'member','active',CURRENT_TIMESTAMP)
  `).run(scope.orgId, scope.teamId, other.id);

  const customerId = db.prepare(`
    INSERT INTO customers (
      brand_name,company_name,created_by,assigned_to,is_public,stage,
      org_id,team_id,duplicate_enforced
    ) VALUES (?,?,?,?,0,?,?,?,0)
  `).run(
    'Aurora Beauty',
    'Aurora Inc',
    owner.id,
    owner.id,
    'proposal',
    scope.orgId,
    scope.teamId
  ).lastInsertRowid;
  const opportunityId = db.prepare(`
    INSERT INTO opportunities (
      customer_id,name,stage,value,created_by,org_id,team_id,owner_user_id
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    customerId,
    'Aurora Launch',
    'proposal',
    5000,
    owner.id,
    scope.orgId,
    scope.teamId,
    owner.id
  ).lastInsertRowid;

  assert.equal(invoke(routes, 'GET /api/customers/:id/detail', { user: other, params: { id: customerId } }).statusCode, 200);
  assert.equal(invoke(routes, 'PUT /api/customers/:id', { user: other, params: { id: customerId }, body: { notes: 'unauthorized' } }).statusCode, 403);
  const leakedPrivateList = invoke(routes, 'GET /api/customers', { user: other, query: { scope: 'my' } });
  assert.equal(leakedPrivateList.statusCode, 200);
  assert.equal(leakedPrivateList.payload.customers.some(function(customer) { return Number(customer.id) === Number(customerId); }), false);
  assert.equal(invoke(routes, 'POST /api/customers/:id/return-pool', {
    user: other,
    params: { id: customerId },
    body: { reason_code: 'capacity_rebalance' }
  }).statusCode, 403);
  assert.equal(invoke(routes, 'POST /api/opportunities', { user: other, body: { customer_id: customerId, name: 'Unauthorized' } }).statusCode, 403);
  assert.equal(invoke(routes, 'PUT /api/opportunities/:id', {
    user: other,
    params: { id: opportunityId },
    body: { customer_id: customerId, name: 'Unauthorized edit' }
  }).statusCode, 403);

  assert.equal(invoke(routes, 'GET /api/customers/:id/detail', { user: owner, params: { id: customerId } }).statusCode, 200);
  assert.equal(invoke(routes, 'PUT /api/opportunities/:id', {
    user: owner,
    params: { id: opportunityId },
    body: { customer_id: customerId, name: 'Aurora Launch Updated' }
  }).statusCode, 200);

  db.close();
});

test('assigned customers cannot be claimed from the public pool', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);
  const owner = { id: 2, role: 'user' };
  const other = { id: 3, role: 'user' };
  const scope = activeOrgTeam(db, owner.id);
  const customerId = db.prepare(`
    INSERT INTO customers (
      brand_name,company_name,created_by,assigned_to,is_public,stage,
      org_id,team_id,duplicate_enforced
    ) VALUES (?,?,?,?,1,?,?,?,0)
  `).run(
    'Assigned Public Flag Brand',
    'Assigned Public Flag Inc',
    owner.id,
    owner.id,
    'proposal',
    scope.orgId,
    scope.teamId
  ).lastInsertRowid;

  const claim = invoke(routes, 'POST /api/customers/:id/claim', {
    user: other,
    params: { id: customerId },
    body: { team_id: activeOrgTeam(db, other.id).teamId }
  });

  assert.equal(claim.statusCode, 409);
  const customer = db.prepare('SELECT assigned_to, is_public FROM customers WHERE id = ?').get(customerId);
  assert.equal(customer.assigned_to, owner.id);
  assert.equal(customer.is_public, 1);

  db.close();
});

test('public-pool customer visibility does not allow opportunity mutation', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);
  const owner = { id: 2, role: 'user' };
  const other = { id: 3, role: 'user' };
  const scope = activeOrgTeam(db, owner.id);
  const customerId = db.prepare(`
    INSERT INTO customers (
      brand_name,company_name,created_by,assigned_to,is_public,stage,
      org_id,team_id,duplicate_enforced
    ) VALUES (?,?,?,NULL,1,?,?,NULL,0)
  `).run('Public Pool Brand', 'Public Pool Inc', owner.id, 'proposal', scope.orgId).lastInsertRowid;
  const opportunityId = db.prepare(`
    INSERT INTO opportunities (
      customer_id,name,stage,value,created_by,org_id,team_id,owner_user_id
    ) VALUES (?,?,?,?,?,?,NULL,?)
  `).run(
    customerId,
    'Public Pool Opportunity',
    'proposal',
    5000,
    owner.id,
    scope.orgId,
    owner.id
  ).lastInsertRowid;

  assert.equal(invoke(routes, 'GET /api/customers/:id/detail', { user: other, params: { id: customerId } }).statusCode, 404);
  assert.equal(invoke(routes, 'PUT /api/opportunities/:id', {
    user: other,
    params: { id: opportunityId },
    body: { customer_id: customerId, name: 'Hidden edit' }
  }).statusCode, 403);
  assert.equal(invoke(routes, 'DELETE /api/opportunities/:id', { user: other, params: { id: opportunityId } }).statusCode, 409);

  db.close();
});

test('customer and opportunity hard deletes are uniformly unavailable and preserve rows', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);
  const owner = { id: 2, role: 'user' };
  const customerId = Number(db.prepare(`
    INSERT INTO customers (
      brand_name,company_name,created_by,assigned_to,is_public,stage
    ) VALUES (?,?,?, ?,0,?)
  `).run(
    'Campaign Customer',
    'Campaign Customer Inc',
    owner.id,
    owner.id,
    'proposal'
  ).lastInsertRowid);
  const opportunityId = Number(db.prepare(`
    INSERT INTO opportunities (customer_id,name,stage,value,created_by)
    VALUES (?,?,?,?,?)
  `).run(
    customerId,
    'Campaign Opportunity',
    'proposal',
    5000,
    owner.id
  ).lastInsertRowid);
  const organizationId = db.prepare(`
    SELECT id FROM organizations WHERE code='turingmarket-default'
  `).get().id;
  const teamId = db.prepare(`
    SELECT team_id
    FROM team_memberships
    WHERE org_id=? AND user_id=? AND status='active'
    ORDER BY team_id
    LIMIT 1
  `).get(organizationId, owner.id).team_id;
  db.prepare(`
    INSERT INTO campaigns (
      org_id,name,customer_id,opportunity_id,owner_user_id,team_id
    ) VALUES (?,?,?,?,?,?)
  `).run(
    organizationId,
    'Delete dependency campaign',
    customerId,
    opportunityId,
    owner.id,
    teamId
  );
  db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes
    ) VALUES (?,?,'note','proposal','proposal','must survive')
  `).run(customerId, owner.id);

  const opportunityDelete = invoke(routes, 'DELETE /api/opportunities/:id', {
    user: owner,
    params: { id: String(opportunityId) }
  });
  assert.equal(opportunityDelete.statusCode, 409);
  assert.deepEqual(opportunityDelete.payload, hardDeleteProblem());
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE id=?')
      .get(opportunityId).count,
    1
  );

  const customerDelete = invoke(routes, 'DELETE /api/customers/:id', {
    user: owner,
    params: { id: String(customerId) }
  });
  assert.equal(customerDelete.statusCode, 409);
  assert.deepEqual(customerDelete.payload, hardDeleteProblem());
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?')
      .get(customerId).count,
    1
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM customers WHERE id=?')
      .get(customerId).count,
    1
  );

  db.close();
});

test('customer hard-delete refusal does not touch unenumerated dependencies or activity', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);
  const owner = { id: 2, role: 'user' };
  const customerId = Number(db.prepare(`
    INSERT INTO customers (
      brand_name,company_name,created_by,assigned_to,is_public,stage
    ) VALUES (?,?,?, ?,0,?)
  `).run(
    'Hidden FK Customer',
    'Hidden FK Inc',
    owner.id,
    owner.id,
    'proposal'
  ).lastInsertRowid);
  db.exec(`
    CREATE TABLE hidden_customer_dependency (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL
        REFERENCES customers(id) ON DELETE RESTRICT
    );
  `);
  db.prepare(`
    INSERT INTO hidden_customer_dependency (customer_id) VALUES (?)
  `).run(customerId);
  db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes
    ) VALUES (?,?,'note','proposal','proposal','rollback evidence')
  `).run(customerId, owner.id);

  const result = invoke(routes, 'DELETE /api/customers/:id', {
    user: owner,
    params: { id: String(customerId) }
  });
  assert.equal(result.statusCode, 409);
  assert.deepEqual(result.payload, hardDeleteProblem());
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?')
      .get(customerId).count,
    1
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM customers WHERE id=?')
      .get(customerId).count,
    1
  );

  db.close();
});

test('hard-delete refusal is independent of stale roles identifiers and record existence', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);
  const staleAdminProjection = { id: 2, role: 'admin' };
  const currentOwnerId = 3;
  const customerId = Number(db.prepare(`
    INSERT INTO customers (
      brand_name,company_name,created_by,assigned_to,is_public,stage
    ) VALUES (?,?,?,?,0,?)
  `).run(
    'Current Owner Customer',
    'Current Owner Inc',
    currentOwnerId,
    currentOwnerId,
    'proposal'
  ).lastInsertRowid);
  const opportunityId = Number(db.prepare(`
    INSERT INTO opportunities (customer_id,name,stage,value,created_by)
    VALUES (?,?,?,?,?)
  `).run(
    customerId,
    'Current Owner Opportunity',
    'proposal',
    5000,
    currentOwnerId
  ).lastInsertRowid);

  const customerForbidden = invoke(routes, 'DELETE /api/customers/:id', {
    user: staleAdminProjection,
    params: { id: String(customerId) }
  });
  assert.equal(customerForbidden.statusCode, 409);
  assert.deepEqual(customerForbidden.payload, hardDeleteProblem());

  const opportunityForbidden = invoke(routes, 'DELETE /api/opportunities/:id', {
    user: staleAdminProjection,
    params: { id: String(opportunityId) }
  });
  assert.equal(opportunityForbidden.statusCode, 409);
  assert.deepEqual(opportunityForbidden.payload, hardDeleteProblem());

  const noncanonicalCustomer = invoke(routes, 'DELETE /api/customers/:id', {
    user: { id: currentOwnerId, role: 'user' },
    params: { id: '0' + String(customerId) }
  });
  assert.equal(noncanonicalCustomer.statusCode, 409);
  assert.deepEqual(noncanonicalCustomer.payload, hardDeleteProblem());

  const noncanonicalOpportunity = invoke(routes, 'DELETE /api/opportunities/:id', {
    user: { id: currentOwnerId, role: 'user' },
    params: { id: '+' + String(opportunityId) }
  });
  assert.equal(noncanonicalOpportunity.statusCode, 409);
  assert.deepEqual(noncanonicalOpportunity.payload, hardDeleteProblem());

  db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(currentOwnerId);
  const inactiveActor = invoke(routes, 'DELETE /api/customers/:id', {
    user: { id: currentOwnerId, role: 'user' },
    params: { id: String(customerId) }
  });
  assert.equal(inactiveActor.statusCode, 409);
  assert.deepEqual(inactiveActor.payload, hardDeleteProblem());

  const missingCustomer = invoke(routes, 'DELETE /api/customers/:id', {
    user: staleAdminProjection,
    params: { id: '9007199254740991' }
  });
  assert.equal(missingCustomer.statusCode, 409);
  assert.deepEqual(missingCustomer.payload, hardDeleteProblem());
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM customers WHERE id=?')
      .get(customerId).count,
    1
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE id=?')
      .get(opportunityId).count,
    1
  );

  db.close();
});

test('hard-delete refusal does not execute destructive database triggers', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);
  const owner = { id: 2, role: 'user' };
  const customerId = Number(db.prepare(`
    INSERT INTO customers (
      brand_name,company_name,created_by,assigned_to,is_public,stage
    ) VALUES (?,?,?,?,0,?)
  `).run(
    'Delete Failure Customer',
    'Delete Failure Inc',
    owner.id,
    owner.id,
    'proposal'
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes
    ) VALUES (?,?,'note','proposal','proposal','must roll back')
  `).run(customerId, owner.id);
  db.exec(`
    CREATE TRIGGER fail_customer_delete
    BEFORE DELETE ON customers
    BEGIN
      SELECT RAISE(ABORT,'sensitive-delete-detail');
    END;
  `);

  const result = invoke(routes, 'DELETE /api/customers/:id', {
    user: owner,
    params: { id: String(customerId) }
  });
  assert.equal(result.statusCode, 409);
  assert.deepEqual(result.payload, hardDeleteProblem());
  assert.equal(JSON.stringify(result.payload).includes('sensitive-delete-detail'), false);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?')
      .get(customerId).count,
    1
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM customers WHERE id=?')
      .get(customerId).count,
    1
  );

  db.close();
});

test('seeded admin and team users do not share the same default password', () => {
  const db = freshDb();
  const admin = db.prepare("SELECT password_hash FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  const member = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('zhangwei');

  assert.ok(admin);
  assert.notEqual(admin.password_hash, member.password_hash);
  assert.equal(bcrypt.compareSync(process.env.DEFAULT_ADMIN_PASSWORD, admin.password_hash), true);
  assert.equal(bcrypt.compareSync(process.env.DEFAULT_ADMIN_PASSWORD, member.password_hash), false);

  db.close();
});

test('seeded admin username can be configured without recreating legacy admin', () => {
  const db = freshDb({ DEFAULT_ADMIN_USERNAME: 'opsadmin' });
  const admins = db.prepare("SELECT username FROM users WHERE role = 'admin' ORDER BY id").all();
  const legacyAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');

  assert.deepEqual(admins.map(function(admin) { return admin.username; }), ['opsadmin']);
  assert.equal(legacyAdmin, undefined);

  db.close();
});

test('crm knowledge archives use the business owner for private visibility', () => {
  const db = freshDb();
  const archive = require('../services/business_knowledge_service');
  const knowledge = require('../services/knowledge_service');

  const entry = archive.archiveCustomer(db, {
    id: 77,
    brand_name: 'Owner Routed Brand',
    company_name: 'Owner Inc',
    created_by: 1,
    assigned_to: 2,
    industry: 'beauty',
    stage: 'proposal',
    notes: 'Assigned user should retrieve this in RAG'
  }, { id: 1, role: 'admin' });

  assert.equal(entry.created_by, 2);
  assert.equal(knowledge.searchKnowledge(db, { q: 'Assigned user RAG', entry_type: 'crm_customer', user: { id: 2, role: 'user' } }).length, 1);
  assert.equal(knowledge.searchKnowledge(db, { q: 'Assigned user RAG', entry_type: 'crm_customer', user: { id: 3, role: 'user' } }).length, 0);

  db.close();
});

test('crm customer stats aggregate opportunity value within caller scope', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);

  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, role, department, is_active)
    VALUES (?, ?, ?, 'user', ?, 1)
  `);
  const ownerA = Number(insertUser.run('stats-owner-a', 'test-hash', 'Stats Owner A', 'sales-a').lastInsertRowid);
  const teammateB = Number(insertUser.run('stats-teammate-b', 'test-hash', 'Stats Teammate B', 'sales-a').lastInsertRowid);
  const outsiderC = Number(insertUser.run('stats-outsider-c', 'test-hash', 'Stats Outsider C', 'sales-b').lastInsertRowid);
  const emptyD = Number(insertUser.run('stats-empty-d', 'test-hash', 'Stats Empty D', 'sales-c').lastInsertRowid);
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  const defaultScope = activeOrgTeam(db, Number(admin.id));
  const outsiderTeamId = Number(db.prepare(`
    INSERT INTO teams (org_id,code,name,created_at)
    VALUES (?,?,?,CURRENT_TIMESTAMP)
  `).run(
    defaultScope.orgId,
    `stats-outsider-${Date.now()}`,
    'Stats Outsider Team'
  ).lastInsertRowid);

  const insertOrgMembership = db.prepare(`
    INSERT INTO organization_memberships (
      org_id,user_id,role_code,status,created_at
    ) VALUES (?,?,'member','active',CURRENT_TIMESTAMP)
  `);
  const insertTeamMembership = db.prepare(`
    INSERT INTO team_memberships (
      org_id,team_id,user_id,role_code,status,created_at
    ) VALUES (?,?,?,'member','active',CURRENT_TIMESTAMP)
  `);
  for (const userId of [ownerA, teammateB, outsiderC, emptyD]) {
    insertOrgMembership.run(defaultScope.orgId, userId);
  }
  for (const userId of [ownerA, teammateB, emptyD]) {
    insertTeamMembership.run(defaultScope.orgId, defaultScope.teamId, userId);
  }
  insertTeamMembership.run(defaultScope.orgId, outsiderTeamId, outsiderC);

  const insertCustomer = db.prepare(`
    INSERT INTO customers (
      brand_name,company_name,created_by,assigned_to,is_public,stage,
      opportunity_value,org_id,team_id,duplicate_enforced
    ) VALUES (?,?,?,?,0,?,?,?,?,0)
  `);
  const customerOne = Number(insertCustomer.run(
    'Scoped One', 'Scoped One Inc', ownerA, ownerA, 'proposal', 1250,
    defaultScope.orgId, defaultScope.teamId
  ).lastInsertRowid);
  const customerTwo = Number(insertCustomer.run(
    'Scoped Two', 'Scoped Two Inc', teammateB, teammateB, 'analysis', 2750,
    defaultScope.orgId, defaultScope.teamId
  ).lastInsertRowid);
  const customerOutside = Number(insertCustomer.run(
    'Outside Scope', 'Outside Scope Inc', outsiderC, outsiderC, 'proposal', 9000,
    defaultScope.orgId, outsiderTeamId
  ).lastInsertRowid);
  const insertOpportunity = db.prepare(`
    INSERT INTO opportunities (
      customer_id,name,stage,value,win_probability,created_by,
      org_id,team_id,owner_user_id
    ) VALUES (?,?,?, ?,50,?, ?,?,?)
  `);
  insertOpportunity.run(
    customerOne, 'Scoped One Opportunity', 'proposal', 1250, ownerA,
    defaultScope.orgId, defaultScope.teamId, ownerA
  );
  insertOpportunity.run(
    customerTwo, 'Scoped Two Opportunity', 'qualification', 2750, teammateB,
    defaultScope.orgId, defaultScope.teamId, teammateB
  );
  insertOpportunity.run(
    customerOutside, 'Outside Opportunity', 'proposal', 9000, outsiderC,
    defaultScope.orgId, outsiderTeamId, outsiderC
  );

  const ownerStats = invoke(routes, 'GET /api/customers/stats', {
    user: { id: ownerA, role: 'user', department: 'sales-a' },
    query: { scope: 'my' }
  });
  assert.equal(ownerStats.statusCode, 200);
  assert.equal(ownerStats.payload.total, 1);
  assert.equal(typeof ownerStats.payload.totalOppValue, 'number');
  assert.equal(ownerStats.payload.totalOppValue, 1250);

  const teamStats = invoke(routes, 'GET /api/customers/stats', {
    user: { id: ownerA, role: 'user', department: 'sales-a' },
    query: { scope: 'team' }
  });
  assert.equal(teamStats.statusCode, 200);
  assert.equal(teamStats.payload.total, 2);
  assert.equal(typeof teamStats.payload.totalOppValue, 'number');
  assert.equal(teamStats.payload.totalOppValue, 4000);

  const adminAllStats = invoke(routes, 'GET /api/customers/stats', {
    user: { id: Number(admin.id), role: 'admin', department: '管理' },
    query: { scope: 'all' }
  });
  assert.equal(adminAllStats.statusCode, 200);
  assert.equal(adminAllStats.payload.total, 3);
  assert.equal(typeof adminAllStats.payload.totalOppValue, 'number');
  assert.equal(adminAllStats.payload.totalOppValue, 13000);

  const adminMyStats = invoke(routes, 'GET /api/customers/stats', {
    user: { id: Number(admin.id), role: 'admin', department: '管理' },
    query: { scope: 'my' }
  });
  assert.equal(adminMyStats.statusCode, 200);
  assert.equal(adminMyStats.payload.total, 0);
  assert.equal(typeof adminMyStats.payload.totalOppValue, 'number');
  assert.equal(adminMyStats.payload.totalOppValue, 0);

  const emptyStats = invoke(routes, 'GET /api/customers/stats', {
    user: { id: emptyD, role: 'user', department: 'sales-c' },
    query: { scope: 'my' }
  });
  assert.equal(emptyStats.statusCode, 200);
  assert.equal(emptyStats.payload.total, 0);
  assert.equal(typeof emptyStats.payload.totalOppValue, 'number');
  assert.equal(emptyStats.payload.totalOppValue, 0);

  db.close();
});

test('crm customer stats has one runtime route owner', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const customerRoutesSource = readRepoFile(repoRoot, 'platform/server/routes_customers.js');
  const serverSource = readRepoFile(repoRoot, 'platform/server/server.js');
  function countCustomerStatsRoutes(source) {
    return (source.match(/app\.get\('\/api\/customers\/stats'/g) || []).length;
  }

  assert.equal(countCustomerStatsRoutes(customerRoutesSource), 1);
  assert.equal(countCustomerStatsRoutes(serverSource), 0);
});
