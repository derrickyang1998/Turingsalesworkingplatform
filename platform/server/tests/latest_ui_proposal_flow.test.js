const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const latestUiCompat = require('../services/latest_ui_compat_service');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-proposal-ai-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

function aiResult(overrides) {
  return Object.assign({
    conversation_id: 51,
    message_id: 52,
    answer: '# Aurora creator proposal\n\nUse scenario-led reviews.',
    model: 'deepseek-chat',
    usage: { total_tokens: 24 },
    knowledge_references: [{ id: 7, title: 'Approved launch playbook' }],
    web_results: [],
    web_search: { used: false, provider: 'tavily', reason: 'disabled' },
    degraded: false,
    reason: '',
    archived_summary_id: 53
  }, overrides || {});
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body, ok = true) {
  return {
    ok,
    async json() {
      return body;
    }
  };
}

function createElement(overrides = {}) {
  return Object.assign({
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; }
    },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return ''; },
    focus() {}
  }, overrides);
}

function createProposalVmHarness() {
  const elements = new Map();
  const apiCalls = [];
  const apiQueue = [];
  const toasts = [];
  const navigations = [];

  for (const id of [
    'proposalEditor',
    'proposalTextMirror',
    'confirmProposalBtn',
    'm3s1',
    'm3s2',
    'm3s3',
    'demandFileStatus',
    'btnAnalyzeAI',
    'aiAnalyzeHint',
    'proposalOutput',
    'demandDropZone',
    'step1',
    'step2',
    'step3',
    'filt_project',
    'filt_product',
    'filt_platform',
    'filt_region',
    'filt_tag'
  ]) {
    elements.set(id, createElement());
  }

  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    dispatchEvent() {}
  };

  const context = {
    window: {
      location: { origin: 'http://task6a.test' },
      TMNavigation: {
        navigate(id, options) {
          navigations.push({ id, options });
        }
      }
    },
    document: documentStub,
    localStorage: {
      getItem() { return ''; },
      setItem() {},
      removeItem() {}
    },
    navigator: { clipboard: { writeText() {} } },
    location: { reload() {} },
    console,
    CustomEvent: function CustomEvent(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    setTimeout(fn) {
      if (typeof fn === 'function') fn();
      return 0;
    },
    clearTimeout() {},
    fetch: async () => jsonResponse({}),
    __apiFetch(url, options) {
      const deferred = apiQueue.shift() || createDeferred();
      apiCalls.push({ url, options, deferred });
      return deferred.promise;
    },
    __toast(message, type) {
      toasts.push({ message, type });
    }
  };
  context.window.window = context.window;
  context.window.document = documentStub;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8'),
    context
  );
  vm.runInContext(`
    apiFetch = __apiFetch;
    toast = __toast;
    var __task6aKeyCounter = 0;
    createIdempotencyKey = function(prefix) {
      __task6aKeyCounter += 1;
      return prefix + __task6aKeyCounter;
    };
    switchTab = function() {};
  `, context);

  function seedProposalState(overrides = {}) {
    const state = {
      content: '# Initial confirmed proposal',
      campaignId: 77,
      customerId: 88,
      opportunityId: 99,
      demandEntryId: 501,
      generationSequence: 9,
      demand: {
        brand: 'Aurora',
        company: 'Aurora Co',
        product: 'Solar Kit',
        category: 'Energy',
        budget: '10000 USD',
        platform: 'YouTube',
        area: 'US',
        usp: 'Field-test proof',
        competitors: 'SunX'
      }
    };
    Object.assign(state, overrides);
    elements.get('proposalEditor').value = state.content;
    vm.runInContext(`
      curDemand = ${JSON.stringify(Object.assign({}, state.demand, {
        customer_id: state.customerId,
        opportunity_id: state.opportunityId,
        campaign_id: state.campaignId
      }))};
      selTpl = 'task6a-template';
      lastProp = ${JSON.stringify(state.content)};
      lastProposalContext = {
        campaign_id: ${state.campaignId},
        customer_id: ${state.customerId},
        opportunity_id: ${state.opportunityId},
        brand: 'Aurora',
        company: 'Aurora Co',
        product: 'Solar Kit',
        platform: 'YouTube',
        market: 'US'
      };
      lastProposalDraftAudit = { demand_entry_id: ${state.demandEntryId} };
      lastProposalAI = { conversation_id: 601, message_id: 602 };
      lastLinkedProposalConfirmation = null;
      pendingLinkedProposalConfirmation = null;
      proposalGenerationSequence = ${state.generationSequence};
    `, context);
  }

  function enqueueResponse(body) {
    const deferred = createDeferred();
    apiQueue.push(deferred);
    deferred.resolve(jsonResponse(body));
    return deferred;
  }

  return {
    context,
    elements,
    apiCalls,
    apiQueue,
    toasts,
    navigations,
    seedProposalState,
    enqueueResponse,
    state(expression) {
      return vm.runInContext(expression, context);
    },
    stateJson(expression) {
      return JSON.parse(JSON.stringify(vm.runInContext(expression, context)));
    },
    run(expression) {
      return vm.runInContext(expression, context);
    }
  };
}

test('proposal draft keeps instructions separate from retrieval and defaults web off', async () => {
  let captured = null;
  let ingested = null;
  const result = await latestUiCompat.generateProposalDraft(
    {},
    { id: 2, role: 'user' },
    {
      title: 'Aurora Solar Kit',
      demand: { brand: 'Aurora', product: 'Solar Kit', target_market: 'US' },
      demand_content: 'Aurora Solar Kit needs US field-test creator coverage.',
      template: { name: 'Launch plan', sections: ['Executive summary', 'Creator mix'] },
      knowledge_limit: 0
    },
    {
      knowledgeService: {
        ingestKnowledge(actualDb, input) {
          ingested = { actualDb, input };
          return { id: 14, title: input.title };
        }
      },
      aiService: {
        async handleChat(actualDb, options) {
          captured = { actualDb, options };
          return aiResult();
        }
      }
    }
  );

  assert.equal(ingested.input.entry_type, 'demand');
  assert.equal(ingested.input.visibility, 'private');
  assert.match(ingested.input.content, /Aurora Solar Kit/);
  assert.equal(captured.options.allowWeb, false);
  assert.equal(captured.options.source_module, 'proposal');
  assert.equal(captured.options.summaryVisibility, 'private');
  assert.equal(captured.options.knowledgeLimit, 10);
  assert.match(captured.options.message, /60-30-10/);
  assert.match(captured.options.message, /Aurora Solar Kit/);
  assert.match(captured.options.ragQuery, /Aurora Solar Kit/);
  assert.match(captured.options.ragQuery, /Launch plan/);
  assert.doesNotMatch(captured.options.ragQuery, /60-30-10/);
  assert.equal(captured.options.webQuery, captured.options.ragQuery);
  assert.equal(result.draft, aiResult().answer);
  assert.equal(result.demand_entry.id, 14);
  assert.equal(result.fallback, false);
  assert.equal(result.warning, '');
  assert.equal(result.ai.conversation_id, 51);
});

test('proposal route forwards controls and latest M3 uses AI draft then explicit confirmation', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeStart = serverSource.indexOf("app.post('/api/ai/proposal-draft'");
  const routeEnd = serverSource.indexOf('// ===== LATEST UI COMPATIBILITY ROUTES =====', routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /latestUiCompat\.generateProposalDraft/);
  assert.match(route, /allowWeb:\s*boolParam\(req\.body\.allow_web,\s*false\)/);
  assert.match(route, /knowledgeLimit:\s*req\.body\.knowledge_limit/);
  assert.match(route, /summaryVisibility:\s*'private'/);
  assert.doesNotMatch(route, /summaryVisibility:\s*req\.body\.summary_visibility/);

  const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  const generateStart = appSource.indexOf('async function generateProposal()');
  const saveStart = appSource.indexOf('async function saveCurrentProposal()');
  const detailStart = appSource.indexOf('function renderCustomerSidebar', saveStart);
  assert.notEqual(generateStart, -1);
  assert.notEqual(saveStart, -1);
  assert.notEqual(detailStart, -1);
  const generateBlock = appSource.slice(generateStart, appSource.indexOf('function updateProposalDraftFromEditor', generateStart));
  const saveBlock = appSource.slice(saveStart, detailStart);
  assert.match(generateBlock, /apiFetch\(["']\/ai\/proposal-draft["']/);
  assert.match(generateBlock, /lastProposalAI\s*=\s*d\.ai/);
  assert.match(generateBlock, /lastProp\s*=\s*d\.draft/);
  assert.match(generateBlock, /generationId\s*!==\s*proposalGenerationSequence/);
  assert.match(generateBlock, /lastProposalContext\s*=\s*generationContext/);
  assert.ok(
    generateBlock.indexOf('lastProposalAI = null') < generateBlock.indexOf("await fetchSimilarKnowledge(curDemand, 'proposal')"),
    'proposal audit state must reset before the first asynchronous retrieval'
  );
  assert.match(generateBlock, /renderProposalAIReferences/);
  assert.match(generateBlock, /确认方案并归档/);
  assert.match(saveBlock, /getCurrentProposalDraft\(\)/);
  assert.match(saveBlock, /var context\s*=\s*lastProposalContext\s*\|\|\s*\{\}/);
  assert.doesNotMatch(saveBlock, /var context\s*=\s*activeWorkflowContext/);
  assert.match(saveBlock, /archiveCustomerArtifact/);
  assert.match(saveBlock, /apiFetch\(["']\/proposals["']/);
  assert.match(saveBlock, /apiFetch\(['"`]\/campaigns\/['"`]\s*\+\s*campaignId\s*\+\s*['"`]\/proposal-confirmations['"`]/);
  assert.match(saveBlock, /headers:\s*\{\s*'Idempotency-Key':\s*linkedKey\s*\}/);
  assert.match(saveBlock, /lastLinkedProposalConfirmation\s*=\s*\{/);
  assert.doesNotMatch(saveBlock, /campaign_id\s*:\s*null/);
  assert.doesNotMatch(saveBlock, /demand_id\s*:\s*lastProposalAI\.demand_entry/);

  const resetStart = appSource.indexOf('function resetDemand(');
  const resetEnd = appSource.indexOf('\n}', resetStart);
  assert.notEqual(resetStart, -1);
  const resetBlock = appSource.slice(resetStart, resetEnd);
  assert.match(resetBlock, /activeWorkflowContext\s*=\s*null/);
  assert.match(resetBlock, /lastProposalContext\s*=\s*null/);
  assert.match(resetBlock, /clearLinkedProposalConfirmation\(\)/);
  assert.match(resetBlock, /proposalGenerationSequence\s*\+=\s*1/);

  const workflowStart = appSource.indexOf('function fillWorkflowDemand(');
  const workflowEnd = appSource.indexOf('function fillWorkflowInfluencers', workflowStart);
  const workflowBlock = appSource.slice(workflowStart, workflowEnd);
  assert.match(workflowBlock, /resetDemand\(\);[\s\S]*setWorkflowContext\(context\)/);

  const switchStart = appSource.indexOf('function switchPage(');
  const switchEnd = appSource.indexOf('\n}', switchStart);
  const switchBlock = appSource.slice(switchStart, switchEnd);
  assert.match(switchBlock, /id\s*===\s*'m3'[\s\S]*activeWorkflowContext\s*=\s*null/);
  assert.match(switchBlock, /id\s*===\s*'m3'[\s\S]*clearLinkedProposalConfirmation\(\)/);

  const handoffStart = appSource.indexOf('function openProposalToInfluencers(');
  const handoffEnd = appSource.indexOf('\n}', handoffStart);
  assert.notEqual(handoffStart, -1);
  const handoffBlock = appSource.slice(handoffStart, handoffEnd);
  assert.match(handoffBlock, /lastProposalContext/);
  assert.match(handoffBlock, /lastLinkedProposalConfirmation/);
  assert.match(handoffBlock, /campaign_id/);
  assert.match(handoffBlock, /demand_entry_id/);
  assert.match(handoffBlock, /demand_id/);
  assert.match(handoffBlock, /proposal_id/);
  assert.match(handoffBlock, /proposal_content_sha256/);
});

test('campaign proposal confirmation reuses unchanged retry key and rotates after edited content', async () => {
  const harness = createProposalVmHarness();
  harness.seedProposalState();

  const firstSave = harness.run('saveCurrentProposal()');
  await new Promise((resolve) => setImmediate(resolve));
  const retrySave = harness.run('saveCurrentProposal()');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.apiCalls.length, 2);
  assert.equal(harness.apiCalls[0].url, '/campaigns/77/proposal-confirmations');
  assert.equal(
    harness.apiCalls[0].options.headers['Idempotency-Key'],
    harness.apiCalls[1].options.headers['Idempotency-Key']
  );
  assert.equal(
    harness.apiCalls[0].options.headers['Idempotency-Key'],
    'proposal-confirmation-1'
  );

  const confirmedBody = {
    campaign_id: 77,
    demand: { id: 701, link_id: 702 },
    proposal: {
      id: 801,
      content_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    }
  };
  harness.apiCalls[0].deferred.resolve(jsonResponse(confirmedBody));
  harness.apiCalls[1].deferred.resolve(jsonResponse(confirmedBody));
  await Promise.all([firstSave, retrySave]);
  assert.deepEqual(harness.stateJson('lastLinkedProposalConfirmation'), {
    campaign_id: 77,
    demand_id: 701,
    demand_link_id: 702,
    proposal_id: 801,
    proposal_content_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    demand_entry_id: 501
  });
  const confirmButton = harness.elements.get('confirmProposalBtn');
  assert.equal(confirmButton.disabled, true);
  assert.equal(confirmButton.textContent, '已确认归档');

  harness.elements.get('proposalEditor').value = '# Edited proposal content';
  harness.run('updateProposalDraftFromEditor()');
  assert.equal(harness.state('lastLinkedProposalConfirmation'), null);
  assert.equal(confirmButton.disabled, false);
  assert.equal(confirmButton.textContent, '确认方案并归档');

  const editedSave = harness.run('saveCurrentProposal()');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirmButton.disabled, true);
  assert.equal(confirmButton.textContent, '正在归档...');
  assert.equal(harness.apiCalls.length, 3);
  assert.equal(
    harness.apiCalls[2].options.headers['Idempotency-Key'],
    'proposal-confirmation-2'
  );
  assert.notEqual(
    harness.apiCalls[2].options.headers['Idempotency-Key'],
    harness.apiCalls[0].options.headers['Idempotency-Key']
  );
  harness.apiCalls[2].deferred.resolve(jsonResponse({
    campaign_id: 77,
    demand: { id: 703, link_id: 704 },
    proposal: {
      id: 802,
      content_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    }
  }));
  await editedSave;
});

test('stale proposal confirmation success after reset or navigation cannot restore linked UI state', async () => {
  const resetHarness = createProposalVmHarness();
  resetHarness.seedProposalState({ demandEntryId: 111 });
  const resetSave = resetHarness.run('saveCurrentProposal()');
  await new Promise((resolve) => setImmediate(resolve));
  resetHarness.run(`
    resetDemand();
    lastProposalDraftAudit = { demand_entry_id: 222 };
  `);
  resetHarness.apiCalls[0].deferred.resolve(jsonResponse({
    campaign_id: 77,
    demand: { id: 711, link_id: 712 },
    proposal: {
      id: 811,
      content_sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    }
  }));
  await resetSave;
  assert.equal(resetHarness.state('lastLinkedProposalConfirmation'), null);
  assert.equal(resetHarness.elements.get('confirmProposalBtn').disabled, false);
  assert.equal(resetHarness.elements.get('confirmProposalBtn').textContent, '确认方案并归档');

  const navigationHarness = createProposalVmHarness();
  navigationHarness.seedProposalState({ demandEntryId: 333 });
  const navigationSave = navigationHarness.run('saveCurrentProposal()');
  await new Promise((resolve) => setImmediate(resolve));
  navigationHarness.run("switchPage('m0')");
  navigationHarness.apiCalls[0].deferred.resolve(jsonResponse({
    campaign_id: 77,
    demand: { id: 713, link_id: 714 },
    proposal: {
      id: 812,
      content_sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    }
  }));
  await navigationSave;
  assert.equal(navigationHarness.state('lastLinkedProposalConfirmation'), null);
  assert.equal(navigationHarness.elements.get('confirmProposalBtn').disabled, false);
  assert.equal(navigationHarness.elements.get('confirmProposalBtn').textContent, '确认方案并归档');

  const editHarness = createProposalVmHarness();
  editHarness.seedProposalState({ demandEntryId: 444 });
  const editSave = editHarness.run('saveCurrentProposal()');
  await new Promise((resolve) => setImmediate(resolve));
  editHarness.elements.get('proposalEditor').value = '# Superseding in-flight edit';
  editHarness.run('updateProposalDraftFromEditor()');
  editHarness.apiCalls[0].deferred.resolve(jsonResponse({
    campaign_id: 77,
    demand: { id: 715, link_id: 716 },
    proposal: {
      id: 813,
      content_sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    }
  }));
  await editSave;
  assert.equal(editHarness.state('lastLinkedProposalConfirmation'), null);
  assert.equal(editHarness.elements.get('confirmProposalBtn').disabled, false);
  assert.equal(editHarness.elements.get('confirmProposalBtn').textContent, '确认方案并归档');
});

test('proposal influencer handoff preserves confirmed campaign proposal context before navigation', () => {
  const harness = createProposalVmHarness();
  harness.seedProposalState();
  harness.run(`
    lastLinkedProposalConfirmation = {
      campaign_id: 77,
      demand_id: 701,
      demand_link_id: 702,
      proposal_id: 801,
      proposal_content_sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      demand_entry_id: 501
    };
  `);

  harness.run('openProposalToInfluencers()');

  assert.deepEqual(harness.navigations.map((item) => item.id), ['m4']);
  assert.deepEqual(harness.stateJson(`({
    campaign_id: activeWorkflowContext.campaign_id,
    customer_id: activeWorkflowContext.customer_id,
    opportunity_id: activeWorkflowContext.opportunity_id,
    demand_id: activeWorkflowContext.demand_id,
    demand_entry_id: activeWorkflowContext.demand_entry_id,
    proposal_id: activeWorkflowContext.proposal_id,
    proposal_content_sha256: activeWorkflowContext.proposal_content_sha256
  })`), {
    campaign_id: 77,
    customer_id: 88,
    opportunity_id: 99,
    demand_id: 701,
    demand_entry_id: 501,
    proposal_id: 801,
    proposal_content_sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  });
});

test('proposal draft persists only authorized references and preserves degradation reason', async () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');
  const accessible = knowledge.ingestKnowledge(db, {
    title: 'Aurora approved launch playbook',
    content: 'Use scenario-led creator reviews and a 60-30-10 budget split for Aurora.',
    entry_type: 'methodology',
    visibility: 'team',
    created_by: 1
  });
  knowledge.ingestKnowledge(db, {
    title: 'Aurora private launch note',
    content: 'This private note belongs to another user and must stay excluded.',
    entry_type: 'methodology',
    visibility: 'private',
    created_by: 3
  });
  let providerMessages = null;
  let webCalls = 0;

  try {
    const result = await latestUiCompat.generateProposalDraft(
      db,
      { id: 2, role: 'user' },
      {
        title: 'Aurora Solar Kit',
        demand_id: 'aurora-solar-kit-v1',
        demand_content: 'Aurora Solar Kit launch in the US using the approved launch playbook.',
        template: { name: 'Launch plan', sections: ['Executive summary', 'Creator mix'] },
        allow_web: false,
        knowledge_limit: 6
      },
      {
        provider: {
          async complete(request) {
            providerMessages = request.messages;
            return {
              content: '# Audited Aurora proposal\n\nUse scenario-led creator reviews.',
              usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
              model: 'proposal-test-model',
              degraded: true,
              reason: 'provider partial response'
            };
          }
        },
        webSearchProvider: {
          async search() {
            webCalls += 1;
            return { used: true, provider: 'tavily', results: [] };
          }
        }
      }
    );

    assert.equal(webCalls, 0);
    assert.match(providerMessages[0].content, /Aurora approved launch playbook/);
    assert.doesNotMatch(providerMessages[0].content, /Aurora private launch note/);
    assert.ok(result.ai.knowledge_references.some((item) => item.id === accessible.id));
    assert.equal(result.ai.knowledge_references.some((item) => item.title === 'Aurora private launch note'), false);
    assert.equal(result.fallback, true);
    assert.equal(result.warning, 'provider partial response');
    assert.equal(result.draft, '# Audited Aurora proposal\n\nUse scenario-led creator reviews.');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='demand'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_conversations').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='web'").get().count, 0);
    assert.ok(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='knowledge'").get().count >= 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM token_usage WHERE endpoint='ai_chat' AND total_tokens=20").get().count, 1);
    const conversation = db.prepare('SELECT source_module,archived_summary_id FROM ai_conversations').get();
    assert.equal(conversation.source_module, 'proposal');
    assert.ok(conversation.archived_summary_id > 0);
    const summary = db.prepare("SELECT visibility,business_type FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get();
    assert.equal(summary.visibility, 'private');
    assert.equal(summary.business_type, 'proposal');
  } finally {
    db.close();
  }
});
