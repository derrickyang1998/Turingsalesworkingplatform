'use strict';

const MAX_REASON_LENGTH = 500;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CANONICAL_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

class SubscriptionExpiryServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SubscriptionExpiryServiceError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function serviceError(status, code, message) {
  return new SubscriptionExpiryServiceError(status, code, message);
}

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > Number.MAX_SAFE_INTEGER) {
    throw serviceError(400, 'INVALID_SUBSCRIPTION_TERM', `${label} must be a positive integer.`);
  }
  return parsed;
}

function boundedText(value, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || CONTROL_CHARACTERS.test(normalized)) return null;
  return normalized;
}

function reasonText(value) {
  const normalized = boundedText(value, MAX_REASON_LENGTH);
  if (!normalized) {
    throw serviceError(400, 'INVALID_SUBSCRIPTION_TERM', 'reason is required and must be at most 500 characters.');
  }
  return normalized;
}

function canonicalExpiry(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !CANONICAL_UTC_SECONDS.test(value)) {
    throw serviceError(400, 'INVALID_SUBSCRIPTION_TERM', 'expires_at must be null or canonical UTC seconds.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().replace('.000Z', 'Z') !== value) {
    throw serviceError(400, 'INVALID_SUBSCRIPTION_TERM', 'expires_at must be a valid canonical UTC timestamp.');
  }
  return value;
}

function auditText(value, maximum) {
  return boundedText(value, maximum);
}

function liveAdmin(db, actorUserId) {
  const id = positiveId(actorUserId, 'actorUserId');
  let user;
  try {
    user = db.prepare('SELECT id,role,is_active FROM users WHERE id=?').get(id);
  } catch (_error) {
    throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', 'Subscription policy is unavailable.');
  }
  if (!user || user.role !== 'admin' || user.is_active !== 1) {
    throw serviceError(403, 'SUBSCRIPTION_ADMIN_FORBIDDEN', 'Only an active platform administrator may manage subscription expiry.');
  }
  return user;
}

function statusFor(expiresAt, nowMs) {
  if (expiresAt === null) return 'perpetual';
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', 'Subscription policy is unavailable.');
  }
  return timestamp <= nowMs ? 'expired' : 'active';
}

function readOrganizationSubscriptionProjection(db, organizationIdValue, nowMs) {
  const organizationId = positiveId(organizationIdValue, 'organizationId');
  let rows;
  try {
    rows = db.prepare(`
      SELECT term_version,expires_at
      FROM organization_subscription_terms term
      WHERE term.org_id=? AND term.term_version=(
        SELECT MAX(current.term_version)
        FROM organization_subscription_terms current
        WHERE current.org_id=term.org_id
      )
      ORDER BY term.id
    `).all(organizationId);
  } catch (_error) {
    throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', 'Subscription policy is unavailable.');
  }
  if (rows.length !== 1) {
    throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', 'Subscription policy is unavailable.');
  }
  const row = rows[0];
  if (
    !Number.isSafeInteger(row.term_version) || row.term_version < 1 ||
    (row.expires_at !== null && canonicalExpiryForRead(row.expires_at) === null)
  ) {
    throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', 'Subscription policy is unavailable.');
  }
  return {
    organization_id: organizationId,
    expires_at: row.expires_at,
    term_version: row.term_version,
    status: statusFor(row.expires_at, nowMs)
  };
}

function canonicalExpiryForRead(value) {
  if (typeof value !== 'string' || !CANONICAL_UTC_SECONDS.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().replace('.000Z', 'Z') === value ? value : null;
}

function currentForMember(db, input, nowMs) {
  const actorUserId = positiveId(input && input.actorUserId, 'actorUserId');
  const organizationId = positiveId(input && input.organizationId, 'organizationId');
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
    throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', 'Subscription policy is unavailable.');
  }
  if (!member) {
    throw serviceError(403, 'SUBSCRIPTION_FORBIDDEN', 'The organization subscription is not available to this user.');
  }
  return readOrganizationSubscriptionProjection(db, organizationId, nowMs);
}

function writeAudit(db, input) {
  const details = JSON.stringify(input.details);
  if (Buffer.byteLength(details, 'utf8') > 4096) {
    throw serviceError(500, 'SUBSCRIPTION_AUDIT_FAILED', 'Subscription audit could not be persisted.');
  }
  try {
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,?,'subscription_expiry',?,?)
    `).run(
      input.actorUserId,
      input.action,
      details,
      auditText(input.ipAddress, 128)
    );
  } catch (_error) {
    throw serviceError(500, 'SUBSCRIPTION_AUDIT_FAILED', 'Subscription audit could not be persisted.');
  }
}

function updateForAdmin(db, input, nowMs) {
  const actorUserId = positiveId(input && input.actorUserId, 'actorUserId');
  const organizationId = positiveId(input && input.organizationId, 'organizationId');
  const expiresAt = canonicalExpiry(input && Object.hasOwn(input, 'expiresAt') ? input.expiresAt : undefined);
  const expectedVersion = positiveId(input && input.expectedVersion, 'expectedVersion');
  const reason = reasonText(input && input.reason);

  const update = db.transaction(() => {
    const admin = liveAdmin(db, actorUserId);
    const organization = db.prepare('SELECT id FROM organizations WHERE id=?').get(organizationId);
    if (!organization) {
      throw serviceError(404, 'ORGANIZATION_NOT_FOUND', 'Organization was not found.');
    }
    const currentRows = db.prepare(`
      SELECT id,term_version,expires_at
      FROM organization_subscription_terms
      WHERE org_id=? AND term_version=(
        SELECT MAX(current.term_version)
        FROM organization_subscription_terms current
        WHERE current.org_id=?
      )
      ORDER BY id
    `).all(organizationId, organizationId);
    if (currentRows.length !== 1) {
      throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', 'Subscription policy is unavailable.');
    }
    const current = currentRows[0];
    if (current.term_version !== expectedVersion) {
      throw serviceError(409, 'SUBSCRIPTION_TERM_VERSION_CONFLICT', 'The subscription term changed before this request completed.');
    }
    if (current.expires_at === expiresAt) {
      return {
        ...readOrganizationSubscriptionProjection(db, organizationId, nowMs),
        changed: false
      };
    }

    const nextVersion = current.term_version + 1;
    db.prepare(`
      INSERT INTO organization_subscription_terms
        (org_id,term_version,expires_at,changed_by,reason,source)
      VALUES (?, ?, ?, ?, ?, 'admin_update')
    `).run(organizationId, nextVersion, expiresAt, admin.id, reason);
    writeAudit(db, {
      actorUserId: admin.id,
      action: 'organization_subscription_expiry_changed',
      ipAddress: input && input.ipAddress,
      details: {
        schema_version: 1,
        actor_user_id: admin.id,
        organization_id: organizationId,
        before: { expires_at: current.expires_at, term_version: current.term_version },
        after: { expires_at: expiresAt, term_version: nextVersion },
        reason,
        request_id: auditText(input && input.requestId, 200)
      }
    });
    return {
      ...readOrganizationSubscriptionProjection(db, organizationId, nowMs),
      changed: true
    };
  });
  try {
    return update.immediate();
  } catch (error) {
    if (error instanceof SubscriptionExpiryServiceError) throw error;
    throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', 'Subscription policy is unavailable.');
  }
}

function createSubscriptionExpiryService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }
  const now = options.now || Date.now;
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  function currentTime() {
    const value = now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) {
      throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', 'Subscription policy is unavailable.');
    }
    return milliseconds;
  }
  return Object.freeze({
    currentForMember(input) { return currentForMember(db, input || {}, currentTime()); },
    updateForAdmin(input) { return updateForAdmin(db, input || {}, currentTime()); },
    projectOrganization(input) {
      return readOrganizationSubscriptionProjection(
        db,
        input && input.organizationId,
        currentTime()
      );
    }
  });
}

module.exports = {
  SubscriptionExpiryServiceError,
  canonicalExpiry,
  createSubscriptionExpiryService,
  currentForMember,
  readOrganizationSubscriptionProjection,
  updateForAdmin
};
