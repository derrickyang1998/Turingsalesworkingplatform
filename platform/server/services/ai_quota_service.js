'use strict';

const tokenUsage = require('./token_usage_service');

const PERIOD = 'legacy_lifetime';
const ORGANIZATION_PERIOD = 'utc_calendar_month';
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

function normalizeOrganizationMonthlyLimit(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_QUOTA) {
    throw serviceError(
      400,
      'AI_ORGANIZATION_QUOTA_INVALID',
      'Organization monthly AI Token quota must be null or a non-negative safe integer.'
    );
  }
  return value;
}

function strictPositiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_SAFE_QUOTA) {
    throw serviceError(400, 'AI_ORGANIZATION_QUOTA_INVALID', `${label} must be a positive integer.`);
  }
  return parsed;
}

function strictPositiveIntegerValue(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_SAFE_QUOTA) {
    throw serviceError(400, 'AI_ORGANIZATION_QUOTA_INVALID', `${label} must be a positive integer.`);
  }
  return value;
}

function reasonText(value) {
  const reason = boundedText(value, 500);
  if (!reason) {
    throw serviceError(
      400,
      'AI_ORGANIZATION_QUOTA_INVALID',
      'reason is required and must be at most 500 characters.'
    );
  }
  return reason;
}

function utcMonthWindow(nowMs) {
  const milliseconds = nowMs instanceof Date ? nowMs.getTime() : Number(nowMs);
  if (!Number.isFinite(milliseconds)) throw policyUnavailable();
  const now = new Date(milliseconds);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const startIso = start.toISOString().replace('.000Z', 'Z');
  const endIso = end.toISOString().replace('.000Z', 'Z');
  return {
    key: startIso.slice(0, 7),
    startIso,
    endIso,
    startLedger: startIso.replace('T', ' ').replace('Z', ''),
    endLedger: endIso.replace('T', ' ').replace('Z', '')
  };
}

function policyUnavailable() {
  return serviceError(503, 'AI_QUOTA_POLICY_UNAVAILABLE', 'AI Token quota policy is unavailable.');
}

function normalizedOrganizationIds(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const ids = [];
  const seen = new Set();
  for (const candidate of value) {
    const id = strictPositiveId(candidate, 'organizationId');
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function organizationQuotaStatus(limit, used) {
  if (limit === null) return 'unlimited';
  if (limit === 0) return 'disabled';
  return used >= limit ? 'exhausted' : 'active';
}

function projectOrganizationQuotas(db, input, nowMs = Date.now()) {
  const organizationIds = normalizedOrganizationIds(input && input.organizationIds);
  if (organizationIds.length === 0) return [];
  const window = utcMonthWindow(nowMs);
  const placeholders = organizationIds.map(() => '?').join(',');
  let rows;
  try {
    rows = db.prepare(`
      SELECT organization.id AS organization_id,
        policy.policy_version,policy.monthly_limit
      FROM organizations organization
      LEFT JOIN organization_ai_quota_policies policy
        ON policy.id=(
          SELECT current.id
          FROM organization_ai_quota_policies current
          WHERE current.org_id=organization.id
          ORDER BY current.policy_version DESC
          LIMIT 1
        )
      WHERE organization.id IN (${placeholders})
      ORDER BY organization.id
    `).all(...organizationIds);
  } catch (_error) {
    throw policyUnavailable();
  }
  if (rows.length !== organizationIds.length) throw policyUnavailable();
  return rows.map((row) => {
    if (!Number.isSafeInteger(row.policy_version) || row.policy_version < 1) {
      throw policyUnavailable();
    }
    let limit;
    try {
      limit = normalizeOrganizationMonthlyLimit(row.monthly_limit);
    } catch (_error) {
      throw policyUnavailable();
    }
    let used;
    try {
      used = tokenUsage.sumForOrganizationPeriod(db, {
        organizationId: row.organization_id,
        periodStart: window.startLedger,
        periodEnd: window.endLedger
      });
    } catch (_error) {
      throw policyUnavailable();
    }
    if (!Number.isSafeInteger(used) || used < 0) throw policyUnavailable();
    const status = organizationQuotaStatus(limit, used);
    const overageTokens = limit === null ? 0 : Math.max(0, used - limit);
    const utilizationPercent = limit === null || limit === 0
      ? null
      : Number(((used / limit) * 100).toFixed(2));
    return {
      organization_id: Number(row.organization_id),
      period: ORGANIZATION_PERIOD,
      period_key: window.key,
      period_start: window.startIso,
      period_end: window.endIso,
      used,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used),
      overage_tokens: overageTokens,
      utilization_percent: utilizationPercent,
      status,
      policy_version: row.policy_version
    };
  });
}

function readOrganizationQuotaProjection(db, input, nowMs = Date.now()) {
  const organizationId = strictPositiveId(input && input.organizationId, 'organizationId');
  const rows = projectOrganizationQuotas(db, { organizationIds: [organizationId] }, nowMs);
  if (rows.length !== 1) throw policyUnavailable();
  return rows[0];
}

function currentOrganizationQuota(db, input, nowMs = Date.now()) {
  const actorUserId = strictPositiveId(input && input.actorUserId, 'actorUserId');
  const organizationId = strictPositiveId(input && input.organizationId, 'organizationId');
  let member;
  try {
    member = db.prepare(`
      SELECT user.id
      FROM users user
      JOIN organization_memberships membership
        ON membership.user_id=user.id AND membership.org_id=?
      WHERE user.id=? AND user.is_active=1 AND membership.status='active'
    `).get(organizationId, actorUserId);
  } catch (_error) {
    throw policyUnavailable();
  }
  if (!member) {
    throw serviceError(
      403,
      'AI_ORGANIZATION_QUOTA_FORBIDDEN',
      'Organization AI quota is not available to this user.'
    );
  }
  return readOrganizationQuotaProjection(db, { organizationId }, nowMs);
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

function organizationDenialError(decision) {
  if (decision.status === 'disabled') {
    return serviceError(
      429,
      'AI_ORGANIZATION_QUOTA_DISABLED',
      'AI access is disabled for this organization because its monthly quota is zero.'
    );
  }
  return serviceError(
    429,
    'AI_ORGANIZATION_QUOTA_EXCEEDED',
    'The organization monthly AI Token quota has been exhausted.'
  );
}

function writeDenialAudit(db, input, decision, error, scope = 'user_lifetime') {
  const organizationScope = scope === 'organization_monthly';
  const details = JSON.stringify(organizationScope ? {
    schema_version: 2,
    scope,
    organization_id: decision.organization_id,
    target_user_id: strictPositiveId(input && input.userId, 'userId'),
    period: decision.period,
    period_key: decision.period_key,
    period_start: decision.period_start,
    period_end: decision.period_end,
    used_tokens: decision.used,
    limit_tokens: decision.limit,
    remaining_tokens: decision.remaining,
    reason_code: error.code,
    endpoint: boundedText(input && input.endpoint, 120),
    request_id: boundedText(input && input.requestId, 200)
  } : {
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
      organizationScope ? strictPositiveId(input && input.userId, 'userId') : decision.user_id,
      details,
      boundedText(input && input.ipAddress, 128)
    );
  } catch (_error) {
    throw serviceError(503, 'AI_QUOTA_POLICY_UNAVAILABLE', 'AI Token quota denial could not be audited.');
  }
}

function writeBreakGlassAudit(db, input, decision, organizationDecision) {
  const details = JSON.stringify({
    schema_version: 1,
    organization_id: organizationDecision.organization_id,
    actor_user_id: decision.user_id,
    period: organizationDecision.period,
    period_key: organizationDecision.period_key,
    period_start: organizationDecision.period_start,
    period_end: organizationDecision.period_end,
    organization_status: organizationDecision.status,
    used_tokens: organizationDecision.used,
    limit_tokens: organizationDecision.limit,
    overage_tokens: organizationDecision.overage_tokens,
    endpoint: boundedText(input && input.endpoint, 120),
    request_id: boundedText(input && input.requestId, 200)
  });
  try {
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,'ai_quota_break_glass_admitted','ai_quota',?,?)
    `).run(
      decision.user_id,
      details,
      boundedText(input && input.ipAddress, 128)
    );
  } catch (_error) {
    throw serviceError(
      503,
      'AI_QUOTA_POLICY_UNAVAILABLE',
      'AI Token quota break-glass admission could not be audited.'
    );
  }
}

function assertAdmission(db, input, nowMs = Date.now()) {
  const decision = readLivePolicy(db, input || {});
  const organizationDecision = readOrganizationQuotaProjection(db, input || {}, nowMs);
  if (decision.status === 'exempt') {
    if (organizationDecision.status === 'disabled' || organizationDecision.status === 'exhausted') {
      const persist = db.transaction(() => writeBreakGlassAudit(
        db,
        input || {},
        decision,
        organizationDecision
      ));
      persist.immediate();
    }
    return Object.freeze({ ...decision, organization_quota: organizationDecision });
  }
  if (organizationDecision.status === 'disabled' || organizationDecision.status === 'exhausted') {
    const error = organizationDenialError(organizationDecision);
    const persist = db.transaction(() => writeDenialAudit(
      db,
      input || {},
      organizationDecision,
      error,
      'organization_monthly'
    ));
    persist.immediate();
    throw error;
  }
  if (decision.status === 'active') {
    return Object.freeze({ ...decision, organization_quota: organizationDecision });
  }
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

function writeOrganizationQuotaUpdateAudit(db, input) {
  const details = JSON.stringify({
    schema_version: 1,
    actor_user_id: input.actorUserId,
    organization_id: input.organizationId,
    period: ORGANIZATION_PERIOD,
    before: {
      monthly_limit: input.beforeLimit,
      policy_version: input.beforeVersion
    },
    after: {
      monthly_limit: input.afterLimit,
      policy_version: input.afterVersion
    },
    reason: input.reason,
    request_id: boundedText(input.requestId, 200)
  });
  if (Buffer.byteLength(details, 'utf8') > 4096) {
    throw serviceError(
      500,
      'AI_ORGANIZATION_QUOTA_AUDIT_FAILED',
      'Organization AI quota update could not be audited.'
    );
  }
  try {
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,'organization_ai_monthly_quota_changed','ai_quota',?,?)
    `).run(input.actorUserId, details, boundedText(input.ipAddress, 128));
  } catch (_error) {
    throw serviceError(
      500,
      'AI_ORGANIZATION_QUOTA_AUDIT_FAILED',
      'Organization AI quota update could not be audited.'
    );
  }
}

function updateOrganizationMonthlyQuota(db, input, nowMs = Date.now()) {
  const actorUserId = strictPositiveId(input && input.actorUserId, 'actorUserId');
  const organizationId = strictPositiveId(input && input.organizationId, 'organizationId');
  const monthlyLimit = normalizeOrganizationMonthlyLimit(
    input && Object.hasOwn(input, 'monthlyLimit') ? input.monthlyLimit : undefined
  );
  const expectedVersion = strictPositiveIntegerValue(input && input.expectedVersion, 'expectedVersion');
  const reason = reasonText(input && input.reason);
  const update = db.transaction(() => {
    let actor;
    let organization;
    let currentRows;
    try {
      actor = db.prepare('SELECT id,role,is_active FROM users WHERE id=?').get(actorUserId);
      organization = db.prepare('SELECT id FROM organizations WHERE id=?').get(organizationId);
      currentRows = db.prepare(`
        SELECT id,policy_version,monthly_limit
        FROM organization_ai_quota_policies
        WHERE org_id=? AND policy_version=(
          SELECT MAX(current.policy_version)
          FROM organization_ai_quota_policies current
          WHERE current.org_id=?
        )
        ORDER BY id
      `).all(organizationId, organizationId);
    } catch (_error) {
      throw policyUnavailable();
    }
    if (!actor || actor.role !== 'admin' || actor.is_active !== 1) {
      throw serviceError(
        403,
        'AI_ORGANIZATION_QUOTA_UPDATE_FORBIDDEN',
        'Only an active platform administrator may update organization AI quota.'
      );
    }
    if (!organization) {
      throw serviceError(404, 'AI_ORGANIZATION_QUOTA_NOT_FOUND', 'Organization was not found.');
    }
    if (currentRows.length !== 1) throw policyUnavailable();
    const current = currentRows[0];
    if (current.policy_version !== expectedVersion) {
      throw serviceError(
        409,
        'AI_ORGANIZATION_QUOTA_VERSION_CONFLICT',
        'Organization AI quota changed before this request completed.'
      );
    }
    let currentLimit;
    try {
      currentLimit = normalizeOrganizationMonthlyLimit(current.monthly_limit);
    } catch (_error) {
      throw policyUnavailable();
    }
    if (currentLimit === monthlyLimit) {
      return {
        ...readOrganizationQuotaProjection(db, { organizationId }, nowMs),
        changed: false
      };
    }
    const nextVersion = current.policy_version + 1;
    try {
      db.prepare(`
        INSERT INTO organization_ai_quota_policies
          (org_id,policy_version,monthly_limit,changed_by,reason,source)
        VALUES (?, ?, ?, ?, ?, 'admin_update')
      `).run(organizationId, nextVersion, monthlyLimit, actor.id, reason);
    } catch (_error) {
      throw policyUnavailable();
    }
    writeOrganizationQuotaUpdateAudit(db, {
      actorUserId: actor.id,
      organizationId,
      beforeLimit: currentLimit,
      beforeVersion: current.policy_version,
      afterLimit: monthlyLimit,
      afterVersion: nextVersion,
      reason,
      requestId: input && input.requestId,
      ipAddress: input && input.ipAddress
    });
    return {
      ...readOrganizationQuotaProjection(db, { organizationId }, nowMs),
      changed: true
    };
  });
  try {
    return update.immediate();
  } catch (error) {
    if (error instanceof AIQuotaServiceError) throw error;
    throw policyUnavailable();
  }
}

function createAIQuotaService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }
  const now = options.now || Date.now;
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  function currentTime() {
    const value = now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw policyUnavailable();
    return milliseconds;
  }
  return Object.freeze({
    assertAdmission(input) { return assertAdmission(db, input || {}, currentTime()); },
    currentOrganizationQuota(input) {
      return currentOrganizationQuota(db, input || {}, currentTime());
    },
    projectMembershipUsage(input) { return projectMembershipUsage(db, input || {}); },
    projectOrganizationQuotas(input) {
      return projectOrganizationQuotas(db, input || {}, currentTime());
    },
    recordUsageOrThrow(input) { return recordUsageOrThrow(db, input || {}); },
    updateOrganizationMonthlyQuota(input) {
      return updateOrganizationMonthlyQuota(db, input || {}, currentTime());
    },
    updateUserQuota(input) { return updateUserQuota(db, input || {}); }
  });
}

module.exports = {
  AIQuotaServiceError,
  ORGANIZATION_PERIOD,
  PERIOD,
  assertAdmission,
  createAIQuotaService,
  currentOrganizationQuota,
  normalizeOrganizationMonthlyLimit,
  normalizeQuota,
  projectMembershipUsage,
  projectOrganizationQuotas,
  readOrganizationQuotaProjection,
  readLivePolicy,
  recordUsageOrThrow,
  updateOrganizationMonthlyQuota,
  updateUserQuota,
  writeQuotaUpdateAuditInTransaction
};
