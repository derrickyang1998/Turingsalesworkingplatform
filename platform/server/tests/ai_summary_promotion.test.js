'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-ai-summary-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

function providerAnswer(content) {
  return {
    async complete() {
      return {
        content,
        model: 'promotion-test-model',
        usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 }
      };
    }
  };
}

function countSummaries(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='ai_chat_summary'").get().count;
}

test('short AI answers remain fully archived as messages but do not become reusable knowledge', async () => {
  const db = freshDb();
  try {
    const ai = require('../services/ai_service');
    const result = await ai.handleChat(db, {
      user: { id: 2, role: 'user' },
      message: '请给出本项目下一步建议。',
      allowWeb: false,
      provider: providerAnswer('先确认预算和交付时间。')
    });

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_conversations').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get().count, 2);
    assert.equal(countSummaries(db), 0);
    assert.equal(result.archived_summary_id, null);
    assert.deepEqual(result.summary_promotion, {
      status: 'retained_only',
      reason: 'insufficient_substance',
      policy_version: 'ai-summary-promotion-v1',
      question_length: 12,
      answer_length: 11,
      knowledge_reference_count: 0,
      web_reference_count: 0,
      evidence_count: 0
    });
  } finally {
    db.close();
  }
});

test('a substantive evidence-backed answer is promoted with auditable policy metadata', async () => {
  const db = freshDb();
  try {
    const knowledge = require('../services/knowledge_service');
    const ai = require('../services/ai_service');
    knowledge.ingestKnowledge(db, {
      title: '北美达人项目方法论',
      content: '项目应先确认受众、平台分工、预算结构、达人筛选标准、内容钩子和复盘指标。',
      entry_type: 'methodology',
      visibility: 'team',
      tags: ['达人营销', '项目方法论'],
      created_by: 1
    });
    const answer = [
      '建议一：先按目标受众和平台角色拆分达人组合，并记录每类达人承担的触达目标。',
      '建议二：把预算分为内容制作、达人合作和付费放大三部分，每周核对实际消耗。',
      '建议三：上线前统一内容钩子、产品证据和行动号召，上线后按播放、互动、点击和转化复盘。',
      '执行时应保留每次选择依据、调整原因和结果差异，形成下次可复用的方法论。'
    ].join('\n').repeat(2);
    const result = await ai.handleChat(db, {
      user: { id: 2, role: 'user' },
      message: '请结合知识库制定北美达人项目的完整执行建议。',
      allowWeb: false,
      provider: providerAnswer(answer)
    });

    assert.equal(result.summary_promotion.status, 'promoted');
    assert.equal(result.summary_promotion.reason, 'high_value');
    assert.equal(result.summary_promotion.knowledge_reference_count, 1);
    assert.equal(result.summary_promotion.evidence_count, 1);
    assert.equal(typeof result.archived_summary_id, 'number');
    assert.equal(countSummaries(db), 1);
    const archive = db.prepare('SELECT metadata_json FROM knowledge_entries WHERE id=?')
      .get(result.archived_summary_id);
    const metadata = JSON.parse(archive.metadata_json);
    assert.equal(metadata.promotion.policy_version, 'ai-summary-promotion-v1');
    assert.equal(metadata.promotion.reason, 'high_value');
    assert.equal(metadata.promotion.evidence_count, 1);
    assert.equal(metadata.conversation_id, result.conversation_id);
    assert.equal(metadata.assistant_message_id, result.message_id);
  } finally {
    db.close();
  }
});

test('a long answer without governed evidence stays out of reusable knowledge', async () => {
  const db = freshDb();
  try {
    const ai = require('../services/ai_service');
    const result = await ai.handleChat(db, {
      user: { id: 2, role: 'user' },
      message: '请写一份没有任何内部或联网证据支持的长建议。',
      allowWeb: false,
      provider: providerAnswer('没有证据的泛化建议。'.repeat(80))
    });

    assert.equal(result.summary_promotion.status, 'retained_only');
    assert.equal(result.summary_promotion.reason, 'insufficient_evidence');
    assert.equal(result.archived_summary_id, null);
    assert.equal(countSummaries(db), 0);
  } finally {
    db.close();
  }
});

test('an explicitly unconfirmed AI artifact never auto-promotes even when substantive and cited', async () => {
  const db = freshDb();
  try {
    const knowledge = require('../services/knowledge_service');
    const ai = require('../services/ai_service');
    knowledge.ingestKnowledge(db, {
      title: '未确认草稿证据',
      content: '这条证据仅用于验证未确认草稿不能自动进入知识库。',
      entry_type: 'methodology',
      visibility: 'team',
      created_by: 1
    });
    const result = await ai.handleChat(db, {
      user: { id: 2, role: 'user' },
      message: '请基于证据生成尚未确认的草稿。',
      allowWeb: false,
      archiveSummary: false,
      provider: providerAnswer('这是尚未确认的草稿内容。'.repeat(80))
    });

    assert.equal(result.summary_promotion.status, 'retained_only');
    assert.equal(result.summary_promotion.reason, 'disabled');
    assert.equal(result.archived_summary_id, null);
    assert.equal(countSummaries(db), 0);
  } finally {
    db.close();
  }
});
