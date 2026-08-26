'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const latestUiCompat = require('../services/latest_ui_compat_service');
const aiService = require('../services/ai_service');

const appPath = path.join(__dirname, '..', '..', 'app.js');
const serverPath = path.join(__dirname, '..', 'server.js');

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

test('Campaign PPT request enrichment carries audited demand, proposal, and selected knowledge without touching ppt.js', () => {
  const appSource = fs.readFileSync(appPath, 'utf8');
  const context = {
    curDemand: {
      campaign_id: 12,
      demand_analysis_conversation_id: 101,
      demand_analysis_message_id: 102,
      proposal_conversation_id: 201,
      proposal_message_id: 202,
      knowledge_entry_ids: [7, 8, 7],
      proposal_knowledge_entry_ids: [9, 8]
    },
    lastDemandAnalysisAI: null,
    lastProposalAI: null,
    getActiveCampaignId() { return 12; },
    getSelectedKnowledgeEntryIds() { return [10, 9]; },
    readPositiveInteger(value) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    },
    createDemandAnalysisOperationId(prefix) { return `${prefix}fixed-operation`; }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(extractFunction(appSource, 'prepareCampaignPptOutlineRequest'), context);

  const original = {
    method: 'POST',
    body: JSON.stringify({
      demand: { brand: 'Acme', knowledge_entry_ids: [7] },
      proposal: '# Editable proposal',
      allow_web: true,
      knowledge_limit: 99
    })
  };
  const prepared = context.prepareCampaignPptOutlineRequest('/ai/ppt-outline', original);
  const body = JSON.parse(prepared.body);

  assert.notEqual(prepared, original);
  assert.equal(JSON.parse(original.body).campaign_id, undefined);
  assert.equal(body.campaign_id, 12);
  assert.equal(body.demand_analysis_conversation_id, 101);
  assert.equal(body.demand_analysis_message_id, 102);
  assert.equal(body.proposal_conversation_id, 201);
  assert.equal(body.proposal_message_id, 202);
  assert.deepEqual(Array.from(body.knowledge_entry_ids), [7, 8, 9, 10]);
  assert.equal(body.allow_web, false);
  assert.equal(Object.hasOwn(body, 'knowledge_limit'), false);
  assert.equal(prepared.headers['Idempotency-Key'], 'ppt-outline-fixed-operation');
  assert.equal(prepared.headers['X-Request-Id'], 'ppt-outline-request-fixed-operation');
});

test('unlinked PPT request enrichment preserves the legacy payload', () => {
  const appSource = fs.readFileSync(appPath, 'utf8');
  const context = {
    curDemand: null,
    lastDemandAnalysisAI: null,
    lastProposalAI: null,
    getActiveCampaignId() { return null; },
    getSelectedKnowledgeEntryIds() { return []; },
    readPositiveInteger() { return null; },
    createDemandAnalysisOperationId(prefix) { return `${prefix}unused`; }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(extractFunction(appSource, 'prepareCampaignPptOutlineRequest'), context);
  const original = { method: 'POST', body: JSON.stringify({ demand: { brand: 'Legacy' } }) };

  assert.equal(context.prepareCampaignPptOutlineRequest('/ai/ppt-outline', original), original);
  assert.equal(context.prepareCampaignPptOutlineRequest('/ai/proposal-draft', original), original);
});

test('linked PPT outline uses private Campaign RAG and returns auditable references without archiving a draft', async () => {
  let captured = null;
  const aiResult = {
    conversation_id: 301,
    message_id: 302,
    answer: JSON.stringify({
      title: 'Acme Campaign',
      subtitle: 'Power station / US',
      sections: [{ title: '01 Executive summary', type: 'content', points: ['Use [KB-1]'], note: '' }]
    }),
    model: 'deepseek-chat',
    usage: { prompt_tokens: 11, completion_tokens: 12, total_tokens: 23 },
    knowledge_references: [{ entry_id: 7, citation_label: 'KB-1', title: 'Approved playbook' }],
    web_results: [],
    web_search: { used: false, provider: 'tavily', reason: 'disabled' },
    archived_summary_id: null,
    campaign_id: 12,
    degraded: false,
    reason: ''
  };

  const result = await latestUiCompat.generatePptOutline(
    {},
    { id: 5, role: 'user' },
    {
      demand: { brand: 'Acme', product: 'Power station', market: 'US' },
      proposal: '# Editable proposal',
      knowledge_entry_ids: [7]
    },
    {
      campaignId: 12,
      idempotencyKey: 'ppt-outline-test-key',
      requestId: 'ppt-outline-test-request',
      demandAudit: { conversation_id: 101, message_id: 102 },
      proposalAudit: { conversation_id: 201, message_id: 202 },
      aiService: {
        async handleChat(actualDb, options) {
          captured = { actualDb, options };
          return aiResult;
        }
      }
    }
  );

  assert.equal(captured.actualDb.constructor, Object);
  assert.equal(captured.options.campaign_id, 12);
  assert.equal(captured.options.source_module, 'ppt_outline');
  assert.equal(captured.options.visibility, 'private');
  assert.equal(captured.options.allowWeb, false);
  assert.equal(captured.options.archiveSummary, false);
  assert.equal(captured.options.atomicOneShot, true);
  assert.equal(captured.options.knowledgeLimit, 8);
  assert.deepEqual(captured.options.knowledge_entry_ids, [7]);
  assert.equal(captured.options.idempotencyKey, 'ppt-outline-test-key');
  assert.equal(captured.options.requestId, 'ppt-outline-test-request');
  assert.match(captured.options.message, /需求分析对话 #101/);
  assert.match(captured.options.message, /方案草稿消息 #202/);
  assert.equal(captured.options.validateCompletion(aiResult.answer), true);
  assert.equal(result.outline.title, 'Acme Campaign');
  assert.deepEqual(result.knowledge_references, aiResult.knowledge_references);
  assert.equal(result.ai, aiResult);
  assert.deepEqual(result.research.results, []);
  assert.equal(result.fallback, false);
});

test('proposal audit verifier accepts only the exact assistant message linked to the same Campaign', () => {
  const conversation = {
    id: 201,
    user_id: 5,
    source_module: 'proposal',
    messages: [{
      id: 202,
      conversation_id: 201,
      user_id: 5,
      role: 'assistant',
      metadata: { campaign_id: 12 }
    }]
  };
  const base = {
    user: { id: 5, role: 'user' },
    campaign_id: 12,
    conversation_id: 201,
    message_id: 202,
    getConversationFn() { return conversation; },
    resolveConversationCampaignFn() { return { ok: true, campaignId: 12, derived: true }; }
  };

  assert.deepEqual(
    aiService.verifyProposalDraftAuditContext({}, base),
    { conversation_id: 201, message_id: 202 }
  );
  assert.throws(
    () => aiService.verifyProposalDraftAuditContext({}, { ...base, message_id: undefined }),
    (error) => error.code === 'INVALID_PROPOSAL_AUDIT_CONTEXT'
  );
  assert.throws(
    () => aiService.verifyProposalDraftAuditContext({}, {
      ...base,
      getConversationFn() { return { ...conversation, source_module: 'assistant' }; }
    }),
    (error) => error.code === 'INVALID_PROPOSAL_AUDIT_CONTEXT'
  );
  assert.throws(
    () => aiService.verifyProposalDraftAuditContext({}, {
      ...base,
      resolveConversationCampaignFn() { return { ok: true, campaignId: 13, derived: true }; }
    }),
    (error) => error.code === 'PROPOSAL_AUDIT_CAMPAIGN_MISMATCH'
  );
});

test('PPT outline route forwards Campaign audit controls and uses sanitized linked errors', () => {
  const serverSource = fs.readFileSync(serverPath, 'utf8');
  const routeStart = serverSource.indexOf("app.post('/api/ai/ppt-outline'");
  const routeEnd = serverSource.indexOf('// ===== KNOWLEDGE CATEGORIES =====', routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const route = serverSource.slice(routeStart, routeEnd);

  assert.match(route, /const linkedRequest = hasCampaignId\(body\)/);
  assert.match(route, /verifyDemandAnalysisAuditContext/);
  assert.match(route, /verifyProposalDraftAuditContext/);
  assert.match(route, /campaignId:\s*body\.campaign_id/);
  assert.match(route, /idempotencyKey:\s*req\.get\('Idempotency-Key'\)/);
  assert.match(route, /requestId:\s*campaignLinkRequestId\(req\)/);
  assert.match(route, /knowledgeLimit:\s*8/);
  assert.match(route, /allowWeb:\s*false/);
  assert.match(route, /if \(linkedRequest\) return sendAiChatError\(req, res, e\)/);
  assert.doesNotMatch(route, /body\.knowledge_limit/);
  assert.doesNotMatch(route, /res\.status\(500\)\.json\(\{ error: e\.message \}\)/);
});
