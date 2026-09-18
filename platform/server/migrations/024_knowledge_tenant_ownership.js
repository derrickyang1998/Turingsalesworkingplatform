'use strict';

const { createHash } = require('node:crypto');

const LEGACY_ENTRY_COLUMNS = Object.freeze([
  'id',
  'entry_type',
  'source_type',
  'source_id',
  'key_terms',
  'content',
  'created_by',
  'is_public',
  'usage_count',
  'created_at',
  'updated_at',
  'title',
  'summary',
  'tags_json',
  'visibility',
  'source_hash',
  'business_type',
  'business_id',
  'metadata_json',
  'embedding_json',
  'source_identity_sha256',
  'content_sha256'
]);
const LEGACY_CHUNK_COLUMNS = Object.freeze([
  'id',
  'entry_id',
  'chunk_index',
  'content',
  'metadata_json',
  'token_count',
  'embedding_json',
  'created_at',
  'content_sha256'
]);

const INDEX_SQL = Object.freeze({
  idx_knowledge_source_hash: `CREATE UNIQUE INDEX idx_knowledge_source_hash
    ON knowledge_entries(org_id,source_hash)
    WHERE source_hash IS NOT NULL AND source_hash != ''`,
  ux_knowledge_source_identity: `CREATE UNIQUE INDEX ux_knowledge_source_identity
    ON knowledge_entries(org_id,source_identity_sha256)
    WHERE source_identity_sha256 IS NOT NULL`,
  ux_knowledge_campaign_review_source: `CREATE UNIQUE INDEX ux_knowledge_campaign_review_source
    ON knowledge_entries(org_id,source_type,CAST(source_id AS TEXT))
    WHERE source_type='campaign_review'`,
  ux_knowledge_entries_org_id: `CREATE UNIQUE INDEX ux_knowledge_entries_org_id
    ON knowledge_entries(org_id,id)`,
  idx_knowledge_entries_org_search_order: `CREATE INDEX idx_knowledge_entries_org_search_order
    ON knowledge_entries(org_id,usage_count DESC,updated_at DESC,id DESC)`
});

function entryPayloadSql(alias) {
  return [
    'title',
    'summary',
    'content',
    'key_terms',
    'tags_json',
    'metadata_json',
    'embedding_json'
  ].map((column) => `length(CAST(COALESCE(${alias}.${column},'') AS BLOB))`).join(' + ');
}

function chunkPayloadSql(alias) {
  return ['content', 'metadata_json', 'embedding_json']
    .map((column) => `length(CAST(COALESCE(${alias}.${column},'') AS BLOB))`)
    .join(' + ');
}

function thresholdSql(delta) {
  return `CASE
      WHEN usage_value + (${delta}) >= limit_value THEN 100
      WHEN (usage_value + (${delta})) * 10 >= limit_value * 9 THEN 90
      WHEN (usage_value + (${delta})) * 5 >= limit_value * 4 THEN 80
      ELSE 0
    END`;
}

function gaugeUpdate(scopeType, metric, scopePredicate, delta) {
  return `UPDATE knowledge_capacity_gauges
  SET usage_value=usage_value + (${delta}),
      threshold_percent=${thresholdSql(delta)},
      updated_at=CURRENT_TIMESTAMP
  WHERE scope_type='${scopeType}' AND metric='${metric}'
    AND (${scopePredicate});`;
}

function footprintValue(entryId, column) {
  return `(SELECT ${column} FROM knowledge_entry_footprints
    WHERE knowledge_entry_id=${entryId})`;
}

function footprintTotal(entryId) {
  return `(${footprintValue(entryId, 'entry_payload_bytes')} +
    ${footprintValue(entryId, 'chunk_payload_bytes')})`;
}

function noCustody(entryId) {
  return `NOT EXISTS (
    SELECT 1 FROM knowledge_current_custody
    WHERE knowledge_entry_id=${entryId}
  ) AND NOT EXISTS (
    SELECT 1 FROM organization_knowledge_custody
    WHERE knowledge_entry_id=${entryId}
  )`;
}

function updateUnlinkedUser(entryId, direction, extraPredicate = '1') {
  const creator = footprintValue(entryId, 'created_by');
  const sign = direction === 1 ? '' : '-';
  return `UPDATE knowledge_unlinked_user_usage
  SET entries=entries + (${sign}1),
      chunks=chunks + (${sign}${footprintValue(entryId, 'chunk_count')}),
      payload_bytes=payload_bytes + (${sign}${footprintTotal(entryId)}),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${creator} AND (${extraPredicate});`;
}

function currentCustodyCapacityBody(alias, direction) {
  const entryId = `${alias}.knowledge_entry_id`;
  const sign = direction === 1 ? '' : '-';
  return [
    gaugeUpdate('campaign', 'entries', `scope_id=${alias}.campaign_id`, `${sign}1`),
    gaugeUpdate(
      'campaign',
      'chunks',
      `scope_id=${alias}.campaign_id`,
      `${sign}${footprintValue(entryId, 'chunk_count')}`
    ),
    gaugeUpdate(
      'campaign',
      'payload_bytes',
      `scope_id=${alias}.campaign_id`,
      `${sign}${footprintTotal(entryId)}`
    ),
    updateUnlinkedUser(
      entryId,
      -direction,
      `NOT EXISTS (
        SELECT 1 FROM organization_knowledge_custody
        WHERE knowledge_entry_id=${entryId}
      )`
    )
  ].join('\n');
}

function entryPayloadMutationBody(alias, delta) {
  const entryId = `${alias}.id`;
  return [
    gaugeUpdate('user', 'payload_bytes', `scope_id=${alias}.created_by`, delta),
    gaugeUpdate(
      'campaign',
      'payload_bytes',
      `scope_id=(SELECT campaign_id FROM knowledge_current_custody
        WHERE knowledge_entry_id=${entryId})`,
      delta
    ),
    gaugeUpdate('organization', 'payload_bytes', `scope_id=${alias}.org_id`, delta),
    `UPDATE knowledge_unlinked_user_usage
  SET payload_bytes=payload_bytes + (${delta}),updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${alias}.created_by AND ${noCustody(entryId)};`
  ].join('\n');
}

function chunkMutationBody(alias, direction) {
  const entryId = `${alias}.entry_id`;
  const creator = footprintValue(entryId, 'created_by');
  const bytes = chunkPayloadSql(alias);
  const sign = direction === 1 ? '' : '-';
  const delta = `CASE metric
      WHEN 'chunks' THEN (${sign}1)
      WHEN 'payload_bytes' THEN (${sign}(${bytes}))
      ELSE 0
    END`;
  return [
    `UPDATE knowledge_capacity_gauges
  SET usage_value=usage_value + (${delta}),
      threshold_percent=${thresholdSql(delta)},
      updated_at=CURRENT_TIMESTAMP
  WHERE metric IN ('chunks','payload_bytes') AND (
    (scope_type='user' AND scope_id=${creator})
    OR (scope_type='campaign' AND scope_id=(
      SELECT campaign_id FROM knowledge_current_custody
      WHERE knowledge_entry_id=${entryId}
    ))
    OR (scope_type='organization' AND scope_id=(
      SELECT org_id FROM knowledge_entries WHERE id=${entryId}
    ))
  );`,
    `UPDATE knowledge_unlinked_user_usage
  SET chunks=chunks + (${sign}1),
      payload_bytes=payload_bytes + (${sign}(${bytes})),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${creator} AND ${noCustody(entryId)};`,
    `UPDATE knowledge_entry_footprints
  SET chunk_count=chunk_count + (${sign}1),
      chunk_payload_bytes=chunk_payload_bytes + (${sign}(${bytes})),
      updated_at=CURRENT_TIMESTAMP
  WHERE knowledge_entry_id=${entryId};`
  ].join('\n');
}

function referenceUserId(alias) {
  return `(SELECT conversation.user_id
    FROM ai_messages message
    JOIN ai_conversations conversation ON conversation.id=message.conversation_id
    WHERE message.id=${alias}.message_id)`;
}

function referenceMutationBody(alias, direction) {
  const sign = direction === 1 ? '' : '-';
  const userId = referenceUserId(alias);
  return [
    gaugeUpdate('user', 'references', `scope_id=${userId}`, `${sign}1`),
    gaugeUpdate(
      'campaign',
      'references',
      `${alias}.campaign_id IS NOT NULL AND scope_id=${alias}.campaign_id`,
      `${sign}1`
    ),
    gaugeUpdate(
      'organization',
      'references',
      `scope_id=CASE
        WHEN ${alias}.campaign_id IS NOT NULL THEN (
          SELECT campaign.org_id FROM campaigns campaign
          WHERE campaign.id=${alias}.campaign_id
        )
        WHEN ${alias}.knowledge_entry_id IS NOT NULL THEN (
          SELECT entry.org_id FROM knowledge_entries entry
          WHERE entry.id=${alias}.knowledge_entry_id
        )
        ELSE NULL
      END`,
      `${sign}1`
    ),
    `UPDATE knowledge_unlinked_user_usage
  SET unscoped_references=unscoped_references + (${sign}1),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${userId} AND ${alias}.campaign_id IS NULL;`
  ].join('\n');
}

const TRIGGER_SQL = Object.freeze({
  knowledge_entries_org_scope_insert: `CREATE TRIGGER knowledge_entries_org_scope_insert
BEFORE INSERT ON knowledge_entries
WHEN NEW.org_id IS NULL
  OR typeof(NEW.org_id)<>'integer'
  OR NEW.org_id<1
  OR NEW.org_id>9007199254740991
  OR NOT EXISTS (SELECT 1 FROM organizations organization WHERE organization.id=NEW.org_id)
BEGIN SELECT RAISE(ABORT,'knowledge organization ownership is required'); END`,
  knowledge_entries_org_scope_update: `CREATE TRIGGER knowledge_entries_org_scope_update
BEFORE UPDATE ON knowledge_entries
WHEN NEW.org_id IS NOT OLD.org_id
  OR NEW.org_id IS NULL
  OR typeof(NEW.org_id)<>'integer'
  OR NEW.org_id<1
  OR NEW.org_id>9007199254740991
  OR NOT EXISTS (SELECT 1 FROM organizations organization WHERE organization.id=NEW.org_id)
BEGIN
  SELECT CASE
    WHEN NEW.org_id IS NOT OLD.org_id
      THEN RAISE(ABORT,'knowledge organization ownership is immutable')
    ELSE RAISE(ABORT,'knowledge organization ownership is required')
  END;
END`,
  knowledge_entries_no_replace_insert: `CREATE TRIGGER knowledge_entries_no_replace_insert
BEFORE INSERT ON knowledge_entries
WHEN EXISTS (
  SELECT 1
  FROM knowledge_entries existing
  WHERE existing.id=NEW.id
    OR (
      NEW.source_hash IS NOT NULL AND NEW.source_hash<>''
      AND existing.org_id=NEW.org_id
      AND existing.source_hash=NEW.source_hash
    )
    OR (
      NEW.source_identity_sha256 IS NOT NULL
      AND existing.org_id=NEW.org_id
      AND existing.source_identity_sha256=NEW.source_identity_sha256
    )
    OR (
      NEW.source_type='campaign_review'
      AND existing.source_type='campaign_review'
      AND existing.org_id=NEW.org_id
      AND CAST(existing.source_id AS TEXT)=CAST(NEW.source_id AS TEXT)
    )
)
BEGIN SELECT RAISE(ABORT,'knowledge entry cannot be replaced'); END`,
  campaign_record_links_knowledge_org_insert: `CREATE TRIGGER campaign_record_links_knowledge_org_insert
BEFORE INSERT ON campaign_record_links
WHEN NEW.record_type='knowledge_entry' AND NOT EXISTS (
  SELECT 1 FROM knowledge_entries entry
  WHERE entry.id=CAST(NEW.record_id AS INTEGER)
    AND entry.org_id=NEW.org_id
)
BEGIN SELECT RAISE(ABORT,'campaign knowledge organization mismatch'); END`,
  campaign_record_links_knowledge_org_update: `CREATE TRIGGER campaign_record_links_knowledge_org_update
BEFORE UPDATE ON campaign_record_links
WHEN NEW.record_type='knowledge_entry' AND NOT EXISTS (
  SELECT 1 FROM knowledge_entries entry
  WHERE entry.id=CAST(NEW.record_id AS INTEGER)
    AND entry.org_id=NEW.org_id
)
BEGIN SELECT RAISE(ABORT,'campaign knowledge organization mismatch'); END`,
  organization_knowledge_custody_org_insert: `CREATE TRIGGER organization_knowledge_custody_org_insert
BEFORE INSERT ON organization_knowledge_custody
WHEN NOT EXISTS (
  SELECT 1 FROM knowledge_entries entry
  WHERE entry.id=NEW.knowledge_entry_id AND entry.org_id=NEW.org_id
)
BEGIN SELECT RAISE(ABORT,'organization knowledge ownership mismatch'); END`,
  organization_knowledge_custody_org_update: `CREATE TRIGGER organization_knowledge_custody_org_update
BEFORE UPDATE ON organization_knowledge_custody
WHEN NOT EXISTS (
  SELECT 1 FROM knowledge_entries entry
  WHERE entry.id=NEW.knowledge_entry_id AND entry.org_id=NEW.org_id
)
BEGIN SELECT RAISE(ABORT,'organization knowledge ownership mismatch'); END`,
  trg_task7_current_custody_insert: `CREATE TRIGGER trg_task7_current_custody_insert
AFTER INSERT ON knowledge_current_custody
BEGIN
${currentCustodyCapacityBody('NEW', 1)}
END`,
  trg_task7_current_custody_delete: `CREATE TRIGGER trg_task7_current_custody_delete
AFTER DELETE ON knowledge_current_custody
BEGIN
${currentCustodyCapacityBody('OLD', -1)}
END`,
  trg_task7_knowledge_entry_insert: `CREATE TRIGGER trg_task7_knowledge_entry_insert
AFTER INSERT ON knowledge_entries
BEGIN
  INSERT INTO knowledge_entry_footprints (
    knowledge_entry_id,created_by,chunk_count,entry_payload_bytes,chunk_payload_bytes
  ) VALUES (NEW.id,NEW.created_by,0,${entryPayloadSql('NEW')},0);
${gaugeUpdate('user', 'entries', 'scope_id=NEW.created_by', '1')}
${gaugeUpdate('user', 'payload_bytes', 'scope_id=NEW.created_by', entryPayloadSql('NEW'))}
${gaugeUpdate('organization', 'entries', 'scope_id=NEW.org_id', '1')}
${gaugeUpdate('organization', 'payload_bytes', 'scope_id=NEW.org_id', entryPayloadSql('NEW'))}
  UPDATE knowledge_unlinked_user_usage
  SET entries=entries+1,
      payload_bytes=payload_bytes+(${entryPayloadSql('NEW')}),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=NEW.created_by;
END`,
  trg_task7_knowledge_entry_payload_update: `CREATE TRIGGER trg_task7_knowledge_entry_payload_update
AFTER UPDATE OF title,summary,content,key_terms,tags_json,metadata_json,embedding_json
ON knowledge_entries
BEGIN
${entryPayloadMutationBody('NEW', `(${entryPayloadSql('NEW')}) - (${entryPayloadSql('OLD')})`)}
  UPDATE knowledge_entry_footprints
  SET entry_payload_bytes=${entryPayloadSql('NEW')},updated_at=CURRENT_TIMESTAMP
  WHERE knowledge_entry_id=NEW.id;
END`,
  trg_task7_knowledge_entry_delete: `CREATE TRIGGER trg_task7_knowledge_entry_delete
BEFORE DELETE ON knowledge_entries
BEGIN
  DELETE FROM knowledge_chunks WHERE entry_id=OLD.id;
${gaugeUpdate('user', 'entries', `scope_id=${footprintValue('OLD.id', 'created_by')}`, '-1')}
${gaugeUpdate('user', 'payload_bytes', `scope_id=${footprintValue('OLD.id', 'created_by')}`, `-${footprintValue('OLD.id', 'entry_payload_bytes')}`)}
${gaugeUpdate('organization', 'entries', 'scope_id=OLD.org_id', '-1')}
${gaugeUpdate('organization', 'payload_bytes', 'scope_id=OLD.org_id', `-${footprintValue('OLD.id', 'entry_payload_bytes')}`)}
  UPDATE knowledge_unlinked_user_usage
  SET entries=entries-1,
      payload_bytes=payload_bytes-${footprintValue('OLD.id', 'entry_payload_bytes')},
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${footprintValue('OLD.id', 'created_by')} AND ${noCustody('OLD.id')};
END`,
  trg_task7_knowledge_chunk_insert: `CREATE TRIGGER trg_task7_knowledge_chunk_insert
AFTER INSERT ON knowledge_chunks
BEGIN
${chunkMutationBody('NEW', 1)}
END`,
  trg_task7_knowledge_chunk_delete: `CREATE TRIGGER trg_task7_knowledge_chunk_delete
AFTER DELETE ON knowledge_chunks
BEGIN
${chunkMutationBody('OLD', -1)}
END`,
  trg_task7_knowledge_chunk_payload_update: `CREATE TRIGGER trg_task7_knowledge_chunk_payload_update
AFTER UPDATE OF content,metadata_json,embedding_json ON knowledge_chunks
BEGIN
${chunkMutationBody('OLD', -1)}
${chunkMutationBody('NEW', 1)}
END`,
  trg_task7_membership_insert: `CREATE TRIGGER trg_task7_membership_insert
AFTER INSERT ON organization_memberships
BEGIN SELECT 1; END`,
  trg_task7_membership_delete: `CREATE TRIGGER trg_task7_membership_delete
AFTER DELETE ON organization_memberships
BEGIN SELECT 1; END`,
  trg_task7_reference_insert: `CREATE TRIGGER trg_task7_reference_insert
AFTER INSERT ON ai_references
BEGIN
${referenceMutationBody('NEW', 1)}
END`,
  trg_task7_reference_delete: `CREATE TRIGGER trg_task7_reference_delete
AFTER DELETE ON ai_references
BEGIN
${referenceMutationBody('OLD', -1)}
END`,
  organization_knowledge_custody_capacity_insert: `CREATE TRIGGER organization_knowledge_custody_capacity_insert
AFTER INSERT ON organization_knowledge_custody
BEGIN
  UPDATE knowledge_unlinked_user_usage
  SET entries=entries-1,
      chunks=chunks-(
        SELECT chunk_count FROM knowledge_entry_footprints
        WHERE knowledge_entry_id=NEW.knowledge_entry_id
      ),
      payload_bytes=payload_bytes-(
        SELECT entry_payload_bytes + chunk_payload_bytes
        FROM knowledge_entry_footprints
        WHERE knowledge_entry_id=NEW.knowledge_entry_id
      ),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=NEW.created_by AND NOT EXISTS (
    SELECT 1 FROM knowledge_current_custody
    WHERE knowledge_entry_id=NEW.knowledge_entry_id
  );
END`
});

const REPLACED_TRIGGER_NAMES = Object.freeze([
  'knowledge_entries_no_replace_insert',
  'trg_task7_current_custody_insert',
  'trg_task7_current_custody_delete',
  'trg_task7_knowledge_entry_insert',
  'trg_task7_knowledge_entry_payload_update',
  'trg_task7_knowledge_entry_delete',
  'trg_task7_knowledge_chunk_insert',
  'trg_task7_knowledge_chunk_delete',
  'trg_task7_knowledge_chunk_payload_update',
  'trg_task7_membership_insert',
  'trg_task7_membership_delete',
  'trg_task7_reference_insert',
  'trg_task7_reference_delete',
  'organization_knowledge_custody_capacity_insert'
]);

function encodedValue(value) {
  if (value === null) return ['null', ''];
  if (typeof value === 'object') return ['blob', value.toString('base64')];
  if (typeof value === 'number') return [Number.isInteger(value) ? 'integer' : 'real', String(value)];
  return ['text', String(value)];
}

function projectionDigest(db, domain, columns, query) {
  const rows = db.prepare(query).all();
  const hash = createHash('sha256');
  hash.update(`tm-knowledge-v24-${domain}-projection-v1\n`);
  for (const row of rows) {
    hash.update(JSON.stringify(columns.map((column) => encodedValue(row[column]))));
    hash.update('\n');
  }
  return { count: rows.length, sha256: hash.digest('hex') };
}

function legacyProjection(db) {
  return {
    entries: projectionDigest(
      db,
      'entries',
      LEGACY_ENTRY_COLUMNS,
      `SELECT ${LEGACY_ENTRY_COLUMNS.join(',')} FROM knowledge_entries ORDER BY id`
    ),
    chunks: projectionDigest(
      db,
      'chunks',
      LEGACY_CHUNK_COLUMNS,
      `SELECT ${LEGACY_CHUNK_COLUMNS.join(',')} FROM knowledge_chunks ORDER BY id`
    ),
    fts: projectionDigest(
      db,
      'fts',
      ['rowid', 'title', 'content', 'tags', 'entry_id', 'chunk_id'],
      `SELECT rowid,title,content,tags,entry_id,chunk_id
       FROM knowledge_chunks_fts ORDER BY rowid`
    )
  };
}

function resolveDefaultOrganizationId(db) {
  const organizations = db.prepare(`
    SELECT id,code,name,created_at
    FROM organizations
    ORDER BY id
  `).all();
  const namedDefault = organizations.filter((organization) => (
    organization.code === 'turingmarket-default'
  ));
  if (namedDefault.length === 1) return namedDefault[0].id;
  if (namedDefault.length > 1 || organizations.length === 0) {
    throw new Error('024 requires one unique default organization');
  }

  const sanitizedDefault = organizations.filter((organization) => (
    /^tm-inert-secret-[0-9a-f]{64}$/.test(organization.code) &&
    /^tmtext-[0-9a-f]{32}$/.test(organization.name) &&
    organization.created_at === '1970-01-01 00:00:00'
  ));
  if (sanitizedDefault.length !== 1 || sanitizedDefault[0].id !== organizations[0].id) {
    throw new Error('024 requires one unique default organization');
  }
  return sanitizedDefault[0].id;
}

function assertNoAuthorityConflict(db) {
  const invalidCampaignTarget = db.prepare(`
    SELECT link.id
    FROM campaign_record_links link
    LEFT JOIN knowledge_entries entry
      ON entry.id=CAST(link.record_id AS INTEGER)
    WHERE link.record_type='knowledge_entry' AND entry.id IS NULL
    ORDER BY link.id
    LIMIT 1
  `).get();
  if (invalidCampaignTarget) {
    throw new Error('024 knowledge Campaign custody target is invalid');
  }

  const conflict = db.prepare(`
    WITH authority_claims(knowledge_entry_id,org_id) AS (
      SELECT entry.id,link.org_id
      FROM knowledge_entries entry
      JOIN campaign_record_links link
        ON link.record_type='knowledge_entry'
       AND link.relation_type<>'shortlist'
       AND CAST(link.record_id AS INTEGER)=entry.id
      UNION ALL
      SELECT entry.id,custody.org_id
      FROM knowledge_entries entry
      JOIN organization_knowledge_custody custody
        ON custody.knowledge_entry_id=entry.id
      UNION ALL
      SELECT entry.id,organization.id
      FROM knowledge_entries entry
      JOIN organizations organization
        ON entry.business_type='organization'
       AND entry.business_id=CAST(organization.id AS TEXT)
    )
    SELECT knowledge_entry_id
    FROM authority_claims
    GROUP BY knowledge_entry_id
    HAVING COUNT(DISTINCT org_id)>1
    ORDER BY knowledge_entry_id
    LIMIT 1
  `).get();
  if (conflict) {
    throw new Error('conflicting authoritative knowledge organization custody');
  }
}

function backfillOwnership(db, defaultOrganizationId) {
  db.prepare(`
    UPDATE knowledge_entries AS entry
    SET org_id=COALESCE(
      (
        SELECT MIN(link.org_id)
        FROM campaign_record_links link
        WHERE link.record_type='knowledge_entry'
          AND link.relation_type<>'shortlist'
          AND CAST(link.record_id AS INTEGER)=entry.id
      ),
      (
        SELECT custody.org_id
        FROM organization_knowledge_custody custody
        WHERE custody.knowledge_entry_id=entry.id
      ),
      (
        SELECT organization.id
        FROM organizations organization
        WHERE entry.business_type='organization'
          AND entry.business_id=CAST(organization.id AS TEXT)
      ),
      @defaultOrganizationId
    )
    WHERE org_id IS NULL
  `).run({ defaultOrganizationId });
}

function rebuildOrganizationGauges(db) {
  db.exec(`
    WITH
    entry_usage AS MATERIALIZED (
      SELECT
        entry.org_id AS scope_id,
        COUNT(*) AS entries,
        COALESCE(SUM(footprint.chunk_count),0) AS chunks,
        COALESCE(SUM(footprint.entry_payload_bytes + footprint.chunk_payload_bytes),0)
          AS payload_bytes
      FROM knowledge_entries entry
      JOIN knowledge_entry_footprints footprint
        ON footprint.knowledge_entry_id=entry.id
      GROUP BY entry.org_id
    ),
    reference_usage_parts AS MATERIALIZED (
      SELECT campaign.org_id AS scope_id,COUNT(*) AS reference_count
      FROM ai_references reference
      JOIN campaigns campaign ON campaign.id=reference.campaign_id
      WHERE reference.campaign_id IS NOT NULL
      GROUP BY campaign.org_id
      UNION ALL
      SELECT entry.org_id AS scope_id,COUNT(*) AS reference_count
      FROM ai_references reference
      JOIN knowledge_entries entry ON entry.id=reference.knowledge_entry_id
      WHERE reference.campaign_id IS NULL
      GROUP BY entry.org_id
    ),
    reference_usage AS MATERIALIZED (
      SELECT scope_id,SUM(reference_count) AS reference_count
      FROM reference_usage_parts
      GROUP BY scope_id
    ),
    scope_usage AS MATERIALIZED (
      SELECT
        organization.id AS scope_id,
        COALESCE(entry.entries,0) AS entries,
        COALESCE(entry.chunks,0) AS chunks,
        COALESCE(entry.payload_bytes,0) AS payload_bytes,
        COALESCE(reference.reference_count,0) AS reference_count
      FROM organizations organization
      LEFT JOIN entry_usage entry ON entry.scope_id=organization.id
      LEFT JOIN reference_usage reference ON reference.scope_id=organization.id
    ),
    metric_usage(scope_id,metric,usage_value,limit_value) AS (
      SELECT scope_id,'entries',entries,500000 FROM scope_usage
      UNION ALL
      SELECT scope_id,'chunks',chunks,5000000 FROM scope_usage
      UNION ALL
      SELECT scope_id,'payload_bytes',payload_bytes,53687091200 FROM scope_usage
      UNION ALL
      SELECT scope_id,'references',reference_count,20000000 FROM scope_usage
    )
    INSERT INTO knowledge_capacity_gauges (
      scope_type,scope_id,metric,usage_value,limit_value,threshold_percent
    )
    SELECT
      'organization',scope_id,metric,usage_value,limit_value,
      CASE
        WHEN usage_value>=limit_value THEN 100
        WHEN usage_value*10>=limit_value*9 THEN 90
        WHEN usage_value*5>=limit_value*4 THEN 80
        ELSE 0
      END
    FROM metric_usage
    WHERE 1
    ON CONFLICT(scope_type,scope_id,metric) DO UPDATE SET
      usage_value=excluded.usage_value,
      limit_value=excluded.limit_value,
      threshold_percent=excluded.threshold_percent,
      updated_at=CURRENT_TIMESTAMP;
  `);
}

function assertLegacyReplacementShape(db) {
  for (const name of [
    'idx_knowledge_source_hash',
    'ux_knowledge_source_identity',
    'ux_knowledge_campaign_review_source'
  ]) {
    const sql = db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type='index' AND name=?
    `).get(name).sql;
    if (/\borg_id\b/i.test(sql)) {
      throw new Error('partial 024 knowledge ownership object exists');
    }
  }

  const noReplaceSql = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='knowledge_entries_no_replace_insert'
  `).get().sql;
  if (/existing\.org_id/i.test(noReplaceSql)) {
    throw new Error('partial 024 knowledge ownership object exists');
  }

  for (const name of REPLACED_TRIGGER_NAMES.slice(1)) {
    const sql = db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?
    `).get(name).sql;
    const isMembershipNoOp = name === 'trg_task7_membership_insert' ||
      name === 'trg_task7_membership_delete';
    if ((!isMembershipNoOp && !/organization_memberships/i.test(sql)) ||
        (isMembershipNoOp && /BEGIN\s+SELECT 1;\s+END/i.test(sql))) {
      throw new Error('partial 024 knowledge ownership object exists');
    }
  }
}

const migration = {
  version: 24,
  name: '024_knowledge_tenant_ownership',
  sourcePath: 'migrations/024_knowledge_tenant_ownership.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      knowledge_entries: {
        org_id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {}
  },
  apply(db) {
    const requiredTables = [
      'organizations',
      'knowledge_entries',
      'knowledge_chunks',
      'knowledge_chunks_fts',
      'campaign_record_links',
      'organization_knowledge_custody',
      'knowledge_current_custody',
      'knowledge_entry_footprints',
      'knowledge_unlinked_user_usage',
      'knowledge_capacity_gauges',
      'ai_conversations',
      'ai_messages',
      'ai_references',
      'campaigns'
    ];
    for (const name of requiredTables) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`024 requires ${name}`);
      }
    }

    const newObjectNames = [
      'ux_knowledge_entries_org_id',
      'idx_knowledge_entries_org_search_order',
      'knowledge_entries_org_scope_insert',
      'knowledge_entries_org_scope_update',
      'campaign_record_links_knowledge_org_insert',
      'campaign_record_links_knowledge_org_update',
      'organization_knowledge_custody_org_insert',
      'organization_knowledge_custody_org_update'
    ];
    const placeholders = newObjectNames.map(() => '?').join(',');
    const existingObject = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE name IN (${placeholders})
      ORDER BY name
      LIMIT 1
    `).get(...newObjectNames);
    const existingColumn = db.prepare(`
      SELECT 1 AS present
      FROM pragma_table_info('knowledge_entries')
      WHERE name='org_id'
    `).get();
    if (existingColumn || existingObject) {
      throw new Error('partial 024 knowledge ownership object exists');
    }

    const requiredObjects = [
      ['index', 'idx_knowledge_source_hash'],
      ['index', 'ux_knowledge_source_identity'],
      ['index', 'ux_knowledge_campaign_review_source'],
      ...REPLACED_TRIGGER_NAMES.map((name) => ['trigger', name])
    ];
    for (const [type, name] of requiredObjects) {
      if (!db.prepare('SELECT 1 AS present FROM sqlite_schema WHERE type=? AND name=?').get(type, name)) {
        throw new Error(`024 requires ${name}`);
      }
    }
    assertLegacyReplacementShape(db);

    const defaultOrganizationId = resolveDefaultOrganizationId(db);
    assertNoAuthorityConflict(db);
    const before = legacyProjection(db);

    db.exec(`
      ALTER TABLE knowledge_entries
      ADD COLUMN org_id INTEGER
        REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);
    backfillOwnership(db, defaultOrganizationId);

    const invalidOwnership = db.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_entries entry
      LEFT JOIN organizations organization ON organization.id=entry.org_id
      WHERE entry.org_id IS NULL
        OR typeof(entry.org_id)<>'integer'
        OR entry.org_id<1
        OR entry.org_id>9007199254740991
        OR organization.id IS NULL
    `).get().count;
    if (invalidOwnership !== 0) {
      throw new Error('024 knowledge organization ownership backfill is incomplete');
    }

    db.exec(`
      DROP INDEX idx_knowledge_source_hash;
      DROP INDEX ux_knowledge_source_identity;
      DROP INDEX ux_knowledge_campaign_review_source;
    `);
    for (const name of REPLACED_TRIGGER_NAMES) {
      db.exec(`DROP TRIGGER ${name};`);
    }
    db.exec([
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
    rebuildOrganizationGauges(db);

    const invalidCustody = db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT link.id
        FROM campaign_record_links link
        LEFT JOIN knowledge_entries entry ON entry.id=CAST(link.record_id AS INTEGER)
        WHERE link.record_type='knowledge_entry'
          AND (entry.id IS NULL OR link.org_id<>entry.org_id)
        UNION ALL
        SELECT custody.knowledge_entry_id
        FROM organization_knowledge_custody custody
        JOIN knowledge_entries entry ON entry.id=custody.knowledge_entry_id
        WHERE custody.org_id<>entry.org_id
      ) mismatch
    `).get().count;
    if (invalidCustody !== 0) {
      throw new Error('024 knowledge custody ownership validation failed');
    }

    const after = legacyProjection(db);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error('024 changed the legacy knowledge projection');
    }
  }
};

module.exports = migration;
