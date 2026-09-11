'use strict';

const { createHash } = require('node:crypto');
const idempotency = require('./idempotency_service');
const knowledge = require('./knowledge_service');
const { requestHash } = require('./sqlite_digest_service');

const CONTRACT_VERSION = 'organization-methodology-promotion-v2';
const SOURCE_TYPES = new Set([
  'performance_ai_review_confirmation',
  'performance_content_analysis_confirmation'
]);
const CONFIRMATION_CONTRACTS = new Set([
  'performance-ai-review-approval-v1',
  'performance-content-analysis-approval-v1'
]);

class OrganizationMethodologyServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'OrganizationMethodologyServiceError';
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new OrganizationMethodologyServiceError(statusCode, code, message, details);
}

function positiveId(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || String(numeric) !== String(value)) {
    throw serviceError(400, 'ORGANIZATION_METHODOLOGY_INPUT_INVALID', `${label} is invalid.`);
  }
  return numeric;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const output = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sorted = expected.slice().sort();
  return keys.length === sorted.length && sorted.every((key, index) => key === keys[index]);
}

function reasonText(value, label) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || Array.from(reason).length > 500 || reason.includes('\u0000')) {
    throw serviceError(
      400,
      'ORGANIZATION_METHODOLOGY_INPUT_INVALID',
      `${label} between 1 and 500 characters is required.`
    );
  }
  return reason;
}

function normalizeRequestBody(value) {
  const body = plainObject(value);
  const expected = [
    'source_knowledge_entry_id',
    'expected_governance_version',
    'reason',
    'supersedes_knowledge_entry_id'
  ];
  if (!body || !exactKeys(body, expected)) {
    throw serviceError(400, 'ORGANIZATION_METHODOLOGY_INPUT_INVALID', 'Methodology request input is invalid.');
  }
  return {
    sourceKnowledgeEntryId: positiveId(body.source_knowledge_entry_id, 'source_knowledge_entry_id'),
    expectedGovernanceVersion: positiveId(body.expected_governance_version, 'expected_governance_version'),
    reason: reasonText(body.reason, 'A promotion request reason'),
    supersedesKnowledgeEntryId: body.supersedes_knowledge_entry_id === null
      ? null
      : positiveId(body.supersedes_knowledge_entry_id, 'supersedes_knowledge_entry_id')
  };
}

function normalizeDecisionBody(value) {
  const body = plainObject(value);
  if (!body || !exactKeys(body, ['decision', 'reason'])) {
    throw serviceError(400, 'ORGANIZATION_METHODOLOGY_INPUT_INVALID', 'Methodology decision input is invalid.');
  }
  const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
  if (!['approved', 'rejected'].includes(decision)) {
    throw serviceError(400, 'ORGANIZATION_METHODOLOGY_INPUT_INVALID', 'Methodology decision is invalid.');
  }
  return {
    decision,
    reason: reasonText(body.reason, 'A promotion decision reason')
  };
}

function normalizeIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) {
    throw serviceError(
      400,
      'ORGANIZATION_METHODOLOGY_IDEMPOTENCY_INVALID',
      'A valid Idempotency-Key is required.'
    );
  }
  return key;
}

function normalizeRequestId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 120 ||
    Buffer.byteLength(value, 'utf8') !== value.length ||
    /[^\x20-\x7e]/.test(value)
  ) {
    throw serviceError(400, 'ORGANIZATION_METHODOLOGY_INPUT_INVALID', 'Request id is invalid.');
  }
  return value;
}

function parseMetadata(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeDimensionText(value, maxLength = 1200) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function sourceRecord(db, entryId) {
  return db.prepare(`
    SELECT
      entry.*,
      custody.org_id,
      custody.campaign_id,
      governance.lineage_root_entry_id,
      governance.supersedes_entry_id,
      governance.version_no,
      governance.is_current,
      governance.quality_state,
      governance.governance_version,
      governance.reviewed_by,
      campaign.owner_user_id,
      campaign.team_id,
      opportunity.product_name,
      opportunity.channel_type,
      customer.industry
    FROM knowledge_entries entry
    JOIN knowledge_current_custody custody
      ON custody.knowledge_entry_id=entry.id AND custody.custody_state='active'
    JOIN knowledge_entry_governance governance
      ON governance.knowledge_entry_id=entry.id
    JOIN campaigns campaign
      ON campaign.org_id=custody.org_id AND campaign.id=custody.campaign_id
    LEFT JOIN opportunities opportunity ON opportunity.id=campaign.opportunity_id
    LEFT JOIN customers customer ON customer.id=campaign.customer_id
    WHERE entry.id=?
  `).get(entryId) || null;
}

function campaignAccess(db, user, campaignId) {
  const userId = positiveId(user && user.id, 'user id');
  const row = db.prepare(`
    SELECT
      campaign.id AS campaign_id,
      campaign.org_id,
      campaign.owner_user_id,
      campaign.team_id,
      account.role AS platform_role,
      membership.role_code AS organization_role,
      EXISTS (
        SELECT 1 FROM team_memberships identity_team
        WHERE identity_team.org_id=campaign.org_id
          AND identity_team.user_id=account.id
          AND identity_team.status='active'
      ) AS has_active_team,
      EXISTS (
        SELECT 1 FROM team_memberships assigned_team
        WHERE assigned_team.org_id=campaign.org_id
          AND assigned_team.team_id=campaign.team_id
          AND assigned_team.user_id=account.id
          AND assigned_team.status='active'
      ) AS assigned_team_member
    FROM campaigns campaign
    JOIN organization_memberships membership
      ON membership.org_id=campaign.org_id
     AND membership.user_id=?
     AND membership.status='active'
    JOIN users account ON account.id=membership.user_id AND account.is_active=1
    WHERE campaign.id=?
  `).get(userId, campaignId);
  if (!row || row.has_active_team !== 1) {
    throw serviceError(
      403,
      'ORGANIZATION_METHODOLOGY_FORBIDDEN',
      'Active organization and team membership is required.'
    );
  }
  const canAccessCampaign = row.organization_role === 'org_admin' ||
    row.owner_user_id === userId || row.assigned_team_member === 1;
  if (!canAccessCampaign) {
    throw serviceError(403, 'ORGANIZATION_METHODOLOGY_FORBIDDEN', 'Campaign access is required.');
  }
  return {
    userId,
    campaignId: row.campaign_id,
    organizationId: row.org_id,
    organizationRole: row.organization_role,
    platformRole: row.platform_role,
    canDecide: row.organization_role === 'org_admin'
  };
}

function campaignAuditAccess(db, user, campaignId) {
  const userId = positiveId(user && user.id, 'user id');
  try {
    const access = campaignAccess(db, user, campaignId);
    return Object.assign({}, access, { canRequest: true, supportAudit: false });
  } catch (error) {
    if (
      !(error instanceof OrganizationMethodologyServiceError) ||
      error.code !== 'ORGANIZATION_METHODOLOGY_FORBIDDEN'
    ) {
      throw error;
    }
    const support = db.prepare(`
      SELECT campaign.id AS campaign_id,campaign.org_id,account.role AS platform_role
      FROM campaigns campaign
      JOIN users account ON account.id=? AND account.is_active=1 AND account.role='admin'
      WHERE campaign.id=?
    `).get(userId, campaignId);
    if (!support) throw error;
    return {
      userId,
      campaignId: support.campaign_id,
      organizationId: support.org_id,
      organizationRole: null,
      platformRole: support.platform_role,
      canRequest: false,
      canDecide: false,
      supportAudit: true
    };
  }
}

function assertSourceShape(source, campaignId) {
  if (!source) {
    throw serviceError(404, 'ORGANIZATION_METHODOLOGY_SOURCE_NOT_FOUND', 'Knowledge source was not found.');
  }
  const metadata = parseMetadata(source.metadata_json);
  const confirmation = plainObject(metadata.confirmation) || {};
  const firstApprovedBy = Number(confirmation.approved_by);
  const eligible = source.campaign_id === campaignId &&
    SOURCE_TYPES.has(source.source_type) &&
    source.business_type === 'campaign' &&
    source.business_id === String(campaignId) &&
    source.visibility === 'team' &&
    source.is_public === 1 &&
    source.is_current === 1 &&
    ['candidate', 'confirmed'].includes(source.quality_state) &&
    CONFIRMATION_CONTRACTS.has(confirmation.contract_version) &&
    Number.isSafeInteger(firstApprovedBy) && firstApprovedBy > 0;
  if (!eligible) {
    throw serviceError(
      409,
      'ORGANIZATION_METHODOLOGY_SOURCE_INELIGIBLE',
      'Only a current, team-visible, human-confirmed performance conclusion can be promoted.'
    );
  }
  return { metadata, confirmation, firstApprovedBy };
}

function confirmLegacySource(db, source, expectedVersion, sourceShape) {
  if (source.governance_version !== expectedVersion) {
    throw serviceError(409, 'ORGANIZATION_METHODOLOGY_STALE', 'Knowledge governance changed before the request.');
  }
  if (source.quality_state === 'confirmed') {
    if (source.reviewed_by !== sourceShape.firstApprovedBy) {
      throw serviceError(
        409,
        'ORGANIZATION_METHODOLOGY_SOURCE_INELIGIBLE',
        'The recorded knowledge reviewer does not match the human confirmation.'
      );
    }
    return source;
  }
  try {
    knowledge.confirmKnowledgeInTransaction(db, {
      entryId: source.id,
      expectedVersion,
      reviewedBy: sourceShape.firstApprovedBy,
      reason: '兼容归档：按原项目人工确认记录固化治理状态。'
    });
  } catch (error) {
    throw serviceError(
      error.statusCode || 409,
      'ORGANIZATION_METHODOLOGY_STALE',
      'Knowledge governance changed before the request.'
    );
  }
  return sourceRecord(db, source.id);
}

function assertRequesterCanSubmit(access, sourceShape) {
  if (access.userId !== sourceShape.firstApprovedBy && access.organizationRole !== 'org_admin') {
    throw serviceError(
      403,
      'ORGANIZATION_METHODOLOGY_FORBIDDEN',
      'The first approver or an organization administrator must submit the request.'
    );
  }
}

function assertDecisionAccess(access, request) {
  if (!access.canDecide || access.organizationId !== request.org_id) {
    throw serviceError(
      403,
      'ORGANIZATION_METHODOLOGY_FORBIDDEN',
      'An active organization administrator is required.'
    );
  }
  if (access.userId === request.first_approved_by) {
    throw serviceError(
      403,
      'ORGANIZATION_METHODOLOGY_FOUR_EYES_REQUIRED',
      'The second approver must be different from the first approver.'
    );
  }
}

function methodologyDimensions(db, source, metadata) {
  const evidence = plainObject(metadata.evidence) || {};
  const contentId = Number(evidence.content_id);
  const publication = Number.isSafeInteger(contentId) && contentId > 0
    ? db.prepare(`
        SELECT platform,product,tags_json
        FROM campaign_publications
        WHERE id=? AND org_id=? AND campaign_id=?
      `).get(contentId, source.org_id, source.campaign_id)
    : null;
  const dimensions = {
    schema_version: 1,
    product: normalizeDimensionText(
      publication && publication.product || source.product_name,
      256
    ),
    category: normalizeDimensionText(source.industry, 256),
    platform: normalizeDimensionText(
      publication && publication.platform || evidence.platform || source.channel_type,
      80
    ),
    audience: normalizeDimensionText(
      evidence.audience || metadata.audience || '',
      500
    ),
    hypothesis: normalizeDimensionText(source.summary || source.title, 1200),
    method: normalizeDimensionText(source.content, 2400)
  };
  return dimensions;
}

function promotionDigest(organizationId, dimensions) {
  return createHash('sha256')
    .update(`tm-organization-methodology-dedupe-v2\n${organizationId}\n${JSON.stringify(dimensions)}`)
    .digest('hex');
}

function currentMethodologyByDedupe(db, organizationId, dedupeSha256) {
  return db.prepare(`
    SELECT entry.*,governance.lineage_root_entry_id,governance.supersedes_entry_id,
      governance.version_no,governance.is_current,governance.quality_state,
      governance.governance_version
    FROM organization_methodology_promotion_decisions decision
    JOIN organization_methodology_promotion_requests request
      ON request.id=decision.request_id
    JOIN organization_knowledge_custody custody
      ON custody.knowledge_entry_id=decision.target_knowledge_entry_id
     AND custody.org_id=request.org_id
    JOIN knowledge_entries entry ON entry.id=custody.knowledge_entry_id
    JOIN knowledge_entry_governance governance ON governance.knowledge_entry_id=entry.id
    WHERE request.org_id=? AND request.dedupe_sha256=?
      AND decision.decision='approved'
      AND governance.is_current=1 AND governance.quality_state='confirmed'
    ORDER BY decision.id
    LIMIT 1
  `).get(organizationId, dedupeSha256) || null;
}

function currentMethodology(db, organizationId, entryId) {
  return db.prepare(`
    SELECT entry.*,governance.lineage_root_entry_id,governance.supersedes_entry_id,
      governance.version_no,governance.is_current,governance.quality_state,
      governance.governance_version
    FROM organization_knowledge_custody custody
    JOIN knowledge_entries entry ON entry.id=custody.knowledge_entry_id
    JOIN knowledge_entry_governance governance ON governance.knowledge_entry_id=entry.id
    WHERE custody.org_id=? AND custody.knowledge_entry_id=?
      AND custody.custody_type='methodology'
      AND entry.entry_type='performance_review_methodology'
      AND entry.source_type='organization_performance_methodology'
  `).get(organizationId, entryId) || null;
}

function requestRow(db, requestId) {
  return db.prepare(`
    SELECT request.*,decision.id AS decision_id,decision.decision,
      decision.decided_by,decision.decision_reason,
      decision.target_knowledge_entry_id,decision.supersedes_knowledge_entry_id AS decided_supersedes_id,
      decision.created_at AS decided_at
    FROM organization_methodology_promotion_requests request
    LEFT JOIN organization_methodology_promotion_decisions decision
      ON decision.request_id=request.id
    WHERE request.id=?
  `).get(requestId) || null;
}

function decisionStatus(db, row) {
  if (!row || !row.decision) return 'pending';
  if (row.decision === 'rejected') return 'rejected';
  if (row.supersedes_knowledge_entry_id !== null) return 'superseded';
  const prior = db.prepare(`
    SELECT 1 AS present
    FROM organization_methodology_promotion_decisions
    WHERE target_knowledge_entry_id=? AND id<? AND decision='approved'
    LIMIT 1
  `).get(row.target_knowledge_entry_id, row.decision_id);
  return prior ? 'deduplicated' : 'promoted';
}

function duplicateTargetId(db, organizationId, dedupeSha256) {
  const duplicate = currentMethodologyByDedupe(db, organizationId, dedupeSha256);
  return duplicate ? duplicate.id : null;
}

function requestProjection(db, row, actorUserId, canDecide) {
  let dimensions = {};
  try {
    dimensions = JSON.parse(row.dimensions_json || '{}');
  } catch {}
  return {
    promotion_request_id: row.id,
    status: decisionStatus(db, row),
    organization_id: row.org_id,
    source_campaign_id: row.source_campaign_id,
    source_knowledge_entry_id: row.source_knowledge_entry_id,
    requested_by: row.requested_by,
    first_approved_by: row.first_approved_by,
    expected_governance_version: row.expected_governance_version,
    dedupe_sha256: row.dedupe_sha256,
    dimensions,
    supersedes_knowledge_entry_id: row.decision
      ? row.decided_supersedes_id
      : row.supersedes_knowledge_entry_id,
    request_reason: row.request_reason,
    requested_at: row.created_at,
    decided_by: row.decided_by || null,
    decision_reason: row.decision_reason || null,
    decided_at: row.decided_at || null,
    target_knowledge_entry_id: row.target_knowledge_entry_id || null,
    duplicate_target_knowledge_entry_id: duplicateTargetId(db, row.org_id, row.dedupe_sha256),
    can_decide: Boolean(canDecide && !row.decision && actorUserId !== row.first_approved_by)
  };
}

function requestResponse(db, row) {
  const projected = requestProjection(db, row, null, false);
  return Object.assign({ contract_version: CONTRACT_VERSION }, projected);
}

function decisionResponse(db, row) {
  const projected = requestProjection(db, row, null, false);
  return {
    contract_version: CONTRACT_VERSION,
    status: projected.status,
    promotion_request_id: projected.promotion_request_id,
    organization_id: projected.organization_id,
    source_campaign_id: projected.source_campaign_id,
    source_knowledge_entry_id: projected.source_knowledge_entry_id,
    target_knowledge_entry_id: projected.target_knowledge_entry_id,
    supersedes_knowledge_entry_id: projected.supersedes_knowledge_entry_id,
    dedupe_sha256: projected.dedupe_sha256,
    first_approved_by: projected.first_approved_by,
    decided_by: projected.decided_by,
    decided_at: projected.decided_at
  };
}

function idempotencyDisposition(disposition) {
  if (!disposition || disposition.state === 'absent') return null;
  if (disposition.state === 'replay') {
    if (disposition.statusCode >= 200 && disposition.statusCode <= 299) {
      const body = plainObject(disposition.responseBody);
      if (body) return body;
      throw serviceError(500, 'ORGANIZATION_METHODOLOGY_RESPONSE_INVALID', 'Stored response is invalid.');
    }
    const body = plainObject(disposition.responseBody) || {};
    throw serviceError(
      disposition.statusCode || 500,
      body.code || 'ORGANIZATION_METHODOLOGY_FAILED',
      body.error || 'Methodology operation failed.'
    );
  }
  if (disposition.state === 'conflict') {
    throw serviceError(409, 'IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for another request.');
  }
  if (disposition.state === 'processing') {
    throw serviceError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The methodology operation is still processing.');
  }
  if (disposition.state === 'expired') {
    throw serviceError(410, 'IDEMPOTENCY_EXPIRED', 'The retained methodology response expired.');
  }
  throw serviceError(500, 'ORGANIZATION_METHODOLOGY_FAILED', 'Methodology idempotency state is invalid.');
}

function reservationInput(input) {
  return {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    campaignId: input.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    expectedEventCount: 0,
    operationTimeoutSeconds: 60
  };
}

function audit(db, input) {
  const inserted = db.prepare(`
    INSERT INTO activity_log (user_id,action,module,details,ip_address)
    VALUES (?,?,?,?,?)
  `).run(
    input.userId,
    input.action,
    'organization_methodology',
    JSON.stringify(input.details),
    input.ipAddress || null
  );
  if (inserted.changes !== 1) throw new Error('organization methodology audit insert failed');
}

function createOrganizationMethodologyService(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }

  function requestPromotion(input) {
    const campaignId = positiveId(input && input.campaignId, 'campaign id');
    const body = normalizeRequestBody(input && input.body);
    const key = normalizeIdempotencyKey(input && input.idempotencyKey);
    const traceId = normalizeRequestId(input && input.requestId);
    const access = campaignAccess(db, input && input.user, campaignId);
    const initialSource = sourceRecord(db, body.sourceKnowledgeEntryId);
    const sourceShape = assertSourceShape(initialSource, campaignId);
    assertRequesterCanSubmit(access, sourceShape);
    if (initialSource.org_id !== access.organizationId) {
      throw serviceError(403, 'ORGANIZATION_METHODOLOGY_FORBIDDEN', 'Knowledge source is outside this organization.');
    }
    const hash = requestHash({
      method: 'POST',
      path: '/api/campaigns/:id/performance/methodology-promotion-requests',
      campaignId,
      kind: 'json',
      payload: {
        source_knowledge_entry_id: body.sourceKnowledgeEntryId,
        expected_governance_version: body.expectedGovernanceVersion,
        reason: body.reason,
        supersedes_knowledge_entry_id: body.supersedesKnowledgeEntryId
      }
    });
    const reservation = reservationInput({
      organizationId: access.organizationId,
      actorUserId: access.userId,
      campaignId,
      scope: 'knowledge.methodology.request',
      key,
      requestHash: hash
    });
    const retained = idempotency.inspectRetained(db, reservation);
    if (retained.state !== 'absent' && !(retained.state === 'processing' && retained.recoverable === true)) {
      return idempotencyDisposition(retained);
    }

    return db.transaction(() => {
      const lockedAccess = campaignAccess(db, input && input.user, campaignId);
      let source = sourceRecord(db, body.sourceKnowledgeEntryId);
      const lockedShape = assertSourceShape(source, campaignId);
      assertRequesterCanSubmit(lockedAccess, lockedShape);
      if (source.org_id !== lockedAccess.organizationId) {
        throw serviceError(403, 'ORGANIZATION_METHODOLOGY_FORBIDDEN', 'Knowledge source is outside this organization.');
      }
      source = confirmLegacySource(db, source, body.expectedGovernanceVersion, lockedShape);
      const dimensions = methodologyDimensions(db, source, lockedShape.metadata);
      const dedupeSha256 = promotionDigest(source.org_id, dimensions);
      const superseded = body.supersedesKnowledgeEntryId === null
        ? null
        : currentMethodology(db, source.org_id, body.supersedesKnowledgeEntryId);
      if (body.supersedesKnowledgeEntryId !== null && (
        !superseded || superseded.is_current !== 1 || superseded.quality_state !== 'confirmed'
      )) {
        throw serviceError(
          409,
          'ORGANIZATION_METHODOLOGY_SUPERSESSION_INVALID',
          'The methodology selected for replacement is not current in this organization.'
        );
      }
      const existing = db.prepare(`
        SELECT id FROM organization_methodology_promotion_requests
        WHERE org_id=? AND source_knowledge_entry_id=?
      `).get(source.org_id, source.id);
      if (existing) return requestResponse(db, requestRow(db, existing.id));

      let held = idempotency.recoverExpiredInTransaction(db, reservation);
      if (held.state === 'absent') held = idempotency.reserveProcessingInTransaction(db, reservation);
      if (held.state !== 'reserved') return idempotencyDisposition(held);
      const inserted = db.prepare(`
        INSERT INTO organization_methodology_promotion_requests (
          org_id,source_campaign_id,source_knowledge_entry_id,requested_by,
          first_approved_by,expected_governance_version,dedupe_sha256,
          dimensions_json,supersedes_knowledge_entry_id,request_reason
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(
        source.org_id,
        source.campaign_id,
        source.id,
        lockedAccess.userId,
        lockedShape.firstApprovedBy,
        source.governance_version,
        dedupeSha256,
        JSON.stringify(dimensions),
        body.supersedesKnowledgeEntryId,
        body.reason
      );
      const row = requestRow(db, Number(inserted.lastInsertRowid));
      const response = requestResponse(db, row);
      audit(db, {
        userId: lockedAccess.userId,
        action: 'request_organization_methodology_promotion',
        ipAddress: input && input.ipAddress,
        details: {
          schema_version: 1,
          contract_version: CONTRACT_VERSION,
          request_id: traceId,
          idempotency_key: key,
          promotion_request_id: row.id,
          organization_id: row.org_id,
          source_campaign_id: row.source_campaign_id,
          source_knowledge_entry_id: row.source_knowledge_entry_id,
          first_approved_by: row.first_approved_by,
          dedupe_sha256: row.dedupe_sha256,
          supersedes_knowledge_entry_id: row.supersedes_knowledge_entry_id,
          outcome: 'pending'
        }
      });
      idempotency.completeJsonInTransaction(db, {
        ledgerId: held.ledgerId,
        requestHash: hash,
        leaseToken: held.leaseToken,
        statusCode: 200,
        responseBody: response
      });
      return response;
    }).immediate();
  }

  function decidePromotion(input) {
    const campaignId = positiveId(input && input.campaignId, 'campaign id');
    const promotionRequestId = positiveId(
      input && input.promotionRequestId,
      'promotion request id'
    );
    const body = normalizeDecisionBody(input && input.body);
    const key = normalizeIdempotencyKey(input && input.idempotencyKey);
    const traceId = normalizeRequestId(input && input.requestId);
    const request = requestRow(db, promotionRequestId);
    if (!request || request.source_campaign_id !== campaignId) {
      throw serviceError(404, 'ORGANIZATION_METHODOLOGY_REQUEST_NOT_FOUND', 'Promotion request was not found.');
    }
    const access = campaignAccess(db, input && input.user, campaignId);
    assertDecisionAccess(access, request);
    const hash = requestHash({
      method: 'POST',
      path: '/api/campaigns/:id/performance/methodology-promotion-requests/:requestId/decision',
      campaignId,
      kind: 'json',
      payload: {
        promotion_request_id: promotionRequestId,
        decision: body.decision,
        reason: body.reason
      }
    });
    const reservation = reservationInput({
      organizationId: access.organizationId,
      actorUserId: access.userId,
      campaignId,
      scope: 'knowledge.methodology.decide',
      key,
      requestHash: hash
    });
    const retained = idempotency.inspectRetained(db, reservation);
    if (retained.state !== 'absent' && !(retained.state === 'processing' && retained.recoverable === true)) {
      return idempotencyDisposition(retained);
    }

    return db.transaction(() => {
      const lockedRequest = requestRow(db, promotionRequestId);
      if (!lockedRequest || lockedRequest.source_campaign_id !== campaignId) {
        throw serviceError(404, 'ORGANIZATION_METHODOLOGY_REQUEST_NOT_FOUND', 'Promotion request was not found.');
      }
      const lockedAccess = campaignAccess(db, input && input.user, campaignId);
      assertDecisionAccess(lockedAccess, lockedRequest);
      if (lockedRequest.decision_id) {
        throw serviceError(409, 'ORGANIZATION_METHODOLOGY_ALREADY_DECIDED', 'Promotion request was already decided.');
      }
      const source = sourceRecord(db, lockedRequest.source_knowledge_entry_id);
      if (
        !source || source.org_id !== lockedRequest.org_id ||
        source.quality_state !== 'confirmed' || source.is_current !== 1 ||
        source.governance_version !== lockedRequest.expected_governance_version ||
        source.reviewed_by !== lockedRequest.first_approved_by
      ) {
        throw serviceError(409, 'ORGANIZATION_METHODOLOGY_STALE', 'Knowledge source changed before the second approval.');
      }
      let held = idempotency.recoverExpiredInTransaction(db, reservation);
      if (held.state === 'absent') held = idempotency.reserveProcessingInTransaction(db, reservation);
      if (held.state !== 'reserved') return idempotencyDisposition(held);

      let target = null;
      let superseded = null;
      if (body.decision === 'approved') {
        target = currentMethodologyByDedupe(db, lockedRequest.org_id, lockedRequest.dedupe_sha256);
        if (target && lockedRequest.supersedes_knowledge_entry_id !== null) {
          throw serviceError(
            409,
            'ORGANIZATION_METHODOLOGY_DUPLICATE_CONFLICT',
            'Equivalent methodology already exists and cannot replace another method.'
          );
        }
        if (!target) {
          superseded = lockedRequest.supersedes_knowledge_entry_id === null
            ? null
            : currentMethodology(
                db,
                lockedRequest.org_id,
                lockedRequest.supersedes_knowledge_entry_id
              );
          if (lockedRequest.supersedes_knowledge_entry_id !== null && (
            !superseded || superseded.is_current !== 1 || superseded.quality_state !== 'confirmed'
          )) {
            throw serviceError(
              409,
              'ORGANIZATION_METHODOLOGY_SUPERSESSION_INVALID',
              'The methodology selected for replacement changed before approval.'
            );
          }
          const sourceMetadata = parseMetadata(source.metadata_json);
          const written = knowledge.writeOrganizationKnowledgeInTransaction(db, {
            organizationId: lockedRequest.org_id,
            createdBy: lockedAccess.userId,
            entryType: 'performance_review_methodology',
            sourceType: 'organization_performance_methodology',
            sourceId: `${lockedRequest.org_id}:${lockedRequest.dedupe_sha256}`,
            title: `组织方法论：${source.title}`,
            summary: source.summary,
            content: source.content,
            tags: [...parseTags(source.tags_json), 'methodology', 'organization_methodology'],
            visibility: 'team',
            metadata: {
              schema_version: 1,
              organization_methodology: {
                contract_version: CONTRACT_VERSION,
                organization_id: lockedRequest.org_id,
                promotion_request_id: lockedRequest.id,
                source_campaign_id: lockedRequest.source_campaign_id,
                source_knowledge_entry_id: lockedRequest.source_knowledge_entry_id,
                source_confirmation_contract: sourceMetadata.confirmation && sourceMetadata.confirmation.contract_version,
                first_approved_by: lockedRequest.first_approved_by,
                second_approved_by: lockedAccess.userId,
                dedupe_sha256: lockedRequest.dedupe_sha256,
                dimensions: parseMetadata(lockedRequest.dimensions_json),
                raw_evidence_retained: false
              }
            }
          });
          if (!written || written.status !== 'created' || !written.entry || !written.entry.id) {
            throw serviceError(
              409,
              'ORGANIZATION_METHODOLOGY_ARCHIVE_CONFLICT',
              'Organization methodology archive conflicts with existing evidence.'
            );
          }
          target = db.prepare('SELECT * FROM knowledge_entries WHERE id=?').get(written.entry.id);
          db.prepare(`
            INSERT INTO organization_knowledge_custody (
              knowledge_entry_id,org_id,custody_type,created_by
            ) VALUES (?,?,'methodology',?)
          `).run(target.id, lockedRequest.org_id, lockedAccess.userId);
          knowledge.applyKnowledgeCapacityGaugePlanInTransaction(db, written.capacityGaugePlan);

          if (superseded) {
            const oldUpdate = db.prepare(`
              UPDATE knowledge_entry_governance
              SET is_current=0,governance_version=governance_version+1,
                updated_at=CURRENT_TIMESTAMP
              WHERE knowledge_entry_id=? AND governance_version=? AND is_current=1
            `).run(superseded.id, superseded.governance_version);
            if (oldUpdate.changes !== 1) {
              throw serviceError(409, 'ORGANIZATION_METHODOLOGY_STALE', 'Prior methodology changed before replacement.');
            }
            const targetUpdate = db.prepare(`
              UPDATE knowledge_entry_governance
              SET lineage_root_entry_id=?,supersedes_entry_id=?,version_no=?,
                quality_state='confirmed',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,
                review_reason=?,governance_version=governance_version+1,
                updated_at=CURRENT_TIMESTAMP
              WHERE knowledge_entry_id=? AND governance_version=1
                AND is_current=1 AND quality_state='candidate'
            `).run(
              superseded.lineage_root_entry_id,
              superseded.id,
              superseded.version_no + 1,
              lockedAccess.userId,
              body.reason,
              target.id
            );
            if (targetUpdate.changes !== 1) {
              throw serviceError(409, 'ORGANIZATION_METHODOLOGY_STALE', 'New methodology governance could not be established.');
            }
          } else {
            knowledge.confirmKnowledgeInTransaction(db, {
              entryId: target.id,
              expectedVersion: 1,
              reviewedBy: lockedAccess.userId,
              reason: body.reason
            });
          }
        }
      }

      const inserted = db.prepare(`
        INSERT INTO organization_methodology_promotion_decisions (
          request_id,org_id,decision,decided_by,decision_reason,
          target_knowledge_entry_id,supersedes_knowledge_entry_id
        ) VALUES (?,?,?,?,?,?,?)
      `).run(
        lockedRequest.id,
        lockedRequest.org_id,
        body.decision,
        lockedAccess.userId,
        body.reason,
        target ? target.id : null,
        superseded ? superseded.id : null
      );
      const row = requestRow(db, lockedRequest.id);
      if (!inserted.changes || !row || !row.decision_id) {
        throw new Error('organization methodology decision insert failed');
      }
      const response = decisionResponse(db, row);
      audit(db, {
        userId: lockedAccess.userId,
        action: 'decide_organization_methodology_promotion',
        ipAddress: input && input.ipAddress,
        details: {
          schema_version: 1,
          contract_version: CONTRACT_VERSION,
          request_id: traceId,
          idempotency_key: key,
          promotion_request_id: row.id,
          organization_id: row.org_id,
          source_campaign_id: row.source_campaign_id,
          source_knowledge_entry_id: row.source_knowledge_entry_id,
          target_knowledge_entry_id: row.target_knowledge_entry_id,
          supersedes_knowledge_entry_id: response.supersedes_knowledge_entry_id,
          first_approved_by: row.first_approved_by,
          second_approved_by: lockedAccess.userId,
          outcome: response.status
        }
      });
      idempotency.completeJsonInTransaction(db, {
        ledgerId: held.ledgerId,
        requestHash: hash,
        leaseToken: held.leaseToken,
        statusCode: 200,
        responseBody: response
      });
      return response;
    }).immediate();
  }

  function listPromotions(input) {
    const campaignId = positiveId(input && input.campaignId, 'campaign id');
    const access = campaignAuditAccess(db, input && input.user, campaignId);
    const sources = db.prepare(`
      SELECT entry.id,entry.title,entry.summary,entry.source_type,entry.created_at,
        governance.quality_state,governance.governance_version,governance.reviewed_by,
        CAST(json_extract(entry.metadata_json,'$.confirmation.approved_by') AS INTEGER) AS first_approved_by
      FROM knowledge_current_custody custody
      JOIN knowledge_entries entry ON entry.id=custody.knowledge_entry_id
      JOIN knowledge_entry_governance governance ON governance.knowledge_entry_id=entry.id
      WHERE custody.org_id=? AND custody.campaign_id=? AND custody.custody_state='active'
        AND entry.source_type IN (
          'performance_ai_review_confirmation',
          'performance_content_analysis_confirmation'
        )
        AND entry.business_type='campaign' AND entry.business_id=?
        AND entry.visibility='team' AND entry.is_public=1
        AND governance.is_current=1 AND governance.quality_state IN ('candidate','confirmed')
        AND json_valid(entry.metadata_json)
      ORDER BY entry.created_at DESC,entry.id DESC
      LIMIT 50
    `).all(access.organizationId, campaignId, String(campaignId));
    const rows = db.prepare(`
      SELECT request.*,decision.id AS decision_id,decision.decision,
        decision.decided_by,decision.decision_reason,
        decision.target_knowledge_entry_id,
        decision.supersedes_knowledge_entry_id AS decided_supersedes_id,
        decision.created_at AS decided_at
      FROM organization_methodology_promotion_requests request
      LEFT JOIN organization_methodology_promotion_decisions decision
        ON decision.request_id=request.id
      WHERE request.org_id=? AND request.source_campaign_id=?
      ORDER BY request.id DESC
      LIMIT 100
    `).all(access.organizationId, campaignId);
    const requests = rows.map((row) => requestProjection(db, row, access.userId, access.canDecide));
    const bySource = new Map(requests.map((request) => [request.source_knowledge_entry_id, request]));
    const projectedSources = sources.map((source) => ({
      knowledge_entry_id: source.id,
      title: source.title,
      summary: source.summary,
      source_type: source.source_type,
      quality_state: source.quality_state,
      governance_version: source.governance_version,
      first_approved_by: source.first_approved_by,
      created_at: source.created_at,
      can_request: access.canRequest && (
        access.userId === source.first_approved_by || access.organizationRole === 'org_admin'
      ),
      promotion: bySource.get(source.id) || null
    }));
    const currentMethods = db.prepare(`
      SELECT entry.id AS knowledge_entry_id,entry.title,entry.summary,entry.updated_at,
        governance.version_no,governance.governance_version
      FROM organization_knowledge_custody custody
      JOIN knowledge_entries entry ON entry.id=custody.knowledge_entry_id
      JOIN knowledge_entry_governance governance ON governance.knowledge_entry_id=entry.id
      WHERE custody.org_id=? AND custody.custody_type='methodology'
        AND governance.is_current=1 AND governance.quality_state='confirmed'
      ORDER BY entry.updated_at DESC,entry.id DESC
      LIMIT 100
    `).all(access.organizationId);
    return {
      contract_version: CONTRACT_VERSION,
      organization_id: access.organizationId,
      campaign_id: campaignId,
      capabilities: {
        can_request: access.canRequest,
        can_decide: access.canDecide,
        support_audit: access.supportAudit
      },
      sources: projectedSources,
      requests,
      current_methods: currentMethods
    };
  }

  return Object.freeze({ requestPromotion, decidePromotion, listPromotions });
}

module.exports = {
  CONTRACT_VERSION,
  OrganizationMethodologyServiceError,
  createOrganizationMethodologyService
};
