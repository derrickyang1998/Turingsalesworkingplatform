'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const realCrmQueryService = require('../services/crm_query_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const FIXED_AT = '2026-08-10 00:00:00';
const REGISTERED_MIGRATIONS = Object.freeze([
  ['002_campaign_business_spine', 'campaign_business_spine'],
  ['003_campaign_workflow_dispatch_evidence', 'campaign_workflow_dispatch_evidence'],
  ['004_knowledge_capacity_observability', 'knowledge_capacity_observability'],
  ['005_knowledge_custody_projection', 'knowledge_custody_projection'],
  ['006_crm_sales_workspace', 'crm_sales_workspace']
].map(([name, fileName], index) => Object.freeze({
  version: index + 2,
  name,
  sourcePath: `migrations/00${index + 2}_${fileName}.js`,
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})));

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

function canonicalCustomerDetail() {
  return {
    customer: { id: 41, brand_name: 'Acme', stage: 'lead', custody: 'owned' },
    opportunities: [{ id: 71, customer_id: 41, name: 'Launch' }],
    activity: [{ id: 81, customer_id: 41, action: 'follow_up' }],
    meta: {
      request_id: 'http-request',
      scope: 'team',
      opportunities: { limit: 100, has_more: false }
    }
  };
}

function canonicalOpportunityDetail() {
  return {
    opportunity: {
      id: 71,
      customer_id: 41,
      name: 'Launch',
      expected_close_date: '2099-02-01 00:00:00',
      decision_chain: 'CMO > Procurement',
      notes: 'Preserve detail fields'
    },
    meta: { request_id: 'http-request', scope: 'team' }
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
    },
    getCustomerDetail(_db, input) {
      calls.push({ method: 'getCustomerDetail', input });
      return canonicalCustomerDetail();
    },
    getOpportunityDetail(_db, input) {
      calls.push({ method: 'getOpportunityDetail', input });
      return canonicalOpportunityDetail();
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

  const db = settings.db || new Proxy({}, {
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

function openDetailHttpFixture(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => {
    if (db.open) db.close();
  });
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: REGISTERED_MIGRATIONS
  }), { status: 'managed', currentVersion: 6 });

  for (const [id, code] of [[501, 'detail-http-a'], [502, 'detail-http-b']]) {
    db.prepare('INSERT INTO organizations (id,code,name,created_at) VALUES (?,?,?,?)')
      .run(id, code, code, FIXED_AT);
  }
  for (const [id, orgId, code] of [
    [601, 501, 'detail-http-a1'],
    [602, 501, 'detail-http-a2'],
    [701, 502, 'detail-http-b1']
  ]) {
    db.prepare('INSERT INTO teams (id,org_id,code,name,created_at) VALUES (?,?,?,?,?)')
      .run(id, orgId, code, code, FIXED_AT);
  }

  for (const [id, username] of [
    [101, 'detail-owner'],
    [102, 'detail-teammate'],
    [103, 'detail-other-team'],
    [104, 'detail-org-admin'],
    [105, 'detail-revoked'],
    [201, 'detail-outsider']
  ]) {
    db.prepare(`
      INSERT INTO users (
        id,username,password_hash,display_name,role,email,department,
        api_quota,created_at,is_active
      ) VALUES (?,?,?,?,?,?,?,?,?,1)
    `).run(
      id,
      username,
      'not-used-by-tests',
      username,
      'user',
      `${username}@example.invalid`,
      'sales',
      50000,
      FIXED_AT
    );
  }

  for (const [orgId, userId, roleCode, status] of [
    [501, 101, 'member', 'active'],
    [501, 102, 'member', 'active'],
    [501, 103, 'member', 'active'],
    [501, 104, 'org_admin', 'active'],
    [501, 105, 'member', 'revoked'],
    [502, 201, 'member', 'active']
  ]) {
    db.prepare(`
      INSERT INTO organization_memberships (
        org_id,user_id,role_code,status,created_at,revoked_at
      ) VALUES (?,?,?,?,?,?)
    `).run(orgId, userId, roleCode, status, FIXED_AT, status === 'active' ? null : FIXED_AT);
  }
  for (const [orgId, teamId, userId, status] of [
    [501, 601, 101, 'active'],
    [501, 601, 102, 'active'],
    [501, 602, 103, 'active'],
    [501, 601, 104, 'active'],
    [501, 601, 105, 'revoked'],
    [502, 701, 201, 'active']
  ]) {
    db.prepare(`
      INSERT INTO team_memberships (
        org_id,team_id,user_id,role_code,status,created_at,revoked_at
      ) VALUES (?,?,?,?,?,?,?)
    `).run(orgId, teamId, userId, 'member', status, FIXED_AT, status === 'active' ? null : FIXED_AT);
  }

  for (const fixture of [
    [41, 'Owned A', 501, 601, 101, 101, 0],
    [42, 'Public A', 501, null, 101, null, 1],
    [43, 'Quarantine A', 501, null, 101, 101, 0],
    [44, 'Other Team A', 501, 602, 103, 103, 0],
    [45, 'Owned B', 502, 701, 201, 201, 0]
  ]) {
    const [id, brandName, orgId, teamId, createdBy, assignedTo, isPublic] = fixture;
    db.prepare(`
      INSERT INTO customers (
        id,brand_name,company_name,stage,source,created_by,assigned_to,
        created_at,updated_at,is_public,priority,org_id,team_id,duplicate_enforced
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    `).run(
      id,
      brandName,
      `${brandName} Company`,
      'lead',
      'fixture',
      createdBy,
      assignedTo,
      FIXED_AT,
      FIXED_AT,
      isPublic,
      'medium',
      orgId,
      teamId
    );
  }
  return db;
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

test('crm http: customer detail uses the scoped query service without direct SQL', async () => {
  const harness = makeHarness();
  const response = await harness.invoke('GET /api/customers/:id/detail', {
    params: { id: '41' }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, canonicalCustomerDetail());
  assert.deepEqual(lastCall(harness, 'getCustomerDetail').input, {
    actorUserId: 101,
    organizationId: 501,
    requestId: 'http-request',
    customerId: 41
  });
});

test('crm http: customer detail serializes concealed records as bounded problem details', async () => {
  const harness = makeHarness({
    crmQueryService: {
      getCustomerDetail() {
        const error = new Error('customer=other-org sql=select secret');
        error.code = 'CRM_CUSTOMER_NOT_FOUND';
        error.status = 404;
        throw error;
      }
    }
  });
  const response = await harness.invoke('GET /api/customers/:id/detail', {
    params: { id: '41' }
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.contentType, 'application/problem+json');
  assert.equal(response.payload.code, 'CRM_CUSTOMER_NOT_FOUND');
  assert.equal(response.payload.title, 'CRM customer was not found');
  assert.equal(JSON.stringify(response.payload).includes('other-org'), false);
  assert.equal(JSON.stringify(response.payload).includes('select secret'), false);
});

test('crm http: opportunity detail uses one scoped target lookup', async () => {
  const harness = makeHarness();
  const response = await harness.invoke('GET /api/opportunities/:id/detail', {
    params: { id: '71' }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, canonicalOpportunityDetail());
  assert.deepEqual(lastCall(harness, 'getOpportunityDetail').input, {
    actorUserId: 101,
    organizationId: 501,
    requestId: 'http-request',
    opportunityId: 71
  });
});

test('crm http: real scoped detail integration conceals inaccessible records and revoked actors', async (t) => {
  const db = openDetailHttpFixture(t);
  const harness = makeHarness({
    db,
    crmQueryService: {
      getCustomerDetail: realCrmQueryService.getCustomerDetail
    }
  });

  const teammate = await harness.invoke('GET /api/customers/:id/detail', {
    user: { id: 102, role: 'user' },
    params: { id: '41' },
    requestId: 'detail-http-read'
  });
  assert.equal(teammate.statusCode, 200);
  assert.equal(teammate.payload.customer.id, 41);
  assert.equal(teammate.payload.meta.scope, 'team');

  const orgAdmin = await harness.invoke('GET /api/customers/:id/detail', {
    user: { id: 104, role: 'user' },
    authContext: {
      organization: { id: 501, code: 'detail-http-a', role_code: 'org_admin' },
      teams: [{ id: 601, role_code: 'member' }]
    },
    params: { id: '43' },
    requestId: 'detail-http-admin'
  });
  assert.equal(orgAdmin.statusCode, 200);
  assert.equal(orgAdmin.payload.customer.id, 43);
  assert.equal(orgAdmin.payload.customer.custody, 'quarantined');
  assert.equal(orgAdmin.payload.meta.scope, 'organization');

  const concealed = [];
  for (const customerId of [42, 43, 44, 45, 999]) {
    concealed.push(await harness.invoke('GET /api/customers/:id/detail', {
      user: { id: 101, role: 'user' },
      params: { id: String(customerId) },
      requestId: 'detail-http-conceal'
    }));
  }
  for (const response of concealed) {
    assert.equal(response.statusCode, 404);
    assert.equal(response.contentType, 'application/problem+json');
    assert.equal(response.payload.code, 'CRM_CUSTOMER_NOT_FOUND');
    assert.deepEqual(response.payload, concealed[0].payload);
    assert.doesNotMatch(JSON.stringify(response.payload), /Public A|Quarantine A|Other Team A|Owned B|customer_id/i);
  }

  const revokedExisting = await harness.invoke('GET /api/customers/:id/detail', {
    user: { id: 105, role: 'user' },
    params: { id: '41' },
    requestId: 'detail-http-revoked'
  });
  const revokedMissing = await harness.invoke('GET /api/customers/:id/detail', {
    user: { id: 105, role: 'user' },
    params: { id: '999' },
    requestId: 'detail-http-revoked'
  });
  assert.equal(revokedExisting.statusCode, 404);
  assert.equal(revokedExisting.contentType, 'application/problem+json');
  assert.deepEqual(revokedExisting.payload, revokedMissing.payload);
  assert.doesNotMatch(JSON.stringify(revokedExisting.payload), /Owned A|customer_id/i);
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
