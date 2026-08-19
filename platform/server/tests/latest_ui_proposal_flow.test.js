const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

  const resetStart = appSource.indexOf('function resetDemand(');
  const resetEnd = appSource.indexOf('\n}', resetStart);
  assert.notEqual(resetStart, -1);
  const resetBlock = appSource.slice(resetStart, resetEnd);
  assert.match(resetBlock, /activeWorkflowContext\s*=\s*null/);
  assert.match(resetBlock, /lastProposalContext\s*=\s*null/);
  assert.match(resetBlock, /proposalGenerationSequence\s*\+=\s*1/);

  const workflowStart = appSource.indexOf('function fillWorkflowDemand(');
  const workflowEnd = appSource.indexOf('function fillWorkflowInfluencers', workflowStart);
  const workflowBlock = appSource.slice(workflowStart, workflowEnd);
  assert.match(workflowBlock, /resetDemand\(\);[\s\S]*setWorkflowContext\(context\)/);

  const switchStart = appSource.indexOf('function switchPage(');
  const switchEnd = appSource.indexOf('\n}', switchStart);
  const switchBlock = appSource.slice(switchStart, switchEnd);
  assert.match(switchBlock, /id\s*===\s*'m3'[\s\S]*activeWorkflowContext\s*=\s*null/);
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
