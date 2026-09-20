'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');
const sanitizer = require('../scripts/sanitize_production_shape');
const sanitizationManifest = require('../scripts/sanitization_manifest.json');
const trustedGate = require('../scripts/trusted_production_source_gate');
const trustedManifest = require('../scripts/trusted_production_source_manifest.json');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const serverRoot = path.resolve(__dirname, '..');
const platformRoot = path.resolve(serverRoot, '..');
const migration025 = Object.freeze({
  version: 25,
  name: '025_ai_conversation_tenant_ownership',
  sourcePath: 'migrations/025_ai_conversation_tenant_ownership.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
});

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function powerShellArrayEntries(source, variableName) {
  const match = source.match(new RegExp(`\\$${variableName}\\s*=\\s*@\\((?<body>[\\s\\S]*?)\\r?\\n\\)`));
  assert.ok(match, `$${variableName} array must exist`);
  return new Set(Array.from(
    match.groups.body.matchAll(/"([^"\r\n]+)"/g),
    (entry) => entry[1].replace(/\\/g, '/')
  ));
}

function powerShellStringAssignment(source, variableName) {
  const match = source.match(new RegExp(`\\$${variableName}\\s*=\\s*"([0-9a-f]{64})"`));
  assert.ok(match, `$${variableName} SHA-256 assignment must exist`);
  return match[1];
}

function openV25Fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-v25-release-gate-'));
  const databasePath = path.join(root, 'source.db');
  const db = migrationService.openMigratedDatabase(databasePath, {
    rootDir: serverRoot,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS.filter((migration) => migration.version <= 25)
  });
  t.after(() => {
    try { if (db.open) db.close(); } catch (_error) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return db;
}

test('schema and sanitizer registries retain migration 025 before migration 026', () => {
  assert.deepEqual(migrationGate.REGISTERED_MIGRATIONS.find((migration) => migration.version === 25), migration025);
  assert.deepEqual(sanitizer.EXACT_PROFILE_MIGRATIONS.find((migration) => migration.version === 25), migration025);
  const dbSource = fs.readFileSync(path.join(serverRoot, 'db.js'), 'utf8');
  assert.match(dbSource, /version:\s*25,[\s\S]*name:\s*'025_ai_conversation_tenant_ownership'/);
});

test('v25 sanitizer profile pins AI conversation organization ownership', (t) => {
  const db = openV25Fixture(t);
  assert.ok(sanitizationManifest.exactProfiles.some((profile) => profile.schemaVersion === 25));
  const structuralPolicy = sanitizer._testing.structuralColumnPolicyForVersion(25);
  assert.deepEqual(structuralPolicy['ai_conversations.org_id'], {
    storage: 'integer',
    kind: 'integer'
  });
  const checksum = db.prepare('SELECT checksum FROM schema_migrations WHERE version=25').get().checksum;
  assert.equal(structuralPolicy['schema_migrations.checksum'].allowedValues.at(-1), checksum);

  const profile = sanitizer._testing.manifestProfileForVersion(sanitizationManifest, 25);
  const conversations = profile.objects.find((object) => object.name === 'ai_conversations');
  assert.deepEqual(conversations.columns.find((column) => column.name === 'org_id'), {
    name: 'org_id',
    declaredType: 'INTEGER',
    notnull: 0,
    pk: 0,
    hidden: 0,
    classification: 'structural',
    foreignKey: true
  });
  assert.equal(
    profile.semanticPolicies.structuralColumns.validatorVersion,
    'tm-structural-policy-v23-ai-conversation-tenant-ownership'
  );
  assert.doesNotThrow(() => sanitizer.validateManifest(sanitizationManifest, db));
});

test('trusted source manifest retains the exact v25 source inside the current contract', () => {
  const manifestPath = path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json');
  const loaded = trustedGate.loadTrustedManifest(manifestPath);
  assert.equal(loaded.migrationContract.targetVersion, 27);
  assert.ok(loaded.migrationContract.acceptedSourceVersions.includes(25));
  for (const requiredPath of [
    'server/migrations/025_ai_conversation_tenant_ownership.js',
    'server/services/ai_service.js',
    'server/services/knowledge_service.js'
  ]) {
    const entry = loaded.files.find((candidate) => candidate.path === requiredPath);
    assert.ok(entry, requiredPath);
    assert.equal(sha256File(path.join(platformRoot, ...requiredPath.split('/'))), entry.sha256);
  }
  for (const entry of loaded.files) {
    assert.equal(
      sha256File(path.join(platformRoot, ...entry.path.split('/'))),
      entry.sha256,
      entry.path
    );
  }
});

test('deploy inventory carries v25 implementation and exact focused tests', () => {
  const deploy = fs.readFileSync(path.join(repoRoot, 'platform', 'deploy_v8.ps1'), 'utf8');
  const files = powerShellArrayEntries(deploy, 'FILES');
  for (const requiredPath of [
    'server/migrations/025_ai_conversation_tenant_ownership.js',
    'server/tests/ai_conversation_tenant_ownership_migration.test.js',
    'server/tests/ai_conversation_tenant_runtime.test.js',
    'server/tests/ai_conversation_tenant_release_gate_inventory.test.js'
  ]) {
    assert.ok(files.has(requiredPath), requiredPath);
  }
  assert.match(
    deploy,
    /if \(Number\(version\) !== 27\) throw new Error\('Candidate migration target version mismatch'\)/
  );
  assert.match(
    deploy,
    /report\.get\('sourceVersion'\) not in \(1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27\)/
  );
  assert.equal(
    powerShellStringAssignment(deploy, 'EXPECTED_TRUSTED_SOURCE_GATE_SHA256'),
    sha256File(path.join(serverRoot, 'scripts', 'trusted_production_source_gate.js'))
  );
  assert.equal(
    powerShellStringAssignment(deploy, 'EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256'),
    sha256File(path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json'))
  );
  assert.equal(
    powerShellStringAssignment(deploy, 'EXPECTED_TRUSTED_MIGRATION_VERIFIER_SHA256'),
    sha256File(path.join(serverRoot, 'scripts', 'verify_campaign_migration_gate.js'))
  );
});

test('trusted manifest parser rejects a v25 contract that omits migration 025', (t) => {
  const document = structuredClone(trustedManifest);
  document.files = document.files.filter(
    (entry) => entry.path !== 'server/migrations/025_ai_conversation_tenant_ownership.js'
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-v25-trust-negative-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'trusted-v25-missing-025.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  assert.throws(() => trustedGate.loadTrustedManifest(manifestPath), /bundle inventory is not exact/i);
});
