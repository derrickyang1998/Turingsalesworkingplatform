'use strict';

const { randomUUID } = require('node:crypto');
const {
  AdminTenantDirectoryServiceError,
  createAdminTenantDirectoryService
} = require('./services/admin_tenant_directory_service');

const generatedRequestIds = new WeakMap();

function validRequestId(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function requestId(request) {
  const upstream = request && (
    request.requestId ||
    request.phase4Request && request.phase4Request.requestId
  );
  if (validRequestId(upstream)) return upstream;
  if (!request || (typeof request !== 'object' && typeof request !== 'function')) return randomUUID();
  let generated = generatedRequestIds.get(request);
  if (!generated) {
    generated = randomUUID();
    generatedRequestIds.set(request, generated);
  }
  return generated;
}

function plainQuery(request) {
  const query = request && request.query;
  if (!query || typeof query !== 'object' || Array.isArray(query)) return {};
  return Object.fromEntries(Object.entries(query));
}

function sendError(request, response, error) {
  const known = error instanceof AdminTenantDirectoryServiceError;
  return response.status(known ? error.statusCode : 500).json({
    error: known ? error.message : 'Tenant directory request failed.',
    code: known ? error.code : 'TENANT_DIRECTORY_REQUEST_FAILED',
    request_id: requestId(request)
  });
}

function registerAdminTenantDirectoryRoutes(app, db, options = {}) {
  const authMiddleware = options.authMiddleware;
  const adminOnly = options.adminOnly;
  const service = options.service || createAdminTenantDirectoryService(db);
  if (typeof authMiddleware !== 'function' || typeof adminOnly !== 'function') {
    throw new TypeError('Tenant directory routes require authentication middleware.');
  }

  app.get('/api/admin/users', authMiddleware, adminOnly, (request, response) => {
    try {
      const result = service.listUsers({
        actor: request.user,
        requestId: requestId(request),
        ipAddress: request.ip,
        query: plainQuery(request)
      });
      return response.json(Object.assign({}, result, { request_id: requestId(request) }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get('/api/admin/organizations', authMiddleware, adminOnly, (request, response) => {
    try {
      const result = service.listOrganizations({
        actor: request.user,
        requestId: requestId(request),
        ipAddress: request.ip,
        query: plainQuery(request)
      });
      return response.json(Object.assign({}, result, { request_id: requestId(request) }));
    } catch (error) {
      return sendError(request, response, error);
    }
  });

  app.get(
    '/api/admin/organizations/:organizationId/members',
    authMiddleware,
    adminOnly,
    (request, response) => {
      try {
        const result = service.listOrganizationMembers({
          actor: request.user,
          organizationId: request.params.organizationId,
          requestId: requestId(request),
          ipAddress: request.ip,
          query: plainQuery(request)
        });
        return response.json(Object.assign({}, result, { request_id: requestId(request) }));
      } catch (error) {
        return sendError(request, response, error);
      }
    }
  );
}

module.exports = registerAdminTenantDirectoryRoutes;
