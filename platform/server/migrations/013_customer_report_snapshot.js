'use strict';

const TABLE_SQL = `CREATE TABLE customer_report_snapshots (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
  source_knowledge_entry_id INTEGER NOT NULL CHECK(source_knowledge_entry_id BETWEEN 1 AND 9007199254740991),
  report_contract_version TEXT NOT NULL CHECK(report_contract_version='customer_safe_v1'),
  redaction_policy_version TEXT NOT NULL CHECK(redaction_policy_version='customer-safe-v1'),
  selected_metric TEXT NOT NULL,
  source_review_content_sha256 TEXT NOT NULL CHECK(
    length(source_review_content_sha256)=64 AND source_review_content_sha256=lower(source_review_content_sha256)
    AND source_review_content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_review_snapshot_hash TEXT NOT NULL CHECK(
    length(source_review_snapshot_hash)=64 AND source_review_snapshot_hash=lower(source_review_snapshot_hash)
    AND source_review_snapshot_hash NOT GLOB '*[^0-9a-f]*'
  ),
  current_evidence_snapshot_hash TEXT NOT NULL CHECK(
    length(current_evidence_snapshot_hash)=64 AND current_evidence_snapshot_hash=lower(current_evidence_snapshot_hash)
    AND current_evidence_snapshot_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint TEXT NOT NULL CHECK(
    length(request_fingerprint)=64 AND request_fingerprint=lower(request_fingerprint)
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  report_sha256 TEXT NOT NULL CHECK(
    length(report_sha256)=64 AND report_sha256=lower(report_sha256)
    AND report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  report_json TEXT NOT NULL CHECK(
    json_valid(report_json) AND json_type(report_json)='object'
    AND length(CAST(report_json AS BLOB)) BETWEEN 2 AND 524288
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  UNIQUE(org_id,campaign_id,request_fingerprint),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(source_knowledge_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  idx_customer_report_snapshots_campaign_created: `CREATE INDEX idx_customer_report_snapshots_campaign_created
    ON customer_report_snapshots(org_id,campaign_id,created_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  customer_report_snapshots_no_update: `CREATE TRIGGER customer_report_snapshots_no_update
BEFORE UPDATE ON customer_report_snapshots
BEGIN SELECT RAISE(ABORT,'customer report snapshots are append-only'); END`,
  customer_report_snapshots_no_delete: `CREATE TRIGGER customer_report_snapshots_no_delete
BEFORE DELETE ON customer_report_snapshots
BEGIN SELECT RAISE(ABORT,'customer report snapshots are append-only'); END`
});

const migration = {
  version: 13,
  name: '013_customer_report_snapshot',
  sourcePath: 'migrations/013_customer_report_snapshot.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      customer_report_snapshots: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        source_knowledge_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        report_contract_version: { type: 'TEXT', notnull: 1, defaultValue: null },
        redaction_policy_version: { type: 'TEXT', notnull: 1, defaultValue: null },
        selected_metric: { type: 'TEXT', notnull: 1, defaultValue: null },
        source_review_content_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        source_review_snapshot_hash: { type: 'TEXT', notnull: 1, defaultValue: null },
        current_evidence_snapshot_hash: { type: 'TEXT', notnull: 1, defaultValue: null },
        request_fingerprint: { type: 'TEXT', notnull: 1, defaultValue: null },
        report_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        report_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      customer_report_snapshots: [
        "CHECK(report_contract_version='customer_safe_v1')",
        "CHECK(redaction_policy_version='customer-safe-v1')",
        'CHECK(length(source_review_content_sha256)=64 AND source_review_content_sha256=lower(source_review_content_sha256) AND source_review_content_sha256 NOT GLOB \'*[^0-9a-f]*\')',
        'CHECK(length(source_review_snapshot_hash)=64 AND source_review_snapshot_hash=lower(source_review_snapshot_hash) AND source_review_snapshot_hash NOT GLOB \'*[^0-9a-f]*\')',
        'CHECK(length(current_evidence_snapshot_hash)=64 AND current_evidence_snapshot_hash=lower(current_evidence_snapshot_hash) AND current_evidence_snapshot_hash NOT GLOB \'*[^0-9a-f]*\')',
        'CHECK(length(request_fingerprint)=64 AND request_fingerprint=lower(request_fingerprint) AND request_fingerprint NOT GLOB \'*[^0-9a-f]*\')',
        'CHECK(length(report_sha256)=64 AND report_sha256=lower(report_sha256) AND report_sha256 NOT GLOB \'*[^0-9a-f]*\')',
        "CHECK(json_valid(report_json) AND json_type(report_json)='object' AND length(CAST(report_json AS BLOB)) BETWEEN 2 AND 524288)",
        'UNIQUE(org_id,campaign_id,request_fingerprint)'
      ]
    }
  },
  apply(db) {
    const required = ['campaigns', 'organization_memberships', 'knowledge_entries'];
    for (const name of required) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`013 requires ${name}`);
      }
    }
    const objectNames = [
      'customer_report_snapshots',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 013 object exists: ${existing[0].name}`);
    db.exec([
      TABLE_SQL,
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;
