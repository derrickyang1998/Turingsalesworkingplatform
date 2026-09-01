'use strict';

const TABLE_SQL = `CREATE TABLE feishu_bitable_outbox (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  actor_user_id INTEGER NOT NULL CHECK(actor_user_id BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL CHECK(
    length(operation_id)=36
    AND operation_id=lower(operation_id)
    AND operation_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(operation_id,9,1)='-'
    AND substr(operation_id,14,1)='-'
    AND substr(operation_id,19,1)='-'
    AND substr(operation_id,24,1)='-'
  ),
  reservation_token TEXT NOT NULL CHECK(
    length(reservation_token)=64
    AND reservation_token=lower(reservation_token)
    AND reservation_token NOT GLOB '*[^0-9a-f]*'
  ),
  payload_sha256 TEXT NOT NULL CHECK(
    length(payload_sha256)=64
    AND payload_sha256=lower(payload_sha256)
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK(
    json_valid(payload_json)
    AND json_type(payload_json)='array'
    AND length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 2097152
  ),
  record_count INTEGER NOT NULL CHECK(
    typeof(record_count)='integer' AND record_count BETWEEN 1 AND 500
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed')),
  remote_record_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(
    json_valid(remote_record_ids_json) AND json_type(remote_record_ids_json)='array'
  ),
  last_error_code TEXT CHECK(
    last_error_code IS NULL OR (
      length(last_error_code) BETWEEN 3 AND 100
      AND last_error_code=upper(last_error_code)
      AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at
  ),
  completed_at TEXT CHECK(
    completed_at IS NULL OR (
      strftime('%Y-%m-%d %H:%M:%S',completed_at) IS NOT NULL
      AND strftime('%Y-%m-%d %H:%M:%S',completed_at)=completed_at
    )
  ),
  failed_at TEXT CHECK(
    failed_at IS NULL OR (
      strftime('%Y-%m-%d %H:%M:%S',failed_at) IS NOT NULL
      AND strftime('%Y-%m-%d %H:%M:%S',failed_at)=failed_at
    )
  ),
  UNIQUE(org_id,actor_user_id,operation_id),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,actor_user_id) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(json_array_length(payload_json)=record_count),
  CHECK(
    (status='pending'
      AND json_array_length(remote_record_ids_json)=0
      AND last_error_code IS NULL
      AND completed_at IS NULL
      AND failed_at IS NULL)
    OR (status='succeeded'
      AND json_array_length(remote_record_ids_json)=record_count
      AND last_error_code IS NULL
      AND completed_at IS NOT NULL
      AND failed_at IS NULL)
    OR (status='failed'
      AND json_array_length(remote_record_ids_json)=0
      AND last_error_code IS NOT NULL
      AND completed_at IS NULL
      AND failed_at IS NOT NULL)
  )
) STRICT`;

const INDEX_SQL = Object.freeze({
  idx_feishu_bitable_outbox_campaign_status: `CREATE INDEX idx_feishu_bitable_outbox_campaign_status
    ON feishu_bitable_outbox(org_id,campaign_id,status,updated_at DESC,id DESC)`,
  idx_feishu_bitable_outbox_actor_created: `CREATE INDEX idx_feishu_bitable_outbox_actor_created
    ON feishu_bitable_outbox(org_id,actor_user_id,created_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  feishu_bitable_outbox_no_replace: `CREATE TRIGGER feishu_bitable_outbox_no_replace
BEFORE INSERT ON feishu_bitable_outbox
WHEN EXISTS (
  SELECT 1
  FROM feishu_bitable_outbox existing
  WHERE existing.id=NEW.id
    OR (
      existing.org_id=NEW.org_id
      AND existing.actor_user_id=NEW.actor_user_id
      AND existing.operation_id=NEW.operation_id
    )
)
BEGIN SELECT RAISE(ABORT,'cannot replace an existing feishu outbox receipt'); END`,
  feishu_bitable_outbox_remote_ids_unique_insert: `CREATE TRIGGER feishu_bitable_outbox_remote_ids_unique_insert
BEFORE INSERT ON feishu_bitable_outbox
WHEN json_valid(NEW.remote_record_ids_json)
  AND EXISTS (
    SELECT 1
    FROM json_each(NEW.remote_record_ids_json)
    GROUP BY value
    HAVING count(*)>1
  )
BEGIN SELECT RAISE(ABORT,'feishu outbox remote record IDs must be unique'); END`,
  feishu_bitable_outbox_remote_ids_unique_update: `CREATE TRIGGER feishu_bitable_outbox_remote_ids_unique_update
BEFORE UPDATE OF remote_record_ids_json ON feishu_bitable_outbox
WHEN json_valid(NEW.remote_record_ids_json)
  AND EXISTS (
    SELECT 1
    FROM json_each(NEW.remote_record_ids_json)
    GROUP BY value
    HAVING count(*)>1
  )
BEGIN SELECT RAISE(ABORT,'feishu outbox remote record IDs must be unique'); END`,
  feishu_bitable_outbox_identity_immutable: `CREATE TRIGGER feishu_bitable_outbox_identity_immutable
BEFORE UPDATE OF org_id,campaign_id,actor_user_id,operation_id,reservation_token,
  payload_sha256,payload_json,record_count,created_at
ON feishu_bitable_outbox
WHEN NOT (
  NEW.org_id IS OLD.org_id
  AND NEW.campaign_id IS OLD.campaign_id
  AND NEW.actor_user_id IS OLD.actor_user_id
  AND NEW.operation_id IS OLD.operation_id
  AND NEW.reservation_token IS OLD.reservation_token
  AND NEW.payload_sha256 IS OLD.payload_sha256
  AND NEW.payload_json IS OLD.payload_json
  AND NEW.record_count IS OLD.record_count
  AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT,'feishu outbox identity is immutable'); END`,
  feishu_bitable_outbox_terminal_transition: `CREATE TRIGGER feishu_bitable_outbox_terminal_transition
BEFORE UPDATE OF status ON feishu_bitable_outbox
WHEN NEW.status<>OLD.status
  AND NOT (OLD.status='pending' AND NEW.status IN ('succeeded','failed'))
BEGIN SELECT RAISE(ABORT,'invalid feishu outbox status transition'); END`,
  feishu_bitable_outbox_terminal_immutable: `CREATE TRIGGER feishu_bitable_outbox_terminal_immutable
BEFORE UPDATE ON feishu_bitable_outbox
WHEN OLD.status IN ('succeeded','failed')
BEGIN SELECT RAISE(ABORT,'feishu outbox terminal receipt is immutable'); END`,
  feishu_bitable_outbox_no_hard_delete: `CREATE TRIGGER feishu_bitable_outbox_no_hard_delete
BEFORE DELETE ON feishu_bitable_outbox
BEGIN SELECT RAISE(ABORT,'feishu outbox records are append-only'); END`
});

const migration = {
  version: 8,
  name: '008_feishu_bitable_outbox',
  sourcePath: 'migrations/008_feishu_bitable_outbox.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      feishu_bitable_outbox: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        actor_user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        operation_id: { type: 'TEXT', notnull: 1, defaultValue: null },
        reservation_token: { type: 'TEXT', notnull: 1, defaultValue: null },
        payload_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        payload_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        record_count: { type: 'INTEGER', notnull: 1, defaultValue: null },
        status: { type: 'TEXT', notnull: 1, defaultValue: "'pending'" },
        remote_record_ids_json: { type: 'TEXT', notnull: 1, defaultValue: "'[]'" },
        last_error_code: { type: 'TEXT', notnull: 0, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        completed_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        failed_at: { type: 'TEXT', notnull: 0, defaultValue: null }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      feishu_bitable_outbox: [
        "CHECK(status IN ('pending','succeeded','failed'))",
        'CHECK(json_array_length(payload_json)=record_count)',
        "CHECK(json_valid(payload_json) AND json_type(payload_json)='array' AND length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 2097152)",
        "CHECK(json_valid(remote_record_ids_json) AND json_type(remote_record_ids_json)='array')"
      ]
    }
  },
  apply(db) {
    const required = ['campaigns', 'organization_memberships'];
    for (const name of required) {
      if (!db.prepare('SELECT 1 AS present FROM sqlite_schema WHERE type=\'table\' AND name=?').get(name)) {
        throw new Error(`008 requires ${name}`);
      }
    }
    const objectNames = [
      'feishu_bitable_outbox',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`
      SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name
    `).all(...objectNames);
    if (existing.length > 0) {
      throw new Error(`partial 008 object exists: ${existing[0].name}`);
    }
    db.exec(`${TABLE_SQL};\n${Object.values(INDEX_SQL).join(';\n')};\n${Object.values(TRIGGER_SQL).join(';\n')};`);
  }
};

module.exports = migration;
