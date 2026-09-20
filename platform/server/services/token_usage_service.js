'use strict';

class TokenUsageServiceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'TokenUsageServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TokenUsageServiceError(400, 'TOKEN_USAGE_INPUT_INVALID', `${label} is invalid.`);
  }
  return parsed;
}

function tokenCount(value, label) {
  const parsed = Number(value === undefined || value === null ? 0 : value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TokenUsageServiceError(400, 'TOKEN_USAGE_INPUT_INVALID', `${label} is invalid.`);
  }
  return parsed;
}

function boundedText(value, label, maximum, required = true) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if ((required && !text) || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TokenUsageServiceError(400, 'TOKEN_USAGE_INPUT_INVALID', `${label} is invalid.`);
  }
  return text || null;
}

function hasOrganizationOwnership(db) {
  return Boolean(db.prepare(`
    SELECT 1 AS present FROM pragma_table_info('token_usage') WHERE name='org_id'
  `).get());
}

function requireOrganizationOwnership(db) {
  if (!hasOrganizationOwnership(db)) {
    throw new TokenUsageServiceError(
      503,
      'TOKEN_USAGE_SCHEMA_UNAVAILABLE',
      'Token usage organization ownership is unavailable.'
    );
  }
}

function requireActiveMembership(db, organizationId, userId) {
  const membership = db.prepare(`
    SELECT 1 AS present FROM organization_memberships
    WHERE org_id=? AND user_id=? AND status='active'
  `).get(organizationId, userId);
  if (!membership) {
    throw new TokenUsageServiceError(
      403,
      'TOKEN_USAGE_ORGANIZATION_FORBIDDEN',
      'Token usage organization ownership is forbidden.'
    );
  }
}

function normalizedUsage(input) {
  return {
    organizationId: positiveId(input && input.organizationId, 'organizationId'),
    userId: positiveId(input && input.userId, 'userId'),
    model: boundedText(input && input.model, 'model', 120),
    promptTokens: tokenCount(input && input.promptTokens, 'promptTokens'),
    completionTokens: tokenCount(input && input.completionTokens, 'completionTokens'),
    totalTokens: tokenCount(input && input.totalTokens, 'totalTokens'),
    endpoint: boundedText(input && input.endpoint, 'endpoint', 120, false)
  };
}

function recordUsage(db, input) {
  requireOrganizationOwnership(db);
  const usage = normalizedUsage(input || {});
  const recordZeroUsage = input && input.recordZeroUsage === true;
  if (!recordZeroUsage && !usage.promptTokens && !usage.completionTokens && !usage.totalTokens) {
    return { id: null, ...usage };
  }
  requireActiveMembership(db, usage.organizationId, usage.userId);
  const result = db.prepare(`
    INSERT INTO token_usage (
      org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint
    ) VALUES (?,?,?,?,?,?,?)
  `).run(
    usage.organizationId,
    usage.userId,
    usage.model,
    usage.promptTokens,
    usage.completionTokens,
    usage.totalTokens,
    usage.endpoint
  );
  return { id: Number(result.lastInsertRowid), ...usage };
}

function sumForUser(db, input) {
  requireOrganizationOwnership(db);
  const userId = positiveId(input && input.userId, 'userId');
  const organizationId = positiveId(input && input.organizationId, 'organizationId');
  return Number(db.prepare(`
    SELECT COALESCE(SUM(total_tokens),0) AS total
    FROM token_usage WHERE org_id=? AND user_id=?
  `).get(organizationId, userId).total || 0);
}

function canonicalLedgerBoundary(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value.replace(' ', 'T') + 'Z'))
  ) {
    throw new TokenUsageServiceError(400, 'TOKEN_USAGE_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function sumForOrganizationPeriod(db, input) {
  requireOrganizationOwnership(db);
  const organizationId = positiveId(input && input.organizationId, 'organizationId');
  const periodStart = canonicalLedgerBoundary(input && input.periodStart, 'periodStart');
  const periodEnd = canonicalLedgerBoundary(input && input.periodEnd, 'periodEnd');
  if (periodStart >= periodEnd) {
    throw new TokenUsageServiceError(400, 'TOKEN_USAGE_INPUT_INVALID', 'Token usage period is invalid.');
  }
  return Number(db.prepare(`
    SELECT COALESCE(SUM(total_tokens),0) AS total
    FROM token_usage
    WHERE org_id=? AND created_at>=? AND created_at<?
  `).get(organizationId, periodStart, periodEnd).total || 0);
}

function globalUsage(db) {
  return db.prepare(`
    SELECT organization.id AS organization_id,organization.name AS organization_name,
      u.username,u.display_name,u.department,
      COALESCE(SUM(usage.total_tokens),0) AS total_tokens,
      COALESCE(SUM(usage.prompt_tokens),0) AS prompt_tokens,
      COALESCE(SUM(usage.completion_tokens),0) AS completion_tokens,
      COUNT(usage.id) AS request_count,
      MAX(usage.created_at) AS last_used
    FROM token_usage usage
    JOIN users u ON u.id=usage.user_id
    JOIN organizations organization ON organization.id=usage.org_id
    GROUP BY usage.org_id,u.id
    ORDER BY total_tokens DESC,usage.org_id,u.id
  `).all();
}

function ownUsage(db, organizationId, userId) {
  return db.prepare(`
    SELECT id,model,prompt_tokens,completion_tokens,total_tokens,endpoint,created_at
    FROM token_usage
    WHERE org_id=? AND user_id=?
    ORDER BY created_at DESC,id DESC LIMIT 100
  `).all(organizationId, userId);
}

function writeGlobalReadAudit(db, input, rows) {
  const organizationCount = Number(
    db.prepare(`SELECT COUNT(DISTINCT org_id) AS count FROM token_usage`).get().count || 0
  );
  const details = JSON.stringify({
    request_id: boundedText(input.requestId, 'requestId', 160, false),
    scope: 'global',
    active_organization_id: input.organizationId,
    organization_count: organizationCount,
    row_count: rows.length
  });
  db.prepare(`
    INSERT INTO activity_log (user_id,action,module,details,ip_address)
    VALUES (?,'admin_list_token_usage','token_usage_audit',?,?)
  `).run(input.user.id, details, input.ipAddress || null);
}

function listUsage(db, input) {
  requireOrganizationOwnership(db);
  const user = input && input.user;
  const userId = positiveId(user && user.id, 'userId');
  const organizationId = positiveId(input && input.organizationId, 'organizationId');
  if (input && input.adminAuditGlobal === true) {
    if (!user || user.role !== 'admin') {
      throw new TokenUsageServiceError(
        403,
        'TOKEN_USAGE_ADMIN_AUDIT_FORBIDDEN',
        'Only a platform administrator may audit global token usage.'
      );
    }
    const rows = globalUsage(db);
    writeGlobalReadAudit(db, {
      user: { id: userId },
      organizationId,
      requestId: input.requestId,
      ipAddress: input.ipAddress
    }, rows);
    return rows;
  }
  return ownUsage(db, organizationId, userId);
}

module.exports = {
  TokenUsageServiceError,
  hasOrganizationOwnership,
  listUsage,
  recordUsage,
  sumForOrganizationPeriod,
  sumForUser
};
