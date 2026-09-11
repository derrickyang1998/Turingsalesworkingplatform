'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registerAdminTenantDirectoryRoutes = require('../routes_admin_tenant_directory');
const {
  AdminTenantDirectoryServiceError
} = require('../services/admin_tenant_directory_service');

function harness(overrides = {}) {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path) {
      routes.set(`GET ${path}`, Array.prototype.slice.call(arguments, 1));
    }
  };
  const service = Object.assign({
    listUsers(input) {
      calls.push(['listUsers', input]);
      return { users: [], page: { limit: 50, next_cursor: null, has_more: false } };
    },
    listOrganizations(input) {
      calls.push(['listOrganizations', input]);
      return { organizations: [], page: { limit: 50, next_cursor: null, has_more: false } };
    },
    listOrganizationMembers(input) {
      calls.push(['listOrganizationMembers', input]);
      return {
        organization: { id: 10, code: 'alpha-market', name: 'Alpha Market' },
        members: [],
        page: { limit: 50, next_cursor: null, has_more: false }
      };
    }
  }, overrides.service || {});
  function authMiddleware(_req, _res, next) { return next(); }
  function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    return next();
  }
  registerAdminTenantDirectoryRoutes(app, {}, { authMiddleware, adminOnly, service });

  async function invoke(key, input = {}) {
    const handlers = routes.get(key);
    assert.ok(handlers, `missing route ${key}`);
    const req = {
      user: input.user || { id: 1, role: 'admin' },
      params: input.params || {},
      query: input.query || {},
      ip: input.ip || '127.0.0.1'
    };
    if (Object.hasOwn(input, 'requestId')) req.requestId = input.requestId;
    let statusCode = 200;
    let payload;
    const res = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; }
    };
    let index = 0;
    async function next() {
      const handler = handlers[index++];
      if (!handler) return;
      if (handler.length >= 3) return handler(req, res, next);
      return handler(req, res);
    }
    await next();
    return { statusCode, payload };
  }

  return { calls, invoke, routes };
}

test('tenant directory routes require platform admin and pass only server-owned actor context', async () => {
  const h = harness();
  assert.deepEqual([...h.routes.keys()].sort(), [
    'GET /api/admin/users',
    'GET /api/admin/organizations',
    'GET /api/admin/organizations/:organizationId/members'
  ].sort());

  const denied = await h.invoke('GET /api/admin/organizations', {
    user: { id: 2, role: 'user' },
    query: { role: 'admin', organization_id: '20' }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(h.calls.length, 0);

  const users = await h.invoke('GET /api/admin/users', {
    query: { q: 'alice', status: 'active', role: 'team_lead', limit: '25' },
    requestId: 'user-directory-request'
  });
  assert.equal(users.statusCode, 200);
  assert.equal(users.payload.request_id, 'user-directory-request');
  assert.deepEqual(h.calls[0][1], {
    actor: { id: 1, role: 'admin' },
    requestId: 'user-directory-request',
    ipAddress: '127.0.0.1',
    query: { q: 'alice', status: 'active', role: 'team_lead', limit: '25' }
  });

  const listed = await h.invoke('GET /api/admin/organizations', {
    query: { q: 'alpha', limit: '25', role: 'owner' },
    requestId: 'route-request'
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.payload.request_id, 'route-request');
  assert.deepEqual(h.calls[1][1], {
    actor: { id: 1, role: 'admin' },
    requestId: 'route-request',
    ipAddress: '127.0.0.1',
    query: { q: 'alpha', limit: '25', role: 'owner' }
  });

  const members = await h.invoke('GET /api/admin/organizations/:organizationId/members', {
    params: { organizationId: '10' },
    query: { status: 'active' },
    requestId: 'route-request'
  });
  assert.equal(members.statusCode, 200);
  assert.equal(h.calls[2][1].organizationId, '10');
});

test('tenant directory routes preserve typed service errors and request IDs', async () => {
  const h = harness({
    service: {
      listOrganizations() {
        throw new AdminTenantDirectoryServiceError(
          400,
          'INVALID_TENANT_DIRECTORY_FILTER',
          'Invalid directory filter.'
        );
      }
    }
  });
  const result = await h.invoke('GET /api/admin/organizations', { requestId: 'route-request' });
  assert.deepEqual(result, {
    statusCode: 400,
    payload: {
      error: 'Invalid directory filter.',
      code: 'INVALID_TENANT_DIRECTORY_FILTER',
      request_id: 'route-request'
    }
  });
});

test('tenant directory routes generate one unique request ID when upstream middleware has none', async () => {
  const h = harness();
  const first = await h.invoke('GET /api/admin/organizations');
  const second = await h.invoke('GET /api/admin/organizations');
  assert.match(first.payload.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(second.payload.request_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.payload.request_id, second.payload.request_id);
  assert.equal(h.calls[0][1].requestId, first.payload.request_id);
  assert.equal(h.calls[1][1].requestId, second.payload.request_id);
});
