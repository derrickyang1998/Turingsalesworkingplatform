const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const latestUiCompat = require('../services/latest_ui_compat_service');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-demand-ai-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

test('demand analysis uses the auditable knowledge-first AI conversation path', async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = '';
  const db = {};
  const user = { id: 17, role: 'member' };
  let captured = null;
  const aiResult = {
    conversation_id: 91,
    message_id: 92,
    answer: JSON.stringify({
      brand: 'Acme',
      product: 'Portable power station',
      platforms: ['TikTok'],
      competitors: [],
      requirements: ['Creator review']
    }),
    model: 'deepseek-chat',
    usage: { total_tokens: 23 },
    knowledge_references: [{ id: 7, title: 'Approved playbook' }],
    web_results: [{ title: 'Market source', url: 'https://example.com/source' }],
    web_search: { used: true, provider: 'tavily', reason: '' },
    archived_summary_id: 93
  };

  try {
    const result = await latestUiCompat.generateDemandAnalysis(
      'Analyze the demand and return structured JSON.',
      'Brand: Acme\nProduct: Portable power station',
      'brief.xlsx',
      {
        db,
        user,
        allowWeb: true,
        knowledgeLimit: 6,
        aiService: {
          async handleChat(actualDb, options) {
            captured = { actualDb, options };
            return aiResult;
          }
        }
      }
    );

    assert.equal(captured.actualDb, db);
    assert.equal(captured.options.user, user);
    assert.equal(captured.options.allowWeb, true);
    assert.equal(captured.options.source_module, 'demand_analysis');
    assert.equal(captured.options.business_type, undefined);
    assert.equal(captured.options.business_id, undefined);
    assert.equal(captured.options.knowledgeLimit, 6);
    assert.match(captured.options.message, /Return JSON only/i);
    assert.match(captured.options.message, /Brand: Acme/);
    assert.equal(result.analysis.brand, 'Acme');
    assert.deepEqual(result.analysis.platforms, ['TikTok']);
    assert.equal(result.fallback, false);
    assert.equal(result.warning, '');
    assert.equal(result.ai, aiResult);
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('demand analysis route forwards explicit web and knowledge controls', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeStart = serverSource.indexOf("app.post('/api/ai/demand-analysis'");
  const routeEnd = serverSource.indexOf("app.post('/api/ai/ppt-outline'", routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const route = serverSource.slice(routeStart, routeEnd);

  assert.match(route, /allowWeb:\s*boolParam\(req\.body\.allow_web,\s*false\)/);
  assert.match(route, /knowledgeLimit:\s*req\.body\.knowledge_limit\s*\|\|\s*8/);
});

test('demand analysis preserves a provider reason when JSON parsing fails', async () => {
  const result = await latestUiCompat.generateDemandAnalysis(
    'Analyze demand.',
    'Brand: Acme',
    'brief.xlsx',
    {
      db: {},
      user: { id: 17, role: 'member' },
      aiService: {
        async handleChat() {
          return {
            answer: 'The provider returned a partial non-JSON response.',
            degraded: true,
            reason: 'provider response truncated',
            knowledge_references: [],
            web_results: [],
            web_search: { used: false, provider: 'tavily', reason: 'disabled' }
          };
        }
      }
    }
  );

  assert.equal(result.fallback, true);
  assert.equal(result.warning, 'provider response truncated');
});

test('demand analysis persists authorized references and preserves provider degradation', async () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');
  const accessible = knowledge.ingestKnowledge(db, {
    title: '需求分析手册',
    content: '需求分析应优先选择真实场景测评达人。',
    entry_type: 'methodology',
    visibility: 'team',
    created_by: 1
  });
  knowledge.ingestKnowledge(db, {
    title: '需求分析私有记录',
    content: '需求分析私有内容。',
    entry_type: 'methodology',
    visibility: 'private',
    created_by: 3
  });
  let webCalls = 0;
  let providerMessages = null;

  try {
    const result = await latestUiCompat.generateDemandAnalysis(
      '请结合需求分析手册处理客户需求。',
      'Brand: Acme\nProduct: Portable power station',
      'brief.xlsx',
      {
        db,
        user: { id: 2, role: 'user' },
        allowWeb: false,
        knowledgeLimit: 5,
        provider: {
          async complete(request) {
            providerMessages = request.messages;
            return {
              content: JSON.stringify({
                brand: 'Acme',
                product: 'Portable power station',
                platforms: ['TikTok'],
                competitors: [],
                requirements: ['Field-test creators']
              }),
              usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
              model: 'degraded-test-model',
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
    assert.match(providerMessages[0].content, /需求分析手册/);
    assert.doesNotMatch(providerMessages[0].content, /需求分析私有记录/);
    assert.deepEqual(result.ai.knowledge_references.map((item) => item.id), [accessible.id]);
    assert.equal(result.ai.web_search.used, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_conversations').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='knowledge'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='web'").get().count, 0);
    assert.equal(result.fallback, true);
    assert.equal(result.warning, 'provider partial response');
    assert.equal(result.ai.degraded, true);
    assert.equal(result.ai.reason, 'provider partial response');
  } finally {
    db.close();
  }
});
