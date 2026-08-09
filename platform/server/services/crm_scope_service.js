'use strict';

const { types: utilTypes } = require('node:util');
const { resolveOrganizationScope } = require('./organization_access_service');

const TIME_ZONE = 'Asia/Shanghai';
const ALLOWED_SCOPES = new Set(['my', 'team', 'organization', 'public_pool']);

const CUSTOMER_CUSTODY_CASE_SQL = `CASE
  WHEN c.is_public=1
    AND c.assigned_to IS NULL
    AND c.team_id IS NULL
    THEN 'public'
  WHEN c.is_public=0
    AND c.assigned_to IS NOT NULL
    AND c.team_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM users crm_custody_user
      JOIN organization_memberships crm_custody_org
        ON crm_custody_org.user_id=crm_custody_user.id
       AND crm_custody_org.org_id=c.org_id
       AND crm_custody_org.status='active'
      JOIN team_memberships crm_custody_team
        ON crm_custody_team.user_id=crm_custody_user.id
       AND crm_custody_team.org_id=c.org_id
       AND crm_custody_team.team_id=c.team_id
       AND crm_custody_team.status='active'
      WHERE crm_custody_user.id=c.assigned_to
        AND crm_custody_user.is_active=1
    )
    THEN 'owned'
  ELSE 'quarantined'
END`;

class CrmScopeError extends Error {
  constructor(code, status, reason) {
    super('CRM scope request rejected');
    Object.defineProperties(this, {
      name: { value: 'CrmScopeError', enumerable: true },
      code: { value: code, enumerable: true },
      status: { value: status, enumerable: true },
      reason: { value: reason, enumerable: true }
    });
  }
}

function invalidScope() {
  return new CrmScopeError('CRM_SCOPE_INVALID', 400, 'invalid_context');
}

function missingScope() {
  return new CrmScopeError('CRM_SCOPE_NOT_FOUND', 404, 'not_found');
}

function forbiddenScope() {
  return new CrmScopeError('CRM_SCOPE_FORBIDDEN', 403, 'insufficient_scope');
}

function snapshotPlainOptions(value, recognizedKeys) {
  if (utilTypes.isProxy(value)) return null;
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const snapshot = {};
    for (const key of recognizedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function dataProperty(value, key) {
  if (utilTypes.isProxy(value)) return { ok: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { ok: false };
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validRequestId(value) {
  return value === null || (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 120
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function resolveCrmAccessContext(db, options) {
  const input = snapshotPlainOptions(options, [
    'actorUserId',
    'organizationId',
    'organizationCode',
    'requestId'
  ]);
  if (!input || !positiveSafeInteger(input.actorUserId)) throw invalidScope();

  const hasOrganizationId = Object.hasOwn(input, 'organizationId');
  const hasOrganizationCode = Object.hasOwn(input, 'organizationCode');
  if (hasOrganizationId && hasOrganizationCode) throw invalidScope();
  const requestId = Object.hasOwn(input, 'requestId') ? input.requestId : null;
  if (!validRequestId(requestId)) throw invalidScope();

  const organizationOptions = {
    userId: input.actorUserId,
    repairMissing: false,
    actorUserId: input.actorUserId,
    requestId
  };
  if (hasOrganizationId) organizationOptions.organizationId = input.organizationId;
  if (hasOrganizationCode) organizationOptions.organizationCode = input.organizationCode;

  let resolved;
  try {
    resolved = resolveOrganizationScope(db, organizationOptions);
  } catch (error) {
    if (error instanceof TypeError) throw invalidScope();
    throw error;
  }
  if (!resolved || resolved.ok !== true) throw missingScope();

  const authContext = resolved.authContext;
  if (!authContext || typeof authContext !== 'object' || utilTypes.isProxy(authContext)) {
    throw missingScope();
  }
  const organizationProperty = dataProperty(authContext, 'organization');
  const teamsProperty = dataProperty(authContext, 'teams');
  if (!organizationProperty.ok || !teamsProperty.ok) throw missingScope();
  const organization = organizationProperty.value;
  const teams = teamsProperty.value;
  if (!organization || typeof organization !== 'object' || utilTypes.isProxy(organization)) {
    throw missingScope();
  }
  if (!Array.isArray(teams) || utilTypes.isProxy(teams) || teams.length === 0) {
    throw missingScope();
  }

  const organizationId = dataProperty(organization, 'id');
  const organizationCode = dataProperty(organization, 'code');
  const organizationRole = dataProperty(organization, 'role_code');
  if (
    !organizationId.ok || !positiveSafeInteger(organizationId.value) ||
    !organizationCode.ok || typeof organizationCode.value !== 'string' ||
    !organizationRole.ok || typeof organizationRole.value !== 'string'
  ) {
    throw missingScope();
  }

  const mappedTeams = [];
  const seenTeamIds = new Set();
  for (const team of teams) {
    if (!team || typeof team !== 'object' || Array.isArray(team) || utilTypes.isProxy(team)) {
      throw missingScope();
    }
    const teamId = dataProperty(team, 'id');
    const teamRole = dataProperty(team, 'role_code');
    if (
      !teamId.ok || !positiveSafeInteger(teamId.value) || seenTeamIds.has(teamId.value) ||
      !teamRole.ok || typeof teamRole.value !== 'string'
    ) {
      throw missingScope();
    }
    seenTeamIds.add(teamId.value);
    mappedTeams.push({ id: teamId.value, role_code: teamRole.value });
  }

  return deepFreeze({
    actor_user_id: input.actorUserId,
    organization: {
      id: organizationId.value,
      code: organizationCode.value,
      role_code: organizationRole.value
    },
    teams: mappedTeams,
    team_ids: mappedTeams.map((team) => team.id),
    is_org_admin: organizationRole.value === 'org_admin',
    time_zone: TIME_ZONE
  });
}

function snapshotContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || utilTypes.isProxy(context)) {
    throw invalidScope();
  }
  const actor = dataProperty(context, 'actor_user_id');
  const organizationProperty = dataProperty(context, 'organization');
  const teamsProperty = dataProperty(context, 'teams');
  const teamIdsProperty = dataProperty(context, 'team_ids');
  const adminProperty = dataProperty(context, 'is_org_admin');
  const timeZoneProperty = dataProperty(context, 'time_zone');
  if (
    !actor.ok || !positiveSafeInteger(actor.value) ||
    !organizationProperty.ok || !teamsProperty.ok || !teamIdsProperty.ok ||
    !adminProperty.ok || typeof adminProperty.value !== 'boolean' ||
    !timeZoneProperty.ok || timeZoneProperty.value !== TIME_ZONE
  ) {
    throw invalidScope();
  }
  const organization = organizationProperty.value;
  if (!organization || typeof organization !== 'object' || Array.isArray(organization) || utilTypes.isProxy(organization)) {
    throw invalidScope();
  }
  const organizationId = dataProperty(organization, 'id');
  const organizationRole = dataProperty(organization, 'role_code');
  if (
    !organizationId.ok || !positiveSafeInteger(organizationId.value) ||
    !organizationRole.ok || typeof organizationRole.value !== 'string' ||
    adminProperty.value !== (organizationRole.value === 'org_admin')
  ) {
    throw invalidScope();
  }
  const teams = teamsProperty.value;
  const teamIds = teamIdsProperty.value;
  if (
    !Array.isArray(teams) || utilTypes.isProxy(teams) ||
    !Array.isArray(teamIds) || utilTypes.isProxy(teamIds) ||
    teams.length === 0 || teams.length !== teamIds.length
  ) {
    throw invalidScope();
  }
  const copiedTeamIds = [];
  for (let index = 0; index < teams.length; index += 1) {
    const team = teams[index];
    if (!team || typeof team !== 'object' || Array.isArray(team) || utilTypes.isProxy(team)) {
      throw invalidScope();
    }
    const teamId = dataProperty(team, 'id');
    if (
      !teamId.ok || !positiveSafeInteger(teamId.value) ||
      teamIds[index] !== teamId.value || copiedTeamIds.includes(teamId.value)
    ) {
      throw invalidScope();
    }
    copiedTeamIds.push(teamId.value);
  }
  return {
    actorUserId: actor.value,
    organizationId: organizationId.value,
    teamIds: copiedTeamIds,
    isOrgAdmin: adminProperty.value
  };
}

function effectiveScope(context, requestedScope) {
  if (requestedScope === null || requestedScope === undefined) {
    return context.isOrgAdmin ? 'organization' : 'my';
  }
  if (typeof requestedScope !== 'string' || !ALLOWED_SCOPES.has(requestedScope)) {
    throw invalidScope();
  }
  if (requestedScope === 'organization' && !context.isOrgAdmin) throw forbiddenScope();
  return requestedScope;
}

function frozenCompilation(scope, whereSql, params) {
  return Object.freeze({
    scope,
    where_sql: whereSql,
    params: Object.freeze(params.slice())
  });
}

function compileCustomerScope(context, requestedScope) {
  const safeContext = snapshotContext(context);
  const scope = effectiveScope(safeContext, requestedScope);
  const custodySql = `(${CUSTOMER_CUSTODY_CASE_SQL})`;

  if (scope === 'organization') {
    return frozenCompilation(scope, 'c.org_id=?', [safeContext.organizationId]);
  }
  if (scope === 'public_pool') {
    return frozenCompilation(
      scope,
      'c.org_id=? AND c.is_public=1 AND c.assigned_to IS NULL AND c.team_id IS NULL',
      [safeContext.organizationId]
    );
  }
  if (scope === 'team') {
    const placeholders = safeContext.teamIds.map(() => '?').join(',');
    return frozenCompilation(
      scope,
      `c.org_id=? AND ${custodySql}='owned' AND c.team_id IN (${placeholders})`,
      [safeContext.organizationId, ...safeContext.teamIds]
    );
  }
  return frozenCompilation(
    scope,
    `c.org_id=? AND ${custodySql}='owned' AND (c.assigned_to=? OR c.created_by=?)`,
    [safeContext.organizationId, safeContext.actorUserId, safeContext.actorUserId]
  );
}

function compileOpportunityScope(context, requestedScope) {
  const safeContext = snapshotContext(context);
  const scope = effectiveScope(safeContext, requestedScope);
  const custodySql = `(${CUSTOMER_CUSTODY_CASE_SQL})`;
  const organizationParams = [safeContext.organizationId, safeContext.organizationId];

  if (scope === 'organization') {
    return frozenCompilation(scope, 'c.org_id=? AND o.org_id=?', organizationParams);
  }
  if (scope === 'public_pool') {
    return frozenCompilation(scope, 'c.org_id=? AND o.org_id=? AND 1=0', organizationParams);
  }
  if (scope === 'team') {
    const placeholders = safeContext.teamIds.map(() => '?').join(',');
    return frozenCompilation(
      scope,
      `c.org_id=? AND o.org_id=? AND ${custodySql}='owned' AND c.team_id IN (${placeholders})`,
      [...organizationParams, ...safeContext.teamIds]
    );
  }
  return frozenCompilation(
    scope,
    `c.org_id=? AND o.org_id=? AND ${custodySql}='owned' AND (c.assigned_to=? OR c.created_by=?)`,
    [...organizationParams, safeContext.actorUserId, safeContext.actorUserId]
  );
}

module.exports = {
  CrmScopeError,
  resolveCrmAccessContext,
  compileCustomerScope,
  compileOpportunityScope,
  CUSTOMER_CUSTODY_CASE_SQL
};
