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
const VENDORED_BCRYPT_PATH = 'migrations/vendor/bcryptjs_v3_0_3.js';

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

function migrationDigestSnapshot(db) {
  const digest = require('../services/sqlite_digest_service');
  return digest.databaseDigest(db, {
    fts: [{
      virtualName: 'knowledge_chunks_fts',
      projectionName: 'knowledge_chunks_v1',
      tokenizerOptions: 'unicode61',
      keyColumnCsv: 'entry_id,chunk_id',
      indexedColumnCsv: 'title,content,tags'
    }]
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
    dependencies: [VENDORED_BCRYPT_PATH],
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

function rebuildCollaborationsWithoutForeignKeys(db) {
  const dependentObjects = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE tbl_name = 'collaborations'
      AND name != 'collaborations'
      AND sql IS NOT NULL
    ORDER BY type, name
  `).all();
  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE collaborations RENAME TO collaborations_with_fk;
    CREATE TABLE collaborations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      demand_id INTEGER,
      influencer_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT DEFAULT 'proposed',
      proposal_notes TEXT,
      cost_quoted INTEGER DEFAULT 0,
      cost_actual INTEGER DEFAULT 0,
      content_url TEXT,
      roi_data TEXT,
      timeline_start DATE,
      timeline_end DATE,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(row_version) = 'integer' AND row_version >= 1 AND row_version <= 9007199254740991),
      cost_actual_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(typeof(cost_actual_confirmed) = 'integer' AND cost_actual_confirmed IN (0,1))
    );
    INSERT INTO collaborations (
      id, demand_id, influencer_id, user_id, status, proposal_notes, cost_quoted, cost_actual,
      content_url, roi_data, timeline_start, timeline_end, notes, created_at, updated_at,
      row_version, cost_actual_confirmed
    )
    SELECT
      id, demand_id, influencer_id, user_id, status, proposal_notes, cost_quoted, cost_actual,
      content_url, roi_data, timeline_start, timeline_end, notes, created_at, updated_at,
      row_version, cost_actual_confirmed
    FROM collaborations_with_fk;
    DROP TABLE collaborations_with_fk;
  `);
  for (const object of dependentObjects) {
    db.exec(object.sql);
  }
  db.pragma('foreign_keys = ON');
}

function tempMigrationRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-${name}-root-`));
  fs.mkdirSync(path.join(root, 'migrations', 'baselines'), { recursive: true });
  fs.mkdirSync(path.join(root, 'migrations', 'engines'), { recursive: true });
  fs.mkdirSync(path.join(root, 'migrations', 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(serverRoot(), 'migrations', '001_legacy_compat_columns.js'), path.join(root, 'migrations', '001_legacy_compat_columns.js'));
  fs.copyFileSync(path.join(serverRoot(), 'migrations', 'engines', 'v1.js'), path.join(root, 'migrations', 'engines', 'v1.js'));
  fs.copyFileSync(path.join(serverRoot(), 'migrations', 'baselines', 'legacy_v1.js'), path.join(root, 'migrations', 'baselines', 'legacy_v1.js'));
  const repositoryVendor = path.join(serverRoot(), ...VENDORED_BCRYPT_PATH.split('/'));
  const installedVendor = path.join(serverRoot(), 'node_modules', 'bcryptjs', 'umd', 'index.js');
  fs.copyFileSync(fs.existsSync(repositoryVendor) ? repositoryVendor : installedVendor, path.join(root, ...VENDORED_BCRYPT_PATH.split('/')));
  return root;
}

function writeTempMigration(root, repoPath, source) {
  const absolute = path.join(root, ...repoPath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source, 'utf8');
}

function assertAsyncCapabilityRejected(probeName, applyBody) {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot(probeName);
  const sourcePath = `migrations/002_${probeName}.js`;
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: '${probeName}',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { ${probeName}: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    ${applyBody}
    db.exec('CREATE TABLE ${probeName} (id INTEGER PRIMARY KEY) STRICT;');
  }
};
`);
  const { db } = tmpDb(probeName);

  try {
    assert.throws(() => migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [{
        version: 2,
        name: probeName,
        sourcePath,
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
      }]
    }), /asynchronous|dynamic import|Atomics|fromAsync|WebAssembly|FinalizationRegistry|not allowed|capability/i);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ?`).get(probeName).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertTransactionEscapeRejected(probeName, applyBody) {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot(probeName);
  const sourcePath = `migrations/002_${probeName}.js`;
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: '${probeName}',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { ${probeName}: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    ${applyBody}
  }
};
`);
  const { db } = tmpDb(probeName);
  let migrationError = null;

  try {
    try {
      migrationService.runMigrations(db, {
        rootDir: root,
        registeredMigrations: [{
          version: 2,
          name: probeName,
          sourcePath,
          engineVersion: 1,
          dependencies: [VENDORED_BCRYPT_PATH]
        }]
      });
    } catch (error) {
      migrationError = error;
    }

    assert.ok(migrationError, 'transaction-control SQL must fail inside the migration transaction');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ?').get(probeName).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'users'").get().count, 0);
    assert.match(migrationError.message, /transaction|connection control|not allowed/i);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    dependencies: [VENDORED_BCRYPT_PATH],
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
      dependencies: [VENDORED_BCRYPT_PATH],
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
      dependencies: [VENDORED_BCRYPT_PATH, 'tests/fixtures/declared_dependency.js']
    }, { rootDir: serverRoot() }),
    /undeclared local import|dependency graph/
  );
  assert.throws(
    () => migrationService.computeRegisteredMigrationChecksum({
      version: 4,
      name: 'fake_engine_probe',
      sourcePath: 'tests/fixtures/fake_engine_suffix_migration.js',
      engineVersion: 1,
      dependencies: [VENDORED_BCRYPT_PATH]
    }, { rootDir: serverRoot() }),
    /undeclared local import|engine/
  );
});

test('migration loader allows only engine-approved builtins and rejects ambient package imports', () => {
  const migrationService = require('../services/migration_service');
  const previousGlobalRequire = global.require;
  global.require = require;
  try {
    assert.throws(
      () => migrationService.runMigrations(tmpDb('bare-import').db, {
        rootDir: serverRoot(),
        seedAdmissions: seedAdmissions(),
        registeredMigrations: [{
          version: 2,
          name: 'bare_import_probe',
          sourcePath: 'tests/fixtures/bare_import_probe_migration.js',
          engineVersion: 1,
          dependencies: [VENDORED_BCRYPT_PATH]
        }]
      }),
      /builtin import is not allowed|ambient global require|bare import|undeclared package|better-sqlite3|require is not a function/
    );
  } finally {
    if (previousGlobalRequire === undefined) delete global.require;
    else global.require = previousGlobalRequire;
  }

  const { db } = tmpDb('builtin-import');
  migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions(),
    registeredMigrations: [{
      version: 2,
      name: 'builtin_import_probe',
      sourcePath: 'tests/fixtures/builtin_import_probe_migration.js',
      engineVersion: 1,
      dependencies: [VENDORED_BCRYPT_PATH]
    }]
  });
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'builtin_import_probe'").get().name, 'builtin_import_probe');
  db.close();
});

test('engine-approved builtin facade cannot expose host constructors or package loading', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('builtin-constructor-escape');
  const sourcePath = 'migrations/002_builtin_constructor_escape.js';
  writeTempMigration(root, sourcePath, `
const crypto = require('crypto');
const hostProcess = crypto.randomInt.constructor('return process')();
const externalRequire = hostProcess.getBuiltinModule('node:module')
  .createRequire(hostProcess.cwd() + '/server/server.js');
const Database = externalRequire('better-sqlite3');
module.exports = {
  version: 2,
  name: 'builtin_constructor_escape',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { builtin_constructor_escape: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    if (!Database) throw new Error('external package did not load');
    db.exec('CREATE TABLE builtin_constructor_escape (id INTEGER PRIMARY KEY) STRICT;');
  }
};
`);
  const { db } = tmpDb('builtin-constructor-escape');

  try {
    assert.throws(() => migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [{
        version: 2,
        name: 'builtin_constructor_escape',
        sourcePath,
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
      }]
    }), /constructor|package|builtin|not allowed|undefined/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'builtin_constructor_escape'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration database facade cannot expose host constructors or package loading', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('database-constructor-escape');
  const sourcePath = 'migrations/002_database_constructor_escape.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'database_constructor_escape',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { database_constructor_escape: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    const hostProcess = db.constructor.constructor('return process')();
    const externalRequire = hostProcess.getBuiltinModule('node:module')
      .createRequire(hostProcess.cwd() + '/server/server.js');
    const Database = externalRequire('better-sqlite3');
    if (!Database) throw new Error('external package did not load');
    db.exec('CREATE TABLE database_constructor_escape (id INTEGER PRIMARY KEY) STRICT;');
  }
};
`);
  const { db } = tmpDb('database-constructor-escape');

  try {
    assert.throws(() => migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [{
        version: 2,
        name: 'database_constructor_escape',
        sourcePath,
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
      }]
    }), /constructor|package|database|not allowed|undefined/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'database_constructor_escape'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration database rows cannot expose host constructors or package loading', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('database-row-constructor-escape');
  const sourcePath = 'migrations/002_database_row_constructor_escape.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'database_row_constructor_escape',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { database_row_constructor_escape: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    const row = db.prepare('SELECT 1 AS value').get();
    const hostProcess = row.constructor.constructor('return process')();
    const externalRequire = hostProcess.getBuiltinModule('node:module')
      .createRequire(hostProcess.cwd() + '/server/server.js');
    const Database = externalRequire('better-sqlite3');
    if (!Database) throw new Error('external package did not load');
    db.exec('CREATE TABLE database_row_constructor_escape (id INTEGER PRIMARY KEY) STRICT;');
  }
};
`);
  const { db } = tmpDb('database-row-constructor-escape');

  try {
    assert.throws(() => migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [{
        version: 2,
        name: 'database_row_constructor_escape',
        sourcePath,
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
      }]
    }), /constructor|package|database|code generation|not allowed|undefined/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'database_row_constructor_escape'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('denied import errors cannot expose host constructors or package loading', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('import-error-constructor-escape');
  const sourcePath = 'migrations/002_import_error_constructor_escape.js';
  writeTempMigration(root, sourcePath, `
let importError;
try {
  require('better-sqlite3');
} catch (error) {
  importError = error;
}
const hostProcess = importError.constructor.constructor('return process')();
const externalRequire = hostProcess.getBuiltinModule('node:module')
  .createRequire(hostProcess.cwd() + '/server/server.js');
const Database = externalRequire('better-sqlite3');
module.exports = {
  version: 2,
  name: 'import_error_constructor_escape',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { import_error_constructor_escape: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    if (!Database) throw new Error('external package did not load');
    db.exec('CREATE TABLE import_error_constructor_escape (id INTEGER PRIMARY KEY) STRICT;');
  }
};
`);
  const { db } = tmpDb('import-error-constructor-escape');

  try {
    assert.throws(() => migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [{
        version: 2,
        name: 'import_error_constructor_escape',
        sourcePath,
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
      }]
    }), /constructor|package|import|code generation|not allowed|undefined/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'import_error_constructor_escape'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('database errors cannot expose host constructors or package loading', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('database-error-constructor-escape');
  const sourcePath = 'migrations/002_database_error_constructor_escape.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'database_error_constructor_escape',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { database_error_constructor_escape: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    let databaseError;
    try {
      db.prepare('SELECT FROM invalid_sql');
    } catch (error) {
      databaseError = error;
    }
    const hostProcess = databaseError.constructor.constructor('return process')();
    const externalRequire = hostProcess.getBuiltinModule('node:module')
      .createRequire(hostProcess.cwd() + '/server/server.js');
    const Database = externalRequire('better-sqlite3');
    if (!Database) throw new Error('external package did not load');
    db.exec('CREATE TABLE database_error_constructor_escape (id INTEGER PRIMARY KEY) STRICT;');
  }
};
`);
  const { db } = tmpDb('database-error-constructor-escape');

  try {
    assert.throws(() => migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [{
        version: 2,
        name: 'database_error_constructor_escape',
        sourcePath,
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
      }]
    }), /constructor|package|database|code generation|not allowed|undefined/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'database_error_constructor_escape'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy expected-schema replay never exposes a raw host database handle', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const root = tempMigrationRoot('legacy-expected-schema-facade');
  const baselinePath = path.join(root, 'migrations', 'baselines', 'legacy_v1.js');
  const escapeMarker = 'TM_LEGACY_EXPECTED_SCHEMA_RAW_DB_ESCAPE';
  const source = fs.readFileSync(baselinePath, 'utf8');
  fs.writeFileSync(baselinePath, source.replace(
    'function apply(db) {',
    `function apply(db) {
  if (db.constructor) {
    const hostProcess = db.constructor.constructor('return process')();
    hostProcess.env.${escapeMarker} = 'escaped';
  }`
  ), 'utf8');
  const { db } = tmpDb('legacy-expected-schema-facade');
  legacy.apply(db);
  delete process.env[escapeMarker];

  try {
    assert.equal(migrationService.classifyDatabase(db, { rootDir: root }).status, 'legacy');
    assert.equal(process.env[escapeMarker], undefined);
  } finally {
    delete process.env[escapeMarker];
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed expected-schema replay never exposes a raw host database handle', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('managed-expected-schema-facade');
  const sourcePath = 'migrations/002_managed_expected_schema_facade.js';
  const escapeMarker = 'TM_MANAGED_EXPECTED_SCHEMA_RAW_DB_ESCAPE';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'managed_expected_schema_facade',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { managed_expected_schema_facade: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    if (db.constructor) {
      const hostProcess = db.constructor.constructor('return process')();
      hostProcess.env.${escapeMarker} = 'escaped';
    }
    db.exec('CREATE TABLE managed_expected_schema_facade (id INTEGER PRIMARY KEY) STRICT;');
  }
};
`);
  const descriptor = {
    version: 2,
    name: 'managed_expected_schema_facade',
    sourcePath,
    engineVersion: 1,
    dependencies: [VENDORED_BCRYPT_PATH]
  };
  const { db } = tmpDb('managed-expected-schema-facade');
  delete process.env[escapeMarker];

  try {
    const classification = migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [descriptor]
    });
    assert.deepEqual(classification, { status: 'managed', currentVersion: 2 });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'managed_expected_schema_facade'").get().count, 1);
    assert.equal(process.env[escapeMarker], undefined);
  } finally {
    delete process.env[escapeMarker];
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  assert.doesNotMatch(baselineSource, /require\(['"]bcryptjs['"]\)/);

  const v1 = migrationService.defaultMigrations()[0];
  assert.ok(v1.dependencies.includes(VENDORED_BCRYPT_PATH));
  const before = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: serverRoot() });
  const after = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: serverRoot() });
  assert.equal(after, before);
});

test('v1 checksum changes when the vendored bcrypt implementation bytes change', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('bcrypt-checksum-closure');
  const vendorPath = path.join(root, ...VENDORED_BCRYPT_PATH.split('/'));
  const v1 = migrationService.defaultMigrations()[0];
  const before = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: root });
  fs.appendFileSync(vendorPath, '\n// checksum drift probe\n');
  const after = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: root });
  assert.notEqual(after, before);
});

test('caller-provided seed admissions cannot override checksum-bound baseline seeds', () => {
  const migrationService = require('../services/migration_service');
  const { db } = tmpDb('immutable-seed-admissions');
  let callerSeedRan = false;

  migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: {
      admin() {
        callerSeedRan = true;
      },
      influencers() {
        callerSeedRan = true;
      }
    }
  });

  assert.equal(callerSeedRan, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 11);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, 15);
  db.close();
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
        version: 2,
        name: 'test_probe',
        sourcePath: 'tests/fixtures/test_probe_migration.js',
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
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
      { version: 2, name: 'test_probe' }
    ]
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'probe_table'").get().count, 1);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();

  const reopened = new Database(db.name, { readonly: true, fileMustExist: true });
  const classification = migrationService.classifyDatabase(reopened, {
    rootDir: serverRoot(),
    migrations: [...migrationService.defaultMigrations(), {
      version: 2,
      name: 'test_probe',
      sourcePath: 'tests/fixtures/test_probe_migration.js',
      engineVersion: 1,
      dependencies: [VENDORED_BCRYPT_PATH]
    }]
  });
  assert.deepEqual(classification, { status: 'managed', currentVersion: 2 });
  reopened.close();
});

test('registered migrations must be a contiguous version sequence before any mutation', () => {
  const migrationService = require('../services/migration_service');
  const { db } = tmpDb('registered-version-gap');

  assert.throws(() => migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    registeredMigrations: [{
      version: 3,
      name: 'gap_probe',
      sourcePath: 'tests/fixtures/gap_probe_migration.js',
      engineVersion: 1,
      dependencies: [VENDORED_BCRYPT_PATH]
    }]
  }), /contiguous|gap|missing migration version 2/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'users'").get().count, 0);
  db.close();
});

test('final managed classification runs inside the exclusive transaction and rolls back invalid migration output', () => {
  const migrationService = require('../services/migration_service');
  const { db } = tmpDb('final-verification-rollback');

  assert.throws(() => migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    registeredMigrations: [{
      version: 2,
      name: 'final_verification_probe',
      sourcePath: 'tests/fixtures/final_verification_probe_migration.js',
      engineVersion: 1,
      dependencies: [VENDORED_BCRYPT_PATH]
    }]
  }), /required_value|final|managed|manifest|classification/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'users'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'final_verification_probe'").get().count, 0);
  db.close();
});

test('migration timers cannot schedule database work after the exclusive transaction returns', async () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('async-timer');
  const sourcePath = 'migrations/002_async_timer_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'async_timer_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: { columns: {}, indexes: {}, triggers: {} },
  apply(db) {
    setImmediate(() => {
      try {
        db.exec('CREATE TABLE async_escape_after_commit (id INTEGER PRIMARY KEY) STRICT;');
      } catch (_error) {
        // The RED implementation can outlive the test transaction; keep the probe deterministic.
      }
    });
  }
};
`);
  const { db } = tmpDb('async-timer');
  let migrationError = null;

  try {
    try {
      migrationService.runMigrations(db, {
        rootDir: root,
        registeredMigrations: [{
          version: 2,
          name: 'async_timer_probe',
          sourcePath,
          engineVersion: 1,
          dependencies: [VENDORED_BCRYPT_PATH]
        }]
      });
    } catch (error) {
      migrationError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.ok(migrationError, 'timer scheduling must fail synchronously inside the migration transaction');
    assert.match(migrationError.message, /asynchronous|timer|setImmediate|not allowed/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'async_escape_after_commit'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration apply rejects returned thenables and rolls back every write', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('async-thenable');
  const sourcePath = 'migrations/002_async_thenable_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'async_thenable_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { async_thenable_probe: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    db.exec('CREATE TABLE async_thenable_probe (id INTEGER PRIMARY KEY) STRICT;');
    return { then() {} };
  }
};
`);
  const { db } = tmpDb('async-thenable');

  try {
    assert.throws(() => migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [{
        version: 2,
        name: 'async_thenable_probe',
        sourcePath,
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
      }]
    }), /asynchronous|thenable|Promise|not allowed/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'async_thenable_probe'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration bundle rejects nested async syntax before it can capture the database', async () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('nested-async');
  const sourcePath = 'migrations/002_nested_async_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'nested_async_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: { columns: {}, indexes: {}, triggers: {} },
  apply(db) {
    (async () => {
      await 0;
      try {
        db.exec('CREATE TABLE nested_async_escape_after_commit (id INTEGER PRIMARY KEY) STRICT;');
      } catch (_error) {}
    })();
  }
};
`);
  const { db } = tmpDb('nested-async');
  let migrationError = null;

  try {
    try {
      migrationService.runMigrations(db, {
        rootDir: root,
        registeredMigrations: [{
          version: 2,
          name: 'nested_async_probe',
          sourcePath,
          engineVersion: 1,
          dependencies: [VENDORED_BCRYPT_PATH]
        }]
      });
    } catch (error) {
      migrationError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.ok(migrationError, 'async syntax must be rejected before migration execution');
    assert.match(migrationError.message, /async|await|asynchronous|not allowed/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'nested_async_escape_after_commit'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration bundle rejects dynamic import as a late microtask source', () => {
  assertAsyncCapabilityRejected(
    'dynamic_import_microtask_probe',
    "import('node:module').catch(() => {});"
  );
});

test('migration bundle rejects Atomics.waitAsync as a late microtask source', () => {
  assertAsyncCapabilityRejected(
    'atomics_wait_async_probe',
    "Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10).value.then(() => {});"
  );
});

test('migration bundle rejects Array.fromAsync as a late microtask source', () => {
  assertAsyncCapabilityRejected(
    'array_from_async_probe',
    'Array.fromAsync([1]).then(() => {});'
  );
});

test('migration bundle rejects AsyncDisposableStack as a late microtask source', () => {
  assertAsyncCapabilityRejected(
    'async_disposable_stack_probe',
    'const stack = new AsyncDisposableStack(); stack.disposeAsync();'
  );
});

test('migration VM hides intrinsic async capabilities from computed global access', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('computed_async_capability_probe');
  const sourcePath = 'migrations/002_computed_async_capability_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'computed_async_capability_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { computed_async_capability_probe: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    const globalNames = [
      'Ato' + 'mics',
      'SharedArray' + 'Buffer',
      'Web' + 'Assembly',
      'Finalization' + 'Registry',
      'Weak' + 'Ref',
      'Async' + 'DisposableStack'
    ];
    for (const name of globalNames) {
      if (globalThis[name] !== undefined) throw new Error('late capability remains visible: ' + name);
      if (delete globalThis[name]) throw new Error('late capability shadow is configurable: ' + name);
    }
    if (Array['from' + 'Async'] !== undefined) throw new Error('Array late factory remains visible');
    db.exec('CREATE TABLE computed_async_capability_probe (id INTEGER PRIMARY KEY) STRICT;');
  }
};
`);
  const descriptor = {
    version: 2,
    name: 'computed_async_capability_probe',
    sourcePath,
    engineVersion: 1,
    dependencies: [VENDORED_BCRYPT_PATH]
  };
  const { db } = tmpDb('computed-async-capability-probe');

  try {
    assert.deepEqual(migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [descriptor]
    }), { status: 'managed', currentVersion: 2 });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'computed_async_capability_probe'").get().count, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration db.exec cannot commit the outer migration transaction', () => {
  assertTransactionEscapeRejected(
    'exec_commit_escape_probe',
    "db.exec('CREATE TABLE exec_commit_escape_probe (id INTEGER PRIMARY KEY) STRICT; /* boundary */ COMMIT;'); throw new Error('after inner commit');"
  );
});

test('migration prepared statements cannot end the outer migration transaction', () => {
  assertTransactionEscapeRejected(
    'prepared_end_escape_probe',
    "db.exec('CREATE TABLE prepared_end_escape_probe (id INTEGER PRIMARY KEY) STRICT;'); db.prepare('/* boundary */ END TRANSACTION').run(); throw new Error('after prepared end');"
  );
});

test('migration db.exec cannot roll back and continue with autocommit writes', () => {
  assertTransactionEscapeRejected(
    'rollback_autocommit_escape_probe',
    "db.exec('CREATE TABLE before_rollback_escape_probe (id INTEGER PRIMARY KEY) STRICT; ROLLBACK; CREATE TABLE rollback_autocommit_escape_probe (id INTEGER PRIMARY KEY) STRICT;');"
  );
});

test('migration conflict rollback cannot be caught to continue with autocommit writes', () => {
  assertTransactionEscapeRejected(
    'conflict_rollback_escape_probe',
    `try {
      db.exec('CREATE TABLE rollback_conflict_guard (value INTEGER UNIQUE); INSERT INTO rollback_conflict_guard VALUES (1); INSERT OR ROLLBACK INTO rollback_conflict_guard VALUES (1);');
    } catch (_error) {}
    db.exec('CREATE TABLE conflict_rollback_escape_probe (id INTEGER PRIMARY KEY) STRICT;');
    throw new Error('transaction boundary probe finished');`
  );
});

test('migration database access is poisoned after SQLite implicitly rolls back the transaction', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('implicit-rollback-escape');
  const sourcePath = 'migrations/002_implicit_rollback_escape_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'implicit_rollback_escape_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { implicit_rollback_escape_probe: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    try {
      db.exec('INSERT INTO knowledge_entries(content) VALUES (hex(zeroblob(2000000)));');
    } catch (_error) {}
    db.exec('CREATE TABLE implicit_rollback_escape_probe (id INTEGER PRIMARY KEY) STRICT;');
    throw new Error('transaction boundary probe finished');
  }
};
`);
  const { db } = tmpDb('implicit-rollback-escape');
  let migrationError = null;

  try {
    migrationService.runMigrations(db, { rootDir: serverRoot() });
    const pageCount = db.pragma('page_count', { simple: true });
    db.pragma(`max_page_count = ${pageCount + 8}`);

    try {
      migrationService.runMigrations(db, {
        rootDir: root,
        registeredMigrations: [{
          version: 2,
          name: 'implicit_rollback_escape_probe',
          sourcePath,
          engineVersion: 1,
          dependencies: [VENDORED_BCRYPT_PATH]
        }]
      });
    } catch (error) {
      migrationError = error;
    }

    assert.ok(migrationError);
    assert.match(migrationError.message, /transaction|database.*lost|expired/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'implicit_rollback_escape_probe'").get().count, 0);
    assert.deepEqual(allRows(db, 'SELECT version,name FROM schema_migrations ORDER BY version'), [
      { version: 1, name: '001_legacy_compat_columns' }
    ]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration SQL cannot persist undigested connection PRAGMA state', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('pragma-state-escape');
  const sourcePath = 'migrations/002_pragma_state_escape_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'pragma_state_escape_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: {
      pragma_state_escape_probe: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        value: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    db.exec(\`
      PRAGMA ignore_check_constraints = ON;
      CREATE TABLE pragma_state_escape_probe (
        id INTEGER PRIMARY KEY,
        value INTEGER CHECK(value = 1)
      ) STRICT;
      INSERT INTO pragma_state_escape_probe(value) VALUES (2);
    \`);
  }
};
`);
  const { db } = tmpDb('pragma-state-escape');
  let migrationError = null;

  try {
    assert.equal(db.pragma('ignore_check_constraints', { simple: true }), 0);
    try {
      migrationService.runMigrations(db, {
        rootDir: root,
        registeredMigrations: [{
          version: 2,
          name: 'pragma_state_escape_probe',
          sourcePath,
          engineVersion: 1,
          dependencies: [VENDORED_BCRYPT_PATH]
        }]
      });
    } catch (error) {
      migrationError = error;
    }

    assert.ok(migrationError, 'mutable connection PRAGMA must fail the outer migration transaction');
    assert.match(migrationError.message, /PRAGMA|connection|not allowed/i);
    assert.equal(db.pragma('ignore_check_constraints', { simple: true }), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'pragma_state_escape_probe'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration SQL cannot create undigested SQLite planner statistics with ANALYZE', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('analyze-statistics-escape');
  const sourcePath = 'migrations/002_analyze_statistics_escape_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'analyze_statistics_escape_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: { columns: {}, indexes: {}, triggers: {} },
  apply(db) {
    db.exec("ANALYZE; UPDATE sqlite_stat1 SET stat = '999'");
  }
};
`);
  const { db } = tmpDb('analyze-statistics-escape');

  try {
    migrationService.runMigrations(db, { rootDir: serverRoot() });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'sqlite_stat1'").get().count, 0);

    assert.throws(() => migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [{
        version: 2,
        name: 'analyze_statistics_escape_probe',
        sourcePath,
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
      }]
    }), /ANALYZE|planner|statistics|not allowed/i);

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'sqlite_stat1'").get().count, 0);
    assert.deepEqual(allRows(db, 'SELECT version,name FROM schema_migrations ORDER BY version'), [
      { version: 1, name: '001_legacy_compat_columns' }
    ]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration SQL cannot mutate preexisting sqlite_stat tables through quoted identifiers', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('quoted-statistics-escape');
  const sourcePath = 'migrations/002_quoted_statistics_escape_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'quoted_statistics_escape_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: { columns: {}, indexes: {}, triggers: {} },
  apply(db) {
    const existing = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'sqlite_' || 'stat1'").get();
    if (existing) db.prepare("UPDATE 'sqlite_stat1' SET stat = '999'").run();
  }
};
`);
  const { db } = tmpDb('quoted-statistics-escape');

  try {
    migrationService.runMigrations(db, { rootDir: serverRoot() });
    db.exec('ANALYZE');
    const beforeStatistics = allRows(db, 'SELECT tbl,idx,stat FROM sqlite_stat1 ORDER BY tbl,idx');
    assert.ok(beforeStatistics.length > 0);

    assert.throws(() => migrationService.runMigrations(db, {
      rootDir: root,
      registeredMigrations: [{
        version: 2,
        name: 'quoted_statistics_escape_probe',
        sourcePath,
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH]
      }]
    }), /sqlite_stat|planner|statistics|not allowed/i);

    assert.deepEqual(allRows(db, 'SELECT tbl,idx,stat FROM sqlite_stat1 ORDER BY tbl,idx'), beforeStatistics);
    assert.deepEqual(allRows(db, 'SELECT version,name FROM schema_migrations ORDER BY version'), [
      { version: 1, name: '001_legacy_compat_columns' }
    ]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration SQL cannot retain an attached database after outer rollback', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('attach-database-escape');
  const sourcePath = 'migrations/002_attach_database_escape_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'attach_database_escape_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: { columns: {}, indexes: {}, triggers: {} },
  apply(db) {
    db.exec("ATTACH DATABASE ':memory:' AS attached_escape");
    throw new Error('after attach');
  }
};
`);
  const { db } = tmpDb('attach-database-escape');
  let migrationError = null;

  try {
    try {
      migrationService.runMigrations(db, {
        rootDir: root,
        registeredMigrations: [{
          version: 2,
          name: 'attach_database_escape_probe',
          sourcePath,
          engineVersion: 1,
          dependencies: [VENDORED_BCRYPT_PATH]
        }]
      });
    } catch (error) {
      migrationError = error;
    }

    assert.ok(migrationError);
    assert.equal(db.prepare('PRAGMA database_list').all().some((row) => row.name === 'attached_escape'), false);
    assert.match(migrationError.message, /transaction|connection control|not allowed/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expected-schema replay cannot write a host file with VACUUM INTO', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('vacuum-into-escape');
  const outputPath = path.join(root, 'vacuum-escape.db');
  const sqliteOutputPath = outputPath.replace(/\\/g, '/').replace(/'/g, "''");
  const sourcePath = 'migrations/002_vacuum_into_escape_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'vacuum_into_escape_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { vacuum_into_escape_probe: { id: { type: 'INTEGER', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    const main = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main');
    if (main && !main.file) db.exec("VACUUM INTO '${sqliteOutputPath}'");
    db.exec('CREATE TABLE vacuum_into_escape_probe (id INTEGER PRIMARY KEY) STRICT;');
  }
};
`);
  const { db } = tmpDb('vacuum-into-escape');
  let migrationError = null;

  try {
    try {
      migrationService.runMigrations(db, {
        rootDir: root,
        registeredMigrations: [{
          version: 2,
          name: 'vacuum_into_escape_probe',
          sourcePath,
          engineVersion: 1,
          dependencies: [VENDORED_BCRYPT_PATH]
        }]
      });
    } catch (error) {
      migrationError = error;
    }

    assert.ok(migrationError, 'VACUUM INTO must be rejected before expected-schema replay');
    assert.match(migrationError.message, /transaction|connection control|not allowed/i);
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'vacuum_into_escape_probe'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration TEMP trigger cannot survive a successful managed migration', () => {
  const migrationService = require('../services/migration_service');
  const root = tempMigrationRoot('temp-trigger-escape');
  const sourcePath = 'migrations/002_temp_trigger_escape_probe.js';
  writeTempMigration(root, sourcePath, `
module.exports = {
  version: 2,
  name: 'temp_trigger_escape_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: { columns: {}, indexes: {}, triggers: {} },
  apply(db) {
    db.exec(\`
      CREATE TEMP TRIGGER temp_users_insert_block
      BEFORE INSERT ON users
      BEGIN
        SELECT RAISE(ABORT, 'temporary trigger changed runtime behavior');
      END;
    \`);
  }
};
`);
  const { db } = tmpDb('temp-trigger-escape');
  let migrationError = null;

  try {
    try {
      migrationService.runMigrations(db, {
        rootDir: root,
        registeredMigrations: [{
          version: 2,
          name: 'temp_trigger_escape_probe',
          sourcePath,
          engineVersion: 1,
          dependencies: [VENDORED_BCRYPT_PATH]
        }]
      });
    } catch (error) {
      migrationError = error;
    }

    assert.ok(migrationError, 'temporary schema state must fail the outer migration transaction');
    assert.match(migrationError.message, /temporary|temp schema|not allowed/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_temp_schema WHERE name = 'temp_users_insert_block'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'users'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('runtime startup delegates path ownership to a read-only-first migration opener', () => {
  const migrationService = require('../services/migration_service');
  const dbSource = fs.readFileSync(path.join(serverRoot(), 'db.js'), 'utf8');
  assert.equal(typeof migrationService.openMigratedDatabase, 'function');
  assert.match(dbSource, /openMigratedDatabase\s*\(/);
  assert.doesNotMatch(dbSource, /new\s+Database\s*\(/);
  assert.doesNotMatch(dbSource, /migrations\/baselines\/legacy_v1/);
});

test('path-owning migration opener upgrades a closed legacy file and returns a managed connection', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const { db, dbPath } = tmpDb('path-owned-opener');
  legacy.apply(db);
  db.close();
  let readOnlyPreflightSeen = false;

  const opened = migrationService.openMigratedDatabase(dbPath, {
    rootDir: serverRoot(),
    afterReadOnlyPreflight(preflightPath, result) {
      readOnlyPreflightSeen = true;
      assert.equal(preflightPath, dbPath);
      assert.equal(result.classification.status, 'legacy');
    }
  });

  assert.equal(readOnlyPreflightSeen, true);
  assert.deepEqual(migrationService.classifyDatabase(opened, { rootDir: serverRoot() }), { status: 'managed', currentVersion: 1 });
  assert.equal(String(opened.pragma('journal_mode', { simple: true })).toLowerCase(), 'delete');
  opened.close();
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

test('populated baseline with an empty migration ledger fails closed without mutation or seeds', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const { db } = tmpDb('populated-empty-ledger');
  legacy.apply(db);
  migrationService.createLedger(db);

  const before = {
    users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    influencers: db.prepare('SELECT COUNT(*) AS count FROM influencers').get().count,
    ledger: db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
    collaborationColumns: db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('collaborations') WHERE name IN ('row_version', 'cost_actual_confirmed')").get().count
  };

  assert.equal(migrationService.classifyDatabase(db, { rootDir: serverRoot() }).status, 'partial_or_malformed');
  assert.throws(
    () => migrationService.runMigrations(db, { rootDir: serverRoot() }),
    /partial_or_malformed|empty migration ledger/
  );
  assert.deepEqual({
    users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    influencers: db.prepare('SELECT COUNT(*) AS count FROM influencers').get().count,
    ledger: db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
    collaborationColumns: db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('collaborations') WHERE name IN ('row_version', 'cost_actual_confirmed')").get().count
  }, before);
  db.close();
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

test('ledger DDL enforces version and name domain checks from the design contract', () => {
  const migrationService = require('../services/migration_service');
  const { db } = tmpDb('ledger-boundaries');
  migrationService.createLedger(db);

  const insert = db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, source_path, engine_version)
    VALUES (?, ?, ?, ?, ?)
  `);
  const checksum = 'a'.repeat(64);

  assert.throws(() => insert.run(0, 'zero_version', checksum, 'migrations/zero.js', 1), /CHECK|version/);
  assert.throws(() => insert.run(-1, 'negative_version', checksum, 'migrations/negative.js', 1), /CHECK|version/);
  assert.throws(() => insert.run(1, '   ', checksum, 'migrations/blank.js', 1), /CHECK|name/);
  assert.throws(() => insert.run(2, 'x'.repeat(121), checksum, 'migrations/long.js', 1), /CHECK|name/);

  insert.run(1, 'x', checksum, 'migrations/one.js', 1);
  insert.run(2, 'y'.repeat(120), checksum, 'migrations/two.js', 1);
  assert.deepEqual(
    allRows(db, 'SELECT version, length(name) AS name_length FROM schema_migrations ORDER BY version'),
    [{ version: 1, name_length: 1 }, { version: 2, name_length: 120 }]
  );
  db.close();
});

test('managed baseline metadata rejects collaborations foreign key removal before writes', () => {
  const migrationService = require('../services/migration_service');
  const { db } = tmpDb('managed-collaborations-no-fk');
  migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  });
  assert.equal(db.prepare('PRAGMA foreign_key_list(collaborations)').all().length, 3);

  rebuildCollaborationsWithoutForeignKeys(db);
  assert.equal(db.prepare('PRAGMA foreign_key_list(collaborations)').all().length, 0);
  const beforeSnapshot = snapshot(db);
  const beforeDigest = migrationDigestSnapshot(db);

  const classification = migrationService.classifyDatabase(db, { rootDir: serverRoot() });
  assert.equal(classification.status, 'partial_or_malformed');
  assert.match(classification.reason, /collaborations|foreign|schema|metadata/i);
  assert.throws(() => migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  }), /collaborations|foreign|schema|metadata|migration classification failed/i);
  assert.equal(snapshot(db), beforeSnapshot);
  assert.deepEqual(migrationDigestSnapshot(db), beforeDigest);
  db.close();
});

test('legacy baseline metadata rejects index drift in addition to column and object drift', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const { db } = tmpDb('legacy-index-drift');
  legacy.apply(db);
  db.exec('DROP INDEX idx_collaborations_demand; CREATE INDEX idx_collaborations_demand ON collaborations(user_id);');
  const classification = migrationService.classifyDatabase(db, { rootDir: serverRoot() });
  assert.equal(classification.status, 'partial_or_malformed');
  assert.match(classification.reason, /idx_collaborations_demand|index|schema/i);
  db.close();
});

test('v0.4 legacy compatibility indexes upgrade to the canonical 001 manifest', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const migration001 = require('../migrations/001_legacy_compat_columns');
  const { db } = tmpDb('v04-compat-indexes');
  legacy.apply(db);
  db.exec(`
    ALTER TABLE knowledge_entries ADD COLUMN title TEXT DEFAULT '';
    ALTER TABLE knowledge_entries ADD COLUMN summary TEXT DEFAULT '';
    ALTER TABLE knowledge_entries ADD COLUMN tags_json TEXT DEFAULT '[]';
    ALTER TABLE knowledge_entries ADD COLUMN visibility TEXT DEFAULT 'team';
    ALTER TABLE knowledge_entries ADD COLUMN source_hash TEXT;
    CREATE UNIQUE INDEX idx_knowledge_source_hash ON knowledge_entries(source_hash)
      WHERE source_hash IS NOT NULL AND source_hash != '';
    CREATE INDEX idx_knowledge_visibility ON knowledge_entries(visibility, created_by);
    CREATE INDEX idx_knowledge_source ON knowledge_entries(source_type, source_id);
    CREATE INDEX idx_ai_conversations_user ON ai_conversations(user_id, updated_at);
    CREATE INDEX idx_ai_messages_conversation ON ai_messages(conversation_id, created_at);
    CREATE INDEX idx_ai_references_message ON ai_references(message_id);
  `);
  insertAdminOnly(db);
  db.prepare('INSERT INTO influencers (id, platform, kol_handle) VALUES (1, ?, ?)').run('YouTube', '@existing');

  assert.equal(migrationService.classifyDatabase(db, { rootDir: serverRoot() }).status, 'legacy');
  migrationService.runMigrations(db, { rootDir: serverRoot() });
  assert.deepEqual(migrationService.classifyDatabase(db, { rootDir: serverRoot() }), { status: 'managed', currentVersion: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, 1);
  for (const [name, sql] of Object.entries(migration001.schemaManifest.indexes)) {
    assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name).sql, sql);
  }
  db.close();
});

test('FTS preflight rejects stored projection drift that leaves postings unchanged before writes', () => {
  const migrationService = require('../services/migration_service');
  const digest = require('../services/sqlite_digest_service');
  const { db } = tmpDb('fts-stored-projection-drift');
  migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  });
  db.prepare('INSERT INTO knowledge_entries (id, title, tags_json, created_by) VALUES (?, ?, ?, ?)').run(500, 'Alpha Guide', '["tag"]', 1);
  db.prepare('INSERT INTO knowledge_chunks (id, entry_id, chunk_index, content) VALUES (?, ?, ?, ?)').run(600, 500, 0, 'alpha beta content');
  digest.rebuildKnowledgeChunksFts(db);
  db.prepare('UPDATE knowledge_chunks_fts SET entry_id = ? WHERE chunk_id = ?').run(501, 600);
  const beforeSnapshot = snapshot(db);
  const beforeDigest = migrationDigestSnapshot(db);

  assert.throws(() => migrationService.runMigrations(db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  }), /FTS projection mismatch|migration classification failed/i);
  assert.equal(snapshot(db), beforeSnapshot);
  assert.deepEqual(migrationDigestSnapshot(db), beforeDigest);
  db.close();
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

test('known legacy compatibility column order remains valid when a later migration adds exact new objects', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const { db } = tmpDb('legacy-order-with-later-migration');
  legacy.apply(db);
  db.exec('ALTER TABLE knowledge_entries ADD COLUMN source_hash TEXT;');
  const probe = {
    version: 2,
    name: 'test_probe',
    sourcePath: 'tests/fixtures/test_probe_migration.js',
    engineVersion: 1,
    dependencies: [VENDORED_BCRYPT_PATH]
  };

  migrationService.runMigrations(db, { rootDir: serverRoot(), registeredMigrations: [probe] });
  assert.deepEqual(migrationService.classifyDatabase(db, {
    rootDir: serverRoot(),
    migrations: [...migrationService.defaultMigrations(), probe]
  }), { status: 'managed', currentVersion: 2 });
  db.close();
});

test('registered future migration columns never relax no-ledger legacy classification', () => {
  const migrationService = require('../services/migration_service');
  const legacy = require('../migrations/baselines/legacy_v1');
  const root = tempMigrationRoot('future-column-no-ledger');
  const sourcePath = 'migrations/002_future_column_probe.js';
  writeTempMigration(root, sourcePath, `
const engine = require('./engines/v1');
module.exports = {
  version: 2,
  name: 'future_column_probe',
  sourcePath: '${sourcePath}',
  engineVersion: 1,
  dependencies: ['${VENDORED_BCRYPT_PATH}'],
  schemaManifest: {
    columns: { users: { phase4_probe: { type: 'TEXT', notnull: 0, defaultValue: null } } },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    engine.addColumnIfMissing(db, 'users', 'phase4_probe TEXT');
  }
};
`);
  const { db } = tmpDb('future-column-no-ledger');
  legacy.apply(db);
  db.exec('ALTER TABLE users ADD COLUMN phase4_probe TEXT;');
  const options = {
    rootDir: root,
    registeredMigrations: [{
      version: 2,
      name: 'future_column_probe',
      sourcePath,
      engineVersion: 1,
      dependencies: [VENDORED_BCRYPT_PATH]
    }]
  };
  const classification = migrationService.classifyDatabase(db, {
    rootDir: root,
    migrations: [...migrationService.defaultMigrations(), options.registeredMigrations[0]]
  });
  let migrationError = null;

  try {
    migrationService.runMigrations(db, options);
  } catch (error) {
    migrationError = error;
  }

  assert.deepEqual({
    classification: classification.status,
    failed: Boolean(migrationError),
    users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    ledgerObjects: db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get().count
  }, {
    classification: 'partial_or_malformed',
    failed: true,
    users: 0,
    ledgerObjects: 0
  });
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
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

  const byteBoundaryOk = tmpDb('source-id-byte-boundary-ok');
  legacy.apply(byteBoundaryOk.db);
  byteBoundaryOk.db.prepare('INSERT INTO knowledge_entries (id, source_id) VALUES (?, ?)').run(1, `${'界'.repeat(1365)}a`);
  assert.doesNotThrow(() => migrationService.runMigrations(byteBoundaryOk.db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  }));
  byteBoundaryOk.db.close();

  const byteBoundaryBad = tmpDb('source-id-byte-boundary-bad');
  legacy.apply(byteBoundaryBad.db);
  byteBoundaryBad.db.prepare('INSERT INTO knowledge_entries (id, source_id) VALUES (?, ?)').run(1, `${'界'.repeat(1365)}ab`);
  assert.throws(() => migrationService.runMigrations(byteBoundaryBad.db, {
    rootDir: serverRoot(),
    seedAdmissions: seedAdmissions()
  }), /knowledge_entries\.source_id/);
  byteBoundaryBad.db.close();
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
        version: 2,
        name: 'failing_probe',
        sourcePath: 'tests/fixtures/failing_probe_migration.js',
        engineVersion: 1,
        dependencies: [VENDORED_BCRYPT_PATH],
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

test('production deploy inventory includes the checksum-bound bcrypt runtime', () => {
  const deploySource = fs.readFileSync(path.join(platformRoot, 'deploy_v8.ps1'), 'utf8');
  assert.match(deploySource, /server\\migrations\\vendor\\bcryptjs_v3_0_3\.js/);
});
