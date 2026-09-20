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

const migration029 = Object.freeze({
  version: 29,
  name: '029_organization_monthly_ai_quota',
  sourcePath: 'migrations/029_organization_monthly_ai_quota.js',
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

function productionProviderCallers() {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'tests') visit(absolute);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name) !== '.js') continue;
      const relative = path.relative(serverRoot, absolute).replace(/\\/g, '/');
      if (relative === 'services/llm_service.js' || relative === 'services/web_search_service.js') continue;
      const source = fs.readFileSync(absolute, 'utf8');
      if (/createDeepSeekProvider\(|webSearch\.searchWeb\(/.test(source)) files.push(relative);
    }
  };
  visit(serverRoot);
  return files.sort();
}

test('schema, sanitizer, and trusted source registries terminate at organization quota migration 029', () => {
  assert.deepEqual(migrationGate.REGISTERED_MIGRATIONS.at(-1), migration029);
  assert.deepEqual(sanitizer.EXACT_PROFILE_MIGRATIONS.at(-1), migration029);
  assert.equal(sanitizationManifest.exactProfiles.at(-1).schemaVersion, 29);
  assert.ok(
    sanitizationManifest.exactProfiles.at(-1).objects.some(
      (object) => object.name === 'organization_ai_quota_policies'
    )
  );

  const manifestPath = path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json');
  const trusted = trustedGate.loadTrustedManifest(manifestPath);
  assert.equal(trusted.migrationContract.targetVersion, 29);
  assert.equal(trusted.migrationContract.acceptedSourceVersions.at(-1), 29);
  for (const requiredPath of [
    'server/migrations/029_organization_monthly_ai_quota.js',
    'server/routes_admin_ai_quota.js',
    'server/services/ai_quota_service.js',
    'server/services/token_usage_service.js',
    'server/services/organization_governance_service.js',
    'server/server.js'
  ]) {
    assert.ok(trustedGate.REQUIRED_BUNDLE_FILES.includes(requiredPath), requiredPath);
    const entry = trusted.files.find((candidate) => candidate.path === requiredPath);
    assert.ok(entry, requiredPath);
    assert.equal(entry.sha256, sha256File(path.join(platformRoot, ...requiredPath.split('/'))));
  }
});

test('deployment inventory ships schema v29 and the focused organization quota gates', () => {
  const deploy = fs.readFileSync(path.join(repoRoot, 'platform', 'deploy_v8.ps1'), 'utf8');
  const files = powerShellArrayEntries(deploy, 'FILES');
  for (const requiredPath of [
    'server/migrations/029_organization_monthly_ai_quota.js',
    'server/tests/organization_ai_quota_migration.test.js',
    'server/tests/organization_ai_quota_release_gate_inventory.test.js',
    'server/tests/ai_quota_service.test.js',
    'server/tests/admin_ai_quota_routes.test.js',
    'server/tests/organization_governance_service.test.js',
    'server/tests/admin_tenant_directory_ui.test.js',
    'app.js',
    'index.html'
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
  assert.match(deploy, /server\/tests\/organization_ai_quota_migration\.test\.js/);
  assert.match(deploy, /server\/tests\/organization_ai_quota_release_gate_inventory\.test\.js/);
  assert.match(deploy, /legacy PPT quota admission/);
});

test('every direct production provider caller has a pinned quota admission contract', () => {
  assert.deepEqual(productionProviderCallers(), [
    'routes_brands.js',
    'services/ai_service.js',
    'services/latest_ui_compat_service.js'
  ]);

  const brandRoutes = fs.readFileSync(path.join(serverRoot, 'routes_brands.js'), 'utf8');
  assert.match(brandRoutes, /if \(aiQuotaGuard\) aiMiddlewares\.push\(aiQuotaGuard\)/);

  const aiService = fs.readFileSync(path.join(serverRoot, 'services', 'ai_service.js'), 'utf8');
  assert.ok(
    (aiService.match(/aiQuota\.assertAdmission\(/g) || []).length >= 3,
    'shared AI service must retain quota admission before provider branches'
  );

  const latestUi = fs.readFileSync(
    path.join(serverRoot, 'services', 'latest_ui_compat_service.js'),
    'utf8'
  );
  const pptFunctionStart = latestUi.indexOf('async function generatePptOutline');
  const legacyPptStart = latestUi.indexOf('aiQuota.assertAdmission(db, {', pptFunctionStart);
  const legacyPptEnd = latestUi.indexOf('const generated = await generateJsonWithDeepSeek', legacyPptStart);
  const legacyPptPrefix = latestUi.slice(legacyPptStart, legacyPptEnd);
  assert.match(legacyPptPrefix, /aiQuota\.assertAdmission\(/);
  assert.match(legacyPptPrefix, /opts\.allowWeb === true/);
});
