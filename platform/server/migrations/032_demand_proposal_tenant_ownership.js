'use strict';

const MAX_SAFE_INTEGER = 9007199254740991;

const INDEX_SQL = Object.freeze({
  idx_demands_org_created: `CREATE INDEX idx_demands_org_created
    ON demands(org_id,created_at DESC,id DESC)`,
  idx_proposals_org_created: `CREATE INDEX idx_proposals_org_created
    ON proposals(org_id,created_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  demands_scope_insert: `CREATE TRIGGER demands_scope_insert
BEFORE INSERT ON demands
WHEN NEW.org_id IS NOT NULL
  AND (
    typeof(NEW.org_id)<>'integer'
    OR NEW.org_id<1
    OR NEW.org_id>${MAX_SAFE_INTEGER}
    OR NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW.org_id)
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships
      WHERE org_id=NEW.org_id AND user_id=NEW.user_id AND status='active'
    )
  )
BEGIN SELECT RAISE(ABORT,'demand organization ownership is invalid'); END`,
  demands_scope_update: `CREATE TRIGGER demands_scope_update
BEFORE UPDATE OF org_id,user_id ON demands
WHEN NEW.org_id IS NOT NULL
  AND (
    typeof(NEW.org_id)<>'integer'
    OR NEW.org_id<1
    OR NEW.org_id>${MAX_SAFE_INTEGER}
    OR NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW.org_id)
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships
      WHERE org_id=NEW.org_id AND user_id=NEW.user_id AND status='active'
    )
  )
BEGIN SELECT RAISE(ABORT,'demand organization ownership is invalid'); END`,
  proposals_scope_insert: `CREATE TRIGGER proposals_scope_insert
BEFORE INSERT ON proposals
WHEN NEW.org_id IS NOT NULL
  AND (
    typeof(NEW.org_id)<>'integer'
    OR NEW.org_id<1
    OR NEW.org_id>${MAX_SAFE_INTEGER}
    OR NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW.org_id)
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships
      WHERE org_id=NEW.org_id AND user_id=NEW.user_id AND status='active'
    )
    OR (
      NEW.demand_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM demands
        WHERE id=NEW.demand_id AND (org_id IS NULL OR org_id=NEW.org_id)
      )
    )
  )
BEGIN SELECT RAISE(ABORT,'proposal organization ownership is invalid'); END`,
  proposals_scope_update: `CREATE TRIGGER proposals_scope_update
BEFORE UPDATE OF org_id,user_id,demand_id ON proposals
WHEN NEW.org_id IS NOT NULL
  AND (
    typeof(NEW.org_id)<>'integer'
    OR NEW.org_id<1
    OR NEW.org_id>${MAX_SAFE_INTEGER}
    OR NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW.org_id)
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships
      WHERE org_id=NEW.org_id AND user_id=NEW.user_id AND status='active'
    )
    OR (
      NEW.demand_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM demands
        WHERE id=NEW.demand_id AND (org_id IS NULL OR org_id=NEW.org_id)
      )
    )
  )
BEGIN SELECT RAISE(ABORT,'proposal organization ownership is invalid'); END`
});

function resolveDefaultOrganization(db) {
  const rows = db.prepare('SELECT id FROM organizations ORDER BY id').all();
  if (rows.length !== 1) return null;
  return rows[0].id;
}

function assertNoAmbiguousLinks(db) {
  const row = db.prepare(`
    SELECT record_type,record_id
    FROM campaign_record_links
    WHERE record_type IN ('demand','proposal')
      AND relation_type<>'shortlist'
      AND revoked_at IS NULL
    GROUP BY record_type,record_id
    HAVING COUNT(DISTINCT org_id)>1
    ORDER BY record_type,record_id
    LIMIT 1
  `).get();
  if (row) throw new Error(`032 ambiguous ${row.record_type} organization ownership for ${row.record_id}`);
}

function backfillFromLinks(db, table, recordType) {
  db.exec(`
    UPDATE ${table} AS record
    SET org_id=(
      SELECT MIN(link.org_id)
      FROM campaign_record_links link
      WHERE link.record_type='${recordType}'
        AND link.record_id=CAST(record.id AS TEXT)
        AND link.relation_type<>'shortlist'
        AND link.revoked_at IS NULL
    )
    WHERE record.org_id IS NULL
  `);
}

function backfillFromOwnerMembership(db, table) {
  db.exec(`
    UPDATE ${table} AS record
    SET org_id=(
      SELECT MIN(membership.org_id)
      FROM organization_memberships membership
      WHERE membership.user_id=record.user_id
        AND membership.status='active'
      GROUP BY membership.user_id
      HAVING COUNT(DISTINCT membership.org_id)=1
    )
    WHERE record.org_id IS NULL
  `);
}

const migration = {
  version: 32,
  name: '032_demand_proposal_tenant_ownership',
  sourcePath: 'migrations/032_demand_proposal_tenant_ownership.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      demands: { org_id: { type: 'INTEGER', notnull: 0, defaultValue: null } },
      proposals: { org_id: { type: 'INTEGER', notnull: 0, defaultValue: null } }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {}
  },
  apply(db) {
    for (const name of [
      'organizations',
      'organization_memberships',
      'campaign_record_links',
      'demands',
      'proposals'
    ]) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`032 requires ${name}`);
      }
    }

    const objects = [...Object.keys(INDEX_SQL), ...Object.keys(TRIGGER_SQL)];
    const placeholders = objects.map(() => '?').join(',');
    const existingObject = db.prepare(`
      SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name LIMIT 1
    `).get(...objects);
    const existingColumn = db.prepare(`
      SELECT name FROM pragma_table_info('demands') WHERE name='org_id'
      UNION ALL
      SELECT name FROM pragma_table_info('proposals') WHERE name='org_id'
      LIMIT 1
    `).get();
    if (existingObject || existingColumn) {
      throw new Error('partial 032 demand/proposal ownership object exists');
    }

    assertNoAmbiguousLinks(db);
    const defaultOrganizationId = resolveDefaultOrganization(db);
    db.exec(`
      ALTER TABLE demands ADD COLUMN org_id INTEGER
        REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
      ALTER TABLE proposals ADD COLUMN org_id INTEGER
        REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);

    backfillFromLinks(db, 'demands', 'demand');
    backfillFromLinks(db, 'proposals', 'proposal');
    db.exec(`
      UPDATE proposals
      SET org_id=(SELECT demand.org_id FROM demands demand WHERE demand.id=proposals.demand_id)
      WHERE org_id IS NULL AND demand_id IS NOT NULL;
    `);
    backfillFromOwnerMembership(db, 'demands');
    backfillFromOwnerMembership(db, 'proposals');
    if (defaultOrganizationId !== null) {
      db.prepare('UPDATE demands SET org_id=? WHERE org_id IS NULL').run(defaultOrganizationId);
      db.prepare('UPDATE proposals SET org_id=? WHERE org_id IS NULL').run(defaultOrganizationId);
    }

    const unresolved = db.prepare(`
      SELECT 'demand' AS kind,id FROM demands WHERE org_id IS NULL
      UNION ALL
      SELECT 'proposal' AS kind,id FROM proposals WHERE org_id IS NULL
      ORDER BY 1,2 LIMIT 1
    `).get();
    if (unresolved) throw new Error(`032 unresolved ${unresolved.kind} organization ownership for ${unresolved.id}`);

    const invalid = db.prepare(`
      SELECT 'demand' AS kind,record.id
      FROM demands record
      LEFT JOIN organizations organization ON organization.id=record.org_id
      WHERE organization.id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM organization_memberships membership
           WHERE membership.org_id=record.org_id
             AND membership.user_id=record.user_id
             AND membership.status='active'
         )
      UNION ALL
      SELECT 'proposal' AS kind,record.id
      FROM proposals record
      LEFT JOIN organizations organization ON organization.id=record.org_id
      WHERE organization.id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM organization_memberships membership
           WHERE membership.org_id=record.org_id
             AND membership.user_id=record.user_id
             AND membership.status='active'
         )
         OR (
           record.demand_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM demands demand
             WHERE demand.id=record.demand_id AND demand.org_id=record.org_id
           )
         )
      ORDER BY 1,2 LIMIT 1
    `).get();
    if (invalid) throw new Error(`032 invalid ${invalid.kind} organization ownership for ${invalid.id}`);

    db.exec([...Object.values(INDEX_SQL), ...Object.values(TRIGGER_SQL)].join(';' + '\n') + ';');
  }
};

module.exports = migration;
