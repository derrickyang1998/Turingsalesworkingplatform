'use strict';

const CAPACITY_LIMITS = Object.freeze({
  user: Object.freeze({
    entries: 50000,
    chunks: 500000,
    payload_bytes: 5368709120,
    references: 2000000
  }),
  campaign: Object.freeze({
    entries: 100000,
    chunks: 1000000,
    payload_bytes: 10737418240,
    references: 4000000
  }),
  organization: Object.freeze({
    entries: 500000,
    chunks: 5000000,
    payload_bytes: 53687091200,
    references: 20000000
  })
});
const METRICS = Object.freeze(['entries', 'chunks', 'payload_bytes', 'references']);

const TABLE_SQL = Object.freeze({
  knowledge_current_custody: `CREATE TABLE knowledge_current_custody (
  knowledge_entry_id INTEGER PRIMARY KEY
    REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  link_id INTEGER NOT NULL UNIQUE
    REFERENCES campaign_record_links(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  bundle_id TEXT NOT NULL CHECK(length(bundle_id)=64 AND bundle_id NOT GLOB '*[^0-9a-f]*'),
  custody_state TEXT NOT NULL CHECK(custody_state IN ('active','revoke_only')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    length(updated_at)>0
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at
  )
) STRICT, WITHOUT ROWID`,
  knowledge_entry_footprints: `CREATE TABLE knowledge_entry_footprints (
  knowledge_entry_id INTEGER PRIMARY KEY
    REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id),
  chunk_count INTEGER NOT NULL CHECK(chunk_count>=0),
  entry_payload_bytes INTEGER NOT NULL CHECK(entry_payload_bytes>=0),
  chunk_payload_bytes INTEGER NOT NULL CHECK(chunk_payload_bytes>=0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    length(updated_at)>0
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at
  )
) STRICT, WITHOUT ROWID`,
  knowledge_unlinked_user_usage: `CREATE TABLE knowledge_unlinked_user_usage (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  entries INTEGER NOT NULL CHECK(entries>=0),
  chunks INTEGER NOT NULL CHECK(chunks>=0),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes>=0),
  unscoped_references INTEGER NOT NULL CHECK(unscoped_references>=0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    length(updated_at)>0
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at
  )
) STRICT, WITHOUT ROWID`
});

const INDEX_SQL = Object.freeze({
  idx_task7_knowledge_entries_unowned: `CREATE INDEX idx_task7_knowledge_entries_unowned
  ON knowledge_entries(created_by,id)
  WHERE created_by IS NULL`,
  idx_task7_campaign_record_links_knowledge_scope: `CREATE INDEX idx_task7_campaign_record_links_knowledge_scope
  ON campaign_record_links(campaign_id,revoked_at,record_id,id,org_id)
  WHERE record_type='knowledge_entry' AND relation_type<>'shortlist'`,
  idx_task7_current_custody_campaign: `CREATE INDEX idx_task7_current_custody_campaign
  ON knowledge_current_custody(campaign_id,knowledge_entry_id)`,
  idx_task7_current_custody_organization: `CREATE INDEX idx_task7_current_custody_organization
  ON knowledge_current_custody(org_id,knowledge_entry_id)`,
  idx_task7_knowledge_entries_search_order: `CREATE INDEX idx_task7_knowledge_entries_search_order
  ON knowledge_entries(usage_count DESC,updated_at DESC,id DESC)`
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
  ].map(function(column) {
    return `length(CAST(COALESCE(${alias}.${column},'') AS BLOB))`;
  }).join(' + ');
}

function chunkPayloadSql(alias) {
  return ['content', 'metadata_json', 'embedding_json'].map(function(column) {
    return `length(CAST(COALESCE(${alias}.${column},'') AS BLOB))`;
  }).join(' + ');
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

function unlinkedOrganizationPredicate(entryId) {
  const creator = footprintValue(entryId, 'created_by');
  return `scope_id IN (
    SELECT membership.org_id
    FROM organization_memberships membership
    WHERE membership.user_id=${creator}
    UNION
    SELECT organization.id
    FROM organizations organization
    WHERE ${creator} IS NULL AND organization.code='turingmarket-default'
  )`;
}

function updateUnlinkedUser(entryId, direction) {
  const creator = footprintValue(entryId, 'created_by');
  const sign = direction === 1 ? '' : '-';
  return `UPDATE knowledge_unlinked_user_usage
  SET entries=entries + (${sign}1),
      chunks=chunks + (${sign}${footprintValue(entryId, 'chunk_count')}),
      payload_bytes=payload_bytes + (${sign}${footprintTotal(entryId)}),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${creator};`;
}

function projectionCapacityBody(alias, direction) {
  const entryId = `${alias}.knowledge_entry_id`;
  const sign = direction === 1 ? '' : '-';
  const reverseSign = direction === 1 ? '-' : '';
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
    gaugeUpdate('organization', 'entries', unlinkedOrganizationPredicate(entryId), `${reverseSign}1`),
    gaugeUpdate(
      'organization',
      'chunks',
      unlinkedOrganizationPredicate(entryId),
      `${reverseSign}${footprintValue(entryId, 'chunk_count')}`
    ),
    gaugeUpdate(
      'organization',
      'payload_bytes',
      unlinkedOrganizationPredicate(entryId),
      `${reverseSign}${footprintTotal(entryId)}`
    ),
    gaugeUpdate('organization', 'entries', `scope_id=${alias}.org_id`, `${sign}1`),
    gaugeUpdate(
      'organization',
      'chunks',
      `scope_id=${alias}.org_id`,
      `${sign}${footprintValue(entryId, 'chunk_count')}`
    ),
    gaugeUpdate(
      'organization',
      'payload_bytes',
      `scope_id=${alias}.org_id`,
      `${sign}${footprintTotal(entryId)}`
    ),
    updateUnlinkedUser(entryId, -direction)
  ].join('\n');
}

function refreshProjection(recordIdExpression, predicate = null) {
  const guard = predicate ? ` AND (${predicate})` : '';
  return `DELETE FROM knowledge_current_custody
  WHERE knowledge_entry_id=CAST(${recordIdExpression} AS INTEGER)${guard};
INSERT INTO knowledge_current_custody (
  knowledge_entry_id,link_id,org_id,campaign_id,bundle_id,custody_state
)
SELECT
  entry.id,
  link.id,
  link.org_id,
  link.campaign_id,
  link.bundle_id,
  CASE WHEN link.revoked_at IS NULL THEN 'active' ELSE 'revoke_only' END
FROM knowledge_entries entry
JOIN campaign_record_links link ON link.id=COALESCE(
  (
    SELECT active.id
    FROM campaign_record_links active
    WHERE active.record_type='knowledge_entry'
      AND active.relation_type<>'shortlist'
      AND active.record_id=CAST(entry.id AS TEXT)
      AND active.revoked_at IS NULL
    ORDER BY active.id DESC
    LIMIT 1
  ),
  (
    SELECT historical.id
    FROM campaign_record_links historical
    WHERE historical.record_type='knowledge_entry'
      AND historical.relation_type<>'shortlist'
      AND historical.record_id=CAST(entry.id AS TEXT)
      AND historical.revoked_at IS NOT NULL
    ORDER BY historical.revoked_at DESC,historical.id DESC
    LIMIT 1
  )
)
WHERE entry.id=CAST(${recordIdExpression} AS INTEGER)${guard};`;
}

function entryOrganizationPredicate(entryAlias) {
  return `scope_id IN (
    SELECT membership.org_id
    FROM organization_memberships membership
    WHERE membership.user_id=${entryAlias}.created_by
    UNION
    SELECT organization.id
    FROM organizations organization
    WHERE ${entryAlias}.created_by IS NULL
      AND organization.code='turingmarket-default'
  )`;
}

function entryPayloadMutationBody(alias, delta) {
  const entryId = `${alias}.id`;
  const creator = `${alias}.created_by`;
  const noCustody = `NOT EXISTS (
    SELECT 1 FROM knowledge_current_custody
    WHERE knowledge_entry_id=${entryId}
  )`;
  return [
    gaugeUpdate('user', 'payload_bytes', `scope_id=${creator}`, delta),
    gaugeUpdate(
      'campaign',
      'payload_bytes',
      `scope_id=(SELECT campaign_id FROM knowledge_current_custody
        WHERE knowledge_entry_id=${entryId})`,
      delta
    ),
    gaugeUpdate(
      'organization',
      'payload_bytes',
      `scope_id=(SELECT org_id FROM knowledge_current_custody
        WHERE knowledge_entry_id=${entryId})`,
      delta
    ),
    gaugeUpdate(
      'organization',
      'payload_bytes',
      `${noCustody} AND ${entryOrganizationPredicate(alias)}`,
      delta
    ),
    `UPDATE knowledge_unlinked_user_usage
  SET payload_bytes=payload_bytes + (${delta}),updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${creator} AND ${noCustody};`
  ].join('\n');
}

function chunkMutationBody(alias, direction) {
  const entryId = `${alias}.entry_id`;
  const creator = footprintValue(entryId, 'created_by');
  const bytes = chunkPayloadSql(alias);
  const sign = direction === 1 ? '' : '-';
  const noCustody = `NOT EXISTS (
    SELECT 1 FROM knowledge_current_custody
    WHERE knowledge_entry_id=${entryId}
  )`;
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
    OR (scope_type='organization' AND (
      scope_id=(SELECT org_id FROM knowledge_current_custody
        WHERE knowledge_entry_id=${entryId})
      OR (${noCustody} AND ${unlinkedOrganizationPredicate(entryId)})
    ))
  );`,
    `UPDATE knowledge_unlinked_user_usage
  SET chunks=chunks + (${sign}1),
      payload_bytes=payload_bytes + (${sign}(${bytes})),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${creator} AND ${noCustody};`,
    `UPDATE knowledge_entry_footprints
  SET chunk_count=chunk_count + (${sign}1),
      chunk_payload_bytes=chunk_payload_bytes + (${sign}(${bytes})),
      updated_at=CURRENT_TIMESTAMP
  WHERE knowledge_entry_id=${entryId};`
  ].join('\n');
}

function scopeGaugeInsertBody(scopeType, idExpression) {
  return METRICS.map(function(metric) {
    return `INSERT INTO knowledge_capacity_gauges (
  scope_type,scope_id,metric,usage_value,limit_value,threshold_percent
) VALUES ('${scopeType}',${idExpression},'${metric}',0,${CAPACITY_LIMITS[scopeType][metric]},0);`;
  }).join('\n');
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
      `${alias}.campaign_id IS NOT NULL AND scope_id=(
        SELECT campaign.org_id FROM campaigns campaign
        WHERE campaign.id=${alias}.campaign_id
      )`,
      `${sign}1`
    ),
    gaugeUpdate(
      'organization',
      'references',
      `${alias}.campaign_id IS NULL AND scope_id IN (
        SELECT membership.org_id FROM organization_memberships membership
        WHERE membership.user_id=${userId}
      )`,
      `${sign}1`
    ),
    `UPDATE knowledge_unlinked_user_usage
  SET unscoped_references=unscoped_references + (${sign}1),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${userId} AND ${alias}.campaign_id IS NULL;`
  ].join('\n');
}

const COLLABORATION_COST_GUARD_NAME = 'campaign_settled_collaboration_cost_guard';
const COLLABORATION_COST_GUARD_SQL = `CREATE TRIGGER campaign_settled_collaboration_cost_guard
BEFORE UPDATE OF status,cost_actual,cost_actual_confirmed ON collaborations
WHEN (
  NEW.status='cancelled' AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type IN ('order','execution','publication','settlement')
      AND link.revoked_at IS NULL
  )
) OR (
  NEW.status IS NOT 'completed' AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type IN ('publication','settlement')
      AND link.revoked_at IS NULL
  )
) OR (
  NEW.cost_actual_confirmed<>1 AND EXISTS (
    SELECT 1
    FROM campaign_record_links link
    JOIN campaigns campaign
      ON campaign.org_id=link.org_id AND campaign.id=link.campaign_id
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type='settlement' AND link.revoked_at IS NULL
      AND campaign.lifecycle_state IN ('settled','reviewed')
  )
)
BEGIN
  SELECT CASE WHEN NEW.status='cancelled' AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type IN ('order','execution','publication','settlement')
      AND link.revoked_at IS NULL
  ) THEN RAISE(ABORT,'cancelled collaboration cannot retain active campaign aliases') END;
  SELECT CASE WHEN NEW.status IS NOT 'completed' AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type IN ('publication','settlement')
      AND link.revoked_at IS NULL
  ) THEN RAISE(ABORT,'published or settled collaboration must remain completed') END;
  SELECT CASE WHEN NEW.cost_actual_confirmed<>1 AND EXISTS (
    SELECT 1
    FROM campaign_record_links link
    JOIN campaigns campaign
      ON campaign.org_id=link.org_id AND campaign.id=link.campaign_id
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type='settlement' AND link.revoked_at IS NULL
      AND campaign.lifecycle_state IN ('settled','reviewed')
  ) THEN RAISE(ABORT,'settled campaign collaboration cost must remain confirmed') END;
END`;

const TRIGGER_SQL = Object.freeze({
  trg_task7_current_custody_insert: `CREATE TRIGGER trg_task7_current_custody_insert
AFTER INSERT ON knowledge_current_custody
BEGIN
${projectionCapacityBody('NEW', 1)}
END`,
  trg_task7_current_custody_delete: `CREATE TRIGGER trg_task7_current_custody_delete
AFTER DELETE ON knowledge_current_custody
BEGIN
${projectionCapacityBody('OLD', -1)}
END`,
  trg_task7_knowledge_link_insert: `CREATE TRIGGER trg_task7_knowledge_link_insert
AFTER INSERT ON campaign_record_links
WHEN NEW.record_type='knowledge_entry' AND NEW.relation_type<>'shortlist'
BEGIN
${refreshProjection('NEW.record_id')}
END`,
  trg_task7_knowledge_link_update: `CREATE TRIGGER trg_task7_knowledge_link_update
AFTER UPDATE OF record_type,relation_type,record_id,revoked_at,org_id,campaign_id,bundle_id
ON campaign_record_links
WHEN (OLD.record_type='knowledge_entry' AND OLD.relation_type<>'shortlist')
  OR (NEW.record_type='knowledge_entry' AND NEW.relation_type<>'shortlist')
BEGIN
${refreshProjection('OLD.record_id')}
${refreshProjection('NEW.record_id', 'NEW.record_id IS NOT OLD.record_id')}
END`,
  trg_task7_knowledge_link_delete: `CREATE TRIGGER trg_task7_knowledge_link_delete
AFTER DELETE ON campaign_record_links
WHEN OLD.record_type='knowledge_entry' AND OLD.relation_type<>'shortlist'
BEGIN
${refreshProjection('OLD.record_id')}
END`,
  trg_task7_knowledge_entry_insert: `CREATE TRIGGER trg_task7_knowledge_entry_insert
AFTER INSERT ON knowledge_entries
BEGIN
  INSERT INTO knowledge_entry_footprints (
    knowledge_entry_id,created_by,chunk_count,entry_payload_bytes,chunk_payload_bytes
  ) VALUES (NEW.id,NEW.created_by,0,${entryPayloadSql('NEW')},0);
${gaugeUpdate('user', 'entries', 'scope_id=NEW.created_by', '1')}
${gaugeUpdate('user', 'payload_bytes', 'scope_id=NEW.created_by', entryPayloadSql('NEW'))}
${gaugeUpdate('organization', 'entries', entryOrganizationPredicate('NEW'), '1')}
${gaugeUpdate('organization', 'payload_bytes', entryOrganizationPredicate('NEW'), entryPayloadSql('NEW'))}
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
  trg_task7_knowledge_entry_creator_immutable: `CREATE TRIGGER trg_task7_knowledge_entry_creator_immutable
BEFORE UPDATE OF created_by ON knowledge_entries
WHEN NEW.created_by IS NOT OLD.created_by
BEGIN SELECT RAISE(ABORT,'knowledge entry creator is immutable after capacity authority'); END`,
  trg_task7_knowledge_entry_delete: `CREATE TRIGGER trg_task7_knowledge_entry_delete
BEFORE DELETE ON knowledge_entries
BEGIN
  DELETE FROM knowledge_chunks WHERE entry_id=OLD.id;
${gaugeUpdate('user', 'entries', `scope_id=${footprintValue('OLD.id', 'created_by')}`, '-1')}
${gaugeUpdate('user', 'payload_bytes', `scope_id=${footprintValue('OLD.id', 'created_by')}`, `-${footprintValue('OLD.id', 'entry_payload_bytes')}`)}
${gaugeUpdate('organization', 'entries', unlinkedOrganizationPredicate('OLD.id'), '-1')}
${gaugeUpdate('organization', 'payload_bytes', unlinkedOrganizationPredicate('OLD.id'), `-${footprintValue('OLD.id', 'entry_payload_bytes')}`)}
  UPDATE knowledge_unlinked_user_usage
  SET entries=entries-1,
      payload_bytes=payload_bytes-${footprintValue('OLD.id', 'entry_payload_bytes')},
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${footprintValue('OLD.id', 'created_by')};
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
  trg_task7_knowledge_chunk_entry_immutable: `CREATE TRIGGER trg_task7_knowledge_chunk_entry_immutable
BEFORE UPDATE OF entry_id ON knowledge_chunks
WHEN NEW.entry_id IS NOT OLD.entry_id
BEGIN SELECT RAISE(ABORT,'knowledge chunk entry is immutable after capacity authority'); END`,
  trg_task7_user_capacity_scope: `CREATE TRIGGER trg_task7_user_capacity_scope
AFTER INSERT ON users
BEGIN
${scopeGaugeInsertBody('user', 'NEW.id')}
  INSERT INTO knowledge_unlinked_user_usage (
    user_id,entries,chunks,payload_bytes,unscoped_references
  ) VALUES (NEW.id,0,0,0,0);
END`,
  trg_task7_campaign_capacity_scope: `CREATE TRIGGER trg_task7_campaign_capacity_scope
AFTER INSERT ON campaigns
BEGIN
${scopeGaugeInsertBody('campaign', 'NEW.id')}
END`,
  trg_task7_organization_capacity_scope: `CREATE TRIGGER trg_task7_organization_capacity_scope
AFTER INSERT ON organizations
BEGIN
${scopeGaugeInsertBody('organization', 'NEW.id')}
END`,
  trg_task7_user_capacity_scope_delete: `CREATE TRIGGER trg_task7_user_capacity_scope_delete
AFTER DELETE ON users
BEGIN
  DELETE FROM knowledge_capacity_gauges WHERE scope_type='user' AND scope_id=OLD.id;
END`,
  trg_task7_campaign_capacity_scope_delete: `CREATE TRIGGER trg_task7_campaign_capacity_scope_delete
AFTER DELETE ON campaigns
BEGIN
  DELETE FROM knowledge_capacity_gauges WHERE scope_type='campaign' AND scope_id=OLD.id;
END`,
  trg_task7_organization_capacity_scope_delete: `CREATE TRIGGER trg_task7_organization_capacity_scope_delete
AFTER DELETE ON organizations
BEGIN
  DELETE FROM knowledge_capacity_gauges WHERE scope_type='organization' AND scope_id=OLD.id;
END`,
  trg_task7_membership_insert: `CREATE TRIGGER trg_task7_membership_insert
AFTER INSERT ON organization_memberships
BEGIN
${gaugeUpdate('organization', 'entries', 'scope_id=NEW.org_id', `(SELECT entries FROM knowledge_unlinked_user_usage WHERE user_id=NEW.user_id)`)}
${gaugeUpdate('organization', 'chunks', 'scope_id=NEW.org_id', `(SELECT chunks FROM knowledge_unlinked_user_usage WHERE user_id=NEW.user_id)`)}
${gaugeUpdate('organization', 'payload_bytes', 'scope_id=NEW.org_id', `(SELECT payload_bytes FROM knowledge_unlinked_user_usage WHERE user_id=NEW.user_id)`)}
${gaugeUpdate('organization', 'references', 'scope_id=NEW.org_id', `(SELECT unscoped_references FROM knowledge_unlinked_user_usage WHERE user_id=NEW.user_id)`)}
END`,
  trg_task7_membership_delete: `CREATE TRIGGER trg_task7_membership_delete
AFTER DELETE ON organization_memberships
BEGIN
${gaugeUpdate('organization', 'entries', 'scope_id=OLD.org_id', `-(SELECT entries FROM knowledge_unlinked_user_usage WHERE user_id=OLD.user_id)`)}
${gaugeUpdate('organization', 'chunks', 'scope_id=OLD.org_id', `-(SELECT chunks FROM knowledge_unlinked_user_usage WHERE user_id=OLD.user_id)`)}
${gaugeUpdate('organization', 'payload_bytes', 'scope_id=OLD.org_id', `-(SELECT payload_bytes FROM knowledge_unlinked_user_usage WHERE user_id=OLD.user_id)`)}
${gaugeUpdate('organization', 'references', 'scope_id=OLD.org_id', `-(SELECT unscoped_references FROM knowledge_unlinked_user_usage WHERE user_id=OLD.user_id)`)}
END`,
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
  trg_task7_reference_attribution_immutable: `CREATE TRIGGER trg_task7_reference_attribution_immutable
BEFORE UPDATE OF message_id,campaign_id ON ai_references
WHEN NEW.message_id IS NOT OLD.message_id OR NEW.campaign_id IS NOT OLD.campaign_id
BEGIN SELECT RAISE(ABORT,'knowledge reference attribution is immutable'); END`
});

const SCHEMA_TRIGGER_SQL = Object.freeze({
  ...TRIGGER_SQL,
  [COLLABORATION_COST_GUARD_NAME]: COLLABORATION_COST_GUARD_SQL
});

function capacityGaugeUpsertSql(scopeType, usageCtes) {
  const limits = CAPACITY_LIMITS[scopeType];
  return `WITH ${usageCtes},
  metric_usage(scope_id,metric,usage_value,limit_value) AS (
    SELECT scope_id,'entries',entries,${limits.entries} FROM scope_usage
    UNION ALL
    SELECT scope_id,'chunks',chunks,${limits.chunks} FROM scope_usage
    UNION ALL
    SELECT scope_id,'payload_bytes',payload_bytes,${limits.payload_bytes} FROM scope_usage
    UNION ALL
    SELECT scope_id,'references',reference_count,${limits.references} FROM scope_usage
  )
    INSERT INTO knowledge_capacity_gauges (
      scope_type,scope_id,metric,usage_value,limit_value,threshold_percent
    )
    SELECT
      '${scopeType}',scope_id,metric,usage_value,limit_value,
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
      updated_at=CURRENT_TIMESTAMP`;
}

function rewriteGauges(db, defaultOrganizationId) {
  db.exec(capacityGaugeUpsertSql('user', `
    user_reference_usage AS MATERIALIZED (
      SELECT conversation.user_id AS scope_id,COUNT(*) AS reference_count
      FROM ai_references reference
      JOIN ai_messages message ON message.id=reference.message_id
      JOIN ai_conversations conversation ON conversation.id=message.conversation_id
      GROUP BY conversation.user_id
    ),
    scope_usage AS MATERIALIZED (
      SELECT
        user.id AS scope_id,
        COUNT(footprint.knowledge_entry_id) AS entries,
        COALESCE(SUM(footprint.chunk_count),0) AS chunks,
        COALESCE(SUM(footprint.entry_payload_bytes + footprint.chunk_payload_bytes),0)
          AS payload_bytes,
        COALESCE(reference_usage.reference_count,0) AS reference_count
      FROM users user
      LEFT JOIN knowledge_entry_footprints footprint ON footprint.created_by=user.id
      LEFT JOIN user_reference_usage reference_usage ON reference_usage.scope_id=user.id
      GROUP BY user.id,reference_usage.reference_count
    )
  `));

  db.exec(capacityGaugeUpsertSql('campaign', `
    campaign_entry_usage AS MATERIALIZED (
      SELECT
        custody.campaign_id AS scope_id,
        COUNT(*) AS entries,
        COALESCE(SUM(footprint.chunk_count),0) AS chunks,
        COALESCE(SUM(footprint.entry_payload_bytes + footprint.chunk_payload_bytes),0)
          AS payload_bytes
      FROM knowledge_current_custody custody
      JOIN knowledge_entry_footprints footprint
        ON footprint.knowledge_entry_id=custody.knowledge_entry_id
      GROUP BY custody.campaign_id
    ),
    campaign_reference_usage AS MATERIALIZED (
      SELECT reference.campaign_id AS scope_id,COUNT(*) AS reference_count
      FROM ai_references reference
      WHERE reference.campaign_id IS NOT NULL
      GROUP BY reference.campaign_id
    ),
    scope_usage AS MATERIALIZED (
      SELECT
        campaign.id AS scope_id,
        COALESCE(entry_usage.entries,0) AS entries,
        COALESCE(entry_usage.chunks,0) AS chunks,
        COALESCE(entry_usage.payload_bytes,0) AS payload_bytes,
        COALESCE(reference_usage.reference_count,0) AS reference_count
      FROM campaigns campaign
      LEFT JOIN campaign_entry_usage entry_usage ON entry_usage.scope_id=campaign.id
      LEFT JOIN campaign_reference_usage reference_usage
        ON reference_usage.scope_id=campaign.id
    )
  `));

  db.prepare(capacityGaugeUpsertSql('organization', `
    custody_usage AS MATERIALIZED (
      SELECT
        custody.org_id AS scope_id,
        COUNT(*) AS entries,
        COALESCE(SUM(footprint.chunk_count),0) AS chunks,
        COALESCE(SUM(footprint.entry_payload_bytes + footprint.chunk_payload_bytes),0)
          AS payload_bytes
      FROM knowledge_current_custody custody
      JOIN knowledge_entry_footprints footprint
        ON footprint.knowledge_entry_id=custody.knowledge_entry_id
      GROUP BY custody.org_id
    ),
    member_usage AS MATERIALIZED (
      SELECT
        membership.org_id AS scope_id,
        COALESCE(SUM(usage.entries),0) AS entries,
        COALESCE(SUM(usage.chunks),0) AS chunks,
        COALESCE(SUM(usage.payload_bytes),0) AS payload_bytes,
        COALESCE(SUM(usage.unscoped_references),0) AS reference_count
      FROM organization_memberships membership
      JOIN knowledge_unlinked_user_usage usage ON usage.user_id=membership.user_id
      GROUP BY membership.org_id
    ),
    unowned_usage AS MATERIALIZED (
      SELECT
        COUNT(footprint.knowledge_entry_id) AS entries,
        COALESCE(SUM(footprint.chunk_count),0) AS chunks,
        COALESCE(SUM(footprint.entry_payload_bytes + footprint.chunk_payload_bytes),0)
          AS payload_bytes
      FROM knowledge_entry_footprints footprint
      LEFT JOIN knowledge_current_custody custody
        ON custody.knowledge_entry_id=footprint.knowledge_entry_id
      WHERE footprint.created_by IS NULL AND custody.knowledge_entry_id IS NULL
    ),
    campaign_reference_usage AS MATERIALIZED (
      SELECT campaign.org_id AS scope_id,COUNT(*) AS reference_count
      FROM ai_references reference
      JOIN campaigns campaign ON campaign.id=reference.campaign_id
      GROUP BY campaign.org_id
    ),
    scope_usage AS MATERIALIZED (
      SELECT
        organization.id AS scope_id,
        COALESCE(custody.entries,0) + COALESCE(member.entries,0) +
          CASE WHEN organization.id=@defaultOrganizationId THEN unowned.entries ELSE 0 END
          AS entries,
        COALESCE(custody.chunks,0) + COALESCE(member.chunks,0) +
          CASE WHEN organization.id=@defaultOrganizationId THEN unowned.chunks ELSE 0 END
          AS chunks,
        COALESCE(custody.payload_bytes,0) + COALESCE(member.payload_bytes,0) +
          CASE WHEN organization.id=@defaultOrganizationId THEN unowned.payload_bytes ELSE 0 END
          AS payload_bytes,
        COALESCE(campaign_reference.reference_count,0) +
          COALESCE(member.reference_count,0) AS reference_count
      FROM organizations organization
      LEFT JOIN custody_usage custody ON custody.scope_id=organization.id
      LEFT JOIN member_usage member ON member.scope_id=organization.id
      LEFT JOIN campaign_reference_usage campaign_reference
        ON campaign_reference.scope_id=organization.id
      CROSS JOIN unowned_usage unowned
    )
  `)).run({ defaultOrganizationId });
}

const migration = {
  version: 5,
  name: '005_knowledge_custody_projection',
  sourcePath: 'migrations/005_knowledge_custody_projection.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      knowledge_current_custody: {
        knowledge_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        link_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        bundle_id: { type: 'TEXT', notnull: 1, defaultValue: null },
        custody_state: { type: 'TEXT', notnull: 1, defaultValue: null },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      knowledge_entry_footprints: {
        knowledge_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        chunk_count: { type: 'INTEGER', notnull: 1, defaultValue: null },
        entry_payload_bytes: { type: 'INTEGER', notnull: 1, defaultValue: null },
        chunk_payload_bytes: { type: 'INTEGER', notnull: 1, defaultValue: null },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      knowledge_unlinked_user_usage: {
        user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        entries: { type: 'INTEGER', notnull: 1, defaultValue: null },
        chunks: { type: 'INTEGER', notnull: 1, defaultValue: null },
        payload_bytes: { type: 'INTEGER', notnull: 1, defaultValue: null },
        unscoped_references: { type: 'INTEGER', notnull: 1, defaultValue: null },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: SCHEMA_TRIGGER_SQL,
    tableChecks: {
      knowledge_current_custody: [
        "CHECK(length(bundle_id)=64 AND bundle_id NOT GLOB '*[^0-9a-f]*')",
        "CHECK(custody_state IN ('active','revoke_only'))"
      ],
      knowledge_entry_footprints: [
        'CHECK(chunk_count>=0)',
        'CHECK(entry_payload_bytes>=0)',
        'CHECK(chunk_payload_bytes>=0)'
      ],
      knowledge_unlinked_user_usage: [
        'CHECK(entries>=0)',
        'CHECK(chunks>=0)',
        'CHECK(payload_bytes>=0)',
        'CHECK(unscoped_references>=0)'
      ]
    }
  },
  apply(db) {
    const required = [
      'knowledge_capacity_gauges',
      'knowledge_entries',
      'knowledge_chunks',
      'campaign_record_links',
      'organization_memberships',
      'ai_references'
    ];
    for (const name of required) {
      const row = db.prepare(`
        SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?
      `).get(name);
      if (!row) throw new Error(`005 requires ${name}`);
    }
    const objectNames = [
      ...Object.keys(TABLE_SQL),
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE name IN (${placeholders})
      ORDER BY name
    `).all(...objectNames);
    if (existing.length > 0) {
      throw new Error(`partial 005 object exists: ${existing[0].name}`);
    }
    const defaultOrganizations = db.prepare(`
      SELECT id FROM organizations WHERE code='turingmarket-default'
    `).all();
    if (defaultOrganizations.length !== 1) {
      throw new Error('005 requires exactly one turingmarket-default organization');
    }
    const ambiguous = db.prepare(`
      SELECT record_id
      FROM campaign_record_links
      WHERE record_type='knowledge_entry'
        AND relation_type<>'shortlist'
        AND revoked_at IS NULL
      GROUP BY record_id
      HAVING COUNT(DISTINCT CAST(org_id AS TEXT) || ':' ||
        CAST(campaign_id AS TEXT) || ':' || bundle_id)>1
      LIMIT 1
    `).get();
    if (ambiguous) throw new Error('005 active knowledge custody is ambiguous');

    db.exec(`${Object.values(TABLE_SQL).join(';\n')};\n${Object.values(INDEX_SQL).join(';\n')};`);
    db.exec(`
      INSERT INTO knowledge_entry_footprints (
        knowledge_entry_id,created_by,chunk_count,entry_payload_bytes,chunk_payload_bytes
      )
      SELECT
        entry.id,
        entry.created_by,
        COUNT(chunk.id),
        ${entryPayloadSql('entry')},
        COALESCE(SUM(${chunkPayloadSql('chunk')}),0)
      FROM knowledge_entries entry
      LEFT JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
      GROUP BY entry.id;

      INSERT INTO knowledge_current_custody (
        knowledge_entry_id,link_id,org_id,campaign_id,bundle_id,custody_state
      )
      SELECT
        entry.id,
        link.id,
        link.org_id,
        link.campaign_id,
        link.bundle_id,
        CASE WHEN link.revoked_at IS NULL THEN 'active' ELSE 'revoke_only' END
      FROM knowledge_entries entry
      JOIN campaign_record_links link ON link.id=COALESCE(
        (
          SELECT active.id FROM campaign_record_links active
          WHERE active.record_type='knowledge_entry'
            AND active.relation_type<>'shortlist'
            AND active.record_id=CAST(entry.id AS TEXT)
            AND active.revoked_at IS NULL
          ORDER BY active.id DESC LIMIT 1
        ),
        (
          SELECT historical.id FROM campaign_record_links historical
          WHERE historical.record_type='knowledge_entry'
            AND historical.relation_type<>'shortlist'
            AND historical.record_id=CAST(entry.id AS TEXT)
            AND historical.revoked_at IS NOT NULL
          ORDER BY historical.revoked_at DESC,historical.id DESC LIMIT 1
        )
      );

      INSERT INTO knowledge_unlinked_user_usage (
        user_id,entries,chunks,payload_bytes,unscoped_references
      )
      SELECT
        user.id,
        COALESCE(SUM(CASE WHEN footprint.knowledge_entry_id IS NOT NULL
          AND custody.knowledge_entry_id IS NULL
          THEN 1 ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN footprint.knowledge_entry_id IS NOT NULL
          AND custody.knowledge_entry_id IS NULL
          THEN footprint.chunk_count ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN footprint.knowledge_entry_id IS NOT NULL
          AND custody.knowledge_entry_id IS NULL
          THEN footprint.entry_payload_bytes + footprint.chunk_payload_bytes
          ELSE 0 END),0),
        (
          SELECT COUNT(*)
          FROM ai_references reference
          JOIN ai_messages message ON message.id=reference.message_id
          JOIN ai_conversations conversation ON conversation.id=message.conversation_id
          WHERE conversation.user_id=user.id AND reference.campaign_id IS NULL
        )
      FROM users user
      LEFT JOIN knowledge_entry_footprints footprint ON footprint.created_by=user.id
      LEFT JOIN knowledge_current_custody custody
        ON custody.knowledge_entry_id=footprint.knowledge_entry_id
      GROUP BY user.id;
    `);
    rewriteGauges(db, defaultOrganizations[0].id);
    db.exec(`DROP TRIGGER IF EXISTS ${COLLABORATION_COST_GUARD_NAME};\n` +
      `${COLLABORATION_COST_GUARD_SQL};\n${Object.values(TRIGGER_SQL).join(';\n')};`);

    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM knowledge_entries) AS entries,
        (SELECT COUNT(*) FROM knowledge_entry_footprints) AS footprints,
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM knowledge_unlinked_user_usage) AS user_usage
    `).get();
    if (counts.entries !== counts.footprints || counts.users !== counts.user_usage) {
      throw new Error('005 capacity authority backfill is incomplete');
    }
  }
};

module.exports = migration;
