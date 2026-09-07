'use strict';

const TABLE_SQL = `CREATE TABLE influencer_saved_views (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  user_id INTEGER NOT NULL CHECK(user_id BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL CHECK(
    length(name) BETWEEN 1 AND 32
    AND name=trim(name)
    AND name NOT GLOB '*[' || char(0) || '-' || char(31) || ']*'
  ),
  filters_json TEXT NOT NULL DEFAULT '{}' CHECK(
    json_valid(filters_json)
    AND json_type(filters_json)='object'
    AND length(CAST(filters_json AS BLOB)) <= 16384
  ),
  visible_columns_json TEXT NOT NULL CHECK(
    json_valid(visible_columns_json)
    AND json_type(visible_columns_json)='array'
    AND json_array_length(visible_columns_json) BETWEEN 1 AND 15
    AND length(CAST(visible_columns_json AS BLOB)) <= 2048
  ),
  column_order_json TEXT NOT NULL CHECK(
    json_valid(column_order_json)
    AND json_type(column_order_json)='array'
    AND json_array_length(column_order_json)=15
    AND length(CAST(column_order_json AS BLOB)) <= 2048
  ),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(
    row_version BETWEEN 1 AND 9007199254740991
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at
  ),
  FOREIGN KEY(user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT`;

const INDEX_SQL = Object.freeze({
  ux_influencer_saved_views_user_name: `CREATE UNIQUE INDEX ux_influencer_saved_views_user_name
    ON influencer_saved_views(user_id,lower(name))`,
  idx_influencer_saved_views_user_updated: `CREATE INDEX idx_influencer_saved_views_user_updated
    ON influencer_saved_views(user_id,updated_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  influencer_saved_views_limit_insert: `CREATE TRIGGER influencer_saved_views_limit_insert
BEFORE INSERT ON influencer_saved_views
WHEN (SELECT COUNT(*) FROM influencer_saved_views WHERE user_id=NEW.user_id) >= 20
BEGIN SELECT RAISE(ABORT,'saved view limit exceeded'); END`,
  influencer_saved_views_version_update: `CREATE TRIGGER influencer_saved_views_version_update
BEFORE UPDATE ON influencer_saved_views
WHEN NEW.user_id IS NOT OLD.user_id
  OR NEW.row_version<>OLD.row_version+1
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'invalid saved view update'); END`
});

const migration = {
  version: 15,
  name: '015_influencer_saved_views',
  sourcePath: 'migrations/015_influencer_saved_views.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      influencer_saved_views: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        name: { type: 'TEXT', notnull: 1, defaultValue: null },
        filters_json: { type: 'TEXT', notnull: 1, defaultValue: "'{}'" },
        visible_columns_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        column_order_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        row_version: { type: 'INTEGER', notnull: 1, defaultValue: '1' },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      influencer_saved_views: [
        'CHECK(id BETWEEN 1 AND 9007199254740991)',
        'CHECK(user_id BETWEEN 1 AND 9007199254740991)',
        "CHECK(length(name) BETWEEN 1 AND 32 AND name=trim(name) AND name NOT GLOB '*[' || char(0) || '-' || char(31) || ']*')",
        "CHECK(json_valid(filters_json) AND json_type(filters_json)='object' AND length(CAST(filters_json AS BLOB)) <= 16384)",
        "CHECK(json_valid(visible_columns_json) AND json_type(visible_columns_json)='array' AND json_array_length(visible_columns_json) BETWEEN 1 AND 15 AND length(CAST(visible_columns_json AS BLOB)) <= 2048)",
        "CHECK(json_valid(column_order_json) AND json_type(column_order_json)='array' AND json_array_length(column_order_json)=15 AND length(CAST(column_order_json AS BLOB)) <= 2048)",
        'CHECK(row_version BETWEEN 1 AND 9007199254740991)'
      ]
    }
  },
  apply(db) {
    if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='users'").get()) {
      throw new Error('015 requires users');
    }
    const objectNames = [
      'influencer_saved_views',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 015 object exists: ${existing[0].name}`);
    db.exec([
      TABLE_SQL,
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;
