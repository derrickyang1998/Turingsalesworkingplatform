'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createV1Fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-migration-preservation-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'sanitized-v1.db');
  const db = migrationService.openMigratedDatabase(databasePath, { rootDir: SERVER_ROOT });
  db.prepare('UPDATE users SET display_name=?,department=? WHERE id=(SELECT MIN(id) FROM users)')
    .run('synthetic-preservation-canary', 'synthetic-department');
  db.prepare(`
    INSERT INTO brands (name,name_cn,amazon_rating,youtube_followers,creative_angles,created_at)
    VALUES ('synthetic-preserved-brand','synthetic-preserved-brand-cn',3.5,73,'synthetic-angle',CURRENT_TIMESTAMP)
  `).run();
  db.close();
  return { root, databasePath };
}

test('populated migration gate proves legacy preservation before migration and after a clean restored rerun', (t) => {
  const fixture = createV1Fixture(t, 'two-run');
  const sourceSha256 = sha256File(fixture.databasePath);
  const workDir = path.join(fixture.root, 'gate-work');

  const report = migrationGate.verifySanitizedMigrationCopy({
    sanitizedPath: fixture.databasePath,
    workDir
  });

  assert.equal(report.format, 'tm-campaign-migration-preservation-v1');
  assert.equal(report.runs, 2);
  assert.equal(report.sourceVersion, 1);
  assert.equal(report.targetVersion, 6);
  assert.ok(report.legacyTableCount > 20);
  assert.ok(report.legacyRowCount > 0);
  for (const stage of [report.preMigration, report.postMigration]) {
    assert.match(stage.topologySha256, /^[0-9a-f]{64}$/);
    assert.match(stage.logicalSha256, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(stage.fts));
  }
  assert.equal(report.preMigrationRestoreVerified, true);
  assert.equal(report.legacyPreservationVerified, true);
  assert.equal(sha256File(fixture.databasePath), sourceSha256, 'the clean sanitized source must remain byte-identical');
  assert.equal(JSON.stringify(report).includes('synthetic-preservation-canary'), false);
});

test('legacy logical-shape verification catches value and storage drift without emitting values', (t) => {
  const fixture = createV1Fixture(t, 'mutation');
  const db = migrationService.openMigratedDatabase(fixture.databasePath, { rootDir: SERVER_ROOT });
  const snapshot = migrationGate._testing.captureLegacyLogicalShape(db);
  const forbiddenValue = 'must-never-appear-in-gate-diagnostics';
  db.prepare('UPDATE users SET display_name=? WHERE id=(SELECT MIN(id) FROM users)').run(forbiddenValue);

  assert.throws(
    () => migrationGate._testing.assertLegacyLogicalShapePreserved(db, snapshot),
    (error) => {
      assert.match(error.message, /legacy preservation.*(?:users.*row|row.*users)/i);
      assert.equal(error.message.includes(forbiddenValue), false);
      return true;
    }
  );
  db.close();
});

test('legacy logical-shape verification fails closed on original column and relationship drift', (t) => {
  const fixture = createV1Fixture(t, 'schema-drift');
  const db = migrationService.openMigratedDatabase(fixture.databasePath, { rootDir: SERVER_ROOT });
  const snapshot = migrationGate._testing.captureLegacyLogicalShape(db);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE demands_replacement AS SELECT * FROM demands;
    DROP TABLE demands;
    ALTER TABLE demands_replacement RENAME TO demands;
  `);

  assert.throws(
    () => migrationGate._testing.assertLegacyLogicalShapePreserved(db, snapshot),
    /legacy preservation.*(column|primary key|relationship|schema)/i
  );
  db.close();
});
