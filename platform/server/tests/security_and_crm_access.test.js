const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

function freshDb(options) {
  options = options || {};
  const dbPath = path.join(os.tmpdir(), `tm-security-crm-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-admin-password';
  if (Object.prototype.hasOwnProperty.call(options, 'DEFAULT_ADMIN_USERNAME')) {
    process.env.DEFAULT_ADMIN_USERNAME = options.DEFAULT_ADMIN_USERNAME;
  } else {
    delete process.env.DEFAULT_ADMIN_USERNAME;
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
  return routes;
}

function invoke(routes, key, opts) {
  opts = opts || {};
  const handlers = routes[key];
  assert.ok(handlers, 'route not found: ' + key);
  const req = {
    user: opts.user || { id: 2, role: 'user' },
    params: opts.params || {},
    query: opts.query || {},
    body: opts.body || {},
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

test('credential rotation runbook and public configuration docs keep the security contract', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const runbook = readRepoFile(repoRoot, 'docs/runbooks/credential-rotation.md');
  const envExample = readRepoFile(repoRoot, '.env.example');
  const deploy = readRepoFile(repoRoot, 'platform/DEPLOY.md');
  const security = readRepoFile(repoRoot, 'docs/handoff/2026-06-30/SECURITY.md');
  const operations = readRepoFile(repoRoot, 'docs/handoff/2026-06-30/OPERATIONS.md');
  const allDocs = [runbook, envExample, deploy, security, operations].join('\n');

  assert.match(runbook, /Credential Rotation Runbook[\s\S]*凭据轮换运行手册/);
  assert.match(runbook, /STDIN-ONLY CLI[\s\S]*仅标准输入 CLI/);
  assert.match(runbook, /node\s+scripts\/rotate_user_credentials\.js\s*</);
  assert.match(runbook, /SESSION REVOCATION VERIFICATION[\s\S]*会话撤销验证/);
  assert.match(runbook, /SELECT COUNT\(\*\) AS count FROM sessions/);
  assert.match(runbook, /Provider Evidence Classification[\s\S]*第三方服务证据分类/);
  assert.match(runbook, /DeepSeek[\s\S]*Tavily[\s\S]*Feishu/);
  assert.match(runbook, /D:\\主盘\\图灵集市\\图灵商务平台开发\\99-private/);
  assert.match(runbook, /Protected Backup[\s\S]*受保护备份/);
  assert.match(runbook, /Rollback Rule[\s\S]*must never restore old password hashes[\s\S]*不得恢复旧密码/);
  assert.match(runbook, /\.env\.bak[\s\S]*清理/);
  assert.match(runbook, /Evidence Retention[\s\S]*证据留存/);

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

test('public files and admin APIs do not expose the legacy default password', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const optionalFiles = [
    path.join(repoRoot, 'README.md'),
    path.join(repoRoot, 'TURINGMARKET_KEYS.md'),
    path.join(repoRoot, 'CLAUDE_CODE_MIGRATION.md')
  ];
  const requiredFiles = [
    path.join(repoRoot, 'platform', 'index.html'),
    path.join(repoRoot, 'platform', 'app.js'),
    path.join(repoRoot, 'platform', 'DEPLOY.md'),
    path.join(repoRoot, 'platform', 'install.sh'),
    path.join(repoRoot, 'platform', 'server', 'server.js'),
    path.join(repoRoot, 'platform', 'server', 'db.js'),
    path.join(repoRoot, 'platform', 'server', 'server_full.js'),
    path.join(repoRoot, 'platform', 'server', 'test_v8.js')
  ];
  const legacyPassword = ['turing', '2026'].join('');
  const legacyDefault = new RegExp([
    'admin\\s*\\/\\s*' + legacyPassword,
    legacyPassword,
    'Password reset to ' + legacyPassword,
    "hashSync\\([\"']" + legacyPassword + "[\"']",
    "DEFAULT_USER_PASSWORD\\s*\\|\\|\\s*[\"']" + legacyPassword + "[\"']"
  ].join('|'), 'i');
  requiredFiles.forEach(function(file) {
    assert.equal(fs.existsSync(file), true, file + ' should exist for legacy password scanning');
  });
  const files = requiredFiles.concat(optionalFiles.filter(function(file) { return fs.existsSync(file); }));
  files.forEach(function(file) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), legacyDefault, file + ' exposes the legacy default password');
  });
});

test('crm customer and opportunity routes reject cross-user access by id', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);
  const owner = { id: 2, role: 'user' };
  const other = { id: 3, role: 'user' };

  const customerId = db.prepare(`
    INSERT INTO customers (brand_name, company_name, created_by, assigned_to, is_public, stage)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run('Aurora Beauty', 'Aurora Inc', owner.id, owner.id, 'proposal').lastInsertRowid;
  const opportunityId = db.prepare(`
    INSERT INTO opportunities (customer_id, name, stage, value, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(customerId, 'Aurora Launch', 'proposal', 5000, owner.id).lastInsertRowid;

  assert.equal(invoke(routes, 'GET /api/customers/:id/detail', { user: other, params: { id: customerId } }).statusCode, 403);
  assert.equal(invoke(routes, 'PUT /api/customers/:id', { user: other, params: { id: customerId }, body: { stage: 'won' } }).statusCode, 403);
  const leakedPrivateList = invoke(routes, 'GET /api/customers', { user: other, query: { is_public: 0 } });
  assert.equal(leakedPrivateList.statusCode, 200);
  assert.equal(leakedPrivateList.payload.customers.some(function(customer) { return Number(customer.id) === Number(customerId); }), false);
  assert.equal(invoke(routes, 'POST /api/customers/:id/return-pool', { user: other, params: { id: customerId } }).statusCode, 403);
  assert.equal(invoke(routes, 'POST /api/opportunities', { user: other, body: { customer_id: customerId, name: 'Unauthorized' } }).statusCode, 403);
  assert.equal(invoke(routes, 'PUT /api/opportunities/:id', { user: other, params: { id: opportunityId }, body: { stage: 'won' } }).statusCode, 403);

  assert.equal(invoke(routes, 'GET /api/customers/:id/detail', { user: owner, params: { id: customerId } }).statusCode, 200);
  assert.equal(invoke(routes, 'PUT /api/opportunities/:id', { user: owner, params: { id: opportunityId }, body: { stage: 'won' } }).statusCode, 200);

  db.close();
});

test('assigned customers cannot be claimed from the public pool', () => {
  const db = freshDb();
  const routes = mountCustomerRoutes(db);
  const owner = { id: 2, role: 'user' };
  const other = { id: 3, role: 'user' };
  const customerId = db.prepare(`
    INSERT INTO customers (brand_name, company_name, created_by, assigned_to, is_public, stage)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run('Assigned Public Flag Brand', 'Assigned Public Flag Inc', owner.id, owner.id, 'proposal').lastInsertRowid;

  const claim = invoke(routes, 'POST /api/customers/:id/claim', { user: other, params: { id: customerId } });

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
  const customerId = db.prepare(`
    INSERT INTO customers (brand_name, company_name, created_by, assigned_to, is_public, stage)
    VALUES (?, ?, ?, NULL, 1, ?)
  `).run('Public Pool Brand', 'Public Pool Inc', owner.id, 'proposal').lastInsertRowid;
  const opportunityId = db.prepare(`
    INSERT INTO opportunities (customer_id, name, stage, value, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(customerId, 'Public Pool Opportunity', 'proposal', 5000, owner.id).lastInsertRowid;

  assert.equal(invoke(routes, 'GET /api/customers/:id/detail', { user: other, params: { id: customerId } }).statusCode, 200);
  assert.equal(invoke(routes, 'PUT /api/opportunities/:id', { user: other, params: { id: opportunityId }, body: { stage: 'won' } }).statusCode, 403);
  assert.equal(invoke(routes, 'DELETE /api/opportunities/:id', { user: other, params: { id: opportunityId } }).statusCode, 403);

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
