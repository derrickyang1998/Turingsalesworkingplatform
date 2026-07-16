const engine = require('./engines/v1');

const migration = {
  version: 1,
  name: '001_legacy_compat_columns',
  sourcePath: 'migrations/001_legacy_compat_columns.js',
  engineVersion: 1,
  dependencies: [],
  apply(db) {
    engine.addColumnIfMissing(db, 'customers', 'lead_source TEXT');
    engine.addColumnIfMissing(db, 'customers', 'lead_score INTEGER DEFAULT 0');
    engine.addColumnIfMissing(db, 'customers', 'assigned_at DATETIME');
    engine.addColumnIfMissing(db, 'customers', 'last_followup DATETIME');
    engine.addColumnIfMissing(db, 'customers', 'opportunity_value REAL DEFAULT 0');
    engine.addColumnIfMissing(db, 'customers', 'win_probability INTEGER DEFAULT 50');
    engine.addColumnIfMissing(db, 'customers', 'tags TEXT');
    engine.addColumnIfMissing(db, 'customers', 'is_public INTEGER DEFAULT 1');
    engine.addColumnIfMissing(db, 'customers', 'last_activity TEXT');
    engine.addColumnIfMissing(db, 'customers', 'claim_deadline TEXT');
    engine.addColumnIfMissing(db, 'customers', 'expected_close_date TEXT');
    engine.addColumnIfMissing(db, 'customers', 'priority TEXT DEFAULT "medium"');

    engine.addColumnIfMissing(db, 'influencers', 'project_name TEXT');
    engine.addColumnIfMissing(db, 'influencers', 'product_name TEXT');
    engine.addColumnIfMissing(db, 'influencers', 'reporter TEXT');
    engine.addColumnIfMissing(db, 'influencers', 'tags TEXT');
    engine.addColumnIfMissing(db, 'influencers', 'quoted_price INTEGER DEFAULT 0');
    engine.addColumnIfMissing(db, 'influencers', 'content_deliverable TEXT');
    engine.addColumnIfMissing(db, 'influencers', 'is_duplicate INTEGER DEFAULT 0');
    engine.addColumnIfMissing(db, 'influencers', 'import_batch TEXT');
    engine.addColumnIfMissing(db, 'influencers', 'influencer_type TEXT');
    engine.addColumnIfMissing(db, 'influencers', 'cpv REAL DEFAULT 0');
    engine.addColumnIfMissing(db, 'influencers', 'parent_record TEXT');

    engine.addColumnIfMissing(db, 'knowledge_entries', "title TEXT DEFAULT ''");
    engine.addColumnIfMissing(db, 'knowledge_entries', "summary TEXT DEFAULT ''");
    engine.addColumnIfMissing(db, 'knowledge_entries', "tags_json TEXT DEFAULT '[]'");
    engine.addColumnIfMissing(db, 'knowledge_entries', "visibility TEXT DEFAULT 'team'");
    engine.addColumnIfMissing(db, 'knowledge_entries', 'source_hash TEXT');
    engine.addColumnIfMissing(db, 'knowledge_entries', 'business_type TEXT');
    engine.addColumnIfMissing(db, 'knowledge_entries', 'business_id TEXT');
    engine.addColumnIfMissing(db, 'knowledge_entries', "metadata_json TEXT DEFAULT '{}'");
    engine.addColumnIfMissing(db, 'knowledge_entries', 'embedding_json TEXT');

    engine.addColumnIfMissing(db, 'collaborations', 'row_version INTEGER NOT NULL DEFAULT 1');
    engine.addColumnIfMissing(db, 'collaborations', 'cost_actual_confirmed INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE collaborations
      SET row_version = 1
      WHERE row_version IS NULL;
      UPDATE collaborations
      SET cost_actual_confirmed = 0
      WHERE cost_actual_confirmed IS NULL;

      DROP INDEX IF EXISTS idx_knowledge_source_hash;
      CREATE UNIQUE INDEX idx_knowledge_source_hash ON knowledge_entries(source_hash) WHERE source_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_knowledge_visibility ON knowledge_entries(visibility, created_by);
      CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_entries(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_references_message ON ai_references(message_id);

      CREATE TRIGGER IF NOT EXISTS trg_collaborations_validate_insert
      BEFORE INSERT ON collaborations
      BEGIN
        SELECT CASE WHEN NEW.row_version IS NOT NULL AND (typeof(NEW.row_version) != 'integer' OR NEW.row_version < 1 OR NEW.row_version > 9007199254740991)
          THEN RAISE(ABORT, 'row_version must be a positive safe integer') END;
        SELECT CASE WHEN NEW.cost_actual_confirmed IS NOT NULL AND (typeof(NEW.cost_actual_confirmed) != 'integer' OR NEW.cost_actual_confirmed NOT IN (0,1))
          THEN RAISE(ABORT, 'cost_actual_confirmed must be integer 0 or 1') END;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_collaborations_validate_update
      BEFORE UPDATE ON collaborations
      BEGIN
        SELECT CASE WHEN NEW.row_version IS NOT NULL AND (typeof(NEW.row_version) != 'integer' OR NEW.row_version < 1 OR NEW.row_version > 9007199254740991)
          THEN RAISE(ABORT, 'row_version must be a positive safe integer') END;
        SELECT CASE WHEN NEW.row_version != OLD.row_version AND NEW.row_version != OLD.row_version + 1
          THEN RAISE(ABORT, 'row_version must stay unchanged or increment exactly once') END;
        SELECT CASE WHEN NEW.cost_actual_confirmed IS NOT NULL AND (typeof(NEW.cost_actual_confirmed) != 'integer' OR NEW.cost_actual_confirmed NOT IN (0,1))
          THEN RAISE(ABORT, 'cost_actual_confirmed must be integer 0 or 1') END;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_collaborations_row_version_update
      AFTER UPDATE ON collaborations
      WHEN NEW.row_version = OLD.row_version
      BEGIN
        UPDATE collaborations
        SET row_version = OLD.row_version + 1
        WHERE id = NEW.id;
      END;
    `);
  }
};

module.exports = migration;
