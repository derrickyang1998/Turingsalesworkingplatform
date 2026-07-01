const crypto = require('crypto');

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
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '...';
}

function makeChunks(content, chunkSize) {
  const text = String(content || '').trim();
  if (!text) return [''];
  const size = chunkSize || 1200;
  const chunks = [];
  let current = '';
  text.split(/\n{2,}/).forEach(function(part) {
    const paragraph = part.trim();
    if (!paragraph) return;
    if ((current + '\n\n' + paragraph).length <= size) {
      current = current ? current + '\n\n' + paragraph : paragraph;
      return;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= size) {
      current = paragraph;
      return;
    }
    for (let i = 0; i < paragraph.length; i += size) chunks.push(paragraph.slice(i, i + size));
    current = '';
  });
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.slice(0, size)];
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

function rebuildChunks(db, entryId, entry) {
  try { db.prepare('DELETE FROM knowledge_chunks_fts WHERE entry_id = ?').run(entryId); } catch (e) {}
  db.prepare('DELETE FROM knowledge_chunks WHERE entry_id = ?').run(entryId);
  const chunks = makeChunks(entry.content);
  const insertChunk = db.prepare(`
    INSERT INTO knowledge_chunks (entry_id, chunk_index, content, metadata_json, token_count, embedding_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO knowledge_chunks_fts (title, content, tags, entry_id, chunk_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  chunks.forEach(function(chunk, index) {
    const result = insertChunk.run(entryId, index, chunk, toJson({ title: entry.title }, {}), Math.ceil(chunk.length / 4), null);
    try {
      insertFts.run(entry.title || '', chunk || '', (entry.tags || []).join(' '), entryId, result.lastInsertRowid);
    } catch (e) {}
  });
}

function ingestKnowledge(db, input) {
  const tags = normalizeTags(input.tags_json || input.tags || input.key_terms || []);
  const visibility = normalizeVisibility(input.visibility || (input.is_public === 1 ? 'team' : input.is_public === 0 ? 'private' : 'private'));
  const entry = {
    entry_type: input.entry_type || input.type || 'note',
    title: input.title || compactText(input.content || input.summary || 'Knowledge', 80),
    summary: input.summary || compactText(input.content || '', 240),
    content: String(input.content || ''),
    tags: tags,
    source_type: input.source_type || null,
    source_id: input.source_id === undefined ? null : input.source_id,
    source_hash: input.allow_source_hash === true && input.source_hash ? input.source_hash : hashInput({
      entry_type: input.entry_type || input.type || 'note',
      title: input.title || '',
      content: input.content || '',
      source_type: input.source_type || '',
      source_id: input.source_id,
      business_type: input.business_type,
      business_id: input.business_id,
      owner_id: visibility === 'private' ? (input.created_by || (input.user && input.user.id) || '') : ''
    }),
    business_type: input.business_type || null,
    business_id: input.business_id === undefined ? null : String(input.business_id),
    metadata_json: toJson(input.metadata || input.metadata_json || {}, {}),
    embedding_json: input.embedding_json ? toJson(input.embedding_json, null) : null,
    created_by: input.created_by || (input.user && input.user.id) || null,
    is_public: isSharedVisibility(visibility) ? 1 : 0,
    visibility: visibility
  };

  const existing = entry.source_hash
    ? db.prepare('SELECT id, created_by, visibility, is_public FROM knowledge_entries WHERE source_hash = ?').get(entry.source_hash)
    : null;

  if (existing) {
    const sameOwner = Number(existing.created_by || 0) === Number(entry.created_by || 0);
    const actorIsAdmin = input.actor_role === 'admin' || (input.user && input.user.role === 'admin');
    if (!sameOwner && !actorIsAdmin) {
      if (normalizeVisibility(existing.visibility || (existing.is_public ? 'team' : 'private')) === 'private') {
        throw new Error('Knowledge source hash is already owned by another user');
      }
      return normalizeEntry(db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(existing.id));
    }
  }

  let id;
  const tx = db.transaction(function() {
    if (existing) {
      id = existing.id;
      db.prepare(`
        UPDATE knowledge_entries
        SET entry_type = ?, title = ?, summary = ?, source_type = ?, source_id = ?, key_terms = ?,
            content = ?, is_public = ?, tags_json = ?, visibility = ?, business_type = ?, business_id = ?,
            metadata_json = ?, embedding_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        entry.entry_type, entry.title, entry.summary, entry.source_type, entry.source_id,
        JSON.stringify(tags), entry.content, entry.is_public, JSON.stringify(tags), entry.visibility,
        entry.business_type, entry.business_id, entry.metadata_json, entry.embedding_json, id
      );
    } else {
      const result = db.prepare(`
        INSERT INTO knowledge_entries (
          entry_type, title, summary, source_type, source_id, key_terms, content, created_by, is_public,
          tags_json, visibility, source_hash, business_type, business_id, metadata_json, embedding_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.entry_type, entry.title, entry.summary, entry.source_type, entry.source_id,
        JSON.stringify(tags), entry.content, entry.created_by, entry.is_public, JSON.stringify(tags),
        entry.visibility, entry.source_hash, entry.business_type, entry.business_id, entry.metadata_json,
        entry.embedding_json
      );
      id = result.lastInsertRowid;
    }
    rebuildChunks(db, id, entry);
  });
  tx();

  return normalizeEntry(db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id));
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
