'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');
const {
  PlanEntitlementServiceError,
  createPlanEntitlementService
} = require('./services/plan_entitlement_service');

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

function exactAssignmentBody(value) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new PlanEntitlementServiceError(400, 'INVALID_PLAN_ASSIGNMENT', 'Request body is invalid.');
  }
  const keys = Object.keys(value).sort();
  const expected = ['expected_version', 'plan_code', 'reason'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new PlanEntitlementServiceError(400, 'INVALID_PLAN_ASSIGNMENT', 'Request body must contain only plan_code, expected_version, and reason.');
  }
  return {
    planCode: value.plan_code,
    expectedVersion: value.expected_version,
    reason: value.reason
  };
}

function sendError(response, id, error) {
  const known = error instanceof PlanEntitlementServiceError ||
    error && error.name === 'PlanEntitlementServiceError';
  if (known) {
    return response.status(error.status || error.statusCode).json({
      error: error.message,
      code: error.code,
      request_id: id
    });
  }
  return response.status(500).json({
    error: 'Plan entitlement request failed.',
    code: 'PLAN_ENTITLEMENT_INTERNAL_ERROR',
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

function registerPlanEntitlementRoutes(app, db, options = {}) {
  const authMiddleware = options.authMiddleware;
  const adminOnly = options.adminOnly;
  if (typeof authMiddleware !== 'function' || typeof adminOnly !== 'function') {
    throw new TypeError('authMiddleware and adminOnly are required');
  }
  const service = options.service || createPlanEntitlementService(db);

  app.get('/api/admin/plan-catalog', authMiddleware, adminOnly, (request, response) => {
    const id = requestId(request);
    try {
      return response.json({
        catalog: service.listCatalog(auditContext(request, id)),
        request_id: id
      });
    } catch (error) {
      return sendError(response, id, error);
    }
  });

  app.get('/api/organization-entitlements', authMiddleware, (request, response) => {
    const id = requestId(request);
    try {
      return response.json({
        entitlements: service.currentForMember({
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
    '/api/admin/organizations/:organizationId/plan',
    authMiddleware,
    adminOnly,
    (request, response) => {
      const id = requestId(request);
      try {
        const body = exactAssignmentBody(request.body);
        return response.json({
          assignment: service.assignForAdmin({
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

module.exports = registerPlanEntitlementRoutes;
module.exports.exactAssignmentBody = exactAssignmentBody;
