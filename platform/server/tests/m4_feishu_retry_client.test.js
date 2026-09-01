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
  'retryableFeishuDeliveries',
  'selectedFeishuRetryDelivery',
  'feishuRetryActionKey',
  'renderFeishuRetryPanel',
  'selectFeishuRetryDelivery',
  'createFeishuBitableOperationId',
  'retryFeishuDelivery'
];

function createContext() {
  const elements = {
    m4CampaignContext: element({ value: '91' }),
    feishuRetryPanel: element({ hidden: true }),
    feishuRetryDelivery: element(),
    feishuRetryMeta: element(),
    feishuRetryAccess: element(),
    feishuRetryForm: element(),
    feishuRetryReason: element(),
    feishuRetrySubmit: element(),
    feishuRetryStatus: element()
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
    feishuRetryState: { campaignId: null, deliveries: [], deliveryId: null, inFlight: null },
    feishuRetryInFlightByDelivery: {},
    feishuRetryOperationIds: {},
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    crypto: { randomUUID() { return 'f2ef4f74-80bc-41ed-82ca-5c4915cd347c'; } },
    readPositiveInteger: positiveInteger,
    esc(value) { return String(value || ''); },
    toast(message, type) { toasts.push({ message, type: type || null }); },
    async apiFetch() { throw new Error('Unexpected request'); },
    async loadFeishuOutbox() { return []; }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const name of functionNames) vm.runInContext(extractFunction(appSource, name), context);
  return { context, elements, toasts };
}

test('M4 retry UI lists only explicit safe failed deliveries and keeps the action owner-gated', () => {
  const { context, elements } = createContext();
  const deliveries = [
    { id: 801, status: 'failed', record_count: 2, last_error_code: 'FEISHU_BITABLE_SCHEMA_MISMATCH', retry_available: true, updated_at: '2026-09-02 03:00:00' },
    { id: 800, status: 'pending', record_count: 2, updated_at: '2026-09-02 02:59:00' },
    { id: 799, status: 'failed', record_count: 2, last_error_code: 'FEISHU_PROVIDER_REJECTED', retry_available: false, updated_at: '2026-09-02 02:58:00' }
  ];

  context.renderFeishuRetryPanel(deliveries, 91);
  assert.equal(elements.feishuRetryPanel.hidden, false);
  assert.equal(elements.feishuRetryForm.hidden, false);
  assert.equal(elements.feishuRetryDelivery.value, '801');
  assert.match(elements.feishuRetryDelivery.innerHTML, /value="801"/);
  assert.doesNotMatch(elements.feishuRetryDelivery.innerHTML, /value="800"/);
  assert.doesNotMatch(elements.feishuRetryDelivery.innerHTML, /value="799"/);

  context.CURRENT_USER = { id: 8, role: 'user' };
  context.renderFeishuRetryPanel(deliveries, 91);
  assert.equal(elements.feishuRetryForm.hidden, true);
});

test('M4 retry requires a reason and sends one request with a stable idempotency key', async () => {
  const { context, elements, toasts } = createContext();
  const delivery = {
    id: 801,
    status: 'failed',
    record_count: 2,
    last_error_code: 'FEISHU_BITABLE_SCHEMA_MISMATCH',
    retry_available: true,
    updated_at: '2026-09-02 03:00:00'
  };
  context.renderFeishuRetryPanel([delivery], 91);
  let requestCount = 0;
  context.apiFetch = async function() { requestCount += 1; return jsonResponse(200, {}); };
  assert.equal(await context.retryFeishuDelivery(), null);
  assert.equal(requestCount, 0);
  assert.match(elements.feishuRetryStatus.textContent, /reason/i);

  elements.feishuRetryReason.value = 'Schema mapping was corrected.';
  let release;
  const requests = [];
  let refreshes = 0;
  context.apiFetch = function(url, options) {
    requests.push({ url, options });
    return new Promise(function(resolve) { release = resolve; });
  };
  context.loadFeishuOutbox = async function() { refreshes += 1; return []; };

  const first = context.retryFeishuDelivery();
  context.m4CampaignContextId = 92;
  context.m4Campaigns.push({ id: 92, name: 'Other campaign', owner: { id: 7 } });
  context.m4CampaignContextId = 91;
  const duplicate = context.retryFeishuDelivery();
  assert.strictEqual(duplicate, first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/campaigns/91/feishu-deliveries/801/retry');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { reason: 'Schema mapping was corrected.' });
  assert.equal(requests[0].options.headers['Idempotency-Key'], 'f2ef4f74-80bc-41ed-82ca-5c4915cd347c');

  release(jsonResponse(200, {
    configured: true,
    delivery: { id: 802, campaign_id: 91, status: 'succeeded', retry_of_delivery_id: 801 }
  }));
  const result = await first;
  await duplicate;
  assert.equal(result.status, 'succeeded');
  assert.equal(refreshes, 1);
  assert.equal(elements.feishuRetryReason.value, '');
  assert.deepEqual(toasts, [{ message: 'Feishu retry completed', type: null }]);
});

test('M4 retry refreshes receipts after a retry conflict without a second network write', async () => {
  const { context, elements, toasts } = createContext();
  context.renderFeishuRetryPanel([{
    id: 801,
    status: 'failed',
    record_count: 2,
    last_error_code: 'FEISHU_BITABLE_SCHEMA_MISMATCH',
    retry_available: true,
    updated_at: '2026-09-02 03:00:00'
  }], 91);
  elements.feishuRetryReason.value = 'Schema mapping was corrected.';
  let refreshes = 0;
  context.apiFetch = async function() {
    return jsonResponse(409, { error: 'A retry delivery already exists for this failed receipt.' });
  };
  context.loadFeishuOutbox = async function() { refreshes += 1; return []; };

  assert.equal(await context.retryFeishuDelivery(), null);
  assert.equal(refreshes, 1);
  assert.deepEqual(toasts, [{ message: 'Feishu retry state was refreshed', type: null }]);
});

test('M4 retry refreshes receipts when the provider result requires reconciliation', async () => {
  const { context, elements, toasts } = createContext();
  context.renderFeishuRetryPanel([{
    id: 801,
    status: 'failed',
    record_count: 2,
    last_error_code: 'FEISHU_BITABLE_SCHEMA_MISMATCH',
    retry_available: true,
    updated_at: '2026-09-02 03:00:00'
  }], 91);
  elements.feishuRetryReason.value = 'The provider receipt needs manual reconciliation.';
  let refreshes = 0;
  context.apiFetch = async function() {
    return jsonResponse(202, {
      code: 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED',
      delivery: { id: 802, campaign_id: 91, status: 'pending', retry_of_delivery_id: 801 }
    });
  };
  context.loadFeishuOutbox = async function() { refreshes += 1; return []; };

  const result = await context.retryFeishuDelivery();
  assert.equal(result.status, 'pending');
  assert.equal(refreshes, 1);
  assert.match(elements.feishuRetryStatus.textContent, /等待飞书回执核对/);
  assert.deepEqual(toasts, [{ message: '飞书重试已提交，等待回执核对', type: null }]);
});

test('M4 retry refreshes receipts when a configured-false response creates a failed child delivery', async () => {
  const { context, elements, toasts } = createContext();
  context.renderFeishuRetryPanel([{
    id: 801,
    status: 'failed',
    record_count: 2,
    last_error_code: 'FEISHU_BITABLE_SCHEMA_MISMATCH',
    retry_available: true,
    updated_at: '2026-09-02 03:00:00'
  }], 91);
  elements.feishuRetryReason.value = 'The Bitable connection must be enabled before retrying.';
  let refreshes = 0;
  context.apiFetch = async function() {
    return jsonResponse(200, {
      configured: false,
      delivery: { id: 802, campaign_id: 91, status: 'failed', retry_of_delivery_id: 801 }
    });
  };
  context.loadFeishuOutbox = async function() { refreshes += 1; return []; };

  const result = await context.retryFeishuDelivery();
  assert.equal(result.status, 'failed');
  assert.equal(refreshes, 1);
  assert.match(elements.feishuRetryStatus.textContent, /失败回执已更新/);
  assert.deepEqual(toasts, [{ message: '飞书重试未写入，失败回执已更新', type: 'error' }]);
});

test('M4 retry markup binds the retry selector, reason, and submit control', () => {
  for (const id of [
    'feishuRetryPanel',
    'feishuRetryDelivery',
    'feishuRetryReason',
    'feishuRetrySubmit',
    'feishuRetryStatus'
  ]) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.match(indexSource, /onchange="selectFeishuRetryDelivery\(\)"/);
  assert.match(indexSource, /onclick="retryFeishuDelivery\(\)"/);
});
