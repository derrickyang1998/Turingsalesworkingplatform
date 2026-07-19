const { createHash } = require('node:crypto');
const { types: utilTypes } = require('node:util');
const crmAccess = require('./crm_access_service');

const DEFAULT_ORGANIZATION_CODE = 'turingmarket-default';
const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const IDENTITY_REASONS = new Set([
  'migration_backfill',
  'user_create',
  'admin_update',
  'soft_deactivate',
  'reactivate',
  'login_membership_repair'
]);
const IDENTITY_CHANGED_FIELDS = Object.freeze([
  'active',
  'department',
  'organization_membership',
  'role',
  'team_memberships'
]);

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

function isOpaqueCallable(value) {
  try {
    return Function.prototype.toString.call(value).includes('[native code]');
  } catch {
    return true;
  }
}

function canonicalId(value, label) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,15}$/.test(value)
  ) {
    const parsed = Number(value);
    if (
      Number.isSafeInteger(parsed) &&
      parsed > 0 &&
      parsed <= SAFE_MAX &&
      String(parsed) === value
    ) {
      return parsed;
    }
  }
  throw new TypeError((label || 'id') + ' must be a positive canonical safe integer');
}

function readDefaultOrganization(db) {
  const rows = db.prepare(`
    SELECT id,code,name
    FROM organizations
    WHERE code=?
  `).all(DEFAULT_ORGANIZATION_CODE);
  if (rows.length !== 1) {
    throw new Error('default organization resolution failed');
  }
  return rows[0];
}

function normalizedDepartment(value) {
  const exact = value === null || value === undefined
    ? ''
    : String(value).normalize('NFC');
  const display = exact
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (display.length === 0) {
    return {
      code: 'legacy-unassigned',
      name: '未分组',
      normalized: ''
    };
  }
  const hash = createHash('sha256').update(Buffer.from(exact, 'utf8')).digest('hex');
  const codePoints = Array.from(display);
  const name = codePoints.length <= 160
    ? display
    : codePoints.slice(0, 136).join('') + '... [' + hash.slice(0, 16) + ']';
  return {
    code: 'legacy-dept-' + hash,
    name,
    normalized: exact
  };
}

function platformRole(user) {
  return user && user.role === 'admin' ? 'platform_admin' : 'member';
}

function organizationRole(user) {
  return user && user.role === 'admin' ? 'org_admin' : 'member';
}

function teamRole(user) {
  return user && user.role === 'admin' ? 'team_lead' : 'member';
}

function ensureDepartmentTeam(db, organizationId, department) {
  const mapped = normalizedDepartment(department);
  const existing = db.prepare(`
    SELECT id,code,name
    FROM teams
    WHERE org_id=? AND code=?
  `).get(organizationId, mapped.code);
  if (existing) {
    if (existing.name !== mapped.name) {
      throw new Error('department hash collision');
    }
    return existing;
  }
  const result = db.prepare(`
    INSERT INTO teams (org_id,code,name)
    VALUES (?,?,?)
  `).run(organizationId, mapped.code, mapped.name);
  return {
    id: Number(result.lastInsertRowid),
    code: mapped.code,
    name: mapped.name
  };
}

function readUser(db, userId) {
  return db.prepare(`
    SELECT id,role,department,is_active
    FROM users
    WHERE id=?
  `).get(userId);
}

function projectIdentityState(db, userIdValue) {
  const userId = canonicalId(userIdValue, 'subjectUserId');
  const user = readUser(db, userId);
  if (!user) return null;
  const organization = readDefaultOrganization(db);
  const department = normalizedDepartment(user.department);
  const membership = db.prepare(`
    SELECT role_code,status
    FROM organization_memberships
    WHERE org_id=? AND user_id=?
  `).get(organization.id, userId);
  const memberships = db.prepare(`
    SELECT membership.team_id,membership.role_code,membership.status,team.code
    FROM team_memberships membership
    JOIN teams team
      ON team.org_id=membership.org_id
     AND team.id=membership.team_id
    WHERE membership.org_id=?
      AND membership.user_id=?
      AND (
        membership.status='active'
        OR team.code=?
      )
    ORDER BY membership.team_id
  `).all(organization.id, userId, department.code);
  return {
    user: {
      platform_role: platformRole(user),
      department_code: department.code,
      is_active: user.is_active === 1 ? 1 : 0
    },
    organization_membership: membership
      ? {
          role_code: membership.role_code,
          status: membership.status
        }
      : null,
    team_memberships: memberships.map((row) => ({
      team_id: row.team_id,
      role_code: row.role_code,
      status: row.status
    }))
  };
}

function projectGlobalMembershipState(db, userIdValue) {
  const userId = canonicalId(userIdValue, 'subjectUserId');
  return {
    organizations: db.prepare(`
      SELECT org_id,role_code,status
      FROM organization_memberships
      WHERE user_id=?
      ORDER BY org_id
    `).all(userId),
    teams: db.prepare(`
      SELECT org_id,team_id,role_code,status
      FROM team_memberships
      WHERE user_id=?
      ORDER BY org_id,team_id
    `).all(userId)
  };
}

function canonicalTimestamp(db) {
  return db.prepare(
    "SELECT strftime('%Y-%m-%d %H:%M:%S','now') AS value"
  ).get().value;
}

function synchronizeMembershipRows(db, user, previousUser, reason) {
  const organization = readDefaultOrganization(db);
  const now = canonicalTimestamp(db);
  const active = user.is_active === 1;
  const previouslyActive = Boolean(
    previousUser && previousUser.is_active === 1
  );
  const orgRole = organizationRole(user);
  const memberRole = teamRole(user);

  db.prepare(`
    UPDATE organization_memberships
    SET role_code=?
    WHERE org_id=? AND user_id=?
  `).run(orgRole, organization.id, user.id);
  db.prepare(`
    UPDATE team_memberships
    SET role_code=?
    WHERE org_id=? AND user_id=?
  `).run(memberRole, organization.id, user.id);

  if (!active) {
    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',
        revoked_at=CASE WHEN status='active' THEN ? ELSE revoked_at END
      WHERE user_id=?
    `).run(now, user.id);
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',
        revoked_at=CASE WHEN status='active' THEN ? ELSE revoked_at END
      WHERE user_id=?
    `).run(now, user.id);
    return organization;
  }

  const membership = db.prepare(`
    SELECT status
    FROM organization_memberships
    WHERE org_id=? AND user_id=?
  `).get(organization.id, user.id);
  const creating = previousUser === undefined;
  const repairing = reason === 'login_membership_repair';
  const reactivating = (
    reason === 'reactivate' &&
    previousUser !== undefined &&
    !previouslyActive
  );
  const shouldActivateExistingOrganization = creating || reactivating;
  const shouldInsertOrganization = (
    !membership &&
    (creating || repairing || reactivating)
  );
  if (membership && shouldActivateExistingOrganization) {
    db.prepare(`
      UPDATE organization_memberships
      SET role_code=?,status='active',revoked_at=NULL
      WHERE org_id=? AND user_id=?
    `).run(orgRole, organization.id, user.id);
  } else if (shouldInsertOrganization) {
    db.prepare(`
      INSERT INTO organization_memberships (
        org_id,user_id,role_code,status,revoked_at
      ) VALUES (?,? ,?,'active',NULL)
    `).run(organization.id, user.id, orgRole);
  }
  const organizationActive = membership
    ? (
        membership.status === 'active' ||
        shouldActivateExistingOrganization
      )
    : shouldInsertOrganization;

  const previousDepartment = previousUser
    ? normalizedDepartment(previousUser.department)
    : null;
  const currentDepartment = normalizedDepartment(user.department);
  const departmentChanged = Boolean(
    previousDepartment &&
    previousDepartment.code !== currentDepartment.code
  );
  const shouldProjectTeam = (
    creating ||
    repairing ||
    reactivating ||
    departmentChanged
  );
  if (!shouldProjectTeam || !organizationActive) {
    return organization;
  }

  const team = ensureDepartmentTeam(db, organization.id, user.department);
  if (departmentChanged) {
    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at=?
      WHERE org_id=?
        AND user_id=?
        AND status='active'
        AND team_id=(
          SELECT id
          FROM teams
          WHERE org_id=? AND code=?
        )
    `).run(
      now,
      organization.id,
      user.id,
      organization.id,
      previousDepartment.code
    );
  }
  const teamMembership = db.prepare(`
    SELECT status
    FROM team_memberships
    WHERE org_id=? AND team_id=? AND user_id=?
  `).get(organization.id, team.id, user.id);
  if (teamMembership && (creating || reactivating)) {
    db.prepare(`
      UPDATE team_memberships
      SET role_code=?,status='active',revoked_at=NULL
      WHERE org_id=? AND team_id=? AND user_id=?
    `).run(memberRole, organization.id, team.id, user.id);
  } else if (!teamMembership) {
    db.prepare(`
      INSERT INTO team_memberships (
        org_id,team_id,user_id,role_code,status,revoked_at
      ) VALUES (?,?,?,?,'active',NULL)
    `).run(organization.id, team.id, user.id, memberRole);
  }
  return organization;
}

function sameProjection(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedFields(before, after, globalBefore, globalAfter) {
  if (before === null) return [...IDENTITY_CHANGED_FIELDS];
  const changed = [];
  if (before.user.is_active !== after.user.is_active) changed.push('active');
  if (before.user.department_code !== after.user.department_code) {
    changed.push('department');
  }
  if (!sameProjection(
    before.organization_membership,
    after.organization_membership
  )) {
    changed.push('organization_membership');
  }
  if (before.user.platform_role !== after.user.platform_role) changed.push('role');
  if (!sameProjection(before.team_memberships, after.team_memberships)) {
    changed.push('team_memberships');
  }
  if (
    globalBefore &&
    globalAfter &&
    !sameProjection(globalBefore.organizations, globalAfter.organizations) &&
    !changed.includes('organization_membership')
  ) {
    changed.push('organization_membership');
  }
  if (
    globalBefore &&
    globalAfter &&
    !sameProjection(globalBefore.teams, globalAfter.teams) &&
    !changed.includes('team_memberships')
  ) {
    changed.push('team_memberships');
  }
  return changed.sort();
}

function summarizedMembershipRows(rows) {
  return {
    summary_version: 1,
    total_count: rows.length,
    active_count: rows.filter(
      (membership) => membership.status === 'active'
    ).length,
    revoked_count: rows.filter(
      (membership) => membership.status === 'revoked'
    ).length,
    sha256: createHash('sha256')
      .update(JSON.stringify(rows))
      .digest('hex')
  };
}

function summarizedIdentityProjection(projection, globalMemberships = null) {
  if (projection === null) return null;
  if (globalMemberships) {
    return {
      user: projection.user,
      organization_membership: {
        default_membership: projection.organization_membership,
        ...summarizedMembershipRows(globalMemberships.organizations)
      },
      team_memberships: summarizedMembershipRows(globalMemberships.teams)
    };
  }
  return {
    user: projection.user,
    organization_membership: projection.organization_membership,
    team_memberships: summarizedMembershipRows(projection.team_memberships)
  };
}

function hasHiddenGlobalMembershipChange({
  organizationId,
  globalBefore,
  globalAfter
}) {
  const nonDefault = (memberships) => memberships.filter(
    (membership) => membership.org_id !== organizationId
  );
  if (!sameProjection(
    nonDefault(globalBefore.organizations),
    nonDefault(globalAfter.organizations)
  )) {
    return true;
  }
  return !sameProjection(
    nonDefault(globalBefore.teams),
    nonDefault(globalAfter.teams)
  );
}

function validateAuditInput({
  actorUserId,
  subjectUserId,
  organizationId,
  reason,
  requestId,
  before,
  after,
  globalBefore,
  globalAfter
}) {
  const actor = actorUserId === null
    ? null
    : canonicalId(actorUserId, 'actorUserId');
  const subject = canonicalId(subjectUserId, 'subjectUserId');
  const organization = canonicalId(organizationId, 'organizationId');
  if (!IDENTITY_REASONS.has(reason)) {
    throw new TypeError('unsupported identity reason');
  }
  if (
    requestId !== null &&
    (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 120)
  ) {
    throw new TypeError('requestId must be null or a bounded string');
  }
  const fields = changedFields(before, after, globalBefore, globalAfter);
  const requiresGlobalSummary = hasHiddenGlobalMembershipChange({
    organizationId: organization,
    globalBefore,
    globalAfter
  });
  let details = {
    schema_version: 1,
    actor_user_id: actor,
    subject_user_id: subject,
    organization_id: organization,
    reason,
    request_id: requestId,
    changed_fields: fields,
    before: requiresGlobalSummary
      ? summarizedIdentityProjection(before, globalBefore)
      : before,
    after: requiresGlobalSummary
      ? summarizedIdentityProjection(after, globalAfter)
      : after
  };
  let detailsJson = JSON.stringify(details);
  if (Buffer.byteLength(detailsJson, 'utf8') > 4096) {
    details = {
      ...details,
      before: requiresGlobalSummary
        ? details.before
        : summarizedIdentityProjection(before),
      after: requiresGlobalSummary
        ? details.after
        : summarizedIdentityProjection(after)
    };
    detailsJson = JSON.stringify(details);
    if (Buffer.byteLength(detailsJson, 'utf8') > 4096) {
      throw new Error('identity audit details exceed limit');
    }
  }
  return { actor, subject, details, detailsJson, fields };
}

function runIdentityProjectionTransaction(db, options) {
  const input = snapshotPlainOptions(options, [
    'actorUserId',
    'subjectUserId',
    'reason',
    'requestId',
    'mutateUser'
  ]);
  const {
    actorUserId,
    subjectUserId: rawSubjectUserId,
    reason,
    requestId = null,
    mutateUser
  } = input || {};
  const subjectUserId = canonicalId(rawSubjectUserId, 'subjectUserId');
  if (
    typeof mutateUser !== 'function' ||
    utilTypes.isProxy(mutateUser)
  ) {
    throw new TypeError('mutateUser must be a function');
  }
  if (
    utilTypes.isAsyncFunction(mutateUser) ||
    isOpaqueCallable(mutateUser)
  ) {
    throw new TypeError('mutateUser must be synchronous');
  }

  const operation = () => {
    const previousUser = readUser(db, subjectUserId);
    const before = projectIdentityState(db, subjectUserId);
    const globalBefore = projectGlobalMembershipState(db, subjectUserId);
    const mutationResult = mutateUser();
    if (mutationResult !== undefined) {
      throw new TypeError('mutateUser must return undefined');
    }
    const user = readUser(db, subjectUserId);
    if (!user) throw new Error('identity subject was not created');
    const organization = synchronizeMembershipRows(
      db,
      user,
      previousUser,
      reason
    );
    const after = projectIdentityState(db, subjectUserId);
    const globalAfter = projectGlobalMembershipState(db, subjectUserId);
    const auditInput = validateAuditInput({
      actorUserId,
      subjectUserId,
      organizationId: organization.id,
      reason,
      requestId,
      before,
      after,
      globalBefore,
      globalAfter
    });
    if (auditInput.fields.length === 0) {
      return {
        changed: false,
        before,
        after,
        audit: null
      };
    }
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(subjectUserId);
    const activityActor = auditInput.actor === null
      ? subjectUserId
      : auditInput.actor;
    db.prepare(`
      INSERT INTO activity_log (
        user_id,action,module,details,ip_address
      ) VALUES (
        ?,'identity_state_changed','identity',?,NULL
      )
    `).run(activityActor, auditInput.detailsJson);
    return {
      changed: true,
      before,
      after,
      audit: {
        action: 'identity_state_changed',
        module: 'identity',
        details: auditInput.detailsJson
      }
    };
  };

  return db.transaction(operation).immediate();
}

function authContextFor(db, organization, userId) {
  const membership = db.prepare(`
    SELECT role_code,status
    FROM organization_memberships
    WHERE org_id=? AND user_id=?
  `).get(organization.id, userId);
  if (!membership || membership.status !== 'active') return null;
  const teams = db.prepare(`
    SELECT team.id,team.code,team.name,membership.role_code
    FROM team_memberships membership
    JOIN teams team
      ON team.org_id=membership.org_id
     AND team.id=membership.team_id
    WHERE membership.org_id=?
      AND membership.user_id=?
      AND membership.status='active'
    ORDER BY team.id
  `).all(organization.id, userId);
  if (teams.length === 0) return null;
  return {
    organization: {
      id: organization.id,
      code: organization.code,
      name: organization.name,
      role_code: membership.role_code
    },
    teams: teams.map((team) => ({
      id: team.id,
      code: team.code,
      name: team.name,
      role_code: team.role_code
    }))
  };
}

function resolveOrganizationScope(db, options) {
  const input = snapshotPlainOptions(options, [
    'userId',
    'repairMissing',
    'actorUserId',
    'requestId'
  ]);
  const {
    userId: rawUserId,
    repairMissing = false,
    actorUserId = rawUserId,
    requestId = null
  } = input || {};
  if (typeof repairMissing !== 'boolean') {
    throw new TypeError('repairMissing must be a boolean');
  }
  const userId = canonicalId(rawUserId, 'userId');
  const user = readUser(db, userId);
  if (!user || user.is_active !== 1) {
    return {
      ok: false,
      kind: 'inactive_user',
      code: 'USER_INACTIVE'
    };
  }
  const organization = readDefaultOrganization(db);
  const membership = db.prepare(`
    SELECT role_code,status
    FROM organization_memberships
    WHERE org_id=? AND user_id=?
  `).get(organization.id, userId);
  if (membership && membership.status !== 'active') {
    return {
      ok: false,
      kind: 'inactive_membership',
      code: 'ORGANIZATION_MEMBERSHIP_INACTIVE'
    };
  }

  let repaired = false;
  if (!membership) {
    if (!repairMissing) {
      return {
        ok: false,
        kind: 'missing_membership',
        code: 'ORGANIZATION_MEMBERSHIP_MISSING'
      };
    }
    runIdentityProjectionTransaction(db, {
      actorUserId,
      subjectUserId: userId,
      reason: 'login_membership_repair',
      requestId,
      mutateUser() {}
    });
    repaired = true;
  }
  const authContext = authContextFor(db, organization, userId);
  if (!authContext) {
    return {
      ok: false,
      kind: 'inactive_membership',
      code: 'ORGANIZATION_MEMBERSHIP_INACTIVE'
    };
  }
  return {
    ok: true,
    repaired,
    authContext
  };
}

function assignmentFailure() {
  return {
    allowed: false,
    code: 'CAMPAIGN_ASSIGNMENT_FORBIDDEN'
  };
}

function getAssignmentDecision(db, options) {
  const input = snapshotPlainOptions(options, [
    'actorUserId',
    'ownerUserId',
    'teamId',
    'campaignId',
    'mode'
  ]);
  if (input === null) return assignmentFailure();
  const {
    actorUserId: rawActorUserId,
    ownerUserId: rawOwnerUserId,
    teamId: rawTeamId,
    campaignId: rawCampaignId,
    mode = 'create'
  } = input;
  if (mode !== 'create' && mode !== 'transfer') {
    throw new TypeError('unsupported assignment mode');
  }
  let actorUserId;
  let ownerUserId;
  let teamId;
  try {
    actorUserId = canonicalId(rawActorUserId, 'actorUserId');
    ownerUserId = canonicalId(rawOwnerUserId, 'ownerUserId');
    teamId = canonicalId(rawTeamId, 'teamId');
  } catch {
    return assignmentFailure();
  }
  const scope = resolveOrganizationScope(db, {
    userId: actorUserId,
    repairMissing: false
  });
  if (!scope.ok) return assignmentFailure();
  const orgId = scope.authContext.organization.id;
  const pair = db.prepare(`
    SELECT membership.role_code
    FROM team_memberships membership
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=membership.org_id
     AND organization_membership.user_id=membership.user_id
    JOIN users owner ON owner.id=membership.user_id
    WHERE membership.org_id=?
      AND membership.team_id=?
      AND membership.user_id=?
      AND membership.status='active'
      AND organization_membership.status='active'
      AND typeof(owner.is_active)='integer'
      AND owner.is_active=1
  `).get(orgId, teamId, ownerUserId);
  if (!pair) return assignmentFailure();

  let campaign = null;
  if (mode === 'transfer') {
    let campaignId;
    try {
      campaignId = canonicalId(rawCampaignId, 'campaignId');
    } catch {
      return assignmentFailure();
    }
    campaign = db.prepare(`
      SELECT id,org_id,owner_user_id,team_id
      FROM campaigns
      WHERE id=? AND org_id=?
    `).get(campaignId, orgId);
    if (
      !campaign ||
      campaign.org_id !== orgId ||
      !Number.isSafeInteger(campaign.owner_user_id) ||
      campaign.owner_user_id < 1 ||
      !Number.isSafeInteger(campaign.team_id) ||
      campaign.team_id < 1
    ) {
      return assignmentFailure();
    }
  }

  const organizationRoleCode = scope.authContext.organization.role_code;
  if (organizationRoleCode === 'org_admin') {
    return {
      allowed: true,
      actorKind: 'org_admin',
      orgId,
      ownerUserId,
      teamId
    };
  }
  const actorTeam = scope.authContext.teams.find((team) => team.id === teamId);
  if (!actorTeam) return assignmentFailure();

  if (mode === 'transfer') {
    if (campaign.owner_user_id !== actorUserId) {
      return assignmentFailure();
    }
    return {
      allowed: true,
      actorKind: 'owner',
      orgId,
      ownerUserId,
      teamId
    };
  }

  if (actorTeam.role_code === 'team_lead') {
    return {
      allowed: true,
      actorKind: 'team_lead',
      orgId,
      ownerUserId,
      teamId
    };
  }
  if (ownerUserId !== actorUserId) return assignmentFailure();
  return {
    allowed: true,
    actorKind: 'self',
    orgId,
    ownerUserId,
    teamId
  };
}

function getCampaignCreationDecision(db, options) {
  const input = snapshotPlainOptions(options, [
    'actorUserId',
    'opportunityId',
    'ownerUserId',
    'teamId'
  ]);
  if (input === null) return assignmentFailure();
  const assignment = getAssignmentDecision(db, {
    actorUserId: input.actorUserId,
    ownerUserId: input.ownerUserId,
    teamId: input.teamId,
    mode: 'create'
  });
  if (!assignment.allowed) return assignment;
  let opportunityId;
  try {
    opportunityId = canonicalId(input.opportunityId, 'opportunityId');
  } catch {
    return {
      allowed: false,
      code: 'CRM_MANAGE_REQUIRED'
    };
  }
  const opportunity = crmAccess.getOpportunityWithCustomer(db, opportunityId);
  if (!opportunity) {
    return {
      allowed: false,
      code: 'CRM_MANAGE_REQUIRED'
    };
  }
  const actor = db.prepare(`
    SELECT id,role
    FROM users
    WHERE id=?
      AND typeof(is_active)='integer'
      AND is_active=1
  `).get(input.actorUserId);
  if (!actor || !crmAccess.canManageOpportunity(actor, opportunity)) {
    return {
      allowed: false,
      code: 'CRM_MANAGE_REQUIRED'
    };
  }
  return {
    ...assignment,
    opportunityId: opportunity.id,
    customerId: opportunity.customer_id
  };
}

module.exports = {
  DEFAULT_ORGANIZATION_CODE,
  resolveOrganizationScope,
  getAssignmentDecision,
  getCampaignCreationDecision,
  projectIdentityState,
  runIdentityProjectionTransaction
};
