const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-ai-kb-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

test('knowledge service ingests entries once and searches with visibility filters', () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');

  const first = knowledge.ingestKnowledge(db, {
    title: 'Aurora Beauty 北美需求',
    content: '客户需要 TikTok Shop 种草和 YouTube 深度测评。',
    entry_type: 'demand',
    source_type: 'demand_upload',
    source_id: 101,
    visibility: 'private',
    tags: ['美妆', '北美', 'TikTok'],
    created_by: 2
  });
  const second = knowledge.ingestKnowledge(db, {
    title: 'Aurora Beauty 北美需求',
    content: '客户需要 TikTok Shop 种草和 YouTube 深度测评。',
    entry_type: 'demand',
    source_type: 'demand_upload',
    source_id: 101,
    visibility: 'private',
    tags: ['美妆', '北美', 'TikTok'],
    created_by: 2
  });

  assert.equal(first.id, second.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count, 1);

  const ownerResults = knowledge.searchKnowledge(db, { q: 'TikTok 北美', user: { id: 2, role: 'user' } });
  assert.equal(ownerResults.length, 1);
  assert.equal(ownerResults[0].title, 'Aurora Beauty 北美需求');

  const otherResults = knowledge.searchKnowledge(db, { q: 'TikTok 北美', user: { id: 3, role: 'user' } });
  assert.equal(otherResults.length, 0);

  const adminResults = knowledge.searchKnowledge(db, { q: 'TikTok 北美', user: { id: 1, role: 'admin' } });
  assert.equal(adminResults.length, 1);

  db.close();
});

test('rag service returns knowledge context and records usage', () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');
  const rag = require('../services/rag_service');

  const entry = knowledge.ingestKnowledge(db, {
    title: '3C 达人 brief',
    content: '3C 产品达人 brief 应包含核心参数、真实使用场景和素材授权范围。',
    entry_type: 'methodology',
    visibility: 'team',
    tags: ['3C', 'brief'],
    created_by: 1
  });

  const context = rag.buildRagContext(db, {
    query: '3C brief 怎么写',
    user: { id: 2, role: 'user' },
    limit: 5
  });

  assert.equal(context.references.length, 1);
  assert.equal(context.references[0].id, entry.id);
  assert.match(context.contextText, /3C 达人 brief/);

  knowledge.markKnowledgeUsed(db, [entry.id]);
  const updated = db.prepare('SELECT usage_count FROM knowledge_entries WHERE id = ?').get(entry.id);
  assert.equal(updated.usage_count, 1);

  db.close();
});

test('rag service extracts Chinese business terms from long questions', () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');
  const rag = require('../services/rag_service');

  const entry = knowledge.ingestKnowledge(db, {
    title: '海外红人营销执行手册',
    content: '红人营销执行需要确认达人 brief、授权范围、发布时间、数据回收和复盘节奏。',
    entry_type: 'methodology',
    visibility: 'team',
    tags: ['红人营销', '执行'],
    created_by: 1
  });

  const context = rag.buildRagContext(db, {
    query: '请结合知识库，用三点概括海外红人营销执行的关键注意事项。',
    user: { id: 2, role: 'user' },
    limit: 5
  });

  assert.equal(context.references.length, 1);
  assert.equal(context.references[0].id, entry.id);

  db.close();
});

test('private source hashes are scoped to the owner', () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');

  const ownerA = knowledge.ingestKnowledge(db, {
    title: 'Private demand A',
    content: 'Owner A private demand',
    entry_type: 'demand',
    source_type: 'manual_upload',
    source_id: 'same-file.csv',
    visibility: 'private',
    created_by: 2
  });
  const ownerB = knowledge.ingestKnowledge(db, {
    title: 'Private demand B',
    content: 'Owner B private demand',
    entry_type: 'demand',
    source_type: 'manual_upload',
    source_id: 'same-file.csv',
    visibility: 'private',
    created_by: 3
  });

  assert.notEqual(ownerA.id, ownerB.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count, 2);

  const noteA = knowledge.ingestKnowledge(db, {
    title: 'Same private note',
    content: 'Same content',
    entry_type: 'note',
    visibility: 'private',
    created_by: 2
  });
  const noteB = knowledge.ingestKnowledge(db, {
    title: 'Same private note',
    content: 'Same content',
    entry_type: 'note',
    visibility: 'private',
    created_by: 3
  });

  assert.notEqual(noteA.id, noteB.id);

  db.close();
});

test('shared source hashes cannot be overwritten by another non-admin user', () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');

  const first = knowledge.ingestKnowledge(db, {
    title: 'Shared method',
    content: 'Original shared playbook',
    entry_type: 'methodology',
    source_type: 'team_doc',
    source_id: 'playbook',
    visibility: 'team',
    created_by: 2,
    actor_role: 'user'
  });
  const second = knowledge.ingestKnowledge(db, {
    title: 'Shared method modified',
    content: 'Unauthorized overwrite',
    entry_type: 'methodology',
    source_type: 'team_doc',
    source_id: 'playbook',
    visibility: 'team',
    created_by: 3,
    actor_role: 'user'
  });

  assert.equal(first.id, second.id);
  const stored = db.prepare('SELECT title, content, created_by FROM knowledge_entries WHERE id = ?').get(first.id);
  assert.equal(stored.title, 'Shared method');
  assert.equal(stored.content, 'Original shared playbook');
  assert.equal(stored.created_by, 2);

  db.close();
});

test('ai service persists conversations and restricts non-admin visibility', async () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');
  const ai = require('../services/ai_service');
  const organizationId = db.prepare(
    "SELECT id FROM organizations WHERE code='turingmarket-default'"
  ).get().id;
  const memberAuth = { organization: { id: organizationId, role_code: 'member' } };

  knowledge.ingestKnowledge(db, {
    title: '方案确认流程',
    content: '方案必须经过 AI 草稿、人工修改、确认方案后才能导出 PPT。',
    entry_type: 'proposal',
    visibility: 'team',
    tags: ['proposal', 'PPT'],
    created_by: 1
  });

  const response = await ai.handleChat(db, {
    user: { id: 2, role: 'user' },
    organizationId,
    message: '生成 PPT 前要注意什么？',
    provider: {
      complete: async ({ messages }) => ({
        content: `答复基于 ${messages.length} 条上下文。`,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 8,
          total_tokens: 18,
          prompt_cache_hit_tokens: 4,
          prompt_cache_miss_tokens: 6
        },
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
        completed_at: '2026-08-23T12:00:00.000Z'
      })
    },
    webSearchProvider: null,
    allowWeb: true
  });

  assert.equal(response.answer, '答复基于 2 条上下文。');
  assert.equal(response.knowledge_references.length, 1);
  assert.deepEqual(response.cost_projection, {
    status: 'priced',
    currency: 'USD',
    total_cost_nano_usd: 6628,
    policy_version: 'deepseek-v4-usd-2026-08-13-v1',
    rate_period: 'off_peak',
    reason: null
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_conversations').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get().count, 2);
  const assistant = db.prepare("SELECT metadata_json FROM ai_messages WHERE role='assistant'").get();
  const assistantMetadata = JSON.parse(assistant.metadata_json);
  assert.equal(assistantMetadata.cost_snapshot.status, 'priced');
  assert.equal(assistantMetadata.cost_snapshot.total_cost_nano_usd, 6628);

  const detail = ai.getConversation(db, {
    id: response.conversation_id,
    user: { id: 2, role: 'user' },
    authContext: memberAuth
  });
  assert.deepEqual(detail.messages[1].run.cost_projection, response.cost_projection);
  assert.deepEqual(detail.run_summary.cost_summary, {
    status: 'priced',
    currency: 'USD',
    priced_run_count: 1,
    unavailable_run_count: 0,
    total_cost_nano_usd: 6628
  });

  const own = ai.listConversations(db, {
    user: { id: 2, role: 'user' },
    authContext: memberAuth
  });
  assert.equal(own.length, 1);
  const other = ai.listConversations(db, {
    user: { id: 3, role: 'user' },
    authContext: { organization: { id: organizationId, role_code: 'member' } }
  });
  assert.equal(other.length, 0);
  const admin = ai.listConversations(db, {
    user: { id: 1, role: 'admin' },
    authContext: { organization: { id: organizationId, role_code: 'org_admin' } },
    adminAuditGlobal: true
  });
  assert.equal(admin.length, 1);

  db.close();
});

test('ai service enforces the live tenant quota before provider I/O and keeps organization usage isolated', async () => {
  const db = freshDb();
  try {
    const ai = require('../services/ai_service');
    const organizationId = db.prepare(
      "SELECT id FROM organizations WHERE code='turingmarket-default'"
    ).get().id;
    db.prepare('UPDATE users SET api_quota=10 WHERE id=2').run();
    let providerCalls = 0;
    const provider = {
      async complete() {
        providerCalls += 1;
        return {
          content: 'quota accounted answer',
          usage: { prompt_tokens: 6, completion_tokens: 6, total_tokens: 12 },
          model: 'deepseek-chat'
        };
      }
    };

    const first = await ai.handleChat(db, {
      user: { id: 2, role: 'user', api_quota: 999999 },
      organizationId,
      message: 'first quota request',
      provider,
      allowWeb: false,
      requestId: 'quota-first-request'
    });
    assert.equal(first.answer, 'quota accounted answer');
    assert.equal(providerCalls, 1);
    assert.equal(db.prepare(`
      SELECT COALESCE(SUM(total_tokens),0) AS total
      FROM token_usage WHERE org_id=? AND user_id=2
    `).get(organizationId).total, 12);

    await assert.rejects(
      ai.handleChat(db, {
        user: { id: 2, role: 'admin', api_quota: 999999 },
        organizationId,
        message: 'must be denied from live database policy',
        provider,
        allowWeb: false,
        requestId: 'quota-denied-request'
      }),
      (error) => error && error.statusCode === 429 && error.code === 'AI_QUOTA_EXCEEDED'
    );
    assert.equal(providerCalls, 1);
    const denial = db.prepare(`
      SELECT action,module,details FROM activity_log
      WHERE action='ai_quota_denied' ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(denial.module, 'ai_quota');
    assert.equal(JSON.parse(denial.details).organization_id, organizationId);
  } finally {
    db.close();
  }
});

test('ai service disables zero-quota users and fails closed when trusted token accounting cannot persist', async () => {
  const db = freshDb();
  try {
    const ai = require('../services/ai_service');
    const organizationId = db.prepare(
      "SELECT id FROM organizations WHERE code='turingmarket-default'"
    ).get().id;
    let providerCalls = 0;
    const provider = {
      async complete() {
        providerCalls += 1;
        return {
          content: 'must not be returned without accounting',
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          model: 'deepseek-chat'
        };
      }
    };

    db.prepare('UPDATE users SET api_quota=0 WHERE id=2').run();
    await assert.rejects(
      ai.handleChat(db, {
        user: { id: 2, role: 'user', api_quota: 50000 },
        organizationId,
        message: 'zero quota must disable AI',
        provider,
        allowWeb: false,
        requestId: 'quota-disabled-request'
      }),
      (error) => error && error.statusCode === 429 && error.code === 'AI_QUOTA_DISABLED'
    );
    assert.equal(providerCalls, 0);

    db.prepare('UPDATE users SET api_quota=50000 WHERE id=2').run();
    db.exec(`
      CREATE TRIGGER test_token_usage_accounting_failure
      BEFORE INSERT ON token_usage
      BEGIN SELECT RAISE(ABORT,'forced token accounting failure'); END;
    `);
    await assert.rejects(
      ai.handleChat(db, {
        user: { id: 2, role: 'user' },
        organizationId,
        message: 'accounting failure must fail the response',
        provider,
        allowWeb: false,
        requestId: 'quota-accounting-failure'
      }),
      (error) => error && error.statusCode === 503 && error.code === 'AI_USAGE_ACCOUNTING_FAILED'
    );
    assert.equal(providerCalls, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM ai_messages
      WHERE content='must not be returned without accounting'
    `).get().count, 0);
  } finally {
    db.close();
  }
});

test('ai service fails closed when a successful provider omits or contradicts token usage', async () => {
  for (const [label, usage] of [
    ['missing', {}],
    ['inconsistent', { prompt_tokens: 6, completion_tokens: 4, total_tokens: 0 }]
  ]) {
    const db = freshDb();
    try {
      const ai = require('../services/ai_service');
      const organizationId = db.prepare(
        "SELECT id FROM organizations WHERE code='turingmarket-default'"
      ).get().id;
      const answer = `unmetered ${label} answer`;
      await assert.rejects(
        ai.handleChat(db, {
          user: { id: 2, role: 'user' },
          organizationId,
          message: `provider usage ${label}`,
          provider: {
            async complete() {
              return { content: answer, usage, model: 'deepseek-chat', provider: 'deepseek' };
            }
          },
          allowWeb: false,
          requestId: `provider-usage-${label}`
        }),
        (error) => error && error.statusCode === 503 && error.code === 'AI_USAGE_ACCOUNTING_FAILED'
      );
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM ai_messages WHERE content=?
      `).get(answer).count, 0);
    } finally {
      db.close();
    }
  }
});

test('ppt outline generation retrieves knowledge and archives references', async () => {
  const db = freshDb();
  const oldDeepSeek = process.env.DEEPSEEK_API_KEY;
  const oldTavily = process.env.TAVILY_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    const knowledge = require('../services/knowledge_service');
    const latestUi = require('../services/latest_ui_compat_service');
    const organizationId = db.prepare(
      "SELECT id FROM organizations WHERE code='turingmarket-default'"
    ).get().id;
    const entry = knowledge.ingestKnowledge(db, {
      title: 'PPT internal case method',
      content: 'PPT generation should use the internal case library and confirmed proposal knowledge before web research.',
      entry_type: 'proposal',
      visibility: 'team',
      tags: ['ppt', 'proposal', 'case'],
      created_by: 1
    });

    const result = await latestUi.generatePptOutline(db, { id: 2, role: 'user' }, {
      demand: { brand: 'Aurora', product: 'Solar Kit', market: 'US' },
      proposal: 'Use the internal case library before generating the client deck.',
      knowledge_limit: 5
    }, { organizationId });

    assert.equal(result.knowledge_references.length, 1);
    assert.equal(result.knowledge_references[0].id, entry.id);
    assert.equal(result.outline.knowledge_references[0].id, entry.id);
    const archived = db.prepare("SELECT metadata_json, content FROM knowledge_entries WHERE entry_type = 'ppt_outline' ORDER BY id DESC LIMIT 1").get();
    const metadata = JSON.parse(archived.metadata_json || '{}');
    assert.deepEqual(metadata.knowledge_reference_ids, [entry.id]);
    assert.match(archived.content, /knowledge_references/);
  } finally {
    if (oldDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldDeepSeek;
    if (oldTavily === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = oldTavily;
    db.close();
  }
});

test('web search service degrades when tavily api key is missing', async () => {
  const web = require('../services/web_search_service');
  const result = await web.searchWeb('latest influencer trend', { provider: 'tavily', apiKey: '' });

  assert.equal(result.used, false);
  assert.equal(result.provider, 'tavily');
  assert.deepEqual(result.results, []);
  assert.match(result.reason, /not configured/i);
});
