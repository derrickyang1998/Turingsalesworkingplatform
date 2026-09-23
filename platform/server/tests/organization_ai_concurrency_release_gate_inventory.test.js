'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverRoot = path.resolve(__dirname, '..');
const platformRoot = path.resolve(serverRoot, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(platformRoot, relativePath), 'utf8');
}

function productionProviderCallers() {
  const callers = [];
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
      const text = fs.readFileSync(absolute, 'utf8');
      if (/createDeepSeekProvider\(|webSearch\.searchWeb\(/.test(text)) callers.push(relative);
    }
  };
  visit(serverRoot);
  return callers.sort();
}

test('schema and release registries terminate at durable AI concurrency migration 030', () => {
  const dbSource = source('server/db.js');
  const migrationGate = source('server/scripts/verify_campaign_migration_gate.js');
  const sanitizer = source('server/scripts/sanitize_production_shape.js');
  const trustedGate = source('server/scripts/trusted_production_source_gate.js');
  const deploy = source('deploy_v8.ps1');
  for (const text of [dbSource, migrationGate, sanitizer]) {
    assert.match(text, /version:\s*30[\s\S]*030_ai_provider_concurrency_reservation/);
  }
  assert.match(trustedGate, /server\/migrations\/030_ai_provider_concurrency_reservation\.js/);
  assert.match(deploy, /server\\migrations\\030_ai_provider_concurrency_reservation\.js/);
  assert.match(deploy, /server\\services\\ai_concurrency_service\.js/);
  assert.match(deploy, /server\\routes_admin_ai_concurrency\.js/);
  assert.match(deploy, /server\\tests\\organization_ai_concurrency_migration\.test\.js/);
  assert.match(deploy, /server\\tests\\ai_concurrency_service\.test\.js/);
  assert.match(deploy, /server\\tests\\admin_ai_concurrency_routes\.test\.js/);
  assert.match(deploy, /server\\tests\\admin_ai_concurrency_ui\.test\.js/);
  assert.match(deploy, /server\\tests\\organization_ai_concurrency_release_gate_inventory\.test\.js/);
  assert.match(deploy, /server\\scripts\\verify_ai_concurrency_acceptance\.js/);
  assert.match(deploy, /"server\\tests\\latest_ui_proposal_campaign_client\.test\.js"/);
  assert.match(deploy, /"server\\tests\\latest_ui_ppt_campaign_rag\.test\.js"/);
});

test('server wires one shared concurrency service into governance and admin routes', () => {
  const server = source('server/server.js');
  const governance = source('server/services/organization_governance_service.js');
  assert.match(server, /createAIConcurrencyService\(db\)/);
  assert.match(server, /registerAdminAIConcurrencyRoutes\(app, db,/);
  assert.match(server, /aiConcurrencyService/);
  assert.match(governance, /ai_concurrency/);
  assert.match(governance, /manage_ai_concurrency/);
});

test('every direct Tavily or DeepSeek production caller is explicitly concurrency guarded', () => {
  assert.deepEqual(productionProviderCallers(), [
    'routes_brands.js',
    'services/ai_service.js',
    'services/latest_ui_compat_service.js'
  ]);
  for (const relative of productionProviderCallers()) {
    const text = fs.readFileSync(path.join(serverRoot, relative), 'utf8');
    assert.match(text, /aiConcurrency/);
    assert.ok(
      /runWithPermit/.test(text) || (/\.acquire\(/.test(text) && /\.release\(/.test(text)),
      `${relative} must wrap provider work in a complete concurrency permit lifecycle`
    );
    assert.match(text, /permit\.signal/, `${relative} must pass the permit deadline signal to provider work`);
    assert.match(text, /permit\.assertActive/, `${relative} must fence durable writes after provider work`);
  }
});

test('production cutover runs reversible AI concurrency acceptance before durable acceptance and public traffic', () => {
  const deploy = source('deploy_v8.ps1');
  const trustedGate = source('server/scripts/trusted_production_source_gate.js');
  const trustedManifest = JSON.parse(source('server/scripts/trusted_production_source_manifest.json'));
  const replay = deploy.indexOf('record_phase release-replay-complete');
  const candidateHealth = deploy.lastIndexOf('restart_pm2_from_ecosystem_exactly');
  const releaseSmokeProvision = deploy.indexOf('node server/scripts/provision_release_smoke_identity.js');
  const concurrencyAcceptance = deploy.indexOf('node server/scripts/verify_ai_concurrency_acceptance.js');
  const acceptanceFacts = deploy.indexOf('\nrecord_acceptance_facts\n', replay);
  const publicActivation = deploy.indexOf('\nactivate_public_candidate\n', acceptanceFacts);
  assert.ok(replay >= 0);
  assert.ok(releaseSmokeProvision > candidateHealth);
  assert.ok(concurrencyAcceptance > replay);
  assert.ok(releaseSmokeProvision < concurrencyAcceptance);
  assert.match(deploy, /RELEASE_SMOKE_IDENTITY_READY existing/);
  assert.match(deploy, /RELEASE_SMOKE_IDENTITY_READY repaired/);
  assert.match(deploy, /RELEASE_SMOKE_IDENTITY_READY created/);
  assert.ok(acceptanceFacts > concurrencyAcceptance);
  assert.ok(publicActivation > acceptanceFacts);
  assert.match(deploy, /AI_CONCURRENCY_ACCEPTANCE_OK/);
  assert.match(
    deploy,
    /NODE_ENV=production[\s\\]+TM_ENV_FILE=\/etc\/turingmarket\/turingmarket\.env[\s\\]+DB_PATH=\/var\/lib\/turingmarket\/db\/turingmarket\.db[\s\\]+node server\/scripts\/verify_ai_concurrency_acceptance\.js/
  );
  assert.match(deploy, /server\/tests\/verify_ai_concurrency_acceptance\.test\.js/);
  assert.match(deploy, /server\\scripts\\provision_release_smoke_identity\.js/);
  assert.match(deploy, /server\\tests\\release_smoke_identity\.test\.js/);
  assert.match(deploy, /server\/tests\/release_smoke_identity\.test\.js/);
  assert.match(trustedGate, /server\/scripts\/provision_release_smoke_identity\.js/);
  assert.equal(
    trustedManifest.entrypoints.releaseSmokeIdentityProvisioner,
    'server/scripts/provision_release_smoke_identity.js'
  );
  assert.ok(trustedManifest.files.some(
    (entry) => entry.path === 'server/scripts/provision_release_smoke_identity.js'
  ));
  assert.match(deploy, /'aiConcurrencyAcceptance': aiConcurrencyAcceptance/);
  assert.match(deploy, /assert_ai_concurrency_acceptance_binding/);
});

test('admin UI extends the existing quota cell without a new navigation surface', () => {
  const app = source('app.js');
  assert.match(app, /AI 配额 \/ 并发/);
  assert.match(app, /ad_organizationAiConcurrency_/);
  assert.match(app, /saveAdminOrganizationAiConcurrency/);
  assert.doesNotMatch(app, /AI 并发中心/);
});
