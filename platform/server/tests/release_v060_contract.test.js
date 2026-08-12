'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const releaseBranch = 'codex/v0.6.0-crm-sales-workspace';
const releaseSlug = 'v060-crm-sales-workspace';
const appBuild = '20260811-v060-crm-sales-workspace';
const appQuery = '20260811v060crmsalesworkspace';
const currentUiManifestPath = path.join(
  repoRoot, 'docs', 'baselines', 'v0.6.0', 'ui-runtime-manifest.json'
);
const frozenUiManifestPath = path.join(
  repoRoot, 'docs', 'baselines', 'v0.2.9', 'ui-ppt-manifest.json'
);

function read(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

function powerShellArrayEntries(source, variableName) {
  const match = source.match(new RegExp(`\\$${variableName}\\s*=\\s*@\\((?<body>[\\s\\S]*?)\\r?\\n\\)`));
  assert.ok(match, `$${variableName} array must exist`);
  return new Set(Array.from(
    match.groups.body.matchAll(/"([^"\r\n]+)"/g),
    (entry) => entry[1].replace(/\\/g, '/')
  ));
}

test('v0.6 release locks branch, build identity, release slug, and frozen PPT identity', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const buildInfo = read('platform', 'client', 'shared', 'build_info.js');
  const index = read('platform', 'index.html');

  assert.ok(deploy.includes(`$EXPECTED_BRANCH = "${releaseBranch}"`));
  assert.ok(deploy.includes(`$EXPECTED_APP_BUILD = "${appBuild}"`));
  assert.ok(deploy.includes(`$EXPECTED_APP_QUERY = "${appQuery}"`));
  assert.ok(deploy.includes(`backups/${releaseSlug}-$stamp`));
  assert.ok(deploy.includes(`$releaseDir = "${releaseSlug}-$stamp"`));
  assert.match(deploy, /TestRoot="\$ReleaseRoot\/tmp\/deploy-v060-gate-__STAMP__"/);
  assert.doesNotMatch(deploy, /deploy-v0(?:40|50)-gate/);
  assert.match(buildInfo, new RegExp(`app:\\s*["']${appBuild}["']`));
  assert.match(index, new RegExp(`app\\.js\\?v=${appQuery}`));
  assert.match(index, new RegExp(`client/styles/tokens\\.css\\?v=${appQuery}`));
  assert.match(deploy, /20260702-v916-kb-bridge-client-cn/);
  assert.match(deploy, /20260702v916kbbridge/);
  assert.match(deploy, /f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e/);
  assert.match(deploy, /if \(Number\(version\) !== 6\) throw new Error\('Candidate migration target version mismatch'\)/);
  assert.doesNotMatch(deploy, /if \(Number\(version\) !== 5\) throw new Error\('Candidate migration target version mismatch'\)/);
});

test('v0.6 deploy inventory ships migration 006, CRM runtime, and every Phase 5 regression', () => {
  const files = powerShellArrayEntries(read('platform', 'deploy_v8.ps1'), 'FILES');
  for (const required of [
    'server/migrations/006_crm_sales_workspace.js',
    'server/services/crm_contract.js',
    'server/services/crm_customer_service.js',
    'server/services/crm_query_service.js',
    'server/services/crm_scope_service.js',
    'server/tests/crm_contract.test.js',
    'server/tests/crm_customer_service.test.js',
    'server/tests/crm_phase5_http.test.js',
    'server/tests/crm_phase5_migration.test.js',
    'server/tests/crm_s6_ui.test.js',
    'server/tests/crm_scope_query.test.js',
    'server/tests/customer_mutation_ui.test.js',
    'server/tests/organization_access_context.test.js',
    'server/tests/release_v060_contract.test.js'
  ]) {
    assert.equal(files.has(required), true, `${required} must ship in v0.6`);
  }
});

test('v0.6 trusted source and sanitization contracts are exact v1-to-v6', () => {
  const trustedManifest = JSON.parse(read(
    'platform', 'server', 'scripts', 'trusted_production_source_manifest.json'
  ));
  const sanitizationManifest = JSON.parse(read(
    'platform', 'server', 'scripts', 'sanitization_manifest.json'
  ));
  const trustedPaths = new Set(trustedManifest.files.map((entry) => entry.path));

  assert.deepEqual(trustedManifest.migrationContract, {
    sourceVersion: 1,
    targetVersion: 6,
    runs: 2,
    deterministicAppendTables: ['activity_log']
  });
  assert.deepEqual(
    sanitizationManifest.exactProfiles.map((profile) => profile.schemaVersion),
    [6]
  );
  for (const required of [
    'server/migrations/006_crm_sales_workspace.js',
    'server/services/crm_contract.js',
    'server/services/crm_customer_service.js',
    'server/services/crm_query_service.js',
    'server/services/crm_scope_service.js'
  ]) {
    assert.equal(trustedPaths.has(required), true, `${required} must be checksum-pinned`);
  }
});

test('v0.6 trusted bytes have exact LF rules and release records exist', () => {
  const attributes = new Set(read('.gitattributes').split(/\r?\n/).filter(Boolean));
  for (const required of [
    'platform/ppt.js',
    'platform/server/migrations/006_crm_sales_workspace.js',
    'platform/server/services/crm_contract.js',
    'platform/server/services/crm_customer_service.js',
    'platform/server/services/crm_query_service.js',
    'platform/server/services/crm_scope_service.js'
  ]) {
    assert.equal(attributes.has(`${required} text eol=lf`), true, `${required} must be LF-pinned`);
  }
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'docs', 'version-records', '2026-08-11-v0.6.0-crm-sales-workspace.md')),
    true
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'archive', 'versions', '2026-08-11-v0.6.0-crm-sales-workspace.md')),
    true
  );
  assert.match(read('CHANGELOG.md'), /v0\.6\.0-crm-sales-workspace/);
});

test('v0.6 candidate inventory ships both root-level release records', () => {
  const rootFiles = powerShellArrayEntries(read('platform', 'deploy_v8.ps1'), 'ROOT_RELATIVE_FILES');
  for (const required of [
    'docs/version-records/2026-08-11-v0.6.0-crm-sales-workspace.md',
    'archive/versions/2026-08-11-v0.6.0-crm-sales-workspace.md'
  ]) {
    assert.equal(rootFiles.has(required), true, `${required} must ship with the isolated v0.6 candidate`);
  }
});

test('v0.6 ships a current runtime UI manifest while the frozen v0.2.9 evidence remains referenced', () => {
  assert.equal(fs.existsSync(currentUiManifestPath), true, 'current v0.6 UI runtime manifest must exist');
  const manifest = JSON.parse(fs.readFileSync(currentUiManifestPath, 'utf8'));
  const frozenBytes = fs.readFileSync(frozenUiManifestPath);
  const files = powerShellArrayEntries(read('platform', 'deploy_v8.ps1'), 'CANDIDATE_ONLY_FILES');

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.release, 'v0.6.0-crm-sales-workspace');
  assert.equal(manifest.buildMarkers.app, appBuild);
  assert.equal(manifest.scriptCacheKeys.app, appQuery);
  assert.equal(manifest.routeCount, 123);
  assert.equal(manifest.activeDefinitions.esc.globalIndex, 317);
  assert.equal(
    manifest.frozenVisualBaseline.sha256,
    require('node:crypto').createHash('sha256').update(frozenBytes).digest('hex')
  );
  assert.equal(files.has('docs/baselines/v0.6.0/ui-runtime-manifest.json'), true);
});
