'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  AdminOperationsServiceError,
  createAdminOperationsService
} = require('../services/admin_operations_service');

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, is_active INTEGER);
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, code TEXT, name TEXT);
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL,
      module TEXT NOT NULL, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE performance_provider_collection_runs (org_id INTEGER, status TEXT, completed_at TEXT);
    CREATE TABLE feishu_bitable_outbox (org_id INTEGER, status TEXT, updated_at TEXT);
    CREATE TABLE workflow_instances (id INTEGER PRIMARY KEY, org_id INTEGER, status TEXT, created_at TEXT);
    CREATE TABLE workflow_tasks (instance_id INTEGER, status TEXT);
    CREATE TABLE influencers (org_id INTEGER, import_batch TEXT, created_at TEXT);
  `);
  db.prepare('INSERT INTO users VALUES (1,?,?,?,1)').run('admin', 'Admin', 'admin');
  db.prepare('INSERT INTO organizations VALUES (1,?,?),(2,?,?)').run('org-one', '组织一', 'org-two', '组织二');
  const insert = db.prepare('INSERT INTO activity_log (user_id,action,module,details,ip_address) VALUES (?,?,?,?,?)');
  insert.run(1, 'provider_sync_failed', 'feishu_provider', '{"status":"retry"}', '127.0.0.1');
  insert.run(1, 'influencer_import_completed', 'import', '{"rows":2}', '127.0.0.1');
  insert.run(1, 'workflow_task_updated', 'workflow', '{"task":1}', '127.0.0.1');
  insert.run(1, 'admin_reset_password_denied', 'security', '{"target":2}', '127.0.0.1');
  db.prepare('INSERT INTO performance_provider_collection_runs VALUES (?,?,?)').run(1, 'failed', '2026-09-24T10:00:00Z');
  db.prepare('INSERT INTO feishu_bitable_outbox VALUES (?,?,?)').run(1, 'pending', '2026-09-24 10:00:00');
  db.prepare('INSERT INTO workflow_instances VALUES (?,?,?,?)').run(11, 1, 'active', '2026-09-24 09:00:00');
  db.prepare('INSERT INTO workflow_tasks VALUES (?,?)').run(11, 'pending');
  db.prepare('INSERT INTO influencers VALUES (?,?,?)').run(1, 'batch-1', '2026-09-24 08:00:00');
  return db;
}

test('admin operations returns classified searchable events and auditable summary', () => {
  const db = database();
  const service = createAdminOperationsService(db);
  const result = service.listOperations({
    actor: { id: 1, role: 'admin' },
    requestId: 'operations-read',
    ipAddress: '127.0.0.1',
    query: { category: 'provider', q: 'sync' }
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].category, 'provider');
  assert.equal(result.summary.provider, 1);
  assert.deepEqual(result.health.provider.status_counts, { failed: 1 });
  assert.deepEqual(result.health.feishu.status_counts, { pending: 1 });
  assert.equal(result.health.imports.batches, 1);
  assert.deepEqual(result.health.workflow.instance_status_counts, { active: 1 });
  assert.equal(result.health.security.event_count, 1);
  assert.deepEqual(result.health.organizations, [{
    organization_id: 1,
    code: 'org-one',
    name: '组织一',
    provider_runs: 1,
    feishu_outbox: 1,
    import_rows: 1,
    import_batches: 1,
    workflow_instances: 1,
    workflow_tasks: 1
  }, {
    organization_id: 2,
    code: 'org-two',
    name: '组织二',
    provider_runs: 0,
    feishu_outbox: 0,
    import_rows: 0,
    import_batches: 0,
    workflow_instances: 0,
    workflow_tasks: 0
  }]);
  assert.equal(result.page.has_more, false);
  const audit = db.prepare("SELECT action,details FROM activity_log WHERE action='admin_operations_read'").get();
  assert.equal(audit.action, 'admin_operations_read');
  assert.match(audit.details, /operations-read/);
  db.close();
});

test('admin operations read audit never feeds back into the operational event stream', () => {
  const db = database();
  const service = createAdminOperationsService(db);
  service.listOperations({
    actor: { id: 1, role: 'admin' },
    requestId: 'first-read',
    query: { category: 'all' }
  });
  const second = service.listOperations({
    actor: { id: 1, role: 'admin' },
    requestId: 'second-read',
    query: { category: 'all' }
  });
  assert.equal(second.events.length, 4);
  assert.equal(second.events.some((event) => event.action === 'admin_operations_read'), false);
  assert.equal(second.summary.security, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='admin_operations_read'").get().count,
    2
  );
  db.close();
});

test('admin operations rejects non-admin actors and invalid categories', () => {
  const db = database();
  const service = createAdminOperationsService(db);
  assert.throws(
    () => service.listOperations({ actor: { id: 1, role: 'user' }, query: {} }),
    (error) => error instanceof AdminOperationsServiceError && error.statusCode === 403
  );
  assert.throws(
    () => service.listOperations({ actor: { id: 1, role: 'admin' }, query: { category: 'unknown' } }),
    (error) => error.code === 'INVALID_ADMIN_OPERATIONS_FILTER'
  );
  db.close();
});
