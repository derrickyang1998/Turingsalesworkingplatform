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
const { CustomerReportSnapshotServiceError } = require('../services/customer_report_snapshot_service');
const { CustomerReportDeliveryServiceError } = require('../services/customer_report_delivery_service');
const { PerformanceCollectionRunServiceError } = require('../services/performance_collection_run_service');
const { PerformanceProviderCollectionServiceError } = require('../services/performance_provider_collection_service');
const campaignContract = require('../contracts/campaign_contract');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    setHeader(key, value) { this.headers[key] = value; return this; },
    send(value) { this.body = value; return this; },
    sendFile(filePath, callback) { this.filePath = filePath; if (callback) callback(); return this; },
    destroy(error) { this.destroyed = error; }
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
    approveManualInput(input) { calls.push(['commercial-approve', input]); return { status: 'approved', manual_input: { id: 12 } }; },
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
    getObservationHistory(input) {
      calls.push(['observation-history', input]);
      return {
        contract_version: 'performance-observation-history-v1',
        campaign_id: 7,
        content_id: 13,
        order: 'observed_at_desc_id_desc',
        items: [],
        page: { limit: 20, has_more: false, next_cursor: null }
      };
    },
    getDashboard(input) { calls.push(['dashboard', input]); return { records: { total: 0 } }; }
  };
  const freshnessService = {
    getQueue(input) {
      calls.push(['freshness-queue', input]);
      return {
        contract_version: 'performance-freshness-queue-v1',
        campaign_id: 7,
        summary: { total: 0, actionable: 0 },
        queue: { total: 0, limit: 100, truncated: false },
        items: [],
        provider: { status: 'not_configured', dispatch_available: false }
      };
    }
  };
  const collectionRunService = {
    listRuns(input) {
      calls.push(['collection-runs', input]);
      const unsupported = Object.keys(input.query || {}).find((key) => key !== 'limit');
      if (unsupported) {
        throw new PerformanceCollectionRunServiceError(
          400,
          'PERFORMANCE_COLLECTION_RUN_QUERY_INVALID',
          'Query contains an unsupported field.',
          { field: unsupported }
        );
      }
      return {
        contract_version: 'performance-collection-runs-v1',
        campaign_id: 7,
        summary: { total: 0, succeeded: 0, partial: 0, failed: 0, latest_completed_at: null },
        items: [],
        page: { limit: 12, returned: 0, has_more: false },
        capabilities: { can_view: true, diagnostics_level: 'summary' }
      };
    }
  };
  const providerCollectionService = {
    getCampaignStatus(input) {
      calls.push(['provider-status', input]);
      return { provider: 'youtube', status: 'ready', dispatch_available: true };
    },
    async runCampaign(input) {
      calls.push(['provider-refresh', input]);
      if (!input.idempotencyKey) {
        throw new PerformanceProviderCollectionServiceError(
          400,
          'PERFORMANCE_PROVIDER_IDEMPOTENCY_KEY_INVALID',
          'A valid Idempotency-Key is required.'
        );
      }
      return {
        contract_version: 'performance-provider-collection-v1',
        replayed: false,
        run: {
          id: 51,
          provider: 'youtube',
          trigger_mode: 'manual',
          status: 'succeeded',
          counts: { total: 1, succeeded: 1, failed: 0 }
        },
        observations: [{ publication_id: 13, provider: 'youtube', metrics: { views: 100 } }]
      };
    }
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
  const feishuProjectionService = {
    preview(input) {
      calls.push(['feishu-projection-preview', input]);
      return {
        contract_version: 'performance-feishu-projection-preview-v1',
        campaign_id: 7,
        snapshot: { source_total: 2, record_count: 1, excluded_without_observation: 1 },
        records: [{ fields: { '视频链接': 'https://example.test/video' } }]
      };
    },
    exportCsv(input) {
      calls.push(['feishu-projection-export', input]);
      return {
        filename: 'performance_campaign_7_feishu_snapshot_2026-09-10.csv',
        csv: '\ufeff视频链接\r\nhttps://example.test/video\r\n',
        record_count: 1
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
  const customerReportSnapshotService = {
    preview(input) {
      calls.push(['customer-report-preview', input]);
      return {
        contract_version: 'customer_safe_v1',
        status: 'preview',
        campaign_id: 7,
        evidence_snapshot_hash: 'd'.repeat(64),
        sections: {}
      };
    },
    seal(input) {
      calls.push(['customer-report-seal', input]);
      return {
        status: 'sealed',
        snapshot: { id: 81, report: { contract_version: 'customer_safe_v1' } }
      };
    },
    list(input) {
      calls.push(['customer-report-list', input]);
      return { contract_version: 'customer_safe_v1', campaign_id: 7, snapshots: [] };
    },
    get(input) {
      calls.push(['customer-report-get', input]);
      return {
        contract_version: 'customer_safe_v1',
        campaign_id: 7,
        snapshot: { id: 81, report: { contract_version: 'customer_safe_v1' } }
      };
    }
  };
  const customerReportDeliveryService = {
    generate(input) {
      calls.push(['customer-report-ppt', input]);
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'Content-Disposition': 'attachment; filename="customer-report-81.pptx"'
        },
        filePath: '/private/customer-report-81.pptx',
        replayed: false
      };
    },
    exportHtml(input) {
      calls.push(['customer-report-html', input]);
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="customer-report-81.html"',
          'Content-Security-Policy': "default-src 'none'"
        },
        body: Buffer.from('<!doctype html><title>Customer report</title>', 'utf8')
      };
    }
  };
  registerPerformanceRoutes(app, {
    authMiddleware(_request, _response, next) { next(); },
    service,
    freshnessService,
    collectionRunService,
    providerCollectionService,
    feishuConnectionService,
    feishuProjectionService,
    aiReviewService,
    customerReportSnapshotService,
    customerReportDeliveryService
  });
  return {
    routes,
    calls,
    service,
    freshnessService,
    collectionRunService,
    providerCollectionService,
    feishuConnectionService,
    feishuProjectionService,
    aiReviewService,
    customerReportSnapshotService,
    customerReportDeliveryService
  };
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
    'GET /api/campaigns/:id/performance/collection-runs',
    'GET /api/campaigns/:id/performance/contents',
    'GET /api/campaigns/:id/performance/contents/:contentId/observations',
    'GET /api/campaigns/:id/performance/contents/export',
    'GET /api/campaigns/:id/performance/customer-report-snapshots',
    'GET /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId',
    'GET /api/campaigns/:id/performance/dashboard',
    'GET /api/campaigns/:id/performance/feishu-connection',
    'GET /api/campaigns/:id/performance/feishu-projection-preview',
    'GET /api/campaigns/:id/performance/feishu-projection-preview/export',
    'GET /api/campaigns/:id/performance/freshness-queue',
    'GET /api/campaigns/:id/performance/integration-preview',
    'GET /api/campaigns/:id/performance/review-evidence',
    'POST /api/campaigns/:id/performance/ai-review-draft',
    'POST /api/campaigns/:id/performance/ai-review-draft/approve',
    'POST /api/campaigns/:id/performance/contents',
    'POST /api/campaigns/:id/performance/contents/:contentId/manual-inputs',
    'POST /api/campaigns/:id/performance/customer-report-preview',
    'POST /api/campaigns/:id/performance/customer-report-snapshots',
    'POST /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/html',
    'POST /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/ppt',
    'POST /api/campaigns/:id/performance/feishu-connection',
    'POST /api/campaigns/:id/performance/feishu-connection/approve',
    'POST /api/campaigns/:id/performance/import',
    'POST /api/campaigns/:id/performance/manual-inputs/:inputId/approve',
    'POST /api/campaigns/:id/performance/provider-refresh'
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

test('normalizes Express null-prototype queries before performance read services', () => {
  const { routes, calls } = createFixture();
  const query = Object.assign(Object.create(null), { q: 'creator', limit: '20', top_metric: 'views' });

  const contents = invoke(routes.get('GET /api/campaigns/:id/performance/contents'), {
    user: { id: 9 },
    params: { id: '7' },
    query,
    requestId: 'contents-query-request'
  });
  const dashboard = invoke(routes.get('GET /api/campaigns/:id/performance/dashboard'), {
    user: { id: 9 },
    params: { id: '7' },
    query,
    requestId: 'dashboard-query-request'
  });

  assert.equal(contents.statusCode, 200);
  assert.equal(dashboard.statusCode, 200);
  for (const call of calls) {
    assert.equal(Object.getPrototypeOf(call[1].query), Object.prototype);
    assert.deepEqual(call[1].query, { q: 'creator', limit: '20', top_metric: 'views' });
  }
});

test('returns safe collection-run summaries through the campaign read contract', () => {
  const { routes, calls } = createFixture();
  const response = invoke(routes.get('GET /api/campaigns/:id/performance/collection-runs'), {
    user: { id: 9 },
    params: { id: '7' },
    query: { limit: '12' },
    requestId: 'collection-runs-request'
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.contract_version, 'performance-collection-runs-v1');
  assert.equal(response.body.request_id, 'collection-runs-request');
  assert.deepEqual(calls[0], ['collection-runs', {
    userId: 9,
    campaignId: '7',
    query: { limit: '12' }
  }]);

  const policy = campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_COLLECTION_RUNS;
  assert.ok(policy);
  assert.equal(policy.id, 'campaign.performance.collection-runs');
  assert.equal(policy.method, 'GET');
  assert.equal(policy.pathTemplate, '/api/campaigns/:id/performance/collection-runs');
  assert.equal(policy.mediaKind, campaignContract.MEDIA_KINDS.EMPTY);

  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_COLLECTION_RUNS'/);
});

test('rejects unsupported collection-run filters at the HTTP boundary', () => {
  const { routes } = createFixture();
  const response = invoke(routes.get('GET /api/campaigns/:id/performance/collection-runs'), {
    user: { id: 9 },
    params: { id: '7' },
    query: { provider: 'tiktok' },
    requestId: 'collection-runs-invalid-query'
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'PERFORMANCE_COLLECTION_RUN_QUERY_INVALID');
  assert.deepEqual(response.body.details, { field: 'provider' });
});

test('returns the provider-independent freshness queue through a read-only campaign contract', () => {
  const { routes, calls } = createFixture();
  const response = invoke(routes.get('GET /api/campaigns/:id/performance/freshness-queue'), {
    user: { id: 9 },
    params: { id: '7' },
    query: { ignored: 'value' },
    requestId: 'freshness-request'
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.request_id, 'freshness-request');
  assert.equal(response.body.provider.dispatch_available, false);
  assert.deepEqual(calls[0], ['freshness-queue', { userId: 9, campaignId: '7' }]);

  const policy = campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_FRESHNESS_QUEUE;
  assert.ok(policy);
  assert.equal(policy.id, 'campaign.performance.freshness-queue');
  assert.equal(policy.method, 'GET');
  assert.equal(policy.pathTemplate, '/api/campaigns/:id/performance/freshness-queue');
  assert.equal(policy.mediaKind, campaignContract.MEDIA_KINDS.EMPTY);

  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_FRESHNESS_QUEUE'/);
});

test('starts one idempotent YouTube refresh through the campaign performance contract', async () => {
  const { routes, calls } = createFixture();
  const response = await invokeAsync(
    routes.get('POST /api/campaigns/:id/performance/provider-refresh'),
    {
      user: { id: 9 },
      params: { id: '7' },
      body: {},
      headers: { 'idempotency-key': 'provider-refresh-00000009' },
      requestId: 'provider-refresh-request'
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.request_id, 'provider-refresh-request');
  assert.equal(response.body.run.provider, 'youtube');
  assert.equal(response.body.run.status, 'succeeded');
  assert.deepEqual(calls, [[
    'provider-refresh',
    {
      userId: 9,
      campaignId: '7',
      triggerMode: 'manual',
      idempotencyKey: 'provider-refresh-00000009'
    }
  ]]);

  const policy = campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_PROVIDER_REFRESH;
  assert.ok(policy);
  assert.equal(policy.id, 'campaign.performance.provider-refresh');
  assert.equal(policy.method, 'POST');
  assert.equal(policy.pathTemplate, '/api/campaigns/:id/performance/provider-refresh');
  assert.equal(policy.mediaKind, campaignContract.MEDIA_KINDS.JSON);

  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_PROVIDER_REFRESH'/);
});

test('normalizes provider refresh failures without exposing provider internals', async () => {
  const { routes, providerCollectionService } = createFixture();
  providerCollectionService.runCampaign = async () => {
    throw new PerformanceProviderCollectionServiceError(
      503,
      'PERFORMANCE_PROVIDER_NOT_CONFIGURED',
      'YouTube data collection is not configured.'
    );
  };
  const response = await invokeAsync(
    routes.get('POST /api/campaigns/:id/performance/provider-refresh'),
    {
      user: { id: 9 },
      params: { id: '7' },
      body: {},
      headers: { 'idempotency-key': 'provider-refresh-00000010' },
      requestId: 'provider-refresh-unconfigured'
    }
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'PERFORMANCE_PROVIDER_NOT_CONFIGURED');
  assert.equal(response.body.error, 'YouTube data collection is not configured.');
});

test('previews and exports the approved Feishu performance projection', () => {
  const { routes, calls } = createFixture();
  const preview = invoke(routes.get('GET /api/campaigns/:id/performance/feishu-projection-preview'), {
    user: { id: 9 },
    params: { id: '7' },
    requestId: 'projection-preview'
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.snapshot.record_count, 1);
  assert.equal(preview.body.request_id, 'projection-preview');

  const exported = invoke(routes.get('GET /api/campaigns/:id/performance/feishu-projection-preview/export'), {
    user: { id: 9 },
    params: { id: '7' },
    requestId: 'projection-export'
  });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.headers['Content-Type'], 'text/csv;charset=utf-8');
  assert.match(exported.headers['Content-Disposition'], /performance_campaign_7_feishu_snapshot_2026-09-10\.csv/);
  assert.match(exported.body, /https:\/\/example\.test\/video/);
  assert.deepEqual(calls, [
    ['feishu-projection-preview', { userId: 9, campaignId: '7' }],
    ['feishu-projection-export', { userId: 9, campaignId: '7' }]
  ]);
});

test('routes commercial approval through a distinct protected campaign contract', () => {
  const { routes, calls } = createFixture();
  const request = {
    user: { id: 3 },
    params: { id: '7', inputId: '11' },
    body: {},
    requestId: 'commercial-approval-request'
  };
  const response = invoke(
    routes.get('POST /api/campaigns/:id/performance/manual-inputs/:inputId/approve'),
    request
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'approved');
  assert.equal(response.body.request_id, 'commercial-approval-request');
  assert.deepEqual(calls[0], ['commercial-approve', {
    userId: 3,
    campaignId: '7',
    manualInputId: '11',
    body: {}
  }]);

  const policy = campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_MANUAL_INPUT_APPROVE;
  assert.ok(policy);
  assert.equal(policy.id, 'campaign.performance.manual-input.approve');
  assert.equal(policy.method, 'POST');
  assert.equal(policy.pathTemplate, '/api/campaigns/:id/performance/manual-inputs/:inputId/approve');

  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_MANUAL_INPUT_APPROVE'/);
});

test('returns one video observation history through the protected campaign read contract', () => {
  const { routes, calls } = createFixture();
  const response = invoke(
    routes.get('GET /api/campaigns/:id/performance/contents/:contentId/observations'),
    {
      user: { id: 9 },
      params: { id: '7', contentId: '13' },
      query: { limit: '10', cursor: 'opaque-cursor', ignored: 'value' },
      requestId: 'observation-history-request'
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.contract_version, 'performance-observation-history-v1');
  assert.equal(response.body.request_id, 'observation-history-request');
  assert.deepEqual(calls[0], ['observation-history', {
    userId: 9,
    campaignId: '7',
    contentId: '13',
    query: { limit: '10', cursor: 'opaque-cursor' }
  }]);

  const policy = campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_OBSERVATION_HISTORY;
  assert.ok(policy);
  assert.equal(policy.id, 'campaign.performance.observation-history');
  assert.equal(policy.method, 'GET');
  assert.equal(
    policy.pathTemplate,
    '/api/campaigns/:id/performance/contents/:contentId/observations'
  );
  assert.equal(policy.mediaKind, campaignContract.MEDIA_KINDS.EMPTY);

  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_OBSERVATION_HISTORY'/);
});

test('routes customer report preview, immutable snapshots, and retained PPT delivery through protected campaign contracts', () => {
  const { routes, calls, customerReportSnapshotService, customerReportDeliveryService } = createFixture();
  const body = {
    top_metric: 'views',
    title: 'Customer performance review',
    optimization_actions: [],
    next_cycle_plan: ''
  };
  const previewRequest = {
    user: { id: 9, role: 'org_admin' },
    params: { id: '7' },
    body,
    requestId: 'customer-report-preview-request'
  };
  const preview = invoke(
    routes.get('POST /api/campaigns/:id/performance/customer-report-preview'),
    previewRequest
  );
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.status, 'preview');
  assert.equal(preview.body.request_id, 'customer-report-preview-request');
  assert.deepEqual(calls[0], ['customer-report-preview', {
    user: previewRequest.user,
    campaignId: '7',
    body
  }]);

  const sealRequest = {
    user: previewRequest.user,
    params: { id: '7' },
    body: Object.assign({}, body, { expected_evidence_snapshot_hash: 'd'.repeat(64) }),
    headers: { 'idempotency-key': 'customer-report-snapshot-key' },
    phase4Request: { requestId: 'customer-report-seal-request' }
  };
  const sealed = invoke(
    routes.get('POST /api/campaigns/:id/performance/customer-report-snapshots'),
    sealRequest
  );
  assert.equal(sealed.statusCode, 200);
  assert.equal(sealed.body.status, 'sealed');
  assert.equal(sealed.body.request_id, 'customer-report-seal-request');
  assert.deepEqual(calls[1], ['customer-report-seal', {
    user: sealRequest.user,
    campaignId: '7',
    body: sealRequest.body,
    idempotencyKey: 'customer-report-snapshot-key',
    requestId: 'customer-report-seal-request'
  }]);

  const listed = invoke(
    routes.get('GET /api/campaigns/:id/performance/customer-report-snapshots'),
    { user: { id: 10 }, params: { id: '7' }, requestId: 'customer-report-list-request' }
  );
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.request_id, 'customer-report-list-request');
  assert.deepEqual(calls[2], ['customer-report-list', { userId: 10, campaignId: '7' }]);

  const detail = invoke(
    routes.get('GET /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId'),
    { user: { id: 10 }, params: { id: '7', snapshotId: '81' }, requestId: 'customer-report-detail-request' }
  );
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.snapshot.id, 81);
  assert.deepEqual(calls[3], ['customer-report-get', {
    userId: 10,
    campaignId: '7',
    snapshotId: '81'
  }]);

  const delivered = invoke(
    routes.get('POST /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/ppt'),
    {
      user: previewRequest.user,
      params: { id: '7', snapshotId: '81' },
      body: {},
      requestId: 'customer-report-ppt-request'
    }
  );
  assert.equal(delivered.statusCode, 200);
  assert.equal(delivered.filePath, '/private/customer-report-81.pptx');
  assert.equal(
    delivered.headers['Content-Type'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
  assert.deepEqual(calls[4], ['customer-report-ppt', {
    user: previewRequest.user,
    campaignId: '7',
    snapshotId: '81',
    requestId: 'customer-report-ppt-request'
  }]);

  const html = invoke(
    routes.get('POST /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/html'),
    {
      user: previewRequest.user,
      params: { id: '7', snapshotId: '81' },
      body: {},
      requestId: 'customer-report-html-request'
    }
  );
  assert.equal(html.statusCode, 200);
  assert.equal(html.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.match(html.body.toString('utf8'), /Customer report/);
  assert.deepEqual(calls[5], ['customer-report-html', {
    user: previewRequest.user,
    campaignId: '7',
    snapshotId: '81',
    requestId: 'customer-report-html-request'
  }]);

  const htmlCallCount = calls.length;
  const invalidHtml = invoke(
    routes.get('POST /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/html'),
    {
      user: previewRequest.user,
      params: { id: '7', snapshotId: '81' },
      body: { unexpected: true },
      requestId: 'customer-report-html-invalid-request'
    }
  );
  assert.equal(invalidHtml.statusCode, 400);
  assert.equal(invalidHtml.body.code, 'INVALID_REQUEST_BODY');
  assert.equal(invalidHtml.body.request_id, 'customer-report-html-invalid-request');
  assert.equal(calls.length, htmlCallCount);

  for (const [name, id, method, pathTemplate, mediaKind] of [
    ['CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_PREVIEW', 'campaign.performance.customer-report-preview', 'POST', '/api/campaigns/:id/performance/customer-report-preview', campaignContract.MEDIA_KINDS.JSON],
    ['CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_SNAPSHOT_CREATE', 'campaign.performance.customer-report-snapshot.create', 'POST', '/api/campaigns/:id/performance/customer-report-snapshots', campaignContract.MEDIA_KINDS.JSON],
    ['CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_SNAPSHOT_LIST', 'campaign.performance.customer-report-snapshot.list', 'GET', '/api/campaigns/:id/performance/customer-report-snapshots', campaignContract.MEDIA_KINDS.EMPTY],
    ['CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_SNAPSHOT_DETAIL', 'campaign.performance.customer-report-snapshot.detail', 'GET', '/api/campaigns/:id/performance/customer-report-snapshots/:snapshotId', campaignContract.MEDIA_KINDS.EMPTY],
    ['CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_HTML_EXPORT', 'campaign.performance.customer-report-html.export', 'POST', '/api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/html', campaignContract.MEDIA_KINDS.JSON],
    ['CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_PPT_GENERATE', 'campaign.performance.customer-report-ppt.generate', 'POST', '/api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/ppt', campaignContract.MEDIA_KINDS.JSON]
  ]) {
    const policy = campaignContract.REQUEST_POLICIES[name];
    assert.ok(policy);
    assert.equal(policy.id, id);
    assert.equal(policy.method, method);
    assert.equal(policy.pathTemplate, pathTemplate);
    assert.equal(policy.mediaKind, mediaKind);
  }
  assert.equal(
    campaignContract.REQUEST_POLICIES.CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_HTML_EXPORT.maxRawBytes,
    campaignContract.BODY_LIMITS.CAMPAIGN_EMPTY_CONTROL_JSON
  );

  customerReportSnapshotService.preview = () => {
    throw new CustomerReportSnapshotServiceError(
      409,
      'CUSTOMER_REPORT_STALE_EVIDENCE',
      'Current performance evidence no longer matches the confirmed review.'
    );
  };
  const stale = invoke(
    routes.get('POST /api/campaigns/:id/performance/customer-report-preview'),
    previewRequest
  );
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.code, 'CUSTOMER_REPORT_STALE_EVIDENCE');
  assert.equal(stale.body.request_id, 'customer-report-preview-request');

  customerReportDeliveryService.generate = () => {
    throw new CustomerReportDeliveryServiceError(
      403,
      'CUSTOMER_REPORT_PPT_FORBIDDEN',
      'Customer report PPT access is forbidden.'
    );
  };
  const forbidden = invoke(
    routes.get('POST /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/ppt'),
    {
      user: { id: 10 },
      params: { id: '7', snapshotId: '81' },
      body: {},
      requestId: 'customer-report-ppt-forbidden'
    }
  );
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.code, 'CUSTOMER_REPORT_PPT_FORBIDDEN');
  assert.equal(forbidden.body.request_id, 'customer-report-ppt-forbidden');

  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_PREVIEW'/);
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_SNAPSHOT_CREATE'/);
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_HTML_EXPORT'/);
  assert.match(serverSource, /'CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_PPT_GENERATE'/);
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
