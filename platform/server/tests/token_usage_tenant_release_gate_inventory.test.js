'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');
const sanitizer = require('../scripts/sanitize_production_shape');
const sanitizationManifest = require('../scripts/sanitization_manifest.json');
const trustedGate = require('../scripts/trusted_production_source_gate');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const serverRoot = path.resolve(__dirname, '..');
const platformRoot = path.resolve(serverRoot, '..');

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

test('schema, sanitizer, and trusted-source registries retain token usage migration 026 before 027', () => {
  const expected = {
    version: 26,
    name: '026_token_usage_tenant_ownership',
    sourcePath: 'migrations/026_token_usage_tenant_ownership.js',
    engineVersion: 1,
    dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
  };
  assert.deepEqual(migrationGate.REGISTERED_MIGRATIONS.find((migration) => migration.version === 26), expected);
  assert.deepEqual(sanitizer.EXACT_PROFILE_MIGRATIONS.find((migration) => migration.version === 26), expected);
  assert.ok(sanitizationManifest.exactProfiles.some((profile) => profile.schemaVersion === 26));
  assert.deepEqual(sanitizer._testing.structuralColumnPolicyForVersion(26)['token_usage.org_id'], {
    storage: 'integer',
    kind: 'integer'
  });

  const trusted = trustedGate.loadTrustedManifest(
    path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json')
  );
  assert.equal(trusted.migrationContract.targetVersion, 27);
  assert.equal(trusted.migrationContract.acceptedSourceVersions.at(-1), 27);
  for (const requiredPath of [
    'server/migrations/026_token_usage_tenant_ownership.js',
    'server/services/token_usage_service.js',
    'server/server.js',
    'server/services/ai_service.js'
  ]) {
    const entry = trusted.files.find((candidate) => candidate.path === requiredPath);
    assert.ok(entry, requiredPath);
    assert.equal(entry.sha256, sha256File(path.join(platformRoot, ...requiredPath.split('/'))));
  }
});

test('deployment inventory carries the exact v26 implementation and focused tests', () => {
  const deploy = fs.readFileSync(path.join(repoRoot, 'platform', 'deploy_v8.ps1'), 'utf8');
  const files = powerShellArrayEntries(deploy, 'FILES');
  for (const requiredPath of [
    'server/migrations/026_token_usage_tenant_ownership.js',
    'server/services/token_usage_service.js',
    'server/tests/token_usage_tenant_ownership_migration.test.js',
    'server/tests/token_usage_service.test.js',
    'server/tests/token_usage_tenant_release_gate_inventory.test.js'
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
});

test('runtime token writers are centralized and admin UI opts into audited global scope', () => {
  const runtimeFiles = [
    'server/server.js',
    'server/routes_brands.js',
    'server/services/ai_service.js',
    'server/services/latest_ui_compat_service.js'
  ];
  for (const relativePath of runtimeFiles) {
    const source = fs.readFileSync(path.join(platformRoot, ...relativePath.split('/')), 'utf8');
    assert.doesNotMatch(source, /INSERT\s+INTO\s+token_usage/i, relativePath);
  }
  const appSource = fs.readFileSync(path.join(platformRoot, 'app.js'), 'utf8');
  assert.match(appSource, /apiFetch\('\/token-usage\?admin_audit=global'\)/);
  assert.doesNotMatch(appSource, /apiFetch\('\/token-usage'\s*,\s*\{\s*method:\s*'POST'/);
  const serverSource = fs.readFileSync(path.join(platformRoot, 'server', 'server.js'), 'utf8');
  assert.match(serverSource, /TOKEN_USAGE_CLIENT_REPORTING_DISABLED/);
  assert.match(serverSource, /FROM token_usage WHERE org_id=\?/);
  assert.doesNotMatch(serverSource, /body\.prompt_tokens/);
  const migration = require('../migrations/026_token_usage_tenant_ownership');
  assert.equal(migration.version, 26);
  assert.ok(migration.schemaManifest.triggers.token_usage_no_replace_insert);
  assert.ok(migration.schemaManifest.triggers.token_usage_no_update);
  assert.ok(migration.schemaManifest.triggers.token_usage_no_delete);
  assert.equal(typeof migrationService.runMigrations, 'function');
});
