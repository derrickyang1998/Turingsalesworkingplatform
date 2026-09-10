'use strict';

const TABLE_SQL = `CREATE TABLE collaboration_publication_custody (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  collaboration_id INTEGER NOT NULL CHECK(collaboration_id BETWEEN 1 AND 9007199254740991),
  publication_id INTEGER NOT NULL CHECK(publication_id BETWEEN 1 AND 9007199254740991),
  deliverable_key TEXT NOT NULL CHECK(
    length(deliverable_key) BETWEEN 1 AND 80
    AND deliverable_key=trim(deliverable_key)
    AND deliverable_key=lower(deliverable_key)
    AND deliverable_key NOT GLOB '*[^a-z0-9._-]*'
    AND substr(deliverable_key,1,1) GLOB '[a-z0-9]'
    AND substr(deliverable_key,-1,1) GLOB '[a-z0-9]'
  ),
  registration_mode TEXT NOT NULL CHECK(registration_mode IN ('created','existing')),
  review_submission_entry_id INTEGER NOT NULL CHECK(review_submission_entry_id BETWEEN 1 AND 9007199254740991),
  review_decision_entry_id INTEGER NOT NULL CHECK(review_decision_entry_id BETWEEN 1 AND 9007199254740991),
  publication_relation_link_id INTEGER NOT NULL CHECK(publication_relation_link_id BETWEEN 1 AND 9007199254740991),
  knowledge_entry_id INTEGER NOT NULL CHECK(knowledge_entry_id BETWEEN 1 AND 9007199254740991),
  confirmed_url TEXT NOT NULL CHECK(
    length(confirmed_url) BETWEEN 8 AND 4096
    AND confirmed_url=trim(confirmed_url)
    AND lower(substr(confirmed_url,1,8))='https://'
  ),
  final_url_sha256 TEXT NOT NULL CHECK(
    length(final_url_sha256)=64 AND final_url_sha256=lower(final_url_sha256)
    AND final_url_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  published_at TEXT NOT NULL CHECK(
    length(published_at) BETWEEN 20 AND 40
    AND published_at GLOB '????-??-??T??:??:??*Z'
  ),
  publication_note TEXT CHECK(
    publication_note IS NULL OR (
      length(publication_note) BETWEEN 1 AND 500
      AND publication_note=trim(publication_note)
      AND publication_note NOT GLOB '*[' || char(0) || '-' || char(31) || ']*'
      AND instr(publication_note,char(127))=0
    )
  ),
  confirmed_by INTEGER NOT NULL CHECK(confirmed_by BETWEEN 1 AND 9007199254740991),
  confirmed_at TEXT NOT NULL CHECK(
    length(confirmed_at) BETWEEN 20 AND 40
    AND confirmed_at GLOB '????-??-??T??:??:??*Z'
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  UNIQUE(org_id,campaign_id,collaboration_id,deliverable_key),
  UNIQUE(org_id,campaign_id,publication_id),
  UNIQUE(knowledge_entry_id),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,confirmed_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(collaboration_id) REFERENCES collaborations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(publication_id) REFERENCES campaign_publications(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(review_submission_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(review_decision_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(publication_relation_link_id) REFERENCES campaign_record_links(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(knowledge_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  ux_collaboration_publication_custody_deliverable: `CREATE UNIQUE INDEX ux_collaboration_publication_custody_deliverable
    ON collaboration_publication_custody(org_id,campaign_id,collaboration_id,deliverable_key)`,
  ux_collaboration_publication_custody_publication: `CREATE UNIQUE INDEX ux_collaboration_publication_custody_publication
    ON collaboration_publication_custody(org_id,campaign_id,publication_id)`,
  idx_collaboration_publication_custody_collaboration: `CREATE INDEX idx_collaboration_publication_custody_collaboration
    ON collaboration_publication_custody(org_id,campaign_id,collaboration_id,id)`,
  idx_collaboration_publication_custody_knowledge: `CREATE INDEX idx_collaboration_publication_custody_knowledge
    ON collaboration_publication_custody(knowledge_entry_id)`
});

const TRIGGER_SQL = Object.freeze({
  collaboration_publication_custody_no_update: `CREATE TRIGGER collaboration_publication_custody_no_update
BEFORE UPDATE ON collaboration_publication_custody
BEGIN SELECT RAISE(ABORT,'collaboration publication custody is append-only'); END`,
  collaboration_publication_custody_no_delete: `CREATE TRIGGER collaboration_publication_custody_no_delete
BEFORE DELETE ON collaboration_publication_custody
BEGIN SELECT RAISE(ABORT,'collaboration publication custody is append-only'); END`,
  collaboration_publication_custody_scope_insert: `CREATE TRIGGER collaboration_publication_custody_scope_insert
BEFORE INSERT ON collaboration_publication_custody
WHEN NOT EXISTS (
  SELECT 1 FROM campaign_publications publication
  WHERE publication.id=NEW.publication_id
    AND publication.org_id=NEW.org_id
    AND publication.campaign_id=NEW.campaign_id
) OR NOT EXISTS (
  SELECT 1 FROM campaign_record_links link
  WHERE link.id=NEW.publication_relation_link_id
    AND link.org_id=NEW.org_id
    AND link.campaign_id=NEW.campaign_id
    AND link.record_type='collaboration'
    AND link.record_id=CAST(NEW.collaboration_id AS TEXT)
    AND link.relation_type='publication'
    AND link.revoked_at IS NULL
) OR NOT EXISTS (
  SELECT 1 FROM knowledge_entries submission
  WHERE submission.id=NEW.review_submission_entry_id
    AND submission.entry_type='collaboration_content_review'
    AND submission.source_type='collaboration_content_review'
    AND submission.business_type='campaign'
    AND CAST(submission.business_id AS TEXT)=CAST(NEW.campaign_id AS TEXT)
    AND CAST(json_extract(submission.metadata_json,'$.collaboration_id') AS INTEGER)=NEW.collaboration_id
    AND json_extract(submission.metadata_json,'$.action')='submitted'
    AND json_extract(submission.metadata_json,'$.retrieval_eligible')=0
) OR NOT EXISTS (
  SELECT 1 FROM knowledge_entries decision
  WHERE decision.id=NEW.review_decision_entry_id
    AND decision.entry_type='collaboration_content_review'
    AND decision.source_type='collaboration_content_review'
    AND decision.business_type='campaign'
    AND CAST(decision.business_id AS TEXT)=CAST(NEW.campaign_id AS TEXT)
    AND CAST(json_extract(decision.metadata_json,'$.collaboration_id') AS INTEGER)=NEW.collaboration_id
    AND json_extract(decision.metadata_json,'$.action')='approved'
    AND CAST(json_extract(decision.metadata_json,'$.submission_entry_id') AS INTEGER)=NEW.review_submission_entry_id
    AND json_extract(decision.metadata_json,'$.retrieval_eligible')=0
)
BEGIN SELECT RAISE(ABORT,'collaboration publication custody scope is invalid'); END`,
  collaboration_publication_custody_knowledge_insert: `CREATE TRIGGER collaboration_publication_custody_knowledge_insert
BEFORE INSERT ON collaboration_publication_custody
WHEN NOT EXISTS (
  SELECT 1
  FROM knowledge_entries entry
  JOIN campaign_record_links link
    ON link.record_type='knowledge_entry'
   AND link.record_id=CAST(entry.id AS TEXT)
   AND link.relation_type='knowledge'
   AND link.revoked_at IS NULL
  WHERE entry.id=NEW.knowledge_entry_id
    AND entry.entry_type='campaign_publication_handoff'
    AND entry.source_type='campaign_publication_handoff'
    AND CAST(entry.source_id AS TEXT)=CAST(NEW.id AS TEXT)
    AND entry.created_by=NEW.confirmed_by
    AND entry.visibility='team'
    AND entry.business_type='campaign'
    AND CAST(entry.business_id AS TEXT)=CAST(NEW.campaign_id AS TEXT)
    AND CAST(json_extract(entry.metadata_json,'$.custody_id') AS INTEGER)=NEW.id
    AND CAST(json_extract(entry.metadata_json,'$.collaboration_id') AS INTEGER)=NEW.collaboration_id
    AND CAST(json_extract(entry.metadata_json,'$.publication_id') AS INTEGER)=NEW.publication_id
    AND json_extract(entry.metadata_json,'$.deliverable_key')=NEW.deliverable_key
    AND json_extract(entry.metadata_json,'$.final_url_sha256')=NEW.final_url_sha256
    AND json_extract(entry.metadata_json,'$.retrieval_eligible')=0
    AND link.org_id=NEW.org_id
    AND link.campaign_id=NEW.campaign_id
    AND link.created_by=NEW.confirmed_by
    AND json_extract(link.metadata_json,'$.producer_type')='campaign_publication_handoff'
    AND CAST(json_extract(link.metadata_json,'$.producer_id') AS INTEGER)=NEW.collaboration_id
    AND CAST(json_extract(link.metadata_json,'$.source_id') AS TEXT)=CAST(NEW.id AS TEXT)
)
BEGIN SELECT RAISE(ABORT,'collaboration publication custody knowledge is invalid'); END`
});

const migration = {
  version: 17,
  name: '017_collaboration_publication_custody',
  sourcePath: 'migrations/017_collaboration_publication_custody.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      collaboration_publication_custody: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        collaboration_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        publication_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        deliverable_key: { type: 'TEXT', notnull: 1, defaultValue: null },
        registration_mode: { type: 'TEXT', notnull: 1, defaultValue: null },
        review_submission_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        review_decision_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        publication_relation_link_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        knowledge_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        confirmed_url: { type: 'TEXT', notnull: 1, defaultValue: null },
        final_url_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        published_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        publication_note: { type: 'TEXT', notnull: 0, defaultValue: null },
        confirmed_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        confirmed_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      collaboration_publication_custody: [
        'UNIQUE(org_id,campaign_id,collaboration_id,deliverable_key)',
        'UNIQUE(org_id,campaign_id,publication_id)',
        'UNIQUE(knowledge_entry_id)',
        "CHECK(registration_mode IN ('created','existing'))",
        "CHECK(length(final_url_sha256)=64 AND final_url_sha256=lower(final_url_sha256) AND final_url_sha256 NOT GLOB '*[^0-9a-f]*')"
      ]
    }
  },
  apply(db) {
    const required = [
      'campaigns',
      'organization_memberships',
      'collaborations',
      'campaign_publications',
      'knowledge_entries',
      'campaign_record_links'
    ];
    for (const name of required) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`017 requires ${name}`);
      }
    }
    const objectNames = [
      'collaboration_publication_custody',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 017 object exists: ${existing[0].name}`);
    db.exec([
      TABLE_SQL,
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;
