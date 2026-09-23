'use strict';

const { randomUUID } = require('node:crypto');
const {
  AdminOperationsServiceError,
  createAdminOperationsService
} = require('./services/admin_operations_service');

function requestId(request) {
  const value = request && request.requestId;
  return typeof value === 'string' && value.length > 0 && value.length <= 120
    ? value
    : randomUUID();
}

function registerAdminOperationsRoutes(app, db, options = {}) {
  const authMiddleware = options.authMiddleware;
  const adminOnly = options.adminOnly;
  const service = options.service || createAdminOperationsService(db);
  if (typeof authMiddleware !== 'function' || typeof adminOnly !== 'function') {
    throw new TypeError('Admin operations routes require authentication middleware.');
  }
  app.get('/api/admin/operations', authMiddleware, adminOnly, (request, response) => {
    const id = requestId(request);
    try {
      const result = service.listOperations({
        actor: request.user,
        requestId: id,
        ipAddress: request.ip,
        query: request.query && typeof request.query === 'object' ? { ...request.query } : {}
      });
      return response.json({ ...result, request_id: id });
    } catch (error) {
      const known = error instanceof AdminOperationsServiceError;
      return response.status(known ? error.statusCode : 500).json({
        error: known ? error.message : 'Admin operations request failed.',
        code: known ? error.code : 'ADMIN_OPERATIONS_REQUEST_FAILED',
        request_id: id
      });
    }
  });
}

module.exports = registerAdminOperationsRoutes;
