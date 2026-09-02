'use strict';

const {
  PerformanceManualServiceError,
  createPerformanceManualService
} = require('./services/performance_manual_service');

function requestId(request) {
  return request.requestId ||
    request.phase4Request && request.phase4Request.requestId ||
    'performance-request';
}

function sendError(request, response, error) {
  const known = error instanceof PerformanceManualServiceError;
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

function registerPerformanceRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('An Express application is required.');
  }
  if (typeof options.authMiddleware !== 'function') {
    throw new TypeError('An authentication middleware is required.');
  }
  const service = options.service || createPerformanceManualService(options.db);
  if (!service || typeof service.listContents !== 'function' || typeof service.exportContents !== 'function' || typeof service.getDashboard !== 'function') {
    throw new TypeError('A performance manual service is required.');
  }

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
}

module.exports = registerPerformanceRoutes;
