'use strict';

const TABLE_SQL = `CREATE TABLE performance_ai_review_audits (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  request_idempotency_id INTEGER NOT NULL UNIQUE CHECK(request_idempotency_id BETWEEN 1 AND 9007199254740991),
  token_usage_id INTEGER NOT NULL UNIQUE CHECK(token_usage_id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  actor_user_id INTEGER NOT NULL CHECK(actor_user_id BETWEEN 1 AND 9007199254740991),
  audit_fingerprint TEXT NOT NULL CHECK(
    length(audit_fingerprint)=64 AND audit_fingerprint=lower(audit_fingerprint)
    AND audit_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  outcome TEXT NOT NULL CHECK(outcome IN ('withheld','stale_snapshot')),
  reason_code TEXT NOT NULL CHECK(reason_code IN (
    'draft_safety_validation_failed','ai_review_protocol_invalid','citation_validation_failed',
    'ai_review_unavailable','review_evidence_changed'
  )),
  stage TEXT NOT NULL CHECK(stage IN (
    'completion_validation','completion_transformation','persistence_validation','provider_unavailable'
  )),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  UNIQUE(org_id,campaign_id,actor_user_id,audit_fingerprint),
  CHECK(
    (outcome='stale_snapshot' AND reason_code='review_evidence_changed' AND stage='persistence_validation')
    OR outcome='withheld'
  ),
  FOREIGN KEY(request_idempotency_id) REFERENCES request_idempotency(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(token_usage_id) REFERENCES token_usage(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,actor_user_id) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  idx_performance_ai_review_audits_campaign_created: `CREATE INDEX idx_performance_ai_review_audits_campaign_created
    ON performance_ai_review_audits(org_id,campaign_id,created_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  performance_ai_review_audits_no_update: `CREATE TRIGGER performance_ai_review_audits_no_update
BEFORE UPDATE ON performance_ai_review_audits
BEGIN SELECT RAISE(ABORT,'performance AI review audits are append-only'); END`,
  performance_ai_review_audits_no_delete: `CREATE TRIGGER performance_ai_review_audits_no_delete
BEFORE DELETE ON performance_ai_review_audits
BEGIN SELECT RAISE(ABORT,'performance AI review audits are append-only'); END`,
  performance_ai_review_audits_request_fingerprint_insert: `CREATE TRIGGER performance_ai_review_audits_request_fingerprint_insert
BEFORE INSERT ON performance_ai_review_audits
WHEN NOT EXISTS (
  SELECT 1
  FROM request_idempotency request
  JOIN token_usage usage ON usage.id=NEW.token_usage_id
  WHERE request.id=NEW.request_idempotency_id
    AND request.org_id=NEW.org_id
    AND request.user_id=NEW.actor_user_id
    AND request.campaign_id=NEW.campaign_id
    AND request.scope='ai.conversation.create.linked'
    AND request.expected_event_count=1
    AND request.audit_fingerprint=NEW.audit_fingerprint
    AND request.state='processing'
    AND request.lease_token IS NOT NULL
    AND datetime(request.lease_until)>CURRENT_TIMESTAMP
    AND datetime(request.operation_deadline)>CURRENT_TIMESTAMP
    AND usage.user_id=NEW.actor_user_id
    AND usage.endpoint='ai_chat_linked_rejected'
)
BEGIN SELECT RAISE(ABORT,'performance AI review audit is not reserved'); END`,
  request_idempotency_legal_transition: `CREATE TRIGGER request_idempotency_legal_transition
BEFORE UPDATE ON request_idempotency
WHEN NOT (
  (OLD.state='processing' AND NEW.state='processing'
    AND NEW.expires_at IS NULL
    AND datetime(OLD.operation_deadline)>CURRENT_TIMESTAMP
    AND (
      (NEW.lease_token=OLD.lease_token
        AND datetime(OLD.lease_until)>CURRENT_TIMESTAMP
        AND datetime(NEW.lease_until)>datetime(OLD.lease_until)
        AND datetime(NEW.lease_until)<=datetime(OLD.operation_deadline))
      OR (datetime(OLD.lease_until)<=CURRENT_TIMESTAMP
        AND NEW.lease_token<>OLD.lease_token
        AND datetime(NEW.lease_until)>CURRENT_TIMESTAMP
        AND datetime(NEW.lease_until)<=datetime(OLD.operation_deadline))
    ))
  OR (OLD.state='processing' AND NEW.state='completed'
    AND (
      (OLD.lease_token IS NOT NULL AND datetime(OLD.lease_until)>CURRENT_TIMESTAMP
        AND datetime(OLD.operation_deadline)>CURRENT_TIMESTAMP)
      OR (datetime(OLD.operation_deadline)<=CURRENT_TIMESTAMP
        AND NEW.response_kind='json' AND NEW.status_code=503)
    )
    AND NEW.expires_at=datetime(
      NEW.updated_at,
      CASE WHEN NEW.response_kind='admission' THEN '+1 day' ELSE '+30 days' END
    )
    AND (
      (NEW.status_code BETWEEN 400 AND 599 AND NEW.response_kind='json'
        AND (SELECT count(*) FROM campaign_events event
          WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
            AND event.audit_fingerprint=OLD.audit_fingerprint)=0)
      OR (
        NEW.status_code BETWEEN 200 AND 299
        AND (
          (
            (SELECT count(*) FROM campaign_events event
              WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
                AND event.audit_fingerprint=OLD.audit_fingerprint)=OLD.expected_event_count
            AND (
              (OLD.expected_event_count=2 AND OLD.scope='campaign.link.correct'
                AND OLD.secondary_campaign_id IS NOT NULL
                AND (SELECT count(*) FROM campaign_events event
                  WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
                    AND event.audit_fingerprint=OLD.audit_fingerprint
                    AND event.campaign_id=OLD.campaign_id AND event.event_type='link_moved')=1
                AND (SELECT count(*) FROM campaign_events event
                  WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
                    AND event.audit_fingerprint=OLD.audit_fingerprint
                    AND event.campaign_id=OLD.secondary_campaign_id AND event.event_type='link_moved')=1)
              OR (OLD.expected_event_count=1 AND OLD.secondary_campaign_id IS NULL
                AND (SELECT count(*) FROM campaign_events event
                  WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
                    AND event.audit_fingerprint=OLD.audit_fingerprint
                    AND event.campaign_id=OLD.campaign_id)=1)
              OR (OLD.expected_event_count=0 AND OLD.secondary_campaign_id IS NULL)
            )
          )
          OR (
            OLD.scope='ai.conversation.create.linked'
            AND OLD.expected_event_count=1
            AND OLD.secondary_campaign_id IS NULL
            AND (SELECT count(*) FROM campaign_events event
              WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
                AND event.audit_fingerprint=OLD.audit_fingerprint)=0
            AND (SELECT count(*) FROM performance_ai_review_audits audit
              WHERE audit.request_idempotency_id=OLD.id
                AND audit.org_id=OLD.org_id
                AND audit.campaign_id=OLD.campaign_id
                AND audit.actor_user_id=OLD.user_id
                AND audit.audit_fingerprint=OLD.audit_fingerprint)=1
          )
        )
      )
    ))
  OR (OLD.state='processing' AND NEW.state='failed'
    AND OLD.lease_token IS NOT NULL AND datetime(OLD.lease_until)>CURRENT_TIMESTAMP
    AND datetime(OLD.operation_deadline)>CURRENT_TIMESTAMP
    AND NEW.expires_at=datetime(NEW.updated_at,'+1 day'))
  OR (OLD.state='failed' AND NEW.state='processing'
    AND datetime(OLD.operation_deadline)>CURRENT_TIMESTAMP
    AND NEW.expires_at IS NULL AND NEW.lease_token IS NOT NULL
    AND datetime(NEW.lease_until)>CURRENT_TIMESTAMP
    AND datetime(NEW.lease_until)<=datetime(OLD.operation_deadline))
  OR (OLD.state='failed' AND NEW.state='completed'
    AND datetime(OLD.operation_deadline)<=CURRENT_TIMESTAMP
    AND NEW.status_code=503 AND NEW.response_kind='json'
    AND NEW.expires_at=datetime(NEW.updated_at,'+30 days')
    AND (SELECT count(*) FROM campaign_events event
      WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
        AND event.audit_fingerprint=OLD.audit_fingerprint)=0)
  OR (OLD.state='completed' AND OLD.response_kind='binary' AND NEW.state='expiring'
    AND datetime(OLD.expires_at)<=CURRENT_TIMESTAMP
    AND NEW.expires_at IS OLD.expires_at
    AND NEW.status_code IS OLD.status_code AND NEW.response_kind IS OLD.response_kind
    AND NEW.response_json IS OLD.response_json
    AND NEW.response_headers_json IS OLD.response_headers_json
    AND NEW.response_cache_key IS OLD.response_cache_key
    AND NEW.response_sha256 IS OLD.response_sha256 AND NEW.response_bytes IS OLD.response_bytes
    AND NEW.response_content_type IS OLD.response_content_type
    AND NEW.response_filename IS OLD.response_filename)
)
BEGIN SELECT RAISE(ABORT,'invalid request idempotency transition'); END`
});

const migration = {
  version: 12,
  name: '012_performance_ai_review_audit',
  sourcePath: 'migrations/012_performance_ai_review_audit.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      performance_ai_review_audits: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        request_idempotency_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        token_usage_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        actor_user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        audit_fingerprint: { type: 'TEXT', notnull: 1, defaultValue: null },
        outcome: { type: 'TEXT', notnull: 1, defaultValue: null },
        reason_code: { type: 'TEXT', notnull: 1, defaultValue: null },
        stage: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      performance_ai_review_audits: [
        "CHECK(outcome IN ('withheld','stale_snapshot'))",
        "CHECK(reason_code IN ('draft_safety_validation_failed','ai_review_protocol_invalid','citation_validation_failed','ai_review_unavailable','review_evidence_changed'))",
        "UNIQUE(org_id,campaign_id,actor_user_id,audit_fingerprint)"
      ]
    }
  },
  apply(db) {
    const required = ['request_idempotency', 'token_usage', 'campaigns', 'organization_memberships'];
    for (const name of required) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`012 requires ${name}`);
      }
    }
    const replacements = ['request_idempotency_legal_transition'];
    for (const name of replacements) {
      const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
      if (!row) throw new Error(`012 requires ${name}`);
    }
    const newObjects = [
      'performance_ai_review_audits',
      ...Object.keys(INDEX_SQL),
      'performance_ai_review_audits_no_update',
      'performance_ai_review_audits_no_delete',
      'performance_ai_review_audits_request_fingerprint_insert'
    ];
    const placeholders = newObjects.map(function() { return '?'; }).join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...newObjects);
    if (existing.length > 0) throw new Error(`partial 012 object exists: ${existing[0].name}`);
    db.exec([TABLE_SQL, ...Object.values(INDEX_SQL)].join(';\n') + ';');
    db.exec(TRIGGER_SQL.performance_ai_review_audits_no_update + ';');
    db.exec(TRIGGER_SQL.performance_ai_review_audits_no_delete + ';');
    db.exec(TRIGGER_SQL.performance_ai_review_audits_request_fingerprint_insert + ';');
    for (const name of replacements) db.exec(`DROP TRIGGER ${name};`);
    db.exec(TRIGGER_SQL.request_idempotency_legal_transition + ';');
  }
};

module.exports = migration;
