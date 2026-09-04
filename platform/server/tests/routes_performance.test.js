'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registerPerformanceRoutes = require('../routes_performance');
const {
  PerformanceManualServiceError,
  PerformanceAiReviewServiceError
} = require('../services/performance_manual_service');
const { PerformanceFeishuConnectionServiceError } = require('../services/performance_feishu_connection_service');
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
    getReviewEvidence(input) {
      calls.push(['review-evidence', input]);
      return {
        contract_version: 'performance-review-evidence-v1',
        campaign_id: 7,
        analysis: { mode: 'metadata_only' },
        rankings: { status: 'insufficient_data', top_contents: [], bottom_contents: [] }
      };
    },
    getDashboard(input) { calls.push(['dashboard', input]); return { records: { total: 0 } }; }
  };
  const feishuConnectionService = {
    getConnection(input) {
      calls.push(['feishu-connection-get', input]);
      return {
        campaign_id: 7,
        active_configuration: null,
        draft_configuration: null,
        capabilities: { can_manage: true, can_approve: false, external_sync_enabled: false },
        external_sync: { enabled: false }
      };
    },
    createDraft(input) {
      calls.push(['feishu-connection-draft', input]);
      return {
        configuration: { id: 11, status: 'draft' },
        capabilities: { can_manage: true, can_approve: false, external_sync_enabled: false },
        external_sync: { enabled: false }
      };
    },
    approveDraft(input) {
      calls.push(['feishu-connection-approve', input]);
      return {
        configuration: { id: 11, status: 'approved' },
        capabilities: { can_manage: true, can_approve: true, external_sync_enabled: false },
        external_sync: { enabled: false }
      };
    }
  };
  const aiReviewService = {
    async createDraft(input) {
      calls.push(['ai-review-draft', input]);
      return {
        contract_version: 'performance-ai-review-draft-v1',
        campaign_id: 7,
        status: 'not_ready',
        reason_code: 'insufficient_comparable_data',
        analysis: { mode: 'metadata_only', web_search: { used: false } },
        draft: null,
        ai: null
      };
    },
    async approveDraft(input) {
      calls.push(['ai-review-approve', input]);
      return {
        contract_version: 'performance-ai-review-approval-v1',
        status: 'confirmed',
        campaign_id: 7,
        conversation_id: 31,
        message_id: 32,
        knowledge_entry_id: 33,
        visibility: 'private',
        evidence_snapshot_hash: 'a'.repeat(64),
        draft_sha256: 'b'.repeat(64),
        final_content_sha256: 'c'.repeat(64)
      };
    }
  };
  registerPerformanceRoutes(app, {
    authMiddleware(_request, _response, next) { next(); },
    service,
    feishuConnectionService,
    aiReviewService
  });
  return { routes, calls, service, feishuConnectionService, aiReviewService };
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

async function invokeAsync(handlers, request) {
  const response = createResponse();
  async function dispatch(index) {
    const handler = handlers[index];
    if (!handler) return;
    await new Promise((resolve, reject) => {
      let advanced = false;
      const next = (error) => {
        advanced = true;
        if (error) {
          reject(error);
          return;
        }
        dispatch(index + 1).then(resolve, reject);
      };
      Promise.resolve(handler(request, response, next)).then(() => {
        if (!advanced) resolve();
      }, reject);
    });
  }
  await dispatch(0);
  return response;
}

test('registers campaign-scoped performance endpoints and forwards authenticated context', () => {
  const { routes, calls } = createFixture();
  assert.deepEqual([...routes.keys()].sort(), [
    'GET /api/campaigns/:id/performance/contents',
    'GET /api/campaigns/:id/performance/contents/export',
    'GET /api/campaigns/:id/performance/dashboard',
    'GET /api/campaigns/:id/performance/feishu-connection',
    'GET /api/campaigns/:id/performance/integration-preview',
    'GET /api/campaigns/:id/performance/review-evidence',
    'POST /api/campaigns/:id/performance/ai-review-draft',
    'POST /api/campaigns/:id/performance/ai-review-draft/approve',
    'POST /api/campaigns/:id/performance/contents',
    'POST /api/campaigns/:id/performance/contents/:contentId/manual-inputs',
    'POST /api/campaigns/:id/performance/feishu-connection',
    'POST /api/campaigns/:id/performance/feishu-connection/approve',
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

test('confirms a campaign-scoped AI review draft through the protected JSON request contract', async () => {
  const { routes, calls, aiReviewService } = createFixture();
  const request = {
    user: { id: 9, role: 'org_admin' },
    params: { id: '7' },
    body: {
      conversation_id: 31,
      message_id: 32,
      expected_snapshot_hash: 'a'.repeat(64),
      edited_draft: 'Reviewed result [PERF-1] [PERF-2]',
      visibility: 'private'
    },
    headers: { 'idempotency-key': 'ai-review-approval-request-key' },
    phase4Request: { requestId: 'ai-review-approval-request-id' }
  };
  const response = await invokeAsync(
    routes.get('POST /api/campaigns/:id/performance/ai-review-draft/approve'),
    request
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'confirmed');
  assert.equal(response.body.request_id, 'ai-review-approval-request-id');
  assert.deepEqual(calls[0], ['ai-review-approve', {
    user: request.user,
    campaignId: '7',
    body: request.body,
    idempotencyKey: 'ai-review-approval-request-key',
    requestId: 'ai-review-approval-request-id'
  }]);

  const policy = campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_AI_REVIEW_APPROVE;
  assert.ok(policy);
  assert.equal(policy.id, 'campaign.performance.ai-review-draft.approve');
  assert.equal(policy.method, 'POST');
  assert.equal(policy.pathTemplate, '/api/campaigns/:id/performance/ai-review-draft/approve');
  assert.equal(policy.mediaKind, campaignContract.MEDIA_KINDS.JSON);

  aiReviewService.approveDraft = async () => {
    throw new PerformanceAiReviewServiceError(
      409,
      'PERFORMANCE_AI_REVIEW_STALE',
      'Performance evidence changed after the AI review draft was generated.'
    );
  };
  const stale = await invokeAsync(
    routes.get('POST /api/campaigns/:id/performance/ai-review-draft/approve'),
    request
  );
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.code, 'PERFORMANCE_AI_REVIEW_STALE');
  assert.equal(stale.body.request_id, 'ai-review-approval-request-id');
});

test('creates a campaign-scoped AI review draft through the protected JSON request contract', async () => {
  const { routes, calls, aiReviewService } = createFixture();
  const request = {
    user: { id: 9, role: 'member' },
    params: { id: '7' },
    body: { top_metric: 'views' },
    headers: { 'idempotency-key': 'ai-review-request-key' },
    phase4Request: { requestId: 'ai-review-request-id' }
  };
  const response = await invokeAsync(routes.get('POST /api/campaigns/:id/performance/ai-review-draft'), request);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'not_ready');
  assert.equal(response.body.request_id, 'ai-review-request-id');
  assert.deepEqual(calls[0], ['ai-review-draft', {
    user: request.user,
    campaignId: '7',
    body: request.body,
    idempotencyKey: 'ai-review-request-key',
    requestId: 'ai-review-request-id'
  }]);

  const policy = campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_AI_REVIEW_DRAFT;
  assert.ok(policy);
  assert.equal(policy.id, 'campaign.performance.ai-review-draft');
  assert.equal(policy.method, 'POST');
  assert.equal(policy.pathTemplate, '/api/campaigns/:id/performance/ai-review-draft');
  assert.equal(policy.mediaKind, campaignContract.MEDIA_KINDS.JSON);

  aiReviewService.createDraft = async () => {
    throw new PerformanceAiReviewServiceError(422, 'PERFORMANCE_AI_REVIEW_INVALID', 'AI review input is invalid.');
  };
  const invalid = await invokeAsync(routes.get('POST /api/campaigns/:id/performance/ai-review-draft'), request);
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.body.code, 'PERFORMANCE_AI_REVIEW_INVALID');
  assert.equal(invalid.body.request_id, 'ai-review-request-id');
});

test('returns campaign-scoped review evidence through a read-only request contract', () => {
  const { routes, calls } = createFixture();
  const response = invoke(routes.get('GET /api/campaigns/:id/performance/review-evidence'), {
    user: { id: 9 },
    params: { id: '7' },
    query: { top_metric: 'core_view_er', ignored: 'value' },
    requestId: 'review-evidence-request'
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.request_id, 'review-evidence-request');
  assert.equal(response.body.analysis.mode, 'metadata_only');
  assert.deepEqual(calls[0], ['review-evidence', {
    userId: 9,
    campaignId: '7',
    query: { top_metric: 'core_view_er' }
  }]);

  const policy = campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_REVIEW_EVIDENCE;
  assert.ok(policy);
  assert.equal(policy.id, 'campaign.performance.review-evidence');
  assert.equal(policy.method, 'GET');
  assert.equal(policy.pathTemplate, '/api/campaigns/:id/performance/review-evidence');
  assert.equal(policy.mediaKind, campaignContract.MEDIA_KINDS.EMPTY);
});

test('routes Feishu projection configuration reads, drafts, and approvals through campaign request contracts', () => {
  const { routes, calls, feishuConnectionService } = createFixture();
  const getResponse = invoke(routes.get('GET /api/campaigns/:id/performance/feishu-connection'), {
    user: { id: 9 },
    params: { id: '7' },
    requestId: 'connection-read'
  });
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.body.external_sync.enabled, false);
  assert.deepEqual(calls[0], ['feishu-connection-get', { userId: 9, campaignId: '7' }]);

  const draftRequest = {
    bitable_app_token: 'bascnPerformanceApp',
    current_table_id: 'tblCurrentState',
    field_mapping: {
      'content.original_url': '视频链接',
      'latest_observation.observed_at': '数据更新时间'
    }
  };
  const draftResponse = invoke(routes.get('POST /api/campaigns/:id/performance/feishu-connection'), {
    user: { id: 9 },
    params: { id: '7' },
    body: draftRequest,
    requestId: 'connection-draft'
  });
  assert.equal(draftResponse.statusCode, 200);
  assert.equal(draftResponse.body.configuration.status, 'draft');
  assert.deepEqual(calls[1], ['feishu-connection-draft', {
    userId: 9,
    campaignId: '7',
    body: draftRequest
  }]);

  const approveResponse = invoke(routes.get('POST /api/campaigns/:id/performance/feishu-connection/approve'), {
    user: { id: 2 },
    params: { id: '7' },
    body: { configuration_id: 11 },
    requestId: 'connection-approve'
  });
  assert.equal(approveResponse.statusCode, 200);
  assert.equal(approveResponse.body.configuration.status, 'approved');
  assert.deepEqual(calls[2], ['feishu-connection-approve', {
    userId: 2,
    campaignId: '7',
    configurationId: 11
  }]);

  for (const [name, id, method, pathTemplate] of [
    ['CAMPAIGN_PERFORMANCE_FEISHU_CONNECTION_GET', 'campaign.performance.feishu-connection.get', 'GET', '/api/campaigns/:id/performance/feishu-connection'],
    ['CAMPAIGN_PERFORMANCE_FEISHU_CONNECTION_DRAFT', 'campaign.performance.feishu-connection.draft', 'POST', '/api/campaigns/:id/performance/feishu-connection'],
    ['CAMPAIGN_PERFORMANCE_FEISHU_CONNECTION_APPROVE', 'campaign.performance.feishu-connection.approve', 'POST', '/api/campaigns/:id/performance/feishu-connection/approve']
  ]) {
    const policy = campaignContract.REQUEST_POLICIES[name];
    assert.ok(policy);
    assert.equal(policy.id, id);
    assert.equal(policy.method, method);
    assert.equal(policy.pathTemplate, pathTemplate);
  }

  feishuConnectionService.createDraft = () => {
    throw new PerformanceFeishuConnectionServiceError(403, 'PERFORMANCE_FEISHU_CONNECTION_MANAGE_FORBIDDEN', 'Feishu connection configuration is not available.');
  };
  const forbidden = invoke(routes.get('POST /api/campaigns/:id/performance/feishu-connection'), {
    user: { id: 3 },
    params: { id: '7' },
    body: draftRequest,
    requestId: 'connection-forbidden'
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.code, 'PERFORMANCE_FEISHU_CONNECTION_MANAGE_FORBIDDEN');
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
