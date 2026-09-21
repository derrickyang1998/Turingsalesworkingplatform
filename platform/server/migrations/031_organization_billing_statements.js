'use strict';

const MAX_SAFE_INTEGER = 9007199254740991;

const POLICY_TABLE_SQL = `CREATE TABLE organization_billing_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  policy_version INTEGER NOT NULL CHECK(policy_version BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  effective_month TEXT NOT NULL CHECK(
    length(effective_month)=10
    AND effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-01'
    AND strftime('%Y-%m-%d',effective_month) IS NOT NULL
    AND strftime('%Y-%m-%d',effective_month)=effective_month
  ),
  billing_enabled INTEGER NOT NULL CHECK(billing_enabled IN (0,1)),
  currency TEXT NOT NULL CHECK(currency='USD'),
  base_fee_cents INTEGER NOT NULL CHECK(base_fee_cents BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  included_tokens INTEGER NOT NULL CHECK(included_tokens BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  overage_cents_per_million_tokens INTEGER NOT NULL CHECK(
    overage_cents_per_million_tokens BETWEEN 0 AND ${MAX_SAFE_INTEGER}
  ),
  changed_by INTEGER CHECK(changed_by IS NULL OR changed_by BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  reason TEXT CHECK(reason IS NULL OR (
    length(trim(reason)) BETWEEN 1 AND 500
    AND reason NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
  )),
  source TEXT NOT NULL CHECK(source IN ('migration_backfill','organization_default','admin_update')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    length(created_at)=19
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
    AND strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const STATEMENT_TABLE_SQL = `CREATE TABLE organization_billing_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  period_key TEXT NOT NULL CHECK(
    length(period_key)=7
    AND period_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND strftime('%Y-%m',period_key || '-01') IS NOT NULL
    AND strftime('%Y-%m',period_key || '-01')=period_key
  ),
  period_start TEXT NOT NULL CHECK(
    length(period_start)=19
    AND period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-01 00:00:00'
    AND strftime('%Y-%m-%d %H:%M:%S',period_start) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',period_start)=period_start
  ),
  period_end TEXT NOT NULL CHECK(
    length(period_end)=19
    AND period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-01 00:00:00'
    AND strftime('%Y-%m-%d %H:%M:%S',period_end) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',period_end)=period_end
    AND period_end=datetime(period_start,'+1 month')
  ),
  policy_version INTEGER NOT NULL CHECK(policy_version BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  billing_enabled INTEGER NOT NULL CHECK(billing_enabled=1),
  currency TEXT NOT NULL CHECK(currency='USD'),
  usage_tokens INTEGER NOT NULL CHECK(usage_tokens BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  usage_record_count INTEGER NOT NULL CHECK(usage_record_count BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  usage_max_id INTEGER CHECK(usage_max_id IS NULL OR usage_max_id BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  included_tokens INTEGER NOT NULL CHECK(included_tokens BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  billable_tokens INTEGER NOT NULL CHECK(billable_tokens BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  base_fee_cents INTEGER NOT NULL CHECK(base_fee_cents BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  overage_cents_per_million_tokens INTEGER NOT NULL CHECK(
    overage_cents_per_million_tokens BETWEEN 0 AND ${MAX_SAFE_INTEGER}
  ),
  overage_fee_cents INTEGER NOT NULL CHECK(overage_fee_cents BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  total_cents INTEGER NOT NULL CHECK(total_cents BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  formula_version TEXT NOT NULL CHECK(formula_version='tm-billing-v1'),
  statement_sha256 TEXT NOT NULL CHECK(
    length(statement_sha256)=64
    AND statement_sha256=lower(statement_sha256)
    AND statement_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  closed_by INTEGER NOT NULL CHECK(closed_by BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  reason TEXT NOT NULL CHECK(
    length(trim(reason)) BETWEEN 1 AND 500
    AND reason NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    length(created_at)=19
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
    AND strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  CHECK(period_key=substr(period_start,1,7)),
  CHECK(
    (usage_record_count=0 AND usage_max_id IS NULL)
    OR (usage_record_count>0 AND usage_max_id IS NOT NULL)
  ),
  CHECK(billable_tokens=CASE
    WHEN usage_tokens>included_tokens THEN usage_tokens-included_tokens
    ELSE 0
  END),
  CHECK(overage_fee_cents=
    (billable_tokens / 1000000) * overage_cents_per_million_tokens
    + (billable_tokens % 1000000) * (overage_cents_per_million_tokens / 1000000)
    + (
      (billable_tokens % 1000000) * (overage_cents_per_million_tokens % 1000000)
      + 500000
    ) / 1000000
  ),
  CHECK(total_cents=base_fee_cents+overage_fee_cents),
  CHECK(billable_tokens<>0 OR overage_fee_cents=0),
  CHECK(overage_cents_per_million_tokens<>0 OR overage_fee_cents=0),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(closed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,policy_version)
    REFERENCES organization_billing_policies(org_id,policy_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;

const INDEX_SQL = Object.freeze({
  ux_organization_billing_policies_version: `CREATE UNIQUE INDEX ux_organization_billing_policies_version
    ON organization_billing_policies(org_id,policy_version)`,
  idx_organization_billing_policies_effective: `CREATE INDEX idx_organization_billing_policies_effective
    ON organization_billing_policies(org_id,effective_month DESC,policy_version DESC)`,
  ux_organization_billing_statements_period: `CREATE UNIQUE INDEX ux_organization_billing_statements_period
    ON organization_billing_statements(org_id,period_key)`
});

const TRIGGER_SQL = Object.freeze({
  organization_billing_policy_insert_guard: `CREATE TRIGGER organization_billing_policy_insert_guard
BEFORE INSERT ON organization_billing_policies
WHEN NEW.policy_version<>(
    SELECT COALESCE(MAX(existing.policy_version),0)+1
    FROM organization_billing_policies existing
    WHERE existing.org_id=NEW.org_id
  )
  OR NEW.source='migration_backfill'
  OR (NEW.source='organization_default' AND (
    NEW.policy_version<>1
    OR NEW.effective_month<>'1970-01-01'
    OR NEW.billing_enabled<>0
    OR NEW.currency<>'USD'
    OR NEW.base_fee_cents<>0
    OR NEW.included_tokens<>0
    OR NEW.overage_cents_per_million_tokens<>0
    OR NEW.changed_by IS NOT NULL
    OR NEW.reason IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM organization_billing_policies existing WHERE existing.org_id=NEW.org_id
    )
  ))
  OR (NEW.source='admin_update' AND (
    NEW.changed_by IS NULL
    OR NEW.reason IS NULL
    OR (NEW.billing_enabled=0 AND (
      NEW.base_fee_cents<>0
      OR NEW.included_tokens<>0
      OR NEW.overage_cents_per_million_tokens<>0
    ))
    OR NOT EXISTS (
      SELECT 1 FROM users actor
      WHERE actor.id=NEW.changed_by AND actor.role='admin' AND actor.is_active=1
    )
    OR NOT EXISTS (
      SELECT 1 FROM organization_billing_policies existing WHERE existing.org_id=NEW.org_id
    )
    OR NEW.effective_month<date('now','start of month','+1 month')
    OR EXISTS (
      SELECT 1 FROM organization_billing_policies existing
      WHERE existing.org_id=NEW.org_id
        AND existing.policy_version=(
          SELECT MAX(latest.policy_version)
          FROM organization_billing_policies latest WHERE latest.org_id=NEW.org_id
        )
        AND existing.effective_month=NEW.effective_month
        AND existing.billing_enabled=NEW.billing_enabled
        AND existing.currency=NEW.currency
        AND existing.base_fee_cents=NEW.base_fee_cents
        AND existing.included_tokens=NEW.included_tokens
        AND existing.overage_cents_per_million_tokens=NEW.overage_cents_per_million_tokens
    )
  ))
BEGIN SELECT RAISE(ABORT,'organization billing policy is invalid'); END`,
  organization_billing_policy_no_replace_insert: `CREATE TRIGGER organization_billing_policy_no_replace_insert
BEFORE INSERT ON organization_billing_policies
WHEN (NEW.id IS NOT NULL AND EXISTS (
    SELECT 1 FROM organization_billing_policies existing WHERE existing.id=NEW.id
  ))
  OR EXISTS (
    SELECT 1 FROM organization_billing_policies existing
    WHERE existing.org_id=NEW.org_id AND existing.policy_version=NEW.policy_version
  )
BEGIN SELECT RAISE(ABORT,'organization billing policy history is immutable'); END`,
  organization_billing_policy_no_update: `CREATE TRIGGER organization_billing_policy_no_update
BEFORE UPDATE ON organization_billing_policies
BEGIN SELECT RAISE(ABORT,'organization billing policy history is immutable'); END`,
  organization_billing_policy_no_delete: `CREATE TRIGGER organization_billing_policy_no_delete
BEFORE DELETE ON organization_billing_policies
BEGIN SELECT RAISE(ABORT,'organization billing policy history is immutable'); END`,
  organization_billing_default_after_insert: `CREATE TRIGGER organization_billing_default_after_insert
AFTER INSERT ON organizations
BEGIN
  INSERT INTO organization_billing_policies (
    org_id,policy_version,effective_month,billing_enabled,currency,base_fee_cents,
    included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
  ) VALUES (NEW.id,1,'1970-01-01',0,'USD',0,0,0,NULL,NULL,'organization_default');
END`,
  organization_billing_statement_insert_guard: `CREATE TRIGGER organization_billing_statement_insert_guard
BEFORE INSERT ON organization_billing_statements
WHEN NEW.period_end>CURRENT_TIMESTAMP
  OR NEW.created_at>CURRENT_TIMESTAMP
  OR NEW.created_at<NEW.period_end
  OR NOT EXISTS (
    SELECT 1
    FROM organization_billing_policies policy
    JOIN users actor ON actor.id=NEW.closed_by
    WHERE policy.org_id=NEW.org_id
      AND policy.policy_version=NEW.policy_version
      AND policy.effective_month<=substr(NEW.period_start,1,10)
      AND policy.billing_enabled=1
      AND policy.currency=NEW.currency
      AND policy.base_fee_cents=NEW.base_fee_cents
      AND policy.included_tokens=NEW.included_tokens
      AND policy.overage_cents_per_million_tokens=NEW.overage_cents_per_million_tokens
      AND actor.role='admin'
      AND actor.is_active=1
  )
  OR NEW.policy_version<>(
    SELECT policy.policy_version
    FROM organization_billing_policies policy
    WHERE policy.org_id=NEW.org_id
      AND policy.effective_month<=substr(NEW.period_start,1,10)
    ORDER BY policy.effective_month DESC,policy.policy_version DESC
    LIMIT 1
  )
BEGIN SELECT RAISE(ABORT,'organization billing statement period is not closed'); END`,
  organization_billing_statement_no_replace_insert: `CREATE TRIGGER organization_billing_statement_no_replace_insert
BEFORE INSERT ON organization_billing_statements
WHEN (NEW.id IS NOT NULL AND EXISTS (
    SELECT 1 FROM organization_billing_statements existing WHERE existing.id=NEW.id
  ))
  OR EXISTS (
    SELECT 1 FROM organization_billing_statements existing
    WHERE existing.org_id=NEW.org_id AND existing.period_key=NEW.period_key
  )
BEGIN SELECT RAISE(ABORT,'organization billing statements are immutable'); END`,
  organization_billing_statement_no_update: `CREATE TRIGGER organization_billing_statement_no_update
BEFORE UPDATE ON organization_billing_statements
BEGIN SELECT RAISE(ABORT,'organization billing statements are immutable'); END`,
  organization_billing_statement_no_delete: `CREATE TRIGGER organization_billing_statement_no_delete
BEFORE DELETE ON organization_billing_statements
BEGIN SELECT RAISE(ABORT,'organization billing statements are immutable'); END`
});

const migration = {
  version: 31,
  name: '031_organization_billing_statements',
  sourcePath: 'migrations/031_organization_billing_statements.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      organization_billing_policies: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        policy_version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        effective_month: { type: 'TEXT', notnull: 1, defaultValue: null },
        billing_enabled: { type: 'INTEGER', notnull: 1, defaultValue: null },
        currency: { type: 'TEXT', notnull: 1, defaultValue: null },
        base_fee_cents: { type: 'INTEGER', notnull: 1, defaultValue: null },
        included_tokens: { type: 'INTEGER', notnull: 1, defaultValue: null },
        overage_cents_per_million_tokens: { type: 'INTEGER', notnull: 1, defaultValue: null },
        changed_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        reason: { type: 'TEXT', notnull: 0, defaultValue: null },
        source: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      organization_billing_statements: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        period_key: { type: 'TEXT', notnull: 1, defaultValue: null },
        period_start: { type: 'TEXT', notnull: 1, defaultValue: null },
        period_end: { type: 'TEXT', notnull: 1, defaultValue: null },
        policy_version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        billing_enabled: { type: 'INTEGER', notnull: 1, defaultValue: null },
        currency: { type: 'TEXT', notnull: 1, defaultValue: null },
        usage_tokens: { type: 'INTEGER', notnull: 1, defaultValue: null },
        usage_record_count: { type: 'INTEGER', notnull: 1, defaultValue: null },
        usage_max_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        included_tokens: { type: 'INTEGER', notnull: 1, defaultValue: null },
        billable_tokens: { type: 'INTEGER', notnull: 1, defaultValue: null },
        base_fee_cents: { type: 'INTEGER', notnull: 1, defaultValue: null },
        overage_cents_per_million_tokens: { type: 'INTEGER', notnull: 1, defaultValue: null },
        overage_fee_cents: { type: 'INTEGER', notnull: 1, defaultValue: null },
        total_cents: { type: 'INTEGER', notnull: 1, defaultValue: null },
        formula_version: { type: 'TEXT', notnull: 1, defaultValue: null },
        statement_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        closed_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        reason: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      organization_billing_policies: [
        `CHECK(policy_version BETWEEN 1 AND ${MAX_SAFE_INTEGER})`,
        'CHECK(billing_enabled IN (0,1))',
        "CHECK(currency='USD')",
        `CHECK(base_fee_cents BETWEEN 0 AND ${MAX_SAFE_INTEGER})`,
        `CHECK(included_tokens BETWEEN 0 AND ${MAX_SAFE_INTEGER})`,
        "CHECK(source IN ('migration_backfill','organization_default','admin_update'))"
      ],
      organization_billing_statements: [
        'CHECK(billing_enabled=1)',
        "CHECK(currency='USD')",
        `CHECK(usage_tokens BETWEEN 0 AND ${MAX_SAFE_INTEGER})`,
        `CHECK(usage_record_count BETWEEN 0 AND ${MAX_SAFE_INTEGER})`,
        `CHECK(billable_tokens BETWEEN 0 AND ${MAX_SAFE_INTEGER})`,
        "CHECK(formula_version='tm-billing-v1')",
        'CHECK(period_key=substr(period_start,1,7))',
        'CHECK(overage_fee_cents=(billable_tokens / 1000000) * overage_cents_per_million_tokens + (billable_tokens % 1000000) * (overage_cents_per_million_tokens / 1000000) + ((billable_tokens % 1000000) * (overage_cents_per_million_tokens % 1000000) + 500000) / 1000000)',
        'CHECK(total_cents=base_fee_cents+overage_fee_cents)',
        "CHECK(length(statement_sha256)=64 AND statement_sha256=lower(statement_sha256) AND statement_sha256 NOT GLOB '*[^0-9a-f]*')"
      ]
    }
  },
  apply(db) {
    for (const name of ['organizations', 'users']) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`031 requires ${name}`);
      }
    }

    const objectNames = [
      'organization_billing_policies',
      'organization_billing_statements',
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(() => '?').join(',');
    const existing = db.prepare(`
      SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name
    `).all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 031 object exists: ${existing[0].name}`);

    const organizationCount = db.prepare('SELECT COUNT(*) AS count FROM organizations').get().count;
    db.exec([
      POLICY_TABLE_SQL,
      INDEX_SQL.ux_organization_billing_policies_version,
      STATEMENT_TABLE_SQL,
      INDEX_SQL.idx_organization_billing_policies_effective,
      INDEX_SQL.ux_organization_billing_statements_period
    ].join(';\n') + ';');
    db.exec(`
      INSERT INTO organization_billing_policies (
        org_id,policy_version,effective_month,billing_enabled,currency,base_fee_cents,
        included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
      )
      SELECT id,1,'1970-01-01',0,'USD',0,0,0,NULL,NULL,'migration_backfill'
      FROM organizations ORDER BY id;
    `);

    const policyCount = db.prepare('SELECT COUNT(*) AS count FROM organization_billing_policies').get().count;
    const invalidCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM organizations organization
      LEFT JOIN organization_billing_policies policy ON policy.org_id=organization.id
      WHERE policy.id IS NULL
        OR policy.policy_version<>1
        OR policy.effective_month<>'1970-01-01'
        OR policy.billing_enabled<>0
        OR policy.currency<>'USD'
        OR policy.base_fee_cents<>0
        OR policy.included_tokens<>0
        OR policy.overage_cents_per_million_tokens<>0
        OR policy.changed_by IS NOT NULL
        OR policy.reason IS NOT NULL
        OR policy.source<>'migration_backfill'
    `).get().count;
    const statementCount = db.prepare('SELECT COUNT(*) AS count FROM organization_billing_statements').get().count;
    if (policyCount !== organizationCount || invalidCount !== 0 || statementCount !== 0) {
      throw new Error('031 organization billing backfill is incomplete');
    }

    db.exec(Object.values(TRIGGER_SQL).join(';\n') + ';');
  }
};

module.exports = migration;
