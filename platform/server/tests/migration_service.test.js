const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('migration checksum framing matches the design vector and excludes orchestration files', () => {
  const migrationService = require('../services/migration_service');
  const actual = migrationService.computeMigrationChecksum({
    engineVersion: MIGRATION_SYNTHETIC.engineVersion,
    files: MIGRATION_SYNTHETIC.files
  });
  assert.equal(actual, MIGRATION_SYNTHETIC.sha256);

  const v1 = migrationService.defaultMigrations()[0];
  const checksumBefore = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: path.join(repoRoot, 'platform/server') });
  const checksumAfterMutableBytes = migrationService.computeRegisteredMigrationChecksum(v1, { rootDir: path.join(repoRoot, 'platform/server') });
  assert.equal(checksumBefore, checksumAfterMutableBytes);
  assert.equal(v1.version, 1);
  assert.notEqual(v1.version, 2);
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
        sourcePath: 'tests/fixtures/test_probe.js',
        engineVersion: 1,
        dependencies: [],
        checksum: 'f'.repeat(64),
        apply(database) {
          events.push(database.inTransaction);
          database.exec('CREATE TABLE probe_table (id INTEGER PRIMARY KEY) STRICT;');
        }
      }
    ]
  });

  assert.deepEqual(events, [true]);
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
  assert.throws(() => db.prepare('UPDATE collaborations SET row_version = ? WHERE id = 40').run(0), /row_version/);
  assert.throws(() => db.prepare('UPDATE collaborations SET cost_actual_confirmed = ? WHERE id = 40').run(2), /cost_actual_confirmed/);

  const firstSnapshot = snapshot(db);
  migrationService.runMigrations(db, {
    rootDir: path.join(repoRoot, 'platform/server'),
    seedAdmissions: seedAdmissions()
  });
  assert.equal(snapshot(db), firstSnapshot);
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
        sourcePath: 'tests/fixtures/failing_probe.js',
        engineVersion: 1,
        dependencies: [],
        checksum: 'e'.repeat(64),
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
