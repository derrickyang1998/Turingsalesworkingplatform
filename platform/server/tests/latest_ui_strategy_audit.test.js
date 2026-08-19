const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const latestUiCompat = require('../services/latest_ui_compat_service');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-strategy-ai-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

test('strategy keeps default web behavior and includes prompt plus input in the audited request', async () => {
  let captured = null;
  const aiResult = {
    conversation_id: 41,
    message_id: 42,
    answer: 'Audited strategy',
    model: 'deepseek-chat',
    usage: { total_tokens: 12 },
    knowledge_references: [],
    web_results: [],
    web_search: { used: false, provider: 'tavily', reason: 'not configured' },
    degraded: false,
    reason: '',
    archived_summary_id: 43
  };

  const result = await latestUiCompat.generateStrategy(
    {},
    { id: 2, role: 'user' },
    'Develop an overseas creator strategy.',
    'Brand: Aurora\nProduct: Solar Kit',
    {
      knowledgeLimit: 0,
      aiService: {
        async handleChat(actualDb, options) {
          captured = { actualDb, options };
          return aiResult;
        }
      }
    }
  );

  assert.equal(captured.options.allowWeb, true);
  assert.equal(captured.options.source_module, 'strategy');
  assert.equal(captured.options.summaryVisibility, 'team');
  assert.equal(captured.options.knowledgeLimit, 8);
  assert.equal(captured.options.max_tokens, 2500);
  assert.match(captured.options.message, /Develop an overseas creator strategy/);
  assert.match(captured.options.message, /Brand: Aurora/);
  assert.equal(captured.options.ragQuery, captured.options.message);
  assert.equal(captured.options.webQuery, captured.options.message);
  assert.equal(result.content, 'Audited strategy');
  assert.equal(result.fallback, false);
  assert.equal(result.warning, '');
  assert.equal(result.ai, aiResult);
});

test('strategy route forwards explicit web, visibility, and knowledge controls', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeStart = serverSource.indexOf("app.post('/api/ai/strategy'");
  const routeEnd = serverSource.indexOf("app.post('/api/ai/demand-analysis'", routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const route = serverSource.slice(routeStart, routeEnd);

  assert.match(route, /allowWeb:\s*boolParam\(req\.body\.allow_web,\s*true\)/);
  assert.match(route, /knowledgeLimit:\s*req\.body\.knowledge_limit\s*[,}]/);
  assert.match(route, /summaryVisibility:\s*req\.body\.summary_visibility\s*\|\|\s*'team'/);
});

test('strategy accepts integer limits and defaults out-of-range or non-scalar values', async () => {
  const capturedLimits = [];
  const aiService = {
    async handleChat(actualDb, options) {
      capturedLimits.push(options.knowledgeLimit);
      return { answer: 'Strategy', degraded: false, reason: '' };
    }
  };

  await latestUiCompat.generateStrategy({}, { id: 2, role: 'user' }, 'Prompt', 'Input', {
    knowledgeLimit: 100,
    aiService
  });
  await latestUiCompat.generateStrategy({}, { id: 2, role: 'user' }, 'Prompt', 'Input', {
    knowledgeLimit: 101,
    aiService
  });
  await latestUiCompat.generateStrategy({}, { id: 2, role: 'user' }, 'Prompt', 'Input', {
    knowledgeLimit: '100',
    aiService
  });
  await latestUiCompat.generateStrategy({}, { id: 2, role: 'user' }, 'Prompt', 'Input', {
    knowledgeLimit: ' 100 ',
    aiService
  });
  await latestUiCompat.generateStrategy({}, { id: 2, role: 'user' }, 'Prompt', 'Input', {
    knowledgeLimit: true,
    aiService
  });
  await latestUiCompat.generateStrategy({}, { id: 2, role: 'user' }, 'Prompt', 'Input', {
    knowledgeLimit: [7],
    aiService
  });

  assert.deepEqual(capturedLimits, [100, 8, 100, 8, 8, 8]);
});

test('strategy disables web explicitly and persists only authorized knowledge references', async () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');
  const accessible = knowledge.ingestKnowledge(db, {
    title: 'Aurora strategy playbook',
    content: 'Use scenario-led creator reviews and a 60-30-10 budget split.',
    entry_type: 'methodology',
    visibility: 'team',
    created_by: 1
  });
  knowledge.ingestKnowledge(db, {
    title: 'Private Aurora strategy note',
    content: 'This private note belongs to another user.',
    entry_type: 'methodology',
    visibility: 'private',
    created_by: 3
  });
  let providerMessages = null;
  let webCalls = 0;

  try {
    const result = await latestUiCompat.generateStrategy(
      db,
      { id: 2, role: 'user' },
      'Use the Aurora strategy playbook.',
      'Brand: Aurora\nProduct: Solar Kit',
      {
        allowWeb: false,
        knowledgeLimit: 5,
        summaryVisibility: 'private',
        provider: {
          async complete(request) {
            providerMessages = request.messages;
            return {
              content: 'Use scenario-led reviews with phased creator investment.',
              usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
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
    assert.match(providerMessages[0].content, /Aurora strategy playbook/);
    assert.doesNotMatch(providerMessages[0].content, /Private Aurora strategy note/);
    assert.deepEqual(result.ai.knowledge_references.map((item) => item.id), [accessible.id]);
    assert.equal(result.ai.web_search.used, false);
    assert.equal(result.fallback, true);
    assert.equal(result.warning, 'provider partial response');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_conversations').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='knowledge'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='web'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM token_usage WHERE endpoint='ai_chat' AND total_tokens=16").get().count, 1);
    const summary = db.prepare("SELECT visibility,business_type FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get();
    assert.equal(summary.visibility, 'private');
    assert.equal(summary.business_type, 'strategy');
  } finally {
    db.close();
  }
});
