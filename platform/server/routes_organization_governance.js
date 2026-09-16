'use strict';

const crypto = require('node:crypto');
const {
  OrganizationGovernanceServiceError,
  createOrganizationGovernanceService,
  validateMemberBody,
  validateOwnerBody
} = require('./services/organization_governance_service');

function requestId(request) {
  const candidates = [
    request && request.requestId,
    request && request.phase4Request && request.phase4Request.requestId
  ];
  for (const value of candidates) {
    if (
      typeof value === 'string' &&
      value.length >= 1 &&
      value.length <= 120 &&
      !/[\u0000-\u001f\u007f]/.test(value)
    ) return value;
  }
  return crypto.randomUUID();
}

function actor(request) {
  return {
    id: request.user && request.user.id,
    role: request.user && request.user.role
  };
}

function inputContext(request, id) {
  return {
    actor: actor(request),
    requestId: id,
    ipAddress: request.ip
  };
}

function sendError(response, id, error) {
  const known = error instanceof OrganizationGovernanceServiceError ||
    error && error.name === 'OrganizationGovernanceServiceError';
  if (known) {
    return response.status(error.status).json({
      error: error.message,
      code: error.code,
      request_id: id
    });
  }
  return response.status(500).json({
    error: '组织治理请求处理失败。',
    code: 'ORGANIZATION_GOVERNANCE_INTERNAL_ERROR',
    request_id: id
  });
}

function registerOrganizationGovernanceRoutes(app, db, options = {}) {
  const authMiddleware = options.authMiddleware;
  if (typeof authMiddleware !== 'function') {
    throw new TypeError('authMiddleware is required');
  }
  const service = options.service || createOrganizationGovernanceService(db);

  app.get('/api/organization-governance/organizations', authMiddleware, (request, response) => {
    const id = requestId(request);
    try {
      return response.json(service.listOrganizations({
        ...inputContext(request, id),
        query: request.query
      }));
    } catch (error) {
      return sendError(response, id, error);
    }
  });

  app.get(
    '/api/organization-governance/organizations/:organizationId/members',
    authMiddleware,
    (request, response) => {
      const id = requestId(request);
      try {
        return response.json(service.listMembers({
          ...inputContext(request, id),
          organizationId: request.params.organizationId,
          query: request.query
        }));
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );

  app.post(
    '/api/organization-governance/organizations/:organizationId/owner/initialize',
    authMiddleware,
    (request, response) => {
      const id = requestId(request);
      try {
        const body = validateOwnerBody(request.body);
        service.initializeOwner({
          ...inputContext(request, id),
          organizationId: request.params.organizationId,
          body
        });
        return response.json({ success: true, request_id: id });
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );

  app.patch(
    '/api/organization-governance/organizations/:organizationId/members/:userId',
    authMiddleware,
    (request, response) => {
      const id = requestId(request);
      try {
        const body = validateMemberBody(request.body);
        service.updateMember({
          ...inputContext(request, id),
          organizationId: request.params.organizationId,
          userId: request.params.userId,
          body
        });
        return response.json({ success: true, request_id: id });
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );
}

module.exports = registerOrganizationGovernanceRoutes;
