'use strict';

const { randomBytes } = require('node:crypto');
const crmAccess = require('./crm_access_service');
const idempotency = require('./idempotency_service');
const knowledgeService = require('./knowledge_service');
const {
  requestHash
} = require('./sqlite_digest_service');
const {
  getCampaignAccess,
  getTargetAccess,
  resolveRecordCustody,
  buildCollectionAccessPredicate,
  projectKnowledgeVisibility,
  projectKnowledgeSource
} = require('./campaign_access_service');
const {
  getAssignmentDecision,
  getCampaignCreationDecision,
  resolveOrganizationScope
} = require('./organization_access_service');

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const CREATE_FIELDS = Object.freeze([
  'name',
  'opportunity_id',
  'owner_user_id',
  'team_id',
  'product_name',
  'region',
  'currency',
  'budget_minor',
  'start_date',
  'end_date'
]);
const LIFECYCLE_STATES = Object.freeze([
  'lead',
  'qualified',
  'demand_confirmed',
  'proposal_draft',
  'proposal_confirmed',
  'influencer_shortlist',
  'ordered',
  'executing',
  'published',
  'settled',
  'reviewed'
]);
const OPERATIONAL_STATUSES = Object.freeze(['active', 'on_hold', 'cancelled']);
const NONTERMINAL_COLLABORATION_STATUSES = Object.freeze([
  'proposed',
  'contacted',
  'negotiating',
  'confirmed',
  'contract_sent',
  'live',
  'content_review'
]);
const NONTERMINAL_COLLABORATION_SQL =
  NONTERMINAL_COLLABORATION_STATUSES.map(() => '?').join(',');
const WORKSPACE_PAGE_LIMIT = 50;
const WORKSPACE_PAGE_MAX = 100;
const UPDATE_FIELDS = Object.freeze([
  'name',
  'product_name',
  'region',
  'currency',
  'budget_minor',
  'start_date',
  'end_date',
  'expected_version'
]);

class CampaignServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'CampaignServiceError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invalidInput(message = 'Invalid campaign input.') {
  return new CampaignServiceError(400, 'INVALID_CAMPAIGN_INPUT', message);
}

function canonicalId(value) {
  if (Number.isSafeInteger(value) && value > 0 && value <= SAFE_MAX) return value;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value
    ? parsed
    : null;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw invalidInput(`${label} is invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidInput(`${label} is invalid.`);
  }
  return parsed;
}

function boundedQuery(value, maximum, label) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || Array.from(value).length > maximum) {
    throw invalidInput(`${label} is invalid.`);
  }
  return value.trim();
}

function assertQueryKeys(query, allowed) {
  const unknown = Object.keys(query || {}).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw invalidInput('Unknown campaign query field.');
}

function plainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertBodyKeys(body, allowed, required) {
  if (!plainObject(body)) throw invalidInput('Campaign body must be an object.');
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.includes(key))) {
    throw invalidInput('Unknown campaign input field.');
  }
  if (required.some((key) => !Object.hasOwn(body, key))) {
    throw invalidInput('Required campaign input is missing.');
  }
}

function scalarText(value, label, minimum, maximum, nullable = false) {
  if (value === undefined && nullable) return null;
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw invalidInput(`${label} is invalid.`);
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  const length = Array.from(normalized).length;
  if (length < minimum || length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw invalidInput(`${label} is invalid.`);
  }
  return normalized;
}

function bodyId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > SAFE_MAX) {
    throw invalidInput(`${label} is invalid.`);
  }
  return value;
}

function optionalSafeInteger(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > SAFE_MAX) {
    throw invalidInput(`${label} is invalid.`);
  }
  return value;
}

function dateValue(value, label) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    throw invalidInput(`${label} is invalid.`);
  }
  const canonical = new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10);
  if (canonical !== value) throw invalidInput(`${label} is invalid.`);
  return value;
}

function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new CampaignServiceError(
      400,
      'IDEMPOTENCY_REQUIRED',
      'A valid Idempotency-Key is required.'
    );
  }
  return value;
}

function normalizeCreateBody(body) {
  assertBodyKeys(body, CREATE_FIELDS, [
    'name',
    'opportunity_id',
    'owner_user_id',
    'team_id'
  ]);
  const normalized = {
    name: scalarText(body.name, 'name', 1, 160),
    opportunity_id: bodyId(body.opportunity_id, 'opportunity_id'),
    owner_user_id: bodyId(body.owner_user_id, 'owner_user_id'),
    team_id: bodyId(body.team_id, 'team_id')
  };
  for (const [key, maximum] of [['product_name', 160], ['region', 120]]) {
    if (Object.hasOwn(body, key)) {
      normalized[key] = scalarText(body[key], key, 0, maximum, true);
    }
  }
  if (Object.hasOwn(body, 'currency')) {
    const currency = scalarText(body.currency, 'currency', 3, 3, true);
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
      throw invalidInput('currency is invalid.');
    }
    normalized.currency = currency;
  }
  if (Object.hasOwn(body, 'budget_minor')) {
    normalized.budget_minor = optionalSafeInteger(body.budget_minor, 'budget_minor');
  }
  if (Object.hasOwn(body, 'start_date')) {
    normalized.start_date = dateValue(body.start_date, 'start_date');
  }
  if (Object.hasOwn(body, 'end_date')) {
    normalized.end_date = dateValue(body.end_date, 'end_date');
  }
  if (
    normalized.start_date &&
    normalized.end_date &&
    normalized.end_date < normalized.start_date
  ) {
    throw invalidInput('Campaign date range is invalid.');
  }
  return normalized;
}

function readActor(db, userId) {
  return db.prepare(`
    SELECT id,username,display_name,role,department,is_active
    FROM users
    WHERE id=? AND is_active=1
  `).get(userId);
}

function creationAuthorization(db, userId, body) {
  const decision = getCampaignCreationDecision(db, {
    actorUserId: userId,
    opportunityId: body.opportunity_id,
    ownerUserId: body.owner_user_id,
    teamId: body.team_id
  });
  if (!decision.allowed) {
    const opportunity = crmAccess.getOpportunityWithCustomer(
      db,
      body.opportunity_id
    );
    if (!opportunity) {
      throw new CampaignServiceError(
        404,
        'RECORD_NOT_FOUND',
        'Opportunity was not found.'
      );
    }
    throw new CampaignServiceError(
      403,
      'RECORD_FORBIDDEN',
      'Campaign creation target is forbidden.'
    );
  }
  return decision;
}

function campaignProjection(db, campaignId) {
  const row = db.prepare(`
    SELECT
      campaign.id,campaign.name,campaign.customer_id,campaign.opportunity_id,
      campaign.owner_user_id,campaign.team_id,campaign.lifecycle_state,
      campaign.operational_status,campaign.row_version,campaign.product_name,
      campaign.region,campaign.currency,campaign.budget_minor,campaign.start_date,
      campaign.end_date,campaign.created_at,campaign.updated_at,
      customer.brand_name,customer.company_name,
      opportunity.name AS opportunity_name,
      owner.display_name AS owner_name,owner.username AS owner_username,
      team.name AS team_name
    FROM campaigns campaign
    LEFT JOIN customers customer ON customer.id=campaign.customer_id
    LEFT JOIN opportunities opportunity ON opportunity.id=campaign.opportunity_id
    LEFT JOIN users owner ON owner.id=campaign.owner_user_id
    LEFT JOIN teams team
      ON team.org_id=campaign.org_id AND team.id=campaign.team_id
    WHERE campaign.id=?
  `).get(campaignId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    customer: {
      id: row.customer_id,
      label: row.brand_name || row.company_name || `Customer #${row.customer_id}`
    },
    opportunity: {
      id: row.opportunity_id,
      label: row.opportunity_name || `Opportunity #${row.opportunity_id}`
    },
    owner: {
      id: row.owner_user_id,
      label: row.owner_name || row.owner_username || `User #${row.owner_user_id}`
    },
    team: {
      id: row.team_id,
      label: row.team_name || `Team #${row.team_id}`
    },
    lifecycle_state: row.lifecycle_state,
    operational_status: row.operational_status,
    row_version: row.row_version,
    product_name: row.product_name,
    region: row.region,
    currency: row.currency,
    budget_minor: row.budget_minor,
    start_date: row.start_date,
    end_date: row.end_date,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function idempotencyDisposition(result) {
  if (result.state === 'replay') {
    return {
      status: result.statusCode,
      body: result.responseBody,
      headers: result.responseHeaders || {}
    };
  }
  if (result.state === 'conflict') {
    throw new CampaignServiceError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'The idempotency key was already used for a different request.'
    );
  }
  if (result.state === 'processing') {
    const error = new CampaignServiceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'The idempotent request is still processing.'
    );
    error.retryAfterSeconds = Math.max(1, result.retryAfterSeconds || 1);
    throw error;
  }
  if (result.state === 'expired') {
    throw new CampaignServiceError(
      410,
      'IDEMPOTENCY_EXPIRED',
      'The retained idempotent response expired.'
    );
  }
  return null;
}

function requireCampaignAccess(db, userId, campaignId) {
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) {
    throw new CampaignServiceError(
      access.status,
      access.code,
      access.code === 'CAMPAIGN_NOT_FOUND'
        ? 'Campaign was not found.'
        : 'Campaign access is forbidden.'
    );
  }
  return access;
}

function campaignOperationalError(status) {
  return new CampaignServiceError(
    409,
    status === 'cancelled' ? 'CAMPAIGN_CANCELLED' : 'CAMPAIGN_ON_HOLD',
    status === 'cancelled' ? 'Campaign is cancelled.' : 'Campaign is on hold.',
    { operational_status: status }
  );
}

function errorBody(error, requestId) {
  const body = {
    error: error.message,
    code: error.code,
    request_id: requestId
  };
  if (error.details !== undefined) body.details = error.details;
  return body;
}

function runCampaignMutation(db, input, operation) {
  const campaignId = canonicalId(input.campaignId);
  const userId = bodyId(input.userId, 'user_id');
  if (campaignId === null) throw invalidInput('Campaign id is invalid.');
  const key = requireIdempotencyKey(input.idempotencyKey);
  const initialAccess = requireCampaignAccess(db, userId, campaignId);
  if (input.authorize) {
    input.authorize({ access: initialAccess, userId, campaignId });
  }
  const hash = requestHash({
    method: input.method,
    path: input.path,
    campaignId,
    kind: 'json',
    payload: input.body
  });
  const reservationInput = {
    organizationId: initialAccess.campaign.org_id,
    actorUserId: userId,
    campaignId,
    secondaryCampaignId: input.secondaryCampaignId ?? null,
    resourceClaim: null,
    scope: input.scope,
    key,
    requestHash: hash,
    expectedEventCount: input.expectedEventCount,
    operationTimeoutSeconds: 60
  };
  idempotency.inspectRetained(db, reservationInput);

  return db.transaction(() => {
    const access = requireCampaignAccess(db, userId, campaignId);
    if (input.authorize) {
      input.authorize({ access, userId, campaignId });
    }
    let reservation = idempotency.recoverExpiredInTransaction(
      db,
      reservationInput
    );
    if (reservation.state === 'absent') {
      reservation = idempotency.reserveProcessingInTransaction(
        db,
        reservationInput
      );
    }
    if (reservation.state !== 'reserved') {
      return idempotencyDisposition(reservation);
    }
    db.exec('SAVEPOINT campaign_business_operation');
    try {
      const outcome = operation({
        access,
        auditFingerprint: reservation.auditFingerprint,
        requestHash: hash,
        userId,
        campaignId
      });
      db.exec('RELEASE SAVEPOINT campaign_business_operation');
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: outcome.status,
        responseBody: outcome.body
      });
      return { status: outcome.status, body: outcome.body, headers: {} };
    } catch (error) {
      const retainedError = error instanceof knowledgeService.CampaignKnowledgeCapacityError
        ? new CampaignServiceError(
          error.statusCode,
          error.code,
          error.message,
          error.details
        )
        : error;
      if (!(retainedError instanceof CampaignServiceError)) throw error;
      db.exec('ROLLBACK TO SAVEPOINT campaign_business_operation');
      db.exec('RELEASE SAVEPOINT campaign_business_operation');
      const body = errorBody(retainedError, input.requestId);
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: retainedError.statusCode,
        responseBody: body
      });
      return { status: retainedError.statusCode, body, headers: {} };
    }
  }).immediate();
}

function finishCampaignCreation(db, {
  campaignId,
  userId,
  requestId,
  requestHash: hash,
  reservation
}) {
  const campaign = db.prepare(`
    SELECT
      org_id,customer_id,opportunity_id,owner_user_id,team_id,row_version
    FROM campaigns
    WHERE id=?
  `).get(campaignId);
  if (!campaign) throw new Error('Campaign creation target disappeared');
  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (
      @orgId,@campaignId,'campaign_created',NULL,'lead',@actorUserId,
      'Campaign created','campaign_api',@metadataJson,@requestId,@auditFingerprint
    )
  `).run({
    orgId: campaign.org_id,
    campaignId,
    actorUserId: userId,
    metadataJson: JSON.stringify({
      customer_id: campaign.customer_id,
      opportunity_id: campaign.opportunity_id,
      owner_user_id: campaign.owner_user_id,
      team_id: campaign.team_id,
      row_version: campaign.row_version
    }),
    requestId,
    auditFingerprint: reservation.auditFingerprint
  });
  const responseBody = { campaign: campaignProjection(db, campaignId) };
  idempotency.completeJsonInTransaction(db, {
    ledgerId: reservation.ledgerId,
    requestHash: hash,
    leaseToken: reservation.leaseToken,
    statusCode: 201,
    responseBody
  });
  return { status: 201, body: responseBody, headers: {} };
}

function createCampaign(db, input) {
  const body = normalizeCreateBody(input.body);
  const userId = bodyId(input.userId, 'user_id');
  const key = requireIdempotencyKey(input.idempotencyKey);
  const actor = readActor(db, userId);
  if (!actor) {
    throw new CampaignServiceError(403, 'CAMPAIGN_FORBIDDEN', 'Campaign access is forbidden.');
  }
  const decision = creationAuthorization(db, userId, body);
  const hash = requestHash({
    method: 'POST',
    path: '/api/campaigns',
    campaignId: null,
    kind: 'json',
    payload: body
  });
  const lookup = {
    organizationId: decision.orgId,
    actorUserId: userId,
    scope: 'campaign.create',
    key,
    requestHash: hash
  };

  return db.transaction(() => {
    const repeated = creationAuthorization(db, userId, body);
    const retainedIdentity = idempotency.inspectRetained(db, {
      ...lookup,
      organizationId: repeated.orgId
    });
    if (retainedIdentity.state !== 'absent') {
      const retainedAccess = requireCampaignAccess(
        db,
        userId,
        retainedIdentity.campaignId
      );
      const retainedTarget = creationAuthorization(db, userId, {
        opportunity_id: retainedAccess.campaign.opportunity_id,
        owner_user_id: retainedAccess.campaign.owner_user_id,
        team_id: retainedAccess.campaign.team_id
      });
      const retainedInput = {
        ...lookup,
        organizationId: retainedTarget.orgId,
        campaignId: retainedAccess.campaign.id,
        secondaryCampaignId: null,
        resourceClaim: null,
        expectedEventCount: 1,
        operationTimeoutSeconds: 60
      };
      const recovered = idempotency.recoverExpiredInTransaction(
        db,
        retainedInput
      );
      if (recovered.state === 'reserved') {
        return finishCampaignCreation(db, {
          campaignId: retainedAccess.campaign.id,
          userId,
          requestId: input.requestId,
          requestHash: hash,
          reservation: recovered
        });
      }
      if (recovered.state !== 'absent') {
        return idempotencyDisposition(recovered);
      }
    }

    const insert = db.prepare(`
      INSERT INTO campaigns (
        org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
        lifecycle_state,operational_status,row_version,product_name,region,
        currency,budget_minor,start_date,end_date
      ) VALUES (
        @orgId,@name,@customerId,@opportunityId,@ownerUserId,@teamId,
        'lead','active',1,@productName,@region,@currency,@budgetMinor,@startDate,@endDate
      )
    `).run({
      orgId: repeated.orgId,
      name: body.name,
      customerId: repeated.customerId,
      opportunityId: body.opportunity_id,
      ownerUserId: body.owner_user_id,
      teamId: body.team_id,
      productName: body.product_name ?? null,
      region: body.region ?? null,
      currency: body.currency ?? null,
      budgetMinor: body.budget_minor ?? null,
      startDate: body.start_date ?? null,
      endDate: body.end_date ?? null
    });
    const campaignId = Number(insert.lastInsertRowid);
    if (!Number.isSafeInteger(campaignId) || campaignId < 1) {
      throw new Error('Campaign identifier allocation failed');
    }
    const reservation = idempotency.reserveProcessingInTransaction(db, {
      organizationId: repeated.orgId,
      actorUserId: userId,
      campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'campaign.create',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    });
    if (reservation.state !== 'reserved') {
      throw new Error('Campaign creation reservation race was invalid');
    }
    return finishCampaignCreation(db, {
      campaignId,
      userId,
      requestId: input.requestId,
      requestHash: hash,
      reservation
    });
  }).immediate();
}

function listCampaigns(db, input) {
  const userId = bodyId(input.userId, 'user_id');
  const query = input.query || {};
  assertQueryKeys(query, [
    'q',
    'state',
    'operational_status',
    'owner_user_id',
    'team_id',
    'limit',
    'offset'
  ]);
  const limit = boundedInteger(query.limit, 25, 1, 100, 'limit');
  const offset = boundedInteger(query.offset, 0, 0, SAFE_MAX, 'offset');
  const q = boundedQuery(query.q, 160, 'q');
  if (query.state !== undefined && !LIFECYCLE_STATES.includes(query.state)) {
    throw invalidInput('state is invalid.');
  }
  if (
    query.operational_status !== undefined &&
    !OPERATIONAL_STATUSES.includes(query.operational_status)
  ) {
    throw invalidInput('operational_status is invalid.');
  }
  const ownerUserId = query.owner_user_id === undefined
    ? null
    : canonicalId(query.owner_user_id);
  const teamId = query.team_id === undefined ? null : canonicalId(query.team_id);
  if (query.owner_user_id !== undefined && ownerUserId === null) {
    throw invalidInput('owner_user_id is invalid.');
  }
  if (query.team_id !== undefined && teamId === null) {
    throw invalidInput('team_id is invalid.');
  }
  const access = buildCollectionAccessPredicate('campaigns', { userId });
  const where = [access.sql];
  const params = [...access.params];
  if (q) {
    where.push(`(
      instr(lower(campaign.name),lower(?))>0
      OR instr(lower(COALESCE(campaign.product_name,'')),lower(?))>0
      OR instr(lower(COALESCE(customer.brand_name,customer.company_name,'')),lower(?))>0
      OR instr(lower(COALESCE(opportunity.name,'')),lower(?))>0
    )`);
    params.push(q, q, q, q);
  }
  if (query.state !== undefined) {
    where.push('campaign.lifecycle_state=?');
    params.push(query.state);
  }
  if (query.operational_status !== undefined) {
    where.push('campaign.operational_status=?');
    params.push(query.operational_status);
  }
  if (ownerUserId !== null) {
    where.push('campaign.owner_user_id=?');
    params.push(ownerUserId);
  }
  if (teamId !== null) {
    where.push('campaign.team_id=?');
    params.push(teamId);
  }
  const from = `
    FROM campaigns campaign
    LEFT JOIN customers customer ON customer.id=campaign.customer_id
    LEFT JOIN opportunities opportunity ON opportunity.id=campaign.opportunity_id
  `;
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    ${from}
    WHERE ${where.join(' AND ')}
  `).get(...params).count;
  const ids = db.prepare(`
    SELECT campaign.id
    ${from}
    WHERE ${where.join(' AND ')}
    ORDER BY campaign.updated_at DESC,campaign.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return {
    items: ids.map((row) => campaignProjection(db, row.id)),
    total,
    limit,
    offset
  };
}

function getCampaignDetail(db, input) {
  const userId = bodyId(input.userId, 'user_id');
  const campaignId = canonicalId(input.campaignId);
  if (campaignId === null) throw invalidInput('Campaign id is invalid.');
  assertQueryKeys(input.query || {}, []);
  requireCampaignAccess(db, userId, campaignId);
  return { campaign: campaignProjection(db, campaignId) };
}

function normalizeUpdateBody(body) {
  assertBodyKeys(body, UPDATE_FIELDS, ['expected_version']);
  if (Object.keys(body).length === 1) {
    throw invalidInput('At least one campaign metadata field is required.');
  }
  const normalized = {
    expected_version: bodyId(body.expected_version, 'expected_version')
  };
  if (Object.hasOwn(body, 'name')) {
    normalized.name = scalarText(body.name, 'name', 1, 160);
  }
  for (const [key, maximum] of [['product_name', 160], ['region', 120]]) {
    if (Object.hasOwn(body, key)) {
      normalized[key] = scalarText(body[key], key, 0, maximum, true);
    }
  }
  if (Object.hasOwn(body, 'currency')) {
    const currency = scalarText(body.currency, 'currency', 3, 3, true);
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
      throw invalidInput('currency is invalid.');
    }
    normalized.currency = currency;
  }
  if (Object.hasOwn(body, 'budget_minor')) {
    normalized.budget_minor = optionalSafeInteger(body.budget_minor, 'budget_minor');
  }
  if (Object.hasOwn(body, 'start_date')) {
    normalized.start_date = dateValue(body.start_date, 'start_date');
  }
  if (Object.hasOwn(body, 'end_date')) {
    normalized.end_date = dateValue(body.end_date, 'end_date');
  }
  return normalized;
}

function updateCampaign(db, input) {
  const body = normalizeUpdateBody(input.body);
  return runCampaignMutation(db, {
    ...input,
    method: 'PATCH',
    path: `/api/campaigns/${input.campaignId}`,
    body,
    scope: 'campaign.update',
    expectedEventCount: 0
  }, ({ access, campaignId }) => {
    if (access.campaign.operational_status !== 'active') {
      throw campaignOperationalError(access.campaign.operational_status);
    }
    if (access.campaign.row_version !== body.expected_version) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_VERSION',
        'Campaign version is stale.',
        { current_version: access.campaign.row_version }
      );
    }
    if (access.campaign.row_version === SAFE_MAX) {
      throw new CampaignServiceError(
        409,
        'ROW_VERSION_EXHAUSTED',
        'Campaign version is exhausted.'
      );
    }
    const effectiveStartDate = Object.hasOwn(body, 'start_date')
      ? body.start_date
      : access.campaign.start_date;
    const effectiveEndDate = Object.hasOwn(body, 'end_date')
      ? body.end_date
      : access.campaign.end_date;
    if (
      effectiveStartDate &&
      effectiveEndDate &&
      effectiveEndDate < effectiveStartDate
    ) {
      throw invalidInput('Campaign date range is invalid.');
    }
    const updates = [];
    const params = { campaignId, expectedVersion: body.expected_version };
    for (const field of UPDATE_FIELDS) {
      if (field === 'expected_version' || !Object.hasOwn(body, field)) continue;
      updates.push(`${field}=@${field}`);
      params[field] = body[field];
    }
    const result = db.prepare(`
      UPDATE campaigns
      SET ${updates.join(',')},row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=@campaignId
        AND row_version=@expectedVersion
        AND operational_status='active'
    `).run(params);
    if (result.changes !== 1) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_VERSION',
        'Campaign version is stale.',
        { current_version: access.campaign.row_version }
      );
    }
    return {
      status: 200,
      body: { campaign: campaignProjection(db, campaignId) }
    };
  });
}

function eventProjectionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_type: row.event_type,
    previous_state: row.previous_state,
    next_state: row.next_state,
    actor: {
      id: row.actor_user_id,
      label: row.actor_name || row.actor_username || `User #${row.actor_user_id}`
    },
    reason: row.reason,
    source: row.source,
    metadata: JSON.parse(row.metadata_json),
    correlation_id: row.correlation_id,
    created_at: row.created_at
  };
}

function eventProjection(db, eventId) {
  const row = db.prepare(`
    SELECT event.*,actor.display_name AS actor_name,actor.username AS actor_username
    FROM campaign_events event
    LEFT JOIN users actor ON actor.id=event.actor_user_id
    WHERE event.id=?
  `).get(eventId);
  return eventProjectionFromRow(row);
}

function insertCampaignEvent(db, values) {
  const result = db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (
      @orgId,@campaignId,@eventType,@previousState,@nextState,@actorUserId,
      @reason,@source,@metadataJson,@correlationId,@auditFingerprint
    )
  `).run({
    ...values,
    metadataJson: JSON.stringify(values.metadata)
  });
  return eventProjection(db, Number(result.lastInsertRowid));
}

function normalizeTransitionBody(body) {
  assertBodyKeys(body, [
    'expected_state',
    'expected_version',
    'next_state',
    'reason'
  ], [
    'expected_state',
    'expected_version',
    'next_state',
    'reason'
  ]);
  if (
    typeof body.expected_state !== 'string' ||
    !LIFECYCLE_STATES.includes(body.expected_state) ||
    typeof body.next_state !== 'string' ||
    !LIFECYCLE_STATES.includes(body.next_state)
  ) {
    throw invalidInput('Campaign lifecycle state is invalid.');
  }
  return {
    expected_state: body.expected_state,
    expected_version: bodyId(body.expected_version, 'expected_version'),
    next_state: body.next_state,
    reason: scalarText(body.reason, 'reason', 1, 1000)
  };
}

const STATE_GUARDS = Object.freeze({
  demand_confirmed: Object.freeze(['demand']),
  proposal_draft: Object.freeze(['proposal']),
  proposal_confirmed: Object.freeze(['proposal']),
  influencer_shortlist: Object.freeze(['shortlist']),
  ordered: Object.freeze(['order']),
  executing: Object.freeze(['execution']),
  published: Object.freeze(['publication']),
  settled: Object.freeze(['publication', 'settlement']),
  reviewed: Object.freeze(['knowledge', 'review'])
});

function requiredRelationsForState(state) {
  const targetIndex = LIFECYCLE_STATES.indexOf(state);
  const relations = new Set();
  for (let index = 0; index <= targetIndex; index += 1) {
    for (const relation of STATE_GUARDS[LIFECYCLE_STATES[index]] || []) {
      relations.add(relation);
    }
  }
  return [...relations].sort();
}

function guardTargetExists(db, link) {
  const query = {
    demand: 'SELECT 1 FROM demands WHERE id=?',
    proposal: 'SELECT 1 FROM proposals WHERE id=?',
    influencer: 'SELECT 1 FROM influencers WHERE id=? AND is_active=1',
    collaboration: `
      SELECT 1 FROM collaborations
      WHERE id=? AND status<>'cancelled'
    `,
    knowledge_entry: 'SELECT 1 FROM knowledge_entries WHERE id=?'
  }[link.record_type];
  return Boolean(query && db.prepare(query).get(Number(link.record_id)));
}

function relationGuardMet(db, campaignId, relation) {
  if (relation === 'review' || relation === 'knowledge') {
    return Boolean(db.prepare(`
      SELECT 1
      FROM campaign_record_links review_link
      JOIN campaign_record_links knowledge_link
        ON knowledge_link.org_id=review_link.org_id
       AND knowledge_link.campaign_id=review_link.campaign_id
       AND knowledge_link.record_type='knowledge_entry'
       AND knowledge_link.record_id=review_link.record_id
       AND knowledge_link.bundle_id=review_link.bundle_id
       AND knowledge_link.relation_type='knowledge'
       AND knowledge_link.revoked_at IS NULL
      JOIN knowledge_entries entry
        ON entry.id=CAST(review_link.record_id AS INTEGER)
       AND entry.entry_type='campaign_review'
       AND entry.source_type='campaign_review'
       AND entry.business_type='campaign'
       AND entry.business_id=CAST(review_link.campaign_id AS TEXT)
      WHERE review_link.campaign_id=?
        AND review_link.relation_type='review'
        AND review_link.revoked_at IS NULL
      LIMIT 1
    `).get(campaignId));
  }
  const rows = db.prepare(`
    SELECT record_type,record_id
    FROM campaign_record_links
    WHERE campaign_id=? AND relation_type=? AND revoked_at IS NULL
    ORDER BY id
  `).all(campaignId, relation);
  return rows.some((row) => {
    if (!guardTargetExists(db, row)) return false;
    if (!['order', 'execution', 'publication', 'settlement'].includes(relation)) {
      return true;
    }
    const collaboration = db.prepare(`
      SELECT status,cost_actual_confirmed
      FROM collaborations
      WHERE id=?
    `).get(Number(row.record_id));
    if (!collaboration || collaboration.status === 'cancelled') return false;
    if (relation === 'execution') {
      return ['live', 'content_review', 'completed'].includes(collaboration.status);
    }
    if (relation === 'publication') return collaboration.status === 'completed';
    if (relation === 'settlement') {
      return collaboration.status === 'completed' &&
        collaboration.cost_actual_confirmed === 1;
    }
    return true;
  });
}

function transitionCampaign(db, input) {
  const body = normalizeTransitionBody(input.body);
  return runCampaignMutation(db, {
    ...input,
    method: 'POST',
    path: `/api/campaigns/${input.campaignId}/transitions`,
    body,
    scope: 'campaign.transition',
    expectedEventCount: 1
  }, ({ access, auditFingerprint, campaignId, userId }) => {
    if (access.campaign.operational_status !== 'active') {
      throw campaignOperationalError(access.campaign.operational_status);
    }
    if (access.campaign.lifecycle_state !== body.expected_state) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_STATE',
        'Campaign state is stale.',
        { current_state: access.campaign.lifecycle_state }
      );
    }
    if (access.campaign.row_version !== body.expected_version) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_VERSION',
        'Campaign version is stale.',
        { current_version: access.campaign.row_version }
      );
    }
    const expectedNext = LIFECYCLE_STATES[
      LIFECYCLE_STATES.indexOf(body.expected_state) + 1
    ];
    if (expectedNext !== body.next_state) {
      throw new CampaignServiceError(
        409,
        'INVALID_CAMPAIGN_TRANSITION',
        'Campaign transition is not adjacent.'
      );
    }
    const missing = requiredRelationsForState(body.next_state)
      .filter((relation) => !relationGuardMet(db, campaignId, relation));
    if (missing.length > 0) {
      throw new CampaignServiceError(
        409,
        'CAMPAIGN_GUARD_NOT_MET',
        'Campaign transition guard is not met.',
        { missing_relations: missing }
      );
    }
    if (access.campaign.row_version === SAFE_MAX) {
      throw new CampaignServiceError(
        409,
        'ROW_VERSION_EXHAUSTED',
        'Campaign version is exhausted.'
      );
    }
    const nextVersion = access.campaign.row_version + 1;
    const update = db.prepare(`
      UPDATE campaigns
      SET lifecycle_state=?,row_version=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND lifecycle_state=? AND row_version=?
        AND operational_status='active'
    `).run(
      body.next_state,
      nextVersion,
      campaignId,
      body.expected_state,
      body.expected_version
    );
    if (update.changes !== 1) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_STATE',
        'Campaign state is stale.',
        { current_state: access.campaign.lifecycle_state }
      );
    }
    const event = insertCampaignEvent(db, {
      orgId: access.campaign.org_id,
      campaignId,
      eventType: 'lifecycle_transition',
      previousState: body.expected_state,
      nextState: body.next_state,
      actorUserId: userId,
      reason: body.reason,
      source: 'project_workspace',
      metadata: {
        previous_version: body.expected_version,
        next_version: nextVersion
      },
      correlationId: input.requestId,
      auditFingerprint
    });
    return {
      status: 200,
      body: {
        campaign: campaignProjection(db, campaignId),
        event,
        dispatches: []
      }
    };
  });
}

function normalizeOperationalBody(body) {
  assertBodyKeys(body, [
    'action',
    'expected_status',
    'expected_version',
    'reason'
  ], [
    'action',
    'expected_status',
    'expected_version',
    'reason'
  ]);
  if (!['hold', 'resume', 'cancel'].includes(body.action)) {
    throw invalidInput('Operational action is invalid.');
  }
  if (!OPERATIONAL_STATUSES.includes(body.expected_status)) {
    throw invalidInput('expected_status is invalid.');
  }
  return {
    action: body.action,
    expected_status: body.expected_status,
    expected_version: bodyId(body.expected_version, 'expected_version'),
    reason: scalarText(body.reason, 'reason', 1, 1000)
  };
}

function cancelCampaignDependents(db, {
  campaignId,
  userId,
  reason
}) {
  const collaborations = db.prepare(`
    SELECT
      collaboration.id,collaboration.row_version,
      COUNT(DISTINCT link.bundle_id) AS active_bundle_count
    FROM collaborations collaboration
    JOIN campaign_record_links link
      ON link.record_type='collaboration'
     AND link.record_id=CAST(collaboration.id AS TEXT)
     AND link.campaign_id=?
     AND link.relation_type IN ('order','execution','publication','settlement')
     AND link.revoked_at IS NULL
    WHERE collaboration.status IN (${NONTERMINAL_COLLABORATION_SQL})
    GROUP BY collaboration.id,collaboration.row_version
    ORDER BY collaboration.id
  `).all(campaignId, ...NONTERMINAL_COLLABORATION_STATUSES);
  if (collaborations.some((row) => row.active_bundle_count !== 1)) {
    throw new CampaignServiceError(
      409,
      'CAMPAIGN_EVIDENCE_IN_USE',
      'Campaign collaboration evidence is inconsistent.'
    );
  }
  if (collaborations.some((row) => row.row_version === SAFE_MAX)) {
    throw new CampaignServiceError(
      409,
      'ROW_VERSION_EXHAUSTED',
      'Collaboration version is exhausted.'
    );
  }
  const relationOrder = ['settlement', 'publication', 'execution', 'order'];
  for (const collaboration of collaborations) {
    for (const relation of relationOrder) {
      db.prepare(`
        UPDATE campaign_record_links
        SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?,revoke_reason=?
        WHERE campaign_id=?
          AND record_type='collaboration'
          AND record_id=?
          AND relation_type=?
          AND revoked_at IS NULL
      `).run(
        userId,
        reason,
        campaignId,
        String(collaboration.id),
        relation
      );
    }
    const update = db.prepare(`
      UPDATE collaborations
      SET status='cancelled',row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND row_version=?
        AND status IN (${NONTERMINAL_COLLABORATION_SQL})
    `).run(
      collaboration.id,
      collaboration.row_version,
      ...NONTERMINAL_COLLABORATION_STATUSES
    );
    if (update.changes !== 1) {
      throw new CampaignServiceError(
        409,
        'CAMPAIGN_EVIDENCE_IN_USE',
        'Campaign collaboration cancellation lost its state race.'
      );
    }
  }

  db.prepare(`
    UPDATE workflow_tasks
    SET status='cancelled'
    WHERE status='pending'
      AND instance_id IN (
        SELECT id FROM workflow_instances
        WHERE campaign_id=? AND status IN ('active','paused')
      )
  `).run(campaignId);
  db.prepare(`
    UPDATE workflow_instances
    SET status='cancelled'
    WHERE campaign_id=? AND status IN ('active','paused')
  `).run(campaignId);
  db.prepare(`
    UPDATE campaign_workflow_dispatches
    SET
      status='cancelled',
      lease_until=NULL,
      lease_token=NULL,
      next_attempt_at=NULL,
      last_error_code='CAMPAIGN_CANCELLED',
      last_error='Campaign cancelled',
      updated_at=CURRENT_TIMESTAMP
    WHERE campaign_id=?
      AND status IN ('pending','processing','failed_initialization')
  `).run(campaignId);
}

function operationalAction(db, input) {
  const body = normalizeOperationalBody(input.body);
  return runCampaignMutation(db, {
    ...input,
    method: 'POST',
    path: `/api/campaigns/${input.campaignId}/operational-actions`,
    body,
    scope: 'campaign.operational',
    expectedEventCount: 1
  }, ({ access, auditFingerprint, campaignId, userId }) => {
    const currentStatus = access.campaign.operational_status;
    if (
      currentStatus !== body.expected_status ||
      body.action === 'hold' && currentStatus !== 'active' ||
      body.action === 'resume' && currentStatus !== 'on_hold' ||
      body.action === 'cancel' && !['active', 'on_hold'].includes(currentStatus)
    ) {
      throw new CampaignServiceError(
        409,
        'INVALID_OPERATIONAL_TRANSITION',
        'Campaign operational transition is invalid.',
        { current_status: currentStatus }
      );
    }
    if (access.campaign.row_version !== body.expected_version) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_VERSION',
        'Campaign version is stale.',
        { current_version: access.campaign.row_version }
      );
    }
    if (access.campaign.row_version === SAFE_MAX) {
      throw new CampaignServiceError(
        409,
        'ROW_VERSION_EXHAUSTED',
        'Campaign version is exhausted.'
      );
    }
    const nextStatus = body.action === 'hold'
      ? 'on_hold'
      : body.action === 'resume'
        ? 'active'
        : 'cancelled';
    const nextVersion = access.campaign.row_version + 1;
    if (body.action === 'cancel') {
      cancelCampaignDependents(db, {
        campaignId,
        userId,
        reason: body.reason
      });
    }
    const update = db.prepare(`
      UPDATE campaigns
      SET operational_status=?,row_version=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND operational_status=? AND row_version=?
    `).run(
      nextStatus,
      nextVersion,
      campaignId,
      body.expected_status,
      body.expected_version
    );
    if (update.changes !== 1) {
      throw new CampaignServiceError(
        409,
        'INVALID_OPERATIONAL_TRANSITION',
        'Campaign operational transition is invalid.',
        { current_status: currentStatus }
      );
    }
    const event = insertCampaignEvent(db, {
      orgId: access.campaign.org_id,
      campaignId,
      eventType: 'operational_status_changed',
      previousState: null,
      nextState: null,
      actorUserId: userId,
      reason: body.reason,
      source: 'project_workspace',
      metadata: {
        previous_status: currentStatus,
        next_status: nextStatus,
        previous_version: body.expected_version,
        next_version: nextVersion
      },
      correlationId: input.requestId,
      auditFingerprint
    });
    return {
      status: 200,
      body: {
        campaign: campaignProjection(db, campaignId),
        event
      }
    };
  });
}

function normalizeTransferBody(body) {
  assertBodyKeys(body, [
    'owner_user_id',
    'team_id',
    'expected_version',
    'reason'
  ], [
    'owner_user_id',
    'team_id',
    'expected_version',
    'reason'
  ]);
  return {
    owner_user_id: bodyId(body.owner_user_id, 'owner_user_id'),
    team_id: bodyId(body.team_id, 'team_id'),
    expected_version: bodyId(body.expected_version, 'expected_version'),
    reason: scalarText(body.reason, 'reason', 1, 1000)
  };
}

function requireTransferAssignment(db, {
  userId,
  campaignId,
  ownerUserId,
  teamId
}) {
  const decision = getAssignmentDecision(db, {
    actorUserId: userId,
    campaignId,
    ownerUserId,
    teamId,
    mode: 'transfer'
  });
  if (!decision.allowed) {
    throw new CampaignServiceError(
      403,
      'RECORD_FORBIDDEN',
      'Campaign transfer assignment is forbidden.'
    );
  }
  return decision;
}

function transferCampaign(db, input) {
  const body = normalizeTransferBody(input.body);
  const campaignId = canonicalId(input.campaignId);
  const userId = bodyId(input.userId, 'user_id');
  if (campaignId === null) throw invalidInput('Campaign id is invalid.');
  requireCampaignAccess(db, userId, campaignId);
  requireTransferAssignment(db, {
    userId,
    campaignId,
    ownerUserId: body.owner_user_id,
    teamId: body.team_id
  });
  return runCampaignMutation(db, {
    ...input,
    method: 'POST',
    path: `/api/campaigns/${input.campaignId}/transfers`,
    body,
    scope: 'campaign.transfer',
    expectedEventCount: 1
  }, ({ access, auditFingerprint }) => {
    if (access.campaign.operational_status !== 'active') {
      throw campaignOperationalError(access.campaign.operational_status);
    }
    requireTransferAssignment(db, {
      userId,
      campaignId,
      ownerUserId: body.owner_user_id,
      teamId: body.team_id
    });
    if (access.campaign.row_version !== body.expected_version) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_VERSION',
        'Campaign version is stale.',
        { current_version: access.campaign.row_version }
      );
    }
    if (
      access.campaign.owner_user_id === body.owner_user_id &&
      access.campaign.team_id === body.team_id
    ) {
      throw invalidInput('Campaign transfer must change the assignment.');
    }
    if (access.campaign.row_version === SAFE_MAX) {
      throw new CampaignServiceError(
        409,
        'ROW_VERSION_EXHAUSTED',
        'Campaign version is exhausted.'
      );
    }
    const nextVersion = access.campaign.row_version + 1;
    const update = db.prepare(`
      UPDATE campaigns
      SET
        owner_user_id=?,
        team_id=?,
        row_version=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND row_version=? AND operational_status='active'
    `).run(
      body.owner_user_id,
      body.team_id,
      nextVersion,
      campaignId,
      body.expected_version
    );
    if (update.changes !== 1) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_VERSION',
        'Campaign version is stale.',
        { current_version: access.campaign.row_version }
      );
    }
    const event = insertCampaignEvent(db, {
      orgId: access.campaign.org_id,
      campaignId,
      eventType: 'campaign_transferred',
      previousState: null,
      nextState: null,
      actorUserId: userId,
      reason: body.reason,
      source: 'project_workspace',
      metadata: {
        previous_owner_user_id: access.campaign.owner_user_id,
        next_owner_user_id: body.owner_user_id,
        previous_team_id: access.campaign.team_id,
        next_team_id: body.team_id,
        previous_version: body.expected_version,
        next_version: nextVersion
      },
      correlationId: input.requestId,
      auditFingerprint
    });
    return {
      status: 200,
      body: {
        campaign: campaignProjection(db, campaignId),
        event
      }
    };
  });
}

const PUBLIC_LINK_MAPPING = Object.freeze({
  demand: 'demand',
  proposal: 'proposal',
  shortlist: 'influencer',
  ai_run: 'ai_conversation',
  knowledge: 'knowledge_entry'
});

function invalidLink(message = 'Invalid campaign link.') {
  return new CampaignServiceError(400, 'INVALID_CAMPAIGN_LINK', message);
}

function normalizeLinkBody(body) {
  if (!plainObject(body)) throw invalidLink();
  const allowed = ['relation_type', 'record_type', 'record_id', 'metadata', 'reason'];
  const required = ['relation_type', 'record_type', 'record_id', 'reason'];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(body, key))
  ) {
    throw invalidLink();
  }
  const metadata = Object.hasOwn(body, 'metadata') ? body.metadata : {};
  const expectedRecordType = PUBLIC_LINK_MAPPING[body.relation_type];
  if (
    !expectedRecordType ||
    body.record_type !== expectedRecordType ||
    typeof body.record_id !== 'string' ||
    canonicalId(body.record_id) === null ||
    !plainObject(metadata) ||
    Object.keys(metadata).length !== 0
  ) {
    throw invalidLink();
  }
  let reason;
  try {
    reason = scalarText(body.reason, 'reason', 1, 1000);
  } catch {
    throw invalidLink();
  }
  return {
    relation_type: body.relation_type,
    record_type: body.record_type,
    record_id: body.record_id,
    metadata: {},
    reason
  };
}

function throwTargetAccess(result, recordType, custody = null) {
  let code = result.code;
  if (
    code === 'RECORD_REQUIRES_LINK_CORRECTION' &&
    custody &&
    custody.state === 'active'
  ) {
    code = 'RECORD_ALREADY_LINKED';
  }
  const status = code === 'RECORD_ALREADY_LINKED' ? 409 : result.status;
  throw new CampaignServiceError(
    status,
    code,
    code === 'KNOWLEDGE_ENTRY_NOT_FOUND'
      ? 'Knowledge entry was not found.'
      : code === 'RECORD_NOT_FOUND'
        ? 'Record was not found.'
        : code === 'RECORD_FORBIDDEN'
          ? 'Record access is forbidden.'
          : code === 'RECORD_ALREADY_LINKED'
            ? 'Record is already linked.'
            : code === 'RECORD_REQUIRES_LINK_CORRECTION'
              ? 'Record requires link correction.'
              : 'Campaign link is invalid.'
  );
}

function requireTargetAccess(db, {
  userId,
  campaignId,
  recordType,
  recordId,
  relationType,
  intent
}) {
  const result = getTargetAccess(db, {
    userId,
    campaignId,
    recordType,
    recordId,
    relationType,
    intent
  });
  if (!result.ok) {
    const custody = resolveRecordCustody(db, { recordType, recordId });
    throwTargetAccess(result, recordType, custody);
  }
  return result;
}

function targetLabel(db, recordType, recordId) {
  const id = Number(recordId);
  switch (recordType) {
    case 'demand': {
      const row = db.prepare(`
        SELECT brand_name,company_name,product_name FROM demands WHERE id=?
      `).get(id);
      const brand = row && (row.brand_name || row.company_name);
      return [brand, row && row.product_name].filter(Boolean).join(' / ') ||
        `Demand #${recordId}`;
    }
    case 'proposal':
      return `Proposal #${recordId}`;
    case 'influencer': {
      const row = db.prepare(`
        SELECT kol_handle FROM influencers WHERE id=?
      `).get(id);
      return row && row.kol_handle || `Influencer #${recordId}`;
    }
    case 'collaboration':
      return `Collaboration #${recordId}`;
    case 'ai_conversation': {
      const row = db.prepare('SELECT title FROM ai_conversations WHERE id=?').get(id);
      return row && row.title || `Conversation #${recordId}`;
    }
    case 'knowledge_entry': {
      const row = db.prepare('SELECT title FROM knowledge_entries WHERE id=?').get(id);
      return row && row.title || `Knowledge #${recordId}`;
    }
    default:
      return `Record #${recordId}`;
  }
}

function workspaceRoute(campaignId, relationType, recordId) {
  if (relationType === 'demand') {
    return `/m3?campaign=${campaignId}&step=demand&record=${recordId}`;
  }
  if (relationType === 'proposal' || relationType === 'ppt') {
    return `/m3?campaign=${campaignId}&step=proposal&record=${recordId}`;
  }
  if (relationType === 'shortlist') {
    return `/m4?campaign=${campaignId}&tab=tab1&record=${recordId}`;
  }
  if (['order', 'execution', 'publication', 'settlement'].includes(relationType)) {
    return `/m4?campaign=${campaignId}&tab=tab2&record=${recordId}`;
  }
  if (relationType === 'ai_run') {
    return `/m5?campaign=${campaignId}&conversation=${recordId}`;
  }
  if (relationType === 'knowledge' || relationType === 'review') {
    return `/campaigns?campaign=${campaignId}&panel=knowledge&entry=${recordId}`;
  }
  return `/campaigns?campaign=${campaignId}`;
}

function workspaceLinkProjectionWithLabel(row, label) {
  return {
    link_id: row.id,
    relation_type: row.relation_type,
    record_type: row.record_type,
    record_id: row.record_id,
    access_state: 'available',
    label,
    route: workspaceRoute(row.campaign_id, row.relation_type, row.record_id),
    created_at: row.created_at,
    revoked_at: row.revoked_at
  };
}

function workspaceLinkProjection(db, row) {
  return workspaceLinkProjectionWithLabel(
    row,
    targetLabel(db, row.record_type, row.record_id)
  );
}

function attachCampaignLink(db, input) {
  const body = normalizeLinkBody(input.body);
  const campaignId = canonicalId(input.campaignId);
  const userId = bodyId(input.userId, 'user_id');
  if (campaignId === null) throw invalidLink();
  requireTargetAccess(db, {
    userId,
    campaignId,
    recordType: body.record_type,
    recordId: body.record_id,
    relationType: body.relation_type,
    intent: 'manage'
  });
  return runCampaignMutation(db, {
    ...input,
    method: 'POST',
    path: `/api/campaigns/${input.campaignId}/links`,
    body,
    scope: 'campaign.link.attach',
    expectedEventCount: 1,
    authorize: () => {
      requireTargetAccess(db, {
        userId,
        campaignId,
        recordType: body.record_type,
        recordId: body.record_id,
        relationType: body.relation_type,
        intent: 'manage'
      });
    }
  }, ({ access, auditFingerprint }) => {
    requireTargetAccess(db, {
      userId,
      campaignId,
      recordType: body.record_type,
      recordId: body.record_id,
      relationType: body.relation_type,
      intent: 'attach'
    });
    const bundleId = randomBytes(32).toString('hex');
    const insert = db.prepare(`
      INSERT INTO campaign_record_links (
        org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json
      ) VALUES (?,?,?,?,?,?,?,'{}')
    `).run(
      access.campaign.org_id,
      campaignId,
      body.record_type,
      bundleId,
      body.record_id,
      body.relation_type,
      userId
    );
    const linkId = Number(insert.lastInsertRowid);
    const linkRow = db.prepare(`
      SELECT * FROM campaign_record_links WHERE id=?
    `).get(linkId);
    const event = insertCampaignEvent(db, {
      orgId: access.campaign.org_id,
      campaignId,
      eventType: 'link_attached',
      previousState: null,
      nextState: null,
      actorUserId: userId,
      reason: body.reason,
      source: 'project_workspace',
      metadata: {
        bundle_id: bundleId,
        relation_types: [body.relation_type],
        record_type: body.record_type,
        record_id: body.record_id,
        link_ids: [linkId]
      },
      correlationId: input.requestId,
      auditFingerprint
    });
    return {
      status: 201,
      body: {
        link: workspaceLinkProjection(db, linkRow),
        event
      }
    };
  });
}

function normalizeLinkCorrectionBody(body) {
  if (!plainObject(body)) throw invalidLink();
  const allowed = ['link_id', 'target_campaign_id', 'reason'];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    !Object.hasOwn(body, 'link_id') ||
    !Object.hasOwn(body, 'reason')
  ) {
    throw invalidLink();
  }
  if (!Number.isSafeInteger(body.link_id) || body.link_id < 1) {
    throw invalidLink();
  }
  let reason;
  try {
    reason = scalarText(body.reason, 'reason', 1, 1000);
  } catch {
    throw invalidLink();
  }
  const normalized = { link_id: body.link_id, reason };
  if (Object.hasOwn(body, 'target_campaign_id')) {
    if (
      !Number.isSafeInteger(body.target_campaign_id) ||
      body.target_campaign_id < 1
    ) {
      throw invalidLink();
    }
    normalized.target_campaign_id = body.target_campaign_id;
  }
  return normalized;
}

function campaignEvidenceInUse(message = 'Campaign evidence is in use.') {
  return new CampaignServiceError(
    409,
    'CAMPAIGN_EVIDENCE_IN_USE',
    message
  );
}

function readCorrectionBundle(db, campaignId, linkId) {
  const selected = db.prepare(`
    SELECT * FROM campaign_record_links
    WHERE id=? AND campaign_id=?
  `).get(linkId, campaignId);
  if (!selected) throw invalidLink('Campaign link was not found.');
  const rows = db.prepare(`
    SELECT * FROM campaign_record_links
    WHERE campaign_id=? AND bundle_id=?
    ORDER BY relation_type,id
  `).all(campaignId, selected.bundle_id);
  if (
    rows.length === 0 ||
    rows.some((row) => (
      row.org_id !== selected.org_id ||
      row.record_type !== selected.record_type ||
      row.record_id !== selected.record_id
    ))
  ) {
    throw campaignEvidenceInUse();
  }
  const activeCount = rows.filter((row) => row.revoked_at === null).length;
  if (activeCount !== 0 && activeCount !== rows.length) {
    throw campaignEvidenceInUse();
  }
  return {
    selected,
    rows,
    active: activeCount === rows.length
  };
}

function authorizeLinkCorrection(db, {
  userId,
  campaignId,
  body,
  access
}) {
  if (access.role !== 'owner' && access.role !== 'org_admin') {
    throw new CampaignServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign link correction is forbidden.'
    );
  }
  if (!access.permissions.correct_links) {
    throw campaignOperationalError(access.campaign.operational_status);
  }
  const bundle = readCorrectionBundle(db, campaignId, body.link_id);
  const targetAuthorizationCampaignId = (
    !bundle.active &&
    body.target_campaign_id !== undefined &&
    body.target_campaign_id !== campaignId
  )
    ? body.target_campaign_id
    : campaignId;
  requireTargetAccess(db, {
    userId,
    campaignId: targetAuthorizationCampaignId,
    recordType: bundle.selected.record_type,
    recordId: bundle.selected.record_id,
    relationType: bundle.selected.relation_type,
    intent: 'manage'
  });
  if (body.target_campaign_id !== undefined) {
    const destination = requireCampaignAccess(
      db,
      userId,
      body.target_campaign_id
    );
    if (
      destination.campaign.org_id !== access.campaign.org_id ||
      !destination.permissions.correct_links
    ) {
      throw new CampaignServiceError(
        403,
        'CAMPAIGN_FORBIDDEN',
        'Destination campaign access is forbidden.'
      );
    }
  }
  return bundle;
}

function linkEventMetadata(bundleId, rows, linkIds) {
  return {
    bundle_id: bundleId,
    relation_types: [...new Set(rows.map((row) => row.relation_type))].sort(),
    record_type: rows[0].record_type,
    record_id: rows[0].record_id,
    link_ids: [...linkIds].sort((left, right) => left - right)
  };
}

function insertReplacementBundle(db, {
  rows,
  organizationId,
  campaignId,
  userId,
  bundleId
}) {
  const insert = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?)
  `);
  const linkIds = [];
  for (const row of rows) {
    const result = insert.run(
      organizationId,
      campaignId,
      row.record_type,
      bundleId,
      row.record_id,
      row.relation_type,
      userId,
      row.metadata_json
    );
    linkIds.push(Number(result.lastInsertRowid));
  }
  linkIds.sort((left, right) => left - right);
  return linkIds;
}

function correctCampaignLink(db, input) {
  const body = normalizeLinkCorrectionBody(input.body);
  const campaignId = canonicalId(input.campaignId);
  const userId = bodyId(input.userId, 'user_id');
  if (campaignId === null) throw invalidLink();
  const targetCampaignId = body.target_campaign_id;
  const preAccess = requireCampaignAccess(db, userId, campaignId);
  authorizeLinkCorrection(db, {
    userId,
    campaignId,
    body,
    access: preAccess
  });
  const crossCampaign = (
    targetCampaignId !== undefined &&
    targetCampaignId !== campaignId
  );
  return runCampaignMutation(db, {
    ...input,
    method: 'POST',
    path: `/api/campaigns/${input.campaignId}/link-corrections`,
    body,
    scope: 'campaign.link.correct',
    expectedEventCount: crossCampaign ? 2 : 1,
    secondaryCampaignId: crossCampaign ? targetCampaignId : null,
    authorize: ({ access }) => {
      authorizeLinkCorrection(db, {
        userId,
        campaignId,
        body,
        access
      });
    }
  }, ({ access, auditFingerprint }) => {
    const bundle = readCorrectionBundle(db, campaignId, body.link_id);
    if (crossCampaign && !bundle.active) {
      throw invalidLink('Only an active link bundle can move between campaigns.');
    }
    const relationTypes = [...new Set(
      bundle.rows.map((row) => row.relation_type)
    )].sort();
    if (relationTypes.includes('workflow')) {
      throw campaignEvidenceInUse();
    }
    if (crossCampaign && relationTypes.includes('review')) {
      throw campaignEvidenceInUse();
    }
    if (bundle.active && targetCampaignId === campaignId) {
      throw invalidLink('An active link bundle is already in this campaign.');
    }
    if (!bundle.active && targetCampaignId === undefined) {
      throw invalidLink('A revoked link bundle requires same-campaign reactivation.');
    }
    if (
      crossCampaign &&
      bundle.selected.record_type === 'knowledge_entry'
    ) {
      knowledgeService.preflightCampaignKnowledgeCustodyMoveInTransaction(
        db,
        {
          entryId: Number(bundle.selected.record_id),
          destinationCampaignId: targetCampaignId,
          organizationId: access.campaign.org_id
        }
      );
    }

    let revokedRows = [];
    if (bundle.active) {
      db.prepare(`
        UPDATE campaign_record_links
        SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?,revoke_reason=?
        WHERE campaign_id=? AND bundle_id=? AND revoked_at IS NULL
      `).run(userId, body.reason, campaignId, bundle.selected.bundle_id);
      revokedRows = db.prepare(`
        SELECT * FROM campaign_record_links
        WHERE campaign_id=? AND bundle_id=?
        ORDER BY relation_type,id
      `).all(campaignId, bundle.selected.bundle_id);
      const sourceRequired = requiredRelationsForState(
        access.campaign.lifecycle_state
      );
      if (sourceRequired.some((relation) => !relationGuardMet(
        db,
        campaignId,
        relation
      ))) {
        throw campaignEvidenceInUse(
          'The link bundle is required by the source campaign state.'
        );
      }
    }

    if (targetCampaignId === undefined) {
      const revokedIds = revokedRows.map((row) => row.id)
        .sort((left, right) => left - right);
      const metadata = linkEventMetadata(
        bundle.selected.bundle_id,
        bundle.rows,
        revokedIds
      );
      delete metadata.link_ids;
      metadata.revoked_link_ids = revokedIds;
      const sourceEvent = insertCampaignEvent(db, {
        orgId: access.campaign.org_id,
        campaignId,
        eventType: 'link_revoked',
        previousState: null,
        nextState: null,
        actorUserId: userId,
        reason: body.reason,
        source: 'project_workspace',
        metadata,
        correlationId: input.requestId,
        auditFingerprint
      });
      return {
        status: 200,
        body: {
          revoked_links: revokedRows.map((row) => workspaceLinkProjection(db, row)),
          replacement_links: [],
          source_event: sourceEvent,
          destination_event: null
        }
      };
    }

    const destinationAccess = requireCampaignAccess(
      db,
      userId,
      targetCampaignId
    );
    const destinationBundleId = randomBytes(32).toString('hex');
    const replacementIds = insertReplacementBundle(db, {
      rows: bundle.rows,
      organizationId: access.campaign.org_id,
      campaignId: targetCampaignId,
      userId,
      bundleId: destinationBundleId
    });
    const replacementRows = replacementIds.map((linkId) => db.prepare(`
      SELECT * FROM campaign_record_links WHERE id=?
    `).get(linkId));
    const destinationRequired = requiredRelationsForState(
      destinationAccess.campaign.lifecycle_state
    );
    if (destinationRequired.some((relation) => !relationGuardMet(
      db,
      targetCampaignId,
      relation
    ))) {
      throw campaignEvidenceInUse(
        'The link bundle is invalid for the destination campaign state.'
      );
    }

    if (!crossCampaign) {
      const metadata = linkEventMetadata(
        destinationBundleId,
        replacementRows,
        replacementIds
      );
      const sourceEvent = insertCampaignEvent(db, {
        orgId: access.campaign.org_id,
        campaignId,
        eventType: 'link_attached',
        previousState: null,
        nextState: null,
        actorUserId: userId,
        reason: body.reason,
        source: 'project_workspace',
        metadata,
        correlationId: input.requestId,
        auditFingerprint
      });
      return {
        status: 200,
        body: {
          revoked_links: [],
          replacement_links: replacementRows.map((row) => (
            workspaceLinkProjection(db, row)
          )),
          source_event: sourceEvent,
          destination_event: null
        }
      };
    }

    const revokedIds = revokedRows.map((row) => row.id)
      .sort((left, right) => left - right);
    const moveMetadata = {
      source_bundle_id: bundle.selected.bundle_id,
      destination_bundle_id: destinationBundleId,
      relation_types: relationTypes,
      record_type: bundle.selected.record_type,
      record_id: bundle.selected.record_id,
      source_campaign_id: campaignId,
      destination_campaign_id: targetCampaignId,
      revoked_link_ids: revokedIds,
      replacement_link_ids: replacementIds
    };
    const sourceEvent = insertCampaignEvent(db, {
      orgId: access.campaign.org_id,
      campaignId,
      eventType: 'link_moved',
      previousState: null,
      nextState: null,
      actorUserId: userId,
      reason: body.reason,
      source: 'project_workspace',
      metadata: moveMetadata,
      correlationId: input.requestId,
      auditFingerprint
    });
    const destinationEvent = insertCampaignEvent(db, {
      orgId: access.campaign.org_id,
      campaignId: targetCampaignId,
      eventType: 'link_moved',
      previousState: null,
      nextState: null,
      actorUserId: userId,
      reason: body.reason,
      source: 'project_workspace',
      metadata: moveMetadata,
      correlationId: input.requestId,
      auditFingerprint
    });
    return {
      status: 200,
      body: {
        revoked_links: revokedRows.map((row) => workspaceLinkProjection(db, row)),
        replacement_links: replacementRows.map((row) => (
          workspaceLinkProjection(db, row)
        )),
        source_event: sourceEvent,
        destination_event: destinationEvent
      }
    };
  });
}

const CANDIDATE_LINK_MAPPING = Object.freeze({
  demand: 'demand',
  proposal: 'proposal',
  shortlist: 'influencer',
  order: 'collaboration',
  ai_run: 'ai_conversation',
  knowledge: 'knowledge_entry'
});

function candidateSqlDefinition(relationType, {
  access,
  actor,
  userId,
  campaignId
}) {
  const unclassified = `
    NOT EXISTS (
      SELECT 1
      FROM campaign_record_links classified
      WHERE classified.record_type=@recordType
        AND classified.record_id=CAST(target.id AS TEXT)
        AND classified.relation_type<>'shortlist'
    )
  `;
  const ownerInOrganization = (column) => `
    EXISTS (
      SELECT 1
      FROM organization_memberships owner_membership
      JOIN users owner_user
        ON owner_user.id=owner_membership.user_id
       AND owner_user.is_active=1
      WHERE owner_membership.org_id=@orgId
        AND owner_membership.user_id=${column}
        AND owner_membership.status='active'
    )
  `;
  const platformAdmin = actor.role === 'admin' ? 1 : 0;
  const orgAdmin = access.role === 'org_admin' ? 1 : 0;
  switch (relationType) {
    case 'demand': {
      const brand = `
        COALESCE(
          NULLIF(target.brand_name,''),
          NULLIF(target.company_name,''),
          ''
        )
      `;
      const product = `COALESCE(NULLIF(target.product_name,''),'')`;
      return {
        params: {
          platformAdmin,
          userId,
          recordType: 'demand'
        },
        sql: `
          SELECT
            target.id,
            CASE
              WHEN ${brand}<>'' AND ${product}<>''
                THEN ${brand} || ' / ' || ${product}
              WHEN ${brand}<>'' THEN ${brand}
              WHEN ${product}<>'' THEN ${product}
              ELSE 'Demand #' || target.id
            END AS label,
            NULL AS status,
            NULL AS row_version
          FROM demands target
          WHERE (@platformAdmin=1 OR target.user_id=@userId)
            AND ${unclassified}
        `
      };
    }
    case 'proposal':
      return {
        params: {
          platformAdmin,
          userId,
          recordType: 'proposal'
        },
        sql: `
          SELECT
            target.id,
            'Proposal #' || target.id AS label,
            NULL AS status,
            NULL AS row_version
          FROM proposals target
          WHERE (@platformAdmin=1 OR target.user_id=@userId)
            AND ${unclassified}
        `
      };
    case 'shortlist':
      return {
        params: {},
        sql: `
          SELECT
            target.id,
            COALESCE(
              NULLIF(target.kol_handle,''),
              'Influencer #' || target.id
            ) AS label,
            NULL AS status,
            NULL AS row_version
          FROM influencers target
          WHERE target.is_active=1
        `
      };
    case 'ai_run':
      return {
        params: {
          platformAdmin,
          orgAdmin,
          orgId: access.campaign.org_id,
          userId,
          recordType: 'ai_conversation'
        },
        sql: `
          SELECT
            target.id,
            COALESCE(
              NULLIF(target.title,''),
              'Conversation #' || target.id
            ) AS label,
            NULL AS status,
            NULL AS row_version
          FROM ai_conversations target
          WHERE (
            @platformAdmin=1
            OR target.user_id=@userId
            OR (
              @orgAdmin=1
              AND ${ownerInOrganization('target.user_id')}
            )
          )
            AND ${unclassified}
        `
      };
    case 'knowledge':
      return {
        params: {
          platformAdmin,
          userId,
          recordType: 'knowledge_entry'
        },
        sql: `
          SELECT
            target.id,
            COALESCE(
              NULLIF(target.title,''),
              'Knowledge #' || target.id
            ) AS label,
            NULL AS status,
            NULL AS row_version
          FROM knowledge_entries target
          WHERE (
            @platformAdmin=1
            OR target.created_by=@userId
          )
            AND ${unclassified}
        `
      };
    case 'order':
      return {
        params: {
          platformAdmin,
          orgAdmin,
          orgId: access.campaign.org_id,
          userId,
          campaignId
        },
        prefix: `
          custody_ranked AS MATERIALIZED (
            SELECT
              CAST(link.record_id AS INTEGER) AS target_id,
              link.org_id,
              link.campaign_id,
              ROW_NUMBER() OVER (
                PARTITION BY link.record_id
                ORDER BY
                  CASE WHEN link.revoked_at IS NULL THEN 0 ELSE 1 END,
                  CASE
                    WHEN link.revoked_at IS NULL THEN link.id
                  END DESC,
                  CASE
                    WHEN link.revoked_at IS NOT NULL THEN link.revoked_at
                  END DESC,
                  link.id DESC
              ) AS custody_rank
            FROM campaign_record_links link
            WHERE link.record_type='collaboration'
              AND link.relation_type<>'shortlist'
          ),
          custody AS (
            SELECT target_id,org_id,campaign_id
            FROM custody_ranked
            WHERE custody_rank=1
          ),
        `,
        sql: `
          SELECT
            target.id,
            COALESCE(
              NULLIF(influencer.display_name,''),
              NULLIF(influencer.kol_handle,''),
              'Creator #' || target.id
            ) || ' partnership' AS label,
            target.status,
            target.row_version
          FROM collaborations target
          JOIN influencers influencer ON influencer.id=target.influencer_id
          LEFT JOIN custody ON custody.target_id=target.id
          WHERE target.status<>'cancelled'
            AND (
              @platformAdmin=1
              OR target.user_id=@userId
              OR (
                @orgAdmin=1
                AND ${ownerInOrganization('target.user_id')}
              )
            )
            AND (
              custody.target_id IS NULL
              OR (
                custody.org_id=@orgId
                AND custody.campaign_id=@campaignId
              )
            )
        `
      };
    default:
      return null;
  }
}

function candidateQuerySql(definition) {
  return `
    WITH
    ${definition.prefix || ''}
    candidate_base AS MATERIALIZED (
      ${definition.sql}
    ),
    filtered AS (
      SELECT id,label,status,row_version
      FROM candidate_base
      WHERE @q='' OR instr(lower(label),lower(@q))>0
    )
  `;
}

function listCampaignLinkCandidates(db, input) {
  const userId = bodyId(input.userId, 'user_id');
  const campaignId = canonicalId(input.campaignId);
  if (campaignId === null) throw invalidInput('Campaign id is invalid.');
  const query = input.query || {};
  assertQueryKeys(query, ['relation_type', 'q', 'limit', 'offset']);
  const relationType = query.relation_type;
  const recordType = CANDIDATE_LINK_MAPPING[relationType];
  if (!recordType) throw invalidInput('relation_type is invalid.');
  const access = requireCampaignAccess(db, userId, campaignId);
  const q = boundedQuery(query.q, 160, 'q');
  const limit = boundedInteger(query.limit, 25, 1, 50, 'limit');
  const offset = boundedInteger(query.offset, 0, 0, SAFE_MAX, 'offset');
  if (!access.permissions.write) {
    return { items: [], total: 0, limit, offset };
  }
  const actor = readActor(db, userId);
  if (!actor) {
    throw new CampaignServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  const definition = candidateSqlDefinition(relationType, {
    access,
    actor,
    userId,
    campaignId
  });
  const sql = candidateQuerySql(definition);
  const params = { ...definition.params, q };
  const total = db.prepare(`
    ${sql}
    SELECT COUNT(*) AS count
    FROM filtered
  `).get(params).count;
  const rows = db.prepare(`
    ${sql}
    SELECT id,label,status,row_version
    FROM filtered
    ORDER BY id
    LIMIT @limit OFFSET @offset
  `).all({
    ...params,
    limit,
    offset
  });
  const items = rows.map((row) => {
    if (relationType === 'order') {
      return {
        id: row.id,
        title: row.label,
        status: row.status,
        row_version: row.row_version,
        adoption_allowed: true
      };
    }
    return {
      record_type: recordType,
      record_id: String(row.id),
      label: row.label
    };
  });
  return { items, total, limit, offset };
}

const WORKSPACE_RELATIONS = Object.freeze([
  'demand',
  'proposal',
  'ppt',
  'shortlist',
  'order',
  'execution',
  'publication',
  'settlement',
  'workflow',
  'ai_run',
  'knowledge',
  'review'
]);

function workspacePagination(query) {
  assertQueryKeys(query, [
    'active_limit',
    'active_offset',
    'history_limit',
    'history_offset',
    'event_limit',
    'event_offset'
  ]);
  return {
    activeLinks: {
      limit: boundedInteger(
        query.active_limit,
        WORKSPACE_PAGE_LIMIT,
        1,
        WORKSPACE_PAGE_MAX,
        'active_limit'
      ),
      offset: boundedInteger(query.active_offset, 0, 0, SAFE_MAX, 'active_offset')
    },
    linkHistory: {
      limit: boundedInteger(
        query.history_limit,
        WORKSPACE_PAGE_LIMIT,
        1,
        WORKSPACE_PAGE_MAX,
        'history_limit'
      ),
      offset: boundedInteger(query.history_offset, 0, 0, SAFE_MAX, 'history_offset')
    },
    events: {
      limit: boundedInteger(
        query.event_limit,
        WORKSPACE_PAGE_LIMIT,
        1,
        WORKSPACE_PAGE_MAX,
        'event_limit'
      ),
      offset: boundedInteger(query.event_offset, 0, 0, SAFE_MAX, 'event_offset')
    }
  };
}

function workspaceTargetKey(recordType, recordId) {
  return `${recordType}:${recordId}`;
}

const WORKSPACE_TARGET_SELECTS = Object.freeze({
  demand: `
    SELECT id,user_id,brand_name,company_name,product_name
    FROM demands
  `,
  proposal: `
    SELECT id,user_id,demand_id
    FROM proposals
  `,
  influencer: `
    SELECT id,is_active,kol_handle
    FROM influencers
  `,
  collaboration: `
    SELECT id,user_id,status,row_version
    FROM collaborations
  `,
  ai_conversation: `
    SELECT id,user_id,visibility,title
    FROM ai_conversations
  `,
  workflow_instance: `
    SELECT id,org_id,campaign_id,started_by,status
    FROM workflow_instances
  `,
  knowledge_entry: `
    SELECT id,created_by,visibility,is_public,title
    FROM knowledge_entries
  `
});

function workspaceTargetRows(db, references) {
  const idsByType = new Map();
  for (const reference of references) {
    if (!Object.hasOwn(WORKSPACE_TARGET_SELECTS, reference.record_type)) continue;
    const ids = idsByType.get(reference.record_type) || new Set();
    ids.add(Number(reference.record_id));
    idsByType.set(reference.record_type, ids);
  }
  const targets = new Map();
  for (const [recordType, ids] of idsByType) {
    const rows = db.prepare(`
      ${WORKSPACE_TARGET_SELECTS[recordType]}
      WHERE id IN (
        SELECT CAST(value AS INTEGER)
        FROM json_each(?)
      )
    `).all(JSON.stringify([...ids]));
    for (const row of rows) {
      targets.set(workspaceTargetKey(recordType, String(row.id)), row);
    }
  }
  return targets;
}

function workspaceCustodyRows(db, references) {
  const keys = [...new Set(references.map((reference) => (
    workspaceTargetKey(reference.record_type, reference.record_id)
  )))];
  if (keys.length === 0) return new Map();
  const rows = db.prepare(`
    WITH requested(key) AS (
      SELECT value FROM json_each(?)
    ), ranked AS (
      SELECT
        link.*,
        ROW_NUMBER() OVER (
          PARTITION BY link.record_type,link.record_id
          ORDER BY
            CASE WHEN link.revoked_at IS NULL THEN 0 ELSE 1 END,
            link.revoked_at DESC,
            link.id DESC
        ) AS custody_rank
      FROM campaign_record_links link
      JOIN requested
        ON requested.key=link.record_type || ':' || link.record_id
      WHERE link.relation_type<>'shortlist'
    )
    SELECT
      record_type,
      record_id,
      COUNT(*) AS classified_count,
      SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active_count,
      COUNT(DISTINCT CASE WHEN revoked_at IS NULL THEN
        printf('%d:%d:%s',org_id,campaign_id,bundle_id)
      END) AS active_identity_count,
      MAX(CASE WHEN revoked_at IS NULL THEN org_id END) AS active_org_id,
      MAX(CASE WHEN revoked_at IS NULL THEN campaign_id END) AS active_campaign_id,
      MAX(CASE WHEN custody_rank=1 THEN org_id END) AS latest_org_id,
      MAX(CASE WHEN custody_rank=1 THEN campaign_id END) AS latest_campaign_id
    FROM ranked
    GROUP BY record_type,record_id
  `).all(JSON.stringify(keys));
  return new Map(rows.map((row) => [
    workspaceTargetKey(row.record_type, row.record_id),
    row
  ]));
}

function workspaceTargetOwner(target) {
  return target.user_id ?? target.created_by ?? target.started_by ?? null;
}

function workspaceOrganizationOwners(db, organizationId, targets) {
  const ownerIds = [...new Set(
    [...targets.values()]
      .map(workspaceTargetOwner)
      .filter((ownerId) => Number.isSafeInteger(ownerId) && ownerId > 0)
  )];
  if (ownerIds.length === 0) return new Set();
  return new Set(db.prepare(`
    SELECT membership.user_id
    FROM organization_memberships membership
    JOIN users owner
      ON owner.id=membership.user_id
     AND owner.is_active=1
    WHERE membership.org_id=?
      AND membership.status='active'
      AND membership.user_id IN (
        SELECT CAST(value AS INTEGER)
        FROM json_each(?)
      )
  `).all(organizationId, JSON.stringify(ownerIds)).map((row) => row.user_id));
}

function workspaceTargetVisible({
  actor,
  campaignAccess,
  organizationOwners,
  recordType,
  target,
  targetCampaignId
}) {
  const platformAdmin = actor.role === 'admin' && actor.is_active === 1;
  const ownerId = workspaceTargetOwner(target);
  const actorOwns = ownerId === actor.id;
  const orgAdmin = (
    campaignAccess.role === 'org_admin' &&
    organizationOwners.has(ownerId)
  );
  switch (recordType) {
    case 'demand':
    case 'proposal':
      return platformAdmin || actorOwns;
    case 'influencer':
      return target.is_active === 1;
    case 'collaboration':
    case 'ai_conversation':
      return platformAdmin || orgAdmin || actorOwns;
    case 'workflow_instance':
      return (
        target.org_id === campaignAccess.campaign.org_id &&
        target.campaign_id === targetCampaignId
      );
    case 'knowledge_entry':
      return (
        platformAdmin ||
        actorOwns ||
        projectKnowledgeVisibility({
          legacyVisibility: target.visibility,
          isPublic: target.is_public
        }) === 'team'
      );
    default:
      return false;
  }
}

function workspaceTargetState(context, reference, targetCampaignId) {
  const key = workspaceTargetKey(reference.record_type, reference.record_id);
  const target = context.targets.get(key);
  if (!target) return 'missing';
  if (!workspaceTargetVisible({
    actor: context.actor,
    campaignAccess: context.campaignAccess,
    organizationOwners: context.organizationOwners,
    recordType: reference.record_type,
    target,
    targetCampaignId
  })) {
    return 'restricted';
  }
  const custody = context.custody.get(key);
  if (!custody) return 'available';
  if (custody.active_identity_count > 1) {
    throw new Error('campaign custody is ambiguous');
  }
  const custodyOrgId = custody.active_count > 0
    ? custody.active_org_id
    : custody.latest_org_id;
  const custodyCampaignId = custody.active_count > 0
    ? custody.active_campaign_id
    : custody.latest_campaign_id;
  return (
    custodyOrgId === context.campaignAccess.campaign.org_id &&
    custodyCampaignId === targetCampaignId
  ) ? 'available' : 'restricted';
}

function workspaceTargetLabel(recordType, recordId, target) {
  if (recordType === 'demand') {
    const brand = target.brand_name || target.company_name;
    return [brand, target.product_name].filter(Boolean).join(' / ') ||
      `Demand #${recordId}`;
  }
  if (recordType === 'proposal') return `Proposal #${recordId}`;
  if (recordType === 'influencer') {
    return target.kol_handle || `Influencer #${recordId}`;
  }
  if (recordType === 'collaboration') return `Collaboration #${recordId}`;
  if (recordType === 'ai_conversation') {
    return target.title || `Conversation #${recordId}`;
  }
  if (recordType === 'knowledge_entry') {
    return target.title || `Knowledge #${recordId}`;
  }
  return `Record #${recordId}`;
}

function missingWorkspaceLink(row) {
  return {
    link_id: row.id,
    relation_type: row.relation_type,
    access_state: 'missing',
    created_at: row.created_at,
    revoked_at: row.revoked_at
  };
}

function restrictedWorkspaceLink(relationType, count) {
  return {
    relation_type: relationType,
    access_state: 'restricted',
    restricted_count: count
  };
}

function workspaceAccessibleCampaignIds(db, userId, campaignIds) {
  if (campaignIds.length === 0) return new Set();
  const predicate = buildCollectionAccessPredicate('campaigns', { userId });
  return new Set(db.prepare(`
    SELECT campaign.id
    FROM campaigns campaign
    WHERE campaign.id IN (
      SELECT CAST(value AS INTEGER)
      FROM json_each(?)
    )
      AND ${predicate.sql}
  `).all(
    JSON.stringify([...new Set(campaignIds)]),
    ...predicate.params
  ).map((row) => row.id));
}

function workspaceEventProjection(context, event) {
  if (!['link_attached', 'link_revoked', 'link_moved'].includes(
    event.event_type
  )) {
    return event;
  }
  const metadata = event.metadata;
  const reference = {
    record_type: metadata.record_type,
    record_id: metadata.record_id
  };
  if (!context.targets.has(workspaceTargetKey(
    reference.record_type,
    reference.record_id
  ))) {
    event.metadata = { access_state: 'missing' };
    return event;
  }
  let targetCampaignId = context.campaignAccess.campaign.id;
  if (event.event_type === 'link_moved') {
    if (
      !context.accessibleCampaignIds.has(metadata.source_campaign_id) ||
      !context.accessibleCampaignIds.has(metadata.destination_campaign_id)
    ) {
      event.metadata = { access_state: 'restricted' };
      return event;
    }
    targetCampaignId = metadata.destination_campaign_id;
  }
  if (workspaceTargetState(context, reference, targetCampaignId) !== 'available') {
    event.metadata = { access_state: 'restricted' };
  }
  return event;
}

function getCampaignWorkspace(db, input) {
  const userId = bodyId(input.userId, 'user_id');
  const campaignId = canonicalId(input.campaignId);
  if (campaignId === null) throw invalidInput('Campaign id is invalid.');
  const page = workspacePagination(input.query || {});
  const campaignAccess = requireCampaignAccess(db, userId, campaignId);
  const actor = readActor(db, userId);
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM campaign_record_links
        WHERE campaign_id=? AND revoked_at IS NULL) AS active_total,
      (SELECT COUNT(*) FROM campaign_record_links
        WHERE campaign_id=? AND revoked_at IS NOT NULL) AS history_total,
      (SELECT COUNT(*) FROM campaign_events
        WHERE campaign_id=?) AS event_total
  `).get(campaignId, campaignId, campaignId);
  const activeRows = db.prepare(`
    SELECT *
    FROM campaign_record_links
    WHERE campaign_id=? AND revoked_at IS NULL
    ORDER BY created_at,id
    LIMIT ? OFFSET ?
  `).all(campaignId, page.activeLinks.limit, page.activeLinks.offset);
  const historyRows = db.prepare(`
    SELECT *
    FROM campaign_record_links
    WHERE campaign_id=? AND revoked_at IS NOT NULL
    ORDER BY created_at,id
    LIMIT ? OFFSET ?
  `).all(campaignId, page.linkHistory.limit, page.linkHistory.offset);
  const eventRows = db.prepare(`
    SELECT event.*,actor.display_name AS actor_name,actor.username AS actor_username
    FROM campaign_events event
    LEFT JOIN users actor ON actor.id=event.actor_user_id
    WHERE event.campaign_id=?
    ORDER BY event.created_at,event.id
    LIMIT ? OFFSET ?
  `).all(campaignId, page.events.limit, page.events.offset);
  const events = eventRows.map(eventProjectionFromRow);
  const eventReferences = events.flatMap((event) => (
    ['link_attached', 'link_revoked', 'link_moved'].includes(event.event_type)
      ? [{
          record_type: event.metadata.record_type,
          record_id: event.metadata.record_id
        }]
      : []
  ));
  const references = [
    ...activeRows,
    ...historyRows,
    ...eventReferences
  ];
  const targets = workspaceTargetRows(db, references);
  const custody = workspaceCustodyRows(db, references);
  const organizationOwners = workspaceOrganizationOwners(
    db,
    campaignAccess.campaign.org_id,
    targets
  );
  const movedCampaignIds = events.flatMap((event) => (
    event.event_type === 'link_moved'
      ? [
          event.metadata.source_campaign_id,
          event.metadata.destination_campaign_id
        ]
      : []
  ));
  const context = {
    actor,
    campaignAccess,
    targets,
    custody,
    organizationOwners,
    accessibleCampaignIds: workspaceAccessibleCampaignIds(
      db,
      userId,
      movedCampaignIds
    )
  };
  const activeLinks = Object.fromEntries(
    WORKSPACE_RELATIONS.map((relation) => [relation, []])
  );
  const activeRestricted = new Map();
  const historyRestricted = new Map();
  const linkHistory = [];
  for (const row of activeRows) {
    const state = workspaceTargetState(context, row, campaignId);
    if (state === 'available') {
      const target = targets.get(workspaceTargetKey(
        row.record_type,
        row.record_id
      ));
      activeLinks[row.relation_type].push(workspaceLinkProjectionWithLabel(
        row,
        workspaceTargetLabel(row.record_type, row.record_id, target)
      ));
    } else {
      activeRestricted.set(
        row.relation_type,
        (activeRestricted.get(row.relation_type) || 0) + 1
      );
    }
  }
  for (const row of historyRows) {
    const state = workspaceTargetState(context, row, campaignId);
    if (state === 'available') {
      const target = targets.get(workspaceTargetKey(
        row.record_type,
        row.record_id
      ));
      linkHistory.push(workspaceLinkProjectionWithLabel(
        row,
        workspaceTargetLabel(row.record_type, row.record_id, target)
      ));
    } else if (state === 'missing') {
      linkHistory.push(missingWorkspaceLink(row));
    } else {
      historyRestricted.set(
        row.relation_type,
        (historyRestricted.get(row.relation_type) || 0) + 1
      );
    }
  }
  for (const relation of WORKSPACE_RELATIONS) {
    const count = activeRestricted.get(relation);
    if (count) {
      activeLinks[relation].push(restrictedWorkspaceLink(relation, count));
    }
  }
  for (const relation of [...historyRestricted.keys()].sort()) {
    linkHistory.push(restrictedWorkspaceLink(
      relation,
      historyRestricted.get(relation)
    ));
  }
  return {
    campaign: campaignProjection(db, campaignId),
    active_links: activeLinks,
    link_history: linkHistory,
    events: events.map((event) => workspaceEventProjection(context, event)),
    workflow_dispatches: [],
    pagination: {
      active_links: {
        total: totals.active_total,
        limit: page.activeLinks.limit,
        offset: page.activeLinks.offset
      },
      link_history: {
        total: totals.history_total,
        limit: page.linkHistory.limit,
        offset: page.linkHistory.offset
      },
      events: {
        total: totals.event_total,
        limit: page.events.limit,
        offset: page.events.offset
      }
    }
  };
}

function safeTags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function knowledgeFtsMatch(q) {
  if (!q) return '';
  const terms = q.match(/[\p{L}\p{N}_-]+/gu) || [];
  if (terms.length === 0) return null;
  return terms.map((term) => (
    `"${term.replace(/"/g, '""')}"`
  )).join(' OR ');
}

function normalizedKnowledgeFilters(query) {
  assertQueryKeys(query, [
    'q',
    'source_type',
    'entry_type',
    'visibility',
    'tag',
    'linked',
    'limit',
    'offset'
  ]);
  const visibility = query.visibility;
  if (
    visibility !== undefined &&
    visibility !== 'private' &&
    visibility !== 'team'
  ) {
    throw invalidInput('visibility is invalid.');
  }
  const linked = query.linked === undefined ? 'all' : query.linked;
  if (!['all', 'true', 'false'].includes(linked)) {
    throw invalidInput('linked is invalid.');
  }
  return {
    q: boundedQuery(query.q, 200, 'q'),
    sourceType: boundedQuery(query.source_type, 120, 'source_type'),
    entryType: boundedQuery(query.entry_type, 120, 'entry_type'),
    visibility,
    tag: boundedQuery(query.tag, 80, 'tag'),
    linked,
    limit: boundedInteger(query.limit, 20, 1, 100, 'limit'),
    offset: boundedInteger(query.offset, 0, 0, SAFE_MAX, 'offset')
  };
}

function projectedKnowledgeVisibilitySql(entryAlias) {
  return `CASE
    WHEN ${entryAlias}.visibility='private' THEN 'private'
    WHEN ${entryAlias}.visibility IN ('team','public','shared') THEN 'team'
    WHEN ${entryAlias}.visibility IS NULL AND ${entryAlias}.is_public=1 THEN 'team'
    ELSE 'private'
  END`;
}

function knowledgeQueryDefinition({
  userId,
  campaignId,
  actor,
  filters,
  entryId = null
}) {
  const visibility = projectedKnowledgeVisibilitySql('entry');
  const ftsMatch = knowledgeFtsMatch(filters.q);
  const hasSearch = ftsMatch !== '';
  const detailPredicate = entryId === null
    ? ''
    : 'AND entry.id=@entryId';
  const searchSql = hasSearch && ftsMatch !== null
    ? `,
    search_rows AS MATERIALIZED (
      SELECT
        CAST(knowledge_chunks_fts.entry_id AS INTEGER) AS entry_id,
        bm25(knowledge_chunks_fts) AS search_rank
      FROM knowledge_chunks_fts
      JOIN filtered
        ON filtered.id=CAST(knowledge_chunks_fts.entry_id AS INTEGER)
      WHERE knowledge_chunks_fts MATCH @ftsMatch
    ),
    ranked AS MATERIALIZED (
      SELECT filtered.*,MIN(search_rows.search_rank) AS search_rank
      FROM filtered
      JOIN search_rows ON search_rows.entry_id=filtered.id
      GROUP BY filtered.id
    )`
    : '';
  return {
    sql: `
      WITH custody_rows AS MATERIALIZED (
        SELECT
          CAST(link.record_id AS INTEGER) AS entry_id,
          link.campaign_id,
          ROW_NUMBER() OVER (
            PARTITION BY link.record_id
            ORDER BY
              CASE WHEN link.revoked_at IS NULL THEN 0 ELSE 1 END,
              link.revoked_at DESC,
              link.id DESC
          ) AS custody_rank
        FROM campaign_record_links link
        WHERE link.record_type='knowledge_entry'
          AND link.relation_type<>'shortlist'
      ),
      current_custody AS MATERIALIZED (
        SELECT entry_id,campaign_id
        FROM custody_rows
        WHERE custody_rank=1
      ),
      authorized AS MATERIALIZED (
        SELECT
          entry.*,
          ${visibility} AS projected_visibility,
          CASE
            WHEN custody.entry_id IS NULL THEN 'available'
            ELSE 'linked'
          END AS link_state
        FROM knowledge_entries entry
        LEFT JOIN current_custody custody ON custody.entry_id=entry.id
        WHERE (
          custody.entry_id IS NULL
          OR custody.campaign_id=@campaignId
        )
          AND (
            @isPlatformAdmin=1
            OR entry.created_by=@userId
            OR ${visibility}='team'
          )
          ${detailPredicate}
      ),
      filtered AS MATERIALIZED (
        SELECT *
        FROM authorized
        WHERE (@sourceType='' OR source_type=@sourceType)
          AND (@entryType='' OR entry_type=@entryType)
          AND (@visibility='' OR projected_visibility=@visibility)
          AND (
            @tag=''
            OR (
              json_valid(tags_json)
              AND json_type(tags_json)='array'
              AND NOT EXISTS (
                SELECT 1
                FROM json_each(tags_json)
                WHERE type<>'text'
              )
              AND EXISTS (
                SELECT 1
                FROM json_each(tags_json)
                WHERE type='text' AND value=@tag
              )
            )
          )
          AND (
            @linked='all'
            OR (@linked='true' AND link_state='linked')
            OR (@linked='false' AND link_state='available')
          )
      )
      ${searchSql}
    `,
    table: hasSearch ? 'ranked' : 'filtered',
    hasSearch,
    impossibleSearch: ftsMatch === null,
    params: {
      userId,
      campaignId,
      isPlatformAdmin: actor.role === 'admin' ? 1 : 0,
      sourceType: filters.sourceType,
      entryType: filters.entryType,
      visibility: filters.visibility || '',
      tag: filters.tag,
      linked: filters.linked,
      ...(entryId === null ? {} : { entryId }),
      ...(hasSearch && ftsMatch !== null ? { ftsMatch } : {})
    }
  };
}

function campaignKnowledgeItem(row) {
  return {
    id: row.id,
    title: row.title || '',
    summary: row.summary || '',
    tags: safeTags(row.tags_json),
    entry_type: row.entry_type,
    source_type: row.source_type,
    visibility: row.projected_visibility,
    usage_count: row.usage_count || 0,
    citation_count: row.citation_count,
    updated_at: row.updated_at,
    link_state: row.link_state
  };
}

function listCampaignKnowledge(db, input) {
  const userId = bodyId(input.userId, 'user_id');
  const campaignId = canonicalId(input.campaignId);
  if (campaignId === null) throw invalidInput('Campaign id is invalid.');
  requireCampaignAccess(db, userId, campaignId);
  const filters = normalizedKnowledgeFilters(input.query || {});
  const actor = readActor(db, userId);
  if (!actor) {
    throw new CampaignServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  const definition = knowledgeQueryDefinition({
    userId,
    campaignId,
    actor,
    filters
  });
  if (definition.impossibleSearch) {
    return {
      items: [],
      total: 0,
      limit: filters.limit,
      offset: filters.offset
    };
  }
  const total = db.prepare(`
    ${definition.sql}
    SELECT COUNT(*) AS count
    FROM ${definition.table}
  `).get(definition.params).count;
  const order = definition.hasSearch
    ? 'search_rank,updated_at DESC,id DESC'
    : 'updated_at DESC,id DESC';
  const rows = db.prepare(`
    ${definition.sql},
    page AS MATERIALIZED (
      SELECT *
      FROM ${definition.table}
      ORDER BY ${order}
      LIMIT @limit OFFSET @offset
    ),
    citation_counts AS (
      SELECT
        reference.knowledge_entry_id AS entry_id,
        COUNT(DISTINCT reference.message_id) AS citation_count
      FROM ai_references reference
      JOIN page ON page.id=reference.knowledge_entry_id
      GROUP BY reference.knowledge_entry_id
    )
    SELECT
      page.*,
      COALESCE(citation_counts.citation_count,0) AS citation_count
    FROM page
    LEFT JOIN citation_counts ON citation_counts.entry_id=page.id
    ORDER BY ${order}
  `).all({
    ...definition.params,
    limit: filters.limit,
    offset: filters.offset
  });
  return {
    items: rows.map(campaignKnowledgeItem),
    total,
    limit: filters.limit,
    offset: filters.offset
  };
}

function knowledgeNotFound() {
  return new CampaignServiceError(
    404,
    'KNOWLEDGE_ENTRY_NOT_FOUND',
    'Knowledge entry was not found.'
  );
}

function getCampaignKnowledgeDetail(db, input) {
  const userId = bodyId(input.userId, 'user_id');
  const campaignId = canonicalId(input.campaignId);
  const entryId = canonicalId(input.entryId);
  if (campaignId === null || entryId === null) throw knowledgeNotFound();
  assertQueryKeys(input.query || {}, []);
  const access = requireCampaignAccess(db, userId, campaignId);
  const actor = readActor(db, userId);
  if (!actor) {
    throw new CampaignServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  const definition = knowledgeQueryDefinition({
    userId,
    campaignId,
    actor,
    entryId,
    filters: {
      q: '',
      sourceType: '',
      entryType: '',
      visibility: '',
      tag: '',
      linked: 'all'
    }
  });
  const row = db.prepare(`
    ${definition.sql}
    SELECT
      filtered.*,
      (
        SELECT COUNT(DISTINCT reference.message_id)
        FROM ai_references reference
        WHERE reference.knowledge_entry_id=filtered.id
      ) AS citation_count
    FROM filtered
  `).get(definition.params);
  if (!row) throw knowledgeNotFound();
  return {
    entry: {
      id: row.id,
      title: row.title || '',
      summary: row.summary || '',
      content: row.content || '',
      tags: safeTags(row.tags_json),
      entry_type: row.entry_type,
      source_type: row.source_type,
      visibility: row.projected_visibility,
      source: projectKnowledgeSource(row.source_type),
      created_at: row.created_at,
      updated_at: row.updated_at,
      link_state: row.link_state
    },
    usage_count: row.usage_count || 0,
    citation_count: row.citation_count,
    can_manage: Boolean(
      access.permissions.write &&
      (actor.role === 'admin' || row.created_by === userId)
    ),
    can_use_in_ai: true
  };
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeReviewBody(body) {
  const allowed = [
    'expected_version',
    'title',
    'summary',
    'content',
    'tags',
    'visibility',
    'reason'
  ];
  assertBodyKeys(body, allowed, allowed);
  if (
    !Array.isArray(body.tags) ||
    body.tags.length > 20 ||
    body.tags.some((tag) => typeof tag !== 'string')
  ) {
    throw invalidInput('tags is invalid.');
  }
  const tags = body.tags.map((tag) => scalarText(tag, 'tag', 1, 80));
  const sorted = [...new Set(tags)].sort(compareUtf8);
  if (
    sorted.length !== tags.length ||
    sorted.some((tag, index) => tag !== tags[index])
  ) {
    throw invalidInput('tags must be unique and UTF-8 sorted.');
  }
  if (body.visibility !== 'private' && body.visibility !== 'team') {
    throw invalidInput('visibility is invalid.');
  }
  return {
    expected_version: bodyId(body.expected_version, 'expected_version'),
    title: scalarText(body.title, 'title', 1, 200),
    summary: scalarText(body.summary, 'summary', 1, 1000),
    content: scalarText(body.content, 'content', 1, 50000),
    tags,
    visibility: body.visibility,
    reason: scalarText(body.reason, 'reason', 1, 1000)
  };
}

function requireSettledEvent(db, campaignId) {
  const event = db.prepare(`
    SELECT id
    FROM campaign_events
    WHERE campaign_id=?
      AND event_type='lifecycle_transition'
      AND next_state='settled'
    ORDER BY created_at DESC,id DESC
    LIMIT 1
  `).get(campaignId);
  if (!event) {
    throw new CampaignServiceError(
      409,
      'STALE_CAMPAIGN_STATE',
      'Campaign has no settled lifecycle evidence.'
    );
  }
  return event;
}

function classifyExistingReview(db, campaignId, sourceId) {
  const entry = db.prepare(`
    SELECT id FROM knowledge_entries
    WHERE source_type='campaign_review' AND CAST(source_id AS TEXT)=?
  `).get(sourceId);
  if (!entry) return;
  const links = db.prepare(`
    SELECT campaign_id,bundle_id,relation_type,revoked_at
    FROM campaign_record_links
    WHERE record_type='knowledge_entry' AND record_id=?
    ORDER BY relation_type,id
  `).all(String(entry.id));
  const relationTypes = links.map((link) => link.relation_type);
  const exactPair = (
    links.length === 2 &&
    links.every((link) => link.campaign_id === campaignId) &&
    links[0].bundle_id === links[1].bundle_id &&
    JSON.stringify(relationTypes) === JSON.stringify(['knowledge', 'review'])
  );
  if (exactPair && links.every((link) => link.revoked_at === null)) {
    throw new CampaignServiceError(
      409,
      'RECORD_ALREADY_LINKED',
      'Campaign review is already linked.'
    );
  }
  if (exactPair && links.every((link) => link.revoked_at !== null)) {
    throw new CampaignServiceError(
      409,
      'RECORD_REQUIRES_LINK_CORRECTION',
      'Campaign review requires link correction.'
    );
  }
  throw campaignEvidenceInUse();
}

function createCampaignReview(db, input) {
  const body = normalizeReviewBody(input.body);
  const campaignId = canonicalId(input.campaignId);
  const userId = bodyId(input.userId, 'user_id');
  if (campaignId === null) throw invalidInput('Campaign id is invalid.');
  const initialAccess = requireCampaignAccess(db, userId, campaignId);
  if (!initialAccess.permissions.write) {
    throw campaignOperationalError(initialAccess.campaign.operational_status);
  }
  const settledEvent = requireSettledEvent(db, campaignId);
  return runCampaignMutation(db, {
    ...input,
    method: 'POST',
    path: `/api/campaigns/${input.campaignId}/reviews`,
    body,
    scope: 'campaign.review.create',
    expectedEventCount: 1,
    authorize: ({ access }) => {
      if (!access.permissions.write) {
        throw campaignOperationalError(access.campaign.operational_status);
      }
      const currentEvent = requireSettledEvent(db, campaignId);
      if (currentEvent.id !== settledEvent.id) {
        throw campaignEvidenceInUse('Settled lifecycle evidence changed.');
      }
    }
  }, ({ access, auditFingerprint }) => {
    if (access.campaign.operational_status !== 'active') {
      throw campaignOperationalError(access.campaign.operational_status);
    }
    if (access.campaign.lifecycle_state !== 'settled') {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_STATE',
        'Campaign state is stale.',
        { current_state: access.campaign.lifecycle_state }
      );
    }
    if (access.campaign.row_version !== body.expected_version) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_VERSION',
        'Campaign version is stale.',
        { current_version: access.campaign.row_version }
      );
    }
    if (body.expected_version >= SAFE_MAX) {
      throw new CampaignServiceError(
        409,
        'ROW_VERSION_EXHAUSTED',
        'Campaign row version is exhausted.'
      );
    }
    const settledInTransaction = requireSettledEvent(db, campaignId);
    if (settledInTransaction.id !== settledEvent.id) {
      throw campaignEvidenceInUse('Settled lifecycle evidence changed.');
    }
    const sourceId = `${campaignId}:${settledEvent.id}`;
    classifyExistingReview(db, campaignId, sourceId);
    const storedTags = [...new Set([
      ...body.tags,
      'campaign',
      'review'
    ])].sort(compareUtf8);
    let written;
    try {
      written = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        createdBy: userId,
        sourceType: 'campaign_review',
        sourceId,
        entryType: 'campaign_review',
        title: body.title,
        summary: body.summary,
        content: body.content,
        tags: storedTags,
        visibility: body.visibility,
        metadata: { settled_event_id: settledEvent.id }
      });
    } catch (error) {
      if (error instanceof knowledgeService.CampaignKnowledgeCapacityError) {
        throw new CampaignServiceError(
          507,
          'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED',
          'Knowledge storage capacity was exceeded.'
        );
      }
      if (error instanceof knowledgeService.CampaignKnowledgeConflictError) {
        throw campaignEvidenceInUse();
      }
      throw error;
    }
    if (written.status !== 'created') throw campaignEvidenceInUse();
    const bundleId = randomBytes(32).toString('hex');
    const linkInsert = db.prepare(`
      INSERT INTO campaign_record_links (
        org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json
      ) VALUES (?,?,?,?,?,?,?,?)
    `);
    const knowledgeLink = linkInsert.run(
      access.campaign.org_id,
      campaignId,
      'knowledge_entry',
      bundleId,
      String(written.entry.id),
      'knowledge',
      userId,
      '{}'
    );
    const reviewLink = linkInsert.run(
      access.campaign.org_id,
      campaignId,
      'knowledge_entry',
      bundleId,
      String(written.entry.id),
      'review',
      userId,
      JSON.stringify({ settled_event_id: settledEvent.id })
    );
    const linkIds = [
      Number(knowledgeLink.lastInsertRowid),
      Number(reviewLink.lastInsertRowid)
    ].sort((left, right) => left - right);
    const nextVersion = body.expected_version + 1;
    const update = db.prepare(`
      UPDATE campaigns
      SET row_version=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND lifecycle_state='settled'
        AND operational_status='active' AND row_version=?
    `).run(nextVersion, campaignId, body.expected_version);
    if (update.changes !== 1) {
      throw new CampaignServiceError(
        409,
        'STALE_CAMPAIGN_VERSION',
        'Campaign version is stale.',
        { current_version: access.campaign.row_version }
      );
    }
    const event = insertCampaignEvent(db, {
      orgId: access.campaign.org_id,
      campaignId,
      eventType: 'link_attached',
      previousState: null,
      nextState: null,
      actorUserId: userId,
      reason: body.reason,
      source: 'campaign_review',
      metadata: {
        bundle_id: bundleId,
        relation_types: ['knowledge', 'review'],
        record_type: 'knowledge_entry',
        record_id: String(written.entry.id),
        link_ids: linkIds
      },
      correlationId: input.requestId,
      auditFingerprint
    });
    const links = db.prepare(`
      SELECT * FROM campaign_record_links
      WHERE id IN (?,?)
      ORDER BY relation_type,id
    `).all(...linkIds).map((row) => workspaceLinkProjection(db, row));
    return {
      status: 201,
      body: {
        campaign: campaignProjection(db, campaignId),
        entry: {
          id: written.entry.id,
          title: body.title,
          summary: body.summary,
          tags: body.tags,
          visibility: body.visibility
        },
        links,
        event
      }
    };
  });
}

function requireOrganization(db, userId) {
  const scope = resolveOrganizationScope(db, {
    userId,
    repairMissing: false
  });
  if (!scope.ok) {
    throw new CampaignServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  return scope;
}

function getOpportunityOptions(db, userId, query, page) {
  const scope = requireOrganization(db, userId);
  const actor = db.prepare(`
    SELECT id,role
    FROM users
    WHERE id=? AND is_active=1
  `).get(userId);
  if (!actor) {
    throw new CampaignServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  const q = boundedQuery(query.q, 160, 'q');
  const sql = `
    WITH eligible AS MATERIALIZED (
      SELECT
        opportunity.id,
        opportunity.customer_id,
        COALESCE(
          NULLIF(customer.brand_name,''),
          NULLIF(customer.company_name,''),
          'Customer #' || customer.id
        ) || ' / ' || COALESCE(
          NULLIF(opportunity.name,''),
          'Opportunity #' || opportunity.id
        ) AS label
      FROM opportunities opportunity
      JOIN customers customer ON customer.id=opportunity.customer_id
      WHERE (
        @isAdmin=1
        OR opportunity.created_by=@userId
        OR customer.assigned_to=@userId
        OR customer.created_by=@userId
      )
    ),
    filtered AS (
      SELECT id,customer_id,label
      FROM eligible
      WHERE @q='' OR instr(lower(label),lower(@q))>0
    )
  `;
  const params = {
    isAdmin: actor.role === 'admin' ? 1 : 0,
    userId,
    q
  };
  const total = db.prepare(`
    ${sql}
    SELECT COUNT(*) AS count
    FROM filtered
  `).get(params).count;
  const rows = db.prepare(`
    ${sql}
    SELECT id,customer_id,label
    FROM filtered
    ORDER BY id
    LIMIT @limit OFFSET @offset
  `).all({
    ...params,
    limit: page.limit,
    offset: page.offset
  }).map((row) => ({
    id: row.id,
    label: row.label,
    customer_id: row.customer_id
  }));
  return {
    resource: 'opportunities',
    items: rows,
    total,
    limit: page.limit,
    offset: page.offset,
    organizationId: scope.authContext.organization.id
  };
}

function getAssignmentOptions(db, userId, query, page) {
  const scope = requireOrganization(db, userId);
  const organization = scope.authContext.organization;
  const campaignId = query.mode === 'transfer'
    ? canonicalId(query.campaign_id)
    : null;
  let campaignAccess = null;
  if (query.mode === 'transfer') {
    campaignAccess = getCampaignAccess(db, { userId, campaignId });
    if (!campaignAccess.ok) {
      throw new CampaignServiceError(
        campaignAccess.status,
        campaignAccess.code,
        campaignAccess.code === 'CAMPAIGN_NOT_FOUND'
          ? 'Campaign was not found.'
          : 'Campaign access is forbidden.'
      );
    }
    if (campaignAccess.role !== 'org_admin' && campaignAccess.role !== 'owner') {
      throw new CampaignServiceError(
        403,
        'CAMPAIGN_FORBIDDEN',
        'Campaign transfer is forbidden.'
      );
    }
  }
  const q = boundedQuery(query.q, 160, 'q');
  const authorizationSql = organization.role_code === 'org_admin'
    ? '1=1'
    : `EXISTS (
        SELECT 1
        FROM team_memberships actor_membership
        WHERE actor_membership.org_id=team.org_id
          AND actor_membership.team_id=team.id
          AND actor_membership.user_id=@actorUserId
          AND actor_membership.status='active'
          AND (
            @mode='transfer'
            OR actor_membership.role_code='team_lead'
            OR membership.user_id=@actorUserId
          )
      )`;
  const params = {
    organizationId: organization.id,
    actorUserId: userId,
    mode: query.mode,
    q
  };
  const sql = `
    WITH authorized_assignments AS (
      SELECT
        team.id AS team_id,
        team.name AS team_label,
        owner.id AS owner_id,
        owner.display_name AS owner_label
      FROM teams team
      JOIN team_memberships membership
        ON membership.org_id=team.org_id
       AND membership.team_id=team.id
       AND membership.status='active'
      JOIN organization_memberships organization_membership
        ON organization_membership.org_id=membership.org_id
       AND organization_membership.user_id=membership.user_id
       AND organization_membership.status='active'
      JOIN users owner
        ON owner.id=membership.user_id
       AND owner.is_active=1
      WHERE team.org_id=@organizationId
        AND ${authorizationSql}
        AND (
          @q=''
          OR instr(lower(team.name),lower(@q))>0
          OR instr(lower(owner.display_name),lower(@q))>0
        )
    )
  `;
  const total = db.prepare(`
    ${sql}
    SELECT COUNT(*) AS count
    FROM authorized_assignments
  `).get(params).count;
  const rows = db.prepare(`
    ${sql}
    SELECT team_id,team_label,owner_id,owner_label
    FROM authorized_assignments
    ORDER BY team_label,team_id,owner_label,owner_id
    LIMIT @limit OFFSET @offset
  `).all({
    ...params,
    limit: page.limit,
    offset: page.offset
  }).map((row) => ({
    team: { id: row.team_id, label: row.team_label },
    owner: { id: row.owner_id, label: row.owner_label }
  }));
  return {
    resource: 'assignments',
    items: rows,
    total,
    limit: page.limit,
    offset: page.offset
  };
}

function createCampaignService(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('A SQLite database is required');
  }

  return Object.freeze({
    getOptions({ userId, query = {} }) {
      assertQueryKeys(query, [
        'mode',
        'resource',
        'q',
        'limit',
        'offset',
        'campaign_id'
      ]);
      if (query.mode !== 'create' && query.mode !== 'transfer') {
        throw invalidInput('mode is invalid.');
      }
      if (query.resource !== 'opportunities' && query.resource !== 'assignments') {
        throw invalidInput('resource is invalid.');
      }
      if (query.mode === 'transfer' && query.resource === 'opportunities') {
        throw invalidInput('Transfer opportunity options are not supported.');
      }
      if (query.mode === 'transfer' && canonicalId(query.campaign_id) === null) {
        throw invalidInput('campaign_id is required for transfer.');
      }
      if (query.mode === 'create' && query.campaign_id !== undefined) {
        throw invalidInput('campaign_id is invalid for create.');
      }
      const page = {
        limit: boundedInteger(query.limit, 25, 1, 50, 'limit'),
        offset: boundedInteger(query.offset, 0, 0, SAFE_MAX, 'offset')
      };
      if (query.resource === 'opportunities') {
        const result = getOpportunityOptions(db, userId, query, page);
        delete result.organizationId;
        return result;
      }
      return getAssignmentOptions(db, userId, query, page);
    },
    createCampaign(input) {
      return createCampaign(db, input);
    },
    listCampaigns(input) {
      return listCampaigns(db, input);
    },
    getCampaignDetail(input) {
      return getCampaignDetail(db, input);
    },
    updateCampaign(input) {
      return updateCampaign(db, input);
    },
    transitionCampaign(input) {
      return transitionCampaign(db, input);
    },
    operationalAction(input) {
      return operationalAction(db, input);
    },
    transferCampaign(input) {
      return transferCampaign(db, input);
    },
    attachCampaignLink(input) {
      return attachCampaignLink(db, input);
    },
    correctCampaignLink(input) {
      return correctCampaignLink(db, input);
    },
    listCampaignLinkCandidates(input) {
      return listCampaignLinkCandidates(db, input);
    },
    getCampaignWorkspace(input) {
      return getCampaignWorkspace(db, input);
    },
    listCampaignKnowledge(input) {
      return listCampaignKnowledge(db, input);
    },
    getCampaignKnowledgeDetail(input) {
      return getCampaignKnowledgeDetail(db, input);
    },
    createCampaignReview(input) {
      return createCampaignReview(db, input);
    },
    campaignProjection(campaignId) {
      return campaignProjection(db, campaignId);
    }
  });
}

module.exports = {
  CampaignServiceError,
  createCampaignService
};
