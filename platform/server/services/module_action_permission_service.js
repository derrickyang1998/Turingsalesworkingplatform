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

function createModuleActionPermissionService(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('database must expose prepare');
  }

  function projectModuleAccess(input) {
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
      return { allowed: true, code: 'ALLOWED', principal, actions };
    } catch {
      return denied('AUTHORITATIVE_FACTS_UNAVAILABLE');
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
    return allowed
      ? { allowed: true, code: 'ALLOWED', principal: projection.principal }
      : { allowed: false, code: 'ACTION_FORBIDDEN', principal: projection.principal };
  }

  return Object.freeze({ authorize, projectModuleAccess });
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
