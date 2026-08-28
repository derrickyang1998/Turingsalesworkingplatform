const knowledge = require('./knowledge_service');
const rag = require('./rag_service');
const llm = require('./llm_service');
const webSearch = require('./web_search_service');
const crypto = require('node:crypto');
const idempotency = require('./idempotency_service');
const { requestHash } = require('./sqlite_digest_service');
const {
  buildCollectionAccessPredicate,
  getCampaignAccess,
  resolveConversationCampaign,
  serializeKnowledgeReference
} = require('./campaign_access_service');

const LINKED_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const SUMMARY_PROMOTION_POLICY_VERSION = 'ai-summary-promotion-v1';
const SUMMARY_PROMOTION_MIN_QUESTION_LENGTH = 8;
const SUMMARY_PROMOTION_MIN_ANSWER_LENGTH = 240;
const aiCostSqlDatabases = new WeakSet();

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

function clampKnowledgeLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback || 8;
  return Math.min(parsed, 20);
}

function scalarLength(value) {
  return Array.from(String(value || '').trim()).length;
}

function decideSummaryPromotion(opts) {
  const questionLength = scalarLength(opts.message);
  const answerLength = scalarLength(opts.answer);
  const knowledgeReferenceCount = Array.isArray(opts.knowledgeReferences)
    ? opts.knowledgeReferences.length
    : 0;
  const webReferenceCount = opts.searchResult && opts.searchResult.used === true && Array.isArray(opts.searchResult.results)
    ? opts.searchResult.results.length
    : 0;
  const decision = {
    status: 'retained_only',
    reason: 'insufficient_substance',
    policy_version: SUMMARY_PROMOTION_POLICY_VERSION,
    question_length: questionLength,
    answer_length: answerLength,
    knowledge_reference_count: knowledgeReferenceCount,
    web_reference_count: webReferenceCount,
    evidence_count: knowledgeReferenceCount + webReferenceCount
  };
  if (opts.archiveSummary === false) {
    decision.reason = 'disabled';
    return decision;
  }
  if (opts.archiveSummary === true) {
    decision.status = 'promoted';
    decision.reason = 'explicit_selection';
    return decision;
  }
  if (opts.degraded === true) {
    decision.reason = 'degraded_response';
    return decision;
  }
  if (
    questionLength < SUMMARY_PROMOTION_MIN_QUESTION_LENGTH ||
    answerLength < SUMMARY_PROMOTION_MIN_ANSWER_LENGTH
  ) {
    return decision;
  }
  if (decision.evidence_count < 1) {
    decision.reason = 'insufficient_evidence';
    return decision;
  }
  decision.status = 'promoted';
  decision.reason = 'high_value';
  return decision;
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

function resolveCompletionModel(completion, requestedModel) {
  return completion && completion.model || requestedModel || process.env.AI_MODEL || llm.DEFAULT_DEEPSEEK_MODEL;
}

function completionCostSnapshot(completion, model) {
  const result = completion || {};
  return llm.createDeepSeekCostSnapshot({
    provider: result.provider || 'deepseek',
    model,
    occurredAt: result.completed_at,
    usage: result.usage || {},
    degraded: result.degraded === true
  });
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
  const manuallySelected = opts.promotion && opts.promotion.trigger === 'manual';
  return knowledge.ingestBusinessArtifact(db, {
    artifactType: manuallySelected ? 'selected_conclusion' : 'ai_summary',
    artifactState: manuallySelected ? 'selected' : 'promoted',
    title: 'AI 对话摘要：' + makeTitle(question),
    summary: answer.slice(0, 240),
    content: summary,
    sourceId: opts.assistantMessageId,
    businessType: opts.source_module || 'assistant',
    businessId: opts.conversationId,
    visibility: opts.visibility || 'private',
    tags: ['ai_chat', 'conversation'],
    createdBy: opts.user.id,
    actorRole: opts.user.role,
    metadata: {
      conversation_id: opts.conversationId,
      assistant_message_id: opts.assistantMessageId,
      question: question.slice(0, 240),
      promotion: opts.promotion
    }
  }).entry;
}

async function handleLegacyChat(db, opts) {
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

  const retrievalQuery = String(opts.ragQuery || message).trim() || message;
  const webQuery = String(opts.webQuery || retrievalQuery).trim() || retrievalQuery;
  const ragContext = rag.buildRagContext(db, {
    query: retrievalQuery,
    user: opts.user,
    limit: clampKnowledgeLimit(opts.knowledgeLimit, 8),
    business_type: opts.business_type,
    business_id: opts.business_id
  });

  let searchResult = {
    used: false,
    provider: opts.webProvider || 'tavily',
    results: [],
    reason_code: 'disabled',
    reason: 'disabled'
  };
  if (opts.allowWeb !== false) {
    if (opts.webSearchProvider && typeof opts.webSearchProvider.search === 'function') {
      searchResult = await opts.webSearchProvider.search(webQuery);
    } else {
      searchResult = await webSearch.searchWeb(webQuery, {
        provider: opts.webProvider || process.env.WEB_SEARCH_PROVIDER || 'tavily',
        maxResults: opts.webMaxResults || 5,
        db: db
      });
    }
    searchResult = normalizeWebSearchResult(
      searchResult,
      opts.webProvider || process.env.WEB_SEARCH_PROVIDER || 'tavily'
    );
    webSearch.cacheSearchResult(db, webQuery, searchResult);
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
  const completionModel = resolveCompletionModel(completion, opts.model);
  const costSnapshot = completionCostSnapshot(completion, completionModel);
  const assistantMessageId = insertMessage(db, {
    conversation_id: conversation.id,
    user_id: opts.user.id,
    role: 'assistant',
    content: completion.content || '',
    model: completionModel,
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    metadata: {
      degraded: !!completion.degraded,
      reason: completion.reason || '',
      rag_has_knowledge: ragContext.hasKnowledge,
      web_used: !!searchResult.used,
      user_message_id: userMessageId,
      cost_snapshot: costSnapshot
    }
  });

  saveReferences(db, assistantMessageId, ragContext.references, searchResult.results);
  knowledge.recordKnowledgeUsageTelemetry(
    db,
    ragContext.references.map(function(ref) { return ref.id; }),
    opts.user
  );
  db.prepare('UPDATE ai_conversations SET updated_at = datetime(\'now\') WHERE id = ?').run(conversation.id);
  if (usage.total_tokens || usage.prompt_tokens || usage.completion_tokens) {
    try {
      db.prepare('INSERT INTO token_usage (user_id, model, prompt_tokens, completion_tokens, total_tokens, endpoint) VALUES (?, ?, ?, ?, ?, ?)')
        .run(opts.user.id, completionModel, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0, 'ai_chat');
    } catch (e) {}
  }

  const promotion = decideSummaryPromotion({
    message,
    answer: completion.content || '',
    knowledgeReferences: ragContext.references,
    searchResult,
    archiveSummary: opts.archiveSummary,
    degraded: !!completion.degraded
  });
  let archived = null;
  if (promotion.status === 'promoted') {
    archived = archiveChatSummary(db, {
      user: opts.user,
      message: message,
      answer: completion.content || '',
      conversationId: conversation.id,
      assistantMessageId: assistantMessageId,
      visibility: opts.summaryVisibility || 'private',
      source_module: opts.source_module || conversation.source_module,
      promotion
    });
    if (archived && archived.id) {
      db.prepare('UPDATE ai_conversations SET archived_summary_id = ? WHERE id = ?').run(archived.id, conversation.id);
    }
  }

  return {
    conversation_id: conversation.id,
    message_id: assistantMessageId,
    answer: completion.content || '',
    model: completionModel,
    usage: usage,
    cost_projection: llm.projectDeepSeekCostSnapshot(costSnapshot),
    knowledge_references: ragContext.references,
    web_results: searchResult.results || [],
    web_search: {
      used: !!searchResult.used,
      provider: searchResult.provider || 'tavily',
      reason: searchResult.reason || '',
      reason_code: searchResult.reason_code || '',
      cached: searchResult.cached === true
    },
    archived_summary_id: archived && archived.id ? archived.id : null,
    summary_promotion: promotion
  };
}

function createOneShotProviderContext(opts) {
  const rawTimeout = Number(opts.operationTimeoutMs);
  const timeoutMs = Number.isSafeInteger(rawTimeout) && rawTimeout > 0
    ? Math.min(rawTimeout, 120000)
    : 60000;
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('AI provider deadline exceeded.'));
    }
  };
  let detachExternal = null;
  if (opts.signal && typeof opts.signal.addEventListener === 'function') {
    if (opts.signal.aborted) {
      abort();
    } else {
      const onAbort = () => abort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
      detachExternal = () => opts.signal.removeEventListener('abort', onAbort);
    }
  }
  const timer = setTimeout(abort, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    deadlineAt: Date.now() + timeoutMs,
    dispose() {
      clearTimeout(timer);
      if (detachExternal) detachExternal();
    }
  };
}

function validateOneShotCompletion(completion, opts) {
  let valid = Boolean(completion && typeof completion.content === 'string' && completion.content.length > 0);
  if (valid && typeof opts.validateCompletion === 'function') {
    try {
      valid = opts.validateCompletion(completion.content) === true;
    } catch (_error) {
      valid = false;
    }
  }
  if (!valid) {
    return {
      content: String(opts.degradedContent || ''),
      usage: completion && completion.usage || {},
      model: completion && completion.model || opts.model || process.env.AI_MODEL || llm.DEFAULT_DEEPSEEK_MODEL,
      degraded: true,
      reason: 'AI response format invalid'
    };
  }
  if (completion.degraded) {
    return Object.assign({}, completion, {
      degraded: true,
      reason: 'AI provider returned a degraded response'
    });
  }
  return Object.assign({}, completion, { degraded: false, reason: '' });
}

function persistAtomicOneShot(db, opts) {
  return db.transaction(() => {
    const conversation = ensureConversation(db, opts);
    const userMessageId = insertMessage(db, {
      conversation_id: conversation.id,
      user_id: opts.user.id,
      role: 'user',
      content: opts.message,
      metadata: {
        source_module: opts.source_module || conversation.source_module || 'assistant',
        status: opts.completion.degraded ? 'degraded' : 'succeeded'
      }
    });
    const usage = opts.completion.usage || {};
    const completionModel = resolveCompletionModel(opts.completion, opts.model);
    const costSnapshot = completionCostSnapshot(opts.completion, completionModel);
    const assistantMessageId = insertMessage(db, {
      conversation_id: conversation.id,
      user_id: opts.user.id,
      role: 'assistant',
      content: opts.completion.content || '',
      model: completionModel,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      metadata: {
        degraded: !!opts.completion.degraded,
        reason: opts.completion.reason || '',
        status: opts.completion.degraded ? 'degraded' : 'succeeded',
        latency_ms: opts.latencyMs,
        rag_has_knowledge: opts.ragContext.hasKnowledge,
        web_used: !!opts.searchResult.used,
        user_message_id: userMessageId,
        cost_snapshot: costSnapshot
      }
    });

    saveReferences(db, assistantMessageId, opts.ragContext.references, opts.searchResult.results);
    knowledge.recordKnowledgeUsageTelemetry(
      db,
      opts.ragContext.references.map(function(reference) { return reference.id; }),
      opts.user
    );
    db.prepare('UPDATE ai_conversations SET updated_at=datetime(\'now\') WHERE id=?')
      .run(conversation.id);
    if (usage.total_tokens || usage.prompt_tokens || usage.completion_tokens) {
      db.prepare(`
        INSERT INTO token_usage (
          user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint
        ) VALUES (?,?,?,?,?,?)
      `).run(
        opts.user.id,
        completionModel,
        usage.prompt_tokens || 0,
        usage.completion_tokens || 0,
        usage.total_tokens || 0,
        opts.source_module || 'ai_one_shot'
      );
    }
    if (opts.searchResult.used) {
      webSearch.cacheSearchResultInTransaction(db, opts.webQuery, opts.searchResult);
    }

    return {
      conversation_id: conversation.id,
      message_id: assistantMessageId,
      answer: opts.completion.content || '',
      model: completionModel,
      usage,
      cost_projection: llm.projectDeepSeekCostSnapshot(costSnapshot),
      knowledge_references: opts.ragContext.references,
      web_results: opts.searchResult.results || [],
      web_search: {
        used: !!opts.searchResult.used,
        provider: opts.searchResult.provider || 'tavily',
        reason: opts.searchResult.reason || ''
      },
      degraded: !!opts.completion.degraded,
      reason: opts.completion.reason || '',
      status: opts.completion.degraded ? 'degraded' : 'succeeded',
      latency_ms: opts.latencyMs,
      archived_summary_id: null
    };
  }).immediate();
}

async function handleAtomicLegacyOneShot(db, opts) {
  const message = String(opts.message || '').trim();
  const retrievalQuery = String(opts.ragQuery || message).trim() || message;
  const webQuery = String(opts.webQuery || retrievalQuery).trim() || retrievalQuery;
  const ragContext = rag.buildRagContext(db, {
    query: retrievalQuery,
    user: opts.user,
    limit: clampKnowledgeLimit(opts.knowledgeLimit, 8),
    visibility: opts.visibility || 'private',
    business_type: opts.business_type,
    business_id: opts.business_id
  });
  const providerContext = createOneShotProviderContext(opts);
  const startedAt = Date.now();
  let searchResult = {
    used: false,
    provider: opts.webProvider || 'tavily',
    results: [],
    reason: 'disabled'
  };
  let completion;
  try {
    if (opts.allowWeb === true) {
      try {
        const webOperation = opts.webSearchProvider && typeof opts.webSearchProvider.search === 'function'
          ? opts.webSearchProvider.search(webQuery, {
              signal: providerContext.signal,
              deadlineAt: providerContext.deadlineAt
            })
          : webSearch.searchWeb(webQuery, {
              provider: opts.webProvider || process.env.WEB_SEARCH_PROVIDER || 'tavily',
              maxResults: opts.webMaxResults || 5,
              db,
              signal: providerContext.signal
            });
        searchResult = normalizeWebSearchResult(
          await awaitWithAbort(webOperation, providerContext.signal),
          opts.webProvider || 'tavily'
        );
      } catch (_error) {
        searchResult = {
          used: false,
          provider: opts.webProvider || 'tavily',
          results: [],
          reason: 'web search unavailable'
        };
      }
    }

    const provider = opts.provider || llm.createDeepSeekProvider();
    const systemPrompt = rag.buildSystemPrompt({
      contextText: ragContext.contextText,
      webContext: webSearch.formatWebContext(searchResult)
    });
    try {
      const rawCompletion = await awaitWithAbort(provider.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        temperature: opts.temperature,
        max_tokens: clampMaxTokens(opts.max_tokens),
        model: opts.model,
        signal: providerContext.signal,
        deadlineAt: providerContext.deadlineAt
      }), providerContext.signal);
      completion = validateOneShotCompletion(rawCompletion, opts);
    } catch (_error) {
      completion = {
        content: String(opts.degradedContent || ''),
        usage: {},
        model: opts.model || process.env.AI_MODEL || llm.DEFAULT_DEEPSEEK_MODEL,
        degraded: true,
        reason: 'AI provider unavailable'
      };
    }
  } finally {
    providerContext.dispose();
  }

  return persistAtomicOneShot(db, {
    ...opts,
    message,
    webQuery,
    ragContext,
    searchResult,
    completion,
    latencyMs: Math.max(0, Date.now() - startedAt)
  });
}

function serviceError(statusCode, code, message) {
  const error = new Error(message);
  error.name = 'AIServiceError';
  error.statusCode = statusCode;
  error.status = statusCode;
  error.code = code;
  return error;
}

function providerUnavailableError() {
  return serviceError(503, 'AI_PROVIDER_UNAVAILABLE', 'DeepSeek is unavailable for linked AI chat.');
}

function parseSqliteDeadline(value) {
  if (typeof value !== 'string') return NaN;
  return Date.parse(value.replace(' ', 'T') + 'Z');
}

function createLinkedProviderContext(reservation, externalSignal) {
  const deadlineAt = parseSqliteDeadline(reservation && reservation.operationDeadline);
  if (!Number.isFinite(deadlineAt)) {
    throw serviceError(500, 'AUDIT_PERSISTENCE_FAILED', 'Linked AI deadline is invalid.');
  }
  const controller = new AbortController();
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    controller.abort(reason instanceof Error ? reason : new Error('Linked AI operation aborted.'));
  };
  let detachExternal = null;
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    if (externalSignal.aborted) {
      abort(externalSignal.reason);
    } else {
      const onAbort = () => abort(externalSignal.reason);
      externalSignal.addEventListener('abort', onAbort, { once: true });
      detachExternal = () => externalSignal.removeEventListener('abort', onAbort);
    }
  }
  const timer = setTimeout(
    () => abort(new Error('Linked AI provider deadline exceeded.')),
    Math.max(0, deadlineAt - Date.now())
  );
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    deadlineAt,
    dispose() {
      clearTimeout(timer);
      if (detachExternal) detachExternal();
    }
  };
}

function assertProviderContextActive(context) {
  if (!context || context.signal.aborted || Date.now() >= context.deadlineAt) {
    throw providerUnavailableError();
  }
}

function awaitWithAbort(value, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Operation aborted.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      handler(result);
    };
    const onAbort = () => finish(reject, signal.reason || new Error('Operation aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error)
    );
  });
}

function positiveId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function ownValue(object, key) {
  return object && Object.prototype.hasOwnProperty.call(object, key)
    ? object[key]
    : undefined;
}

function requestedCampaignValue(opts) {
  const snake = ownValue(opts, 'campaign_id');
  return snake !== undefined ? snake : ownValue(opts, 'campaignId');
}

function requestedConversationValue(opts) {
  const snake = ownValue(opts, 'conversation_id');
  return snake !== undefined ? snake : ownValue(opts, 'conversationId');
}

function resolveLinkedContext(db, opts) {
  const rawCampaignId = requestedCampaignValue(opts);
  const rawConversationId = requestedConversationValue(opts);
  const campaignRequested = rawCampaignId !== undefined && rawCampaignId !== null && rawCampaignId !== '';
  const conversationRequested = rawConversationId !== undefined && rawConversationId !== null && rawConversationId !== '';
  const requestedCampaignId = campaignRequested ? positiveId(rawCampaignId) : null;
  const conversationId = conversationRequested ? positiveId(rawConversationId) : null;
  if ((campaignRequested && requestedCampaignId === null) || (conversationRequested && conversationId === null)) {
    throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'Campaign and conversation identifiers must be positive integers.');
  }
  if (!conversationRequested) {
    return requestedCampaignId === null
      ? { linked: false, campaignId: null, conversationId: null, initialLink: false }
      : { linked: true, campaignId: requestedCampaignId, conversationId: null, initialLink: true };
  }
  const resolution = resolveConversationCampaign(db, {
    conversationId,
    requestedCampaignId
  });
  if (!resolution.ok) {
    throw serviceError(
      resolution.status || 400,
      resolution.code || 'INVALID_CAMPAIGN_INPUT',
      resolution.code === 'CONVERSATION_CAMPAIGN_MISMATCH'
        ? 'Conversation is already linked to another campaign.'
        : 'Conversation campaign context is invalid.'
    );
  }
  if (resolution.campaignId === null) {
    return { linked: false, campaignId: null, conversationId, initialLink: false };
  }
  return {
    linked: true,
    campaignId: resolution.campaignId,
    conversationId,
    initialLink: !resolution.derived
  };
}

function requireLinkedCampaignAccess(db, userId, campaignId) {
  const access = getCampaignAccess(db, { userId, campaignId });
  if (access.ok) return access;
  throw serviceError(
    access.status || access.statusCode || 403,
    access.code || 'RECORD_FORBIDDEN',
    'Campaign is unavailable for this AI conversation.'
  );
}

function requireLinkedConversationAccess(db, user, conversationId) {
  const conversation = db.prepare('SELECT * FROM ai_conversations WHERE id=?').get(conversationId);
  if (!canAccessConversation(user, conversation)) {
    throw serviceError(404, 'RECORD_NOT_FOUND', 'Conversation was not found.');
  }
  return conversation;
}

function requireLinkedIdempotencyKey(opts) {
  const value = ownValue(opts, 'idempotencyKey') !== undefined
    ? opts.idempotencyKey
    : ownValue(opts, 'idempotency_key');
  if (typeof value !== 'string' || !LINKED_IDEMPOTENCY_KEY.test(value)) {
    throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'A valid idempotency key is required for linked AI chat.');
  }
  return value;
}

function normalizeRequestId(opts, key) {
  const raw = ownValue(opts, 'requestId') !== undefined ? opts.requestId : ownValue(opts, 'request_id');
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 200);
  return `ai-chat:${key.slice(0, 160)}`;
}

function linkedRequestHash(message, linked, ragContext, opts) {
  return requestHash({
    method: 'POST',
    path: '/api/ai/chat',
    campaignId: linked.campaignId,
    kind: 'json',
    payload: {
      message,
      campaign_id: linked.campaignId,
      conversation_id: linked.conversationId,
      source_module: String(opts.source_module || 'assistant'),
      allow_web: opts.allowWeb !== false,
      knowledge_entry_ids: ragContext.selectedEntryIds
    }
  });
}

function reservationDispositionError(disposition) {
  if (disposition.state === 'conflict') {
    return serviceError(disposition.statusCode || 409, disposition.code || 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key conflicts with an earlier request.');
  }
  if (disposition.state === 'processing') {
    return serviceError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Linked AI chat is already in progress.');
  }
  return serviceError(500, 'AUDIT_PERSISTENCE_FAILED', 'Linked AI chat idempotency state is invalid.');
}

function reserveLinkedOperation(db, opts) {
  const disposition = db.transaction(() => {
    requireLinkedCampaignAccess(db, opts.user.id, opts.campaignId);
    let result = idempotency.recoverExpiredInTransaction(db, opts.reservationInput);
    if (result.state === 'absent') {
      result = idempotency.reserveProcessingInTransaction(db, opts.reservationInput);
    }
    return result;
  }).immediate();
  if (disposition.state === 'reserved') return disposition;
  if (disposition.state === 'replay') {
    if (disposition.statusCode >= 400) {
      const body = disposition.responseBody || {};
      throw serviceError(
        disposition.statusCode,
        body.code || 'AI_PROVIDER_UNAVAILABLE',
        body.error || 'Linked AI chat could not be completed.'
      );
    }
    return disposition;
  }
  throw reservationDispositionError(disposition);
}

function completeLinkedFailure(db, reservation, requestHashValue, requestId, error) {
  const statusCode = Number.isSafeInteger(error && error.statusCode)
    ? error.statusCode
    : 500;
  const responseBody = {
    error: error && error.message ? String(error.message).slice(0, 300) : 'Linked AI chat failed.',
    code: error && error.code ? error.code : 'AI_PROVIDER_UNAVAILABLE',
    request_id: requestId
  };
  db.transaction(() => {
    idempotency.completeJsonInTransaction(db, {
      ledgerId: reservation.ledgerId,
      requestHash: requestHashValue,
      leaseToken: reservation.leaseToken,
      statusCode,
      responseBody
    });
  }).immediate();
}

function normalizeWebSearchResult(result, provider) {
  return webSearch.governSearchResult(result, provider, { maxResults: 10 });
}

async function runOptionalWebSearch(db, message, opts, providerContext) {
  const providerName = opts.webProvider || process.env.WEB_SEARCH_PROVIDER || 'tavily';
  if (opts.allowWeb === false) {
    return {
      used: false,
      provider: providerName,
      results: [],
      reason_code: 'disabled',
      reason: 'disabled'
    };
  }
  try {
    const operation = opts.webSearchProvider && typeof opts.webSearchProvider.search === 'function'
      ? opts.webSearchProvider.search(message, providerContext)
      : webSearch.searchWeb(message, {
        provider: providerName,
        maxResults: opts.webMaxResults || 5,
        db,
        signal: providerContext.signal,
        deadlineAt: providerContext.deadlineAt
      });
    const result = await awaitWithAbort(operation, providerContext.signal);
    return normalizeWebSearchResult(result, providerName);
  } catch (error) {
    if (providerContext.signal.aborted) throw error;
    return {
      used: false,
      provider: providerName,
      results: [],
      reason_code: 'provider_unavailable',
      reason: 'web search temporarily unavailable'
    };
  }
}

function insertCampaignRecordLink(db, values) {
  const bundleId = crypto.randomBytes(32).toString('hex');
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    values.organizationId,
    values.campaignId,
    values.recordType,
    bundleId,
    String(values.recordId),
    values.relationType,
    values.userId,
    JSON.stringify(values.metadata || {})
  );
  return { id: Number(result.lastInsertRowid), bundleId };
}

function insertLinkedConversationEvent(db, values) {
  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?,'link_attached',NULL,NULL,?,?,?,?,?,?)
  `).run(
    values.organizationId,
    values.campaignId,
    values.userId,
    'Linked ai_run',
    'ai_link',
    JSON.stringify({
      record_type: 'ai_conversation',
      record_id: String(values.conversationId),
      relation_types: ['ai_run'],
      link_ids: [values.link.id],
      bundle_id: values.link.bundleId
    }),
    values.requestId,
    values.auditFingerprint
  );
}

function saveLinkedReferences(db, messageId, campaignId, references, webResults) {
  const insertKnowledge = db.prepare(`
    INSERT INTO ai_references (
      message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json,
      reference_schema_version,knowledge_entry_id,knowledge_chunk_id,campaign_id,
      source_identity_sha256,entry_content_sha256,chunk_content_sha256,reference_rank,
      selection_origin
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  (references || []).forEach((reference) => {
    insertKnowledge.run(
      messageId,
      'knowledge',
      String(reference.entry_id),
      reference.title || '',
      '',
      reference.snippet || '',
      '',
      JSON.stringify({ selected: !!reference.selected, rank: reference.rank }),
      1,
      reference.entry_id,
      reference.chunk_id,
      campaignId,
      reference.source_identity_sha256,
      reference.entry_content_sha256,
      reference.chunk_content_sha256,
      reference.rank,
      reference.selection_origin
    );
  });
  saveReferences(db, messageId, [], webResults);
}

function archiveLinkedChatSummary(db, opts) {
  const answer = String(opts.answer || '');
  const question = String(opts.message || '');
  const content = `Question:\n${question}\n\nAnswer:\n${answer}`;
  const manuallySelected = opts.promotion && opts.promotion.trigger === 'manual';
  const written = knowledge.ingestBusinessArtifact(db, {
    artifactType: manuallySelected ? 'selected_conclusion' : 'ai_summary',
    artifactState: manuallySelected ? 'selected' : 'promoted',
    organizationId: opts.access.campaign.org_id,
    campaignId: opts.campaignId,
    createdBy: opts.user.id,
    sourceId: opts.assistantMessageId,
    title: `AI conversation summary #${opts.conversationId}`,
    summary: Array.from(answer).slice(0, 1000).join(''),
    content,
    tags: ['ai_chat', 'campaign', 'conversation'],
    visibility: opts.visibility || 'private',
    metadata: {
      conversation_id: opts.conversationId,
      assistant_message_id: opts.assistantMessageId,
      promotion: opts.promotion
    }
  });
  if (written.status !== 'created') {
    throw serviceError(409, 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT', 'AI conversation summary already exists.');
  }
  const link = insertCampaignRecordLink(db, {
    organizationId: opts.access.campaign.org_id,
    campaignId: opts.campaignId,
    userId: opts.user.id,
    recordType: 'knowledge_entry',
    recordId: written.entry.id,
    relationType: 'knowledge',
    metadata: {}
  });
  knowledge.applyKnowledgeCapacityGaugePlanInTransaction(db, written.capacityGaugePlan);
  db.prepare('UPDATE ai_conversations SET archived_summary_id=? WHERE id=?')
    .run(written.entry.id, opts.conversationId);
  return { id: written.entry.id, linkId: link.id };
}

function requireFinalConversationCampaign(db, conversationId, campaignId) {
  const resolution = resolveConversationCampaign(db, {
    conversationId,
    requestedCampaignId: campaignId
  });
  if (!resolution.ok || resolution.campaignId !== campaignId || resolution.derived !== true) {
    throw serviceError(
      resolution.status || 409,
      resolution.code || 'CONVERSATION_CAMPAIGN_MISMATCH',
      'Conversation campaign custody changed during linked AI generation.'
    );
  }
}

function requireFinalKnowledgeAccess(db, user, campaignId, references) {
  const entryIds = [...new Set((references || []).map((reference) => reference.entry_id))];
  for (const entryId of entryIds) {
    if (!knowledge.campaignKnowledgeEntryAllowsRead(db, { user, campaignId, entryId })) {
      throw serviceError(404, 'KNOWLEDGE_ENTRY_NOT_FOUND', 'Knowledge access changed during linked AI generation.');
    }
  }
}

function projectLinkedReferences(references) {
  return (references || []).map((reference) => (
    serializeKnowledgeReference(reference, { target: 'available' })
  ));
}

function persistLinkedChat(db, opts) {
  return db.transaction(() => {
    assertProviderContextActive(opts.providerContext);
    const access = requireLinkedCampaignAccess(db, opts.user.id, opts.linked.campaignId);
    let conversation;
    let link = null;
    if (opts.linked.conversationId !== null) {
      conversation = requireLinkedConversationAccess(db, opts.user, opts.linked.conversationId);
    } else {
      const created = db.prepare(`
        INSERT INTO ai_conversations (user_id,title,visibility,source_module)
        VALUES (?,?,?,?)
      `).run(
        opts.user.id,
        makeTitle(opts.message),
        opts.visibility || 'private',
        opts.source_module || 'assistant'
      );
      conversation = db.prepare('SELECT * FROM ai_conversations WHERE id=?').get(created.lastInsertRowid);
    }
    if (opts.linked.initialLink) {
      link = insertCampaignRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId: opts.linked.campaignId,
        userId: opts.user.id,
        recordType: 'ai_conversation',
        recordId: conversation.id,
        relationType: 'ai_run',
        metadata: {}
      });
      insertLinkedConversationEvent(db, {
        organizationId: access.campaign.org_id,
        campaignId: opts.linked.campaignId,
        userId: opts.user.id,
        conversationId: conversation.id,
        link,
        requestId: opts.requestId,
        auditFingerprint: opts.reservation.auditFingerprint
      });
    }
    requireFinalConversationCampaign(db, conversation.id, opts.linked.campaignId);
    requireFinalKnowledgeAccess(
      db,
      opts.user,
      opts.linked.campaignId,
      opts.ragContext.references
    );
    const userMessageId = insertMessage(db, {
      conversation_id: conversation.id,
      user_id: opts.user.id,
      role: 'user',
      content: opts.message,
      metadata: { source_module: opts.source_module || conversation.source_module || 'assistant' }
    });
    const usage = opts.completion.usage || {};
    const completionModel = resolveCompletionModel(opts.completion, opts.model);
    const costSnapshot = completionCostSnapshot(opts.completion, completionModel);
    const assistantMessageId = insertMessage(db, {
      conversation_id: conversation.id,
      user_id: opts.user.id,
      role: 'assistant',
      content: opts.completion.content || '',
      model: completionModel,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      metadata: {
        degraded: false,
        reason: '',
        status: 'succeeded',
        latency_ms: opts.latencyMs,
        rag_has_knowledge: opts.ragContext.hasKnowledge,
        web_used: opts.searchResult.used,
        user_message_id: userMessageId,
        campaign_id: opts.linked.campaignId,
        cost_snapshot: costSnapshot
      }
    });
    saveLinkedReferences(
      db,
      assistantMessageId,
      opts.linked.campaignId,
      opts.ragContext.references,
      opts.searchResult.results
    );
    knowledge.recordKnowledgeUsageTelemetry(
      db,
      opts.ragContext.references.map((reference) => reference.entry_id),
      opts.user
    );
    db.prepare('UPDATE ai_conversations SET updated_at=datetime(\'now\') WHERE id=?').run(conversation.id);
    if (usage.total_tokens || usage.prompt_tokens || usage.completion_tokens) {
      db.prepare(`
        INSERT INTO token_usage (
          user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint
        ) VALUES (?,?,?,?,?,?)
      `).run(
        opts.user.id,
        completionModel,
        usage.prompt_tokens || 0,
        usage.completion_tokens || 0,
        usage.total_tokens || 0,
        'ai_chat_linked'
      );
    }
    if (opts.searchResult.used) {
      webSearch.cacheSearchResultInTransaction(db, opts.webQuery, opts.searchResult);
    }
    const promotion = decideSummaryPromotion({
      message: opts.message,
      answer: opts.completion.content || '',
      knowledgeReferences: opts.ragContext.references,
      searchResult: opts.searchResult,
      archiveSummary: opts.archiveSummary,
      degraded: false
    });
    const archived = promotion.status === 'promoted'
      ? archiveLinkedChatSummary(db, {
          access,
          campaignId: opts.linked.campaignId,
          user: opts.user,
          message: opts.message,
          answer: opts.completion.content || '',
          conversationId: conversation.id,
          assistantMessageId,
          summaryVisibility: opts.summaryVisibility,
          promotion
        })
      : null;
    const response = {
      conversation_id: conversation.id,
      message_id: assistantMessageId,
      answer: opts.completion.content || '',
      model: completionModel,
      usage,
      cost_projection: llm.projectDeepSeekCostSnapshot(costSnapshot),
      knowledge_references: projectLinkedReferences(opts.ragContext.references),
      web_results: opts.searchResult.results || [],
      web_search: {
        used: !!opts.searchResult.used,
        provider: opts.searchResult.provider || 'tavily',
        reason: opts.searchResult.reason || '',
        reason_code: opts.searchResult.reason_code || '',
        cached: opts.searchResult.cached === true
      },
      degraded: false,
      reason: '',
      status: 'succeeded',
      latency_ms: opts.latencyMs,
      archived_summary_id: archived && archived.id ? archived.id : null,
      summary_promotion: promotion,
      campaign_id: opts.linked.campaignId
    };
    if (link) response.link_id = link.id;
    idempotency.completeJsonInTransaction(db, {
      ledgerId: opts.reservation.ledgerId,
      requestHash: opts.requestHashValue,
      leaseToken: opts.reservation.leaseToken,
      statusCode: 200,
      responseBody: response
    });
    return response;
  }).immediate();
}

async function handleLinkedChat(db, opts, linked) {
  const message = String(opts.message || '').trim();
  const retrievalQuery = String(opts.ragQuery || message).trim() || message;
  const webQuery = String(opts.webQuery || retrievalQuery).trim() || retrievalQuery;
  const user = opts.user;
  requireLinkedCampaignAccess(db, user.id, linked.campaignId);
  if (linked.conversationId !== null) {
    requireLinkedConversationAccess(db, user, linked.conversationId);
  }
  const ragContext = rag.buildLinkedRagContext(db, {
    query: retrievalQuery,
    user,
    campaignId: linked.campaignId,
    knowledge_entry_ids: opts.knowledge_entry_ids === undefined
      ? opts.knowledgeEntryIds
      : opts.knowledge_entry_ids,
    entry_type: opts.entry_type,
    source_type: opts.source_type,
    visibility: opts.visibility,
    business_type: opts.business_type,
    business_id: opts.business_id,
    tags: opts.tags
  });
  const key = requireLinkedIdempotencyKey(opts);
  const requestId = normalizeRequestId(opts, key);
  const requestHashValue = linkedRequestHash(message, linked, ragContext, opts);
  const reservationInput = {
    organizationId: requireLinkedCampaignAccess(db, user.id, linked.campaignId).campaign.org_id,
    actorUserId: user.id,
    campaignId: linked.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: linked.initialLink
      ? 'ai.conversation.create.linked'
      : 'ai.conversation.continue.linked',
    key,
    requestHash: requestHashValue,
    expectedEventCount: linked.initialLink ? 1 : 0,
    operationTimeoutSeconds: 120
  };
  const reservation = reserveLinkedOperation(db, {
    user,
    campaignId: linked.campaignId,
    reservationInput
  });
  if (reservation.state === 'replay') return reservation.responseBody;
  const providerContext = createLinkedProviderContext(reservation, opts.signal);
  const startedAt = Date.now();
  try {
    let searchResult;
    let completion;
    try {
      searchResult = await runOptionalWebSearch(db, webQuery, opts, providerContext);
      assertProviderContextActive(providerContext);
      const history = linked.conversationId === null
        ? []
        : recentMessages(db, linked.conversationId, 8);
      const provider = opts.provider || llm.createDeepSeekProvider();
      const systemPrompt = rag.buildSystemPrompt({
        contextText: ragContext.contextText,
        webContext: webSearch.formatWebContext(searchResult)
      });
      completion = await awaitWithAbort(provider.complete({
        messages: [{ role: 'system', content: systemPrompt }]
          .concat(history, [{ role: 'user', content: message }]),
        temperature: opts.temperature,
        max_tokens: clampMaxTokens(opts.max_tokens),
        model: opts.model,
        signal: providerContext.signal,
        deadlineAt: providerContext.deadlineAt
      }), providerContext.signal);
      let completionValid = true;
      if (typeof opts.validateCompletion === 'function') {
        try {
          completionValid = opts.validateCompletion(completion && completion.content) === true;
        } catch (_error) {
          completionValid = false;
        }
      }
      if (
        !completion ||
        completion.degraded ||
        typeof completion.content !== 'string' ||
        completion.content.length === 0 ||
        !completionValid
      ) {
        throw providerUnavailableError();
      }
      assertProviderContextActive(providerContext);
    } catch (error) {
      const providerError = error && error.code === 'AI_PROVIDER_UNAVAILABLE'
        ? error
        : providerUnavailableError();
      completeLinkedFailure(db, reservation, requestHashValue, requestId, providerError);
      throw providerError;
    }

    try {
      return persistLinkedChat(db, {
        ...opts,
        user,
        message,
        linked,
        requestId,
        requestHashValue,
        reservation,
        providerContext,
        ragContext,
        searchResult,
        completion,
        webQuery,
        latencyMs: Math.max(0, Date.now() - startedAt)
      });
    } catch (error) {
      const terminalError = error && error.statusCode
        ? error
        : serviceError(500, 'AI_PERSISTENCE_FAILED', 'Linked AI chat could not be stored safely.');
      completeLinkedFailure(db, reservation, requestHashValue, requestId, terminalError);
      throw terminalError;
    }
  } finally {
    providerContext.dispose();
  }
}

async function handleChat(db, opts) {
  opts = opts || {};
  if (!opts.user || !opts.user.id) throw new Error('User required');
  const message = String(opts.message || '').trim();
  if (!message) throw new Error('Message required');
  const linked = resolveLinkedContext(db, opts);
  if (linked.linked) return handleLinkedChat(db, opts, linked);
  if (opts.atomicOneShot === true) return handleAtomicLegacyOneShot(db, opts);
  return handleLegacyChat(db, opts);
}

function conversationReadLimit(value) {
  const parsed = parseInt(value || 100, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 100;
  return Math.min(parsed, 300);
}

function readRequestId(opts) {
  const raw = ownValue(opts, 'requestId') !== undefined
    ? opts.requestId
    : ownValue(opts, 'request_id');
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim().slice(0, 200);
}

function readAuthOrganization(authContext) {
  if (!authContext || typeof authContext !== 'object') return null;
  try {
    const organization = authContext.organization;
    const id = positiveId(organization && organization.id);
    if (id === null) return null;
    return {
      id,
      roleCode: organization.role_code === 'org_admin' ? 'org_admin' : 'member'
    };
  } catch (error) {
    return null;
  }
}

function resolveConversationReadActor(db, opts) {
  const userId = positiveId(opts && opts.user && opts.user.id);
  if (userId === null) return null;
  const user = db.prepare(`
    SELECT id,role
    FROM users
    WHERE id=? AND typeof(is_active)='integer' AND is_active=1
  `).get(userId);
  if (!user) return null;
  const suppliedAuthContext = ownValue(opts, 'authContext');
  const authOrganization = readAuthOrganization(suppliedAuthContext);
  let organizationAdmin = false;
  if (authOrganization && authOrganization.roleCode === 'org_admin') {
    organizationAdmin = Boolean(db.prepare(`
      SELECT 1
      FROM organization_memberships
      WHERE org_id=? AND user_id=? AND role_code='org_admin' AND status='active'
    `).get(authOrganization.id, userId));
  }
  return {
    id: userId,
    platformAdmin: user.role === 'admin',
    organizationAdmin,
    organizationId: organizationAdmin ? authOrganization.id : null,
    authOrganizationId: authOrganization ? authOrganization.id : null,
    privileged: user.role === 'admin' || organizationAdmin
  };
}

function authorizedConversationProjection(actor) {
  const collectionAccess = buildCollectionAccessPredicate('ai_conversations', {
    userId: actor.id
  });
  const authOrganizationId = actor.authOrganizationId || -1;
  const organizationId = actor.organizationId || -1;
  const platformAdmin = actor.platformAdmin ? 1 : 0;
  const organizationAdmin = actor.organizationAdmin ? 1 : 0;
  return {
    cte: `
      WITH ranked_conversation_links AS MATERIALIZED (
        SELECT
          CAST(link.record_id AS INTEGER) AS conversation_id,
          link.org_id,
          link.campaign_id,
          link.id,
          link.revoked_at,
          SUM(CASE WHEN link.revoked_at IS NULL THEN 1 ELSE 0 END) OVER (
            PARTITION BY link.record_id
          ) AS active_link_count,
          ROW_NUMBER() OVER (
            PARTITION BY link.record_id
            ORDER BY
              CASE WHEN link.revoked_at IS NULL THEN 0 ELSE 1 END,
              CASE WHEN link.revoked_at IS NULL THEN link.id END DESC,
              link.revoked_at DESC,
              link.id DESC
          ) AS custody_rank
        FROM campaign_record_links link
        WHERE link.record_type='ai_conversation'
          AND link.relation_type='ai_run'
      ),
      conversation_link_stats AS MATERIALIZED (
        SELECT conversation_id,COUNT(*) AS link_count
        FROM ranked_conversation_links
        GROUP BY conversation_id
      ),
      campaign_scope AS MATERIALIZED (
        SELECT conversation_id,org_id,campaign_id
        FROM ranked_conversation_links
        WHERE custody_rank=1 AND active_link_count<=1
      ),
      conversation_owner_scope AS MATERIALIZED (
        SELECT membership.user_id,MIN(membership.org_id) AS org_id
        FROM organization_memberships membership
        WHERE membership.status='active'
        GROUP BY membership.user_id
        HAVING COUNT(DISTINCT membership.org_id)=1
      ),
      conversation_access_scope AS MATERIALIZED (
        SELECT
          conversation.id AS conversation_id,
          conversation.user_id AS conversation_user_id,
          CASE
            WHEN link_stats.conversation_id IS NULL THEN owner_scope.org_id
            ELSE campaign_scope.org_id
          END AS __organization_id,
          campaign_scope.campaign_id AS __campaign_id,
          CASE
            WHEN link_stats.conversation_id IS NULL THEN 1
            WHEN campaign_scope.campaign_id IS NOT NULL THEN 1
            ELSE 0
          END AS __custody_valid,
          CASE
            WHEN campaign_scope.campaign_id IS NULL THEN 1
            WHEN (${collectionAccess.sql}) THEN 1
            WHEN EXISTS (
              SELECT 1
              FROM campaigns context_campaign
              JOIN organization_memberships context_membership
                ON context_membership.org_id=context_campaign.org_id
               AND context_membership.user_id=?
               AND context_membership.status='active'
              WHERE context_campaign.id=campaign_scope.campaign_id
                AND context_campaign.org_id=campaign_scope.org_id
                AND context_campaign.org_id=?
                AND EXISTS (
                  SELECT 1
                  FROM team_memberships identity_team
                  WHERE identity_team.org_id=context_campaign.org_id
                    AND identity_team.user_id=context_membership.user_id
                    AND identity_team.status='active'
                )
                AND (
                  context_membership.role_code='org_admin'
                  OR context_campaign.owner_user_id=context_membership.user_id
                  OR EXISTS (
                    SELECT 1
                    FROM team_memberships assigned_team
                    WHERE assigned_team.org_id=context_campaign.org_id
                      AND assigned_team.team_id=context_campaign.team_id
                      AND assigned_team.user_id=context_membership.user_id
                      AND assigned_team.status='active'
                  )
                )
            ) THEN 1
            ELSE 0
          END AS __campaign_allowed
        FROM ai_conversations conversation
        LEFT JOIN conversation_link_stats link_stats
          ON link_stats.conversation_id=conversation.id
        LEFT JOIN campaign_scope
          ON campaign_scope.conversation_id=conversation.id
        LEFT JOIN conversation_owner_scope owner_scope
          ON owner_scope.user_id=conversation.user_id
      ),
      authorized_conversation_ids AS MATERIALIZED (
        SELECT
          access_scope.*,
          CASE
            WHEN ?=1 THEN 'platform_admin'
            WHEN ?=1 AND access_scope.__organization_id=? THEN 'org_admin'
            ELSE 'owner'
          END AS __access_role
        FROM conversation_access_scope access_scope
        WHERE access_scope.__custody_valid=1
          AND (
            ?=1
            OR (
              access_scope.conversation_user_id=?
              AND access_scope.__campaign_allowed=1
            )
            OR (
              ?=1
              AND access_scope.__organization_id=?
              AND access_scope.__campaign_allowed=1
            )
          )
      ),
      authorized_conversations AS MATERIALIZED (
        SELECT
          conversation.*,
          owner.username,
          owner.display_name,
          authorized.__organization_id,
          authorized.__campaign_id,
          authorized.__custody_valid,
          authorized.__campaign_allowed,
          authorized.__access_role
        FROM authorized_conversation_ids authorized
        JOIN ai_conversations conversation
          ON conversation.id=authorized.conversation_id
        JOIN users owner ON owner.id=conversation.user_id
      )
    `,
    params: [
      ...collectionAccess.params,
      actor.id,
      authOrganizationId,
      platformAdmin,
      organizationAdmin,
      organizationId,
      platformAdmin,
      actor.id,
      organizationAdmin,
      organizationId
    ]
  };
}

function conversationListFilters(opts, actor) {
  const conditions = [];
  const params = [];
  const filterNames = [];
  const q = opts.q === undefined || opts.q === null ? '' : String(opts.q).trim();
  const sourceModule = opts.source_module === undefined || opts.source_module === null
    ? ''
    : String(opts.source_module).trim();
  const dateFrom = normalizeAiAuditDate(opts.date_from);
  const dateTo = normalizeAiAuditDate(opts.date_to);
  const referenceType = normalizeAiAuditEnum(
    opts.reference_type,
    ['knowledge', 'web'],
    'Invalid AI audit reference type.'
  );
  const archiveStatus = normalizeAiAuditEnum(
    opts.archive_status,
    ['archived', 'unarchived'],
    'Invalid AI audit archive status.'
  );
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw serviceError(
      400,
      'INVALID_AI_AUDIT_FILTER',
      'AI audit start date must not be later than end date.'
    );
  }
  if (q) {
    filterNames.push('q');
  }
  if (opts.user_id) {
    filterNames.push('user_id');
  }
  if (sourceModule) {
    filterNames.push('source_module');
  }
  if (dateFrom) filterNames.push('date_from');
  if (dateTo) filterNames.push('date_to');
  if (referenceType) filterNames.push('reference_type');
  if (archiveStatus) filterNames.push('archive_status');
  if (ownValue(opts, 'limit') !== undefined) {
    filterNames.push('limit');
  }
  if (actor.privileged && opts.user_id) {
    conditions.push('authorized.user_id=?');
    params.push(positiveId(opts.user_id) || -1);
  }
  if (sourceModule) {
    conditions.push('authorized.source_module=?');
    params.push(sourceModule);
  }
  if (dateFrom) {
    conditions.push('authorized.activity_at>=?');
    params.push(dateFrom + ' 00:00:00');
  }
  if (dateTo) {
    conditions.push('authorized.activity_at<?');
    params.push(nextAiAuditDate(dateTo) + ' 00:00:00');
  }
  if (referenceType) {
    conditions.push(`EXISTS (
      SELECT 1
      FROM ai_messages reference_message
      JOIN ai_references matching_reference
        ON matching_reference.message_id=reference_message.id
      WHERE reference_message.conversation_id=authorized.id
        AND matching_reference.reference_type=?
    )`);
    params.push(referenceType);
  }
  if (archiveStatus === 'archived') {
    conditions.push('authorized.archived_summary_id IS NOT NULL');
  } else if (archiveStatus === 'unarchived') {
    conditions.push('authorized.archived_summary_id IS NULL');
  }
  if (q) {
    const pattern = '%' + q + '%';
    conditions.push(`(
      authorized.title LIKE ?
      OR authorized.username LIKE ?
      OR COALESCE(authorized.display_name,'') LIKE ?
      OR EXISTS (
        SELECT 1
        FROM ai_messages matching_message
        WHERE matching_message.conversation_id=authorized.id
          AND matching_message.content LIKE ?
      )
      OR EXISTS (
        SELECT 1
        FROM ai_messages matching_reference_message
        JOIN ai_references searched_reference
          ON searched_reference.message_id=matching_reference_message.id
        WHERE matching_reference_message.conversation_id=authorized.id
          AND (
            searched_reference.title LIKE ?
            OR searched_reference.url LIKE ?
            OR searched_reference.snippet LIKE ?
          )
      )
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  return { conditions, params, filterNames };
}

function normalizeAiAuditDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw serviceError(400, 'INVALID_AI_AUDIT_FILTER', 'Invalid AI audit date.');
  }
  const parsed = new Date(normalized + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw serviceError(400, 'INVALID_AI_AUDIT_FILTER', 'Invalid AI audit date.');
  }
  return normalized;
}

function normalizeAiAuditEnum(value, allowed, message) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!allowed.includes(normalized)) {
    throw serviceError(400, 'INVALID_AI_AUDIT_FILTER', message);
  }
  return normalized;
}

function nextAiAuditDate(value) {
  const parsed = new Date(value + 'T00:00:00Z');
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function stripConversationReadMetadata(row) {
  const projected = { ...row };
  projected.campaign_id = positiveId(projected.__campaign_id);
  delete projected.__organization_id;
  delete projected.__campaign_id;
  delete projected.__custody_valid;
  delete projected.__campaign_allowed;
  delete projected.__access_role;
  delete projected.last_message_at;
  delete projected.latest_message_role;
  return projected;
}

function boundedAiRunInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function boundedAiRunAggregate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  if (parsed >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return Math.floor(parsed);
}

function addBoundedAiRunInteger(current, value) {
  const left = boundedAiRunInteger(current);
  const right = boundedAiRunInteger(value);
  return left > Number.MAX_SAFE_INTEGER - right
    ? Number.MAX_SAFE_INTEGER
    : left + right;
}

function parseAiRunMetadata(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { metadata: {}, valid: false };
    }
    return { metadata: parsed, valid: true };
  } catch (error) {
    return { metadata: {}, valid: false };
  }
}

function aiRunStatus(parsedMetadata) {
  if (!parsedMetadata.valid) return 'unknown';
  const metadata = parsedMetadata.metadata;
  if (metadata.status === 'succeeded' || metadata.status === 'degraded' || metadata.status === 'failed') {
    return metadata.status;
  }
  if (metadata.status !== undefined && metadata.status !== null && metadata.status !== '') return 'unknown';
  return metadata.degraded === true ? 'degraded' : 'succeeded';
}

function aiRunLatency(metadata) {
  const value = metadata && metadata.latency_ms;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < 0 || value > 60 * 60 * 1000) return null;
  return value;
}

function ensureAiCostSqlProjection(db) {
  if (aiCostSqlDatabases.has(db)) return;
  db.function('tm_ai_cost_nano_usd', { deterministic: true }, function(metadataJson) {
    try {
      const parsed = parseAiRunMetadata(metadataJson);
      const projected = llm.projectDeepSeekCostSnapshot(parsed.metadata.cost_snapshot, {
        metadataValid: parsed.valid
      });
      return projected.status === 'priced' ? projected.total_cost_nano_usd : null;
    } catch (_error) {
      return null;
    }
  });
  aiCostSqlDatabases.add(db);
}

function summarizeAiRunCost(runCount, pricedRunCount, totalCost, overflow) {
  const runs = boundedAiRunInteger(runCount);
  const priced = Math.min(runs, boundedAiRunInteger(pricedRunCount));
  const unavailable = runs - priced;
  let status = overflow === true ? 'overflow' : 'empty';
  if (!overflow && runs > 0 && priced === 0) status = 'unavailable';
  else if (!overflow && priced === runs && runs > 0) status = 'priced';
  else if (!overflow && priced > 0) status = 'partial';
  return {
    status,
    currency: 'USD',
    priced_run_count: priced,
    unavailable_run_count: unavailable,
    total_cost_nano_usd: priced > 0 && !overflow ? boundedAiRunAggregate(totalCost) : null
  };
}

function projectAssistantRun(message, references, parsedMetadata) {
  const parsed = parsedMetadata || parseAiRunMetadata(message && message.metadata_json);
  const visibleReferences = Array.isArray(references) ? references : [];
  const costProjection = llm.projectDeepSeekCostSnapshot(parsed.metadata.cost_snapshot, {
    metadataValid: parsed.valid
  });
  return {
    run_id: positiveId(message && message.id),
    status: aiRunStatus(parsed),
    model: message && typeof message.model === 'string' && message.model ? message.model : null,
    prompt_tokens: boundedAiRunInteger(message && message.prompt_tokens),
    completion_tokens: boundedAiRunInteger(message && message.completion_tokens),
    total_tokens: boundedAiRunInteger(message && message.total_tokens),
    latency_ms: aiRunLatency(parsed.metadata),
    knowledge_reference_count: visibleReferences.filter((reference) => reference.reference_type === 'knowledge').length,
    web_reference_count: visibleReferences.filter((reference) => reference.reference_type === 'web').length,
    created_at: message && message.created_at ? message.created_at : null,
    cost_projection: costProjection
  };
}

function summarizeAiRuns(runs, options) {
  const projectedRuns = Array.isArray(runs) ? runs : [];
  const opts = options || {};
  const counts = { succeeded: 0, degraded: 0, failed: 0, unknown: 0 };
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let latencyTotal = 0;
  let latencyCount = 0;
  let pricedRunCount = 0;
  let totalCost = 0;
  let costOverflow = false;
  projectedRuns.forEach((run) => {
    const status = Object.hasOwn(counts, run.status) ? run.status : 'unknown';
    counts[status] += 1;
    promptTokens = addBoundedAiRunInteger(promptTokens, run.prompt_tokens);
    completionTokens = addBoundedAiRunInteger(completionTokens, run.completion_tokens);
    totalTokens = addBoundedAiRunInteger(totalTokens, run.total_tokens);
    if (run.latency_ms !== null) {
      latencyTotal = addBoundedAiRunInteger(latencyTotal, run.latency_ms);
      latencyCount += 1;
    }
    if (run.cost_projection && run.cost_projection.status === 'priced') {
      pricedRunCount += 1;
      const cost = boundedAiRunInteger(run.cost_projection.total_cost_nano_usd);
      if (totalCost > Number.MAX_SAFE_INTEGER - cost) costOverflow = true;
      else if (!costOverflow) totalCost += cost;
    }
  });
  const activeStates = Object.values(counts).filter((count) => count > 0).length;
  let status = 'empty';
  if (opts.latestMessageRole === 'user') status = 'incomplete';
  else if (projectedRuns.length === 0) status = boundedAiRunInteger(opts.messageCount) > 0 ? 'incomplete' : 'empty';
  else if (activeStates > 1) status = 'mixed';
  else if (counts.failed > 0) status = 'failed';
  else if (counts.degraded > 0) status = 'degraded';
  else if (counts.unknown > 0) status = 'unknown';
  else status = 'succeeded';
  return {
    status,
    run_count: projectedRuns.length,
    succeeded_count: counts.succeeded,
    degraded_count: counts.degraded,
    failed_count: counts.failed,
    unknown_count: counts.unknown,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    average_latency_ms: latencyCount > 0 ? Math.round(latencyTotal / latencyCount) : null,
    latest_model: projectedRuns.length > 0 ? projectedRuns[projectedRuns.length - 1].model : null,
    knowledge_reference_count: boundedAiRunInteger(opts.knowledgeReferenceCount),
    web_reference_count: boundedAiRunInteger(opts.webReferenceCount),
    cost_summary: summarizeAiRunCost(projectedRuns.length, pricedRunCount, totalCost, costOverflow)
  };
}

function summarizeAiRunAggregate(row, options) {
  const aggregate = row || {};
  const opts = options || {};
  const counts = {
    succeeded: boundedAiRunInteger(aggregate.succeeded_count),
    degraded: boundedAiRunInteger(aggregate.degraded_count),
    failed: boundedAiRunInteger(aggregate.failed_count),
    unknown: boundedAiRunInteger(aggregate.unknown_count)
  };
  const runCount = boundedAiRunInteger(aggregate.run_count);
  const activeStates = Object.values(counts).filter((count) => count > 0).length;
  let status = 'empty';
  if (opts.latestMessageRole === 'user') status = 'incomplete';
  else if (runCount === 0) status = boundedAiRunInteger(opts.messageCount) > 0 ? 'incomplete' : 'empty';
  else if (activeStates > 1) status = 'mixed';
  else if (counts.failed > 0) status = 'failed';
  else if (counts.degraded > 0) status = 'degraded';
  else if (counts.unknown > 0) status = 'unknown';
  else status = 'succeeded';
  const latency = aggregate.average_latency_ms === null || aggregate.average_latency_ms === undefined
    ? null
    : boundedAiRunInteger(Math.round(Number(aggregate.average_latency_ms)));
  return {
    status,
    run_count: runCount,
    succeeded_count: counts.succeeded,
    degraded_count: counts.degraded,
    failed_count: counts.failed,
    unknown_count: counts.unknown,
    prompt_tokens: boundedAiRunAggregate(aggregate.prompt_tokens),
    completion_tokens: boundedAiRunAggregate(aggregate.completion_tokens),
    total_tokens: boundedAiRunAggregate(aggregate.total_tokens),
    average_latency_ms: latency,
    latest_model: typeof aggregate.latest_model === 'string' && aggregate.latest_model
      ? aggregate.latest_model
      : null,
    knowledge_reference_count: boundedAiRunInteger(aggregate.knowledge_reference_count),
    web_reference_count: boundedAiRunInteger(aggregate.web_reference_count),
    cost_summary: summarizeAiRunCost(
      runCount,
      aggregate.priced_run_count,
      aggregate.total_cost_nano_usd,
      Number(aggregate.cost_overflow) === 1
    )
  };
}

function auditTargetForConversation(row) {
  const conversationId = positiveId(row && row.id);
  const userId = positiveId(row && row.user_id);
  const organizationId = positiveId(row && row.__organization_id);
  if (conversationId === null || userId === null || organizationId === null) {
    throw new Error('AI read audit target identity is unavailable.');
  }
  const target = {
    conversation_id: conversationId,
    user_id: userId,
    organization_id: organizationId
  };
  const campaignId = positiveId(row.__campaign_id);
  if (campaignId !== null) target.campaign_id = campaignId;
  return target;
}

function persistPrivilegedConversationReadAudit(db, actor, opts, values) {
  if (!actor.privileged) return;
  try {
    const details = { actor_user_id: actor.id };
    if (actor.organizationAdmin && !actor.platformAdmin) {
      details.organization_id = actor.organizationId;
    }
    details.request_id = readRequestId(opts);
    details.filter_names = values.filterNames;
    details.targets = values.rows.map(auditTargetForConversation);
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,?,'ai_audit',?,NULL)
    `).run(actor.id, values.action, JSON.stringify(details));
  } catch (error) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'AI conversation read audit could not be persisted.'
    );
  }
}

function readAuthorizedConversation(db, actor, conversationId) {
  const projection = authorizedConversationProjection(actor);
  return db.prepare(`
    ${projection.cte}
    SELECT *
    FROM authorized_conversations authorized
    WHERE authorized.id=?
    LIMIT 1
  `).get(...projection.params, conversationId) || null;
}

function parseMetadataObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function manualPromotionVisibility(value) {
  const visibility = value === undefined || value === null || value === ''
    ? 'private'
    : String(value).trim();
  if (visibility !== 'private' && visibility !== 'team') {
    throw serviceError(
      400,
      'INVALID_AI_PROMOTION_VISIBILITY',
      'AI knowledge visibility must be private or team.'
    );
  }
  return visibility;
}

function manualPromotionQuestion(db, conversationId, ownerId, assistantMessage) {
  const metadata = parseMetadataObject(assistantMessage.metadata_json);
  const referencedUserMessageId = positiveId(metadata.user_message_id);
  let question = null;
  if (referencedUserMessageId !== null) {
    question = db.prepare(`
      SELECT id,content
      FROM ai_messages
      WHERE id=? AND conversation_id=? AND user_id=? AND role='user'
    `).get(referencedUserMessageId, conversationId, ownerId) || null;
  }
  if (!question) {
    question = db.prepare(`
      SELECT id,content
      FROM ai_messages
      WHERE conversation_id=? AND user_id=? AND role='user' AND id<?
      ORDER BY id DESC
      LIMIT 1
    `).get(conversationId, ownerId, assistantMessage.id) || null;
  }
  return {
    content: question ? String(question.content || '') : '',
    metadata
  };
}

function existingPromotedMessageKnowledge(
  db,
  selectedSourceType,
  legacySourceType,
  messageId
) {
  return db.prepare(`
    SELECT id,visibility,metadata_json
    FROM knowledge_entries
    WHERE CAST(source_id AS TEXT)=?
      AND (
        source_type=?
        OR (
          source_type=?
          AND json_valid(metadata_json)
          AND json_extract(metadata_json,'$.promotion.trigger')='manual'
        )
      )
    ORDER BY CASE WHEN source_type=? THEN 0 ELSE 1 END,id
    LIMIT 1
  `).get(
    String(messageId),
    selectedSourceType,
    legacySourceType,
    selectedSourceType
  ) || null;
}

function requireExistingCampaignKnowledgeLink(db, campaignId, knowledgeEntryId) {
  const linked = db.prepare(`
    SELECT 1 AS present
    FROM campaign_record_links
    WHERE campaign_id=?
      AND record_type='knowledge_entry'
      AND record_id=?
      AND relation_type='knowledge'
      AND revoked_at IS NULL
    LIMIT 1
  `).get(campaignId, String(knowledgeEntryId));
  if (!linked) {
    throw serviceError(
      409,
      'KNOWLEDGE_CUSTODY_CONFLICT',
      'Existing AI knowledge belongs to another custody context.'
    );
  }
}

function persistManualPromotionAudit(db, actor, opts, values) {
  try {
    const result = values.result === 'promoted' || values.result === 'already_promoted'
      ? values.result
      : 'rejected';
    const details = {
      request_id: readRequestId(opts),
      conversation_id: positiveId(values.conversationId),
      message_id: positiveId(values.messageId),
      knowledge_entry_id: positiveId(values.knowledgeEntryId),
      visibility: values.visibility === 'private' || values.visibility === 'team'
        ? values.visibility
        : null,
      result
    };
    if (result === 'rejected') {
      details.error_code = typeof values.errorCode === 'string' && values.errorCode
        ? values.errorCode.slice(0, 100)
        : 'AI_PROMOTION_FAILED';
    }
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,'manual_promote_ai_message','ai_knowledge',?,NULL)
    `).run(actor.id, JSON.stringify(details));
  } catch (error) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'AI knowledge promotion audit could not be persisted.'
    );
  }
}

function promoteMessageToKnowledge(db, opts) {
  opts = opts || {};
  const conversationId = positiveId(requestedConversationValue(opts));
  const rawMessageId = ownValue(opts, 'message_id') !== undefined
    ? opts.message_id
    : ownValue(opts, 'messageId');
  const messageId = positiveId(rawMessageId);
  const auditActor = resolveConversationReadActor(db, opts);
  let visibility = opts.visibility === undefined || opts.visibility === null || opts.visibility === ''
    ? 'private'
    : String(opts.visibility).trim();

  try {
    if (conversationId === null || messageId === null) {
      throw serviceError(
        400,
        'INVALID_AI_PROMOTION_TARGET',
        'Conversation and assistant message identifiers must be positive integers.'
      );
    }
    visibility = manualPromotionVisibility(visibility);

    return db.transaction(() => {
      const actor = resolveConversationReadActor(db, opts);
      if (!actor) throw serviceError(404, 'RECORD_NOT_FOUND', 'Conversation was not found.');
      const conversation = readAuthorizedConversation(db, actor, conversationId);
      if (
        !conversation ||
        (!actor.platformAdmin && Number(conversation.user_id) !== actor.id)
      ) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Conversation was not found.');
      }
      const assistantMessage = db.prepare(`
        SELECT id,conversation_id,user_id,content,metadata_json
        FROM ai_messages
        WHERE id=? AND conversation_id=? AND user_id=? AND role='assistant'
      `).get(messageId, conversationId, conversation.user_id);
      if (!assistantMessage) {
        throw serviceError(
          400,
          'INVALID_AI_PROMOTION_TARGET',
          'Only a persisted assistant response can be promoted.'
        );
      }

      const question = manualPromotionQuestion(
        db,
        conversationId,
        conversation.user_id,
        assistantMessage
      );
      const references = db.prepare(`
        SELECT reference_type,title,url,snippet
        FROM ai_references
        WHERE message_id=?
        ORDER BY id
      `).all(messageId);
      const knowledgeReferences = references.filter((reference) => reference.reference_type === 'knowledge');
      const webReferences = references.filter((reference) => reference.reference_type === 'web');
      const promotion = Object.assign(decideSummaryPromotion({
        message: question.content,
        answer: assistantMessage.content,
        knowledgeReferences,
        searchResult: { used: webReferences.length > 0, results: webReferences },
        archiveSummary: true,
        degraded: question.metadata.degraded === true
      }), {
        trigger: 'manual',
        actor_user_id: actor.id
      });
      const campaignId = positiveId(conversation.__campaign_id);
      const selectedSourceType = campaignId === null
        ? 'ai_selected_message'
        : 'campaign_ai_selected_message';
      const legacySourceType = campaignId === null
        ? 'ai_message'
        : 'campaign_ai_message';
      const existing = existingPromotedMessageKnowledge(
        db,
        selectedSourceType,
        legacySourceType,
        messageId
      );
      let knowledgeEntryId;
      let result = 'promoted';
      let resultVisibility = visibility;

      if (existing) {
        if (campaignId !== null) {
          requireExistingCampaignKnowledgeLink(db, campaignId, existing.id);
        }
        knowledgeEntryId = Number(existing.id);
        result = 'already_promoted';
        resultVisibility = existing.visibility || visibility;
      } else if (campaignId !== null) {
        const access = requireLinkedCampaignAccess(db, actor.id, campaignId);
        const archived = archiveLinkedChatSummary(db, {
          access,
          campaignId,
          user: { id: actor.id, role: opts.user && opts.user.role },
          message: question.content,
          answer: assistantMessage.content,
          conversationId,
          assistantMessageId: messageId,
          promotion,
          visibility
        });
        knowledgeEntryId = Number(archived.id);
      } else {
        const archived = archiveChatSummary(db, {
          user: { id: actor.id, role: opts.user && opts.user.role },
          message: question.content,
          answer: assistantMessage.content,
          conversationId,
          assistantMessageId: messageId,
          source_module: conversation.source_module || 'assistant',
          promotion,
          visibility
        });
        if (!archived || positiveId(archived.id) === null) {
          throw serviceError(500, 'AI_PROMOTION_FAILED', 'AI response could not be promoted.');
        }
        knowledgeEntryId = Number(archived.id);
      }

      db.prepare('UPDATE ai_conversations SET archived_summary_id=? WHERE id=?')
        .run(knowledgeEntryId, conversationId);
      persistManualPromotionAudit(db, actor, opts, {
        conversationId,
        messageId,
        knowledgeEntryId,
        visibility: resultVisibility,
        result
      });
      return {
        status: result,
        conversation_id: conversationId,
        message_id: messageId,
        knowledge_entry_id: knowledgeEntryId,
        visibility: resultVisibility,
        promotion
      };
    }).immediate();
  } catch (error) {
    if (auditActor) {
      persistManualPromotionAudit(db, auditActor, opts, {
        conversationId,
        messageId,
        knowledgeEntryId: null,
        visibility,
        result: 'rejected',
        errorCode: error && error.code
      });
    }
    throw error;
  }
}

function listConversations(db, opts) {
  opts = opts || {};
  ensureAiCostSqlProjection(db);
  return db.transaction(() => {
    const actor = resolveConversationReadActor(db, opts);
    if (!actor) return [];
    const projection = authorizedConversationProjection(actor);
    const filters = conversationListFilters(opts, actor);
    const rows = db.prepare(`
      ${projection.cte},
      conversation_list_activity_source AS MATERIALIZED (
        SELECT
          authorized.*,
          (
            SELECT MAX(activity_message.created_at)
            FROM ai_messages activity_message
            WHERE activity_message.conversation_id=authorized.id
          ) AS last_message_at,
          (
            SELECT latest_message.role
            FROM ai_messages latest_message
            WHERE latest_message.conversation_id=authorized.id
            ORDER BY latest_message.created_at DESC,latest_message.id DESC
            LIMIT 1
          ) AS latest_message_role
        FROM authorized_conversations authorized
      ),
      authorized_conversation_activity AS MATERIALIZED (
        SELECT
          activity_source.*,
          CASE
            WHEN activity_source.last_message_at IS NOT NULL
              AND activity_source.last_message_at > COALESCE(activity_source.updated_at,activity_source.created_at)
            THEN activity_source.last_message_at
            ELSE COALESCE(activity_source.updated_at,activity_source.created_at)
          END AS activity_at
        FROM conversation_list_activity_source activity_source
      ),
      filtered_conversations AS MATERIALIZED (
        SELECT *
        FROM authorized_conversation_activity authorized
        ${filters.conditions.length ? 'WHERE ' + filters.conditions.join(' AND ') : ''}
      )
      SELECT
        filtered.*,
        (
          SELECT COUNT(*)
          FROM ai_messages counted_message
          WHERE counted_message.conversation_id=filtered.id
        ) AS message_count,
        (
          SELECT latest_answer.content
          FROM ai_messages latest_answer
          WHERE latest_answer.conversation_id=filtered.id
            AND latest_answer.role='assistant'
          ORDER BY latest_answer.id DESC
          LIMIT 1
        ) AS last_answer,
        (
          SELECT COUNT(*)
          FROM ai_messages referenced_message
          JOIN ai_references counted_reference
            ON counted_reference.message_id=referenced_message.id
          WHERE referenced_message.conversation_id=filtered.id
            AND counted_reference.reference_type='knowledge'
        ) AS knowledge_reference_count,
        (
          SELECT COUNT(*)
          FROM ai_messages referenced_message
          JOIN ai_references counted_reference
            ON counted_reference.message_id=referenced_message.id
          WHERE referenced_message.conversation_id=filtered.id
            AND counted_reference.reference_type='web'
        ) AS web_reference_count
      FROM filtered_conversations filtered
      ORDER BY filtered.activity_at DESC,filtered.id DESC
      LIMIT ?
    `).all(
      ...projection.params,
      ...filters.params,
      conversationReadLimit(opts.limit)
    );
    const runRows = rows.length === 0 ? [] : db.prepare(`
      WITH selected_conversations(conversation_id) AS (
        VALUES ${rows.map(() => '(?)').join(',')}
      ),
      metadata_source AS MATERIALIZED (
        SELECT
          message.id,message.conversation_id,message.model,message.prompt_tokens,
          message.completion_tokens,message.total_tokens,message.created_at,
          CASE
            WHEN message.metadata_json IS NULL OR message.metadata_json='' THEN '{}'
            WHEN json_valid(message.metadata_json)=1 THEN message.metadata_json
            ELSE NULL
          END AS run_metadata
        FROM ai_messages message
        JOIN selected_conversations selected
          ON selected.conversation_id=message.conversation_id
        WHERE message.role='assistant'
      ),
      projected_runs AS MATERIALIZED (
        SELECT
          source.*,
          CASE
            WHEN source.run_metadata IS NULL OR json_type(source.run_metadata,'$')<>'object'
              THEN 'unknown'
            WHEN json_extract(source.run_metadata,'$.status') IN ('succeeded','degraded','failed')
              THEN json_extract(source.run_metadata,'$.status')
            WHEN json_type(source.run_metadata,'$.status') IS NOT NULL
              AND NOT (
                json_type(source.run_metadata,'$.status')='null'
                OR (
                  json_type(source.run_metadata,'$.status')='text'
                  AND json_extract(source.run_metadata,'$.status')=''
                )
              ) THEN 'unknown'
            WHEN json_type(source.run_metadata,'$.degraded')='true' THEN 'degraded'
            ELSE 'succeeded'
          END AS run_status,
          CASE
            WHEN json_type(source.run_metadata,'$.latency_ms')='integer'
              AND json_extract(source.run_metadata,'$.latency_ms') BETWEEN 0 AND 3600000
            THEN json_extract(source.run_metadata,'$.latency_ms')
            ELSE NULL
          END AS latency_ms,
          tm_ai_cost_nano_usd(source.run_metadata) AS cost_nano_usd,
          ROW_NUMBER() OVER (
            PARTITION BY source.conversation_id
            ORDER BY source.created_at DESC,source.id DESC
          ) AS latest_rank
        FROM metadata_source source
      ),
      run_totals AS MATERIALIZED (
        SELECT
          run.conversation_id,
          COUNT(*) AS run_count,
          SUM(run.run_status='succeeded') AS succeeded_count,
          SUM(run.run_status='degraded') AS degraded_count,
          SUM(run.run_status='failed') AS failed_count,
          SUM(run.run_status='unknown') AS unknown_count,
          TOTAL(CASE
            WHEN typeof(run.prompt_tokens) IN ('integer','real')
              AND run.prompt_tokens BETWEEN 0 AND 9007199254740991
              AND run.prompt_tokens=CAST(run.prompt_tokens AS INTEGER)
            THEN run.prompt_tokens ELSE 0 END
          ) AS prompt_tokens,
          TOTAL(CASE
            WHEN typeof(run.completion_tokens) IN ('integer','real')
              AND run.completion_tokens BETWEEN 0 AND 9007199254740991
              AND run.completion_tokens=CAST(run.completion_tokens AS INTEGER)
            THEN run.completion_tokens ELSE 0 END
          ) AS completion_tokens,
          TOTAL(CASE
            WHEN typeof(run.total_tokens) IN ('integer','real')
              AND run.total_tokens BETWEEN 0 AND 9007199254740991
              AND run.total_tokens=CAST(run.total_tokens AS INTEGER)
            THEN run.total_tokens ELSE 0 END
          ) AS total_tokens,
          SUM(run.cost_nano_usd IS NOT NULL) AS priced_run_count,
          TOTAL(COALESCE(run.cost_nano_usd,0)) AS total_cost_nano_usd,
          CASE
            WHEN TOTAL(COALESCE(run.cost_nano_usd,0))>9007199254740991 THEN 1 ELSE 0
          END AS cost_overflow,
          AVG(run.latency_ms) AS average_latency_ms,
          MAX(CASE WHEN run.latest_rank=1 THEN run.model END) AS latest_model
        FROM projected_runs run
        GROUP BY run.conversation_id
      ),
      reference_totals AS MATERIALIZED (
        SELECT
          message.conversation_id,
          SUM(reference.reference_type='knowledge') AS knowledge_reference_count,
          SUM(reference.reference_type='web') AS web_reference_count
        FROM ai_messages message
        JOIN selected_conversations selected
          ON selected.conversation_id=message.conversation_id
        JOIN ai_references reference ON reference.message_id=message.id
        WHERE message.role='assistant'
        GROUP BY message.conversation_id
      )
      SELECT
        totals.*,
        COALESCE(reference.knowledge_reference_count,0) AS knowledge_reference_count,
        COALESCE(reference.web_reference_count,0) AS web_reference_count
      FROM run_totals totals
      LEFT JOIN reference_totals reference
        ON reference.conversation_id=totals.conversation_id
    `).all(...rows.map((row) => row.id));
    const runsByConversation = new Map(
      runRows.map((row) => [row.conversation_id, row])
    );
    persistPrivilegedConversationReadAudit(db, actor, opts, {
      action: 'admin_list_ai_conversations',
      filterNames: filters.filterNames,
      rows
    });
    return rows.map((row) => {
      const conversation = stripConversationReadMetadata(row);
      conversation.run_summary = summarizeAiRunAggregate(runsByConversation.get(row.id), {
        messageCount: row.message_count,
        latestMessageRole: row.latest_message_role
      });
      return conversation;
    });
  }).immediate();
}

function getConversation(db, opts) {
  opts = opts || {};
  const conversationId = positiveId(opts.id);
  if (conversationId === null) return null;
  return db.transaction(() => {
    const actor = resolveConversationReadActor(db, opts);
    if (!actor) return null;
    const initial = readAuthorizedConversation(db, actor, conversationId);
    if (!initial) return null;
    const authorized = readAuthorizedConversation(db, actor, conversationId);
    if (!authorized) return null;
    const messageActivity = db.prepare(`
      SELECT MAX(created_at) AS last_message_at
      FROM ai_messages
      WHERE conversation_id=?
    `).get(conversationId);
    const baselineActivity = authorized.updated_at || authorized.created_at || null;
    authorized.activity_at = messageActivity && messageActivity.last_message_at > baselineActivity
      ? messageActivity.last_message_at
      : baselineActivity;
    const messages = db.prepare(`
      SELECT *
      FROM ai_messages
      WHERE conversation_id=?
      ORDER BY created_at,id
    `).all(conversationId);
    const refs = db.prepare(`
      SELECT reference.*
      FROM ai_references reference
      JOIN ai_messages message ON message.id=reference.message_id
      WHERE message.conversation_id=?
      ORDER BY reference.id
    `).all(conversationId);
    const byMessage = {};
    refs.forEach(function(ref) {
      if (!byMessage[ref.message_id]) byMessage[ref.message_id] = [];
      byMessage[ref.message_id].push(ref);
    });
    messages.forEach(function(message) {
      const parsedMetadata = parseAiRunMetadata(message.metadata_json);
      message.metadata = parsedMetadata.metadata;
      if (!parsedMetadata.valid) message.metadata_valid = false;
      message.references = knowledge.redactKnowledgeReferences(
        db,
        byMessage[message.id] || [],
        opts.user
      );
      if (message.role === 'assistant') {
        message.run = projectAssistantRun(message, byMessage[message.id] || [], parsedMetadata);
      }
    });
    persistPrivilegedConversationReadAudit(db, actor, opts, {
      action: 'admin_view_ai_conversation',
      filterNames: ['id'],
      rows: [authorized]
    });
    const conversation = stripConversationReadMetadata(authorized);
    conversation.messages = messages;
    const projectedRuns = messages.filter((message) => message.run).map((message) => message.run);
    conversation.run_summary = summarizeAiRuns(
      projectedRuns,
      {
        messageCount: messages.length,
        latestMessageRole: messages.length > 0 ? messages[messages.length - 1].role : null,
        knowledgeReferenceCount: projectedRuns.reduce(
          (count, run) => addBoundedAiRunInteger(count, run.knowledge_reference_count),
          0
        ),
        webReferenceCount: projectedRuns.reduce(
          (count, run) => addBoundedAiRunInteger(count, run.web_reference_count),
          0
        )
      }
    );
    return conversation;
  }).immediate();
}

function verifyCampaignAiAuditContext(db, opts, contract) {
  opts = opts || {};
  contract = contract || {};
  const rawConversationId = ownValue(opts, 'conversation_id');
  const rawMessageId = ownValue(opts, 'message_id');
  const hasConversationId = rawConversationId !== undefined && rawConversationId !== null && rawConversationId !== '';
  const hasMessageId = rawMessageId !== undefined && rawMessageId !== null && rawMessageId !== '';
  if (!hasConversationId && !hasMessageId) return null;

  const campaignId = positiveId(requestedCampaignValue(opts));
  const conversationId = positiveId(rawConversationId);
  const messageId = positiveId(rawMessageId);
  if (campaignId === null || conversationId === null || messageId === null) {
    throw serviceError(
      400,
      contract.invalidCode,
      contract.invalidMessage
    );
  }

  const getConversationFn = typeof opts.getConversationFn === 'function'
    ? opts.getConversationFn
    : getConversation;
  const conversation = getConversationFn(db, {
    id: conversationId,
    user: opts.user,
    authContext: opts.authContext,
    requestId: opts.requestId
  });
  const message = conversation && Array.isArray(conversation.messages)
    ? conversation.messages.find((item) => positiveId(item && item.id) === messageId)
    : null;
  const conversationUserId = positiveId(conversation && conversation.user_id);
  if (
    !conversation ||
    positiveId(conversation.id) !== conversationId ||
    conversationUserId === null ||
    conversation.source_module !== contract.sourceModule ||
    !message ||
    positiveId(message.conversation_id) !== conversationId ||
    positiveId(message.user_id) !== conversationUserId ||
    message.role !== 'assistant'
  ) {
    throw serviceError(
      400,
      contract.invalidCode,
      contract.invalidMessage
    );
  }

  const resolveConversationCampaignFn = typeof opts.resolveConversationCampaignFn === 'function'
    ? opts.resolveConversationCampaignFn
    : resolveConversationCampaign;
  const resolution = resolveConversationCampaignFn(db, {
    conversationId,
    requestedCampaignId: campaignId
  });
  const messageCampaignId = positiveId(message.metadata && message.metadata.campaign_id);
  if (
    !resolution ||
    resolution.ok !== true ||
    resolution.derived !== true ||
    positiveId(resolution.campaignId) !== campaignId ||
    messageCampaignId !== campaignId
  ) {
    throw serviceError(
      409,
      contract.mismatchCode,
      contract.mismatchMessage
    );
  }
  return { conversation_id: conversationId, message_id: messageId };
}

function verifyDemandAnalysisAuditContext(db, opts) {
  return verifyCampaignAiAuditContext(db, opts, {
    sourceModule: 'demand_analysis',
    invalidCode: 'INVALID_DEMAND_AUDIT_CONTEXT',
    invalidMessage: 'Demand analysis audit context is invalid.',
    mismatchCode: 'DEMAND_AUDIT_CAMPAIGN_MISMATCH',
    mismatchMessage: 'Demand analysis audit context does not belong to this campaign.'
  });
}

function verifyProposalDraftAuditContext(db, opts) {
  return verifyCampaignAiAuditContext(db, opts, {
    sourceModule: 'proposal',
    invalidCode: 'INVALID_PROPOSAL_AUDIT_CONTEXT',
    invalidMessage: 'Proposal draft audit context is invalid.',
    mismatchCode: 'PROPOSAL_AUDIT_CAMPAIGN_MISMATCH',
    mismatchMessage: 'Proposal draft audit context does not belong to this campaign.'
  });
}

module.exports = {
  handleChat,
  promoteMessageToKnowledge,
  listConversations,
  getConversation,
  verifyDemandAnalysisAuditContext,
  verifyProposalDraftAuditContext,
  ensureConversation
};
