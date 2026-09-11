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
    'ad_organizationMemberPageLabel'
  ]) {
    assert.match(indexSource, new RegExp(`id=["']${id}["']`));
  }
  assert.match(navigationSource, /ADMIN_TABS\s*=\s*\[[^\]]*['"]organizations['"]/);
  assert.match(appSource, /\['overview','users','organizations','knowledge','ai-audit','tokens'\]/);
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
      if (url.startsWith('/admin/organizations/10/members')) {
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
  assert.match(calls[0], /^\/admin\/organizations\?/);
  assert.match(elements.ad_organizationList.innerHTML, /Alpha &lt;Market&gt;/);
  assert.doesNotMatch(elements.ad_organizationList.innerHTML, /Alpha <Market>/);
  assert.equal(context.adminSelectedOrganizationId, 10);
  assert.match(calls[1], /^\/admin\/organizations\/10\/members\?/);
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
  const organizationCallsBefore = calls.filter((url) => /^\/admin\/organizations\?/.test(url)).length;
  const nextPage = context.adminOrganizationNextPage();
  const duplicateNextPage = context.adminOrganizationNextPage();
  assert.equal(calls.filter((url) => /^\/admin\/organizations\?/.test(url)).length, organizationCallsBefore + 1);
  await duplicateNextPage;
  releaseOrganizationPage();
  await nextPage;
  assert.match(calls.find((url) => /\/admin\/organizations\?[^#]*cursor=10/.test(url)), /cursor=10/);
  assert.equal(elements.ad_organizationPageLabel.textContent, '第 2 页');
  await context.adminOrganizationPreviousPage();
  assert.equal(calls[calls.length - 2].includes('/admin/organizations?limit=50'), true);
  assert.equal(elements.ad_organizationPageLabel.textContent, '第 1 页');

  rejectOrganizationPage = true;
  await context.adminOrganizationNextPage();
  assert.equal(elements.ad_organizationPageLabel.textContent, '第 1 页');
  assert.equal(elements.ad_organizationPrevious.disabled, true);
  assert.equal(elements.ad_organizationNext.disabled, false);

  elements.ad_organizationSearch.value = 'new filter';
  await context.adminOrganizationNextPage();
  const organizationCalls = calls.filter((url) => /^\/admin\/organizations\?/.test(url));
  assert.match(organizationCalls[organizationCalls.length - 1], /q=new%20filter/);
  assert.doesNotMatch(organizationCalls[organizationCalls.length - 1], /cursor=/);
  assert.equal(elements.ad_organizationPageLabel.textContent, '第 1 页');
});
