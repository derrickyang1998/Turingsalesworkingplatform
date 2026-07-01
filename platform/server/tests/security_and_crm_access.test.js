const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-security-crm-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-admin-password';
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

test('public files and admin APIs do not expose the legacy default password', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const files = [
    path.join(repoRoot, 'README.md'),
    path.join(repoRoot, 'TURINGMARKET_KEYS.md'),
    path.join(repoRoot, 'CLAUDE_CODE_MIGRATION.md'),
    path.join(repoRoot, 'platform', 'index.html'),
    path.join(repoRoot, 'platform', 'app.js'),
    path.join(repoRoot, 'platform', 'DEPLOY.md'),
    path.join(repoRoot, 'platform', 'install.sh'),
    path.join(repoRoot, 'platform', 'server', 'server.js'),
    path.join(repoRoot, 'platform', 'server', 'db.js'),
    path.join(repoRoot, 'platform', 'server', 'server_full.js'),
    path.join(repoRoot, 'platform', 'server', 'test_v8.js')
  ];
  const legacyDefault = /admin\s*\/\s*turing2026|turing2026|Password reset to turing2026|hashSync\(['"]turing2026['"]|DEFAULT_USER_PASSWORD\s*\|\|\s*['"]turing2026['"]/i;
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
    INSERT INTO customers (brand_name, company_name, created_by, assigned_to, stage)
    VALUES (?, ?, ?, ?, ?)
  `).run('Aurora Beauty', 'Aurora Inc', owner.id, owner.id, 'proposal').lastInsertRowid;
  const opportunityId = db.prepare(`
    INSERT INTO opportunities (customer_id, name, stage, value, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(customerId, 'Aurora Launch', 'proposal', 5000, owner.id).lastInsertRowid;

  assert.equal(invoke(routes, 'GET /api/customers/:id/detail', { user: other, params: { id: customerId } }).statusCode, 403);
  assert.equal(invoke(routes, 'PUT /api/customers/:id', { user: other, params: { id: customerId }, body: { stage: 'won' } }).statusCode, 403);
  assert.equal(invoke(routes, 'POST /api/customers/:id/return-pool', { user: other, params: { id: customerId } }).statusCode, 403);
  assert.equal(invoke(routes, 'POST /api/opportunities', { user: other, body: { customer_id: customerId, name: 'Unauthorized' } }).statusCode, 403);
  assert.equal(invoke(routes, 'PUT /api/opportunities/:id', { user: other, params: { id: opportunityId }, body: { stage: 'won' } }).statusCode, 403);

  assert.equal(invoke(routes, 'GET /api/customers/:id/detail', { user: owner, params: { id: customerId } }).statusCode, 200);
  assert.equal(invoke(routes, 'PUT /api/opportunities/:id', { user: owner, params: { id: opportunityId }, body: { stage: 'won' } }).statusCode, 200);

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
