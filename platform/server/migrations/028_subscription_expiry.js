'use strict';

const TABLE_SQL = `CREATE TABLE organization_subscription_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  term_version INTEGER NOT NULL CHECK(term_version BETWEEN 1 AND 9007199254740991),
  expires_at TEXT CHECK(
    expires_at IS NULL OR (
      length(expires_at)=20
      AND expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
      AND substr(expires_at,12,2) BETWEEN '00' AND '23'
      AND strftime('%Y-%m-%dT%H:%M:%SZ',expires_at)=expires_at
      AND julianday(expires_at) IS NOT NULL
    )
  ),
  changed_by INTEGER CHECK(changed_by IS NULL OR changed_by BETWEEN 1 AND 9007199254740991),
  reason TEXT CHECK(reason IS NULL OR (length(trim(reason)) BETWEEN 1 AND 500 AND reason NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*')),
  source TEXT NOT NULL CHECK(source IN ('migration_backfill','organization_default','admin_update')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  ux_organization_subscription_terms_version: `CREATE UNIQUE INDEX ux_organization_subscription_terms_version
    ON organization_subscription_terms(org_id,term_version)`
});

const TRIGGER_SQL = Object.freeze({
  organization_subscription_term_insert_guard: `CREATE TRIGGER organization_subscription_term_insert_guard
BEFORE INSERT ON organization_subscription_terms
WHEN NEW.term_version<>(
    SELECT COALESCE(MAX(existing.term_version),0)+1
    FROM organization_subscription_terms existing WHERE existing.org_id=NEW.org_id
  )
  OR NEW.source='migration_backfill'
  OR (
    NEW.source='organization_default' AND (
      NEW.changed_by IS NOT NULL OR NEW.reason IS NOT NULL OR NEW.expires_at IS NOT NULL
      OR NEW.term_version<>1
      OR EXISTS (
        SELECT 1 FROM organization_subscription_terms existing WHERE existing.org_id=NEW.org_id
      )
    )
  )
  OR (
    NEW.source='admin_update' AND (
      NEW.changed_by IS NULL OR NEW.reason IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM organization_subscription_terms existing WHERE existing.org_id=NEW.org_id
      )
      OR NEW.expires_at IS (
        SELECT current.expires_at
        FROM organization_subscription_terms current
        WHERE current.org_id=NEW.org_id
        ORDER BY current.term_version DESC
        LIMIT 1
      )
    )
  )
BEGIN SELECT RAISE(ABORT,'organization subscription term is invalid'); END`,
  organization_subscription_term_no_replace_insert: `CREATE TRIGGER organization_subscription_term_no_replace_insert
BEFORE INSERT ON organization_subscription_terms
WHEN NEW.id IS NOT NULL AND EXISTS (
  SELECT 1 FROM organization_subscription_terms WHERE id=NEW.id
)
BEGIN SELECT RAISE(ABORT,'organization subscription term history is immutable'); END`,
  organization_subscription_term_no_update: `CREATE TRIGGER organization_subscription_term_no_update
BEFORE UPDATE ON organization_subscription_terms
BEGIN SELECT RAISE(ABORT,'organization subscription term history is immutable'); END`,
  organization_subscription_term_no_delete: `CREATE TRIGGER organization_subscription_term_no_delete
BEFORE DELETE ON organization_subscription_terms
BEGIN SELECT RAISE(ABORT,'organization subscription term history is immutable'); END`,
  organization_subscription_default_after_insert: `CREATE TRIGGER organization_subscription_default_after_insert
AFTER INSERT ON organizations
BEGIN
  INSERT INTO organization_subscription_terms
    (org_id,term_version,expires_at,changed_by,reason,source)
  VALUES (NEW.id,1,NULL,NULL,NULL,'organization_default');
END`
});

const migration = {
  version: 28,
  name: '028_subscription_expiry',
  sourcePath: 'migrations/028_subscription_expiry.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      organization_subscription_terms: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        term_version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        expires_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        changed_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        reason: { type: 'TEXT', notnull: 0, defaultValue: null },
        source: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      organization_subscription_terms: [
        "source IN ('migration_backfill','organization_default','admin_update')",
        "strftime('%Y-%m-%dT%H:%M:%SZ',expires_at)=expires_at"
      ]
    }
  },
  apply(db) {
    for (const name of ['organizations', 'users', 'activity_log', 'organization_plan_assignments']) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`028 requires ${name}`);
      }
    }

    const objectNames = [
      'organization_subscription_terms',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(() => '?').join(',');
    const existing = db.prepare(`
      SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name
    `).all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 028 object exists: ${existing[0].name}`);

    const organizationCount = db.prepare('SELECT COUNT(*) AS count FROM organizations').get().count;
    db.exec([TABLE_SQL, ...Object.values(INDEX_SQL)].join(';\n') + ';');
    db.exec(`
      INSERT INTO organization_subscription_terms
        (org_id,term_version,expires_at,changed_by,reason,source)
      SELECT id,1,NULL,NULL,NULL,'migration_backfill'
      FROM organizations ORDER BY id;
    `);
    const termCount = db.prepare('SELECT COUNT(*) AS count FROM organization_subscription_terms').get().count;
    const invalidCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM organizations organization
      LEFT JOIN organization_subscription_terms term
        ON term.id=(
          SELECT current.id
          FROM organization_subscription_terms current
          WHERE current.org_id=organization.id
          ORDER BY current.term_version DESC
          LIMIT 1
        )
      WHERE term.id IS NULL OR term.term_version<>1 OR term.expires_at IS NOT NULL
    `).get().count;
    if (termCount !== organizationCount || invalidCount !== 0) {
      throw new Error('028 organization subscription backfill is incomplete');
    }
    db.exec(Object.values(TRIGGER_SQL).join(';\n') + ';');
  }
};

module.exports = migration;
