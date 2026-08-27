const knowledge = require('./knowledge_service');
const { getTargetAccess } = require('./campaign_access_service');

const LINKED_RAG_LIMITS = Object.freeze({
  maxSelectedEntries: 20,
  maxSelectedChunksPerEntry: 2,
  maxRetrievedChunks: 8,
  maxReferences: 48,
  maxContextBytes: 98_304,
  retrievalCandidates: 100
});

function ragInputError(code, message, statusCode) {
  const error = new Error(message);
  error.name = 'RagServiceError';
  error.code = code || 'INVALID_CAMPAIGN_INPUT';
  error.statusCode = statusCode || 400;
  return error;
}

function positiveId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function normalizeSelectedEntryIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw ragInputError('INVALID_CAMPAIGN_INPUT', 'knowledge_entry_ids must be an array');
  }
  const ids = value.map(positiveId);
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) {
    throw ragInputError('INVALID_CAMPAIGN_INPUT', 'knowledge_entry_ids must contain unique positive identifiers');
  }
  if (ids.length > LINKED_RAG_LIMITS.maxSelectedEntries) {
    throw ragInputError(
      'KNOWLEDGE_SELECTION_TOO_LARGE',
      `knowledge_entry_ids must contain at most ${LINKED_RAG_LIMITS.maxSelectedEntries} entries`,
      413
    );
  }
  return ids;
}

function loadEntryChunks(db, entryId) {
  const entry = db.prepare(`
    SELECT
      id,title,entry_type,source_type,source_id,visibility,is_public,
      source_identity_sha256,content_sha256,summary,content
    FROM knowledge_entries
    WHERE id=?
  `).get(entryId);
  if (!entry) return null;
  const chunks = db.prepare(`
    SELECT id,entry_id,chunk_index,content,content_sha256
    FROM knowledge_chunks
    WHERE entry_id=?
    ORDER BY chunk_index,id
  `).all(entryId);
  return { entry, chunks };
}

function referenceFromChunk(record, chunk, selected, rank) {
  const entry = record.entry;
  return {
    entry_id: entry.id,
    chunk_id: chunk.id,
    chunk_index: chunk.chunk_index,
    title: entry.title || '',
    entry_type: entry.entry_type || 'note',
    source_type: entry.source_type || 'manual',
    visibility: entry.visibility === null ? null : entry.visibility,
    is_public: entry.is_public === 1 ? 1 : 0,
    snippet: Array.from(String(chunk.content || '')).slice(0, 1200).join(''),
    source_identity_sha256: entry.source_identity_sha256,
    entry_content_sha256: entry.content_sha256,
    chunk_content_sha256: chunk.content_sha256,
    selected: selected,
    selection_origin: selected ? 'selected' : 'retrieved',
    rank: rank
  };
}

function renderLinkedRecord(reference, chunk) {
  return `[KB-${reference.rank}]\n${reference.title || ''}\n${chunk.content || ''}`;
}

function assertSelectedEntryAccess(db, opts, entryId) {
  const access = getTargetAccess(db, {
    userId: opts.user && opts.user.id,
    campaignId: opts.campaignId,
    recordType: 'knowledge_entry',
    recordId: entryId,
    relationType: 'knowledge',
    intent: 'read'
  });
  if (!access.ok) {
    throw ragInputError(
      access.code || 'RECORD_FORBIDDEN',
      'Selected knowledge is unavailable for this campaign.',
      access.status || access.statusCode || 403
    );
  }
  if (!knowledge.isKnowledgeRetrievable(db, entryId)) {
    throw ragInputError(
      'KNOWLEDGE_NOT_RETRIEVABLE',
      'Selected knowledge is not an active reusable version.',
      409
    );
  }
}

function buildLinkedRagContext(db, opts) {
  opts = opts || {};
  const campaignId = positiveId(opts.campaignId || opts.campaign_id);
  if (campaignId === null || !opts.user || positiveId(opts.user.id) === null) {
    throw ragInputError('INVALID_CAMPAIGN_INPUT', 'Linked RAG requires a campaign and authenticated user.');
  }
  const selectedEntryIds = normalizeSelectedEntryIds(
    opts.knowledge_entry_ids === undefined ? opts.knowledgeEntryIds : opts.knowledge_entry_ids
  );
  const selectedRecords = [];
  for (const entryId of selectedEntryIds) {
    assertSelectedEntryAccess(db, { ...opts, campaignId }, entryId);
    const record = loadEntryChunks(db, entryId);
    if (!record || !record.chunks.length) {
      throw ragInputError('RECORD_NOT_FOUND', 'Selected knowledge is unavailable for this campaign.', 404);
    }
    for (const chunk of record.chunks.slice(0, LINKED_RAG_LIMITS.maxSelectedChunksPerEntry)) {
      selectedRecords.push({ record, chunk, selected: true });
    }
  }

  const retrieved = knowledge.searchCampaignKnowledgeChunks(db, {
    query: opts.query || opts.q || '',
    user: opts.user,
    campaignId,
    limit: LINKED_RAG_LIMITS.retrievalCandidates,
    entry_type: opts.entry_type,
    source_type: opts.source_type,
    visibility: opts.visibility,
    business_type: opts.business_type,
    business_id: opts.business_id,
    tags: opts.tags
  });
  const accepted = [];
  const acceptedChunkIds = new Set();
  let contextBytes = 0;
  function candidate(item) {
    const reference = referenceFromChunk(
      item.record,
      item.chunk,
      item.selected,
      accepted.length + 1
    );
    const rendered = renderLinkedRecord(reference, item.chunk);
    const separatorBytes = accepted.length ? Buffer.byteLength('\n\n', 'utf8') : 0;
    const renderedBytes = Buffer.byteLength(rendered, 'utf8');
    return { reference, rendered, bytes: separatorBytes + renderedBytes };
  }
  for (const item of selectedRecords) {
    const next = candidate(item);
    if (
      accepted.length + 1 > LINKED_RAG_LIMITS.maxReferences ||
      contextBytes + next.bytes > LINKED_RAG_LIMITS.maxContextBytes
    ) {
      throw ragInputError(
        'KNOWLEDGE_SELECTION_TOO_LARGE',
        'Selected knowledge exceeds the linked AI context limit.',
        413
      );
    }
    accepted.push({ reference: next.reference, rendered: next.rendered });
    acceptedChunkIds.add(item.chunk.id);
    contextBytes += next.bytes;
  }

  let retrievedCount = 0;
  for (const item of retrieved) {
    if (acceptedChunkIds.has(item.chunk.id)) continue;
    if (
      accepted.length >= LINKED_RAG_LIMITS.maxReferences ||
      retrievedCount >= LINKED_RAG_LIMITS.maxRetrievedChunks
    ) break;
    const next = candidate({ ...item, selected: false });
    if (contextBytes + next.bytes > LINKED_RAG_LIMITS.maxContextBytes) break;
    accepted.push({ reference: next.reference, rendered: next.rendered });
    acceptedChunkIds.add(item.chunk.id);
    contextBytes += next.bytes;
    retrievedCount += 1;
  }

  return {
    query: String(opts.query || opts.q || ''),
    contextText: accepted.map((item) => item.rendered).join('\n\n'),
    references: accepted.map((item) => item.reference),
    hasKnowledge: accepted.length > 0,
    selectedEntryIds,
    contextBytes
  };
}

function buildRagContext(db, opts) {
  opts = opts || {};
  const query = opts.query || opts.q || '';
  const limit = opts.limit || 8;
  const results = knowledge.searchKnowledge(db, {
    q: query,
    user: opts.user,
    limit: limit,
    entry_type: opts.entry_type,
    source_type: opts.source_type,
    visibility: opts.visibility,
    business_type: opts.business_type,
    business_id: opts.business_id,
    tags: opts.tags
  });

  const references = results.map(function(entry) {
    return {
      id: entry.id,
      title: entry.title,
      entry_type: entry.entry_type,
      source_type: entry.source_type,
      source_id: entry.source_id,
      visibility: entry.visibility,
      snippet: entry.snippet || String(entry.content || '').slice(0, 220),
      usage_count: entry.usage_count || 0
    };
  });

  const contextText = references.length
    ? results.map(function(entry, index) {
      return [
        `[KB-${index + 1}] ${entry.title || 'Knowledge'} (#${entry.id})`,
        `Type: ${entry.entry_type || 'note'}; Tags: ${(entry.tags || []).join(', ') || '-'}`,
        String(entry.summary || entry.content || '').slice(0, 900)
      ].join('\n');
    }).join('\n\n')
    : '';

  return {
    query: query,
    contextText: contextText,
    references: references,
    hasKnowledge: references.length > 0
  };
}

function buildSystemPrompt(opts) {
  opts = opts || {};
  const lines = [
    '你是 TuringMarket 平台的 AI 商务与红人营销助手。',
    '回答必须优先使用平台知识库内容；如果知识库不足，明确说明不足之处。',
    '当联网结果存在时，可以结合联网来源，但不要把未验证信息说成平台事实。',
    '涉及方案、PPT、客户、品牌、达人和流程建议时，尽量引用 [KB-n] 或 [WEB-n] 编号。',
    '回答使用中文，结构清晰，可执行，适合商务团队直接复用。'
  ];
  if (opts.contextText) {
    lines.push('\n【平台知识库上下文】\n' + opts.contextText);
  }
  if (opts.webContext) {
    lines.push('\n【联网搜索上下文】\n' + opts.webContext);
  }
  return lines.join('\n');
}

module.exports = {
  buildRagContext,
  buildLinkedRagContext,
  LINKED_RAG_LIMITS,
  buildSystemPrompt
};
