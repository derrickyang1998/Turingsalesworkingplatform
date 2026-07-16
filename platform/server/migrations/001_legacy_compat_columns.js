const engine = require('./engines/v1');

const COLUMNS = {
  customers: {
    lead_source: { definition: 'lead_source TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    lead_score: { definition: 'lead_score INTEGER DEFAULT 0', type: 'INTEGER', notnull: 0, defaultValue: '0' },
    assigned_at: { definition: 'assigned_at DATETIME', type: 'DATETIME', notnull: 0, defaultValue: null },
    last_followup: { definition: 'last_followup DATETIME', type: 'DATETIME', notnull: 0, defaultValue: null },
    opportunity_value: { definition: 'opportunity_value REAL DEFAULT 0', type: 'REAL', notnull: 0, defaultValue: '0' },
    win_probability: { definition: 'win_probability INTEGER DEFAULT 50', type: 'INTEGER', notnull: 0, defaultValue: '50' },
    tags: { definition: 'tags TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    is_public: { definition: 'is_public INTEGER DEFAULT 1', type: 'INTEGER', notnull: 0, defaultValue: '1' },
    last_activity: { definition: 'last_activity TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    claim_deadline: { definition: 'claim_deadline TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    expected_close_date: { definition: 'expected_close_date TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    priority: { definition: 'priority TEXT DEFAULT "medium"', type: 'TEXT', notnull: 0, defaultValue: '"medium"' }
  },
  influencers: {
    project_name: { definition: 'project_name TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    product_name: { definition: 'product_name TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    reporter: { definition: 'reporter TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    tags: { definition: 'tags TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    quoted_price: { definition: 'quoted_price INTEGER DEFAULT 0', type: 'INTEGER', notnull: 0, defaultValue: '0' },
    content_deliverable: { definition: 'content_deliverable TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    is_duplicate: { definition: 'is_duplicate INTEGER DEFAULT 0', type: 'INTEGER', notnull: 0, defaultValue: '0' },
    import_batch: { definition: 'import_batch TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    influencer_type: { definition: 'influencer_type TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    cpv: { definition: 'cpv REAL DEFAULT 0', type: 'REAL', notnull: 0, defaultValue: '0' },
    parent_record: { definition: 'parent_record TEXT', type: 'TEXT', notnull: 0, defaultValue: null }
  },
  knowledge_entries: {
    title: { definition: "title TEXT DEFAULT ''", type: 'TEXT', notnull: 0, defaultValue: "''" },
    summary: { definition: "summary TEXT DEFAULT ''", type: 'TEXT', notnull: 0, defaultValue: "''" },
    tags_json: { definition: "tags_json TEXT DEFAULT '[]'", type: 'TEXT', notnull: 0, defaultValue: "'[]'" },
    visibility: { definition: "visibility TEXT DEFAULT 'team'", type: 'TEXT', notnull: 0, defaultValue: "'team'" },
    source_hash: { definition: 'source_hash TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    business_type: { definition: 'business_type TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    business_id: { definition: 'business_id TEXT', type: 'TEXT', notnull: 0, defaultValue: null },
    metadata_json: { definition: "metadata_json TEXT DEFAULT '{}'", type: 'TEXT', notnull: 0, defaultValue: "'{}'" },
    embedding_json: { definition: 'embedding_json TEXT', type: 'TEXT', notnull: 0, defaultValue: null }
  },
  collaborations: {
    row_version: { definition: 'row_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(row_version) = \'integer\' AND row_version >= 1 AND row_version <= 9007199254740991)', type: 'INTEGER', notnull: 1, defaultValue: '1' },
    cost_actual_confirmed: { definition: 'cost_actual_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(typeof(cost_actual_confirmed) = \'integer\' AND cost_actual_confirmed IN (0,1))', type: 'INTEGER', notnull: 1, defaultValue: '0' }
  }
};

const INDEX_DDL = {
  idx_knowledge_source_hash: "CREATE UNIQUE INDEX idx_knowledge_source_hash ON knowledge_entries(source_hash) WHERE source_hash IS NOT NULL AND source_hash != ''",
  idx_knowledge_visibility: 'CREATE INDEX idx_knowledge_visibility ON knowledge_entries(visibility, created_by)',
  idx_knowledge_source: 'CREATE INDEX idx_knowledge_source ON knowledge_entries(source_type, source_id)',
  idx_ai_conversations_user: 'CREATE INDEX idx_ai_conversations_user ON ai_conversations(user_id, updated_at)',
  idx_ai_messages_conversation: 'CREATE INDEX idx_ai_messages_conversation ON ai_messages(conversation_id, created_at)',
  idx_ai_references_message: 'CREATE INDEX idx_ai_references_message ON ai_references(message_id)'
};

const TRIGGER_DDL = {
  trg_collaborations_validate_insert: `CREATE TRIGGER trg_collaborations_validate_insert
BEFORE INSERT ON collaborations
BEGIN
  SELECT CASE WHEN NEW.row_version IS NOT NULL AND (typeof(NEW.row_version) != 'integer' OR NEW.row_version < 1 OR NEW.row_version > 9007199254740991)
    THEN RAISE(ABORT, 'row_version must be a positive safe integer') END;
  SELECT CASE WHEN NEW.cost_actual_confirmed IS NOT NULL AND (typeof(NEW.cost_actual_confirmed) != 'integer' OR NEW.cost_actual_confirmed NOT IN (0,1))
    THEN RAISE(ABORT, 'cost_actual_confirmed must be integer 0 or 1') END;
END`,
  trg_collaborations_validate_update: `CREATE TRIGGER trg_collaborations_validate_update
BEFORE UPDATE ON collaborations
BEGIN
  SELECT CASE WHEN NEW.row_version IS NOT NULL AND (typeof(NEW.row_version) != 'integer' OR NEW.row_version < 1 OR NEW.row_version > 9007199254740991)
    THEN RAISE(ABORT, 'row_version must be a positive safe integer') END;
  SELECT CASE WHEN NEW.row_version != OLD.row_version AND NEW.row_version != OLD.row_version + 1
    THEN RAISE(ABORT, 'row_version must stay unchanged or increment exactly once') END;
  SELECT CASE WHEN NEW.cost_actual_confirmed IS NOT NULL AND (typeof(NEW.cost_actual_confirmed) != 'integer' OR NEW.cost_actual_confirmed NOT IN (0,1))
    THEN RAISE(ABORT, 'cost_actual_confirmed must be integer 0 or 1') END;
END`,
  trg_collaborations_row_version_update: `CREATE TRIGGER trg_collaborations_row_version_update
AFTER UPDATE ON collaborations
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE collaborations
  SET row_version = OLD.row_version + 1
  WHERE id = NEW.id;
END`
};

const TABLE_CHECKS = {
  collaborations: [
    "CHECK(typeof(row_version) = 'integer' AND row_version >= 1 AND row_version <= 9007199254740991)",
    "CHECK(typeof(cost_actual_confirmed) = 'integer' AND cost_actual_confirmed IN (0,1))"
  ]
};

function schemaManifest() {
  const columns = {};
  for (const [table, tableColumns] of Object.entries(COLUMNS)) {
    columns[table] = {};
    for (const [name, column] of Object.entries(tableColumns)) {
      columns[table][name] = {
        type: column.type,
        notnull: column.notnull,
        defaultValue: column.defaultValue
      };
    }
  }
  return {
    columns,
    indexes: INDEX_DDL,
    triggers: TRIGGER_DDL,
    tableChecks: TABLE_CHECKS
  };
}

const migration = {
  version: 1,
  name: '001_legacy_compat_columns',
  sourcePath: 'migrations/001_legacy_compat_columns.js',
  engineVersion: 1,
  dependencies: [],
  schemaManifest: schemaManifest(),
  apply(db) {
    for (const [table, tableColumns] of Object.entries(COLUMNS)) {
      for (const column of Object.values(tableColumns)) {
        engine.addColumnIfMissing(db, table, column.definition);
      }
    }

    db.exec(`
      UPDATE collaborations
      SET row_version = 1
      WHERE row_version IS NULL;
      UPDATE collaborations
      SET cost_actual_confirmed = 0
      WHERE cost_actual_confirmed IS NULL;

      DROP INDEX IF EXISTS idx_knowledge_source_hash;
      ${Object.values(INDEX_DDL).join(';\n      ')};
      ${Object.values(TRIGGER_DDL).join(';\n      ')};
    `);
  }
};

module.exports = migration;
