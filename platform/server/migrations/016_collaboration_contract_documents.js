'use strict';

const TABLE_SQL = `CREATE TABLE collaboration_contract_documents (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  collaboration_id INTEGER NOT NULL CHECK(collaboration_id BETWEEN 1 AND 9007199254740991),
  uploaded_by INTEGER NOT NULL CHECK(uploaded_by BETWEEN 1 AND 9007199254740991),
  knowledge_entry_id INTEGER NOT NULL CHECK(knowledge_entry_id BETWEEN 1 AND 9007199254740991),
  original_filename TEXT NOT NULL CHECK(
    length(original_filename) BETWEEN 5 AND 180
    AND length(CAST(original_filename AS BLOB)) <= 255
    AND original_filename=trim(original_filename)
    AND lower(substr(original_filename,-4))='.pdf'
    AND original_filename NOT GLOB '*[' || char(0) || '-' || char(31) || ']*'
    AND instr(original_filename,char(127))=0
    AND instr(original_filename,'/')=0
    AND instr(original_filename,'\\')=0
    AND instr(original_filename,'<')=0
    AND instr(original_filename,'>')=0
    AND instr(original_filename,':')=0
    AND instr(original_filename,'"')=0
    AND instr(original_filename,'|')=0
    AND instr(original_filename,'?')=0
    AND instr(original_filename,'*')=0
  ),
  media_type TEXT NOT NULL CHECK(media_type='application/pdf'),
  file_sha256 TEXT NOT NULL CHECK(
    length(file_sha256)=64 AND file_sha256=lower(file_sha256)
    AND file_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  file_bytes INTEGER NOT NULL CHECK(file_bytes BETWEEN 32 AND 8388608),
  document_blob BLOB NOT NULL CHECK(
    typeof(document_blob)='blob'
    AND length(document_blob)=file_bytes
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  UNIQUE(collaboration_id,file_sha256),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,uploaded_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(collaboration_id) REFERENCES collaborations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(knowledge_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  ux_collaboration_contract_documents_identity: `CREATE UNIQUE INDEX ux_collaboration_contract_documents_identity
    ON collaboration_contract_documents(collaboration_id,file_sha256)`,
  idx_collaboration_contract_documents_campaign_created: `CREATE INDEX idx_collaboration_contract_documents_campaign_created
    ON collaboration_contract_documents(org_id,campaign_id,collaboration_id,created_at DESC,id DESC)`,
  idx_collaboration_contract_documents_knowledge: `CREATE INDEX idx_collaboration_contract_documents_knowledge
    ON collaboration_contract_documents(knowledge_entry_id)`
});

const TRIGGER_SQL = Object.freeze({
  collaboration_contract_documents_no_update: `CREATE TRIGGER collaboration_contract_documents_no_update
BEFORE UPDATE ON collaboration_contract_documents
BEGIN SELECT RAISE(ABORT,'collaboration contract documents are append-only'); END`,
  collaboration_contract_documents_no_delete: `CREATE TRIGGER collaboration_contract_documents_no_delete
BEFORE DELETE ON collaboration_contract_documents
BEGIN SELECT RAISE(ABORT,'collaboration contract documents are append-only'); END`,
  collaboration_contract_documents_limit_insert: `CREATE TRIGGER collaboration_contract_documents_limit_insert
BEFORE INSERT ON collaboration_contract_documents
WHEN (SELECT COUNT(*) FROM collaboration_contract_documents WHERE collaboration_id=NEW.collaboration_id) >= 5
BEGIN SELECT RAISE(ABORT,'collaboration contract document file limit exceeded'); END`,
  collaboration_contract_documents_scope_insert: `CREATE TRIGGER collaboration_contract_documents_scope_insert
BEFORE INSERT ON collaboration_contract_documents
WHEN NOT EXISTS (
  SELECT 1
  FROM campaign_record_links link
  WHERE link.org_id=NEW.org_id
    AND link.campaign_id=NEW.campaign_id
    AND link.record_type='collaboration'
    AND link.record_id=CAST(NEW.collaboration_id AS TEXT)
    AND link.relation_type IN ('order','execution','publication','settlement')
    AND link.revoked_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'collaboration contract document custody is invalid'); END`,
  collaboration_contract_documents_knowledge_insert: `CREATE TRIGGER collaboration_contract_documents_knowledge_insert
BEFORE INSERT ON collaboration_contract_documents
WHEN NOT EXISTS (
  SELECT 1
  FROM knowledge_entries entry
  JOIN campaign_record_links link
    ON link.record_type='knowledge_entry'
   AND link.record_id=CAST(entry.id AS TEXT)
   AND link.relation_type='knowledge'
   AND link.revoked_at IS NULL
  WHERE entry.id=NEW.knowledge_entry_id
    AND entry.entry_type='collaboration_contract_document'
    AND entry.source_type='collaboration_contract_document'
    AND CAST(entry.source_id AS TEXT)=CAST(NEW.id AS TEXT)
    AND entry.created_by=NEW.uploaded_by
    AND entry.visibility='team'
    AND entry.business_type='campaign'
    AND CAST(entry.business_id AS TEXT)=CAST(NEW.campaign_id AS TEXT)
    AND link.org_id=NEW.org_id
    AND link.campaign_id=NEW.campaign_id
    AND link.created_by=NEW.uploaded_by
    AND json_extract(link.metadata_json,'$.producer_type')='collaboration_contract_document'
    AND json_extract(link.metadata_json,'$.producer_id')=NEW.collaboration_id
    AND json_extract(link.metadata_json,'$.source_type')='collaboration_contract_document'
    AND CAST(json_extract(link.metadata_json,'$.source_id') AS TEXT)=CAST(NEW.id AS TEXT)
)
BEGIN SELECT RAISE(ABORT,'collaboration contract document knowledge custody is invalid'); END`
});

const migration = {
  version: 16,
  name: '016_collaboration_contract_documents',
  sourcePath: 'migrations/016_collaboration_contract_documents.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      collaboration_contract_documents: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        collaboration_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        uploaded_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        knowledge_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        original_filename: { type: 'TEXT', notnull: 1, defaultValue: null },
        media_type: { type: 'TEXT', notnull: 1, defaultValue: null },
        file_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        file_bytes: { type: 'INTEGER', notnull: 1, defaultValue: null },
        document_blob: { type: 'BLOB', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      collaboration_contract_documents: [
        'CHECK(id BETWEEN 1 AND 9007199254740991)',
        'CHECK(org_id BETWEEN 1 AND 9007199254740991)',
        'CHECK(campaign_id BETWEEN 1 AND 9007199254740991)',
        'CHECK(collaboration_id BETWEEN 1 AND 9007199254740991)',
        'CHECK(uploaded_by BETWEEN 1 AND 9007199254740991)',
        'CHECK(knowledge_entry_id BETWEEN 1 AND 9007199254740991)',
        "CHECK(media_type='application/pdf')",
        "CHECK(length(file_sha256)=64 AND file_sha256=lower(file_sha256) AND file_sha256 NOT GLOB '*[^0-9a-f]*')",
        'CHECK(file_bytes BETWEEN 32 AND 8388608)',
        "CHECK(typeof(document_blob)='blob' AND length(document_blob)=file_bytes)",
        'UNIQUE(collaboration_id,file_sha256)'
      ]
    }
  },
  apply(db) {
    const required = [
      'campaigns',
      'organization_memberships',
      'collaborations',
      'knowledge_entries',
      'campaign_record_links'
    ];
    for (const name of required) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`016 requires ${name}`);
      }
    }
    const objectNames = [
      'collaboration_contract_documents',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 016 object exists: ${existing[0].name}`);
    db.exec([
      TABLE_SQL,
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;
