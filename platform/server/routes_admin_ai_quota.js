'use strict';

const crypto = require('node:crypto');
const { createAIQuotaService } = require('./services/ai_quota_service');

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

function registerAdminAIQuotaRoutes(app, db, options = {}) {
  const authMiddleware = options.authMiddleware;
  const adminOnly = options.adminOnly;
  if (typeof authMiddleware !== 'function' || typeof adminOnly !== 'function') {
    throw new TypeError('authMiddleware and adminOnly are required');
  }
  const service = options.service || createAIQuotaService(db);

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
}

module.exports = registerAdminAIQuotaRoutes;
