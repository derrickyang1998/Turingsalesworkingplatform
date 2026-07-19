const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const campaignSchemaContract = require('./fixtures/campaign_schema_contract');
const {
  buildLegacyPopulatedFixture,
  captureTypedTable,
  captureFtsProjection
} = require('./fixtures/legacy_populated_fixture');

const SERVER_ROOT = path.resolve(__dirname, '..');

const CAMPAIGN_MIGRATION_DESCRIPTOR = Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
});

const EXPECTED_DOMAIN_TABLES = Object.freeze([
  'campaign_events',
  'campaign_record_links',
  'campaign_workflow_dispatches',
  'campaigns',
  'organization_memberships',
  'organizations',
  'request_idempotency',
  'team_memberships',
  'teams'
]);

const EXPECTED_COMPATIBILITY_COLUMNS = Object.freeze({
  ai_references: Object.freeze([
    'campaign_id',
    'chunk_content_sha256',
    'entry_content_sha256',
    'knowledge_chunk_id',
    'knowledge_entry_id',
    'reference_rank',
    'reference_schema_version',
    'selection_origin',
    'source_identity_sha256'
  ]),
  knowledge_chunks: Object.freeze(['content_sha256']),
  knowledge_entries: Object.freeze(['content_sha256', 'source_identity_sha256']),
  workflow_instances: Object.freeze([
    'campaign_dispatch_id',
    'campaign_event_id',
    'campaign_id',
    'execution_error',
    'execution_error_code',
    'execution_failed_at',
    'initialization_error',
    'initialization_status',
    'org_id'
  ]),
  workflow_tasks: Object.freeze(['assignment_version']),
  workflow_templates: Object.freeze(['trigger_config_json'])
});

const EXPECTED_INDEXES = campaignSchemaContract.indexNames;
const EXPECTED_TRIGGERS = campaignSchemaContract.triggerNames;

const EXPECTED_COMPOSITE_FOREIGN_KEYS = Object.freeze([
  'campaign_events|campaigns|org_id,campaign_id|org_id,id',
  'campaign_events|organization_memberships|org_id,actor_user_id|org_id,user_id',
  'campaign_record_links|campaigns|org_id,campaign_id|org_id,id',
  'campaign_record_links|organization_memberships|org_id,created_by|org_id,user_id',
  'campaign_record_links|organization_memberships|org_id,revoked_by|org_id,user_id',
  'campaign_workflow_dispatches|campaign_events|org_id,campaign_id,event_id|org_id,campaign_id,id',
  'campaign_workflow_dispatches|campaign_events|org_id,campaign_id,trigger_event_id|org_id,campaign_id,id',
  'campaign_workflow_dispatches|campaigns|org_id,campaign_id|org_id,id',
  'campaign_workflow_dispatches|workflow_instances|org_id,campaign_id,workflow_instance_id|org_id,campaign_id,id',
  'campaigns|opportunities|opportunity_id,customer_id|id,customer_id',
  'campaigns|organization_memberships|org_id,owner_user_id|org_id,user_id',
  'campaigns|team_memberships|org_id,team_id,owner_user_id|org_id,team_id,user_id',
  'request_idempotency|campaigns|org_id,campaign_id|org_id,id',
  'request_idempotency|campaigns|org_id,secondary_campaign_id|org_id,id',
  'request_idempotency|organization_memberships|org_id,user_id|org_id,user_id',
  'team_memberships|organization_memberships|org_id,user_id|org_id,user_id',
  'team_memberships|teams|org_id,team_id|org_id,id'
].sort(compareUtf8));

const KNOWLEDGE_FTS_MANIFEST = Object.freeze({
  fts: Object.freeze([Object.freeze({
    virtualName: 'knowledge_chunks_fts',
    projectionName: 'knowledge_chunks_v1',
    tokenizerOptions: 'unicode61',
    keyColumnCsv: 'entry_id,chunk_id',
    indexedColumnCsv: 'title,content,tags'
  })])
});

const SOURCE_IDENTITY_GOLDENS = Object.freeze([
  Object.freeze({
    id: 7,
    source_identity_sha256: '5ef2ea4713049f94cfa5078d44b1859ce67b26f36531468ebc3c0350b8ab5b87'
  }),
  Object.freeze({
    id: 8,
    source_identity_sha256: '8803bcd08efc90d2647c179b1ddde143a3ddfd98b6387e90514fa0082fae43f2'
  })
]);

function registeredMigrations() {
  return [CAMPAIGN_MIGRATION_DESCRIPTOR];
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function runCampaignMigrations(db) {
  return migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: registeredMigrations()
  });
}

function campaignMigrationOptions() {
  return {
    rootDir: SERVER_ROOT,
    registeredMigrations: registeredMigrations()
  };
}

function databaseDigest(db) {
  return sqliteDigest.databaseDigest(db, KNOWLEDGE_FTS_MANIFEST);
}

function namedSchemaObjects(db, type, names) {
  const expected = new Set(names);
  return db.prepare(`
    SELECT type,name,sql
    FROM sqlite_schema
    WHERE type=? AND sql IS NOT NULL
    ORDER BY CAST(name AS BLOB)
  `).all(type).filter((row) => expected.has(row.name));
}

function allManagedIndexTriggerObjects(db) {
  return db.prepare(`
    SELECT type,name,sql
    FROM sqlite_schema
    WHERE type IN ('index','trigger') AND sql IS NOT NULL
    ORDER BY CAST(type AS BLOB),CAST(name AS BLOB)
  `).all();
}

function schemaObjectSqlDigest(rows) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(rows), 'utf8')
    .digest('hex');
}

function assertNamedSchemaObjects(db, type, expectedNames, expectedCount, expectedSqlSha256) {
  const actual = namedSchemaObjects(db, type, expectedNames);
  assert.equal(expectedNames.length, expectedCount);
  assert.deepEqual(
    actual.map((row) => row.name),
    [...expectedNames],
    `002 must install the exact ${expectedNames.length} ${type} objects`
  );
  assert.equal(
    schemaObjectSqlDigest(actual),
    expectedSqlSha256,
    `002 ${type} SQL must match the independently frozen contract`
  );
  return actual;
}

function compositeForeignKeys(db) {
  const result = [];
  for (const tableName of EXPECTED_DOMAIN_TABLES) {
    const groups = new Map();
    for (const row of db.pragma(`foreign_key_list(${JSON.stringify(tableName)})`)) {
      if (!groups.has(row.id)) groups.set(row.id, []);
      groups.get(row.id).push(row);
    }
    for (const rows of groups.values()) {
      rows.sort((left, right) => left.seq - right.seq);
      if (rows.length < 2) continue;
      assert.ok(rows.every((row) => row.on_update === 'RESTRICT' && row.on_delete === 'RESTRICT'));
      result.push([
        tableName,
        rows[0].table,
        rows.map((row) => row.from).join(','),
        rows.map((row) => row.to).join(',')
      ].join('|'));
    }
  }
  return result.sort(compareUtf8);
}

function assertCampaignContract(db) {
  const tableRows = db.pragma('table_list')
    .filter((row) => row.schema === 'main' && EXPECTED_DOMAIN_TABLES.includes(row.name))
    .sort((left, right) => compareUtf8(left.name, right.name));
  assert.deepEqual(
    tableRows.map((row) => row.name),
    [...EXPECTED_DOMAIN_TABLES],
    '002 must create the exact nine domain tables'
  );
  for (const row of tableRows) {
    assert.equal(row.type, 'table', `${row.name} must be a stored table`);
    assert.equal(row.strict, 1, `${row.name} must be STRICT`);
  }

  const actualCompatibilityColumns = {};
  for (const [tableName, expectedColumns] of Object.entries(EXPECTED_COMPATIBILITY_COLUMNS)) {
    const available = new Set(db.pragma(`table_xinfo(${JSON.stringify(tableName)})`).map((column) => column.name));
    actualCompatibilityColumns[tableName] = expectedColumns.filter((column) => available.has(column));
  }
  assert.deepEqual(
    actualCompatibilityColumns,
    EXPECTED_COMPATIBILITY_COLUMNS,
    '002 must add all 23 compatibility columns'
  );

  const indexes = assertNamedSchemaObjects(
    db,
    'index',
    EXPECTED_INDEXES,
    campaignSchemaContract.indexCount,
    campaignSchemaContract.indexSqlSha256
  );
  const triggers = assertNamedSchemaObjects(
    db,
    'trigger',
    EXPECTED_TRIGGERS,
    campaignSchemaContract.triggerCount,
    campaignSchemaContract.triggerSqlSha256
  );
  assert.equal(
    schemaObjectSqlDigest([...indexes, ...triggers].sort((left, right) => (
      compareUtf8(`${left.type}:${left.name}`, `${right.type}:${right.name}`)
    ))),
    campaignSchemaContract.schemaObjectSqlSha256,
    '002 index and trigger SQL must match the independently frozen aggregate contract'
  );
  const allManagedObjects = allManagedIndexTriggerObjects(db);
  assert.equal(
    allManagedObjects.filter((row) => row.type === 'index').length,
    campaignSchemaContract.managedIndexCount,
    'managed schema must contain no undeclared explicit index'
  );
  assert.equal(
    allManagedObjects.filter((row) => row.type === 'trigger').length,
    campaignSchemaContract.managedTriggerCount,
    'managed schema must contain no undeclared trigger'
  );
  assert.equal(
    schemaObjectSqlDigest(allManagedObjects),
    campaignSchemaContract.managedIndexTriggerSqlSha256,
    'complete managed index and trigger SQL must match the independent contract'
  );
  assert.deepEqual(
    compositeForeignKeys(db),
    EXPECTED_COMPOSITE_FOREIGN_KEYS,
    '002 must install the exact 17 composite foreign-key contracts'
  );
}

function assertLegacyProjectionPreserved(db, fixture) {
  const intentionallyChanged = new Set([
    'activity_log',
    'schema_migrations',
    'sqlite_sequence'
  ]);
  for (const [tableName, expected] of Object.entries(fixture.snapshot.tables)) {
    if (intentionallyChanged.has(tableName)) continue;
    assert.deepEqual(
      captureTypedTable(db, tableName, expected.columns),
      expected,
      `${tableName} legacy columns and SQLite storage classes must be preserved`
    );
  }

  assert.deepEqual(
    db.prepare(`
      SELECT
        id,user_id,action,module,details,ip_address,created_at,
        typeof(id) AS id_type,typeof(user_id) AS user_id_type,
        typeof(details) AS details_type
      FROM activity_log
      WHERE id=151
    `).get(),
    {
      id: 151,
      user_id: 2,
      action: 'fixture_existing_activity',
      module: 'crm',
      details: '{"safe":"legacy-fixture"}',
      ip_address: '192.0.2.10',
      created_at: '2024-08-01 01:02:03',
      id_type: 'integer',
      user_id_type: 'integer',
      details_type: 'text'
    }
  );
  assert.deepEqual(
    captureFtsProjection(db),
    fixture.snapshot.ftsProjection,
    '002 must rebuild the same logical FTS projection'
  );

  for (const [tableName, floor] of Object.entries(fixture.sequenceFloors)) {
    const row = db.prepare(
      'SELECT seq,typeof(seq) AS seq_type FROM sqlite_sequence WHERE name=?'
    ).get(tableName);
    assert.ok(row, `sqlite_sequence must retain ${tableName}`);
    assert.equal(row.seq_type, 'integer');
    assert.ok(row.seq >= floor, `sqlite_sequence ${tableName} must not move backward`);
  }
}

function assertKnowledgeBackfill(db, fixture) {
  assert.deepEqual(
    db.prepare(`
      SELECT id,source_identity_sha256
      FROM knowledge_entries
      WHERE id IN (7,8)
      ORDER BY id
    `).all(),
    SOURCE_IDENTITY_GOLDENS
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_entries
      WHERE source_identity_sha256 IS NULL
         OR content_sha256 IS NULL
         OR length(source_identity_sha256)<>64
         OR length(content_sha256)<>64
         OR source_identity_sha256 GLOB '*[^0-9a-f]*'
         OR content_sha256 GLOB '*[^0-9a-f]*'
    `).get().count,
    0
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_chunks
      WHERE content_sha256 IS NULL
         OR length(content_sha256)<>64
         OR content_sha256 GLOB '*[^0-9a-f]*'
    `).get().count,
    0
  );
  for (const [term, expectedChunkIds] of Object.entries(fixture.ftsCanaries)) {
    assert.deepEqual(
      sqliteDigest.matchKnowledgeChunksCanary(db, term),
      expectedChunkIds,
      `FTS canary ${term} must resolve to its frozen chunk IDs`
    );
  }
  sqliteDigest.verifyKnowledgeChunksFtsCanaries(
    db,
    Object.keys(fixture.ftsCanaries)
  );
}

function mutationSnapshot(db) {
  return {
    schema: db.prepare(`
      SELECT type,name,tbl_name,sql
      FROM sqlite_schema
      ORDER BY CAST(type AS BLOB),CAST(name AS BLOB),CAST(tbl_name AS BLOB)
    `).all(),
    ledger: db.prepare(`
      SELECT version,name,checksum,source_path,engine_version,applied_at
      FROM schema_migrations
      ORDER BY version
    `).all(),
    sequences: db.prepare(`
      SELECT name,seq,typeof(seq) AS seq_type
      FROM sqlite_sequence
      ORDER BY CAST(name AS BLOB)
    `).all(),
    digest: databaseDigest(db)
  };
}

test('legacy populated fixture builds independently before campaign migration', () => {
  const db = new Database(':memory:');
  try {
    const fixture = buildLegacyPopulatedFixture(db);

    assert.deepEqual(
      migrationService.classifyDatabase(db, {
        rootDir: SERVER_ROOT,
        migrations: migrationService.defaultMigrations()
      }),
      { status: 'managed', currentVersion: 1 }
    );
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.ok(Object.keys(fixture.snapshot.tables).length > 0);
    assert.deepEqual(
      db.prepare(`
        SELECT id, typeof(source_id) AS source_id_type
        FROM knowledge_entries
        WHERE id IN (7, 8)
        ORDER BY id
      `).all(),
      [
        { id: 7, source_id_type: 'integer' },
        { id: 8, source_id_type: 'text' }
      ]
    );
  } finally {
    db.close();
  }
});

test('ledgerless populated v1-compatible database adopts 001 and upgrades through 002', () => {
  const db = new Database(':memory:');
  try {
    const fixture = buildLegacyPopulatedFixture(db);
    db.exec('DROP TABLE schema_migrations');

    assert.deepEqual(
      migrationService.classifyDatabase(db, campaignMigrationOptions()),
      { status: 'legacy', currentVersion: 0 }
    );
    assert.deepEqual(
      runCampaignMigrations(db),
      { status: 'managed', currentVersion: 2 }
    );
    assert.deepEqual(
      db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all(),
      [
        { version: 1, name: '001_legacy_compat_columns' },
        { version: 2, name: '002_campaign_business_spine' }
      ]
    );
    assertLegacyProjectionPreserved(db, fixture);
    assertCampaignContract(db);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('empty database reaches managed version 2 through the registered migration runner', () => {
  const db = new Database(':memory:');
  try {
    assert.deepEqual(
      runCampaignMigrations(db),
      { status: 'managed', currentVersion: 2 }
    );
    assertCampaignContract(db);
    assert.deepEqual(
      db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all(),
      [
        { version: 1, name: '001_legacy_compat_columns' },
        { version: 2, name: '002_campaign_business_spine' }
      ]
    );
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('populated legacy database upgrades through 002 and backfills every fixture user', () => {
  const db = new Database(':memory:');
  try {
    const fixture = buildLegacyPopulatedFixture(db);
    const beforeDigest = databaseDigest(db);

    assert.deepEqual(
      runCampaignMigrations(db),
      { status: 'managed', currentVersion: 2 }
    );
    assertCampaignContract(db);

    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM organizations WHERE code='turingmarket-default'").get().count,
      1
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_memberships').get().count, 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM team_memberships').get().count, 5);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM activity_log
        WHERE module='identity' AND action='identity_state_changed'
      `).get().count,
      5
    );
    assertLegacyProjectionPreserved(db, fixture);
    assertKnowledgeBackfill(db, fixture);
    assert.notDeepEqual(
      databaseDigest(db),
      beforeDigest,
      'the v1 and v2 database digests must not be conflated'
    );
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('file-backed managed-v1 upgrade is digest-stable across no-op rerun and reopen', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-campaign-v2-'));
  const dbPath = path.join(tempRoot, 'managed-v1.db');
  let db = new Database(dbPath);
  let fixture;
  let beforeDigest;
  try {
    fixture = buildLegacyPopulatedFixture(db);
    beforeDigest = databaseDigest(db);
    db.close();
    db = null;

    db = migrationService.openMigratedDatabase(dbPath, campaignMigrationOptions());
    const firstGreenDigest = databaseDigest(db);
    assert.notDeepEqual(firstGreenDigest, beforeDigest);
    assertCampaignContract(db);
    assertLegacyProjectionPreserved(db, fixture);
    assertKnowledgeBackfill(db, fixture);

    assert.deepEqual(
      runCampaignMigrations(db),
      { status: 'managed', currentVersion: 2 }
    );
    assert.deepEqual(
      databaseDigest(db),
      firstGreenDigest,
      'same-connection v2 rerun must be a logical no-op'
    );
    db.close();
    db = null;

    db = migrationService.openMigratedDatabase(dbPath, campaignMigrationOptions());
    assert.deepEqual(
      databaseDigest(db),
      firstGreenDigest,
      'close, reopen, and migration rerun must preserve the exact v2 digest'
    );
    assertCampaignContract(db);
    assertLegacyProjectionPreserved(db, fixture);
    assertKnowledgeBackfill(db, fixture);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    if (db && db.open) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('002 preflight failure rolls back schema, ledger, sequence, logical, and FTS state', () => {
  const db = new Database(':memory:');
  try {
    buildLegacyPopulatedFixture(db);
    db.prepare(`
      UPDATE knowledge_entries
      SET
        entry_type='campaign_review',
        source_type='campaign_review',
        source_id='1:1',
        business_type='campaign',
        business_id='1'
      WHERE id IN (9,10)
    `).run();
    const before = mutationSnapshot(db);

    assert.throws(
      () => runCampaignMigrations(db),
      /duplicate campaign review source/
    );
    assert.deepEqual(
      mutationSnapshot(db),
      before,
      'a rejected 002 migration must leave no schema or data mutation'
    );
    assert.deepEqual(
      migrationService.classifyDatabase(db, {
        rootDir: SERVER_ROOT,
        migrations: migrationService.defaultMigrations()
      }),
      { status: 'managed', currentVersion: 1 }
    );
  } finally {
    db.close();
  }
});

test('002 preflight rejects malformed legacy campaign review identity without mutation', () => {
  const db = new Database(':memory:');
  try {
    buildLegacyPopulatedFixture(db);
    db.prepare(`
      UPDATE knowledge_entries
      SET source_type='campaign_review',source_id='garbage'
      WHERE id=9
    `).run();
    const before = mutationSnapshot(db);

    assert.throws(
      () => runCampaignMigrations(db),
      /invalid legacy campaign review identity/
    );
    assert.deepEqual(
      mutationSnapshot(db),
      before,
      'malformed legacy campaign review rejection must be zero-mutation'
    );
    assert.deepEqual(
      migrationService.classifyDatabase(db, {
        rootDir: SERVER_ROOT,
        migrations: migrationService.defaultMigrations()
      }),
      { status: 'managed', currentVersion: 1 }
    );
  } finally {
    db.close();
  }
});

test('002 preserves nullable legacy entry_type while backfilling valid digests', () => {
  const db = new Database(':memory:');
  try {
    buildLegacyPopulatedFixture(db);
    db.prepare('UPDATE knowledge_entries SET entry_type=NULL WHERE id=7').run();

    assert.deepEqual(
      runCampaignMigrations(db),
      { status: 'managed', currentVersion: 2 }
    );
    assert.deepEqual(
      db.prepare(`
        SELECT
          entry_type,typeof(entry_type) AS entry_type_type,
          length(source_identity_sha256) AS source_digest_length,
          length(content_sha256) AS content_digest_length
        FROM knowledge_entries
        WHERE id=7
      `).get(),
      {
        entry_type: null,
        entry_type_type: 'null',
        source_digest_length: 64,
        content_digest_length: 64
      }
    );
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});
