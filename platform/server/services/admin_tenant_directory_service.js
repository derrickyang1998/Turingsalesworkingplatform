'use strict';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 120;
const MAX_REQUEST_ID_LENGTH = 120;
const MAX_IP_ADDRESS_LENGTH = 128;
const MEMBER_STATUSES = new Set(['active', 'revoked']);
const USER_STATUSES = new Set(['active', 'inactive']);
const USER_ACCESS_ROLES = new Set(['platform_admin', 'org_admin', 'team_lead', 'member']);

class AdminTenantDirectoryServiceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AdminTenantDirectoryServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function serviceError(statusCode, code, message) {
  return new AdminTenantDirectoryServiceError(statusCode, code, message);
}

function positiveInteger(value, fieldName) {
  const source = typeof value === 'number' ? String(value) : value;
  if (typeof source !== 'string' || !/^[1-9]\d*$/.test(source)) {
    throw serviceError(400, 'INVALID_TENANT_DIRECTORY_FILTER', `${fieldName} must be a positive integer.`);
  }
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed)) {
    throw serviceError(400, 'INVALID_TENANT_DIRECTORY_FILTER', `${fieldName} must be a safe positive integer.`);
  }
  return parsed;
}

function optionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  return positiveInteger(value, fieldName);
}

function boundedQuery(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw serviceError(400, 'INVALID_TENANT_DIRECTORY_FILTER', 'q must be a string.');
  }
  const normalized = value.trim();
  if (normalized.length > MAX_QUERY_LENGTH) {
    throw serviceError(400, 'INVALID_TENANT_DIRECTORY_FILTER', 'q is too long.');
  }
  return normalized;
}

function boundedLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const limit = positiveInteger(value, 'limit');
  if (limit > MAX_LIMIT) {
    throw serviceError(400, 'INVALID_TENANT_DIRECTORY_FILTER', `limit must not exceed ${MAX_LIMIT}.`);
  }
  return limit;
}

function memberStatus(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !MEMBER_STATUSES.has(value)) {
    throw serviceError(400, 'INVALID_TENANT_DIRECTORY_FILTER', 'status must be active or revoked.');
  }
  return value;
}

function userStatus(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !USER_STATUSES.has(value)) {
    throw serviceError(400, 'INVALID_TENANT_DIRECTORY_FILTER', 'status must be active or inactive.');
  }
  return value;
}

function userAccessRole(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !USER_ACCESS_ROLES.has(value)) {
    throw serviceError(
      400,
      'INVALID_TENANT_DIRECTORY_FILTER',
      'role must be platform_admin, org_admin, team_lead, or member.'
    );
  }
  return value;
}

function readQuery(options) {
  const value = options && options.query;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedRequestId(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_REQUEST_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) return null;
  return value;
}

function normalizedIpAddress(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_IP_ADDRESS_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) return null;
  return value;
}

function filterNames(query, names) {
  return names.filter((name) => (
    Object.prototype.hasOwnProperty.call(query, name) &&
    query[name] !== undefined &&
    query[name] !== null &&
    query[name] !== ''
  )).sort();
}

function assertPlatformAdmin(db, actor) {
  const actorId = positiveInteger(actor && actor.id, 'actor.id');
  const row = db.prepare(`
    SELECT id,role,is_active
    FROM users
    WHERE id=?
  `).get(actorId);
  if (!row || row.role !== 'admin' || row.is_active !== 1 || actor.role !== 'admin') {
    throw serviceError(403, 'ADMIN_REQUIRED', 'Platform administrator access is required.');
  }
  return actorId;
}

function persistReadAudit(db, input) {
  const details = {
    schema_version: 1,
    actor_user_id: input.actorUserId,
    request_id: normalizedRequestId(input.requestId),
    filter_names: input.filterNames,
    target_organization_ids: input.organizationIds,
    result_count: input.resultCount,
    next_cursor: input.nextCursor
  };
  if (input.userIds) details.target_user_ids = input.userIds;
  try {
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,?,'tenant_admin',?,?)
    `).run(
      input.actorUserId,
      input.action,
      JSON.stringify(details),
      normalizedIpAddress(input.ipAddress)
    );
  } catch (_error) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Tenant directory read audit could not be persisted.'
    );
  }
}

function listUsers(db, options) {
  const query = readQuery(options);
  const q = boundedQuery(query.q);
  const status = userStatus(query.status);
  const role = userAccessRole(query.role);
  const limit = boundedLimit(query.limit);
  const cursor = optionalPositiveInteger(query.cursor, 'cursor');
  const names = filterNames(query, ['q', 'status', 'role', 'limit', 'cursor']);

  return db.transaction(() => {
    const actorUserId = assertPlatformAdmin(db, options && options.actor);
    const rows = db.prepare(`
      SELECT
        user.id,
        user.username,
        user.display_name,
        user.role,
        user.department,
        user.email,
        user.api_quota,
        user.created_at,
        user.last_login,
        user.is_active
      FROM users user
      WHERE (? IS NULL OR user.id>?)
        AND (
          ?='' OR
          instr(lower(user.username),lower(?))>0 OR
          instr(lower(user.display_name),lower(?))>0 OR
          instr(lower(COALESCE(user.department,'')),lower(?))>0 OR
          instr(lower(COALESCE(user.email,'')),lower(?))>0 OR
          instr(lower(COALESCE(user.role,'')),lower(?))>0 OR
          EXISTS (
            SELECT 1
            FROM organization_memberships membership
            JOIN organizations organization ON organization.id=membership.org_id
            WHERE membership.user_id=user.id
              AND (
                instr(lower(organization.code),lower(?))>0 OR
                instr(lower(organization.name),lower(?))>0 OR
                instr(lower(membership.role_code),lower(?))>0
              )
          ) OR
          EXISTS (
            SELECT 1
            FROM team_memberships membership
            JOIN teams team
              ON team.org_id=membership.org_id
             AND team.id=membership.team_id
            WHERE membership.user_id=user.id
              AND (
                instr(lower(team.code),lower(?))>0 OR
                instr(lower(team.name),lower(?))>0 OR
                instr(lower(membership.role_code),lower(?))>0
              )
          )
        )
        AND (
          ?='' OR
          (?='active' AND user.is_active=1) OR
          (?='inactive' AND user.is_active=0)
        )
        AND (
          ?='' OR
          (?='platform_admin' AND user.role='admin') OR
          (?='org_admin' AND EXISTS (
            SELECT 1
            FROM organization_memberships membership
            WHERE membership.user_id=user.id
              AND membership.status='active'
              AND membership.role_code='org_admin'
          )) OR
          (?='team_lead' AND EXISTS (
            SELECT 1
            FROM team_memberships membership
            JOIN organization_memberships organization_membership
              ON organization_membership.org_id=membership.org_id
             AND organization_membership.user_id=membership.user_id
             AND organization_membership.status='active'
            WHERE membership.user_id=user.id
              AND membership.status='active'
              AND membership.role_code='team_lead'
          )) OR
          (?='member' AND (
            EXISTS (
              SELECT 1
              FROM organization_memberships membership
              WHERE membership.user_id=user.id
                AND membership.status='active'
                AND membership.role_code='member'
            ) OR
            EXISTS (
              SELECT 1
              FROM team_memberships membership
              JOIN organization_memberships organization_membership
                ON organization_membership.org_id=membership.org_id
               AND organization_membership.user_id=membership.user_id
               AND organization_membership.status='active'
              WHERE membership.user_id=user.id
                AND membership.status='active'
                AND membership.role_code='member'
            )
          ))
        )
      ORDER BY user.id
      LIMIT ?
    `).all(
      cursor, cursor,
      q, q, q, q, q, q,
      q, q, q,
      q, q, q,
      status, status, status,
      role, role, role, role, role,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const selectedRows = rows.slice(0, limit);
    const userIds = selectedRows.map((row) => row.id);
    const organizationsByUser = new Map(userIds.map((userId) => [userId, []]));
    const organizationByUserAndId = new Map();

    if (userIds.length) {
      const placeholders = userIds.map(() => '?').join(',');
      const organizationRows = db.prepare(`
        SELECT
          membership.user_id,
          organization.id,
          organization.code,
          organization.name,
          membership.role_code,
          membership.status,
          membership.created_at,
          membership.revoked_at
        FROM organization_memberships membership
        JOIN organizations organization ON organization.id=membership.org_id
        WHERE membership.user_id IN (${placeholders})
        ORDER BY membership.user_id,organization.id
      `).all(...userIds);
      for (const membership of organizationRows) {
        const organization = {
          id: membership.id,
          code: membership.code,
          name: membership.name,
          role_code: membership.role_code,
          status: membership.status,
          created_at: membership.created_at,
          revoked_at: membership.revoked_at,
          teams: []
        };
        organizationsByUser.get(membership.user_id).push(organization);
        organizationByUserAndId.set(`${membership.user_id}:${membership.id}`, organization);
      }

      const teamRows = db.prepare(`
        SELECT
          membership.user_id,
          membership.org_id,
          team.id,
          team.code,
          team.name,
          membership.role_code,
          membership.status,
          membership.created_at,
          membership.revoked_at
        FROM team_memberships membership
        JOIN teams team
          ON team.org_id=membership.org_id
         AND team.id=membership.team_id
        WHERE membership.user_id IN (${placeholders})
        ORDER BY membership.user_id,membership.org_id,team.id
      `).all(...userIds);
      for (const membership of teamRows) {
        const organization = organizationByUserAndId.get(
          `${membership.user_id}:${membership.org_id}`
        );
        if (!organization) continue;
        organization.teams.push({
          id: membership.id,
          code: membership.code,
          name: membership.name,
          role_code: membership.role_code,
          status: membership.status,
          created_at: membership.created_at,
          revoked_at: membership.revoked_at
        });
      }
    }

    const users = selectedRows.map((row) => {
      const organizations = organizationsByUser.get(row.id) || [];
      const accessRoles = [];
      if (row.role === 'admin') accessRoles.push('platform_admin');
      if (organizations.some((organization) => (
        organization.status === 'active' && organization.role_code === 'org_admin'
      ))) accessRoles.push('org_admin');
      if (organizations.some((organization) => (
        organization.status === 'active' && organization.teams.some((team) => (
          team.status === 'active' && team.role_code === 'team_lead'
        ))
      ))) accessRoles.push('team_lead');
      if (organizations.some((organization) => (
        organization.status === 'active' && (
          organization.role_code === 'member' || organization.teams.some((team) => (
            team.status === 'active' && team.role_code === 'member'
          ))
        )
      ))) accessRoles.push('member');
      return {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        role: row.role,
        department: row.department,
        email: row.email,
        api_quota: row.api_quota,
        created_at: row.created_at,
        last_login: row.last_login,
        is_active: row.is_active,
        access_roles: accessRoles,
        organizations
      };
    });
    const nextCursor = hasMore ? users[users.length - 1].id : null;
    const organizationIds = Array.from(new Set(users.flatMap((user) => (
      user.organizations.map((organization) => organization.id)
    )))).sort((left, right) => left - right);
    persistReadAudit(db, {
      actorUserId,
      action: 'admin_list_users',
      requestId: options && options.requestId,
      ipAddress: options && options.ipAddress,
      filterNames: names,
      organizationIds,
      userIds,
      resultCount: users.length,
      nextCursor
    });
    return {
      users,
      page: { limit, next_cursor: nextCursor, has_more: hasMore }
    };
  }).immediate();
}

function listOrganizations(db, options) {
  const query = readQuery(options);
  const q = boundedQuery(query.q);
  const limit = boundedLimit(query.limit);
  const cursor = optionalPositiveInteger(query.cursor, 'cursor');
  const names = filterNames(query, ['q', 'limit', 'cursor']);

  return db.transaction(() => {
    const actorUserId = assertPlatformAdmin(db, options && options.actor);
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
          instr(lower(organization.name),lower(?))>0 OR
          EXISTS (
            SELECT 1
            FROM organization_memberships membership
            JOIN users user ON user.id=membership.user_id
            WHERE membership.org_id=organization.id
              AND (
                instr(lower(user.username),lower(?))>0 OR
                instr(lower(user.display_name),lower(?))>0 OR
                instr(lower(COALESCE(user.department,'')),lower(?))>0
              )
          ) OR
          EXISTS (
            SELECT 1
            FROM teams team
            WHERE team.org_id=organization.id
              AND (
                instr(lower(team.code),lower(?))>0 OR
                instr(lower(team.name),lower(?))>0
              )
          )
        )
      ORDER BY organization.id
      LIMIT ?
    `).all(
      cursor, cursor,
      q, q, q,
      q, q, q,
      q, q,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const organizations = rows.slice(0, limit).map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      created_at: row.created_at,
      team_count: Number(row.team_count),
      active_member_count: Number(row.active_member_count),
      revoked_member_count: Number(row.revoked_member_count)
    }));
    const nextCursor = hasMore ? organizations[organizations.length - 1].id : null;
    persistReadAudit(db, {
      actorUserId,
      action: 'admin_list_organizations',
      requestId: options && options.requestId,
      ipAddress: options && options.ipAddress,
      filterNames: names,
      organizationIds: organizations.map((organization) => organization.id),
      resultCount: organizations.length,
      nextCursor
    });
    return {
      organizations,
      page: { limit, next_cursor: nextCursor, has_more: hasMore }
    };
  }).immediate();
}

function listOrganizationMembers(db, options) {
  const organizationId = positiveInteger(options && options.organizationId, 'organizationId');
  const query = readQuery(options);
  const q = boundedQuery(query.q);
  const status = memberStatus(query.status);
  const limit = boundedLimit(query.limit);
  const cursor = optionalPositiveInteger(query.cursor, 'cursor');
  const names = filterNames(query, ['q', 'status', 'limit', 'cursor']);

  return db.transaction(() => {
    const actorUserId = assertPlatformAdmin(db, options && options.actor);
    const organization = db.prepare(`
      SELECT id,code,name,created_at
      FROM organizations
      WHERE id=?
    `).get(organizationId);
    if (!organization) {
      throw serviceError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found.');
    }
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
        membership.created_at AS membership_created_at,
        membership.revoked_at AS membership_revoked_at
      FROM organization_memberships membership
      JOIN users user ON user.id=membership.user_id
      WHERE membership.org_id=?
        AND (? IS NULL OR membership.user_id>?)
        AND (?='' OR membership.status=?)
        AND (
          ?='' OR
          instr(lower(user.username),lower(?))>0 OR
          instr(lower(user.display_name),lower(?))>0 OR
          instr(lower(COALESCE(user.department,'')),lower(?))>0 OR
          instr(lower(COALESCE(user.role,'')),lower(?))>0 OR
          instr(lower(membership.role_code),lower(?))>0 OR
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
      ORDER BY membership.user_id
      LIMIT ?
    `).all(
      organizationId,
      cursor, cursor,
      status, status,
      q, q, q, q, q, q,
      q, q, q,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const selectedRows = rows.slice(0, limit);
    const userIds = selectedRows.map((row) => row.user_id);
    const teamsByUser = new Map(userIds.map((userId) => [userId, []]));
    if (userIds.length) {
      const placeholders = userIds.map(() => '?').join(',');
      const teamRows = db.prepare(`
        SELECT
          membership.user_id,
          team.id,
          team.code,
          team.name,
          membership.role_code,
          membership.status,
          membership.created_at,
          membership.revoked_at
        FROM team_memberships membership
        JOIN teams team
          ON team.org_id=membership.org_id
         AND team.id=membership.team_id
        WHERE membership.org_id=?
          AND membership.user_id IN (${placeholders})
        ORDER BY membership.user_id,team.id
      `).all(organizationId, ...userIds);
      for (const team of teamRows) {
        teamsByUser.get(team.user_id).push({
          id: team.id,
          code: team.code,
          name: team.name,
          role_code: team.role_code,
          status: team.status,
          created_at: team.created_at,
          revoked_at: team.revoked_at
        });
      }
    }
    const members = selectedRows.map((row) => ({
      user_id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      department: row.department,
      platform_role: row.platform_role,
      is_active: row.is_active,
      organization_role: row.organization_role,
      membership_status: row.membership_status,
      membership_created_at: row.membership_created_at,
      membership_revoked_at: row.membership_revoked_at,
      teams: teamsByUser.get(row.user_id) || []
    }));
    const nextCursor = hasMore ? members[members.length - 1].user_id : null;
    persistReadAudit(db, {
      actorUserId,
      action: 'admin_list_organization_members',
      requestId: options && options.requestId,
      ipAddress: options && options.ipAddress,
      filterNames: names,
      organizationIds: [organizationId],
      userIds,
      resultCount: members.length,
      nextCursor
    });
    return {
      organization,
      members,
      page: { limit, next_cursor: nextCursor, has_more: hasMore }
    };
  }).immediate();
}

function createAdminTenantDirectoryService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }
  return Object.freeze({
    listUsers(options) {
      return listUsers(db, options || {});
    },
    listOrganizations(options) {
      return listOrganizations(db, options || {});
    },
    listOrganizationMembers(options) {
      return listOrganizationMembers(db, options || {});
    }
  });
}

module.exports = {
  AdminTenantDirectoryServiceError,
  createAdminTenantDirectoryService
};
