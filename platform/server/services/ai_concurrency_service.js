'use strict';

const crypto = require('node:crypto');

const PROVIDER_DEADLINE_MS = 120000;
const RECLAIM_GRACE_MS = 15000;
const MAX_LIMIT = 64;

class AIConcurrencyServiceError extends Error {
  constructor(statusCode, code, message, extras = {}) {
    super(message);
    this.name = 'AIConcurrencyServiceError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
    Object.assign(this, extras);
  }
}

function serviceError(status, code, message, extras) {
  return new AIConcurrencyServiceError(status, code, message, extras);
}

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw serviceError(400, 'AI_ORGANIZATION_CONCURRENCY_INVALID', `${label} must be a positive integer.`);
  }
  return value;
}

function bounded(value, label, maximum) {
  if (typeof value !== 'string') {
    throw serviceError(400, 'AI_ORGANIZATION_CONCURRENCY_INVALID', `${label} is required.`);
  }
  const result = value.trim();
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw serviceError(400, 'AI_ORGANIZATION_CONCURRENCY_INVALID', `${label} is invalid.`);
  }
  return result;
}

function optionalBounded(value, maximum) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= maximum && !/[\u0000-\u001f\u007f]/.test(result) ? result : null;
}

function ledgerTime(value) {
  return new Date(Math.floor(value.getTime() / 1000) * 1000).toISOString().replace('T', ' ').replace('.000Z', '');
}

function apiTime(value) {
  return value ? `${value.replace(' ', 'T')}Z` : null;
}

function createAIConcurrencyService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A better-sqlite3 database is required.');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const randomToken = typeof options.randomToken === 'function'
    ? options.randomToken
    : () => crypto.randomBytes(32).toString('base64url');
  const randomId = typeof options.randomId === 'function'
    ? options.randomId
    : () => crypto.randomUUID();
  const scheduleTimeout = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const cancelTimeout = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;

  function clock() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw serviceError(503, 'AI_CONCURRENCY_POLICY_UNAVAILABLE', 'AI concurrency clock is unavailable.');
    }
    return date;
  }

  function event(reservationId, organizationId, eventType, at, metadata = {}) {
    db.prepare(`
      INSERT INTO ai_provider_reservation_events
        (reservation_id,org_id,event_type,event_at,metadata_json)
      VALUES (?,?,?,?,?)
    `).run(reservationId, organizationId, eventType, at, JSON.stringify(metadata));
  }

  function livePolicy(organizationId) {
    const row = db.prepare(`
      SELECT policy_version,concurrency_limit
      FROM organization_ai_concurrency_policies
      WHERE org_id=? ORDER BY policy_version DESC LIMIT 1
    `).get(organizationId);
    if (!row || !Number.isSafeInteger(row.policy_version) ||
        !Number.isSafeInteger(row.concurrency_limit) || row.concurrency_limit < 0 || row.concurrency_limit > MAX_LIMIT) {
      throw serviceError(503, 'AI_CONCURRENCY_POLICY_UNAVAILABLE', 'AI concurrency policy is unavailable.');
    }
    return row;
  }

  function reclaimExpired(organizationId, at) {
    const expired = db.prepare(`
      SELECT reservation_id FROM ai_provider_reservations
      WHERE org_id=? AND state='active' AND reclaim_after<=?
      ORDER BY reclaim_after,reservation_id
    `).all(organizationId, at);
    const update = db.prepare(`
      UPDATE ai_provider_reservations SET state='timed_out',terminal_at=?
      WHERE reservation_id=? AND state='active' AND reclaim_after<=?
    `);
    for (const row of expired) {
      if (update.run(at, row.reservation_id, at).changes === 1) {
        event(row.reservation_id, organizationId, 'timed_out', at);
      }
    }
  }

  const acquireTransaction = db.transaction((input) => {
    const organizationId = integer(input && input.organizationId, 'organizationId');
    const actorUserId = integer(input && input.actorUserId, 'actorUserId');
    const operationKey = bounded(input && input.operationKey, 'operationKey', 200);
    const member = db.prepare(`
      SELECT user.id FROM users user
      JOIN organization_memberships membership ON membership.user_id=user.id AND membership.org_id=?
      WHERE user.id=? AND user.is_active=1 AND membership.status='active'
    `).get(organizationId, actorUserId);
    if (!member) throw serviceError(403, 'AI_ORGANIZATION_CONCURRENCY_FORBIDDEN', 'AI concurrency is not available to this user.');
    const atDate = clock();
    const at = ledgerTime(atDate);
    reclaimExpired(organizationId, at);
    const policy = livePolicy(organizationId);
    const active = db.prepare(`
      SELECT COUNT(*) AS count,MIN(reclaim_after) AS earliest
      FROM ai_provider_reservations WHERE org_id=? AND state='active'
    `).get(organizationId);
    if (policy.concurrency_limit === 0 || active.count >= policy.concurrency_limit) {
      const retryAfter = active.earliest
        ? Math.max(1, Math.min(135, Math.ceil((Date.parse(apiTime(active.earliest)) - atDate.getTime()) / 1000)))
        : 1;
      event(null, organizationId, 'rejected', at, {
        reason_code: 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED',
        active: active.count,
        limit: policy.concurrency_limit,
        operation_key: operationKey
      });
      return { denied: true, retryAfter };
    }
    const reservationId = bounded(randomId(), 'reservationId', 128);
    const fenceToken = bounded(randomToken(), 'fenceToken', 256);
    const deadline = ledgerTime(new Date(atDate.getTime() + PROVIDER_DEADLINE_MS));
    const reclaimAfter = ledgerTime(new Date(atDate.getTime() + PROVIDER_DEADLINE_MS + RECLAIM_GRACE_MS));
    db.prepare(`
      INSERT INTO ai_provider_reservations (
        reservation_id,org_id,actor_user_id,operation_key,fence_token,state,
        acquired_at,provider_deadline_at,reclaim_after
      ) VALUES (?,?,?,?,?,'active',?,?,?)
    `).run(reservationId, organizationId, actorUserId, operationKey, fenceToken, at, deadline, reclaimAfter);
    event(reservationId, organizationId, 'acquired', at, { operation_key: operationKey });
    return {
      denied: false,
      reservation_id: reservationId,
      organization_id: organizationId,
      fence_token: fenceToken,
      state: 'active',
      acquired_at: apiTime(at),
      provider_deadline_at: apiTime(deadline),
      reclaim_after: apiTime(reclaimAfter)
    };
  });

  function acquire(input) {
    let result;
    try {
      result = acquireTransaction.immediate(input || {});
    } catch (error) {
      if (error instanceof AIConcurrencyServiceError) throw error;
      throw serviceError(503, 'AI_CONCURRENCY_POLICY_UNAVAILABLE', 'AI concurrency admission is unavailable.');
    }
    if (result.denied) {
      throw serviceError(
        429,
        'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED',
        '当前组织的 AI 并发已满。本次请求尚未开始，不会消耗 Token，请稍后重试。',
        { retryAfter: result.retryAfter }
      );
    }
    return result;
  }

  function ownedReservation(input) {
    const reservationId = bounded(input && input.reservationId, 'reservationId', 128);
    const fenceToken = bounded(input && input.fenceToken, 'fenceToken', 256);
    const row = db.prepare('SELECT * FROM ai_provider_reservations WHERE reservation_id=?').get(reservationId);
    if (!row) throw serviceError(404, 'AI_CONCURRENCY_RESERVATION_NOT_FOUND', 'AI concurrency reservation was not found.');
    const storedToken = Buffer.from(row.fence_token);
    const presentedToken = Buffer.from(fenceToken);
    if (storedToken.length !== presentedToken.length || !crypto.timingSafeEqual(storedToken, presentedToken)) {
      throw serviceError(409, 'AI_CONCURRENCY_RESERVATION_FENCE_MISMATCH', 'AI concurrency reservation ownership was lost.');
    }
    return row;
  }

  const authorizeTransaction = db.transaction((input) => {
    const row = ownedReservation(input);
    if (row.state !== 'active') {
      throw serviceError(409, 'AI_CONCURRENCY_RESERVATION_NOT_ACTIVE', 'AI concurrency reservation is not active.');
    }
    const at = ledgerTime(clock());
    if (at >= row.provider_deadline_at) {
      throw serviceError(409, 'AI_CONCURRENCY_PROVIDER_DEADLINE_EXCEEDED', 'AI provider dispatch deadline has expired.');
    }
    const provider = input && input.provider ? bounded(input.provider, 'provider', 80) : null;
    event(row.reservation_id, row.org_id, 'dispatch_authorized', at, { provider });
    return { authorized: true, reservation_id: row.reservation_id, provider_deadline_at: apiTime(row.provider_deadline_at) };
  });

  function authorizeDispatch(input) {
    return authorizeTransaction.immediate(input || {});
  }

  const assertActiveTransaction = db.transaction((input) => {
    const row = ownedReservation(input);
    if (row.state !== 'active') {
      throw serviceError(409, 'AI_CONCURRENCY_RESERVATION_NOT_ACTIVE', 'AI concurrency reservation is not active.');
    }
    if (ledgerTime(clock()) >= row.provider_deadline_at) {
      throw serviceError(409, 'AI_CONCURRENCY_PROVIDER_DEADLINE_EXCEEDED', 'AI provider dispatch deadline has expired.');
    }
    return { reservation_id: row.reservation_id, state: row.state };
  });

  function assertActive(input) {
    return assertActiveTransaction.immediate(input || {});
  }

  const completedTransaction = db.transaction((input) => {
    const row = ownedReservation(input);
    if (row.state !== 'active') {
      throw serviceError(409, 'AI_CONCURRENCY_RESERVATION_NOT_ACTIVE', 'AI concurrency reservation is not active.');
    }
    const at = ledgerTime(clock());
    if (at >= row.provider_deadline_at) {
      throw serviceError(409, 'AI_CONCURRENCY_PROVIDER_DEADLINE_EXCEEDED', 'AI provider completion deadline has expired.');
    }
    db.prepare(`
      UPDATE ai_provider_reservations SET provider_completed_at=COALESCE(provider_completed_at,?)
      WHERE reservation_id=? AND state='active'
    `).run(at, row.reservation_id);
    event(row.reservation_id, row.org_id, 'provider_completed', at, {
      provider: input && input.provider ? bounded(input.provider, 'provider', 80) : null
    });
    return { reservation_id: row.reservation_id, state: 'active', provider_completed_at: apiTime(at) };
  });

  function markProviderCompleted(input) {
    return completedTransaction.immediate(input || {});
  }

  const releaseTransaction = db.transaction((input) => {
    const row = ownedReservation(input);
    if (row.state === 'released') return { reservation_id: row.reservation_id, state: 'released' };
    if (row.state !== 'active') {
      throw serviceError(409, 'AI_CONCURRENCY_RESERVATION_NOT_ACTIVE', 'AI concurrency reservation is not active.');
    }
    const at = ledgerTime(clock());
    const changed = db.prepare(`
      UPDATE ai_provider_reservations SET state='released',terminal_at=?
      WHERE reservation_id=? AND state='active' AND fence_token=?
    `).run(at, row.reservation_id, row.fence_token);
    if (changed.changes !== 1) {
      throw serviceError(409, 'AI_CONCURRENCY_RESERVATION_FENCE_MISMATCH', 'AI concurrency reservation ownership was lost.');
    }
    event(row.reservation_id, row.org_id, 'released', at);
    return { reservation_id: row.reservation_id, state: 'released', terminal_at: apiTime(at) };
  });

  function release(input) {
    return releaseTransaction.immediate(input || {});
  }

  async function runWithPermit(input, operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('AI concurrency operation must be a function.');
    }
    const permit = acquire(input || {});
    const ownership = {
      reservationId: permit.reservation_id,
      fenceToken: permit.fence_token
    };
    const deadlineAt = Date.parse(permit.provider_deadline_at);
    if (!Number.isFinite(deadlineAt)) {
      try { release(ownership); } catch (_) {}
      throw serviceError(503, 'AI_CONCURRENCY_POLICY_UNAVAILABLE', 'AI concurrency deadline is unavailable.');
    }
    const controller = new AbortController();
    const deadlineError = () => serviceError(
      409,
      'AI_CONCURRENCY_PROVIDER_DEADLINE_EXCEEDED',
      'AI provider operation exceeded its concurrency reservation deadline.'
    );
    const abort = (reason) => {
      if (!controller.signal.aborted) controller.abort(reason instanceof Error ? reason : deadlineError());
    };
    const externalSignal = input && input.signal;
    let detachExternal = null;
    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
      if (externalSignal.aborted) {
        abort(externalSignal.reason);
      } else {
        const onExternalAbort = () => abort(externalSignal.reason);
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        detachExternal = () => externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
    const timer = scheduleTimeout(() => abort(deadlineError()), Math.max(0, deadlineAt - clock().getTime()));
    const operationPermit = Object.freeze({
      ...permit,
      signal: controller.signal,
      deadlineAt,
      assertActive() {
        if (controller.signal.aborted) throw controller.signal.reason || deadlineError();
        return assertActive(ownership);
      }
    });
    let result;
    let operationError = null;
    let closureError = null;
    let dispatched = false;
    try {
      authorizeDispatch({
        ...ownership,
        provider: optionalBounded(input && input.provider, 80) || 'ai_sequence'
      });
      dispatched = true;
      if (controller.signal.aborted) throw controller.signal.reason || deadlineError();
      result = await operation(operationPermit);
      operationPermit.assertActive();
    } catch (error) {
      operationError = error;
    }
    if (dispatched && operationError === null) {
      try {
        markProviderCompleted({
          ...ownership,
          provider: optionalBounded(input && input.provider, 80) || 'ai_sequence'
        });
      } catch (error) {
        closureError = error;
      }
    }
    try {
      release(ownership);
    } catch (error) {
      if (closureError === null) closureError = error;
    }
    cancelTimeout(timer);
    if (detachExternal) detachExternal();
    if (operationError) throw operationError;
    if (closureError) throw closureError;
    return result;
  }

  const projectionTransaction = db.transaction((organizationId) => {
    const at = ledgerTime(clock());
    reclaimExpired(organizationId, at);
    const policy = livePolicy(organizationId);
    const usage = db.prepare(`
      SELECT COUNT(*) AS active,MIN(reclaim_after) AS earliest
      FROM ai_provider_reservations WHERE org_id=? AND state='active'
    `).get(organizationId);
    const overCapacity = Math.max(0, usage.active - policy.concurrency_limit);
    let status = 'available';
    if (policy.concurrency_limit === 0) status = 'disabled';
    else if (overCapacity > 0) status = 'draining';
    else if (usage.active >= policy.concurrency_limit) status = 'full';
    return {
      organization_id: organizationId,
      active: usage.active,
      limit: policy.concurrency_limit,
      available: Math.max(0, policy.concurrency_limit - usage.active),
      over_capacity: overCapacity,
      status,
      policy_version: policy.policy_version,
      earliest_lease_expires_at: apiTime(usage.earliest)
    };
  });

  function projectOrganizationConcurrency(input) {
    const organizationId = integer(input && input.organizationId, 'organizationId');
    try {
      return projectionTransaction.immediate(organizationId);
    } catch (error) {
      if (error instanceof AIConcurrencyServiceError) throw error;
      throw serviceError(503, 'AI_CONCURRENCY_POLICY_UNAVAILABLE', 'AI concurrency projection is unavailable.');
    }
  }

  function currentOrganizationConcurrency(input) {
    const organizationId = integer(input && input.organizationId, 'organizationId');
    const actorUserId = integer(input && input.actorUserId, 'actorUserId');
    const member = db.prepare(`
      SELECT user.id FROM users user
      JOIN organization_memberships membership ON membership.user_id=user.id AND membership.org_id=?
      WHERE user.id=? AND user.is_active=1 AND membership.status='active'
    `).get(organizationId, actorUserId);
    if (!member) {
      throw serviceError(403, 'AI_ORGANIZATION_CONCURRENCY_FORBIDDEN', 'Organization AI concurrency is not available to this user.');
    }
    return projectOrganizationConcurrency({ organizationId });
  }

  const updateTransaction = db.transaction((input) => {
    const actorUserId = integer(input && input.actorUserId, 'actorUserId');
    const organizationId = integer(input && input.organizationId, 'organizationId');
    const expectedVersion = integer(input && input.expectedVersion, 'expectedVersion');
    const limit = input && input.concurrencyLimit;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
      throw serviceError(400, 'AI_ORGANIZATION_CONCURRENCY_INVALID', 'concurrencyLimit must be between 0 and 64.');
    }
    const reason = bounded(input && input.reason, 'reason', 500);
    const admin = db.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND is_active=1").get(actorUserId);
    if (!admin) {
      throw serviceError(403, 'AI_ORGANIZATION_CONCURRENCY_ADMIN_FORBIDDEN', 'Platform administrator access is required.');
    }
    if (!db.prepare('SELECT id FROM organizations WHERE id=?').get(organizationId)) {
      throw serviceError(404, 'ORGANIZATION_NOT_FOUND', 'Organization was not found.');
    }
    const before = livePolicy(organizationId);
    if (before.policy_version !== expectedVersion) {
      throw serviceError(409, 'AI_ORGANIZATION_CONCURRENCY_VERSION_CONFLICT', 'AI concurrency policy version has changed.');
    }
    if (before.concurrency_limit === limit) {
      return Object.assign(projectOrganizationConcurrency({ organizationId }), { changed: false });
    }
    const nextVersion = before.policy_version + 1;
    db.prepare(`
      INSERT INTO organization_ai_concurrency_policies
        (org_id,policy_version,concurrency_limit,changed_by,reason,source)
      VALUES (?,?,?,?,?,'admin_update')
    `).run(organizationId, nextVersion, limit, actorUserId, reason);
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,'organization_ai_concurrency_changed','ai_concurrency',?,?)
    `).run(actorUserId, JSON.stringify({
      schema_version: 1,
      actor_user_id: actorUserId,
      organization_id: organizationId,
      reason,
      request_id: optionalBounded(input && input.requestId, 200),
      before: { concurrency_limit: before.concurrency_limit, policy_version: before.policy_version },
      after: { concurrency_limit: limit, policy_version: nextVersion }
    }), optionalBounded(input && input.ipAddress, 128));
    return Object.assign(projectOrganizationConcurrency({ organizationId }), { changed: true });
  });

  function updateOrganizationConcurrencyPolicy(input) {
    try {
      return updateTransaction.immediate(input || {});
    } catch (error) {
      if (error instanceof AIConcurrencyServiceError) throw error;
      throw serviceError(500, 'AI_ORGANIZATION_CONCURRENCY_AUDIT_FAILED', 'AI concurrency policy update could not be audited.');
    }
  }

  return Object.freeze({
    acquire,
    authorizeDispatch,
    assertActive,
    markProviderCompleted,
    release,
    runWithPermit,
    projectOrganizationConcurrency,
    currentOrganizationConcurrency,
    updateOrganizationConcurrencyPolicy
  });
}

module.exports = {
  PROVIDER_DEADLINE_MS,
  RECLAIM_GRACE_MS,
  MAX_LIMIT,
  AIConcurrencyServiceError,
  createAIConcurrencyService
};
