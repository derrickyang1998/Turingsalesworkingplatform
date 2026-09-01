'use strict';

const TABLE_SQL = Object.freeze({
  campaign_publications: `CREATE TABLE campaign_publications (
    id INTEGER PRIMARY KEY,
    org_id INTEGER NOT NULL,
    campaign_id INTEGER NOT NULL,
    canonical_identity TEXT NOT NULL CHECK(length(canonical_identity) BETWEEN 3 AND 360),
    original_url TEXT NOT NULL CHECK(length(original_url) BETWEEN 8 AND 4096),
    canonical_url TEXT NOT NULL CHECK(length(canonical_url) BETWEEN 8 AND 4096),
    platform TEXT NOT NULL CHECK(platform IN ('tiktok','instagram','youtube','facebook','x','manual','custom')),
    platform_content_id TEXT CHECK(platform_content_id IS NULL OR length(platform_content_id) BETWEEN 1 AND 512),
    creator_id TEXT CHECK(creator_id IS NULL OR length(creator_id) BETWEEN 1 AND 256),
    creator_name TEXT CHECK(creator_name IS NULL OR length(creator_name) BETWEEN 1 AND 256),
    product TEXT CHECK(product IS NULL OR length(product) BETWEEN 1 AND 256),
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json) AND json_type(tags_json)='array'),
    custom_fields_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(custom_fields_json) AND json_type(custom_fields_json)='object'),
    search_payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(search_payload_json) AND json_type(search_payload_json)='object'),
    source_mode TEXT NOT NULL CHECK(source_mode IN ('manual','csv_xlsx')),
    source_file_hash TEXT CHECK(source_file_hash IS NULL OR length(source_file_hash)=64),
    mapping_version TEXT CHECK(mapping_version IS NULL OR length(mapping_version) BETWEEN 1 AND 160),
    source_row_number INTEGER CHECK(source_row_number IS NULL OR source_row_number BETWEEN 1 AND 1000000000),
    published_at TEXT CHECK(published_at IS NULL OR length(published_at) BETWEEN 20 AND 40),
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL),
    UNIQUE(org_id,campaign_id,canonical_identity),
    FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT`,
  performance_metric_observations: `CREATE TABLE performance_metric_observations (
    id INTEGER PRIMARY KEY,
    org_id INTEGER NOT NULL,
    campaign_id INTEGER NOT NULL,
    publication_id INTEGER NOT NULL,
    source_mode TEXT NOT NULL CHECK(source_mode IN ('manual','csv_xlsx')),
    metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json) AND json_type(metrics_json)='object'),
    observed_at TEXT NOT NULL CHECK(length(observed_at) BETWEEN 20 AND 40),
    correction_reason TEXT CHECK(correction_reason IS NULL OR length(correction_reason) BETWEEN 1 AND 500),
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL),
    FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(publication_id) REFERENCES campaign_publications(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT`,
  performance_manual_inputs: `CREATE TABLE performance_manual_inputs (
    id INTEGER PRIMARY KEY,
    org_id INTEGER NOT NULL,
    campaign_id INTEGER NOT NULL,
    publication_id INTEGER NOT NULL,
    commercial_json TEXT NOT NULL CHECK(json_valid(commercial_json) AND json_type(commercial_json)='object'),
    approval_state TEXT NOT NULL CHECK(approval_state IN ('draft','approved')),
    correction_reason TEXT CHECK(correction_reason IS NULL OR length(correction_reason) BETWEEN 1 AND 500),
    supersedes_input_id INTEGER,
    created_by INTEGER NOT NULL,
    approved_by INTEGER,
    approved_at TEXT CHECK(approved_at IS NULL OR length(approved_at) BETWEEN 20 AND 40),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL),
    FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(publication_id) REFERENCES campaign_publications(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(org_id,approved_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(supersedes_input_id) REFERENCES performance_manual_inputs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK(
      (approval_state='draft' AND approved_by IS NULL AND approved_at IS NULL)
      OR (approval_state='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    )
  ) STRICT`
});

const INDEX_SQL = Object.freeze({
  idx_campaign_publications_campaign_created: `CREATE INDEX idx_campaign_publications_campaign_created
    ON campaign_publications(org_id,campaign_id,created_at DESC,id DESC)`,
  idx_campaign_publications_campaign_platform: `CREATE INDEX idx_campaign_publications_campaign_platform
    ON campaign_publications(org_id,campaign_id,platform,id DESC)`,
  idx_performance_metric_observations_current: `CREATE INDEX idx_performance_metric_observations_current
    ON performance_metric_observations(org_id,campaign_id,publication_id,observed_at DESC,id DESC)`,
  idx_performance_manual_inputs_current: `CREATE INDEX idx_performance_manual_inputs_current
    ON performance_manual_inputs(org_id,campaign_id,publication_id,created_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  campaign_publications_no_update: `CREATE TRIGGER campaign_publications_no_update
BEFORE UPDATE ON campaign_publications
BEGIN SELECT RAISE(ABORT,'campaign publications are immutable'); END`,
  campaign_publications_no_delete: `CREATE TRIGGER campaign_publications_no_delete
BEFORE DELETE ON campaign_publications
BEGIN SELECT RAISE(ABORT,'campaign publications are append-only'); END`,
  performance_metric_observations_no_update: `CREATE TRIGGER performance_metric_observations_no_update
BEFORE UPDATE ON performance_metric_observations
BEGIN SELECT RAISE(ABORT,'performance metric observations are immutable'); END`,
  performance_metric_observations_no_delete: `CREATE TRIGGER performance_metric_observations_no_delete
BEFORE DELETE ON performance_metric_observations
BEGIN SELECT RAISE(ABORT,'performance metric observations are append-only'); END`,
  performance_manual_inputs_no_update: `CREATE TRIGGER performance_manual_inputs_no_update
BEFORE UPDATE ON performance_manual_inputs
BEGIN SELECT RAISE(ABORT,'performance manual inputs are immutable'); END`,
  performance_manual_inputs_no_delete: `CREATE TRIGGER performance_manual_inputs_no_delete
BEFORE DELETE ON performance_manual_inputs
BEGIN SELECT RAISE(ABORT,'performance manual inputs are append-only'); END`
});

const migration = {
  version: 10,
  name: '010_performance_manual_foundation',
  sourcePath: 'migrations/010_performance_manual_foundation.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      campaign_publications: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        canonical_identity: { type: 'TEXT', notnull: 1, defaultValue: null },
        original_url: { type: 'TEXT', notnull: 1, defaultValue: null },
        canonical_url: { type: 'TEXT', notnull: 1, defaultValue: null },
        platform: { type: 'TEXT', notnull: 1, defaultValue: null },
        platform_content_id: { type: 'TEXT', notnull: 0, defaultValue: null },
        creator_id: { type: 'TEXT', notnull: 0, defaultValue: null },
        creator_name: { type: 'TEXT', notnull: 0, defaultValue: null },
        product: { type: 'TEXT', notnull: 0, defaultValue: null },
        tags_json: { type: 'TEXT', notnull: 1, defaultValue: "'[]'" },
        custom_fields_json: { type: 'TEXT', notnull: 1, defaultValue: "'{}'" },
        search_payload_json: { type: 'TEXT', notnull: 1, defaultValue: "'{}'" },
        source_mode: { type: 'TEXT', notnull: 1, defaultValue: null },
        source_file_hash: { type: 'TEXT', notnull: 0, defaultValue: null },
        mapping_version: { type: 'TEXT', notnull: 0, defaultValue: null },
        source_row_number: { type: 'INTEGER', notnull: 0, defaultValue: null },
        published_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      performance_metric_observations: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        publication_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        source_mode: { type: 'TEXT', notnull: 1, defaultValue: null },
        metrics_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        observed_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        correction_reason: { type: 'TEXT', notnull: 0, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      performance_manual_inputs: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        publication_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        commercial_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        approval_state: { type: 'TEXT', notnull: 1, defaultValue: null },
        correction_reason: { type: 'TEXT', notnull: 0, defaultValue: null },
        supersedes_input_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        approved_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        approved_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      campaign_publications: [
        'UNIQUE(org_id,campaign_id,canonical_identity)',
        "CHECK(json_valid(tags_json) AND json_type(tags_json)='array')"
      ],
      performance_metric_observations: [
        "CHECK(json_valid(metrics_json) AND json_type(metrics_json)='object')"
      ],
      performance_manual_inputs: [
        "CHECK(approval_state IN ('draft','approved'))",
        "CHECK(json_valid(commercial_json) AND json_type(commercial_json)='object')"
      ]
    }
  },
  apply(db) {
    const required = ['campaigns', 'organization_memberships'];
    for (const name of required) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`010 requires ${name}`);
      }
    }
    const objectNames = [
      ...Object.keys(TABLE_SQL),
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 010 object exists: ${existing[0].name}`);
    db.exec([
      ...Object.values(TABLE_SQL),
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;
