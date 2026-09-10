'use strict';

const TABLE_SQL = `CREATE TABLE collaboration_publication_lifecycle_versions (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  collaboration_id INTEGER NOT NULL CHECK(collaboration_id BETWEEN 1 AND 9007199254740991),
  custody_id INTEGER NOT NULL CHECK(custody_id BETWEEN 1 AND 9007199254740991),
  lifecycle_version INTEGER NOT NULL CHECK(lifecycle_version BETWEEN 2 AND 9007199254740991),
  previous_version_id INTEGER CHECK(previous_version_id IS NULL OR previous_version_id BETWEEN 1 AND 9007199254740991),
  action TEXT NOT NULL CHECK(action IN ('corrected','paused','resumed')),
  tracking_state TEXT NOT NULL CHECK(tracking_state IN ('active','paused')),
  publication_id INTEGER NOT NULL CHECK(publication_id BETWEEN 1 AND 9007199254740991),
  effective_url TEXT NOT NULL CHECK(
    length(effective_url) BETWEEN 8 AND 4096
    AND effective_url=trim(effective_url)
    AND lower(substr(effective_url,1,8))='https://'
  ),
  effective_url_sha256 TEXT NOT NULL CHECK(
    length(effective_url_sha256)=64 AND effective_url_sha256=lower(effective_url_sha256)
    AND effective_url_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  canonical_identity TEXT NOT NULL CHECK(length(canonical_identity) BETWEEN 3 AND 360),
  platform TEXT NOT NULL CHECK(platform IN ('tiktok','instagram','youtube','facebook','x','manual','custom')),
  platform_content_id TEXT CHECK(platform_content_id IS NULL OR length(platform_content_id) BETWEEN 1 AND 512),
  effective_published_at TEXT NOT NULL CHECK(
    length(effective_published_at) BETWEEN 20 AND 40
    AND effective_published_at GLOB '????-??-??T??:??:??*Z'
  ),
  correction_kind TEXT CHECK(correction_kind IS NULL OR correction_kind IN ('url_alias','content_replacement')),
  registration_mode TEXT CHECK(registration_mode IS NULL OR registration_mode IN ('reused_current','created','existing','reused_history')),
  reason TEXT NOT NULL CHECK(
    length(reason) BETWEEN 1 AND 500
    AND reason=trim(reason)
    AND reason NOT GLOB '*[' || char(0) || '-' || char(31) || ']*'
    AND instr(reason,char(127))=0
  ),
  knowledge_entry_id INTEGER NOT NULL CHECK(knowledge_entry_id BETWEEN 1 AND 9007199254740991),
  collaboration_row_version_observed INTEGER NOT NULL CHECK(collaboration_row_version_observed BETWEEN 1 AND 9007199254740991),
  acted_by INTEGER NOT NULL CHECK(acted_by BETWEEN 1 AND 9007199254740991),
  acted_at TEXT NOT NULL CHECK(
    length(acted_at) BETWEEN 20 AND 40
    AND acted_at GLOB '????-??-??T??:??:??*Z'
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  UNIQUE(custody_id,lifecycle_version),
  UNIQUE(knowledge_entry_id),
  CHECK(
    (action='corrected' AND correction_kind IS NOT NULL AND registration_mode IS NOT NULL)
    OR (action IN ('paused','resumed') AND correction_kind IS NULL AND registration_mode IS NULL)
  ),
  CHECK((action='paused' AND tracking_state='paused') OR action<>'paused'),
  CHECK((action='resumed' AND tracking_state='active') OR action<>'resumed'),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,acted_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(collaboration_id) REFERENCES collaborations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(custody_id) REFERENCES collaboration_publication_custody(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(previous_version_id) REFERENCES collaboration_publication_lifecycle_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(publication_id) REFERENCES campaign_publications(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(knowledge_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  ux_collaboration_publication_lifecycle_version: `CREATE UNIQUE INDEX ux_collaboration_publication_lifecycle_version
    ON collaboration_publication_lifecycle_versions(custody_id,lifecycle_version)`,
  idx_collaboration_publication_lifecycle_scope: `CREATE INDEX idx_collaboration_publication_lifecycle_scope
    ON collaboration_publication_lifecycle_versions(org_id,campaign_id,collaboration_id,custody_id,lifecycle_version DESC)`,
  idx_collaboration_publication_lifecycle_publication: `CREATE INDEX idx_collaboration_publication_lifecycle_publication
    ON collaboration_publication_lifecycle_versions(org_id,campaign_id,publication_id,custody_id,lifecycle_version DESC)`
});

const TRIGGER_SQL = Object.freeze({
  collaboration_publication_lifecycle_no_update: `CREATE TRIGGER collaboration_publication_lifecycle_no_update
BEFORE UPDATE ON collaboration_publication_lifecycle_versions
BEGIN SELECT RAISE(ABORT,'collaboration publication lifecycle is append-only'); END`,
  collaboration_publication_lifecycle_no_delete: `CREATE TRIGGER collaboration_publication_lifecycle_no_delete
BEFORE DELETE ON collaboration_publication_lifecycle_versions
BEGIN SELECT RAISE(ABORT,'collaboration publication lifecycle is append-only'); END`,
  collaboration_publication_lifecycle_chain_insert: `CREATE TRIGGER collaboration_publication_lifecycle_chain_insert
BEFORE INSERT ON collaboration_publication_lifecycle_versions
WHEN NOT EXISTS (
  SELECT 1
  FROM collaboration_publication_custody custody
  JOIN campaign_publications baseline ON baseline.id=custody.publication_id
  JOIN campaign_publications target ON target.id=NEW.publication_id
  WHERE custody.id=NEW.custody_id
    AND custody.org_id=NEW.org_id
    AND custody.campaign_id=NEW.campaign_id
    AND custody.collaboration_id=NEW.collaboration_id
    AND baseline.org_id=NEW.org_id AND baseline.campaign_id=NEW.campaign_id
    AND target.org_id=NEW.org_id AND target.campaign_id=NEW.campaign_id
    AND target.canonical_identity=NEW.canonical_identity
    AND target.platform=NEW.platform
    AND target.platform_content_id IS NEW.platform_content_id
    AND (
      NEW.action<>'corrected' OR NEW.correction_kind<>'content_replacement'
      OR target.published_at IS NEW.effective_published_at
    )
    AND COALESCE(target.creator_id,'')=COALESCE(baseline.creator_id,'')
    AND NOT EXISTS (
      SELECT 1 FROM collaboration_publication_custody other_custody
      WHERE other_custody.publication_id=NEW.publication_id
        AND other_custody.id<>NEW.custody_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM collaboration_publication_lifecycle_versions other_version
      WHERE other_version.publication_id=NEW.publication_id
        AND other_version.custody_id<>NEW.custody_id
    )
    AND (
      (
        NEW.lifecycle_version=2
        AND NEW.previous_version_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM collaboration_publication_lifecycle_versions existing
          WHERE existing.custody_id=NEW.custody_id
        )
        AND (
          (
            NEW.action='corrected'
            AND NEW.tracking_state='active'
            AND (
              (NEW.correction_kind='url_alias' AND NEW.registration_mode='reused_current'
                AND NEW.publication_id=custody.publication_id
                AND NEW.canonical_identity=baseline.canonical_identity
                AND NEW.platform=baseline.platform
                AND NEW.platform_content_id IS baseline.platform_content_id
                AND NEW.effective_published_at=custody.published_at)
              OR
              (NEW.correction_kind='content_replacement' AND NEW.publication_id<>custody.publication_id
                AND NEW.canonical_identity<>baseline.canonical_identity
                AND NEW.platform=baseline.platform
                AND NEW.registration_mode IN ('created','existing','reused_history'))
            )
          )
          OR
          (NEW.action='paused' AND NEW.tracking_state='paused'
            AND NEW.publication_id=custody.publication_id
            AND NEW.effective_url=custody.confirmed_url
            AND NEW.effective_url_sha256=custody.final_url_sha256
            AND NEW.canonical_identity=baseline.canonical_identity
            AND NEW.platform=baseline.platform
            AND NEW.platform_content_id IS baseline.platform_content_id
            AND NEW.effective_published_at=custody.published_at)
        )
      )
      OR
      (
        NEW.lifecycle_version>2
        AND EXISTS (
          SELECT 1
          FROM collaboration_publication_lifecycle_versions previous
          WHERE previous.id=NEW.previous_version_id
            AND previous.custody_id=NEW.custody_id
            AND previous.lifecycle_version=NEW.lifecycle_version-1
            AND NOT EXISTS (
              SELECT 1 FROM collaboration_publication_lifecycle_versions later
              WHERE later.custody_id=NEW.custody_id
                AND later.lifecycle_version>previous.lifecycle_version
            )
            AND (
              (
                NEW.action='corrected'
                AND NEW.tracking_state=previous.tracking_state
                AND (
                  (NEW.correction_kind='url_alias' AND NEW.registration_mode='reused_current'
                    AND NEW.publication_id=previous.publication_id
                    AND NEW.canonical_identity=previous.canonical_identity
                    AND NEW.platform=previous.platform
                    AND NEW.platform_content_id IS previous.platform_content_id
                    AND NEW.effective_published_at=previous.effective_published_at)
                  OR
                  (NEW.correction_kind='content_replacement' AND NEW.publication_id<>previous.publication_id
                    AND NEW.canonical_identity<>previous.canonical_identity
                    AND NEW.platform=previous.platform
                    AND NEW.registration_mode IN ('created','existing','reused_history'))
                )
              )
              OR
              (NEW.action='paused' AND previous.tracking_state='active' AND NEW.tracking_state='paused'
                AND NEW.publication_id=previous.publication_id
                AND NEW.effective_url=previous.effective_url
                AND NEW.effective_url_sha256=previous.effective_url_sha256
                AND NEW.canonical_identity=previous.canonical_identity
                AND NEW.platform=previous.platform
                AND NEW.platform_content_id IS previous.platform_content_id
                AND NEW.effective_published_at=previous.effective_published_at)
              OR
              (NEW.action='resumed' AND previous.tracking_state='paused' AND NEW.tracking_state='active'
                AND NEW.publication_id=previous.publication_id
                AND NEW.effective_url=previous.effective_url
                AND NEW.effective_url_sha256=previous.effective_url_sha256
                AND NEW.canonical_identity=previous.canonical_identity
                AND NEW.platform=previous.platform
                AND NEW.platform_content_id IS previous.platform_content_id
                AND NEW.effective_published_at=previous.effective_published_at)
            )
        )
      )
    )
)
BEGIN SELECT RAISE(ABORT,'collaboration publication lifecycle chain is invalid'); END`,
  collaboration_publication_lifecycle_knowledge_insert: `CREATE TRIGGER collaboration_publication_lifecycle_knowledge_insert
BEFORE INSERT ON collaboration_publication_lifecycle_versions
WHEN NOT EXISTS (
  SELECT 1
  FROM knowledge_entries entry
  JOIN campaign_record_links link
    ON link.record_type='knowledge_entry'
   AND link.record_id=CAST(entry.id AS TEXT)
   AND link.relation_type='knowledge'
   AND link.revoked_at IS NULL
  WHERE entry.id=NEW.knowledge_entry_id
    AND entry.entry_type='campaign_publication_lifecycle'
    AND entry.source_type='campaign_publication_lifecycle'
    AND CAST(entry.source_id AS TEXT)=CAST(NEW.id AS TEXT)
    AND entry.created_by=NEW.acted_by
    AND entry.visibility='team'
    AND entry.business_type='campaign'
    AND CAST(entry.business_id AS TEXT)=CAST(NEW.campaign_id AS TEXT)
    AND CAST(json_extract(entry.metadata_json,'$.custody_id') AS INTEGER)=NEW.custody_id
    AND CAST(json_extract(entry.metadata_json,'$.collaboration_id') AS INTEGER)=NEW.collaboration_id
    AND CAST(json_extract(entry.metadata_json,'$.publication_id') AS INTEGER)=NEW.publication_id
    AND CAST(json_extract(entry.metadata_json,'$.lifecycle_version') AS INTEGER)=NEW.lifecycle_version
    AND json_extract(entry.metadata_json,'$.action')=NEW.action
    AND json_extract(entry.metadata_json,'$.effective_url_sha256')=NEW.effective_url_sha256
    AND json_extract(entry.metadata_json,'$.retrieval_eligible')=0
    AND link.org_id=NEW.org_id
    AND link.campaign_id=NEW.campaign_id
    AND link.created_by=NEW.acted_by
    AND json_extract(link.metadata_json,'$.producer_type')='campaign_publication_lifecycle'
    AND CAST(json_extract(link.metadata_json,'$.producer_id') AS INTEGER)=NEW.collaboration_id
    AND CAST(json_extract(link.metadata_json,'$.source_id') AS TEXT)=CAST(NEW.id AS TEXT)
)
BEGIN SELECT RAISE(ABORT,'collaboration publication lifecycle knowledge is invalid'); END`,
  performance_metric_observations_lifecycle_insert: `CREATE TRIGGER performance_metric_observations_lifecycle_insert
BEFORE INSERT ON performance_metric_observations
WHEN EXISTS (
  SELECT 1
  FROM collaboration_publication_custody custody
  WHERE custody.org_id=NEW.org_id
    AND custody.campaign_id=NEW.campaign_id
    AND (
      custody.publication_id=NEW.publication_id
      OR EXISTS (
        SELECT 1 FROM collaboration_publication_lifecycle_versions historical
        WHERE historical.custody_id=custody.id
          AND historical.publication_id=NEW.publication_id
      )
    )
)
AND NOT EXISTS (
  SELECT 1
  FROM collaboration_publication_custody custody
  LEFT JOIN collaboration_publication_lifecycle_versions latest
    ON latest.id=(
      SELECT candidate.id
      FROM collaboration_publication_lifecycle_versions candidate
      WHERE candidate.custody_id=custody.id
      ORDER BY candidate.lifecycle_version DESC
      LIMIT 1
    )
  WHERE custody.org_id=NEW.org_id
    AND custody.campaign_id=NEW.campaign_id
    AND COALESCE(latest.publication_id,custody.publication_id)=NEW.publication_id
    AND COALESCE(latest.tracking_state,'active')='active'
)
BEGIN SELECT RAISE(ABORT,'publication metrics tracking is paused or publication is not current'); END`
});

const migration = {
  version: 18,
  name: '018_collaboration_publication_lifecycle',
  sourcePath: 'migrations/018_collaboration_publication_lifecycle.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      collaboration_publication_lifecycle_versions: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        collaboration_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        custody_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        lifecycle_version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        previous_version_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        action: { type: 'TEXT', notnull: 1, defaultValue: null },
        tracking_state: { type: 'TEXT', notnull: 1, defaultValue: null },
        publication_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        effective_url: { type: 'TEXT', notnull: 1, defaultValue: null },
        effective_url_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        canonical_identity: { type: 'TEXT', notnull: 1, defaultValue: null },
        platform: { type: 'TEXT', notnull: 1, defaultValue: null },
        platform_content_id: { type: 'TEXT', notnull: 0, defaultValue: null },
        effective_published_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        correction_kind: { type: 'TEXT', notnull: 0, defaultValue: null },
        registration_mode: { type: 'TEXT', notnull: 0, defaultValue: null },
        reason: { type: 'TEXT', notnull: 1, defaultValue: null },
        knowledge_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        collaboration_row_version_observed: { type: 'INTEGER', notnull: 1, defaultValue: null },
        acted_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        acted_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      collaboration_publication_lifecycle_versions: [
        'UNIQUE(custody_id,lifecycle_version)',
        'UNIQUE(knowledge_entry_id)',
        "CHECK(action IN ('corrected','paused','resumed'))",
        "CHECK(tracking_state IN ('active','paused'))",
        "CHECK(correction_kind IS NULL OR correction_kind IN ('url_alias','content_replacement'))",
        "CHECK(registration_mode IS NULL OR registration_mode IN ('reused_current','created','existing','reused_history'))",
        "CHECK(length(effective_url_sha256)=64 AND effective_url_sha256=lower(effective_url_sha256) AND effective_url_sha256 NOT GLOB '*[^0-9a-f]*')"
      ]
    }
  },
  apply(db) {
    const required = [
      'campaigns',
      'organization_memberships',
      'collaborations',
      'campaign_publications',
      'performance_metric_observations',
      'knowledge_entries',
      'campaign_record_links',
      'collaboration_publication_custody'
    ];
    for (const name of required) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`018 requires ${name}`);
      }
    }
    const objectNames = [
      'collaboration_publication_lifecycle_versions',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 018 object exists: ${existing[0].name}`);
    db.exec([
      TABLE_SQL,
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;
