'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadRoutes() {
  try {
    return require('../routes_admin_ai_quota');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('admin AI quota routes have not been implemented');
    }
    throw error;
  }
}

function harness(overrides = {}) {
  const routes = new Map();
  const calls = [];
  const app = {
    put(path) {
      routes.set(`PUT ${path}`, Array.prototype.slice.call(arguments, 1));
    }
  };
  const service = Object.assign({
    updateUserQuota(input) {
      calls.push(input);
      return {
        user_id: Number(input.userId),
        period: 'legacy_lifetime',
        limit: input.quota,
        status: 'active'
      };
    }
  }, overrides.service || {});
  function authMiddleware(_request, _response, next) { return next(); }
  function adminOnly(request, response, next) {
    if (!request.user || request.user.role !== 'admin') {
      return response.status(403).json({ error: 'Admin only' });
    }
    return next();
  }
  loadRoutes()(app, {}, { authMiddleware, adminOnly, service });

  async function invoke(input = {}) {
    const handlers = routes.get('PUT /api/admin/users/:userId/ai-quota');
    assert.ok(handlers, 'dedicated AI quota route must exist');
    const request = {
      user: input.user || { id: 1, role: 'admin' },
      params: input.params || { userId: '2' },
      body: input.body || { api_quota: 50000 },
      requestId: input.requestId || 'quota-route-request',
      ip: '127.0.0.1'
    };
    let statusCode = 200;
    let payload;
    const response = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; }
    };
    let index = 0;
    async function next() {
      const handler = handlers[index++];
      if (!handler) return;
      if (handler.length >= 3) return handler(request, response, next);
      return handler(request, response);
    }
    await next();
    return { statusCode, payload };
  }

  return { calls, invoke, routes };
}

test('dedicated AI quota route requires platform admin and forwards only server-owned audit context', async () => {
  const h = harness();
  const denied = await h.invoke({ user: { id: 2, role: 'user' } });
  assert.equal(denied.statusCode, 403);
  assert.equal(h.calls.length, 0);

  const updated = await h.invoke({
    params: { userId: '7' },
    body: { api_quota: 123456, actorUserId: 99, organizationId: 88 }
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(h.calls[0], {
    actorUserId: 1,
    userId: '7',
    quota: 123456,
    requestId: 'quota-route-request',
    ipAddress: '127.0.0.1'
  });
  assert.equal(updated.payload.quota.limit, 123456);
});

test('dedicated AI quota route preserves typed validation and audit failures', async () => {
  const errors = [
    { statusCode: 400, code: 'AI_QUOTA_INVALID', message: 'AI quota is invalid.' },
    { statusCode: 500, code: 'AI_QUOTA_AUDIT_FAILED', message: 'AI quota audit failed.' }
  ];
  for (const expected of errors) {
    const h = harness({
      service: {
        updateUserQuota() {
          const error = new Error(expected.message);
          Object.assign(error, expected);
          throw error;
        }
      }
    });
    const result = await h.invoke();
    assert.deepEqual(result, {
      statusCode: expected.statusCode,
      payload: {
        error: expected.message,
        code: expected.code,
        request_id: 'quota-route-request'
      }
    });
  }
});
