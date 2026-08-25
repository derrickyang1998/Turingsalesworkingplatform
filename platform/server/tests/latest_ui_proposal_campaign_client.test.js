'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', '..', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const serverPath = path.join(__dirname, '..', 'server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');
const aiService = require('../services/ai_service');

function extractFunction(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
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

function createRuntime(initialCampaignId = 12) {
  const elements = {
    proposalOutput: { innerHTML: '' },
    btnGenerateProposal: { disabled: false }
  };
  const pending = [];
  const toasts = [];
  let similarKnowledgeCalls = 0;
  let campaignId = initialCampaignId;
  let uuid = 0;
  const context = {
    window: {
      crypto: {
        randomUUID() {
          uuid += 1;
          return `proposal-${uuid}`;
        }
      }
    },
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    curDemand: {
      campaign_id: initialCampaignId,
      brand: 'Acme',
      company: 'Acme Inc',
      product: 'Power station',
      usp: 'Fast charging',
      platform: 'TikTok',
      area: 'US',
      budget: 'USD 50,000',
      category: 'Consumer electronics',
      demand_analysis_conversation_id: 101,
      demand_analysis_message_id: 102,
      knowledge_entry_ids: [7, 8, 7, 'bad']
    },
    selTpl: 'growth',
    lastProp: '',
    lastProposalAI: null,
    proposalRequestGeneration: 0,
    proposalInFlight: false,
    activeWorkflowContext: { campaign_id: initialCampaignId },
    getActiveCampaignId() { return campaignId; },
    setCampaignId(value) {
      campaignId = value;
      context.activeWorkflowContext.campaign_id = value;
      context.curDemand.campaign_id = value;
    },
    readPositiveInteger(value) {
      if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
      if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    },
    createDemandAnalysisOperationId(prefix) {
      return String(prefix || '') + context.window.crypto.randomUUID();
    },
    getSelectedProposalTemplate() {
      return {
        id: 'growth',
        name: '增长方案',
        description: '面向新品增长',
        sections: ['执行摘要', '达人策略', '预算与 KPI']
      };
    },
    async fetchSimilarKnowledge() {
      similarKnowledgeCalls += 1;
      return [];
    },
    apiFetch(url, options) {
      return new Promise((resolve) => pending.push({ url, options, resolve }));
    },
    renderKnowledgeReuse() { return ''; },
    esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    toast(message, type) { toasts.push({ message, type }); }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext([
    extractFunction(appSource, 'beginProposalDraftRequest'),
    extractFunction(appSource, 'isCurrentProposalDraftRequest'),
    extractFunction(appSource, 'finishProposalDraftRequest'),
    extractFunction(appSource, 'invalidateProposalDraftRequests'),
    extractFunction(appSource, 'buildProposalDemandContent'),
    extractFunction(appSource, 'buildProposalDraftRequestOptions'),
    extractFunction(appSource, 'normalizeDemandAnalysisAudit'),
    extractFunction(appSource, 'captureProposalDraftAudit'),
    extractFunction(appSource, 'renderDemandAnalysisEvidence'),
    extractFunction(appSource, 'renderProposalDraftEvidence'),
    extractFunction(appSource, 'buildLocalProposalDraft'),
    extractFunction(appSource, 'renderProposalDraftResult'),
    extractFunction(appSource, 'generateProposal')
  ].join('\n'), context, { filename: appPath });
  context.elements = elements;
  context.pending = pending;
  context.toasts = toasts;
  context.getSimilarKnowledgeCalls = () => similarKnowledgeCalls;
  return context;
}

function successResponse(campaignId, conversationId, answer) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        draft: answer,
        demand_entry: null,
        ai: {
          conversation_id: conversationId,
          message_id: conversationId + 1,
          knowledge_references: [{
            entry_id: campaignId,
            citation_label: 'KB-1',
            title: '<script>unsafe</script>'
          }],
          web_search: { used: false, provider: 'tavily', reason: 'disabled' },
          archived_summary_id: null
        }
      };
    }
  };
}

test('linked proposal draft sends Campaign RAG controls and audited demand context', async () => {
  const context = createRuntime(12);
  const operation = context.generateProposal();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(context.pending.length, 1);
  assert.equal(context.getSimilarKnowledgeCalls(), 0, 'linked proposal must not call the legacy unscoped similar-knowledge endpoint');
  const request = context.pending[0];
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, '/ai/proposal-draft');
  assert.equal(body.campaign_id, 12);
  assert.equal(body.allow_web, false);
  assert.deepEqual(body.knowledge_entry_ids, [7, 8]);
  assert.equal(body.demand_analysis_conversation_id, 101);
  assert.equal(body.demand_analysis_message_id, 102);
  assert.deepEqual(body.template.sections, ['执行摘要', '达人策略', '预算与 KPI']);
  assert.equal(Object.hasOwn(body, 'knowledge_limit'), false);
  assert.match(request.options.headers['Idempotency-Key'], /^proposal-draft-/);
  assert.match(request.options.headers['X-Request-Id'], /^proposal-draft-request-/);
  assert.equal(context.elements.btnGenerateProposal.disabled, true);

  context.pending[0].resolve(successResponse(12, 201, '# AI Campaign Proposal'));
  await operation;

  assert.equal(context.lastProp, '# AI Campaign Proposal');
  assert.equal(context.curDemand.proposal_conversation_id, 201);
  assert.equal(context.curDemand.proposal_message_id, 202);
  assert.deepEqual(Array.from(context.curDemand.proposal_knowledge_entry_ids), [12]);
  assert.match(context.elements.proposalOutput.innerHTML, /知识依据与 AI 审计/);
  assert.match(context.elements.proposalOutput.innerHTML, /活动 #12/);
  assert.match(context.elements.proposalOutput.innerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(context.elements.proposalOutput.innerHTML, /<script>/);
  assert.equal(context.elements.btnGenerateProposal.disabled, false);
});

test('proposal draft coalesces duplicate clicks and ignores stale Campaign responses', async () => {
  const context = createRuntime(31);
  const first = context.generateProposal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.pending.length, 1);

  await context.generateProposal();
  assert.equal(context.pending.length, 1, 'duplicate click must share the in-flight operation');

  context.invalidateProposalDraftRequests();
  assert.equal(context.elements.btnGenerateProposal.disabled, false, 'context invalidation must make the real submit control usable');
  context.setCampaignId(32);
  const second = context.generateProposal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.pending.length, 2);

  context.pending[0].resolve(successResponse(31, 301, '# Stale Proposal'));
  await first;
  assert.doesNotMatch(context.elements.proposalOutput.innerHTML, /Stale Proposal/);
  assert.equal(context.elements.btnGenerateProposal.disabled, true);

  context.pending[1].resolve(successResponse(32, 401, '# Current Proposal'));
  await second;
  assert.equal(context.lastProp, '# Current Proposal');
  assert.match(context.elements.proposalOutput.innerHTML, /活动 #32/);
  assert.doesNotMatch(context.elements.proposalOutput.innerHTML, /活动 #31/);
  assert.equal(context.elements.btnGenerateProposal.disabled, false);
});

test('proposal draft keeps the editable local proposal when the AI request fails', async () => {
  const context = createRuntime(null);
  const operation = context.generateProposal();
  await new Promise((resolve) => setImmediate(resolve));
  const requestBody = JSON.parse(context.pending[0].options.body);
  assert.equal(Object.hasOwn(requestBody, 'campaign_id'), false);
  assert.equal(Object.hasOwn(context.pending[0].options, 'headers'), false);
  assert.equal(context.getSimilarKnowledgeCalls(), 2, 'unlinked legacy proposal keeps its existing similar-case lookup');

  context.pending[0].resolve({
    ok: false,
    status: 503,
    async json() { return { error: 'AI proposal service unavailable.' }; }
  });
  await operation;

  assert.match(context.lastProp, /Acme 红人营销方案/);
  assert.match(context.elements.proposalOutput.innerHTML, /AI 服务暂不可用，已保留可编辑的基础方案/);
  assert.match(context.elements.proposalOutput.innerHTML, /textarea/);
  assert.equal(context.elements.btnGenerateProposal.disabled, false);
});

test('proposal route uses fixed private Campaign RAG without archiving an unconfirmed draft', () => {
  const routeStart = serverSource.indexOf("app.post('/api/ai/proposal-draft'");
  const routeEnd = serverSource.indexOf('// ===== LATEST UI COMPATIBILITY ROUTES =====', routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const route = serverSource.slice(routeStart, routeEnd);

  assert.match(route, /const linkedRequest = hasCampaignId\(body\)/);
  assert.match(route, /campaign_id:\s*body\.campaign_id/);
  assert.match(route, /idempotencyKey:\s*req\.get\('Idempotency-Key'\)/);
  assert.match(route, /requestId:\s*campaignLinkRequestId\(req\)/);
  assert.match(route, /knowledge_entry_ids:\s*body\.knowledge_entry_ids/);
  assert.match(route, /knowledgeLimit:\s*8/);
  assert.match(route, /allowWeb:\s*false/);
  assert.match(route, /archiveSummary:\s*false/);
  assert.match(route, /atomicOneShot:\s*true/);
  assert.match(route, /source_module:\s*'proposal'/);
  assert.match(route, /verifyDemandAnalysisAuditContext/);
  assert.match(route, /if \(!linkedRequest\)[\s\S]*knowledgeService\.ingestKnowledge/);
  assert.match(route, /if \(linkedRequest\) return sendAiChatError\(req, res, e\)/);
  assert.doesNotMatch(route, /body\.knowledge_limit/);
  assert.doesNotMatch(route, /summaryVisibility/);
});

test('verified demand audit context requires the exact linked Campaign conversation and assistant message', () => {
  const conversation = {
    id: 21,
    user_id: 5,
    source_module: 'demand_analysis',
    messages: [{
      id: 22,
      conversation_id: 21,
      user_id: 5,
      role: 'assistant',
      metadata: { campaign_id: 12 }
    }]
  };
  let readCount = 0;
  const result = aiService.verifyDemandAnalysisAuditContext({}, {
    user: { id: 5, role: 'user' },
    authContext: {},
    requestId: 'proposal-audit-test',
    campaign_id: 12,
    conversation_id: 21,
    message_id: 22,
    resolveConversationCampaignFn() {
      return { ok: true, campaignId: 12, derived: true };
    },
    getConversationFn() {
      readCount += 1;
      return conversation;
    }
  });

  assert.deepEqual(result, { conversation_id: 21, message_id: 22 });
  assert.equal(readCount, 1);
});

test('demand audit context rejects incomplete, foreign, or misleading provenance', () => {
  const base = {
    user: { id: 5, role: 'user' },
    campaign_id: 12,
    conversation_id: 21,
    message_id: 22,
    resolveConversationCampaignFn() {
      return { ok: true, campaignId: 12, derived: true };
    },
    getConversationFn() {
      return {
        id: 21,
        user_id: 5,
        source_module: 'demand_analysis',
        messages: [{ id: 22, conversation_id: 21, user_id: 5, role: 'assistant', metadata: { campaign_id: 12 } }]
      };
    }
  };

  assert.throws(
    () => aiService.verifyDemandAnalysisAuditContext({}, { ...base, message_id: undefined }),
    (error) => error.code === 'INVALID_DEMAND_AUDIT_CONTEXT'
  );
  assert.throws(
    () => aiService.verifyDemandAnalysisAuditContext({}, {
      ...base,
      resolveConversationCampaignFn() { return { ok: true, campaignId: 13, derived: true }; }
    }),
    (error) => error.code === 'DEMAND_AUDIT_CAMPAIGN_MISMATCH'
  );
  assert.throws(
    () => aiService.verifyDemandAnalysisAuditContext({}, {
      ...base,
      getConversationFn() { return { ...base.getConversationFn(), source_module: 'assistant' }; }
    }),
    (error) => error.code === 'INVALID_DEMAND_AUDIT_CONTEXT'
  );
  assert.throws(
    () => aiService.verifyDemandAnalysisAuditContext({}, {
      ...base,
      getConversationFn() {
        const value = base.getConversationFn();
        value.messages[0].metadata.campaign_id = 13;
        return value;
      }
    }),
    (error) => error.code === 'DEMAND_AUDIT_CAMPAIGN_MISMATCH'
  );
});
