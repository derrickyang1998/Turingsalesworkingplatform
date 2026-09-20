'use strict';

const { types: utilTypes } = require('node:util');

const ACCESS_ROLES = new Set(['administrator', 'manager', 'member', 'read_only']);
const MEMBERSHIP_STATUSES = new Set(['active', 'revoked']);
const ROLE_ORDER = Object.freeze([
  'platform_admin',
  'company_owner',
  'administrator',
  'manager',
  'member',
  'read_only'
]);
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 120;

class OrganizationGovernanceServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OrganizationGovernanceServiceError';
    this.status = status;
    this.code = code;
  }
}

function serviceError(status, code, message) {
  return new OrganizationGovernanceServiceError(status, code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isQueryObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function boundedQuery(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_INPUT', 'q 必须是字符串。');
  }
  const normalized = value.trim();
  if (normalized.length > MAX_QUERY_LENGTH) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_INPUT', `q 不能超过 ${MAX_QUERY_LENGTH} 个字符。`);
  }
  return normalized;
}

function memberStatus(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !MEMBERSHIP_STATUSES.has(value)) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_INPUT', 'status 必须是 active 或 revoked。');
  }
  return value;
}

function positiveInteger(value, label) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && String(parsed) === value) return parsed;
  }
  throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_INPUT', `${label} 必须是有效的正整数。`);
}

function boundedLimit(value) {
  if (value === undefined || value === null || value === '') return 50;
  const limit = positiveInteger(value, 'limit');
  if (limit > MAX_LIMIT) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_INPUT', `limit 不能超过 ${MAX_LIMIT}。`);
  }
  return limit;
}

function optionalCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  return positiveInteger(value, 'cursor');
}

function requestQuery(options) {
  const query = options && options.query;
  return isQueryObject(query) ? query : {};
}

function normalizedRequestId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function normalizedIpAddress(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function readUser(db, userId) {
  return db.prepare(`
    SELECT id,username,display_name,role,department,is_active
    FROM users
    WHERE id=?
  `).get(userId);
}

function readOrganization(db, organizationId) {
  return db.prepare(`
    SELECT id,code,name,created_at
    FROM organizations
    WHERE id=?
  `).get(organizationId);
}

function membershipProjection(db, user, organizationId) {
  const membership = db.prepare(`
    SELECT
      membership.role_code,
      membership.status,
      policy.access_mode,
      CASE WHEN authority.owner_user_id=membership.user_id THEN 1 ELSE 0 END AS is_company_owner
    FROM organization_memberships membership
    JOIN organization_member_policy policy
      ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
    LEFT JOIN organization_authority authority ON authority.org_id=membership.org_id
    WHERE membership.org_id=? AND membership.user_id=?
  `).get(organizationId, user.id);
  if (!membership) return null;
  const teams = db.prepare(`
    SELECT team.id,team.code,team.name,membership.role_code,membership.status
    FROM team_memberships membership
    JOIN teams team ON team.org_id=membership.org_id AND team.id=membership.team_id
    WHERE membership.org_id=? AND membership.user_id=?
    ORDER BY team.id
  `).all(organizationId, user.id);
  return {
    ...membership,
    is_company_owner: membership.is_company_owner === 1,
    teams
  };
}

function accessRolesFor(user, projection) {
  const roles = new Set();
  if (user && user.is_active === 1 && user.role === 'admin') roles.add('platform_admin');
  if (!user || user.is_active !== 1 || !projection || projection.status !== 'active') {
    return ROLE_ORDER.filter((role) => roles.has(role));
  }
  if (projection.access_mode === 'read_only') {
    roles.add('read_only');
    return ROLE_ORDER.filter((role) => roles.has(role));
  }
  if (projection.is_company_owner) roles.add('company_owner');
  if (projection.role_code === 'org_admin') roles.add('administrator');
  if (projection.teams.some((team) => team.status === 'active' && team.role_code === 'team_lead')) {
    roles.add('manager');
  }
  roles.add('member');
  return ROLE_ORDER.filter((role) => roles.has(role));
}

function effectiveRole(accessRoles) {
  for (const role of [
    'company_owner',
    'read_only',
    'platform_admin',
    'administrator',
    'manager',
    'member'
  ]) {
    if (accessRoles.includes(role)) return role;
  }
  return null;
}

function projectUserAccess(db, options) {
  const userId = positiveInteger(options && options.userId, 'userId');
  const organizationId = positiveInteger(options && options.organizationId, 'organizationId');
  const user = readUser(db, userId);
  if (!user) {
    throw serviceError(404, 'USER_NOT_FOUND', '用户不存在。');
  }
  const projection = membershipProjection(db, user, organizationId);
  if (!projection) {
    throw serviceError(404, 'ORGANIZATION_MEMBERSHIP_NOT_FOUND', '组织成员不存在。');
  }
  const accessRoles = accessRolesFor(user, projection);
  return {
    access_roles: accessRoles,
    organization_access: {
      organization_id: organizationId,
      membership_status: projection.status,
      access_mode: projection.access_mode,
      effective_role: effectiveRole(accessRoles),
      is_company_owner: projection.is_company_owner
    }
  };
}

function liveActor(db, actor) {
  let actorId;
  try {
    actorId = positiveInteger(actor && actor.id, 'actor.id');
  } catch {
    throw serviceError(403, 'ORGANIZATION_GOVERNANCE_FORBIDDEN', '无权访问组织治理功能。');
  }
  const user = readUser(db, actorId);
  if (!user || user.is_active !== 1) {
    throw serviceError(403, 'ORGANIZATION_GOVERNANCE_FORBIDDEN', '无权访问组织治理功能。');
  }
  return user;
}

function actorScope(db, actor, organizationId) {
  const user = liveActor(db, actor);
  if (user.role === 'admin') return { kind: 'platform_admin', user };
  const projection = membershipProjection(db, user, organizationId);
  if (!projection || projection.status !== 'active' || projection.access_mode === 'read_only') {
    throw serviceError(403, 'ORGANIZATION_GOVERNANCE_FORBIDDEN', '无权访问该组织的治理信息。');
  }
  if (projection.is_company_owner) return { kind: 'company_owner', user, projection };
  if (projection.role_code === 'org_admin') return { kind: 'administrator', user, projection };
  throw serviceError(403, 'ORGANIZATION_GOVERNANCE_FORBIDDEN', '无权访问该组织的治理信息。');
}

function visibleOrganizationIds(db, actor) {
  const user = liveActor(db, actor);
  if (user.role === 'admin') return { kind: 'platform_admin', user, ids: null };
  const rows = db.prepare(`
    SELECT membership.org_id
    FROM organization_memberships membership
    JOIN organization_member_policy policy
      ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
    LEFT JOIN organization_authority authority ON authority.org_id=membership.org_id
    WHERE membership.user_id=?
      AND membership.status='active'
      AND policy.access_mode='read_write'
      AND (authority.owner_user_id=membership.user_id OR membership.role_code='org_admin')
    ORDER BY membership.org_id
  `).all(user.id);
  if (rows.length === 0) {
    throw serviceError(403, 'ORGANIZATION_GOVERNANCE_FORBIDDEN', '无权访问组织治理功能。');
  }
  return { kind: 'scoped', user, ids: rows.map((row) => row.org_id) };
}

function ownerSummary(db, organizationId) {
  const row = db.prepare(`
    SELECT user.id AS user_id,user.username,user.display_name,authority.version
    FROM organization_authority authority
    JOIN users user ON user.id=authority.owner_user_id
    WHERE authority.org_id=?
  `).get(organizationId);
  return row || null;
}

function persistAudit(db, input) {
  const details = {
    schema_version: 1,
    actor_user_id: input.actorUserId,
    organization_id: input.organizationId === undefined ? null : input.organizationId,
    subject_user_id: input.subjectUserId === undefined ? null : input.subjectUserId,
    request_id: normalizedRequestId(input.requestId),
    changed_fields: input.changedFields || [],
    result_count: input.resultCount === undefined ? null : input.resultCount,
    next_cursor: input.nextCursor === undefined ? null : input.nextCursor
  };
  if (input.before !== undefined) details.before = input.before;
  if (input.after !== undefined) details.after = input.after;
  if (input.reason !== undefined) details.reason = input.reason;
  if (input.previousOwnerUsername !== undefined) {
    details.previous_owner_username = input.previousOwnerUsername;
  }
  if (input.newOwnerUsername !== undefined) details.new_owner_username = input.newOwnerUsername;
  try {
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,?,'organization_governance',?,?)
    `).run(
      input.actorUserId,
      input.action,
      JSON.stringify(details),
      normalizedIpAddress(input.ipAddress)
    );
  } catch (_error) {
    throw serviceError(500, 'AUDIT_PERSISTENCE_FAILED', '组织治理审计写入失败。');
  }
}

function listOrganizations(
  db,
  options,
  planEntitlementService,
  subscriptionExpiryService,
  aiQuotaService
) {
  const query = requestQuery(options);
  const q = boundedQuery(query.q);
  const limit = boundedLimit(query.limit);
  const cursor = optionalCursor(query.cursor);
  return db.transaction(() => {
    const scope = visibleOrganizationIds(db, options && options.actor);
    const visibleClause = scope.ids === null
      ? ''
      : `AND organization.id IN (${scope.ids.map(() => '?').join(',')})`;
    const parameters = [cursor, cursor, q, q, q, ...(scope.ids || []), limit + 1];
    const rows = db.prepare(`
      SELECT
        organization.id,
        organization.code,
        organization.name,
        organization.created_at,
        (SELECT COUNT(*) FROM teams team WHERE team.org_id=organization.id) AS team_count,
        (SELECT COUNT(*) FROM organization_memberships membership
          WHERE membership.org_id=organization.id AND membership.status='active') AS active_member_count,
        (SELECT COUNT(*) FROM organization_memberships membership
          WHERE membership.org_id=organization.id AND membership.status='revoked') AS revoked_member_count
      FROM organizations organization
      WHERE (? IS NULL OR organization.id>?)
        AND (
          ?='' OR
          instr(lower(organization.code),lower(?))>0 OR
          instr(lower(organization.name),lower(?))>0
        )
        ${visibleClause}
      ORDER BY organization.id
      LIMIT ?
    `).all(...parameters);
    const hasMore = rows.length > limit;
    const selectedRows = rows.slice(0, limit);
    const quotaByOrganization = new Map();
    if (aiQuotaService && selectedRows.length) {
      let projections;
      try {
        projections = aiQuotaService.projectOrganizationQuotas({
          organizationIds: selectedRows.map((row) => row.id)
        });
      } catch (_error) {
        throw serviceError(503, 'AI_QUOTA_POLICY_UNAVAILABLE', '组织 AI 配额策略不可用。');
      }
      if (!Array.isArray(projections) || projections.length !== selectedRows.length) {
        throw serviceError(503, 'AI_QUOTA_POLICY_UNAVAILABLE', '组织 AI 配额策略不可用。');
      }
      for (const projection of projections) {
        quotaByOrganization.set(Number(projection.organization_id), projection);
      }
    }
    const organizations = selectedRows.map((row) => {
      const companyOwner = ownerSummary(db, row.id);
      let plan;
      if (planEntitlementService) {
        try {
          plan = planEntitlementService.projectOrganization({ organizationId: row.id });
        } catch (_error) {
          throw serviceError(503, 'ENTITLEMENT_POLICY_UNAVAILABLE', '组织套餐权益策略不可用。');
        }
      }
      let subscription;
      if (subscriptionExpiryService) {
        try {
          subscription = subscriptionExpiryService.projectOrganization({ organizationId: row.id });
        } catch (_error) {
          throw serviceError(503, 'SUBSCRIPTION_POLICY_UNAVAILABLE', '组织订阅期限策略不可用。');
        }
      }
      let aiMonthlyQuota;
      if (aiQuotaService) {
        const projection = quotaByOrganization.get(Number(row.id));
        if (!projection) {
          throw serviceError(503, 'AI_QUOTA_POLICY_UNAVAILABLE', '组织 AI 配额策略不可用。');
        }
        aiMonthlyQuota = {
          period: projection.period,
          period_key: projection.period_key,
          period_start: projection.period_start,
          period_end: projection.period_end,
          used: projection.used,
          limit: projection.limit,
          remaining: projection.remaining,
          ...(projection.overage_tokens === undefined ? {} : {
            overage_tokens: projection.overage_tokens
          }),
          ...(projection.utilization_percent === undefined ? {} : {
            utilization_percent: projection.utilization_percent
          }),
          status: projection.status,
          policy_version: projection.policy_version
        };
      }
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        created_at: row.created_at,
        team_count: Number(row.team_count),
        active_member_count: Number(row.active_member_count),
        revoked_member_count: Number(row.revoked_member_count),
        company_owner: companyOwner,
        ...(plan === undefined ? {} : { plan }),
        ...(subscription === undefined ? {} : { subscription }),
        ...(aiMonthlyQuota === undefined ? {} : { ai_monthly_quota: aiMonthlyQuota }),
        allowed_actions: {
          initialize_owner: scope.kind === 'platform_admin' && companyOwner === null,
          ...(plan === undefined ? {} : { assign_plan: scope.kind === 'platform_admin' }),
          ...(subscription === undefined ? {} : {
            manage_subscription: scope.kind === 'platform_admin'
          }),
          ...(aiMonthlyQuota === undefined ? {} : {
            manage_ai_quota: scope.kind === 'platform_admin'
          })
        }
      };
    });
    const nextCursor = hasMore ? organizations[organizations.length - 1].id : null;
    persistAudit(db, {
      actorUserId: scope.user.id,
      action: 'organization_governance_list_organizations',
      requestId: options && options.requestId,
      ipAddress: options && options.ipAddress,
      resultCount: organizations.length,
      nextCursor
    });
    return {
      organizations,
      page: { limit, next_cursor: nextCursor, has_more: hasMore }
    };
  }).immediate();
}

function canChangeTarget(scope, target) {
  if (target.is_company_owner || target.platform_role === 'admin') return false;
  if (scope.kind === 'platform_admin' || scope.kind === 'company_owner') return true;
  return scope.kind === 'administrator' &&
    target.organization_role !== 'org_admin';
}

function listMembers(db, options) {
  const organizationId = positiveInteger(options && options.organizationId, 'organizationId');
  const query = requestQuery(options);
  const q = boundedQuery(query.q);
  const status = memberStatus(query.status);
  const limit = boundedLimit(query.limit);
  const cursor = optionalCursor(query.cursor);
  return db.transaction(() => {
    const organization = readOrganization(db, organizationId);
    if (!organization) throw serviceError(404, 'ORGANIZATION_NOT_FOUND', '组织不存在。');
    const scope = actorScope(db, options && options.actor, organizationId);
    const companyOwner = ownerSummary(db, organizationId);
    const rows = db.prepare(`
      SELECT
        membership.user_id,
        user.username,
        user.display_name,
        user.department,
        user.role AS platform_role,
        user.is_active,
        membership.role_code AS organization_role,
        membership.status AS membership_status,
        policy.access_mode,
        CASE WHEN authority.owner_user_id=membership.user_id THEN 1 ELSE 0 END AS is_company_owner
      FROM organization_memberships membership
      JOIN users user ON user.id=membership.user_id
      JOIN organization_member_policy policy
        ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
      LEFT JOIN organization_authority authority ON authority.org_id=membership.org_id
       WHERE membership.org_id=? AND (? IS NULL OR membership.user_id>?)
        AND (
          ?='' OR
          instr(lower(user.username),lower(?))>0 OR
          instr(lower(user.display_name),lower(?))>0 OR
          instr(lower(COALESCE(user.department,'')),lower(?))>0 OR
          instr(lower(user.role),lower(?))>0 OR
          instr(lower(membership.role_code),lower(?))>0 OR
          instr(lower(policy.access_mode),lower(?))>0 OR
          EXISTS (
            SELECT 1
            FROM team_memberships team_membership
            JOIN teams team
              ON team.org_id=team_membership.org_id
             AND team.id=team_membership.team_id
            WHERE team_membership.org_id=membership.org_id
              AND team_membership.user_id=membership.user_id
              AND (
                instr(lower(team.code),lower(?))>0 OR
                instr(lower(team.name),lower(?))>0 OR
                instr(lower(team_membership.role_code),lower(?))>0
              )
          )
        )
        AND (?='' OR membership.status=?)
       ORDER BY membership.user_id
       LIMIT ?
    `).all(
      organizationId,
      cursor,
      cursor,
      q,
      q,
      q,
      q,
      q,
      q,
      q,
      q,
      q,
      q,
      status,
      status,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const members = selected.map((row) => {
      const user = {
        id: row.user_id,
        role: row.platform_role,
        is_active: row.is_active
      };
      const projection = membershipProjection(db, user, organizationId);
      const accessRoles = accessRolesFor(user, projection);
      const target = {
        platform_role: row.platform_role,
        organization_role: row.organization_role,
        is_company_owner: row.is_company_owner === 1
      };
      const changeAllowed = canChangeTarget(scope, target);
      const initializeAllowed = scope.kind === 'platform_admin' &&
        companyOwner === null &&
        row.is_active === 1 &&
        row.membership_status === 'active' &&
        row.access_mode === 'read_write';
      const transferAllowed = companyOwner !== null &&
        (scope.kind === 'platform_admin' || scope.kind === 'company_owner') &&
        target.is_company_owner === false &&
        row.is_active === 1 &&
        row.membership_status === 'active' &&
        row.access_mode === 'read_write';
      return {
        user_id: row.user_id,
        username: row.username,
        display_name: row.display_name,
        department: row.department,
        platform_role: row.platform_role,
        is_active: row.is_active,
        organization_role: row.organization_role,
        membership_status: row.membership_status,
        access_mode: row.access_mode,
        effective_role: effectiveRole(accessRoles),
        is_company_owner: target.is_company_owner,
        teams: projection.teams.map((team) => ({
          id: team.id,
          code: team.code,
          name: team.name,
          role_code: team.role_code,
          status: team.status
        })),
        allowed_actions: {
          change_role: changeAllowed,
          change_status: changeAllowed,
          initialize_owner: initializeAllowed,
          transfer_owner: transferAllowed
        }
      };
    });
    const nextCursor = hasMore ? members[members.length - 1].user_id : null;
    persistAudit(db, {
      actorUserId: scope.user.id,
      action: 'organization_governance_list_members',
      organizationId,
      requestId: options && options.requestId,
      ipAddress: options && options.ipAddress,
      resultCount: members.length,
      nextCursor
    });
    return {
      organization: {
        id: organization.id,
        code: organization.code,
        name: organization.name,
        company_owner: companyOwner
      },
      members,
      page: { limit, next_cursor: nextCursor, has_more: hasMore }
    };
  }).immediate();
}

function exactBody(value, keys) {
  if (!isPlainObject(value)) return null;
  const actual = Object.keys(value).sort();
  const allowed = new Set(keys);
  if (actual.some((key) => !allowed.has(key))) return null;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
  }
  return value;
}

function validateOwnerBody(value) {
  const body = exactBody(value, ['user_id']);
  if (!body || Object.keys(body).length !== 1 || !Number.isSafeInteger(body.user_id) || body.user_id < 1) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_BODY', '请求内容格式无效。');
  }
  return { user_id: body.user_id };
}

function validateMemberBody(value) {
  const body = exactBody(value, ['access_role', 'membership_status']);
  if (!body || Object.keys(body).length < 1) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_BODY', '请求内容格式无效。');
  }
  if (Object.hasOwn(body, 'access_role') &&
      (typeof body.access_role !== 'string' || !ACCESS_ROLES.has(body.access_role))) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_BODY', 'access_role 无效。');
  }
  if (Object.hasOwn(body, 'membership_status') &&
      (typeof body.membership_status !== 'string' || !MEMBERSHIP_STATUSES.has(body.membership_status))) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_BODY', 'membership_status 无效。');
  }
  const normalized = {};
  if (Object.hasOwn(body, 'access_role')) normalized.access_role = body.access_role;
  if (Object.hasOwn(body, 'membership_status')) normalized.membership_status = body.membership_status;
  return normalized;
}

function validateOwnerTransferBody(value) {
  const keys = [
    'confirmation_username',
    'expected_owner_user_id',
    'expected_version',
    'new_owner_user_id',
    'reason'
  ];
  const body = exactBody(value, keys);
  if (!body || Object.keys(body).length !== keys.length) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_BODY', '请求内容格式无效。');
  }
  for (const key of ['new_owner_user_id', 'expected_owner_user_id', 'expected_version']) {
    if (!Number.isSafeInteger(body[key]) || body[key] < 1) {
      throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_BODY', '请求内容格式无效。');
    }
  }
  if (
    typeof body.confirmation_username !== 'string' ||
    body.confirmation_username.length < 1 ||
    body.confirmation_username.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(body.confirmation_username)
  ) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_BODY', '请求内容格式无效。');
  }
  if (typeof body.reason !== 'string') {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_BODY', '请求内容格式无效。');
  }
  const reason = body.reason.trim();
  const reasonLength = [...reason].length;
  if (reasonLength < 8 || reasonLength > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw serviceError(400, 'INVALID_ORGANIZATION_GOVERNANCE_BODY', '请求内容格式无效。');
  }
  return {
    new_owner_user_id: body.new_owner_user_id,
    expected_owner_user_id: body.expected_owner_user_id,
    expected_version: body.expected_version,
    confirmation_username: body.confirmation_username,
    reason
  };
}

function initializeOwner(db, options) {
  const organizationId = positiveInteger(options && options.organizationId, 'organizationId');
  const body = validateOwnerBody(options && options.body);
  return db.transaction(() => {
    const actorUser = liveActor(db, options && options.actor);
    if (actorUser.role !== 'admin') {
      throw serviceError(403, 'PLATFORM_ADMIN_REQUIRED', '仅平台管理员可以初始化公司所有者。');
    }
    const scope = { kind: 'platform_admin', user: actorUser };
    if (!readOrganization(db, organizationId)) {
      throw serviceError(404, 'ORGANIZATION_NOT_FOUND', '组织不存在。');
    }
    if (ownerSummary(db, organizationId)) {
      throw serviceError(409, 'COMPANY_OWNER_ALREADY_INITIALIZED', '公司所有者已初始化，本版本不可替换。');
    }
    const candidate = db.prepare(`
      SELECT membership.user_id
      FROM organization_memberships membership
      JOIN organization_member_policy policy
        ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
      JOIN users user ON user.id=membership.user_id
      WHERE membership.org_id=? AND membership.user_id=?
        AND membership.status='active'
        AND policy.access_mode='read_write'
        AND user.is_active=1
    `).get(organizationId, body.user_id);
    if (!candidate) {
      throw serviceError(409, 'COMPANY_OWNER_CANDIDATE_INELIGIBLE', '公司所有者必须是活跃且可写的本组织成员。');
    }
    db.prepare(`
      INSERT INTO organization_authority (
        org_id,owner_user_id,created_by,created_at,updated_by,updated_at,version
      )
      VALUES (?,?,?,CURRENT_TIMESTAMP,?,CURRENT_TIMESTAMP,1)
    `).run(organizationId, body.user_id, scope.user.id, scope.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(body.user_id);
    persistAudit(db, {
      actorUserId: scope.user.id,
      action: 'organization_owner_initialized',
      organizationId,
      subjectUserId: body.user_id,
      requestId: options && options.requestId,
      ipAddress: options && options.ipAddress,
      changedFields: ['company_owner'],
      before: { company_owner: null },
      after: { company_owner_user_id: body.user_id }
    });
    return { changed: true };
  }).immediate();
}

function transferOwner(db, options) {
  const organizationId = positiveInteger(options && options.organizationId, 'organizationId');
  const body = validateOwnerTransferBody(options && options.body);
  return db.transaction(() => {
    if (!readOrganization(db, organizationId)) {
      throw serviceError(404, 'ORGANIZATION_NOT_FOUND', '组织不存在。');
    }
    const actorUser = liveActor(db, options && options.actor);
    const current = db.prepare(`
      SELECT
        authority.owner_user_id,
        authority.version,
        owner.username AS owner_username
      FROM organization_authority authority
      JOIN users owner ON owner.id=authority.owner_user_id
      WHERE authority.org_id=?
    `).get(organizationId);
    if (!current) {
      throw serviceError(409, 'COMPANY_OWNER_NOT_INITIALIZED', '请先初始化企业所有者。');
    }
    if (actorUser.role !== 'admin' && actorUser.id !== current.owner_user_id) {
      throw serviceError(403, 'ORGANIZATION_OWNER_TRANSFER_FORBIDDEN', '仅平台管理员或当前企业所有者可以转移所有权。');
    }
    if (
      body.expected_owner_user_id !== current.owner_user_id ||
      body.expected_version !== current.version
    ) {
      throw serviceError(409, 'ORGANIZATION_OWNER_TRANSFER_STALE', '企业所有权已发生变化，请刷新后重试。');
    }
    if (body.new_owner_user_id === current.owner_user_id) {
      throw serviceError(409, 'ORGANIZATION_OWNER_UNCHANGED', '新企业所有者不能与当前所有者相同。');
    }
    const candidate = db.prepare(`
      SELECT user.id AS user_id,user.username,user.display_name
      FROM organization_memberships membership
      JOIN organization_member_policy policy
        ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
      JOIN users user ON user.id=membership.user_id
      WHERE membership.org_id=? AND membership.user_id=?
        AND membership.status='active'
        AND policy.access_mode='read_write'
        AND user.is_active=1
    `).get(organizationId, body.new_owner_user_id);
    if (!candidate) {
      throw serviceError(409, 'COMPANY_OWNER_CANDIDATE_INELIGIBLE', '企业所有者必须是活跃且可写的本组织成员。');
    }
    if (body.confirmation_username !== candidate.username) {
      throw serviceError(409, 'ORGANIZATION_OWNER_CONFIRMATION_MISMATCH', '确认账号与目标成员不一致。');
    }

    const update = db.prepare(`
      UPDATE organization_authority
      SET
        owner_user_id=?,
        updated_by=?,
        updated_at=CURRENT_TIMESTAMP,
        version=version+1
      WHERE org_id=? AND owner_user_id=? AND version=?
    `).run(
      candidate.user_id,
      actorUser.id,
      organizationId,
      body.expected_owner_user_id,
      body.expected_version
    );
    if (update.changes !== 1) {
      throw serviceError(409, 'ORGANIZATION_OWNER_TRANSFER_STALE', '企业所有权已发生变化，请刷新后重试。');
    }
    const nextVersion = body.expected_version + 1;
    db.prepare('DELETE FROM sessions WHERE user_id IN (?,?)')
      .run(current.owner_user_id, candidate.user_id);
    persistAudit(db, {
      actorUserId: actorUser.id,
      action: 'organization_owner_transferred',
      organizationId,
      subjectUserId: candidate.user_id,
      requestId: options && options.requestId,
      ipAddress: options && options.ipAddress,
      changedFields: ['company_owner', 'authority_version'],
      before: {
        company_owner_user_id: current.owner_user_id,
        version: current.version
      },
      after: {
        company_owner_user_id: candidate.user_id,
        version: nextVersion
      },
      reason: body.reason,
      previousOwnerUsername: current.owner_username,
      newOwnerUsername: candidate.username
    });
    return {
      changed: true,
      organization_id: organizationId,
      previous_owner_user_id: current.owner_user_id,
      owner: {
        user_id: candidate.user_id,
        username: candidate.username,
        display_name: candidate.display_name,
        version: nextVersion
      },
      reauthentication_required:
        actorUser.id === current.owner_user_id || actorUser.id === candidate.user_id
    };
  }).immediate();
}

function memberState(db, organizationId, userId) {
  const row = db.prepare(`
    SELECT membership.role_code,membership.status,membership.revoked_at,policy.access_mode
    FROM organization_memberships membership
    JOIN organization_member_policy policy
      ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
    WHERE membership.org_id=? AND membership.user_id=?
  `).get(organizationId, userId);
  if (!row) return null;
  return {
    organization_role: row.role_code,
    membership_status: row.status,
    access_mode: row.access_mode
  };
}

function updateMember(db, options) {
  const organizationId = positiveInteger(options && options.organizationId, 'organizationId');
  const userId = positiveInteger(options && options.userId, 'userId');
  const body = validateMemberBody(options && options.body);
  return db.transaction(() => {
    if (!readOrganization(db, organizationId)) {
      throw serviceError(404, 'ORGANIZATION_NOT_FOUND', '组织不存在。');
    }
    const scope = actorScope(db, options && options.actor, organizationId);
    const user = readUser(db, userId);
    const projection = user && membershipProjection(db, user, organizationId);
    if (!user || !projection) {
      throw serviceError(404, 'ORGANIZATION_MEMBERSHIP_NOT_FOUND', '组织成员不存在。');
    }
    const target = {
      platform_role: user.role,
      organization_role: projection.role_code,
      is_company_owner: projection.is_company_owner
    };
    if (target.is_company_owner) {
      throw serviceError(409, 'COMPANY_OWNER_IMMUTABLE', '公司所有者在本版本不可修改、撤销或替换。');
    }
    if (!canChangeTarget(scope, target)) {
      throw serviceError(403, 'ORGANIZATION_MEMBER_CHANGE_FORBIDDEN', '无权修改该组织成员。');
    }

    if (body.access_role === 'manager') {
      const activeTeam = db.prepare(`
        SELECT 1 AS present
        FROM team_memberships
        WHERE org_id=? AND user_id=? AND status='active'
        LIMIT 1
      `).get(organizationId, userId);
      if (!activeTeam) {
        throw serviceError(409, 'MANAGER_TEAM_REQUIRED', '成员至少需要归属一个有效团队后才能设为经理。');
      }
    }

    const before = memberState(db, organizationId, userId);
    if (body.access_role) {
      const organizationRole = body.access_role === 'administrator' ? 'org_admin' : 'member';
      const teamRole = body.access_role === 'manager' ? 'team_lead' : 'member';
      const accessMode = body.access_role === 'read_only' ? 'read_only' : 'read_write';
      db.prepare(`
        UPDATE organization_memberships SET role_code=? WHERE org_id=? AND user_id=?
      `).run(organizationRole, organizationId, userId);
      db.prepare(`
        UPDATE team_memberships SET role_code=? WHERE org_id=? AND user_id=?
      `).run(teamRole, organizationId, userId);
      db.prepare(`
        UPDATE organization_member_policy
        SET access_mode=?,updated_at=CURRENT_TIMESTAMP
        WHERE org_id=? AND user_id=?
      `).run(accessMode, organizationId, userId);
    }
    if (body.membership_status) {
      const revokedAt = body.membership_status === 'revoked' ?
        db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%S','now') AS value").get().value :
        null;
      db.prepare(`
        UPDATE organization_memberships
        SET status=?,revoked_at=?
        WHERE org_id=? AND user_id=?
      `).run(body.membership_status, revokedAt, organizationId, userId);
    }
    const after = memberState(db, organizationId, userId);
    const changedFields = Object.keys(after).filter((key) => before[key] !== after[key]).sort();
    if (changedFields.length > 0) db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    persistAudit(db, {
      actorUserId: scope.user.id,
      action: 'organization_member_updated',
      organizationId,
      subjectUserId: userId,
      requestId: options && options.requestId,
      ipAddress: options && options.ipAddress,
      changedFields,
      before,
      after
    });
    return { changed: changedFields.length > 0 };
  }).immediate();
}

function createOrganizationGovernanceService(db, factoryOptions = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }
  const planEntitlementService = factoryOptions.planEntitlementService || null;
  const subscriptionExpiryService = factoryOptions.subscriptionExpiryService || null;
  const aiQuotaService = factoryOptions.aiQuotaService || null;
  if (
    planEntitlementService !== null &&
    typeof planEntitlementService.projectOrganization !== 'function'
  ) {
    throw new TypeError('planEntitlementService must expose projectOrganization');
  }
  if (
    subscriptionExpiryService !== null &&
    typeof subscriptionExpiryService.projectOrganization !== 'function'
  ) {
    throw new TypeError('subscriptionExpiryService must expose projectOrganization');
  }
  if (
    aiQuotaService !== null &&
    typeof aiQuotaService.projectOrganizationQuotas !== 'function'
  ) {
    throw new TypeError('aiQuotaService must expose projectOrganizationQuotas');
  }
  return Object.freeze({
    projectUserAccess(requestOptions) {
      return projectUserAccess(db, requestOptions || {});
    },
    listOrganizations(requestOptions) {
      return listOrganizations(
        db,
        requestOptions || {},
        planEntitlementService,
        subscriptionExpiryService,
        aiQuotaService
      );
    },
    listMembers(requestOptions) {
      return listMembers(db, requestOptions || {});
    },
    initializeOwner(requestOptions) {
      return initializeOwner(db, requestOptions || {});
    },
    transferOwner(requestOptions) {
      return transferOwner(db, requestOptions || {});
    },
    updateMember(requestOptions) {
      return updateMember(db, requestOptions || {});
    }
  });
}

module.exports = {
  OrganizationGovernanceServiceError,
  createOrganizationGovernanceService,
  validateMemberBody,
  validateOwnerBody,
  validateOwnerTransferBody
};
