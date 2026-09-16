const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'platform', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(repoRoot, 'platform', 'app.js'), 'utf8');
const navigationJs = fs.readFileSync(path.join(repoRoot, 'platform', 'client', 'core', 'navigation.js'), 'utf8');

function pageSection(id) {
  const marker = `id="${id}"`;
  const start = indexHtml.indexOf(marker);
  assert.notEqual(start, -1, `missing ${id}`);
  const next = indexHtml.indexOf('<div class="page"', start + marker.length);
  return indexHtml.slice(start, next === -1 ? indexHtml.length : next);
}

function appNavigationApplySection() {
  const start = appJs.indexOf('function applyAppSideEffects(state)');
  assert.notEqual(start, -1, 'missing TM_NAVIGATION_APP applyAppSideEffects');
  const end = appJs.indexOf("document.addEventListener('tm:navigation-applied'", start);
  assert.notEqual(end, -1, 'missing tm:navigation-applied listener');
  return appJs.slice(start, end);
}

function appFunction(functionName) {
  const start = appJs.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `missing ${functionName}`);
  const next = appJs.indexOf('\nfunction ', start + 10);
  return appJs.slice(start, next === -1 ? appJs.length : next);
}

test('customer workspace exposes separate board and detail pages', () => {
  assert.match(indexHtml, /id="page-m0"/);
  assert.match(indexHtml, /id="page-m0-detail"/);
  assert.match(navigationJs, /id:\s*'m0',\s*icon:\s*'看',\s*label:\s*'客户看板'/);
  assert.match(navigationJs, /id:\s*'m0-detail',\s*icon:\s*'客',\s*label:\s*'客户明细'/);
});

test('customer board page keeps the operating dashboard out of customer details', () => {
  const board = pageSection('page-m0');
  assert.match(board, /id="m0StageBars"/);
  assert.match(board, /id="m0FocusBrand"/);
  assert.match(board, /id="m0AiInsightText"/);
  assert.doesNotMatch(board, /id="custSearch"/);
  assert.doesNotMatch(board, /id="custTableBody"/);
  assert.doesNotMatch(board, /id="seaPoolTable"/);
});

test('customer detail page owns list filters, public pool, and opportunity views', () => {
  const detail = pageSection('page-m0-detail');
  assert.match(detail, /客户明细/);
  assert.match(detail, /id="custSearch"/);
  assert.match(detail, /id="custTableBody"/);
  assert.match(detail, /id="seaPoolTable"/);
  assert.match(detail, /id="crmOpportunityView"/);
  assert.match(detail, /id="m0StageFilter"/);
  assert.doesNotMatch(detail, /id="m0StageBars"/);
});

test('customer navigation initializes board and detail views independently', () => {
  const applySideEffects = appNavigationApplySection();
  assert.match(applySideEffects, /id === 'm0'[\s\S]*?loadCustomerStats\(\)[\s\S]*?renderCrmCommandCenter\(\)/);
  assert.match(applySideEffects, /id === 'm0-detail'[\s\S]*?switchCrmView\(substate\.view \|\| curCrmView \|\| 'pipeline', \{ skipHistory: true \}\)/);
  assert.match(appJs, /await loadCustomers\(\)/);
  assert.match(indexHtml, /ppt\.js\?v=20260702v916kbbridge/);
});

test('customer workspace projects server-approved CRM actions into existing controls', () => {
  const detail = pageSection('page-m0-detail');
  assert.match(detail, /id="customerScopeTeam"[^>]*data-scope="team"/);
  assert.match(detail, /id="customerScopeOrganization"[^>]*data-scope="all"/);
  assert.match(detail, /id="crmCreateCustomerButton"[^>]*onclick="openAddCustomer\(\)"/);
  assert.match(appJs, /function currentUserHasCrmPermission\(action\)/);
  assert.match(appJs, /CURRENT_USER && CURRENT_USER\.module_permissions/);
  assert.match(appJs, /permissions\['crm\.customer'\]/);
  assert.match(appJs, /function applyCrmPermissionPresentation\(\)/);
  assert.match(appJs, /currentUserHasCrmPermission\('create'\)/);
  assert.match(appJs, /currentUserHasCrmPermission\('update'\)/);
  assert.match(appJs, /currentUserCanUseCrmScope\('organization'\)/);
  assert.match(appJs, /currentUserCanUseCrmScope\('team'\)/);
});

test('customer write entry points fail closed in the browser when the server projection denies update', () => {
  for (const functionName of [
    'showAddCustomer',
    'openAddCustomer',
    'editCustomer',
    'saveCustomer',
    'changeCustomerStage',
    'claimCustomer',
    'returnToPool'
  ]) {
    const start = appJs.indexOf(`function ${functionName}(`);
    assert.notEqual(start, -1, `missing ${functionName}`);
    const next = appJs.indexOf('\nfunction ', start + 10);
    const body = appJs.slice(start, next === -1 ? appJs.length : next);
    const action = functionName === 'showAddCustomer' || functionName === 'openAddCustomer'
      ? 'create'
      : functionName === 'saveCustomer'
        ? null
        : 'update';
    if (action) {
      assert.match(body, new RegExp(`currentUserHasCrmPermission\\('${action}'\\)`), functionName);
    } else {
      assert.match(body, /currentUserHasCrmPermission\(editId \? 'update' : 'create'\)/, functionName);
    }
  }
});

test('opportunity controls consume server-projected create and update actions', () => {
  assert.match(indexHtml, /onclick="saveOpportunity\(\)"[^>]*data-crm-opportunity-action="create"/);
  assert.match(appJs, /function currentUserHasCrmOpportunityPermission\(action\)/);
  assert.match(appJs, /permissions\['crm\.opportunity'\]/);

  const presentation = appFunction('applyCrmPermissionPresentation');
  assert.match(presentation, /\[data-crm-opportunity-action\]/);
  assert.match(presentation, /currentUserHasCrmOpportunityPermission\(action\)/);

  const sidebar = appFunction('renderCustomerSidebar');
  assert.match(sidebar, /currentUserHasCrmOpportunityPermission\('create'\)/);

  assert.match(appFunction('showOppModal'), /currentUserHasCrmOpportunityPermission\('create'\)/);
  assert.match(
    appFunction('saveOpportunity'),
    /currentUserHasCrmOpportunityPermission\(editId \? 'update' : 'create'\)/
  );
  assert.match(appFunction('editOpportunity'), /currentUserHasCrmOpportunityPermission\('update'\)/);
});

test('opportunity table rows expose edit behavior only with update permission', () => {
  const loadOpportunities = appFunction('loadOpportunities');
  assert.match(loadOpportunities, /currentUserHasCrmOpportunityPermission\('update'\)/);
  assert.match(loadOpportunities, /canUpdateOpportunity \?[^;]*editOpportunity/);
  assert.doesNotMatch(loadOpportunities, /<tr data-opp-id="'\+o\.id\+'" style="cursor:pointer" onclick="editOpportunity/);
});
