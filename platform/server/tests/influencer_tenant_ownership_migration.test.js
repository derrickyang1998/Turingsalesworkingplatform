'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');
const influencerWorkflow = require('../services/influencer_workflow_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
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

function loadMigration() {
  try {
    return require('../migrations/023_influencer_tenant_ownership');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 023 has not been implemented');
    }
    throw error;
  }
}

function migrationsThroughV23(migration) {
  return [
    ...migrationGate.REGISTERED_MIGRATIONS.filter((registered) => registered.version <= 22),
    migration
  ];
}

function openV22() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS.filter(
      (registered) => registered.version <= 22
    )
  });
  return db;
}

function legacyRows(db) {
  return db.prepare(`
    SELECT ${LEGACY_COLUMNS.join(',')}
    FROM influencers
    ORDER BY id
  `).all();
}

function seedLegacyRows(db) {
  db.prepare(`
    INSERT INTO influencers (
      id,platform,kol_handle,profile_link,followers,avg_views_10,avg_engagement,
      category,sub_category,region,language,content_style,collab_type,cost_usd,
      cost_range_min,cost_range_max,cpm,brand_collab_history,contact_email,
      data_source,enrichment_data,is_active,created_at,updated_at,project_name,
      product_name,reporter,tags,quoted_price,content_deliverable,is_duplicate,
      import_batch,influencer_type,cpv,parent_record
    ) VALUES (
      @id,@platform,@kol_handle,@profile_link,@followers,@avg_views_10,@avg_engagement,
      @category,@sub_category,@region,@language,@content_style,@collab_type,@cost_usd,
      @cost_range_min,@cost_range_max,@cpm,@brand_collab_history,@contact_email,
      @data_source,@enrichment_data,@is_active,@created_at,@updated_at,@project_name,
      @product_name,@reporter,@tags,@quoted_price,@content_deliverable,@is_duplicate,
      @import_batch,@influencer_type,@cpv,@parent_record
    )
  `).run({
    id: 701,
    platform: 'TikTok',
    kol_handle: '@legacy_creator',
    profile_link: 'https://example.test/legacy',
    followers: 123456,
    avg_views_10: 45678,
    avg_engagement: 3.25,
    category: 'Outdoor',
    sub_category: 'Camping',
    region: 'US',
    language: 'en',
    content_style: 'review',
    collab_type: 'Dedicated',
    cost_usd: 2500,
    cost_range_min: 2200,
    cost_range_max: 2800,
    cpm: 54.73,
    brand_collab_history: 'Brand A',
    contact_email: 'legacy@example.test',
    data_source: 'upload',
    enrichment_data: '{"source":"legacy"}',
    is_active: 1,
    created_at: '2026-07-01 02:03:04',
    updated_at: '2026-07-02 03:04:05',
    project_name: 'Legacy Project',
    product_name: 'Legacy Product',
    reporter: 'Derrick',
    tags: 'outdoor,camping',
    quoted_price: 3500,
    content_deliverable: '1 video',
    is_duplicate: 0,
    import_batch: 'legacy-batch',
    influencer_type: 'Mid-tier',
    cpv: 0.06,
    parent_record: 'CRM-701'
  });
  db.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,is_active,created_at,updated_at)
    VALUES (702,'Instagram','@inactive_creator',0,'2026-06-01 00:00:00','2026-06-01 00:00:00')
  `).run();
}

test('migration 023 backfills the unique default organization without changing legacy influencer values', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 23);
  assert.equal(migration.name, '023_influencer_tenant_ownership');
  assert.equal(migration.sourcePath, 'migrations/023_influencer_tenant_ownership.js');

  const db = openV22();
  try {
    seedLegacyRows(db);
    const before = legacyRows(db);

    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationsThroughV23(migration)
    });

    assert.equal(db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 23);
    assert.deepEqual(legacyRows(db), before);
    const ownedRows = db.prepare('SELECT id,org_id FROM influencers ORDER BY id').all();
    assert.equal(ownedRows.length, before.length);
    assert.ok(ownedRows.every((row) => row.org_id === 1));
    assert.deepEqual(ownedRows.slice(-2), [{ id: 701, org_id: 1 }, { id: 702, org_id: 1 }]);
    assert.deepEqual(
      db.prepare('PRAGMA foreign_key_list(influencers)').all()
        .filter((foreignKey) => foreignKey.from === 'org_id')
        .map((foreignKey) => ({ table: foreignKey.table, from: foreignKey.from, to: foreignKey.to })),
      [{ table: 'organizations', from: 'org_id', to: 'id' }]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type='index' AND name LIKE '%influencers_org%'
        ORDER BY name
      `).all().map((row) => row.name),
      [
        'idx_influencers_org_active_followers',
        'idx_influencers_org_import_batch',
        'ux_influencers_org_id'
      ]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type='trigger' AND name LIKE 'influencers_org_%'
        ORDER BY name
      `).all().map((row) => row.name),
      ['influencers_org_scope_insert', 'influencers_org_scope_update']
    );
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);

    assert.doesNotThrow(() => migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationsThroughV23(migration)
    }));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=23').get().count, 1);
  } finally {
    db.close();
  }
});

test('migration 023 preserves exact replay of a legacy default-organization import batch', () => {
  const migration = loadMigration();
  const db = openV22();
  try {
    const batch = 'legacy-replay-batch';
    const sourceRow = {
      Platform: 'TikTok',
      'KOL Handle': '@legacy_replay_creator',
      'Profile Link': 'https://example.test/legacy-replay',
      Followers: 12345,
      Project: 'Legacy Replay Project',
      Product: 'Legacy Replay Product'
    };
    const normalized = influencerWorkflow.normalizeInfluencerRow(sourceRow);
    const rowsSha256 = createHash('sha256')
      .update(Buffer.from(JSON.stringify([normalized]), 'utf8'))
      .digest('hex');
    const legacyArchive = influencerWorkflow._testing.archiveImportKnowledge(
      db,
      [normalized],
      { imported: 1, skipped: 0, total: 1, batch },
      batch,
      rowsSha256,
      { id: 1, role: 'admin' },
      1,
      true
    );
    assert.equal(legacyArchive.status, 'created');
    db.prepare(`
      INSERT INTO influencers (platform,kol_handle,profile_link,followers,project_name,product_name,import_batch)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      normalized.platform,
      normalized.kol_handle,
      normalized.profile_link,
      normalized.followers,
      normalized.project_name,
      normalized.product_name,
      batch
    );

    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationsThroughV23(migration)
    });

    const replay = influencerWorkflow.importInfluencerRows(db, [sourceRow], {
      organizationId: 1,
      batch_id: batch,
      user: { id: 1, role: 'admin' }
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.imported, 0);
    assert.equal(replay.knowledge_entry_id, legacyArchive.entry.id);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM influencers WHERE org_id=1 AND import_batch=?').get(batch).count,
      1
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries WHERE source_type=? AND source_id=?')
        .get('influencer_import', batch).count,
      1
    );
  } finally {
    db.close();
  }
});

test('migration 023 rejects missing, unknown, and reassigned influencer ownership', () => {
  const migration = loadMigration();
  const db = openV22();
  try {
    seedLegacyRows(db);
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: migrationsThroughV23(migration)
    });
    db.prepare("INSERT INTO organizations (id,code,name) VALUES (2,'second-org','Second Org')").run();

    assert.throws(
      () => db.prepare("INSERT INTO influencers (platform,kol_handle) VALUES ('TikTok','@missing_org')").run(),
      /organization ownership is required/i
    );
    assert.throws(
      () => db.prepare("INSERT INTO influencers (platform,kol_handle,org_id) VALUES ('TikTok','@unknown_org',999)").run(),
      /organization ownership is required/i
    );
    assert.doesNotThrow(
      () => db.prepare("INSERT INTO influencers (platform,kol_handle,org_id) VALUES ('TikTok','@second_org',2)").run()
    );
    assert.throws(
      () => db.prepare('UPDATE influencers SET org_id=2 WHERE id=701').run(),
      /organization ownership is immutable/i
    );
    assert.equal(db.prepare('SELECT org_id FROM influencers WHERE id=701').get().org_id, 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('migration 023 fails closed when the default organization is unavailable', () => {
  const migration = loadMigration();
  const db = openV22();
  try {
    seedLegacyRows(db);
    db.exec(`
      DROP TRIGGER organizations_code_immutable;
      UPDATE organizations SET code='renamed-default' WHERE id=1;
    `);

    assert.throws(
      () => db.transaction(() => migration.apply(db))(),
      /unique default organization/i
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('influencers') WHERE name='org_id'").get().count,
      0
    );
    assert.equal(db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 22);
  } finally {
    db.close();
  }
});
