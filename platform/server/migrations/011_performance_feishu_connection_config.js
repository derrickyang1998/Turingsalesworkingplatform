'use strict';

const TABLE_SQL = `CREATE TABLE performance_feishu_projection_configs (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  bitable_app_token TEXT NOT NULL CHECK(length(bitable_app_token) BETWEEN 3 AND 160),
  current_table_id TEXT NOT NULL CHECK(length(current_table_id) BETWEEN 3 AND 160),
  daily_snapshot_table_id TEXT CHECK(daily_snapshot_table_id IS NULL OR length(daily_snapshot_table_id) BETWEEN 3 AND 160),
  field_mapping_json TEXT NOT NULL CHECK(
    json_valid(field_mapping_json)
    AND json_type(field_mapping_json)='object'
    AND length(CAST(field_mapping_json AS BLOB)) BETWEEN 2 AND 8192
  ),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','superseded')),
  created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
  approved_by INTEGER CHECK(approved_by IS NULL OR approved_by BETWEEN 1 AND 9007199254740991),
  approved_at TEXT CHECK(approved_at IS NULL OR length(approved_at) BETWEEN 20 AND 40),
  superseded_at TEXT CHECK(superseded_at IS NULL OR length(superseded_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL),
  UNIQUE(org_id,campaign_id,version),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,approved_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (status='draft' AND approved_by IS NULL AND approved_at IS NULL AND superseded_at IS NULL)
    OR (status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND superseded_at IS NULL)
    OR (status='superseded' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND superseded_at IS NOT NULL)
  )
) STRICT`;

const INDEX_SQL = Object.freeze({
  idx_performance_feishu_projection_configs_campaign_version: `CREATE INDEX idx_performance_feishu_projection_configs_campaign_version
    ON performance_feishu_projection_configs(org_id,campaign_id,version DESC,id DESC)`,
  ux_performance_feishu_projection_configs_one_approved: `CREATE UNIQUE INDEX ux_performance_feishu_projection_configs_one_approved
    ON performance_feishu_projection_configs(org_id,campaign_id) WHERE status='approved'`
});

const TRIGGER_SQL = Object.freeze({
  performance_feishu_projection_configs_state_transition: `CREATE TRIGGER performance_feishu_projection_configs_state_transition
BEFORE UPDATE ON performance_feishu_projection_configs
WHEN NOT (
  (
    OLD.status='draft'
    AND NEW.status='approved'
    AND NEW.id IS OLD.id
    AND NEW.org_id IS OLD.org_id
    AND NEW.campaign_id IS OLD.campaign_id
    AND NEW.version IS OLD.version
    AND NEW.bitable_app_token IS OLD.bitable_app_token
    AND NEW.current_table_id IS OLD.current_table_id
    AND NEW.daily_snapshot_table_id IS OLD.daily_snapshot_table_id
    AND NEW.field_mapping_json IS OLD.field_mapping_json
    AND NEW.created_by IS OLD.created_by
    AND OLD.approved_by IS NULL
    AND OLD.approved_at IS NULL
    AND OLD.superseded_at IS NULL
    AND NEW.approved_by IS NOT NULL
    AND NEW.approved_at IS NOT NULL
    AND NEW.superseded_at IS NULL
    AND NEW.created_at IS OLD.created_at
  )
  OR
  (
    OLD.status='approved'
    AND NEW.status='superseded'
    AND NEW.id IS OLD.id
    AND NEW.org_id IS OLD.org_id
    AND NEW.campaign_id IS OLD.campaign_id
    AND NEW.version IS OLD.version
    AND NEW.bitable_app_token IS OLD.bitable_app_token
    AND NEW.current_table_id IS OLD.current_table_id
    AND NEW.daily_snapshot_table_id IS OLD.daily_snapshot_table_id
    AND NEW.field_mapping_json IS OLD.field_mapping_json
    AND NEW.created_by IS OLD.created_by
    AND NEW.approved_by IS OLD.approved_by
    AND NEW.approved_at IS OLD.approved_at
    AND NEW.superseded_at IS NOT NULL
    AND OLD.superseded_at IS NULL
    AND NEW.created_at IS OLD.created_at
  )
)
BEGIN SELECT RAISE(ABORT,'performance Feishu projection config is immutable except state transition'); END`,
  performance_feishu_projection_configs_no_delete: `CREATE TRIGGER performance_feishu_projection_configs_no_delete
BEFORE DELETE ON performance_feishu_projection_configs
BEGIN SELECT RAISE(ABORT,'performance Feishu projection configs are append-only'); END`
});

const migration = {
  version: 11,
  name: '011_performance_feishu_connection_config',
  sourcePath: 'migrations/011_performance_feishu_connection_config.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      performance_feishu_projection_configs: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        bitable_app_token: { type: 'TEXT', notnull: 1, defaultValue: null },
        current_table_id: { type: 'TEXT', notnull: 1, defaultValue: null },
        daily_snapshot_table_id: { type: 'TEXT', notnull: 0, defaultValue: null },
        field_mapping_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        status: { type: 'TEXT', notnull: 1, defaultValue: "'draft'" },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        approved_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        approved_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        superseded_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      performance_feishu_projection_configs: [
        "CHECK(status IN ('draft','approved','superseded'))",
        "CHECK(json_valid(field_mapping_json) AND json_type(field_mapping_json)='object' AND length(CAST(field_mapping_json AS BLOB)) BETWEEN 2 AND 8192)",
        'UNIQUE(org_id,campaign_id,version)'
      ]
    }
  },
  apply(db) {
    const required = ['campaigns', 'organization_memberships'];
    for (const name of required) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`011 requires ${name}`);
      }
    }
    const objectNames = [
      'performance_feishu_projection_configs',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 011 object exists: ${existing[0].name}`);
    db.exec([
      TABLE_SQL,
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;
