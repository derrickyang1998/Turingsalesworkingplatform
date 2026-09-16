'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadRoute() {
  try {
    return require('../routes_organization_governance');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('organization governance routes have not been implemented');
    }
    throw error;
  }
}

function harness(overrides = {}) {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path) { routes.set(`GET ${path}`, Array.prototype.slice.call(arguments, 1)); },
    post(path) { routes.set(`POST ${path}`, Array.prototype.slice.call(arguments, 1)); },
    patch(path) { routes.set(`PATCH ${path}`, Array.prototype.slice.call(arguments, 1)); }
  };
  const service = Object.assign({
    listOrganizations(input) {
      calls.push(['listOrganizations', input]);
      return { organizations: [], page: { limit: 50, next_cursor: null, has_more: false } };
    },
    listMembers(input) {
      calls.push(['listMembers', input]);
      return {
        organization: { id: 10, code: 'alpha', name: 'Alpha', company_owner: null },
        members: [],
        page: { limit: 50, next_cursor: null, has_more: false }
      };
    },
    initializeOwner(input) {
      calls.push(['initializeOwner', input]);
      return { changed: true };
    },
    updateMember(input) {
      calls.push(['updateMember', input]);
      return { changed: true };
    }
  }, overrides.service || {});
  function authMiddleware(_request, _response, next) { return next(); }
  loadRoute()(app, {}, { authMiddleware, service });

  async function invoke(key, input = {}) {
    const handlers = routes.get(key);
    assert.ok(handlers, `missing route ${key}`);
    const request = {
      user: input.user || { id: 1, role: 'admin' },
      params: input.params || {},
      query: input.query || {},
      body: input.body,
      ip: input.ip || '127.0.0.1',
      requestId: input.requestId || 'governance-route-request'
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

test('registers only the approved governance endpoints and preserves exact GET success envelopes', async () => {
  const h = harness();
  assert.deepEqual([...h.routes.keys()].sort(), [
    'GET /api/organization-governance/organizations',
    'GET /api/organization-governance/organizations/:organizationId/members',
    'PATCH /api/organization-governance/organizations/:organizationId/members/:userId',
    'POST /api/organization-governance/organizations/:organizationId/owner/initialize'
  ].sort());

  const organizations = await h.invoke('GET /api/organization-governance/organizations', {
    query: { limit: '25', cursor: '10' }
  });
  assert.deepEqual(organizations, {
    statusCode: 200,
    payload: { organizations: [], page: { limit: 50, next_cursor: null, has_more: false } }
  });
  assert.deepEqual(h.calls[0], ['listOrganizations', {
    actor: { id: 1, role: 'admin' },
    requestId: 'governance-route-request',
    ipAddress: '127.0.0.1',
    query: { limit: '25', cursor: '10' }
  }]);

  const members = await h.invoke(
    'GET /api/organization-governance/organizations/:organizationId/members',
    { params: { organizationId: '20' }, query: { limit: '10' } }
  );
  assert.equal(members.statusCode, 200);
  assert.deepEqual(Object.keys(members.payload), ['organization', 'members', 'page']);
  assert.equal(h.calls[1][1].organizationId, '20');
});

test('accepts only exact owner initialization and member patch bodies', async () => {
  const h = harness();

  const initialized = await h.invoke(
    'POST /api/organization-governance/organizations/:organizationId/owner/initialize',
    { params: { organizationId: '20' }, body: { user_id: 4 } }
  );
  assert.deepEqual(initialized, {
    statusCode: 200,
    payload: { success: true, request_id: 'governance-route-request' }
  });
  assert.deepEqual(h.calls[0][1].body, { user_id: 4 });

  for (const body of [
    undefined,
    null,
    {},
    { user_id: 4, role: 'owner' },
    { user_id: '4' },
    Object.assign(Object.create(null), { user_id: 4 })
  ]) {
    const result = await h.invoke(
      'POST /api/organization-governance/organizations/:organizationId/owner/initialize',
      { params: { organizationId: '20' }, body }
    );
    assert.equal(result.statusCode, 400);
    assert.deepEqual(Object.keys(result.payload), ['error', 'code', 'request_id']);
    assert.equal(result.payload.code, 'INVALID_ORGANIZATION_GOVERNANCE_BODY');
  }

  for (const body of [
    { access_role: 'administrator' },
    { access_role: 'manager', membership_status: 'active' },
    { access_role: 'member', membership_status: 'revoked' },
    { access_role: 'read_only' },
    { membership_status: 'active' }
  ]) {
    const result = await h.invoke(
      'PATCH /api/organization-governance/organizations/:organizationId/members/:userId',
      { params: { organizationId: '20', userId: '4' }, body }
    );
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload, { success: true, request_id: 'governance-route-request' });
  }

  const acceptedCallCount = h.calls.length;
  for (const body of [
    undefined,
    null,
    {},
    { access_role: 'owner' },
    { membership_status: 'inactive' },
    { access_role: 'member', unexpected: true },
    { access_role: ['member'] },
    { membership_status: new String('active') }
  ]) {
    const result = await h.invoke(
      'PATCH /api/organization-governance/organizations/:organizationId/members/:userId',
      { params: { organizationId: '20', userId: '4' }, body }
    );
    assert.equal(result.statusCode, 400);
    assert.equal(result.payload.code, 'INVALID_ORGANIZATION_GOVERNANCE_BODY');
  }
  assert.equal(h.calls.length, acceptedCallCount);
});

test('returns stable displayable service errors with request IDs', async () => {
  const h = harness({
    service: {
      listMembers() {
        const error = new Error('无权访问该组织的治理信息。');
        error.name = 'OrganizationGovernanceServiceError';
        error.status = 403;
        error.code = 'ORGANIZATION_GOVERNANCE_FORBIDDEN';
        throw error;
      }
    }
  });
  const result = await h.invoke(
    'GET /api/organization-governance/organizations/:organizationId/members',
    { params: { organizationId: '20' }, requestId: 'stable-error-request' }
  );
  assert.deepEqual(result, {
    statusCode: 403,
    payload: {
      error: '无权访问该组织的治理信息。',
      code: 'ORGANIZATION_GOVERNANCE_FORBIDDEN',
      request_id: 'stable-error-request'
    }
  });
});
