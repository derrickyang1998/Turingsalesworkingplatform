'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const DEFAULT_CONTEXT = Object.freeze({
  organization: Object.freeze({ id: 501, code: 'http-org', role_code: 'member' }),
  teams: Object.freeze([Object.freeze({ id: 601, role_code: 'member' })])
});

function canonicalCustomerList(overrides) {
  return Object.assign({
    items: [{ id: 41, brand_name: 'Acme', stage: 'lead' }],
    total: 1,
    page: { limit: 25, next_cursor: null, has_more: false },
    meta: {
      scope: 'my',
      applied_filters: { scope: 'my' },
      query_fingerprint: 'customer-fingerprint',
      as_of: '2026-08-10T00:00:00.000Z'
    }
  }, overrides || {});
}

function canonicalDashboard(overrides) {
  return Object.assign({
    customers: {
      total: 3,
      by_stage: { lead: 2, paused: 0, won: 1, lost: 0 },
      by_group: { development: 2, closed: 1 },
      overdue_next_action: 0,
      no_next_action: 3,
      stalled: 0,
      quarantined: 0
    },
    opportunities: { open_count: 2, open_amount: 12500, weighted_forecast: 6250 },
    meta: {
      scope: 'my',
      applied_filters: { scope: 'my' },
      query_fingerprint: 'dashboard-fingerprint',
      as_of: '2026-08-10T00:00:00.000Z'
    }
  }, overrides || {});
}

function canonicalOpportunityList() {
  return {
    items: [{
      id: 71,
      customer_id: 41,
      name: 'Launch',
      stage: 'discovery',
      customer_brand_name: 'Acme'
    }],
    total: 1,
    page: { limit: 100, next_cursor: null, has_more: false },
    meta: {
      scope: 'my',
      applied_filters: { scope: 'my' },
      query_fingerprint: 'opportunity-fingerprint',
      as_of: '2026-08-10T00:00:00.000Z'
    }
  };
}

function success(entity, action, id) {
  return {
    ok: true,
    entity,
    action,
    record: { id, updated_at: '2026-08-10 00:00:00' },
    meta: { request_id: 'http-request', correlation_id: 'http-correlation' }
  };
}

function makeHarness(options) {
  const settings = options || {};
  const routes = new Map();
  const calls = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = function register(path) {
      routes.set(`${method.toUpperCase()} ${path}`, Array.prototype.slice.call(arguments, 1));
    };
  }

  const crmQueryService = Object.assign({
    listCustomers(_db, input) {
      calls.push({ method: 'listCustomers', input });
      return canonicalCustomerList();
    },
    listOpportunities(_db, input) {
      calls.push({ method: 'listOpportunities', input });
      return canonicalOpportunityList();
    },
    getCrmDashboard(_db, input) {
      calls.push({ method: 'getCrmDashboard', input });
      return canonicalDashboard();
    }
  }, settings.crmQueryService || {});

  const crmCustomerService = Object.assign({
    createOrUpdateCustomer(_db, input) {
      calls.push({ method: 'createOrUpdateCustomer', input });
      return success('customer', input.command.mode === 'create' ? 'created' : 'updated', 41);
    },
    mutateCustomerCustody(_db, input) {
      calls.push({ method: 'mutateCustomerCustody', input });
      return success('customer_custody', input.command.action, input.command.customerId);
    },
    createOrUpdateOpportunity(_db, input) {
      calls.push({ method: 'createOrUpdateOpportunity', input });
      return success('opportunity', input.command.mode === 'create' ? 'created' : 'updated', 71);
    },
    mutateCustomerContact(_db, input) {
      calls.push({ method: 'mutateCustomerContact', input });
      return success('contact', input.command.action, input.command.contactId || 81);
    },
    mutateCrmTask(_db, input) {
      calls.push({ method: 'mutateCrmTask', input });
      return success('task', input.command.action, input.command.taskId || 91);
    },
    archiveCustomerResult(_db, input) {
      calls.push({ method: 'archiveCustomerResult', input });
      return success('customer_archive', 'archived', 101);
    },
    recordCustomerActivity(_db, input) {
      calls.push({ method: 'recordCustomerActivity', input });
      return success('customer_activity', 'recorded', 111);
    }
  }, settings.crmCustomerService || {});

  const db = new Proxy({}, {
    get(_target, property) {
      if (property === 'open') return true;
      throw new Error(`CRM_SQL_BYPASS:${String(property)}`);
    }
  });
  const authMiddleware = function authMiddleware(_req, _res, next) { return next(); };
  require('../routes_customers')(app, db, authMiddleware, {
    crmQueryService,
    crmCustomerService
  });

  async function invoke(key, request) {
    const handlers = routes.get(key);
    assert.ok(handlers, `route not found: ${key}`);
    const input = request || {};
    const req = {
      user: input.user || { id: 101, role: 'user' },
      authContext: input.authContext || DEFAULT_CONTEXT,
      params: input.params || {},
      query: input.query || {},
      body: input.body || {},
      headers: Object.assign({ 'x-correlation-id': 'http-correlation' }, input.headers || {}),
      requestId: input.requestId || 'http-request',
      ip: '127.0.0.1'
    };
    let statusCode = 200;
    let payload;
    let contentType = null;
    const res = {
      status(code) { statusCode = code; return this; },
      type(value) { contentType = value; return this; },
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
    return { statusCode, payload, contentType };
  }

  return { calls, invoke, routes };
}

function lastCall(harness, method) {
  const matching = harness.calls.filter((call) => call.method === method);
  assert.ok(matching.length, `expected ${method} call`);
  return matching[matching.length - 1];
}

test('crm http: customer list normalizes aliases and preserves canonical metadata', async () => {
  const harness = makeHarness();
  const response = await harness.invoke('GET /api/customers', {
    query: {
      scope: 'all',
      stage: 'proposal',
      search: '  ACME  ',
      pageSize: '1000',
      priority: 'high'
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.customers, response.payload.items);
  assert.equal(response.payload.total, 1);
  assert.equal(response.payload.meta.query_fingerprint, 'customer-fingerprint');
  assert.ok(response.payload.stages.lead);
  const input = lastCall(harness, 'listCustomers').input;
  assert.equal(input.actorUserId, 101);
  assert.equal(input.organizationId, 501);
  assert.equal(input.requestId, 'http-request');
  assert.deepEqual(input.filter, {
    scope: 'organization',
    customer_stage: ['proposal'],
    priority: ['high'],
    keyword: 'ACME',
    limit: 100
  });
});

test('crm http: sea pool and stats use canonical query services and keep UI aliases', async () => {
  const harness = makeHarness({
    crmQueryService: {
      listCustomers(_db, input) {
        harness.calls.push({ method: 'listCustomers', input });
        return canonicalCustomerList({ items: [], total: 7 });
      }
    }
  });
  const pool = await harness.invoke('GET /api/customers/sea-pool', { query: { limit: '50' } });
  assert.equal(pool.statusCode, 200);
  assert.deepEqual(pool.payload.customers, []);
  assert.equal(pool.payload.total, 7);
  assert.equal(lastCall(harness, 'listCustomers').input.filter.scope, 'public_pool');

  harness.calls.length = 0;
  const stats = await harness.invoke('GET /api/customers/stats', { query: { scope: 'my' } });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.payload.total, 3);
  assert.equal(stats.payload.publicPool, 7);
  assert.equal(stats.payload.totalOppValue, 12500);
  assert.equal(stats.payload.byStage.lead, 2);
  assert.equal(stats.payload.won, 1);
  assert.equal(stats.payload.meta.query_fingerprint, 'dashboard-fingerprint');
  assert.deepEqual(harness.calls.map((call) => call.method), [
    'getCrmDashboard',
    'listCustomers'
  ]);
});

test('crm http: dashboard and opportunity list preserve canonical and legacy envelopes', async () => {
  const harness = makeHarness();
  const dashboard = await harness.invoke('GET /api/customers/dashboard', {
    query: { scope: 'team', status: 'active' }
  });
  assert.equal(dashboard.statusCode, 200);
  assert.equal(dashboard.payload.customers.total, 3);
  assert.equal(dashboard.payload.opportunities.open_amount, 12500);
  assert.equal(dashboard.payload.meta.scope, 'my');

  const opportunities = await harness.invoke('GET /api/opportunities', {
    query: { scope: 'my', stage: 'discovery', search: 'launch', pageSize: '1000' }
  });
  assert.equal(opportunities.statusCode, 200);
  assert.deepEqual(opportunities.payload.rows, opportunities.payload.opportunities);
  assert.equal(opportunities.payload.opportunities[0].brand_name, 'Acme');
  assert.equal(opportunities.payload.items[0].brand_name, undefined);
  assert.deepEqual(lastCall(harness, 'listOpportunities').input.filter, {
    scope: 'my',
    opportunity_stage: ['discovery'],
    keyword: 'launch',
    limit: 100
  });
});

test('crm http: customer create and lead conversion derive actor scope and one active team', async () => {
  const harness = makeHarness();
  const created = await harness.invoke('POST /api/customers', {
    body: {
      brand_name: 'Acme',
      company_name: 'Acme Co',
      stage: 'lead',
      assigned_to: 999,
      team_id: 601,
      organizationId: 999,
      actorUserId: 999
    }
  });
  assert.equal(created.statusCode, 200);
  const createInput = lastCall(harness, 'createOrUpdateCustomer').input;
  assert.equal(createInput.actorUserId, 101);
  assert.equal(createInput.organizationId, 501);
  assert.deepEqual(createInput.command, {
    mode: 'create',
    values: {
      brand_name: 'Acme',
      company_name: 'Acme Co',
      assigned_to: 101,
      team_id: 601
    }
  });

  harness.calls.length = 0;
  const converted = await harness.invoke('POST /api/leads/:id/convert', {
    params: { id: '31' },
    body: { assigned_to: 999, team_id: 601 }
  });
  assert.equal(converted.statusCode, 200);
  assert.deepEqual(lastCall(harness, 'createOrUpdateCustomer').input.command, {
    mode: 'create',
    sourceLeadId: 31,
    values: { assigned_to: 101, team_id: 601 }
  });
});

test('crm http: customer mixed update becomes one atomic S4 command', async () => {
  const harness = makeHarness();
  const response = await harness.invoke('PUT /api/customers/:id', {
    params: { id: '41' },
    body: {
      brand_name: 'Acme Next',
      stage: 'paused',
      reason_code: 'timeline_changed',
      next_action_at: '2099-01-01 09:00:00'
    }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(harness.calls.filter((call) => call.method === 'createOrUpdateCustomer').length, 1);
  assert.deepEqual(lastCall(harness, 'createOrUpdateCustomer').input.command, {
    mode: 'update',
    customerId: 41,
    values: { brand_name: 'Acme Next' },
    transition: {
      to_stage: 'paused',
      reason_code: 'timeline_changed',
      next_action_at: '2099-01-01 09:00:00'
    }
  });
});

test('crm http: custody aliases map to claim, release, and transfer commands', async () => {
  const harness = makeHarness();
  await harness.invoke('POST /api/customers/:id/claim', { params: { id: '41' } });
  assert.deepEqual(lastCall(harness, 'mutateCustomerCustody').input.command, {
    action: 'claim', customerId: 41, team_id: 601
  });

  harness.calls.length = 0;
  await harness.invoke('POST /api/customers/:id/return', {
    params: { id: '41' }, body: { reason_code: 'capacity_rebalance' }
  });
  const returnCommand = lastCall(harness, 'mutateCustomerCustody').input.command;
  harness.calls.length = 0;
  await harness.invoke('POST /api/customers/:id/return-pool', {
    params: { id: '41' }, body: { reason_code: 'capacity_rebalance' }
  });
  assert.deepEqual(lastCall(harness, 'mutateCustomerCustody').input.command, returnCommand);
  assert.deepEqual(returnCommand, {
    action: 'release', customerId: 41, reason_code: 'capacity_rebalance'
  });

  harness.calls.length = 0;
  await harness.invoke('POST /api/customers/:id/assign', {
    params: { id: '41' },
    authContext: {
      organization: { id: 501, code: 'http-org', role_code: 'org_admin' },
      teams: [{ id: 601, role_code: 'manager' }]
    },
    body: { user_id: 102, team_id: 601, reason_code: 'manager_assignment' }
  });
  assert.deepEqual(lastCall(harness, 'mutateCustomerCustody').input.command, {
    action: 'transfer',
    customerId: 41,
    assigned_to: 102,
    team_id: 601,
    reason_code: 'manager_assignment'
  });
});

test('crm http: opportunity create and update strip flat stages into canonical commands', async () => {
  const harness = makeHarness();
  await harness.invoke('POST /api/opportunities', {
    body: {
      customer_id: 41,
      name: 'Launch',
      stage: 'discovery',
      value: 5000,
      win_probability: 40
    }
  });
  assert.deepEqual(lastCall(harness, 'createOrUpdateOpportunity').input.command, {
    mode: 'create',
    customerId: 41,
    values: { name: 'Launch', value: 5000, win_probability: 40 }
  });

  harness.calls.length = 0;
  await harness.invoke('PUT /api/opportunities/:id', {
    params: { id: '71' },
    body: {
      customer_id: 41,
      name: 'Launch v2',
      stage: 'proposal',
      reason_code: 'requirements_changed',
      campaign_disposition: 'continue'
    }
  });
  assert.deepEqual(lastCall(harness, 'createOrUpdateOpportunity').input.command, {
    mode: 'update',
    customerId: 41,
    opportunityId: 71,
    values: { name: 'Launch v2' },
    transition: {
      to_stage: 'proposal',
      reason_code: 'requirements_changed',
      campaign_disposition: 'continue'
    }
  });
});

test('crm http: archive, contact, task, and reference activity use S4 aggregate adapters', async () => {
  const harness = makeHarness();
  await harness.invoke('POST /api/customers/:id/archive-result', {
    params: { id: '41' },
    body: { artifact_type: 'proposal', title: 'Plan', content: 'Body', tags: ['crm'] }
  });
  assert.deepEqual(lastCall(harness, 'archiveCustomerResult').input.command, {
    customerId: 41,
    artifact_type: 'proposal',
    title: 'Plan',
    content: 'Body',
    tags: ['crm']
  });

  harness.calls.length = 0;
  await harness.invoke('POST /api/customers/:customerId/contacts', {
    params: { customerId: '41' }, body: { name: 'Dana', email: 'dana@example.invalid' }
  });
  assert.deepEqual(lastCall(harness, 'mutateCustomerContact').input.command, {
    action: 'create', customerId: 41, values: { name: 'Dana', email: 'dana@example.invalid' }
  });

  harness.calls.length = 0;
  await harness.invoke('POST /api/customers/:customerId/tasks/:taskId/complete', {
    params: { customerId: '41', taskId: '91' }, body: { completion_note: 'Done' }
  });
  assert.deepEqual(lastCall(harness, 'mutateCrmTask').input.command, {
    action: 'complete', customerId: 41, taskId: 91, values: { completion_note: 'Done' }
  });

  harness.calls.length = 0;
  await harness.invoke('POST /api/customers/:id/activity', {
    params: { id: '41' }, body: { action: 'followup_recorded', reference_type: 'task', reference_id: 91 }
  });
  assert.deepEqual(lastCall(harness, 'recordCustomerActivity').input.command, {
    customerId: 41,
    action: 'followup_recorded',
    reference_type: 'task',
    reference_id: 91
  });
});

test('crm http: hard deletes fail closed without SQL or mutation service calls', async () => {
  const harness = makeHarness();
  for (const [key, params] of [
    ['DELETE /api/customers/:id', { id: '41' }],
    ['DELETE /api/opportunities/:id', { id: '71' }]
  ]) {
    const response = await harness.invoke(key, { params });
    assert.equal(response.statusCode, 409);
    assert.equal(response.contentType, 'application/problem+json');
    assert.equal(response.payload.code, 'CRM_HARD_DELETE_UNAVAILABLE');
    assert.equal(response.payload.request_id, 'http-request');
  }
  assert.equal(harness.calls.length, 0);
});

test('crm http: known errors preserve status and bounded details without leaking messages', async () => {
  const unsafeMessage = 'SQLITE /private/path SELECT secret@example.invalid';
  const harness = makeHarness({
    crmCustomerService: {
      createOrUpdateCustomer() {
        const error = new Error(unsafeMessage);
        Object.assign(error, {
          name: 'CrmMutationError',
          code: 'CRM_CUSTOMER_DUPLICATE',
          status: 409,
          title: 'Customer identity conflicts with an existing record',
          details: { conflict: { visibility: 'restricted' } }
        });
        throw error;
      }
    }
  });
  const response = await harness.invoke('POST /api/customers', {
    body: { brand_name: 'Secret', stage: 'lead' }
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.contentType, 'application/problem+json');
  assert.equal(response.payload.code, 'CRM_CUSTOMER_DUPLICATE');
  assert.deepEqual(response.payload.conflict, { visibility: 'restricted' });
  assert.equal(response.payload.request_id, 'http-request');
  assert.doesNotMatch(JSON.stringify(response.payload), /SQLITE|private|secret@example/i);
});

test('crm http: invalid identifiers and conflicting read aliases fail before services', async () => {
  const harness = makeHarness();
  const invalidId = await harness.invoke('PUT /api/customers/:id', {
    params: { id: '41x' }, body: { brand_name: 'Acme' }
  });
  assert.equal(invalidId.statusCode, 400);
  assert.equal(invalidId.payload.code, 'CRM_HTTP_INVALID');

  const conflictingScope = await harness.invoke('GET /api/customers', {
    query: { scope: 'my', is_public: '1' }
  });
  assert.equal(conflictingScope.statusCode, 400);
  assert.equal(conflictingScope.payload.code, 'CRM_HTTP_INVALID');

  const unsupportedOpportunityFilter = await harness.invoke('GET /api/opportunities', {
    query: { customer_id: '41' }
  });
  assert.equal(unsupportedOpportunityFilter.statusCode, 400);
  assert.equal(unsupportedOpportunityFilter.payload.code, 'CRM_HTTP_INVALID');
  assert.equal(harness.calls.length, 0);
});

test('crm http: legacy CRM dashboard aliases share the scoped S3 dashboard adapter', async () => {
  const harness = makeHarness();
  for (const key of ['GET /api/dashboard/sales', 'GET /api/dashboard/stats']) {
    const response = await harness.invoke(key, { query: { scope: 'team' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.customers.total, 3);
    assert.equal(response.payload.opportunities.open_amount, 12500);
  }
  assert.equal(harness.calls.filter((call) => call.method === 'getCrmDashboard').length, 2);
});

test('crm http: server has no duplicate customer activity or CRM dashboard route owner', () => {
  const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  const customerRouteSource = fs.readFileSync(path.resolve(__dirname, '../routes_customers.js'), 'utf8');
  for (const [method, routePath] of [
    ['post', '/api/customers/:id/activity'],
    ['get', '/api/dashboard/sales'],
    ['get', '/api/dashboard/stats']
  ]) {
    const pattern = new RegExp(`app\\.${method}\\('${routePath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}'`, 'g');
    assert.equal((serverSource.match(pattern) || []).length, 0, `${routePath} must leave server.js`);
    assert.equal((customerRouteSource.match(pattern) || []).length, 1, `${routePath} must have one CRM owner`);
  }
});

test('crm http: legacy unscoped sales target and performance endpoints fail closed', async () => {
  const harness = makeHarness();
  for (const [key, request] of [
    ['GET /api/sales-targets', {}],
    ['POST /api/sales-targets', { body: { target_type: 'revenue', target_value: 1000 } }],
    ['GET /api/sales-performance', { query: { period_start: '2026-08-01', period_end: '2026-08-31' } }]
  ]) {
    const response = await harness.invoke(key, request);
    assert.equal(response.statusCode, 409);
    assert.equal(response.contentType, 'application/problem+json');
    assert.equal(response.payload.code, 'CRM_SALES_SCOPE_UNAVAILABLE');
  }
  assert.equal(harness.calls.length, 0);
});
