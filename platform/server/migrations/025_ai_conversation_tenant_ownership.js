'use strict';

const { createHash } = require('node:crypto');

const LEGACY_CONVERSATION_COLUMNS = Object.freeze([
  'id',
  'user_id',
  'title',
  'visibility',
  'source_module',
  'archived_summary_id',
  'created_at',
  'updated_at'
]);
const MESSAGE_COLUMNS = Object.freeze([
  'id',
  'conversation_id',
  'user_id',
  'role',
  'content',
  'model',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'metadata_json',
  'created_at'
]);
const REFERENCE_COLUMNS = Object.freeze([
  'id',
  'message_id',
  'reference_type',
  'reference_id',
  'title',
  'url',
  'snippet',
  'provider',
  'metadata_json',
  'created_at',
  'reference_schema_version',
  'knowledge_entry_id',
  'knowledge_chunk_id',
  'campaign_id',
  'source_identity_sha256',
  'entry_content_sha256',
  'chunk_content_sha256',
  'reference_rank',
  'selection_origin'
]);
const LINK_COLUMNS = Object.freeze([
  'id',
  'org_id',
  'campaign_id',
  'record_type',
  'bundle_id',
  'record_id',
  'relation_type',
  'created_by',
  'created_at',
  'revoked_at',
  'revoked_by',
  'revoke_reason',
  'metadata_json'
]);

const INDEX_SQL = Object.freeze({
  ux_ai_conversations_org_id: `CREATE UNIQUE INDEX ux_ai_conversations_org_id
    ON ai_conversations(org_id,id)`,
  idx_ai_conversations_org_owner_updated: `CREATE INDEX idx_ai_conversations_org_owner_updated
    ON ai_conversations(org_id,user_id,updated_at DESC,id DESC)`
});

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

function referenceConversationValue(alias, column) {
  return `(SELECT conversation.${column}
    FROM ai_messages message
    JOIN ai_conversations conversation ON conversation.id=message.conversation_id
    WHERE message.id=${alias}.message_id)`;
}

function referenceMutationBody(alias, direction) {
  const sign = direction === 1 ? '' : '-';
  const userId = referenceConversationValue(alias, 'user_id');
  const organizationId = referenceConversationValue(alias, 'org_id');
  return [
    gaugeUpdate('user', 'references', `scope_id=${userId}`, `${sign}1`),
    gaugeUpdate(
      'campaign',
      'references',
      `${alias}.campaign_id IS NOT NULL AND scope_id=${alias}.campaign_id`,
      `${sign}1`
    ),
    gaugeUpdate('organization', 'references', `scope_id=${organizationId}`, `${sign}1`),
    `UPDATE knowledge_unlinked_user_usage
  SET unscoped_references=unscoped_references + (${sign}1),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=${userId} AND ${alias}.campaign_id IS NULL;`
  ].join('\n');
}

const TRIGGER_SQL = Object.freeze({
  ai_conversations_no_replace_insert: `CREATE TRIGGER ai_conversations_no_replace_insert
BEFORE INSERT ON ai_conversations
WHEN EXISTS (SELECT 1 FROM ai_conversations existing WHERE existing.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'AI conversation cannot be replaced'); END`,
  ai_conversations_org_scope_insert: `CREATE TRIGGER ai_conversations_org_scope_insert
BEFORE INSERT ON ai_conversations
BEGIN
  SELECT CASE WHEN
    NEW.org_id IS NULL
    OR typeof(NEW.org_id)<>'integer'
    OR NEW.org_id<1
    OR NEW.org_id>9007199254740991
    OR NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW.org_id)
  THEN RAISE(ABORT,'AI conversation organization ownership is required') END;
  SELECT CASE WHEN NEW.archived_summary_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM knowledge_entries entry
    WHERE entry.id=NEW.archived_summary_id AND entry.org_id=NEW.org_id
  ) THEN RAISE(ABORT,'AI conversation archived summary ownership mismatch') END;
END`,
  ai_conversations_org_scope_update: `CREATE TRIGGER ai_conversations_org_scope_update
BEFORE UPDATE OF org_id,archived_summary_id ON ai_conversations
BEGIN
  SELECT CASE WHEN
    NEW.org_id IS NOT OLD.org_id
    OR NEW.org_id IS NULL
    OR typeof(NEW.org_id)<>'integer'
    OR NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW.org_id)
  THEN RAISE(ABORT,'AI conversation organization ownership is immutable') END;
  SELECT CASE WHEN NEW.archived_summary_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM knowledge_entries entry
    WHERE entry.id=NEW.archived_summary_id AND entry.org_id=NEW.org_id
  ) THEN RAISE(ABORT,'AI conversation archived summary ownership mismatch') END;
END`,
  ai_messages_no_replace_insert: `CREATE TRIGGER ai_messages_no_replace_insert
BEFORE INSERT ON ai_messages
WHEN EXISTS (SELECT 1 FROM ai_messages existing WHERE existing.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'AI message cannot be replaced'); END`,
  ai_messages_conversation_owner_insert: `CREATE TRIGGER ai_messages_conversation_owner_insert
BEFORE INSERT ON ai_messages
WHEN NOT EXISTS (
  SELECT 1 FROM ai_conversations conversation
  WHERE conversation.id=NEW.conversation_id AND conversation.user_id=NEW.user_id
)
BEGIN SELECT RAISE(ABORT,'AI message conversation ownership mismatch'); END`,
  ai_messages_conversation_owner_update: `CREATE TRIGGER ai_messages_conversation_owner_update
BEFORE UPDATE OF conversation_id,user_id ON ai_messages
WHEN NEW.conversation_id IS NOT OLD.conversation_id OR NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT,'AI message conversation ownership is immutable'); END`,
  campaign_record_links_ai_conversation_org_insert: `CREATE TRIGGER campaign_record_links_ai_conversation_org_insert
BEFORE INSERT ON campaign_record_links
WHEN NEW.record_type='ai_conversation' AND (
  NEW.record_id<>CAST(CAST(NEW.record_id AS INTEGER) AS TEXT)
  OR NOT EXISTS (
    SELECT 1 FROM ai_conversations conversation
    WHERE conversation.id=CAST(NEW.record_id AS INTEGER)
      AND conversation.org_id=NEW.org_id
  )
)
BEGIN SELECT RAISE(ABORT,'AI conversation Campaign ownership mismatch'); END`,
  campaign_record_links_ai_conversation_org_update: `CREATE TRIGGER campaign_record_links_ai_conversation_org_update
BEFORE UPDATE OF org_id,record_type,record_id ON campaign_record_links
WHEN NEW.record_type='ai_conversation' AND (
  NEW.record_id<>CAST(CAST(NEW.record_id AS INTEGER) AS TEXT)
  OR NOT EXISTS (
    SELECT 1 FROM ai_conversations conversation
    WHERE conversation.id=CAST(NEW.record_id AS INTEGER)
      AND conversation.org_id=NEW.org_id
  )
)
BEGIN SELECT RAISE(ABORT,'AI conversation Campaign ownership mismatch'); END`,
  ai_references_conversation_org_insert: `CREATE TRIGGER ai_references_conversation_org_insert
BEFORE INSERT ON ai_references
WHEN
  (NEW.campaign_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM ai_messages message
    JOIN ai_conversations conversation ON conversation.id=message.conversation_id
    JOIN campaigns campaign ON campaign.id=NEW.campaign_id
    WHERE message.id=NEW.message_id AND campaign.org_id=conversation.org_id
  ))
  OR (NEW.knowledge_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM ai_messages message
    JOIN ai_conversations conversation ON conversation.id=message.conversation_id
    JOIN knowledge_entries entry ON entry.id=NEW.knowledge_entry_id
    WHERE message.id=NEW.message_id AND entry.org_id=conversation.org_id
  ))
  OR (NEW.reference_type='knowledge' AND NEW.knowledge_entry_id IS NULL AND NOT EXISTS (
    SELECT 1
    FROM ai_messages message
    JOIN ai_conversations conversation ON conversation.id=message.conversation_id
    JOIN knowledge_entries entry ON entry.id=CAST(NEW.reference_id AS INTEGER)
    WHERE message.id=NEW.message_id
      AND typeof(NEW.reference_id)='text'
      AND NEW.reference_id GLOB '[1-9]*'
      AND NEW.reference_id NOT GLOB '*[^0-9]*'
      AND length(NEW.reference_id)<=16
      AND NEW.reference_id=CAST(CAST(NEW.reference_id AS INTEGER) AS TEXT)
      AND entry.org_id=conversation.org_id
  ))
BEGIN SELECT RAISE(ABORT,'AI reference organization ownership mismatch'); END`,
  ai_references_conversation_org_update: `CREATE TRIGGER ai_references_conversation_org_update
BEFORE UPDATE OF message_id,campaign_id,knowledge_entry_id,reference_type,reference_id ON ai_references
WHEN
  (NEW.campaign_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM ai_messages message
    JOIN ai_conversations conversation ON conversation.id=message.conversation_id
    JOIN campaigns campaign ON campaign.id=NEW.campaign_id
    WHERE message.id=NEW.message_id AND campaign.org_id=conversation.org_id
  ))
  OR (NEW.knowledge_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM ai_messages message
    JOIN ai_conversations conversation ON conversation.id=message.conversation_id
    JOIN knowledge_entries entry ON entry.id=NEW.knowledge_entry_id
    WHERE message.id=NEW.message_id AND entry.org_id=conversation.org_id
  ))
  OR (NEW.reference_type='knowledge' AND NEW.knowledge_entry_id IS NULL AND NOT EXISTS (
    SELECT 1
    FROM ai_messages message
    JOIN ai_conversations conversation ON conversation.id=message.conversation_id
    JOIN knowledge_entries entry ON entry.id=CAST(NEW.reference_id AS INTEGER)
    WHERE message.id=NEW.message_id
      AND typeof(NEW.reference_id)='text'
      AND NEW.reference_id GLOB '[1-9]*'
      AND NEW.reference_id NOT GLOB '*[^0-9]*'
      AND length(NEW.reference_id)<=16
      AND NEW.reference_id=CAST(CAST(NEW.reference_id AS INTEGER) AS TEXT)
      AND entry.org_id=conversation.org_id
  ))
BEGIN SELECT RAISE(ABORT,'AI reference organization ownership mismatch'); END`,
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
  trg_task7_reference_update: `CREATE TRIGGER trg_task7_reference_update
AFTER UPDATE OF message_id,campaign_id,knowledge_entry_id ON ai_references
BEGIN
${referenceMutationBody('OLD', -1)}
${referenceMutationBody('NEW', 1)}
END`
});

function encodedValue(value) {
  if (value === null) return ['null', ''];
  if (typeof value === 'object') return ['blob', value.toString('base64')];
  if (typeof value === 'number') return [Number.isInteger(value) ? 'integer' : 'real', String(value)];
  return ['text', String(value)];
}

function projectionDigest(db, domain, columns, query) {
  const rows = db.prepare(query).all();
  const hash = createHash('sha256');
  hash.update(`tm-ai-conversation-v25-${domain}-projection-v1\n`);
  for (const row of rows) {
    hash.update(JSON.stringify(columns.map((column) => encodedValue(row[column]))));
    hash.update('\n');
  }
  return { count: rows.length, sha256: hash.digest('hex') };
}

function legacyProjection(db) {
  return {
    conversations: projectionDigest(
      db,
      'conversations',
      LEGACY_CONVERSATION_COLUMNS,
      `SELECT ${LEGACY_CONVERSATION_COLUMNS.join(',')} FROM ai_conversations ORDER BY id`
    ),
    messages: projectionDigest(
      db,
      'messages',
      MESSAGE_COLUMNS,
      `SELECT ${MESSAGE_COLUMNS.join(',')} FROM ai_messages ORDER BY id`
    ),
    references: projectionDigest(
      db,
      'references',
      REFERENCE_COLUMNS,
      `SELECT ${REFERENCE_COLUMNS.join(',')} FROM ai_references ORDER BY id`
    ),
    links: projectionDigest(
      db,
      'campaign-links',
      LINK_COLUMNS,
      `SELECT ${LINK_COLUMNS.join(',')} FROM campaign_record_links ORDER BY id`
    ),
    sequences: projectionDigest(
      db,
      'sqlite-sequence',
      ['name', 'seq'],
      'SELECT name,seq FROM sqlite_sequence ORDER BY name'
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
  if (namedDefault.length === 1) {
    return { id: namedDefault[0].id, onlyOrganization: organizations.length === 1 };
  }
  if (namedDefault.length > 1 || organizations.length === 0) {
    throw new Error('025 requires one unique default organization');
  }
  const sanitizedDefault = organizations.filter((organization) => (
    /^tm-inert-secret-[0-9a-f]{64}$/.test(organization.code) &&
    /^tmtext-[0-9a-f]{32}$/.test(organization.name) &&
    organization.created_at === '1970-01-01 00:00:00'
  ));
  if (sanitizedDefault.length !== 1 || sanitizedDefault[0].id !== organizations[0].id) {
    throw new Error('025 requires one unique default organization');
  }
  return { id: sanitizedDefault[0].id, onlyOrganization: organizations.length === 1 };
}

function authorityClaimsSql() {
  return `
    SELECT conversation.id AS conversation_id,link.org_id
    FROM ai_conversations conversation
    JOIN campaign_record_links link
      ON link.record_type='ai_conversation'
     AND CAST(link.record_id AS INTEGER)=conversation.id
    UNION ALL
    SELECT conversation.id,entry.org_id
    FROM ai_conversations conversation
    JOIN knowledge_entries entry ON entry.id=conversation.archived_summary_id
    UNION ALL
    SELECT conversation.id,campaign.org_id
    FROM ai_conversations conversation
    JOIN ai_messages message ON message.conversation_id=conversation.id
    JOIN ai_references reference ON reference.message_id=message.id
    JOIN campaigns campaign ON campaign.id=reference.campaign_id
    UNION ALL
    SELECT conversation.id,entry.org_id
    FROM ai_conversations conversation
    JOIN ai_messages message ON message.conversation_id=conversation.id
    JOIN ai_references reference ON reference.message_id=message.id
    JOIN knowledge_entries entry ON entry.id=reference.knowledge_entry_id
    UNION ALL
    SELECT conversation.id,entry.org_id
    FROM ai_conversations conversation
    JOIN ai_messages message ON message.conversation_id=conversation.id
    JOIN ai_references reference ON reference.message_id=message.id
    JOIN knowledge_entries entry ON entry.id=CAST(reference.reference_id AS INTEGER)
    WHERE reference.reference_type='knowledge'
      AND reference.knowledge_entry_id IS NULL
      AND typeof(reference.reference_id)='text'
      AND reference.reference_id GLOB '[1-9]*'
      AND reference.reference_id NOT GLOB '*[^0-9]*'
      AND length(reference.reference_id)<=16
      AND reference.reference_id=CAST(CAST(reference.reference_id AS INTEGER) AS TEXT)
  `;
}

function assertNoAuthorityConflict(db) {
  const invalidLink = db.prepare(`
    SELECT link.id
    FROM campaign_record_links link
    LEFT JOIN ai_conversations conversation
      ON conversation.id=CAST(link.record_id AS INTEGER)
    WHERE link.record_type='ai_conversation'
      AND (
        link.record_id<>CAST(CAST(link.record_id AS INTEGER) AS TEXT)
        OR conversation.id IS NULL
      )
    ORDER BY link.id
    LIMIT 1
  `).get();
  if (invalidLink) throw new Error('025 AI conversation Campaign target is invalid');

  const invalidReference = db.prepare(`
    SELECT reference.id
    FROM ai_references reference
    WHERE (reference.campaign_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM campaigns campaign WHERE campaign.id=reference.campaign_id
    )) OR (reference.knowledge_entry_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM knowledge_entries entry WHERE entry.id=reference.knowledge_entry_id
    )) OR (
      reference.reference_type='knowledge'
      AND reference.knowledge_entry_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM knowledge_entries entry
        WHERE typeof(reference.reference_id)='text'
          AND reference.reference_id GLOB '[1-9]*'
          AND reference.reference_id NOT GLOB '*[^0-9]*'
          AND length(reference.reference_id)<=16
          AND reference.reference_id=CAST(CAST(reference.reference_id AS INTEGER) AS TEXT)
          AND entry.id=CAST(reference.reference_id AS INTEGER)
      )
    )
    ORDER BY reference.id
    LIMIT 1
  `).get();
  if (invalidReference) throw new Error('025 AI conversation reference target is invalid');

  const invalidMessage = db.prepare(`
    SELECT message.id
    FROM ai_messages message
    LEFT JOIN ai_conversations conversation ON conversation.id=message.conversation_id
    WHERE conversation.id IS NULL OR conversation.user_id<>message.user_id
    ORDER BY message.id
    LIMIT 1
  `).get();
  if (invalidMessage) throw new Error('025 AI message conversation ownership is invalid');

  const conflict = db.prepare(`
    WITH authority_claims(conversation_id,org_id) AS (
      ${authorityClaimsSql()}
    )
    SELECT conversation_id
    FROM authority_claims
    GROUP BY conversation_id
    HAVING COUNT(DISTINCT org_id)>1
    ORDER BY conversation_id
    LIMIT 1
  `).get();
  if (conflict) {
    throw new Error('conflicting authoritative AI conversation organization ownership');
  }
}

function assertNoUnresolvedOwnership(db, allowDefaultFallback) {
  if (allowDefaultFallback) return;
  const unresolved = db.prepare(`
    WITH authority_claims(conversation_id,org_id) AS (
      ${authorityClaimsSql()}
    )
    SELECT conversation.id
    FROM ai_conversations conversation
    LEFT JOIN authority_claims authority ON authority.conversation_id=conversation.id
    GROUP BY conversation.id
    HAVING COUNT(DISTINCT authority.org_id)=0
    ORDER BY conversation.id
    LIMIT 1
  `).get();
  if (unresolved) {
    throw new Error('unresolved AI conversation organization ownership');
  }
}

function backfillOwnership(db, defaultOrganizationId) {
  db.prepare(`
    WITH authority_claims(conversation_id,org_id) AS (
      ${authorityClaimsSql()}
    ),
    resolved_ownership AS MATERIALIZED (
      SELECT conversation.id AS conversation_id,
        COALESCE(MIN(authority.org_id),@defaultOrganizationId) AS org_id
      FROM ai_conversations conversation
      LEFT JOIN authority_claims authority ON authority.conversation_id=conversation.id
      GROUP BY conversation.id
    )
    UPDATE ai_conversations AS conversation
    SET org_id=(
      SELECT ownership.org_id
      FROM resolved_ownership ownership
      WHERE ownership.conversation_id=conversation.id
    )
    WHERE org_id IS NULL
  `).run({ defaultOrganizationId });
}

function rebuildOrganizationReferenceGauges(db) {
  db.exec(`
    WITH reference_usage AS MATERIALIZED (
      SELECT conversation.org_id AS scope_id,COUNT(reference.id) AS reference_count
      FROM ai_conversations conversation
      LEFT JOIN ai_messages message ON message.conversation_id=conversation.id
      LEFT JOIN ai_references reference ON reference.message_id=message.id
      GROUP BY conversation.org_id
    ),
    usage AS MATERIALIZED (
      SELECT organization.id AS scope_id,COALESCE(reference.reference_count,0) AS reference_count
      FROM organizations organization
      LEFT JOIN reference_usage reference ON reference.scope_id=organization.id
    )
    INSERT INTO knowledge_capacity_gauges (
      scope_type,scope_id,metric,usage_value,limit_value,threshold_percent
    )
    SELECT
      'organization',scope_id,'references',reference_count,20000000,
      CASE
        WHEN reference_count>=20000000 THEN 100
        WHEN reference_count*10>=20000000*9 THEN 90
        WHEN reference_count*5>=20000000*4 THEN 80
        ELSE 0
      END
    FROM usage
    WHERE 1
    ON CONFLICT(scope_type,scope_id,metric) DO UPDATE SET
      usage_value=excluded.usage_value,
      limit_value=excluded.limit_value,
      threshold_percent=excluded.threshold_percent,
      updated_at=CURRENT_TIMESTAMP;
  `);
}

const migration = {
  version: 25,
  name: '025_ai_conversation_tenant_ownership',
  sourcePath: 'migrations/025_ai_conversation_tenant_ownership.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      ai_conversations: {
        org_id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {}
  },
  apply(db) {
    for (const name of [
      'organizations',
      'ai_conversations',
      'ai_messages',
      'ai_references',
      'knowledge_entries',
      'campaigns',
      'campaign_record_links',
      'knowledge_capacity_gauges',
      'knowledge_unlinked_user_usage'
    ]) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`025 requires ${name}`);
      }
    }
    if (!db.prepare(`
      SELECT 1 AS present FROM pragma_table_info('knowledge_entries') WHERE name='org_id'
    `).get()) {
      throw new Error('025 requires knowledge tenant ownership');
    }

    const newObjectNames = [
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL).filter((name) => ![
        'trg_task7_reference_insert',
        'trg_task7_reference_delete'
      ].includes(name))
    ];
    const placeholders = newObjectNames.map(() => '?').join(',');
    const existingObject = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE name IN (${placeholders})
      ORDER BY name LIMIT 1
    `).get(...newObjectNames);
    const existingColumn = db.prepare(`
      SELECT 1 AS present FROM pragma_table_info('ai_conversations') WHERE name='org_id'
    `).get();
    if (existingColumn || existingObject) {
      throw new Error('partial 025 AI conversation ownership object exists');
    }
    for (const name of ['trg_task7_reference_insert', 'trg_task7_reference_delete']) {
      if (!db.prepare(`
        SELECT 1 AS present FROM sqlite_schema WHERE type='trigger' AND name=?
      `).get(name)) {
        throw new Error(`025 requires ${name}`);
      }
    }

    const defaultOrganization = resolveDefaultOrganizationId(db);
    assertNoAuthorityConflict(db);
    assertNoUnresolvedOwnership(db, defaultOrganization.onlyOrganization);
    const before = legacyProjection(db);

    db.exec(`
      ALTER TABLE ai_conversations
      ADD COLUMN org_id INTEGER
        REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);
    backfillOwnership(db, defaultOrganization.onlyOrganization ? defaultOrganization.id : null);

    const invalidOwnership = db.prepare(`
      SELECT COUNT(*) AS count
      FROM ai_conversations conversation
      LEFT JOIN organizations organization ON organization.id=conversation.org_id
      WHERE conversation.org_id IS NULL
        OR typeof(conversation.org_id)<>'integer'
        OR conversation.org_id<1
        OR conversation.org_id>9007199254740991
        OR organization.id IS NULL
    `).get().count;
    if (invalidOwnership !== 0) {
      throw new Error('025 AI conversation organization ownership backfill is incomplete');
    }

    db.exec('DROP TRIGGER trg_task7_reference_insert; DROP TRIGGER trg_task7_reference_delete;');
    db.exec([
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
    rebuildOrganizationReferenceGauges(db);

    const invalidRelationships = db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT conversation.id
        FROM ai_conversations conversation
        JOIN knowledge_entries entry ON entry.id=conversation.archived_summary_id
        WHERE entry.org_id<>conversation.org_id
        UNION ALL
        SELECT link.id
        FROM campaign_record_links link
        LEFT JOIN ai_conversations conversation
          ON conversation.id=CAST(link.record_id AS INTEGER)
        WHERE link.record_type='ai_conversation'
          AND (conversation.id IS NULL OR conversation.org_id<>link.org_id)
        UNION ALL
        SELECT reference.id
        FROM ai_references reference
        JOIN ai_messages message ON message.id=reference.message_id
        JOIN ai_conversations conversation ON conversation.id=message.conversation_id
        LEFT JOIN campaigns campaign ON campaign.id=reference.campaign_id
        LEFT JOIN knowledge_entries entry ON entry.id=reference.knowledge_entry_id
        WHERE (reference.campaign_id IS NOT NULL AND campaign.org_id<>conversation.org_id)
          OR (reference.knowledge_entry_id IS NOT NULL AND entry.org_id<>conversation.org_id)
          OR (
            reference.reference_type='knowledge'
            AND reference.knowledge_entry_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM knowledge_entries legacy_entry
              WHERE typeof(reference.reference_id)='text'
                AND reference.reference_id GLOB '[1-9]*'
                AND reference.reference_id NOT GLOB '*[^0-9]*'
                AND length(reference.reference_id)<=16
                AND reference.reference_id=CAST(CAST(reference.reference_id AS INTEGER) AS TEXT)
                AND legacy_entry.id=CAST(reference.reference_id AS INTEGER)
                AND legacy_entry.org_id=conversation.org_id
            )
          )
        UNION ALL
        SELECT message.id
        FROM ai_messages message
        JOIN ai_conversations conversation ON conversation.id=message.conversation_id
        WHERE message.user_id<>conversation.user_id
      ) mismatch
    `).get().count;
    if (invalidRelationships !== 0) {
      throw new Error('025 AI conversation relationship ownership validation failed');
    }

    const after = legacyProjection(db);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error('025 changed the legacy AI conversation projection');
    }
  }
};

module.exports = migration;
