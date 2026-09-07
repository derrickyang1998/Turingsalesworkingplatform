'use strict';

const TABLE_SQL = `CREATE TABLE customer_report_ppt_artifacts (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  snapshot_id INTEGER NOT NULL CHECK(snapshot_id BETWEEN 1 AND 9007199254740991),
  created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
  report_contract_version TEXT NOT NULL CHECK(report_contract_version='customer_safe_v1'),
  redaction_policy_version TEXT NOT NULL CHECK(redaction_policy_version='customer-safe-v1'),
  ppt_contract_version TEXT NOT NULL CHECK(ppt_contract_version='customer-report-ppt-v1'),
  snapshot_report_sha256 TEXT NOT NULL CHECK(
    length(snapshot_report_sha256)=64 AND snapshot_report_sha256=lower(snapshot_report_sha256)
    AND snapshot_report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_cache_key TEXT NOT NULL CHECK(
    length(artifact_cache_key)=64 AND artifact_cache_key=lower(artifact_cache_key)
    AND artifact_cache_key NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_sha256 TEXT NOT NULL CHECK(
    length(artifact_sha256)=64 AND artifact_sha256=lower(artifact_sha256)
    AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_bytes INTEGER NOT NULL CHECK(artifact_bytes BETWEEN 4 AND 67108864),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  UNIQUE(org_id,campaign_id,snapshot_id,ppt_contract_version),
  UNIQUE(artifact_cache_key),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(snapshot_id) REFERENCES customer_report_snapshots(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  idx_customer_report_ppt_artifacts_campaign_created: `CREATE INDEX idx_customer_report_ppt_artifacts_campaign_created
    ON customer_report_ppt_artifacts(org_id,campaign_id,created_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  customer_report_ppt_artifacts_no_update: `CREATE TRIGGER customer_report_ppt_artifacts_no_update
BEFORE UPDATE ON customer_report_ppt_artifacts
BEGIN SELECT RAISE(ABORT,'customer report PPT artifacts are append-only'); END`,
  customer_report_ppt_artifacts_no_delete: `CREATE TRIGGER customer_report_ppt_artifacts_no_delete
BEFORE DELETE ON customer_report_ppt_artifacts
BEGIN SELECT RAISE(ABORT,'customer report PPT artifacts are append-only'); END`,
  customer_report_ppt_artifacts_snapshot_scope_insert: `CREATE TRIGGER customer_report_ppt_artifacts_snapshot_scope_insert
BEFORE INSERT ON customer_report_ppt_artifacts
WHEN NOT EXISTS (
  SELECT 1
  FROM customer_report_snapshots snapshot
  WHERE snapshot.id=NEW.snapshot_id
    AND snapshot.org_id=NEW.org_id
    AND snapshot.campaign_id=NEW.campaign_id
    AND snapshot.report_contract_version=NEW.report_contract_version
    AND snapshot.redaction_policy_version=NEW.redaction_policy_version
    AND snapshot.report_sha256=NEW.snapshot_report_sha256
)
BEGIN SELECT RAISE(ABORT,'customer report PPT artifact snapshot lineage is invalid'); END`
});

const migration = {
  version: 14,
  name: '014_customer_report_ppt_artifact',
  sourcePath: 'migrations/014_customer_report_ppt_artifact.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      customer_report_ppt_artifacts: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        snapshot_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        report_contract_version: { type: 'TEXT', notnull: 1, defaultValue: null },
        redaction_policy_version: { type: 'TEXT', notnull: 1, defaultValue: null },
        ppt_contract_version: { type: 'TEXT', notnull: 1, defaultValue: null },
        snapshot_report_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        artifact_cache_key: { type: 'TEXT', notnull: 1, defaultValue: null },
        artifact_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        artifact_bytes: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      customer_report_ppt_artifacts: [
        "CHECK(report_contract_version='customer_safe_v1')",
        "CHECK(redaction_policy_version='customer-safe-v1')",
        "CHECK(ppt_contract_version='customer-report-ppt-v1')",
        'CHECK(length(snapshot_report_sha256)=64 AND snapshot_report_sha256=lower(snapshot_report_sha256) AND snapshot_report_sha256 NOT GLOB \'*[^0-9a-f]*\')',
        'CHECK(length(artifact_cache_key)=64 AND artifact_cache_key=lower(artifact_cache_key) AND artifact_cache_key NOT GLOB \'*[^0-9a-f]*\')',
        'CHECK(length(artifact_sha256)=64 AND artifact_sha256=lower(artifact_sha256) AND artifact_sha256 NOT GLOB \'*[^0-9a-f]*\')',
        'CHECK(artifact_bytes BETWEEN 4 AND 67108864)',
        'UNIQUE(org_id,campaign_id,snapshot_id,ppt_contract_version)',
        'UNIQUE(artifact_cache_key)'
      ]
    }
  },
  apply(db) {
    const required = ['campaigns', 'organization_memberships', 'customer_report_snapshots'];
    for (const name of required) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`014 requires ${name}`);
      }
    }
    const objectNames = [
      'customer_report_ppt_artifacts',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 014 object exists: ${existing[0].name}`);
    db.exec([
      TABLE_SQL,
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;
