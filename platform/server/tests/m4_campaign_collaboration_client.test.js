'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', '..', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');

function extractFunction(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const match = declaration.exec(source);
  assert.ok(match, `${name} must exist`);
  const openingBrace = source.indexOf('{', match.index);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  assert.fail(`${name} must have a balanced function body`);
}

function loadFunctions(context, names) {
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext([
    'var m4Campaigns = [];',
    'var m4CampaignContextId = null;',
    'var lastCollabRows = [];',
    'var pendingCollabInfId = 700;',
    'var pendingCollabCreateIntentId = null;',
    'var m4CollabMutationOperations = {};',
    'var m4CollabMutationInFlight = {};'
  ].join('\n'), context);
  for (const name of names) vm.runInContext(extractFunction(appSource, name), context);
  return context;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function element(initial) {
  return Object.assign({ value: '', innerHTML: '', textContent: '' }, initial || {});
}

function createClientContext() {
  let operation = 0;
  let nextCollaborationId = 501;
  const requests = [];
  const completedByKey = new Map();
  const rows = [];
  const elements = {
    m4CampaignContext: element(),
    m4CampaignContextStatus: element(),
    collabFilter: element(),
    collabStatsBar: element(),
    execTableContainer: element(),
    orderProject: element({ value: 'Campaign project' }),
    orderProduct: element({ value: 'Campaign product' }),
    orderType: element({ value: 'paid' }),
    orderReference: element({ value: 'PO-501' }),
    orderDeliverable: element({ value: 'One short video' }),
    orderQuotedPrice: element({ value: '1200' }),
    orderTimelineStart: element({ value: '2026-09-01' }),
    orderTimelineEnd: element({ value: '2026-09-10' }),
    orderNotes: element({ value: 'Client approved' })
  };
  const campaign = {
    id: 91,
    name: 'Autumn launch',
    product_name: 'Portable power station',
    lifecycle_state: 'demand_confirmed',
    operational_status: 'active'
  };

  function cloneRows() {
    return rows.map(function(row) {
      return Object.assign({}, row, { active_relations: row.active_relations.slice() });
    });
  }

  function applyUpdate(url, options) {
    const body = JSON.parse(options.body);
    const idempotencyKey = options.headers['Idempotency-Key'];
    const replayKey = url + ':' + idempotencyKey;
    if (completedByKey.has(replayKey)) return jsonResponse(200, completedByKey.get(replayKey));
    const collaboration = rows.find(function(row) { return row.id === Number(url.split('/').pop()); });
    if (!collaboration || collaboration.row_version !== body.expected_version) {
      return jsonResponse(409, { error: 'STALE_COLLABORATION_VERSION' });
    }
    collaboration.status = body.status;
    if (body.campaign_relation && !collaboration.active_relations.includes(body.campaign_relation)) {
      collaboration.active_relations.push(body.campaign_relation);
    }
    if (Object.hasOwn(body, 'cost_actual')) collaboration.cost_actual = body.cost_actual;
    collaboration.row_version += 1;
    const response = {
      success: true,
      campaign_id: collaboration.campaign_id,
      row_version: collaboration.row_version,
      active_relations: collaboration.active_relations.slice()
    };
    completedByKey.set(replayKey, response);
    return jsonResponse(200, response);
  }

  function createCollaboration(options) {
    const body = JSON.parse(options.body);
    const idempotencyKey = options.headers && options.headers['Idempotency-Key'];
    const replayKey = idempotencyKey ? '/collaborations:' + idempotencyKey : null;
    if (replayKey && completedByKey.has(replayKey)) return jsonResponse(201, completedByKey.get(replayKey));
    const resource = body.resource;
    const row = {
      id: nextCollaborationId++,
      influencer_id: body.influencer_id,
      campaign_id: body.campaign_id,
      campaign_name: campaign.name,
      campaign_lifecycle_state: campaign.lifecycle_state,
      campaign_operational_status: campaign.operational_status,
      status: body.status,
      row_version: 1,
      active_relations: ['order'],
      proposal_notes: JSON.stringify(resource),
      project_name: resource.project_name,
      product_name: resource.product_name,
      timeline_start: body.timeline_start,
      timeline_end: body.timeline_end,
      notes: body.notes,
      cost_quoted: body.cost_quoted
    };
    rows.push(row);
    const response = {
      id: row.id,
      campaign_id: row.campaign_id,
      row_version: row.row_version,
      active_relations: row.active_relations.slice()
    };
    if (replayKey) completedByKey.set(replayKey, response);
    return jsonResponse(201, response);
  }

  const context = {
    m4Campaigns: [],
    m4CampaignContextId: null,
    lastCollabRows: [],
    pendingCollabInfId: 700,
    m4CollabMutationOperations: {},
    m4CollabMutationInFlight: {},
    pendingCreateRelease: null,
    pauseNextCreate: false,
    pendingCreateFailureRelease: null,
    pauseNextCreateFailure: false,
    failNextCreateAfterPersist: false,
    pendingPauseRelease: null,
    pauseNextUpdate: false,
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    getActiveCampaignId() { return 91; },
    getActiveDemandId() { return 17; },
    readPositiveInteger: positiveInteger,
    esc(value) { return String(value || ''); },
    createDemandAnalysisOperationId(prefix) {
      operation += 1;
      return prefix + operation;
    },
    toast() {},
    switchTab() {},
    closeCollabOrderModal() {},
    renderCollabTable() {},
    async apiFetch(url, options) {
      options = options || {};
      requests.push({ url, options });
      if (url === '/campaigns?limit=100&operational_status=active') {
        return jsonResponse(200, { items: [campaign] });
      }
      if (url.indexOf('/collaborations?') === 0) {
        return jsonResponse(200, { collaborations: cloneRows() });
      }
      if (url === '/collaborations' && options.method === 'POST') {
        if (context.pauseNextCreate) {
          context.pauseNextCreate = false;
          return new Promise(function(resolve) {
            context.pendingCreateRelease = function() { resolve(createCollaboration(options)); };
          });
        }
        if (context.pauseNextCreateFailure) {
          context.pauseNextCreateFailure = false;
          return new Promise(function(_resolve, reject) {
            context.pendingCreateFailureRelease = function() {
              createCollaboration(options);
              reject(new Error('lost create response'));
            };
          });
        }
        if (context.failNextCreateAfterPersist) {
          context.failNextCreateAfterPersist = false;
          createCollaboration(options);
          return Promise.reject(new Error('lost create response'));
        }
        return createCollaboration(options);
      }
      if (url.indexOf('/collaborations/') === 0 && options.method === 'PUT') {
        if (context.pauseNextUpdate) {
          context.pauseNextUpdate = false;
          return new Promise(function(resolve) {
            context.pendingPauseRelease = function() { resolve(applyUpdate(url, options)); };
          });
        }
        return applyUpdate(url, options);
      }
      throw new Error('Unexpected client request: ' + url);
    }
  };

  return { context, elements, requests, rows };
}

const m4Functions = [
  'getM4CampaignId',
  'getM4CampaignById',
  'm4CampaignLabel',
  'renderM4CampaignContext',
  'loadM4Campaigns',
  'm4ActiveDemandId',
  'm4OperationId',
  'm4MutationHeaders',
  'm4CollabMutationSlot',
  'm4CollabCreateMutationSlot',
  'm4CollabMutationOperationKey',
  'submitCollabOrder',
  'loadCollaborations',
  'findCollaborationById',
  'collabRelations',
  'isCampaignCollaboration',
  'submitCampaignCollabUpdate',
  'runCampaignCollabAction'
];

test('M4 campaign order holds duplicate clicks to one in-flight creation', async () => {
  const { context, requests, rows } = createClientContext();
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();

  context.pauseNextCreate = true;
  const firstCreation = context.submitCollabOrder();
  const duplicateCreation = context.submitCollabOrder();
  await Promise.resolve();
  assert.equal(typeof context.pendingCreateRelease, 'function');
  context.pendingCreateRelease();
  await Promise.all([firstCreation, duplicateCreation]);

  const createRequests = requests.filter(function(request) {
    return request.url === '/collaborations' && request.options.method === 'POST';
  });
  assert.equal(createRequests.length, 1);
  assert.equal(rows.length, 1);
});

test('M4 campaign order ignores a stale completion after a newer dialog intent begins', async () => {
  const { context, requests, rows } = createClientContext();
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();

  let closeCalls = 0;
  let switchCalls = 0;
  let refreshCalls = 0;
  context.closeCollabOrderModal = function() {
    closeCalls += 1;
    context.pendingCollabInfId = null;
    context.pendingCollabCreateIntentId = null;
  };
  context.switchTab = function() { switchCalls += 1; };
  context.loadCollaborations = function() { refreshCalls += 1; };
  context.pauseNextCreate = true;
  const firstCreation = context.submitCollabOrder();
  await Promise.resolve();
  assert.equal(typeof context.pendingCreateRelease, 'function');

  const nextIntentId = 'm4-collaboration-create-intent-next-dialog';
  context.pendingCollabCreateIntentId = nextIntentId;
  context.pendingCollabInfId = 701;
  context.pendingCreateRelease();
  await firstCreation;

  assert.equal(closeCalls, 0);
  assert.equal(switchCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(context.pendingCollabCreateIntentId, nextIntentId);
  assert.equal(context.pendingCollabInfId, 701);

  await context.submitCollabOrder();
  const createRequests = requests.filter(function(request) {
    return request.url === '/collaborations' && request.options.method === 'POST';
  });
  assert.equal(createRequests.length, 2);
  assert.notEqual(createRequests[0].options.headers['Idempotency-Key'], createRequests[1].options.headers['Idempotency-Key']);
  assert.equal(rows.length, 2);
});

test('M4 campaign order ignores a stale failed request after a newer dialog intent begins', async () => {
  const { context, rows } = createClientContext();
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();

  const toasts = [];
  context.toast = function(message, type) { toasts.push({ message, type }); };
  context.pauseNextCreateFailure = true;
  const firstCreation = context.submitCollabOrder();
  await Promise.resolve();
  assert.equal(typeof context.pendingCreateFailureRelease, 'function');

  const nextIntentId = 'm4-collaboration-create-intent-next-dialog-after-failure';
  context.pendingCollabCreateIntentId = nextIntentId;
  context.pendingCollabInfId = 701;
  context.pendingCreateFailureRelease();
  await firstCreation;

  assert.deepEqual(toasts, []);
  assert.equal(context.pendingCollabCreateIntentId, nextIntentId);
  assert.equal(context.pendingCollabInfId, 701);
  assert.equal(rows.length, 1);
});

test('M4 campaign order retries a lost response with the same idempotency key', async () => {
  const { context, requests, rows } = createClientContext();
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();

  context.failNextCreateAfterPersist = true;
  await context.submitCollabOrder();
  await context.submitCollabOrder();

  const createRequests = requests.filter(function(request) {
    return request.url === '/collaborations' && request.options.method === 'POST';
  });
  assert.equal(createRequests.length, 2);
  assert.equal(createRequests[0].options.headers['Idempotency-Key'], createRequests[1].options.headers['Idempotency-Key']);
  assert.notEqual(createRequests[0].options.headers['X-Request-Id'], createRequests[1].options.headers['X-Request-Id']);
  assert.equal(rows.length, 1);
});

test('M4 campaign workspace executes selector, linked order, lifecycle, and replay-safe action flow', async () => {
  const { context, elements, requests, rows } = createClientContext();
  loadFunctions(context, m4Functions);

  const campaigns = await context.loadM4Campaigns();
  assert.equal(campaigns.length, 1);
  assert.match(elements.m4CampaignContext.innerHTML, /Autumn launch/);
  assert.equal(context.getM4CampaignId(), 91);
  assert.match(elements.m4CampaignContextStatus.textContent, /订单、执行、发布和结算/);

  await context.loadCollaborations();
  assert.equal(requests.at(-1).url, '/collaborations?include_campaign_context=1&campaign_id=91');

  await context.submitCollabOrder();
  const createRequest = requests.find(function(request) {
    return request.url === '/collaborations' && request.options.method === 'POST';
  });
  const createBody = JSON.parse(createRequest.options.body);
  assert.equal(createBody.campaign_id, 91);
  assert.equal(createBody.demand_id, 17);
  assert.equal(createBody.status, 'confirmed');
  assert.deepEqual(createBody.resource, {
    schema: 'turingmarket.collaboration-order.v1',
    project_name: 'Campaign project',
    product_name: 'Campaign product',
    order_type: 'paid',
    order_reference: 'PO-501',
    deliverable: 'One short video',
    quoted_price: 1200
  });
  assert.match(createRequest.options.headers['Idempotency-Key'], /^m4-collaboration-create-/);
  assert.equal(rows.length, 1);

  await context.loadCollaborations();
  context.findCollaborationById = function(collaborationId) {
    return rows.find(function(row) { return row.id === Number(collaborationId); }) || null;
  };
  const created = Object.assign({}, rows[0], { active_relations: rows[0].active_relations.slice() });
  assert.ok(created);
  const executionPatch = {
    status: 'live',
    campaign_relation: 'execution',
    reason: '从下单工作台确认开始执行'
  };
  const executed = await context.submitCampaignCollabUpdate(created, executionPatch, 'execution');
  const replay = await context.submitCampaignCollabUpdate(created, executionPatch, 'execution');
  assert.deepEqual(replay, executed);
  const executionRequests = requests.filter(function(request) {
    return request.url === '/collaborations/' + created.id && request.options.method === 'PUT';
  });
  assert.equal(executionRequests.length, 2);
  assert.equal(executionRequests[0].options.headers['Idempotency-Key'], executionRequests[1].options.headers['Idempotency-Key']);
  assert.notEqual(executionRequests[0].options.headers['X-Request-Id'], executionRequests[1].options.headers['X-Request-Id']);
  assert.equal(rows[0].row_version, 2);

  await context.loadCollaborations();
  await context.runCampaignCollabAction(created.id, 'review');
  assert.equal(rows[0].status, 'content_review');
  await context.runCampaignCollabAction(created.id, 'publication');
  assert.equal(rows[0].status, 'completed');
  assert.deepEqual(rows[0].active_relations, ['order', 'execution', 'publication']);

  await context.loadCollaborations();
  const settlement = Object.assign({}, rows[0], { active_relations: rows[0].active_relations.slice() });
  const settlementPatch = {
    status: 'completed',
    campaign_relation: 'settlement',
    cost_actual: 1200,
    confirm_cost_actual: true,
    reason: '从下单工作台确认结算成本'
  };
  context.pauseNextUpdate = true;
  const firstSettlement = context.submitCampaignCollabUpdate(settlement, settlementPatch, 'settlement');
  const duplicateSettlement = context.submitCampaignCollabUpdate(settlement, settlementPatch, 'settlement');
  await Promise.resolve();
  assert.equal(typeof context.pendingPauseRelease, 'function');
  context.pendingPauseRelease();
  const [firstResult, duplicateResult] = await Promise.all([firstSettlement, duplicateSettlement]);
  assert.deepEqual(duplicateResult, firstResult);
  const settlementRequests = requests.filter(function(request) {
    return request.url === '/collaborations/' + settlement.id && request.options.method === 'PUT' &&
      JSON.parse(request.options.body).campaign_relation === 'settlement';
  });
  assert.equal(settlementRequests.length, 1);
  assert.deepEqual(rows[0].active_relations, ['order', 'execution', 'publication', 'settlement']);
});
