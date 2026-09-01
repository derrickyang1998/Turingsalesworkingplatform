const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');

function extractFunction(source, name) {
  const declaration = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'g');
  const match = declaration.exec(source);
  assert.ok(match, name + ' must exist');
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
  assert.fail(name + ' must have a balanced function body');
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function loadFeishuFunctions(context) {
  context.window = context;
  context.globalThis = context;
  context.readPositiveInteger = context.readPositiveInteger || function(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  };
  vm.createContext(context);
  vm.runInContext('var feishuBitableSyncState = { selectionKey: \'\', operationId: \'\', inFlight: null };', context);
  [
    'createFeishuBitableOperationId',
    'feishuBitableSelectionSignature',
    'feishuBitableSyncStateFor',
    'pushToFeishu'
  ].forEach(function(name) {
    vm.runInContext(extractFunction(appSource, name), context);
  });
  return context;
}

test('selected Bitable push reuses its UUID after a lost response and rotates it after confirmation', async () => {
  const requests = [];
  const status = { innerHTML: '', textContent: '' };
  const operationIds = [
    '7d4add32-0efc-41ec-8e69-5c9508c7a654',
    '8113a1fa-a9c7-433b-b564-9d0e501fd6e7'
  ];
  const context = {
    crypto: { randomUUID: function() { return operationIds.shift(); } },
    document: { getElementById: function(id) { return id === 'feishuStatus' ? status : null; } },
    getSelectedInfIds: function() { return [9, 2]; },
    getM4CampaignId: function() { return 7001; },
    esc: function(value) { return String(value || ''); },
    toast: function() {},
    dlFile: function() {},
    loadFeishuStatus: function() {},
    loadFeishuOutbox: function() {},
    async apiFetch(url, options) {
      requests.push({ url, options });
      if (requests.length === 1) throw new Error('lost provider response');
      return response(200, { configured: true, synced: 2, records: 2 });
    }
  };
  loadFeishuFunctions(context);

  await context.pushToFeishu();
  await context.pushToFeishu();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/influencers/feishu/sync');
  assert.equal(requests[0].options.headers['Idempotency-Key'], '7d4add32-0efc-41ec-8e69-5c9508c7a654');
  assert.equal(requests[1].options.headers['Idempotency-Key'], requests[0].options.headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(requests[0].options.body), { ids: [9, 2], campaign_id: 7001 });

  await context.pushToFeishu();
  assert.equal(requests[2].options.headers['Idempotency-Key'], '8113a1fa-a9c7-433b-b564-9d0e501fd6e7');
});

test('Bitable UUID state is scoped to both the selected influencers and campaign', () => {
  const operationIds = [
    '85bbda1f-2969-49da-8cf8-85e1fbc38132',
    'bc42b9aa-2188-4835-a05d-b64451d40753'
  ];
  const context = { crypto: { randomUUID: function() { return operationIds.shift(); } } };
  loadFeishuFunctions(context);

  const first = context.feishuBitableSyncStateFor([9, 2], 7001);
  const sameCampaign = context.feishuBitableSyncStateFor([2, 9], 7001);
  const changedCampaign = context.feishuBitableSyncStateFor([2, 9], 7002);

  assert.equal(first.operationId, '85bbda1f-2969-49da-8cf8-85e1fbc38132');
  assert.equal(sameCampaign.operationId, first.operationId);
  assert.equal(changedCampaign.operationId, 'bc42b9aa-2188-4835-a05d-b64451d40753');
});
