const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const knowledgeService = require('../services/knowledge_service');
const migration004 = require('../migrations/004_knowledge_capacity_observability');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_V3 = Object.freeze([
  Object.freeze({
    version: 2,
    name: '002_campaign_business_spine',
    sourcePath: 'migrations/002_campaign_business_spine.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 3,
    name: '003_campaign_workflow_dispatch_evidence',
    sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);
const MIGRATIONS_V4 = Object.freeze([
  ...MIGRATIONS_V3,
  Object.freeze({
    version: 4,
    name: '004_knowledge_capacity_observability',
    sourcePath: 'migrations/004_knowledge_capacity_observability.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);
const EXPECTED_TASK7_INDEX_SQL = Object.freeze({
  idx_task7_knowledge_entries_creator: `CREATE INDEX idx_task7_knowledge_entries_creator
  ON knowledge_entries(created_by)
  WHERE created_by IS NOT NULL`,
  idx_task7_ai_references_campaign: `CREATE INDEX idx_task7_ai_references_campaign
  ON ai_references(campaign_id)
  WHERE campaign_id IS NOT NULL`,
  idx_task7_ai_references_knowledge_message_v1: `CREATE INDEX idx_task7_ai_references_knowledge_message_v1
  ON ai_references(knowledge_entry_id,message_id)
  WHERE reference_schema_version=1 AND knowledge_entry_id IS NOT NULL`,
  idx_task7_campaign_record_links_knowledge_custody: `CREATE INDEX idx_task7_campaign_record_links_knowledge_custody
  ON campaign_record_links(
    record_id,revoked_at,id,campaign_id,org_id,record_type,relation_type
  )
  WHERE record_type='knowledge_entry' AND relation_type<>'shortlist'`
});

function migrationOptions(migrations) {
  return { rootDir: SERVER_ROOT, registeredMigrations: migrations };
}

function databaseWorkspace(t, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `tm-${label}-`));
  const databases = [];
  t.after(() => {
    for (const db of databases) {
      if (db.open) db.close();
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    databasePath: path.join(directory, 'database.db'),
    track(db) {
      databases.push(db);
      return db;
    }
  };
}

function openMigrated(workspace, migrations) {
  return workspace.track(migrationService.openMigratedDatabase(
    workspace.databasePath,
    migrationOptions(migrations)
  ));
}

function seedCapacityFixture(db) {
  const hashes = {
    source100: '1'.repeat(64),
    entry100: 'a'.repeat(64),
    chunk100: 'b'.repeat(64),
    source101: '2'.repeat(64),
    entry101: 'c'.repeat(64),
    chunk101: 'd'.repeat(64),
    source102: '3'.repeat(64),
    entry102: 'e'.repeat(64),
    chunk102: 'f'.repeat(64)
  };

  db.prepare('INSERT INTO customers (id,brand_name,created_by) VALUES (100,?,1)')
    .run('Capacity fixture');
  db.prepare('INSERT INTO opportunities (id,customer_id,name,created_by) VALUES (100,100,?,1)')
    .run('Capacity fixture');
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id
    ) VALUES (100,1,'Capacity fixture',100,100,1,6)
  `).run();

  const insertEntry = db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      title,summary,tags_json,visibility,metadata_json,embedding_json,
      source_identity_sha256,content_sha256
    ) VALUES (@id,'note','manual',@id,'[]',@content,@creator,0,
      @title,'','[]','team','{}',NULL,@sourceHash,@entryHash)
  `);
  const insertChunk = db.prepare(`
    INSERT INTO knowledge_chunks (
      id,entry_id,chunk_index,content,metadata_json,token_count,embedding_json,
      content_sha256
    ) VALUES (@id,@id,0,@content,'{}',0,NULL,@chunkHash)
  `);
  const insertFts = db.prepare(`
    INSERT INTO knowledge_chunks_fts (title,content,tags,entry_id,chunk_id)
    VALUES (@title,@content,'',@id,@id)
  `);
  for (const row of [
    { id: 100, creator: 1, title: 'A', content: 'alpha', sourceHash: hashes.source100, entryHash: hashes.entry100, chunkHash: hashes.chunk100 },
    { id: 101, creator: null, title: 'B', content: 'é', sourceHash: hashes.source101, entryHash: hashes.entry101, chunkHash: hashes.chunk101 },
    { id: 102, creator: 1, title: 'C', content: 'xyz', sourceHash: hashes.source102, entryHash: hashes.entry102, chunkHash: hashes.chunk102 }
  ]) {
    insertEntry.run(row);
    insertChunk.run(row);
    insertFts.run(row);
  }

  db.prepare(`
    INSERT INTO campaign_record_links (
      id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by
    ) VALUES (100,1,100,'knowledge_entry',?,'102','knowledge',1)
  `).run('9'.repeat(64));

  db.prepare(`
    INSERT INTO ai_conversations (id,user_id,title) VALUES (100,1,'Capacity fixture')
  `).run();
  db.prepare(`
    INSERT INTO ai_messages (id,conversation_id,user_id,role,content)
    VALUES (100,100,1,'assistant','Fixture answer')
  `).run();
  db.prepare(`
    INSERT INTO ai_references (id,message_id,reference_type,reference_id)
    VALUES (100,100,'web','legacy')
  `).run();
  db.prepare(`
    INSERT INTO ai_references (
      id,message_id,reference_type,reference_id,reference_schema_version,
      knowledge_entry_id,knowledge_chunk_id,campaign_id,source_identity_sha256,
      entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
    ) VALUES (101,100,'knowledge','102',1,102,102,100,?,?,?,1,'selected')
  `).run(hashes.source102, hashes.entry102, hashes.chunk102);
}

function metricsFor(db, scopeType, scopeId) {
  return Object.fromEntries(db.prepare(`
    SELECT metric,usage_value,limit_value,threshold_percent,updated_at
    FROM knowledge_capacity_gauges
    WHERE scope_type=? AND scope_id=?
    ORDER BY metric
  `).all(scopeType, scopeId).map((row) => [row.metric, row]));
}

test('runtime registration upgrades an empty database to v4 with the capacity gauge table', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-capacity-v4-'));
  const databasePath = path.join(directory, 'empty.db');
  const previousDatabasePath = process.env.DB_PATH;
  process.env.DB_PATH = databasePath;

  const db = require('../db');
  t.after(() => {
    db.close();
    if (previousDatabasePath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDatabasePath;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(
    db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    4
  );
  assert.deepEqual(
    db.pragma('table_list').find((row) => row.name === 'knowledge_capacity_gauges'),
    {
      schema: 'main',
      name: 'knowledge_capacity_gauges',
      type: 'table',
      ncol: 7,
      wr: 1,
      strict: 1
    }
  );
  assert.deepEqual(
    db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type='index' AND name LIKE 'idx_task7_%'
      ORDER BY name
    `).all().map((row) => row.name),
    [
      'idx_task7_ai_references_campaign',
      'idx_task7_ai_references_knowledge_message_v1',
      'idx_task7_campaign_record_links_knowledge_custody',
      'idx_task7_knowledge_entries_creator'
    ]
  );
});

test('populated v3 upgrades deterministically and backfills authoritative sanitized gauges', (t) => {
  const workspace = databaseWorkspace(t, 'capacity-backfill');
  const v3 = openMigrated(workspace, MIGRATIONS_V3);
  seedCapacityFixture(v3);
  v3.close();

  const v4 = openMigrated(workspace, MIGRATIONS_V4);
  const user = metricsFor(v4, 'user', 1);
  const campaign = metricsFor(v4, 'campaign', 100);
  const organization = metricsFor(v4, 'organization', 1);

  assert.deepEqual(
    Object.fromEntries(Object.entries(user).map(([metric, row]) => [metric, [row.usage_value, row.limit_value, row.threshold_percent]])),
    {
      chunks: [2, 500000, 0],
      entries: [2, 50000, 0],
      payload_bytes: [34, 5368709120, 0],
      references: [2, 2000000, 0]
    }
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(campaign).map(([metric, row]) => [metric, [row.usage_value, row.limit_value, row.threshold_percent]])),
    {
      chunks: [1, 1000000, 0],
      entries: [1, 100000, 0],
      payload_bytes: [15, 10737418240, 0],
      references: [1, 4000000, 0]
    }
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(organization).map(([metric, row]) => [metric, [row.usage_value, row.limit_value, row.threshold_percent]])),
    {
      chunks: [3, 5000000, 0],
      entries: [3, 500000, 0],
      payload_bytes: [47, 53687091200, 0],
      references: [2, 20000000, 0]
    }
  );
  assert.match(user.entries.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(metricsFor(v4, 'user', 2).entries.usage_value, 0);

  const beforeRerun = v4.prepare(`
    SELECT * FROM knowledge_capacity_gauges
    ORDER BY scope_type,scope_id,metric
  `).all();
  migrationService.runMigrations(v4, migrationOptions(MIGRATIONS_V4));
  assert.deepEqual(v4.prepare(`
    SELECT * FROM knowledge_capacity_gauges
    ORDER BY scope_type,scope_id,metric
  `).all(), beforeRerun);
  assert.equal(v4.prepare(`
    SELECT COUNT(*) AS count FROM schema_migrations WHERE version=4
  `).get().count, 1);
  v4.close();

  const reopened = openMigrated(workspace, MIGRATIONS_V4);
  assert.deepEqual(reopened.prepare(`
    SELECT * FROM knowledge_capacity_gauges
    ORDER BY scope_type,scope_id,metric
  `).all(), beforeRerun);
});

test('gauge constraints, thresholds, and query plans enforce the foundation contract', (t) => {
  const workspace = databaseWorkspace(t, 'capacity-contract');
  const v3 = openMigrated(workspace, MIGRATIONS_V3);
  seedCapacityFixture(v3);
  v3.close();
  const db = openMigrated(workspace, MIGRATIONS_V4);

  assert.deepEqual(
    db.pragma('table_xinfo("knowledge_capacity_gauges")').map((column) => column.name),
    ['scope_type','scope_id','metric','usage_value','limit_value','threshold_percent','updated_at']
  );
  for (const invalid of [
    ['other', 999, 'entries', 0, 1, 0, '2026-01-01 00:00:00'],
    ['user', 0, 'entries', 0, 1, 0, '2026-01-01 00:00:00'],
    ['user', 999, 'other', 0, 1, 0, '2026-01-01 00:00:00'],
    ['user', 999, 'entries', -1, 1, 0, '2026-01-01 00:00:00'],
    ['user', 999, 'entries', 0, 0, 0, '2026-01-01 00:00:00'],
    ['user', 999, 'entries', 0, 1, 70, '2026-01-01 00:00:00'],
    ['user', 999, 'entries', 0, 1, 0, 'not-a-time']
  ]) {
    assert.throws(() => db.prepare(`
      INSERT INTO knowledge_capacity_gauges
        (scope_type,scope_id,metric,usage_value,limit_value,threshold_percent,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(...invalid), /constraint/i);
  }
  assert.deepEqual(
    [[79, 100], [80, 100], [89, 100], [90, 100], [99, 100], [100, 100], [101, 100]]
      .map(([usage, limit]) => knowledgeService.capacityThresholdPercent(usage, limit)),
    [0, 80, 80, 90, 90, 100, 100]
  );

  const planCases = [
    ['SELECT id FROM knowledge_entries WHERE created_by=1', 'idx_task7_knowledge_entries_creator', [100, 102]],
    ['SELECT id FROM ai_references WHERE campaign_id=100', 'idx_task7_ai_references_campaign', [101]],
    ["SELECT message_id FROM ai_references WHERE reference_schema_version=1 AND knowledge_entry_id=102", 'idx_task7_ai_references_knowledge_message_v1', [100]],
    ["SELECT campaign_id FROM campaign_record_links WHERE record_type='knowledge_entry' AND relation_type<>'shortlist' AND record_id='102'", 'idx_task7_campaign_record_links_knowledge_custody', [100]]
  ];
  for (const [sql, indexName, expected] of planCases) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join('\n');
    assert.match(plan, new RegExp(indexName));
    assert.deepEqual(db.prepare(sql).all().map((row) => Object.values(row)[0]), expected);
  }

  assert.deepEqual(
    Object.fromEntries(db.prepare(`
      SELECT name,sql
      FROM sqlite_schema
      WHERE type='index' AND name LIKE 'idx_task7_%'
      ORDER BY name
    `).all().map((row) => [row.name, row.sql])),
    EXPECTED_TASK7_INDEX_SQL
  );

  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id
    ) VALUES (101,1,'Capacity plan target',100,100,1,6)
  `).run();
  db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at='2026-03-01 00:00:00',revoked_by=1,revoke_reason='Capacity plan move'
    WHERE id=100
  `).run();
  db.prepare(`
    INSERT INTO campaign_record_links (
      id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by
    ) VALUES (101,1,101,'knowledge_entry',?,'102','knowledge',1)
  `).run('8'.repeat(64));

  let authoritativeCampaignSql = null;
  const planProbe = {
    prepare(sql) {
      authoritativeCampaignSql = sql;
      return db.prepare(sql);
    }
  };
  assert.equal(knowledgeService.campaignKnowledgeUsage(planProbe, 100).entries, 0);
  assert.equal(knowledgeService.campaignKnowledgeUsage(planProbe, 101).entries, 1);
  db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at='2026-02-01 00:00:00',revoked_by=1,revoke_reason='Capacity plan revoked'
    WHERE id=101
  `).run();
  assert.equal(knowledgeService.campaignKnowledgeUsage(planProbe, 100).entries, 1);
  assert.equal(knowledgeService.campaignKnowledgeUsage(planProbe, 101).entries, 0);
  const authoritativePlan = db.prepare(`EXPLAIN QUERY PLAN ${authoritativeCampaignSql}`)
    .all({ scopeId: 100 })
    .map((row) => row.detail)
    .join('\n');
  assert.match(
    authoritativePlan,
    /SCAN custody_link USING COVERING INDEX idx_task7_campaign_record_links_knowledge_custody/
  );
  assert.doesNotMatch(authoritativePlan, /SCAN custody_link(?:\n|$)/);
});

test('reconciliation repairs stale gauges inside a transaction while base rows stay authoritative', (t) => {
  const workspace = databaseWorkspace(t, 'capacity-reconcile');
  const v3 = openMigrated(workspace, MIGRATIONS_V3);
  seedCapacityFixture(v3);
  v3.close();
  const db = openMigrated(workspace, MIGRATIONS_V4);

  db.prepare(`
    UPDATE knowledge_capacity_gauges SET usage_value=0
    WHERE scope_type='user' AND scope_id=1 AND metric='entries'
  `).run();
  db.prepare(`
    DELETE FROM knowledge_capacity_gauges
    WHERE scope_type='campaign' AND scope_id=100 AND metric='chunks'
  `).run();
  assert.equal(knowledgeService.userKnowledgeUsage(db, 1).entries, 2);
  assert.throws(
    () => knowledgeService.reconcileKnowledgeCapacityGaugesInTransaction(db),
    /existing transaction/
  );

  db.transaction(() => {
    knowledgeService.reconcileKnowledgeCapacityGaugesInTransaction(db);
  }).immediate();

  assert.equal(metricsFor(db, 'user', 1).entries.usage_value, 2);
  assert.equal(metricsFor(db, 'campaign', 100).chunks.usage_value, 1);
  assert.equal(knowledgeService.userKnowledgeUsage(db, 1).entries, 2);
});

test('targeted refresh repairs only requested scopes after authoritative base-row reads', (t) => {
  const workspace = databaseWorkspace(t, 'capacity-refresh');
  const v3 = openMigrated(workspace, MIGRATIONS_V3);
  seedCapacityFixture(v3);
  v3.close();
  const db = openMigrated(workspace, MIGRATIONS_V4);

  db.prepare(`
    UPDATE knowledge_capacity_gauges SET usage_value=0
    WHERE scope_type='user' AND scope_id=1 AND metric='entries'
  `).run();
  db.prepare(`
    DELETE FROM knowledge_capacity_gauges
    WHERE scope_type='campaign' AND scope_id=100 AND metric='chunks'
  `).run();

  db.transaction(() => {
    assert.equal(knowledgeService.refreshKnowledgeCapacityGaugesInTransaction(db, [
      { scopeType: 'user', scopeId: 1 }
    ]), 4);
  }).immediate();

  assert.equal(metricsFor(db, 'user', 1).entries.usage_value, 2);
  assert.equal(metricsFor(db, 'campaign', 100).chunks, undefined);
  assert.equal(knowledgeService.campaignKnowledgeUsage(db, 100).chunks, 1);
});

test('partial or malformed pre-existing 004 objects fail closed without a ledger row', (t) => {
  const workspace = databaseWorkspace(t, 'capacity-drift');
  const v3 = openMigrated(workspace, MIGRATIONS_V3);
  v3.close();
  const raw = workspace.track(new Database(workspace.databasePath));
  raw.exec('CREATE TABLE knowledge_capacity_gauges (scope_type TEXT)');
  raw.close();

  assert.throws(
    () => openMigrated(workspace, MIGRATIONS_V4),
    /partial_or_malformed|unknown baseline object|partial 004/i
  );
  const inspection = workspace.track(new Database(workspace.databasePath, {
    readonly: true,
    fileMustExist: true
  }));
  assert.equal(
    inspection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    3
  );
});

test('pre-ledger forged 004 indexes and complete object sets fail closed without mutation', (t) => {
  const wrongIndexWorkspace = databaseWorkspace(t, 'capacity-wrong-index');
  const wrongIndexV3 = openMigrated(wrongIndexWorkspace, MIGRATIONS_V3);
  wrongIndexV3.close();
  const wrongIndexRaw = wrongIndexWorkspace.track(new Database(wrongIndexWorkspace.databasePath));
  wrongIndexRaw.exec(`
    CREATE INDEX idx_task7_knowledge_entries_creator
    ON knowledge_entries(created_by)
  `);
  wrongIndexRaw.close();
  assert.throws(
    () => openMigrated(wrongIndexWorkspace, MIGRATIONS_V4),
    /partial_or_malformed|unknown baseline object|partial 004/i
  );
  const wrongIndexInspection = wrongIndexWorkspace.track(new Database(
    wrongIndexWorkspace.databasePath,
    { readonly: true, fileMustExist: true }
  ));
  assert.equal(
    wrongIndexInspection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    3
  );
  assert.equal(
    wrongIndexInspection.prepare(`
      SELECT sql FROM sqlite_schema WHERE name='idx_task7_knowledge_entries_creator'
    `).get().sql.trimEnd(),
    'CREATE INDEX idx_task7_knowledge_entries_creator\n    ON knowledge_entries(created_by)'
  );

  const forgedWorkspace = databaseWorkspace(t, 'capacity-forged-complete');
  const forgedV3 = openMigrated(forgedWorkspace, MIGRATIONS_V3);
  seedCapacityFixture(forgedV3);
  forgedV3.transaction(() => migration004.apply(forgedV3)).immediate();
  const forgedGaugeCount = forgedV3.prepare(`
    SELECT COUNT(*) AS count FROM knowledge_capacity_gauges
  `).get().count;
  forgedV3.close();
  assert.throws(
    () => openMigrated(forgedWorkspace, MIGRATIONS_V4),
    /partial_or_malformed|unknown baseline object|partial 004/i
  );
  const forgedInspection = forgedWorkspace.track(new Database(
    forgedWorkspace.databasePath,
    { readonly: true, fileMustExist: true }
  ));
  assert.equal(
    forgedInspection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    3
  );
  assert.equal(
    forgedInspection.prepare('SELECT COUNT(*) AS count FROM knowledge_capacity_gauges').get().count,
    forgedGaugeCount
  );
});

test('managed v4 index tampering fails closed without ledger or domain mutation', (t) => {
  const workspace = databaseWorkspace(t, 'capacity-managed-drift');
  const v3 = openMigrated(workspace, MIGRATIONS_V3);
  seedCapacityFixture(v3);
  v3.close();
  const v4 = openMigrated(workspace, MIGRATIONS_V4);
  const before = {
    ledger: v4.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
    entries: v4.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count,
    gauges: v4.prepare('SELECT COUNT(*) AS count FROM knowledge_capacity_gauges').get().count
  };
  v4.exec(`
    DROP INDEX idx_task7_ai_references_campaign;
    CREATE INDEX idx_task7_ai_references_campaign
      ON ai_references(campaign_id,message_id)
      WHERE campaign_id IS NOT NULL;
  `);
  v4.close();

  assert.throws(
    () => openMigrated(workspace, MIGRATIONS_V4),
    /partial_or_malformed|incompatible 004_knowledge_capacity_observability index/i
  );
  const inspection = workspace.track(new Database(workspace.databasePath, {
    readonly: true,
    fileMustExist: true
  }));
  assert.deepEqual(
    inspection.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
    before.ledger
  );
  assert.equal(
    inspection.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count,
    before.entries
  );
  assert.equal(
    inspection.prepare('SELECT COUNT(*) AS count FROM knowledge_capacity_gauges').get().count,
    before.gauges
  );
});
