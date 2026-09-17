const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  const functionStart = appJs.indexOf(`function ${functionName}(`);
  assert.notEqual(functionStart, -1, `missing ${functionName}`);
  const start = appJs.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const next = appJs.indexOf('\nfunction ', start + 10);
  return appJs.slice(start, next === -1 ? appJs.length : next);
}

function evaluateAppFunctions(functionNames, globals) {
  const sandbox = { ...globals };
  const source = functionNames.map(appFunction).join('\n')
    + `\nthis.__functions = { ${functionNames.join(', ')} };`;
  vm.runInNewContext(source, sandbox);
  return sandbox.__functions;
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

test('customer detail keeps the contact workflow embedded and consumes only server-projected contact actions', () => {
  assert.doesNotMatch(indexHtml, /id="page-contacts"/);
  assert.match(indexHtml, /id="contactDialog"[^>]*role="dialog"/);
  assert.match(indexHtml, /id="contactName"[^>]*required/);
  assert.match(indexHtml, /data-crm-contact-action="create"/);
  assert.match(appJs, /function currentUserHasCrmContactPermission\(action\)/);
  assert.match(appJs, /permissions\['crm\.contact'\]/);

  const presentation = appFunction('applyCrmPermissionPresentation');
  assert.match(presentation, /\[data-crm-contact-action\]/);
  assert.match(presentation, /currentUserHasCrmContactPermission\(action\)/);

  const sidebar = appFunction('renderCustomerSidebar');
  assert.match(sidebar, /联系人\s*\(\$\{contacts\.length\}\)/);
  assert.match(sidebar, /detail\.contacts/);
  assert.match(sidebar, /currentUserHasCrmContactPermission\('create'\)/);
  assert.match(sidebar, /currentUserHasCrmContactPermission\('update'\)/);
  assert.match(sidebar, /esc\(contact\.name/);
  assert.match(sidebar, /esc\(contact\.role/);
  assert.match(sidebar, /esc\(contact\.email/);
  assert.match(sidebar, /esc\(contact\.phone/);
  assert.match(sidebar, /encodeURIComponent\(contact\.email/);
  assert.match(sidebar, /encodeURIComponent\(contact\.phone/);

  assert.match(appFunction('showContactModal'), /currentUserHasCrmContactPermission\('create'\)/);
  assert.match(
    appFunction('saveContact'),
    /currentUserHasCrmContactPermission\(contactEditId \? 'update' : 'create'\)/
  );
  assert.match(appFunction('editContact'), /currentUserHasCrmContactPermission\('update'\)/);
  assert.match(appFunction('archiveContact'), /currentUserHasCrmContactPermission\('update'\)/);
  assert.match(appFunction('archiveContact'), /confirm\(/);
  assert.match(appFunction('archiveContact'), /openCustomerDetail\(customerId\)/);
});

test('opportunity table exposes focusable view actions and permission-gated edit buttons', () => {
  const loadOpportunities = appFunction('loadOpportunities');
  assert.match(loadOpportunities, /currentUserHasCrmOpportunityPermission\('update'\)/);
  assert.match(loadOpportunities, /<button type="button"[^>]*onclick="viewOpportunity\('/);
  assert.match(loadOpportunities, /if\s*\(canUpdateOpportunity\)[\s\S]*?<button type="button"[^>]*onclick="editOpportunity\('/);
  assert.doesNotMatch(loadOpportunities, /<tr[^>]*onclick=/);
  assert.doesNotMatch(loadOpportunities, /<tr[^>]*cursor:pointer/);
});

test('opportunity list escapes every server-controlled text value before writing innerHTML', () => {
  const loadOpportunities = appFunction('loadOpportunities');
  assert.match(loadOpportunities, /var opportunityName\s*=\s*esc\(o\.name\s*\|\|\s*''\)/);
  assert.match(loadOpportunities, /var opportunityBrand\s*=\s*esc\(o\.brand_name\s*\|\|\s*'-'\)/);
  assert.match(loadOpportunities, /var opportunityStage\s*=\s*esc\(sl\[o\.stage\]\s*\|\|\s*o\.stage\s*\|\|\s*'-'\)/);
  assert.match(loadOpportunities, /var opportunityCloseDate\s*=\s*esc\(o\.expected_close_date\s*\|\|\s*'-'\)/);
  assert.doesNotMatch(loadOpportunities, /\+\(o\.brand_name\|\|'-'\)\+/);
  assert.doesNotMatch(loadOpportunities, /\+\(sl\[o\.stage\]\|\|o\.stage\)\+/);
  assert.doesNotMatch(loadOpportunities, /\+\(o\.expected_close_date\|\|'-'\)\+/);
});

test('opportunity list cannot inject markup through any server-controlled cell', async () => {
  const opportunityTable = { innerHTML: '' };
  const elements = {
    oppStageFilter: { value: '' },
    oppCustomerFilter: { value: '' },
    oppTableBody: opportunityTable,
    oppCount: { textContent: '' }
  };
  const marker = '<img src=x onerror=alert(1)>';
  const { loadOpportunities } = evaluateAppFunctions(
    ['requireSuccessfulCustomerMutation', 'loadOpportunities'],
    {
      apiFetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          opportunities: [{
            id: 17,
            name: marker,
            brand_name: marker,
            value: marker,
            stage: marker,
            win_probability: marker,
            expected_close_date: marker
          }]
        })
      }),
      currentUserHasCrmOpportunityPermission: () => true,
      document: { getElementById: (id) => elements[id] || null },
      esc: (value) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
    }
  );

  await loadOpportunities();

  assert.doesNotMatch(opportunityTable.innerHTML, /<img\b/i);
  assert.match(opportunityTable.innerHTML, /&lt;img/);
});

test('opportunity modal supports accessible read-only view and restores create or edit state', () => {
  const viewOpportunity = appFunction('viewOpportunity');
  assert.doesNotMatch(viewOpportunity, /currentUserHasCrmOpportunityPermission\('update'\)/);
  assert.match(viewOpportunity, /setOpportunityModalMode\('view'\)/);
  assert.match(viewOpportunity, /openOpportunityDialog\(\)/);

  const setMode = appFunction('setOpportunityModalMode');
  assert.match(setMode, /var viewOnly\s*=\s*mode === 'view'/);
  assert.match(setMode, /field\.disabled\s*=\s*viewOnly/);
  assert.match(setMode, /saveButton\.hidden\s*=\s*viewOnly/);

  assert.match(appFunction('showOppModal'), /setOpportunityModalMode\('create'\)/);
  assert.match(appFunction('editOpportunity'), /setOpportunityModalMode\('update'\)/);

  const openDialog = appFunction('openOpportunityDialog');
  assert.match(openDialog, /TMAccessibility\.openDialog/);
  assert.match(openDialog, /dialog\.focus\(\)/);
  const closeDialog = appFunction('closeOppModal');
  assert.match(closeDialog, /TMAccessibility\.closeDialog/);
  assert.match(closeDialog, /opportunityDialogOpener\.focus\(\)/);
});

test('opportunity row inline handlers are included in the global export contract', () => {
  const start = appJs.indexOf('(function exposeInlineHandlers()');
  assert.notEqual(start, -1, 'missing exposeInlineHandlers');
  const end = appJs.indexOf('})();', start);
  assert.notEqual(end, -1, 'missing exposeInlineHandlers terminator');
  const inlineHandlerBlock = appJs.slice(start, end);

  assert.match(inlineHandlerBlock, /'viewOpportunity'/);
  assert.match(inlineHandlerBlock, /'editOpportunity'/);
});

test('failed opportunity response does not enter the empty-list state', async () => {
  const opportunityTable = { innerHTML: '' };
  const elements = {
    oppStageFilter: { value: '' },
    oppCustomerFilter: { value: '' },
    oppTableBody: opportunityTable,
    oppCount: { textContent: '' }
  };
  const { loadOpportunities } = evaluateAppFunctions(
    ['requireSuccessfulCustomerMutation', 'loadOpportunities'],
    {
      apiFetch: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ code: 'CRM_PERMISSION_FORBIDDEN' })
      }),
      currentUserHasCrmOpportunityPermission: () => false,
      document: { getElementById: (id) => elements[id] || null },
      esc: (value) => String(value)
    }
  );

  await loadOpportunities();

  assert.doesNotMatch(opportunityTable.innerHTML, /暂无商机/);
  assert.match(opportunityTable.innerHTML, /加载失败/);
  assert.match(opportunityTable.innerHTML, /CRM_PERMISSION_FORBIDDEN/);
});

test('failed customer detail response does not enter the not-found state', async () => {
  const messages = [];
  let renderCount = 0;
  const { openCustomerDetail } = evaluateAppFunctions(
    ['requireSuccessfulCustomerMutation', 'openCustomerDetail'],
    {
      apiFetch: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ code: 'CRM_PERMISSION_FORBIDDEN' })
      }),
      toast: (message) => messages.push(message),
      renderCustomerSidebar: () => { renderCount += 1; }
    }
  );

  await openCustomerDetail(41);

  assert.equal(renderCount, 0);
  assert.equal(messages.some((message) => message.includes('客户不存在')), false);
  assert.equal(messages.some((message) => message.includes('加载失败')), true);
  assert.equal(messages.some((message) => message.includes('CRM_PERMISSION_FORBIDDEN')), true);
});
