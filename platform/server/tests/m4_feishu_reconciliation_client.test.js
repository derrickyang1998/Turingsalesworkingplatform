'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', '..', 'app.js');
const indexPath = path.join(__dirname, '..', '..', 'index.html');
const appSource = fs.readFileSync(appPath, 'utf8');
const indexSource = fs.readFileSync(indexPath, 'utf8');

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

function element(initial) {
  return Object.assign({
    value: '',
    innerHTML: '',
    textContent: '',
    hidden: false,
    disabled: false,
    style: {}
  }, initial || {});
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

const functionNames = [
  'getM4CampaignId',
  'getM4CampaignById',
  'isM4FeishuReconciliationOperator',
  'pendingFeishuDeliveries',
  'selectedFeishuReconciliationDelivery',
  'normalizeFeishuReconciliationRecordIds',
  'feishuReconciliationActionKey',
  'renderFeishuReconciliationPanel',
  'selectFeishuReconciliationDelivery',
  'reconcileFeishuDelivery',
  'renderFeishuDeliveryStatus',
  'loadFeishuOutbox'
];

function createContext() {
  const elements = {
    m4CampaignContext: element({ value: '91' }),
    feishuDeliveryStatus: element(),
    feishuReconciliationPanel: element({ hidden: true }),
    feishuReconciliationDelivery: element(),
    feishuReconciliationMeta: element(),
    feishuReconciliationAccess: element(),
    feishuReconciliationForm: element(),
    feishuReconciliationRecordIds: element(),
    feishuReconciliationSubmit: element(),
    feishuReconciliationStatus: element()
  };
  const toasts = [];
  const context = {
    console,
    Set,
    encodeURIComponent,
    m4Campaigns: [{ id: 91, name: 'Autumn launch', owner: { id: 7 } }],
    m4CampaignContextId: 91,
    CURRENT_USER: { id: 7, role: 'user' },
    CURRENT_AUTH_CONTEXT: { organization: { role_code: 'member' } },
    feishuReconciliationState: { campaignId: null, deliveries: [], deliveryId: null, inFlight: null },
    feishuReconciliationInFlightByDelivery: {},
    feishuOutboxLoadGeneration: 0,
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    readPositiveInteger: positiveInteger,
    getActiveCampaignId() { return 91; },
    esc(value) { return String(value || ''); },
    toast(message, type) { toasts.push({ message, type: type || null }); },
    renderFeishuRetryPanel() {},
    async apiFetch() { throw new Error('Unexpected request'); }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const name of functionNames) vm.runInContext(extractFunction(appSource, name), context);
  return { context, elements, toasts };
}

test('M4 reconciliation UI presents pending receipts only to an owner or organization admin', () => {
  const { context, elements } = createContext();
  const deliveries = [
    { id: 700, status: 'pending', record_count: 2, updated_at: '2026-09-02 02:40:00' },
    { id: 699, status: 'succeeded', record_count: 2, updated_at: '2026-09-02 02:39:00' },
    { id: 698, status: 'pending', record_count: 1, updated_at: '2026-09-02 02:38:00' }
  ];

  context.renderFeishuReconciliationPanel(deliveries, 91);
  assert.equal(elements.feishuReconciliationPanel.hidden, false);
  assert.equal(elements.feishuReconciliationForm.hidden, false);
  assert.equal(elements.feishuReconciliationDelivery.value, '700');
  assert.match(elements.feishuReconciliationDelivery.innerHTML, /value="700"/);
  assert.match(elements.feishuReconciliationDelivery.innerHTML, /value="698"/);
  assert.doesNotMatch(elements.feishuReconciliationDelivery.innerHTML, /value="699"/);
  assert.match(elements.feishuReconciliationMeta.textContent, /2 条唯一 Record ID/);
  assert.deepEqual(
    Array.from(context.normalizeFeishuReconciliationRecordIds(' rec-one\n\nrec-two \n')),
    ['rec-one', 'rec-two']
  );

  context.CURRENT_USER = { id: 8, role: 'user' };
  context.renderFeishuReconciliationPanel(deliveries, 91);
  assert.equal(elements.feishuReconciliationForm.hidden, true);
  assert.match(elements.feishuReconciliationAccess.textContent, /Owner/);

  context.CURRENT_AUTH_CONTEXT = { organization: { role_code: 'org_admin' } };
  context.renderFeishuReconciliationPanel(deliveries, 91);
  assert.equal(elements.feishuReconciliationForm.hidden, false);
});

test('M4 reconciliation sends one validated confirmation and refreshes the delivery list', async () => {
  const { context, elements, toasts } = createContext();
  context.renderFeishuReconciliationPanel([
    { id: 700, status: 'pending', record_count: 2, updated_at: '2026-09-02 02:40:00' }
  ], 91);
  elements.feishuReconciliationRecordIds.value = 'rec-001\nrec-002';
  const requests = [];
  let release;
  let refreshes = 0;
  context.apiFetch = function(url, options) {
    requests.push({ url, options });
    return new Promise(function(resolve) { release = resolve; });
  };
  context.loadFeishuOutbox = async function() { refreshes += 1; return []; };

  const first = context.reconcileFeishuDelivery();
  const duplicate = context.reconcileFeishuDelivery();
  assert.equal(requests.length, 1);
  assert.equal(elements.feishuReconciliationSubmit.disabled, true);
  assert.equal(requests[0].url, '/campaigns/91/feishu-deliveries/700/reconcile');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    remote_record_ids: ['rec-001', 'rec-002']
  });

  release(jsonResponse(200, {
    delivery: { id: 700, campaign_id: 91, status: 'succeeded', record_count: 2 }
  }));
  const result = await first;
  await duplicate;
  assert.equal(result.status, 'succeeded');
  assert.equal(refreshes, 1);
  assert.equal(elements.feishuReconciliationRecordIds.value, '');
  assert.equal(context.feishuReconciliationState.inFlight, null);
  assert.deepEqual(toasts, [{ message: '飞书回执已确认', type: null }]);
});

test('M4 reconciliation keeps its single-flight lock when a manual refresh cannot load the receipt', async () => {
  const { context, elements } = createContext();
  context.renderFeishuReconciliationPanel([
    { id: 700, status: 'pending', record_count: 2, updated_at: '2026-09-02 02:40:00' }
  ], 91);
  elements.feishuReconciliationRecordIds.value = 'rec-001\nrec-002';
  let requestCount = 0;
  let release;
  context.apiFetch = function() {
    requestCount += 1;
    return new Promise(function(resolve) { release = resolve; });
  };
  context.loadFeishuOutbox = async function() { return []; };

  const first = context.reconcileFeishuDelivery();
  context.renderFeishuReconciliationPanel([], 91, new Error('temporary refresh failure'));
  const duplicate = context.reconcileFeishuDelivery();
  assert.strictEqual(duplicate, first);
  assert.equal(requestCount, 1);

  release(jsonResponse(200, {
    delivery: { id: 700, campaign_id: 91, status: 'succeeded', record_count: 2 }
  }));
  await first;
  assert.equal(context.feishuReconciliationState.inFlight, null);
});

test('M4 reconciliation retains a pending delivery lock across a campaign context switch', async () => {
  const { context, elements } = createContext();
  const pendingDelivery = { id: 700, status: 'pending', record_count: 2, updated_at: '2026-09-02 02:40:00' };
  context.m4Campaigns = [
    { id: 91, name: 'First campaign', owner: { id: 7 } },
    { id: 92, name: 'Second campaign', owner: { id: 7 } }
  ];
  context.renderFeishuReconciliationPanel([pendingDelivery], 91);
  elements.feishuReconciliationRecordIds.value = 'rec-001\nrec-002';
  let requestCount = 0;
  let release;
  context.apiFetch = function() {
    requestCount += 1;
    return new Promise(function(resolve) { release = resolve; });
  };
  context.loadFeishuOutbox = async function() { return []; };

  const first = context.reconcileFeishuDelivery();
  context.m4CampaignContextId = 92;
  context.renderFeishuReconciliationPanel([], 92);
  context.m4CampaignContextId = 91;
  context.renderFeishuReconciliationPanel([pendingDelivery], 91);
  const duplicate = context.reconcileFeishuDelivery();
  assert.strictEqual(duplicate, first);
  assert.equal(requestCount, 1);

  release(jsonResponse(200, {
    delivery: { id: 700, campaign_id: 91, status: 'succeeded', record_count: 2 }
  }));
  await first;
  assert.equal(context.feishuReconciliationInFlightByDelivery['91:700'], undefined);
});

test('M4 reconciliation refreshes the receipt after a concurrent finalization response', async () => {
  const { context, elements, toasts } = createContext();
  context.renderFeishuReconciliationPanel([
    { id: 700, status: 'pending', record_count: 2, updated_at: '2026-09-02 02:40:00' }
  ], 91);
  elements.feishuReconciliationRecordIds.value = 'rec-001\nrec-002';
  let refreshes = 0;
  context.apiFetch = async function() {
    return jsonResponse(409, {
      error: 'Feishu delivery is already finalized.',
      code: 'FEISHU_OUTBOX_RECONCILIATION_NOT_REQUIRED'
    });
  };
  context.loadFeishuOutbox = async function() {
    refreshes += 1;
    context.renderFeishuReconciliationPanel([
      { id: 700, status: 'succeeded', record_count: 2, updated_at: '2026-09-02 02:44:00' }
    ], 91);
    return [];
  };

  assert.equal(await context.reconcileFeishuDelivery(), null);
  assert.equal(refreshes, 1);
  assert.equal(context.feishuReconciliationState.deliveryId, null);
  assert.deepEqual(toasts, [{ message: '回执状态已更新，请按最新结果处理', type: null }]);
});

test('M4 reconciliation blocks malformed receipts and unauthorized operators before a network write', async () => {
  const { context, elements, toasts } = createContext();
  context.renderFeishuReconciliationPanel([
    { id: 700, status: 'pending', record_count: 2, updated_at: '2026-09-02 02:40:00' }
  ], 91);
  let requestCount = 0;
  context.apiFetch = async function() { requestCount += 1; return jsonResponse(200, {}); };

  elements.feishuReconciliationRecordIds.value = 'rec-duplicate\nrec-duplicate';
  assert.equal(await context.reconcileFeishuDelivery(), null);
  assert.equal(requestCount, 0);
  assert.match(elements.feishuReconciliationStatus.textContent, /不重复/);

  elements.feishuReconciliationRecordIds.value = 'rec-001\nrec-002';
  context.CURRENT_USER = { id: 8, role: 'user' };
  assert.equal(await context.reconcileFeishuDelivery(), null);
  assert.equal(requestCount, 0);
  assert.match(elements.feishuReconciliationStatus.textContent, /无权/);
  assert.deepEqual(toasts, [{ message: '当前账号无权确认该回执', type: 'error' }]);
});

test('M4 reconciliation ignores an older delivery response after the campaign context changes', async () => {
  const { context, elements } = createContext();
  const pending = [];
  context.m4Campaigns = [
    { id: 91, name: 'First campaign', owner: { id: 7 } },
    { id: 92, name: 'Second campaign', owner: { id: 7 } }
  ];
  context.apiFetch = function(url) {
    return new Promise(function(resolve) { pending.push({ url, resolve }); });
  };

  const first = context.loadFeishuOutbox();
  context.m4CampaignContextId = 92;
  const second = context.loadFeishuOutbox();
  assert.deepEqual(pending.map(function(request) { return request.url; }), [
    '/campaigns/91/feishu-deliveries?limit=20',
    '/campaigns/92/feishu-deliveries?limit=20'
  ]);

  pending[1].resolve(jsonResponse(200, {
    deliveries: [{ id: 920, status: 'pending', record_count: 1, updated_at: '2026-09-02 02:42:00' }]
  }));
  await second;
  pending[0].resolve(jsonResponse(200, {
    deliveries: [{ id: 910, status: 'pending', record_count: 1, updated_at: '2026-09-02 02:41:00' }]
  }));
  assert.equal((await first).length, 0);
  assert.equal(context.feishuReconciliationState.campaignId, 92);
  assert.equal(context.feishuReconciliationState.deliveryId, 920);
  assert.match(elements.feishuReconciliationMeta.textContent, /#920/);
});

test('M4 reconciliation markup binds the pending selector and confirmation control', () => {
  for (const id of [
    'feishuReconciliationPanel',
    'feishuReconciliationDelivery',
    'feishuReconciliationRecordIds',
    'feishuReconciliationSubmit',
    'feishuReconciliationStatus'
  ]) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.match(indexSource, /onchange="selectFeishuReconciliationDelivery\(\)"/);
  assert.match(indexSource, /onclick="reconcileFeishuDelivery\(\)"/);
});
