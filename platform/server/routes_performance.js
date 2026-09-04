'use strict';

const {
  PerformanceManualServiceError,
  PerformanceAiReviewServiceError,
  createPerformanceManualService,
  createPerformanceAiReviewService
} = require('./services/performance_manual_service');
const {
  PerformanceFeishuConnectionServiceError,
  createPerformanceFeishuConnectionService
} = require('./services/performance_feishu_connection_service');

function requestId(request) {
  return request.requestId ||
    request.phase4Request && request.phase4Request.requestId ||
    'performance-request';
}

function sendError(request, response, error) {
  const known = error instanceof PerformanceManualServiceError ||
    error instanceof PerformanceFeishuConnectionServiceError ||
    error instanceof PerformanceAiReviewServiceError;
  const status = known ? error.statusCode : 500;
  const body = {
    error: known ? error.message : 'Performance request failed.',
    code: known ? error.code : 'PERFORMANCE_REQUEST_FAILED',
    request_id: requestId(request)
  };
  if (known && error.details !== undefined) body.details = error.details;
  return response.status(status).json(body);
}

function sendResult(request, response, payload) {
  return response.json(Object.assign({}, payload, { request_id: requestId(request) }));
}

function authenticatedUserId(request) {
  return request.user && request.user.id;
}

function requestHeader(request, name) {
  if (request && typeof request.get === 'function') return request.get(name);
  const headers = request && request.headers && typeof request.headers === 'object' ? request.headers : {};
  return headers[String(name || '').toLowerCase()] || null;
}

function registerPerformanceRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('An Express application is required.');
  }
  if (typeof options.authMiddleware !== 'function') {
    throw new TypeError('An authentication middleware is required.');
  }
  const service = options.service || createPerformanceManualService(options.db);
  if (!service || typeof service.listContents !== 'function' || typeof service.getIntegrationPreview !== 'function' || typeof service.exportContents !== 'function' || typeof service.getDashboard !== 'function' || typeof service.getReviewEvidence !== 'function') {
    throw new TypeError('A performance manual service is required.');
  }
  const feishuConnectionService = options.feishuConnectionService ||
    createPerformanceFeishuConnectionService(options.db);
  if (!feishuConnectionService ||
    typeof feishuConnectionService.getConnection !== 'function' ||
    typeof feishuConnectionService.createDraft !== 'function' ||
    typeof feishuConnectionService.approveDraft !== 'function') {
    throw new TypeError('A performance Feishu connection service is required.');
  }
  const aiReviewService = options.aiReviewService || createPerformanceAiReviewService(options.db, {
    performanceService: service,
    aiService: options.aiService
  });
  if (
    !aiReviewService ||
    typeof aiReviewService.createDraft !== 'function' ||
    typeof aiReviewService.approveDraft !== 'function'
  ) {
    throw new TypeError('A performance AI review service is required.');
  }
  const aiLimiter = typeof options.aiLimiter === 'function'
    ? options.aiLimiter
    : (_request, _response, next) => next();

  app.get('/api/campaigns/:id/performance/contents', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, service.listContents({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        query: request.query || {}
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/performance/contents/export', options.authMiddleware, (request, response) => {
    try {
      const query = Object.assign({}, request.query || {});
      const scope = query.scope;
      delete query.scope;
      const exported = service.exportContents({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        scope,
        query
      });
      response.setHeader('Content-Type', 'text/csv;charset=utf-8');
      response.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
      return response.send(exported.csv);
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/performance/integration-preview', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, service.getIntegrationPreview({
        userId: authenticatedUserId(request),
        campaignId: request.params.id
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/performance/feishu-connection', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, feishuConnectionService.getConnection({
        userId: authenticatedUserId(request),
        campaignId: request.params.id
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/performance/feishu-connection', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, feishuConnectionService.createDraft({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/performance/feishu-connection/approve', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, feishuConnectionService.approveDraft({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        configurationId: request.body && request.body.configuration_id
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/performance/contents', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, service.createContent({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/performance/import', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, service.importContentRows({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post(
    '/api/campaigns/:id/performance/contents/:contentId/manual-inputs',
    options.authMiddleware,
    (request, response) => {
      try {
        return sendResult(request, response, service.recordManualInput({
          userId: authenticatedUserId(request),
          campaignId: request.params.id,
          contentId: request.params.contentId,
          body: request.body
        }));
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

  app.get('/api/campaigns/:id/performance/dashboard', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, service.getDashboard({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        query: request.query || {}
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/performance/review-evidence', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, service.getReviewEvidence({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        query: { top_metric: request.query && request.query.top_metric }
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post(
    '/api/campaigns/:id/performance/ai-review-draft',
    options.authMiddleware,
    aiLimiter,
    async (request, response) => {
      try {
        const result = await aiReviewService.createDraft({
          user: request.user,
          campaignId: request.params.id,
          body: request.body,
          idempotencyKey: requestHeader(request, 'Idempotency-Key'),
          requestId: requestId(request)
        });
        return sendResult(request, response, result);
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

  app.post(
    '/api/campaigns/:id/performance/ai-review-draft/approve',
    options.authMiddleware,
    async (request, response) => {
      try {
        const result = await aiReviewService.approveDraft({
          user: request.user,
          campaignId: request.params.id,
          body: request.body,
          idempotencyKey: requestHeader(request, 'Idempotency-Key'),
          requestId: requestId(request)
        });
        return sendResult(request, response, result);
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );
}

module.exports = registerPerformanceRoutes;
