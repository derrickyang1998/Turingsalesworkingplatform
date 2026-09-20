'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');
const {
  AIConcurrencyServiceError,
  createAIConcurrencyService
} = require('./services/ai_concurrency_service');

function requestId(request) {
  const value = request && request.requestId;
  if (typeof value === 'string' && value.length <= 200 && value.length > 0 &&
      !/[\u0000-\u001f\u007f]/.test(value)) return value;
  return crypto.randomUUID();
}

function exactConcurrencyBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AIConcurrencyServiceError(
      400,
      'AI_ORGANIZATION_CONCURRENCY_INVALID',
      'Request body is invalid.'
    );
  }
  const expected = ['concurrency_limit', 'expected_version', 'reason'];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new AIConcurrencyServiceError(
      400,
      'AI_ORGANIZATION_CONCURRENCY_INVALID',
      'Request body must contain only concurrency_limit, expected_version, and reason.'
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (expected.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new AIConcurrencyServiceError(
      400,
      'AI_ORGANIZATION_CONCURRENCY_INVALID',
      'Request body accessors are not supported.'
    );
  }
  const concurrencyLimit = descriptors.concurrency_limit.value;
  const expectedVersion = descriptors.expected_version.value;
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 0 || concurrencyLimit > 64 ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new AIConcurrencyServiceError(
      400,
      'AI_ORGANIZATION_CONCURRENCY_INVALID',
      'concurrency_limit must be 0 through 64 and expected_version must be positive.'
    );
  }
  return {
    concurrencyLimit,
    expectedVersion,
    reason: descriptors.reason.value
  };
}

function sendError(response, id, error) {
  const status = Number.isSafeInteger(error && (error.statusCode || error.status))
    ? error.statusCode || error.status
    : 500;
  if (error && (error.retryAfterSeconds || error.retryAfter)) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds || error.retryAfter));
  }
  return response.status(status).json({
    error: error && error.message || 'Organization AI concurrency request failed.',
    code: error && error.code || 'AI_CONCURRENCY_REQUEST_FAILED',
    request_id: id
  });
}

function registerAdminAIConcurrencyRoutes(app, db, options = {}) {
  const authMiddleware = options.authMiddleware;
  const adminOnly = options.adminOnly;
  if (typeof authMiddleware !== 'function' || typeof adminOnly !== 'function') {
    throw new TypeError('authMiddleware and adminOnly are required');
  }
  const service = options.service || createAIConcurrencyService(db);

  app.get('/api/organization-ai-concurrency', authMiddleware, (request, response) => {
    const id = requestId(request);
    try {
      return response.json({
        concurrency: service.currentOrganizationConcurrency({
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
    '/api/admin/organizations/:organizationId/ai-concurrency',
    authMiddleware,
    adminOnly,
    (request, response) => {
      const id = requestId(request);
      try {
        const body = exactConcurrencyBody(request.body);
        const concurrency = service.updateOrganizationConcurrencyPolicy({
          actorUserId: request.user && request.user.id,
          organizationId: Number(request.params.organizationId),
          ...body,
          requestId: id,
          ipAddress: request.ip
        });
        return response.json({ success: true, concurrency, request_id: id });
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );
}

module.exports = registerAdminAIConcurrencyRoutes;
module.exports.exactConcurrencyBody = exactConcurrencyBody;
