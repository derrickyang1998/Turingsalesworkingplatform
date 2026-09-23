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
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL,
      module TEXT NOT NULL, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO users VALUES (1,?,?,?,1)').run('admin', 'Admin', 'admin');
  const insert = db.prepare('INSERT INTO activity_log (user_id,action,module,details,ip_address) VALUES (?,?,?,?,?)');
  insert.run(1, 'provider_sync_failed', 'feishu_provider', '{"status":"retry"}', '127.0.0.1');
  insert.run(1, 'influencer_import_completed', 'import', '{"rows":2}', '127.0.0.1');
  insert.run(1, 'workflow_task_updated', 'workflow', '{"task":1}', '127.0.0.1');
  insert.run(1, 'admin_reset_password_denied', 'security', '{"target":2}', '127.0.0.1');
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
  assert.equal(result.page.has_more, false);
  const audit = db.prepare("SELECT action,details FROM activity_log WHERE action='admin_operations_read'").get();
  assert.equal(audit.action, 'admin_operations_read');
  assert.match(audit.details, /operations-read/);
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
