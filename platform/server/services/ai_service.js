const knowledge = require('./knowledge_service');
const rag = require('./rag_service');
const llm = require('./llm_service');
const webSearch = require('./web_search_service');

function canAccessConversation(user, conversation) {
  return user && conversation && (user.role === 'admin' || Number(conversation.user_id) === Number(user.id));
}

function makeTitle(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 60) : 'AI conversation';
}

function clampMaxTokens(value) {
  const parsed = parseInt(value || 2200, 10) || 2200;
  return Math.max(256, Math.min(parsed, 4000));
}

function insertMessage(db, payload) {
  const result = db.prepare(`
    INSERT INTO ai_messages (
      conversation_id, user_id, role, content, model, prompt_tokens, completion_tokens, total_tokens, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.conversation_id,
    payload.user_id,
    payload.role,
    payload.content || '',
    payload.model || null,
    payload.prompt_tokens || 0,
    payload.completion_tokens || 0,
    payload.total_tokens || 0,
    JSON.stringify(payload.metadata || {})
  );
  return result.lastInsertRowid;
}

function ensureConversation(db, opts) {
  opts = opts || {};
  const user = opts.user;
  if (opts.conversation_id) {
    const conversation = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(opts.conversation_id);
    if (!canAccessConversation(user, conversation)) throw new Error('Conversation not found or forbidden');
    return conversation;
  }
  const result = db.prepare(`
    INSERT INTO ai_conversations (user_id, title, visibility, source_module)
    VALUES (?, ?, ?, ?)
  `).run(
    user.id,
    makeTitle(opts.message),
    opts.visibility || 'private',
    opts.source_module || 'assistant'
  );
  return db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(result.lastInsertRowid);
}

function recentMessages(db, conversationId, limit) {
  return db.prepare(`
    SELECT role, content
    FROM ai_messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(conversationId, limit || 10).reverse();
}

function saveReferences(db, messageId, references, webResults) {
  const insert = db.prepare(`
    INSERT INTO ai_references (message_id, reference_type, reference_id, title, url, snippet, provider, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (references || []).forEach(function(ref) {
    insert.run(
      messageId,
      'knowledge',
      String(ref.id),
      ref.title || '',
      '',
      ref.snippet || '',
      '',
      JSON.stringify(ref)
    );
  });
  (webResults || []).forEach(function(ref) {
    insert.run(
      messageId,
      'web',
      ref.url || ref.title || '',
      ref.title || '',
      ref.url || '',
      ref.snippet || '',
      ref.provider || '',
      JSON.stringify(ref)
    );
  });
}

function archiveChatSummary(db, opts) {
  const answer = String(opts.answer || '');
  const question = String(opts.message || '');
  if (!answer.trim() && !question.trim()) return null;
  const summary = 'Q: ' + question.slice(0, 1200) + '\n\nA: ' + answer.slice(0, 1800);
  return knowledge.ingestKnowledge(db, {
    title: 'AI 对话摘要：' + makeTitle(question),
    summary: answer.slice(0, 240),
    content: summary,
    entry_type: 'ai_chat_summary',
    source_type: 'ai_message',
    source_id: opts.assistantMessageId,
    business_type: opts.source_module || 'assistant',
    business_id: opts.conversationId,
    visibility: opts.visibility || 'private',
    tags: ['ai_chat', 'conversation'],
    created_by: opts.user.id,
    actor_role: opts.user.role,
    metadata: {
      conversation_id: opts.conversationId,
      assistant_message_id: opts.assistantMessageId,
      question: question.slice(0, 240)
    }
  });
}

async function handleChat(db, opts) {
  opts = opts || {};
  if (!opts.user || !opts.user.id) throw new Error('User required');
  const message = String(opts.message || '').trim();
  if (!message) throw new Error('Message required');

  const conversation = ensureConversation(db, opts);
  const userMessageId = insertMessage(db, {
    conversation_id: conversation.id,
    user_id: opts.user.id,
    role: 'user',
    content: message,
    metadata: { source_module: opts.source_module || conversation.source_module || 'assistant' }
  });

  const ragContext = rag.buildRagContext(db, {
    query: message,
    user: opts.user,
    limit: opts.knowledgeLimit || 8,
    business_type: opts.business_type,
    business_id: opts.business_id
  });

  let searchResult = { used: false, provider: opts.webProvider || 'tavily', results: [], reason: 'disabled' };
  if (opts.allowWeb !== false) {
    if (opts.webSearchProvider && typeof opts.webSearchProvider.search === 'function') {
      searchResult = await opts.webSearchProvider.search(message);
    } else {
      searchResult = await webSearch.searchWeb(message, {
        provider: opts.webProvider || process.env.WEB_SEARCH_PROVIDER || 'tavily',
        maxResults: opts.webMaxResults || 5,
        db: db
      });
    }
    webSearch.cacheSearchResult(db, message, searchResult);
  }

  const history = recentMessages(db, conversation.id, 8);
  const provider = opts.provider || llm.createDeepSeekProvider();
  const systemPrompt = rag.buildSystemPrompt({
    contextText: ragContext.contextText,
    webContext: webSearch.formatWebContext(searchResult)
  });
  const completion = await provider.complete({
    messages: [{ role: 'system', content: systemPrompt }].concat(history),
    temperature: opts.temperature,
    max_tokens: clampMaxTokens(opts.max_tokens),
    model: opts.model
  });

  const usage = completion.usage || {};
  const assistantMessageId = insertMessage(db, {
    conversation_id: conversation.id,
    user_id: opts.user.id,
    role: 'assistant',
    content: completion.content || '',
    model: completion.model || opts.model || process.env.AI_MODEL || 'deepseek-chat',
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    metadata: {
      degraded: !!completion.degraded,
      reason: completion.reason || '',
      rag_has_knowledge: ragContext.hasKnowledge,
      web_used: !!searchResult.used,
      user_message_id: userMessageId
    }
  });

  saveReferences(db, assistantMessageId, ragContext.references, searchResult.results);
  knowledge.markKnowledgeUsed(db, ragContext.references.map(function(ref) { return ref.id; }));
  db.prepare('UPDATE ai_conversations SET updated_at = datetime(\'now\') WHERE id = ?').run(conversation.id);
  if (usage.total_tokens || usage.prompt_tokens || usage.completion_tokens) {
    try {
      db.prepare('INSERT INTO token_usage (user_id, model, prompt_tokens, completion_tokens, total_tokens, endpoint) VALUES (?, ?, ?, ?, ?, ?)')
        .run(opts.user.id, completion.model || 'deepseek-chat', usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0, 'ai_chat');
    } catch (e) {}
  }

  let archived = null;
  if (opts.archiveSummary !== false) {
    archived = archiveChatSummary(db, {
      user: opts.user,
      message: message,
      answer: completion.content || '',
      conversationId: conversation.id,
      assistantMessageId: assistantMessageId,
      visibility: opts.summaryVisibility || 'private',
      source_module: opts.source_module || conversation.source_module
    });
    if (archived && archived.id) {
      db.prepare('UPDATE ai_conversations SET archived_summary_id = ? WHERE id = ?').run(archived.id, conversation.id);
    }
  }

  return {
    conversation_id: conversation.id,
    message_id: assistantMessageId,
    answer: completion.content || '',
    model: completion.model || opts.model || process.env.AI_MODEL || 'deepseek-chat',
    usage: usage,
    knowledge_references: ragContext.references,
    web_results: searchResult.results || [],
    web_search: {
      used: !!searchResult.used,
      provider: searchResult.provider || 'tavily',
      reason: searchResult.reason || ''
    },
    archived_summary_id: archived && archived.id ? archived.id : null
  };
}

function listConversations(db, opts) {
  opts = opts || {};
  const user = opts.user || {};
  const limit = Math.min(parseInt(opts.limit || 100, 10) || 100, 300);
  const where = [];
  const params = [];
  if (user.role !== 'admin') {
    where.push('c.user_id = ?');
    params.push(user.id || -1);
  }
  if (opts.user_id && user.role === 'admin') {
    where.push('c.user_id = ?');
    params.push(opts.user_id);
  }
  if (opts.source_module) {
    where.push('c.source_module = ?');
    params.push(opts.source_module);
  }
  if (opts.q) {
    where.push(`EXISTS (
      SELECT 1 FROM ai_messages m
      WHERE m.conversation_id = c.id AND m.content LIKE ?
    )`);
    params.push('%' + opts.q + '%');
  }
  const sql = `
    SELECT c.*, u.username, u.display_name,
      (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count,
      (SELECT content FROM ai_messages m WHERE m.conversation_id = c.id AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1) AS last_answer
    FROM ai_conversations c
    JOIN users u ON u.id = c.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function getConversation(db, opts) {
  opts = opts || {};
  const conversation = db.prepare(`
    SELECT c.*, u.username, u.display_name
    FROM ai_conversations c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(opts.id);
  if (!canAccessConversation(opts.user, conversation)) return null;
  const messages = db.prepare('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at, id').all(opts.id);
  const refs = db.prepare(`
    SELECT r.*
    FROM ai_references r
    JOIN ai_messages m ON m.id = r.message_id
    WHERE m.conversation_id = ?
    ORDER BY r.id
  `).all(opts.id);
  const byMessage = {};
  refs.forEach(function(ref) {
    if (!byMessage[ref.message_id]) byMessage[ref.message_id] = [];
    byMessage[ref.message_id].push(ref);
  });
  messages.forEach(function(message) {
    message.metadata = (() => {
      try { return JSON.parse(message.metadata_json || '{}'); } catch (e) { return {}; }
    })();
    message.references = byMessage[message.id] || [];
  });
  conversation.messages = messages;
  return conversation;
}

module.exports = {
  handleChat,
  listConversations,
  getConversation,
  ensureConversation
};
