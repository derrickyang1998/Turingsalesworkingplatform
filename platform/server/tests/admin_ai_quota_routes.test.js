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
    get(path) {
      routes.set(`GET ${path}`, Array.prototype.slice.call(arguments, 1));
    },
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
    },
    currentOrganizationQuota(input) {
      calls.push(input);
      return {
        organization_id: Number(input.organizationId),
        period: 'utc_calendar_month',
        period_key: '2026-09',
        used: 120,
        limit: 5000,
        remaining: 4880,
        status: 'active',
        policy_version: 2
      };
    },
    updateOrganizationMonthlyQuota(input) {
      calls.push(input);
      return {
        organization_id: Number(input.organizationId),
        period: 'utc_calendar_month',
        period_key: '2026-09',
        used: 120,
        limit: input.monthlyLimit,
        remaining: input.monthlyLimit === null ? null : Math.max(0, input.monthlyLimit - 120),
        status: input.monthlyLimit === null ? 'unlimited' : 'active',
        policy_version: Number(input.expectedVersion) + 1,
        changed: true
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
    const handlers = routes.get(input.route || 'PUT /api/admin/users/:userId/ai-quota');
    assert.ok(handlers, 'dedicated AI quota route must exist');
    const request = {
      user: input.user || { id: 1, role: 'admin' },
      params: input.params || { userId: '2' },
      body: Object.hasOwn(input, 'body') ? input.body : { api_quota: 50000 },
      requestId: input.requestId || 'quota-route-request',
      ip: '127.0.0.1',
      authContext: input.authContext || { organization: { id: 10 } }
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

test('active members can read the current organization monthly quota', async () => {
  const h = harness();
  const result = await h.invoke({
    route: 'GET /api/organization-ai-quota',
    user: { id: 2, role: 'user' },
    params: {},
    body: undefined,
    authContext: { organization: { id: 20 } }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.quota.organization_id, 20);
  assert.deepEqual(h.calls[0], {
    actorUserId: 2,
    organizationId: 20
  });
});

test('organization monthly quota update requires admin and an exact versioned body', async () => {
  const h = harness();
  const denied = await h.invoke({
    route: 'PUT /api/admin/organizations/:organizationId/ai-quota',
    user: { id: 2, role: 'user' },
    params: { organizationId: '10' },
    body: { monthly_limit: 5000, expected_version: 2, reason: 'Approved allocation' }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(h.calls.length, 0);

  const invalid = await h.invoke({
    route: 'PUT /api/admin/organizations/:organizationId/ai-quota',
    params: { organizationId: '10' },
    body: {
      monthly_limit: 5000,
      expected_version: 2,
      reason: 'Approved allocation',
      actorUserId: 99
    }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.payload.code, 'AI_ORGANIZATION_QUOTA_INVALID');
  assert.equal(h.calls.length, 0);

  let getterCalls = 0;
  const accessorBody = {
    expected_version: 2,
    reason: 'Accessor must not execute'
  };
  Object.defineProperty(accessorBody, 'monthly_limit', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 5000;
    }
  });
  const accessor = await h.invoke({
    route: 'PUT /api/admin/organizations/:organizationId/ai-quota',
    params: { organizationId: '10' },
    body: accessorBody
  });
  assert.equal(accessor.statusCode, 400);
  assert.equal(accessor.payload.code, 'AI_ORGANIZATION_QUOTA_INVALID');
  assert.equal(getterCalls, 0);
  assert.equal(h.calls.length, 0);

  for (const expectedVersion of [true, '2', 2.5]) {
    const invalidVersion = await h.invoke({
      route: 'PUT /api/admin/organizations/:organizationId/ai-quota',
      params: { organizationId: '10' },
      body: {
        monthly_limit: 5000,
        expected_version: expectedVersion,
        reason: 'CAS version must be a numeric integer'
      }
    });
    assert.equal(invalidVersion.statusCode, 400);
    assert.equal(invalidVersion.payload.code, 'AI_ORGANIZATION_QUOTA_INVALID');
    assert.equal(h.calls.length, 0);
  }

  const updated = await h.invoke({
    route: 'PUT /api/admin/organizations/:organizationId/ai-quota',
    params: { organizationId: '10' },
    body: { monthly_limit: null, expected_version: 2, reason: 'Restore unlimited policy' }
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(h.calls[0], {
    actorUserId: 1,
    organizationId: '10',
    monthlyLimit: null,
    expectedVersion: 2,
    reason: 'Restore unlimited policy',
    requestId: 'quota-route-request',
    ipAddress: '127.0.0.1'
  });
  assert.equal(updated.payload.quota.status, 'unlimited');
});
