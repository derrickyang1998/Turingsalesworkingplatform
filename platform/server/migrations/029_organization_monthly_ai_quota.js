'use strict';

const TABLE_SQL = `CREATE TABLE organization_ai_quota_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  policy_version INTEGER NOT NULL CHECK(policy_version BETWEEN 1 AND 9007199254740991),
  monthly_limit INTEGER CHECK(
    monthly_limit IS NULL OR monthly_limit BETWEEN 0 AND 9007199254740991
  ),
  changed_by INTEGER CHECK(changed_by IS NULL OR changed_by BETWEEN 1 AND 9007199254740991),
  reason TEXT CHECK(reason IS NULL OR (
    length(trim(reason)) BETWEEN 1 AND 500
    AND reason NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
  )),
  source TEXT NOT NULL CHECK(source IN ('migration_backfill','organization_default','admin_update')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  ux_organization_ai_quota_policies_version: `CREATE UNIQUE INDEX ux_organization_ai_quota_policies_version
    ON organization_ai_quota_policies(org_id,policy_version)`,
  idx_token_usage_org_created: `CREATE INDEX idx_token_usage_org_created
    ON token_usage(org_id,created_at,id)`
});

const TRIGGER_SQL = Object.freeze({
  token_usage_created_at_insert_guard: `CREATE TRIGGER token_usage_created_at_insert_guard
BEFORE INSERT ON token_usage
WHEN typeof(NEW.created_at)<>'text'
  OR length(NEW.created_at)<>19
  OR NEW.created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
  OR strftime('%Y-%m-%d %H:%M:%S',NEW.created_at) IS NULL
  OR strftime('%Y-%m-%d %H:%M:%S',NEW.created_at)<>NEW.created_at
BEGIN SELECT RAISE(ABORT,'token usage timestamp must be canonical UTC seconds'); END`,
  organization_ai_quota_policy_insert_guard: `CREATE TRIGGER organization_ai_quota_policy_insert_guard
BEFORE INSERT ON organization_ai_quota_policies
WHEN NEW.policy_version<>(
    SELECT COALESCE(MAX(existing.policy_version),0)+1
    FROM organization_ai_quota_policies existing WHERE existing.org_id=NEW.org_id
  )
  OR NEW.source='migration_backfill'
  OR (
    NEW.source='organization_default' AND (
      NEW.changed_by IS NOT NULL OR NEW.reason IS NOT NULL OR NEW.monthly_limit IS NOT NULL
      OR NEW.policy_version<>1
      OR EXISTS (
        SELECT 1 FROM organization_ai_quota_policies existing WHERE existing.org_id=NEW.org_id
      )
    )
  )
  OR (
    NEW.source='admin_update' AND (
      NEW.changed_by IS NULL OR NEW.reason IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM organization_ai_quota_policies existing WHERE existing.org_id=NEW.org_id
      )
      OR NEW.monthly_limit IS (
        SELECT current.monthly_limit
        FROM organization_ai_quota_policies current
        WHERE current.org_id=NEW.org_id
        ORDER BY current.policy_version DESC
        LIMIT 1
      )
    )
  )
BEGIN SELECT RAISE(ABORT,'organization AI quota policy is invalid'); END`,
  organization_ai_quota_policy_no_replace_insert: `CREATE TRIGGER organization_ai_quota_policy_no_replace_insert
BEFORE INSERT ON organization_ai_quota_policies
WHEN NEW.id IS NOT NULL AND EXISTS (
  SELECT 1 FROM organization_ai_quota_policies WHERE id=NEW.id
)
BEGIN SELECT RAISE(ABORT,'organization AI quota policy history is immutable'); END`,
  organization_ai_quota_policy_no_update: `CREATE TRIGGER organization_ai_quota_policy_no_update
BEFORE UPDATE ON organization_ai_quota_policies
BEGIN SELECT RAISE(ABORT,'organization AI quota policy history is immutable'); END`,
  organization_ai_quota_policy_no_delete: `CREATE TRIGGER organization_ai_quota_policy_no_delete
BEFORE DELETE ON organization_ai_quota_policies
BEGIN SELECT RAISE(ABORT,'organization AI quota policy history is immutable'); END`,
  organization_ai_quota_default_after_insert: `CREATE TRIGGER organization_ai_quota_default_after_insert
AFTER INSERT ON organizations
BEGIN
  INSERT INTO organization_ai_quota_policies
    (org_id,policy_version,monthly_limit,changed_by,reason,source)
  VALUES (NEW.id,1,NULL,NULL,NULL,'organization_default');
END`
});

const migration = {
  version: 29,
  name: '029_organization_monthly_ai_quota',
  sourcePath: 'migrations/029_organization_monthly_ai_quota.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      organization_ai_quota_policies: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        policy_version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        monthly_limit: { type: 'INTEGER', notnull: 0, defaultValue: null },
        changed_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        reason: { type: 'TEXT', notnull: 0, defaultValue: null },
        source: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      organization_ai_quota_policies: [
        "source IN ('migration_backfill','organization_default','admin_update')",
        'monthly_limit BETWEEN 0 AND 9007199254740991'
      ]
    }
  },
  apply(db) {
    for (const name of ['organizations', 'users', 'activity_log', 'token_usage']) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`029 requires ${name}`);
      }
    }

    const objectNames = [
      'organization_ai_quota_policies',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(() => '?').join(',');
    const existing = db.prepare(`
      SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name
    `).all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 029 object exists: ${existing[0].name}`);

    const organizationCount = db.prepare('SELECT COUNT(*) AS count FROM organizations').get().count;
    const tokenUsageCount = db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count;
    const invalidTimestamp = db.prepare(`
      SELECT id FROM token_usage
      WHERE typeof(created_at)<>'text'
        OR length(created_at)<>19
        OR created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
        OR strftime('%Y-%m-%d %H:%M:%S',created_at) IS NULL
        OR strftime('%Y-%m-%d %H:%M:%S',created_at)<>created_at
      ORDER BY id LIMIT 1
    `).get();
    if (invalidTimestamp) throw new Error('non-canonical token usage timestamp');
    db.exec([TABLE_SQL, ...Object.values(INDEX_SQL)].join(';\n') + ';');
    db.exec(`
      INSERT INTO organization_ai_quota_policies
        (org_id,policy_version,monthly_limit,changed_by,reason,source)
      SELECT id,1,NULL,NULL,NULL,'migration_backfill'
      FROM organizations ORDER BY id;
    `);
    const policyCount = db.prepare('SELECT COUNT(*) AS count FROM organization_ai_quota_policies').get().count;
    const invalidCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM organizations organization
      LEFT JOIN organization_ai_quota_policies policy
        ON policy.id=(
          SELECT current.id
          FROM organization_ai_quota_policies current
          WHERE current.org_id=organization.id
          ORDER BY current.policy_version DESC
          LIMIT 1
        )
      WHERE policy.id IS NULL OR policy.policy_version<>1 OR policy.monthly_limit IS NOT NULL
    `).get().count;
    const tokenUsageCountAfter = db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count;
    if (
      policyCount !== organizationCount || invalidCount !== 0 ||
      tokenUsageCountAfter !== tokenUsageCount
    ) {
      throw new Error('029 organization AI quota backfill is incomplete');
    }
    db.exec(Object.values(TRIGGER_SQL).join(';\n') + ';');
  }
};

module.exports = migration;
