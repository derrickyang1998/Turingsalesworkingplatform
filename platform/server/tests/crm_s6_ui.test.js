'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const platformRoot = path.resolve(__dirname, '..', '..');
const appJs = fs.readFileSync(path.join(platformRoot, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(platformRoot, 'index.html'), 'utf8');

function extractFunction(name) {
  const signatures = [`async function ${name}(`, `function ${name}(`];
  let start = -1;
  for (const signature of signatures) {
    start = appJs.indexOf(signature);
    if (start !== -1) break;
  }
  if (start === -1) return null;
  const braceStart = appJs.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = braceStart; index < appJs.length; index += 1) {
    const char = appJs[index];
    const next = appJs[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return appJs.slice(start, index + 1);
    }
  }
  return null;
}

function createElement(value = '') {
  const attributes = new Map();
  return {
    value,
    checked: false,
    disabled: false,
    hidden: false,
    innerHTML: '',
    textContent: '',
    dataset: {},
    style: { display: 'flex', opacity: '1' },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    setAttribute(name, valueToSet) { attributes.set(name, String(valueToSet)); },
    removeAttribute(name) { attributes.delete(name); },
    appendChild() {},
    focus() {}
  };
}

function okResponse() {
  return { ok: true, status: 200, async json() { return {}; } };
}

function jsonResponse(payload) {
  return { ok: true, status: 200, async json() { return payload; } };
}

function rejectedResponse() {
  return {
    ok: false,
    status: 409,
    async json() { return { code: 'CRM_TRANSITION_INVALID', title: 'CRM transition is not allowed' }; }
  };
}

function runFunctions(names, context) {
  const sources = names.map((name) => {
    const source = extractFunction(name);
    assert.ok(source, `app.js must define ${name}`);
    return source;
  });
  vm.createContext(context);
  vm.runInContext(sources.join('\n\n'), context, { filename: 'crm-s6-ui-functions.js' });
  return context;
}

function parsedBody(call) {
  assert.equal(typeof call.options.body, 'string');
  return JSON.parse(call.options.body);
}

function customerHarness(response = okResponse()) {
  const elements = new Map(Object.entries({
    custBrand: 'Acme',
    custCompany: 'Acme Ltd',
    custIndustry: 'Retail',
    custContact: 'Derrick',
    custContactInfo: 'derrick@example.invalid',
    custSource: 'Referral',
    custBudget: '12000',
    custNotes: 'Profile notes',
    custStage: 'lead',
    custEditId: '',
    activityText: 'Client approved the next review step'
  }).map(([id, value]) => [id, createElement(value)]));
  elements.get('custStage').dataset.originalStage = 'lead';
  const state = { calls: [], toasts: [], closes: 0, detailCloses: 0, loads: 0, stats: 0 };
  const context = {
    console,
    CUST_STAGES: { lead: '开发中', paused: '暂停', lost: '丢失' },
    CURRENT_AUTH_CONTEXT: {
      organization: { id: 501, role_code: 'member' },
      teams: [{ id: 701, name: 'Team A' }, { id: 702, name: 'Team B' }]
    },
    CURRENT_CRM_TEAM_ID: 701,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElement());
        return elements.get(id);
      },
      querySelector() { return createElement(); },
      querySelectorAll() { return []; },
      createElement() { return createElement(); }
    },
    async apiFetch(url, options) { state.calls.push({ url, options }); return response; },
    toast(message, type) { state.toasts.push({ message, type }); },
    closeCustModal() { state.closes += 1; },
    closeCustomerDetail() { state.detailCloses += 1; },
    async loadCustomers() { state.loads += 1; },
    loadCustomerStats() { state.stats += 1; },
    async openCustomerDetail() {},
    async collectCustomerTransitionEvidence() {
      return { reason_code: 'timeline_changed', next_action_at: '2099-01-01 09:00:00' };
    },
    async collectCustomerReleaseReason() { return 'capacity_rebalance'; }
  };
  return { context, elements, state };
}

test('authenticated organization context selects and exposes only an active CRM team', () => {
  const selector = createElement();
  const context = {
    CURRENT_AUTH_CONTEXT: null,
    CURRENT_CRM_TEAM_ID: null,
    document: {
      getElementById(id) { return id === 'crmTeamSelect' ? selector : null; },
      createElement() { return createElement(); }
    },
    esc(value) { return String(value); }
  };
  runFunctions(['rememberAuthContext', 'syncCrmTeamSelector', 'getSelectedCrmTeamId'], context);

  context.rememberAuthContext({
    organization: { id: 501, role_code: 'member' },
    teams: [{ id: 701, name: 'Team A' }, { id: 702, name: 'Team B' }]
  });
  assert.equal(context.CURRENT_CRM_TEAM_ID, 701);
  assert.equal(context.getSelectedCrmTeamId(), 701);
  selector.value = '702';
  assert.equal(context.getSelectedCrmTeamId(), 702);
  selector.value = '999';
  assert.equal(context.getSelectedCrmTeamId(), null);
});

test('customer create sends selected team while unchanged profile updates omit stage', async () => {
  const created = customerHarness();
  created.context.getSelectedCrmTeamId = () => 702;
  runFunctions(['requireSuccessfulCustomerMutation', 'saveCustomer'], created.context);
  await created.context.saveCustomer();
  assert.equal(created.state.calls[0].url, '/customers');
  assert.deepEqual(parsedBody(created.state.calls[0]), {
    brand_name: 'Acme',
    company_name: 'Acme Ltd',
    industry: 'Retail',
    contact_person: 'Derrick',
    contact_info: 'derrick@example.invalid',
    source: 'Referral',
    budget_estimate: '12000',
    notes: 'Profile notes',
    team_id: 702
  });

  const updated = customerHarness();
  updated.elements.get('custEditId').value = '41';
  updated.context.getSelectedCrmTeamId = () => 702;
  runFunctions(['requireSuccessfulCustomerMutation', 'saveCustomer'], updated.context);
  await updated.context.saveCustomer();
  const updateBody = parsedBody(updated.state.calls[0]);
  assert.equal(updated.state.calls[0].url, '/customers/41');
  assert.equal(Object.hasOwn(updateBody, 'stage'), false);
  assert.equal(Object.hasOwn(updateBody, 'transition'), false);
  assert.equal(Object.hasOwn(updateBody, 'team_id'), false);
});

test('customer stage changes use governed transition evidence and keep rollback behavior', async () => {
  const harness = customerHarness();
  runFunctions(['requireSuccessfulCustomerMutation', 'changeCustomerStage'], harness.context);
  const select = createElement('paused');
  select.setAttribute('data-previous-value', 'lead');

  await harness.context.changeCustomerStage(41, 'paused', select);

  assert.deepEqual(parsedBody(harness.state.calls[0]), {
    transition: {
      to_stage: 'paused',
      reason_code: 'timeline_changed',
      next_action_at: '2099-01-01 09:00:00'
    }
  });
  assert.equal(select.getAttribute('data-previous-value'), 'paused');
  assert.equal(harness.state.stats, 1);
});

test('claim sends selected team and release sends a closed reason', async () => {
  const harness = customerHarness();
  harness.context.getSelectedCrmTeamId = () => 702;
  runFunctions([
    'requireSuccessfulCustomerMutation',
    'claimCustomer',
    'returnToPool'
  ], harness.context);

  await harness.context.claimCustomer(41, true);
  await harness.context.returnToPool(41, true);

  assert.deepEqual(parsedBody(harness.state.calls[0]), { team_id: 702 });
  assert.deepEqual(parsedBody(harness.state.calls[1]), { reason_code: 'capacity_rebalance' });
  assert.equal(harness.state.detailCloses, 2);
  assert.equal(harness.state.loads, 2);
});

test('transition and custody evidence come from governed closed-option dialogs', async () => {
  const calls = [];
  const context = {
    console,
    document: { getElementById() { return null; } },
    async openCrmEvidenceDialog(config) {
      calls.push(config);
      if (config.kind === 'customer_transition') {
        return { reason_code: 'timeline_changed', next_action_at: '2099-01-01 09:00:00' };
      }
      if (config.kind === 'customer_release') {
        return { reason_code: 'capacity_rebalance' };
      }
      return { reason_code: 'competitive_loss', campaign_disposition: 'close' };
    }
  };
  runFunctions([
    'collectCustomerTransitionEvidence',
    'collectCustomerReleaseReason',
    'collectOpportunityTransitionEvidence'
  ], context);

  assert.deepEqual(
    await context.collectCustomerTransitionEvidence(41, 'proposal', 'paused'),
    { reason_code: 'timeline_changed', next_action_at: '2099-01-01 09:00:00' }
  );
  assert.equal(await context.collectCustomerReleaseReason(41), 'capacity_rebalance');
  assert.deepEqual(
    await context.collectOpportunityTransitionEvidence(71, 'proposal', 'lost'),
    { reason_code: 'competitive_loss', campaign_disposition: 'close' }
  );
  assert.deepEqual(calls.map((call) => call.kind), [
    'customer_transition',
    'customer_release',
    'opportunity_transition'
  ]);
  const evidenceSource = [
    extractFunction('collectCustomerTransitionEvidence'),
    extractFunction('collectCustomerReleaseReason'),
    extractFunction('collectOpportunityTransitionEvidence')
  ].join('\n');
  assert.doesNotMatch(evidenceSource, /manual_update|loss_reason_updated|window\.prompt/);
  assert.match(indexHtml, /id="crmEvidenceOverlay"/);
  assert.match(indexHtml, /id="crmEvidenceReason"/);
  assert.match(indexHtml, /id="crmEvidenceNextAction"/);
  assert.match(indexHtml, /id="crmEvidenceDisposition"/);
});

test('opportunity non-2xx keeps the modal open and unchanged stages stay out of profile writes', async () => {
  const ids = {
    oppName: 'Launch',
    oppValue: '12000',
    oppStage: 'proposal',
    oppProbability: '60',
    oppProduct: 'Power Station',
    oppChannel: 'TikTok',
    oppCloseDate: '2099-02-01',
    oppNotes: 'Draft remains open',
    oppDecisionChain: 'CMO > Procurement',
    oppLossReason: '',
    oppEditId: '71',
    oppCustomerId: '41'
  };
  const elements = new Map(Object.entries(ids).map(([id, value]) => [id, createElement(value)]));
  const state = { calls: [], closes: 0, toasts: [], loads: 0, detailLoads: 0 };
  const context = {
    console,
    currentOppCustomerId: 41,
    currentOppOriginalStage: 'proposal',
    document: {
      getElementById(id) { return elements.get(id) || createElement(); },
      querySelector() { return createElement(); }
    },
    async apiFetch(url, options) { state.calls.push({ url, options }); return rejectedResponse(); },
    toast(message, type) { state.toasts.push({ message, type }); },
    closeOppModal() { state.closes += 1; },
    loadOpportunities() { state.loads += 1; },
    openCustomerDetail() { state.detailLoads += 1; },
    async collectOpportunityTransitionEvidence() { return null; }
  };
  runFunctions(['requireSuccessfulCustomerMutation', 'saveOpportunity'], context);

  await context.saveOpportunity();

  assert.equal(state.calls.length, 1);
  assert.equal(Object.hasOwn(parsedBody(state.calls[0]), 'stage'), false);
  assert.equal(state.closes, 0);
  assert.equal(state.loads, 0);
  assert.equal(state.detailLoads, 0);
  assert.equal(state.toasts.some((entry) => entry.type === 'error'), true);
});

test('new opportunities start in discovery and do not expose an ignored stage selector', () => {
  const elements = new Map([
    'oppEditId',
    'oppCustomerId',
    'oppName',
    'oppValue',
    'oppStage',
    'oppProbability',
    'oppProduct',
    'oppChannel',
    'oppCloseDate',
    'oppNotes',
    'oppDecisionChain',
    'oppLossReason',
    'oppModalTitle',
    'oppModalOverlay'
  ].map((id) => [id, createElement()]));
  elements.get('oppStage').value = 'won';
  const context = {
    currentOppCustomerId: null,
    currentOppOriginalStage: null,
    document: { getElementById(id) { return elements.get(id) || null; } }
  };
  runFunctions(['showOppModal'], context);

  context.showOppModal(41);

  assert.equal(elements.get('oppStage').value, 'discovery');
  assert.equal(elements.get('oppStage').disabled, true);
  assert.equal(elements.get('oppModalOverlay').style.display, 'flex');
});

test('editing loads the scoped opportunity detail and preserves canonical timestamps and fields', async () => {
  const elements = new Map(Object.entries({
    oppEditId: '',
    oppCustomerId: '',
    oppName: '',
    oppValue: '',
    oppStage: '',
    oppProbability: '',
    oppProduct: '',
    oppChannel: '',
    oppCloseDate: '',
    oppNotes: '',
    oppDecisionChain: '',
    oppLossReason: '',
    oppModalTitle: '',
    oppModalOverlay: ''
  }).map(([id, value]) => [id, createElement(value)]));
  const detailed = {
    id: 71,
    customer_id: 41,
    name: 'Launch',
    stage: 'proposal',
    value: 12000,
    win_probability: 0,
    product_name: 'Power Station',
    channel_type: 'TikTok',
    expected_close_date: '2099-02-01 00:00:00',
    loss_reason: '',
    decision_chain: 'CMO > Procurement',
    notes: 'Preserve the approved media constraints'
  };
  const state = { calls: [], toasts: [], closes: 0 };
  const context = {
    console,
    currentOppCustomerId: null,
    currentOppOriginalStage: null,
    document: {
      getElementById(id) {
        if (id === 'custDetailSidebar') return null;
        return elements.get(id) || null;
      },
      querySelector() { return createElement(); }
    },
    async apiFetch(url, options) {
      state.calls.push({ url, options });
      if (url === '/opportunities/71/detail') {
        return jsonResponse({ opportunity: detailed, meta: { scope: 'team' } });
      }
      return okResponse();
    },
    toast(message, type) { state.toasts.push({ message, type }); },
    closeOppModal() { state.closes += 1; },
    loadOpportunities() {},
    openCustomerDetail() {},
    async collectOpportunityTransitionEvidence() { return null; }
  };
  runFunctions([
    'requireSuccessfulCustomerMutation',
    'editOpportunity',
    'saveOpportunity'
  ], context);

  await context.editOpportunity(71);

  assert.deepEqual(state.calls.map((call) => call.url), ['/opportunities/71/detail']);
  assert.equal(elements.get('oppDecisionChain').value, 'CMO > Procurement');
  assert.equal(elements.get('oppNotes').value, 'Preserve the approved media constraints');
  assert.equal(Number(elements.get('oppProbability').value), 0);
  assert.equal(elements.get('oppCloseDate').value, '2099-02-01');
  assert.equal(elements.get('oppStage').disabled, false);

  await context.saveOpportunity();

  assert.equal(state.calls[1].url, '/opportunities/71');
  assert.equal(parsedBody(state.calls[1]).decision_chain, 'CMO > Procurement');
  assert.equal(parsedBody(state.calls[1]).notes, 'Preserve the approved media constraints');
  assert.equal(parsedBody(state.calls[1]).win_probability, 0);
  assert.equal(parsedBody(state.calls[1]).expected_close_date, '2099-02-01');
  assert.equal(state.closes, 1);
});

test('auth expiry dismisses the governed evidence dialog and settles its pending result', async () => {
  const ids = [
    'crmEvidenceOverlay',
    'crmEvidenceDialog',
    'crmEvidenceTitle',
    'crmEvidenceReason',
    'crmEvidenceNextActionRow',
    'crmEvidenceNextAction',
    'crmEvidenceDispositionRow',
    'crmEvidenceDisposition',
    'crmEvidenceExceptionRow',
    'crmEvidenceException',
    'app',
    'authOverlay',
    'loginUser'
  ];
  const elements = new Map(ids.map((id) => [id, createElement()]));
  const opener = createElement();
  const state = { dismiss: null, opens: 0, closes: 0, detailCloses: 0, toasts: [] };
  const accessibility = {
    openDialog(dialog, dialogOpener, dismiss) {
      state.opens += 1;
      state.dialog = dialog;
      state.opener = dialogOpener;
      state.dismiss = dismiss;
    },
    closeDialog(dialog) {
      state.closes += 1;
      assert.equal(dialog, elements.get('crmEvidenceDialog'));
    },
    dismissAllDialogs() {
      if (state.dismiss) state.dismiss();
    }
  };
  const context = {
    console,
    pendingCrmEvidenceResolver: null,
    pendingCrmEvidenceConfig: null,
    AUTH_TOKEN: 'token',
    CURRENT_USER: { id: 7 },
    CURRENT_AUTH_CONTEXT: { organization: { id: 501 } },
    CURRENT_CRM_TEAM_ID: 701,
    AUTH_GENERATION: 1,
    authExpiredNotified: false,
    window: { TMAccessibility: accessibility },
    document: {
      activeElement: opener,
      getElementById(id) { return elements.get(id) || null; }
    },
    localStorage: { removeItem() {} },
    setTimeout(callback) { callback(); },
    esc(value) { return String(value); },
    closeCustomerDetail() { state.detailCloses += 1; },
    toast(message, type) { state.toasts.push({ message, type }); }
  };
  runFunctions([
    'finishCrmEvidenceDialog',
    'cancelCrmEvidenceDialog',
    'openCrmEvidenceDialog',
    'handleAuthExpired'
  ], context);

  const evidenceResult = context.openCrmEvidenceDialog({
    title: 'Transition evidence',
    reasons: [{ value: 'timeline_changed', label: 'Timeline changed' }],
    showNextAction: false,
    showDisposition: false,
    allowNoOpportunityException: false
  });

  assert.equal(state.opens, 1);
  assert.equal(state.opener, opener);
  assert.equal(typeof state.dismiss, 'function');

  context.handleAuthExpired('Session expired');

  assert.equal(await evidenceResult, null);
  assert.equal(state.closes, 1);
  assert.equal(context.pendingCrmEvidenceResolver, null);
  assert.equal(elements.get('crmEvidenceOverlay').hidden, true);
  assert.equal(state.detailCloses, 1);
});

test('free-text customer follow-up archives one governed knowledge note', async () => {
  const harness = customerHarness();
  runFunctions(['requireSuccessfulCustomerMutation', 'addCustomerActivity'], harness.context);

  await harness.context.addCustomerActivity(41);

  assert.equal(harness.state.calls[0].url, '/customers/41/archive-result');
  assert.deepEqual(parsedBody(harness.state.calls[0]), {
    artifact_type: 'note',
    title: '客户跟进记录',
    content: 'Client approved the next review step',
    tags: ['crm', 'follow-up'],
    source_type: 'manual_note'
  });
  assert.equal(harness.state.toasts.some((entry) => entry.type !== 'error'), true);
});

test('latest CRM UI exposes only canonical lifecycle controls and no hard-delete command', () => {
  const canonicalStages = [
    'lead',
    'info_confirmed',
    'advantage_shared',
    'needs_confirmed',
    'analysis',
    'proposal',
    'kol_matching',
    'cooperation',
    'paused',
    'won',
    'lost'
  ];
  const customerStageSelect = /<select id="custStage">([\s\S]*?)<\/select>/u.exec(indexHtml);
  const customerFilterSelect = /<select id="custStageFilter"[^>]*>([\s\S]*?)<\/select>/u.exec(indexHtml);
  assert.ok(customerStageSelect);
  assert.ok(customerFilterSelect);
  for (const stage of canonicalStages) {
    assert.match(customerStageSelect[1], new RegExp(`value="${stage}"`));
    assert.match(customerFilterSelect[1], new RegExp(`value="${stage}"`));
  }
  for (const obsolete of ['negotiation', 'maintenance']) {
    assert.doesNotMatch(customerStageSelect[1], new RegExp(`value="${obsolete}"`));
    assert.doesNotMatch(customerFilterSelect[1], new RegExp(`value="${obsolete}"`));
    assert.doesNotMatch(appJs, new RegExp(`\\n\\s*${obsolete}:`));
  }
  assert.match(appJs, /legacy-stage-readonly/);
  assert.equal(extractFunction('deleteCustomer'), null);
  assert.equal(extractFunction('deleteOpportunity'), null);
  assert.doesNotMatch(appJs, /method:\s*['"]DELETE['"][\s\S]{0,120}\/(?:customers|opportunities)\//);
});
