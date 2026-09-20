'use strict';

const MODULE_CHECK = `module_code IN (
  'crm.customer','crm.opportunity','crm.contact','crm.task',
  'campaign.performance','campaign.customer_report','influencer.data'
)`;

const TABLE_SQL = Object.freeze({
  plan_catalog: `CREATE TABLE plan_catalog (
  code TEXT PRIMARY KEY CHECK(code IN ('crm_core','legacy_full')),
  name_zh TEXT NOT NULL CHECK(length(trim(name_zh)) BETWEEN 1 AND 80),
  name_en TEXT NOT NULL CHECK(length(trim(name_en)) BETWEEN 1 AND 80),
  catalog_version INTEGER NOT NULL CHECK(catalog_version=1),
  status TEXT NOT NULL CHECK(status='active'),
  display_order INTEGER NOT NULL UNIQUE CHECK(display_order BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  )
) STRICT, WITHOUT ROWID`,
  plan_module_entitlements: `CREATE TABLE plan_module_entitlements (
  plan_code TEXT NOT NULL,
  module_code TEXT NOT NULL CHECK(${MODULE_CHECK}),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  PRIMARY KEY(plan_code,module_code),
  FOREIGN KEY(plan_code) REFERENCES plan_catalog(code) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`,
  organization_plan_assignments: `CREATE TABLE organization_plan_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  plan_code TEXT NOT NULL,
  assignment_version INTEGER NOT NULL CHECK(assignment_version BETWEEN 1 AND 9007199254740991),
  assigned_by INTEGER CHECK(assigned_by IS NULL OR assigned_by BETWEEN 1 AND 9007199254740991),
  reason TEXT CHECK(reason IS NULL OR (length(trim(reason)) BETWEEN 1 AND 500 AND reason NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*')),
  source TEXT NOT NULL CHECK(source IN ('migration_backfill','organization_default','admin_assignment')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(plan_code) REFERENCES plan_catalog(code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(assigned_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`
});

const INDEX_SQL = Object.freeze({
  ux_organization_plan_assignments_version: `CREATE UNIQUE INDEX ux_organization_plan_assignments_version
    ON organization_plan_assignments(org_id,assignment_version)`,
  idx_organization_plan_assignments_plan: `CREATE INDEX idx_organization_plan_assignments_plan
    ON organization_plan_assignments(plan_code,org_id,assignment_version DESC)`
});

const TRIGGER_SQL = Object.freeze({
  plan_catalog_no_replace_insert: `CREATE TRIGGER plan_catalog_no_replace_insert
BEFORE INSERT ON plan_catalog
BEGIN SELECT RAISE(ABORT,'plan catalog is immutable'); END`,
  plan_catalog_no_update: `CREATE TRIGGER plan_catalog_no_update
BEFORE UPDATE ON plan_catalog
BEGIN SELECT RAISE(ABORT,'plan catalog is immutable'); END`,
  plan_catalog_no_delete: `CREATE TRIGGER plan_catalog_no_delete
BEFORE DELETE ON plan_catalog
BEGIN SELECT RAISE(ABORT,'plan catalog is immutable'); END`,
  plan_entitlements_no_replace_insert: `CREATE TRIGGER plan_entitlements_no_replace_insert
BEFORE INSERT ON plan_module_entitlements
BEGIN SELECT RAISE(ABORT,'plan entitlements are immutable'); END`,
  plan_entitlements_no_update: `CREATE TRIGGER plan_entitlements_no_update
BEFORE UPDATE ON plan_module_entitlements
BEGIN SELECT RAISE(ABORT,'plan entitlements are immutable'); END`,
  plan_entitlements_no_delete: `CREATE TRIGGER plan_entitlements_no_delete
BEFORE DELETE ON plan_module_entitlements
BEGIN SELECT RAISE(ABORT,'plan entitlements are immutable'); END`,
  organization_plan_assignment_insert_guard: `CREATE TRIGGER organization_plan_assignment_insert_guard
BEFORE INSERT ON organization_plan_assignments
WHEN NOT EXISTS (
    SELECT 1 FROM plan_catalog plan WHERE plan.code=NEW.plan_code AND plan.status='active'
  )
  OR NEW.assignment_version<>(
    SELECT COALESCE(MAX(existing.assignment_version),0)+1
    FROM organization_plan_assignments existing WHERE existing.org_id=NEW.org_id
  )
  OR NEW.source='migration_backfill'
  OR (
    NEW.source='organization_default' AND (
      NEW.assigned_by IS NOT NULL OR NEW.reason IS NOT NULL OR NEW.assignment_version<>1
      OR EXISTS (
        SELECT 1 FROM organization_plan_assignments existing WHERE existing.org_id=NEW.org_id
      )
    )
  )
  OR (
    NEW.source='admin_assignment' AND (
      NEW.assigned_by IS NULL OR NEW.reason IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM organization_plan_assignments existing WHERE existing.org_id=NEW.org_id
      )
      OR NEW.plan_code=(
        SELECT current.plan_code
        FROM organization_plan_assignments current
        WHERE current.org_id=NEW.org_id
        ORDER BY current.assignment_version DESC
        LIMIT 1
      )
    )
  )
BEGIN SELECT RAISE(ABORT,'organization plan assignment is invalid'); END`,
  organization_plan_assignment_no_replace_insert: `CREATE TRIGGER organization_plan_assignment_no_replace_insert
BEFORE INSERT ON organization_plan_assignments
WHEN NEW.id IS NOT NULL AND EXISTS (
  SELECT 1 FROM organization_plan_assignments WHERE id=NEW.id
)
BEGIN SELECT RAISE(ABORT,'organization plan assignment history is immutable'); END`,
  organization_plan_assignment_no_update: `CREATE TRIGGER organization_plan_assignment_no_update
BEFORE UPDATE ON organization_plan_assignments
BEGIN SELECT RAISE(ABORT,'organization plan assignment history is immutable'); END`,
  organization_plan_assignment_no_delete: `CREATE TRIGGER organization_plan_assignment_no_delete
BEFORE DELETE ON organization_plan_assignments
BEGIN SELECT RAISE(ABORT,'organization plan assignment history is immutable'); END`,
  organization_plan_default_after_insert: `CREATE TRIGGER organization_plan_default_after_insert
AFTER INSERT ON organizations
BEGIN
  INSERT INTO organization_plan_assignments
    (org_id,plan_code,assignment_version,assigned_by,reason,source)
  VALUES (NEW.id,'legacy_full',1,NULL,NULL,'organization_default');
END`
});

const migration = {
  version: 27,
  name: '027_plan_catalog_module_entitlements',
  sourcePath: 'migrations/027_plan_catalog_module_entitlements.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      plan_catalog: {
        code: { type: 'TEXT', notnull: 1, defaultValue: null },
        name_zh: { type: 'TEXT', notnull: 1, defaultValue: null },
        name_en: { type: 'TEXT', notnull: 1, defaultValue: null },
        catalog_version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        status: { type: 'TEXT', notnull: 1, defaultValue: null },
        display_order: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      plan_module_entitlements: {
        plan_code: { type: 'TEXT', notnull: 1, defaultValue: null },
        module_code: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      organization_plan_assignments: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        plan_code: { type: 'TEXT', notnull: 1, defaultValue: null },
        assignment_version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        assigned_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        reason: { type: 'TEXT', notnull: 0, defaultValue: null },
        source: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      plan_catalog: ["code IN ('crm_core','legacy_full')", 'catalog_version=1'],
      plan_module_entitlements: ["'campaign.performance'", "'influencer.data'"],
      organization_plan_assignments: ["source IN ('migration_backfill','organization_default','admin_assignment')"]
    }
  },
  apply(db) {
    for (const name of ['organizations', 'users', 'activity_log']) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`027 requires ${name}`);
      }
    }

    const objectNames = [
      ...Object.keys(TABLE_SQL),
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(() => '?').join(',');
    const existing = db.prepare(`
      SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name
    `).all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 027 object exists: ${existing[0].name}`);

    const organizationCount = db.prepare('SELECT COUNT(*) AS count FROM organizations').get().count;
    db.exec([
      ...Object.values(TABLE_SQL),
      ...Object.values(INDEX_SQL)
    ].join(';\n') + ';');

    db.exec(`
      INSERT INTO plan_catalog
        (code,name_zh,name_en,catalog_version,status,display_order)
      VALUES
        ('crm_core','客户关系核心版','CRM Core',1,'active',10),
        ('legacy_full','完整兼容版','Legacy Full',1,'active',20);

      INSERT INTO plan_module_entitlements (plan_code,module_code) VALUES
        ('crm_core','crm.customer'),
        ('crm_core','crm.opportunity'),
        ('crm_core','crm.contact'),
        ('crm_core','crm.task'),
        ('legacy_full','crm.customer'),
        ('legacy_full','crm.opportunity'),
        ('legacy_full','crm.contact'),
        ('legacy_full','crm.task'),
        ('legacy_full','campaign.performance'),
        ('legacy_full','campaign.customer_report'),
        ('legacy_full','influencer.data');

      INSERT INTO organization_plan_assignments
        (org_id,plan_code,assignment_version,assigned_by,reason,source)
      SELECT id,'legacy_full',1,NULL,NULL,'migration_backfill'
      FROM organizations ORDER BY id;
    `);

    const assignmentCount = db.prepare(`
      SELECT COUNT(*) AS count FROM organization_plan_assignments
    `).get().count;
    const invalidCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM organizations organization
      LEFT JOIN organization_plan_assignments assignment
        ON assignment.id=(
          SELECT current.id
          FROM organization_plan_assignments current
          WHERE current.org_id=organization.id
          ORDER BY current.assignment_version DESC
          LIMIT 1
        )
      LEFT JOIN plan_catalog plan ON plan.code=assignment.plan_code AND plan.status='active'
      WHERE assignment.id IS NULL OR plan.code IS NULL
    `).get().count;
    const expectedEntitlements = [
      'crm_core:crm.contact',
      'crm_core:crm.customer',
      'crm_core:crm.opportunity',
      'crm_core:crm.task',
      'legacy_full:campaign.customer_report',
      'legacy_full:campaign.performance',
      'legacy_full:crm.contact',
      'legacy_full:crm.customer',
      'legacy_full:crm.opportunity',
      'legacy_full:crm.task',
      'legacy_full:influencer.data'
    ];
    const actualEntitlements = db.prepare(`
      SELECT plan_code || ':' || module_code AS entitlement
      FROM plan_module_entitlements
      ORDER BY plan_code,module_code
    `).all().map((row) => row.entitlement);
    if (
      assignmentCount !== organizationCount || invalidCount !== 0 ||
      JSON.stringify(actualEntitlements) !== JSON.stringify(expectedEntitlements)
    ) {
      throw new Error('027 organization plan backfill is incomplete');
    }
    db.exec(Object.values(TRIGGER_SQL).join(';\n') + ';');
  }
};

module.exports = migration;
