'use strict';

const POLICY_TABLE_SQL = `CREATE TABLE organization_ai_concurrency_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version >= 1),
  concurrency_limit INTEGER NOT NULL CHECK(concurrency_limit BETWEEN 0 AND 64),
  changed_by INTEGER,
  reason TEXT CHECK(reason IS NULL OR (
    length(trim(reason)) BETWEEN 1 AND 500
    AND reason NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
  )),
  source TEXT NOT NULL CHECK(source IN ('migration_backfill','organization_default','admin_update')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const RESERVATION_TABLE_SQL = `CREATE TABLE ai_provider_reservations (
  reservation_id TEXT PRIMARY KEY CHECK(length(reservation_id) BETWEEN 1 AND 128),
  org_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  operation_key TEXT NOT NULL CHECK(length(operation_key) BETWEEN 1 AND 200),
  fence_token TEXT NOT NULL UNIQUE CHECK(length(fence_token) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('active','released','timed_out')),
  acquired_at TEXT NOT NULL,
  provider_deadline_at TEXT NOT NULL,
  reclaim_after TEXT NOT NULL,
  provider_completed_at TEXT,
  terminal_at TEXT,
  CHECK(provider_deadline_at > acquired_at),
  CHECK(reclaim_after > provider_deadline_at),
  CHECK((state='active' AND terminal_at IS NULL) OR (state<>'active' AND terminal_at IS NOT NULL)),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(actor_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const EVENT_TABLE_SQL = `CREATE TABLE ai_provider_reservation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT,
  org_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'acquired','rejected','dispatch_authorized','provider_completed','released','timed_out'
  )),
  event_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(reservation_id) REFERENCES ai_provider_reservations(reservation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  ux_organization_ai_concurrency_policy_version: `CREATE UNIQUE INDEX ux_organization_ai_concurrency_policy_version
    ON organization_ai_concurrency_policies(org_id,policy_version)`,
  idx_ai_provider_reservations_active_org: `CREATE INDEX idx_ai_provider_reservations_active_org
    ON ai_provider_reservations(org_id,reclaim_after,reservation_id) WHERE state='active'`,
  idx_ai_provider_reservation_events_reservation: `CREATE INDEX idx_ai_provider_reservation_events_reservation
    ON ai_provider_reservation_events(reservation_id,id)`
});

const TRIGGER_SQL = Object.freeze({
  organization_ai_concurrency_policy_insert_guard: `CREATE TRIGGER organization_ai_concurrency_policy_insert_guard
BEFORE INSERT ON organization_ai_concurrency_policies
WHEN NEW.policy_version<>(
    SELECT COALESCE(MAX(policy_version),0)+1 FROM organization_ai_concurrency_policies WHERE org_id=NEW.org_id
  )
  OR NEW.source='migration_backfill'
  OR (NEW.source='organization_default' AND (
    NEW.policy_version<>1 OR NEW.concurrency_limit<>10 OR NEW.changed_by IS NOT NULL OR NEW.reason IS NOT NULL
  ))
  OR (NEW.source='admin_update' AND (
    NEW.changed_by IS NULL OR NEW.reason IS NULL
    OR NOT EXISTS (SELECT 1 FROM organization_ai_concurrency_policies WHERE org_id=NEW.org_id)
    OR NEW.concurrency_limit IS (
      SELECT concurrency_limit FROM organization_ai_concurrency_policies
      WHERE org_id=NEW.org_id ORDER BY policy_version DESC LIMIT 1
    )
  ))
BEGIN SELECT RAISE(ABORT,'organization AI concurrency policy is invalid'); END`,
  organization_ai_concurrency_policy_no_update: `CREATE TRIGGER organization_ai_concurrency_policy_no_update
BEFORE UPDATE ON organization_ai_concurrency_policies
BEGIN SELECT RAISE(ABORT,'organization AI concurrency policy history is immutable'); END`,
  organization_ai_concurrency_policy_no_delete: `CREATE TRIGGER organization_ai_concurrency_policy_no_delete
BEFORE DELETE ON organization_ai_concurrency_policies
BEGIN SELECT RAISE(ABORT,'organization AI concurrency policy history is immutable'); END`,
  organization_ai_concurrency_default_after_insert: `CREATE TRIGGER organization_ai_concurrency_default_after_insert
AFTER INSERT ON organizations
BEGIN
  INSERT INTO organization_ai_concurrency_policies
    (org_id,policy_version,concurrency_limit,changed_by,reason,source)
  VALUES (NEW.id,1,10,NULL,NULL,'organization_default');
END`,
  ai_provider_reservation_identity_immutable: `CREATE TRIGGER ai_provider_reservation_identity_immutable
BEFORE UPDATE ON ai_provider_reservations
WHEN NEW.reservation_id IS NOT OLD.reservation_id
  OR NEW.org_id IS NOT OLD.org_id
  OR NEW.actor_user_id IS NOT OLD.actor_user_id
  OR NEW.operation_key IS NOT OLD.operation_key
  OR NEW.fence_token IS NOT OLD.fence_token
  OR NEW.acquired_at IS NOT OLD.acquired_at
  OR NEW.provider_deadline_at IS NOT OLD.provider_deadline_at
  OR NEW.reclaim_after IS NOT OLD.reclaim_after
BEGIN SELECT RAISE(ABORT,'AI provider reservation identity is immutable'); END`,
  ai_provider_reservation_transition_guard: `CREATE TRIGGER ai_provider_reservation_transition_guard
BEFORE UPDATE ON ai_provider_reservations
WHEN (OLD.state<>'active' AND (
    NEW.state IS NOT OLD.state OR NEW.terminal_at IS NOT OLD.terminal_at
    OR NEW.provider_completed_at IS NOT OLD.provider_completed_at
  ))
  OR (OLD.state='active' AND NEW.state NOT IN ('active','released','timed_out'))
  OR (OLD.state='active' AND NEW.state='active' AND NEW.terminal_at IS NOT NULL)
  OR (OLD.state='active' AND NEW.state<>'active' AND NEW.terminal_at IS NULL)
BEGIN SELECT RAISE(ABORT,'AI provider reservation terminal state is immutable'); END`,
  ai_provider_reservation_no_delete: `CREATE TRIGGER ai_provider_reservation_no_delete
BEFORE DELETE ON ai_provider_reservations
BEGIN SELECT RAISE(ABORT,'AI provider reservation history is immutable'); END`,
  ai_provider_reservation_event_no_update: `CREATE TRIGGER ai_provider_reservation_event_no_update
BEFORE UPDATE ON ai_provider_reservation_events
BEGIN SELECT RAISE(ABORT,'AI provider reservation events are append-only'); END`,
  ai_provider_reservation_event_no_delete: `CREATE TRIGGER ai_provider_reservation_event_no_delete
BEFORE DELETE ON ai_provider_reservation_events
BEGIN SELECT RAISE(ABORT,'AI provider reservation events are append-only'); END`
});

const migration = {
  version: 30,
  name: '030_ai_provider_concurrency_reservation',
  sourcePath: 'migrations/030_ai_provider_concurrency_reservation.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      organization_ai_concurrency_policies: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        policy_version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        concurrency_limit: { type: 'INTEGER', notnull: 1, defaultValue: null },
        changed_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        reason: { type: 'TEXT', notnull: 0, defaultValue: null },
        source: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      ai_provider_reservations: {
        reservation_id: { type: 'TEXT', notnull: 1, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        actor_user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        operation_key: { type: 'TEXT', notnull: 1, defaultValue: null },
        fence_token: { type: 'TEXT', notnull: 1, defaultValue: null },
        state: { type: 'TEXT', notnull: 1, defaultValue: null },
        acquired_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        provider_deadline_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        reclaim_after: { type: 'TEXT', notnull: 1, defaultValue: null },
        provider_completed_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        terminal_at: { type: 'TEXT', notnull: 0, defaultValue: null }
      },
      ai_provider_reservation_events: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        reservation_id: { type: 'TEXT', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        event_type: { type: 'TEXT', notnull: 1, defaultValue: null },
        event_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        metadata_json: { type: 'TEXT', notnull: 1, defaultValue: "'{}'" }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      organization_ai_concurrency_policies: ['concurrency_limit BETWEEN 0 AND 64'],
      ai_provider_reservations: ["state IN ('active','released','timed_out')"],
      ai_provider_reservation_events: ["event_type IN ('acquired','rejected','dispatch_authorized','provider_completed','released','timed_out')"]
    }
  },
  apply(db) {
    for (const name of ['organizations', 'users', 'activity_log']) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`030 requires ${name}`);
      }
    }
    const objectNames = [
      'organization_ai_concurrency_policies', 'ai_provider_reservations',
      'ai_provider_reservation_events', ...Object.keys(INDEX_SQL), ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(() => '?').join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`).all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 030 object exists: ${existing[0].name}`);

    const organizationCount = db.prepare('SELECT COUNT(*) AS count FROM organizations').get().count;
    db.exec([POLICY_TABLE_SQL, RESERVATION_TABLE_SQL, EVENT_TABLE_SQL, ...Object.values(INDEX_SQL)].join(';\n') + ';');
    db.exec(`
      INSERT INTO organization_ai_concurrency_policies
        (org_id,policy_version,concurrency_limit,changed_by,reason,source)
      SELECT id,1,10,NULL,NULL,'migration_backfill' FROM organizations ORDER BY id;
    `);
    const policyCount = db.prepare('SELECT COUNT(*) AS count FROM organization_ai_concurrency_policies').get().count;
    if (policyCount !== organizationCount) throw new Error('030 organization concurrency backfill is incomplete');
    db.exec(Object.values(TRIGGER_SQL).join(';\n') + ';');
  }
};

module.exports = migration;
