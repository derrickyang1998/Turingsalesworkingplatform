'use strict';

const TABLE_SQL = `CREATE TABLE feishu_bitable_outbox_retries (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  failed_delivery_id INTEGER NOT NULL UNIQUE CHECK(failed_delivery_id BETWEEN 1 AND 9007199254740991),
  retry_delivery_id INTEGER NOT NULL UNIQUE CHECK(retry_delivery_id BETWEEN 1 AND 9007199254740991),
  actor_user_id INTEGER NOT NULL CHECK(actor_user_id BETWEEN 1 AND 9007199254740991),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 280 AND length(trim(reason))=length(reason)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  CHECK(failed_delivery_id<>retry_delivery_id),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,actor_user_id) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(failed_delivery_id) REFERENCES feishu_bitable_outbox(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(retry_delivery_id) REFERENCES feishu_bitable_outbox(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  idx_feishu_bitable_outbox_retries_campaign_created: `CREATE INDEX idx_feishu_bitable_outbox_retries_campaign_created
    ON feishu_bitable_outbox_retries(org_id,campaign_id,created_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  feishu_bitable_outbox_retries_no_replace: `CREATE TRIGGER feishu_bitable_outbox_retries_no_replace
BEFORE INSERT ON feishu_bitable_outbox_retries
WHEN EXISTS (
  SELECT 1
  FROM feishu_bitable_outbox_retries existing
  WHERE existing.id=NEW.id
    OR existing.failed_delivery_id=NEW.failed_delivery_id
    OR existing.retry_delivery_id=NEW.retry_delivery_id
)
BEGIN SELECT RAISE(ABORT,'cannot replace an existing feishu outbox retry link'); END`,
  feishu_bitable_outbox_retries_link_scope: `CREATE TRIGGER feishu_bitable_outbox_retries_link_scope
BEFORE INSERT ON feishu_bitable_outbox_retries
WHEN NOT EXISTS (
  SELECT 1
  FROM feishu_bitable_outbox source
  JOIN feishu_bitable_outbox child ON child.id=NEW.retry_delivery_id
  WHERE source.id=NEW.failed_delivery_id
    AND source.org_id=NEW.org_id
    AND source.campaign_id=NEW.campaign_id
    AND source.status='failed'
    AND child.org_id=NEW.org_id
    AND child.campaign_id=NEW.campaign_id
    AND child.status='pending'
)
BEGIN SELECT RAISE(ABORT,'feishu outbox retry link has an invalid source or child'); END`,
  feishu_bitable_outbox_retries_immutable: `CREATE TRIGGER feishu_bitable_outbox_retries_immutable
BEFORE UPDATE ON feishu_bitable_outbox_retries
BEGIN SELECT RAISE(ABORT,'feishu outbox retry links are immutable'); END`,
  feishu_bitable_outbox_retries_no_hard_delete: `CREATE TRIGGER feishu_bitable_outbox_retries_no_hard_delete
BEFORE DELETE ON feishu_bitable_outbox_retries
BEGIN SELECT RAISE(ABORT,'feishu outbox retry links are append-only'); END`
});

const migration = {
  version: 9,
  name: '009_feishu_bitable_retry_lineage',
  sourcePath: 'migrations/009_feishu_bitable_retry_lineage.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      feishu_bitable_outbox_retries: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        failed_delivery_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        retry_delivery_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        actor_user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        reason: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      feishu_bitable_outbox_retries: [
        'CHECK(failed_delivery_id<>retry_delivery_id)',
        'CHECK(length(reason) BETWEEN 1 AND 280 AND length(trim(reason))=length(reason))'
      ]
    }
  },
  apply(db) {
    const required = ['campaigns', 'organization_memberships', 'feishu_bitable_outbox'];
    for (const name of required) {
      if (!db.prepare('SELECT 1 AS present FROM sqlite_schema WHERE type=\'table\' AND name=?').get(name)) {
        throw new Error(`009 requires ${name}`);
      }
    }
    const objectNames = [
      'feishu_bitable_outbox_retries',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`
      SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name
    `).all(...objectNames);
    if (existing.length > 0) {
      throw new Error(`partial 009 object exists: ${existing[0].name}`);
    }
    db.exec(`${TABLE_SQL};\n${Object.values(INDEX_SQL).join(';\n')};\n${Object.values(TRIGGER_SQL).join(';\n')};`);
  }
};

module.exports = migration;
