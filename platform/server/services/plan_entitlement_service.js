'use strict';

const CATALOG_VERSION = 1;
const MAX_REASON_LENGTH = 500;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

class PlanEntitlementServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PlanEntitlementServiceError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function serviceError(status, code, message) {
  return new PlanEntitlementServiceError(status, code, message);
}

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > Number.MAX_SAFE_INTEGER) {
    throw serviceError(400, 'INVALID_PLAN_ASSIGNMENT', `${label} must be a positive integer.`);
  }
  return parsed;
}

function boundedText(value, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || CONTROL_CHARACTERS.test(normalized)) return null;
  return normalized;
}

function planCode(value) {
  const normalized = boundedText(value, 80);
  if (!normalized || !/^[a-z][a-z0-9_]{1,79}$/.test(normalized)) {
    throw serviceError(400, 'INVALID_PLAN_ASSIGNMENT', 'plan_code is invalid.');
  }
  return normalized;
}

function reasonText(value) {
  const normalized = boundedText(value, MAX_REASON_LENGTH);
  if (!normalized) {
    throw serviceError(400, 'INVALID_PLAN_ASSIGNMENT', 'reason is required and must be at most 500 characters.');
  }
  return normalized;
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
    throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
  }
  if (!user || user.role !== 'admin' || user.is_active !== 1) {
    throw serviceError(403, 'PLAN_ADMIN_FORBIDDEN', 'Only an active platform administrator may manage organization plans.');
  }
  return user;
}

function writeAudit(db, input) {
  const details = JSON.stringify(input.details);
  if (Buffer.byteLength(details, 'utf8') > 4096) {
    throw serviceError(500, 'PLAN_AUDIT_FAILED', 'Plan entitlement audit could not be persisted.');
  }
  try {
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,?,'plan_entitlements',?,?)
    `).run(
      input.actorUserId,
      input.action,
      details,
      auditText(input.ipAddress, 128)
    );
  } catch (_error) {
    throw serviceError(500, 'PLAN_AUDIT_FAILED', 'Plan entitlement audit could not be persisted.');
  }
}

function readOrganizationPlanProjection(db, organizationIdValue) {
  const organizationId = positiveId(organizationIdValue, 'organizationId');
  let assignments;
  try {
    assignments = db.prepare(`
      SELECT
        assignment.plan_code,
        assignment.assignment_version,
        plan.name_zh,
        plan.name_en,
        plan.catalog_version,
        plan.status AS plan_status
      FROM organization_plan_assignments assignment
      LEFT JOIN plan_catalog plan ON plan.code=assignment.plan_code
      WHERE assignment.org_id=? AND assignment.assignment_version=(
        SELECT MAX(current.assignment_version)
        FROM organization_plan_assignments current
        WHERE current.org_id=assignment.org_id
      )
      ORDER BY assignment.id
    `).all(organizationId);
  } catch (_error) {
    throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
  }
  if (
    assignments.length !== 1 ||
    assignments[0].plan_status !== 'active' ||
    assignments[0].catalog_version !== CATALOG_VERSION
  ) {
    throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
  }
  let modules;
  try {
    modules = db.prepare(`
      SELECT module_code
      FROM plan_module_entitlements
      WHERE plan_code=?
      ORDER BY module_code
    `).all(assignments[0].plan_code).map((row) => row.module_code);
  } catch (_error) {
    throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
  }
  if (modules.length === 0 || modules.some((module) => typeof module !== 'string')) {
    throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
  }
  const assignment = assignments[0];
  return {
    organization_id: organizationId,
    plan_code: assignment.plan_code,
    name_zh: assignment.name_zh,
    name_en: assignment.name_en,
    catalog_version: assignment.catalog_version,
    assignment_version: assignment.assignment_version,
    modules
  };
}

function listCatalog(db, input) {
  const admin = liveAdmin(db, input && input.actorUserId);
  let rows;
  try {
    rows = db.prepare(`
      SELECT
        plan.code,
        plan.name_zh,
        plan.name_en,
        plan.catalog_version,
        plan.display_order,
        entitlement.module_code
      FROM plan_catalog plan
      LEFT JOIN plan_module_entitlements entitlement ON entitlement.plan_code=plan.code
      WHERE plan.status='active'
      ORDER BY plan.display_order,plan.code,entitlement.module_code
    `).all();
  } catch (_error) {
    throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
  }
  const plansByCode = new Map();
  for (const row of rows) {
    if (row.catalog_version !== CATALOG_VERSION || typeof row.module_code !== 'string') {
      throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
    }
    if (!plansByCode.has(row.code)) {
      plansByCode.set(row.code, {
        code: row.code,
        name_zh: row.name_zh,
        name_en: row.name_en,
        catalog_version: row.catalog_version,
        display_order: row.display_order,
        modules: []
      });
    }
    plansByCode.get(row.code).modules.push(row.module_code);
  }
  const plans = Array.from(plansByCode.values());
  writeAudit(db, {
    actorUserId: admin.id,
    action: 'admin_plan_catalog_viewed',
    ipAddress: input && input.ipAddress,
    details: {
      schema_version: 1,
      actor_user_id: admin.id,
      catalog_version: CATALOG_VERSION,
      result_count: plans.length,
      request_id: auditText(input && input.requestId, 200)
    }
  });
  return { catalog_version: CATALOG_VERSION, plans };
}

function currentForMember(db, input) {
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
    throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
  }
  if (!member) {
    throw serviceError(403, 'PLAN_ENTITLEMENT_FORBIDDEN', 'The active organization plan is not available to this user.');
  }
  return readOrganizationPlanProjection(db, organizationId);
}

function assignForAdmin(db, input) {
  const actorUserId = positiveId(input && input.actorUserId, 'actorUserId');
  const organizationId = positiveId(input && input.organizationId, 'organizationId');
  const requestedPlanCode = planCode(input && input.planCode);
  const expectedVersion = positiveId(input && input.expectedVersion, 'expectedVersion');
  const reason = reasonText(input && input.reason);

  const assign = db.transaction(() => {
    const admin = liveAdmin(db, actorUserId);
    const organization = db.prepare('SELECT id FROM organizations WHERE id=?').get(organizationId);
    if (!organization) {
      throw serviceError(404, 'ORGANIZATION_NOT_FOUND', 'Organization was not found.');
    }
    const plan = db.prepare(`
      SELECT code,status,catalog_version FROM plan_catalog WHERE code=?
    `).get(requestedPlanCode);
    if (!plan) throw serviceError(404, 'PLAN_NOT_FOUND', 'Plan was not found.');
    if (plan.status !== 'active' || plan.catalog_version !== CATALOG_VERSION) {
      throw serviceError(409, 'PLAN_NOT_ACTIVE', 'Plan is not active.');
    }
    const currentRows = db.prepare(`
      SELECT id,plan_code,assignment_version
      FROM organization_plan_assignments
      WHERE org_id=? AND assignment_version=(
        SELECT MAX(current.assignment_version)
        FROM organization_plan_assignments current
        WHERE current.org_id=?
      )
      ORDER BY id
    `).all(organizationId, organizationId);
    if (currentRows.length !== 1) {
      throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
    }
    const current = currentRows[0];
    if (current.assignment_version !== expectedVersion) {
      throw serviceError(409, 'PLAN_ASSIGNMENT_VERSION_CONFLICT', 'The organization plan changed before this request completed.');
    }
    if (current.plan_code === requestedPlanCode) {
      return { ...readOrganizationPlanProjection(db, organizationId), changed: false };
    }

    const nextVersion = current.assignment_version + 1;
    db.prepare(`
      INSERT INTO organization_plan_assignments
        (org_id,plan_code,assignment_version,assigned_by,reason,source)
      VALUES (?, ?, ?, ?, ?, 'admin_assignment')
    `).run(organizationId, requestedPlanCode, nextVersion, admin.id, reason);

    writeAudit(db, {
      actorUserId: admin.id,
      action: 'organization_plan_assigned',
      ipAddress: input && input.ipAddress,
      details: {
        schema_version: 1,
        actor_user_id: admin.id,
        organization_id: organizationId,
        catalog_version: CATALOG_VERSION,
        before: {
          plan_code: current.plan_code,
          assignment_version: current.assignment_version
        },
        after: {
          plan_code: requestedPlanCode,
          assignment_version: nextVersion
        },
        reason,
        request_id: auditText(input && input.requestId, 200)
      }
    });
    return { ...readOrganizationPlanProjection(db, organizationId), changed: true };
  });
  try {
    return assign.immediate();
  } catch (error) {
    if (error instanceof PlanEntitlementServiceError) throw error;
    throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', 'Plan entitlement policy is unavailable.');
  }
}

function createPlanEntitlementService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }
  return Object.freeze({
    listCatalog(input) { return listCatalog(db, input || {}); },
    currentForMember(input) { return currentForMember(db, input || {}); },
    assignForAdmin(input) { return assignForAdmin(db, input || {}); },
    projectOrganization(input) {
      const organizationId = input && input.organizationId;
      return readOrganizationPlanProjection(db, organizationId);
    }
  });
}

module.exports = {
  CATALOG_VERSION,
  PlanEntitlementServiceError,
  assignForAdmin,
  createPlanEntitlementService,
  currentForMember,
  listCatalog,
  readOrganizationPlanProjection
};
