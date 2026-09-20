'use strict';

const PLATFORM_ADMINISTRATION_MODULE = 'platform_administration';
const PLATFORM_ADMINISTRATION_MANAGE_ACTION = 'manage';
const CRM_CUSTOMER_MODULE = 'crm.customer';
const CRM_CUSTOMER_READ_ACTION = 'read';
const CRM_CUSTOMER_CREATE_ACTION = 'create';
const CRM_CUSTOMER_UPDATE_ACTION = 'update';
const CRM_OPPORTUNITY_MODULE = 'crm.opportunity';
const CRM_OPPORTUNITY_READ_ACTION = 'read';
const CRM_OPPORTUNITY_CREATE_ACTION = 'create';
const CRM_OPPORTUNITY_UPDATE_ACTION = 'update';
const CRM_CONTACT_MODULE = 'crm.contact';
const CRM_CONTACT_READ_ACTION = 'read';
const CRM_CONTACT_CREATE_ACTION = 'create';
const CRM_CONTACT_UPDATE_ACTION = 'update';
const CRM_TASK_MODULE = 'crm.task';
const CRM_TASK_READ_ACTION = 'read';
const CRM_TASK_CREATE_ACTION = 'create';
const CRM_TASK_UPDATE_ACTION = 'update';
const CAMPAIGN_PERFORMANCE_MODULE = 'campaign.performance';
const CAMPAIGN_PERFORMANCE_EXPORT_ACTION = 'export';
const CAMPAIGN_CUSTOMER_REPORT_MODULE = 'campaign.customer_report';
const CAMPAIGN_CUSTOMER_REPORT_EXPORT_ACTION = 'export';
const INFLUENCER_DATA_MODULE = 'influencer.data';
const INFLUENCER_DATA_EXPORT_ACTION = 'export';
const INFLUENCER_DATA_IMPORT_ACTION = 'import';
const REQUEST_ROLE_VOCABULARY = new Set(['admin', 'user']);
const ROLE_ORDER = Object.freeze([
  'platform_admin',
  'company_owner',
  'administrator',
  'manager',
  'member',
  'read_only'
]);
const POLICY = Object.freeze({
  [PLATFORM_ADMINISTRATION_MODULE]: Object.freeze({
    [PLATFORM_ADMINISTRATION_MANAGE_ACTION]: Object.freeze(['platform_admin'])
  }),
  [CRM_CUSTOMER_MODULE]: Object.freeze({
    [CRM_CUSTOMER_READ_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member',
      'read_only'
    ]),
    [CRM_CUSTOMER_CREATE_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ]),
    [CRM_CUSTOMER_UPDATE_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ])
  }),
  [CRM_OPPORTUNITY_MODULE]: Object.freeze({
    [CRM_OPPORTUNITY_READ_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member',
      'read_only'
    ]),
    [CRM_OPPORTUNITY_CREATE_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ]),
    [CRM_OPPORTUNITY_UPDATE_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ])
  }),
  [CRM_CONTACT_MODULE]: Object.freeze({
    [CRM_CONTACT_READ_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member',
      'read_only'
    ]),
    [CRM_CONTACT_CREATE_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ]),
    [CRM_CONTACT_UPDATE_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ])
  }),
  [CRM_TASK_MODULE]: Object.freeze({
    [CRM_TASK_READ_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member',
      'read_only'
    ]),
    [CRM_TASK_CREATE_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ]),
    [CRM_TASK_UPDATE_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ])
  }),
  [CAMPAIGN_PERFORMANCE_MODULE]: Object.freeze({
    [CAMPAIGN_PERFORMANCE_EXPORT_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ])
  }),
  [CAMPAIGN_CUSTOMER_REPORT_MODULE]: Object.freeze({
    [CAMPAIGN_CUSTOMER_REPORT_EXPORT_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ])
  }),
  [INFLUENCER_DATA_MODULE]: Object.freeze({
    [INFLUENCER_DATA_EXPORT_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ]),
    [INFLUENCER_DATA_IMPORT_ACTION]: Object.freeze([
      'company_owner',
      'administrator',
      'manager',
      'member'
    ])
  })
});
const ORGANIZATION_SCOPED_MODULES = new Set([
  CRM_CUSTOMER_MODULE,
  CRM_OPPORTUNITY_MODULE,
  CRM_CONTACT_MODULE,
  CRM_TASK_MODULE,
  CAMPAIGN_PERFORMANCE_MODULE,
  CAMPAIGN_CUSTOMER_REPORT_MODULE,
  INFLUENCER_DATA_MODULE
]);
const ORGANIZATION_POLICY_STATE = Symbol('organizationPolicyState');
const CANONICAL_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function denied(code) {
  return { allowed: false, code };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function requestPrincipal(value) {
  if (!isPlainObject(value)) return null;
  try {
    const id = value.id;
    const role = value.role;
    if (!Number.isSafeInteger(id) || id < 1 || typeof role !== 'string') return null;
    return { id, role };
  } catch {
    return null;
  }
}

function projectRoles(db, user, organizationId) {
  const roles = new Set();
  if (user.role === 'admin') roles.add('platform_admin');

  const scoped = Number.isSafeInteger(organizationId) && organizationId > 0;
  const organizationMemberships = db.prepare(`
    SELECT
      membership.org_id,
      membership.role_code,
      policy.access_mode,
      CASE WHEN authority.owner_user_id=membership.user_id THEN 1 ELSE 0 END AS is_company_owner
    FROM organization_memberships membership
    JOIN organization_member_policy policy
      ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
    LEFT JOIN organization_authority authority ON authority.org_id=membership.org_id
    WHERE membership.user_id=?
      AND membership.status='active'
      ${scoped ? 'AND membership.org_id=?' : ''}
  `).all(...(scoped ? [user.id, organizationId] : [user.id]));
  if (organizationMemberships.some((membership) => membership.access_mode === 'read_only')) {
    roles.add('read_only');
  }
  const writableMemberships = organizationMemberships.filter(
    (membership) => membership.access_mode === 'read_write'
  );
  if (writableMemberships.length > 0) roles.add('member');
  if (writableMemberships.some((membership) => membership.is_company_owner === 1)) {
    roles.add('company_owner');
  }
  if (writableMemberships.some((membership) => membership.role_code === 'org_admin')) {
    roles.add('administrator');
  }

  const teamMemberships = db.prepare(`
    SELECT team_membership.role_code
    FROM team_memberships team_membership
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=team_membership.org_id
     AND organization_membership.user_id=team_membership.user_id
    JOIN organization_member_policy policy
      ON policy.org_id=team_membership.org_id
     AND policy.user_id=team_membership.user_id
    WHERE team_membership.user_id=?
      AND team_membership.status='active'
      AND organization_membership.status='active'
      AND policy.access_mode='read_write'
      ${scoped ? 'AND team_membership.org_id=?' : ''}
  `).all(...(scoped ? [user.id, organizationId] : [user.id]));
  if (teamMemberships.length > 0) roles.add('member');
  if (teamMemberships.some((membership) => membership.role_code === 'team_lead')) {
    roles.add('manager');
  }

  return ROLE_ORDER.filter((role) => roles.has(role));
}

function organizationModuleEntitlement(db, organizationId, module) {
  const rows = db.prepare(`
    SELECT
      assignment.plan_code,
      plan.status AS plan_status,
      CASE WHEN entitlement.module_code IS NULL THEN 0 ELSE 1 END AS entitled
    FROM organization_plan_assignments assignment
    LEFT JOIN plan_catalog plan ON plan.code=assignment.plan_code
    LEFT JOIN plan_module_entitlements entitlement
      ON entitlement.plan_code=assignment.plan_code AND entitlement.module_code=?
    WHERE assignment.org_id=? AND assignment.assignment_version=(
      SELECT MAX(current.assignment_version)
      FROM organization_plan_assignments current
      WHERE current.org_id=assignment.org_id
    )
    ORDER BY assignment.id
  `).all(module, organizationId);
  if (rows.length !== 1 || rows[0].plan_status !== 'active') {
    throw new Error('organization entitlement policy is unavailable');
  }
  return rows[0].entitled === 1;
}

function organizationSubscriptionPolicy(db, organizationId, evaluatedAt) {
  const rows = db.prepare(`
    SELECT term.term_version,term.expires_at
    FROM organization_subscription_terms term
    WHERE term.org_id=? AND term.term_version=(
      SELECT MAX(current.term_version)
      FROM organization_subscription_terms current
      WHERE current.org_id=term.org_id
    )
    ORDER BY term.id
  `).all(organizationId);
  if (
    rows.length !== 1 || !Number.isSafeInteger(rows[0].term_version) ||
    rows[0].term_version < 1
  ) {
    throw new Error('organization subscription policy is unavailable');
  }
  const expiresAt = rows[0].expires_at;
  if (expiresAt !== null) {
    const timestamp = Date.parse(expiresAt);
    if (
      typeof expiresAt !== 'string' || !CANONICAL_UTC_SECONDS.test(expiresAt) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().replace('.000Z', 'Z') !== expiresAt
    ) {
      throw new Error('organization entitlement policy is unavailable');
    }
  }
  return {
    termVersion: rows[0].term_version,
    expiresAt,
    expired: expiresAt !== null && Date.parse(expiresAt) <= evaluatedAt
  };
}

function createModuleActionPermissionService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('database must expose prepare');
  }
  const now = options.now || Date.now;
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  function currentTime() {
    const value = now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) {
      throw new Error('organization entitlement policy time is unavailable');
    }
    return milliseconds;
  }

  function projectModuleAccess(input, evaluationContext = null) {
    let requested;
    let module;
    let organizationId = null;
    try {
      if (!isPlainObject(input)) return denied('MALFORMED_REQUEST');
      module = input.module;
      const principal = input.principal;
      if (typeof module !== 'string') {
        return denied('MALFORMED_REQUEST');
      }
      if (!Object.hasOwn(POLICY, module)) return denied('UNKNOWN_MODULE');
      if (ORGANIZATION_SCOPED_MODULES.has(module)) {
        if (!Object.hasOwn(input, 'organizationId')) {
          return denied('ORGANIZATION_SCOPE_REQUIRED');
        }
        organizationId = input.organizationId;
        if (!Number.isSafeInteger(organizationId) || organizationId < 1) {
          return denied('MALFORMED_ORGANIZATION');
        }
      }

      requested = requestPrincipal(principal);
      if (!requested) return denied('MALFORMED_PRINCIPAL');
      if (!REQUEST_ROLE_VOCABULARY.has(requested.role)) return denied('UNKNOWN_ROLE');
    } catch {
      return denied('MALFORMED_REQUEST');
    }

    try {
      const liveUser = db.prepare(`
        SELECT id,role,is_active
        FROM users
        WHERE id=?
      `).get(requested.id);
      if (!liveUser) return denied('MISSING_USER');
      if (liveUser.is_active !== 1) return denied('INACTIVE_USER');
      if (!REQUEST_ROLE_VOCABULARY.has(liveUser.role)) return denied('UNKNOWN_ROLE');
      if (liveUser.role !== requested.role) return denied('ROLE_MISMATCH');

      const principal = {
        user_id: liveUser.id,
        ...(organizationId === null ? {} : { organization_id: organizationId }),
        roles: projectRoles(db, liveUser, organizationId)
      };
      const actions = Object.entries(POLICY[module])
        .filter(([, allowedRoles]) => allowedRoles.some((role) => principal.roles.includes(role)))
        .map(([action]) => action);
      if (ORGANIZATION_SCOPED_MODULES.has(module)) {
        const subscription = evaluationContext && evaluationContext.subscription
          ? evaluationContext.subscription
          : organizationSubscriptionPolicy(db, organizationId, currentTime());
        const policyState = {
          planEntitled: organizationModuleEntitlement(db, organizationId, module),
          subscriptionExpired: subscription.expired
        };
        if (!policyState.planEntitled || policyState.subscriptionExpired) {
          const projection = { allowed: true, code: 'ALLOWED', principal, actions: [] };
          Object.defineProperty(projection, ORGANIZATION_POLICY_STATE, { value: policyState });
          return projection;
        }
        const projection = { allowed: true, code: 'ALLOWED', principal, actions };
        Object.defineProperty(projection, ORGANIZATION_POLICY_STATE, { value: policyState });
        return projection;
      }
      return { allowed: true, code: 'ALLOWED', principal, actions };
    } catch {
      return denied(
        ORGANIZATION_SCOPED_MODULES.has(module)
          ? 'ENTITLEMENT_POLICY_UNAVAILABLE'
          : 'AUTHORITATIVE_FACTS_UNAVAILABLE'
      );
    }
  }

  function authorize(input) {
    let module;
    let action;
    let projectionInput;
    try {
      if (!isPlainObject(input)) return denied('MALFORMED_REQUEST');
      module = input.module;
      action = input.action;
      const principal = input.principal;
      if (typeof module !== 'string' || typeof action !== 'string') {
        return denied('MALFORMED_REQUEST');
      }
      if (!Object.hasOwn(POLICY, module)) return denied('UNKNOWN_MODULE');
      if (!Object.hasOwn(POLICY[module], action)) return denied('UNKNOWN_ACTION');
      projectionInput = { module, principal };
      if (ORGANIZATION_SCOPED_MODULES.has(module)) {
        if (!Object.hasOwn(input, 'organizationId')) {
          return denied('ORGANIZATION_SCOPE_REQUIRED');
        }
        projectionInput.organizationId = input.organizationId;
      }
    } catch {
      return denied('MALFORMED_REQUEST');
    }

    const projection = projectModuleAccess(projectionInput);
    if (!projection.allowed) return projection;
    const allowed = projection.actions.includes(action);
    if (allowed) {
      return { allowed: true, code: 'ALLOWED', principal: projection.principal };
    }
    const roleWouldAllow = POLICY[module][action].some(
      (role) => projection.principal.roles.includes(role)
    );
    const policyState = projection[ORGANIZATION_POLICY_STATE];
    let code = 'ACTION_FORBIDDEN';
    if (ORGANIZATION_SCOPED_MODULES.has(module) && roleWouldAllow) {
      code = policyState && policyState.planEntitled && policyState.subscriptionExpired
        ? 'SUBSCRIPTION_EXPIRED'
        : 'PLAN_ENTITLEMENT_REQUIRED';
    }
    return {
      allowed: false,
      code,
      principal: projection.principal
    };
  }

  function projectModulesAccess(input) {
    try {
      if (!isPlainObject(input) || !Array.isArray(input.modules) || input.modules.length < 1) {
        return denied('MALFORMED_REQUEST');
      }
      const organizationId = input.organizationId;
      if (!Number.isSafeInteger(organizationId) || organizationId < 1) {
        return denied('MALFORMED_ORGANIZATION');
      }
      const modules = input.modules.slice();
      if (
        new Set(modules).size !== modules.length ||
        modules.some((module) => typeof module !== 'string' || !ORGANIZATION_SCOPED_MODULES.has(module))
      ) {
        return denied('UNKNOWN_MODULE');
      }
      const evaluatedAt = currentTime();
      const subscription = organizationSubscriptionPolicy(db, organizationId, evaluatedAt);
      const projections = modules.map((module) => projectModuleAccess({
        principal: input.principal,
        organizationId,
        module
      }, { evaluatedAt, subscription }));
      const failure = projections.find((projection) => !projection.allowed);
      if (failure) return failure;
      return {
        allowed: true,
        code: 'ALLOWED',
        evaluated_at: evaluatedAt,
        subscription: {
          organization_id: organizationId,
          expires_at: subscription.expiresAt,
          term_version: subscription.termVersion,
          status: subscription.expiresAt === null
            ? 'perpetual'
            : (subscription.expired ? 'expired' : 'active')
        },
        projections
      };
    } catch {
      return denied('ENTITLEMENT_POLICY_UNAVAILABLE');
    }
  }

  return Object.freeze({ authorize, projectModuleAccess, projectModulesAccess });
}

module.exports = {
  PLATFORM_ADMINISTRATION_MODULE,
  PLATFORM_ADMINISTRATION_MANAGE_ACTION,
  CRM_CUSTOMER_MODULE,
  CRM_CUSTOMER_READ_ACTION,
  CRM_CUSTOMER_CREATE_ACTION,
  CRM_CUSTOMER_UPDATE_ACTION,
  CRM_OPPORTUNITY_MODULE,
  CRM_OPPORTUNITY_READ_ACTION,
  CRM_OPPORTUNITY_CREATE_ACTION,
  CRM_OPPORTUNITY_UPDATE_ACTION,
  CRM_CONTACT_MODULE,
  CRM_CONTACT_READ_ACTION,
  CRM_CONTACT_CREATE_ACTION,
  CRM_CONTACT_UPDATE_ACTION,
  CRM_TASK_MODULE,
  CRM_TASK_READ_ACTION,
  CRM_TASK_CREATE_ACTION,
  CRM_TASK_UPDATE_ACTION,
  CAMPAIGN_PERFORMANCE_MODULE,
  CAMPAIGN_PERFORMANCE_EXPORT_ACTION,
  CAMPAIGN_CUSTOMER_REPORT_MODULE,
  CAMPAIGN_CUSTOMER_REPORT_EXPORT_ACTION,
  INFLUENCER_DATA_MODULE,
  INFLUENCER_DATA_EXPORT_ACTION,
  INFLUENCER_DATA_IMPORT_ACTION,
  POLICY,
  createModuleActionPermissionService
};
