'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const registerRoutes = require('../routes_admin_ai_concurrency');

function appFixture() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); }
  };
}

function responseFixture() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(value) { this.body = value; return this; }
  };
}

function invoke(handlers, request) {
  const response = responseFixture();
  let index = 0;
  const next = () => handlers[index++]?.(request, response, next);
  next();
  return response;
}

test('member read and administrator update preserve the concurrency projection', () => {
  const app = appFixture();
  const calls = [];
  const service = {
    currentOrganizationConcurrency(input) {
      calls.push(['read', input]);
      return { active: 1, limit: 10, available: 9, status: 'available', policy_version: 1 };
    },
    updateOrganizationConcurrencyPolicy(input) {
      calls.push(['update', input]);
      return { active: 1, limit: input.concurrencyLimit, available: 5, status: 'available', policy_version: 2 };
    }
  };
  registerRoutes(app, {}, {
    service,
    authMiddleware: (_request, _response, next) => next(),
    adminOnly: (_request, _response, next) => next()
  });
  const read = invoke(app.routes.get('GET /api/organization-ai-concurrency'), {
    user: { id: 7 }, authContext: { organization: { id: 12 } }, requestId: 'read-1'
  });
  assert.equal(read.body.concurrency.limit, 10);
  const update = invoke(app.routes.get('PUT /api/admin/organizations/:organizationId/ai-concurrency'), {
    user: { id: 1 }, params: { organizationId: '12' },
    body: { concurrency_limit: 6, expected_version: 1, reason: 'capacity review' },
    requestId: 'update-1', ip: '127.0.0.1'
  });
  assert.equal(update.body.concurrency.limit, 6);
  assert.equal(calls[1][1].concurrencyLimit, 6);
});

test('update rejects extra fields, accessors, invalid limits, and preserves typed errors', () => {
  for (const body of [
    { concurrency_limit: 2, expected_version: 1, reason: 'x', extra: true },
    { concurrency_limit: 65, expected_version: 1, reason: 'x' },
    Object.defineProperty({ concurrency_limit: 2, expected_version: 1 }, 'reason', { get() { return 'x'; }, enumerable: true })
  ]) {
    assert.throws(() => registerRoutes.exactConcurrencyBody(body), /invalid|only|accessors|must be/i);
  }
  const app = appFixture();
  registerRoutes(app, {}, {
    service: {
      currentOrganizationConcurrency() { return {}; },
      updateOrganizationConcurrencyPolicy() {
        const error = new Error('stale');
        error.statusCode = 409;
        error.code = 'AI_ORGANIZATION_CONCURRENCY_VERSION_CONFLICT';
        throw error;
      }
    },
    authMiddleware: (_request, _response, next) => next(),
    adminOnly: (_request, _response, next) => next()
  });
  const response = invoke(app.routes.get('PUT /api/admin/organizations/:organizationId/ai-concurrency'), {
    user: { id: 1 }, params: { organizationId: '12' },
    body: { concurrency_limit: 2, expected_version: 1, reason: 'capacity review' },
    requestId: 'update-2'
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'AI_ORGANIZATION_CONCURRENCY_VERSION_CONFLICT');
});
