'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');
const {
  AIQuotaServiceError,
  createAIQuotaService
} = require('./services/ai_quota_service');

function requestId(request) {
  const value = request && request.requestId;
  if (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) return value;
  return crypto.randomUUID();
}

function sendError(response, id, error) {
  const statusCode = Number.isSafeInteger(error && (error.statusCode || error.status))
    ? error.statusCode || error.status
    : 500;
  return response.status(statusCode).json({
    error: error && error.message || 'AI Token quota update failed.',
    code: error && error.code || 'AI_QUOTA_UPDATE_FAILED',
    request_id: id
  });
}

function exactOrganizationQuotaBody(value) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new AIQuotaServiceError(
      400,
      'AI_ORGANIZATION_QUOTA_INVALID',
      'Request body is invalid.'
    );
  }
  const keys = Object.keys(value).sort();
  const expected = ['expected_version', 'monthly_limit', 'reason'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new AIQuotaServiceError(
      400,
      'AI_ORGANIZATION_QUOTA_INVALID',
      'Request body must contain only monthly_limit, expected_version, and reason.'
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (expected.some((key) => (
    !descriptors[key] ||
    !Object.hasOwn(descriptors[key], 'value') ||
    descriptors[key].get !== undefined ||
    descriptors[key].set !== undefined
  ))) {
    throw new AIQuotaServiceError(
      400,
      'AI_ORGANIZATION_QUOTA_INVALID',
      'Request body accessors are not supported.'
    );
  }
  const expectedVersion = descriptors.expected_version.value;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
    throw new AIQuotaServiceError(
      400,
      'AI_ORGANIZATION_QUOTA_INVALID',
      'expected_version must be a positive integer.'
    );
  }
  return {
    monthlyLimit: descriptors.monthly_limit.value,
    expectedVersion,
    reason: descriptors.reason.value
  };
}

function registerAdminAIQuotaRoutes(app, db, options = {}) {
  const authMiddleware = options.authMiddleware;
  const adminOnly = options.adminOnly;
  if (typeof authMiddleware !== 'function' || typeof adminOnly !== 'function') {
    throw new TypeError('authMiddleware and adminOnly are required');
  }
  const service = options.service || createAIQuotaService(db);

  app.get('/api/organization-ai-quota', authMiddleware, (request, response) => {
    const id = requestId(request);
    try {
      return response.json({
        quota: service.currentOrganizationQuota({
          actorUserId: request.user && request.user.id,
          organizationId: request.authContext && request.authContext.organization &&
            request.authContext.organization.id
        }),
        request_id: id
      });
    } catch (error) {
      return sendError(response, id, error);
    }
  });

  app.put(
    '/api/admin/users/:userId/ai-quota',
    authMiddleware,
    adminOnly,
    (request, response) => {
      const id = requestId(request);
      try {
        const quota = service.updateUserQuota({
          actorUserId: request.user && request.user.id,
          userId: request.params.userId,
          quota: request.body && request.body.api_quota,
          requestId: id,
          ipAddress: request.ip
        });
        return response.json({ success: true, quota, request_id: id });
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );

  app.put(
    '/api/admin/organizations/:organizationId/ai-quota',
    authMiddleware,
    adminOnly,
    (request, response) => {
      const id = requestId(request);
      try {
        const body = exactOrganizationQuotaBody(request.body);
        const quota = service.updateOrganizationMonthlyQuota({
          actorUserId: request.user && request.user.id,
          organizationId: request.params.organizationId,
          ...body,
          requestId: id,
          ipAddress: request.ip
        });
        return response.json({ success: true, quota, request_id: id });
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );
}

module.exports = registerAdminAIQuotaRoutes;
module.exports.exactOrganizationQuotaBody = exactOrganizationQuotaBody;
