'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');
const {
  SubscriptionExpiryServiceError,
  createSubscriptionExpiryService
} = require('./services/subscription_expiry_service');

function requestId(request) {
  const candidates = [
    request && request.requestId,
    request && request.phase4Request && request.phase4Request.requestId
  ];
  for (const value of candidates) {
    if (
      typeof value === 'string' && value.length >= 1 && value.length <= 120 &&
      !/[\u0000-\u001f\u007f]/.test(value)
    ) return value;
  }
  return crypto.randomUUID();
}

function exactSubscriptionBody(value) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new SubscriptionExpiryServiceError(400, 'INVALID_SUBSCRIPTION_TERM', 'Request body is invalid.');
  }
  const keys = Object.keys(value).sort();
  const expected = ['expected_version', 'expires_at', 'reason'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new SubscriptionExpiryServiceError(
      400,
      'INVALID_SUBSCRIPTION_TERM',
      'Request body must contain only expires_at, expected_version, and reason.'
    );
  }
  return {
    expiresAt: value.expires_at,
    expectedVersion: value.expected_version,
    reason: value.reason
  };
}

function sendError(response, id, error) {
  const known = error instanceof SubscriptionExpiryServiceError ||
    error && error.name === 'SubscriptionExpiryServiceError';
  if (known) {
    return response.status(error.status || error.statusCode).json({
      error: error.message,
      code: error.code,
      request_id: id
    });
  }
  return response.status(500).json({
    error: 'Subscription expiry request failed.',
    code: 'SUBSCRIPTION_INTERNAL_ERROR',
    request_id: id
  });
}

function auditContext(request, id) {
  return {
    actorUserId: request.user && request.user.id,
    requestId: id,
    ipAddress: request.ip
  };
}

function registerSubscriptionExpiryRoutes(app, db, options = {}) {
  const authMiddleware = options.authMiddleware;
  const adminOnly = options.adminOnly;
  if (typeof authMiddleware !== 'function' || typeof adminOnly !== 'function') {
    throw new TypeError('authMiddleware and adminOnly are required');
  }
  const service = options.service || createSubscriptionExpiryService(db);

  app.get('/api/organization-subscription', authMiddleware, (request, response) => {
    const id = requestId(request);
    try {
      return response.json({
        subscription: service.currentForMember({
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
    '/api/admin/organizations/:organizationId/subscription',
    authMiddleware,
    adminOnly,
    (request, response) => {
      const id = requestId(request);
      try {
        const body = exactSubscriptionBody(request.body);
        return response.json({
          subscription: service.updateForAdmin({
            ...auditContext(request, id),
            organizationId: request.params.organizationId,
            ...body
          }),
          request_id: id
        });
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );
}

module.exports = registerSubscriptionExpiryRoutes;
module.exports.exactSubscriptionBody = exactSubscriptionBody;
