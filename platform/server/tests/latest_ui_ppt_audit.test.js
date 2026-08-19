const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const latestUiCompat = require('../services/latest_ui_compat_service');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-ppt-ai-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

function validOutline(title) {
  return JSON.stringify({
    title,
    subtitle: 'Solar Kit / US',
    sections: [
      { title: '01 Campaign Brief', type: 'cover', points: ['Solar Kit', 'US'], note: '' },
      { title: '02 Strategy', type: 'content', points: ['Use trusted field-test creators'], note: '' }
    ]
  });
}

test('ppt outline defaults to web-enabled auditable AI without changing the response contract', async () => {
  let captured = null;
  const aiResult = {
    conversation_id: 31,
    message_id: 32,
    answer: validOutline('Aurora Campaign'),
    model: 'deepseek-chat',
    usage: { total_tokens: 20 },
    knowledge_references: [{ id: 7, title: 'Approved case' }],
    web_results: [{ title: 'Market source', url: 'https://example.com/market', snippet: 'Signal' }],
    web_search: { used: true, provider: 'tavily', reason: '' },
    degraded: false,
    reason: '',
    archived_summary_id: 33
  };

  const result = await latestUiCompat.generatePptOutline(
    {},
    { id: 2, role: 'user' },
    {
      demand: { brand: 'Aurora', product: 'Solar Kit', market: 'US' },
      proposal: 'Use the approved internal case.',
      knowledge_limit: 6,
      business_type: 'proposal'
    },
    {
      aiService: {
        async handleChat(actualDb, options) {
          captured = { actualDb, options };
          return aiResult;
        }
      }
    }
  );

  assert.equal(captured.options.allowWeb, true);
  assert.equal(captured.options.source_module, 'ppt_outline');
  assert.equal(captured.options.knowledgeLimit, 6);
  assert.equal(captured.options.business_type, 'proposal');
  assert.equal(captured.options.max_tokens, 3200);
  assert.equal(captured.options.temperature, 0.25);
  assert.match(captured.options.message, /Return JSON only/i);
  assert.match(captured.options.ragQuery, /approved internal case/i);
  assert.match(captured.options.webQuery, /Aurora/);
  assert.equal(result.outline.title, 'Aurora Campaign');
  assert.deepEqual(result.knowledge_references, aiResult.knowledge_references);
  assert.deepEqual(result.outline.knowledge_references, aiResult.knowledge_references);
  assert.equal(result.research.used, true);
  assert.deepEqual(result.outline.research, result.research);
  assert.equal(result.fallback, false);
  assert.equal(result.warning, '');
  assert.equal(result.ai, aiResult);
});

test('ppt outline persists authorized audit references and disables web explicitly', async () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');
  const accessible = knowledge.ingestKnowledge(db, {
    title: 'Approved PPT case method',
    content: 'Use trusted field-test creators and confirmed proposal evidence.',
    entry_type: 'proposal',
    visibility: 'team',
    created_by: 1
  });
  knowledge.ingestKnowledge(db, {
    title: 'Private PPT note',
    content: 'This private note must not enter another user PPT.',
    entry_type: 'proposal',
    visibility: 'private',
    created_by: 3
  });
  let providerMessages = null;
  let webCalls = 0;

  try {
    const result = await latestUiCompat.generatePptOutline(
      db,
      { id: 2, role: 'user' },
      {
        demand: { brand: 'Aurora', product: 'Solar Kit', market: 'US' },
        proposal: 'Apply the Approved PPT case method.',
        allow_web: false,
        knowledge_limit: 5
      },
      {
        provider: {
          async complete(request) {
            providerMessages = request.messages;
            return {
              content: validOutline('Aurora Audited Campaign'),
              usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 },
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
    assert.match(providerMessages[0].content, /Approved PPT case method/);
    assert.doesNotMatch(providerMessages[0].content, /Private PPT note/);
    assert.deepEqual(result.knowledge_references.map((item) => item.id), [accessible.id]);
    assert.equal(result.research.used, false);
    assert.deepEqual(result.research.results, []);
    assert.equal(result.fallback, true);
    assert.equal(result.warning, 'provider partial response');
    assert.equal(result.ai.degraded, true);
    assert.equal(result.ai.reason, 'provider partial response');
    const conversations = db.prepare('SELECT id,user_id,source_module,archived_summary_id FROM ai_conversations').all();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].user_id, 2);
    assert.equal(conversations[0].source_module, 'ppt_outline');
    assert.ok(conversations[0].archived_summary_id > 0);
    const messages = db.prepare(`
      SELECT id,conversation_id,user_id,role,content,model,prompt_tokens,completion_tokens,total_tokens
      FROM ai_messages
      ORDER BY id
    `).all();
    assert.deepEqual(messages.map((item) => item.role), ['user', 'assistant']);
    assert.deepEqual(messages.map((item) => item.conversation_id), [conversations[0].id, conversations[0].id]);
    assert.deepEqual(messages.map((item) => item.user_id), [2, 2]);
    assert.match(messages[0].content, /Create a client-facing overseas influencer marketing PPT outline/);
    assert.match(messages[0].content, /Aurora/);
    assert.match(messages[1].content, /Aurora Audited Campaign/);
    assert.equal(messages[1].model, 'degraded-test-model');
    assert.deepEqual(
      [messages[1].prompt_tokens, messages[1].completion_tokens, messages[1].total_tokens],
      [11, 9, 20]
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='knowledge'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='web'").get().count, 0);
    const tokenUsage = db.prepare(`
      SELECT user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint
      FROM token_usage
      WHERE endpoint='ai_chat'
    `).all();
    assert.equal(tokenUsage.length, 1);
    assert.deepEqual(tokenUsage[0], {
      user_id: 2,
      model: 'degraded-test-model',
      prompt_tokens: 11,
      completion_tokens: 9,
      total_tokens: 20,
      endpoint: 'ai_chat'
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='ppt_outline'").get().count, 1);
    const summary = db.prepare(`
      SELECT source_id,business_id,metadata_json
      FROM knowledge_entries
      WHERE entry_type='ai_chat_summary'
    `).get();
    assert.equal(Number(summary.source_id), messages[1].id);
    assert.equal(Number(summary.business_id), conversations[0].id);
    assert.equal(JSON.parse(summary.metadata_json).conversation_id, conversations[0].id);
    const archived = db.prepare("SELECT metadata_json,content FROM knowledge_entries WHERE entry_type='ppt_outline'").get();
    assert.deepEqual(JSON.parse(archived.metadata_json).knowledge_reference_ids, [accessible.id]);
    assert.match(archived.content, /Aurora Audited Campaign/);
  } finally {
    db.close();
  }
});

test('ppt outline preserves provider reason and fallback when AI JSON is invalid', async () => {
  const result = await latestUiCompat.generatePptOutline(
    {},
    { id: 2, role: 'user' },
    { demand: { brand: 'Aurora', product: 'Solar Kit', market: 'US' }, allow_web: false },
    {
      aiService: {
        async handleChat() {
          return {
            answer: 'provider returned incomplete output',
            knowledge_references: [],
            web_results: [],
            web_search: { used: false, provider: 'tavily', reason: 'disabled' },
            degraded: true,
            reason: 'provider response truncated'
          };
        }
      }
    }
  );

  assert.equal(result.fallback, true);
  assert.equal(result.warning, 'provider response truncated');
  assert.equal(result.outline.title, 'Aurora 海外红人营销方案');
  assert.ok(result.outline.sections.length >= 9);
});

test('ppt outline records enabled web research as auditable references', async () => {
  const db = freshDb();
  let webCalls = 0;
  const webResult = {
    title: 'US creator market signal',
    url: 'https://example.com/us-creator-signal',
    snippet: 'Field-test creator content is growing.',
    provider: 'tavily'
  };

  try {
    const result = await latestUiCompat.generatePptOutline(
      db,
      { id: 2, role: 'user' },
      {
        demand: { brand: 'Aurora', product: 'Solar Kit', market: 'US' },
        proposal: 'Use current market evidence.',
        allow_web: true
      },
      {
        provider: {
          async complete() {
            return {
              content: validOutline('Aurora Web-Informed Campaign'),
              usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 },
              model: 'test-model'
            };
          }
        },
        webSearchProvider: {
          async search(query) {
            webCalls += 1;
            assert.match(query, /Aurora/);
            return { used: true, provider: 'tavily', results: [webResult], reason: '' };
          }
        }
      }
    );

    assert.equal(webCalls, 1);
    assert.equal(result.research.used, true);
    assert.deepEqual(result.research.results, [webResult]);
    assert.equal(result.ai.web_search.used, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_references WHERE reference_type='web'").get().count, 1);
    const stored = db.prepare("SELECT url,title,provider FROM ai_references WHERE reference_type='web'").get();
    assert.equal(stored.url, webResult.url);
    assert.equal(stored.title, webResult.title);
    assert.equal(stored.provider, 'tavily');
  } finally {
    db.close();
  }
});
