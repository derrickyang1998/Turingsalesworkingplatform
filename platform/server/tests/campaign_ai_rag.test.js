'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const knowledge = require('../services/knowledge_service');
const ai = require('../services/ai_service');
const llm = require('../services/llm_service');
const webSearch = require('../services/web_search_service');
const { resolveConversationCampaign } = require('../services/campaign_access_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 2,
    name: '002_campaign_business_spine',
    sourcePath: 'migrations/002_campaign_business_spine.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 3,
    name: '003_campaign_workflow_dispatch_evidence',
    sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 4,
    name: '004_knowledge_capacity_observability',
    sourcePath: 'migrations/004_knowledge_capacity_observability.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 5,
    name: '005_knowledge_custody_projection',
    sourcePath: 'migrations/005_knowledge_custody_projection.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function openDatabase() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  });
  return db;
}

function createCampaignFixture(db) {
  const identity = db.prepare(`
    SELECT organization.id AS orgId,user.id AS userId,user.role AS role,
      team_membership.team_id AS teamId
    FROM organizations organization
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=organization.id
     AND organization_membership.status='active'
    JOIN users user
      ON user.id=organization_membership.user_id AND user.is_active=1
    JOIN team_memberships team_membership
      ON team_membership.org_id=organization.id
     AND team_membership.user_id=user.id
     AND team_membership.status='active'
    WHERE organization.code='turingmarket-default' AND user.role<>'admin'
    ORDER BY user.id,team_membership.team_id
    LIMIT 1
  `).get();
  assert.ok(identity, 'fixture requires one active non-admin organization member');

  const fixture = {
    ...identity,
    customerId: 910401,
    opportunityId: 920401,
    campaignId: 930401
  };
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
    ) VALUES (
      @customerId,'Campaign AI contract','Campaign AI contract Ltd',
      'qualified','campaign-ai-contract',@userId,@userId,0
    )
  `).run(fixture);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (
      @opportunityId,@customerId,'Campaign AI contract opportunity','proposal',1000,50,
      'Campaign AI contract product','influencer',@userId
    )
  `).run(fixture);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@orgId,'Campaign AI contract campaign',@customerId,@opportunityId,
      @userId,@teamId,'lead','active',1
    )
  `).run(fixture);
  fixture.user = { id: fixture.userId, role: fixture.role };
  return fixture;
}

function addCampaign(db, fixture, campaignId) {
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      ?,?,?,?,?,?,?,'lead','active',1
    )
  `).run(
    campaignId,
    fixture.orgId,
    `Campaign AI contract campaign ${campaignId}`,
    fixture.customerId,
    fixture.opportunityId,
    fixture.userId,
    fixture.teamId
  );
}

function linkKnowledge(db, fixture, entryId, label) {
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (
      @orgId,@campaignId,'knowledge_entry',@bundleId,@recordId,'knowledge',
      @userId,'{}'
    )
  `).run({
    ...fixture,
    recordId: String(entryId),
    bundleId: sha256(`campaign-ai-rag:${label}:${entryId}`)
  });
}

function replaceWithOneChunk(db, entry, tags, content) {
  const prior = db.prepare(`
    SELECT id FROM knowledge_chunks WHERE entry_id=? ORDER BY chunk_index,id
  `).all(entry.id);
  assert.ok(prior.length > 0, 'fixture entry must have at least one chunk');
  db.prepare('DELETE FROM knowledge_chunks_fts WHERE entry_id=?').run(entry.id);
  db.prepare('DELETE FROM knowledge_chunks WHERE entry_id=?').run(entry.id);
  const chunkId = prior[0].id;
  db.prepare(`
    INSERT INTO knowledge_chunks (
      id,entry_id,chunk_index,content,metadata_json,token_count,embedding_json,content_sha256
    ) VALUES (?,?,0,?,'{}',0,NULL,?)
  `).run(chunkId, entry.id, content, sha256(content));
  db.prepare(`
    INSERT INTO knowledge_chunks_fts (title,content,tags,entry_id,chunk_id)
    VALUES (?,?,?,?,?)
  `).run(entry.title, content, tags.join(' '), entry.id, chunkId);
  db.prepare(
    "INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('integrity-check')"
  ).run();
}

function writeLinkedKnowledge(db, fixture, options) {
  const input = {
    organizationId: fixture.orgId,
    campaignId: fixture.campaignId,
    createdBy: fixture.userId,
    sourceType: 'campaign_ai_rag_contract',
    sourceId: options.label,
    entryType: 'campaign_note',
    title: options.title || `Campaign AI ${options.label}`,
    summary: '',
    content: options.content,
    tags: options.tags || ['campaign', 'ai-rag'],
    visibility: 'team',
    metadata: { schema_version: 1 }
  };
  let written;
  db.transaction(() => {
    written = knowledge.writeCampaignKnowledgeInTransaction(db, input);
    if (options.oneChunkContent !== undefined) {
      replaceWithOneChunk(db, written.entry, input.tags, options.oneChunkContent);
    }
    linkKnowledge(db, fixture, written.entry.id, options.label);
    if (written.capacityGaugePlan && options.oneChunkContent === undefined) {
      knowledge.applyKnowledgeCapacityGaugePlanInTransaction(db, written.capacityGaugePlan);
    }
  }).immediate();
  if (options.updatedAt) {
    db.prepare('UPDATE knowledge_entries SET updated_at=? WHERE id=?')
      .run(options.updatedAt, written.entry.id);
  }
  return {
    entry: db.prepare('SELECT * FROM knowledge_entries WHERE id=?').get(written.entry.id),
    chunks: db.prepare(`
      SELECT id,entry_id,chunk_index,content,content_sha256
      FROM knowledge_chunks
      WHERE entry_id=?
      ORDER BY chunk_index,id
    `).all(written.entry.id)
  };
}

function writeUnlinkedKnowledge(db, fixture, options) {
  const entry = knowledge.ingestKnowledge(db, {
    title: options.title || `Unlinked ${options.label}`,
    summary: '',
    content: options.content,
    entry_type: 'campaign_note',
    source_type: 'manual',
    source_id: options.label,
    visibility: 'team',
    tags: options.tags || ['campaign', 'ai-rag'],
    created_by: fixture.userId,
    actor_role: fixture.role
  });
  return {
    entry: db.prepare('SELECT * FROM knowledge_entries WHERE id=?').get(entry.id),
    chunks: db.prepare(`
      SELECT id,entry_id,chunk_index,content,content_sha256
      FROM knowledge_chunks
      WHERE entry_id=?
      ORDER BY chunk_index,id
    `).all(entry.id)
  };
}

function renderKnowledgeRecord(rank, entry, chunk) {
  return `[KB-${rank}]\n${entry.title || ''}\n${chunk.content}`;
}

function capturedKnowledgeContext(request) {
  const system = request.messages.find((message) => message.role === 'system');
  assert.ok(system, 'provider must receive a system message');
  const start = system.content.indexOf('[KB-1]\n');
  assert.notEqual(start, -1, 'provider prompt must contain ranked knowledge records');
  return system.content.slice(start);
}

function successfulProvider(calls, answer = 'deterministic linked answer') {
  return {
    async complete(request) {
      calls.push(request);
      return {
        content: answer,
        model: 'fake-deepseek',
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      };
    }
  };
}

function linkedInput(fixture, suffix, overrides = {}) {
  return {
    user: fixture.user,
    message: 'rag-contract-query',
    campaign_id: fixture.campaignId,
    requestId: `campaign-ai-rag-request-${suffix}`,
    idempotencyKey: `campaign-ai-rag-key-${suffix}`,
    allowWeb: false,
    ...overrides
  };
}

function tableRowCount(db, tableName) {
  const table = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type='table' AND name=?
  `).get(tableName);
  return table ? db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count : 0;
}

function durableLinkedState(db, campaignId) {
  const state = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM ai_conversations) AS conversations,
      (SELECT COUNT(*) FROM ai_messages) AS messages,
      (SELECT COUNT(*) FROM ai_references) AS reference_rows,
      (SELECT COUNT(*) FROM knowledge_entries WHERE entry_type='ai_chat_summary') AS archives,
      (SELECT COUNT(*) FROM campaign_record_links
        WHERE campaign_id=@campaignId AND record_type='ai_conversation'
          AND relation_type='ai_run') AS ai_links,
      (SELECT COUNT(*) FROM campaign_events
        WHERE campaign_id=@campaignId AND source='ai_link') AS ai_events
  `).get({ campaignId });
  return {
    ...state,
    tokens: tableRowCount(db, 'token_usage'),
    web_cache: tableRowCount(db, 'web_search_cache')
  };
}

async function settled(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function assertServiceError(outcome, statusCode, code) {
  assert.equal(outcome.ok, false, 'linked chat must reject with a typed service error');
  assert.equal(outcome.error.code, code);
  assert.equal(outcome.error.statusCode || outcome.error.status, statusCode);
}

test('linked chat keeps 20 selected entries in input order, then appends only the first 8 retrieved chunks for 48 total', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const selected = [];
    for (let index = 0; index < 20; index += 1) {
      const marker = `selected-${String(index).padStart(2, '0')}`;
      const item = writeLinkedKnowledge(db, fixture, {
        label: marker,
        title: `Selected ${marker}`,
        content: `${marker}-${'s'.repeat(1201)}`
      });
      assert.equal(item.chunks.length, 2, 'selected fixture must yield two ordered chunks');
      selected.push(item);
    }
    const retrieved = [];
    for (let index = 0; index < 9; index += 1) {
      const marker = `retrieved-${index}`;
      retrieved.push(writeLinkedKnowledge(db, fixture, {
        label: marker,
        title: `ranking-needle ${marker}`,
        content: `ranking-needle ${marker}`,
        updatedAt: `2026-07-30 00:00:${String(index).padStart(2, '0')}`
      }));
    }

    const selectedInRequestOrder = selected.slice().reverse();
    const expected = selectedInRequestOrder.flatMap((item) => item.chunks.map((chunk) => ({
      entry: item.entry,
      chunk,
      selected: true
    }))).concat(retrieved.slice().reverse().slice(0, 8).map((item) => ({
      entry: item.entry,
      chunk: item.chunks[0],
      selected: false
    })));
    assert.equal(expected.length, 48);
    const expectedContext = expected.map((item, index) => (
      renderKnowledgeRecord(index + 1, item.entry, item.chunk)
    )).join('\n\n');
    assert.ok(Buffer.byteLength(expectedContext, 'utf8') < 98_304);

    const calls = [];
    const result = await ai.handleChat(db, linkedInput(fixture, 'twenty-selected', {
      message: 'ranking-needle',
      knowledge_entry_ids: selectedInRequestOrder.map((item) => item.entry.id),
      provider: successfulProvider(calls)
    }));

    assert.equal(calls.length, 1);
    assert.equal(capturedKnowledgeContext(calls[0]), expectedContext);
    assert.equal(result.campaign_id, fixture.campaignId);
    assert.equal(typeof result.link_id, 'number');
    assert.deepEqual(result.knowledge_references.map((reference) => ({
      entry_id: reference.entry_id,
      chunk_id: reference.chunk_id,
      chunk_index: reference.chunk_index,
      selected: reference.selected,
      rank: reference.rank
    })), expected.map((item, index) => ({
      entry_id: item.entry.id,
      chunk_id: item.chunk.id,
      chunk_index: item.chunk.chunk_index,
      selected: item.selected,
      rank: index + 1
    })));
  } finally {
    db.close();
  }
});

test('linked chat rejects a 21st unique selected entry with the selection overflow contract before provider work', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const entries = [];
    for (let index = 0; index < 21; index += 1) {
      entries.push(writeLinkedKnowledge(db, fixture, {
        label: `selection-limit-${index}`,
        content: `selection limit ${index}`
      }));
    }
    const before = durableLinkedState(db, fixture.campaignId);
    let providerCalls = 0;
    const outcome = await settled(ai.handleChat(db, linkedInput(fixture, 'selection-limit', {
      knowledge_entry_ids: entries.map((item) => item.entry.id),
      provider: {
        async complete() {
          providerCalls += 1;
          return { content: 'must not run', usage: {}, model: 'fake-deepseek' };
        }
      }
    })));

    assertServiceError(outcome, 413, 'KNOWLEDGE_SELECTION_TOO_LARGE');
    assert.equal(providerCalls, 0);
    assert.deepEqual(durableLinkedState(db, fixture.campaignId), before);
  } finally {
    db.close();
  }
});

test('linked chat stops retrieval at the first whole chunk that would exceed 98,304 UTF-8 bytes without skipping later chunks', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const selected = writeLinkedKnowledge(db, fixture, {
      label: 'byte-selected',
      title: 'Byte selected',
      content: 'selected byte fixture'
    });
    const selectedRecord = renderKnowledgeRecord(1, selected.entry, selected.chunks[0]);
    const firstTitle = Array(8).fill('bytecapneedle').join(' ') + ' first';
    const firstPrefix = `[KB-2]\n${firstTitle}\n`;
    const exactFirstContentBytes = 98_304 - Buffer.byteLength(
      `${selectedRecord}\n\n${firstPrefix}`,
      'utf8'
    );
    assert.ok(exactFirstContentBytes > 0);
    const first = writeLinkedKnowledge(db, fixture, {
      label: 'byte-first',
      title: firstTitle,
      content: 'x'.repeat(exactFirstContentBytes),
      oneChunkContent: 'x'.repeat(exactFirstContentBytes),
      updatedAt: '2026-07-30 00:00:03'
    });
    const blocker = writeLinkedKnowledge(db, fixture, {
      label: 'byte-blocker',
      title: 'bytecapneedle blocker',
      content: 'b',
      updatedAt: '2026-07-30 00:00:02'
    });
    const later = writeLinkedKnowledge(db, fixture, {
      label: 'byte-later',
      title: 'bytecapneedle later',
      content: 'later-must-not-be-skipped-to-fit',
      updatedAt: '2026-07-30 00:00:01'
    });
    const expectedContext = [
      selectedRecord,
      renderKnowledgeRecord(2, first.entry, first.chunks[0])
    ].join('\n\n');
    assert.equal(Buffer.byteLength(expectedContext, 'utf8'), 98_304);

    const calls = [];
    const result = await ai.handleChat(db, linkedInput(fixture, 'byte-cap', {
      message: 'bytecapneedle',
      knowledge_entry_ids: [selected.entry.id],
      provider: successfulProvider(calls)
    }));

    assert.equal(capturedKnowledgeContext(calls[0]), expectedContext);
    assert.deepEqual(result.knowledge_references.map((reference) => reference.chunk_id), [
      selected.chunks[0].id,
      first.chunks[0].id
    ]);
    assert.equal(
      result.knowledge_references.some((reference) => reference.chunk_id === blocker.chunks[0].id),
      false
    );
    assert.equal(
      result.knowledge_references.some((reference) => reference.chunk_id === later.chunks[0].id),
      false
    );
  } finally {
    db.close();
  }
});

test('linked chat writes no conversation, message, reference, token, archive, cache, link, or event before DeepSeek succeeds', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const before = durableLinkedState(db, fixture.campaignId);
    let resolveCompletion;
    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    const operation = ai.handleChat(db, linkedInput(fixture, 'provider-pending', {
      provider: {
        complete() {
          providerStarted();
          return new Promise((resolve) => { resolveCompletion = resolve; });
        }
      }
    }));

    await started;
    try {
      assert.deepEqual(durableLinkedState(db, fixture.campaignId), before);
    } finally {
      resolveCompletion({
        content: 'provider completed after the no-write checkpoint',
        model: 'fake-deepseek',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
      await operation.catch(() => {});
    }
  } finally {
    db.close();
  }
});

test('linked one-shot chat can suppress an unconfirmed knowledge summary without losing its audited run', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const result = await ai.handleChat(db, linkedInput(fixture, 'unconfirmed-summary', {
      archiveSummary: false,
      provider: successfulProvider([])
    }));

    assert.equal(result.archived_summary_id, null);
    assert.equal(result.campaign_id, fixture.campaignId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get().count, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_record_links
      WHERE campaign_id=? AND record_type='ai_conversation' AND relation_type='ai_run'
    `).get(fixture.campaignId).count, 1);
  } finally {
    db.close();
  }
});

test('linked chat treats DeepSeek failure as zero-event 503 and does not retain linked domain rows', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const before = durableLinkedState(db, fixture.campaignId);
    const outcome = await settled(ai.handleChat(db, linkedInput(fixture, 'provider-failure', {
      provider: {
        async complete() {
          throw new Error('deterministic DeepSeek outage');
        }
      }
    })));

    assert.deepEqual(durableLinkedState(db, fixture.campaignId), before);
    assertServiceError(outcome, 503, 'AI_PROVIDER_UNAVAILABLE');
    assert.deepEqual(db.prepare(`
      SELECT scope,campaign_id,state,status_code
      FROM request_idempotency
      WHERE idempotency_key=?
    `).get('campaign-ai-rag-key-provider-failure'), {
      scope: 'ai.conversation.create.linked',
      campaign_id: fixture.campaignId,
      state: 'completed',
      status_code: 503
    });
  } finally {
    db.close();
  }
});

test('linked chat tolerates web failure, invokes mandatory DeepSeek, and leaves no web cache row', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const llmCalls = [];
    let webCalls = 0;
    const outcome = await settled(ai.handleChat(db, linkedInput(fixture, 'optional-web', {
      allowWeb: true,
      provider: successfulProvider(llmCalls),
      webSearchProvider: {
        async search() {
          webCalls += 1;
          throw new Error('deterministic optional web outage');
        }
      }
    })));

    assert.equal(outcome.ok, true, outcome.error && outcome.error.message);
    assert.equal(llmCalls.length, 1);
    assert.equal(webCalls, 1);
    assert.equal(outcome.value.web_search.used, false);
    assert.equal(tableRowCount(db, 'web_search_cache'), 0);
  } finally {
    db.close();
  }
});

test('linked conversation derives one immutable parent campaign, replays exactly, and conceals its body after campaign access is revoked', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const entry = writeLinkedKnowledge(db, fixture, {
      label: 'visibility',
      title: 'Visibility boundary',
      content: 'visibility-boundary needle'
    });
    const calls = [];
    const createInput = linkedInput(fixture, 'parent-create', {
      message: 'visibility-boundary needle',
      knowledge_entry_ids: [entry.entry.id],
      provider: successfulProvider(calls)
    });
    const created = await ai.handleChat(db, createInput);
    const replayed = await ai.handleChat(db, createInput);

    assert.deepEqual(replayed, created);
    assert.equal(calls.length, 1);
    assert.equal(created.campaign_id, fixture.campaignId);
    assert.equal(typeof created.link_id, 'number');
    assert.deepEqual(resolveConversationCampaign(db, {
      conversationId: created.conversation_id
    }), {
      ok: true,
      campaignId: fixture.campaignId,
      derived: true
    });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_record_links
      WHERE campaign_id=? AND record_type='ai_conversation'
        AND record_id=? AND relation_type='ai_run' AND revoked_at IS NULL
    `).get(fixture.campaignId, String(created.conversation_id)).count, 1);

    const replacement = db.prepare(`
      SELECT membership.user_id AS userId,membership.team_id AS teamId
      FROM team_memberships membership
      JOIN users user ON user.id=membership.user_id AND user.is_active=1
      WHERE membership.org_id=? AND membership.status='active' AND membership.team_id<>?
      ORDER BY membership.user_id,membership.team_id
      LIMIT 1
    `).get(fixture.orgId, fixture.teamId);
    assert.ok(replacement, 'fixture requires a second active team');
    db.prepare(`
      UPDATE campaigns
      SET owner_user_id=?,team_id=?,row_version=row_version+1
      WHERE id=?
    `).run(replacement.userId, replacement.teamId, fixture.campaignId);

    assert.equal(ai.getConversation(db, {
      id: created.conversation_id,
      user: fixture.user
    }), null);
  } finally {
    db.close();
  }
});

test('linked continuation derives its parent campaign before idempotency lookup and rejects an explicit mismatched campaign', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const secondCampaignId = fixture.campaignId + 1;
    addCampaign(db, fixture, secondCampaignId);
    const calls = [];
    const created = await ai.handleChat(db, linkedInput(fixture, 'continuation-create', {
      provider: successfulProvider(calls)
    }));
    const continued = await ai.handleChat(db, linkedInput(fixture, 'continuation-derived', {
      conversation_id: created.conversation_id,
      provider: successfulProvider(calls)
    }));

    assert.equal(continued.campaign_id, fixture.campaignId);
    assert.equal(Object.hasOwn(continued, 'link_id'), false);
    assert.equal(calls.length, 2);
    assert.deepEqual(db.prepare(`
      SELECT scope,campaign_id,state,status_code
      FROM request_idempotency
      WHERE scope IN ('ai.conversation.create.linked','ai.conversation.continue.linked')
      ORDER BY id
    `).all(), [
      {
        scope: 'ai.conversation.create.linked',
        campaign_id: fixture.campaignId,
        state: 'completed',
        status_code: 200
      },
      {
        scope: 'ai.conversation.continue.linked',
        campaign_id: fixture.campaignId,
        state: 'completed',
        status_code: 200
      }
    ]);

    const beforeMismatch = durableLinkedState(db, fixture.campaignId);
    const mismatch = await settled(ai.handleChat(db, linkedInput(fixture, 'continuation-mismatch', {
      campaign_id: secondCampaignId,
      conversation_id: created.conversation_id,
      provider: successfulProvider(calls)
    })));
    assertServiceError(mismatch, 409, 'CONVERSATION_CAMPAIGN_MISMATCH');
    assert.equal(calls.length, 2);
    assert.deepEqual(durableLinkedState(db, fixture.campaignId), beforeMismatch);
  } finally {
    db.close();
  }
});

test('campaign retrieval admits authorized unclassified knowledge but excludes evidence in another campaign from prompt, references, and archive', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const otherCampaignId = fixture.campaignId + 1;
    addCampaign(db, fixture, otherCampaignId);
    const otherCampaignEvidence = writeLinkedKnowledge(db, {
      ...fixture,
      campaignId: otherCampaignId
    }, {
      label: 'other-campaign-evidence',
      title: 'crosscampaignneedle other campaign',
      content: 'crosscampaignneedle SECRET_OTHER_CAMPAIGN_EVIDENCE'
    });
    const unclassified = writeUnlinkedKnowledge(db, fixture, {
      label: 'unclassified-shared-evidence',
      title: 'crosscampaignneedle unclassified',
      content: 'crosscampaignneedle authorized unclassified evidence'
    });
    const calls = [];

    const result = await ai.handleChat(db, linkedInput(fixture, 'cross-campaign-leakage', {
      message: 'crosscampaignneedle',
      provider: successfulProvider(calls)
    }));

    assert.equal(calls.length, 1);
    assert.match(capturedKnowledgeContext(calls[0]), /authorized unclassified evidence/);
    assert.doesNotMatch(JSON.stringify(calls[0]), /SECRET_OTHER_CAMPAIGN_EVIDENCE/);
    assert.equal(
      result.knowledge_references.some((reference) => reference.entry_id === otherCampaignEvidence.entry.id),
      false
    );
    assert.equal(
      result.knowledge_references.some((reference) => reference.entry_id === unclassified.entry.id),
      true
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM ai_references
      WHERE message_id=? AND knowledge_entry_id=?
    `).get(result.message_id, otherCampaignEvidence.entry.id).count, 0);
    const archive = db.prepare('SELECT content FROM knowledge_entries WHERE id=?')
      .get(result.archived_summary_id);
    assert.ok(archive);
    assert.doesNotMatch(archive.content, /SECRET_OTHER_CAMPAIGN_EVIDENCE/);
  } finally {
    db.close();
  }
});

test('retrieved chunk cap stops independently at 8 when a ninth candidate fits total-count and byte limits', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const entries = [];
    for (let index = 0; index < 9; index += 1) {
      entries.push(writeLinkedKnowledge(db, fixture, {
        label: `independent-retrieval-${index}`,
        title: `independentretrievalneedle ${index}`,
        content: `independentretrievalneedle candidate ${index}`,
        updatedAt: `2026-07-30 00:01:${String(index).padStart(2, '0')}`
      }));
    }
    const calls = [];

    const result = await ai.handleChat(db, linkedInput(fixture, 'independent-eight', {
      message: 'independentretrievalneedle',
      provider: successfulProvider(calls)
    }));

    assert.equal(result.knowledge_references.length, 8);
    assert.deepEqual(
      result.knowledge_references.map((reference) => reference.chunk_id),
      entries.slice().reverse().slice(0, 8).map((entry) => entry.chunks[0].id)
    );
    assert.equal(result.knowledge_references.every((reference) => reference.selected === false), true);
  } finally {
    db.close();
  }
});

test('each selected entry contributes at most its first two chunks in chunk-index and chunk-id order', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const selected = writeLinkedKnowledge(db, fixture, {
      label: 'selected-three-chunks',
      title: 'Selected three chunks',
      content: 's'.repeat(2401)
    });
    assert.equal(selected.chunks.length, 3);
    const calls = [];

    const result = await ai.handleChat(db, linkedInput(fixture, 'selected-two-chunk-cap', {
      message: 'unmatchedselectedcapquery',
      knowledge_entry_ids: [selected.entry.id],
      provider: successfulProvider(calls)
    }));

    assert.deepEqual(
      result.knowledge_references.map((reference) => reference.chunk_id),
      selected.chunks.slice(0, 2).map((chunk) => chunk.id)
    );
    assert.equal(capturedKnowledgeContext(calls[0]), selected.chunks.slice(0, 2)
      .map((chunk, index) => renderKnowledgeRecord(index + 1, selected.entry, chunk))
      .join('\n\n'));
  } finally {
    db.close();
  }
});

test('selected chunks 0 and 1 stay first and retrieved chunk 2 from the same entry follows in exact rank order', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const selected = writeLinkedKnowledge(db, fixture, {
      label: 'selected-entry-retrieved-third-chunk',
      title: 'Selected entry with a retrieved third chunk',
      content: `${'s'.repeat(2400)} sameentrythirdchunkneedle`
    });
    assert.equal(selected.chunks.length, 3);
    assert.deepEqual(selected.chunks.map((chunk) => chunk.chunk_index), [0, 1, 2]);
    const expectedContext = selected.chunks.map((chunk, index) => (
      renderKnowledgeRecord(index + 1, selected.entry, chunk)
    )).join('\n\n');
    const calls = [];

    const result = await ai.handleChat(db, linkedInput(fixture, 'selected-retrieved-third', {
      message: 'sameentrythirdchunkneedle',
      knowledge_entry_ids: [selected.entry.id],
      provider: successfulProvider(calls)
    }));

    assert.equal(calls.length, 1);
    assert.equal(capturedKnowledgeContext(calls[0]), expectedContext);
    assert.deepEqual(result.knowledge_references.map((reference) => ({
      entry_id: reference.entry_id,
      chunk_id: reference.chunk_id,
      chunk_index: reference.chunk_index,
      selected: reference.selected,
      rank: reference.rank
    })), selected.chunks.map((chunk, index) => ({
      entry_id: selected.entry.id,
      chunk_id: chunk.id,
      chunk_index: index,
      selected: index < 2,
      rank: index + 1
    })));
  } finally {
    db.close();
  }
});

test('reference snippet preserves 1,199 BMP scalars followed by one supplementary scalar', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const content = 'a'.repeat(1199) + '\u{1F600}';
    const selected = writeLinkedKnowledge(db, fixture, {
      label: 'snippet-boundary-bmp-supplementary',
      title: 'BMP and supplementary snippet boundary',
      content
    });
    assert.equal(selected.chunks.length, 1);
    assert.equal(Array.from(content).length, 1200);
    assert.equal(content.length, 1201);
    const calls = [];

    const result = await ai.handleChat(db, linkedInput(fixture, 'snippet-bmp-supplementary', {
      message: 'snippet-boundary-query',
      knowledge_entry_ids: [selected.entry.id],
      provider: successfulProvider(calls)
    }));

    assert.equal(calls.length, 1);
    assert.equal(result.knowledge_references[0].snippet, content);
    assert.equal(Array.from(result.knowledge_references[0].snippet).length, 1200);
    assert.equal(db.prepare(`
      SELECT snippet FROM ai_references
      WHERE message_id=? AND knowledge_chunk_id=?
    `).get(result.message_id, selected.chunks[0].id).snippet, content);
  } finally {
    db.close();
  }
});

test('reference snippet preserves exactly 1,200 supplementary scalars', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const content = '\u{1F600}'.repeat(1200);
    const selected = writeLinkedKnowledge(db, fixture, {
      label: 'snippet-boundary-all-supplementary',
      title: 'All supplementary snippet boundary',
      content
    });
    assert.equal(selected.chunks.length, 1);
    assert.equal(Array.from(content).length, 1200);
    assert.equal(content.length, 2400);
    const calls = [];

    const result = await ai.handleChat(db, linkedInput(fixture, 'snippet-all-supplementary', {
      message: 'snippet-boundary-query',
      knowledge_entry_ids: [selected.entry.id],
      provider: successfulProvider(calls)
    }));

    assert.equal(calls.length, 1);
    assert.equal(result.knowledge_references[0].snippet, content);
    assert.equal(Array.from(result.knowledge_references[0].snippet).length, 1200);
    assert.equal(db.prepare(`
      SELECT snippet FROM ai_references
      WHERE message_id=? AND knowledge_chunk_id=?
    `).get(result.message_id, selected.chunks[0].id).snippet, content);
  } finally {
    db.close();
  }
});

test('selected context exceeding 98,304 UTF-8 bytes fails as 413 without truncation or provider work', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const selected = writeLinkedKnowledge(db, fixture, {
      label: 'selected-byte-overflow',
      title: 'Selected byte overflow',
      content: 'x'.repeat(98_304),
      oneChunkContent: 'x'.repeat(98_304)
    });
    const before = durableLinkedState(db, fixture.campaignId);
    let providerCalls = 0;

    const outcome = await settled(ai.handleChat(db, linkedInput(fixture, 'selected-byte-overflow', {
      message: 'selected-byte-overflow-query',
      knowledge_entry_ids: [selected.entry.id],
      provider: {
        async complete() {
          providerCalls += 1;
          return { content: 'must not run', usage: {}, model: 'fake-deepseek' };
        }
      }
    })));

    assertServiceError(outcome, 413, 'KNOWLEDGE_SELECTION_TOO_LARGE');
    assert.equal(providerCalls, 0);
    assert.deepEqual(durableLinkedState(db, fixture.campaignId), before);
  } finally {
    db.close();
  }
});

test('LLM and web adapters forward the caller AbortSignal to every fetch', async () => {
  const controller = new AbortController();
  const deadlineAt = Date.now() + 120_000;
  let llmFetchSignal;
  let webFetchSignal;
  const provider = llm.createDeepSeekProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      llmFetchSignal = init.signal;
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: 'adapter answer' } }],
            usage: {},
            model: 'adapter-model'
          };
        }
      };
    }
  });
  await provider.complete({
    messages: [{ role: 'user', content: 'adapter test' }],
    signal: controller.signal,
    deadlineAt
  });
  await webSearch.searchWeb('adapter test', {
    apiKey: 'test-key',
    signal: controller.signal,
    deadlineAt,
    fetchImpl: async (_url, init) => {
      webFetchSignal = init.signal;
      return {
        ok: true,
        async json() { return { results: [] }; }
      };
    }
  });

  assert.equal(llmFetchSignal, controller.signal);
  assert.equal(webFetchSignal, controller.signal);
});

test('unlinked adapter calls preserve the legacy fetch option shape when no AbortSignal is supplied', async () => {
  let llmHasSignal = true;
  let webHasSignal = true;
  const provider = llm.createDeepSeekProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      llmHasSignal = Object.hasOwn(init, 'signal');
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: 'legacy adapter answer' } }],
            usage: {},
            model: 'legacy-adapter-model'
          };
        }
      };
    }
  });
  await provider.complete({ messages: [{ role: 'user', content: 'legacy adapter test' }] });
  await webSearch.searchWeb('legacy adapter test', {
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      webHasSignal = Object.hasOwn(init, 'signal');
      return {
        ok: true,
        async json() { return { results: [] }; }
      };
    }
  });

  assert.equal(llmHasSignal, false);
  assert.equal(webHasSignal, false);
});

test('linked web and LLM share one deadline signal and an aborted late completion cannot write', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const before = durableLinkedState(db, fixture.campaignId);
    const externalAbort = new AbortController();
    let webSignal;
    let webDeadlineAt;
    let llmSignal;
    let llmDeadlineAt;
    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    let resolveLateCompletion;
    const operation = ai.handleChat(db, linkedInput(fixture, 'shared-abort', {
      allowWeb: true,
      signal: externalAbort.signal,
      webSearchProvider: {
        async search(_message, providerOptions) {
          webSignal = providerOptions && providerOptions.signal;
          webDeadlineAt = providerOptions && providerOptions.deadlineAt;
          return { used: true, provider: 'fake-web', results: [] };
        }
      },
      provider: {
        complete(request) {
          llmSignal = request.signal;
          llmDeadlineAt = request.deadlineAt;
          providerStarted();
          return new Promise((resolve) => { resolveLateCompletion = resolve; });
        }
      }
    }));

    await started;
    externalAbort.abort(new Error('deterministic client abort'));
    setTimeout(() => resolveLateCompletion({
      content: 'late result must be ignored',
      model: 'fake-deepseek',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), 25);
    const outcome = await settled(operation);
    await new Promise((resolve) => setTimeout(resolve, 40));

    assertServiceError(outcome, 503, 'AI_PROVIDER_UNAVAILABLE');
    assert.ok(webSignal instanceof AbortSignal);
    assert.equal(llmSignal, webSignal);
    assert.equal(llmDeadlineAt, webDeadlineAt);
    assert.equal(webSignal.aborted, true);
    assert.equal(typeof llmDeadlineAt, 'number');
    assert.deepEqual(durableLinkedState(db, fixture.campaignId), before);
  } finally {
    db.close();
  }
});

test('final transaction re-resolves conversation campaign after an in-flight custody move', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const destinationCampaignId = fixture.campaignId + 1;
    addCampaign(db, fixture, destinationCampaignId);
    const created = await ai.handleChat(db, linkedInput(fixture, 'move-race-create', {
      provider: successfulProvider([])
    }));
    let afterMove;
    const outcome = await settled(ai.handleChat(db, linkedInput(fixture, 'move-race-continue', {
      conversation_id: created.conversation_id,
      provider: {
        async complete() {
          db.prepare(`
            UPDATE campaign_record_links
            SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?,revoke_reason='test custody move'
            WHERE campaign_id=? AND record_type='ai_conversation'
              AND record_id=? AND relation_type='ai_run' AND revoked_at IS NULL
          `).run(fixture.userId, fixture.campaignId, String(created.conversation_id));
          db.prepare(`
            INSERT INTO campaign_record_links (
              org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
              created_by,metadata_json
            ) VALUES (?,?, 'ai_conversation', ?, ?, 'ai_run', ?, '{}')
          `).run(
            fixture.orgId,
            destinationCampaignId,
            sha256('conversation-move-race-bundle'),
            String(created.conversation_id),
            fixture.userId
          );
          afterMove = durableLinkedState(db, fixture.campaignId);
          return { content: 'must not persist after move', usage: {}, model: 'fake-deepseek' };
        }
      }
    })));

    assertServiceError(outcome, 409, 'CONVERSATION_CAMPAIGN_MISMATCH');
    assert.deepEqual(durableLinkedState(db, fixture.campaignId), afterMove);
  } finally {
    db.close();
  }
});

test('final transaction rejects an in-flight campaign access revocation before writing the assistant result', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const replacement = db.prepare(`
      SELECT membership.user_id AS userId,membership.team_id AS teamId
      FROM team_memberships membership
      JOIN users user ON user.id=membership.user_id AND user.is_active=1
      WHERE membership.org_id=? AND membership.status='active' AND membership.team_id<>?
      ORDER BY membership.user_id,membership.team_id
      LIMIT 1
    `).get(fixture.orgId, fixture.teamId);
    assert.ok(replacement, 'fixture requires a second active team');
    let afterRevocation;
    const outcome = await settled(ai.handleChat(db, linkedInput(fixture, 'access-revoke-race', {
      provider: {
        async complete() {
          db.prepare(`
            UPDATE campaigns
            SET owner_user_id=?,team_id=?,row_version=row_version+1
            WHERE id=?
          `).run(replacement.userId, replacement.teamId, fixture.campaignId);
          afterRevocation = durableLinkedState(db, fixture.campaignId);
          return { content: 'must not persist after access revocation', usage: {}, model: 'fake-deepseek' };
        }
      }
    })));

    assertServiceError(outcome, 403, 'CAMPAIGN_FORBIDDEN');
    assert.deepEqual(durableLinkedState(db, fixture.campaignId), afterRevocation);
  } finally {
    db.close();
  }
});

test('web cache insertion failure rolls back the linked conversation, references, archive, links, event, and success ledger', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    db.exec(`
      CREATE TRIGGER campaign_ai_force_web_cache_failure
      BEFORE INSERT ON web_search_cache
      BEGIN SELECT RAISE(ABORT,'forced web cache rollback'); END;
    `);
    const before = durableLinkedState(db, fixture.campaignId);
    const outcome = await settled(ai.handleChat(db, linkedInput(fixture, 'cache-rollback', {
      allowWeb: true,
      webSearchProvider: {
        async search() {
          return {
            used: true,
            provider: 'fake-web',
            results: [{
              title: 'Atomic cache result',
              url: 'https://example.invalid/atomic-cache',
              snippet: 'cache rollback contract',
              provider: 'fake-web'
            }]
          };
        }
      },
      provider: successfulProvider([])
    })));

    assertServiceError(outcome, 500, 'AI_PERSISTENCE_FAILED');
    assert.deepEqual(durableLinkedState(db, fixture.campaignId), before);
    const ledger = db.prepare(`
      SELECT state,status_code,response_json
      FROM request_idempotency
      WHERE idempotency_key=?
    `).get('campaign-ai-rag-key-cache-rollback');
    assert.equal(ledger.state, 'completed');
    assert.equal(ledger.status_code, 500);
    assert.equal(JSON.parse(ledger.response_json).code, 'AI_PERSISTENCE_FAILED');
  } finally {
    db.close();
  }
});

test('linked AI response uses the safe source projection and archives the exact immutable AI projection', async () => {
  const db = openDatabase();
  try {
    const fixture = createCampaignFixture(db);
    const selected = writeLinkedKnowledge(db, fixture, {
      label: 'sensitive-raw-source-id',
      title: 'Safe source projection',
      content: 'exactprojectionneedle evidence'
    });
    const question = 'exactprojectionneedle question';
    const answer = 'Answer ' + '😀'.repeat(1005);
    const result = await ai.handleChat(db, linkedInput(fixture, 'exact-ai-projection', {
      message: question,
      knowledge_entry_ids: [selected.entry.id],
      summaryVisibility: 'team',
      provider: successfulProvider([], answer)
    }));

    assert.equal(result.knowledge_references.length, 1);
    const reference = result.knowledge_references[0];
    assert.deepEqual(Object.keys(reference), [
      'citation_label', 'entry_id', 'chunk_id', 'chunk_index', 'title',
      'entry_type', 'source', 'visibility', 'snippet', 'selected', 'rank',
      'source_identity_sha256', 'entry_content_sha256', 'chunk_content_sha256'
    ]);
    assert.deepEqual(reference.source, { kind: 'other', label: 'Other knowledge' });
    assert.equal(Object.hasOwn(reference, 'source_id'), false);
    assert.equal(Object.hasOwn(reference, 'source_type'), false);

    const archive = db.prepare(`
      SELECT * FROM knowledge_entries WHERE id=?
    `).get(result.archived_summary_id);
    assert.ok(archive);
    assert.equal(archive.entry_type, 'ai_chat_summary');
    assert.equal(archive.source_type, 'campaign_ai_message');
    assert.equal(archive.source_id, result.message_id);
    assert.equal(archive.title, `AI conversation summary #${result.conversation_id}`);
    assert.equal(archive.content, `Question:\n${question}\n\nAnswer:\n${answer}`);
    assert.equal(archive.summary, Array.from(answer).slice(0, 1000).join(''));
    assert.equal(archive.visibility, 'private');
    assert.equal(archive.business_type, 'campaign');
    assert.equal(archive.business_id, String(fixture.campaignId));
    assert.equal(archive.created_by, fixture.userId);
    assert.equal(archive.tags_json, '["ai_chat","campaign","conversation"]');
    assert.match(archive.source_identity_sha256, /^[0-9a-f]{64}$/);
    assert.match(archive.content_sha256, /^[0-9a-f]{64}$/);
  } finally {
    db.close();
  }
});
