'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createFixture(t, name, targetVersion = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-migration-exactness-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, `source-v${targetVersion}.db`);
  const options = { rootDir: SERVER_ROOT };
  if (targetVersion === 6) options.registeredMigrations = migrationGate.REGISTERED_MIGRATIONS;
  const db = migrationService.openMigratedDatabase(databasePath, options);
  db.prepare('UPDATE users SET display_name=?,department=? WHERE id=(SELECT MIN(id) FROM users)')
    .run('synthetic-exactness-user', 'synthetic-exactness-department');
  db.prepare(`
    INSERT INTO brands (name,name_cn,amazon_rating,youtube_followers,creative_angles,created_at)
    VALUES ('synthetic-exactness-brand','synthetic-exactness-brand-cn',4.0,41,'synthetic-exactness-angle','2026-01-02 03:04:05')
  `).run();
  db.close();
  return { root, databasePath };
}

function captureV1Shape(t, name, setup) {
  const fixture = createFixture(t, name, 1);
  const db = new Database(fixture.databasePath);
  if (setup) setup(db);
  const snapshot = migrationGate._testing.captureLegacyLogicalShape(db);
  return { ...fixture, db, snapshot };
}

function rewriteSchemaSql(db, objectType, objectName, rewrite) {
  const row = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?').get(objectType, objectName);
  assert.ok(row && typeof row.sql === 'string', `${objectType} ${objectName} must have stored SQL`);
  const changed = rewrite(row.sql);
  assert.notEqual(changed, row.sql, 'test mutation must change stored SQL bytes');
  const schemaVersion = db.pragma('schema_version', { simple: true });
  db.unsafeMode(true);
  db.pragma('writable_schema = ON');
  try {
    db.prepare('UPDATE sqlite_schema SET sql=? WHERE type=? AND name=?').run(changed, objectType, objectName);
  } finally {
    db.pragma('writable_schema = OFF');
    db.unsafeMode(false);
  }
  db.pragma(`schema_version = ${schemaVersion + 1}`);
}

test('migration verifier rejects a sanitized source that is already at version 6', (t) => {
  const fixture = createFixture(t, 'reject-v6', 6);

  assert.throws(
    () => migrationGate.verifySanitizedMigrationCopy({
      sanitizedPath: fixture.databasePath,
      workDir: path.join(fixture.root, 'work')
    }),
    /source version.*exactly 1|pre-Phase-4.*version 1/i
  );
});

test('migration verifier accepts a populated sanitized version 1 source and reaches version 6', (t) => {
  const fixture = createFixture(t, 'v1-to-v6', 1);
  const sourceSha256 = sha256File(fixture.databasePath);

  const report = migrationGate.verifySanitizedMigrationCopy({
    sanitizedPath: fixture.databasePath,
    workDir: path.join(fixture.root, 'work')
  });

  assert.equal(report.sourceVersion, 1);
  assert.equal(report.targetVersion, 6);
  assert.equal(report.runs, 2);
  assert.equal(report.preMigrationRestoreVerified, true);
  assert.equal(report.legacyPreservationVerified, true);
  assert.equal(sha256File(fixture.databasePath), sourceSha256);
});

test('migration verifier preserves an existing activity_log allocator across deterministic migration appends', (t) => {
  const fixture = createFixture(t, 'activity-log-sequence', 1);
  const db = new Database(fixture.databasePath);
  db.prepare(`
    INSERT INTO activity_log (user_id,action,details,ip_address,created_at)
    VALUES ((SELECT MIN(id) FROM users),'synthetic-preexisting-audit','{}','127.0.0.1','2026-01-02 03:04:05')
  `).run();
  db.close();

  const report = migrationGate.verifySanitizedMigrationCopy({
    sanitizedPath: fixture.databasePath,
    workDir: path.join(fixture.root, 'work')
  });

  assert.equal(report.sourceVersion, 1);
  assert.equal(report.targetVersion, 6);
  assert.equal(report.legacyPreservationVerified, true);
});

const topologyMutationCases = [
  {
    name: 'view SQL',
    setup(db) {
      db.exec('CREATE VIEW legacy_brand_names AS SELECT id,name FROM brands');
    },
    mutate(db) {
      db.exec('DROP VIEW legacy_brand_names; CREATE VIEW legacy_brand_names AS SELECT id,name_cn AS name FROM brands');
    }
  },
  {
    name: 'index SQL and metadata',
    setup(db) {
      db.exec('CREATE INDEX legacy_brand_name_idx ON brands(name)');
    },
    mutate(db) {
      db.exec('DROP INDEX legacy_brand_name_idx; CREATE INDEX legacy_brand_name_idx ON brands(name DESC)');
    }
  },
  {
    name: 'trigger SQL',
    setup(db) {
      db.exec(`
        CREATE TRIGGER legacy_brand_update_probe
        AFTER UPDATE OF name ON brands
        BEGIN SELECT NEW.id; END
      `);
    },
    mutate(db) {
      db.exec(`
        DROP TRIGGER legacy_brand_update_probe;
        CREATE TRIGGER legacy_brand_update_probe
        AFTER UPDATE OF name ON brands
        BEGIN SELECT NEW.name; END
      `);
    }
  },
  {
    name: 'table SQL bytes',
    mutate(db) {
      rewriteSchemaSql(db, 'table', 'brands', (sql) => sql.replace(/\r?\n/, '\n\n'));
    }
  },
  {
    name: 'sqlite_sequence allocator row',
    mutate(db) {
      const result = db.prepare("UPDATE sqlite_sequence SET seq=seq+1 WHERE name='users'").run();
      assert.equal(result.changes, 1);
    }
  },
  {
    name: 'fixed pragma',
    mutate(db) {
      db.pragma('user_version = 73');
    }
  }
];

for (const scenario of topologyMutationCases) {
  test(`legacy preservation rejects ${scenario.name} mutation`, (t) => {
    const fixture = captureV1Shape(t, scenario.name.replaceAll(' ', '-'), scenario.setup);
    try {
      scenario.mutate(fixture.db);
      assert.throws(
        () => migrationGate._testing.assertLegacyLogicalShapePreserved(fixture.db, fixture.snapshot),
        /legacy preservation.*(?:topology|schema|view|index|trigger|table SQL|sequence|pragma|allocator)/i
      );
    } finally {
      fixture.db.close();
    }
  });
}

test('post-migration digest remains sensitive to migration-owned temporal evidence', (t) => {
  const fixture = createFixture(t, 'temporal-evidence', 1);
  const first = migrationGate.verifySanitizedMigrationCopy({
    sanitizedPath: fixture.databasePath,
    workDir: path.join(fixture.root, 'work-one'),
    frozenMigrationTimestamp: '2040-01-02 03:04:05'
  });
  const second = migrationGate.verifySanitizedMigrationCopy({
    sanitizedPath: fixture.databasePath,
    workDir: path.join(fixture.root, 'work-two'),
    frozenMigrationTimestamp: '2041-02-03 04:05:06'
  });

  assert.equal(first.postMigration.topologySha256, second.postMigration.topologySha256);
  assert.notEqual(first.postMigration.logicalSha256, second.postMigration.logicalSha256);
});

test('both migration runs reject a logically equivalent restoration with different source bytes', { concurrency: false }, (t) => {
  const fixture = createFixture(t, 'restore-bytes', 1);
  const originalCopyFileSync = fs.copyFileSync;
  let secondRestoreMutated = false;
  fs.copyFileSync = function copyFileSyncWithPhysicalMutation(source, destination, flags) {
    originalCopyFileSync.call(fs, source, destination, flags);
    if (path.basename(destination) !== 'migration-run-two-restored.db') return;
    const db = new Database(destination);
    try {
      db.exec('CREATE TABLE __tm_physical_layout_probe (id INTEGER PRIMARY KEY); DROP TABLE __tm_physical_layout_probe;');
    } finally {
      db.close();
    }
    secondRestoreMutated = true;
  };

  try {
    assert.throws(
      () => migrationGate.verifySanitizedMigrationCopy({
        sanitizedPath: fixture.databasePath,
        workDir: path.join(fixture.root, 'work')
      }),
      /restored.*byte|byte-identical|exact sanitized.*input/i
    );
  } finally {
    fs.copyFileSync = originalCopyFileSync;
  }
  assert.equal(secondRestoreMutated, true, 'the adversarial second restore must be exercised');
});
