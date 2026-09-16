'use strict';

const PLATFORM_ADMINISTRATION_MODULE = 'platform_administration';
const PLATFORM_ADMINISTRATION_MANAGE_ACTION = 'manage';
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
  })
});

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

function projectRoles(db, user) {
  const roles = new Set();
  if (user.role === 'admin') roles.add('platform_admin');

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
  `).all(user.id);
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
  `).all(user.id);
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

  function authorize(input) {
    let requested;
    let allowedRoles;
    try {
      if (!isPlainObject(input)) return denied('MALFORMED_REQUEST');
      const module = input.module;
      const action = input.action;
      const principal = input.principal;
      if (typeof module !== 'string' || typeof action !== 'string') {
        return denied('MALFORMED_REQUEST');
      }
      if (!Object.hasOwn(POLICY, module)) return denied('UNKNOWN_MODULE');
      const modulePolicy = POLICY[module];
      if (!Object.hasOwn(modulePolicy, action)) return denied('UNKNOWN_ACTION');
      allowedRoles = modulePolicy[action];

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
        roles: projectRoles(db, liveUser)
      };
      const allowed = allowedRoles.some((role) => principal.roles.includes(role));
      return allowed
        ? { allowed: true, code: 'ALLOWED', principal }
        : { allowed: false, code: 'ACTION_FORBIDDEN', principal };
    } catch {
      return denied('AUTHORITATIVE_FACTS_UNAVAILABLE');
    }
  }

  return Object.freeze({ authorize });
}

module.exports = {
  PLATFORM_ADMINISTRATION_MODULE,
  PLATFORM_ADMINISTRATION_MANAGE_ACTION,
  POLICY,
  createModuleActionPermissionService
};
