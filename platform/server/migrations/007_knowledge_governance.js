'use strict';

const TABLE_SQL = `CREATE TABLE knowledge_entry_governance (
  knowledge_entry_id INTEGER PRIMARY KEY
    REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  lineage_root_entry_id INTEGER NOT NULL
    REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  supersedes_entry_id INTEGER
    REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version_no INTEGER NOT NULL DEFAULT 1 CHECK(
    typeof(version_no)='integer' AND version_no BETWEEN 1 AND 9007199254740991
  ),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
  quality_state TEXT NOT NULL DEFAULT 'candidate'
    CHECK(quality_state IN ('candidate','confirmed','rejected')),
  retention_class TEXT NOT NULL DEFAULT 'protected'
    CHECK(retention_class IN ('protected','scheduled')),
  retain_until TEXT CHECK(
    retain_until IS NULL OR (
      strftime('%Y-%m-%d %H:%M:%S',retain_until) IS NOT NULL
      AND strftime('%Y-%m-%d %H:%M:%S',retain_until)=retain_until
    )
  ),
  governance_version INTEGER NOT NULL DEFAULT 1 CHECK(
    typeof(governance_version)='integer'
    AND governance_version BETWEEN 1 AND 9007199254740991
  ),
  reviewed_by INTEGER REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reviewed_at TEXT CHECK(
    reviewed_at IS NULL OR (
      strftime('%Y-%m-%d %H:%M:%S',reviewed_at) IS NOT NULL
      AND strftime('%Y-%m-%d %H:%M:%S',reviewed_at)=reviewed_at
    )
  ),
  review_reason TEXT CHECK(
    review_reason IS NULL OR length(trim(review_reason)) BETWEEN 1 AND 500
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at
  ),
  CHECK(supersedes_entry_id IS NULL OR supersedes_entry_id<>knowledge_entry_id),
  CHECK(
    (version_no=1 AND supersedes_entry_id IS NULL AND lineage_root_entry_id=knowledge_entry_id)
    OR (version_no>1 AND supersedes_entry_id IS NOT NULL)
  ),
  CHECK(
    (retention_class='protected' AND retain_until IS NULL)
    OR (retention_class='scheduled' AND retain_until IS NOT NULL)
  ),
  CHECK(
    (quality_state='candidate' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (
      quality_state IN ('confirmed','rejected')
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL
    )
  )
) STRICT, WITHOUT ROWID`;

const INDEX_SQL = Object.freeze({
  ux_knowledge_governance_lineage_version: `CREATE UNIQUE INDEX ux_knowledge_governance_lineage_version
  ON knowledge_entry_governance(lineage_root_entry_id,version_no)`,
  ux_knowledge_governance_predecessor: `CREATE UNIQUE INDEX ux_knowledge_governance_predecessor
  ON knowledge_entry_governance(supersedes_entry_id)
  WHERE supersedes_entry_id IS NOT NULL`,
  ux_knowledge_governance_current_lineage: `CREATE UNIQUE INDEX ux_knowledge_governance_current_lineage
  ON knowledge_entry_governance(lineage_root_entry_id)
  WHERE is_current=1`,
  idx_knowledge_governance_retrieval: `CREATE INDEX idx_knowledge_governance_retrieval
  ON knowledge_entry_governance(is_current,quality_state,retention_class,retain_until,knowledge_entry_id)`
});

const TRIGGER_SQL = Object.freeze({
  knowledge_governance_entry_insert: `CREATE TRIGGER knowledge_governance_entry_insert
AFTER INSERT ON knowledge_entries
BEGIN
  INSERT INTO knowledge_entry_governance (
    knowledge_entry_id,lineage_root_entry_id,version_no,is_current,
    quality_state,retention_class,governance_version
  ) VALUES (NEW.id,NEW.id,1,1,'candidate','protected',1);
END`,
  knowledge_governance_content_update_guard: `CREATE TRIGGER knowledge_governance_content_update_guard
BEFORE UPDATE OF content_sha256 ON knowledge_entries
WHEN NEW.content_sha256 IS NOT OLD.content_sha256
  AND EXISTS (
    SELECT 1 FROM knowledge_entry_governance governance
    WHERE governance.knowledge_entry_id=OLD.id
      AND (governance.is_current<>1 OR governance.quality_state='rejected')
  )
BEGIN
  SELECT RAISE(ABORT,'inactive knowledge content requires a new version');
END`,
  knowledge_governance_content_review_reset: `CREATE TRIGGER knowledge_governance_content_review_reset
AFTER UPDATE OF content_sha256 ON knowledge_entries
WHEN NEW.content_sha256 IS NOT OLD.content_sha256
BEGIN
  UPDATE knowledge_entry_governance
  SET quality_state='candidate',reviewed_by=NULL,reviewed_at=NULL,
      review_reason=NULL,governance_version=governance_version+1,
      updated_at=CURRENT_TIMESTAMP
  WHERE knowledge_entry_id=NEW.id;
END`
});

const migration = {
  version: 7,
  name: '007_knowledge_governance',
  sourcePath: 'migrations/007_knowledge_governance.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      knowledge_entry_governance: {
        knowledge_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        lineage_root_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        supersedes_entry_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        version_no: { type: 'INTEGER', notnull: 1, defaultValue: '1' },
        is_current: { type: 'INTEGER', notnull: 1, defaultValue: '1' },
        quality_state: { type: 'TEXT', notnull: 1, defaultValue: "'candidate'" },
        retention_class: { type: 'TEXT', notnull: 1, defaultValue: "'protected'" },
        retain_until: { type: 'TEXT', notnull: 0, defaultValue: null },
        governance_version: { type: 'INTEGER', notnull: 1, defaultValue: '1' },
        reviewed_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        reviewed_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        review_reason: { type: 'TEXT', notnull: 0, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      knowledge_entry_governance: [
        "CHECK(quality_state IN ('candidate','confirmed','rejected'))",
        "CHECK(retention_class IN ('protected','scheduled'))",
        'CHECK(is_current IN (0,1))',
        "CHECK((retention_class='protected' AND retain_until IS NULL) OR (retention_class='scheduled' AND retain_until IS NOT NULL))",
        "CHECK((version_no=1 AND supersedes_entry_id IS NULL AND lineage_root_entry_id=knowledge_entry_id) OR (version_no>1 AND supersedes_entry_id IS NOT NULL))"
      ]
    }
  },
  apply(db) {
    const objectNames = [
      'knowledge_entry_governance',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE name IN (${placeholders})
      ORDER BY name
    `).all(...objectNames);
    if (existing.length > 0) {
      throw new Error(`partial 007 object exists: ${existing[0].name}`);
    }

    db.exec(`${TABLE_SQL};`);
    db.exec(`
      INSERT INTO knowledge_entry_governance (
        knowledge_entry_id,lineage_root_entry_id,version_no,is_current,
        quality_state,retention_class,governance_version
      )
      SELECT id,id,1,1,'candidate','protected',1
      FROM knowledge_entries
      ORDER BY id;
    `);
    db.exec(`${Object.values(INDEX_SQL).join(';\n')};`);
    db.exec(`${Object.values(TRIGGER_SQL).join(';\n')};`);
  }
};

module.exports = migration;
