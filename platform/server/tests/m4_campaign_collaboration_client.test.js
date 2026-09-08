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
    'var pendingContractCollabId = null;',
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
  let nextContractDocumentId = 801;
  const requests = [];
  const completedByKey = new Map();
  const rows = [];
  const appendedElements = [];
  const contractBytes = Buffer.from('%PDF-1.7\nclient contract fixture\n%%EOF\n', 'ascii');
  const contractFile = {
    name: 'signed-contract.pdf',
    type: 'application/pdf',
    size: contractBytes.length,
    async arrayBuffer() {
      return contractBytes.buffer.slice(
        contractBytes.byteOffset,
        contractBytes.byteOffset + contractBytes.byteLength
      );
    }
  };
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
    orderCreatorCost: element({ value: '800' }),
    orderClientQuote: element({ value: '1200' }),
    orderCurrency: element({ value: 'USD' }),
    orderPaymentTerms: element({ value: 'net_30' }),
    orderMarginPreview: element(),
    orderTimelineStart: element({ value: '2026-09-01' }),
    orderTimelineEnd: element({ value: '2026-09-10' }),
    orderNotes: element({ value: 'Client approved' }),
    contractReference: element({ value: 'SIGNED-501' }),
    contractCounterparty: element({ value: 'Creator Studio LLC' }),
    contractSignedAt: element({ value: '2026-09-07T10:00' }),
    contractConfirmationNote: element({ value: 'Signed copy verified in the approved drive.' }),
    contractDocumentExisting: element({ value: '' }),
    contractDocumentFile: element({ files: [contractFile] })
  };
  const campaign = {
    id: 91,
    name: 'Autumn launch',
    product_name: 'Portable power station',
    currency: 'USD',
    customer: { id: 31, label: 'Northstar Energy' },
    owner: { id: 9, label: 'Mina Chen' },
    lifecycle_state: 'demand_confirmed',
    operational_status: 'active'
  };

  function cloneRows() {
    return rows.map(function(row) {
      return Object.assign({}, row, {
        active_relations: row.active_relations.slice(),
        contract_confirmation: row.contract_confirmation
          ? Object.assign({}, row.contract_confirmation)
          : null,
        contract_documents: (row.contract_documents || []).map(function(document) {
          return Object.assign({}, document);
        })
      });
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
      contract_documents: [],
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

  function uploadContractDocument(url, options) {
    const body = JSON.parse(options.body);
    const collaborationId = Number(url.split('/')[2]);
    const collaboration = rows.find(function(row) { return row.id === collaborationId; });
    if (!collaboration || collaboration.row_version !== body.expected_version) {
      return jsonResponse(409, { error: 'STALE_COLLABORATION_VERSION', code: 'STALE_COLLABORATION_VERSION' });
    }
    const bytes = Buffer.from(body.content_base64, 'base64');
    const document = {
      id: nextContractDocumentId++,
      collaboration_id: collaborationId,
      original_filename: body.filename,
      media_type: body.media_type,
      file_sha256: 'a'.repeat(64),
      file_bytes: bytes.length,
      uploaded_by: 9,
      uploaded_by_name: 'Mina Chen',
      knowledge_entry_id: 991,
      created_at: '2026-09-08 09:00:00'
    };
    collaboration.contract_documents.push(document);
    return jsonResponse(201, { success: true, document });
  }

  function confirmContract(url, options) {
    const body = JSON.parse(options.body);
    const idempotencyKey = options.headers['Idempotency-Key'];
    const replayKey = url + ':' + idempotencyKey;
    if (completedByKey.has(replayKey)) return jsonResponse(201, completedByKey.get(replayKey));
    const collaborationId = Number(url.split('/')[2]);
    const collaboration = rows.find(function(row) { return row.id === collaborationId; });
    if (!collaboration || collaboration.row_version !== body.expected_version) {
      return jsonResponse(409, { error: 'STALE_COLLABORATION_VERSION' });
    }
    const document = collaboration.contract_documents.find(function(item) {
      return item.id === body.contract_document_id;
    });
    if (!document) return jsonResponse(409, { error: 'CONTRACT_DOCUMENT_REQUIRED' });
    collaboration.status = 'contracted';
    collaboration.row_version += 1;
    collaboration.contract_confirmation = {
      id: 901,
      contract_reference: body.contract_reference,
      counterparty_name: body.counterparty_name,
      signed_at: new Date(body.signed_at).toISOString(),
      confirmation_note: body.confirmation_note,
      confirmed_by: 9,
      confirmed_by_name: 'Mina Chen',
      confirmed_at: '2026-09-08T09:00:00.000Z',
      document: Object.assign({}, document)
    };
    const response = {
      success: true,
      campaign_id: collaboration.campaign_id,
      status: collaboration.status,
      row_version: collaboration.row_version,
      active_relations: collaboration.active_relations.slice(),
      contract_confirmation: Object.assign({}, collaboration.contract_confirmation)
    };
    completedByKey.set(replayKey, response);
    return jsonResponse(201, response);
  }

  const context = {
    m4Campaigns: [],
    m4CampaignContextId: null,
    lastCollabRows: [],
    pendingCollabInfId: 700,
    pendingContractCollabId: null,
    m4CollabMutationOperations: {},
    m4CollabMutationInFlight: {},
    pendingCreateRelease: null,
    pauseNextCreate: false,
    pendingCreateFailureRelease: null,
    pauseNextCreateFailure: false,
    failNextCreateAfterPersist: false,
    pendingPauseRelease: null,
    pauseNextUpdate: false,
    conflictNextContractAfterPersist: false,
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
    document: {
      getElementById(id) { return elements[id] || appendedElements.find(function(item) { return item.id === id; }) || null; },
      createElement() { return element({ remove() {} }); },
      body: { appendChild(item) { appendedElements.push(item); } },
      activeElement: null
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
      if (/^\/collaborations\/\d+\/contract-documents$/.test(url) && options.method === 'POST') {
        return uploadContractDocument(url, options);
      }
      if (/^\/collaborations\/\d+\/contract-confirmations$/.test(url) && options.method === 'POST') {
        if (context.conflictNextContractAfterPersist) {
          context.conflictNextContractAfterPersist = false;
          confirmContract(url, options);
          return jsonResponse(409, {
            error: 'Signed contract was already confirmed.',
            code: 'CONTRACT_ALREADY_CONFIRMED'
          });
        }
        return confirmContract(url, options);
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

  return { context, elements, requests, rows, appendedElements, contractBytes };
}

const m4Functions = [
  'getM4CampaignId',
  'getM4CampaignById',
  'm4CampaignLabel',
  'm4CampaignCommercialContext',
  'renderM4CampaignContext',
  'loadM4Campaigns',
  'm4ActiveDemandId',
  'm4OperationId',
  'm4MutationHeaders',
  'm4CollabMutationSlot',
  'm4CollabCreateMutationSlot',
  'm4CollabMutationOperationKey',
  'm4OrderCurrency',
  'm4OrderCommercialDefaults',
  'm4OrderCommercialControls',
  'm4CommercialValueText',
  'renderM4CommercialPreview',
  'submitCollabOrder',
  'loadCollaborations',
  'findCollaborationById',
  'collabRelations',
  'isCampaignCollaboration',
  'collabResource',
  'm4ContractDocuments',
  'm4ContractDocumentFingerprint',
  'm4ReadContractDocumentFile',
  'uploadCampaignContractDocument',
  'downloadCampaignContractDocument',
  'renderCollabRelationTags',
  'renderCampaignCollabActions',
  'renderContractConfirmation',
  'renderCollabCommercialTerms',
  'renderCollabTable',
  'submitCampaignCollabUpdate',
  'runCampaignCollabAction',
  'openCampaignContractConfirmationModal',
  'closeCampaignContractConfirmationModal',
  'submitCampaignContractConfirmation',
  'openCampaignSettlementModal'
];

test('M4 contract document retry fingerprint distinguishes equal-size PDF contents', () => {
  const { context } = createClientContext();
  loadFunctions(context, m4Functions);
  const first = new Uint8Array(Buffer.from('%PDF-1.7\ncontract-alpha\n%%EOF\n', 'ascii'));
  const second = new Uint8Array(Buffer.from('%PDF-1.7\ncontract-bravo\n%%EOF\n', 'ascii'));
  assert.equal(first.length, second.length);
  assert.notEqual(
    context.m4ContractDocumentFingerprint(first),
    context.m4ContractDocumentFingerprint(second)
  );
});

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

test('M4 commercial order builds v2 terms and projects creator cost to the historical field', async () => {
  const { context, requests, rows } = createClientContext();
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();

  await context.submitCollabOrder();

  const createRequest = requests.find(function(request) {
    return request.url === '/collaborations' && request.options.method === 'POST';
  });
  const createBody = JSON.parse(createRequest.options.body);
  assert.equal(createBody.cost_quoted, 800);
  assert.deepEqual(createBody.resource, {
    schema: 'turingmarket.collaboration-order.v2',
    project_name: 'Campaign project',
    product_name: 'Campaign product',
    order_type: 'paid',
    order_reference: 'PO-501',
    deliverable: 'One short video',
    creator_cost: 800,
    client_quote: 1200,
    currency: 'USD',
    payment_terms: 'net_30'
  });
  assert.equal(rows[0].cost_quoted, 800);
});

test('M4 commercial order rejects invalid terms before it creates a request', async () => {
  const { context, elements, requests } = createClientContext();
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();
  const toasts = [];
  context.toast = function(message, type) { toasts.push({ message, type }); };

  elements.orderCreatorCost.value = '3.5';
  await context.submitCollabOrder();
  elements.orderCreatorCost.value = '800';
  elements.orderCurrency.value = 'US';
  await context.submitCollabOrder();
  elements.orderCurrency.value = 'USD';
  elements.orderPaymentTerms.value = 'pay_later';
  await context.submitCollabOrder();

  assert.equal(requests.filter(function(request) { return request.url === '/collaborations'; }).length, 0);
  assert.equal(toasts.length, 3);
});

test('M4 currency input, preview, and submit normalize lowercase codes to uppercase', async () => {
  const { context, elements, requests } = createClientContext();
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();

  assert.match(context.m4OrderCommercialControls({ cost_usd: 800 }, 91), /oninput="this\.value=this\.value\.toUpperCase\(\);renderM4CommercialPreview\(\)"/);
  elements.orderCurrency.value = 'usd';
  context.renderM4CommercialPreview();
  assert.equal(elements.orderCurrency.value, 'USD');
  assert.match(elements.orderMarginPreview.innerHTML, /毛利：USD 400/);

  elements.orderCurrency.value = 'eur';
  await context.submitCollabOrder();
  const request = requests.find(function(item) { return item.url === '/collaborations' && item.options.method === 'POST'; });
  assert.equal(JSON.parse(request.options.body).resource.currency, 'EUR');
});

test('M4 settlement labels v2 currency, defaults historical rows to USD, and preserves actual zero', () => {
  const { context, appendedElements } = createClientContext();
  loadFunctions(context, m4Functions);

  context.openCampaignSettlementModal({
    id: 501,
    campaign_id: 91,
    campaign_name: 'Launch',
    kol_handle: '@creator',
    proposal_notes: JSON.stringify({ schema: 'turingmarket.collaboration-order.v2', currency: 'EUR' }),
    cost_actual: 0,
    cost_quoted: 800
  });
  assert.match(appendedElements.at(-1).innerHTML, /实际结算成本（EUR，整数）/);
  assert.match(appendedElements.at(-1).innerHTML, /value="0"/);

  context.openCampaignSettlementModal({
    id: 502,
    campaign_id: 91,
    campaign_name: 'Legacy',
    kol_handle: '@legacy',
    proposal_notes: 'legacy note',
    cost_actual: null,
    cost_quoted: 900
  });
  assert.match(appendedElements.at(-1).innerHTML, /实际结算成本（USD，整数）/);
  assert.match(appendedElements.at(-1).innerHTML, /value="900"/);
});

test('M4 commercial order previews margin and shows selected campaign customer and owner context', async () => {
  const { context, elements } = createClientContext();
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();

  assert.match(elements.m4CampaignContextStatus.textContent, /客户：Northstar Energy/);
  assert.match(elements.m4CampaignContextStatus.textContent, /负责人：Mina Chen/);
  assert.match(context.m4CampaignCommercialContext(91), /客户：Northstar Energy/);
  assert.match(context.m4CampaignCommercialContext(91), /负责人：Mina Chen/);

  context.renderM4CommercialPreview();
  assert.match(elements.orderMarginPreview.innerHTML, /毛利：USD 400/);
  assert.match(elements.orderMarginPreview.innerHTML, /33\.3%/);
  elements.orderCreatorCost.value = '';
  elements.orderClientQuote.value = '';
  context.renderM4CommercialPreview();
  assert.match(elements.orderMarginPreview.innerHTML, /请输入非负整数后预览毛利/);
  elements.orderCreatorCost.value = '800';
  elements.orderClientQuote.value = '0';
  context.renderM4CommercialPreview();
  assert.match(elements.orderMarginPreview.innerHTML, /毛利率不可计算/);
  assert.doesNotMatch(elements.orderMarginPreview.innerHTML, /-%/);
  elements.orderClientQuote.value = '700';
  context.renderM4CommercialPreview();
  assert.match(elements.orderMarginPreview.innerHTML, /亏损/);
  assert.match(elements.orderMarginPreview.innerHTML, /USD -100/);
});

test('M4 collaboration table distinguishes v2 commercial terms from historical quote rows', () => {
  const { context, elements } = createClientContext();
  context.COLLAB_ORDER_TYPE_LABELS = { paid: '付费合作' };
  context.COLLAB_RELATION_LABELS = { order: '下单' };
  context.STATUS_LABELS = { confirmed: '已确认下单' };
  context.fmtCount = function(value) { return String(value || 0); };
  loadFunctions(context, m4Functions);

  context.renderCollabTable([
    {
      id: 501,
      kol_handle: 'creator-a',
      platform: 'YouTube',
      followers: 10000,
      campaign_id: 91,
      campaign_name: 'Autumn launch',
      status: 'confirmed',
      row_version: 1,
      active_relations: ['order'],
      proposal_notes: JSON.stringify({
        schema: 'turingmarket.collaboration-order.v2',
        order_type: 'paid',
        creator_cost: 800,
        client_quote: 1200,
        currency: 'USD',
        payment_terms: 'net_30'
      }),
      cost_quoted: 800
    },
    {
      id: 502,
      kol_handle: 'creator-b',
      platform: 'TikTok',
      followers: 20000,
      status: 'confirmed',
      active_relations: [],
      proposal_notes: JSON.stringify({ schema: 'turingmarket.collaboration-order.v1', quoted_price: 900 }),
      cost_quoted: 900
    }
  ]);

  assert.match(elements.execTableContainer.innerHTML, /商业条款/);
  assert.match(elements.execTableContainer.innerHTML, /达人成本：USD 800/);
  assert.match(elements.execTableContainer.innerHTML, /客户报价：USD 1200/);
  assert.match(elements.execTableContainer.innerHTML, /毛利：USD 400/);
  assert.match(elements.execTableContainer.innerHTML, /账期：Net 30/);
  assert.match(elements.execTableContainer.innerHTML, /历史报价：\$900/);
  assert.match(context.renderCollabCommercialTerms(
    { cost_quoted: 0 },
    {
      schema: 'turingmarket.collaboration-order.v2',
      creator_cost: 0,
      client_quote: 0,
      currency: 'USD',
      payment_terms: 'full_prepayment'
    }
  ), /达人成本：USD 0/);
  assert.match(context.renderCollabCommercialTerms(
    { cost_quoted: 0 },
    { schema: 'turingmarket.collaboration-order.v1', quoted_price: 0 }
  ), /历史报价：\$0/);
});

test('M4 signed contract checkpoint gates v2 execution and persists entered evidence', async () => {
  const { context, elements, requests, rows, contractBytes } = createClientContext();
  context.COLLAB_ORDER_TYPE_LABELS = { paid: '付费合作' };
  context.COLLAB_RELATION_LABELS = { order: '下单' };
  context.STATUS_LABELS = {
    confirmed: '已确认',
    contract_sent: '合同待回签',
    contracted: '已签约'
  };
  context.fmtCount = function(value) { return String(value || 0); };
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();
  await context.submitCollabOrder();
  await context.loadCollaborations();

  const created = rows[0];
  const confirmedActions = context.renderCampaignCollabActions(created);
  assert.match(confirmedActions, /登记合同已发/);
  assert.match(confirmedActions, /确认已签约/);
  assert.doesNotMatch(confirmedActions, /开始执行/);

  context.pendingContractCollabId = created.id;
  await context.submitCampaignContractConfirmation();

  const uploadRequest = requests.find(function(request) {
    return request.url === '/collaborations/' + created.id + '/contract-documents';
  });
  assert.ok(uploadRequest);
  assert.match(uploadRequest.options.headers['Idempotency-Key'], /^m4-contract-document-upload-/);
  assert.deepEqual(JSON.parse(uploadRequest.options.body), {
    campaign_id: 91,
    expected_version: 1,
    filename: 'signed-contract.pdf',
    media_type: 'application/pdf',
    content_base64: contractBytes.toString('base64')
  });
  const confirmationRequest = requests.find(function(request) {
    return request.url === '/collaborations/' + created.id + '/contract-confirmations';
  });
  assert.ok(confirmationRequest);
  assert.match(confirmationRequest.options.headers['Idempotency-Key'], /^m4-contract-confirmation-/);
  assert.deepEqual(JSON.parse(confirmationRequest.options.body), {
    campaign_id: 91,
    expected_version: 1,
    contract_document_id: 801,
    contract_reference: 'SIGNED-501',
    counterparty_name: 'Creator Studio LLC',
    signed_at: new Date('2026-09-07T10:00').toISOString(),
    confirmation_note: 'Signed copy verified in the approved drive.'
  });
  assert.equal(created.status, 'contracted');
  assert.equal(created.row_version, 2);
  assert.match(context.renderCampaignCollabActions(created), /开始执行/);
  assert.match(context.renderContractConfirmation(created), /SIGNED-501/);
  assert.match(context.renderContractConfirmation(created), /Creator Studio LLC/);
  assert.match(context.renderContractConfirmation(created), /Mina Chen/);
  assert.match(context.renderContractConfirmation(created), /下载合同/);

  context.renderCollabTable([created]);
  assert.match(elements.execTableContainer.innerHTML, /已签约/);
  assert.match(elements.execTableContainer.innerHTML, /SIGNED-501/);
});

test('M4 signed contract checkpoint can reuse an already uploaded PDF without uploading again', async () => {
  const { context, elements, requests, rows } = createClientContext();
  context.COLLAB_ORDER_TYPE_LABELS = { paid: '付费合作' };
  context.COLLAB_RELATION_LABELS = { order: '下单' };
  context.STATUS_LABELS = { confirmed: '已确认', contracted: '已签约' };
  context.fmtCount = function(value) { return String(value || 0); };
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();
  await context.submitCollabOrder();
  await context.loadCollaborations();
  const existingDocument = {
    id: 880,
    collaboration_id: rows[0].id,
    original_filename: 'previously-uploaded.pdf',
    media_type: 'application/pdf',
    file_sha256: 'b'.repeat(64),
    file_bytes: 128,
    uploaded_by: 9,
    uploaded_by_name: 'Mina Chen',
    knowledge_entry_id: 992,
    created_at: '2026-09-08 08:00:00'
  };
  rows[0].contract_documents.push(existingDocument);
  context.lastCollabRows[0].contract_documents.push(Object.assign({}, existingDocument));
  elements.contractDocumentExisting.value = '880';
  elements.contractDocumentFile.files = [];
  context.pendingContractCollabId = rows[0].id;

  await context.submitCampaignContractConfirmation();

  assert.equal(requests.some(function(request) {
    return /\/contract-documents$/.test(request.url);
  }), false);
  const confirmationRequest = requests.find(function(request) {
    return /\/contract-confirmations$/.test(request.url);
  });
  assert.equal(JSON.parse(confirmationRequest.options.body).contract_document_id, 880);
  assert.equal(rows[0].status, 'contracted');
});

test('M4 signed contract conflict reloads persisted evidence and closes the stale modal', async () => {
  const { context, requests, rows } = createClientContext();
  context.COLLAB_ORDER_TYPE_LABELS = { paid: '付费合作' };
  context.COLLAB_RELATION_LABELS = { order: '下单' };
  context.STATUS_LABELS = { confirmed: '已确认', contracted: '已签约' };
  context.fmtCount = function(value) { return String(value || 0); };
  loadFunctions(context, m4Functions);
  await context.loadM4Campaigns();
  await context.submitCollabOrder();
  await context.loadCollaborations();
  context.pendingContractCollabId = rows[0].id;
  const toasts = [];
  context.toast = function(message, type) { toasts.push({ message, type }); };
  let closeCalls = 0;
  context.closeCampaignContractConfirmationModal = function() {
    closeCalls += 1;
    context.pendingContractCollabId = null;
  };
  context.conflictNextContractAfterPersist = true;

  await context.submitCampaignContractConfirmation();

  assert.equal(requests.filter(function(request) {
    return /\/contract-confirmations$/.test(request.url);
  }).length, 1, JSON.stringify(toasts));
  assert.equal(rows[0].status, 'contracted');
  assert.ok(rows[0].contract_confirmation);
  assert.equal(closeCalls, 1);
  assert.equal(context.pendingContractCollabId, null);
});

test('M4 commercial controls preserve zero defaults and choose campaign currency safely', () => {
  const { context } = createClientContext();
  loadFunctions(context, m4Functions);
  context.m4Campaigns = [{ id: 91, currency: 'EUR' }];

  assert.deepEqual(JSON.parse(JSON.stringify(context.m4OrderCommercialDefaults({ cost_usd: 0 }, 91))), {
    creatorCost: 0,
    clientQuote: 0,
    currency: 'EUR'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.m4OrderCommercialDefaults({ cost_usd: 300 }, 91))), {
    creatorCost: 300,
    clientQuote: 300,
    currency: 'EUR'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.m4OrderCommercialDefaults({ cost_usd: 300, quoted_price: 500 }, 91))), {
    creatorCost: 300,
    clientQuote: 500,
    currency: 'EUR'
  });

  context.m4Campaigns = [{ id: 91, currency: 'eur' }];
  assert.equal(context.m4OrderCommercialDefaults({ cost_usd: 0 }, 91).currency, 'USD');
  context.m4Campaigns = [{ id: 91 }];
  assert.equal(context.m4OrderCommercialDefaults({ cost_usd: 0 }, 91).currency, 'USD');

  context.m4Campaigns = [{ id: 91, currency: 'EUR' }];
  const controls = context.m4OrderCommercialControls({ cost_usd: 0 }, 91);
  assert.match(controls, /id="orderCreatorCost"[^>]*value="0"/);
  assert.match(controls, /id="orderClientQuote"[^>]*value="0"/);
  assert.match(controls, /id="orderCurrency"[^>]*value="EUR"/);
  assert.match(controls, /id="orderPaymentTerms"/);
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
    schema: 'turingmarket.collaboration-order.v2',
    project_name: 'Campaign project',
    product_name: 'Campaign product',
    order_type: 'paid',
    order_reference: 'PO-501',
    deliverable: 'One short video',
    creator_cost: 800,
    client_quote: 1200,
    currency: 'USD',
    payment_terms: 'net_30'
  });
  assert.equal(createBody.cost_quoted, 800);
  assert.match(createRequest.options.headers['Idempotency-Key'], /^m4-collaboration-create-/);
  assert.equal(rows.length, 1);

  await context.loadCollaborations();
  context.findCollaborationById = function(collaborationId) {
    return rows.find(function(row) { return row.id === Number(collaborationId); }) || null;
  };
  const created = Object.assign({}, rows[0], { active_relations: rows[0].active_relations.slice() });
  assert.ok(created);
  context.pendingContractCollabId = created.id;
  await context.submitCampaignContractConfirmation();
  assert.equal(rows[0].status, 'contracted');
  assert.equal(rows[0].row_version, 2);
  const contracted = Object.assign({}, rows[0], { active_relations: rows[0].active_relations.slice() });
  const executionPatch = {
    status: 'live',
    campaign_relation: 'execution',
    reason: '从下单工作台确认开始执行'
  };
  const executed = await context.submitCampaignCollabUpdate(contracted, executionPatch, 'execution');
  const replay = await context.submitCampaignCollabUpdate(contracted, executionPatch, 'execution');
  assert.deepEqual(replay, executed);
  const executionRequests = requests.filter(function(request) {
    return request.url === '/collaborations/' + created.id && request.options.method === 'PUT';
  });
  assert.equal(executionRequests.length, 2);
  assert.equal(executionRequests[0].options.headers['Idempotency-Key'], executionRequests[1].options.headers['Idempotency-Key']);
  assert.notEqual(executionRequests[0].options.headers['X-Request-Id'], executionRequests[1].options.headers['X-Request-Id']);
  assert.equal(rows[0].row_version, 3);

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
