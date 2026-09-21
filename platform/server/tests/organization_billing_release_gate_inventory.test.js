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

test('schema, sanitizer, trusted source, and deployment registries terminate at billing migration 031', () => {
  const dbSource = source('server/db.js');
  const migrationGate = source('server/scripts/verify_campaign_migration_gate.js');
  const sanitizer = source('server/scripts/sanitize_production_shape.js');
  const trustedGate = source('server/scripts/trusted_production_source_gate.js');
  const deploy = source('deploy_v8.ps1');
  for (const text of [dbSource, migrationGate, sanitizer]) {
    assert.match(text, /version:\s*31[\s\S]*031_organization_billing_statements/);
  }
  assert.match(sanitizer, /STRUCTURAL_COLUMN_POLICY_V31/);
  assert.match(sanitizer, /schemaVersion === 31/);
  assert.match(sanitizer, /version 6 through version 31/);
  assert.match(trustedGate, /server\/migrations\/031_organization_billing_statements\.js/);
  for (const file of [
    'server\\migrations\\031_organization_billing_statements.js',
    'server\\services\\organization_billing_service.js',
    'server\\routes_organization_billing.js',
    'server\\tests\\organization_billing_migration.test.js',
    'server\\tests\\organization_billing_service.test.js',
    'server\\tests\\organization_billing_routes.test.js',
    'server\\tests\\admin_organization_billing_ui.test.js',
    'server\\tests\\verify_organization_billing_acceptance.test.js',
    'server\\tests\\organization_billing_release_gate_inventory.test.js',
    'server\\scripts\\verify_organization_billing_acceptance.js'
  ]) {
    assert.ok(deploy.includes(file), `${file} must be included in the deployment inventory`);
  }
});

test('server shares one billing service with governance and exact billing routes', () => {
  const server = source('server/server.js');
  const governance = source('server/services/organization_governance_service.js');
  assert.match(server, /createOrganizationBillingService\(db\)/);
  assert.match(server, /registerOrganizationBillingRoutes\(app, db,/);
  assert.match(server, /billingService:\s*organizationBillingService/);
  assert.match(governance, /billingService\.projectOrganizationBillingSummary/);
  assert.match(governance, /manage_billing/);
});

test('production cutover binds reversible billing acceptance before durable acceptance and public traffic', () => {
  const deploy = source('deploy_v8.ps1');
  const replay = deploy.indexOf('record_phase release-replay-complete');
  const billingAcceptance = deploy.indexOf('node server/scripts/verify_organization_billing_acceptance.js');
  const acceptanceFacts = deploy.indexOf('\nrecord_acceptance_facts\n', replay);
  const publicActivation = deploy.indexOf('\nactivate_public_candidate\n', acceptanceFacts);
  assert.ok(replay >= 0);
  assert.ok(billingAcceptance > replay);
  assert.ok(acceptanceFacts > billingAcceptance);
  assert.ok(publicActivation > acceptanceFacts);
  assert.match(deploy, /ORGANIZATION_BILLING_ACCEPTANCE_OK/);
  assert.match(deploy, /'organizationBillingAcceptance': organizationBillingAcceptance/);
  assert.match(deploy, /assert_organization_billing_acceptance_binding/);
});

test('admin UI adds compact billing controls without a new navigation surface', () => {
  const app = source('app.js');
  assert.match(app, /账单/);
  assert.match(app, /ad_organizationBilling(?:Toggle|Editor)_/);
  assert.match(app, /saveAdminOrganizationBilling/);
  assert.doesNotMatch(app, /账单中心/);
});
