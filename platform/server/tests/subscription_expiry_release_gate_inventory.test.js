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

const migration028 = Object.freeze({
  version: 28,
  name: '028_subscription_expiry',
  sourcePath: 'migrations/028_subscription_expiry.js',
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

test('schema, sanitizer, and trusted source registries retain subscription expiry migration 028 through current migration 029', () => {
  assert.deepEqual(migrationGate.REGISTERED_MIGRATIONS.find((entry) => entry.version === 28), migration028);
  assert.deepEqual(sanitizer.EXACT_PROFILE_MIGRATIONS.find((entry) => entry.version === 28), migration028);
  assert.equal(migrationGate.REGISTERED_MIGRATIONS.at(-1).version, 29);
  assert.equal(sanitizer.EXACT_PROFILE_MIGRATIONS.at(-1).version, 29);
  assert.equal(sanitizationManifest.exactProfiles.at(-1).schemaVersion, 29);

  const manifestPath = path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json');
  const trusted = trustedGate.loadTrustedManifest(manifestPath);
  assert.equal(trusted.migrationContract.targetVersion, 29);
  assert.equal(trusted.migrationContract.acceptedSourceVersions.at(-1), 29);

  for (const requiredPath of [
    'server/migrations/028_subscription_expiry.js',
    'server/routes_subscription_expiry.js',
    'server/services/subscription_expiry_service.js',
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

test('current trusted candidate files are LF-normalized byte-for-byte', () => {
  const manifestPath = path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json');
  const trusted = trustedGate.loadTrustedManifest(manifestPath);
  for (const entry of trusted.files) {
    const bytes = fs.readFileSync(path.join(platformRoot, ...entry.path.split('/')));
    assert.equal(bytes.includes(13), false, `${entry.path} must contain LF bytes only`);
  }
});

test('deployment inventory retains the exact v28 implementation while targeting current v29', () => {
  const deploy = fs.readFileSync(path.join(repoRoot, 'platform', 'deploy_v8.ps1'), 'utf8');
  const phase4Integration = fs.readFileSync(
    path.join(serverRoot, 'tests', 'phase4_server_integration.test.js'),
    'utf8'
  );
  const files = powerShellArrayEntries(deploy, 'FILES');
  for (const requiredPath of [
    'server/migrations/028_subscription_expiry.js',
    'server/routes_subscription_expiry.js',
    'server/services/subscription_expiry_service.js',
    'server/tests/subscription_expiry_migration.test.js',
    'server/tests/subscription_expiry_service.test.js',
    'server/tests/subscription_expiry_routes.test.js',
    'server/tests/subscription_expiry_release_gate_inventory.test.js',
    'server/tests/influencer_workflow.test.js',
    'server/tests/phase4_server_integration.test.js',
    'server/tests/deployment-browser-smoke.spec.js',
    'server/tests/helpers/browser_fixture.js'
  ]) {
    assert.ok(files.has(requiredPath), requiredPath);
  }
  assert.match(
    deploy,
    /if \(Number\(version\) !== 29\) throw new Error\('Candidate migration target version mismatch'\)/
  );
  assert.match(
    deploy,
    /report\.get\('sourceVersion'\) not in \(1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29\)/
  );
  assert.match(deploy, /OFFLINE_LOOPBACK_TCP_OK/);
  assert.match(deploy, /OFFLINE_GATE_EFFECTIVE_PROPERTIES_OK/);
  assert.match(
    deploy,
    /node --test --test-reporter=dot --test-name-pattern="login and auth me"[\s\\]+server\/tests\/phase4_server_integration\.test\.js/
  );
  assert.match(
    phase4Integration,
    /test\('one live session observes subscription expiry and renewal without being revoked'/
  );
  assert.match(
    phase4Integration,
    /test\('authenticated requests report unavailable entitlement policy as 503 instead of invalid token'/
  );
  for (const requestPath of [
    '/api/opportunities',
    '/api/opportunities/1',
    '/api/customers/1/contacts',
    '/api/customers/1/contacts/1',
    '/api/customers/1/tasks',
    '/api/customers/1/tasks/1/complete',
    '/api/influencers',
    '/api/influencers/import',
    '/api/influencers/upload'
  ]) {
    assert.ok(phase4Integration.includes(`'${requestPath}'`), requestPath);
  }
  assert.match(phase4Integration, /reason_code, 'SUBSCRIPTION_EXPIRED'/);
  assert.match(phase4Integration, /response\.status, 503/);
  assert.match(phase4Integration, /reason_code, 'ENTITLEMENT_POLICY_UNAVAILABLE'/);
  assert.match(
    deploy,
    /--test-name-pattern="trusted source manifest pins the sanitizer closure\|[^"\r\n]+deploy pins trusted sanitizer closure"[\s\\]+server\/tests\/deployment_source_trust\.test\.js/
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
});
