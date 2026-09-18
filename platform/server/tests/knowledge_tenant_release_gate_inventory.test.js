'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const migrationGate = require('../scripts/verify_campaign_migration_gate');
const sanitizer = require('../scripts/sanitize_production_shape');
const trustedGate = require('../scripts/trusted_production_source_gate');
const trustedManifest = require('../scripts/trusted_production_source_manifest.json');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const migration024 = Object.freeze({
  version: 24,
  name: '024_knowledge_tenant_ownership',
  sourcePath: 'migrations/024_knowledge_tenant_ownership.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
});
const supportedSourceVersions = Object.freeze([
  1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24
]);

function writeManifest(t, document, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-v24-release-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, name);
  fs.writeFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function v24TrustedManifest() {
  const document = structuredClone(trustedManifest);
  document.migrationContract.acceptedSourceVersions = [...supportedSourceVersions];
  document.migrationContract.targetVersion = 24;
  const predecessorIndex = document.files.findIndex(
    (entry) => entry.path === 'server/migrations/023_influencer_tenant_ownership.js'
  );
  assert.notEqual(predecessorIndex, -1, 'trusted manifest must retain migration 023');
  document.files.splice(predecessorIndex + 1, 0, {
    path: 'server/migrations/024_knowledge_tenant_ownership.js',
    sha256: '0'.repeat(64)
  });
  return document;
}

function powerShellArrayEntries(source, variableName) {
  const match = source.match(new RegExp(`\\$${variableName}\\s*=\\s*@\\((?<body>[\\s\\S]*?)\\r?\\n\\)`));
  assert.ok(match, `$${variableName} array must exist`);
  return new Set(Array.from(
    match.groups.body.matchAll(/"([^"\r\n]+)"/g),
    (entry) => entry[1].replace(/\\/g, '/')
  ));
}

test('schema gate registries end at migration 024 without embedding migration bytes', () => {
  assert.deepEqual(migrationGate.REGISTERED_MIGRATIONS.at(-1), migration024);
  assert.deepEqual(sanitizer.EXACT_PROFILE_MIGRATIONS.at(-1), migration024);
});

test('trusted source gate accepts only the exact v24 source contract with migration 024', (t) => {
  const document = v24TrustedManifest();
  const manifestPath = writeManifest(t, document, 'trusted-v24.json');
  const loaded = trustedGate.loadTrustedManifest(manifestPath);

  assert.deepEqual(loaded.migrationContract, {
    acceptedSourceVersions: [...supportedSourceVersions],
    targetVersion: 24,
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
    () => trustedGate.loadTrustedManifest(writeManifest(t, missing024, 'trusted-v24-missing-024.json')),
    /bundle inventory is not exact/i
  );
});

test('deploy inventory carries migration 024 and gates candidate and no-op paths at v24', () => {
  const deploy = fs.readFileSync(path.join(repoRoot, 'platform', 'deploy_v8.ps1'), 'utf8');
  const files = powerShellArrayEntries(deploy, 'FILES');

  assert.ok(files.has('server/migrations/024_knowledge_tenant_ownership.js'));
  assert.ok(files.has('server/tests/knowledge_tenant_ownership_migration.test.js'));
  assert.ok(files.has('server/tests/knowledge_tenant_release_gate_inventory.test.js'));
  assert.match(
    deploy,
    /if \(Number\(version\) !== 24\) throw new Error\('Candidate migration target version mismatch'\)/
  );
  assert.match(
    deploy,
    /report\.get\('sourceVersion'\) not in \(1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24\)/
  );
});
