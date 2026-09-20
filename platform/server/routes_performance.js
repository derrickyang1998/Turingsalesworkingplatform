'use strict';

const {
  PerformanceManualServiceError,
  PerformanceAiReviewServiceError,
  createPerformanceManualService,
  createPerformanceAiReviewService
} = require('./services/performance_manual_service');
const {
  CustomerReportSnapshotServiceError,
  createCustomerReportSnapshotService
} = require('./services/customer_report_snapshot_service');
const {
  CustomerReportDeliveryServiceError
} = require('./services/customer_report_delivery_service');
const {
  PerformanceFeishuConnectionServiceError,
  createPerformanceFeishuConnectionService
} = require('./services/performance_feishu_connection_service');
const {
  PerformanceFeishuProjectionServiceError,
  createPerformanceFeishuProjectionService
} = require('./services/performance_feishu_projection_service');
const { createPerformanceFreshnessService } = require('./services/performance_freshness_service');
const {
  PerformanceCollectionRunServiceError,
  createPerformanceCollectionRunService
} = require('./services/performance_collection_run_service');
const {
  PerformanceProviderCollectionServiceError
} = require('./services/performance_provider_collection_service');
const {
  PerformanceContentAnalysisServiceError,
  createPerformanceContentAnalysisService
} = require('./services/performance_content_analysis_service');
const {
  OrganizationMethodologyServiceError
} = require('./services/organization_methodology_service');
const { AIQuotaServiceError } = require('./services/ai_quota_service');
const {
  CAMPAIGN_PERFORMANCE_MODULE,
  CAMPAIGN_PERFORMANCE_EXPORT_ACTION,
  CAMPAIGN_CUSTOMER_REPORT_MODULE,
  CAMPAIGN_CUSTOMER_REPORT_EXPORT_ACTION
} = require('./services/module_action_permission_service');

function requestId(request) {
  return request.requestId ||
    request.phase4Request && request.phase4Request.requestId ||
    'performance-request';
}

function plainRequestQuery(request) {
  const query = request && request.query;
  if (!query || typeof query !== 'object' || Array.isArray(query)) return query || {};
  return Object.fromEntries(Object.entries(query));
}

function sendError(request, response, error) {
  const known = error instanceof PerformanceManualServiceError ||
    error instanceof PerformanceFeishuConnectionServiceError ||
    error instanceof PerformanceFeishuProjectionServiceError ||
    error instanceof PerformanceCollectionRunServiceError ||
    error instanceof PerformanceProviderCollectionServiceError ||
    error instanceof PerformanceAiReviewServiceError ||
    error instanceof PerformanceContentAnalysisServiceError ||
    error instanceof OrganizationMethodologyServiceError ||
    error instanceof AIQuotaServiceError ||
    (error && error.name === 'IdempotencyServiceError') ||
    error instanceof CustomerReportSnapshotServiceError ||
    error instanceof CustomerReportDeliveryServiceError;
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

function sendPptResult(request, response, result) {
  for (const [name, value] of Object.entries(result.headers || {})) {
    response.setHeader(name, value);
  }
  return response.status(result.status).sendFile(result.filePath, (error) => {
    if (!error) return;
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    sendError(request, response, new CustomerReportDeliveryServiceError(
      503,
      'CUSTOMER_REPORT_PPT_ARTIFACT_UNAVAILABLE',
      'The retained customer report PPT could not be delivered safely.'
    ));
  });
}

function sendHtmlResult(response, result) {
  for (const [name, value] of Object.entries(result.headers || {})) {
    response.setHeader(name, value);
  }
  return response.status(result.status).send(result.body);
}

function authenticatedUserId(request) {
  return request.user && request.user.id;
}

function positiveIntegerOrNull(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

function boundedAuditText(value, fallback, maxLength) {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maxLength)
    : fallback;
}

function performanceExportOrganizationId(request) {
  return request && request.authContext && request.authContext.organization
    ? request.authContext.organization.id
    : undefined;
}

function performanceExportAuditEvent(request, decision, exportKind, outcome, recordCount) {
  const event = {
    actor_user_id: positiveIntegerOrNull(authenticatedUserId(request)),
    organization_id: positiveIntegerOrNull(performanceExportOrganizationId(request)),
    permission: `${CAMPAIGN_PERFORMANCE_MODULE}.${CAMPAIGN_PERFORMANCE_EXPORT_ACTION}`,
    outcome,
    reason_code: boundedAuditText(decision && decision.code, 'PERMISSION_DECISION_INVALID', 80),
    request_id: boundedAuditText(requestId(request), 'performance-request', 120),
    target_type: 'campaign',
    target_id: positiveIntegerOrNull(request && request.params && request.params.id),
    export_kind: exportKind,
    ip_address: boundedAuditText(request && request.ip, null, 255)
  };
  if (Number.isSafeInteger(recordCount) && recordCount >= 0) event.record_count = recordCount;
  return event;
}

function customerReportExportAuditEvent(request, decision, exportKind, outcome) {
  return {
    actor_user_id: positiveIntegerOrNull(authenticatedUserId(request)),
    organization_id: positiveIntegerOrNull(performanceExportOrganizationId(request)),
    permission: `${CAMPAIGN_CUSTOMER_REPORT_MODULE}.${CAMPAIGN_CUSTOMER_REPORT_EXPORT_ACTION}`,
    outcome,
    reason_code: boundedAuditText(decision && decision.code, 'PERMISSION_DECISION_INVALID', 80),
    request_id: boundedAuditText(requestId(request), 'performance-request', 120),
    target_type: 'customer_report_snapshot',
    target_id: positiveIntegerOrNull(request && request.params && request.params.snapshotId),
    campaign_id: positiveIntegerOrNull(request && request.params && request.params.id),
    export_kind: exportKind,
    ip_address: boundedAuditText(request && request.ip, null, 255)
  };
}

function sendPerformanceExportError(request, response, statusCode, code, message) {
  return response.status(statusCode).json({
    error: message,
    code,
    request_id: requestId(request)
  });
}

function sendCustomerReportExportError(request, response, statusCode, code, message) {
  return response.status(statusCode).json({
    error: message,
    code,
    request_id: requestId(request)
  });
}

function requestHeader(request, name) {
  if (request && typeof request.get === 'function') return request.get(name);
  const headers = request && request.headers && typeof request.headers === 'object' ? request.headers : {};
  return headers[String(name || '').toLowerCase()] || null;
}

function requireEmptyJsonObject(request) {
  const body = request && request.body;
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype ||
    Object.keys(body).length !== 0
  ) {
    throw new CustomerReportDeliveryServiceError(
      400,
      'INVALID_REQUEST_BODY',
      'Request body must be an empty JSON object.'
    );
  }
}

function registerPerformanceRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('An Express application is required.');
  }
  if (typeof options.authMiddleware !== 'function') {
    throw new TypeError('An authentication middleware is required.');
  }
  const service = options.service || createPerformanceManualService(options.db);
  if (!service || typeof service.listContents !== 'function' || typeof service.getObservationHistory !== 'function' || typeof service.getIntegrationPreview !== 'function' || typeof service.exportContents !== 'function' || typeof service.getDashboard !== 'function' || typeof service.getReviewEvidence !== 'function') {
    throw new TypeError('A performance manual service is required.');
  }
  const freshnessService = options.freshnessService || createPerformanceFreshnessService({
    performanceService: service
  });
  if (!freshnessService || typeof freshnessService.getQueue !== 'function') {
    throw new TypeError('A performance freshness service is required.');
  }
  const collectionRunService = options.collectionRunService ||
    createPerformanceCollectionRunService(options.db);
  if (!collectionRunService || typeof collectionRunService.listRuns !== 'function') {
    throw new TypeError('A performance collection run service is required.');
  }
  const providerCollectionService = options.providerCollectionService;
  if (!providerCollectionService ||
    typeof providerCollectionService.getCampaignStatus !== 'function' ||
    typeof providerCollectionService.runCampaign !== 'function') {
    throw new TypeError('A performance provider collection service is required.');
  }
  const feishuConnectionService = options.feishuConnectionService ||
    createPerformanceFeishuConnectionService(options.db);
  if (!feishuConnectionService ||
    typeof feishuConnectionService.getConnection !== 'function' ||
    typeof feishuConnectionService.createDraft !== 'function' ||
    typeof feishuConnectionService.approveDraft !== 'function') {
    throw new TypeError('A performance Feishu connection service is required.');
  }
  const feishuProjectionService = options.feishuProjectionService ||
    createPerformanceFeishuProjectionService({ performanceService: service, feishuConnectionService });
  if (!feishuProjectionService ||
    typeof feishuProjectionService.preview !== 'function' ||
    typeof feishuProjectionService.exportCsv !== 'function') {
    throw new TypeError('A performance Feishu projection service is required.');
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
  const contentAnalysisService = options.contentAnalysisService ||
    createPerformanceContentAnalysisService(options.db, {
      performanceService: service,
      aiService: options.aiService
    });
  if (
    !contentAnalysisService ||
    typeof contentAnalysisService.createDraft !== 'function' ||
    typeof contentAnalysisService.approveDraft !== 'function'
  ) {
    throw new TypeError('A performance content analysis service is required.');
  }
  const organizationMethodologyService = options.organizationMethodologyService;
  if (
    !organizationMethodologyService ||
    typeof organizationMethodologyService.listPromotions !== 'function' ||
    typeof organizationMethodologyService.requestPromotion !== 'function' ||
    typeof organizationMethodologyService.decidePromotion !== 'function'
  ) {
    throw new TypeError('An organization methodology service is required.');
  }
  const customerReportSnapshotService = options.customerReportSnapshotService ||
    createCustomerReportSnapshotService(options.db, { performanceService: service });
  if (
    !customerReportSnapshotService ||
    typeof customerReportSnapshotService.preview !== 'function' ||
    typeof customerReportSnapshotService.seal !== 'function' ||
    typeof customerReportSnapshotService.list !== 'function' ||
    typeof customerReportSnapshotService.get !== 'function'
  ) {
    throw new TypeError('A customer report snapshot service is required.');
  }
  const customerReportDeliveryService = options.customerReportDeliveryService;
  if (!customerReportDeliveryService ||
    typeof customerReportDeliveryService.generate !== 'function' ||
    typeof customerReportDeliveryService.exportHtml !== 'function') {
    throw new TypeError('A customer report delivery service is required.');
  }
  const moduleActionPermissionService = options.moduleActionPermissionService;
  if (!moduleActionPermissionService || typeof moduleActionPermissionService.authorize !== 'function') {
    throw new TypeError('A module action permission service is required.');
  }
  const performanceExportAudit = options.performanceExportAudit;
  if (typeof performanceExportAudit !== 'function') {
    throw new TypeError('A performance export audit writer is required.');
  }
  const customerReportExportAudit = options.customerReportExportAudit;
  if (typeof customerReportExportAudit !== 'function') {
    throw new TypeError('A customer report export audit writer is required.');
  }
  const aiLimiter = typeof options.aiLimiter === 'function'
    ? options.aiLimiter
    : (_request, _response, next) => next();

  function requirePerformanceExport(exportKind) {
    return function performanceExportPermissionMiddleware(request, response, next) {
      let decision;
      try {
        decision = moduleActionPermissionService.authorize({
          principal: request.user,
          organizationId: performanceExportOrganizationId(request),
          module: CAMPAIGN_PERFORMANCE_MODULE,
          action: CAMPAIGN_PERFORMANCE_EXPORT_ACTION
        });
      } catch {
        decision = { allowed: false, code: 'AUTHORITATIVE_FACTS_UNAVAILABLE' };
      }
      if (decision && decision.allowed === true) {
        request.performanceExportPermission = decision;
        return next();
      }
      try {
        performanceExportAudit(performanceExportAuditEvent(request, decision, exportKind, 'denied'));
      } catch {
        return sendPerformanceExportError(
          request,
          response,
          503,
          'PERFORMANCE_EXPORT_AUDIT_UNAVAILABLE',
          'Performance export audit is unavailable.'
        );
      }
      return sendPerformanceExportError(
        request,
        response,
        403,
        'PERFORMANCE_EXPORT_FORBIDDEN',
        'Performance export is forbidden.'
      );
    };
  }

  function requireCustomerReportExport(exportKind) {
    return function customerReportExportPermissionMiddleware(request, response, next) {
      let decision;
      try {
        decision = moduleActionPermissionService.authorize({
          principal: request.user,
          organizationId: performanceExportOrganizationId(request),
          module: CAMPAIGN_CUSTOMER_REPORT_MODULE,
          action: CAMPAIGN_CUSTOMER_REPORT_EXPORT_ACTION
        });
      } catch {
        decision = { allowed: false, code: 'AUTHORITATIVE_FACTS_UNAVAILABLE' };
      }
      if (decision && decision.allowed === true) {
        request.customerReportExportPermission = decision;
        return next();
      }
      try {
        customerReportExportAudit(customerReportExportAuditEvent(
          request,
          decision,
          exportKind,
          'denied'
        ));
      } catch {
        return sendCustomerReportExportError(
          request,
          response,
          503,
          'CUSTOMER_REPORT_EXPORT_AUDIT_UNAVAILABLE',
          'Customer report export audit is unavailable.'
        );
      }
      return sendCustomerReportExportError(
        request,
        response,
        403,
        'CUSTOMER_REPORT_EXPORT_FORBIDDEN',
        'Customer report export is forbidden.'
      );
    };
  }

  const requireContentCsvExport = requirePerformanceExport('content_csv');
  const requireFeishuSnapshotCsvExport = requirePerformanceExport('feishu_snapshot_csv');
  const requireCustomerReportPptExport = requireCustomerReportExport('pptx');
  const requireCustomerReportHtmlExport = requireCustomerReportExport('html');

  app.get('/api/campaigns/:id/performance/contents', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, service.listContents({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        query: plainRequestQuery(request)
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/performance/freshness-queue', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, freshnessService.getQueue({
        userId: authenticatedUserId(request),
        campaignId: request.params.id
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/performance/collection-runs', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, collectionRunService.listRuns({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        query: request.query || {}
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/performance/provider-refresh', options.authMiddleware, async (request, response) => {
    try {
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) ||
        Object.getPrototypeOf(request.body) !== Object.prototype || Object.keys(request.body).length !== 0) {
        throw new PerformanceProviderCollectionServiceError(
          400,
          'PERFORMANCE_PROVIDER_REQUEST_INVALID',
          'Request body must be an empty JSON object.'
        );
      }
      const result = await providerCollectionService.runCampaign({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        triggerMode: 'manual',
        idempotencyKey: requestHeader(request, 'Idempotency-Key')
      });
      return sendResult(request, response, result);
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get(
    '/api/campaigns/:id/performance/contents/:contentId/observations',
    options.authMiddleware,
    (request, response) => {
      try {
        return sendResult(request, response, service.getObservationHistory({
          userId: authenticatedUserId(request),
          campaignId: request.params.id,
          contentId: request.params.contentId,
          query: {
            limit: request.query && request.query.limit,
            cursor: request.query && request.query.cursor
          }
        }));
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

  app.get(
    '/api/campaigns/:id/performance/contents/export',
    options.authMiddleware,
    requireContentCsvExport,
    (request, response) => {
      try {
        const query = plainRequestQuery(request);
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
    }
  );

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

  app.get('/api/campaigns/:id/performance/feishu-projection-preview', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, feishuProjectionService.preview({
        userId: authenticatedUserId(request),
        campaignId: request.params.id
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get(
    '/api/campaigns/:id/performance/feishu-projection-preview/export',
    options.authMiddleware,
    requireFeishuSnapshotCsvExport,
    (request, response) => {
      try {
        const exported = feishuProjectionService.exportCsv({
          userId: authenticatedUserId(request),
          campaignId: request.params.id
        });
        try {
          performanceExportAudit(performanceExportAuditEvent(
            request,
            request.performanceExportPermission,
            'feishu_snapshot_csv',
            'exported',
            exported.record_count
          ));
        } catch {
          return sendPerformanceExportError(
            request,
            response,
            503,
            'PERFORMANCE_EXPORT_AUDIT_UNAVAILABLE',
            'Performance export audit is unavailable.'
          );
        }
        response.setHeader('Content-Type', 'text/csv;charset=utf-8');
        response.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
        return response.send(exported.csv);
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

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

  app.post(
    '/api/campaigns/:id/performance/manual-inputs/:inputId/approve',
    options.authMiddleware,
    (request, response) => {
      try {
        return sendResult(request, response, service.approveManualInput({
          userId: authenticatedUserId(request),
          campaignId: request.params.id,
          manualInputId: request.params.inputId,
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
        query: plainRequestQuery(request)
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

  app.get('/api/campaigns/:id/performance/methodology-promotions', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, organizationMethodologyService.listPromotions({
        user: request.user,
        campaignId: request.params.id
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/performance/methodology-promotion-requests', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, organizationMethodologyService.requestPromotion({
        user: request.user,
        campaignId: request.params.id,
        body: request.body,
        idempotencyKey: requestHeader(request, 'Idempotency-Key'),
        requestId: requestId(request),
        ipAddress: request.ip
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post(
    '/api/campaigns/:id/performance/methodology-promotion-requests/:requestId/decision',
    options.authMiddleware,
    (request, response) => {
      try {
        return sendResult(request, response, organizationMethodologyService.decidePromotion({
          user: request.user,
          campaignId: request.params.id,
          promotionRequestId: request.params.requestId,
          body: request.body,
          idempotencyKey: requestHeader(request, 'Idempotency-Key'),
          requestId: requestId(request),
          ipAddress: request.ip
        }));
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

  app.get('/api/campaigns/:id/performance/customer-report-snapshots', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, customerReportSnapshotService.list({
        userId: authenticatedUserId(request),
        campaignId: request.params.id
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/campaigns/:id/performance/customer-report-snapshots/:snapshotId', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, customerReportSnapshotService.get({
        userId: authenticatedUserId(request),
        campaignId: request.params.id,
        snapshotId: request.params.snapshotId
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/performance/customer-report-preview', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, customerReportSnapshotService.preview({
        user: request.user,
        campaignId: request.params.id,
        body: request.body
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post('/api/campaigns/:id/performance/customer-report-snapshots', options.authMiddleware, (request, response) => {
    try {
      return sendResult(request, response, customerReportSnapshotService.seal({
        user: request.user,
        campaignId: request.params.id,
        body: request.body,
        idempotencyKey: requestHeader(request, 'Idempotency-Key'),
        requestId: requestId(request)
      }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.post(
    '/api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/ppt',
    options.authMiddleware,
    requireCustomerReportPptExport,
    (request, response) => {
      try {
        const result = customerReportDeliveryService.generate({
          user: request.user,
          campaignId: request.params.id,
          snapshotId: request.params.snapshotId,
          requestId: requestId(request)
        });
        try {
          customerReportExportAudit(customerReportExportAuditEvent(
            request,
            request.customerReportExportPermission,
            'pptx',
            'exported'
          ));
        } catch {
          return sendCustomerReportExportError(
            request,
            response,
            503,
            'CUSTOMER_REPORT_EXPORT_AUDIT_UNAVAILABLE',
            'Customer report export audit is unavailable.'
          );
        }
        return sendPptResult(request, response, result);
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

  app.post(
    '/api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/html',
    options.authMiddleware,
    requireCustomerReportHtmlExport,
    (request, response) => {
      try {
        requireEmptyJsonObject(request);
        const result = customerReportDeliveryService.exportHtml({
          user: request.user,
          campaignId: request.params.id,
          snapshotId: request.params.snapshotId,
          requestId: requestId(request)
        });
        try {
          customerReportExportAudit(customerReportExportAuditEvent(
            request,
            request.customerReportExportPermission,
            'html',
            'exported'
          ));
        } catch {
          return sendCustomerReportExportError(
            request,
            response,
            503,
            'CUSTOMER_REPORT_EXPORT_AUDIT_UNAVAILABLE',
            'Customer report export audit is unavailable.'
          );
        }
        return sendHtmlResult(response, result);
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );

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

  app.post(
    '/api/campaigns/:id/performance/content-analysis-draft',
    options.authMiddleware,
    aiLimiter,
    async (request, response) => {
      try {
        const result = await contentAnalysisService.createDraft({
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
    '/api/campaigns/:id/performance/content-analysis-draft/approve',
    options.authMiddleware,
    (request, response) => {
      try {
        const result = contentAnalysisService.approveDraft({
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
