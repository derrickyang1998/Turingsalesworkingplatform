'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-ai-manual-promotion-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

function shortProvider(answer) {
  return {
    async complete() {
      return {
        content: answer,
        model: 'manual-promotion-test-model',
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 }
      };
    }
  };
}

test('an owner can manually promote a retained AI answer exactly once with policy and audit metadata', async () => {
  const db = freshDb();
  try {
    const ai = require('../services/ai_service');
    const chat = await ai.handleChat(db, {
      user: { id: 2, role: 'user' },
      message: '请给出一句简短建议。',
      allowWeb: false,
      provider: shortProvider('先确认客户目标。')
    });
    assert.equal(chat.summary_promotion.status, 'retained_only');
    assert.equal(chat.archived_summary_id, null);

    const first = ai.promoteMessageToKnowledge(db, {
      user: { id: 2, role: 'user' },
      conversation_id: chat.conversation_id,
      message_id: chat.message_id,
      visibility: 'private',
      requestId: 'manual-promotion-owner-0001'
    });
    const replay = ai.promoteMessageToKnowledge(db, {
      user: { id: 2, role: 'user' },
      conversation_id: chat.conversation_id,
      message_id: chat.message_id,
      visibility: 'private',
      requestId: 'manual-promotion-owner-0002'
    });

    assert.equal(first.status, 'promoted');
    assert.equal(replay.status, 'already_promoted');
    assert.equal(replay.knowledge_entry_id, first.knowledge_entry_id);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get().count, 1);
    assert.equal(
      db.prepare('SELECT archived_summary_id FROM ai_conversations WHERE id=?').get(chat.conversation_id).archived_summary_id,
      first.knowledge_entry_id
    );

    const entry = db.prepare('SELECT source_type,source_id,visibility,metadata_json FROM knowledge_entries WHERE id=?')
      .get(first.knowledge_entry_id);
    assert.equal(entry.source_type, 'ai_message');
    assert.equal(Number(entry.source_id), chat.message_id);
    assert.equal(entry.visibility, 'private');
    const metadata = JSON.parse(entry.metadata_json);
    assert.equal(metadata.promotion.status, 'promoted');
    assert.equal(metadata.promotion.reason, 'explicit_selection');
    assert.equal(metadata.promotion.policy_version, 'ai-summary-promotion-v1');
    assert.equal(metadata.promotion.trigger, 'manual');
    assert.equal(metadata.promotion.actor_user_id, 2);

    const audits = db.prepare(`
      SELECT details FROM activity_log
      WHERE user_id=2 AND module='ai_knowledge' AND action='manual_promote_ai_message'
      ORDER BY id
    `).all();
    assert.equal(audits.length, 2);
    assert.equal(JSON.parse(audits[0].details).request_id, 'manual-promotion-owner-0001');
    assert.equal(JSON.parse(audits[0].details).result, 'promoted');
    assert.equal(JSON.parse(audits[1].details).result, 'already_promoted');
  } finally {
    db.close();
  }
});

test('ordinary users cannot promote another owner answer while a platform admin can curate it', async () => {
  const db = freshDb();
  try {
    const ai = require('../services/ai_service');
    const chat = await ai.handleChat(db, {
      user: { id: 2, role: 'user' },
      message: '这条回复用于权限测试。',
      allowWeb: false,
      provider: shortProvider('权限测试回复。')
    });
    const other = db.prepare("SELECT id,role FROM users WHERE id<>2 AND role='user' AND is_active=1 ORDER BY id LIMIT 1").get();
    assert.ok(other);

    assert.throws(() => ai.promoteMessageToKnowledge(db, {
      user: other,
      conversation_id: chat.conversation_id,
      message_id: chat.message_id,
      visibility: 'private',
      requestId: 'manual-promotion-denied-0001'
    }), (error) => {
      assert.equal(error.statusCode || error.status, 404);
      assert.equal(error.code, 'RECORD_NOT_FOUND');
      return true;
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get().count, 0);
    const deniedAudit = db.prepare(`
      SELECT details FROM activity_log
      WHERE user_id=? AND module='ai_knowledge' AND action='manual_promote_ai_message'
    `).get(other.id);
    assert.ok(deniedAudit);
    assert.deepEqual(JSON.parse(deniedAudit.details), {
      request_id: 'manual-promotion-denied-0001',
      conversation_id: chat.conversation_id,
      message_id: chat.message_id,
      knowledge_entry_id: null,
      visibility: 'private',
      result: 'rejected',
      error_code: 'RECORD_NOT_FOUND'
    });

    const promoted = ai.promoteMessageToKnowledge(db, {
      user: { id: 1, role: 'admin' },
      conversation_id: chat.conversation_id,
      message_id: chat.message_id,
      visibility: 'private',
      requestId: 'manual-promotion-admin-0001'
    });
    assert.equal(promoted.status, 'promoted');
    assert.ok(promoted.knowledge_entry_id > 0);
  } finally {
    db.close();
  }
});

test('manual promotion rejects non-assistant messages and unsupported visibility without writing', async () => {
  const db = freshDb();
  try {
    const ai = require('../services/ai_service');
    const chat = await ai.handleChat(db, {
      user: { id: 2, role: 'user' },
      message: '验证错误目标。',
      allowWeb: false,
      provider: shortProvider('目标回复。')
    });
    const userMessage = db.prepare("SELECT id FROM ai_messages WHERE conversation_id=? AND role='user'")
      .get(chat.conversation_id);

    for (const input of [
      { message_id: userMessage.id, visibility: 'private', requestId: 'manual-promotion-invalid-0001' },
      { message_id: chat.message_id, visibility: 'public', requestId: 'manual-promotion-invalid-0002' }
    ]) {
      assert.throws(() => ai.promoteMessageToKnowledge(db, {
        user: { id: 2, role: 'user' },
        conversation_id: chat.conversation_id,
        message_id: input.message_id,
        visibility: input.visibility,
        requestId: input.requestId
      }), (error) => {
        assert.equal(error.statusCode || error.status, 400);
        assert.match(error.code, /^INVALID_AI_PROMOTION/);
        return true;
      });
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get().count, 0);
    const audits = db.prepare(`
      SELECT details FROM activity_log
      WHERE user_id=2 AND module='ai_knowledge' AND action='manual_promote_ai_message'
      ORDER BY id
    `).all().map((row) => JSON.parse(row.details));
    assert.equal(audits.length, 2);
    assert.deepEqual(audits.map((audit) => audit.result), ['rejected', 'rejected']);
    assert.deepEqual(audits.map((audit) => audit.request_id), [
      'manual-promotion-invalid-0001',
      'manual-promotion-invalid-0002'
    ]);
  } finally {
    db.close();
  }
});
