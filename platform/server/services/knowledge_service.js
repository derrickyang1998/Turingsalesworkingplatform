const crypto = require('crypto');
const {
  buildCollectionAccessPredicate,
  projectKnowledgeVisibility,
  serializeKnowledgeReference
} = require('./campaign_access_service');

const MAX_SAFE_ID = 9007199254740991;
const MAX_ALLOCATABLE_PREVIOUS_ID = 9007199254740990n;
const MAX_SAFE_ID_BIGINT = BigInt(MAX_SAFE_ID);
const PREVIOUS_ENTRY_ID_SQL = `
  WITH bounds AS (
    SELECT
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name='knowledge_entries'),0) AS seq,
      COALESCE((SELECT MAX(id) FROM knowledge_entries),0) AS max_id
  )
  SELECT CASE WHEN seq>max_id THEN seq ELSE max_id END AS previous_id
  FROM bounds
`;
const PREVIOUS_CHUNK_ID_SQL = `
  WITH bounds AS (
    SELECT
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name='knowledge_chunks'),0) AS seq,
      COALESCE((SELECT MAX(id) FROM knowledge_chunks),0) AS max_id
  )
  SELECT CASE WHEN seq>max_id THEN seq ELSE max_id END AS previous_id
  FROM bounds
`;
const CAMPAIGN_KNOWLEDGE_CAPACITY = Object.freeze({
  user: Object.freeze({
    entries: 50000,
    chunks: 500000,
    payloadBytes: 5 * 1024 * 1024 * 1024,
    references: 2000000
  }),
  campaign: Object.freeze({
    entries: 100000,
    chunks: 1000000,
    payloadBytes: 10 * 1024 * 1024 * 1024,
    references: 4000000
  }),
  organization: Object.freeze({
    entries: 500000,
    chunks: 5000000,
    payloadBytes: 50 * 1024 * 1024 * 1024,
    references: 20000000
  })
});
const CAPACITY_METRICS = Object.freeze([
  'entries',
  'chunks',
  'payloadBytes',
  'references'
]);
const KNOWLEDGE_CUSTODY_CTE = `
  knowledge_custody_ranked AS MATERIALIZED (
    SELECT
      CAST(custody_link.record_id AS INTEGER) AS entry_id,
      custody_link.org_id,
      custody_link.campaign_id,
      ROW_NUMBER() OVER (
        PARTITION BY custody_link.record_id
        ORDER BY
          CASE WHEN custody_link.revoked_at IS NULL THEN 0 ELSE 1 END,
          CASE
            WHEN custody_link.revoked_at IS NULL THEN custody_link.id
          END DESC,
          CASE
            WHEN custody_link.revoked_at IS NOT NULL
              THEN custody_link.revoked_at
          END DESC,
          custody_link.id DESC
      ) AS custody_rank
    FROM campaign_record_links custody_link
    WHERE custody_link.record_type='knowledge_entry'
      AND custody_link.relation_type<>'shortlist'
  ),
  knowledge_custody AS (
    SELECT entry_id,org_id,campaign_id
    FROM knowledge_custody_ranked
    WHERE custody_rank=1
  )
`;

class CampaignKnowledgeConflictError extends Error {
  constructor(message) {
    super(message || 'Campaign knowledge source content conflict');
    this.name = 'CampaignKnowledgeConflictError';
    this.code = 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT';
    this.status = 409;
    this.statusCode = 409;
  }
}

class CampaignKnowledgeCapacityError extends Error {
  constructor(details) {
    super('Campaign knowledge storage capacity exceeded');
    this.name = 'CampaignKnowledgeCapacityError';
    this.code = 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED';
    this.status = 507;
    this.statusCode = 507;
    this.details = details;
  }
}

class CampaignKnowledgeInputError extends Error {
  constructor(message) {
    super(message || 'Campaign knowledge input is invalid');
    this.name = 'CampaignKnowledgeInputError';
    this.code = 'INVALID_CAMPAIGN_INPUT';
    this.status = 400;
    this.statusCode = 400;
  }
}

class KnowledgeGovernanceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'KnowledgeGovernanceError';
    this.code = code;
    this.status = statusCode;
    this.statusCode = statusCode;
  }
}

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
  const governance = normalizeGovernance(row);
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
    snippet: compactText(row.summary || row.content || '', 220),
    governance
  };
}

function hasKnowledgeGovernance(db) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type='table' AND name='knowledge_entry_governance'
  `).get());
}

function governanceValue(row, name) {
  if (!row || typeof row !== 'object') return undefined;
  const projected = row[`governance_${name}`];
  return projected === undefined ? row[name] : projected;
}

function governanceRetrievable(row, now) {
  const quality = governanceValue(row, 'quality_state');
  const isCurrent = governanceValue(row, 'is_current');
  const retentionClass = governanceValue(row, 'retention_class');
  const retainUntil = governanceValue(row, 'retain_until');
  if (quality === undefined) return true;
  if (isCurrent !== 1 || !['candidate', 'confirmed'].includes(quality)) return false;
  if (retentionClass === 'protected') return true;
  return (
    retentionClass === 'scheduled' &&
    typeof retainUntil === 'string' &&
    retainUntil > now
  );
}

function normalizeGovernance(row) {
  const knowledgeEntryId = governanceValue(row, 'knowledge_entry_id');
  if (knowledgeEntryId === undefined || knowledgeEntryId === null) return null;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return {
    knowledge_entry_id: knowledgeEntryId,
    lineage_root_entry_id: governanceValue(row, 'lineage_root_entry_id'),
    supersedes_entry_id: governanceValue(row, 'supersedes_entry_id'),
    version_no: governanceValue(row, 'version_no'),
    is_current: governanceValue(row, 'is_current') === 1,
    quality_state: governanceValue(row, 'quality_state'),
    retention_class: governanceValue(row, 'retention_class'),
    retain_until: governanceValue(row, 'retain_until'),
    governance_version: governanceValue(row, 'governance_version'),
    reviewed_by: governanceValue(row, 'reviewed_by'),
    reviewed_at: governanceValue(row, 'reviewed_at'),
    review_reason: governanceValue(row, 'review_reason'),
    created_at: governanceValue(row, 'created_at'),
    updated_at: governanceValue(row, 'updated_at'),
    is_retrievable: governanceRetrievable(row, now)
  };
}

function governanceProjection(alias = 'governance') {
  return `
    ${alias}.knowledge_entry_id AS governance_knowledge_entry_id,
    ${alias}.lineage_root_entry_id AS governance_lineage_root_entry_id,
    ${alias}.supersedes_entry_id AS governance_supersedes_entry_id,
    ${alias}.version_no AS governance_version_no,
    ${alias}.is_current AS governance_is_current,
    ${alias}.quality_state AS governance_quality_state,
    ${alias}.retention_class AS governance_retention_class,
    ${alias}.retain_until AS governance_retain_until,
    ${alias}.governance_version AS governance_governance_version,
    ${alias}.reviewed_by AS governance_reviewed_by,
    ${alias}.reviewed_at AS governance_reviewed_at,
    ${alias}.review_reason AS governance_review_reason,
    ${alias}.created_at AS governance_created_at,
    ${alias}.updated_at AS governance_updated_at`;
}

function governanceEligibilitySql(alias = 'governance') {
  return `(
    ${alias}.knowledge_entry_id IS NOT NULL
    AND ${alias}.is_current=1
    AND ${alias}.quality_state IN ('candidate','confirmed')
    AND (
      ${alias}.retention_class='protected'
      OR (${alias}.retention_class='scheduled' AND ${alias}.retain_until>CURRENT_TIMESTAMP)
    )
  )`;
}

function knowledgeGovernanceSql(db, entryAlias = 'entry', governanceAlias = 'governance') {
  for (const alias of [entryAlias, governanceAlias]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
      throw new TypeError('knowledge governance SQL alias is invalid');
    }
  }
  if (!hasKnowledgeGovernance(db)) {
    return Object.freeze({
      joinSql: '',
      eligibilitySql: '1=1',
      canUseInAiSql: '1'
    });
  }
  const eligibilitySql = governanceEligibilitySql(governanceAlias);
  return Object.freeze({
    joinSql: `JOIN knowledge_entry_governance ${governanceAlias}
      ON ${governanceAlias}.knowledge_entry_id=${entryAlias}.id`,
    eligibilitySql,
    canUseInAiSql: `CASE WHEN ${eligibilitySql} THEN 1 ELSE 0 END`
  });
}

function readKnowledgeGovernance(db, entryId) {
  if (!hasKnowledgeGovernance(db)) return null;
  return db.prepare(`
    SELECT governance.*
    FROM knowledge_entry_governance governance
    WHERE governance.knowledge_entry_id=?
  `).get(entryId) || null;
}

function isKnowledgeRetrievable(db, entryId) {
  const numericId = Number(entryId);
  if (!Number.isSafeInteger(numericId) || numericId < 1) return false;
  if (!hasKnowledgeGovernance(db)) {
    return Boolean(db.prepare('SELECT 1 AS present FROM knowledge_entries WHERE id=?').get(numericId));
  }
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM knowledge_entry_governance governance
    WHERE governance.knowledge_entry_id=?
      AND ${governanceEligibilitySql('governance')}
  `).get(numericId));
}

function knowledgeGovernanceError(statusCode, code, message) {
  throw new KnowledgeGovernanceError(statusCode, code, message);
}

function governanceId(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || String(numeric) !== String(value)) {
    knowledgeGovernanceError(400, 'INVALID_KNOWLEDGE_GOVERNANCE_INPUT', `${label} is invalid.`);
  }
  return numeric;
}

function governanceReason(value) {
  const reason = canonicalKnowledgeText(value === undefined ? '' : value, 'governance reason').trim();
  if (Array.from(reason).length < 1 || Array.from(reason).length > 500) {
    knowledgeGovernanceError(
      400,
      'INVALID_KNOWLEDGE_GOVERNANCE_INPUT',
      'A governance reason between 1 and 500 characters is required.'
    );
  }
  return reason;
}

function governanceTimestamp(value) {
  const canonical = typeof value === 'string'
    ? new Date(value.replace(' ', 'T') + 'Z')
    : null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ||
    Number.isNaN(canonical.getTime()) ||
    canonical.toISOString().slice(0, 19).replace('T', ' ') !== value
  ) {
    knowledgeGovernanceError(
      400,
      'INVALID_KNOWLEDGE_GOVERNANCE_INPUT',
      'retain_until must be a UTC timestamp in YYYY-MM-DD HH:mm:ss format.'
    );
  }
  return value;
}

function governanceRecord(db, entryId) {
  const custodyProjection = hasKnowledgeCurrentCustody(db)
    ? `LEFT JOIN knowledge_current_custody custody
         ON custody.knowledge_entry_id=entry.id`
    : '';
  return db.prepare(`
    SELECT
      entry.id,entry.created_by,entry.entry_type,
      ${hasKnowledgeCurrentCustody(db) ? 'custody.org_id,custody.campaign_id,' : 'NULL AS org_id,NULL AS campaign_id,'}
      ${governanceProjection('governance')}
    FROM knowledge_entries entry
    JOIN knowledge_entry_governance governance
      ON governance.knowledge_entry_id=entry.id
    ${custodyProjection}
    WHERE entry.id=?
  `).get(entryId) || null;
}

function sameGovernanceScope(left, right) {
  if (left.campaign_id !== null || right.campaign_id !== null) {
    return (
      left.campaign_id !== null &&
      left.campaign_id === right.campaign_id &&
      left.org_id === right.org_id
    );
  }
  return left.created_by === right.created_by;
}

function auditKnowledgeGovernance(db, input, before, after, replacement) {
  const details = JSON.stringify({
    schema_version: 1,
    entry_id: input.entryId,
    action: input.action,
    reason: input.reason,
    before: {
      quality_state: governanceValue(before, 'quality_state'),
      retention_class: governanceValue(before, 'retention_class'),
      retain_until: governanceValue(before, 'retain_until'),
      is_current: governanceValue(before, 'is_current'),
      governance_version: governanceValue(before, 'governance_version')
    },
    after: {
      quality_state: governanceValue(after, 'quality_state'),
      retention_class: governanceValue(after, 'retention_class'),
      retain_until: governanceValue(after, 'retain_until'),
      is_current: governanceValue(after, 'is_current'),
      governance_version: governanceValue(after, 'governance_version')
    },
    replacement_entry_id: replacement ? replacement.id : null
  });
  const inserted = db.prepare(`
    INSERT INTO activity_log (user_id,action,module,details,ip_address)
    VALUES (?,'knowledge_governance_updated','knowledge_governance',?,?)
  `).run(input.user.id, details, input.ipAddress || null);
  if (inserted.changes !== 1) throw new Error('knowledge governance audit insert failed');
}

function governKnowledgeEntry(db, options) {
  const input = options || {};
  if (!input.user || input.user.role !== 'admin') {
    knowledgeGovernanceError(403, 'KNOWLEDGE_GOVERNANCE_FORBIDDEN', 'Knowledge governance requires an administrator.');
  }
  if (!hasKnowledgeGovernance(db)) {
    throw new Error('knowledge governance schema is unavailable');
  }
  const entryId = governanceId(input.entryId, 'knowledge entry id');
  const expectedVersion = governanceId(input.expectedVersion, 'governance version');
  const action = String(input.action || '');
  if (!['confirm', 'reject', 'supersede', 'set_retention'].includes(action)) {
    knowledgeGovernanceError(400, 'INVALID_KNOWLEDGE_GOVERNANCE_INPUT', 'Knowledge governance action is invalid.');
  }
  const reason = governanceReason(input.reason);
  const tx = db.transaction(function() {
    const current = governanceRecord(db, entryId);
    if (!current) {
      knowledgeGovernanceError(404, 'KNOWLEDGE_GOVERNANCE_NOT_FOUND', 'Knowledge entry was not found.');
    }
    if (governanceValue(current, 'governance_version') !== expectedVersion) {
      knowledgeGovernanceError(409, 'KNOWLEDGE_GOVERNANCE_STALE', 'Knowledge governance version is stale.');
    }
    if (governanceValue(current, 'is_current') !== 1) {
      knowledgeGovernanceError(
        409,
        'KNOWLEDGE_GOVERNANCE_TRANSITION_INVALID',
        'Historical knowledge governance is immutable.'
      );
    }
    let replacement = null;
    if (action === 'confirm' || action === 'reject') {
      const priorQuality = governanceValue(current, 'quality_state');
      const nextQuality = action === 'confirm' ? 'confirmed' : 'rejected';
      const allowed = (
        (priorQuality === 'candidate' && ['confirmed', 'rejected'].includes(nextQuality)) ||
        (priorQuality === 'confirmed' && nextQuality === 'rejected')
      );
      if (!allowed) {
        knowledgeGovernanceError(
          409,
          'KNOWLEDGE_GOVERNANCE_TRANSITION_INVALID',
          'Knowledge quality transition is not allowed.'
        );
      }
      const update = db.prepare(`
        UPDATE knowledge_entry_governance
        SET quality_state=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,
            review_reason=?,governance_version=governance_version+1,
            updated_at=CURRENT_TIMESTAMP
        WHERE knowledge_entry_id=? AND governance_version=?
      `).run(nextQuality, input.user.id, reason, entryId, expectedVersion);
      if (update.changes !== 1) {
        knowledgeGovernanceError(409, 'KNOWLEDGE_GOVERNANCE_STALE', 'Knowledge governance version is stale.');
      }
    } else if (action === 'set_retention') {
      const retentionClass = String(input.retentionClass || '');
      if (!['protected', 'scheduled'].includes(retentionClass)) {
        knowledgeGovernanceError(400, 'INVALID_KNOWLEDGE_GOVERNANCE_INPUT', 'Retention class is invalid.');
      }
      const retainUntil = retentionClass === 'protected'
        ? null
        : governanceTimestamp(input.retainUntil);
      const update = db.prepare(`
        UPDATE knowledge_entry_governance
        SET retention_class=?,retain_until=?,
            governance_version=governance_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE knowledge_entry_id=? AND governance_version=?
      `).run(retentionClass, retainUntil, entryId, expectedVersion);
      if (update.changes !== 1) {
        knowledgeGovernanceError(409, 'KNOWLEDGE_GOVERNANCE_STALE', 'Knowledge governance version is stale.');
      }
    } else {
      const replacementEntryId = governanceId(input.replacementEntryId, 'replacement knowledge entry id');
      if (replacementEntryId === entryId) {
        knowledgeGovernanceError(409, 'KNOWLEDGE_GOVERNANCE_TRANSITION_INVALID', 'A knowledge entry cannot replace itself.');
      }
      replacement = governanceRecord(db, replacementEntryId);
      if (!replacement) {
        knowledgeGovernanceError(404, 'KNOWLEDGE_GOVERNANCE_NOT_FOUND', 'Replacement knowledge entry was not found.');
      }
      if (
        governanceValue(current, 'is_current') !== 1 ||
        governanceValue(replacement, 'is_current') !== 1 ||
        governanceValue(replacement, 'quality_state') !== 'confirmed' ||
        governanceValue(replacement, 'version_no') !== 1 ||
        governanceValue(replacement, 'lineage_root_entry_id') !== replacementEntryId ||
        governanceValue(replacement, 'supersedes_entry_id') !== null ||
        current.entry_type !== replacement.entry_type ||
        !sameGovernanceScope(current, replacement)
      ) {
        knowledgeGovernanceError(
          409,
          'KNOWLEDGE_GOVERNANCE_TRANSITION_INVALID',
          'Replacement knowledge must be a confirmed current root in the same scope and type.'
        );
      }
      const nextVersion = governanceValue(current, 'version_no') + 1;
      if (!Number.isSafeInteger(nextVersion)) {
        knowledgeGovernanceError(409, 'KNOWLEDGE_GOVERNANCE_TRANSITION_INVALID', 'Knowledge lineage version is exhausted.');
      }
      const oldUpdate = db.prepare(`
        UPDATE knowledge_entry_governance
        SET is_current=0,governance_version=governance_version+1,
            updated_at=CURRENT_TIMESTAMP
        WHERE knowledge_entry_id=? AND governance_version=? AND is_current=1
      `).run(entryId, expectedVersion);
      if (oldUpdate.changes !== 1) {
        knowledgeGovernanceError(409, 'KNOWLEDGE_GOVERNANCE_STALE', 'Knowledge governance version is stale.');
      }
      const replacementUpdate = db.prepare(`
        UPDATE knowledge_entry_governance
        SET lineage_root_entry_id=?,supersedes_entry_id=?,version_no=?,
            governance_version=governance_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE knowledge_entry_id=? AND governance_version=? AND is_current=1
      `).run(
        governanceValue(current, 'lineage_root_entry_id'),
        entryId,
        nextVersion,
        replacementEntryId,
        governanceValue(replacement, 'governance_version')
      );
      if (replacementUpdate.changes !== 1) {
        knowledgeGovernanceError(409, 'KNOWLEDGE_GOVERNANCE_STALE', 'Replacement governance version is stale.');
      }
    }
    const after = governanceRecord(db, entryId);
    const replacementAfter = replacement
      ? governanceRecord(db, replacement.id)
      : null;
    auditKnowledgeGovernance(
      db,
      { ...input, entryId, action, reason },
      current,
      after,
      replacementAfter
    );
    return {
      entry: normalizeEntry(db.prepare('SELECT * FROM knowledge_entries WHERE id=?').get(entryId)),
      governance: normalizeGovernance(after),
      replacement_governance: normalizeGovernance(replacementAfter)
    };
  });
  return tx.immediate();
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

function canonicalCampaignId(value, label) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (
      Number.isSafeInteger(parsed) &&
      parsed > 0 &&
      parsed <= MAX_SAFE_ID &&
      String(parsed) === value
    ) {
      return parsed;
    }
  }
  throw new TypeError(`${label} must be a positive canonical JavaScript-safe integer`);
}

function requiredCampaignText(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  return canonicalKnowledgeText(value, label);
}

function canonicalCampaignSourceId(value) {
  let text;
  if (Number.isSafeInteger(value) && value > 0) {
    text = String(value);
  } else if (typeof value === 'string') {
    text = canonicalKnowledgeText(value, 'campaign knowledge sourceId');
  } else {
    throw new TypeError('campaign knowledge sourceId must be text or a positive safe integer');
  }
  if (text.length === 0) {
    throw new TypeError('campaign knowledge sourceId must not be empty');
  }
  if (Buffer.byteLength(text, 'utf8') > 4096) {
    throw new TypeError('campaign knowledge sourceId exceeds 4096 UTF-8 bytes');
  }
  if (text.includes('\u0000')) {
    throw new TypeError('campaign knowledge sourceId cannot contain NUL');
  }
  const sqliteNumericLiteral =
    /^[\u0009-\u000d\u0020]*[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?[\u0009-\u000d\u0020]*$/;
  if (sqliteNumericLiteral.test(text)) {
    const numeric = Number(text);
    if (
      !/^[1-9][0-9]{0,15}$/.test(text) ||
      !Number.isSafeInteger(numeric) ||
      numeric < 1 ||
      String(numeric) !== text
    ) {
      throw new TypeError('numeric campaign knowledge sourceId must be a positive canonical safe integer');
    }
  }
  return text;
}

function canonicalJsonNode(value, label, seen) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return canonicalKnowledgeText(value, label);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} contains an unsupported JSON value`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${label} contains a circular value`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(function(item, index) {
        return canonicalJsonNode(item, `${label}[${index}]`, seen);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain plain JSON objects`);
    }
    const normalizedKeys = Object.keys(value).map(function(key) {
      return {
        original: key,
        canonical: canonicalKnowledgeText(key, `${label} key`)
      };
    }).sort(function(left, right) {
      return compareUtf8(left.canonical, right.canonical);
    });
    const output = Object.create(null);
    let previous = null;
    normalizedKeys.forEach(function(key) {
      if (key.canonical === previous) {
        throw new TypeError(`${label} contains duplicate canonical keys`);
      }
      previous = key.canonical;
      output[key.canonical] = canonicalJsonNode(
        value[key.original],
        `${label}.${key.canonical}`,
        seen
      );
    });
    return output;
  } finally {
    seen.delete(value);
  }
}

function canonicalStoredJson(value, fallback, label, requireObject) {
  let input = value === undefined ? fallback : value;
  if (typeof input === 'string') {
    const canonicalInput = canonicalKnowledgeText(input, label);
    try {
      input = JSON.parse(canonicalInput);
    } catch (_error) {
      throw new TypeError(`${label} must be valid JSON`);
    }
  }
  const normalized = canonicalJsonNode(input, label, new Set());
  if (
    requireObject &&
    (
      normalized === null ||
      typeof normalized !== 'object' ||
      Array.isArray(normalized)
    )
  ) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return JSON.stringify(normalized);
}

function campaignSourceIdentityDigest(entry, organizationId, campaignId) {
  return framedDigest([
    'tm-knowledge-source-v1',
    String(organizationId),
    String(campaignId),
    entry.source_type,
    entry.source_id,
    entry.entry_type,
    entry.visibility === 'private' ? String(entry.created_by) : ''
  ].map(function(value, index) {
    return Buffer.from(
      assertScalarText(value, `campaign knowledge source frame ${index}`),
      'utf8'
    );
  }));
}

function prepareCampaignKnowledge(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('campaign knowledge options must be an object');
  }
  const organizationId = canonicalCampaignId(
    options.organizationId,
    'organizationId'
  );
  const campaignId = canonicalCampaignId(options.campaignId, 'campaignId');
  const createdBy = canonicalCampaignId(options.createdBy, 'createdBy');
  if (
    Object.prototype.hasOwnProperty.call(options, 'is_public') ||
    Object.prototype.hasOwnProperty.call(options, 'isPublic')
  ) {
    throw new CampaignKnowledgeInputError(
      'campaign knowledge is_public is not accepted'
    );
  }
  const visibility = Object.prototype.hasOwnProperty.call(options, 'visibility')
    ? options.visibility
    : 'private';
  if (visibility !== 'private' && visibility !== 'team') {
    throw new CampaignKnowledgeInputError(
      'campaign knowledge visibility must be private or team'
    );
  }
  if (!Array.isArray(options.tags)) {
    throw new TypeError('campaign knowledge tags must be an array');
  }
  const tags = canonicalKnowledgeTags(options.tags.map(function(tag) {
    if (typeof tag !== 'string') {
      throw new TypeError('campaign knowledge tags must contain only strings');
    }
    return tag;
  }));
  const metadataValue = Object.prototype.hasOwnProperty.call(options, 'metadata')
    ? options.metadata
    : options.metadataJson;
  const embeddingValue = Object.prototype.hasOwnProperty.call(options, 'embedding')
    ? options.embedding
    : options.embeddingJson;
  const entry = {
    entry_type: requiredCampaignText(
      options.entryType,
      'campaign knowledge entryType'
    ),
    title: requiredCampaignText(options.title, 'campaign knowledge title'),
    summary: requiredCampaignText(options.summary, 'campaign knowledge summary'),
    content: requiredCampaignText(options.content, 'campaign knowledge content'),
    tags,
    source_type: requiredCampaignText(
      options.sourceType,
      'campaign knowledge sourceType'
    ),
    source_id: canonicalCampaignSourceId(options.sourceId),
    source_hash: null,
    business_type: 'campaign',
    business_id: String(campaignId),
    metadata_json: canonicalStoredJson(
      metadataValue,
      {},
      'campaign knowledge metadata',
      true
    ),
    embedding_json: embeddingValue === undefined || embeddingValue === null
      ? null
      : canonicalStoredJson(
        embeddingValue,
        null,
        'campaign knowledge embedding',
        false
      ),
    created_by: createdBy,
    is_public: visibility === 'team' ? 1 : 0,
    visibility
  };
  if (!entry.entry_type || !entry.source_type) {
    throw new TypeError('campaign knowledge entryType and sourceType must not be empty');
  }
  entry.source_identity_sha256 = campaignSourceIdentityDigest(
    entry,
    organizationId,
    campaignId
  );
  entry.content_sha256 = knowledgeContentDigest(entry);
  entry.key_terms = JSON.stringify(tags);
  entry.tags_json = entry.key_terms;
  return {
    organizationId,
    campaignId,
    entry,
    chunks: preparedChunks(entry)
  };
}

function knowledgeEntryPayloadBytes(entry) {
  return [
    entry.title,
    entry.summary,
    entry.content,
    entry.key_terms,
    entry.tags_json,
    entry.metadata_json,
    entry.embedding_json
  ].reduce(function(total, value) {
    return total + Buffer.byteLength(value === null ? '' : String(value), 'utf8');
  }, 0);
}

function knowledgeChunkPayloadBytes(chunks) {
  return chunks.reduce(function(total, chunk) {
    return total +
      Buffer.byteLength(chunk.content, 'utf8') +
      Buffer.byteLength(chunk.metadataJson, 'utf8');
  }, 0);
}

function entryPayloadSql(alias) {
  return [
    'title',
    'summary',
    'content',
    'key_terms',
    'tags_json',
    'metadata_json',
    'embedding_json'
  ].map(function(column) {
    return `length(CAST(COALESCE(${alias}.${column},'') AS BLOB))`;
  }).join(' + ');
}

function chunkPayloadSql(alias) {
  return ['content', 'metadata_json', 'embedding_json'].map(function(column) {
    return `length(CAST(COALESCE(${alias}.${column},'') AS BLOB))`;
  }).join(' + ');
}

function normalizedCapacityUsage(row, label) {
  const normalized = {};
  CAPACITY_METRICS.forEach(function(metric) {
    const value = row && row[metric];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} knowledge capacity usage is invalid`);
    }
    normalized[metric] = value;
  });
  return normalized;
}

function userKnowledgeUsage(db, userId) {
  return normalizedCapacityUsage(db.prepare(`
    SELECT
      (
        SELECT COUNT(*)
        FROM knowledge_entries entry
        WHERE entry.created_by=@scopeId
      ) AS entries,
      (
        SELECT COUNT(*)
        FROM knowledge_chunks chunk
        JOIN knowledge_entries entry ON entry.id=chunk.entry_id
        WHERE entry.created_by=@scopeId
      ) AS chunks,
      (
        COALESCE((
          SELECT SUM(${entryPayloadSql('entry')})
          FROM knowledge_entries entry
          WHERE entry.created_by=@scopeId
        ),0)
        +
        COALESCE((
          SELECT SUM(${chunkPayloadSql('chunk')})
          FROM knowledge_chunks chunk
          JOIN knowledge_entries entry ON entry.id=chunk.entry_id
          WHERE entry.created_by=@scopeId
        ),0)
      ) AS payloadBytes,
      (
        SELECT COUNT(*)
        FROM ai_references reference
        JOIN ai_messages message ON message.id=reference.message_id
        JOIN ai_conversations conversation ON conversation.id=message.conversation_id
        WHERE conversation.user_id=@scopeId
      ) AS "references"
  `).get({ scopeId: userId }), 'user');
}

function campaignKnowledgeUsage(db, campaignId) {
  return normalizedCapacityUsage(db.prepare(`
    WITH
    ${KNOWLEDGE_CUSTODY_CTE},
    capacity_entries AS (
      SELECT entry.*
      FROM knowledge_entries entry
      JOIN knowledge_custody custody ON custody.entry_id=entry.id
      WHERE custody.campaign_id=@scopeId
    )
    SELECT
      (SELECT COUNT(*) FROM capacity_entries) AS entries,
      (
        SELECT COUNT(*)
        FROM knowledge_chunks chunk
        JOIN capacity_entries entry ON entry.id=chunk.entry_id
      ) AS chunks,
      (
        COALESCE((
          SELECT SUM(${entryPayloadSql('entry')})
          FROM capacity_entries entry
        ),0)
        +
        COALESCE((
          SELECT SUM(${chunkPayloadSql('chunk')})
          FROM knowledge_chunks chunk
          JOIN capacity_entries entry ON entry.id=chunk.entry_id
        ),0)
      ) AS payloadBytes,
      (
        SELECT COUNT(*)
        FROM ai_references reference
        WHERE reference.campaign_id=@scopeId
      ) AS "references"
  `).get({ scopeId: campaignId }), 'campaign');
}

function organizationKnowledgeUsage(db, organizationId, defaultOrganizationId) {
  return normalizedCapacityUsage(db.prepare(`
    WITH
    ${KNOWLEDGE_CUSTODY_CTE},
    scope_members AS MATERIALIZED (
      SELECT membership.user_id
      FROM organization_memberships membership
      WHERE membership.org_id=@scopeId
    ),
    capacity_entries AS MATERIALIZED (
      SELECT entry.*
      FROM knowledge_entries entry
      LEFT JOIN knowledge_custody custody ON custody.entry_id=entry.id
      LEFT JOIN scope_members creator_membership
        ON creator_membership.user_id=entry.created_by
      WHERE custody.org_id=@scopeId
        OR (
          custody.entry_id IS NULL
          AND (
            (
              entry.created_by IS NOT NULL
              AND creator_membership.user_id IS NOT NULL
            )
            OR (
              entry.created_by IS NULL
              AND @scopeId=@defaultOrganizationId
            )
          )
        )
    ),
    capacity_references AS (
      SELECT reference.id
      FROM ai_references reference
      JOIN ai_messages message ON message.id=reference.message_id
      JOIN ai_conversations conversation ON conversation.id=message.conversation_id
      LEFT JOIN campaigns campaign ON campaign.id=reference.campaign_id
      LEFT JOIN scope_members conversation_membership
        ON conversation_membership.user_id=conversation.user_id
      WHERE (
        reference.campaign_id IS NOT NULL
        AND campaign.org_id=@scopeId
      ) OR (
        reference.campaign_id IS NULL
        AND conversation_membership.user_id IS NOT NULL
      )
    )
    SELECT
      (SELECT COUNT(*) FROM capacity_entries) AS entries,
      (
        SELECT COUNT(*)
        FROM knowledge_chunks chunk
        JOIN capacity_entries entry ON entry.id=chunk.entry_id
      ) AS chunks,
      (
        COALESCE((
          SELECT SUM(${entryPayloadSql('entry')})
          FROM capacity_entries entry
        ),0)
        +
        COALESCE((
          SELECT SUM(${chunkPayloadSql('chunk')})
          FROM knowledge_chunks chunk
          JOIN capacity_entries entry ON entry.id=chunk.entry_id
        ),0)
      ) AS payloadBytes,
      (
        SELECT COUNT(*) FROM capacity_references
      ) AS "references"
  `).get({
    scopeId: organizationId,
    defaultOrganizationId
  }), 'organization');
}

function campaignOrganizationKnowledgeUsage(
  db,
  campaignIds,
  organizationIds,
  defaultOrganizationId
) {
  const requested = [];
  const seen = new Set();
  for (const [scopeType, ids] of [
    ['campaign', campaignIds],
    ['organization', organizationIds]
  ]) {
    if (!Array.isArray(ids)) throw new TypeError('knowledge capacity scope ids must be arrays');
    for (const scopeId of ids) {
      if (!Number.isSafeInteger(scopeId) || scopeId < 1 || scopeId > MAX_SAFE_ID) {
        throw new TypeError('knowledge capacity scope id is invalid');
      }
      const key = `${scopeType}:${scopeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requested.push({ scopeType, scopeId });
    }
  }
  if (
    !Number.isSafeInteger(defaultOrganizationId) ||
    defaultOrganizationId < 1 ||
    defaultOrganizationId > MAX_SAFE_ID
  ) {
    throw new TypeError('default knowledge organization id is invalid');
  }
  if (requested.length === 0) return new Map();

  const valuesSql = requested.map(function() { return '(?,?)'; }).join(',');
  const params = requested.flatMap(function(scope) {
    return [scope.scopeType, scope.scopeId];
  });
  params.push(defaultOrganizationId);
  const rows = db.prepare(`
    WITH
    requested_scopes(scope_type,scope_id) AS (VALUES ${valuesSql}),
    requested_campaigns AS MATERIALIZED (
      SELECT
        request.scope_type,
        request.scope_id,
        request.scope_id AS campaign_id
      FROM requested_scopes request
      WHERE request.scope_type='campaign'

      UNION ALL

      SELECT
        request.scope_type,
        request.scope_id,
        campaign.id AS campaign_id
      FROM requested_scopes request
      JOIN campaigns campaign ON campaign.org_id=request.scope_id
      WHERE request.scope_type='organization'
    ),
    active_scope_custody AS MATERIALIZED (
      SELECT
        requested.scope_type,
        requested.scope_id,
        CAST(active_link.record_id AS INTEGER) AS entry_id
      FROM requested_campaigns requested
      JOIN campaign_record_links active_link
        ON active_link.campaign_id=requested.campaign_id
      WHERE active_link.record_type='knowledge_entry'
        AND active_link.relation_type<>'shortlist'
        AND active_link.revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM campaign_record_links newer_active_link
          WHERE newer_active_link.record_type='knowledge_entry'
            AND newer_active_link.relation_type<>'shortlist'
            AND newer_active_link.record_id=active_link.record_id
            AND newer_active_link.revoked_at IS NULL
            AND newer_active_link.id>active_link.id
        )
    ),
    historical_scope_custody AS MATERIALIZED (
      SELECT
        requested.scope_type,
        requested.scope_id,
        CAST(historical_link.record_id AS INTEGER) AS entry_id
      FROM requested_campaigns requested
      JOIN campaign_record_links historical_link
        ON historical_link.campaign_id=requested.campaign_id
      WHERE historical_link.record_type='knowledge_entry'
        AND historical_link.relation_type<>'shortlist'
        AND historical_link.revoked_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM campaign_record_links current_link
          WHERE current_link.record_type='knowledge_entry'
            AND current_link.relation_type<>'shortlist'
            AND current_link.record_id=historical_link.record_id
            AND current_link.revoked_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM campaign_record_links newer_link
          WHERE newer_link.record_type='knowledge_entry'
            AND newer_link.relation_type<>'shortlist'
            AND newer_link.record_id=historical_link.record_id
            AND newer_link.revoked_at IS NOT NULL
            AND (
              newer_link.revoked_at>historical_link.revoked_at
              OR (
                newer_link.revoked_at=historical_link.revoked_at
                AND newer_link.id>historical_link.id
              )
            )
        )
    ),
    knowledge_custody AS MATERIALIZED (
      SELECT scope_type,scope_id,entry_id FROM active_scope_custody
      UNION ALL
      SELECT scope_type,scope_id,entry_id FROM historical_scope_custody
    ),
    scope_members AS MATERIALIZED (
      SELECT request.scope_id AS org_id,membership.user_id
      FROM requested_scopes request
      JOIN organization_memberships membership
        ON membership.org_id=request.scope_id
      WHERE request.scope_type='organization'
    ),
    capacity_entries AS MATERIALIZED (
      SELECT custody.scope_type,custody.scope_id,entry.*
      FROM knowledge_custody custody
      CROSS JOIN knowledge_entries entry
      WHERE entry.id=custody.entry_id

      UNION ALL

      SELECT 'organization',member.org_id,member_entry.*
      FROM scope_members member
      CROSS JOIN knowledge_entries member_entry
      WHERE member_entry.created_by=member.user_id
        AND NOT EXISTS (
        SELECT 1
        FROM campaign_record_links entry_link
        WHERE entry_link.record_type='knowledge_entry'
          AND entry_link.relation_type<>'shortlist'
          AND entry_link.record_id=CAST(member_entry.id AS TEXT)
      )

      UNION ALL

      SELECT 'organization',request.scope_id,default_entry.*
      FROM requested_scopes request
      JOIN knowledge_entries default_entry ON default_entry.created_by IS NULL
      WHERE request.scope_type='organization'
        AND request.scope_id=?
        AND NOT EXISTS (
          SELECT 1
          FROM campaign_record_links entry_link
          WHERE entry_link.record_type='knowledge_entry'
            AND entry_link.relation_type<>'shortlist'
            AND entry_link.record_id=CAST(default_entry.id AS TEXT)
        )
    ),
    capacity_references AS MATERIALIZED (
      SELECT
        'campaign' AS scope_type,
        request.scope_id AS scope_id,
        campaign_reference.id
      FROM requested_scopes request
      JOIN ai_references campaign_reference
        ON campaign_reference.campaign_id=request.scope_id
      WHERE request.scope_type='campaign'

      UNION ALL

      SELECT 'organization',request.scope_id,organization_reference.id
      FROM requested_scopes request
      CROSS JOIN campaigns organization_campaign
      CROSS JOIN ai_references organization_reference
      WHERE request.scope_type='organization'
        AND organization_campaign.org_id=request.scope_id
        AND organization_reference.campaign_id=organization_campaign.id

      UNION ALL

      SELECT 'organization',member.org_id,member_reference.id
      FROM scope_members member
      CROSS JOIN ai_conversations conversation
      CROSS JOIN ai_messages message
      CROSS JOIN ai_references member_reference
      WHERE conversation.user_id=member.user_id
        AND message.conversation_id=conversation.id
        AND member_reference.message_id=message.id
        AND member_reference.campaign_id IS NULL
    ),
    entry_usage AS MATERIALIZED (
      SELECT
        entry.scope_type,
        entry.scope_id,
        COUNT(*) AS entries,
        COALESCE(SUM(${entryPayloadSql('entry')}),0) AS entry_payload_bytes
      FROM capacity_entries entry
      GROUP BY entry.scope_type,entry.scope_id
    ),
    chunk_usage AS MATERIALIZED (
      SELECT
        entry.scope_type,
        entry.scope_id,
        COUNT(*) AS chunks,
        COALESCE(SUM(${chunkPayloadSql('chunk')}),0) AS chunk_payload_bytes
      FROM capacity_entries entry
      JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
      GROUP BY entry.scope_type,entry.scope_id
    ),
    reference_usage AS MATERIALIZED (
      SELECT
        reference.scope_type,
        reference.scope_id,
        COUNT(*) AS "references"
      FROM capacity_references reference
      GROUP BY reference.scope_type,reference.scope_id
    )
    SELECT
      request.scope_type,
      request.scope_id,
      COALESCE(entry_usage.entries,0) AS entries,
      COALESCE(chunk_usage.chunks,0) AS chunks,
      COALESCE(entry_usage.entry_payload_bytes,0) +
        COALESCE(chunk_usage.chunk_payload_bytes,0) AS payloadBytes,
      COALESCE(reference_usage."references",0) AS "references"
    FROM requested_scopes request
    LEFT JOIN entry_usage
      ON entry_usage.scope_type=request.scope_type
     AND entry_usage.scope_id=request.scope_id
    LEFT JOIN chunk_usage
      ON chunk_usage.scope_type=request.scope_type
     AND chunk_usage.scope_id=request.scope_id
    LEFT JOIN reference_usage
      ON reference_usage.scope_type=request.scope_type
     AND reference_usage.scope_id=request.scope_id
  `).all(...params);
  const usage = new Map();
  rows.forEach(function(row) {
    usage.set(
      `${row.scope_type}:${row.scope_id}`,
      normalizedCapacityUsage(row, row.scope_type)
    );
  });
  if (usage.size !== requested.length) {
    throw new Error('knowledge capacity scope usage is incomplete');
  }
  return usage;
}

function capacityMetricLabel(metric) {
  return metric === 'payloadBytes' ? 'payload_bytes' : metric;
}

function capacityThresholdPercent(usageValue, limitValue) {
  if (!Number.isSafeInteger(usageValue) || usageValue < 0) {
    throw new TypeError('capacity usage must be a nonnegative JavaScript-safe integer');
  }
  if (!Number.isSafeInteger(limitValue) || limitValue < 1) {
    throw new TypeError('capacity limit must be a positive JavaScript-safe integer');
  }
  const usage = BigInt(usageValue);
  const limit = BigInt(limitValue);
  if (usage >= limit) return 100;
  if (usage * 10n >= limit * 9n) return 90;
  if (usage * 5n >= limit * 4n) return 80;
  return 0;
}

function defaultKnowledgeOrganizationId(db) {
  const organizations = db.prepare(`
    SELECT id
    FROM organizations
    WHERE code='turingmarket-default'
  `).all();
  if (organizations.length !== 1) {
    throw new Error('default organization resolution failed during knowledge capacity reconciliation');
  }
  return organizations[0].id;
}

function allKnowledgeCapacityScopes(db) {
  return [
    ...db.prepare('SELECT id FROM users ORDER BY id').all().map(function(row) {
      return { scopeType: 'user', scopeId: row.id };
    }),
    ...db.prepare('SELECT id FROM campaigns ORDER BY id').all().map(function(row) {
      return { scopeType: 'campaign', scopeId: row.id };
    }),
    ...db.prepare('SELECT id FROM organizations ORDER BY id').all().map(function(row) {
      return { scopeType: 'organization', scopeId: row.id };
    })
  ];
}

function knowledgeCapacityUsage(db, scopeType, scopeId, defaultOrganizationId) {
  if (scopeType === 'user') return userKnowledgeUsage(db, scopeId);
  if (scopeType === 'campaign') return campaignKnowledgeUsage(db, scopeId);
  if (scopeType === 'organization') {
    return organizationKnowledgeUsage(db, scopeId, defaultOrganizationId);
  }
  throw new TypeError('knowledge capacity scope type is invalid');
}

function normalizeKnowledgeCapacityScopes(scopes) {
  if (!Array.isArray(scopes)) {
    throw new TypeError('knowledge capacity scopes must be an array');
  }
  const unique = new Map();
  for (const scope of scopes) {
    const scopeType = scope && scope.scopeType;
    const scopeId = scope && scope.scopeId;
    if (!Object.prototype.hasOwnProperty.call(CAMPAIGN_KNOWLEDGE_CAPACITY, scopeType)) {
      throw new TypeError('knowledge capacity scope type is invalid');
    }
    if (!Number.isSafeInteger(scopeId) || scopeId < 1) {
      throw new TypeError('knowledge capacity scope id must be a positive safe integer');
    }
    unique.set(`${scopeType}:${scopeId}`, { scopeType, scopeId });
  }
  return [...unique.values()];
}

function knowledgeCapacityScopeExists(db, scopeType, scopeId) {
  const table = {
    user: 'users',
    campaign: 'campaigns',
    organization: 'organizations'
  }[scopeType];
  return Boolean(db.prepare(`SELECT 1 AS present FROM ${table} WHERE id=?`).get(scopeId));
}

function knowledgeCapacityGaugeTableExists(db) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type='table' AND name='knowledge_capacity_gauges'
  `).get());
}

function knowledgeCapacityAuthorityExists(db) {
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type='table' AND name IN (
      'knowledge_current_custody',
      'knowledge_entry_footprints',
      'knowledge_unlinked_user_usage'
    )
  `).all();
  return rows.length === 3;
}

function authoritativeKnowledgeCapacityUsage(db, scopes) {
  const normalizedScopes = normalizeKnowledgeCapacityScopes(scopes);
  if (normalizedScopes.length === 0) return new Map();
  if (!knowledgeCapacityAuthorityExists(db)) {
    throw new Error('knowledge capacity authority is unavailable');
  }
  const predicate = normalizedScopes.map(function() {
    return '(scope_type=? AND scope_id=?)';
  }).join(' OR ');
  const params = normalizedScopes.flatMap(function(scope) {
    return [scope.scopeType, scope.scopeId];
  });
  const rows = db.prepare(`
    SELECT scope_type,scope_id,metric,usage_value,limit_value
    FROM knowledge_capacity_gauges
    WHERE ${predicate}
    ORDER BY scope_type,scope_id,metric
  `).all(...params);
  const usage = new Map(normalizedScopes.map(function(scope) {
    return [`${scope.scopeType}:${scope.scopeId}`, {
      entries: null,
      chunks: null,
      payloadBytes: null,
      references: null
    }];
  }));
  for (const row of rows) {
    const key = `${row.scope_type}:${row.scope_id}`;
    const target = usage.get(key);
    const field = row.metric === 'payload_bytes' ? 'payloadBytes' : row.metric;
    const limits = CAMPAIGN_KNOWLEDGE_CAPACITY[row.scope_type];
    if (
      !target ||
      !Object.prototype.hasOwnProperty.call(target, field) ||
      row.limit_value !== limits[field] ||
      target[field] !== null
    ) {
      throw new Error('knowledge capacity authority is malformed');
    }
    if (!Number.isSafeInteger(row.usage_value) || row.usage_value < 0) {
      throw new Error('knowledge capacity authority usage is invalid');
    }
    target[field] = row.usage_value;
  }
  for (const target of usage.values()) {
    if (CAPACITY_METRICS.some(function(metric) { return target[metric] === null; })) {
      throw new Error('knowledge capacity authority is incomplete');
    }
  }
  return usage;
}

function normalizeKnowledgeCapacityGaugePlan(plan) {
  if (!Array.isArray(plan)) {
    throw new TypeError('knowledge capacity gauge plan must be an array');
  }
  const unique = new Map();
  for (const item of plan) {
    const scopeType = item && item.scopeType;
    const scopeId = item && item.scopeId;
    if (!Object.prototype.hasOwnProperty.call(CAMPAIGN_KNOWLEDGE_CAPACITY, scopeType)) {
      throw new TypeError('knowledge capacity gauge scope type is invalid');
    }
    if (!Number.isSafeInteger(scopeId) || scopeId < 1) {
      throw new TypeError('knowledge capacity gauge scope id is invalid');
    }
    const usage = normalizedCapacityUsage(
      item.usage,
      `${scopeType} gauge plan`
    );
    const key = `${scopeType}:${scopeId}`;
    const existing = unique.get(key);
    if (existing && JSON.stringify(existing.usage) !== JSON.stringify(usage)) {
      throw new Error('knowledge capacity gauge plan is inconsistent');
    }
    unique.set(key, { scopeType, scopeId, usage });
  }
  return [...unique.values()];
}

function writeKnowledgeCapacityGaugePlanInTransaction(db, normalizedPlan) {
  const upsert = db.prepare(`
    INSERT INTO knowledge_capacity_gauges (
      scope_type,scope_id,metric,usage_value,limit_value,threshold_percent,updated_at
    ) VALUES (@scopeType,@scopeId,@metric,@usageValue,@limitValue,@thresholdPercent,CURRENT_TIMESTAMP)
    ON CONFLICT(scope_type,scope_id,metric) DO UPDATE SET
      usage_value=excluded.usage_value,
      limit_value=excluded.limit_value,
      threshold_percent=excluded.threshold_percent,
      updated_at=excluded.updated_at
  `);
  for (const scope of normalizedPlan) {
    if (!knowledgeCapacityScopeExists(db, scope.scopeType, scope.scopeId)) {
      throw new TypeError('knowledge capacity scope does not exist');
    }
    const limits = CAMPAIGN_KNOWLEDGE_CAPACITY[scope.scopeType];
    for (const metric of CAPACITY_METRICS) {
      const usageValue = scope.usage[metric];
      const limitValue = limits[metric];
      upsert.run({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        metric: capacityMetricLabel(metric),
        usageValue,
        limitValue,
        thresholdPercent: capacityThresholdPercent(usageValue, limitValue)
      });
    }
  }
  return normalizedPlan.length * CAPACITY_METRICS.length;
}

function applyKnowledgeCapacityGaugePlanInTransaction(db, plan) {
  if (!db || db.inTransaction !== true) {
    throw new TypeError(
      'applyKnowledgeCapacityGaugePlanInTransaction requires an existing transaction'
    );
  }
  const normalizedPlan = normalizeKnowledgeCapacityGaugePlan(plan);
  if (normalizedPlan.length === 0 || !knowledgeCapacityGaugeTableExists(db)) {
    return 0;
  }
  if (!knowledgeCapacityAuthorityExists(db)) {
    return writeKnowledgeCapacityGaugePlanInTransaction(db, normalizedPlan);
  }
  const actual = authoritativeKnowledgeCapacityUsage(db, normalizedPlan);
  for (const scope of normalizedPlan) {
    const current = actual.get(`${scope.scopeType}:${scope.scopeId}`);
    if (JSON.stringify(current) !== JSON.stringify(scope.usage)) {
      throw new Error('knowledge capacity authority mutation mismatch');
    }
  }
  return normalizedPlan.length * CAPACITY_METRICS.length;
}

function refreshKnowledgeCapacityGaugesInTransaction(db, scopes) {
  if (!db || db.inTransaction !== true) {
    throw new TypeError(
      'refreshKnowledgeCapacityGaugesInTransaction requires an existing transaction'
    );
  }
  const normalizedScopes = normalizeKnowledgeCapacityScopes(scopes);
  if (normalizedScopes.length === 0 || !knowledgeCapacityGaugeTableExists(db)) return 0;
  const defaultOrganizationId = defaultKnowledgeOrganizationId(db);
  return writeKnowledgeCapacityGaugePlanInTransaction(
    db,
    normalizeKnowledgeCapacityGaugePlan(normalizedScopes.map(function(scope) {
      return {
        ...scope,
        usage: knowledgeCapacityUsage(
          db,
          scope.scopeType,
          scope.scopeId,
          defaultOrganizationId
        )
      };
    }))
  );
}

function reconcileKnowledgeCapacityGaugesInTransaction(db) {
  if (!db || db.inTransaction !== true) {
    throw new TypeError(
      'reconcileKnowledgeCapacityGaugesInTransaction requires an existing transaction'
    );
  }
  const scopes = allKnowledgeCapacityScopes(db);
  db.exec(`
    DELETE FROM knowledge_capacity_gauges
    WHERE (scope_type='user' AND NOT EXISTS (
      SELECT 1 FROM users WHERE users.id=knowledge_capacity_gauges.scope_id
    )) OR (scope_type='campaign' AND NOT EXISTS (
      SELECT 1 FROM campaigns WHERE campaigns.id=knowledge_capacity_gauges.scope_id
    )) OR (scope_type='organization' AND NOT EXISTS (
      SELECT 1 FROM organizations WHERE organizations.id=knowledge_capacity_gauges.scope_id
    ));
  `);
  return refreshKnowledgeCapacityGaugesInTransaction(db, scopes);
}

function capacityUsageAfterDelta(scope, usage, delta, direction) {
  if (direction !== 1 && direction !== -1) {
    throw new TypeError('knowledge capacity delta direction is invalid');
  }
  const limits = CAMPAIGN_KNOWLEDGE_CAPACITY[scope];
  const projectedUsage = {};
  CAPACITY_METRICS.forEach(function(metric) {
    const projected = usage[metric] + (direction * delta[metric]);
    if (!Number.isSafeInteger(projected) || projected < 0) {
      throw new Error('knowledge capacity projection is invalid');
    }
    if (projected > limits[metric]) {
      throw new CampaignKnowledgeCapacityError({
        scope,
        metric: capacityMetricLabel(metric),
        limit: limits[metric],
        projected
      });
    }
    projectedUsage[metric] = projected;
  });
  return projectedUsage;
}

function assertCapacity(scope, usage, delta) {
  return capacityUsageAfterDelta(scope, usage, delta, 1);
}

function preflightCampaignKnowledgeCapacity(db, prepared) {
  const campaign = db.prepare(`
    SELECT org_id
    FROM campaigns
    WHERE id=?
  `).get(prepared.campaignId);
  if (
    !campaign ||
    campaign.org_id !== prepared.organizationId
  ) {
    throw new TypeError('campaign knowledge organization and campaign do not match');
  }
  const creatorMembership = db.prepare(`
    SELECT 1 AS present
    FROM organization_memberships
    WHERE org_id=? AND user_id=?
    LIMIT 1
  `).get(prepared.organizationId, prepared.entry.created_by);
  if (!creatorMembership) {
    throw new TypeError('campaign knowledge creator has no organization membership');
  }
  const defaultOrganizations = db.prepare(`
    SELECT id
    FROM organizations
    WHERE code='turingmarket-default'
  `).all();
  if (defaultOrganizations.length !== 1) {
    throw new Error('default organization resolution failed during knowledge capacity preflight');
  }
  const delta = {
    entries: 1,
    chunks: prepared.chunks.length,
    payloadBytes: knowledgeEntryPayloadBytes(prepared.entry) +
      knowledgeChunkPayloadBytes(prepared.chunks),
    references: 0
  };
  let userUsage;
  let campaignUsage;
  let organizationUsage;
  if (knowledgeCapacityAuthorityExists(db)) {
    const authoritativeUsage = authoritativeKnowledgeCapacityUsage(db, [
      { scopeType: 'user', scopeId: prepared.entry.created_by },
      { scopeType: 'campaign', scopeId: prepared.campaignId },
      { scopeType: 'organization', scopeId: prepared.organizationId }
    ]);
    userUsage = authoritativeUsage.get(`user:${prepared.entry.created_by}`);
    campaignUsage = authoritativeUsage.get(`campaign:${prepared.campaignId}`);
    organizationUsage = authoritativeUsage.get(`organization:${prepared.organizationId}`);
  } else {
    userUsage = userKnowledgeUsage(db, prepared.entry.created_by);
    const combinedUsage = campaignOrganizationKnowledgeUsage(
      db,
      [prepared.campaignId],
      [prepared.organizationId],
      defaultOrganizations[0].id
    );
    campaignUsage = combinedUsage.get(`campaign:${prepared.campaignId}`);
    organizationUsage = combinedUsage.get(`organization:${prepared.organizationId}`);
  }
  return [
    {
      scopeType: 'user',
      scopeId: prepared.entry.created_by,
      usage: assertCapacity('user', userUsage, delta)
    },
    {
      scopeType: 'campaign',
      scopeId: prepared.campaignId,
      usage: assertCapacity('campaign', campaignUsage, delta)
    },
    {
      scopeType: 'organization',
      scopeId: prepared.organizationId,
      usage: assertCapacity('organization', organizationUsage, delta)
    }
  ];
}

function preflightCampaignKnowledgeCustodyMoveInTransaction(db, options) {
  if (!db || db.inTransaction !== true) {
    throw new TypeError(
      'preflightCampaignKnowledgeCustodyMoveInTransaction requires an existing transaction'
    );
  }
  const entryId = options && options.entryId;
  const destinationCampaignId = options && options.destinationCampaignId;
  const organizationId = options && options.organizationId;
  if (
    !Number.isSafeInteger(entryId) ||
    entryId < 1 ||
    entryId > MAX_SAFE_ID ||
    !Number.isSafeInteger(destinationCampaignId) ||
    destinationCampaignId < 1 ||
    destinationCampaignId > MAX_SAFE_ID ||
    !Number.isSafeInteger(organizationId) ||
    organizationId < 1 ||
    organizationId > MAX_SAFE_ID
  ) {
    throw new TypeError('campaign knowledge custody move input is invalid');
  }
  const destination = db.prepare(`
    SELECT org_id
    FROM campaigns
    WHERE id=?
  `).get(destinationCampaignId);
  if (!destination || destination.org_id !== organizationId) {
    throw new TypeError(
      'campaign knowledge custody destination does not match organization'
    );
  }
  const delta = knowledgeCapacityAuthorityExists(db)
    ? db.prepare(`
        SELECT
          1 AS entries,
          chunk_count AS chunks,
          entry_payload_bytes + chunk_payload_bytes AS payloadBytes,
          0 AS "references"
        FROM knowledge_entry_footprints
        WHERE knowledge_entry_id=?
      `).get(entryId)
    : db.prepare(`
        SELECT
          1 AS entries,
          COUNT(chunk.id) AS chunks,
          ${entryPayloadSql('entry')} +
            COALESCE(SUM(${chunkPayloadSql('chunk')}),0) AS payloadBytes,
          0 AS "references"
        FROM knowledge_entries entry
        LEFT JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
        WHERE entry.id=?
        GROUP BY entry.id
      `).get(entryId);
  if (!delta) {
    throw new TypeError('campaign knowledge custody entry does not exist');
  }
  const normalizedDelta = normalizedCapacityUsage(
    delta,
    'campaign custody move'
  );
  const defaultOrganizations = db.prepare(`
    SELECT id
    FROM organizations
    WHERE code='turingmarket-default'
  `).all();
  if (defaultOrganizations.length !== 1) {
    throw new Error(
      'default organization resolution failed during knowledge capacity preflight'
    );
  }
  const defaultOrganizationId = defaultOrganizations[0].id;
  const custody = currentKnowledgeCustody(db, entryId);
  const sourceOrganizationIds = new Set();
  if (custody) {
    sourceOrganizationIds.add(custody.org_id);
  } else {
    const entry = db.prepare(`
      SELECT created_by
      FROM knowledge_entries
      WHERE id=?
    `).get(entryId);
    if (entry.created_by === null) {
      sourceOrganizationIds.add(defaultOrganizationId);
    } else {
      db.prepare(`
        SELECT org_id
        FROM organization_memberships
        WHERE user_id=?
      `).all(entry.created_by).forEach(function(row) {
        sourceOrganizationIds.add(row.org_id);
      });
    }
  }
  const campaignIds = [destinationCampaignId];
  if (custody && custody.campaign_id !== destinationCampaignId) {
    campaignIds.push(custody.campaign_id);
  }
  const organizationIds = [organizationId, ...sourceOrganizationIds];
  const requestedScopes = [
    ...campaignIds.map(function(scopeId) { return { scopeType: 'campaign', scopeId }; }),
    ...organizationIds.map(function(scopeId) { return { scopeType: 'organization', scopeId }; })
  ];
  const combinedUsage = knowledgeCapacityAuthorityExists(db)
    ? authoritativeKnowledgeCapacityUsage(db, requestedScopes)
    : campaignOrganizationKnowledgeUsage(
      db,
      campaignIds,
      organizationIds,
      defaultOrganizationId
    );
  const plans = [];
  const destinationCampaignUsage = combinedUsage.get(
    `campaign:${destinationCampaignId}`
  );
  plans.push({
    scopeType: 'campaign',
    scopeId: destinationCampaignId,
    usage: custody && custody.campaign_id === destinationCampaignId
      ? destinationCampaignUsage
      : assertCapacity('campaign', destinationCampaignUsage, normalizedDelta)
  });
  if (custody && custody.campaign_id !== destinationCampaignId) {
    plans.push({
      scopeType: 'campaign',
      scopeId: custody.campaign_id,
      usage: capacityUsageAfterDelta(
        'campaign',
        combinedUsage.get(`campaign:${custody.campaign_id}`),
        normalizedDelta,
        -1
      )
    });
  }

  const destinationOrganizationUsage = combinedUsage.get(
    `organization:${organizationId}`
  );
  plans.push({
    scopeType: 'organization',
    scopeId: organizationId,
    usage: sourceOrganizationIds.has(organizationId)
      ? destinationOrganizationUsage
      : assertCapacity(
        'organization',
        destinationOrganizationUsage,
        normalizedDelta
      )
  });
  for (const sourceOrganizationId of sourceOrganizationIds) {
    if (sourceOrganizationId === organizationId) continue;
    plans.push({
      scopeType: 'organization',
      scopeId: sourceOrganizationId,
      usage: capacityUsageAfterDelta(
        'organization',
        combinedUsage.get(`organization:${sourceOrganizationId}`),
        normalizedDelta,
        -1
      )
    });
  }
  return normalizeKnowledgeCapacityGaugePlan(plans);
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

function allocateKnowledgeChunkIds(db, count) {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('campaign knowledge must allocate at least one chunk');
  }
  const row = db.prepare(PREVIOUS_CHUNK_ID_SQL).safeIntegers(true).get();
  if (!row || typeof row.previous_id !== 'bigint') {
    throw new Error('knowledge chunk previous_id must have INTEGER storage');
  }
  const finalId = row.previous_id + BigInt(count);
  if (row.previous_id < 0n || finalId > MAX_SAFE_ID_BIGINT) {
    throw new Error('knowledge chunk identifier capacity is exhausted');
  }
  const firstId = Number(row.previous_id + 1n);
  const lastId = Number(finalId);
  if (db.prepare(`
    SELECT 1 AS present
    FROM knowledge_chunks
    WHERE id BETWEEN ? AND ?
    LIMIT 1
  `).get(firstId, lastId)) {
    throw new Error('knowledge chunk identifier range is already allocated');
  }
  return Array.from({ length: count }, function(_unused, index) {
    return firstId + index;
  });
}

function verifyKnowledgeChunkSequence(db, finalChunkId) {
  const row = db.prepare(`
    SELECT seq,typeof(seq) AS seq_type
    FROM sqlite_sequence
    WHERE name='knowledge_chunks'
  `).safeIntegers(true).get();
  if (
    !row ||
    row.seq_type !== 'integer' ||
    typeof row.seq !== 'bigint' ||
    row.seq !== BigInt(finalChunkId)
  ) {
    throw new Error('knowledge_chunks sqlite_sequence did not advance atomically');
  }
}

function readCampaignKnowledgeGraph(db, entryId) {
  const entry = db.prepare(`
    SELECT *
    FROM knowledge_entries
    WHERE id=?
  `).get(entryId);
  if (!entry) return null;
  const chunks = db.prepare(`
    SELECT
      id,entry_id,chunk_index,content,metadata_json,token_count,
      embedding_json,created_at,content_sha256
    FROM knowledge_chunks
    WHERE entry_id=?
    ORDER BY chunk_index,id
  `).all(entryId);
  return { entry, chunks };
}

function normalizeCampaignKnowledgeEntry(row) {
  return Object.assign(normalizeEntry(row), {
    source_identity_sha256: row.source_identity_sha256,
    content_sha256: row.content_sha256
  });
}

function normalizeCampaignKnowledgeChunk(row) {
  return {
    id: row.id,
    entry_id: row.entry_id,
    chunk_index: row.chunk_index,
    content: row.content,
    metadata: parseJson(row.metadata_json, {}),
    metadata_json: row.metadata_json,
    token_count: row.token_count,
    embedding: parseJson(row.embedding_json, null),
    embedding_json: row.embedding_json,
    created_at: row.created_at,
    content_sha256: row.content_sha256
  };
}

function campaignKnowledgeResult(status, graph, capacityGaugePlan = []) {
  const result = {
    status,
    entry: normalizeCampaignKnowledgeEntry(graph.entry),
    chunks: graph.chunks.map(normalizeCampaignKnowledgeChunk)
  };
  Object.defineProperty(result, 'capacityGaugePlan', {
    configurable: false,
    enumerable: false,
    value: normalizeKnowledgeCapacityGaugePlan(capacityGaugePlan),
    writable: false
  });
  return result;
}

function currentKnowledgeCustody(db, entryId) {
  return db.prepare(`
    SELECT org_id,campaign_id
    FROM campaign_record_links
    WHERE record_type='knowledge_entry'
      AND relation_type<>'shortlist'
      AND record_id=?
    ORDER BY
      CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END,
      CASE WHEN revoked_at IS NULL THEN id END DESC,
      revoked_at DESC,
      id DESC
    LIMIT 1
  `).get(String(entryId)) || null;
}

function sameCampaignSourceProjection(existing, prepared) {
  const expected = prepared.entry;
  const sourceId = existing.source_id === null
    ? null
    : String(existing.source_id);
  return (
    existing.entry_type === expected.entry_type &&
    existing.source_type === expected.source_type &&
    sourceId === expected.source_id &&
    (existing.source_hash === null || existing.source_hash === '') &&
    existing.business_type === 'campaign' &&
    existing.business_id === String(prepared.campaignId) &&
    (
      expected.visibility === 'team' ||
      existing.created_by === expected.created_by
    )
  );
}

function campaignKnowledgeFtsMatches(db, graph, prepared) {
  const actual = db.prepare(`
    SELECT title,content,tags,entry_id,chunk_id
    FROM knowledge_chunks_fts
    WHERE entry_id=?
    ORDER BY CAST(chunk_id AS INTEGER),rowid
  `).all(graph.entry.id);
  const expected = graph.chunks.map(function(chunk) {
    return {
      title: prepared.entry.title,
      content: chunk.content,
      tags: prepared.entry.tags.join(' '),
      entry_id: graph.entry.id,
      chunk_id: chunk.id
    };
  });
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function exactCampaignKnowledgeGraph(db, existing, prepared) {
  const graph = readCampaignKnowledgeGraph(db, existing.id);
  const custody = currentKnowledgeCustody(db, existing.id);
  if (
    !graph ||
    !sameCampaignSourceProjection(graph.entry, prepared) ||
    !custody ||
    custody.org_id !== prepared.organizationId ||
    custody.campaign_id !== prepared.campaignId
  ) {
    throw new CampaignKnowledgeConflictError(
      'Campaign knowledge source identity projection conflicts with stored evidence'
    );
  }
  const expected = prepared.entry;
  const entryMatches = (
    graph.entry.source_identity_sha256 === expected.source_identity_sha256 &&
    graph.entry.content_sha256 === expected.content_sha256 &&
    graph.entry.entry_type === expected.entry_type &&
    graph.entry.title === expected.title &&
    graph.entry.summary === expected.summary &&
    graph.entry.content === expected.content &&
    graph.entry.tags_json === expected.tags_json &&
    graph.entry.visibility === expected.visibility
  );
  const chunksMatch = (
    graph.chunks.length === prepared.chunks.length &&
    graph.chunks.every(function(chunk, index) {
      const candidate = prepared.chunks[index];
      return (
        chunk.chunk_index === index &&
        chunk.content === candidate.content &&
        chunk.content_sha256 === candidate.contentSha256 &&
        sha256Hex(Buffer.from(chunk.content, 'utf8')) === chunk.content_sha256
      );
    })
  );
  const ftsMatches = campaignKnowledgeFtsMatches(db, graph, prepared);
  if (!entryMatches || !chunksMatch || !ftsMatches) {
    throw new CampaignKnowledgeConflictError();
  }
  return graph;
}

function findCampaignKnowledgeByIdentity(db, prepared) {
  return db.prepare(`
    SELECT id
    FROM knowledge_entries
    WHERE source_identity_sha256=?
  `).get(prepared.entry.source_identity_sha256) || null;
}

function assertNoConflictingCampaignReview(db, prepared) {
  if (prepared.entry.source_type !== 'campaign_review') return;
  const existing = db.prepare(`
    SELECT id,source_identity_sha256
    FROM knowledge_entries
    WHERE source_type='campaign_review'
      AND CAST(source_id AS TEXT)=?
  `).get(prepared.entry.source_id);
  if (
    existing &&
    existing.source_identity_sha256 !== prepared.entry.source_identity_sha256
  ) {
    throw new CampaignKnowledgeConflictError(
      'Campaign review source identity conflicts with stored evidence'
    );
  }
}

function insertCampaignKnowledgeEntry(db, entryId, entry) {
  const result = db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,title,summary,source_type,source_id,key_terms,content,
      created_by,is_public,tags_json,visibility,source_hash,business_type,
      business_id,metadata_json,embedding_json,source_identity_sha256,
      content_sha256
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    entryId,
    entry.entry_type,
    entry.title,
    entry.summary,
    entry.source_type,
    entry.source_id,
    entry.key_terms,
    entry.content,
    entry.created_by,
    entry.is_public,
    entry.tags_json,
    entry.visibility,
    null,
    'campaign',
    entry.business_id,
    entry.metadata_json,
    entry.embedding_json,
    entry.source_identity_sha256,
    entry.content_sha256
  );
  if (result.changes !== 1) {
    throw new Error('campaign knowledge entry insert count mismatch');
  }
  verifyKnowledgeEntrySequence(db, entryId);
}

function insertCampaignKnowledgeChunks(db, entryId, chunkIds, chunks) {
  const insert = db.prepare(`
    INSERT INTO knowledge_chunks (
      id,entry_id,chunk_index,content,metadata_json,token_count,
      embedding_json,content_sha256
    )
    VALUES (?,?,?,?,?,?,?,?)
  `);
  chunks.forEach(function(chunk, index) {
    const result = insert.run(
      chunkIds[index],
      entryId,
      chunk.index,
      chunk.content,
      chunk.metadataJson,
      chunk.tokenCount,
      null,
      chunk.contentSha256
    );
    if (result.changes !== 1) {
      throw new Error('campaign knowledge chunk insert count mismatch');
    }
  });
  verifyKnowledgeChunkSequence(db, chunkIds[chunkIds.length - 1]);
}

function insertCampaignKnowledgeFts(db, entryId, entry, chunkIds, chunks) {
  const insert = db.prepare(`
    INSERT INTO knowledge_chunks_fts (title,content,tags,entry_id,chunk_id)
    VALUES (?,?,?,?,?)
  `);
  const expected = chunks.map(function(chunk, index) {
    const row = {
      title: entry.title,
      content: chunk.content,
      tags: entry.tags.join(' '),
      entry_id: entryId,
      chunk_id: chunkIds[index]
    };
    insert.run(
      row.title,
      row.content,
      row.tags,
      row.entry_id,
      row.chunk_id
    );
    return row;
  });
  db.prepare(
    "INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('integrity-check')"
  ).run();
  const actual = db.prepare(`
    SELECT title,content,tags,entry_id,chunk_id
    FROM knowledge_chunks_fts
    WHERE entry_id=?
    ORDER BY CAST(chunk_id AS INTEGER),rowid
  `).all(entryId);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('campaign knowledge FTS projection mismatch');
  }
}

function writeCampaignKnowledgeInTransaction(db, options) {
  if (!db || db.inTransaction !== true) {
    throw new TypeError(
      'writeCampaignKnowledgeInTransaction requires an existing transaction'
    );
  }
  const prepared = prepareCampaignKnowledge(options);
  const existing = findCampaignKnowledgeByIdentity(db, prepared);
  if (existing) {
    return campaignKnowledgeResult(
      'exact_existing',
      exactCampaignKnowledgeGraph(db, existing, prepared)
    );
  }
  assertNoConflictingCampaignReview(db, prepared);
  const capacityGaugePlan = preflightCampaignKnowledgeCapacity(db, prepared);

  const entryId = allocateKnowledgeEntryId(db);
  const chunkIds = allocateKnowledgeChunkIds(db, prepared.chunks.length);
  insertCampaignKnowledgeEntry(db, entryId, prepared.entry);
  insertCampaignKnowledgeChunks(
    db,
    entryId,
    chunkIds,
    prepared.chunks
  );
  insertCampaignKnowledgeFts(
    db,
    entryId,
    prepared.entry,
    chunkIds,
    prepared.chunks
  );
  const graph = readCampaignKnowledgeGraph(db, entryId);
  if (!graph || graph.chunks.length !== prepared.chunks.length) {
    throw new Error('campaign knowledge graph verification failed');
  }
  return campaignKnowledgeResult('created', graph, capacityGaugePlan);
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

function hasCampaignKnowledgeCustody(db) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type='table' AND name='campaign_record_links'
  `).get());
}

function hasKnowledgeCurrentCustody(db) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type='table' AND name='knowledge_current_custody'
  `).get());
}

function sharedKnowledgePredicate(entryAlias) {
  return `(
    ${entryAlias}.visibility IN ('team','public','shared')
    OR ${entryAlias}.is_public=1
  )`;
}

function projectedKnowledgeVisibilitySql(entryAlias) {
  return `CASE
    WHEN ${entryAlias}.visibility='private' THEN 'private'
    WHEN ${entryAlias}.visibility IN ('team','public','shared') THEN 'team'
    WHEN ${entryAlias}.visibility IS NULL AND ${entryAlias}.is_public=1 THEN 'team'
    ELSE 'private'
  END`;
}

function latestKnowledgeCustodyJoin(db, entryAlias) {
  if (hasKnowledgeCurrentCustody(db)) {
    return {
      sql: `LEFT JOIN knowledge_current_custody campaign_scope
        ON campaign_scope.knowledge_entry_id=${entryAlias}.id`,
      presence: 'campaign_scope.link_id'
    };
  }
  return {
    sql: `LEFT JOIN campaign_record_links campaign_scope
    ON campaign_scope.id=COALESCE(
      (
        SELECT active_link.id
        FROM campaign_record_links active_link
        WHERE active_link.record_type='knowledge_entry'
          AND active_link.relation_type<>'shortlist'
          AND active_link.record_id=CAST(${entryAlias}.id AS TEXT)
          AND active_link.revoked_at IS NULL
        ORDER BY active_link.id DESC
        LIMIT 1
      ),
      (
        SELECT historical_link.id
        FROM campaign_record_links historical_link
        WHERE historical_link.record_type='knowledge_entry'
          AND historical_link.relation_type<>'shortlist'
          AND historical_link.record_id=CAST(${entryAlias}.id AS TEXT)
          AND historical_link.revoked_at IS NOT NULL
        ORDER BY historical_link.revoked_at DESC,historical_link.id DESC
        LIMIT 1
      )
    )`,
    presence: 'campaign_scope.id'
  };
}

function knowledgeAccessParts(db, user, scope, options) {
  const entryAlias = 'entry';
  const shared = sharedKnowledgePredicate(entryAlias);
  const hasCustody = hasCampaignKnowledgeCustody(db);
  const allowPrivateUnlinked = Boolean(options && options.allowPrivateUnlinked);
  const isPlatformAdmin = Boolean(user && user.role === 'admin');
  const numericUserId = Number(user && user.id);
  const hasUserId = Number.isSafeInteger(numericUserId) && numericUserId > 0;
  const legacyAccess = allowPrivateUnlinked
    ? '1=1'
    : `(${entryAlias}.created_by=? OR ${shared})`;
  const legacyParams = allowPrivateUnlinked ? [] : [hasUserId ? numericUserId : -1];

  if (!hasCustody) {
    return {
      withClause: '',
      fromClause: `knowledge_entries ${entryAlias}`,
      hasCustody: false,
      clause: isPlatformAdmin ? '1=1' : legacyAccess,
      params: isPlatformAdmin ? [] : legacyParams
    };
  }

  const custodyJoin = latestKnowledgeCustodyJoin(db, entryAlias);
  const result = {
    withClause: '',
    fromClause: `knowledge_entries ${entryAlias}
      ${custodyJoin.sql}`,
    hasCustody: true,
    custodyPresence: custodyJoin.presence
  };
  const requestedCampaignId = Number(options && options.campaignId);
  const campaignScoped = Number.isSafeInteger(requestedCampaignId) && requestedCampaignId > 0;
  if (campaignScoped) {
    const unlinkedAccess = isPlatformAdmin ? '1=1' : legacyAccess;
    const params = isPlatformAdmin ? [] : [...legacyParams];
    let linkedAccess = '0=1';
    let campaignAccessSql = '1=1';
    if (isPlatformAdmin) {
      linkedAccess = '1=1';
    } else if (hasUserId) {
      linkedAccess = `(
        ${entryAlias}.created_by=?
        OR ${projectedKnowledgeVisibilitySql(entryAlias)}='team'
      )`;
      params.push(requestedCampaignId, numericUserId);
      const campaignAccess = buildCollectionAccessPredicate(scope, {
        userId: numericUserId
      });
      campaignAccessSql = campaignAccess.sql;
      params.push(...campaignAccess.params);
    } else {
      params.push(requestedCampaignId);
    }
    if (isPlatformAdmin) params.push(requestedCampaignId);
    return {
      ...result,
      clause: `(
        (${custodyJoin.presence} IS NULL AND ${unlinkedAccess})
        OR (
          ${custodyJoin.presence} IS NOT NULL
          AND campaign_scope.campaign_id=?
          AND ${linkedAccess}
          AND (${campaignAccessSql})
        )
      )`,
      params
    };
  }
  if (isPlatformAdmin) {
    return { ...result, clause: '1=1', params: [] };
  }
  if (!hasUserId) {
    return {
      ...result,
      clause: `(${custodyJoin.presence} IS NULL AND ${legacyAccess})`,
      params: legacyParams
    };
  }

  const campaignAccess = buildCollectionAccessPredicate(scope, {
    userId: numericUserId
  });
  return {
    ...result,
    clause: `(
      (${custodyJoin.presence} IS NULL AND ${legacyAccess})
      OR (
        ${custodyJoin.presence} IS NOT NULL
        AND (
          ${entryAlias}.created_by=?
          OR ${projectedKnowledgeVisibilitySql(entryAlias)}='team'
        )
        AND (${campaignAccess.sql})
      )
    )`,
    params: [
      ...legacyParams,
      numericUserId,
      ...campaignAccess.params
    ]
  };
}

function buildWhere(db, opts, scope, accessOptions) {
  const where = ['1=1'];
  const params = [];
  const user = opts.user || {};
  const access = knowledgeAccessParts(db, user, scope, accessOptions);
  const governanceAvailable = hasKnowledgeGovernance(db);
  const includeInactiveGovernance = Boolean(
    governanceAvailable &&
    accessOptions &&
    accessOptions.includeInactiveGovernance
  );
  if (opts.entry_type || opts.type) { where.push('entry.entry_type = ?'); params.push(opts.entry_type || opts.type); }
  if (opts.source_type) { where.push('entry.source_type = ?'); params.push(opts.source_type); }
  const visibilitySql = access.hasCustody
    ? `CASE
        WHEN ${access.custodyPresence} IS NULL THEN entry.visibility
        ELSE ${projectedKnowledgeVisibilitySql('entry')}
      END`
    : 'entry.visibility';
  if (opts.visibility) { where.push(`${visibilitySql} = ?`); params.push(opts.visibility); }
  if (opts.business_type) { where.push('entry.business_type = ?'); params.push(opts.business_type); }
  if (opts.business_id) { where.push('entry.business_id = ?'); params.push(String(opts.business_id)); }
  if (governanceAvailable && !includeInactiveGovernance) {
    where.push(governanceEligibilitySql('governance'));
  }
  if (governanceAvailable && opts.quality_state) {
    where.push('governance.quality_state = ?');
    params.push(String(opts.quality_state));
  }
  if (governanceAvailable && opts.retention_class) {
    where.push('governance.retention_class = ?');
    params.push(String(opts.retention_class));
  }
  where.push(access.clause);
  params.push(...access.params);
  return {
    withClause: access.withClause,
    fromClause: governanceAvailable
      ? `${access.fromClause}
        LEFT JOIN knowledge_entry_governance governance
          ON governance.knowledge_entry_id=entry.id`
      : access.fromClause,
    hasCustody: access.hasCustody,
    custodyPresence: access.custodyPresence || null,
    hasGovernance: governanceAvailable,
    governanceProjection: governanceAvailable ? governanceProjection('governance') : 'NULL AS governance_knowledge_entry_id',
    governanceOrder: governanceAvailable
      ? "CASE governance.quality_state WHEN 'confirmed' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END"
      : 'CASE WHEN 1=1 THEN 0 ELSE 1 END',
    clause: where.join(' AND '),
    params
  };
}

function versionedKnowledgeReferenceProjection(db, reference) {
  const entryId = reference && reference.knowledge_entry_id;
  const chunkId = reference && reference.knowledge_chunk_id;
  const rank = reference && reference.reference_rank;
  if (
    !reference ||
    typeof reference !== 'object' ||
    Array.isArray(reference) ||
    reference.reference_schema_version !== 1 ||
    reference.reference_type !== 'knowledge' ||
    !Number.isSafeInteger(entryId) ||
    entryId < 1 ||
    !Number.isSafeInteger(chunkId) ||
    chunkId < 1 ||
    !Number.isSafeInteger(rank) ||
    rank < 1
  ) {
    return null;
  }
  return db.prepare(`
    SELECT
      entry.id AS entry_id,
      chunk.id AS chunk_id,
      chunk.chunk_index,
      entry.title,
      entry.entry_type,
      entry.source_type,
      entry.visibility,
      entry.is_public,
      @snippet AS snippet,
      @selectionOrigin AS selection_origin,
      @sourceIdentitySha256 AS source_identity_sha256,
      @entryContentSha256 AS entry_content_sha256,
      @chunkContentSha256 AS chunk_content_sha256,
      @rank AS rank
    FROM knowledge_entries entry
    JOIN knowledge_chunks chunk
      ON chunk.entry_id=entry.id AND chunk.id=@chunkId
    WHERE entry.id=@entryId
      AND entry.source_identity_sha256=@sourceIdentitySha256
      AND entry.content_sha256=@entryContentSha256
      AND chunk.content_sha256=@chunkContentSha256
  `).get({
    entryId,
    chunkId,
    rank,
    snippet: typeof reference.snippet === 'string' ? reference.snippet : '',
    selectionOrigin: reference.selection_origin,
    sourceIdentitySha256: reference.source_identity_sha256,
    entryContentSha256: reference.entry_content_sha256,
    chunkContentSha256: reference.chunk_content_sha256
  }) || null;
}

function historicalKnowledgeCustodyAllowsRead(db, entryId, user) {
  const where = buildWhere(
    db,
    { user: user || {} },
    'knowledge_references',
    { includeInactiveGovernance: true }
  );
  return Boolean(db.prepare(`
    ${where.withClause}
    SELECT 1 AS present
    FROM ${where.fromClause}
    WHERE ${where.clause} AND entry.id=?
    LIMIT 1
  `).get(...where.params, entryId));
}

function redactKnowledgeReferences(db, references, user) {
  if (!Array.isArray(references)) {
    throw new TypeError('knowledge references must be an array');
  }
  return references.map(function(reference) {
    if (
      !reference ||
      typeof reference !== 'object' ||
      Array.isArray(reference) ||
      reference.reference_schema_version !== 1
    ) {
      return reference;
    }
    const rank = reference.reference_rank;
    if (!Number.isSafeInteger(rank) || rank < 1) {
      throw new Error('versioned knowledge reference rank is invalid');
    }
    const projection = versionedKnowledgeReferenceProjection(db, reference);
    if (!projection) {
      return serializeKnowledgeReference({ rank }, { target: 'missing' });
    }
    if (!historicalKnowledgeCustodyAllowsRead(db, projection.entry_id, user)) {
      return serializeKnowledgeReference({ rank }, { target: 'restricted' });
    }
    return serializeKnowledgeReference(projection, { target: 'available' });
  });
}

function adminKnowledgeBaseWhere(db, opts) {
  const where = ['1=1'];
  const params = [];
  if (opts.entry_type || opts.type) {
    where.push('entry.entry_type = ?');
    params.push(opts.entry_type || opts.type);
  }
  if (opts.source_type) {
    where.push('entry.source_type = ?');
    params.push(opts.source_type);
  }
  if (opts.business_type) {
    where.push('entry.business_type = ?');
    params.push(opts.business_type);
  }
  if (opts.business_id) {
    where.push('entry.business_id = ?');
    params.push(String(opts.business_id));
  }
  const governanceAvailable = hasKnowledgeGovernance(db);
  const includeInactive = Boolean(opts.include_inactive);
  if (governanceAvailable && !includeInactive) {
    where.push(governanceEligibilitySql('governance'));
  }
  if (governanceAvailable && opts.quality_state) {
    where.push('governance.quality_state = ?');
    params.push(String(opts.quality_state));
  }
  if (governanceAvailable && opts.retention_class) {
    where.push('governance.retention_class = ?');
    params.push(String(opts.retention_class));
  }
  return {
    clause: where.join(' AND '),
    params,
    hasGovernance: governanceAvailable,
    fromClause: governanceAvailable
      ? `knowledge_entries entry
        LEFT JOIN knowledge_entry_governance governance
          ON governance.knowledge_entry_id=entry.id`
      : 'knowledge_entries entry',
    governanceProjection: governanceAvailable
      ? governanceProjection('governance')
      : 'NULL AS governance_knowledge_entry_id',
    governanceOrder: governanceAvailable
      ? "CASE governance.quality_state WHEN 'confirmed' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END"
      : 'CASE WHEN 1=1 THEN 0 ELSE 1 END'
  };
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

function campaignKnowledgeEntryAllowsRead(db, options) {
  const input = options || {};
  const entryId = Number(input.entryId);
  const campaignId = Number(input.campaignId);
  if (
    !Number.isSafeInteger(entryId) || entryId < 1 ||
    !Number.isSafeInteger(campaignId) || campaignId < 1
  ) return false;
  const where = buildWhere(
    db,
    { user: input.user || {} },
    'knowledge_rag',
    { campaignId }
  );
  return Boolean(db.prepare(`
    ${where.withClause || ''}
    SELECT 1 AS present
    FROM ${where.fromClause}
    WHERE ${where.clause} AND entry.id=?
    LIMIT 1
  `).get(...where.params, entryId));
}

function searchCampaignKnowledgeChunks(db, opts) {
  opts = opts || {};
  const campaignId = Number(opts.campaignId || opts.campaign_id);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) {
    throw new CampaignKnowledgeInputError('campaign knowledge search requires a campaign');
  }
  const terms = extractSearchTerms(opts.query || opts.q || '');
  if (!terms.length) return [];
  const ftsQuery = terms.map(function(term) {
    return `"${term.replace(/"/g, '""')}"`;
  }).join(' OR ');
  const limit = Math.min(Math.max(parseInt(opts.limit || 100, 10) || 100, 1), 100);
  const where = buildWhere(
    db,
    opts,
    'knowledge_rag',
    { campaignId }
  );
  const rows = db.prepare(`
    ${where.withClause || ''}
    SELECT
      entry.id AS entry_id,
      entry.title,
      entry.entry_type,
      entry.source_type,
      entry.visibility,
      entry.is_public,
      entry.source_identity_sha256,
      entry.content_sha256 AS entry_content_sha256,
      entry.updated_at,
      chunk.id AS chunk_id,
      chunk.chunk_index,
      chunk.content AS chunk_content,
      chunk.content_sha256 AS chunk_content_sha256,
      bm25(knowledge_chunks_fts) AS fts_rank,
      ${where.governanceProjection}
    FROM ${where.fromClause}
    JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
    JOIN knowledge_chunks_fts
      ON CAST(knowledge_chunks_fts.entry_id AS INTEGER)=entry.id
     AND CAST(knowledge_chunks_fts.chunk_id AS INTEGER)=chunk.id
    WHERE knowledge_chunks_fts MATCH ?
      AND ${where.clause}
    ORDER BY
      ${where.governanceOrder} ASC,
      fts_rank ASC,
      entry.updated_at DESC,
      entry.id ASC,
      chunk.chunk_index ASC,
      chunk.id ASC
    LIMIT ?
  `).all(ftsQuery, ...where.params, limit);
  return rows.map(function(row) {
    return {
      record: {
        entry: {
          id: row.entry_id,
          title: row.title,
          entry_type: row.entry_type,
          source_type: row.source_type,
          visibility: row.visibility,
          is_public: row.is_public,
          source_identity_sha256: row.source_identity_sha256,
          content_sha256: row.entry_content_sha256,
          updated_at: row.updated_at,
          governance: normalizeGovernance(row)
        }
      },
      chunk: {
        id: row.chunk_id,
        entry_id: row.entry_id,
        chunk_index: row.chunk_index,
        content: row.chunk_content,
        content_sha256: row.chunk_content_sha256
      },
      ftsRank: row.fts_rank
    };
  });
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
  const adminCandidateFirst = Boolean(
    opts.user && opts.user.role === 'admin' && !opts.visibility
  );
  const where = adminCandidateFirst
    ? adminKnowledgeBaseWhere(db, opts)
    : buildWhere(
        db,
        opts,
        'knowledge',
        {
          includeInactiveGovernance: Boolean(
            opts.include_inactive && opts.user && opts.user.role === 'admin'
          )
        }
      );
  const hasCustody = adminCandidateFirst
    ? hasCampaignKnowledgeCustody(db)
    : where.hasCustody;
  let rows;
  if (adminCandidateFirst && hasCustody) {
    const custodyJoin = latestKnowledgeCustodyJoin(db, 'entry');
    rows = db.prepare(`
      WITH admin_candidates AS MATERIALIZED (
        SELECT entry.*,${where.governanceProjection}
        FROM ${where.fromClause}
        WHERE ${where.clause}
        ORDER BY ${where.governanceOrder} ASC,
          entry.usage_count DESC, entry.updated_at DESC, entry.id DESC
        LIMIT 500
      )
      SELECT entry.*,${custodyJoin.presence} AS campaign_custody_entry_id
      FROM admin_candidates entry
      ${custodyJoin.sql}
      ORDER BY
        ${where.hasGovernance
          ? `CASE entry.governance_quality_state
              WHEN 'confirmed' THEN 0 WHEN 'candidate' THEN 1 ELSE 2
            END`
          : 'CASE WHEN 1=1 THEN 0 ELSE 1 END'} ASC,
        entry.usage_count DESC, entry.updated_at DESC, entry.id DESC
    `).all(...where.params);
  } else {
    const boundedCandidates = Boolean(
      !adminCandidateFirst &&
      hasCustody &&
      hasKnowledgeCurrentCustody(db) &&
      !where.hasGovernance
    );
    if (boundedCandidates) {
      rows = db.prepare(`
        WITH knowledge_candidates AS MATERIALIZED (
          SELECT
            entry.id,
            entry.usage_count,
            entry.updated_at,
            ${where.custodyPresence} AS campaign_custody_entry_id
          FROM ${where.fromClause}
          WHERE ${where.clause}
          ORDER BY entry.usage_count DESC,entry.updated_at DESC,entry.id DESC
          LIMIT 500
        )
        SELECT entry.*,candidate.campaign_custody_entry_id
        FROM knowledge_candidates candidate
        JOIN knowledge_entries entry ON entry.id=candidate.id
        ORDER BY candidate.usage_count DESC,candidate.updated_at DESC,candidate.id DESC
      `).all(...where.params);
    } else {
      rows = db.prepare(`
        ${where.withClause || ''}
        SELECT
          entry.*,
          ${where.governanceProjection},
          ${hasCustody ? where.custodyPresence : 'NULL'}
            AS campaign_custody_entry_id
        FROM ${where.fromClause}
        WHERE ${where.clause}
        ORDER BY ${where.governanceOrder} ASC,
          entry.usage_count DESC, entry.updated_at DESC, entry.id DESC
        LIMIT 500
      `).all(...where.params);
    }
  }

  let entries = rows.map(function(row) {
    const entry = normalizeEntry(row);
    if (row.campaign_custody_entry_id !== null) {
      entry.visibility = projectKnowledgeVisibility({
        legacyVisibility: row.visibility,
        isPublic: row.is_public
      });
      entry.is_public = entry.visibility === 'team' ? 1 : 0;
    }
    return entry;
  });
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
        const aQuality = a.governance && a.governance.quality_state === 'confirmed' ? 0 : 1;
        const bQuality = b.governance && b.governance.quality_state === 'confirmed' ? 0 : 1;
        if (aQuality !== bQuality) return aQuality - bQuality;
        return (b.usage_count || 0) - (a.usage_count || 0);
      });
  }

  return entries.slice(0, limit);
}

function listKnowledgeCategories(db, opts) {
  opts = opts || {};
  if (opts.user && opts.user.role === 'admin' && !opts.visibility) {
    const where = adminKnowledgeBaseWhere(db, opts);
    return db.prepare(`
      SELECT entry.entry_type,COUNT(*) AS count
      FROM ${where.fromClause}
      WHERE ${where.clause}
      GROUP BY entry.entry_type
      ORDER BY entry.entry_type
    `).all(...where.params);
  }
  const where = buildWhere(db, opts, 'knowledge_categories');
  return db.prepare(`
    ${where.withClause}
    SELECT entry.entry_type,COUNT(*) AS count
    FROM ${where.fromClause}
    WHERE ${where.clause}
    GROUP BY entry.entry_type
    ORDER BY entry.entry_type
  `).all(...where.params);
}

function updateKnowledgeUsage(db, ids, user, options) {
  const uniqueIds = Array.from(new Set((ids || []).map(function(id) {
    const numericId = Number(id);
    return Number.isSafeInteger(numericId) && numericId > 0 ? numericId : null;
  }).filter(function(id) { return id !== null; })));
  if (!uniqueIds.length) return 0;
  const telemetry = Boolean(options && options.telemetry);
  const applyUpdates = function() {
    const where = buildWhere(
      db,
      { user: user || {} },
      'knowledge',
      { allowPrivateUnlinked: !user }
    );
    const placeholders = uniqueIds.map(function() { return '?'; }).join(',');
    const authorizedIds = db.prepare(`
      ${where.withClause}
      SELECT entry.id
      FROM ${where.fromClause}
      WHERE ${where.clause}
        ${where.hasCustody && !telemetry ? `AND ${where.custodyPresence} IS NULL` : ''}
        AND entry.id IN (${placeholders})
      ORDER BY entry.id
    `).all(...where.params, ...uniqueIds).map(function(row) { return row.id; });
    if (!authorizedIds.length) return 0;
    const updatePlaceholders = authorizedIds.map(function() { return '?'; }).join(',');
    const updateSql = telemetry
      ? `UPDATE knowledge_entries SET usage_count = usage_count + 1
        WHERE id IN (${updatePlaceholders})`
      : `UPDATE knowledge_entries SET usage_count = usage_count + 1,
          updated_at = datetime('now')
        WHERE id IN (${updatePlaceholders})`;
    return db.prepare(updateSql).run(...authorizedIds).changes;
  };
  if (db.inTransaction) return applyUpdates();
  return db.transaction(applyUpdates).immediate();
}

function markKnowledgeUsed(db, ids, user) {
  return updateKnowledgeUsage(db, ids, user, { telemetry: false });
}

function recordKnowledgeUsageTelemetry(db, ids, user) {
  return updateKnowledgeUsage(db, ids, user, { telemetry: true });
}

function purgeEphemeralKnowledgeEntries(db, options) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('purgeEphemeralKnowledgeEntries requires a database');
  }
  const input = options || {};
  const sourceType = typeof input.sourceType === 'string' ? input.sourceType.trim() : '';
  const entryIds = Array.isArray(input.entryIds) ? input.entryIds : [];
  const sourceIds = Array.isArray(input.sourceIds) ? input.sourceIds : [];
  if (sourceType !== 'deployment_smoke') {
    throw new TypeError('ephemeral knowledge sourceType is invalid');
  }
  if (entryIds.length < 1 || entryIds.length > 100 || sourceIds.length !== entryIds.length) {
    throw new TypeError('ephemeral knowledge cleanup requires 1-100 exact entry/source identities');
  }
  const expected = new Map();
  entryIds.forEach(function(value, index) {
    const entryId = Number(value);
    const sourceId = typeof sourceIds[index] === 'string' ? sourceIds[index].trim() : '';
    if (!Number.isSafeInteger(entryId) || entryId < 1 || !sourceId || sourceId.length > 200) {
      throw new TypeError('ephemeral knowledge cleanup identity is invalid');
    }
    if (expected.has(entryId)) throw new TypeError('ephemeral knowledge cleanup entry IDs must be unique');
    expected.set(entryId, sourceId);
  });

  const purge = function() {
    const ids = [...expected.keys()].sort(function(left, right) { return left - right; });
    const placeholders = ids.map(function() { return '?'; }).join(',');
    const rows = db.prepare(`
      SELECT entry.id,entry.source_type,entry.source_id,
        governance.lineage_root_entry_id,governance.supersedes_entry_id,
        governance.version_no,governance.is_current,governance.quality_state,
        governance.retention_class,
        (SELECT COUNT(*) FROM knowledge_chunks chunk WHERE chunk.entry_id=entry.id) AS chunk_count,
        (SELECT COUNT(*) FROM knowledge_chunks_fts fts
          WHERE CAST(fts.entry_id AS INTEGER)=entry.id) AS fts_count,
        (SELECT COUNT(*) FROM ai_references reference
          WHERE reference.knowledge_entry_id=entry.id
             OR (reference.reference_type='knowledge'
                 AND reference.reference_id=CAST(entry.id AS TEXT))) AS reference_count,
        (SELECT COUNT(*) FROM campaign_record_links link
          WHERE link.record_type='knowledge_entry'
            AND link.record_id=CAST(entry.id AS TEXT)) AS custody_count
      FROM knowledge_entries entry
      JOIN knowledge_entry_governance governance
        ON governance.knowledge_entry_id=entry.id
      WHERE entry.id IN (${placeholders})
      ORDER BY entry.id
    `).all(...ids);
    if (rows.length !== ids.length) {
      throw new Error('ephemeral knowledge cleanup identity set is incomplete');
    }
    let chunkCount = 0;
    let ftsCount = 0;
    for (const row of rows) {
      if (
        row.source_type !== sourceType || row.source_id !== expected.get(row.id) ||
        !expected.has(row.lineage_root_entry_id) ||
        (row.supersedes_entry_id !== null && !expected.has(row.supersedes_entry_id)) ||
        row.reference_count !== 0 || row.custody_count !== 0 ||
        row.chunk_count < 1 || row.fts_count !== row.chunk_count
      ) {
        throw new Error(`ephemeral knowledge cleanup rejected entry ${row.id}`);
      }
      chunkCount += row.chunk_count;
      ftsCount += row.fts_count;
    }
    const outsideSuccessors = db.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_entry_governance
      WHERE supersedes_entry_id IN (${placeholders})
        AND knowledge_entry_id NOT IN (${placeholders})
    `).get(...ids, ...ids).count;
    if (outsideSuccessors !== 0) {
      throw new Error('ephemeral knowledge cleanup lineage is incomplete');
    }

    const fts = db.prepare(`
      DELETE FROM knowledge_chunks_fts
      WHERE CAST(entry_id AS INTEGER) IN (${placeholders})
    `).run(...ids);
    const deleteGovernance = db.prepare(`
      DELETE FROM knowledge_entry_governance WHERE knowledge_entry_id=?
    `);
    let governanceChanges = 0;
    rows.sort(function(left, right) { return right.version_no - left.version_no; })
      .forEach(function(row) {
        governanceChanges += deleteGovernance.run(row.id).changes;
      });
    const entries = db.prepare(`
      DELETE FROM knowledge_entries WHERE id IN (${placeholders})
    `).run(...ids);
    if (fts.changes !== ftsCount || governanceChanges !== ids.length || entries.changes !== ids.length) {
      throw new Error('ephemeral knowledge cleanup cardinality mismatch');
    }
    db.prepare(
      "INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('integrity-check')"
    ).run();
    const leftovers = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM knowledge_entries WHERE id IN (${placeholders})) AS entries,
        (SELECT COUNT(*) FROM knowledge_chunks WHERE entry_id IN (${placeholders})) AS chunks,
        (SELECT COUNT(*) FROM knowledge_chunks_fts
          WHERE CAST(entry_id AS INTEGER) IN (${placeholders})) AS fts
    `).get(...ids, ...ids, ...ids);
    if (leftovers.entries !== 0 || leftovers.chunks !== 0 || leftovers.fts !== 0) {
      throw new Error('ephemeral knowledge cleanup left residual rows');
    }
    return { entries: entries.changes, chunks: chunkCount, fts: fts.changes };
  };
  return db.transaction(purge).immediate();
}

module.exports = {
  ingestKnowledge,
  writeCampaignKnowledgeInTransaction,
  preflightCampaignKnowledgeCustodyMoveInTransaction,
  applyKnowledgeCapacityGaugePlanInTransaction,
  reconcileKnowledgeCapacityGaugesInTransaction,
  refreshKnowledgeCapacityGaugesInTransaction,
  userKnowledgeUsage,
  campaignKnowledgeUsage,
  organizationKnowledgeUsage,
  campaignOrganizationKnowledgeUsage,
  capacityThresholdPercent,
  searchKnowledge,
  searchCampaignKnowledgeChunks,
  campaignKnowledgeEntryAllowsRead,
  listKnowledgeCategories,
  markKnowledgeUsed,
  recordKnowledgeUsageTelemetry,
  purgeEphemeralKnowledgeEntries,
  governKnowledgeEntry,
  readKnowledgeGovernance,
  isKnowledgeRetrievable,
  knowledgeGovernanceSql,
  redactKnowledgeReferences,
  normalizeEntry,
  normalizeTags,
  hashInput,
  makeChunks,
  CampaignKnowledgeConflictError,
  CampaignKnowledgeCapacityError,
  CampaignKnowledgeInputError,
  KnowledgeGovernanceError
};
