const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'platform', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(repoRoot, 'platform', 'app.js'), 'utf8');
const navigationJs = fs.readFileSync(path.join(repoRoot, 'platform', 'client', 'core', 'navigation.js'), 'utf8');
const componentsCss = fs.readFileSync(path.join(repoRoot, 'platform', 'client', 'styles', 'components.css'), 'utf8');

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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function createContactRefreshRaceHarness() {
  const elements = {};
  const document = {
    activeElement: null,
    getElementById: (id) => elements[id] || null
  };
  const customerDetailDialog = {
    id: 'customerDetailDialog',
    contains(node) { return node === elements.customerContactSection; }
  };
  const contactDialog = {
    id: 'contactDialog',
    dataset: { requestGeneration: '0' },
    setAttribute() {},
    focus() { document.activeElement = this; }
  };
  const contactName = {
    value: '',
    focus() { document.activeElement = this; }
  };
  const detailFocus = {
    id: 'detail-focus',
    isConnected: true,
    focus() { document.activeElement = this; }
  };
  Object.assign(elements, {
    contactModalOverlay: {
      hidden: true,
      inert: true,
      style: {},
      removeAttribute() {},
      setAttribute() {}
    },
    contactDialog,
    customerDetailDialog,
    contactModalTitle: { textContent: '' },
    contactEditId: { value: '' },
    contactCustomerId: { value: '' },
    contactName,
    contactRole: { value: '' },
    contactEmail: { value: '' },
    contactPhone: { value: '' },
    contactIsPreferred: { checked: false },
    contactSaveButton: {
      hidden: false,
      disabled: false,
      textContent: '保存',
      setAttribute(name, value) { this[name] = value; }
    },
    customerContactSection: detailFocus
  });

  const dialogStack = [customerDetailDialog];
  const accessibility = {
    activeDialog: customerDetailDialog,
    openDialog(dialog) {
      dialogStack.push(dialog);
      this.activeDialog = dialog;
      if (dialog === contactDialog) contactName.focus();
      else detailFocus.focus();
    },
    closeDialog(dialog) {
      const index = dialogStack.lastIndexOf(dialog);
      if (index !== -1) dialogStack.splice(index, 1);
      this.activeDialog = dialogStack[dialogStack.length - 1] || null;
      detailFocus.focus();
    }
  };
  document.activeElement = detailFocus;

  let releaseDetail = null;
  let renderCount = 0;
  const globals = {
    customerDetailRequestGeneration: 0,
    _lastCustomerDetailData: null,
    currentUserHasCrmContactPermission: () => true,
    rejectCrmBrowserAction: () => false,
    document,
    window: { TMAccessibility: accessibility },
    showConfirm: async () => true,
    apiFetch: async (url) => {
      if (url === '/customers/41/detail') {
        return new Promise((resolve) => {
          releaseDetail = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({
              customer: { id: 41, brand_name: 'Refresh result' },
              contacts: [],
              opportunities: [],
              activity: []
            })
          });
        });
      }
      return { ok: true, status: 200 };
    },
    renderCustomerSidebar() {
      renderCount += 1;
      elements.customerContactSection = {
        id: 'refreshed-contact-section',
        isConnected: true,
        focus() { document.activeElement = this; }
      };
      accessibility.openDialog(customerDetailDialog);
      elements.customerContactSection.focus();
    },
    toast() {}
  };

  return {
    elements,
    document,
    accessibility,
    dialogStack,
    globals,
    renderCount: () => renderCount,
    async waitForDetailRequest() {
      while (!releaseDetail) await new Promise((resolve) => setImmediate(resolve));
    },
    releaseDetail() {
      assert.equal(typeof releaseDetail, 'function');
      releaseDetail();
    }
  };
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
      customerDetailRequestGeneration: 0,
      _lastCustomerDetailData: null,
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

test('an older customer detail response cannot overwrite a newer customer', async () => {
  const pending = new Map();
  const renderedCustomerIds = [];
  const { openCustomerDetail } = evaluateAppFunctions(
    ['requireSuccessfulCustomerMutation', 'openCustomerDetail'],
    {
      customerDetailRequestGeneration: 0,
      _lastCustomerDetailData: null,
      apiFetch: (url) => new Promise((resolve) => pending.set(url, resolve)),
      toast() {},
      renderCustomerSidebar: (data) => renderedCustomerIds.push(data.customer.id)
    }
  );

  const olderRequest = openCustomerDetail(41);
  const newerRequest = openCustomerDetail(42);
  pending.get('/customers/42/detail')({
    ok: true,
    status: 200,
    json: async () => ({ customer: { id: 42 } })
  });
  assert.equal(await newerRequest, true);
  pending.get('/customers/41/detail')({
    ok: true,
    status: 200,
    json: async () => ({ customer: { id: 41 } })
  });

  assert.equal(await olderRequest, false);
  assert.deepEqual(renderedCustomerIds, [42]);
});

test('closing customer detail invalidates its pending response', async () => {
  let releaseDetail = null;
  let renderCount = 0;
  const { openCustomerDetail, closeCustomerDetail } = evaluateAppFunctions(
    ['requireSuccessfulCustomerMutation', 'openCustomerDetail', 'closeCustomerDetail'],
    {
      customerDetailRequestGeneration: 0,
      _lastCustomerDetailData: null,
      apiFetch: () => new Promise((resolve) => { releaseDetail = resolve; }),
      document: { getElementById: () => null },
      window: {},
      toast() {},
      renderCustomerSidebar: () => { renderCount += 1; }
    }
  );

  const pendingRequest = openCustomerDetail(41);
  closeCustomerDetail();
  releaseDetail({
    ok: true,
    status: 200,
    json: async () => ({ customer: { id: 41 } })
  });

  assert.equal(await pendingRequest, false);
  assert.equal(renderCount, 0);
});

test('contact permissions use only the exact server-projected crm.contact actions', () => {
  const { currentUserHasCrmContactPermission } = evaluateAppFunctions(
    ['currentUserHasCrmContactPermission'],
    {
      CURRENT_USER: {
        role: 'admin',
        access_roles: ['company_owner'],
        module_permissions: {
          'crm.customer': ['read', 'create', 'update'],
          'crm.opportunity': ['read', 'create', 'update'],
          'crm.contact': ['read']
        }
      }
    }
  );

  assert.equal(currentUserHasCrmContactPermission('read'), true);
  assert.equal(currentUserHasCrmContactPermission('create'), false);
  assert.equal(currentUserHasCrmContactPermission('update'), false);
});

test('customer sidebar renders compact escaped contacts immediately after basic information', () => {
  const title = { textContent: '' };
  const body = { innerHTML: '' };
  const overlay = { hidden: true, style: {} };
  const sidebar = {
    hidden: true,
    inert: true,
    classList: { add() {} },
    removeAttribute() {}
  };
  const dialog = {};
  const elements = {
    custDetailTitle: title,
    custDetailBody: body,
    custDetailOverlay: overlay,
    custDetailSidebar: sidebar,
    customerDetailDialog: dialog
  };
  const { renderCustomerContacts, renderCustomerSidebar } = evaluateAppFunctions(
    ['renderCustomerContacts', 'renderCustomerSidebar'],
    {
      CUST_STAGES: { lead: '线索' },
      currentUserHasCrmPermission: () => false,
      currentUserHasCrmOpportunityPermission: () => false,
      currentUserHasCrmContactPermission: () => true,
      document: {
        activeElement: { id: 'detail-opener' },
        getElementById: (id) => elements[id] || null
      },
      esc: escapeHtml,
      window: { TMAccessibility: { openDialog() {} } }
    }
  );

  renderCustomerSidebar({
    customer: {
      id: 41,
      brand_name: 'Acme',
      company_name: 'Acme Ltd',
      industry: 'Retail',
      contact_person: 'Legacy owner',
      stage: 'lead',
      source: 'manual',
      notes: 'Notes'
    },
    contacts: [{
      id: 7,
      customer_id: 41,
      name: '<img src=x onerror=alert(1)>',
      role: 'VP <script>alert(2)</script>',
      email: 'alex"<tag>@example.invalid',
      phone: '+86 <555>',
      is_preferred: true
    }],
    opportunities: [],
    activity: []
  });

  assert.ok(body.innerHTML.indexOf('基本信息') < body.innerHTML.indexOf('customer-contact-section'));
  assert.match(body.innerHTML, /<h4[^>]*>联系人 \(1\)<\/h4>/);
  assert.match(body.innerHTML, /contact-card/);
  assert.match(body.innerHTML, /主联系人/);
  assert.match(body.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(body.innerHTML, /VP &lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(body.innerHTML, /alex&quot;&lt;tag&gt;@example\.invalid/);
  assert.match(body.innerHTML, /\+86 &lt;555&gt;/);
  assert.match(body.innerHTML, /href="mailto:alex%22%3Ctag%3E%40example\.invalid"/);
  assert.match(body.innerHTML, /href="tel:%2B86%20%3C555%3E"/);
  assert.doesNotMatch(body.innerHTML, /<img\b|<script\b|href="javascript:/i);
});

test('contact section has a complete empty state and independently gates create versus update controls', () => {
  let actions = [];
  const { renderCustomerContacts } = evaluateAppFunctions(
    ['renderCustomerContacts'],
    {
      currentUserHasCrmContactPermission: (action) => actions.includes(action),
      esc: escapeHtml
    }
  );

  const readOnly = renderCustomerContacts(41, []);
  assert.match(readOnly, /联系人 \(0\)/);
  assert.match(readOnly, /暂无联系人/);
  assert.match(readOnly, /联系人只读/);
  assert.match(readOnly, /title="当前账号没有新增、编辑或归档联系人权限"/);
  assert.doesNotMatch(readOnly, /showAddContact|editCustomerContact|archiveCustomerContact/);

  actions = ['read', 'create'];
  const createOnly = renderCustomerContacts(41, [{
    id: 7,
    name: 'Alex',
    role: null,
    email: null,
    phone: null,
    is_preferred: false
  }]);
  assert.match(createOnly, /showAddContact\(41\)/);
  assert.doesNotMatch(createOnly, /editCustomerContact|archiveCustomerContact/);
  assert.match(createOnly, /不可编辑或归档/);

  actions = ['read', 'update'];
  const updateOnly = renderCustomerContacts(41, [{
    id: 7,
    name: 'Alex',
    role: null,
    email: null,
    phone: null,
    is_preferred: false
  }]);
  assert.doesNotMatch(updateOnly, /showAddContact/);
  assert.match(updateOnly, /editCustomerContact\(41, 7\)/);
  assert.match(updateOnly, /archiveCustomerContact\(41, 7\)/);
});

test('contact cards contain legal 200-character names and roles at 320px without horizontal overflow', () => {
  const longName = 'N'.repeat(200);
  const longRole = 'R'.repeat(200);
  const { renderCustomerContacts } = evaluateAppFunctions(
    ['renderCustomerContacts'],
    {
      currentUserHasCrmContactPermission: () => true,
      esc: escapeHtml
    }
  );

  const rendered = renderCustomerContacts(41, [{
    id: 7,
    name: longName,
    role: longRole,
    email: null,
    phone: null,
    is_preferred: false
  }]);

  assert.match(rendered, new RegExp(longName));
  assert.match(rendered, new RegExp(longRole));
  assert.match(rendered, /class="customer-contact-actions"/);
  assert.match(
    componentsCss,
    /\.customer-contact-section \.contact-card\s*\{[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap[^}]*\}/
  );
  assert.match(
    componentsCss,
    /\.customer-contact-section \.contact-card \.cc-info\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere[^}]*\}/
  );
  assert.match(
    componentsCss,
    /\.customer-contact-section \.customer-contact-actions\s*\{[^}]*flex-wrap:\s*wrap[^}]*max-width:\s*100%[^}]*\}/
  );
  assert.match(
    componentsCss,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.customer-contact-section \.customer-contact-actions\s*\{[^}]*flex:\s*1 1 100%[^}]*\}/
  );
});

test('contact dialog is accessible, uses normal checkbox sizing, and exposes explicit create/edit state', () => {
  const start = indexHtml.indexOf('id="contactModalOverlay"');
  assert.notEqual(start, -1, 'missing contact modal overlay');
  const end = indexHtml.indexOf('<!-- CRM transition evidence -->', start);
  assert.notEqual(end, -1, 'missing contact modal boundary');
  const contactDialog = indexHtml.slice(start, end);

  assert.match(contactDialog, /hidden inert aria-hidden="true"/);
  assert.match(contactDialog, /id="contactDialog"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="contactModalTitle"/);
  assert.match(contactDialog, /<label for="contactName">姓名/);
  assert.match(contactDialog, /id="contactName"[^>]*required[^>]*aria-required="true"/);
  assert.match(contactDialog, /id="contactRole"/);
  assert.match(contactDialog, /id="contactEmail"[^>]*type="email"/);
  assert.match(contactDialog, /id="contactPhone"[^>]*type="tel"/);
  assert.match(contactDialog, /id="contactIsPreferred"[^>]*type="checkbox"/);
  assert.doesNotMatch(contactDialog, /id="contactIsPreferred"[^>]*style="[^"]*(?:width|height)/);

  const setMode = appFunction('setContactDialogMode');
  assert.match(setMode, /dialog\.dataset\.mode\s*=\s*mode/);
  assert.match(setMode, /mode === 'update'/);
  assert.match(appFunction('showAddContact'), /setContactDialogMode\('create'\)/);
  assert.match(appFunction('editCustomerContact'), /setContactDialogMode\('update'\)/);
  assert.match(appFunction('openContactDialog'), /TMAccessibility\.openDialog/);
  assert.match(appFunction('closeContactDialog'), /TMAccessibility\.closeDialog/);
});

test('contact browser handlers reject every unauthorized write before dialog, confirmation, or fetch', async () => {
  let rejected = 0;
  let externalCalls = 0;
  const { showAddContact, editCustomerContact, saveCustomerContact, archiveCustomerContact } = evaluateAppFunctions(
    ['showAddContact', 'editCustomerContact', 'saveCustomerContact', 'archiveCustomerContact'],
    {
      currentUserHasCrmContactPermission: () => false,
      rejectCrmBrowserAction: () => { rejected += 1; return false; },
      document: { getElementById: () => ({ value: '' }) },
      openContactDialog: () => { externalCalls += 1; },
      apiFetch: async () => { externalCalls += 1; return { ok: true }; },
      showConfirm: async () => { externalCalls += 1; return true; }
    }
  );

  showAddContact(41);
  editCustomerContact(41, 7);
  await saveCustomerContact();
  await archiveCustomerContact(41, 7);

  assert.equal(rejected, 4);
  assert.equal(externalCalls, 0);
});

test('contact dialog delegates focus and Escape dismissal to TMAccessibility in create and edit modes', () => {
  const calls = [];
  const opener = { focus: () => calls.push('fallback-focus') };
  const overlay = {
    hidden: true,
    inert: true,
    style: {},
    removeAttribute(name) { calls.push(`overlay-remove:${name}`); },
    setAttribute(name, value) { calls.push(`overlay-set:${name}:${value}`); }
  };
  const dialog = { dataset: {}, setAttribute() {}, focus: () => calls.push('dialog-focus') };
  const elements = {
    contactModalOverlay: overlay,
    contactDialog: dialog,
    contactModalTitle: { textContent: '' },
    contactEditId: { value: '' },
    contactCustomerId: { value: '' },
    contactName: { value: '' },
    contactRole: { value: '' },
    contactEmail: { value: '' },
    contactPhone: { value: '' },
    contactIsPreferred: { checked: false },
    contactSaveButton: {
      hidden: false,
      disabled: false,
      setAttribute(name, value) { this[name] = value; }
    }
  };
  let dismiss = null;
  const globals = {
    contactDialogOpener: null,
    _lastCustomerDetailData: {
      customer: { id: 41 },
      contacts: [{
        id: 7,
        customer_id: 41,
        name: 'Alex',
        role: 'Buyer',
        email: 'alex@example.invalid',
        phone: '+86 555',
        is_preferred: true
      }]
    },
    currentUserHasCrmContactPermission: () => true,
    rejectCrmBrowserAction: () => false,
    document: {
      activeElement: opener,
      getElementById: (id) => elements[id] || null
    },
    window: {
      TMAccessibility: {
        openDialog(receivedDialog, receivedOpener, onDismiss) {
          assert.equal(receivedDialog, dialog);
          assert.equal(receivedOpener, opener);
          dismiss = onDismiss;
          calls.push('open');
        },
        closeDialog(receivedDialog) {
          assert.equal(receivedDialog, dialog);
          calls.push('close');
        }
      }
    }
  };
  const {
    setContactDialogMode,
    openContactDialog,
    closeContactDialog,
    showAddContact,
    editCustomerContact
  } = evaluateAppFunctions(
    [
      'setContactDialogMode',
      'openContactDialog',
      'closeContactDialog',
      'showAddContact',
      'editCustomerContact'
    ],
    globals
  );

  showAddContact(41);
  assert.equal(dialog.dataset.mode, 'create');
  assert.equal(elements.contactModalTitle.textContent, '新增联系人');
  assert.equal(elements.contactEditId.value, '');
  assert.equal(typeof dismiss, 'function');
  dismiss();
  assert.equal(overlay.hidden, true);

  editCustomerContact(41, 7);
  assert.equal(dialog.dataset.mode, 'update');
  assert.equal(elements.contactModalTitle.textContent, '编辑联系人');
  assert.equal(elements.contactEditId.value, 7);
  assert.equal(elements.contactName.value, 'Alex');
  assert.equal(elements.contactIsPreferred.checked, true);
  closeContactDialog();
  assert.deepEqual(calls.filter((call) => call === 'open' || call === 'close'), ['open', 'close', 'open', 'close']);
});

test('contact create and update use exact endpoints and await refreshed detail after success', async () => {
  for (const scenario of [
    {
      editId: '',
      expectedAction: 'create',
      expectedUrl: '/customers/41/contacts',
      expectedMethod: 'POST'
    },
    {
      editId: '7',
      expectedAction: 'update',
      expectedUrl: '/customers/41/contacts/7',
      expectedMethod: 'PUT'
    }
  ]) {
    const events = [];
    let finishRefresh = null;
    let saveSettled = false;
    const oldOpener = { isConnected: true };
    const elements = {
      contactEditId: { value: scenario.editId },
      contactCustomerId: { value: '41' },
      contactName: { value: '  Alex  ' },
      contactRole: { value: ' Buyer ' },
      contactEmail: { value: ' alex@example.invalid ' },
      contactPhone: { value: ' +86 555 ' },
      contactIsPreferred: { checked: true },
      contactSaveButton: { disabled: false, textContent: '保存' },
      contactDialog: {
        dataset: {
          mode: scenario.expectedAction,
          requestGeneration: '1'
        }
      },
      customerDetailDialog: {
        contains(node) { return node === elements.customerContactSection; }
      }
    };
    const document = {
      activeElement: oldOpener,
      getElementById: (id) => elements[id] || null
    };
    let request = null;
    const { requireSuccessfulCustomerMutation, saveCustomerContact } = evaluateAppFunctions(
      ['requireSuccessfulCustomerMutation', 'saveCustomerContact'],
      {
        currentUserHasCrmContactPermission: (action) => {
          assert.equal(action, scenario.expectedAction);
          return true;
        },
        rejectCrmBrowserAction: () => false,
        document,
        apiFetch: async (url, options) => {
          request = { url, options };
          events.push('request');
          return { ok: true, status: 200 };
        },
        closeContactDialog: () => {
          document.activeElement = oldOpener;
          events.push('close');
        },
        openCustomerDetail: (customerId) => new Promise((resolve) => {
          events.push(`refresh:${customerId}`);
          finishRefresh = () => {
            oldOpener.isConnected = false;
            elements.customerContactSection = {
              isConnected: true,
              focus() {
                document.activeElement = this;
                events.push('focus:contacts');
              }
            };
            events.push('refresh-complete');
            resolve(true);
          };
        }),
        toast: (message, type) => events.push(`toast:${type || 'success'}:${message}`)
      }
    );

    const savePromise = saveCustomerContact().then(() => { saveSettled = true; });
    while (!finishRefresh) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(request.url, scenario.expectedUrl);
    assert.equal(request.options.method, scenario.expectedMethod);
    assert.deepEqual(JSON.parse(request.options.body), {
      name: 'Alex',
      role: 'Buyer',
      email: 'alex@example.invalid',
      phone: '+86 555',
      is_preferred: true
    });
    assert.ok(events.indexOf('close') < events.indexOf('refresh:41'));
    assert.equal(saveSettled, false);
    finishRefresh();
    await savePromise;
    assert.ok(events.indexOf('refresh:41') < events.indexOf('refresh-complete'));
    assert.ok(events.indexOf('refresh-complete') < events.indexOf('focus:contacts'));
    assert.equal(elements.customerDetailDialog.contains(document.activeElement), true);
  }
});

test('an older Alice save cannot close or refresh a reopened Bob contact draft', async () => {
  const dialog = { dataset: {}, setAttribute() {}, focus() {} };
  const overlay = {
    hidden: true,
    inert: true,
    style: {},
    removeAttribute() {},
    setAttribute() {}
  };
  const elements = {
    contactModalOverlay: overlay,
    contactDialog: dialog,
    contactModalTitle: { textContent: '' },
    contactEditId: { value: '' },
    contactCustomerId: { value: '' },
    contactName: { value: '' },
    contactRole: { value: '' },
    contactEmail: { value: '' },
    contactPhone: { value: '' },
    contactIsPreferred: { checked: false },
    contactSaveButton: {
      hidden: false,
      disabled: false,
      textContent: '保存',
      setAttribute(name, value) { this[name] = value; }
    }
  };
  let releaseAlice = null;
  let refreshed = 0;
  let closeCount = 0;
  const { requireSuccessfulCustomerMutation, setContactDialogMode, openContactDialog,
    closeContactDialog, showAddContact, saveCustomerContact } = evaluateAppFunctions(
    [
      'requireSuccessfulCustomerMutation',
      'setContactDialogMode',
      'openContactDialog',
      'closeContactDialog',
      'showAddContact',
      'saveCustomerContact'
    ],
    {
      currentUserHasCrmContactPermission: () => true,
      rejectCrmBrowserAction: () => false,
      document: {
        activeElement: { focus() {} },
        getElementById: (id) => elements[id] || null
      },
      window: {
        TMAccessibility: {
          openDialog() {},
          closeDialog() { closeCount += 1; }
        }
      },
      apiFetch: () => new Promise((resolve) => {
        releaseAlice = () => resolve({ ok: true, status: 200 });
      }),
      openCustomerDetail: async () => { refreshed += 1; },
      toast() {}
    }
  );

  showAddContact(41);
  elements.contactName.value = 'Alice';
  const aliceSave = saveCustomerContact();
  while (!releaseAlice) await new Promise((resolve) => setImmediate(resolve));

  closeContactDialog();
  showAddContact(41);
  elements.contactName.value = 'Bob';
  assert.equal(overlay.hidden, false);
  assert.equal(elements.contactSaveButton.disabled, false);

  releaseAlice();
  await aliceSave;

  assert.equal(overlay.hidden, false);
  assert.equal(elements.contactName.value, 'Bob');
  assert.equal(elements.contactSaveButton.disabled, false);
  assert.equal(elements.contactSaveButton.textContent, '保存');
  assert.equal(refreshed, 0);
  assert.equal(closeCount, 1);
});

test('contact save refresh abandons before render when Bob opens during the detail fetch', async () => {
  const harness = createContactRefreshRaceHarness();
  const { requireSuccessfulCustomerMutation, openCustomerDetail, setContactDialogMode,
    openContactDialog, closeContactDialog, showAddContact, saveCustomerContact } = evaluateAppFunctions(
    [
      'requireSuccessfulCustomerMutation',
      'openCustomerDetail',
      'setContactDialogMode',
      'openContactDialog',
      'closeContactDialog',
      'showAddContact',
      'saveCustomerContact'
    ],
    harness.globals
  );

  showAddContact(41);
  harness.elements.contactName.value = 'Alice';
  const aliceSave = saveCustomerContact();
  await harness.waitForDetailRequest();

  showAddContact(41);
  harness.elements.contactName.value = 'Bob';
  const bobGeneration = harness.elements.contactDialog.dataset.requestGeneration;
  assert.deepEqual(harness.dialogStack, [
    harness.elements.customerDetailDialog,
    harness.elements.contactDialog
  ]);
  assert.equal(harness.accessibility.activeDialog, harness.elements.contactDialog);
  assert.equal(harness.document.activeElement, harness.elements.contactName);

  harness.releaseDetail();
  await aliceSave;

  assert.equal(harness.renderCount(), 0);
  assert.equal(harness.elements.contactModalOverlay.hidden, false);
  assert.equal(harness.elements.contactName.value, 'Bob');
  assert.equal(harness.elements.contactDialog.dataset.requestGeneration, bobGeneration);
  assert.deepEqual(harness.dialogStack, [
    harness.elements.customerDetailDialog,
    harness.elements.contactDialog
  ]);
  assert.equal(harness.accessibility.activeDialog, harness.elements.contactDialog);
  assert.equal(harness.document.activeElement, harness.elements.contactName);
});

test('non-success contact save response stays open and never refreshes detail', async () => {
  const messages = [];
  let closed = 0;
  let refreshed = 0;
  const elements = {
    contactEditId: { value: '' },
    contactCustomerId: { value: '41' },
    contactName: { value: 'Alex' },
    contactRole: { value: '' },
    contactEmail: { value: '' },
    contactPhone: { value: '' },
    contactIsPreferred: { checked: false },
    contactSaveButton: { disabled: false, textContent: '保存' },
    contactDialog: { dataset: { mode: 'create', requestGeneration: '1' } }
  };
  const { requireSuccessfulCustomerMutation, saveCustomerContact } = evaluateAppFunctions(
    ['requireSuccessfulCustomerMutation', 'saveCustomerContact'],
    {
      currentUserHasCrmContactPermission: () => true,
      rejectCrmBrowserAction: () => false,
      document: { getElementById: (id) => elements[id] || null },
      apiFetch: async () => ({
        ok: false,
        status: 422,
        json: async () => ({ code: 'CRM_CONTACT_INVALID' })
      }),
      closeContactDialog: () => { closed += 1; },
      openCustomerDetail: async () => { refreshed += 1; },
      toast: (message) => messages.push(message)
    }
  );

  await saveCustomerContact();

  assert.equal(closed, 0);
  assert.equal(refreshed, 0);
  assert.equal(messages.some((message) => message.includes('CRM_CONTACT_INVALID')), true);
  assert.equal(messages.some((message) => message.includes('HTTP 422')), true);
});

test('an older archive response cannot refresh or steal focus from a newly opened contact draft', async () => {
  const dialog = { dataset: { requestGeneration: '0' }, setAttribute() {}, focus() {} };
  const overlay = {
    hidden: true,
    inert: true,
    style: {},
    removeAttribute() {},
    setAttribute() {}
  };
  const elements = {
    contactModalOverlay: overlay,
    contactDialog: dialog,
    contactModalTitle: { textContent: '' },
    contactEditId: { value: '' },
    contactCustomerId: { value: '' },
    contactName: { value: '' },
    contactRole: { value: '' },
    contactEmail: { value: '' },
    contactPhone: { value: '' },
    contactIsPreferred: { checked: false },
    contactSaveButton: {
      hidden: false,
      disabled: false,
      textContent: '保存',
      setAttribute(name, value) { this[name] = value; }
    },
    customerDetailDialog: {
      contains(node) { return node === elements.customerContactSection; }
    }
  };
  const document = {
    activeElement: { id: 'archive-opener' },
    getElementById: (id) => elements[id] || null
  };
  let releaseArchive = null;
  let refreshed = 0;
  const { requireSuccessfulCustomerMutation, setContactDialogMode, openContactDialog,
    showAddContact, archiveCustomerContact } = evaluateAppFunctions(
    [
      'requireSuccessfulCustomerMutation',
      'setContactDialogMode',
      'openContactDialog',
      'showAddContact',
      'archiveCustomerContact'
    ],
    {
      currentUserHasCrmContactPermission: () => true,
      rejectCrmBrowserAction: () => false,
      document,
      window: {
        TMAccessibility: {
          openDialog() { document.activeElement = elements.contactName; }
        }
      },
      showConfirm: async () => true,
      apiFetch: () => new Promise((resolve) => {
        releaseArchive = () => resolve({ ok: true, status: 200 });
      }),
      openCustomerDetail: async () => {
        refreshed += 1;
        elements.customerContactSection = {
          isConnected: true,
          focus() { document.activeElement = this; }
        };
      },
      toast() {}
    }
  );

  const archivePromise = archiveCustomerContact(41, 7);
  while (!releaseArchive) await new Promise((resolve) => setImmediate(resolve));

  showAddContact(41);
  elements.contactName.value = 'Bob';
  assert.equal(document.activeElement, elements.contactName);

  releaseArchive();
  await archivePromise;

  assert.equal(refreshed, 0);
  assert.equal(overlay.hidden, false);
  assert.equal(elements.contactName.value, 'Bob');
  assert.equal(document.activeElement, elements.contactName);
});

test('contact archive refresh abandons before render when Bob opens during the detail fetch', async () => {
  const harness = createContactRefreshRaceHarness();
  const { requireSuccessfulCustomerMutation, openCustomerDetail, setContactDialogMode,
    openContactDialog, showAddContact, archiveCustomerContact } = evaluateAppFunctions(
    [
      'requireSuccessfulCustomerMutation',
      'openCustomerDetail',
      'setContactDialogMode',
      'openContactDialog',
      'showAddContact',
      'archiveCustomerContact'
    ],
    harness.globals
  );

  const archivePromise = archiveCustomerContact(41, 7);
  await harness.waitForDetailRequest();

  showAddContact(41);
  harness.elements.contactName.value = 'Bob';
  const bobGeneration = harness.elements.contactDialog.dataset.requestGeneration;
  assert.deepEqual(harness.dialogStack, [
    harness.elements.customerDetailDialog,
    harness.elements.contactDialog
  ]);
  assert.equal(harness.accessibility.activeDialog, harness.elements.contactDialog);
  assert.equal(harness.document.activeElement, harness.elements.contactName);

  harness.releaseDetail();
  await archivePromise;

  assert.equal(harness.renderCount(), 0);
  assert.equal(harness.elements.contactModalOverlay.hidden, false);
  assert.equal(harness.elements.contactName.value, 'Bob');
  assert.equal(harness.elements.contactDialog.dataset.requestGeneration, bobGeneration);
  assert.deepEqual(harness.dialogStack, [
    harness.elements.customerDetailDialog,
    harness.elements.contactDialog
  ]);
  assert.equal(harness.accessibility.activeDialog, harness.elements.contactDialog);
  assert.equal(harness.document.activeElement, harness.elements.contactName);
});

test('contact archive confirms soft deletion, uses the archive endpoint, and awaits detail refresh', async () => {
  const confirmations = [];
  const events = [];
  let allowArchive = false;
  let finishRefresh = null;
  let archiveSettled = false;
  const oldOpener = { isConnected: true };
  const elements = {
    contactDialog: { dataset: { requestGeneration: '0' } },
    customerDetailDialog: {
      contains(node) { return node === elements.customerContactSection; }
    }
  };
  const document = {
    activeElement: oldOpener,
    getElementById: (id) => elements[id] || null
  };
  const { requireSuccessfulCustomerMutation, archiveCustomerContact } = evaluateAppFunctions(
    ['requireSuccessfulCustomerMutation', 'archiveCustomerContact'],
    {
      currentUserHasCrmContactPermission: (action) => action === 'update',
      rejectCrmBrowserAction: () => false,
      showConfirm: async (title, message) => {
        confirmations.push({ title, message });
        return allowArchive;
      },
      apiFetch: async (url, options) => {
        events.push(`request:${options.method}:${url}`);
        return { ok: true, status: 200 };
      },
      document,
      openCustomerDetail: (customerId) => new Promise((resolve) => {
        events.push(`refresh:${customerId}`);
        finishRefresh = () => {
          oldOpener.isConnected = false;
          elements.customerContactSection = {
            isConnected: true,
            focus() {
              document.activeElement = this;
              events.push('focus:contacts');
            }
          };
          events.push('refresh-complete');
          resolve(true);
        };
      }),
      toast: (message) => events.push(`toast:${message}`)
    }
  );

  await archiveCustomerContact(41, 7);
  assert.deepEqual(events, []);
  assert.match(confirmations[0].title, /归档/);
  assert.match(confirmations[0].message, /归档/);
  assert.match(confirmations[0].message, /不会永久删除/);

  allowArchive = true;
  const archivePromise = archiveCustomerContact(41, 7).then(() => { archiveSettled = true; });
  while (!finishRefresh) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archiveSettled, false);
  assert.deepEqual(events, [
    'request:POST:/customers/41/contacts/7/archive',
    'toast:联系人已归档',
    'refresh:41'
  ]);
  finishRefresh();
  await archivePromise;
  assert.deepEqual(events, [
    'request:POST:/customers/41/contacts/7/archive',
    'toast:联系人已归档',
    'refresh:41',
    'refresh-complete',
    'focus:contacts'
  ]);
  assert.equal(elements.customerDetailDialog.contains(document.activeElement), true);
});

test('contact inline controls are included in the global export contract', () => {
  const start = appJs.indexOf('(function exposeInlineHandlers()');
  assert.notEqual(start, -1, 'missing exposeInlineHandlers');
  const end = appJs.indexOf('})();', start);
  const inlineHandlerBlock = appJs.slice(start, end);

  for (const handler of [
    'showAddContact',
    'editCustomerContact',
    'archiveCustomerContact',
    'saveCustomerContact',
    'closeContactDialog'
  ]) {
    assert.match(inlineHandlerBlock, new RegExp(`'${handler}'`));
  }
});
