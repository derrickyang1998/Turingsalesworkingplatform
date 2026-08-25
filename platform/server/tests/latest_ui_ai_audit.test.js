const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const latestUiCompat = require('../services/latest_ui_compat_service');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-demand-ai-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  const db = require(dbModule);
  return {
    db,
    close() {
      db.close();
      delete require.cache[dbModule];
      if (previousDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = previousDbPath;
      [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach(function(filePath) {
        try { fs.unlinkSync(filePath); } catch (_error) {}
      });
    }
  };
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
        campaignId: 23,
        idempotencyKey: 'demand-analysis-test-key',
        requestId: 'demand-analysis-test-request',
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
    assert.equal(captured.options.campaign_id, 23);
    assert.equal(captured.options.idempotencyKey, 'demand-analysis-test-key');
    assert.equal(captured.options.requestId, 'demand-analysis-test-request');
    assert.equal(captured.options.business_type, undefined);
    assert.equal(captured.options.business_id, undefined);
    assert.equal(captured.options.knowledgeLimit, 8);
    assert.equal(captured.options.archiveSummary, false);
    assert.equal(captured.options.atomicOneShot, true);
    assert.equal(typeof captured.options.validateCompletion, 'function');
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

test('demand analysis accepts one JSON object wrapped in provider commentary', async () => {
  const wrappedAnswer = [
    'I analyzed the request. The structured result is:',
    JSON.stringify({
      brand: 'Acme',
      product: 'Portable power station',
      platforms: ['TikTok'],
      competitors: [],
      requirements: ['Creator review']
    }),
    'This result is ready for the next workflow step.'
  ].join('\n');
  let completionWasAccepted = false;

  const result = await latestUiCompat.generateDemandAnalysis(
    'Analyze demand.',
    'Brand: Acme',
    'brief.xlsx',
    {
      db: {},
      user: { id: 17, role: 'member' },
      aiService: {
        async handleChat(_db, options) {
          completionWasAccepted = options.validateCompletion(wrappedAnswer);
          return {
            answer: wrappedAnswer,
            degraded: false,
            reason: '',
            knowledge_references: [],
            web_results: [],
            web_search: { used: false, provider: 'tavily', reason: 'disabled' }
          };
        }
      }
    }
  );

  assert.equal(completionWasAccepted, true);
  assert.equal(result.analysis.brand, 'Acme');
  assert.deepEqual(result.analysis.platforms, ['TikTok']);
  assert.equal(result.fallback, false);
  assert.equal(result.warning, '');
});

test('demand analysis route forwards campaign audit controls and fixes the retrieval limit', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeStart = serverSource.indexOf("app.post('/api/ai/demand-analysis'");
  const routeEnd = serverSource.indexOf("app.post('/api/ai/ppt-outline'", routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const route = serverSource.slice(routeStart, routeEnd);

  assert.match(route, /allowWeb:\s*boolParam\(body\.allow_web,\s*false\)/);
  assert.match(route, /campaignId:\s*body\.campaign_id/);
  assert.match(route, /idempotencyKey:\s*req\.get\('Idempotency-Key'\)/);
  assert.match(route, /requestId:\s*campaignLinkRequestId\(req\)/);
  assert.match(route, /knowledgeLimit:\s*8/);
  assert.doesNotMatch(route, /body\.knowledge_limit/);
  assert.doesNotMatch(route, /ingestKnowledge/);
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
            reason: 'AI response format invalid',
            knowledge_references: [],
            web_results: [],
            web_search: { used: false, provider: 'tavily', reason: 'disabled' }
          };
        }
      }
    }
  );

  assert.equal(result.fallback, true);
  assert.equal(result.warning, 'AI response format invalid');
});

test('unlinked demand analysis is atomic, private-only, and does not archive an unconfirmed summary', async () => {
  const fixture = freshDb();
  const db = fixture.db;
  const knowledge = require('../services/knowledge_service');
  const accessible = knowledge.ingestKnowledge(db, {
    title: '需求分析手册',
    content: '需求分析应优先选择真实场景测评达人。',
    entry_type: 'methodology',
    visibility: 'private',
    created_by: 2
  });
  knowledge.ingestKnowledge(db, {
    title: '需求分析其他团队记录',
    content: '需求分析其他团队内容。',
    entry_type: 'methodology',
    visibility: 'team',
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
        knowledgeLimit: -1,
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
              reason: 'internal provider detail that must not escape'
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
    assert.doesNotMatch(providerMessages[0].content, /需求分析其他团队记录/);
    assert.deepEqual(result.ai.knowledge_references.map((item) => item.id), [accessible.id]);
    assert.equal(result.ai.web_search.used, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_conversations').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='knowledge'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='web'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get().count, 0);
    assert.equal(result.fallback, true);
    assert.equal(result.warning, 'AI provider returned a degraded response');
    assert.equal(result.ai.degraded, true);
    assert.equal(result.ai.reason, 'AI provider returned a degraded response');
    assert.equal(result.ai.status, 'degraded');
    assert.equal(Number.isSafeInteger(result.ai.latency_ms), true);

    const assistant = db.prepare("SELECT metadata_json FROM ai_messages WHERE role='assistant'").get();
    const metadata = JSON.parse(assistant.metadata_json);
    assert.equal(metadata.degraded, true);
    assert.equal(metadata.reason, 'AI provider returned a degraded response');
    assert.equal(metadata.status, 'degraded');
  } finally {
    fixture.close();
  }
});

test('unlinked demand analysis records a complete safe fallback when the provider throws', async () => {
  const fixture = freshDb();
  const db = fixture.db;
  try {
    const result = await latestUiCompat.generateDemandAnalysis(
      'Analyze demand.',
      'Brand: Acme',
      'brief.xlsx',
      {
        db,
        user: { id: 2, role: 'user' },
        allowWeb: false,
        provider: {
          async complete() {
            throw new Error('socket path and credential detail must not escape');
          }
        }
      }
    );

    assert.equal(result.fallback, true);
    assert.equal(result.warning, 'AI provider unavailable');
    assert.equal(result.ai.status, 'degraded');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_conversations').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get().count, 2);
    const assistant = db.prepare("SELECT content,metadata_json FROM ai_messages WHERE role='assistant'").get();
    assert.doesNotMatch(assistant.content, /socket path|credential detail/i);
    assert.deepEqual(JSON.parse(assistant.metadata_json).status, 'degraded');
  } finally {
    fixture.close();
  }
});

test('unlinked demand analysis enforces a provider deadline and still completes its audit row', async () => {
  const fixture = freshDb();
  const db = fixture.db;
  try {
    const operation = latestUiCompat.generateDemandAnalysis(
      'Analyze demand.',
      'Brand: Acme',
      'brief.xlsx',
      {
        db,
        user: { id: 2, role: 'user' },
        allowWeb: false,
        operationTimeoutMs: 20,
        provider: { complete() { return new Promise(function() {}); } }
      }
    );
    const result = await Promise.race([
      operation,
      new Promise(function(_resolve, reject) {
        setTimeout(function() { reject(new Error('demand analysis deadline was not enforced')); }, 250);
      })
    ]);

    assert.equal(result.fallback, true);
    assert.equal(result.warning, 'AI provider unavailable');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get().count, 2);
  } finally {
    fixture.close();
  }
});

test('legacy chat keeps its public response shape unless completion state is requested', async () => {
  const fixture = freshDb();
  const db = fixture.db;
  const ai = require('../services/ai_service');
  try {
    const result = await ai.handleChat(db, {
      user: { id: 2, role: 'user' },
      message: 'shape contract',
      allowWeb: false,
      archiveSummary: false,
      provider: {
        async complete() {
          return {
            content: 'degraded response',
            usage: {},
            model: 'shape-test',
            degraded: true,
            reason: 'private provider detail'
          };
        }
      }
    });

    assert.equal(Object.hasOwn(result, 'degraded'), false);
    assert.equal(Object.hasOwn(result, 'reason'), false);
    assert.equal(Object.hasOwn(result, 'status'), false);
  } finally {
    fixture.close();
  }
});
