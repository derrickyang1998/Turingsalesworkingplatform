'use strict';

const tokenUsage = require('./token_usage_service');

const PERIOD = 'legacy_lifetime';
const MAX_SAFE_QUOTA = Number.MAX_SAFE_INTEGER;

class AIQuotaServiceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AIQuotaServiceError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}

function serviceError(statusCode, code, message) {
  return new AIQuotaServiceError(statusCode, code, message);
}

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw serviceError(503, 'AI_QUOTA_POLICY_UNAVAILABLE', `${label} is unavailable.`);
  }
  return parsed;
}

function boundedText(value, maximum) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function normalizeQuota(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_QUOTA) {
    throw serviceError(400, 'AI_QUOTA_INVALID', 'AI Token quota must be a non-negative safe integer.');
  }
  return value;
}

function policyUnavailable() {
  return serviceError(503, 'AI_QUOTA_POLICY_UNAVAILABLE', 'AI Token quota policy is unavailable.');
}

function readLivePolicy(db, input) {
  const organizationId = positiveId(input && input.organizationId, 'organizationId');
  const userId = positiveId(input && input.userId, 'userId');
  let row;
  try {
    row = db.prepare(`
      SELECT user.id,user.role,user.api_quota,user.is_active,
        membership.status AS membership_status
      FROM users user
      LEFT JOIN organization_memberships membership
        ON membership.org_id=? AND membership.user_id=user.id
      WHERE user.id=?
    `).get(organizationId, userId);
  } catch (_error) {
    throw policyUnavailable();
  }
  if (!row || row.is_active !== 1 || row.membership_status !== 'active') {
    throw policyUnavailable();
  }
  let limit;
  try {
    limit = normalizeQuota(row.api_quota);
  } catch (_error) {
    throw policyUnavailable();
  }
  let used;
  try {
    used = tokenUsage.sumForUser(db, { organizationId, userId });
  } catch (_error) {
    throw policyUnavailable();
  }
  if (!Number.isSafeInteger(used) || used < 0) throw policyUnavailable();
  const exempt = row.role === 'admin';
  return {
    organization_id: organizationId,
    user_id: userId,
    period: PERIOD,
    used,
    limit,
    remaining: exempt ? null : Math.max(0, limit - used),
    status: exempt ? 'exempt' : limit === 0 ? 'disabled' : used >= limit ? 'exhausted' : 'active'
  };
}

function denialError(decision) {
  if (decision.status === 'disabled') {
    return serviceError(429, 'AI_QUOTA_DISABLED', 'AI access is disabled because the Token quota is zero.');
  }
  return serviceError(429, 'AI_QUOTA_EXCEEDED', 'AI Token quota has been exhausted.');
}

function writeDenialAudit(db, input, decision, error) {
  const details = JSON.stringify({
    schema_version: 1,
    organization_id: decision.organization_id,
    target_user_id: decision.user_id,
    period: decision.period,
    used_tokens: decision.used,
    limit_tokens: decision.limit,
    remaining_tokens: decision.remaining,
    reason_code: error.code,
    endpoint: boundedText(input && input.endpoint, 120),
    request_id: boundedText(input && input.requestId, 200)
  });
  try {
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,'ai_quota_denied','ai_quota',?,?)
    `).run(
      decision.user_id,
      details,
      boundedText(input && input.ipAddress, 128)
    );
  } catch (_error) {
    throw serviceError(503, 'AI_QUOTA_POLICY_UNAVAILABLE', 'AI Token quota denial could not be audited.');
  }
}

function assertAdmission(db, input) {
  const decision = readLivePolicy(db, input || {});
  if (decision.status === 'active' || decision.status === 'exempt') return decision;
  const error = denialError(decision);
  const persist = db.transaction(() => writeDenialAudit(db, input || {}, decision, error));
  persist.immediate();
  throw error;
}

function normalizedUserIds(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const ids = [];
  const seen = new Set();
  for (const candidate of value) {
    const id = Number(candidate);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw serviceError(400, 'AI_QUOTA_INVALID', 'User identifiers are invalid.');
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function projectMembershipUsage(db, input) {
  const userIds = normalizedUserIds(input && input.userIds);
  if (userIds.length === 0) return [];
  if (!tokenUsage.hasOrganizationOwnership(db)) throw policyUnavailable();
  const placeholders = userIds.map(() => '?').join(',');
  let rows;
  try {
    rows = db.prepare(`
      SELECT
        membership.org_id AS organization_id,
        membership.user_id,
        membership.status AS membership_status,
        user.role,
        user.is_active,
        user.api_quota,
        COALESCE(SUM(usage.total_tokens),0) AS used
      FROM organization_memberships membership
      JOIN users user ON user.id=membership.user_id
      LEFT JOIN token_usage usage
        ON usage.org_id=membership.org_id AND usage.user_id=membership.user_id
      WHERE membership.user_id IN (${placeholders})
      GROUP BY membership.org_id,membership.user_id,membership.status,
        user.role,user.is_active,user.api_quota
      ORDER BY membership.user_id,membership.org_id
    `).all(...userIds);
  } catch (_error) {
    throw policyUnavailable();
  }
  return rows.map((row) => {
    let limit;
    try {
      limit = normalizeQuota(row.api_quota);
    } catch (_error) {
      throw policyUnavailable();
    }
    const used = Number(row.used || 0);
    if (!Number.isSafeInteger(used) || used < 0) throw policyUnavailable();
    let status = 'active';
    if (row.membership_status !== 'active') status = 'revoked';
    else if (row.is_active !== 1) status = 'inactive';
    else if (row.role === 'admin') status = 'exempt';
    else if (limit === 0) status = 'disabled';
    else if (used >= limit) status = 'exhausted';
    return {
      organization_id: Number(row.organization_id),
      user_id: Number(row.user_id),
      period: PERIOD,
      used,
      limit,
      remaining: status === 'exempt' ? null : Math.max(0, limit - used),
      status
    };
  });
}

function recordUsageOrThrow(db, input) {
  try {
    const source = input || {};
    const promptTokens = Number(source.promptTokens);
    const completionTokens = Number(source.completionTokens);
    const totalTokens = Number(source.totalTokens);
    if (
      !Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
      !Number.isSafeInteger(completionTokens) || completionTokens < 0 ||
      !Number.isSafeInteger(totalTokens) || totalTokens < 0 ||
      totalTokens !== promptTokens + completionTokens ||
      (totalTokens === 0 && source.allowZeroUsage !== true)
    ) {
      throw new TypeError('Trusted AI token usage is missing or inconsistent.');
    }
    return tokenUsage.recordUsage(db, Object.assign({}, source, {
      promptTokens,
      completionTokens,
      totalTokens,
      recordZeroUsage: totalTokens === 0 && source.allowZeroUsage === true
    }));
  } catch (_error) {
    throw serviceError(503, 'AI_USAGE_ACCOUNTING_FAILED', 'AI Token usage could not be recorded safely.');
  }
}

function updatedQuotaStatus(db, target, quota) {
  if (target.is_active !== 1) return 'inactive';
  if (target.role === 'admin') return 'exempt';
  if (quota === 0) return 'disabled';
  const statuses = new Set(projectMembershipUsage(db, { userIds: [target.id] })
    .map((projection) => projection.status));
  if (statuses.has('exhausted')) return 'exhausted';
  if (statuses.has('active')) return 'active';
  if (statuses.has('revoked')) return 'revoked';
  return 'unassigned';
}

function writeQuotaUpdateAuditInTransaction(db, input) {
  const actorUserId = positiveId(input && input.actorUserId, 'actorUserId');
  const targetUserId = positiveId(input && input.targetUserId, 'targetUserId');
  const before = normalizeQuota(input && input.before);
  const after = normalizeQuota(input && input.after);
  const details = JSON.stringify({
    schema_version: 1,
    actor_user_id: actorUserId,
    target_user_id: targetUserId,
    period: PERIOD,
    before: { api_quota: before },
    after: { api_quota: after },
    request_id: boundedText(input && input.requestId, 200)
  });
  try {
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,'admin_update_ai_quota','ai_quota',?,?)
    `).run(actorUserId, details, boundedText(input && input.ipAddress, 128));
  } catch (_error) {
    throw serviceError(500, 'AI_QUOTA_AUDIT_FAILED', 'AI Token quota update could not be audited.');
  }
}

function updateUserQuota(db, input) {
  const actorUserId = positiveId(input && input.actorUserId, 'actorUserId');
  const targetUserId = positiveId(input && input.userId, 'userId');
  const quota = normalizeQuota(input && input.quota);
  const update = db.transaction(() => {
    const actor = db.prepare(`
      SELECT id,role,is_active FROM users WHERE id=?
    `).get(actorUserId);
    if (!actor || actor.role !== 'admin' || actor.is_active !== 1) {
      throw serviceError(403, 'AI_QUOTA_UPDATE_FORBIDDEN', 'Only an active platform administrator may update AI quota.');
    }
    const target = db.prepare(`
      SELECT id,role,is_active,api_quota FROM users WHERE id=?
    `).get(targetUserId);
    if (!target) throw serviceError(404, 'AI_QUOTA_USER_NOT_FOUND', 'User was not found.');
    const before = normalizeQuota(target.api_quota);
    if (before !== quota) {
      db.prepare('UPDATE users SET api_quota=? WHERE id=?').run(quota, targetUserId);
      writeQuotaUpdateAuditInTransaction(db, {
        actorUserId,
        targetUserId,
        before,
        after: quota,
        requestId: input && input.requestId,
        ipAddress: input && input.ipAddress
      });
    }
    return {
      user_id: targetUserId,
      period: PERIOD,
      limit: quota,
      status: updatedQuotaStatus(db, target, quota),
      changed: before !== quota
    };
  });
  return update.immediate();
}

function createAIQuotaService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }
  return Object.freeze({
    assertAdmission(input) { return assertAdmission(db, input || {}); },
    projectMembershipUsage(input) { return projectMembershipUsage(db, input || {}); },
    recordUsageOrThrow(input) { return recordUsageOrThrow(db, input || {}); },
    updateUserQuota(input) { return updateUserQuota(db, input || {}); }
  });
}

module.exports = {
  AIQuotaServiceError,
  PERIOD,
  assertAdmission,
  createAIQuotaService,
  normalizeQuota,
  projectMembershipUsage,
  readLivePolicy,
  recordUsageOrThrow,
  updateUserQuota,
  writeQuotaUpdateAuditInTransaction
};
