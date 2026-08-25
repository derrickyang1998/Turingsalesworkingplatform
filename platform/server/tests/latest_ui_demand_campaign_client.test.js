'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', '..', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const pptPath = path.join(__dirname, '..', '..', 'ppt.js');
const pptSource = fs.readFileSync(pptPath, 'utf8');

function extractFunction(source, name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const match = declaration.exec(source);
  assert.ok(match, `${name} must exist`);

  const openingBrace = source.indexOf('{', match.index);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
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

function functionBody(name) {
  const declaration = extractFunction(appSource, name);
  return declaration.slice(declaration.indexOf('{') + 1, -1);
}

function extractActiveEsc() {
  const matches = pptSource.match(/function esc\(s\) \{[\s\S]*?\n\}/g);
  assert.ok(matches && matches.length, 'active ppt.js esc must exist');
  return matches.at(-1);
}

function loadDemandHelpers(campaignId) {
  let uuid = 0;
  const remembered = [];
  const context = {
    window: {
      crypto: {
        randomUUID() {
          uuid += 1;
          return `uuid-${uuid}`;
        }
      }
    },
    getActiveCampaignId() { return campaignId; },
    rememberKnowledgeEntryForChat(id) { remembered.push(id); },
    readPositiveInteger(value) {
      if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
      if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    [
      'var lastDemandAnalysisAI = null;',
      'var demandAnalysisRequestGeneration = 0;',
      'var demandAnalysisInFlight = false;',
      extractActiveEsc(),
      extractFunction(appSource, 'createDemandAnalysisOperationId'),
      extractFunction(appSource, 'beginDemandAnalysisRequest'),
      extractFunction(appSource, 'isCurrentDemandAnalysisRequest'),
      extractFunction(appSource, 'finishDemandAnalysisRequest'),
      extractFunction(appSource, 'invalidateDemandAnalysisRequests'),
      extractFunction(appSource, 'buildDemandAnalysisRequestOptions'),
      extractFunction(appSource, 'normalizeDemandAnalysisAudit'),
      extractFunction(appSource, 'captureDemandAnalysisAudit'),
      extractFunction(appSource, 'renderDemandAnalysisEvidence')
    ].join('\n'),
    context,
    { filename: appPath }
  );
  context.remembered = remembered;
  return context;
}

function loadWorkflowContextHelpers() {
  const context = {
    activeWorkflowContext: { campaign_id: 11 },
    curDemand: null,
    selectedKnowledgeEntryIds: [7],
    selectedKnowledgeCampaignId: 11,
    currentAIConversationId: 91,
    lastDemandAnalysisAI: { campaign_id: 11 },
    demandAnalysisRequestGeneration: 4,
    demandAnalysisInFlight: true
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction(appSource, 'readPositiveInteger'),
      extractFunction(appSource, 'readExplicitCampaignId'),
      extractFunction(appSource, 'getActiveCampaignId'),
      extractFunction(appSource, 'rememberKnowledgeEntryForChat'),
      extractFunction(appSource, 'getSelectedKnowledgeEntryIds'),
      extractFunction(appSource, 'invalidateDemandAnalysisRequests'),
      extractFunction(appSource, 'setWorkflowContext')
    ].join('\n'),
    context,
    { filename: appPath }
  );
  return context;
}

function loadDemandAnalysisRuntime(initialCampaignId = 11) {
  function classList() {
    const values = new Set();
    return {
      add(...tokens) { tokens.forEach((token) => values.add(token)); },
      remove(...tokens) { tokens.forEach((token) => values.delete(token)); },
      contains(token) { return values.has(token); }
    };
  }
  function element(value = '') {
    return { value, innerHTML: '', textContent: '', disabled: false, classList: classList() };
  }

  const elements = {
    demandFileStatus: element(),
    analysisOut: element(),
    aiAnalyzeHint: element(),
    btnAnalyzeAI: element(),
    d_brand: element(),
    d_product: element(),
    d_usp: element(),
    d_category: element(),
    d_area: element(),
    d_budget: element(),
    m3s1: element(),
    m3s2: element()
  };
  const pending = [];
  let uuid = 0;
  const context = {
    window: {
      crypto: {
        randomUUID() {
          uuid += 1;
          return `runtime-${uuid}`;
        }
      }
    },
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    activeWorkflowContext: { campaign_id: initialCampaignId },
    curDemand: null,
    currentAIConversationId: null,
    selectedKnowledgeEntryIds: [],
    selectedKnowledgeCampaignId: initialCampaignId,
    uploadedDemandContent: 'Brand: Acme\nProduct: Power station',
    uploadedDemandFileName: 'brief.xlsx',
    demandAnalysisResult: '',
    lastDemandAnalysisAI: null,
    demandAnalysisRequestGeneration: 0,
    demandAnalysisInFlight: false,
    apiFetch(url, options) {
      return new Promise((resolve, reject) => pending.push({ url, options, resolve, reject }));
    },
    mergeDemandAnalysis(value) {
      return Object.assign({
        brand: '', company: '', product: '', usp: '', industry: '', budget_range: '', target_market: '',
        platforms: [], competitors: [], requirements: []
      }, value || {});
    },
    inferDemandFromText() { return {}; },
    hasDemandAnalysisValue() { return true; },
    toast() {},
    updSteps(value) { context.lastStep = value; }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    [
      extractActiveEsc(),
      extractFunction(appSource, 'readPositiveInteger'),
      extractFunction(appSource, 'readExplicitCampaignId'),
      extractFunction(appSource, 'getActiveCampaignId'),
      extractFunction(appSource, 'rememberKnowledgeEntryForChat'),
      extractFunction(appSource, 'getSelectedKnowledgeEntryIds'),
      extractFunction(appSource, 'setWorkflowContext'),
      extractFunction(appSource, 'createDemandAnalysisOperationId'),
      extractFunction(appSource, 'beginDemandAnalysisRequest'),
      extractFunction(appSource, 'isCurrentDemandAnalysisRequest'),
      extractFunction(appSource, 'finishDemandAnalysisRequest'),
      extractFunction(appSource, 'invalidateDemandAnalysisRequests'),
      extractFunction(appSource, 'buildDemandAnalysisRequestOptions'),
      extractFunction(appSource, 'normalizeDemandAnalysisAudit'),
      extractFunction(appSource, 'captureDemandAnalysisAudit'),
      extractFunction(appSource, 'renderDemandAnalysisEvidence'),
      'async ' + extractFunction(appSource, 'analyzeDemandAI')
    ].join('\n'),
    context,
    { filename: appPath }
  );
  context.elements = elements;
  context.pending = pending;
  return context;
}

function demandResponse(campaignId, conversationId) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        analysis: {
          brand: `Campaign ${campaignId}`,
          product: 'Power station',
          platforms: ['TikTok'],
          competitors: [],
          requirements: ['Creator review']
        },
        fallback: false,
        ai: {
          conversation_id: conversationId,
          message_id: conversationId + 1,
          knowledge_references: [{ entry_id: campaignId, citation_label: 'KB-1', title: `Campaign ${campaignId} knowledge` }]
        }
      };
    }
  };
}

test('linked demand analysis sends campaign audit controls and fixed knowledge-only policy', () => {
  const context = loadDemandHelpers(42);
  const request = context.beginDemandAnalysisRequest();
  const options = context.buildDemandAnalysisRequestOptions(
    'Brand: Acme',
    'Analyze this demand',
    'brief.xlsx',
    request
  );
  const body = JSON.parse(options.body);

  assert.equal(request.campaignId, 42);
  assert.equal(body.campaign_id, 42);
  assert.equal(body.allow_web, false);
  assert.equal(Object.hasOwn(body, 'knowledge_limit'), false);
  assert.match(options.headers['Idempotency-Key'], /^demand-analysis-/);
  assert.match(options.headers['X-Request-Id'], /^demand-analysis-request-/);
  assert.equal(context.isCurrentDemandAnalysisRequest(request), true);

  const duplicate = context.beginDemandAnalysisRequest();
  assert.equal(duplicate, null, 'a second submission must not create another idempotency key while the first is in flight');
  context.finishDemandAnalysisRequest(request);
  const newer = context.beginDemandAnalysisRequest();
  assert.equal(context.isCurrentDemandAnalysisRequest(request), false);
  assert.equal(context.isCurrentDemandAnalysisRequest(newer), true);
  context.invalidateDemandAnalysisRequests();
  assert.equal(context.isCurrentDemandAnalysisRequest(newer), false);
});

test('unlinked demand analysis remains compatible without campaign-only headers', () => {
  const context = loadDemandHelpers(null);
  const request = context.beginDemandAnalysisRequest();
  const options = context.buildDemandAnalysisRequestOptions('Brand: Acme', 'Analyze', '', request);
  const body = JSON.parse(options.body);

  assert.equal(Object.hasOwn(body, 'campaign_id'), false);
  assert.equal(Object.hasOwn(options, 'headers'), false);
  assert.equal(body.allow_web, false);
});

test('demand analysis captures linked and legacy knowledge references with escaped evidence', () => {
  const context = loadDemandHelpers(42);
  const audit = context.captureDemandAnalysisAudit({
    conversation_id: 91,
    message_id: 92,
    reason: 'private provider detail',
    knowledge_references: [
      { entry_id: 7, citation_label: 'KB-1', title: '<script>alert(1)</script>' },
      { id: 8, title: 'Legacy playbook' },
      { entry_id: 7, title: 'Duplicate chunk' },
      { entry_id: 'invalid', title: 'Invalid reference' }
    ]
  }, 42);
  const html = context.renderDemandAnalysisEvidence(audit);

  assert.equal(audit.campaign_id, 42);
  assert.equal(audit.conversation_id, 91);
  assert.equal(audit.message_id, 92);
  assert.deepEqual(Array.from(audit.knowledge_entry_ids), [7, 8]);
  assert.deepEqual(context.remembered, [7, 8]);
  assert.match(html, /活动 #42/);
  assert.match(html, /对话 #91/);
  assert.match(html, /消息 #92/);
  assert.match(html, /KB-1/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|private provider detail|Invalid reference/);
});

test('workflow context changes invalidate pending analysis and isolate campaign knowledge selection', () => {
  const context = loadWorkflowContextHelpers();

  context.setWorkflowContext({ campaign_id: 12 });
  assert.equal(context.activeWorkflowContext.campaign_id, 12);
  assert.equal(context.demandAnalysisRequestGeneration, 5);
  assert.equal(context.demandAnalysisInFlight, false);
  assert.equal(context.lastDemandAnalysisAI, null);
  assert.deepEqual(Array.from(context.selectedKnowledgeEntryIds), []);
  assert.equal(context.selectedKnowledgeCampaignId, 12);
  assert.equal(context.currentAIConversationId, null);

  context.rememberKnowledgeEntryForChat(8);
  assert.deepEqual(Array.from(context.getSelectedKnowledgeEntryIds()), [8]);
  context.setWorkflowContext({ campaign_id: 12 });
  assert.deepEqual(Array.from(context.getSelectedKnowledgeEntryIds()), [8], 'same-campaign context refresh keeps its own selected knowledge');

  context.setWorkflowContext({ campaign_id: 13 });
  assert.deepEqual(Array.from(context.getSelectedKnowledgeEntryIds()), [], 'switching campaigns cannot carry prior knowledge IDs');
});

test('actual demand analysis coalesces duplicate submits and ignores a stale campaign response', async () => {
  const context = loadDemandAnalysisRuntime(11);
  context.elements.analysisOut.innerHTML = 'untouched';

  const first = context.analyzeDemandAI();
  assert.equal(context.pending.length, 1);
  assert.equal(context.elements.btnAnalyzeAI.disabled, true);

  await context.analyzeDemandAI();
  assert.equal(context.pending.length, 1, 'duplicate click must not start a second fetch');

  context.setWorkflowContext({ campaign_id: 12 });
  context.elements.btnAnalyzeAI.disabled = false;
  const second = context.analyzeDemandAI();
  assert.equal(context.pending.length, 2);
  assert.equal(context.elements.btnAnalyzeAI.disabled, true);

  context.pending[0].resolve(demandResponse(11, 101));
  await first;
  assert.equal(context.elements.analysisOut.innerHTML, 'untouched');
  assert.equal(context.elements.btnAnalyzeAI.disabled, true, 'stale completion cannot release the current request button');

  context.pending[1].resolve(demandResponse(12, 201));
  await second;
  assert.match(context.elements.analysisOut.innerHTML, /活动 #12/);
  assert.doesNotMatch(context.elements.analysisOut.innerHTML, /活动 #11|Campaign 11 knowledge/);
  assert.equal(context.elements.btnAnalyzeAI.disabled, false);
  assert.equal(context.elements.m3s1.classList.contains('hidden'), true);
  assert.equal(context.elements.m3s2.classList.contains('hidden'), false);
});

test('actual demand analysis releases its submit lock after a current request failure', async () => {
  const context = loadDemandAnalysisRuntime(21);
  const operation = context.analyzeDemandAI();
  context.pending[0].resolve({
    ok: false,
    status: 500,
    async json() { return { error: 'Safe demand failure' }; }
  });

  await operation;
  assert.equal(context.elements.aiAnalyzeHint.textContent, 'Failed');
  assert.match(context.elements.demandFileStatus.innerHTML, /Safe demand failure/);
  assert.equal(context.elements.btnAnalyzeAI.disabled, false);

  context.analyzeDemandAI();
  assert.equal(context.pending.length, 2, 'a retry may start after the failed request releases its lock');
});

test('M3 applies response-generation fencing and carries audit references into demand context', () => {
  const analyzeBody = functionBody('analyzeDemandAI');
  const syncBody = functionBody('syncCurDemandFromAnalysis');
  const resetBody = functionBody('resetDemand');

  assert.match(analyzeBody, /var requestContext = beginDemandAnalysisRequest\(\);/);
  assert.match(analyzeBody, /if \(!requestContext\) return;/);
  assert.match(analyzeBody, /buildDemandAnalysisRequestOptions\(source, prompt, uploadedDemandFileName, requestContext\)/);
  assert.ok(
    (analyzeBody.match(/if \(!isCurrentDemandAnalysisRequest\(requestContext\)\) return;/g) || []).length >= 2,
    'both success and failure paths must ignore stale responses'
  );
  assert.match(analyzeBody, /captureDemandAnalysisAudit\(d\.ai, requestContext\.campaignId\)/);
  assert.match(analyzeBody, /renderDemandAnalysisEvidence\(lastDemandAnalysisAI\)/);
  assert.match(analyzeBody, /finally\s*\{/);
  assert.match(analyzeBody, /finishDemandAnalysisRequest\(requestContext\);/);

  assert.match(syncBody, /campaign_id:\s*campaignId \|\| ''/);
  assert.match(syncBody, /demand_analysis_conversation_id:/);
  assert.match(syncBody, /demand_analysis_message_id:/);
  assert.match(syncBody, /knowledge_entry_ids:/);

  assert.match(resetBody, /invalidateDemandAnalysisRequests\(\);/);
  assert.match(resetBody, /lastDemandAnalysisAI\s*=\s*null;/);
});
