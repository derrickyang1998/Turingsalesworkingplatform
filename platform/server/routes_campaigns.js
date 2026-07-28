'use strict';

const {
  CampaignServiceError,
  createCampaignService
} = require('./services/campaign_service');
const {
  CampaignWorkflowServiceError,
  createCampaignWorkflowService
} = require('./services/campaign_workflow_service');

function requestId(request) {
  return request.requestId ||
    request.phase4Request && request.phase4Request.requestId ||
    'campaign-request';
}

function sendError(request, response, error) {
  const known = error instanceof CampaignServiceError ||
    error instanceof CampaignWorkflowServiceError ||
    error && error.name === 'IdempotencyServiceError';
  const status = known ? error.statusCode : 500;
  const body = {
    error: known ? error.message : 'Campaign request failed.',
    code: known ? error.code : 'AUDIT_PERSISTENCE_FAILED',
    request_id: requestId(request)
  };
  if (known && error.details !== undefined) body.details = error.details;
  if (known && error.retryAfterSeconds) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  return response.status(status).json(body);
}

function sendResult(response, result) {
  for (const [name, value] of Object.entries(result.headers || {})) {
    response.setHeader(name, value);
  }
  return response.status(result.status).json(result.body);
}

function registerCampaignRoutes(app, db) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('An Express application is required');
  }
  const service = createCampaignService(db);
  const workflowService = createCampaignWorkflowService(db);

  app.get('/api/campaigns/options', (request, response) => {
    try {
      return response.json(service.getOptions({
        userId: request.user && request.user.id,
        query: request.query
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns', (request, response) => {
    try {
      return sendResult(response, service.createCampaign({
        userId: request.user && request.user.id,
        requestId: requestId(request),
        idempotencyKey: request.get('Idempotency-Key'),
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns', (request, response) => {
    try {
      return response.json(service.listCampaigns({
        userId: request.user && request.user.id,
        query: request.query
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id', (request, response) => {
    try {
      return response.json(service.getCampaignDetail({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        query: request.query
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.patch('/api/campaigns/:id', (request, response) => {
    try {
      return sendResult(response, service.updateCampaign({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        requestId: requestId(request),
        idempotencyKey: request.get('Idempotency-Key'),
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/transitions', (request, response) => {
    try {
      return sendResult(response, service.transitionCampaign({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        requestId: requestId(request),
        idempotencyKey: request.get('Idempotency-Key'),
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/operational-actions', (request, response) => {
    try {
      return sendResult(response, service.operationalAction({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        requestId: requestId(request),
        idempotencyKey: request.get('Idempotency-Key'),
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/transfers', (request, response) => {
    try {
      return sendResult(response, service.transferCampaign({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        requestId: requestId(request),
        idempotencyKey: request.get('Idempotency-Key'),
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/links', (request, response) => {
    try {
      return sendResult(response, service.attachCampaignLink({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        requestId: requestId(request),
        idempotencyKey: request.get('Idempotency-Key'),
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/link-corrections', (request, response) => {
    try {
      return sendResult(response, service.correctCampaignLink({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        requestId: requestId(request),
        idempotencyKey: request.get('Idempotency-Key'),
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/link-candidates', (request, response) => {
    try {
      return response.json(service.listCampaignLinkCandidates({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        query: request.query
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/workspace', (request, response) => {
    try {
      return response.json(service.getCampaignWorkspace({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        query: request.query
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/knowledge', (request, response) => {
    try {
      return response.json(service.listCampaignKnowledge({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        query: request.query
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/knowledge/:entryId', (request, response) => {
    try {
      return response.json(service.getCampaignKnowledgeDetail({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        entryId: request.params.entryId,
        query: request.query
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/reviews', (request, response) => {
    try {
      return sendResult(response, service.createCampaignReview({
        userId: request.user && request.user.id,
        campaignId: request.params.id,
        requestId: requestId(request),
        idempotencyKey: request.get('Idempotency-Key'),
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get(
    '/api/campaigns/:id/workflow-reconciliation-options',
    (request, response) => {
      try {
        return response.json(
          workflowService.getWorkflowReconciliationOptions({
            userId: request.user && request.user.id,
            campaignId: request.params.id,
            query: request.query
          })
        );
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

  app.post(
    '/api/campaigns/:id/workflow-dispatches/:dispatchId/retry',
    (request, response) => {
      try {
        return sendResult(response, workflowService.retryWorkflowDispatch({
          userId: request.user && request.user.id,
          campaignId: request.params.id,
          dispatchId: request.params.dispatchId,
          requestId: requestId(request),
          idempotencyKey: request.get('Idempotency-Key'),
          body: request.body
        }));
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

  app.post(
    '/api/campaigns/:id/workflow-dispatches/:dispatchId/reconcile',
    (request, response) => {
      try {
        return sendResult(response, workflowService.reconcileWorkflowDispatch({
          userId: request.user && request.user.id,
          campaignId: request.params.id,
          dispatchId: request.params.dispatchId,
          requestId: requestId(request),
          idempotencyKey: request.get('Idempotency-Key'),
          body: request.body
        }));
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

  app.post(
    '/api/campaigns/:id/workflow-tasks/:taskId/reassign',
    (request, response) => {
      try {
        return sendResult(response, workflowService.reassignWorkflowTask({
          userId: request.user && request.user.id,
          campaignId: request.params.id,
          taskId: request.params.taskId,
          requestId: requestId(request),
          idempotencyKey: request.get('Idempotency-Key'),
          body: request.body
        }));
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

  return service;
}

module.exports = registerCampaignRoutes;
module.exports.registerCampaignRoutes = registerCampaignRoutes;
