'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const registerAdminOperationsRoutes = require('../routes_admin_operations');
const { AdminOperationsServiceError } = require('../services/admin_operations_service');

function harness(service) {
  const routes = new Map();
  const app = { get(path) { routes.set(path, [...arguments].slice(1)); } };
  const authMiddleware = (_req, _res, next) => next();
  const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
  registerAdminOperationsRoutes(app, {}, { authMiddleware, adminOnly, service });
  return async (input = {}) => {
    const handlers = routes.get('/api/admin/operations');
    const req = { user: input.user || { id: 1, role: 'admin' }, query: input.query || {}, ip: '127.0.0.1' };
    let statusCode = 200;
    let payload;
    const res = { status(code) { statusCode = code; return this; }, json(value) { payload = value; return this; } };
    let index = 0;
    const next = () => { const handler = handlers[index++]; return handler && handler(req, res, next); };
    await next();
    return { statusCode, payload };
  };
}

test('admin operations route passes server-owned actor and returns request id', async () => {
  let received;
  const invoke = harness({
    listOperations(input) { received = input; return { events: [], summary: {}, page: {} }; }
  });
  const result = await invoke({ query: { category: 'security' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.request_id.length, 36);
  assert.equal(received.actor.id, 1);
  assert.deepEqual(received.query, { category: 'security' });
});

test('admin operations route preserves typed service errors', async () => {
  const invoke = harness({
    listOperations() { throw new AdminOperationsServiceError(400, 'INVALID_ADMIN_OPERATIONS_FILTER', 'bad'); }
  });
  const result = await invoke();
  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.code, 'INVALID_ADMIN_OPERATIONS_FILTER');
});
