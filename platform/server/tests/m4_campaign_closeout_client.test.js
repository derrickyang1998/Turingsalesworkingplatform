'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', '..', 'app.js');
const indexPath = path.join(__dirname, '..', '..', 'index.html');
const appSource = fs.readFileSync(appPath, 'utf8');
const indexSource = fs.readFileSync(indexPath, 'utf8');

function extractFunction(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const match = declaration.exec(source);
  assert.ok(match, `${name} must exist`);
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

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function element(initial) {
  return Object.assign({
    value: '',
    textContent: '',
    title: '',
    disabled: false,
    hidden: false
  }, initial || {});
}

function createContext(options) {
  const requests = [];
  const toasts = [];
  let closed = 0;
  let loads = 0;
  let operation = 0;
  const campaign = {
    id: 91,
    name: 'Autumn launch',
    product_name: 'Portable power station',
    lifecycle_state: 'settled',
    operational_status: 'active',
    row_version: 7,
    currency: 'USD',
    customer: { id: 31, label: 'Northstar Energy' },
    owner: { id: 9, label: 'Mina Chen' }
  };
  const elements = {
    m4CampaignContext: element({ value: '91' }),
    m4CampaignContextStatus: element(),
    m4CampaignReviewAction: element(),
    m4CampaignCloseoutTitle: element({ value: 'Autumn launch 项目复盘' }),
    m4CampaignCloseoutSummary: element({ value: '项目按目标完成，核心内容效率高于基准。' }),
    m4CampaignCloseoutOutcomes: element({ value: '完成两条内容交付并形成稳定曝光。' }),
    m4CampaignCloseoutMethods: element({ value: '前三秒展示真实使用场景，保留达人原生表达。' }),
    m4CampaignCloseoutIssues: element({ value: '首版 CTA 较弱，原因是产品利益点出现过晚。' }),
    m4CampaignCloseoutActions: element({ value: '下一轮复用场景钩子，并在十五秒内前置 CTA。' }),
    m4CampaignCloseoutReportRef: element({ value: '客户复盘报告 v3' }),
    m4CampaignCloseoutVisibility: element({ value: 'team' }),
    m4CampaignCloseoutSubmit: element()
  };
  const context = {
    console,
    JSON,
    Number,
    String,
    Object,
    Array,
    Math,
    Promise,
    window: null,
    globalThis: null,
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    getActiveCampaignId() { return 91; },
    readPositiveInteger(value) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    },
    createDemandAnalysisOperationId(prefix) {
      operation += 1;
      return `${prefix}${operation}`;
    },
    toast(message, tone) { toasts.push({ message, tone }); },
    closeM4CampaignCloseoutReview() { closed += 1; },
    async loadM4Campaigns() {
      loads += 1;
      if (options && options.reviewAlreadyLinked) campaign.row_version = 8;
      context.m4Campaigns = [campaign];
      return [campaign];
    },
    renderM4CampaignContext() {},
    async apiFetch(url, requestOptions) {
      requests.push({ url, options: requestOptions || {} });
      if (url === '/campaigns/91/reviews') {
        if (options && options.reviewAlreadyLinked) {
          return jsonResponse(409, {
            code: 'RECORD_ALREADY_LINKED',
            error: 'Campaign review is already linked.'
          });
        }
        campaign.row_version = 8;
        return jsonResponse(201, { campaign: Object.assign({}, campaign), entry: { id: 501 } });
      }
      if (url === '/campaigns/91/transitions') {
        campaign.lifecycle_state = 'reviewed';
        campaign.row_version = 9;
        return jsonResponse(200, { campaign: Object.assign({}, campaign) });
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext([
    'var m4Campaigns = [];',
    'var m4CampaignContextId = null;',
    'var lastCollabRows = [];',
    'var m4CampaignCloseoutOperation = null;',
    'var m4CampaignCloseoutInFlight = null;'
  ].join('\n'), context);
  return { context, campaign, elements, requests, toasts, getClosed: () => closed, getLoads: () => loads };
}

function loadFunctions(context, names) {
  for (const name of names) vm.runInContext(extractFunction(appSource, name), context);
}

test('M4 campaign context exposes one closeout review command on the existing page', () => {
  assert.match(indexSource, /id="m4CampaignReviewAction"/);
  assert.match(indexSource, /onclick="openM4CampaignCloseoutReview\(\)"/);
});

test('campaign closeout action is enabled only for an active settled campaign', () => {
  const { context, campaign } = createContext();
  loadFunctions(context, ['m4CampaignCloseoutActionState']);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.m4CampaignCloseoutActionState(campaign))),
    { enabled: true, label: '结案复盘', hint: '归档复盘并完成项目结案' }
  );
  campaign.lifecycle_state = 'reviewed';
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.m4CampaignCloseoutActionState(campaign))),
    { enabled: false, label: '复盘已归档', hint: '该活动已经完成结案复盘' }
  );
  campaign.lifecycle_state = 'published';
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.m4CampaignCloseoutActionState(campaign))),
    { enabled: false, label: '结算后复盘', hint: '活动完成结算后才可归档复盘' }
  );
});

test('human-confirmed closeout archives structured knowledge before advancing the campaign', async () => {
  const fixture = createContext();
  const { context, requests, elements, campaign } = fixture;
  loadFunctions(context, [
    'getM4CampaignId',
    'getM4CampaignById',
    'm4CampaignLabel',
    'm4CampaignCloseoutActionState',
    'm4OperationId',
    'm4PaymentSettlement',
    'm4CampaignCloseoutSnapshot',
    'm4CampaignCloseoutContent',
    'submitM4CampaignCloseoutReview'
  ]);
  context.m4Campaigns = [campaign];
  context.lastCollabRows = [
    {
      id: 701,
      campaign_id: 91,
      status: 'completed',
      payment_reference: 'MUST-NOT-ARCHIVE',
      payment_settlement: {
        status: 'approved',
        currency: 'USD',
        creator_payment_total: 800,
        client_receipt_total: 1200
      }
    },
    { id: 702, campaign_id: 91, status: 'completed', payment_settlement: { status: 'not_submitted' } }
  ];

  await context.submitM4CampaignCloseoutReview();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/campaigns/91/reviews');
  assert.equal(requests[1].url, '/campaigns/91/transitions');
  const reviewBody = JSON.parse(requests[0].options.body);
  const transitionBody = JSON.parse(requests[1].options.body);
  assert.equal(reviewBody.expected_version, 7);
  assert.equal(reviewBody.visibility, 'team');
  assert.deepEqual(reviewBody.tags, []);
  assert.match(reviewBody.content, /## 执行快照/);
  assert.match(reviewBody.content, /合作资源：2/);
  assert.match(reviewBody.content, /已结算：1/);
  assert.match(reviewBody.content, /达人付款：USD 800/);
  assert.match(reviewBody.content, /## 可复用方法/);
  assert.match(reviewBody.content, /## 问题与根因/);
  assert.match(reviewBody.content, /客户复盘报告 v3/);
  assert.doesNotMatch(reviewBody.content, /MUST-NOT-ARCHIVE/);
  assert.deepEqual(transitionBody, {
    expected_state: 'settled',
    expected_version: 8,
    next_state: 'reviewed',
    reason: '项目结案复盘已人工确认并归档'
  });
  assert.ok(requests[0].options.headers['Idempotency-Key']);
  assert.ok(requests[1].options.headers['Idempotency-Key']);
  assert.notEqual(
    requests[0].options.headers['Idempotency-Key'],
    requests[1].options.headers['Idempotency-Key']
  );
  assert.equal(elements.m4CampaignCloseoutSubmit.disabled, false);
  assert.equal(fixture.getClosed(), 1);
  assert.equal(fixture.getLoads(), 1);
});

test('an already archived review resumes at the lifecycle transition without duplication', async () => {
  const fixture = createContext({ reviewAlreadyLinked: true });
  const { context, requests, campaign } = fixture;
  loadFunctions(context, [
    'getM4CampaignId',
    'getM4CampaignById',
    'm4CampaignLabel',
    'm4CampaignCloseoutActionState',
    'm4OperationId',
    'm4PaymentSettlement',
    'm4CampaignCloseoutSnapshot',
    'm4CampaignCloseoutContent',
    'submitM4CampaignCloseoutReview'
  ]);
  context.m4Campaigns = [campaign];
  context.lastCollabRows = [];

  await context.submitM4CampaignCloseoutReview();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/campaigns/91/reviews');
  assert.equal(requests[1].url, '/campaigns/91/transitions');
  assert.equal(JSON.parse(requests[1].options.body).expected_version, 8);
  assert.equal(fixture.getLoads(), 2);
  assert.equal(fixture.getClosed(), 1);
});
