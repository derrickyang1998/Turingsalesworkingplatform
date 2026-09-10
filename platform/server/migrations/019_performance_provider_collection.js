'use strict';

const TABLE_SQL = Object.freeze({
  performance_provider_collection_claims: `CREATE TABLE performance_provider_collection_claims (
    id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
    org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
    campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
    provider TEXT NOT NULL CHECK(provider IN ('youtube')),
    run_key TEXT NOT NULL CHECK(
      length(run_key)=64 AND run_key=lower(run_key) AND run_key NOT GLOB '*[^0-9a-f]*'
    ),
    trigger_mode TEXT NOT NULL CHECK(trigger_mode IN ('manual','scheduled')),
    requested_by INTEGER NOT NULL CHECK(requested_by BETWEEN 1 AND 9007199254740991),
    requested_items INTEGER NOT NULL CHECK(requested_items BETWEEN 1 AND 50),
    reserved_quota_units INTEGER NOT NULL CHECK(
      reserved_quota_units BETWEEN requested_items AND requested_items * 3
    ),
    lease_token TEXT NOT NULL CHECK(
      length(lease_token)=64 AND lease_token=lower(lease_token)
      AND lease_token NOT GLOB '*[^0-9a-f]*'
    ),
    lease_until TEXT NOT NULL CHECK(
      length(lease_until) BETWEEN 20 AND 40 AND lease_until GLOB '????-??-??T??:??:??*Z'
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
      strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
      AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
    ),
    UNIQUE(org_id,campaign_id,provider),
    FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(org_id,requested_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT`,
  performance_provider_quota_reservations: `CREATE TABLE performance_provider_quota_reservations (
    id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
    org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
    campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
    provider TEXT NOT NULL CHECK(provider IN ('youtube')),
    run_key TEXT NOT NULL CHECK(
      length(run_key)=64 AND run_key=lower(run_key) AND run_key NOT GLOB '*[^0-9a-f]*'
    ),
    trigger_mode TEXT NOT NULL CHECK(trigger_mode IN ('manual','scheduled')),
    requested_by INTEGER NOT NULL CHECK(requested_by BETWEEN 1 AND 9007199254740991),
    requested_items INTEGER NOT NULL CHECK(requested_items BETWEEN 1 AND 50),
    reserved_quota_units INTEGER NOT NULL CHECK(
      reserved_quota_units BETWEEN requested_items AND requested_items * 3
    ),
    created_at TEXT NOT NULL CHECK(
      length(created_at) BETWEEN 20 AND 40 AND created_at GLOB '????-??-??T??:??:??*Z'
    ),
    UNIQUE(provider,run_key),
    FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(org_id,requested_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT`,
  performance_provider_collection_runs: `CREATE TABLE performance_provider_collection_runs (
    id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
    org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
    campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
    provider TEXT NOT NULL CHECK(provider IN ('youtube')),
    run_key TEXT NOT NULL CHECK(
      length(run_key)=64 AND run_key=lower(run_key) AND run_key NOT GLOB '*[^0-9a-f]*'
    ),
    trigger_mode TEXT NOT NULL CHECK(trigger_mode IN ('manual','scheduled')),
    requested_by INTEGER NOT NULL CHECK(requested_by BETWEEN 1 AND 9007199254740991),
    status TEXT NOT NULL CHECK(status IN ('succeeded','partial','failed')),
    counts_json TEXT NOT NULL CHECK(json_valid(counts_json) AND json_type(counts_json)='object'),
    item_results_json TEXT NOT NULL CHECK(json_valid(item_results_json) AND json_type(item_results_json)='array'),
    safe_error_category TEXT CHECK(safe_error_category IS NULL OR safe_error_category IN (
      'item_failure','quota_exceeded','rate_limited','provider_timeout',
      'content_not_found','provider_forbidden','provider_response_invalid','provider_unavailable'
    )),
    scheduled_for TEXT NOT NULL CHECK(
      length(scheduled_for) BETWEEN 20 AND 40 AND scheduled_for GLOB '????-??-??T??:??:??*Z'
    ),
    started_at TEXT NOT NULL CHECK(
      length(started_at) BETWEEN 20 AND 40 AND started_at GLOB '????-??-??T??:??:??*Z'
    ),
    completed_at TEXT NOT NULL CHECK(
      length(completed_at) BETWEEN 20 AND 40 AND completed_at GLOB '????-??-??T??:??:??*Z'
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
      strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
      AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
    ),
    UNIQUE(org_id,campaign_id,provider,run_key),
    FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(org_id,requested_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT`,
  performance_provider_observations: `CREATE TABLE performance_provider_observations (
    id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
    run_id INTEGER NOT NULL CHECK(run_id BETWEEN 1 AND 9007199254740991),
    org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
    campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
    publication_id INTEGER NOT NULL CHECK(publication_id BETWEEN 1 AND 9007199254740991),
    provider TEXT NOT NULL CHECK(provider IN ('youtube')),
    provider_content_id TEXT NOT NULL CHECK(length(provider_content_id) BETWEEN 6 AND 128),
    metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json) AND json_type(metrics_json)='object'),
    availability_json TEXT NOT NULL CHECK(json_valid(availability_json) AND json_type(availability_json)='object'),
    observed_at TEXT NOT NULL CHECK(
      length(observed_at) BETWEEN 20 AND 40 AND observed_at GLOB '????-??-??T??:??:??*Z'
    ),
    payload_sha256 TEXT NOT NULL CHECK(
      length(payload_sha256)=64 AND payload_sha256=lower(payload_sha256)
      AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
      strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
      AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
    ),
    UNIQUE(run_id,publication_id),
    FOREIGN KEY(run_id) REFERENCES performance_provider_collection_runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(publication_id) REFERENCES campaign_publications(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT`
});

const INDEX_SQL = Object.freeze({
  idx_performance_provider_claims_lease: `CREATE INDEX idx_performance_provider_claims_lease
    ON performance_provider_collection_claims(lease_until,id)`,
  idx_performance_provider_quota_reservations_window: `CREATE INDEX idx_performance_provider_quota_reservations_window
    ON performance_provider_quota_reservations(provider,created_at DESC,id DESC)`,
  idx_performance_provider_quota_reservations_org_window: `CREATE INDEX idx_performance_provider_quota_reservations_org_window
    ON performance_provider_quota_reservations(org_id,provider,created_at DESC,id DESC)`,
  idx_performance_provider_runs_provider_completed: `CREATE INDEX idx_performance_provider_runs_provider_completed
    ON performance_provider_collection_runs(provider,completed_at DESC,id DESC)`,
  idx_performance_provider_runs_campaign_completed: `CREATE INDEX idx_performance_provider_runs_campaign_completed
    ON performance_provider_collection_runs(org_id,campaign_id,completed_at DESC,id DESC)`,
  idx_performance_provider_observations_current: `CREATE INDEX idx_performance_provider_observations_current
    ON performance_provider_observations(org_id,campaign_id,publication_id,observed_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  performance_provider_collection_claims_no_update: `CREATE TRIGGER performance_provider_collection_claims_no_update
BEFORE UPDATE ON performance_provider_collection_claims
BEGIN SELECT RAISE(ABORT,'performance provider collection claims cannot be updated'); END`,
  performance_provider_quota_reservations_no_update: `CREATE TRIGGER performance_provider_quota_reservations_no_update
BEFORE UPDATE ON performance_provider_quota_reservations
BEGIN SELECT RAISE(ABORT,'performance provider quota reservations are immutable'); END`,
  performance_provider_quota_reservations_no_delete: `CREATE TRIGGER performance_provider_quota_reservations_no_delete
BEFORE DELETE ON performance_provider_quota_reservations
BEGIN SELECT RAISE(ABORT,'performance provider quota reservations are append-only'); END`,
  performance_provider_collection_runs_no_update: `CREATE TRIGGER performance_provider_collection_runs_no_update
BEFORE UPDATE ON performance_provider_collection_runs
BEGIN SELECT RAISE(ABORT,'performance provider collection runs are immutable'); END`,
  performance_provider_collection_runs_no_delete: `CREATE TRIGGER performance_provider_collection_runs_no_delete
BEFORE DELETE ON performance_provider_collection_runs
BEGIN SELECT RAISE(ABORT,'performance provider collection runs are append-only'); END`,
  performance_provider_observations_no_update: `CREATE TRIGGER performance_provider_observations_no_update
BEFORE UPDATE ON performance_provider_observations
BEGIN SELECT RAISE(ABORT,'performance provider observations are immutable'); END`,
  performance_provider_observations_no_delete: `CREATE TRIGGER performance_provider_observations_no_delete
BEFORE DELETE ON performance_provider_observations
BEGIN SELECT RAISE(ABORT,'performance provider observations are append-only'); END`,
  performance_provider_observations_scope_insert: `CREATE TRIGGER performance_provider_observations_scope_insert
BEFORE INSERT ON performance_provider_observations
WHEN NOT EXISTS (
  SELECT 1
  FROM performance_provider_collection_runs run
  JOIN campaign_publications publication
    ON publication.id=NEW.publication_id
   AND publication.org_id=NEW.org_id
   AND publication.campaign_id=NEW.campaign_id
   AND publication.platform=NEW.provider
   AND publication.platform_content_id=NEW.provider_content_id
  WHERE run.id=NEW.run_id
    AND run.org_id=NEW.org_id
    AND run.campaign_id=NEW.campaign_id
    AND run.provider=NEW.provider
    AND run.requested_by=NEW.created_by
)
BEGIN SELECT RAISE(ABORT,'performance provider observation scope is invalid'); END`
});

const migration = {
  version: 19,
  name: '019_performance_provider_collection',
  sourcePath: 'migrations/019_performance_provider_collection.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      performance_provider_collection_claims: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        provider: { type: 'TEXT', notnull: 1, defaultValue: null },
        run_key: { type: 'TEXT', notnull: 1, defaultValue: null },
        trigger_mode: { type: 'TEXT', notnull: 1, defaultValue: null },
        requested_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        requested_items: { type: 'INTEGER', notnull: 1, defaultValue: null },
        reserved_quota_units: { type: 'INTEGER', notnull: 1, defaultValue: null },
        lease_token: { type: 'TEXT', notnull: 1, defaultValue: null },
        lease_until: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      performance_provider_quota_reservations: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        provider: { type: 'TEXT', notnull: 1, defaultValue: null },
        run_key: { type: 'TEXT', notnull: 1, defaultValue: null },
        trigger_mode: { type: 'TEXT', notnull: 1, defaultValue: null },
        requested_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        requested_items: { type: 'INTEGER', notnull: 1, defaultValue: null },
        reserved_quota_units: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: null }
      },
      performance_provider_collection_runs: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        provider: { type: 'TEXT', notnull: 1, defaultValue: null },
        run_key: { type: 'TEXT', notnull: 1, defaultValue: null },
        trigger_mode: { type: 'TEXT', notnull: 1, defaultValue: null },
        requested_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        status: { type: 'TEXT', notnull: 1, defaultValue: null },
        counts_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        item_results_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        safe_error_category: { type: 'TEXT', notnull: 0, defaultValue: null },
        scheduled_for: { type: 'TEXT', notnull: 1, defaultValue: null },
        started_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        completed_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      performance_provider_observations: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        run_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        publication_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        provider: { type: 'TEXT', notnull: 1, defaultValue: null },
        provider_content_id: { type: 'TEXT', notnull: 1, defaultValue: null },
        metrics_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        availability_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        observed_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        payload_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      performance_provider_collection_claims: [
        "CHECK(provider IN ('youtube'))",
        "CHECK(trigger_mode IN ('manual','scheduled'))",
        'CHECK(requested_items BETWEEN 1 AND 50)',
        'reserved_quota_units BETWEEN requested_items AND requested_items * 3',
        'UNIQUE(org_id,campaign_id,provider)'
      ],
      performance_provider_quota_reservations: [
        "CHECK(provider IN ('youtube'))",
        "CHECK(trigger_mode IN ('manual','scheduled'))",
        'CHECK(requested_items BETWEEN 1 AND 50)',
        'reserved_quota_units BETWEEN requested_items AND requested_items * 3',
        'UNIQUE(provider,run_key)'
      ],
      performance_provider_collection_runs: [
        "CHECK(provider IN ('youtube'))",
        "CHECK(trigger_mode IN ('manual','scheduled'))",
        "CHECK(status IN ('succeeded','partial','failed'))",
        "safe_error_category IN (",
        "CHECK(json_valid(counts_json) AND json_type(counts_json)='object')",
        "CHECK(json_valid(item_results_json) AND json_type(item_results_json)='array')",
        'UNIQUE(org_id,campaign_id,provider,run_key)'
      ],
      performance_provider_observations: [
        "CHECK(provider IN ('youtube'))",
        "CHECK(json_valid(metrics_json) AND json_type(metrics_json)='object')",
        "CHECK(json_valid(availability_json) AND json_type(availability_json)='object')",
        'UNIQUE(run_id,publication_id)'
      ]
    }
  },
  apply(db) {
    const required = [
      'campaigns',
      'organization_memberships',
      'campaign_publications',
      'activity_log'
    ];
    for (const name of required) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`019 requires ${name}`);
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
    if (existing.length > 0) throw new Error(`partial 019 object exists: ${existing[0].name}`);
    db.exec([
      ...Object.values(TABLE_SQL),
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;
