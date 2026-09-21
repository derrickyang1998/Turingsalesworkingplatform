'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const registerRoutes = require('../routes_organization_billing');

function appFixture() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }
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

test('registers own and administrator billing reads with tenant and audit intent', () => {
  const app = appFixture();
  const calls = [];
  const service = {
    currentOrganizationBilling(input) {
      calls.push(input);
      return { organization_id: input.organizationId, month: input.month, status: 'estimated' };
    },
    updateOrganizationBillingPolicy() { return {}; },
    closeOrganizationBillingStatement() { return {}; }
  };
  registerRoutes(app, {}, {
    service,
    authMiddleware: (_request, _response, next) => next(),
    adminOnly: (_request, _response, next) => next()
  });

  const own = invoke(app.routes.get('GET /api/organization-billing'), {
    user: { id: 7 },
    authContext: { organization: { id: 12 } },
    query: { month: '2026-10' },
    requestId: 'own-billing'
  });
  assert.equal(own.body.billing.organization_id, 12);
  assert.equal(calls[0].adminAuditGlobal, false);
  assert.equal(own.headers['Cache-Control'], 'private, no-store');

  const admin = invoke(app.routes.get('GET /api/admin/organizations/:organizationId/billing'), {
    user: { id: 1 }, params: { organizationId: '20' }, query: { month: '2026-09' },
    requestId: 'admin-billing', ip: '127.0.0.1'
  });
  assert.equal(admin.body.billing.organization_id, 20);
  assert.equal(calls[1].adminAuditGlobal, true);
  assert.equal(calls[1].ipAddress, '127.0.0.1');
  assert.equal(admin.headers['Cache-Control'], 'private, no-store');
});

test('policy and statement routes accept exact snake-case bodies and preserve typed errors', () => {
  const app = appFixture();
  const calls = [];
  const service = {
    currentOrganizationBilling() { return {}; },
    updateOrganizationBillingPolicy(input) {
      calls.push(['policy', input]);
      return { changed: true, policy: { policy_version: 2 } };
    },
    closeOrganizationBillingStatement(input) {
      calls.push(['close', input]);
      return { status: 'closed', statement: { id: 4 } };
    }
  };
  registerRoutes(app, {}, {
    service,
    authMiddleware: (_request, _response, next) => next(),
    adminOnly: (_request, _response, next) => next()
  });
  const policyBody = {
    billing_enabled: true,
    base_fee_cents: 2500,
    included_tokens: 1000000,
    overage_cents_per_million_tokens: 300,
    effective_month: '2026-10',
    expected_version: 1,
    reason: 'Approved pricing'
  };
  const policy = invoke(app.routes.get('PUT /api/admin/organizations/:organizationId/billing-policy'), {
    user: { id: 1 }, params: { organizationId: '10' }, body: policyBody,
    requestId: 'policy-1', ip: '127.0.0.1'
  });
  assert.equal(policy.body.billing.policy.policy_version, 2);
  assert.equal(calls[0][1].overageCentsPerMillionTokens, 300);

  const close = invoke(app.routes.get('POST /api/admin/organizations/:organizationId/billing-statements/close'), {
    user: { id: 1 }, params: { organizationId: '10' },
    body: { period: '2026-09', expected_policy_version: 2, reason: 'Close September' },
    requestId: 'close-1', ip: '127.0.0.1'
  });
  assert.equal(close.body.billing.statement.id, 4);
  assert.equal(calls[1][1].expectedPolicyVersion, 2);

  for (const body of [
    { ...policyBody, extra: true },
    { ...policyBody, billing_enabled: 1 },
    Object.defineProperty({ ...policyBody }, 'reason', { get() { return 'x'; }, enumerable: true })
  ]) {
    assert.throws(() => registerRoutes.exactPolicyBody(body), /invalid|only|accessors|must be/i);
  }
  assert.throws(
    () => registerRoutes.exactCloseBody({ period: '2026-09', expected_policy_version: 2, reason: 'x', extra: true }),
    /only/i
  );

  service.closeOrganizationBillingStatement = () => {
    const error = new Error('already closed');
    error.statusCode = 409;
    error.code = 'ORGANIZATION_BILLING_STATEMENT_CONFLICT';
    throw error;
  };
  const conflict = invoke(app.routes.get('POST /api/admin/organizations/:organizationId/billing-statements/close'), {
    user: { id: 1 }, params: { organizationId: '10' },
    body: { period: '2026-09', expected_policy_version: 2, reason: 'Close September' },
    requestId: 'close-conflict'
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'ORGANIZATION_BILLING_STATEMENT_CONFLICT');
  assert.equal(conflict.headers['Cache-Control'], 'private, no-store');
});

test('rejects unexpected query keys and unsafe query objects before service invocation', () => {
  let calls = 0;
  const app = appFixture();
  registerRoutes(app, {}, {
    service: {
      currentOrganizationBilling() { calls += 1; return {}; },
      updateOrganizationBillingPolicy() { return {}; },
      closeOrganizationBillingStatement() { return {}; }
    },
    authMiddleware: (_request, _response, next) => next(),
    adminOnly: (_request, _response, next) => next()
  });
  const extra = invoke(app.routes.get('GET /api/organization-billing'), {
    user: { id: 7 }, authContext: { organization: { id: 12 } },
    query: { month: '2026-10', organizationId: '20' }, requestId: 'bad-query'
  });
  assert.equal(extra.statusCode, 400);
  assert.equal(calls, 0);

  let trapInvoked = false;
  const proxy = new Proxy({ month: '2026-10' }, {
    ownKeys() { trapInvoked = true; return ['month']; }
  });
  const unsafe = invoke(app.routes.get('GET /api/organization-billing'), {
    user: { id: 7 }, authContext: { organization: { id: 12 } }, query: proxy
  });
  assert.equal(unsafe.statusCode, 400);
  assert.equal(trapInvoked, false);
  assert.equal(calls, 0);
});
