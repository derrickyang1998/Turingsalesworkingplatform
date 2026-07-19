const crypto = require('crypto');

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
  const visibility = options.visibility;
  if (visibility !== 'private' && visibility !== 'team') {
    throw new TypeError('campaign knowledge visibility must be private or team');
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

function capacityMetricLabel(metric) {
  return metric === 'payloadBytes' ? 'payload_bytes' : metric;
}

function assertCapacity(scope, usage, delta) {
  const limits = CAMPAIGN_KNOWLEDGE_CAPACITY[scope];
  CAPACITY_METRICS.forEach(function(metric) {
    const projected = usage[metric] + delta[metric];
    if (!Number.isSafeInteger(projected) || projected > limits[metric]) {
      throw new CampaignKnowledgeCapacityError({
        scope,
        metric: capacityMetricLabel(metric),
        limit: limits[metric],
        projected
      });
    }
  });
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
  assertCapacity(
    'user',
    userKnowledgeUsage(db, prepared.entry.created_by),
    delta
  );
  assertCapacity(
    'campaign',
    campaignKnowledgeUsage(db, prepared.campaignId),
    delta
  );
  assertCapacity(
    'organization',
    organizationKnowledgeUsage(
      db,
      prepared.organizationId,
      defaultOrganizations[0].id
    ),
    delta
  );
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

function campaignKnowledgeResult(status, graph) {
  return {
    status,
    entry: normalizeCampaignKnowledgeEntry(graph.entry),
    chunks: graph.chunks.map(normalizeCampaignKnowledgeChunk)
  };
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
  preflightCampaignKnowledgeCapacity(db, prepared);

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
  return campaignKnowledgeResult('created', graph);
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
  writeCampaignKnowledgeInTransaction,
  searchKnowledge,
  markKnowledgeUsed,
  normalizeEntry,
  normalizeTags,
  hashInput,
  makeChunks,
  CampaignKnowledgeConflictError,
  CampaignKnowledgeCapacityError
};
