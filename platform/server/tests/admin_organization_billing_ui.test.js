'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');

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

function element(properties = {}) {
  return Object.assign({
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    innerHTML: '',
    textContent: '',
    style: {},
    attributes: {},
    focusCount: 0,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    focus() { this.focusCount += 1; }
  }, properties);
}

function documentFixture(elements) {
  return {
    getElementById(id) { return elements[id] || null; }
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function directoryBilling(overrides = {}) {
  return Object.assign({
    month: '2026-09',
    status: 'estimated',
    billing_enabled: true,
    currency: 'USD',
    policy_version: 3,
    policy_head_version: 4,
    effective_month: '2026-09-01',
    base_fee_cents: 2500,
    included_tokens: 1000000,
    overage_cents_per_million_tokens: 400
  }, overrides);
}

function billingProjection(overrides = {}) {
  return Object.assign({
    organization_id: 10,
    month: '2026-08',
    status: 'closable',
    policy: {
      policy_version: 3,
      effective_month: '2026-08-01',
      billing_enabled: true,
      currency: 'USD',
      base_fee_cents: 2500,
      included_tokens: 1000000,
      overage_cents_per_million_tokens: 500
    },
    usage: { total_tokens: 1500000, billable_tokens: 500000 },
    charges: { base_fee_cents: 2500, overage_fee_cents: 250, total_cents: 2750 },
    statement: null
  }, overrides);
}

class FixedDate extends Date {
  constructor(value) {
    super(value === undefined ? '2026-09-21T00:00:00.000Z' : value);
  }

  static now() {
    return new Date('2026-09-21T00:00:00.000Z').getTime();
  }
}

test('organization directory renders a compact billing summary and permission-gated cents editor', () => {
  const elements = { ad_organizationList: element() };
  const context = loadFunctions({
    document: documentFixture(elements),
    adminOrganizationsById: {},
    adminOrganizationBillingHistoryById: {},
    adminPlanCatalog: [],
    esc,
    Date: FixedDate
  }, [
    'adminBillingMonth',
    'formatAdminBillingInteger',
    'formatAdminBillingUsdCents',
    'adminBillingStatusLabel',
    'renderAdminOrganizationBillingCell',
    'renderAdminOrganizations'
  ]);

  context.renderAdminOrganizations([
    {
      id: 10,
      code: 'alpha',
      name: 'Alpha',
      team_count: 2,
      active_member_count: 4,
      revoked_member_count: 1,
      billing: directoryBilling(),
      allowed_actions: { manage_billing: true }
    },
    {
      id: 20,
      code: 'beta',
      name: 'Beta',
      team_count: 1,
      active_member_count: 2,
      revoked_member_count: 0,
      billing: directoryBilling({ status: 'disabled', billing_enabled: false, total_tokens: 0, estimated_total_cents: 0 }),
      allowed_actions: { manage_billing: false }
    }
  ]);

  const html = elements.ad_organizationList.innerHTML;
  assert.match(html, /<th>账单<\/th>/);
  assert.match(html, /预估/);
  assert.match(html, /策略 v3/);
  assert.doesNotMatch(html, /USD 123\.45/);
  assert.doesNotMatch(html, /1,250,000 Token/);
  assert.match(html, /id="ad_organizationBillingToggle_10"/);
  assert.match(html, /id="ad_organizationBillingEditor_10"[^>]*hidden/);
  assert.match(html, /基础费（美分）/);
  assert.match(html, /超额费率（美分\/百万 Token）/);
  assert.match(html, /id="ad_organizationBillingBaseFeeCents_10"[^>]*step="1"/);
  assert.match(html, /已结束月份/);
  assert.doesNotMatch(html, /id="ad_organizationBillingToggle_20"/);
});

test('billing month helper rolls across years and Escape closes the compact editor', () => {
  const trigger = element({ attributes: { 'aria-expanded': 'true' } });
  const editor = element({ hidden: false });
  const elements = {
    ad_organizationBillingToggle_10: trigger,
    ad_organizationBillingEditor_10: editor
  };
  const context = loadFunctions({ document: documentFixture(elements) }, [
    'adminBillingMonth',
    'closeAdminOrganizationBillingEditor',
    'handleAdminOrganizationBillingKeydown'
  ]);

  assert.equal(context.adminBillingMonth(1, new Date('2026-12-15T00:00:00Z')), '2027-01');
  assert.equal(context.adminBillingMonth(-1, new Date('2026-01-15T00:00:00Z')), '2025-12');

  let prevented = false;
  let stopped = false;
  const closed = context.handleAdminOrganizationBillingKeydown({
    key: 'Escape',
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; }
  }, 10);
  assert.equal(closed, true);
  assert.equal(editor.hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger.focusCount, 1);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test('billing policy save sends the exact integer-cents next-month contract', async () => {
  const calls = [];
  const elements = {
    ad_organizationBillingEnabled_10: element({ checked: true }),
    ad_organizationBillingBaseFeeCents_10: element({ value: '2500' }),
    ad_organizationBillingIncludedTokens_10: element({ value: '1000000' }),
    ad_organizationBillingOverageCentsPerMillion_10: element({ value: '300' }),
    ad_organizationBillingEffectiveMonth_10: element({ value: '2026-10' }),
    ad_organizationBillingPolicySave_10: element()
  };
  let refreshes = 0;
  const context = loadFunctions({
    Date: FixedDate,
    document: documentFixture(elements),
    adminOrganizationsById: {
      10: {
        billing: directoryBilling(),
        allowed_actions: { manage_billing: true }
      }
    },
    prompt() { return 'Approved October pricing'; },
    toast() {},
    async apiFetch(url, options) {
      calls.push({ url, options });
      return response(200, { success: true, billing: { policy: { policy_version: 4 } } });
    },
    async loadAdminOrganizations() { refreshes += 1; }
  }, ['adminBillingMonth', 'readAdminBillingIntegerInput', 'saveAdminOrganizationBillingPolicy']);

  assert.equal(await context.saveAdminOrganizationBillingPolicy(10), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/admin/organizations/10/billing-policy');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    billing_enabled: true,
    base_fee_cents: 2500,
    included_tokens: 1000000,
    overage_cents_per_million_tokens: 300,
    effective_month: '2026-10',
    expected_version: 4,
    reason: 'Approved October pricing'
  });
  assert.equal(refreshes, 1);
});

test('billing policy editor rejects decimal cents before making a request', async () => {
  const messages = [];
  const elements = {
    ad_organizationBillingEnabled_10: element({ checked: true }),
    ad_organizationBillingBaseFeeCents_10: element({ value: '12.5' }),
    ad_organizationBillingIncludedTokens_10: element({ value: '1000000' }),
    ad_organizationBillingOverageCentsPerMillion_10: element({ value: '300' }),
    ad_organizationBillingEffectiveMonth_10: element({ value: '2026-10' }),
    ad_organizationBillingPolicySave_10: element()
  };
  const context = loadFunctions({
    Date: FixedDate,
    document: documentFixture(elements),
    adminOrganizationsById: {
      10: { billing: directoryBilling(), allowed_actions: { manage_billing: true } }
    },
    prompt() { assert.fail('invalid cents must be rejected before asking for a reason'); },
    toast(message, type) { messages.push([message, type]); },
    apiFetch() { assert.fail('invalid cents must not reach the API'); },
    loadAdminOrganizations() {}
  }, ['adminBillingMonth', 'readAdminBillingIntegerInput', 'saveAdminOrganizationBillingPolicy']);

  assert.equal(await context.saveAdminOrganizationBillingPolicy(10), false);
  assert.match(messages[0][0], /基础费.*非负整数/);
  assert.equal(messages[0][1], 'error');
});

test('ended-month query uses the admin billing API and renders a closable projection', async () => {
  const calls = [];
  const projection = billingProjection();
  const elements = {
    ad_organizationBillingHistoryMonth_10: element({ value: '2026-08' }),
    ad_organizationBillingHistoryLoad_10: element(),
    ad_organizationBillingHistoryResult_10: element()
  };
  const context = loadFunctions({
    Date: FixedDate,
    document: documentFixture(elements),
    adminOrganizationsById: {
      10: { billing: directoryBilling(), allowed_actions: { manage_billing: true } }
    },
    adminOrganizationBillingHistoryById: {},
    esc,
    toast() {},
    async apiFetch(url, options) {
      calls.push({ url, options });
      return response(200, { billing: projection });
    }
  }, [
    'adminBillingMonth',
    'formatAdminBillingInteger',
    'formatAdminBillingUsdCents',
    'adminBillingStatusLabel',
    'renderAdminOrganizationBillingProjection',
    'loadAdminOrganizationBillingMonth'
  ]);

  assert.equal(await context.loadAdminOrganizationBillingMonth(10), projection);
  assert.deepEqual(calls, [{
    url: '/admin/organizations/10/billing?month=2026-08',
    options: undefined
  }]);
  const html = elements.ad_organizationBillingHistoryResult_10.innerHTML;
  assert.match(html, /可结账/);
  assert.match(html, /USD 27\.50/);
  assert.match(html, /1,500,000 Token/);
  assert.match(html, /id="ad_organizationBillingClose_10"/);
  assert.equal(context.adminOrganizationBillingHistoryById['10'], projection);
});

test('statement close sends the exact period and policy-version contract', async () => {
  const calls = [];
  const projection = billingProjection();
  const closedProjection = billingProjection({
    status: 'closed',
    statement: { id: 44, policy_version: 3, total_cents: 2750 }
  });
  const elements = {
    ad_organizationBillingClose_10: element(),
    ad_organizationBillingHistoryResult_10: element()
  };
  const context = loadFunctions({
    document: documentFixture(elements),
    adminOrganizationsById: {
      10: { billing: directoryBilling(), allowed_actions: { manage_billing: true } }
    },
    adminOrganizationBillingHistoryById: { 10: projection },
    esc,
    prompt() { return 'Close August usage'; },
    toast() {},
    async apiFetch(url, options) {
      calls.push({ url, options });
      return response(200, { success: true, billing: closedProjection });
    }
  }, [
    'formatAdminBillingInteger',
    'formatAdminBillingUsdCents',
    'adminBillingStatusLabel',
    'renderAdminOrganizationBillingProjection',
    'closeAdminOrganizationBillingStatement'
  ]);

  assert.equal(await context.closeAdminOrganizationBillingStatement(10), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/admin/organizations/10/billing-statements/close');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    period: '2026-08',
    expected_policy_version: 3,
    reason: 'Close August usage'
  });
  assert.match(elements.ad_organizationBillingHistoryResult_10.innerHTML, /已结账/);
  assert.doesNotMatch(elements.ad_organizationBillingHistoryResult_10.innerHTML, /ad_organizationBillingClose_10/);
});
