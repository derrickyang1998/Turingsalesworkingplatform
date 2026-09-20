'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationGate = require('../scripts/verify_campaign_migration_gate');
const sanitizer = require('../scripts/sanitize_production_shape');
const sanitizationManifest = require('../scripts/sanitization_manifest.json');
const trustedGate = require('../scripts/trusted_production_source_gate');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const serverRoot = path.resolve(__dirname, '..');
const platformRoot = path.resolve(serverRoot, '..');

const migration027 = Object.freeze({
  version: 27,
  name: '027_plan_catalog_module_entitlements',
  sourcePath: 'migrations/027_plan_catalog_module_entitlements.js',
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

function powerShellShaAssignment(source, variableName) {
  const match = source.match(new RegExp(`\\$${variableName}\\s*=\\s*"([0-9a-f]{64})"`));
  assert.ok(match, `$${variableName} SHA-256 assignment must exist`);
  return match[1];
}

test('schema, sanitizer, and trusted source registries terminate at plan entitlement migration 027', () => {
  assert.deepEqual(migrationGate.REGISTERED_MIGRATIONS.at(-1), migration027);
  assert.deepEqual(sanitizer.EXACT_PROFILE_MIGRATIONS.at(-1), migration027);
  assert.equal(sanitizationManifest.exactProfiles.at(-1).schemaVersion, 27);

  const manifestPath = path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json');
  const trusted = trustedGate.loadTrustedManifest(manifestPath);
  assert.equal(trusted.migrationContract.targetVersion, 27);
  assert.equal(trusted.migrationContract.acceptedSourceVersions.at(-1), 27);

  for (const requiredPath of [
    'server/migrations/027_plan_catalog_module_entitlements.js',
    'server/routes_plan_entitlements.js',
    'server/services/plan_entitlement_service.js',
    'server/services/module_action_permission_service.js',
    'server/services/organization_governance_service.js',
    'server/server.js'
  ]) {
    assert.ok(trustedGate.REQUIRED_BUNDLE_FILES.includes(requiredPath), requiredPath);
    const entry = trusted.files.find((candidate) => candidate.path === requiredPath);
    assert.ok(entry, requiredPath);
    assert.equal(entry.sha256, sha256File(path.join(platformRoot, ...requiredPath.split('/'))));
  }
});

test('deployment inventory ships the exact v27 implementation and focused release tests', () => {
  const deploy = fs.readFileSync(path.join(repoRoot, 'platform', 'deploy_v8.ps1'), 'utf8');
  const files = powerShellArrayEntries(deploy, 'FILES');
  for (const requiredPath of [
    'server/migrations/027_plan_catalog_module_entitlements.js',
    'server/routes_plan_entitlements.js',
    'server/services/plan_entitlement_service.js',
    'server/tests/plan_entitlements_migration.test.js',
    'server/tests/plan_entitlement_service.test.js',
    'server/tests/plan_entitlement_routes.test.js',
    'server/tests/plan_entitlements_release_gate_inventory.test.js'
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

  const runtimeConfigPath = path.join(serverRoot, 'config', 'runtime_config.js');
  const runtimeConfigHash = sha256File(runtimeConfigPath);
  assert.equal(
    powerShellShaAssignment(deploy, 'EXPECTED_TRUSTED_RUNTIME_CONFIG_SHA256'),
    runtimeConfigHash
  );
  const trusted = trustedGate.loadTrustedManifest(
    path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json')
  );
  assert.equal(
    trusted.files.find((entry) => entry.path === 'server/config/runtime_config.js').sha256,
    runtimeConfigHash
  );

  const gitAttributes = fs.readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8');
  assert.match(
    gitAttributes,
    /^platform\/server\/\*\*\/\*\.js text eol=lf$/m,
    'all server JavaScript must have deterministic LF bytes for trusted-source hashing'
  );
});
