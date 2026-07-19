const crypto = require('crypto');

const MAX_SAFE_ID = 9007199254740991;
const MAX_ALLOCATABLE_PREVIOUS_ID = 9007199254740990n;
const PREVIOUS_ENTRY_ID_SQL = `
  WITH bounds AS (
    SELECT
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name='knowledge_entries'),0) AS seq,
      COALESCE((SELECT MAX(id) FROM knowledge_entries),0) AS max_id
  )
  SELECT CASE WHEN seq>max_id THEN seq ELSE max_id END AS previous_id
  FROM bounds
`;

function assertScalarText(value, label) {
  const text = String(value);
  for (const point of text) {
    const codePoint = point.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new Error(`${label} contains an isolated Unicode surrogate`);
    }
  }
  return text;
}

function canonicalKnowledgeText(value, label) {
  return assertScalarText(value, label).replace(/\r\n?/g, '\n').normalize('NFC');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalKnowledgeTags(tags) {
  const normalized = tags.map(function(tag) {
    return canonicalKnowledgeText(tag, 'knowledge tag');
  });
  return Array.from(new Set(normalized)).sort(compareUtf8);
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function frame32(bytes) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (payload.length > 0xffffffff) throw new Error('knowledge digest frame is too large');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, payload]);
}

function framedDigest(payloads) {
  return sha256Hex(Buffer.concat(payloads.map(frame32)));
}

function assertPositiveSafeId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_ID) {
    throw new Error(`${label} must be a positive JavaScript-safe integer`);
  }
  return value;
}

function typedText(value, label) {
  return Buffer.concat([
    Buffer.from([2]),
    Buffer.from(assertScalarText(value, label), 'utf8')
  ]);
}

function typedInteger(value, label) {
  return Buffer.concat([
    Buffer.from([1]),
    Buffer.from(String(assertPositiveSafeId(value, label)), 'utf8')
  ]);
}

function typedNullableText(value, label) {
  return value === null ? Buffer.from([0]) : typedText(value, label);
}

function typedNullableInteger(value, label) {
  return value === null ? Buffer.from([0]) : typedInteger(value, label);
}

function sqliteIntegerAffinitySourceId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') {
    if (value < 1n || value > BigInt(MAX_SAFE_ID)) {
      throw new Error('knowledge source_id must be a positive JavaScript-safe integer');
    }
    return Number(value);
  }
  if (typeof value === 'number') {
    return assertPositiveSafeId(value, 'knowledge source_id');
  }
  const text = assertScalarText(value, 'knowledge source_id');
  if (Buffer.byteLength(text, 'utf8') > 4096) {
    throw new Error('knowledge source_id exceeds 4096 UTF-8 bytes');
  }
  if (text.includes('\u0000')) {
    throw new Error('knowledge source_id cannot contain NUL');
  }
  const numericLiteral = /^[\u0009-\u000d\u0020]*[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?[\u0009-\u000d\u0020]*$/;
  if (!numericLiteral.test(text)) return text;
  const numeric = Number(text);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > MAX_SAFE_ID) {
    throw new Error('knowledge source_id would not retain safe INTEGER storage');
  }
  return numeric;
}

function legacySourceIdentityDigest(entry) {
  let sourceId;
  if (entry.source_id === null) sourceId = Buffer.from([0]);
  else if (typeof entry.source_id === 'number') {
    sourceId = typedInteger(entry.source_id, 'knowledge source_id');
  } else {
    sourceId = typedText(entry.source_id, 'knowledge source_id');
  }
  return framedDigest([
    typedText('tm-knowledge-legacy-source-v1', 'knowledge source identity version'),
    typedInteger(entry.id, 'knowledge entry id'),
    typedNullableText(entry.entry_type, 'knowledge entry_type'),
    typedNullableText(entry.source_type, 'knowledge source_type'),
    sourceId,
    typedNullableText(entry.source_hash, 'knowledge source_hash'),
    typedNullableText(entry.business_type, 'knowledge business_type'),
    typedNullableText(entry.business_id, 'knowledge business_id'),
    typedNullableInteger(entry.created_by, 'knowledge created_by')
  ]);
}

function knowledgeContentDigest(entry) {
  return framedDigest([
    'tm-knowledge-content-v1',
    entry.entry_type,
    entry.title,
    entry.summary,
    entry.content,
    JSON.stringify(entry.tags),
    entry.visibility
  ].map(function(value, index) {
    return Buffer.from(assertScalarText(value, `knowledge content frame ${index}`), 'utf8');
  }));
}

function toJson(value, fallback) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function normalizeTags(tags) {
  const parsed = parseJson(tags, tags);
  if (Array.isArray(parsed)) {
    return parsed.map(function(tag) { return String(tag || '').trim(); }).filter(Boolean);
  }
  if (typeof parsed === 'string') {
    return parsed.split(/[,\n;|]/).map(function(tag) { return tag.trim(); }).filter(Boolean);
  }
  return [];
}

function normalizeVisibility(input) {
  if (input === 'private' || input === 'team' || input === 'public' || input === 'shared') return input;
  return 'private';
}

function isSharedVisibility(visibility) {
  return visibility === 'team' || visibility === 'public' || visibility === 'shared';
}

function hashInput(input) {
  const title = input.title || '';
  const content = input.content || '';
  const sourceType = input.source_type || '';
  const sourceId = input.source_id !== undefined && input.source_id !== null ? String(input.source_id) : '';
  const businessType = input.business_type || '';
  const businessId = input.business_id || '';
  const ownerId = input.owner_id !== undefined && input.owner_id !== null ? String(input.owner_id) : '';
  const stableSource = sourceType && sourceId ? [sourceType, sourceId, businessType, businessId, ownerId].join('|') : '';
  const payload = stableSource || [input.entry_type || 'note', title, content, ownerId].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function compactText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const points = Array.from(text);
  if (!maxLength || points.length <= maxLength) return text;
  return points.slice(0, Math.max(0, maxLength - 3)).join('') + '...';
}

function makeChunks(content, chunkSize) {
  const text = assertScalarText(String(content || ''), 'knowledge chunk input').trim();
  if (!text) return [''];
  const size = Number.isSafeInteger(chunkSize) && chunkSize > 0 ? chunkSize : 1200;
  const chunks = [];
  let current = '';
  text.split(/\n{2,}/).forEach(function(part) {
    const paragraph = part.trim();
    if (!paragraph) return;
    const candidate = current ? current + '\n\n' + paragraph : paragraph;
    if (Array.from(candidate).length <= size) {
      current = candidate;
      return;
    }
    if (current) chunks.push(current);
    const points = Array.from(paragraph);
    if (points.length <= size) {
      current = paragraph;
      return;
    }
    for (let i = 0; i < points.length; i += size) {
      chunks.push(points.slice(i, i + size).join(''));
    }
    current = '';
  });
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

function normalizeEntry(row) {
  if (!row) return null;
  const tags = normalizeTags(row.tags_json || row.key_terms || []);
  const visibility = normalizeVisibility(row.visibility || (row.is_public ? 'team' : 'private'));
  return {
    id: row.id,
    entry_type: row.entry_type || 'note',
    title: row.title || compactText(row.key_terms || row.content || 'Knowledge', 80),
    summary: row.summary || compactText(row.content || '', 240),
    content: row.content || '',
    tags: tags,
    tags_json: row.tags_json || JSON.stringify(tags),
    source_type: row.source_type || '',
    source_id: row.source_id,
    source_hash: row.source_hash || '',
    business_type: row.business_type || '',
    business_id: row.business_id || '',
    metadata: parseJson(row.metadata_json, {}),
    visibility: visibility,
    created_by: row.created_by,
    is_public: row.is_public,
    usage_count: row.usage_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    snippet: compactText(row.summary || row.content || '', 220)
  };
}

function preparedChunks(entry) {
  return makeChunks(entry.content).map(function(content, index) {
    return {
      index,
      content,
      contentSha256: sha256Hex(Buffer.from(content, 'utf8')),
      metadataJson: toJson({ title: entry.title }, {}),
      tokenCount: Math.ceil(Array.from(content).length / 4)
    };
  });
}

function rebuildChunks(db, entryId, entry) {
  const chunks = preparedChunks(entry);
  db.prepare('DELETE FROM knowledge_chunks_fts WHERE entry_id = ?').run(entryId);
  db.prepare('DELETE FROM knowledge_chunks WHERE entry_id = ?').run(entryId);
  const insertChunk = db.prepare(`
    INSERT INTO knowledge_chunks (
      entry_id,chunk_index,content,metadata_json,token_count,embedding_json,content_sha256
    )
    VALUES (?,?,?,?,?,?,?)
  `).safeIntegers(true);
  const insertFts = db.prepare(`
    INSERT INTO knowledge_chunks_fts (title, content, tags, entry_id, chunk_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const expectedFts = [];
  chunks.forEach(function(chunk) {
    const result = insertChunk.run(
      entryId,
      chunk.index,
      chunk.content,
      chunk.metadataJson,
      chunk.tokenCount,
      null,
      chunk.contentSha256
    );
    const chunkIdValue = result.lastInsertRowid;
    if (
      typeof chunkIdValue !== 'bigint' ||
      chunkIdValue < 1n ||
      chunkIdValue > BigInt(MAX_SAFE_ID)
    ) {
      throw new Error('knowledge chunk identifier is not JavaScript-safe');
    }
    const chunkId = Number(chunkIdValue);
    insertFts.run(
      entry.title,
      chunk.content,
      entry.tags.join(' '),
      entryId,
      chunkId
    );
    expectedFts.push({
      title: entry.title,
      content: chunk.content,
      tags: entry.tags.join(' '),
      entry_id: entryId,
      chunk_id: chunkId
    });
  });

  db.prepare(
    "INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('integrity-check')"
  ).run();
  const actualFts = db.prepare(`
    SELECT title,content,tags,entry_id,chunk_id
    FROM knowledge_chunks_fts
    WHERE entry_id=?
    ORDER BY CAST(chunk_id AS INTEGER),rowid
  `).all(entryId);
  if (JSON.stringify(actualFts) !== JSON.stringify(expectedFts)) {
    throw new Error('knowledge FTS projection mismatch');
  }
}

function rawCreatorId(input) {
  if (Object.prototype.hasOwnProperty.call(input, 'created_by')) {
    return input.created_by;
  }
  if (input.user && Object.prototype.hasOwnProperty.call(input.user, 'id')) {
    return input.user.id;
  }
  return null;
}

function normalizedCreatorId(input) {
  const raw = rawCreatorId(input);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'bigint') {
    if (raw < 1n || raw > BigInt(MAX_SAFE_ID)) {
      throw new Error('knowledge created_by must be a positive JavaScript-safe integer');
    }
    return Number(raw);
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new Error('knowledge created_by must be a positive JavaScript-safe integer');
  }
  if (typeof raw === 'string' && raw.length === 0) {
    throw new Error('knowledge created_by must be a positive JavaScript-safe integer');
  }
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  return assertPositiveSafeId(numeric, 'knowledge created_by');
}

function optionalStoredText(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return assertScalarText(value, label);
}

function prepareLegacyEntry(input) {
  const visibility = normalizeVisibility(
    input.visibility ||
    (input.is_public === 1 ? 'team' : input.is_public === 0 ? 'private' : 'private')
  );
  const rawCreator = rawCreatorId(input);
  const createdBy = normalizedCreatorId(input);
  const rawHashInput = {
    entry_type: input.entry_type || input.type || 'note',
    title: input.title || '',
    content: input.content || '',
    source_type: input.source_type || '',
    source_id: input.source_id,
    business_type: input.business_type,
    business_id: input.business_id,
    owner_id: visibility === 'private' && rawCreator !== null && rawCreator !== undefined
      ? rawCreator
      : ''
  };
  const rawSourceHash = (
    input.allow_source_hash === true && input.source_hash
      ? input.source_hash
      : hashInput(rawHashInput)
  );
  const tags = canonicalKnowledgeTags(
    normalizeTags(input.tags_json || input.tags || input.key_terms || [])
  );
  const entryType = assertScalarText(
    input.entry_type || input.type || 'note',
    'knowledge entry_type'
  );
  const title = canonicalKnowledgeText(
    input.title || compactText(input.content || input.summary || 'Knowledge', 80),
    'knowledge title'
  );
  const summary = canonicalKnowledgeText(
    input.summary || compactText(input.content || '', 240),
    'knowledge summary'
  );
  const content = canonicalKnowledgeText(
    String(input.content || ''),
    'knowledge content'
  );
  const entry = {
    entry_type: entryType,
    title,
    summary,
    content,
    tags,
    source_type: optionalStoredText(input.source_type, 'knowledge source_type'),
    source_id: sqliteIntegerAffinitySourceId(input.source_id),
    source_hash: assertScalarText(rawSourceHash, 'knowledge source_hash'),
    business_type: optionalStoredText(input.business_type, 'knowledge business_type'),
    business_id: input.business_id === undefined
      ? null
      : assertScalarText(String(input.business_id), 'knowledge business_id'),
    metadata_json: toJson(input.metadata || input.metadata_json || {}, {}),
    embedding_json: input.embedding_json ? toJson(input.embedding_json, null) : null,
    created_by: createdBy,
    is_public: isSharedVisibility(visibility) ? 1 : 0,
    visibility
  };
  entry.content_sha256 = knowledgeContentDigest(entry);
  return entry;
}

function findSourceHashEntry(db, sourceHash) {
  if (!sourceHash) return null;
  return db.prepare(`
    SELECT
      id,entry_type,source_type,source_id,source_hash,business_type,business_id,
      created_by,visibility,is_public,source_identity_sha256
    FROM knowledge_entries
    WHERE source_hash=?
  `).get(sourceHash) || null;
}

function isCampaignClassified(db, entryId) {
  const hasCampaignLinks = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type='table' AND name='campaign_record_links'
  `).get();
  if (!hasCampaignLinks) return false;
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM campaign_record_links
    WHERE record_type='knowledge_entry' AND record_id=?
    LIMIT 1
  `).get(String(entryId)));
}

function assertStoredSourceIdentity(existing) {
  if (
    typeof existing.source_identity_sha256 !== 'string' ||
    legacySourceIdentityDigest(existing) !== existing.source_identity_sha256
  ) {
    throw new Error('Knowledge source identity digest mismatch');
  }
}

function preserveLegacyEmptyIdentity(existingValue, candidateValue, canonicalDefault) {
  if (
    (existingValue === null || existingValue === '') &&
    candidateValue === canonicalDefault
  ) {
    return existingValue;
  }
  return candidateValue;
}

function refreshSourceIdentity(existing, entry) {
  return Object.assign({}, entry, {
    id: existing.id,
    entry_type: preserveLegacyEmptyIdentity(
      existing.entry_type,
      entry.entry_type,
      'note'
    ),
    source_type: preserveLegacyEmptyIdentity(
      existing.source_type,
      entry.source_type,
      null
    ),
    business_type: preserveLegacyEmptyIdentity(
      existing.business_type,
      entry.business_type,
      null
    ),
    created_by: existing.created_by
  });
}

function existingWriteDecision(db, existing, entry, input) {
  if (isCampaignClassified(db, existing.id)) {
    throw new Error('Knowledge entry requires campaign-aware custody');
  }
  assertStoredSourceIdentity(existing);
  const sameOwner = existing.created_by === entry.created_by;
  const actorIsAdmin = input.actor_role === 'admin' || (input.user && input.user.role === 'admin');
  if (sameOwner || actorIsAdmin) {
    if (
      legacySourceIdentityDigest(refreshSourceIdentity(existing, entry)) !==
      existing.source_identity_sha256
    ) {
      throw new Error('Knowledge source identity is immutable');
    }
    return 'update';
  }
  if (
    normalizeVisibility(
      existing.visibility || (existing.is_public ? 'team' : 'private')
    ) === 'private'
  ) {
    throw new Error('Knowledge source hash is already owned by another user');
  }
  return 'reuse';
}

function allocateKnowledgeEntryId(db) {
  const statement = db.prepare(PREVIOUS_ENTRY_ID_SQL).safeIntegers(true);
  const row = statement.get();
  if (!row || typeof row.previous_id !== 'bigint') {
    throw new Error('knowledge previous_id must have INTEGER storage');
  }
  if (row.previous_id < 0n || row.previous_id > MAX_ALLOCATABLE_PREVIOUS_ID) {
    throw new Error('knowledge entry identifier capacity is exhausted');
  }
  const nextId = Number(row.previous_id + 1n);
  if (db.prepare('SELECT 1 AS present FROM knowledge_entries WHERE id=?').get(nextId)) {
    throw new Error('knowledge entry identifier is already allocated');
  }
  return nextId;
}

function verifyKnowledgeEntrySequence(db, entryId) {
  const row = db.prepare(`
    SELECT seq,typeof(seq) AS seq_type
    FROM sqlite_sequence
    WHERE name='knowledge_entries'
  `).safeIntegers(true).get();
  if (
    !row ||
    row.seq_type !== 'integer' ||
    typeof row.seq !== 'bigint' ||
    row.seq !== BigInt(entryId)
  ) {
    throw new Error('knowledge_entries sqlite_sequence did not advance atomically');
  }
}

function ingestKnowledge(db, input) {
  const entry = prepareLegacyEntry(input);
  const initialExisting = findSourceHashEntry(db, entry.source_hash);
  if (initialExisting) existingWriteDecision(db, initialExisting, entry, input);

  let id;
  const tx = db.transaction(function() {
    const existing = findSourceHashEntry(db, entry.source_hash);
    if (existing) {
      const decision = existingWriteDecision(db, existing, entry, input);
      id = existing.id;
      if (decision === 'reuse') return;
      const refreshEntry = Object.assign({}, entry, {
        entry_type: existing.entry_type === null ? 'note' : existing.entry_type
      });
      refreshEntry.content_sha256 = knowledgeContentDigest(refreshEntry);
      const update = db.prepare(`
        UPDATE knowledge_entries
        SET
          title=?,summary=?,key_terms=?,content=?,is_public=?,tags_json=?,visibility=?,
          metadata_json=?,embedding_json=?,content_sha256=?,updated_at=datetime('now')
        WHERE id=?
      `).run(
        refreshEntry.title,
        refreshEntry.summary,
        JSON.stringify(refreshEntry.tags),
        refreshEntry.content,
        refreshEntry.is_public,
        JSON.stringify(refreshEntry.tags),
        refreshEntry.visibility,
        refreshEntry.metadata_json,
        refreshEntry.embedding_json,
        refreshEntry.content_sha256,
        id
      );
      if (update.changes !== 1) throw new Error('knowledge refresh count mismatch');
      rebuildChunks(db, id, refreshEntry);
      return;
    }

    id = allocateKnowledgeEntryId(db);
    entry.id = id;
    entry.source_identity_sha256 = legacySourceIdentityDigest(entry);
    const insert = db.prepare(`
      INSERT INTO knowledge_entries (
        id,entry_type,title,summary,source_type,source_id,key_terms,content,created_by,
        is_public,tags_json,visibility,source_hash,business_type,business_id,
        metadata_json,embedding_json,source_identity_sha256,content_sha256
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      entry.entry_type,
      entry.title,
      entry.summary,
      entry.source_type,
      entry.source_id,
      JSON.stringify(entry.tags),
      entry.content,
      entry.created_by,
      entry.is_public,
      JSON.stringify(entry.tags),
      entry.visibility,
      entry.source_hash,
      entry.business_type,
      entry.business_id,
      entry.metadata_json,
      entry.embedding_json,
      entry.source_identity_sha256,
      entry.content_sha256
    );
    if (insert.changes !== 1) throw new Error('knowledge insert count mismatch');
    verifyKnowledgeEntrySequence(db, id);
    rebuildChunks(db, id, entry);
  });
  tx.immediate();

  return normalizeEntry(db.prepare('SELECT * FROM knowledge_entries WHERE id=?').get(id));
}

function buildWhere(opts) {
  const where = ['1=1'];
  const params = [];
  const user = opts.user || {};
  if (opts.entry_type || opts.type) { where.push('entry_type = ?'); params.push(opts.entry_type || opts.type); }
  if (opts.source_type) { where.push('source_type = ?'); params.push(opts.source_type); }
  if (opts.visibility) { where.push('visibility = ?'); params.push(opts.visibility); }
  if (opts.business_type) { where.push('business_type = ?'); params.push(opts.business_type); }
  if (opts.business_id) { where.push('business_id = ?'); params.push(String(opts.business_id)); }
  if (user.role !== 'admin') {
    where.push('(created_by = ? OR visibility IN (\'team\', \'public\', \'shared\') OR is_public = 1)');
    params.push(user.id || -1);
  }
  return { clause: where.join(' AND '), params: params };
}

function extractSearchTerms(query) {
  const text = String(query || '').toLowerCase();
  const terms = [];
  const seen = new Set();
  function add(term) {
    const normalized = String(term || '').trim();
    if (normalized.length < 2 || seen.has(normalized)) return;
    seen.add(normalized);
    terms.push(normalized);
  }

  text.split(/[\s,，。.!！？?；;：:、/\\()[\]{}【】《》"'`~|+-]+/).forEach(add);
  const tokens = text.match(/[\u4e00-\u9fff]+|[a-z0-9][a-z0-9_-]*/g) || [];
  tokens.forEach(function(token) {
    add(token);
    if (!/^[\u4e00-\u9fff]+$/.test(token) || token.length <= 2) return;
    const maxLen = Math.min(6, token.length);
    for (let len = maxLen; len >= 2; len--) {
      for (let index = 0; index <= token.length - len; index++) {
        add(token.slice(index, index + len));
        if (terms.length >= 80) return;
      }
      if (terms.length >= 80) return;
    }
  });
  return terms.slice(0, 80);
}

function scoreEntry(entry, terms, rawQuery) {
  if (!terms.length && !rawQuery) return 1;
  const title = String(entry.title || '').toLowerCase();
  const summary = String(entry.summary || '').toLowerCase();
  const content = String(entry.content || '').toLowerCase();
  const tags = (entry.tags || []).join(' ').toLowerCase();
  const haystack = [title, summary, content, tags].join(' ');
  const query = String(rawQuery || '').toLowerCase();
  let score = query && haystack.indexOf(query) >= 0 ? 10 : 0;
  terms.forEach(function(term) {
    if (!term) return;
    if (title.indexOf(term) >= 0) score += 8;
    if (tags.indexOf(term) >= 0) score += 6;
    if (summary.indexOf(term) >= 0) score += 4;
    if (content.indexOf(term) >= 0) score += 2;
  });
  return score;
}

function searchKnowledge(db, opts) {
  opts = opts || {};
  const query = String(opts.q || opts.query || opts.search || '').trim();
  const limit = Math.min(parseInt(opts.limit || 20, 10) || 20, 100);
  const tags = normalizeTags(opts.tags || opts.tag || []);
  const where = buildWhere(opts);
  let rows = db.prepare(`
    SELECT * FROM knowledge_entries
    WHERE ${where.clause}
    ORDER BY usage_count DESC, updated_at DESC, id DESC
    LIMIT 500
  `).all(...where.params);

  let entries = rows.map(normalizeEntry);
  if (tags.length) {
    const wanted = tags.map(function(tag) { return tag.toLowerCase(); });
    entries = entries.filter(function(entry) {
      const have = (entry.tags || []).map(function(tag) { return tag.toLowerCase(); });
      return wanted.every(function(tag) { return have.some(function(item) { return item.indexOf(tag) >= 0; }); });
    });
  }

  if (query) {
    const terms = extractSearchTerms(query);
    entries = entries
      .map(function(entry) { return Object.assign({}, entry, { score: scoreEntry(entry, terms, query) }); })
      .filter(function(entry) { return entry.score > 0; })
      .sort(function(a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return (b.usage_count || 0) - (a.usage_count || 0);
      });
  }

  return entries.slice(0, limit);
}

function markKnowledgeUsed(db, ids) {
  const uniqueIds = Array.from(new Set((ids || []).map(function(id) { return parseInt(id, 10); }).filter(Boolean)));
  if (!uniqueIds.length) return 0;
  const update = db.prepare('UPDATE knowledge_entries SET usage_count = usage_count + 1, updated_at = datetime(\'now\') WHERE id = ?');
  const tx = db.transaction(function() {
    uniqueIds.forEach(function(id) { update.run(id); });
  });
  tx();
  return uniqueIds.length;
}

module.exports = {
  ingestKnowledge,
  searchKnowledge,
  markKnowledgeUsed,
  normalizeEntry,
  normalizeTags,
  hashInput,
  makeChunks
};
