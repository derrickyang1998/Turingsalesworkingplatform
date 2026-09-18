'use strict';

const { createHash } = require('node:crypto');

const LEGACY_COLUMNS = Object.freeze([
  'id',
  'platform',
  'kol_handle',
  'profile_link',
  'followers',
  'avg_views_10',
  'avg_engagement',
  'category',
  'sub_category',
  'region',
  'language',
  'content_style',
  'collab_type',
  'cost_usd',
  'cost_range_min',
  'cost_range_max',
  'cpm',
  'brand_collab_history',
  'contact_email',
  'data_source',
  'enrichment_data',
  'is_active',
  'created_at',
  'updated_at',
  'project_name',
  'product_name',
  'reporter',
  'tags',
  'quoted_price',
  'content_deliverable',
  'is_duplicate',
  'import_batch',
  'influencer_type',
  'cpv',
  'parent_record'
]);

const INDEX_SQL = Object.freeze({
  ux_influencers_org_id: `CREATE UNIQUE INDEX ux_influencers_org_id
    ON influencers(org_id,id)`,
  idx_influencers_org_active_followers: `CREATE INDEX idx_influencers_org_active_followers
    ON influencers(org_id,is_active,followers DESC,id)`,
  idx_influencers_org_import_batch: `CREATE INDEX idx_influencers_org_import_batch
    ON influencers(org_id,import_batch,id)`
});

const TRIGGER_SQL = Object.freeze({
  influencers_org_scope_insert: `CREATE TRIGGER influencers_org_scope_insert
BEFORE INSERT ON influencers
WHEN NEW.org_id IS NULL
  OR typeof(NEW.org_id)<>'integer'
  OR NEW.org_id<1
  OR NEW.org_id>9007199254740991
  OR NOT EXISTS (SELECT 1 FROM organizations organization WHERE organization.id=NEW.org_id)
BEGIN SELECT RAISE(ABORT,'influencer organization ownership is required'); END`,
  influencers_org_scope_update: `CREATE TRIGGER influencers_org_scope_update
BEFORE UPDATE ON influencers
WHEN NEW.org_id IS NOT OLD.org_id
  OR NEW.org_id IS NULL
  OR typeof(NEW.org_id)<>'integer'
  OR NEW.org_id<1
  OR NEW.org_id>9007199254740991
  OR NOT EXISTS (SELECT 1 FROM organizations organization WHERE organization.id=NEW.org_id)
BEGIN
  SELECT CASE
    WHEN NEW.org_id IS NOT OLD.org_id
      THEN RAISE(ABORT,'influencer organization ownership is immutable')
    ELSE RAISE(ABORT,'influencer organization ownership is required')
  END;
END`
});

function encodedValue(value) {
  if (value === null) return ['null', ''];
  if (typeof value === 'object') return ['blob', value.toString('base64')];
  if (typeof value === 'number') return [Number.isInteger(value) ? 'integer' : 'real', String(value)];
  return ['text', String(value)];
}

function legacyProjection(db) {
  const rows = db.prepare(`
    SELECT ${LEGACY_COLUMNS.join(',')}
    FROM influencers
    ORDER BY id
  `).all();
  const hash = createHash('sha256');
  hash.update('tm-influencers-v23-legacy-projection-v1\n');
  for (const row of rows) {
    hash.update(JSON.stringify(LEGACY_COLUMNS.map((column) => encodedValue(row[column]))));
    hash.update('\n');
  }
  return { count: rows.length, sha256: hash.digest('hex') };
}

function resolveDefaultOrganizationId(db) {
  const organizations = db.prepare(`
    SELECT id,code,name,created_at
    FROM organizations
    ORDER BY id
  `).all();
  const namedDefault = organizations.filter((organization) => (
    organization.code === 'turingmarket-default'
  ));
  if (namedDefault.length === 1) return namedDefault[0].id;
  if (namedDefault.length > 1 || organizations.length === 0) {
    throw new Error('023 requires one unique default organization');
  }

  const sanitizedDefault = organizations.filter((organization) => (
    /^tm-inert-secret-[0-9a-f]{64}$/.test(organization.code) &&
    /^tmtext-[0-9a-f]{32}$/.test(organization.name) &&
    organization.created_at === '1970-01-01 00:00:00'
  ));
  if (sanitizedDefault.length !== 1 || sanitizedDefault[0].id !== organizations[0].id) {
    throw new Error('023 requires one unique default organization');
  }
  return sanitizedDefault[0].id;
}

const migration = {
  version: 23,
  name: '023_influencer_tenant_ownership',
  sourcePath: 'migrations/023_influencer_tenant_ownership.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      influencers: {
        org_id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {}
  },
  apply(db) {
    for (const name of ['organizations', 'influencers']) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`023 requires ${name}`);
      }
    }

    const objectNames = [...Object.keys(INDEX_SQL), ...Object.keys(TRIGGER_SQL)];
    const placeholders = objectNames.map(() => '?').join(',');
    const existingObject = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE name IN (${placeholders})
      ORDER BY name
      LIMIT 1
    `).get(...objectNames);
    const existingColumn = db.prepare("SELECT 1 AS present FROM pragma_table_info('influencers') WHERE name='org_id'").get();
    if (existingColumn || existingObject) {
      throw new Error('partial 023 influencer ownership object exists');
    }

    const defaultOrganizationId = resolveDefaultOrganizationId(db);

    const before = legacyProjection(db);
    db.exec(`
      ALTER TABLE influencers
      ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);
    db.prepare('UPDATE influencers SET org_id=? WHERE org_id IS NULL').run(defaultOrganizationId);
    db.exec([
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');

    const after = legacyProjection(db);
    if (after.count !== before.count || after.sha256 !== before.sha256) {
      throw new Error('023 changed the legacy influencer projection');
    }
    const invalidOwnership = db.prepare(`
      SELECT COUNT(*) AS count
      FROM influencers influencer
      LEFT JOIN organizations organization ON organization.id=influencer.org_id
      WHERE influencer.org_id IS NULL
        OR typeof(influencer.org_id)<>'integer'
        OR organization.id IS NULL
    `).get().count;
    if (invalidOwnership !== 0) {
      throw new Error('023 influencer ownership backfill is incomplete');
    }
  }
};

module.exports = migration;
