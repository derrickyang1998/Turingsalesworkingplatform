'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadRoutes() {
  try {
    return require('../routes_subscription_expiry');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('subscription expiry routes have not been implemented');
    }
    throw error;
  }
}

function harness(overrides = {}) {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path) { routes.set(`GET ${path}`, Array.prototype.slice.call(arguments, 1)); },
    put(path) { routes.set(`PUT ${path}`, Array.prototype.slice.call(arguments, 1)); }
  };
  const service = Object.assign({
    currentForMember(input) {
      calls.push(['currentForMember', input]);
      return { organization_id: input.organizationId, expires_at: null, term_version: 1, status: 'perpetual' };
    },
    updateForAdmin(input) {
      calls.push(['updateForAdmin', input]);
      return { organization_id: Number(input.organizationId), expires_at: input.expiresAt, changed: true };
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

  async function invoke(method, path, input = {}) {
    const handlers = routes.get(`${method} ${path}`);
    assert.ok(handlers, `${method} ${path} must exist`);
    const request = {
      user: input.user || { id: 1, role: 'admin' },
      authContext: input.authContext || { organization: { id: 10 } },
      params: input.params || { organizationId: '10' },
      body: Object.hasOwn(input, 'body') ? input.body : {},
      requestId: input.requestId || 'subscription-route-request',
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
  return { calls, invoke };
}

test('member subscription route derives actor and organization only from authenticated context', async () => {
  const h = harness();
  const result = await h.invoke('GET', '/api/organization-subscription', {
    user: { id: 2, role: 'user' },
    authContext: { organization: { id: 20 } },
    body: { organizationId: 999, actorUserId: 999 }
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(h.calls[0], ['currentForMember', { actorUserId: 2, organizationId: 20 }]);
});

test('admin update route rejects unknown fields and forwards exact server-owned context', async () => {
  const h = harness();
  const denied = await h.invoke('PUT', '/api/admin/organizations/:organizationId/subscription', {
    user: { id: 2, role: 'user' },
    body: { expires_at: null, expected_version: 1, reason: 'Approved' }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(h.calls.length, 0);

  const extra = await h.invoke('PUT', '/api/admin/organizations/:organizationId/subscription', {
    body: { expires_at: null, expected_version: 1, reason: 'Approved', actor_user_id: 999 }
  });
  assert.equal(extra.statusCode, 400);

  await h.invoke('PUT', '/api/admin/organizations/:organizationId/subscription', {
    params: { organizationId: '20' },
    body: { expires_at: '2099-01-01T00:00:00Z', expected_version: 3, reason: 'Annual renewal' }
  });
  assert.deepEqual(h.calls.at(-1), ['updateForAdmin', {
    actorUserId: 1,
    organizationId: '20',
    expiresAt: '2099-01-01T00:00:00Z',
    expectedVersion: 3,
    reason: 'Annual renewal',
    requestId: 'subscription-route-request',
    ipAddress: '127.0.0.1'
  }]);
});

test('subscription routes preserve typed failures and request IDs', async () => {
  const h = harness({
    service: {
      updateForAdmin() {
        const error = new Error('Stale subscription term.');
        Object.assign(error, {
          name: 'SubscriptionExpiryServiceError',
          status: 409,
          code: 'SUBSCRIPTION_TERM_VERSION_CONFLICT'
        });
        throw error;
      }
    }
  });
  const result = await h.invoke('PUT', '/api/admin/organizations/:organizationId/subscription', {
    body: { expires_at: null, expected_version: 1, reason: 'Restore perpetual' }
  });
  assert.deepEqual(result, {
    statusCode: 409,
    payload: {
      error: 'Stale subscription term.',
      code: 'SUBSCRIPTION_TERM_VERSION_CONFLICT',
      request_id: 'subscription-route-request'
    }
  });
});
