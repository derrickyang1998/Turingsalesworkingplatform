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
const migration024Checksum = '1e8460c645399788f853168dfe80711e158c2e535fe34e765c8e209af1508d64';
const migration024Sha256 = 'd35ed2ec1785e36377e71267eb92b57dc191b50e4ab85ac2a286a610040fd1ef';
const migration024 = Object.freeze({
  version: 24,
  name: '024_knowledge_tenant_ownership',
  sourcePath: 'migrations/024_knowledge_tenant_ownership.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
});
const supportedSourceVersions = Object.freeze([
  1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  25, 26, 27, 28, 29
]);
const trustedKnowledgeRuntimeFiles = Object.freeze([
  'server/server.js',
  'server/services/ai_service.js',
  'server/services/rag_service.js',
  'server/services/business_knowledge_service.js',
  'server/services/influencer_workflow_service.js',
  'server/services/latest_ui_compat_service.js',
  'server/services/obsidian_ingest_service.js',
  'server/services/performance_content_analysis_service.js',
  'server/services/performance_manual_service.js'
]);

function writeManifest(t, document, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-v24-release-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, name);
  fs.writeFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function currentTrustedManifest() {
  return structuredClone(trustedManifest);
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

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function openV24Fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-v24-sanitizer-profile-'));
  const databasePath = path.join(root, 'source.db');
  const db = migrationService.openMigratedDatabase(databasePath, {
    rootDir: serverRoot,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS.filter((entry) => entry.version <= 24)
  });
  t.after(() => {
    try { if (db.open) db.close(); } catch (_error) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return db;
}

test('schema gate registries retain migration 024 and terminate at current migration 029', () => {
  assert.deepEqual(migrationGate.REGISTERED_MIGRATIONS.find((entry) => entry.version === 24), migration024);
  assert.deepEqual(sanitizer.EXACT_PROFILE_MIGRATIONS.find((entry) => entry.version === 24), migration024);
  assert.equal(migrationGate.REGISTERED_MIGRATIONS.at(-1).version, 29);
  assert.equal(sanitizer.EXACT_PROFILE_MIGRATIONS.at(-1).version, 29);
});

test('trusted source gate current contract retains the exact migration 024 source', (t) => {
  const document = currentTrustedManifest();
  const manifestPath = writeManifest(t, document, 'trusted-current.json');
  const loaded = trustedGate.loadTrustedManifest(manifestPath);

  assert.deepEqual(loaded.migrationContract, {
    acceptedSourceVersions: [...supportedSourceVersions],
    targetVersion: 29,
    runs: 2,
    deterministicAppendTables: ['activity_log']
  });
  assert.ok(loaded.files.some(
    (entry) => entry.path === 'server/migrations/024_knowledge_tenant_ownership.js'
  ));

  const missing024 = structuredClone(document);
  missing024.files = missing024.files.filter(
    (entry) => entry.path !== 'server/migrations/024_knowledge_tenant_ownership.js'
  );
  assert.throws(
    () => trustedGate.loadTrustedManifest(writeManifest(t, missing024, 'trusted-current-missing-024.json')),
    /bundle inventory is not exact/i
  );
});

test('final v24 sanitizer profile pins knowledge ownership and the migration 024 checksum', (t) => {
  const db = openV24Fixture(t);
  assert.equal(sanitizationManifest.exactProfiles.some((entry) => entry.schemaVersion === 24), true);

  const structuralPolicy = sanitizer._testing.structuralColumnPolicyForVersion(24);
  assert.deepEqual(structuralPolicy['knowledge_entries.org_id'], {
    storage: 'integer',
    kind: 'integer'
  });
  assert.equal(
    structuralPolicy['schema_migrations.checksum'].allowedValues.at(-1),
    migration024Checksum
  );

  const profile = sanitizer._testing.manifestProfileForVersion(sanitizationManifest, 24);
  const knowledgeEntries = profile.objects.find((object) => object.name === 'knowledge_entries');
  assert.deepEqual(knowledgeEntries.columns.find((column) => column.name === 'org_id'), {
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
    'tm-structural-policy-v22-knowledge-tenant-ownership'
  );
  assert.doesNotThrow(() => sanitizer.validateManifest(sanitizationManifest, db));
});

test('committed current trusted manifest still pins migration 024 source bytes exactly', () => {
  const manifestPath = path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json');
  const loaded = trustedGate.loadTrustedManifest(manifestPath);

  assert.equal(loaded.migrationContract.targetVersion, 29);
  assert.equal(loaded.migrationContract.acceptedSourceVersions.at(-1), 29);
  const migrationEntry = loaded.files.find(
    (entry) => entry.path === 'server/migrations/024_knowledge_tenant_ownership.js'
  );
  assert.equal(migrationEntry.sha256, migration024Sha256);
  const trustedPaths = new Set(loaded.files.map((entry) => entry.path));
  for (const runtimePath of trustedKnowledgeRuntimeFiles) {
    assert.ok(trustedPaths.has(runtimePath), runtimePath);
  }
  for (const entry of loaded.files) {
    assert.equal(
      sha256File(path.join(platformRoot, ...entry.path.split('/'))),
      entry.sha256,
      entry.path
    );
  }
});

test('deploy inventory carries migration 024 while gating candidate and no-op paths at current v29', () => {
  const deploy = fs.readFileSync(path.join(repoRoot, 'platform', 'deploy_v8.ps1'), 'utf8');
  const files = powerShellArrayEntries(deploy, 'FILES');

  assert.ok(files.has('server/migrations/024_knowledge_tenant_ownership.js'));
  assert.ok(files.has('server/tests/knowledge_tenant_ownership_migration.test.js'));
  assert.ok(files.has('server/tests/knowledge_tenant_release_gate_inventory.test.js'));
  assert.match(
    deploy,
    /if \(Number\(version\) !== 29\) throw new Error\('Candidate migration target version mismatch'\)/
  );
  assert.match(
    deploy,
    /report\.get\('sourceVersion'\) not in \(1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29\)/
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
