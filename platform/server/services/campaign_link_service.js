'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');

const idempotencyService = require('./idempotency_service');
const knowledgeService = require('./knowledge_service');
const { requestHash } = require('./sqlite_digest_service');
const {
  getCampaignAccess,
  getTargetAccess
} = require('./campaign_access_service');

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const DEMAND_FIELDS = Object.freeze([
  'campaign_id',
  'brand_name',
  'company_name',
  'product_name',
  'industry',
  'budget',
  'target_market',
  'platform',
  'data_json'
]);
const PROPOSAL_FIELDS = Object.freeze([
  'campaign_id',
  'demand_id',
  'template_id',
  'content'
]);

class CampaignLinkServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'CampaignLinkServiceError';
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new CampaignLinkServiceError(statusCode, code, message, details);
}

function invalidInput(message = 'Invalid campaign-linked request.') {
  return serviceError(400, 'INVALID_CAMPAIGN_INPUT', message);
}

function snapshotBody(value, allowedFields, requiredFields) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidInput('Request body must be a plain JSON object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => (
      typeof key !== 'string' ||
      !allowedFields.includes(key) ||
      !descriptors[key] ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], 'value')
    )) ||
    requiredFields.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    throw invalidInput('Request fields do not match the linked route contract.');
  }
  const snapshot = {};
  for (const key of keys) snapshot[key] = descriptors[key].value;
  return snapshot;
}

function positiveSafeId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > SAFE_MAX) {
    throw invalidInput(`${label} is invalid.`);
  }
  return value;
}

function validScalarText(value, label, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalidInput(`${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw invalidInput(`${label} is invalid.`);
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (normalized.includes('\u0000')) throw invalidInput(`${label} is invalid.`);
  for (const point of normalized) {
    const codePoint = point.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw invalidInput(`${label} is invalid.`);
    }
  }
  return normalized;
}

function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw serviceError(
      400,
      'IDEMPOTENCY_REQUIRED',
      'A valid Idempotency-Key is required.'
    );
  }
  return value;
}

function normalizeDemandBody(value) {
  const body = snapshotBody(value, DEMAND_FIELDS, ['campaign_id']);
  return Object.freeze({
    campaign_id: positiveSafeId(body.campaign_id, 'campaign_id'),
    brand_name: validScalarText(body.brand_name, 'brand_name'),
    company_name: validScalarText(body.company_name, 'company_name'),
    product_name: validScalarText(body.product_name, 'product_name'),
    industry: validScalarText(body.industry, 'industry'),
    budget: validScalarText(body.budget, 'budget'),
    target_market: validScalarText(body.target_market, 'target_market'),
    platform: validScalarText(body.platform, 'platform'),
    data_json: Object.hasOwn(body, 'data_json') ? body.data_json : null
  });
}

function normalizeProposalBody(value) {
  const body = snapshotBody(
    value,
    PROPOSAL_FIELDS,
    ['campaign_id', 'demand_id', 'template_id', 'content']
  );
  return Object.freeze({
    campaign_id: positiveSafeId(body.campaign_id, 'campaign_id'),
    demand_id: positiveSafeId(body.demand_id, 'demand_id'),
    template_id: validScalarText(body.template_id, 'template_id', { required: true }),
    content: validScalarText(body.content, 'content', { required: true })
  });
}

function requireCampaignAccess(db, userId, campaignId) {
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) {
    throw serviceError(
      access.status,
      access.code,
      access.code === 'CAMPAIGN_NOT_FOUND'
        ? 'Campaign was not found.'
        : 'Campaign access is forbidden.'
    );
  }
  return access;
}

function requireProposalParentAccess(db, userId, campaignId, demandId) {
  const access = getTargetAccess(db, {
    userId,
    campaignId,
    recordType: 'demand',
    recordId: demandId,
    relationType: 'demand',
    intent: 'read'
  });
  if (!access.ok) {
    const messages = {
      CAMPAIGN_NOT_FOUND: 'Campaign was not found.',
      CAMPAIGN_FORBIDDEN: 'Campaign access is forbidden.',
      TARGET_NOT_FOUND: 'Proposal demand was not found.',
      TARGET_FORBIDDEN: 'Proposal demand access is forbidden.'
    };
    throw serviceError(
      access.status,
      access.code,
      messages[access.code] || 'Proposal demand access failed.'
    );
  }
  return access;
}

function operationalError(status) {
  return serviceError(
    409,
    status === 'cancelled' ? 'CAMPAIGN_CANCELLED' : 'CAMPAIGN_ON_HOLD',
    status === 'cancelled' ? 'Campaign is cancelled.' : 'Campaign is on hold.',
    { operational_status: status }
  );
}

function assertCampaignWritable(access) {
  if (!access.permissions.write) {
    throw operationalError(access.campaign.operational_status);
  }
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
    throw serviceError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'The idempotency key was already used for a different request.'
    );
  }
  if (result.state === 'processing') {
    const error = serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'The idempotent request is still processing.'
    );
    error.retryAfterSeconds = Math.max(1, result.retryAfterSeconds || 1);
    throw error;
  }
  if (result.state === 'expired') {
    throw serviceError(
      410,
      'IDEMPOTENCY_EXPIRED',
      'The retained idempotent response expired.'
    );
  }
  throw new Error('Unexpected idempotency disposition');
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

function retainedOperationError(error) {
  if (error instanceof CampaignLinkServiceError) return error;
  if (
    error instanceof knowledgeService.CampaignKnowledgeCapacityError ||
    error instanceof knowledgeService.CampaignKnowledgeConflictError
  ) {
    return serviceError(
      error.statusCode,
      error.code,
      error.message,
      error.details
    );
  }
  return null;
}

function runLinkedMutation(db, input, operation) {
  const userId = positiveSafeId(input.userId, 'user_id');
  const campaignId = positiveSafeId(input.campaignId, 'campaign_id');
  const key = requireIdempotencyKey(input.idempotencyKey);
  const initialAccess = requireCampaignAccess(db, userId, campaignId);
  if (input.authorize) input.authorize(initialAccess);
  const hash = requestHash({
    method: 'POST',
    path: input.path,
    campaignId,
    kind: 'json',
    payload: input.body
  });
  const reservationInput = {
    organizationId: initialAccess.campaign.org_id,
    actorUserId: userId,
    campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: input.scope,
    key,
    requestHash: hash,
    expectedEventCount: 1,
    operationTimeoutSeconds: 60
  };

  return db.transaction(() => {
    const access = requireCampaignAccess(db, userId, campaignId);
    if (input.authorize) input.authorize(access);
    let reservation = idempotencyService.recoverExpiredInTransaction(
      db,
      reservationInput
    );
    if (reservation.state === 'absent') {
      reservation = idempotencyService.reserveProcessingInTransaction(
        db,
        reservationInput
      );
    }
    if (reservation.state !== 'reserved') {
      return idempotencyDisposition(reservation);
    }

    db.exec('SAVEPOINT campaign_link_operation');
    try {
      const outcome = operation({
        access,
        auditFingerprint: reservation.auditFingerprint,
        campaignId,
        requestHash: hash,
        userId
      });
      db.exec('RELEASE SAVEPOINT campaign_link_operation');
      idempotencyService.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: outcome.status,
        responseBody: outcome.body
      });
      return { status: outcome.status, body: outcome.body, headers: {} };
    } catch (error) {
      const retained = retainedOperationError(error);
      if (!retained) throw error;
      db.exec('ROLLBACK TO SAVEPOINT campaign_link_operation');
      db.exec('RELEASE SAVEPOINT campaign_link_operation');
      const body = errorBody(retained, input.requestId);
      idempotencyService.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: retained.statusCode,
        responseBody: body
      });
      return { status: retained.statusCode, body, headers: {} };
    }
  }).immediate();
}

function insertRecordLink(db, values) {
  const bundleId = crypto.randomBytes(32).toString('hex');
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    values.organizationId,
    values.campaignId,
    values.recordType,
    bundleId,
    String(values.recordId),
    values.relationType,
    values.userId,
    JSON.stringify(values.metadata || {})
  );
  return {
    id: Number(result.lastInsertRowid),
    bundleId
  };
}

function insertLinkEvent(db, values) {
  const metadata = {
    record_type: values.recordType,
    record_id: String(values.recordId),
    relation_types: [values.relationType],
    link_ids: [values.producerLink.id],
    bundle_id: values.producerLink.bundleId
  };
  const result = db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?, 'link_attached',NULL,NULL,?,?,?,?,?,?)
  `).run(
    values.organizationId,
    values.campaignId,
    values.userId,
    values.reason,
    values.source,
    JSON.stringify(metadata),
    values.requestId,
    values.auditFingerprint
  );
  return Number(result.lastInsertRowid);
}

function compactSummary(values, fallback) {
  const text = values
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' / ')
    .replace(/\s+/gu, ' ')
    .trim() || fallback;
  return Array.from(text).slice(0, 240).join('');
}

function proposalContentSha256(content) {
  return crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function refreshProducerGauges(db, values) {
  knowledgeService.refreshKnowledgeCapacityGaugesInTransaction(db, [
    { scopeType: 'user', scopeId: values.userId },
    { scopeType: 'campaign', scopeId: values.campaignId },
    { scopeType: 'organization', scopeId: values.organizationId }
  ]);
}

function archiveDemand(db, values) {
  const body = values.body;
  const written = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: values.organizationId,
    campaignId: values.campaignId,
    createdBy: values.userId,
    sourceType: 'campaign_demand',
    sourceId: values.demandId,
    entryType: 'campaign_demand',
    title: `需求归档：${body.brand_name || body.product_name || values.demandId}`,
    summary: compactSummary(
      [body.brand_name, body.product_name, body.industry, body.target_market, body.budget],
      `需求记录 #${values.demandId}`
    ),
    content: JSON.stringify({
      brand_name: body.brand_name,
      company_name: body.company_name,
      product_name: body.product_name,
      industry: body.industry,
      budget: body.budget,
      target_market: body.target_market,
      platform: body.platform,
      data_json: body.data_json
    }, null, 2),
    tags: ['demand', body.industry, body.target_market].filter(Boolean),
    visibility: 'private',
    metadata: {
      producer_type: 'demand',
      producer_id: values.demandId
    }
  });
  if (written.status !== 'created') {
    throw new knowledgeService.CampaignKnowledgeConflictError(
      'Demand archive source identity is already in use'
    );
  }
  return written;
}

function archiveProposal(db, values) {
  const body = values.body;
  const written = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: values.organizationId,
    campaignId: values.campaignId,
    createdBy: values.userId,
    sourceType: 'campaign_proposal',
    sourceId: values.proposalId,
    entryType: 'campaign_proposal',
    title: `确认方案：${body.demand_id || values.proposalId}`,
    summary: compactSummary([body.content], `方案记录 #${values.proposalId}`),
    content: body.content,
    tags: ['proposal', 'confirmed', body.template_id].filter(Boolean),
    visibility: 'team',
    metadata: {
      producer_type: 'proposal',
      producer_id: values.proposalId,
      demand_id: body.demand_id,
      template_id: body.template_id,
      content_sha256: values.contentSha256
    }
  });
  if (written.status !== 'created') {
    throw new knowledgeService.CampaignKnowledgeConflictError(
      'Proposal archive source identity is already in use'
    );
  }
  return written;
}

function createCampaignLinkService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A SQLite database is required');
  }

  function createDemand(input) {
    const body = normalizeDemandBody(input.body);
    return runLinkedMutation(db, {
      userId: input.userId,
      campaignId: body.campaign_id,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      path: '/api/demands',
      scope: 'demand.create.linked',
      body
    }, ({ access, auditFingerprint, campaignId, userId }) => {
      assertCampaignWritable(access);
      const dataJson = body.data_json === undefined
        ? null
        : JSON.stringify(body.data_json);
      const result = db.prepare(`
        INSERT INTO demands (
          user_id,brand_name,company_name,product_name,industry,budget,
          target_market,platform,data_json
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        userId,
        body.brand_name,
        body.company_name,
        body.product_name,
        body.industry,
        body.budget,
        body.target_market,
        body.platform,
        dataJson
      );
      const demandId = Number(result.lastInsertRowid);
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details,ip_address)
        VALUES (?,?,?,?,?)
      `).run(
        userId,
        'create_demand',
        'demand',
        `Created demand for ${body.brand_name || ''}`,
        input.ipAddress || null
      );
      const archive = archiveDemand(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        demandId,
        body
      });
      const producerLink = insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'demand',
        recordId: demandId,
        relationType: 'demand',
        metadata: { knowledge_entry_id: archive.entry.id }
      });
      insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: archive.entry.id,
        relationType: 'knowledge',
        metadata: { producer_type: 'demand', producer_id: demandId }
      });
      insertLinkEvent(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        requestId: input.requestId,
        auditFingerprint,
        source: 'demand_link',
        reason: 'Linked demand',
        recordType: 'demand',
        recordId: demandId,
        relationType: 'demand',
        producerLink
      });
      refreshProducerGauges(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId
      });
      return {
        status: 201,
        body: {
          id: demandId,
          campaign_id: campaignId,
          link_id: producerLink.id
        }
      };
    });
  }

  function createProposal(input) {
    const body = normalizeProposalBody(input.body);
    const authorize = () => requireProposalParentAccess(
      db,
      positiveSafeId(input.userId, 'user_id'),
      body.campaign_id,
      body.demand_id
    );
    const contentSha256 = proposalContentSha256(body.content);
    return runLinkedMutation(db, {
      userId: input.userId,
      campaignId: body.campaign_id,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      path: '/api/proposals',
      scope: 'proposal.create.linked',
      body,
      authorize
    }, ({ access, auditFingerprint, campaignId, userId }) => {
      assertCampaignWritable(access);
      const result = db.prepare(`
        INSERT INTO proposals (user_id,demand_id,template_id,content)
        VALUES (?,?,?,?)
      `).run(userId, body.demand_id, body.template_id, body.content);
      const proposalId = Number(result.lastInsertRowid);
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details,ip_address)
        VALUES (?,?,?,?,?)
      `).run(
        userId,
        'generate_proposal',
        'proposal',
        `Generated proposal with template ${body.template_id}`,
        input.ipAddress || null
      );
      const archive = archiveProposal(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        proposalId,
        contentSha256,
        body
      });
      const producerLink = insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'proposal',
        recordId: proposalId,
        relationType: 'proposal',
        metadata: {
          knowledge_entry_id: archive.entry.id,
          content_sha256: contentSha256
        }
      });
      insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: archive.entry.id,
        relationType: 'knowledge',
        metadata: { producer_type: 'proposal', producer_id: proposalId }
      });
      insertLinkEvent(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        requestId: input.requestId,
        auditFingerprint,
        source: 'proposal_link',
        reason: 'Linked proposal',
        recordType: 'proposal',
        recordId: proposalId,
        relationType: 'proposal',
        producerLink
      });
      refreshProducerGauges(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId
      });
      return {
        status: 201,
        body: {
          id: proposalId,
          campaign_id: campaignId,
          content_sha256: contentSha256
        }
      };
    });
  }

  return Object.freeze({ createDemand, createProposal });
}

module.exports = {
  CampaignLinkServiceError,
  createCampaignLinkService,
  proposalContentSha256
};
