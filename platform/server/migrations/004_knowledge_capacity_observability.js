const TABLE_SQL = `CREATE TABLE knowledge_capacity_gauges (
  scope_type TEXT NOT NULL CHECK(scope_type IN ('user','campaign','organization')),
  scope_id INTEGER NOT NULL CHECK(
    typeof(scope_id)='integer' AND scope_id BETWEEN 1 AND 9007199254740991
  ),
  metric TEXT NOT NULL CHECK(metric IN ('entries','chunks','payload_bytes','references')),
  usage_value INTEGER NOT NULL CHECK(
    typeof(usage_value)='integer' AND usage_value BETWEEN 0 AND 9007199254740991
  ),
  limit_value INTEGER NOT NULL CHECK(
    typeof(limit_value)='integer' AND limit_value BETWEEN 1 AND 9007199254740991
  ),
  threshold_percent INTEGER NOT NULL CHECK(
    typeof(threshold_percent)='integer' AND threshold_percent IN (0,80,90,100)
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    length(updated_at)>0
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at
  ),
  PRIMARY KEY(scope_type,scope_id,metric)
) STRICT, WITHOUT ROWID`;

const INDEX_SQL = Object.freeze({
  idx_task7_knowledge_entries_creator: `CREATE INDEX idx_task7_knowledge_entries_creator
  ON knowledge_entries(created_by)
  WHERE created_by IS NOT NULL`,
  idx_task7_ai_references_campaign: `CREATE INDEX idx_task7_ai_references_campaign
  ON ai_references(campaign_id)
  WHERE campaign_id IS NOT NULL`,
  idx_task7_ai_references_knowledge_message_v1: `CREATE INDEX idx_task7_ai_references_knowledge_message_v1
  ON ai_references(knowledge_entry_id,message_id)
  WHERE reference_schema_version=1 AND knowledge_entry_id IS NOT NULL`,
  idx_task7_campaign_record_links_knowledge_custody: `CREATE INDEX idx_task7_campaign_record_links_knowledge_custody
  ON campaign_record_links(
    record_id,revoked_at,id,campaign_id,org_id,record_type,relation_type
  )
  WHERE record_type='knowledge_entry' AND relation_type<>'shortlist'`
});

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
          CASE WHEN custody_link.revoked_at IS NULL THEN custody_link.id END DESC,
          CASE WHEN custody_link.revoked_at IS NOT NULL THEN custody_link.revoked_at END DESC,
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

function userUsage(db, scopeId) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM knowledge_entries entry WHERE entry.created_by=@scopeId) AS entries,
      (
        SELECT COUNT(*)
        FROM knowledge_chunks chunk
        JOIN knowledge_entries entry ON entry.id=chunk.entry_id
        WHERE entry.created_by=@scopeId
      ) AS chunks,
      COALESCE((
        SELECT SUM(${entryPayloadSql('entry')})
        FROM knowledge_entries entry
        WHERE entry.created_by=@scopeId
      ),0) + COALESCE((
        SELECT SUM(${chunkPayloadSql('chunk')})
        FROM knowledge_chunks chunk
        JOIN knowledge_entries entry ON entry.id=chunk.entry_id
        WHERE entry.created_by=@scopeId
      ),0) AS payload_bytes,
      (
        SELECT COUNT(*)
        FROM ai_references reference
        JOIN ai_messages message ON message.id=reference.message_id
        JOIN ai_conversations conversation ON conversation.id=message.conversation_id
        WHERE conversation.user_id=@scopeId
      ) AS "references"
  `).get({ scopeId });
}

function campaignUsage(db, scopeId) {
  return db.prepare(`
    WITH
    ${KNOWLEDGE_CUSTODY_CTE},
    capacity_entries AS MATERIALIZED (
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
      COALESCE((
        SELECT SUM(${entryPayloadSql('entry')}) FROM capacity_entries entry
      ),0) + COALESCE((
        SELECT SUM(${chunkPayloadSql('chunk')})
        FROM knowledge_chunks chunk
        JOIN capacity_entries entry ON entry.id=chunk.entry_id
      ),0) AS payload_bytes,
      (
        SELECT COUNT(*) FROM ai_references reference
        WHERE reference.campaign_id=@scopeId
      ) AS "references"
  `).get({ scopeId });
}

function organizationUsage(db, scopeId, defaultOrganizationId) {
  return db.prepare(`
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
            (entry.created_by IS NOT NULL AND creator_membership.user_id IS NOT NULL)
            OR (entry.created_by IS NULL AND @scopeId=@defaultOrganizationId)
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
        reference.campaign_id IS NOT NULL AND campaign.org_id=@scopeId
      ) OR (
        reference.campaign_id IS NULL AND conversation_membership.user_id IS NOT NULL
      )
    )
    SELECT
      (SELECT COUNT(*) FROM capacity_entries) AS entries,
      (
        SELECT COUNT(*)
        FROM knowledge_chunks chunk
        JOIN capacity_entries entry ON entry.id=chunk.entry_id
      ) AS chunks,
      COALESCE((
        SELECT SUM(${entryPayloadSql('entry')}) FROM capacity_entries entry
      ),0) + COALESCE((
        SELECT SUM(${chunkPayloadSql('chunk')})
        FROM knowledge_chunks chunk
        JOIN capacity_entries entry ON entry.id=chunk.entry_id
      ),0) AS payload_bytes,
      (SELECT COUNT(*) FROM capacity_references) AS "references"
  `).get({ scopeId, defaultOrganizationId });
}

function thresholdPercent(usageValue, limitValue) {
  if (usageValue >= limitValue) return 100;
  if (usageValue * 10 >= limitValue * 9) return 90;
  if (usageValue * 5 >= limitValue * 4) return 80;
  return 0;
}

function writeScopeGauges(db, insertGauge, scopeType, scopeId, usage) {
  const limits = CAPACITY_LIMITS[scopeType];
  for (const metric of METRICS) {
    insertGauge.run(
      scopeType,
      scopeId,
      metric,
      usage[metric],
      limits[metric],
      thresholdPercent(usage[metric], limits[metric])
    );
  }
}

function backfillGauges(db) {
  const defaultOrganizations = db.prepare(`
    SELECT id FROM organizations WHERE code='turingmarket-default'
  `).all();
  if (defaultOrganizations.length !== 1) {
    throw new Error('004 requires exactly one turingmarket-default organization');
  }
  const defaultOrganizationId = defaultOrganizations[0].id;
  const insertGauge = db.prepare(`
    INSERT INTO knowledge_capacity_gauges (
      scope_type,scope_id,metric,usage_value,limit_value,threshold_percent
    ) VALUES (?,?,?,?,?,?)
  `);
  for (const row of db.prepare('SELECT id FROM users ORDER BY id').all()) {
    writeScopeGauges(db, insertGauge, 'user', row.id, userUsage(db, row.id));
  }
  for (const row of db.prepare('SELECT id FROM campaigns ORDER BY id').all()) {
    writeScopeGauges(db, insertGauge, 'campaign', row.id, campaignUsage(db, row.id));
  }
  for (const row of db.prepare('SELECT id FROM organizations ORDER BY id').all()) {
    writeScopeGauges(
      db,
      insertGauge,
      'organization',
      row.id,
      organizationUsage(db, row.id, defaultOrganizationId)
    );
  }
}

const migration = {
  version: 4,
  name: '004_knowledge_capacity_observability',
  sourcePath: 'migrations/004_knowledge_capacity_observability.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      knowledge_capacity_gauges: {
        scope_type: { type: 'TEXT', notnull: 1, defaultValue: null },
        scope_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        metric: { type: 'TEXT', notnull: 1, defaultValue: null },
        usage_value: { type: 'INTEGER', notnull: 1, defaultValue: null },
        limit_value: { type: 'INTEGER', notnull: 1, defaultValue: null },
        threshold_percent: { type: 'INTEGER', notnull: 1, defaultValue: null },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: {},
    tableChecks: {
      knowledge_capacity_gauges: [
        "CHECK(scope_type IN ('user','campaign','organization'))",
        "CHECK(metric IN ('entries','chunks','payload_bytes','references'))",
        'CHECK(typeof(scope_id)=\'integer\' AND scope_id BETWEEN 1 AND 9007199254740991)',
        'CHECK(typeof(usage_value)=\'integer\' AND usage_value BETWEEN 0 AND 9007199254740991)',
        'CHECK(typeof(limit_value)=\'integer\' AND limit_value BETWEEN 1 AND 9007199254740991)',
        'CHECK(typeof(threshold_percent)=\'integer\' AND threshold_percent IN (0,80,90,100))'
      ]
    }
  },
  apply(db) {
    const objectNames = [
      'knowledge_capacity_gauges',
      ...Object.keys(INDEX_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE name IN (${placeholders})
      ORDER BY name
    `).all(...objectNames);
    if (existing.length > 0) {
      throw new Error(`partial 004 object exists: ${existing[0].name}`);
    }

    db.exec(`${TABLE_SQL};\n${Object.values(INDEX_SQL).join(';\n')};`);
    backfillGauges(db);
  }
};

module.exports = migration;
