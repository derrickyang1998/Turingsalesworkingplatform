'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registerPerformanceRoutes = require('../routes_performance');
const { PerformanceManualServiceError } = require('../services/performance_manual_service');
const campaignContract = require('../contracts/campaign_contract');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    setHeader(key, value) { this.headers[key] = value; return this; },
    send(value) { this.body = value; return this; }
  };
}

function createFixture() {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }
  };
  const calls = [];
  const service = {
    listContents(input) { calls.push(['list', input]); return { items: [], total: 0 }; },
    createContent(input) { calls.push(['create', input]); return { content: { id: 1 } }; },
    importContentRows(input) { calls.push(['import', input]); return { accepted_count: 1 }; },
    recordManualInput(input) { calls.push(['input', input]); return { observation_id: 1 }; },
    exportContents(input) {
      calls.push(['export', input]);
      return { filename: 'performance_campaign_7_filtered_export.csv', csv: '\ufeff视频链接\r\nhttps://example.test/video\r\n' };
    },
    getIntegrationPreview(input) {
      calls.push(['integration-preview', input]);
      return {
        contract_version: 'performance-integration-preview-v1',
        campaign_id: 7,
        capabilities: { can_view: true },
        data_sources: [],
        feishu: { status: 'preview_only', provider_validation: 'not_attempted', write_attempted: false, field_mapping: [] }
      };
    },
    getDashboard(input) { calls.push(['dashboard', input]); return { records: { total: 0 } }; }
  };
  registerPerformanceRoutes(app, {
    authMiddleware(_request, _response, next) { next(); },
    service
  });
  return { routes, calls, service };
}

function invoke(handlers, request) {
  const response = createResponse();
  let index = 0;
  function next(error) {
    if (error) throw error;
    const handler = handlers[index++];
    if (handler) handler(request, response, next);
  }
  next();
  return response;
}

test('registers campaign-scoped performance endpoints and forwards authenticated context', () => {
  const { routes, calls } = createFixture();
  assert.deepEqual([...routes.keys()].sort(), [
    'GET /api/campaigns/:id/performance/contents',
    'GET /api/campaigns/:id/performance/contents/export',
    'GET /api/campaigns/:id/performance/dashboard',
    'GET /api/campaigns/:id/performance/integration-preview',
    'POST /api/campaigns/:id/performance/contents',
    'POST /api/campaigns/:id/performance/contents/:contentId/manual-inputs',
    'POST /api/campaigns/:id/performance/import'
  ]);

  const request = {
    user: { id: 9 },
    params: { id: '7' },
    query: { q: 'creator', limit: '20' },
    body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    requestId: 'request-1'
  };
  const response = invoke(routes.get('POST /api/campaigns/:id/performance/contents'), request);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { content: { id: 1 }, request_id: 'request-1' });
  assert.deepEqual(calls[0], ['create', {
    userId: 9,
    campaignId: '7',
    body: request.body
  }]);
});

test('returns integration previews through the campaign request contract without a body', () => {
  const { routes, calls } = createFixture();
  const response = invoke(routes.get('GET /api/campaigns/:id/performance/integration-preview'), {
    user: { id: 9 },
    params: { id: '7' },
    query: { ignored: 'value' },
    requestId: 'request-preview'
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.request_id, 'request-preview');
  assert.equal(response.body.feishu.write_attempted, false);
  assert.deepEqual(calls[0], ['integration-preview', { userId: 9, campaignId: '7' }]);

  const policy = campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_INTEGRATION_PREVIEW;
  assert.ok(policy);
  assert.equal(policy.id, 'campaign.performance.integration-preview');
  assert.equal(policy.method, 'GET');
  assert.equal(policy.pathTemplate, '/api/campaigns/:id/performance/integration-preview');
  assert.equal(policy.mediaKind, campaignContract.MEDIA_KINDS.EMPTY);

  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_INTEGRATION_PREVIEW'/);
});

test('returns known performance errors with a stable request identifier', () => {
  const { routes, service } = createFixture();
  service.getDashboard = () => {
    throw new PerformanceManualServiceError(403, 'PERFORMANCE_FORBIDDEN', 'Performance access is forbidden.');
  };
  const response = invoke(routes.get('GET /api/campaigns/:id/performance/dashboard'), {
    user: { id: 9 },
    params: { id: '7' },
    query: {},
    phase4Request: { requestId: 'phase4-request' }
  });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, {
    error: 'Performance access is forbidden.',
    code: 'PERFORMANCE_FORBIDDEN',
    request_id: 'phase4-request'
  });
});

test('streams scoped performance CSV exports without serializing the CSV as JSON', () => {
  const { routes, calls } = createFixture();
  const response = invoke(routes.get('GET /api/campaigns/:id/performance/contents/export'), {
    user: { id: 9 },
    params: { id: '7' },
    query: { q: 'creator', tag: 'launch', scope: 'filtered' },
    requestId: 'request-export'
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'text/csv;charset=utf-8');
  assert.equal(response.headers['Content-Disposition'], 'attachment; filename="performance_campaign_7_filtered_export.csv"');
  assert.match(response.body, /^\ufeff视频链接/);
  assert.deepEqual(calls[0], ['export', {
    userId: 9,
    campaignId: '7',
    scope: 'filtered',
    query: { q: 'creator', tag: 'launch' }
  }]);
});
