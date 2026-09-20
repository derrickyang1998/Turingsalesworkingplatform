'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const navigationSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'client', 'core', 'navigation.js'),
  'utf8'
);

function extractFunction(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const matches = Array.from(source.matchAll(declaration));
  assert.ok(matches.length, `${name} must exist`);
  const match = matches[matches.length - 1];
  const openingBrace = source.indexOf('{', match.index);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  assert.fail(`${name} must have a balanced function body`);
}

function loadFunctions(context, names) {
  context.window = context.window || context;
  context.globalThis = context;
  vm.createContext(context);
  for (const name of names) vm.runInContext(extractFunction(appSource, name), context);
  return context;
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

test('admin password reset surfaces protected-account failures instead of reporting success', async () => {
  const toasts = [];
  const context = loadFunctions({
    apiFetch() {
      return Promise.resolve(response(409, {
        error: '受保护账号需要使用凭据恢复流程',
        code: 'PROTECTED_ACCOUNT_RESET_REQUIRES_BREAK_GLASS'
      }));
    },
    toast(message, type) { toasts.push([message, type]); },
    Error,
    Promise
  }, ['adminResetPw']);

  const result = await context.adminResetPw(7);
  assert.equal(result, null);
  assert.deepEqual(toasts, [['受保护账号需要使用凭据恢复流程', 'error']]);
});

test('existing admin control room exposes the organization directory as a routed tab', () => {
  assert.match(indexSource, /switchAdminTab\(['"]organizations['"]\)[^>]*>[^<]*组织/);
  for (const id of [
    'admin-tab-organizations',
    'ad_organizationSearch',
    'ad_organizationList',
    'ad_organizationMemberSearch',
    'ad_organizationMemberStatus',
    'ad_organizationMembers',
    'ad_organizationPrevious',
    'ad_organizationNext',
    'ad_organizationPageLabel',
    'ad_organizationMemberPrevious',
    'ad_organizationMemberNext',
    'ad_organizationMemberPageLabel',
    'ad_ownerTransferOverlay',
    'ad_ownerTransferDialog',
    'ad_ownerTransferOrganization',
    'ad_ownerTransferCurrentOwner',
    'ad_ownerTransferTarget',
    'ad_ownerTransferReason',
    'ad_ownerTransferConfirmation',
    'ad_ownerTransferSubmit',
    'ad_ownerTransferStatus'
  ]) {
    assert.match(indexSource, new RegExp(`id=["']${id}["']`));
  }
  assert.match(navigationSource, /ADMIN_TABS\s*=\s*\[[^\]]*['"]organizations['"]/);
  assert.match(appSource, /\['overview','users','organizations','knowledge','ai-audit','tokens'\]/);
});

test('existing users tab exposes searchable entitlement filters and stable paging controls', () => {
  for (const id of [
    'ad_userSearch',
    'ad_userStatus',
    'ad_userRole',
    'ad_userTableBody',
    'ad_userPrevious',
    'ad_userNext',
    'ad_userPageLabel',
    'ad_userStatusText'
  ]) {
    assert.match(indexSource, new RegExp(`id=["']${id}["']`));
  }
  assert.ok(
    /<th[^>]*>\s*AI Token 配额\s*<\/th>/.test(indexSource),
    'users table quota column must be labeled "AI Token 配额"'
  );
});

test('user directory renders every active organization AI quota and per-user save controls', () => {
  const elements = { ad_userTableBody: { innerHTML: '' } };
  const context = loadFunctions({
    document: { getElementById(id) { return elements[id] || null; } },
    esc
  }, ['renderAdminUserTable']);

  context.renderAdminUserTable([{
    id: 1,
    username: 'derrick',
    display_name: 'Derrick',
    department: 'Management',
    email: 'derrick@example.com',
    role: 'admin',
    api_quota: 200000,
    last_login: '2026-09-10 08:00:00',
    is_active: 1,
    access_roles: ['platform_admin'],
    organizations: [{
      id: 10,
      code: 'alpha',
      name: 'Alpha <Market>',
      role_code: 'org_admin',
      status: 'active',
      teams: [],
      ai_quota: {
        period: 'legacy_lifetime',
        used: 250001,
        limit: 200000,
        remaining: null,
        status: 'exempt'
      }
    }]
  }, {
    id: 2,
    username: 'alice',
    display_name: 'Alice',
    department: 'Sales',
    email: 'alice@example.com',
    role: 'user',
    api_quota: 50000,
    last_login: '2026-09-09 08:00:00',
    is_active: 1,
    access_roles: ['member'],
    organizations: [{
      id: 10,
      code: 'alpha',
      name: 'Alpha <Market>',
      role_code: 'member',
      status: 'active',
      teams: [],
      ai_quota: {
        period: 'legacy_lifetime',
        used: 12345,
        limit: 50000,
        remaining: 37655,
        status: 'active'
      }
    }, {
      id: 20,
      code: 'beta',
      name: 'Beta & Labs',
      role_code: 'member',
      status: 'active',
      teams: [],
      ai_quota: {
        period: 'legacy_lifetime',
        used: 50000,
        limit: 50000,
        remaining: 0,
        status: 'exhausted'
      }
    }, {
      id: 30,
      code: 'former',
      name: 'Former Organization',
      role_code: 'member',
      status: 'revoked',
      teams: [],
      ai_quota: {
        period: 'legacy_lifetime',
        used: 49999,
        limit: 50000,
        remaining: 1,
        status: 'revoked'
      }
    }]
  }, {
    id: 4,
    username: 'carol',
    display_name: 'Carol',
    department: 'Operations',
    email: 'carol@example.com',
    role: 'user',
    api_quota: 0,
    last_login: '2026-09-08 08:00:00',
    is_active: 1,
    access_roles: ['member'],
    organizations: [{
      id: 20,
      code: 'beta',
      name: 'Beta & Labs',
      role_code: 'member',
      status: 'active',
      teams: [],
      ai_quota: {
        period: 'legacy_lifetime',
        used: 3,
        limit: 0,
        remaining: 0,
        status: 'disabled'
      }
    }]
  }]);

  const html = elements.ad_userTableBody.innerHTML;
  assert.match(html, /Alpha &lt;Market&gt;/);
  assert.doesNotMatch(html, /Alpha <Market>/);
  for (const [pattern, message] of [
    [/250,001\s*\/\s*200,000/, 'exempt organization must render used / limit'],
    [/12,345\s*\/\s*50,000/, 'active organization must render used / limit'],
    [/50,000\s*\/\s*50,000/, 'exhausted organization must render used / limit'],
    [/3\s*\/\s*0/, 'disabled organization must render used / limit'],
    [/剩余\s*不限/, 'exempt organization must render unlimited remaining quota'],
    [/剩余\s*37,655/, 'active organization must render remaining quota'],
    [/剩余\s*0/, 'exhausted and disabled organizations must render zero remaining quota'],
    [/(?:免配额|exempt)/, 'exempt organization must render its quota status'],
    [/(?:可用|正常|active)/, 'active organization must render its quota status'],
    [/(?:已用尽|exhausted)/, 'exhausted organization must render its quota status'],
    [/(?:已停用|disabled)/, 'disabled organization must render its quota status']
  ]) {
    assert.ok(pattern.test(html), message);
  }
  assert.equal(/49,?999/.test(html), false, 'revoked organizations must not render active quota controls');
  for (const [id, quota] of [[1, 200000], [2, 50000], [4, 0]]) {
    const inputPattern = new RegExp(
      `<input(?=[^>]*id=["']ad_aiQuota_${id}["'])(?=[^>]*type=["']number["'])`
        + `(?=[^>]*value=["']${quota}["'])[^>]*>`
    );
    assert.ok(inputPattern.test(html), `user ${id} must render a numeric AI quota input`);
    assert.ok(
      new RegExp(`onclick=["']adminUpdateAiQuota\\(${id}\\)["']`).test(html),
      `user ${id} must render an AI quota save action`
    );
  }
});

test('AI quota save sends only the numeric quota and refreshes after success', async () => {
  const elements = { ad_aiQuota_2: { value: '123456' } };
  const calls = [];
  const toasts = [];
  let refreshes = 0;
  const context = loadFunctions({
    document: { getElementById(id) { return elements[id] || null; } },
    apiFetch(url, options) {
      calls.push({ url, options });
      return Promise.resolve(response(200, {
        quota: { user_id: 2, limit: 123456, status: 'active' }
      }));
    },
    loadAdminUsers() {
      refreshes += 1;
      return Promise.resolve([]);
    },
    toast(message, type) { toasts.push([message, type]); },
    Promise,
    Error,
    JSON,
    Number
  }, ['adminUpdateAiQuota']);

  await context.adminUpdateAiQuota(2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/admin/users/2/ai-quota');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), { api_quota: 123456 });
  assert.equal(refreshes, 1);
  assert.equal(toasts.some((entry) => entry[1] === 'error'), false);
});

test('AI quota save rejects a blank field instead of disabling the user', async () => {
  const elements = { ad_aiQuota_2: { value: '   ' } };
  const calls = [];
  const toasts = [];
  const context = loadFunctions({
    document: { getElementById(id) { return elements[id] || null; } },
    apiFetch(url, options) {
      calls.push({ url, options });
      return Promise.resolve(response(200, {}));
    },
    loadAdminUsers() { return Promise.resolve([]); },
    toast(message, type) { toasts.push([message, type]); },
    Promise,
    Error,
    JSON,
    Number
  }, ['adminUpdateAiQuota']);

  await context.adminUpdateAiQuota(2);
  assert.equal(calls.length, 0);
  assert.deepEqual(toasts, [['AI Token 配额必须是非负整数', 'error']]);
});

test('AI quota save surfaces HTTP failures without refreshing or reporting success', async () => {
  const elements = { ad_aiQuota_2: { value: '123456' } };
  const calls = [];
  const toasts = [];
  let refreshes = 0;
  const context = loadFunctions({
    document: { getElementById(id) { return elements[id] || null; } },
    apiFetch(url, options) {
      calls.push({ url, options });
      return Promise.resolve(response(500, {
        error: 'AI Token 配额保存失败',
        code: 'AI_QUOTA_AUDIT_FAILED'
      }));
    },
    loadAdminUsers() {
      refreshes += 1;
      return Promise.resolve([]);
    },
    toast(message, type) { toasts.push([message, type]); },
    Promise,
    Error,
    JSON,
    Number
  }, ['adminUpdateAiQuota']);

  await context.adminUpdateAiQuota(2);
  assert.equal(calls.length, 1);
  assert.equal(refreshes, 0);
  assert.deepEqual(toasts, [['AI Token 配额保存失败', 'error']]);
});

test('user entitlement directory encodes filters, escapes role projections, and pages without duplicate requests', async () => {
  const elements = {
    ad_userSearch: { value: 'Alpha & Sales' },
    ad_userStatus: { value: 'active' },
    ad_userRole: { value: 'team_lead' },
    ad_userTableBody: { innerHTML: '' },
    ad_userPrevious: { disabled: false },
    ad_userNext: { disabled: false },
    ad_userPageLabel: { textContent: '' },
    ad_userStatusText: { textContent: '' }
  };
  const calls = [];
  let releaseNextPage = null;
  const context = loadFunctions({
    adminUserPageCursors: [null],
    adminUserPageIndex: 0,
    adminUserNextCursor: null,
    adminUserPageLoading: false,
    adminUserRefreshPending: false,
    adminUserFilterSignature: '',
    document: { getElementById(id) { return elements[id] || null; } },
    encodeURIComponent,
    esc,
    Promise,
    Error,
    apiFetch(url) {
      calls.push(url);
      const cursor = new URLSearchParams(url.split('?')[1] || '').get('cursor');
      const result = response(200, {
        users: [{
          id: cursor ? 2 : 1,
          username: cursor ? 'alice' : 'derrick<script>',
          display_name: cursor ? 'Alice' : 'Derrick & Co',
          department: 'Sales',
          email: cursor ? 'alice@example.com' : 'derrick@example.com',
          role: cursor ? 'user' : 'admin',
          api_quota: 50000,
          last_login: '2026-09-10 08:00:00',
          is_active: 1,
          access_roles: cursor ? ['team_lead', 'member'] : ['platform_admin', 'org_admin'],
          organizations: [{
            id: 10,
            code: 'alpha',
            name: cursor ? 'Alpha' : 'Alpha <Market>',
            role_code: cursor ? 'member' : 'org_admin',
            status: 'active',
            teams: [{ id: 101, code: 'sales', name: 'Sales <A>', role_code: 'team_lead', status: 'active' }]
          }]
        }],
        page: cursor
          ? { limit: 50, next_cursor: null, has_more: false }
          : { limit: 50, next_cursor: 1, has_more: true }
      });
      if (cursor) return new Promise((resolve) => { releaseNextPage = () => resolve(result); });
      return Promise.resolve(result);
    }
  }, [
    'buildAdminUserQuery',
    'renderAdminUserTable',
    'updateAdminUserPager',
    'loadAdminUsers',
    'adminUserNextPage',
    'adminUserPreviousPage'
  ]);

  assert.equal(context.buildAdminUserQuery(19),
    '?limit=50&q=Alpha%20%26%20Sales&status=active&role=team_lead&cursor=19');
  await context.loadAdminUsers();
  assert.match(calls[0], /^\/admin\/users\?limit=50&q=Alpha%20%26%20Sales&status=active&role=team_lead$/);
  assert.match(elements.ad_userTableBody.innerHTML, /derrick&lt;script&gt;/);
  assert.match(elements.ad_userTableBody.innerHTML, /Alpha &lt;Market&gt;/);
  assert.match(elements.ad_userTableBody.innerHTML, /Sales &lt;A&gt;/);
  assert.doesNotMatch(elements.ad_userTableBody.innerHTML, /<script>/i);
  assert.equal(elements.ad_userPageLabel.textContent, '第 1 页');
  assert.equal(elements.ad_userStatusText.textContent, '已加载 1 位用户');

  const next = context.adminUserNextPage();
  const duplicate = context.adminUserNextPage();
  assert.equal(calls.length, 2);
  await duplicate;
  releaseNextPage();
  await next;
  assert.match(calls[1], /cursor=1/);
  assert.equal(elements.ad_userPageLabel.textContent, '第 2 页');
  await context.adminUserPreviousPage();
  assert.doesNotMatch(calls[calls.length - 1], /cursor=/);
  assert.equal(elements.ad_userPageLabel.textContent, '第 1 页');
});

test('user directory queues a current-page refresh while an older request is in flight', async () => {
  const elements = {
    ad_userSearch: { value: '' },
    ad_userStatus: { value: '' },
    ad_userRole: { value: '' },
    ad_userTableBody: { innerHTML: '' },
    ad_userPrevious: { disabled: false },
    ad_userNext: { disabled: false },
    ad_userPageLabel: { textContent: '' },
    ad_userStatusText: { textContent: '' }
  };
  const calls = [];
  let releaseFirst = null;
  const context = loadFunctions({
    adminUserPageCursors: [null],
    adminUserPageIndex: 0,
    adminUserNextCursor: null,
    adminUserPageLoading: false,
    adminUserRefreshPending: false,
    adminUserFilterSignature: '',
    document: { getElementById(id) { return elements[id] || null; } },
    encodeURIComponent,
    esc,
    Promise,
    Error,
    apiFetch(url) {
      calls.push(url);
      const body = {
        users: [{
          id: calls.length,
          username: calls.length === 1 ? 'stale-user' : 'current-user',
          display_name: calls.length === 1 ? 'Stale User' : 'Current User',
          role: 'user',
          is_active: 1,
          access_roles: ['member'],
          organizations: []
        }],
        page: { limit: 50, next_cursor: null, has_more: false }
      };
      if (calls.length === 1) {
        return new Promise((resolve) => { releaseFirst = () => resolve(response(200, body)); });
      }
      return Promise.resolve(response(200, body));
    }
  }, [
    'buildAdminUserQuery',
    'renderAdminUserTable',
    'updateAdminUserPager',
    'loadAdminUsers'
  ]);

  const first = context.loadAdminUsers();
  await context.loadAdminUsers();
  assert.equal(calls.length, 1);
  releaseFirst();
  await first;
  assert.equal(calls.length, 2);
  assert.doesNotMatch(elements.ad_userTableBody.innerHTML, /stale-user/);
  assert.match(elements.ad_userTableBody.innerHTML, /current-user/);
  assert.equal(elements.ad_userStatusText.textContent, '已加载 1 位用户');
});

test('organization directory query builders encode search, status, cursor, and bounded page size', () => {
  const values = {
    ad_organizationSearch: 'Alpha & Sales',
    ad_organizationMemberSearch: 'creative lead',
    ad_organizationMemberStatus: 'active'
  };
  const context = loadFunctions({
    document: { getElementById(id) { return { value: values[id] || '' }; } },
    encodeURIComponent
  }, ['buildAdminOrganizationQuery', 'buildAdminOrganizationMemberQuery']);
  assert.equal(context.buildAdminOrganizationQuery(19),
    '?limit=50&q=Alpha%20%26%20Sales&cursor=19');
  assert.equal(context.buildAdminOrganizationMemberQuery(27),
    '?limit=50&q=creative%20lead&status=active&cursor=27');
});

test('organization directory renders escaped organization and membership projections', async () => {
  const elements = {
    ad_organizationSearch: { value: 'alpha' },
    ad_organizationList: { innerHTML: '' },
    ad_organizationMemberSearch: { value: '' },
    ad_organizationMemberStatus: { value: '' },
    ad_organizationMembers: { innerHTML: '' },
    ad_selectedOrganizationName: { textContent: '' },
    ad_organizationPrevious: { disabled: false },
    ad_organizationNext: { disabled: false },
    ad_organizationPageLabel: { textContent: '' },
    ad_organizationMemberPrevious: { disabled: false },
    ad_organizationMemberNext: { disabled: false },
    ad_organizationMemberPageLabel: { textContent: '' }
  };
  const calls = [];
  const context = loadFunctions({
    adminSelectedOrganizationId: null,
    adminOrganizationsById: {},
    adminOrganizationLoadSequence: 0,
    adminOrganizationMemberLoadSequence: 0,
    adminOrganizationPageCursors: [null],
    adminOrganizationPageIndex: 0,
    adminOrganizationNextCursor: null,
    adminOrganizationPageLoading: false,
    adminOrganizationFilterSignature: '',
    adminOrganizationMemberPageCursors: [null],
    adminOrganizationMemberPageIndex: 0,
    adminOrganizationMemberNextCursor: null,
    adminOrganizationMemberPageLoading: false,
    adminOrganizationMemberFilterSignature: '',
    document: { getElementById(id) { return elements[id] || null; } },
    encodeURIComponent,
    esc,
    Promise,
    Error,
    apiFetch(url) {
      calls.push(url);
      if (url.startsWith('/organization-governance/organizations/10/members')) {
        return Promise.resolve(response(200, {
          organization: { id: 10, code: 'alpha', name: 'Alpha <Market>' },
          members: [{
            user_id: 2,
            username: 'alice<script>',
            display_name: 'Alice & Co',
            department: 'Sales',
            platform_role: 'user',
            organization_role: 'member',
            membership_status: 'active',
            teams: [{ id: 101, code: 'sales', name: 'Sales <A>', role_code: 'team_lead', status: 'active' }]
          }],
          page: { limit: 50, next_cursor: null, has_more: false }
        }));
      }
      return Promise.resolve(response(200, {
        organizations: [{
          id: 10,
          code: 'alpha',
          name: 'Alpha <Market>',
          team_count: 2,
          active_member_count: 3,
          revoked_member_count: 1
        }],
        page: { limit: 50, next_cursor: null, has_more: false }
      }));
    }
  }, [
    'buildAdminOrganizationQuery',
    'buildAdminOrganizationMemberQuery',
    'renderAdminOrganizations',
    'adminGovernanceRoleLabel',
    'effectiveAdminOrganizationMemberRole',
    'renderAdminOrganizationMembers',
    'updateAdminOrganizationPager',
    'updateAdminOrganizationMemberPager',
    'loadAdminOrganizations',
    'selectAdminOrganization',
    'loadAdminOrganizationMembers',
    'adminOrganizationNextPage',
    'adminOrganizationPreviousPage',
    'adminOrganizationMemberNextPage',
    'adminOrganizationMemberPreviousPage'
  ]);

  await context.loadAdminOrganizations();
  assert.match(calls[0], /^\/organization-governance\/organizations\?/);
  assert.match(elements.ad_organizationList.innerHTML, /Alpha &lt;Market&gt;/);
  assert.doesNotMatch(elements.ad_organizationList.innerHTML, /Alpha <Market>/);
  assert.equal(context.adminSelectedOrganizationId, 10);
  assert.match(calls[1], /^\/organization-governance\/organizations\/10\/members\?/);
  assert.match(elements.ad_organizationMembers.innerHTML, /alice&lt;script&gt;/);
  assert.match(elements.ad_organizationMembers.innerHTML, /Sales &lt;A&gt;/);
  assert.doesNotMatch(elements.ad_organizationMembers.innerHTML, /<script>/i);
  assert.equal(elements.ad_selectedOrganizationName.textContent, 'Alpha <Market>');
});

test('organization and member paging controls request every cursor and can return to the first page', async () => {
  const elements = {
    ad_organizationSearch: { value: '' },
    ad_organizationList: { innerHTML: '' },
    ad_organizationMemberSearch: { value: '' },
    ad_organizationMemberStatus: { value: '' },
    ad_organizationMembers: { innerHTML: '' },
    ad_selectedOrganizationName: { textContent: '' },
    ad_organizationPrevious: { disabled: false },
    ad_organizationNext: { disabled: false },
    ad_organizationPageLabel: { textContent: '' },
    ad_organizationMemberPrevious: { disabled: false },
    ad_organizationMemberNext: { disabled: false },
    ad_organizationMemberPageLabel: { textContent: '' }
  };
  const calls = [];
  let delayOrganizationPage = false;
  let rejectOrganizationPage = false;
  let releaseOrganizationPage = null;
  let delayMemberPage = false;
  let rejectMemberPage = false;
  let releaseMemberPage = null;
  const context = loadFunctions({
    adminSelectedOrganizationId: null,
    adminOrganizationsById: {},
    adminOrganizationLoadSequence: 0,
    adminOrganizationMemberLoadSequence: 0,
    adminOrganizationPageCursors: [null],
    adminOrganizationPageIndex: 0,
    adminOrganizationNextCursor: null,
    adminOrganizationPageLoading: false,
    adminOrganizationFilterSignature: '',
    adminOrganizationMemberPageCursors: [null],
    adminOrganizationMemberPageIndex: 0,
    adminOrganizationMemberNextCursor: null,
    adminOrganizationMemberPageLoading: false,
    adminOrganizationMemberFilterSignature: '',
    document: { getElementById(id) { return elements[id] || null; } },
    encodeURIComponent,
    esc,
    Promise,
    Error,
    apiFetch(url) {
      calls.push(url);
      const cursor = new URLSearchParams(url.split('?')[1] || '').get('cursor');
      if (/\/members\?/.test(url)) {
        const memberResponse = response(200, {
          organization: { id: 10, code: 'alpha', name: 'Alpha' },
          members: [{
            user_id: cursor ? 3 : 2,
            username: cursor ? 'bob' : 'alice',
            display_name: cursor ? 'Bob' : 'Alice',
            platform_role: 'user',
            organization_role: 'member',
            membership_status: 'active',
            teams: []
          }],
          page: cursor
            ? { limit: 50, next_cursor: null, has_more: false }
            : { limit: 50, next_cursor: 2, has_more: true }
        });
        if (cursor && rejectMemberPage) {
          rejectMemberPage = false;
          return Promise.resolve(response(503, { error: 'temporary member failure' }));
        }
        if (cursor && delayMemberPage) {
          delayMemberPage = false;
          return new Promise((resolve) => { releaseMemberPage = () => resolve(memberResponse); });
        }
        return Promise.resolve(memberResponse);
      }
      const organizationResponse = response(200, {
        organizations: [{
          id: cursor ? 20 : 10,
          code: cursor ? 'beta' : 'alpha',
          name: cursor ? 'Beta' : 'Alpha',
          team_count: 1,
          active_member_count: 1,
          revoked_member_count: 0
        }],
        page: cursor
          ? { limit: 50, next_cursor: null, has_more: false }
          : { limit: 50, next_cursor: 10, has_more: true }
      });
      if (cursor && rejectOrganizationPage) {
        rejectOrganizationPage = false;
        return Promise.resolve(response(503, { error: 'temporary failure' }));
      }
      if (cursor && delayOrganizationPage) {
        delayOrganizationPage = false;
        return new Promise((resolve) => { releaseOrganizationPage = () => resolve(organizationResponse); });
      }
      return Promise.resolve(organizationResponse);
    }
  }, [
    'buildAdminOrganizationQuery',
    'buildAdminOrganizationMemberQuery',
    'renderAdminOrganizations',
    'adminGovernanceRoleLabel',
    'effectiveAdminOrganizationMemberRole',
    'renderAdminOrganizationMembers',
    'updateAdminOrganizationPager',
    'updateAdminOrganizationMemberPager',
    'loadAdminOrganizations',
    'selectAdminOrganization',
    'loadAdminOrganizationMembers',
    'adminOrganizationNextPage',
    'adminOrganizationPreviousPage',
    'adminOrganizationMemberNextPage',
    'adminOrganizationMemberPreviousPage'
  ]);

  await context.loadAdminOrganizations();
  assert.equal(elements.ad_organizationPrevious.disabled, true);
  assert.equal(elements.ad_organizationNext.disabled, false);
  assert.equal(elements.ad_organizationPageLabel.textContent, '第 1 页');

  delayMemberPage = true;
  const memberCallsBefore = calls.filter((url) => /\/members\?/.test(url)).length;
  const nextMemberPage = context.adminOrganizationMemberNextPage();
  const duplicateNextMemberPage = context.adminOrganizationMemberNextPage();
  assert.equal(calls.filter((url) => /\/members\?/.test(url)).length, memberCallsBefore + 1);
  await duplicateNextMemberPage;
  releaseMemberPage();
  await nextMemberPage;
  assert.match(calls[calls.length - 1], /\/members\?[^#]*cursor=2/);
  await context.adminOrganizationMemberPreviousPage();
  assert.doesNotMatch(calls[calls.length - 1], /cursor=/);

  rejectMemberPage = true;
  await context.adminOrganizationMemberNextPage();
  assert.equal(elements.ad_organizationMemberPageLabel.textContent, '第 1 页');
  assert.equal(elements.ad_organizationMemberPrevious.disabled, true);
  assert.equal(elements.ad_organizationMemberNext.disabled, false);

  elements.ad_organizationMemberSearch.value = 'finance';
  await context.adminOrganizationMemberNextPage();
  const memberCalls = calls.filter((url) => /\/members\?/.test(url));
  assert.match(memberCalls[memberCalls.length - 1], /q=finance/);
  assert.doesNotMatch(memberCalls[memberCalls.length - 1], /cursor=/);
  assert.equal(elements.ad_organizationMemberPageLabel.textContent, '第 1 页');
  elements.ad_organizationMemberSearch.value = '';

  delayOrganizationPage = true;
  const organizationCallsBefore = calls.filter((url) => /^\/organization-governance\/organizations\?/.test(url)).length;
  const nextPage = context.adminOrganizationNextPage();
  const duplicateNextPage = context.adminOrganizationNextPage();
  assert.equal(calls.filter((url) => /^\/organization-governance\/organizations\?/.test(url)).length, organizationCallsBefore + 1);
  await duplicateNextPage;
  releaseOrganizationPage();
  await nextPage;
  assert.match(calls.find((url) => /\/organization-governance\/organizations\?[^#]*cursor=10/.test(url)), /cursor=10/);
  assert.equal(elements.ad_organizationPageLabel.textContent, '第 2 页');
  await context.adminOrganizationPreviousPage();
  assert.equal(calls[calls.length - 2].includes('/organization-governance/organizations?limit=50'), true);
  assert.equal(elements.ad_organizationPageLabel.textContent, '第 1 页');

  rejectOrganizationPage = true;
  await context.adminOrganizationNextPage();
  assert.equal(elements.ad_organizationPageLabel.textContent, '第 1 页');
  assert.equal(elements.ad_organizationPrevious.disabled, true);
  assert.equal(elements.ad_organizationNext.disabled, false);

  elements.ad_organizationSearch.value = 'new filter';
  await context.adminOrganizationNextPage();
  const organizationCalls = calls.filter((url) => /^\/organization-governance\/organizations\?/.test(url));
  assert.match(organizationCalls[organizationCalls.length - 1], /q=new%20filter/);
  assert.doesNotMatch(organizationCalls[organizationCalls.length - 1], /cursor=/);
  assert.equal(elements.ad_organizationPageLabel.textContent, '第 1 页');
});

test('organization governance renders authoritative roles and persists only server-approved member changes', async () => {
  const governanceSource = indexSource + '\n' + appSource;
  for (const text of [
    '企业所有者',
    '组织管理员',
    '经理',
    '成员',
    '只读',
    '此成员只能查看已获授权的数据，不能提交或修改任何业务内容。'
  ]) {
    assert.match(governanceSource, new RegExp(text));
  }
  assert.match(indexSource, /class=["'][^"']*platform-admin-only/);
  assert.match(indexSource, /id=["']ad_readOnlyBanner["']/);

  const elements = {
    ad_organizationMembers: { innerHTML: '' },
    ad_memberRole_2: { value: 'read_only' },
    ad_memberStatus_2: { value: 'active' }
  };
  const calls = [];
  let refreshes = 0;
  const context = loadFunctions({
    adminSelectedOrganizationId: 10,
    document: { getElementById(id) { return elements[id] || null; } },
    esc,
    Promise,
    Error,
    JSON,
    toast() {},
    loadAdminOrganizationMembers() {
      refreshes += 1;
      return Promise.resolve([]);
    },
    apiFetch(url, options) {
      calls.push({ url, options });
      return Promise.resolve(response(200, { success: true }));
    }
  }, [
    'adminGovernanceRoleLabel',
    'effectiveAdminOrganizationMemberRole',
    'renderAdminOrganizationMembers',
    'saveAdminOrganizationMember'
  ]);

  context.renderAdminOrganizationMembers([{
    user_id: 2,
    username: 'alice<script>',
    display_name: 'Alice & Co',
    department: 'Sales',
    platform_role: 'user',
    organization_role: 'member',
    membership_status: 'active',
    access_mode: 'read_write',
    effective_role: 'manager',
    is_company_owner: false,
    allowed_actions: {
      change_role: true,
      change_status: true,
      initialize_owner: false,
      transfer_owner: true
    },
    teams: [{ id: 101, code: 'sales', name: 'Sales <A>', role_code: 'team_lead', status: 'active' }]
  }, {
    user_id: 1,
    username: 'derrick',
    display_name: 'Derrick',
    department: 'Management',
    platform_role: 'admin',
    organization_role: 'org_admin',
    membership_status: 'active',
    access_mode: 'read_write',
    effective_role: 'company_owner',
    is_company_owner: true,
    allowed_actions: {
      change_role: false,
      change_status: false,
      initialize_owner: false,
      transfer_owner: false
    },
    teams: []
  }]);

  assert.match(elements.ad_organizationMembers.innerHTML, /Alice &amp; Co/);
  assert.match(elements.ad_organizationMembers.innerHTML, /alice&lt;script&gt;/);
  assert.match(elements.ad_organizationMembers.innerHTML, /Sales &lt;A&gt;/);
  assert.match(elements.ad_organizationMembers.innerHTML, /id="ad_memberRole_2"/);
  assert.match(elements.ad_organizationMembers.innerHTML, />经理<\/option>/);
  assert.match(elements.ad_organizationMembers.innerHTML, /企业所有者/);
  assert.match(elements.ad_organizationMembers.innerHTML, /openAdminOrganizationOwnerTransfer\(2\)/);
  assert.doesNotMatch(elements.ad_organizationMembers.innerHTML, /id="ad_memberRole_1"/);

  await context.saveAdminOrganizationMember(2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/organization-governance/organizations/10/members/2');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    access_role: 'read_only',
    membership_status: 'active'
  });
  assert.equal(refreshes, 1);
});

test('ownership transfer confirmation posts the authority snapshot and handles self-transfer reauthentication', async () => {
  const elements = {
    ad_ownerTransferReason: { value: 'Transfer regional operating responsibility' },
    ad_ownerTransferConfirmation: { value: 'administrator' },
    ad_ownerTransferSubmit: { disabled: true },
    ad_ownerTransferStatus: { textContent: '' }
  };
  const calls = [];
  const messages = [];
  let closed = 0;
  let reauthenticated = 0;
  const context = loadFunctions({
    adminOwnerTransferSnapshot: {
      organizationId: 20,
      expectedOwnerUserId: 2,
      expectedVersion: 1,
      targetUserId: 3,
      targetUsername: 'administrator'
    },
    adminOwnerTransferSubmitting: false,
    CURRENT_USER: { id: 2, role: 'user' },
    document: { getElementById(id) { return elements[id] || null; } },
    Promise,
    Error,
    JSON,
    String,
    Number,
    toast(message) { messages.push(message); },
    closeAdminOrganizationOwnerTransfer() { closed += 1; },
    handleAuthExpired() { reauthenticated += 1; },
    loadAdminOrganizations() { throw new Error('self-transfer must not refresh with a revoked session'); },
    apiFetch(url, options) {
      calls.push({ url, options });
      return Promise.resolve(response(200, {
        success: true,
        transfer: {
          changed: true,
          organization_id: 20,
          previous_owner_user_id: 2,
          owner: {
            user_id: 3,
            username: 'administrator',
            display_name: 'Organization Admin',
            version: 2
          },
          reauthentication_required: true
        }
      }));
    }
  }, [
    'updateAdminOrganizationOwnerTransferSubmit',
    'submitAdminOrganizationOwnerTransfer'
  ]);

  assert.equal(context.updateAdminOrganizationOwnerTransferSubmit(), true);
  assert.equal(elements.ad_ownerTransferSubmit.disabled, false);
  const result = await context.submitAdminOrganizationOwnerTransfer();
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/organization-governance/organizations/20/owner/transfer');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    new_owner_user_id: 3,
    expected_owner_user_id: 2,
    expected_version: 1,
    confirmation_username: 'administrator',
    reason: 'Transfer regional operating responsibility'
  });
  assert.equal(closed, 1);
  assert.equal(reauthenticated, 1);
  assert.deepEqual(messages, ['企业所有权已转移']);
});

test('platform-admin ownership transfer refreshes the organization projection without forcing reauthentication', async () => {
  const elements = {
    ad_ownerTransferReason: { value: 'Transfer regional operating responsibility' },
    ad_ownerTransferConfirmation: { value: 'administrator' },
    ad_ownerTransferSubmit: { disabled: true },
    ad_ownerTransferStatus: { textContent: '' }
  };
  let refreshes = 0;
  let reauthenticated = 0;
  const context = loadFunctions({
    adminOwnerTransferSnapshot: {
      organizationId: 20,
      expectedOwnerUserId: 2,
      expectedVersion: 1,
      targetUserId: 3,
      targetUsername: 'administrator'
    },
    adminOwnerTransferSubmitting: false,
    document: { getElementById(id) { return elements[id] || null; } },
    Promise,
    Error,
    JSON,
    String,
    Number,
    toast() {},
    closeAdminOrganizationOwnerTransfer() {},
    handleAuthExpired() { reauthenticated += 1; },
    async loadAdminOrganizations() { refreshes += 1; },
    apiFetch() {
      return Promise.resolve(response(200, {
        success: true,
        transfer: { reauthentication_required: false }
      }));
    }
  }, [
    'updateAdminOrganizationOwnerTransferSubmit',
    'submitAdminOrganizationOwnerTransfer'
  ]);

  assert.equal(await context.submitAdminOrganizationOwnerTransfer(), true);
  assert.equal(refreshes, 1);
  assert.equal(reauthenticated, 0);
});

test('ownership transfer confirmation remains disabled until reason and exact username are present', () => {
  const elements = {
    ad_ownerTransferReason: { value: 'short' },
    ad_ownerTransferConfirmation: { value: 'administrator ' },
    ad_ownerTransferSubmit: { disabled: false },
    ad_ownerTransferStatus: { textContent: '' }
  };
  const context = loadFunctions({
    adminOwnerTransferSnapshot: { targetUsername: 'administrator' },
    adminOwnerTransferSubmitting: false,
    document: { getElementById(id) { return elements[id] || null; } },
    String
  }, ['updateAdminOrganizationOwnerTransferSubmit']);

  assert.equal(context.updateAdminOrganizationOwnerTransferSubmit(), false);
  assert.equal(elements.ad_ownerTransferSubmit.disabled, true);
  assert.match(elements.ad_ownerTransferStatus.textContent, /至少 8 个字符/);

  elements.ad_ownerTransferReason.value = 'Transfer operating responsibility';
  assert.equal(context.updateAdminOrganizationOwnerTransferSubmit(), false);
  assert.match(elements.ad_ownerTransferStatus.textContent, /完整输入目标账号/);

  elements.ad_ownerTransferConfirmation.value = 'administrator';
  assert.equal(context.updateAdminOrganizationOwnerTransferSubmit(), true);
  assert.equal(elements.ad_ownerTransferSubmit.disabled, false);
});

test('failed organization governance writes keep the current member projection on screen', async () => {
  const elements = {
    ad_memberRole_2: { value: 'administrator' },
    ad_memberStatus_2: { value: 'active' }
  };
  let refreshes = 0;
  const messages = [];
  const context = loadFunctions({
    adminSelectedOrganizationId: 10,
    document: { getElementById(id) { return elements[id] || null; } },
    Promise,
    Error,
    JSON,
    toast(message) { messages.push(message); },
    loadAdminOrganizationMembers() {
      refreshes += 1;
      return Promise.resolve([]);
    },
    apiFetch() {
      return Promise.resolve(response(403, {
        error: '你只能管理本组织的成员和角色。',
        code: 'ORGANIZATION_GOVERNANCE_FORBIDDEN'
      }));
    }
  }, ['saveAdminOrganizationMember']);

  await context.saveAdminOrganizationMember(2);
  assert.equal(refreshes, 0);
  assert.deepEqual(messages, ['你只能管理本组织的成员和角色。']);
});
