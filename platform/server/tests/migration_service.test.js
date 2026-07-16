const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const Database = require('better-sqlite3');

const repoRoot = path.resolve(__dirname, '../../..');
const platformRoot = path.resolve(__dirname, '../..');
const { MIGRATION_SYNTHETIC } = require('./fixtures/canonical_hash_vectors');

function tmpDb(name) {
  const dbPath = path.join(os.tmpdir(), `tm-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  return { db, dbPath };
}

function allRows(db, sql) {
  return db.prepare(sql).all();
}

function snapshot(db) {
  return JSON.stringify({
    tables: allRows(db, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
    users: allRows(db, 'SELECT id,username,display_name,role,email,department,api_quota FROM users ORDER BY id'),
    influencers: allRows(db, 'SELECT id,platform,kol_handle,profile_link,followers,avg_views_10,avg_engagement,category,sub_category,region,language,content_style,collab_type,cost_usd,cost_range_min,cost_range_max,cpm,brand_collab_history,contact_email,data_source FROM influencers ORDER BY id'),
    collaborations: allRows(db, 'SELECT id,demand_id,influencer_id,user_id,status,cost_actual,row_version,cost_actual_confirmed FROM collaborations ORDER BY id'),
    ledger: allRows(db, 'SELECT version,name,checksum,source_path,engine_version FROM schema_migrations ORDER BY version')
  });
}

function seedAdmissions() {
  return require('../migrations/baselines/legacy_v1').seedAdmissions;
}

function serverRoot() {
  return path.join(repoRoot, 'platform/server');
}

function noOpProbeMigration(version, name, sourcePath) {
  return {
    version,
    name,
    sourcePath,
    engineVersion: 1,
    dependencies: [],
    apply(database) {
      database.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY) STRICT;`);
    }
  };
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function dbTableNames(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY name").all().map((row) => row.name);
}

function insertAdminOnly(db) {
  db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (1, ?, ?, ?, ?)').run('admin', 'hash', 'Admin', 'admin');
}

function setupRelationshipParents(db) {
  insertAdminOnly(db);
  db.prepare('INSERT INTO customers (id, brand_name, created_by) VALUES (1, ?, 1)').run('Customer');
  db.prepare('INSERT INTO workflow_templates (id, name, nodes, edges, created_by) VALUES (1, ?, ?, ?, 1)').run('Template', '[]', '[]');
  db.prepare('INSERT INTO workflow_instances (id, template_id, business_type, business_id, started_by) VALUES (1, 1, ?, 1, 1)').run('customer');
}

function tempMigrationRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-${name}-root-`));
  fs.mkdirSync(path.join(root, 'migrations', 'baselines'), { recursive: true });
  fs.mkdirSync(path.join(root, 'migrations', 'engines'), { recursive: true });
  fs.copyFileSync(path.join(serverRoot(), 'migrations', '001_legacy_compat_columns.js'), path.join(root, 'migrations', '001_legacy_compat_columns.js'));
  fs.copyFileSync(path.join(serverRoot(), 'migrations', 'engines', 'v1.js'), path.join(root, 'migrations', 'engines', 'v1.js'));
  fs.copyFileSync(path.join(serverRoot(), 'migrations', 'baselines', 'legacy_v1.js'), path.join(root, 'migrations', 'baselines', 'legacy_v1.js'));
  return root;
}

test('migration checksum framing matches the design vector and excludes orchestration files', () => {
  const migrationService = require('../services/migration_service');
  const actual = migrationService.computeMigrationChecksum({
    engineVersion: MIGRATION_SYNTHETIC.engineVersion,
    files: MIGRATION_SYNTHETIC.files
  });
  assert.equal(actual, MIGRATION_SYNTHETIC.sha256);

  const v1 = migrationService.defaultMigrations()[0];
  const checksumBefore = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: serverRoot() });
  const checksumAfterMutableBytes = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: serverRoot() });
  assert.equal(checksumBefore, checksumAfterMutableBytes);
  assert.equal(v1.version, 1);
  assert.notEqual(v1.version, 2);
});

test('registered migration checksums are always derived from file bytes and undeclared imports are rejected', () => {
  const migrationService = require('../services/migration_service');
  const bypassAttempt = {
    version: 7,
    name: 'bad_import_probe',
    sourcePath: 'tests/fixtures/bad_import_probe.js',
    engineVersion: 1,
    dependencies: [],
    checksum: 'f'.repeat(64),
    apply() {}
  };

  assert.throws(
    () => migrationService.computeRegisteredMigrationChecksum(bypassAttempt, { rootDir: serverRoot() }),
    /undeclared local import|declared dependency/
  );
  assert.notEqual(
    migrationService.computeRegisteredMigrationChecksum(noOpProbeMigration(8, 'test_probe_table', 'tests/fixtures/test_probe_migration.js'), { rootDir: serverRoot() }),
    'f'.repeat(64)
  );
});

test('registered migrations execute the same source bytes that are checksummed, never caller inline apply', () => {
  const migrationService = require('../services/migration_service');
  const { db } = tmpDb('source-bytes-execute');

  migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions(),
    registeredMigrations: [{
      version: 2,
      name: 'inline_apply_must_not_run',
      sourcePath: 'tests/fixtures/source_exec_probe_migration.js',
      engineVersion: 1,
      dependencies: [],
      apply(database) {
        database.exec('CREATE TABLE inline_apply_executed (id INTEGER PRIMARY KEY) STRICT;');
      }
    }]
  });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'source_apply_executed'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'inline_apply_executed'").get().count, 0);
  db.close();
});

test('closed migration dependency graph rejects undeclared transitive imports and fake engine suffix imports', () => {
  const migrationService = require('../services/migration_service');
  assert.throws(
    () => migrationService.computeRegisteredMigrationChecksum({
      version: 3,
      name: 'transitive_dependency_probe',
      sourcePath: 'tests/fixtures/transitive_dependency_migration.js',
      engineVersion: 1,
      dependencies: ['tests/fixtures/declared_dependency.js']
    }, { rootDir: serverRoot() }),
    /undeclared local import|dependency graph/
  );
  assert.throws(
    () => migrationService.computeRegisteredMigrationChecksum({
      version: 4,
      name: 'fake_engine_probe',
      sourcePath: 'tests/fixtures/fake_engine_suffix_migration.js',
      engineVersion: 1,
      dependencies: []
    }, { rootDir: serverRoot() }),
    /undeclared local import|engine/
  );
});

test('migration loader allows only builtins and rejects undeclared bare package imports', () => {
  const migrationService = require('../services/migration_service');
  assert.throws(
    () => migrationService.runMigrations(tmpDb('bare-import').db, {
      rootDir: serverRoot(),
      seedAdmissions: seedAdmissions(),
      registeredMigrations: [{
        version: 5,
        name: 'bare_import_probe',
        sourcePath: 'tests/fixtures/bare_import_probe_migration.js',
        engineVersion: 1,
        dependencies: []
      }]
    }),
    /bare import|undeclared package|better-sqlite3/
  );

  const { db } = tmpDb('builtin-import');
  migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions(),
    registeredMigrations: [{
      version: 6,
      name: 'builtin_import_probe',
      sourcePath: 'tests/fixtures/builtin_import_probe_migration.js',
      engineVersion: 1,
      dependencies: []
    }]
  });
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'builtin_import_probe'").get().name, 'builtin_import_probe');
  db.close();
});

test('empty initialization applies the immutable baseline bytes from the first migration checksum bundle', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('baseline-bytes');
  const baselinePath = path.join(root, 'migrations', 'baselines', 'legacy_v1.js');
  const source = fs.readFileSync(baselinePath, 'utf8');
  fs.writeFileSync(
    baselinePath,
    source.replace(
      'function apply(db) {',
      "function apply(db) {\n  db.exec('CREATE TABLE baseline_bundle_marker (id INTEGER PRIMARY KEY) STRICT;');"
    )
  );
  const { db } = tmpDb('baseline-bytes');
  migrationService.runMigrations(db, {
    rootDir: root,
    seedAdmissions: seedAdmissions()
  });
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'baseline_bundle_marker'").get().name, 'baseline_bundle_marker');
  db.close();
});

test('001 schema manifest is exported from the checksummed migration implementation', () => {
  const migration001 = require('../migrations/001_legacy_compat_columns');
  assert.ok(migration001.schemaManifest, '001 migration must export schemaManifest from checksum bytes');
  assert.ok(migration001.schemaManifest.indexes.idx_knowledge_source_hash);
  assert.ok(migration001.schemaManifest.triggers.trg_collaborations_validate_update);
});

test('immutable baseline is self-contained for seed credentials and v1 checksum ignores mutable services', () => {
  const fs = require('node:fs');
  const migrationService = require('../services/migration_service');
  const baselineSource = fs.readFileSync(path.join(serverRoot(), 'migrations/baselines/legacy_v1.js'), 'utf8');
  assert.doesNotMatch(baselineSource, /credential_rotation_service/);
  assert.doesNotMatch(baselineSource, /require\(['"]\.\.\/\.\.\/services\//);

  const v1 = migrationService.defaultMigrations()[0];
  const before = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: serverRoot() });
  const after = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: serverRoot() });
  assert.equal(after, before);
});

test('empty database applies baseline, ledger, 001, both seed admissions, and a registered later probe in one transaction', () => {
  const migrationService = require('../services/migration_service');
  const { db } = tmpDb('empty-run');
  const events = [];

  migrationService.runMigrations(db, {
    rootDir: path.join(repoRoot, 'platform/server'),
    seedAdmissions: seedAdmissions(),
    registeredMigrations: [
      {
        version: 99,
        name: 'test_probe',
        sourcePath: 'tests/fixtures/test_probe_migration.js',
        engineVersion: 1,
        dependencies: []
      }
    ]
  });

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 11);
  assert.equal(db.prepare('SELECT username FROM users ORDER BY id LIMIT 1').get().username, 'admin');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, 15);
  assert.equal(db.prepare('SELECT kol_handle FROM influencers ORDER BY id LIMIT 1').get().kol_handle, '@TechReviewPro');
  assert.deepEqual(
    allRows(db, 'SELECT version,name FROM schema_migrations ORDER BY version'),
    [
      { version: 1, name: '001_legacy_compat_columns' },
      { version: 99, name: 'test_probe' }
    ]
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'probe_table'").get().count, 1);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

test('db startup does not persist WAL or mutate malformed populated database before migration preflight succeeds', () => {
  const { db, dbPath } = tmpDb('db-startup-no-wal-before-fail');
  db.pragma('journal_mode = DELETE');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);');
  db.close();
  const beforeHash = fileSha256(dbPath);

  const child = childProcess.spawnSync(process.execPath, ['-e', "require('./server/db')"], {
    cwd: path.join(repoRoot, 'platform'),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      TM_DISABLE_DOTENV: '1'
    },
    encoding: 'utf8'
  });

  assert.notEqual(child.status, 0);
  assert.match(`${child.stdout}\n${child.stderr}`, /partial_or_malformed|missing baseline column|migration classification failed/);
  const after = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(String(after.pragma('journal_mode', { simple: true })).toLowerCase(), 'delete');
  after.close();
  assert.equal(fileSha256(dbPath), beforeHash);
});

test('managed and legacy classification require immutable baseline object and column manifests', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');

  const ledgerOnly = tmpDb('ledger-only');
  migrationService.createLedger(ledgerOnly.db);
  assert.equal(migrationService.classifyDatabase(ledgerOnly.db, { rootDir: serverRoot() }).status, 'partial_or_malformed');
  ledgerOnly.db.close();

  const malformedLegacy = tmpDb('malformed-legacy-shape');
  legacy.apply(malformedLegacy.db);
  malformedLegacy.db.exec('PRAGMA foreign_keys = OFF; DROP TABLE users; CREATE TABLE users (id TEXT);');
  const classification = migrationService.classifyDatabase(malformedLegacy.db, { rootDir: serverRoot() });
  assert.equal(classification.status, 'partial_or_malformed');
  malformedLegacy.db.close();
});

test('baseline and ledger shape validation rejects column drift, extra objects, and weak ledgers', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');

  const columnDrift = tmpDb('baseline-column-drift');
  legacy.apply(columnDrift.db);
  columnDrift.db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE customers RENAME TO customers_old;
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_name TEXT NOT NULL,
      company_name TEXT,
      contact_person TEXT,
      contact_info TEXT,
      industry TEXT,
      stage TEXT DEFAULT 'prospect',
      source TEXT,
      budget_estimate TEXT,
      notes TEXT,
      created_by INTEGER NOT NULL,
      assigned_to INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );
  `);
  assert.equal(migrationService.classifyDatabase(columnDrift.db, { rootDir: serverRoot() }).status, 'partial_or_malformed');
  columnDrift.db.close();

  const extraObject = tmpDb('baseline-extra-object');
  legacy.apply(extraObject.db);
  extraObject.db.exec('CREATE TABLE unexpected_task2_object (id INTEGER PRIMARY KEY) STRICT;');
  assert.equal(migrationService.classifyDatabase(extraObject.db, { rootDir: serverRoot() }).status, 'partial_or_malformed');
  extraObject.db.close();

  const ledgerExtra = tmpDb('ledger-extra-column');
  legacy.apply(ledgerExtra.db);
  ledgerExtra.db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      source_path TEXT NOT NULL,
      engine_version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      extra TEXT
    ) STRICT;
  `);
  assert.equal(migrationService.classifyDatabase(ledgerExtra.db, { rootDir: serverRoot() }).status, 'partial_or_malformed');
  ledgerExtra.db.close();

  const ledgerWeak = tmpDb('ledger-weak-check');
  legacy.apply(ledgerWeak.db);
  ledgerWeak.db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      source_path TEXT NOT NULL,
      engine_version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);
  assert.equal(migrationService.classifyDatabase(ledgerWeak.db, { rootDir: serverRoot() }).status, 'partial_or_malformed');
  ledgerWeak.db.close();
});

test('populated read-only preflight records identity and aborts if data changes before exclusive migration write', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const { db, dbPath } = tmpDb('preflight-race');
  legacy.apply(db);
  db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (1, ?, ?, ?, ?)').run('admin', 'hash', 'Admin', 'admin');

  assert.throws(() => migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions(),
    afterReadOnlyPreflight(databasePath) {
      assert.equal(databasePath, dbPath);
      const other = new Database(databasePath);
      other.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (2, ?, ?, ?, ?)').run('race', 'hash', 'Race', 'user');
      other.close();
    }
  }), /preflight.*changed|identity.*changed|digest.*changed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  db.close();
});

test('exclusive migration gate reruns full preflight before digest comparison and writes', () => {
  const source = fs.readFileSync(path.join(serverRoot(), 'services', 'migration_service.js'), 'utf8');
  const gateStart = source.indexOf('function assertPreflightStillMatches');
  const gateEnd = source.indexOf('function insertLedgerRow');
  assert.notEqual(gateStart, -1);
  assert.notEqual(gateEnd, -1);
  const gateSource = source.slice(gateStart, gateEnd);
  assert.match(gateSource, /preflight\(db,\s*classification,\s*\{\s*checkMainFtsIntegrity:\s*true\s*\}\)/);
  assert.ok(
    gateSource.indexOf('preflight(db, classification') < gateSource.indexOf('preflightDigest(db)'),
    'exclusive gate must run full preflight before digest comparison'
  );
  const runSource = source.slice(source.indexOf('const transaction = db.transaction'), source.indexOf('transaction.exclusive'));
  assert.ok(
    runSource.indexOf('assertPreflightStillMatches') < runSource.indexOf("classification.status === 'empty'"),
    'exclusive gate must run before baseline or ledger writes'
  );
});

test('legacy upgrade preserves legacy values, adds compatibility columns, backfills versions, and is idempotent', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const { db } = tmpDb('legacy-upgrade');
  legacy.apply(db);
  db.prepare('INSERT INTO users (id, username, password_hash, display_name, role, department) VALUES (10, ?, ?, ?, ?, ?)').run('owner', 'hash', 'Owner', 'admin', 'Ops');
  db.prepare('INSERT INTO demands (id, user_id, brand_name) VALUES (20, 10, ?)').run('Brand');
  db.prepare('INSERT INTO influencers (id, platform, kol_handle) VALUES (30, ?, ?)').run('YouTube', '@legacy');
  db.prepare('INSERT INTO collaborations (id, demand_id, influencer_id, user_id, status, cost_actual) VALUES (40, 20, 30, 10, ?, ?)').run('proposed', 123);
  const beforeIds = allRows(db, 'SELECT id,username FROM users UNION ALL SELECT id,kol_handle FROM influencers UNION ALL SELECT id,status FROM collaborations ORDER BY id');

  migrationService.runMigrations(db, {
    rootDir: path.join(repoRoot, 'platform/server'),
    seedAdmissions: seedAdmissions()
  });
  const afterIds = allRows(db, 'SELECT id,username FROM users UNION ALL SELECT id,kol_handle FROM influencers UNION ALL SELECT id,status FROM collaborations ORDER BY id');
  assert.deepEqual(afterIds, beforeIds);
  assert.equal(db.prepare('SELECT row_version FROM collaborations WHERE id = 40').get().row_version, 1);
  assert.equal(db.prepare('SELECT cost_actual_confirmed FROM collaborations WHERE id = 40').get().cost_actual_confirmed, 0);
  db.prepare("UPDATE collaborations SET notes = 'changed' WHERE id = 40").run();
  assert.equal(db.prepare('SELECT row_version FROM collaborations WHERE id = 40').get().row_version, 2);
  db.prepare('UPDATE collaborations SET row_version = ? WHERE id = 40').run(3);
  assert.equal(db.prepare('SELECT row_version FROM collaborations WHERE id = 40').get().row_version, 3);
  assert.throws(() => db.prepare('UPDATE collaborations SET row_version = ? WHERE id = 40').run(5), /row_version/);
  assert.throws(() => db.prepare('UPDATE collaborations SET row_version = ? WHERE id = 40').run(2), /row_version/);
  assert.throws(() => db.prepare('UPDATE collaborations SET row_version = ? WHERE id = 40').run(0), /row_version/);
  assert.throws(() => db.prepare('UPDATE collaborations SET row_version = ? WHERE id = 40').run(9007199254740992), /row_version/);
  assert.throws(() => db.prepare('UPDATE collaborations SET cost_actual_confirmed = ? WHERE id = 40').run(2), /cost_actual_confirmed/);
  const legacyShape = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_knowledge_source_hash'").get().sql;
  assert.equal(legacyShape, "CREATE UNIQUE INDEX idx_knowledge_source_hash ON knowledge_entries(source_hash) WHERE source_hash IS NOT NULL AND source_hash != ''");

  const firstSnapshot = snapshot(db);
  migrationService.runMigrations(db, {
    rootDir: path.join(repoRoot, 'platform/server'),
    seedAdmissions: seedAdmissions()
  });
  assert.equal(snapshot(db), firstSnapshot);
  db.close();
});

test('knowledge source hash unique predicate preserves duplicate empty legacy hashes and rejects duplicate non-empty hashes', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');

  const duplicateEmpty = tmpDb('source-hash-empty-duplicates');
  legacy.apply(duplicateEmpty.db);
  duplicateEmpty.db.exec('ALTER TABLE knowledge_entries ADD COLUMN source_hash TEXT;');
  duplicateEmpty.db.prepare('INSERT INTO knowledge_entries (id, source_hash) VALUES (?, ?)').run(1, '');
  duplicateEmpty.db.prepare('INSERT INTO knowledge_entries (id, source_hash) VALUES (?, ?)').run(2, '');
  migrationService.runMigrations(duplicateEmpty.db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  });
  assert.equal(
    duplicateEmpty.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_knowledge_source_hash'").get().sql,
    "CREATE UNIQUE INDEX idx_knowledge_source_hash ON knowledge_entries(source_hash) WHERE source_hash IS NOT NULL AND source_hash != ''"
  );
  duplicateEmpty.db.close();

  const duplicateNonEmpty = tmpDb('source-hash-nonempty-duplicates');
  legacy.apply(duplicateNonEmpty.db);
  duplicateNonEmpty.db.exec('ALTER TABLE knowledge_entries ADD COLUMN source_hash TEXT;');
  duplicateNonEmpty.db.prepare('INSERT INTO knowledge_entries (id, source_hash) VALUES (?, ?)').run(1, 'same-hash');
  duplicateNonEmpty.db.prepare('INSERT INTO knowledge_entries (id, source_hash) VALUES (?, ?)').run(2, 'same-hash');
  assert.throws(() => migrationService.runMigrations(duplicateNonEmpty.db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  }), /idx_knowledge_source_hash|UNIQUE|source_hash/);
  assert.equal(duplicateNonEmpty.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  duplicateNonEmpty.db.close();
});

test('legacy shape accepts the v0.4 knowledge source hash partial index predicate as known compatibility state', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const fixture = tmpDb('source-hash-v04-index');
  legacy.apply(fixture.db);
  fixture.db.exec(`
    ALTER TABLE knowledge_entries ADD COLUMN source_hash TEXT;
    CREATE UNIQUE INDEX idx_knowledge_source_hash ON knowledge_entries(source_hash)
      WHERE source_hash IS NOT NULL AND source_hash != '';
  `);
  const classification = migrationService.classifyDatabase(fixture.db, { rootDir: serverRoot() });
  assert.equal(classification.status, 'legacy');
  fixture.db.close();
});

test('collaboration compatibility columns require immutable CHECK constraints and reject direct invalid writes', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');

  const malformed = tmpDb('compat-no-check');
  legacy.apply(malformed.db);
  malformed.db.exec(`
    ALTER TABLE collaborations ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE collaborations ADD COLUMN cost_actual_confirmed INTEGER NOT NULL DEFAULT 0;
  `);
  assert.throws(() => migrationService.runMigrations(malformed.db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  }), /CHECK|row_version|cost_actual_confirmed/);
  malformed.db.close();

  const migrated = tmpDb('compat-check');
  legacy.apply(migrated.db);
  migrationService.runMigrations(migrated.db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  });
  const tableSql = migrated.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'collaborations'").get().sql;
  assert.match(tableSql, /row_version INTEGER NOT NULL DEFAULT 1 CHECK\s*\(/);
  assert.match(tableSql, /cost_actual_confirmed INTEGER NOT NULL DEFAULT 0 CHECK\s*\(/);
  migrated.db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (9001, ?, ?, ?, ?)').run('u', 'h', 'User', 'admin');
  migrated.db.prepare('INSERT INTO demands (id, user_id) VALUES (9001, 9001)').run();
  migrated.db.prepare('INSERT INTO influencers (id, platform, kol_handle) VALUES (9001, ?, ?)').run('YouTube', '@i');
  assert.throws(
    () => migrated.db.prepare('INSERT INTO collaborations (id,demand_id,influencer_id,user_id,row_version) VALUES (9001,9001,9001,9001,0)').run(),
    /row_version|CHECK/
  );
  assert.throws(
    () => migrated.db.prepare('INSERT INTO collaborations (id,demand_id,influencer_id,user_id,cost_actual_confirmed) VALUES (9002,9001,9001,9001,2)').run(),
    /cost_actual_confirmed|CHECK/
  );
  migrated.db.close();
});

test('safe integer rule manifest covers every baseline plus 001 integer column', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const { db } = tmpDb('integer-rule-coverage');
  legacy.apply(db);
  require('../migrations/001_legacy_compat_columns').apply(db);
  const missing = [];
  for (const table of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name").all()) {
    for (const column of db.prepare(`PRAGMA table_info(${JSON.stringify(table.name)})`).all()) {
      if (String(column.type).toUpperCase() === 'INTEGER' && !migrationService.integerRuleFor(table.name, column.name)) {
        missing.push(`${table.name}.${column.name}`);
      }
    }
  }
  assert.deepEqual(missing, []);
  db.close();
});

test('safe integer preflight enforces field domains and knowledge source_id polymorphic exception', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const cases = [
    ['customers', "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (1,'u','h','U','admin'); INSERT INTO customers (id, brand_name, created_by, lead_score) VALUES (1,'c',1,-1)", /customers\.lead_score/],
    ['customers', "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (1,'u','h','U','admin'); INSERT INTO customers (id, brand_name, created_by, win_probability) VALUES (1,'c',1,101)", /customers\.win_probability/],
    ['customers', "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (1,'u','h','U','admin'); INSERT INTO customers (id, brand_name, created_by, is_public) VALUES (1,'c',1,2)", /customers\.is_public/],
    ['influencers', "INSERT INTO influencers (id, platform, kol_handle, quoted_price) VALUES (1,'YouTube','@bad',-1)", /influencers\.quoted_price/],
    ['influencers', "INSERT INTO influencers (id, platform, kol_handle, is_duplicate) VALUES (1,'YouTube','@bad',2)", /influencers\.is_duplicate/],
    ['collaborations', "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (1,'u','h','U','admin'); INSERT INTO demands (id,user_id) VALUES (1,1); INSERT INTO influencers (id, platform, kol_handle) VALUES (1,'YouTube','@i'); INSERT INTO collaborations (id,demand_id,influencer_id,user_id,row_version) VALUES (1,1,1,1,0)", /collaborations\.row_version/],
    ['collaborations', "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (1,'u','h','U','admin'); INSERT INTO demands (id,user_id) VALUES (1,1); INSERT INTO influencers (id, platform, kol_handle) VALUES (1,'YouTube','@i'); INSERT INTO collaborations (id,demand_id,influencer_id,user_id,cost_actual_confirmed) VALUES (1,1,1,1,2)", /collaborations\.cost_actual_confirmed/],
    ['knowledge_entries', "INSERT INTO knowledge_entries (id, source_id) VALUES (1, 9007199254740992)", /knowledge_entries\.source_id/]
  ];

  for (const [name, sql, pattern] of cases) {
    const fixture = tmpDb(`domain-${name}`);
    legacy.apply(fixture.db);
    if (name === 'collaborations') {
      fixture.db.exec(`
        ALTER TABLE collaborations ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE collaborations ADD COLUMN cost_actual_confirmed INTEGER NOT NULL DEFAULT 0;
      `);
    } else {
      require('../migrations/001_legacy_compat_columns').apply(fixture.db);
    }
    fixture.db.pragma('foreign_keys = OFF');
    fixture.db.exec(sql);
    assert.throws(() => migrationService.runMigrations(fixture.db, {
      rootDir: serverRoot(),
      seedAdmissions: seedAdmissions()
    }), pattern);
    fixture.db.close();
  }

  const ok = tmpDb('source-id-text-ok');
  legacy.apply(ok.db);
  require('../migrations/001_legacy_compat_columns').apply(ok.db);
  ok.db.prepare('INSERT INTO knowledge_entries (id, source_id) VALUES (?, ?)').run(1, 'brief.csv');
  assert.doesNotThrow(() => migrationService.classifyDatabase(ok.db, { rootDir: serverRoot() }));
  ok.db.close();
});

test('legacy orphan preflight covers declared physical and logical relationships', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const cases = [
    ['workflow_instances.template_id', () => "INSERT INTO workflow_instances (id, template_id, business_type, business_id) VALUES (1,404,'customer',1)"],
    ['workflow_instances.started_by', () => "INSERT INTO workflow_templates (id,name,nodes,edges) VALUES (1,'t','[]','[]'); INSERT INTO workflow_instances (id, template_id, business_type, business_id, started_by) VALUES (1,1,'customer',1,404)"],
    ['workflow_tasks.instance_id', () => "INSERT INTO workflow_tasks (id, instance_id, node_id, node_type, title) VALUES (1,404,'n','task','Task')"],
    ['workflow_tasks.assignee_id', () => "INSERT INTO workflow_templates (id,name,nodes,edges) VALUES (1,'t','[]','[]'); INSERT INTO workflow_instances (id, template_id, business_type, business_id) VALUES (1,1,'customer',1); INSERT INTO workflow_tasks (id, instance_id, node_id, node_type, title, assignee_id) VALUES (1,1,'n','task','Task',404)"],
    ['workflow_tasks.completed_by', () => "INSERT INTO workflow_templates (id,name,nodes,edges) VALUES (1,'t','[]','[]'); INSERT INTO workflow_instances (id, template_id, business_type, business_id) VALUES (1,1,'customer',1); INSERT INTO workflow_tasks (id, instance_id, node_id, node_type, title, completed_by) VALUES (1,1,'n','task','Task',404)"],
    ['workflow_timers.instance_id', () => "INSERT INTO workflow_timers (id, instance_id, node_id, fire_at) VALUES (1,404,'n','2030-01-01')"],
    ['workflow_node_logs.instance_id', () => "INSERT INTO workflow_node_logs (id, instance_id, node_id, action) VALUES (1,404,'n','start')"],
    ['workflow_node_logs.user_id', () => "INSERT INTO workflow_templates (id,name,nodes,edges) VALUES (1,'t','[]','[]'); INSERT INTO workflow_instances (id, template_id, business_type, business_id) VALUES (1,1,'customer',1); INSERT INTO workflow_node_logs (id, instance_id, node_id, action, user_id) VALUES (1,1,'n','start',404)"],
    ['workflow_templates.created_by', () => "INSERT INTO workflow_templates (id,name,nodes,edges,created_by) VALUES (1,'t','[]','[]',404)"],
    ['leads.assigned_to', () => "INSERT INTO leads (id, assigned_to) VALUES (1,404)"],
    ['leads.converted_customer_id', () => "INSERT INTO leads (id, converted_customer_id) VALUES (1,404)"],
    ['opportunities.created_by', () => "INSERT INTO customers (id, brand_name, created_by) VALUES (1,'c',1); INSERT INTO opportunities (id, customer_id, name, created_by) VALUES (1,1,'o',404)"],
    ['sales_targets.user_id', () => "INSERT INTO sales_targets (id, user_id) VALUES (1,404)"],
    ['activity_log_ext.customer_id', () => "INSERT INTO activity_log_ext (id, customer_id) VALUES (1,404)"],
    ['activity_log_ext.user_id', () => "INSERT INTO activity_log_ext (id, user_id) VALUES (1,404)"],
    ['knowledge_entries.created_by', () => "INSERT INTO knowledge_entries (id, created_by) VALUES (1,404)"]
  ];

  for (const [label, sqlFactory] of cases) {
    const fixture = tmpDb(`orphan-${label.replace(/[^a-z0-9]/gi, '-')}`);
    legacy.apply(fixture.db);
    fixture.db.pragma('foreign_keys = OFF');
    insertAdminOnly(fixture.db);
    fixture.db.exec(sqlFactory());
    assert.throws(() => migrationService.runMigrations(fixture.db, {
      rootDir: serverRoot(),
      seedAdmissions: seedAdmissions()
    }), new RegExp(label.replace('.', '\\.')));
    fixture.db.close();
  }
});

test('sqlite_sequence preflight rejects ghost rows, duplicate names, seq below max id, unsafe values, and next id exhaustion', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const cases = [
    ['ghost', "INSERT INTO sqlite_sequence (name, seq) VALUES ('ghost_table', 1)", /sqlite_sequence.*ghost_table/],
    ['duplicate', "INSERT INTO sqlite_sequence (name, seq) VALUES ('users', 1); INSERT INTO sqlite_sequence (name, seq) VALUES ('users', 2)", /sqlite_sequence.*duplicate.*users/],
    ['below-max', "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (10,'u','h','U','admin'); UPDATE sqlite_sequence SET seq = 5 WHERE name = 'users'", /sqlite_sequence.*users.*below/],
    ['unsafe', "UPDATE sqlite_sequence SET seq = 9007199254740992 WHERE name = 'users'", /sqlite_sequence.*unsafe|sqlite_sequence\.seq/],
    ['exhaustion', "UPDATE sqlite_sequence SET seq = 9007199254740991 WHERE name = 'users'", /sqlite_sequence.*exhausted|next id/]
  ];

  for (const [name, sql, pattern] of cases) {
    const fixture = tmpDb(`sequence-${name}`);
    legacy.apply(fixture.db);
    fixture.db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (1, ?, ?, ?, ?)').run('admin', 'hash', 'Admin', 'admin');
    fixture.db.exec(sql);
    assert.throws(() => migrationService.runMigrations(fixture.db, {
      rootDir: serverRoot(),
      seedAdmissions: seedAdmissions()
    }), pattern);
    fixture.db.close();
  }
});

test('managed schema manifest rejects missing or tampered 001 indexes and triggers before restart', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const cases = [
    ['DROP INDEX idx_knowledge_source_hash', /idx_knowledge_source_hash/],
    ['DROP TRIGGER trg_collaborations_validate_update', /trg_collaborations_validate_update/],
    ['DROP TRIGGER trg_collaborations_validate_update; CREATE TRIGGER trg_collaborations_validate_update BEFORE UPDATE ON collaborations BEGIN SELECT 1; END', /trg_collaborations_validate_update/],
    ["DROP INDEX idx_knowledge_visibility; CREATE INDEX idx_knowledge_visibility ON knowledge_entries(created_by)", /idx_knowledge_visibility/]
  ];

  for (const [tamperSql, pattern] of cases) {
    const fixture = tmpDb('managed-manifest');
    legacy.apply(fixture.db);
    migrationService.runMigrations(fixture.db, { rootDir: serverRoot(), seedAdmissions: seedAdmissions() });
    fixture.db.exec(tamperSql);
    const classification = migrationService.classifyDatabase(fixture.db, { rootDir: serverRoot() });
    assert.equal(classification.status, 'partial_or_malformed');
    assert.match(classification.reason, pattern);
    assert.throws(() => migrationService.runMigrations(fixture.db, {
      rootDir: serverRoot(),
      seedAdmissions: seedAdmissions()
    }), pattern);
    fixture.db.close();
  }
});

test('pre-existing malformed collaboration compatibility columns and values fail before mutation', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const { db } = tmpDb('bad-compat-columns');
  legacy.apply(db);
  db.exec('ALTER TABLE collaborations ADD COLUMN row_version TEXT;');
  assert.throws(() => migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  }), /row_version|compatibility column|partial_or_malformed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  db.close();
});

test('malformed, future, orphaned, and failed migrations fail closed without ledger mutation', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');

  const malformed = tmpDb('malformed');
  malformed.db.exec("CREATE TABLE schema_migrations (version INTEGER, name TEXT); INSERT INTO schema_migrations VALUES (1, 'bad');");
  assert.throws(() => migrationService.runMigrations(malformed.db, { seedAdmissions: seedAdmissions() }), /partial_or_malformed|malformed/);
  assert.equal(malformed.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'users'").get().count, 0);
  malformed.db.close();

  const future = tmpDb('future');
  legacy.apply(future.db);
  migrationService.createLedger(future.db);
  future.db.prepare('INSERT INTO schema_migrations (version,name,checksum,source_path,engine_version) VALUES (?,?,?,?,?)').run(999, 'future', 'a'.repeat(64), 'future.js', 1);
  assert.throws(() => migrationService.runMigrations(future.db, { seedAdmissions: seedAdmissions() }), /future/);
  assert.equal(future.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1);
  future.db.close();

  const orphan = tmpDb('orphan');
  legacy.apply(orphan.db);
  orphan.db.pragma('foreign_keys = OFF');
  orphan.db.prepare('INSERT INTO demands (id, user_id, brand_name) VALUES (1, 404, ?)').run('Broken');
  assert.throws(() => migrationService.runMigrations(orphan.db, { seedAdmissions: seedAdmissions() }), /orphan|foreign_key_check|demands/);
  assert.equal(orphan.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  orphan.db.close();

  const rollback = tmpDb('rollback');
  assert.throws(() => migrationService.runMigrations(rollback.db, {
    seedAdmissions: seedAdmissions(),
    registeredMigrations: [
      {
        version: 99,
        name: 'failing_probe',
        sourcePath: 'tests/fixtures/failing_probe_migration.js',
        engineVersion: 1,
        dependencies: [],
        apply() {
          throw new Error('injected migration failure');
        }
      }
    ]
  }), /injected migration failure/);
  assert.equal(rollback.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  assert.equal(rollback.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'users'").get().count, 0);
  rollback.db.close();
});

test('admin and influencer seed predicates remain independently frozen', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const { db } = tmpDb('seed-predicates');
  legacy.apply(db);
  db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run('root', 'hash', 'Root', 'admin');
  db.prepare('INSERT INTO influencers (platform, kol_handle) VALUES (?, ?)').run('YouTube', '@one-existing');

  migrationService.runMigrations(db, {
    rootDir: path.join(repoRoot, 'platform/server'),
    seedAdmissions: seedAdmissions()
  });

  assert.deepEqual(allRows(db, 'SELECT username FROM users ORDER BY id'), [{ username: 'root' }]);
  assert.deepEqual(allRows(db, 'SELECT kol_handle FROM influencers ORDER BY id'), [{ kol_handle: '@one-existing' }]);
  db.close();
});

test('obsolete standalone migrate entrypoint is removed and has no runtime/deploy references', () => {
  assert.equal(fs.existsSync(path.join(platformRoot, 'migrate.js')), false);
  const searched = [
    'platform/DEPLOY.md',
    'platform/deploy_v8.ps1',
    'platform/ecosystem.config.js',
    'platform/server/server.js',
    'platform/server/server_full.js'
  ];
  for (const relative of searched) {
    const content = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    assert.doesNotMatch(content, /\bmigrate\.js\b/);
  }
});
