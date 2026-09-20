'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadRoutes() {
  try {
    return require('../routes_plan_entitlements');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('plan entitlement routes have not been implemented');
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
    listCatalog(input) {
      calls.push(['listCatalog', input]);
      return { catalog_version: 1, plans: [] };
    },
    currentForMember(input) {
      calls.push(['currentForMember', input]);
      return { organization_id: input.organizationId, plan_code: 'legacy_full', modules: [] };
    },
    assignForAdmin(input) {
      calls.push(['assignForAdmin', input]);
      return { organization_id: Number(input.organizationId), plan_code: input.planCode, changed: true };
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
      body: input.body || {},
      requestId: input.requestId || 'plan-route-request',
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

test('admin catalog and assignment routes require platform administration and forward server-owned context', async () => {
  const h = harness();
  const denied = await h.invoke('GET', '/api/admin/plan-catalog', {
    user: { id: 2, role: 'user' }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(h.calls.length, 0);

  await h.invoke('GET', '/api/admin/plan-catalog');
  assert.deepEqual(h.calls[0], ['listCatalog', {
    actorUserId: 1,
    requestId: 'plan-route-request',
    ipAddress: '127.0.0.1'
  }]);

  const assigned = await h.invoke('PUT', '/api/admin/organizations/:organizationId/plan', {
    params: { organizationId: '20' },
    body: {
      plan_code: 'crm_core',
      expected_version: 3,
      reason: 'Approved scope',
      actorUserId: 999
    }
  });
  assert.equal(assigned.statusCode, 400, 'unknown body properties must be rejected');

  await h.invoke('PUT', '/api/admin/organizations/:organizationId/plan', {
    params: { organizationId: '20' },
    body: { plan_code: 'crm_core', expected_version: 3, reason: 'Approved scope' }
  });
  assert.deepEqual(h.calls.at(-1), ['assignForAdmin', {
    actorUserId: 1,
    organizationId: '20',
    planCode: 'crm_core',
    expectedVersion: 3,
    reason: 'Approved scope',
    requestId: 'plan-route-request',
    ipAddress: '127.0.0.1'
  }]);
});
test('organization entitlement route derives organization and actor only from authenticated context', async () => {
  const h = harness();
  const result = await h.invoke('GET', '/api/organization-entitlements', {
    user: { id: 2, role: 'user' },
    authContext: { organization: { id: 20 } },
    body: { organizationId: 999, actorUserId: 999 }
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(h.calls[0], ['currentForMember', {
    actorUserId: 2,
    organizationId: 20
  }]);
});

test('plan routes preserve typed service errors and request IDs', async () => {
  const h = harness({
    service: {
      assignForAdmin() {
        const error = new Error('Stale plan assignment.');
        Object.assign(error, {
          name: 'PlanEntitlementServiceError',
          status: 409,
          code: 'PLAN_ASSIGNMENT_VERSION_CONFLICT'
        });
        throw error;
      }
    }
  });
  const result = await h.invoke('PUT', '/api/admin/organizations/:organizationId/plan', {
    body: { plan_code: 'crm_core', expected_version: 1, reason: 'Approved scope' }
  });
  assert.deepEqual(result, {
    statusCode: 409,
    payload: {
      error: 'Stale plan assignment.',
      code: 'PLAN_ASSIGNMENT_VERSION_CONFLICT',
      request_id: 'plan-route-request'
    }
  });
});
