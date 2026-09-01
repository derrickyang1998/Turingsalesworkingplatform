'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerPerformanceRoutes = require('../routes_performance');
const { PerformanceManualServiceError } = require('../services/performance_manual_service');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
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
    'GET /api/campaigns/:id/performance/dashboard',
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
