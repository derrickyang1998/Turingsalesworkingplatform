'use strict';

const crypto = require('node:crypto');
const idempotencyService = require('./idempotency_service');
const knowledgeService = require('./knowledge_service');
const { requestHash } = require('./sqlite_digest_service');
const {
  CollaborationResourceContractError,
  isCanonicalCollaborationResource,
  isReservedV2ProposalNotes,
  isV2CollaborationResourceInput,
  isVersionedCollaborationResourceInput,
  normalizeCollaborationResource,
  resolveResourceQuotedPrice,
  serializeCollaborationResource
} = require('./collaboration_resource_contract');
const {
  buildCollectionAccessPredicate,
  getCampaignAccess
} = require('./campaign_access_service');

const ACTIVE_STATUSES = Object.freeze([
  'proposed',
  'contacted',
  'negotiating',
  'confirmed',
  'contract_sent',
  'contracted',
  'live',
  'content_review'
]);
const CANCELLABLE_STATUSES = Object.freeze([
  'proposed',
  'contacted',
  'negotiating',
  'confirmed',
  'contract_sent',
  'contracted',
  'live',
  'content_review'
]);
const COLLABORATION_RELATIONS = Object.freeze([
  'order',
  'execution',
  'publication',
  'settlement'
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
const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const LINKED_CREATE_KEYS = new Set([
  'campaign_id',
  'influencer_id',
  'demand_id',
  'status',
  'proposal_notes',
  'resource',
  'cost_quoted',
  'notes',
  'timeline_start',
  'timeline_end'
]);
const LINKED_UPDATE_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'reason',
  'status',
  'cost_quoted',
  'cost_actual',
  'content_url',
  'notes',
  'timeline_start',
  'timeline_end',
  'campaign_relation',
  'confirm_cost_actual'
]);
const LINKED_CANCELLATION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'reason',
  'action'
]);
const CONTRACT_CONFIRMATION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'contract_document_id',
  'contract_reference',
  'counterparty_name',
  'signed_at',
  'confirmation_note'
]);
const CONTRACT_DOCUMENT_UPLOAD_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'filename',
  'media_type',
  'content_base64'
]);
const CONTENT_REVIEW_SUBMISSION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'content_url',
  'content_version',
  'submission_note'
]);
const CONTENT_REVIEW_DECISION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'decision',
  'review_note'
]);
const PUBLICATION_CONFIRMATION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'publications'
]);
const PUBLICATION_CORRECTION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'custody_id',
  'url',
  'published_at',
  'correction_reason',
  'same_content_confirmed'
]);
const PUBLICATION_TRACKING_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'custody_id',
  'action',
  'reason'
]);
const PAYMENT_RECORD_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'direction',
  'amount',
  'paid_at',
  'payment_method',
  'payment_reference',
  'counterparty_name',
  'tranche',
  'payment_note'
]);
const PAYMENT_VOID_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'void_reason'
]);
const SETTLEMENT_SUBMISSION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'settlement_note',
  'variance_reason',
  'zero_value_reason'
]);
const SETTLEMENT_DECISION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'submission_entry_id',
  'decision',
  'review_note'
]);
const PAYMENT_DIRECTIONS = Object.freeze(['client_receipt', 'creator_payment']);
const PAYMENT_METHODS = Object.freeze([
  'bank_transfer',
  'paypal',
  'wise',
  'payoneer',
  'platform',
  'other_manual'
]);
const PAYMENT_TRANCHES = Object.freeze(['deposit', 'balance', 'full', 'commission', 'other']);
const CLOSEOUT_SNAPSHOT_MAX_COLLABORATIONS = 5000;
const CONTRACT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const CONTRACT_DOCUMENT_MIN_BYTES = 32;
const CONTRACT_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
const CONTRACT_DOCUMENT_MAX_BASE64_BYTES = Math.ceil(CONTRACT_DOCUMENT_MAX_BYTES / 3) * 4;
const CONTRACT_DOCUMENT_ACTIVE_NAMES = new Set([
  '/JavaScript',
  '/JS',
  '/OpenAction',
  '/AA',
  '/Launch',
  '/EmbeddedFile',
  '/RichMedia',
  '/XFA',
  '/ObjStm',
  '/SubmitForm',
  '/ImportData',
  '/GoToR',
  '/Rendition',
  '/Encrypt'
].map((name) => name.toLowerCase()));

class CampaignCollaborationServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new CampaignCollaborationServiceError(statusCode, code, message, details);
}

function requirePositiveSafeId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a positive JavaScript-safe integer`);
  }
  return value;
}

function requireActiveActor(db, userId) {
  const actor = db.prepare(`
    SELECT id,role,is_active
    FROM users
    WHERE id=?
  `).get(userId);
  if (!actor || actor.is_active !== 1) {
    return null;
  }
  return actor;
}

function collaborationObjectPredicate() {
  return `(
    collaboration.user_id=?
    OR EXISTS (
      SELECT 1
      FROM users platform_actor
      WHERE platform_actor.id=?
        AND platform_actor.role='admin'
        AND typeof(platform_actor.is_active)='integer'
        AND platform_actor.is_active=1
    )
    OR EXISTS (
      SELECT 1
      FROM organization_memberships owner_membership
      JOIN organization_memberships actor_membership
        ON actor_membership.org_id=owner_membership.org_id
       AND actor_membership.user_id=?
       AND actor_membership.role_code='org_admin'
       AND actor_membership.status='active'
      JOIN users owner
        ON owner.id=owner_membership.user_id
       AND typeof(owner.is_active)='integer'
       AND owner.is_active=1
      WHERE owner_membership.user_id=collaboration.user_id
        AND owner_membership.status='active'
    )
  )`;
}

function assertAllowedKeys(body, allowedKeys, message) {
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', message);
  }
}

function isCanonicalCost(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function v2CollaborationResource(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isV2CollaborationResourceInput(parsed)
      ? normalizeCollaborationResource(parsed)
      : null;
  } catch (error) {
    return null;
  }
}

function contractConfirmationText(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', { field });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field,
      max_length: maxLength
    });
  }
  return normalized;
}

function normalizedSignedAt(value, enforceNotFuture = true) {
  const raw = contractConfirmationText(value, 'signed_at', 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(raw);
  if (!match) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field: 'signed_at'
    });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field: 'signed_at'
    });
  }
  const timestamp = Date.parse(raw);
  if (
    !Number.isFinite(timestamp) ||
    (enforceNotFuture && timestamp > Date.now() + CONTRACT_FUTURE_TOLERANCE_MS)
  ) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field: 'signed_at'
    });
  }
  return new Date(timestamp).toISOString();
}

function normalizedContractConfirmation(body) {
  if (Object.keys(body).some((key) => !CONTRACT_CONFIRMATION_KEYS.has(key))) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.');
  }
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field: 'expected_version'
    });
  }
  if (!Number.isSafeInteger(body.contract_document_id) || body.contract_document_id < 1) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field: 'contract_document_id'
    });
  }
  return Object.freeze({
    campaignId: body.campaign_id,
    expectedVersion: body.expected_version,
    contractDocumentId: body.contract_document_id,
    contractReference: contractConfirmationText(body.contract_reference, 'contract_reference', 160),
    counterpartyName: contractConfirmationText(body.counterparty_name, 'counterparty_name', 160),
    signedAt: normalizedSignedAt(body.signed_at),
    confirmationNote: contractConfirmationText(body.confirmation_note, 'confirmation_note', 500)
  });
}

function contractDocumentError(code, field) {
  throw serviceError(400, code, 'Contract document is invalid.', field ? { field } : undefined);
}

function normalizedContractDocumentFilename(value) {
  if (typeof value !== 'string') contractDocumentError('INVALID_CONTRACT_DOCUMENT', 'filename');
  const normalized = value.trim();
  if (
    normalized.length < 5 || normalized.length > 180 ||
    Buffer.byteLength(normalized, 'utf8') > 255 ||
    !/\.pdf$/i.test(normalized) ||
    /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(normalized)
  ) {
    contractDocumentError('INVALID_CONTRACT_DOCUMENT', 'filename');
  }
  return normalized;
}

function decodeCanonicalContractDocument(value) {
  if (
    typeof value !== 'string' || value.length < 4 ||
    value.length > CONTRACT_DOCUMENT_MAX_BASE64_BYTES ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    contractDocumentError('INVALID_CONTRACT_DOCUMENT', 'content_base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length < CONTRACT_DOCUMENT_MIN_BYTES ||
    bytes.length > CONTRACT_DOCUMENT_MAX_BYTES ||
    bytes.toString('base64') !== value
  ) {
    contractDocumentError('INVALID_CONTRACT_DOCUMENT', 'content_base64');
  }
  return bytes;
}

function assertSafeContractPdf(bytes, errorCode = 'INVALID_CONTRACT_DOCUMENT') {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 16)).toString('latin1');
  const suffix = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r?\n|\r)/.test(prefix) || !/%%EOF[\t \r\n]*$/.test(suffix)) {
    contractDocumentError(errorCode, 'content_base64');
  }
  const names = bytes.toString('latin1').match(/\/(?:#[0-9A-Fa-f]{2}|[^\x00-\x20()<>{}\[\]\/\%#])+/g) || [];
  const unsafe = names.some((name) => {
    const decoded = name.replace(/#([0-9A-Fa-f]{2})/g, (_match, encoded) => (
      String.fromCharCode(Number.parseInt(encoded, 16))
    ));
    return CONTRACT_DOCUMENT_ACTIVE_NAMES.has(decoded.toLowerCase());
  });
  if (unsafe) {
    contractDocumentError('UNSAFE_CONTRACT_DOCUMENT', 'content_base64');
  }
}

function normalizedContractDocumentUpload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    contractDocumentError('INVALID_CONTRACT_DOCUMENT');
  }
  if (Object.keys(body).some((key) => !CONTRACT_DOCUMENT_UPLOAD_KEYS.has(key))) {
    contractDocumentError('INVALID_CONTRACT_DOCUMENT');
  }
  if (!Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) {
    contractDocumentError('INVALID_CONTRACT_DOCUMENT', 'campaign_id');
  }
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) {
    contractDocumentError('INVALID_CONTRACT_DOCUMENT', 'expected_version');
  }
  if (body.media_type !== 'application/pdf') {
    contractDocumentError('INVALID_CONTRACT_DOCUMENT', 'media_type');
  }
  const filename = normalizedContractDocumentFilename(body.filename);
  const bytes = decodeCanonicalContractDocument(body.content_base64);
  assertSafeContractPdf(bytes);
  return Object.freeze({
    campaignId: body.campaign_id,
    expectedVersion: body.expected_version,
    filename,
    mediaType: body.media_type,
    bytes,
    fileSha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

function contentReviewError(field, message = 'Content review evidence is invalid.') {
  throw serviceError(400, 'INVALID_CONTENT_REVIEW', message, field ? { field } : undefined);
}

function contentReviewText(value, field, maxLength, multiline) {
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    contentReviewError(field);
  }
  const normalized = value.trim();
  const forbidden = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (!normalized || Array.from(normalized).length > maxLength || forbidden.test(normalized)) {
    contentReviewError(field);
  }
  return normalized;
}

function normalizedContentReviewUrl(value) {
  const raw = contentReviewText(value, 'content_url', 2048, false);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    contentReviewError('content_url');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    !parsed.hostname || parsed.href.length > 2048
  ) {
    contentReviewError('content_url');
  }
  return parsed.href;
}

function normalizedContentReviewSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) contentReviewError();
  if (Object.keys(body).some((key) => !CONTENT_REVIEW_SUBMISSION_KEYS.has(key))) {
    contentReviewError();
  }
  if (!Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) {
    contentReviewError('campaign_id');
  }
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) {
    contentReviewError('expected_version');
  }
  const contentUrl = normalizedContentReviewUrl(body.content_url);
  return Object.freeze({
    campaignId: body.campaign_id,
    expectedVersion: body.expected_version,
    contentUrl,
    contentUrlSha256: crypto.createHash('sha256').update(contentUrl, 'utf8').digest('hex'),
    contentVersion: contentReviewText(body.content_version, 'content_version', 80, false),
    submissionNote: contentReviewText(body.submission_note, 'submission_note', 1000, true)
  });
}

function normalizedContentReviewDecision(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) contentReviewError();
  if (Object.keys(body).some((key) => !CONTENT_REVIEW_DECISION_KEYS.has(key))) {
    contentReviewError();
  }
  if (!Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) {
    contentReviewError('campaign_id');
  }
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) {
    contentReviewError('expected_version');
  }
  if (!['approved', 'changes_requested'].includes(body.decision)) {
    contentReviewError('decision');
  }
  return Object.freeze({
    campaignId: body.campaign_id,
    expectedVersion: body.expected_version,
    decision: body.decision,
    reviewNote: contentReviewText(body.review_note, 'review_note', 1000, true)
  });
}

function paymentSettlementError(field, message = 'Payment or settlement evidence is invalid.') {
  throw serviceError(400, 'INVALID_PAYMENT_SETTLEMENT', message, field ? { field } : undefined);
}

function paymentSettlementText(value, field, maxLength, options = {}) {
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    paymentSettlementError(field);
  }
  const normalized = value.trim();
  const forbidden = options.multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (
    (!options.optional && !normalized) ||
    Array.from(normalized).length > maxLength ||
    forbidden.test(normalized)
  ) {
    paymentSettlementError(field);
  }
  return normalized || null;
}

function canonicalUtcTimestamp(value, field) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    paymentSettlementError(field);
  }
  return value;
}

function normalizedPaymentRecord(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) paymentSettlementError();
  if (Object.keys(body).some((key) => !PAYMENT_RECORD_KEYS.has(key))) paymentSettlementError();
  if (!Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) paymentSettlementError('campaign_id');
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) paymentSettlementError('expected_version');
  if (!PAYMENT_DIRECTIONS.includes(body.direction)) paymentSettlementError('direction');
  if (!Number.isSafeInteger(body.amount) || body.amount < 1) paymentSettlementError('amount');
  if (!PAYMENT_METHODS.includes(body.payment_method)) paymentSettlementError('payment_method');
  if (!PAYMENT_TRANCHES.includes(body.tranche)) paymentSettlementError('tranche');
  return Object.freeze({
    campaignId: body.campaign_id,
    expectedVersion: body.expected_version,
    direction: body.direction,
    amount: body.amount,
    paidAt: canonicalUtcTimestamp(body.paid_at, 'paid_at'),
    paymentMethod: body.payment_method,
    paymentReference: paymentSettlementText(body.payment_reference, 'payment_reference', 160),
    counterpartyName: paymentSettlementText(body.counterparty_name, 'counterparty_name', 200),
    tranche: body.tranche,
    paymentNote: paymentSettlementText(body.payment_note, 'payment_note', 1000, { multiline: true })
  });
}

function normalizedPaymentVoid(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) paymentSettlementError();
  if (Object.keys(body).some((key) => !PAYMENT_VOID_KEYS.has(key))) paymentSettlementError();
  if (!Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) paymentSettlementError('campaign_id');
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) paymentSettlementError('expected_version');
  return Object.freeze({
    campaignId: body.campaign_id,
    expectedVersion: body.expected_version,
    voidReason: paymentSettlementText(body.void_reason, 'void_reason', 1000, { multiline: true })
  });
}

function normalizedSettlementSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) paymentSettlementError();
  if (Object.keys(body).some((key) => !SETTLEMENT_SUBMISSION_KEYS.has(key))) paymentSettlementError();
  if (!Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) paymentSettlementError('campaign_id');
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) paymentSettlementError('expected_version');
  return Object.freeze({
    campaignId: body.campaign_id,
    expectedVersion: body.expected_version,
    settlementNote: paymentSettlementText(body.settlement_note, 'settlement_note', 1000, { multiline: true }),
    varianceReason: paymentSettlementText(body.variance_reason || '', 'variance_reason', 1000, {
      multiline: true,
      optional: true
    }),
    zeroValueReason: paymentSettlementText(body.zero_value_reason || '', 'zero_value_reason', 1000, {
      multiline: true,
      optional: true
    })
  });
}

function normalizedSettlementDecision(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) paymentSettlementError();
  if (Object.keys(body).some((key) => !SETTLEMENT_DECISION_KEYS.has(key))) paymentSettlementError();
  if (!Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) paymentSettlementError('campaign_id');
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) paymentSettlementError('expected_version');
  if (!Number.isSafeInteger(body.submission_entry_id) || body.submission_entry_id < 1) {
    paymentSettlementError('submission_entry_id');
  }
  if (!['approved', 'changes_requested'].includes(body.decision)) paymentSettlementError('decision');
  return Object.freeze({
    campaignId: body.campaign_id,
    expectedVersion: body.expected_version,
    submissionEntryId: body.submission_entry_id,
    decision: body.decision,
    reviewNote: paymentSettlementText(body.review_note, 'review_note', 1000, { multiline: true })
  });
}

function authorizedCollaborationScope(userId) {
  const campaignAccess = buildCollectionAccessPredicate(
    'collaboration_stats',
    { userId }
  );
  return {
    sql: `
      classified_links AS (
        SELECT id,record_id,org_id,campaign_id,bundle_id,revoked_at
        FROM campaign_record_links
        WHERE record_type='collaboration'
          AND relation_type IN ('order','execution','publication','settlement')
      ),
      classified_records AS (
        SELECT record_id
        FROM classified_links
        GROUP BY record_id
      ),
      active_identities AS (
        SELECT record_id,org_id,campaign_id,bundle_id
        FROM classified_links
        WHERE revoked_at IS NULL
        GROUP BY record_id,org_id,campaign_id,bundle_id
      ),
      active_custody AS (
        SELECT record_id,MIN(org_id) AS org_id,MIN(campaign_id) AS campaign_id
        FROM active_identities
        GROUP BY record_id
        HAVING COUNT(*)=1
      ),
      latest_revoked_custody AS (
        SELECT link.record_id,link.org_id,link.campaign_id
        FROM classified_links link
        WHERE link.revoked_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM active_identities active
            WHERE active.record_id=link.record_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM classified_links newer
            WHERE newer.record_id=link.record_id
              AND newer.revoked_at IS NOT NULL
              AND (
                newer.revoked_at>link.revoked_at
                OR (newer.revoked_at=link.revoked_at AND newer.id>link.id)
              )
          )
      ),
      campaign_scope AS (
        SELECT record_id,org_id,campaign_id FROM active_custody
        UNION ALL
        SELECT record_id,org_id,campaign_id FROM latest_revoked_custody
      ),
      authorized_collaborations AS (
        SELECT collaboration.id,campaign_scope.campaign_id AS custody_campaign_id
        FROM collaborations collaboration
        LEFT JOIN classified_records classification
          ON classification.record_id=CAST(collaboration.id AS TEXT)
        LEFT JOIN campaign_scope
          ON campaign_scope.record_id=CAST(collaboration.id AS TEXT)
        WHERE ${collaborationObjectPredicate()}
          AND (
            classification.record_id IS NULL
            OR (
              campaign_scope.record_id IS NOT NULL
              AND ${campaignAccess.sql}
            )
          )
      )
    `,
    params: [userId, userId, userId, ...campaignAccess.params]
  };
}

function legacyCollaborationColumns(alias) {
  return `${alias}.id, ${alias}.demand_id, ${alias}.influencer_id, ${alias}.user_id,
    ${alias}.status, ${alias}.proposal_notes, ${alias}.cost_quoted, ${alias}.cost_actual,
    ${alias}.content_url, ${alias}.roi_data, ${alias}.timeline_start, ${alias}.timeline_end,
    ${alias}.notes, ${alias}.created_at, ${alias}.updated_at,
    influencer.kol_handle, influencer.platform, influencer.followers, influencer.category,
    influencer.region, influencer.project_name, influencer.product_name,
    influencer.content_deliverable, influencer.quoted_price`;
}

function readAuthorizedCollaboration(db, userId, collaborationId, includeCustody) {
  const scope = authorizedCollaborationScope(userId);
  const custodyProjection = includeCustody
    ? ', authorized.custody_campaign_id AS __custody_campaign_id'
    : '';
  return db.prepare(`
    WITH ${scope.sql}
    SELECT ${legacyCollaborationColumns('collaboration')}${custodyProjection}
    FROM authorized_collaborations authorized
    JOIN collaborations collaboration ON collaboration.id=authorized.id
    JOIN influencers influencer ON collaboration.influencer_id=influencer.id
    WHERE collaboration.id=?
    LIMIT 1
  `).get(...scope.params, collaborationId) || null;
}

function archiveSummary(content) {
  return Array.from(content.replace(/\s+/gu, ' ').trim()).slice(0, 1000).join('');
}

function requireCampaignAccess(db, userId, campaignId) {
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) {
    throw serviceError(access.status, access.code, 'Campaign access is unavailable.');
  }
  return access;
}

function requireCampaignWrite(db, userId, campaignId) {
  const access = requireCampaignAccess(db, userId, campaignId);
  if (!access.permissions.write) {
    throw serviceError(
      409,
      access.campaign.operational_status === 'cancelled' ? 'CAMPAIGN_CANCELLED' : 'CAMPAIGN_ON_HOLD',
      'Campaign is not writable.',
      { operational_status: access.campaign.operational_status }
    );
  }
  return access;
}

function idempotencyOutcome(reservation) {
  if (reservation.state === 'replay') {
    return { status: reservation.statusCode, body: reservation.responseBody };
  }
  if (reservation.state === 'processing') {
    throw serviceError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The idempotent request is still processing.');
  }
  if (reservation.state === 'conflict') {
    throw serviceError(409, 'IDEMPOTENCY_KEY_REUSED', 'The idempotency key was already used.');
  }
  throw serviceError(410, 'IDEMPOTENCY_EXPIRED', 'The idempotency response expired.');
}

function activeRelations(db, campaignId, collaborationId) {
  return db.prepare(`
    SELECT relation_type
    FROM campaign_record_links
    WHERE campaign_id=? AND record_type='collaboration' AND record_id=? AND revoked_at IS NULL
    ORDER BY CASE relation_type
      WHEN 'order' THEN 1 WHEN 'execution' THEN 2 WHEN 'publication' THEN 3 WHEN 'settlement' THEN 4
      ELSE 99 END
  `).all(campaignId, String(collaborationId)).map((row) => row.relation_type);
}

function projectedContractDocument(row) {
  return {
    id: row.id,
    collaboration_id: row.collaboration_id,
    original_filename: row.original_filename,
    media_type: row.media_type,
    file_sha256: row.file_sha256,
    file_bytes: row.file_bytes,
    uploaded_by: row.uploaded_by,
    uploaded_by_name: row.uploaded_by_name || null,
    knowledge_entry_id: row.knowledge_entry_id,
    created_at: row.created_at
  };
}

function contractDocuments(db, campaignId, collaborationId) {
  return db.prepare(`
    SELECT
      document.id,document.collaboration_id,document.original_filename,
      document.media_type,document.file_sha256,document.file_bytes,
      document.uploaded_by,document.knowledge_entry_id,document.created_at,
      actor.display_name AS uploaded_by_name
    FROM collaboration_contract_documents document
    LEFT JOIN users actor ON actor.id=document.uploaded_by
    WHERE document.campaign_id=? AND document.collaboration_id=?
    ORDER BY document.created_at DESC,document.id DESC
  `).all(campaignId, collaborationId).map(projectedContractDocument);
}

function contractDocumentRecord(db, campaignId, collaborationId, documentId, includeBytes = false) {
  const row = db.prepare(`
    SELECT
      document.id,document.org_id,document.campaign_id,document.collaboration_id,
      document.original_filename,document.media_type,document.file_sha256,
      document.file_bytes,document.uploaded_by,document.knowledge_entry_id,
      document.created_at,actor.display_name AS uploaded_by_name
      ${includeBytes ? ',document.document_blob' : ''}
    FROM collaboration_contract_documents document
    LEFT JOIN users actor ON actor.id=document.uploaded_by
    WHERE document.campaign_id=? AND document.collaboration_id=? AND document.id=?
    LIMIT 1
  `).get(campaignId, collaborationId, documentId);
  return row || null;
}

function verifiedContractDocumentBytes(row) {
  if (!row || !Buffer.isBuffer(row.document_blob) || row.document_blob.length !== row.file_bytes) {
    throw serviceError(409, 'CONTRACT_DOCUMENT_CORRUPT', 'Contract document integrity verification failed.');
  }
  const actual = crypto.createHash('sha256').update(row.document_blob).digest();
  const expected = Buffer.from(row.file_sha256, 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(actual, expected)) {
    throw serviceError(409, 'CONTRACT_DOCUMENT_CORRUPT', 'Contract document integrity verification failed.');
  }
  try {
    assertSafeContractPdf(row.document_blob, 'CONTRACT_DOCUMENT_CORRUPT');
  } catch (error) {
    if (error && error.code === 'UNSAFE_CONTRACT_DOCUMENT') {
      throw serviceError(409, 'CONTRACT_DOCUMENT_CORRUPT', 'Contract document integrity verification failed.');
    }
    if (error && error.code === 'CONTRACT_DOCUMENT_CORRUPT') {
      error.status = 409;
      error.statusCode = 409;
    }
    throw error;
  }
  return row.document_blob;
}

function contractConfirmation(db, campaignId, collaborationId) {
  const rows = db.prepare(`
    SELECT
      entry.id,entry.source_id,entry.business_type,entry.business_id,entry.created_by,
      entry.visibility,entry.metadata_json,entry.created_at,
      link.org_id,link.created_by AS link_created_by,link.metadata_json AS link_metadata_json,
      campaign.org_id AS campaign_org_id,actor.display_name AS confirmed_by_name
    FROM campaign_record_links link
    JOIN knowledge_entries entry
      ON entry.id=CAST(link.record_id AS INTEGER)
     AND entry.source_type='collaboration_contract_confirmation'
     AND entry.entry_type='collaboration_contract_confirmation'
    JOIN campaigns campaign ON campaign.id=link.campaign_id
    LEFT JOIN users actor
      ON actor.id=json_extract(entry.metadata_json,'$.confirmed_by')
    WHERE link.campaign_id=?
      AND link.record_type='knowledge_entry'
      AND link.relation_type='knowledge'
      AND link.revoked_at IS NULL
      AND json_extract(entry.metadata_json,'$.collaboration_id')=?
    ORDER BY entry.id DESC
    LIMIT 2
  `).all(campaignId, collaborationId);
  if (!rows.length) return null;
  if (rows.length !== 1) {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
  }
  const row = rows[0];
  let metadata;
  let linkMetadata;
  try {
    metadata = JSON.parse(row.metadata_json);
    linkMetadata = JSON.parse(row.link_metadata_json);
  } catch (error) {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
  }
  let signedAt;
  let confirmedAt;
  try {
    signedAt = normalizedSignedAt(metadata.signed_at, false);
    confirmedAt = normalizedSignedAt(metadata.confirmed_at, false);
  } catch (error) {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
  }
  const expectedSourceId = `${collaborationId}:${metadata.row_version}`;
  const schemaVersion = metadata.schema_version;
  if (
    ![1, 2].includes(schemaVersion) || metadata.collaboration_id !== collaborationId ||
    !Number.isSafeInteger(metadata.row_version) || metadata.row_version < 1 ||
    !Number.isSafeInteger(metadata.confirmed_by) || metadata.confirmed_by < 1 ||
    metadata.retrieval_eligible !== false || signedAt !== metadata.signed_at ||
    typeof metadata.confirmed_at !== 'string' || confirmedAt !== metadata.confirmed_at ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(metadata.confirmed_at) ||
    typeof metadata.contract_reference !== 'string' || !metadata.contract_reference.trim() || metadata.contract_reference.length > 160 ||
    typeof metadata.counterparty_name !== 'string' || !metadata.counterparty_name.trim() || metadata.counterparty_name.length > 160 ||
    typeof metadata.confirmation_note !== 'string' || !metadata.confirmation_note.trim() || metadata.confirmation_note.length > 500 ||
    String(row.source_id) !== expectedSourceId || row.business_type !== 'campaign' ||
    String(row.business_id) !== String(campaignId) || row.visibility !== 'team' ||
    row.created_by !== metadata.confirmed_by || row.link_created_by !== metadata.confirmed_by ||
    row.org_id !== row.campaign_org_id ||
    !linkMetadata || linkMetadata.producer_type !== 'collaboration_contract_confirmation' ||
    linkMetadata.producer_id !== collaborationId ||
    linkMetadata.source_type !== 'collaboration_contract_confirmation' ||
    String(linkMetadata.source_id) !== expectedSourceId
  ) {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
  }
  let document = null;
  if (schemaVersion === 2) {
    if (
      !Number.isSafeInteger(metadata.contract_document_id) || metadata.contract_document_id < 1 ||
      typeof metadata.contract_document_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(metadata.contract_document_sha256)
    ) {
      throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
    }
    const documentRow = contractDocumentRecord(
      db,
      campaignId,
      collaborationId,
      metadata.contract_document_id,
      false
    );
    if (!documentRow || documentRow.file_sha256 !== metadata.contract_document_sha256) {
      throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
    }
    document = projectedContractDocument(documentRow);
  }
  const projection = {
    id: row.id,
    contract_reference: metadata.contract_reference,
    counterparty_name: metadata.counterparty_name,
    signed_at: metadata.signed_at,
    confirmation_note: metadata.confirmation_note,
    confirmed_by: metadata.confirmed_by,
    confirmed_by_name: row.confirmed_by_name || null,
    confirmed_at: metadata.confirmed_at
  };
  if (document) projection.document = document;
  return projection;
}

function contentReviewEvidenceError() {
  throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Content review evidence is inconsistent.');
}

function contentReviewHistory(db, campaignId, collaborationId, currentContentUrl) {
  const pageStatement = db.prepare(`
    SELECT
      entry.id,entry.source_id,entry.business_type,entry.business_id,entry.created_by,
      entry.visibility,entry.metadata_json,entry.created_at,
      link.org_id,link.created_by AS link_created_by,link.metadata_json AS link_metadata_json,
      campaign.org_id AS campaign_org_id,actor.display_name AS actor_name
    FROM campaign_record_links link
    JOIN knowledge_entries entry
      ON entry.id=CAST(link.record_id AS INTEGER)
     AND entry.source_type='collaboration_content_review'
     AND entry.entry_type='collaboration_content_review'
    JOIN campaigns campaign ON campaign.id=link.campaign_id
    LEFT JOIN users actor ON actor.id=json_extract(entry.metadata_json,'$.actor_user_id')
    WHERE link.campaign_id=?
      AND link.record_type='knowledge_entry'
      AND link.relation_type='knowledge'
      AND link.revoked_at IS NULL
      AND json_extract(entry.metadata_json,'$.collaboration_id')=?
      AND entry.id>?
    ORDER BY entry.id
    LIMIT 200
  `);
  const rows = [];
  let cursor = 0;
  while (true) {
    const page = pageStatement.all(campaignId, collaborationId, cursor);
    rows.push(...page);
    if (page.length < 200) break;
    const nextCursor = page[page.length - 1].id;
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) {
      contentReviewEvidenceError();
    }
    cursor = nextCursor;
  }

  const events = [];
  let expected = 'submitted';
  let currentSubmission = null;
  let latestDecision = null;
  let previousRowVersion = 0;
  let terminalApproval = false;
  for (const row of rows) {
    let metadata;
    let linkMetadata;
    try {
      metadata = JSON.parse(row.metadata_json);
      linkMetadata = JSON.parse(row.link_metadata_json);
    } catch (_error) {
      contentReviewEvidenceError();
    }
    const action = metadata && metadata.action;
    const expectedSourceId = `${collaborationId}:${metadata && metadata.row_version}:${action}`;
    if (
      terminalApproval || metadata.schema_version !== 1 ||
      metadata.collaboration_id !== collaborationId ||
      !Number.isSafeInteger(metadata.row_version) || metadata.row_version < 1 ||
      metadata.row_version <= previousRowVersion ||
      !Number.isSafeInteger(metadata.actor_user_id) || metadata.actor_user_id < 1 ||
      metadata.retrieval_eligible !== false ||
      typeof metadata.recorded_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(metadata.recorded_at) ||
      !Number.isFinite(Date.parse(metadata.recorded_at)) ||
      String(row.source_id) !== expectedSourceId ||
      row.business_type !== 'campaign' || String(row.business_id) !== String(campaignId) ||
      row.visibility !== 'team' || row.created_by !== metadata.actor_user_id ||
      row.link_created_by !== metadata.actor_user_id || row.org_id !== row.campaign_org_id ||
      !linkMetadata || linkMetadata.producer_type !== 'collaboration_content_review' ||
      linkMetadata.producer_id !== collaborationId ||
      linkMetadata.source_type !== 'collaboration_content_review' ||
      String(linkMetadata.source_id) !== expectedSourceId
    ) {
      contentReviewEvidenceError();
    }
    previousRowVersion = metadata.row_version;

    if (action === 'submitted') {
      if (expected !== 'submitted') contentReviewEvidenceError();
      let contentUrl;
      let contentVersion;
      let submissionNote;
      try {
        contentUrl = normalizedContentReviewUrl(metadata.content_url);
        contentVersion = contentReviewText(metadata.content_version, 'content_version', 80, false);
        submissionNote = contentReviewText(metadata.submission_note, 'submission_note', 1000, true);
      } catch (_error) {
        contentReviewEvidenceError();
      }
      const digest = crypto.createHash('sha256').update(contentUrl, 'utf8').digest('hex');
      if (
        contentUrl !== metadata.content_url || metadata.content_url_sha256 !== digest ||
        contentVersion !== metadata.content_version || submissionNote !== metadata.submission_note
      ) {
        contentReviewEvidenceError();
      }
      currentSubmission = {
        id: row.id,
        action,
        row_version: metadata.row_version,
        content_url: contentUrl,
        content_url_sha256: digest,
        content_version: contentVersion,
        submission_note: submissionNote,
        submitted_by: metadata.actor_user_id,
        submitted_by_name: row.actor_name || null,
        submitted_at: metadata.recorded_at
      };
      events.push(currentSubmission);
      latestDecision = null;
      expected = 'decision';
      continue;
    }

    if (!['approved', 'changes_requested'].includes(action) || expected !== 'decision' || !currentSubmission) {
      contentReviewEvidenceError();
    }
    let reviewNote;
    let contentVersion;
    try {
      reviewNote = contentReviewText(metadata.review_note, 'review_note', 1000, true);
      contentVersion = contentReviewText(metadata.content_version, 'content_version', 80, false);
    } catch (_error) {
      contentReviewEvidenceError();
    }
    if (
      metadata.submission_entry_id !== currentSubmission.id ||
      metadata.content_url_sha256 !== currentSubmission.content_url_sha256 ||
      contentVersion !== currentSubmission.content_version ||
      contentVersion !== metadata.content_version || reviewNote !== metadata.review_note ||
      metadata.actor_user_id === currentSubmission.submitted_by
    ) {
      contentReviewEvidenceError();
    }
    latestDecision = {
      id: row.id,
      action,
      row_version: metadata.row_version,
      submission_entry_id: metadata.submission_entry_id,
      content_url_sha256: metadata.content_url_sha256,
      content_version: contentVersion,
      review_note: reviewNote,
      reviewed_by: metadata.actor_user_id,
      reviewed_by_name: row.actor_name || null,
      reviewed_at: metadata.recorded_at
    };
    events.push(latestDecision);
    if (action === 'approved') {
      terminalApproval = true;
      expected = 'terminal';
    } else {
      expected = 'submitted';
    }
  }

  let status = 'not_submitted';
  if (currentSubmission) status = latestDecision ? latestDecision.action : 'pending';
  let publicationReady = false;
  if (status === 'approved' && currentSubmission && latestDecision) {
    let normalizedCurrent;
    try {
      normalizedCurrent = normalizedContentReviewUrl(currentContentUrl);
    } catch (_error) {
      contentReviewEvidenceError();
    }
    const currentDigest = crypto.createHash('sha256').update(normalizedCurrent, 'utf8').digest('hex');
    if (
      normalizedCurrent !== currentContentUrl ||
      currentDigest !== latestDecision.content_url_sha256 ||
      latestDecision.submission_entry_id !== currentSubmission.id
    ) {
      contentReviewEvidenceError();
    }
    publicationReady = true;
  }
  return {
    status,
    publication_ready: publicationReady,
    current_submission: currentSubmission,
    latest_decision: latestDecision,
    events
  };
}

function projectContentReviewCapabilities(access, userId, current, relations, review) {
  const relationSet = new Set(Array.isArray(relations) ? relations : []);
  const reviewStageOpen = relationSet.has('order') && relationSet.has('execution') &&
    !relationSet.has('publication') && !relationSet.has('settlement');
  const writable = Boolean(access && access.permissions && access.permissions.write);
  const isV2 = v2CollaborationResource(current && current.proposal_notes);
  const canSubmit = Boolean(writable && isV2 && reviewStageOpen && (
    (current.status === 'live' && ['not_submitted', 'changes_requested'].includes(review.status)) ||
    (current.status === 'content_review' && review.status === 'not_submitted') ||
    (current.status === 'completed' && review.status === 'not_submitted')
  ));
  const canDecide = Boolean(
    writable && isV2 && reviewStageOpen && current.status === 'content_review' &&
    review.status === 'pending' && review.current_submission && !review.latest_decision &&
    ['owner', 'org_admin'].includes(access.role) &&
    review.current_submission.submitted_by !== userId
  );
  const canPublish = Boolean(
    writable && isV2 && reviewStageOpen && review.publication_ready &&
    ['content_review', 'completed'].includes(current.status)
  );
  return {
    ...review,
    can_submit: canSubmit,
    can_decide: canDecide,
    can_publish: canPublish
  };
}

function paymentEvidenceError() {
  throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Payment and settlement evidence is inconsistent.');
}

function paymentFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify({
    direction: value.direction,
    amount: value.amount,
    currency: value.currency,
    paid_at: value.paid_at,
    payment_method: value.payment_method,
    payment_reference: value.payment_reference,
    counterparty_name: value.counterparty_name,
    tranche: value.tranche
  }), 'utf8').digest('hex');
}

function activePaymentsDigest(entries) {
  const canonical = entries
    .filter((entry) => entry.status === 'active')
    .sort((left, right) => left.id - right.id)
    .map((entry) => ({
      id: entry.id,
      direction: entry.direction,
      amount: entry.amount,
      currency: entry.currency,
      paid_at: entry.paid_at,
      payment_method: entry.payment_method,
      payment_reference: entry.payment_reference,
      counterparty_name: entry.counterparty_name,
      tranche: entry.tranche,
      recorded_by: entry.recorded_by,
      fingerprint: entry.fingerprint
    }));
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function paymentSettlementHistory(db, campaignId, collaborationId, resource, relations) {
  const pageStatement = db.prepare(`
    SELECT
      entry.id,entry.source_id,entry.business_type,entry.business_id,entry.created_by,
      entry.visibility,entry.metadata_json,
      link.org_id,link.created_by AS link_created_by,link.metadata_json AS link_metadata_json,
      campaign.org_id AS campaign_org_id,actor.display_name AS actor_name
    FROM campaign_record_links link
    JOIN knowledge_entries entry
      ON entry.id=CAST(link.record_id AS INTEGER)
     AND entry.source_type='collaboration_payment_settlement'
     AND entry.entry_type='collaboration_payment_settlement'
    JOIN campaigns campaign ON campaign.id=link.campaign_id
    LEFT JOIN users actor ON actor.id=json_extract(entry.metadata_json,'$.actor_user_id')
    WHERE link.campaign_id=?
      AND link.record_type='knowledge_entry'
      AND link.relation_type='knowledge'
      AND link.revoked_at IS NULL
      AND json_extract(entry.metadata_json,'$.collaboration_id')=?
      AND entry.id>?
    ORDER BY entry.id
    LIMIT 200
  `);
  const rows = [];
  let cursor = 0;
  while (true) {
    const page = pageStatement.all(campaignId, collaborationId, cursor);
    rows.push(...page);
    if (page.length < 200) break;
    const nextCursor = page[page.length - 1].id;
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) paymentEvidenceError();
    cursor = nextCursor;
  }

  const relationSet = new Set(Array.isArray(relations) ? relations : []);
  if (!resource) {
    if (rows.length > 0) paymentEvidenceError();
    return {
      status: relationSet.has('settlement') ? 'legacy_settled' : 'not_available',
      currency: null,
      expected_creator_cost: null,
      expected_client_receipt: null,
      creator_payment_total: 0,
      client_receipt_total: 0,
      creator_payment_remaining: null,
      client_receipt_remaining: null,
      active_entry_count: 0,
      entries: [],
      current_submission: null,
      latest_decision: null,
      events: []
    };
  }

  const entries = [];
  const byId = new Map();
  const events = [];
  let currentSubmission = null;
  let latestDecision = null;
  let pendingSubmission = null;
  let terminalApproval = false;
  let previousRowVersion = 0;
  for (const row of rows) {
    let metadata;
    let linkMetadata;
    try {
      metadata = JSON.parse(row.metadata_json);
      linkMetadata = JSON.parse(row.link_metadata_json);
    } catch (_error) {
      paymentEvidenceError();
    }
    const action = metadata && metadata.action;
    const expectedSourceId = `${collaborationId}:${metadata && metadata.row_version}:${action}`;
    if (
      terminalApproval || metadata.schema_version !== 1 ||
      metadata.collaboration_id !== collaborationId ||
      !Number.isSafeInteger(metadata.row_version) || metadata.row_version < 1 ||
      metadata.row_version <= previousRowVersion ||
      !Number.isSafeInteger(metadata.actor_user_id) || metadata.actor_user_id < 1 ||
      metadata.retrieval_eligible !== false ||
      typeof metadata.recorded_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(metadata.recorded_at) ||
      !Number.isFinite(Date.parse(metadata.recorded_at)) ||
      String(row.source_id) !== expectedSourceId ||
      row.business_type !== 'campaign' || String(row.business_id) !== String(campaignId) ||
      row.visibility !== 'team' || row.created_by !== metadata.actor_user_id ||
      row.link_created_by !== metadata.actor_user_id || row.org_id !== row.campaign_org_id ||
      !linkMetadata || linkMetadata.producer_type !== 'collaboration_payment_settlement' ||
      linkMetadata.producer_id !== collaborationId ||
      linkMetadata.source_type !== 'collaboration_payment_settlement' ||
      String(linkMetadata.source_id) !== expectedSourceId
    ) {
      paymentEvidenceError();
    }
    previousRowVersion = metadata.row_version;

    if (action === 'payment_recorded') {
      if (pendingSubmission) paymentEvidenceError();
      let normalized;
      try {
        normalized = normalizedPaymentRecord({
          campaign_id: campaignId,
          expected_version: Math.max(1, metadata.row_version - 1),
          direction: metadata.direction,
          amount: metadata.amount,
          paid_at: metadata.paid_at,
          payment_method: metadata.payment_method,
          payment_reference: metadata.payment_reference,
          counterparty_name: metadata.counterparty_name,
          tranche: metadata.tranche,
          payment_note: metadata.payment_note
        });
      } catch (_error) {
        paymentEvidenceError();
      }
      const entry = {
        id: row.id,
        action,
        status: 'active',
        row_version: metadata.row_version,
        direction: normalized.direction,
        amount: normalized.amount,
        currency: metadata.currency,
        paid_at: normalized.paidAt,
        payment_method: normalized.paymentMethod,
        payment_reference: normalized.paymentReference,
        counterparty_name: normalized.counterpartyName,
        tranche: normalized.tranche,
        payment_note: normalized.paymentNote,
        fingerprint: metadata.payment_fingerprint,
        recorded_by: metadata.actor_user_id,
        recorded_by_name: row.actor_name || null,
        recorded_at: metadata.recorded_at,
        voided_by: null,
        voided_by_name: null,
        voided_at: null,
        void_reason: null
      };
      if (
        metadata.currency !== resource.currency ||
        typeof entry.fingerprint !== 'string' ||
        entry.fingerprint !== paymentFingerprint(entry) ||
        entries.some((candidate) => candidate.status === 'active' && (
          candidate.fingerprint === entry.fingerprint ||
          (candidate.direction === entry.direction && candidate.payment_reference === entry.payment_reference)
        ))
      ) {
        paymentEvidenceError();
      }
      entries.push(entry);
      byId.set(entry.id, entry);
      events.push({
        id: row.id,
        action,
        row_version: metadata.row_version,
        payment_entry_id: row.id,
        actor_user_id: metadata.actor_user_id,
        actor_name: row.actor_name || null,
        recorded_at: metadata.recorded_at
      });
      continue;
    }

    if (action === 'payment_voided') {
      if (pendingSubmission || !Number.isSafeInteger(metadata.payment_entry_id)) paymentEvidenceError();
      const target = byId.get(metadata.payment_entry_id);
      let voidReason;
      try {
        voidReason = paymentSettlementText(metadata.void_reason, 'void_reason', 1000, { multiline: true });
      } catch (_error) {
        paymentEvidenceError();
      }
      if (!target || target.status !== 'active' || metadata.payment_fingerprint !== target.fingerprint) {
        paymentEvidenceError();
      }
      target.status = 'voided';
      target.voided_by = metadata.actor_user_id;
      target.voided_by_name = row.actor_name || null;
      target.voided_at = metadata.recorded_at;
      target.void_reason = voidReason;
      events.push({
        id: row.id,
        action,
        row_version: metadata.row_version,
        payment_entry_id: target.id,
        actor_user_id: metadata.actor_user_id,
        actor_name: row.actor_name || null,
        recorded_at: metadata.recorded_at
      });
      continue;
    }

    if (action === 'settlement_submitted') {
      if (pendingSubmission) paymentEvidenceError();
      const active = entries.filter((entry) => entry.status === 'active');
      const creatorTotal = active
        .filter((entry) => entry.direction === 'creator_payment')
        .reduce((sum, entry) => sum + entry.amount, 0);
      const clientTotal = active
        .filter((entry) => entry.direction === 'client_receipt')
        .reduce((sum, entry) => sum + entry.amount, 0);
      const activeIds = active.map((entry) => entry.id).sort((left, right) => left - right);
      const recorderIds = Array.from(new Set(active.map((entry) => entry.recorded_by))).sort((left, right) => left - right);
      let settlementNote;
      let varianceReason;
      let zeroValueReason;
      try {
        settlementNote = paymentSettlementText(metadata.settlement_note, 'settlement_note', 1000, { multiline: true });
        varianceReason = paymentSettlementText(metadata.variance_reason || '', 'variance_reason', 1000, {
          multiline: true,
          optional: true
        });
        zeroValueReason = paymentSettlementText(metadata.zero_value_reason || '', 'zero_value_reason', 1000, {
          multiline: true,
          optional: true
        });
      } catch (_error) {
        paymentEvidenceError();
      }
      if (
        metadata.currency !== resource.currency ||
        metadata.expected_creator_cost !== resource.creator_cost ||
        metadata.expected_client_receipt !== resource.client_quote ||
        metadata.creator_payment_total !== creatorTotal ||
        metadata.client_receipt_total !== clientTotal ||
        metadata.payment_digest !== activePaymentsDigest(active) ||
        JSON.stringify(metadata.active_payment_entry_ids) !== JSON.stringify(activeIds) ||
        JSON.stringify(metadata.recorder_user_ids) !== JSON.stringify(recorderIds)
      ) {
        paymentEvidenceError();
      }
      currentSubmission = {
        id: row.id,
        action,
        row_version: metadata.row_version,
        payment_digest: metadata.payment_digest,
        active_payment_entry_ids: activeIds,
        recorder_user_ids: recorderIds,
        currency: resource.currency,
        expected_creator_cost: resource.creator_cost,
        expected_client_receipt: resource.client_quote,
        creator_payment_total: creatorTotal,
        client_receipt_total: clientTotal,
        settlement_note: settlementNote,
        variance_reason: varianceReason,
        zero_value_reason: zeroValueReason,
        submitted_by: metadata.actor_user_id,
        submitted_by_name: row.actor_name || null,
        submitted_at: metadata.recorded_at
      };
      latestDecision = null;
      pendingSubmission = currentSubmission;
      events.push(currentSubmission);
      continue;
    }

    if (!['settlement_approved', 'settlement_changes_requested'].includes(action) || !pendingSubmission) {
      paymentEvidenceError();
    }
    let reviewNote;
    try {
      reviewNote = paymentSettlementText(metadata.review_note, 'review_note', 1000, { multiline: true });
    } catch (_error) {
      paymentEvidenceError();
    }
    if (
      metadata.submission_entry_id !== pendingSubmission.id ||
      metadata.payment_digest !== pendingSubmission.payment_digest ||
      metadata.actor_user_id === pendingSubmission.submitted_by ||
      pendingSubmission.recorder_user_ids.includes(metadata.actor_user_id)
    ) {
      paymentEvidenceError();
    }
    latestDecision = {
      id: row.id,
      action,
      row_version: metadata.row_version,
      submission_entry_id: pendingSubmission.id,
      payment_digest: pendingSubmission.payment_digest,
      review_note: reviewNote,
      reviewed_by: metadata.actor_user_id,
      reviewed_by_name: row.actor_name || null,
      reviewed_at: metadata.recorded_at
    };
    events.push(latestDecision);
    pendingSubmission = null;
    if (action === 'settlement_approved') terminalApproval = true;
  }

  const activeEntries = entries.filter((entry) => entry.status === 'active');
  const creatorTotal = activeEntries
    .filter((entry) => entry.direction === 'creator_payment')
    .reduce((sum, entry) => sum + entry.amount, 0);
  const clientTotal = activeEntries
    .filter((entry) => entry.direction === 'client_receipt')
    .reduce((sum, entry) => sum + entry.amount, 0);
  if (terminalApproval !== relationSet.has('settlement')) {
    if (!(rows.length === 0 && relationSet.has('settlement'))) paymentEvidenceError();
  }
  let status = 'not_started';
  if (rows.length === 0 && relationSet.has('settlement')) status = 'legacy_settled';
  else if (terminalApproval) status = 'settled';
  else if (pendingSubmission) status = 'pending_review';
  else if (latestDecision && latestDecision.action === 'settlement_changes_requested') status = 'changes_requested';
  else if (activeEntries.length > 0) status = relationSet.has('publication') ? 'ready' : 'recording';

  return {
    status,
    currency: resource.currency,
    expected_creator_cost: resource.creator_cost,
    expected_client_receipt: resource.client_quote,
    creator_payment_total: creatorTotal,
    client_receipt_total: clientTotal,
    creator_payment_remaining: resource.creator_cost - creatorTotal,
    client_receipt_remaining: resource.client_quote - clientTotal,
    active_entry_count: activeEntries.length,
    entries,
    current_submission: currentSubmission,
    latest_decision: latestDecision,
    events
  };
}

function projectPaymentSettlementCapabilities(db, access, userId, campaignId, current, relations, history) {
  const relationSet = new Set(Array.isArray(relations) ? relations : []);
  const resource = v2CollaborationResource(current && current.proposal_notes);
  const writable = Boolean(access && access.permissions && access.permissions.write);
  const pending = history.status === 'pending_review';
  const closed = relationSet.has('settlement') || ['settled', 'legacy_settled'].includes(history.status);
  const contractReady = Boolean(
    contractConfirmation(db, campaignId, current.id) ||
    relationSet.has('execution') || relationSet.has('publication')
  );
  const recordStage = ['contracted', 'live', 'content_review', 'completed'].includes(current.status);
  const canRecord = Boolean(resource && writable && contractReady && recordStage && !pending && !closed);
  const creatorReady = history.creator_payment_total > 0 || history.expected_creator_cost === 0;
  const canSubmit = Boolean(
    resource && writable && current.status === 'completed' && relationSet.has('publication') &&
    !pending && !closed && creatorReady
  );
  const recorderIds = history.current_submission && history.current_submission.recorder_user_ids || [];
  const canDecide = Boolean(
    resource && writable && pending && ['owner', 'org_admin'].includes(access.role) &&
    history.current_submission && history.current_submission.submitted_by !== userId &&
    !recorderIds.includes(userId)
  );
  return {
    ...history,
    can_record: canRecord,
    can_submit: canSubmit,
    can_decide: canDecide,
    entries: history.entries.map((entry) => ({
      ...entry,
      can_void: Boolean(
        canRecord && entry.status === 'active' &&
        (entry.recorded_by === userId || ['owner', 'org_admin'].includes(access.role))
      )
    }))
  };
}

function insertLink(db, values) {
  const bundleId = values.bundleId || crypto.randomBytes(32).toString('hex');
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    values.orgId, values.campaignId, values.recordType, bundleId,
    String(values.recordId), values.relationType, values.userId,
    JSON.stringify(values.metadata || {})
  );
  return { id: Number(result.lastInsertRowid), bundleId };
}

function activeCollaborationLinks(db, campaignId, collaborationId) {
  return db.prepare(`
    SELECT id,bundle_id,relation_type
    FROM campaign_record_links
    WHERE campaign_id=? AND record_type='collaboration' AND record_id=?
      AND relation_type IN ('order','execution','publication','settlement')
      AND revoked_at IS NULL
    ORDER BY CASE relation_type
      WHEN 'settlement' THEN 1
      WHEN 'publication' THEN 2
      WHEN 'execution' THEN 3
      WHEN 'order' THEN 4
      ELSE 99 END,id
  `).all(campaignId, String(collaborationId));
}

function activeCollaborationBundle(db, campaignId, collaborationId) {
  const links = activeCollaborationLinks(db, campaignId, collaborationId);
  if (links.length === 0) return null;
  const bundleIds = new Set(links.map((link) => link.bundle_id));
  if (bundleIds.size !== 1) {
    throw serviceError(
      409,
      'CAMPAIGN_EVIDENCE_IN_USE',
      'Campaign collaboration evidence is inconsistent.'
    );
  }
  return { bundleId: links[0].bundle_id, links };
}

function collaborationCustody(db, collaborationId) {
  const active = db.prepare(`
    SELECT org_id,campaign_id,bundle_id
    FROM campaign_record_links
    WHERE record_type='collaboration' AND record_id=?
      AND relation_type IN ('order','execution','publication','settlement')
      AND revoked_at IS NULL
    ORDER BY id
  `).all(String(collaborationId));
  if (active.length > 0) {
    const identities = new Set(active.map((row) => (
      `${row.org_id}:${row.campaign_id}:${row.bundle_id}`
    )));
    if (identities.size !== 1) {
      throw serviceError(
        409,
        'CAMPAIGN_EVIDENCE_IN_USE',
        'Campaign collaboration evidence is inconsistent.'
      );
    }
    return {
      classification: 'campaign_classified',
      state: 'active',
      orgId: active[0].org_id,
      campaignId: active[0].campaign_id,
      bundleId: active[0].bundle_id
    };
  }
  const historical = db.prepare(`
    SELECT org_id,campaign_id,bundle_id
    FROM campaign_record_links
    WHERE record_type='collaboration' AND record_id=?
      AND relation_type IN ('order','execution','publication','settlement')
      AND revoked_at IS NOT NULL
    ORDER BY revoked_at DESC,id DESC
    LIMIT 1
  `).get(String(collaborationId));
  if (historical) {
    return {
      classification: 'campaign_classified',
      state: 'historical',
      orgId: historical.org_id,
      campaignId: historical.campaign_id,
      bundleId: historical.bundle_id
    };
  }
  return {
    classification: 'unclassified',
    state: 'none',
    orgId: null,
    campaignId: null,
    bundleId: null
  };
}

function insertLinkAttachedEvent(db, values) {
  const recordType = values.recordType || 'collaboration';
  const recordId = values.recordId || values.collaborationId;
  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?, 'link_attached',NULL,NULL,?,?,?,?,?,?)
  `).run(
    values.orgId, values.campaignId, values.userId, values.reason, 'collaboration_link',
    JSON.stringify({
      bundle_id: values.link.bundleId,
      relation_types: [values.relationType],
      record_type: recordType,
      record_id: String(recordId),
      link_ids: [values.link.id]
    }),
    values.requestId || null,
    values.auditFingerprint
  );
}

function insertLinkRevokedEvent(db, values) {
  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?,'link_revoked',NULL,NULL,?,?,?,?,?,?)
  `).run(
    values.orgId,
    values.campaignId,
    values.userId,
    values.reason,
    'collaboration_link',
    JSON.stringify({
      bundle_id: values.bundle.bundleId,
      relation_types: values.bundle.links.map((link) => link.relation_type).sort(),
      record_type: 'collaboration',
      record_id: String(values.collaborationId),
      revoked_link_ids: values.bundle.links.map((link) => link.id).sort((left, right) => left - right)
    }),
    values.requestId || null,
    values.auditFingerprint
  );
}

function insertOperationalCancellationEvent(db, values) {
  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?,'operational_status_changed',NULL,NULL,?,?,?,?,?,?)
  `).run(
    values.orgId,
    values.campaignId,
    values.userId,
    values.reason,
    'collaboration_link',
    JSON.stringify({
      previous_status: 'on_hold',
      next_status: 'cancelled',
      previous_version: values.previousVersion,
      next_version: values.previousVersion + 1
    }),
    values.requestId || null,
    values.auditFingerprint
  );
}

function revokeCollaborationBundle(db, values) {
  const bundle = activeCollaborationBundle(db, values.campaignId, values.collaborationId);
  if (!bundle) {
    throw serviceError(
      409,
      'CAMPAIGN_EVIDENCE_IN_USE',
      'Campaign collaboration evidence is inconsistent.'
    );
  }
  for (const link of bundle.links) {
    const update = db.prepare(`
      UPDATE campaign_record_links
      SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?,revoke_reason=?
      WHERE id=? AND revoked_at IS NULL
    `).run(values.userId, values.reason, link.id);
    if (update.changes !== 1) {
      throw serviceError(
        409,
        'CAMPAIGN_EVIDENCE_IN_USE',
        'Campaign collaboration evidence changed concurrently.'
      );
    }
  }
  return bundle;
}

function updateCollaborationCancelled(db, values) {
  const update = db.prepare(`
    UPDATE collaborations
    SET status='cancelled',row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND row_version=?
      AND status IN ('proposed','contacted','negotiating','confirmed','contract_sent','contracted','live','content_review')
  `).run(values.collaborationId, values.expectedVersion);
  if (update.changes !== 1) {
    throw serviceError(
      409,
      'STALE_COLLABORATION_VERSION',
      'Collaboration version is stale.'
    );
  }
}

function cancelWorkflowDependents(db, campaignId) {
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
    SET status='cancelled',lease_until=NULL,lease_token=NULL,next_attempt_at=NULL,
      last_error_code='CAMPAIGN_CANCELLED',last_error='Campaign cancelled',
      updated_at=CURRENT_TIMESTAMP
    WHERE campaign_id=?
      AND status IN ('pending','processing','failed_initialization')
  `).run(campaignId);
}

function cancelCampaignCascade(db, values) {
  const collaborations = db.prepare(`
    SELECT collaboration.id,collaboration.row_version,
      COUNT(DISTINCT link.bundle_id) AS active_bundle_count
    FROM collaborations collaboration
    JOIN campaign_record_links link
      ON link.record_type='collaboration'
     AND link.record_id=CAST(collaboration.id AS TEXT)
     AND link.campaign_id=?
     AND link.relation_type IN ('order','execution','publication','settlement')
     AND link.revoked_at IS NULL
    WHERE collaboration.status IN ('proposed','contacted','negotiating','confirmed','contract_sent','contracted','live','content_review')
    GROUP BY collaboration.id,collaboration.row_version
    ORDER BY collaboration.id
  `).all(values.campaignId);
  const target = collaborations.find((row) => row.id === values.collaborationId);
  if (!target || target.row_version !== values.expectedVersion) {
    throw serviceError(
      409,
      'STALE_COLLABORATION_VERSION',
      'Collaboration version is stale.'
    );
  }
  if (collaborations.some((row) => row.active_bundle_count !== 1)) {
    throw serviceError(
      409,
      'CAMPAIGN_EVIDENCE_IN_USE',
      'Campaign collaboration evidence is inconsistent.'
    );
  }
  if (
    values.campaignVersion === SAFE_MAX ||
    collaborations.some((row) => row.row_version === SAFE_MAX)
  ) {
    throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
  }
  for (const collaboration of collaborations) {
    revokeCollaborationBundle(db, {
      campaignId: values.campaignId,
      collaborationId: collaboration.id,
      userId: values.userId,
      reason: values.reason
    });
    updateCollaborationCancelled(db, {
      collaborationId: collaboration.id,
      expectedVersion: collaboration.row_version
    });
  }
  cancelWorkflowDependents(db, values.campaignId);
  const campaignUpdate = db.prepare(`
    UPDATE campaigns
    SET operational_status='cancelled',row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND operational_status='on_hold' AND row_version=?
  `).run(values.campaignId, values.campaignVersion);
  if (campaignUpdate.changes !== 1) {
    throw serviceError(
      409,
      'INVALID_COLLABORATION_TRANSITION',
      'Collaboration cancellation requires a held campaign.'
    );
  }
  insertOperationalCancellationEvent(db, {
    orgId: values.orgId,
    campaignId: values.campaignId,
    userId: values.userId,
    reason: values.reason,
    previousVersion: values.campaignVersion,
    requestId: values.requestId,
    auditFingerprint: values.auditFingerprint
  });
}

function isOrderedOrLater(lifecycleState) {
  return LIFECYCLE_STATES.indexOf(lifecycleState) >= LIFECYCLE_STATES.indexOf('ordered');
}

function errorResponse(code, message) {
  return { error: message, code };
}

function completeJson(db, reservation, hash, statusCode, responseBody) {
  idempotencyService.completeJsonInTransaction(db, {
    ledgerId: reservation.ledgerId,
    requestHash: hash,
    leaseToken: reservation.leaseToken,
    statusCode,
    responseBody
  });
  return { status: statusCode, body: responseBody };
}

function collaborationArchive(db, values) {
  const row = db.prepare(`
    SELECT id,influencer_id,status,row_version,cost_quoted,cost_actual,cost_actual_confirmed
    FROM collaborations
    WHERE id=?
  `).get(values.collaborationId);
  if (!row) throw new Error('Committed collaboration was not found.');
  const campaignRelation = values.campaignRelation === undefined
    ? null
    : values.campaignRelation;
  if (campaignRelation !== null && !COLLABORATION_RELATIONS.includes(campaignRelation)) {
    throw new Error('Committed collaboration campaign relation is invalid.');
  }
  const contentValues = {
    id: row.id,
    influencer_id: row.influencer_id,
    status: row.status,
    row_version: row.row_version,
    campaign_relation: campaignRelation,
    cost_actual: row.cost_actual,
    cost_actual_confirmed: row.cost_actual_confirmed
  };
  if (values.resource) {
    contentValues.cost_quoted = row.cost_quoted;
    contentValues.resource = values.resource;
  }
  const content = JSON.stringify(contentValues);
  const archive = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: values.orgId,
    campaignId: values.campaignId,
    createdBy: values.userId,
    entryType: 'campaign_collaboration',
    title: `Campaign collaboration #${row.id}`,
    summary: archiveSummary(content),
    content,
    tags: ['campaign', 'collaboration'],
    sourceType: 'campaign_collaboration',
    sourceId: `${row.id}:${row.row_version}`,
    visibility: 'team',
    metadata: {}
  });
  if (archive.status !== 'created') {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Collaboration archive evidence already exists.');
  }
  insertLink(db, {
    orgId: values.orgId,
    campaignId: values.campaignId,
    userId: values.userId,
    recordType: 'knowledge_entry',
    recordId: archive.entry.id,
    relationType: 'knowledge',
    metadata: { producer_type: 'collaboration', producer_id: values.collaborationId }
  });
  knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, archive.capacityGaugePlan);
  return archive;
}

function createCampaignCollaborationService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('campaign collaboration service requires a SQLite database');
  }
  const publicationHandoffService = options.publicationHandoffService || null;
  if (
    publicationHandoffService &&
    (
      typeof publicationHandoffService.confirmBatch !== 'function' ||
      typeof publicationHandoffService.correct !== 'function' ||
      typeof publicationHandoffService.changeTracking !== 'function' ||
      typeof publicationHandoffService.history !== 'function' ||
      typeof publicationHandoffService.prepare !== 'function' ||
      typeof publicationHandoffService.prepareCorrection !== 'function' ||
      typeof publicationHandoffService.project !== 'function'
    )
  ) {
    throw new TypeError('campaign collaboration publication handoff service is invalid');
  }

  function list(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    if (!requireActiveActor(db, userId)) return { collaborations: [] };
    const rawCampaignId = input && input.campaignId;
    const campaignId = rawCampaignId === undefined || rawCampaignId === null || rawCampaignId === ''
      ? null
      : Number(rawCampaignId);
    if (campaignId !== null && (!Number.isSafeInteger(campaignId) || campaignId < 1)) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'Campaign id is invalid.');
    }
    const includeCampaignContext = campaignId !== null ||
      input && (input.includeCampaignContext === true || input.includeCampaignContext === '1' || input.includeCampaignContext === 'true');
    const scope = authorizedCollaborationScope(userId);
    const conditions = [];
    const params = [...scope.params];
    if (input.status) {
      conditions.push('collaboration.status=?');
      params.push(input.status);
    }
    if (input.demandId) {
      conditions.push('collaboration.demand_id=?');
      params.push(parseInt(input.demandId));
    }
    if (campaignId !== null) {
      conditions.push('authorized.custody_campaign_id=?');
      params.push(campaignId);
    }
    const contextProjection = includeCampaignContext
      ? `, collaboration.row_version,
        authorized.custody_campaign_id AS campaign_id,
        campaign.name AS campaign_name,
        campaign.lifecycle_state AS campaign_lifecycle_state,
        campaign.operational_status AS campaign_operational_status`
      : '';
    const contextJoin = includeCampaignContext
      ? 'LEFT JOIN campaigns campaign ON campaign.id=authorized.custody_campaign_id'
      : '';
    const rows = db.prepare(`
      WITH ${scope.sql}
      SELECT ${legacyCollaborationColumns('collaboration')}${contextProjection}
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
      JOIN influencers influencer ON collaboration.influencer_id=influencer.id
      ${contextJoin}
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY collaboration.updated_at DESC
      LIMIT 200
    `).all(...params);
    const accessByCampaign = new Map();
    const collaborations = includeCampaignContext
      ? rows.map((row) => {
          if (row.campaign_id === null) {
            return {
              ...row,
              active_relations: [],
              contract_documents: [],
              contract_confirmation: null,
              content_review: null,
              payment_settlement: null,
              performance_tracking: null
            };
          }
          const relations = activeRelations(db, row.campaign_id, row.id);
          let access = accessByCampaign.get(row.campaign_id);
          if (!access) {
            access = requireCampaignAccess(db, userId, row.campaign_id);
            accessByCampaign.set(row.campaign_id, access);
          }
          const review = contentReviewHistory(db, row.campaign_id, row.id, row.content_url);
          const resource = v2CollaborationResource(row.proposal_notes);
          const paymentSettlement = paymentSettlementHistory(
            db,
            row.campaign_id,
            row.id,
            resource,
            relations
          );
          return {
            ...row,
            active_relations: relations,
            contract_documents: contractDocuments(db, row.campaign_id, row.id),
            contract_confirmation: contractConfirmation(db, row.campaign_id, row.id),
            content_review: projectContentReviewCapabilities(
              access,
              userId,
              row,
              relations,
              review
            ),
            performance_tracking: publicationHandoffService
              ? publicationHandoffService.project({
                orgId: access.campaign.org_id,
                campaignId: row.campaign_id,
                collaborationId: row.id,
                writable: Boolean(
                  access.permissions.write && row.status === 'completed' && relations.includes('publication')
                )
              })
              : null,
            payment_settlement: projectPaymentSettlementCapabilities(
              db,
              access,
              userId,
              row.campaign_id,
              row,
              relations,
              paymentSettlement
            )
          };
        })
      : rows;
    return { collaborations };
  }

  function closeoutSnapshot(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const campaignId = requirePositiveSafeId(input && input.campaignId, 'campaignId');
    if (!requireActiveActor(db, userId)) {
      throw serviceError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign access is unavailable.');
    }
    const access = requireCampaignWrite(db, userId, campaignId);
    if (!['settled', 'reviewed'].includes(access.campaign.lifecycle_state)) {
      throw serviceError(
        409,
        'CAMPAIGN_NOT_SETTLED',
        'Campaign must be settled before closeout review.',
        { lifecycle_state: access.campaign.lifecycle_state }
      );
    }
    const rows = db.prepare(`
      SELECT
        collaboration.id,collaboration.status,collaboration.cost_actual_confirmed,
        collaboration.proposal_notes
      FROM collaborations collaboration
      JOIN campaign_record_links link
        ON link.record_type='collaboration'
       AND link.record_id=CAST(collaboration.id AS TEXT)
       AND link.campaign_id=?
       AND link.relation_type IN ('order','execution','publication','settlement')
       AND link.revoked_at IS NULL
      WHERE collaboration.status<>'cancelled'
      GROUP BY
        collaboration.id,collaboration.status,collaboration.cost_actual_confirmed,
        collaboration.proposal_notes
      ORDER BY collaboration.id
      LIMIT ?
    `).all(campaignId, CLOSEOUT_SNAPSHOT_MAX_COLLABORATIONS + 1);
    if (rows.length > CLOSEOUT_SNAPSHOT_MAX_COLLABORATIONS) {
      throw serviceError(
        413,
        'CAMPAIGN_CLOSEOUT_SNAPSHOT_TOO_LARGE',
        'Campaign has too many collaborations for one closeout snapshot.',
        { maximum: CLOSEOUT_SNAPSHOT_MAX_COLLABORATIONS }
      );
    }
    const campaignCurrency = /^[A-Z]{3}$/.test(String(access.campaign.currency || ''))
      ? String(access.campaign.currency)
      : null;
    let currency = campaignCurrency;
    let completedCount = 0;
    let settledCount = 0;
    let v2SettledCount = 0;
    let legacySettledCount = 0;
    let creatorPaymentTotal = 0;
    let clientReceiptTotal = 0;
    for (const row of rows) {
      if (row.status === 'completed') completedCount += 1;
      const relations = activeRelations(db, campaignId, row.id);
      if (!relations.includes('settlement')) continue;
      const resource = v2CollaborationResource(row.proposal_notes);
      const history = paymentSettlementHistory(db, campaignId, row.id, resource, relations);
      if (row.status !== 'completed' || row.cost_actual_confirmed !== 1) {
        paymentEvidenceError();
      }
      if (resource) {
        if (history.status !== 'settled') paymentEvidenceError();
        if (currency !== null && resource.currency !== currency) {
          throw serviceError(
            409,
            'CAMPAIGN_CLOSEOUT_CURRENCY_CONFLICT',
            'Campaign closeout snapshot contains mixed currencies.'
          );
        }
        currency = currency || resource.currency;
        creatorPaymentTotal += history.creator_payment_total;
        clientReceiptTotal += history.client_receipt_total;
        v2SettledCount += 1;
      } else {
        if (history.status !== 'legacy_settled') paymentEvidenceError();
        legacySettledCount += 1;
      }
      settledCount += 1;
    }
    return {
      campaign_id: campaignId,
      verified: true,
      source: 'campaign_collaboration_ledger',
      collaboration_count: rows.length,
      completed_count: completedCount,
      settled_count: settledCount,
      v2_settled_count: v2SettledCount,
      legacy_settled_count: legacySettledCount,
      currency: currency || 'USD',
      creator_payment_total: creatorPaymentTotal,
      client_receipt_total: clientReceiptTotal
    };
  }

  function get(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    if (!requireActiveActor(db, userId)) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    const row = readAuthorizedCollaboration(db, userId, collaborationId, false);
    if (!row) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    return row;
  }

  function contractDocumentContext(userId, collaborationId, options = {}) {
    if (!requireActiveActor(db, userId)) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    const custody = collaborationCustody(db, collaborationId);
    const readableState = custody.classification === 'campaign_classified' &&
      (custody.state === 'active' || (!options.write && custody.state === 'historical'));
    if (!readableState || (options.campaignId && custody.campaignId !== options.campaignId)) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    let access;
    try {
      access = requireCampaignAccess(db, userId, custody.campaignId);
    } catch (_error) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    if (options.write && !access.permissions.write) {
      throw serviceError(
        409,
        access.campaign.operational_status === 'cancelled' ? 'CAMPAIGN_CANCELLED' : 'CAMPAIGN_ON_HOLD',
        'Campaign is not writable.',
        { operational_status: access.campaign.operational_status }
      );
    }
    const current = db.prepare('SELECT * FROM collaborations WHERE id=?').get(collaborationId);
    if (!current) throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    return { access, custody, current };
  }

  function listContractDocuments(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const context = contractDocumentContext(userId, collaborationId);
    return {
      campaign_id: context.custody.campaignId,
      collaboration_id: collaborationId,
      documents: contractDocuments(db, context.custody.campaignId, collaborationId)
    };
  }

  function listContentReviews(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const context = contractDocumentContext(userId, collaborationId);
    const relations = activeRelations(db, context.custody.campaignId, collaborationId);
    const review = contentReviewHistory(
      db,
      context.custody.campaignId,
      collaborationId,
      context.current.content_url
    );
    return {
      campaign_id: context.custody.campaignId,
      collaboration_id: collaborationId,
      status: context.current.status,
      row_version: context.current.row_version,
      content_review: projectContentReviewCapabilities(
        context.access,
        userId,
        context.current,
        relations,
        review
      )
    };
  }

  function listPayments(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const context = contractDocumentContext(userId, collaborationId);
    const relations = activeRelations(db, context.custody.campaignId, collaborationId);
    const resource = v2CollaborationResource(context.current.proposal_notes);
    const history = paymentSettlementHistory(
      db,
      context.custody.campaignId,
      collaborationId,
      resource,
      relations
    );
    return {
      campaign_id: context.custody.campaignId,
      collaboration_id: collaborationId,
      status: context.current.status,
      row_version: context.current.row_version,
      payment_settlement: projectPaymentSettlementCapabilities(
        db,
        context.access,
        userId,
        context.custody.campaignId,
        context.current,
        relations,
        history
      )
    };
  }

  function persistContentReviewEvidence(values) {
    const sourceId = `${values.collaborationId}:${values.rowVersion}:${values.action}`;
    const evidence = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
      organizationId: values.orgId,
      campaignId: values.campaignId,
      createdBy: values.userId,
      entryType: 'collaboration_content_review',
      title: `Content review checkpoint #${values.collaborationId}-${values.rowVersion}`,
      summary: `Content review evidence recorded for collaboration #${values.collaborationId}.`,
      content: JSON.stringify({
        collaboration_id: values.collaborationId,
        checkpoint: 'content_review',
        action: values.action,
        evidence_recorded: true
      }),
      tags: ['campaign', 'collaboration', 'content-review'],
      sourceType: 'collaboration_content_review',
      sourceId,
      visibility: 'team',
      metadata: values.metadata
    });
    if (evidence.status !== 'created') {
      throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Content review evidence already exists.');
    }
    const evidenceLink = insertLink(db, {
      orgId: values.orgId,
      campaignId: values.campaignId,
      userId: values.userId,
      recordType: 'knowledge_entry',
      recordId: evidence.entry.id,
      relationType: 'knowledge',
      metadata: {
        producer_type: 'collaboration_content_review',
        producer_id: values.collaborationId,
        source_type: 'collaboration_content_review',
        source_id: sourceId
      }
    });
    insertLinkAttachedEvent(db, {
      orgId: values.orgId,
      campaignId: values.campaignId,
      userId: values.userId,
      recordType: 'knowledge_entry',
      recordId: evidence.entry.id,
      relationType: 'knowledge',
      link: evidenceLink,
      requestId: values.requestId,
      auditFingerprint: values.auditFingerprint,
      reason: values.reason
    });
    knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, evidence.capacityGaugePlan);
    return evidence;
  }

  function persistPaymentSettlementEvidence(values) {
    const sourceId = `${values.collaborationId}:${values.rowVersion}:${values.action}`;
    const evidence = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
      organizationId: values.orgId,
      campaignId: values.campaignId,
      createdBy: values.userId,
      entryType: 'collaboration_payment_settlement',
      title: `Payment settlement checkpoint #${values.collaborationId}-${values.rowVersion}`,
      summary: `Protected financial evidence recorded for collaboration #${values.collaborationId}.`,
      content: JSON.stringify({
        collaboration_id: values.collaborationId,
        checkpoint: 'payment_settlement',
        action: values.action,
        evidence_recorded: true
      }),
      tags: ['campaign', 'collaboration', 'payment-settlement'],
      sourceType: 'collaboration_payment_settlement',
      sourceId,
      visibility: 'team',
      metadata: values.metadata
    });
    if (evidence.status !== 'created') {
      throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Payment and settlement evidence already exists.');
    }
    const evidenceLink = insertLink(db, {
      orgId: values.orgId,
      campaignId: values.campaignId,
      userId: values.userId,
      recordType: 'knowledge_entry',
      recordId: evidence.entry.id,
      relationType: 'knowledge',
      metadata: {
        producer_type: 'collaboration_payment_settlement',
        producer_id: values.collaborationId,
        source_type: 'collaboration_payment_settlement',
        source_id: sourceId
      }
    });
    if (values.emitLinkEvent !== false) {
      insertLinkAttachedEvent(db, {
        orgId: values.orgId,
        campaignId: values.campaignId,
        userId: values.userId,
        recordType: 'knowledge_entry',
        recordId: evidence.entry.id,
        relationType: 'knowledge',
        link: evidenceLink,
        requestId: values.requestId,
        auditFingerprint: values.auditFingerprint,
        reason: values.reason
      });
    }
    knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, evidence.capacityGaugePlan);
    return evidence;
  }

  function recordPayment(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const payment = normalizedPaymentRecord(input && input.body);
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: payment.campaignId
    });
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const payload = {
      campaign_id: payment.campaignId,
      expected_version: payment.expectedVersion,
      direction: payment.direction,
      amount: payment.amount,
      paid_at: payment.paidAt,
      payment_method: payment.paymentMethod,
      payment_reference: payment.paymentReference,
      counterparty_name: payment.counterpartyName,
      tranche: payment.tranche,
      payment_note: payment.paymentNote
    };
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/payments`,
      campaignId: payment.campaignId,
      kind: 'json',
      payload
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: payment.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: payment.campaignId
      });
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const current = context.current;
      if (current.row_version !== payment.expectedVersion) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const resource = v2CollaborationResource(current.proposal_notes);
      if (!resource) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Payment evidence requires a version 2 order.');
      }
      const relations = activeRelations(db, payment.campaignId, collaborationId);
      const contractReady = Boolean(
        contractConfirmation(db, payment.campaignId, collaborationId) ||
        relations.includes('execution') || relations.includes('publication')
      );
      if (
        !contractReady || !['contracted', 'live', 'content_review', 'completed'].includes(current.status) ||
        relations.includes('settlement')
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Payment recording is unavailable from the current stage.');
      }
      const history = paymentSettlementHistory(
        db,
        payment.campaignId,
        collaborationId,
        resource,
        relations
      );
      if (history.status === 'pending_review') {
        throw serviceError(409, 'SETTLEMENT_REVIEW_PENDING', 'Payment recording is locked during settlement review.');
      }
      const candidate = {
        direction: payment.direction,
        amount: payment.amount,
        currency: resource.currency,
        paid_at: payment.paidAt,
        payment_method: payment.paymentMethod,
        payment_reference: payment.paymentReference,
        counterparty_name: payment.counterpartyName,
        tranche: payment.tranche
      };
      const fingerprint = paymentFingerprint(candidate);
      const conflict = history.entries.find((entry) => entry.status === 'active' && (
        entry.fingerprint === fingerprint ||
        (entry.direction === payment.direction && entry.payment_reference === payment.paymentReference)
      ));
      if (conflict) {
        throw serviceError(409, 'PAYMENT_EVIDENCE_EXISTS', 'The payment reference or fingerprint is already active.', {
          payment_entry_id: conflict.id
        });
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }
      const rowVersion = payment.expectedVersion + 1;
      const update = db.prepare(`
        UPDATE collaborations
        SET row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(collaborationId, payment.expectedVersion);
      if (update.changes !== 1) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const recordedAt = db.prepare(`
        SELECT replace(CURRENT_TIMESTAMP,' ','T') || '.000Z' AS now
      `).get().now;
      persistPaymentSettlementEvidence({
        orgId: context.access.campaign.org_id,
        campaignId: payment.campaignId,
        collaborationId,
        userId,
        rowVersion,
        action: 'payment_recorded',
        metadata: {
          schema_version: 1,
          collaboration_id: collaborationId,
          row_version: rowVersion,
          action: 'payment_recorded',
          direction: payment.direction,
          amount: payment.amount,
          currency: resource.currency,
          paid_at: payment.paidAt,
          payment_method: payment.paymentMethod,
          payment_reference: payment.paymentReference,
          counterparty_name: payment.counterpartyName,
          tranche: payment.tranche,
          payment_note: payment.paymentNote,
          payment_fingerprint: fingerprint,
          actor_user_id: userId,
          recorded_at: recordedAt,
          retrieval_eligible: false
        },
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: payment.direction === 'creator_payment' ? 'Creator payment recorded' : 'Client receipt recorded'
      });
      const paymentHistory = paymentSettlementHistory(
        db,
        payment.campaignId,
        collaborationId,
        resource,
        relations
      );
      const response = {
        success: true,
        campaign_id: payment.campaignId,
        collaboration_id: collaborationId,
        status: current.status,
        row_version: rowVersion,
        active_relations: relations,
        payment_settlement: projectPaymentSettlementCapabilities(
          db,
          context.access,
          userId,
          payment.campaignId,
          { ...current, row_version: rowVersion },
          relations,
          paymentHistory
        )
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function voidPayment(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const paymentId = requirePositiveSafeId(input && input.paymentId, 'paymentId');
    const voidInput = normalizedPaymentVoid(input && input.body);
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: voidInput.campaignId
    });
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const payload = {
      campaign_id: voidInput.campaignId,
      expected_version: voidInput.expectedVersion,
      void_reason: voidInput.voidReason
    };
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/payments/${paymentId}/void`,
      campaignId: voidInput.campaignId,
      kind: 'json',
      payload
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: voidInput.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: voidInput.campaignId
      });
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const current = context.current;
      if (current.row_version !== voidInput.expectedVersion) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const resource = v2CollaborationResource(current.proposal_notes);
      const relations = activeRelations(db, voidInput.campaignId, collaborationId);
      if (!resource || relations.includes('settlement')) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Payment void is unavailable from the current stage.');
      }
      const history = paymentSettlementHistory(
        db,
        voidInput.campaignId,
        collaborationId,
        resource,
        relations
      );
      if (history.status === 'pending_review') {
        throw serviceError(409, 'SETTLEMENT_REVIEW_PENDING', 'Payment changes are locked during settlement review.');
      }
      const payment = history.entries.find((entry) => entry.id === paymentId && entry.status === 'active');
      if (!payment) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Active payment evidence was not found.');
      }
      if (payment.recorded_by !== userId && !['owner', 'org_admin'].includes(context.access.role)) {
        throw serviceError(403, 'PAYMENT_VOID_FORBIDDEN', 'Only the recorder, campaign owner, or organization administrator may void this evidence.');
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }
      const rowVersion = voidInput.expectedVersion + 1;
      const update = db.prepare(`
        UPDATE collaborations
        SET row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(collaborationId, voidInput.expectedVersion);
      if (update.changes !== 1) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const recordedAt = db.prepare(`
        SELECT replace(CURRENT_TIMESTAMP,' ','T') || '.000Z' AS now
      `).get().now;
      persistPaymentSettlementEvidence({
        orgId: context.access.campaign.org_id,
        campaignId: voidInput.campaignId,
        collaborationId,
        userId,
        rowVersion,
        action: 'payment_voided',
        metadata: {
          schema_version: 1,
          collaboration_id: collaborationId,
          row_version: rowVersion,
          action: 'payment_voided',
          payment_entry_id: payment.id,
          payment_fingerprint: payment.fingerprint,
          void_reason: voidInput.voidReason,
          actor_user_id: userId,
          recorded_at: recordedAt,
          retrieval_eligible: false
        },
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: 'Payment evidence voided'
      });
      const paymentHistory = paymentSettlementHistory(
        db,
        voidInput.campaignId,
        collaborationId,
        resource,
        relations
      );
      const response = {
        success: true,
        campaign_id: voidInput.campaignId,
        collaboration_id: collaborationId,
        status: current.status,
        row_version: rowVersion,
        active_relations: relations,
        payment_settlement: projectPaymentSettlementCapabilities(
          db,
          context.access,
          userId,
          voidInput.campaignId,
          { ...current, row_version: rowVersion },
          relations,
          paymentHistory
        )
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function submitSettlement(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const submission = normalizedSettlementSubmission(input && input.body);
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: submission.campaignId
    });
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const payload = {
      campaign_id: submission.campaignId,
      expected_version: submission.expectedVersion,
      settlement_note: submission.settlementNote,
      variance_reason: submission.varianceReason,
      zero_value_reason: submission.zeroValueReason
    };
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/settlement-submissions`,
      campaignId: submission.campaignId,
      kind: 'json',
      payload
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: submission.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: submission.campaignId
      });
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const current = context.current;
      if (current.row_version !== submission.expectedVersion) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const resource = v2CollaborationResource(current.proposal_notes);
      if (!resource) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Settlement requires a version 2 order.');
      }
      const relations = activeRelations(db, submission.campaignId, collaborationId);
      if (
        current.status !== 'completed' || !relations.includes('publication') ||
        relations.includes('settlement')
      ) {
        throw serviceError(409, 'SETTLEMENT_PUBLICATION_REQUIRED', 'Approved publication is required before settlement review.');
      }
      const history = paymentSettlementHistory(
        db,
        submission.campaignId,
        collaborationId,
        resource,
        relations
      );
      if (history.status === 'pending_review') {
        throw serviceError(409, 'SETTLEMENT_REVIEW_PENDING', 'A settlement submission is already pending review.');
      }
      const active = history.entries.filter((entry) => entry.status === 'active');
      if (history.creator_payment_total === 0 && resource.creator_cost > 0) {
        throw serviceError(409, 'CREATOR_PAYMENT_REQUIRED', 'At least one creator payment is required before settlement.');
      }
      const variance = history.creator_payment_total !== resource.creator_cost ||
        history.client_receipt_total !== resource.client_quote;
      if (variance && !submission.varianceReason) {
        throw serviceError(400, 'SETTLEMENT_VARIANCE_REASON_REQUIRED', 'A variance reason is required for mismatched totals.');
      }
      if (
        active.length === 0 && resource.creator_cost === 0 && resource.client_quote === 0 &&
        !submission.zeroValueReason
      ) {
        throw serviceError(400, 'SETTLEMENT_ZERO_VALUE_REASON_REQUIRED', 'A zero-value reason is required.');
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }
      const rowVersion = submission.expectedVersion + 1;
      const update = db.prepare(`
        UPDATE collaborations
        SET row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(collaborationId, submission.expectedVersion);
      if (update.changes !== 1) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const recordedAt = db.prepare(`
        SELECT replace(CURRENT_TIMESTAMP,' ','T') || '.000Z' AS now
      `).get().now;
      const digest = activePaymentsDigest(active);
      const activeIds = active.map((entry) => entry.id).sort((left, right) => left - right);
      const recorderIds = Array.from(new Set(active.map((entry) => entry.recorded_by)))
        .sort((left, right) => left - right);
      persistPaymentSettlementEvidence({
        orgId: context.access.campaign.org_id,
        campaignId: submission.campaignId,
        collaborationId,
        userId,
        rowVersion,
        action: 'settlement_submitted',
        metadata: {
          schema_version: 1,
          collaboration_id: collaborationId,
          row_version: rowVersion,
          action: 'settlement_submitted',
          currency: resource.currency,
          expected_creator_cost: resource.creator_cost,
          expected_client_receipt: resource.client_quote,
          creator_payment_total: history.creator_payment_total,
          client_receipt_total: history.client_receipt_total,
          payment_digest: digest,
          active_payment_entry_ids: activeIds,
          recorder_user_ids: recorderIds,
          settlement_note: submission.settlementNote,
          variance_reason: submission.varianceReason,
          zero_value_reason: submission.zeroValueReason,
          actor_user_id: userId,
          recorded_at: recordedAt,
          retrieval_eligible: false
        },
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: 'Settlement submitted for independent review'
      });
      const paymentHistory = paymentSettlementHistory(
        db,
        submission.campaignId,
        collaborationId,
        resource,
        relations
      );
      const response = {
        success: true,
        campaign_id: submission.campaignId,
        collaboration_id: collaborationId,
        status: current.status,
        row_version: rowVersion,
        active_relations: relations,
        payment_settlement: projectPaymentSettlementCapabilities(
          db,
          context.access,
          userId,
          submission.campaignId,
          { ...current, row_version: rowVersion },
          relations,
          paymentHistory
        )
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function decideSettlement(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const decision = normalizedSettlementDecision(input && input.body);
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: decision.campaignId
    });
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const payload = {
      campaign_id: decision.campaignId,
      expected_version: decision.expectedVersion,
      submission_entry_id: decision.submissionEntryId,
      decision: decision.decision,
      review_note: decision.reviewNote
    };
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/settlement-decisions`,
      campaignId: decision.campaignId,
      kind: 'json',
      payload
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: decision.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: decision.campaignId
      });
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const current = context.current;
      if (current.row_version !== decision.expectedVersion) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const resource = v2CollaborationResource(current.proposal_notes);
      const relations = activeRelations(db, decision.campaignId, collaborationId);
      if (
        !resource || current.status !== 'completed' || !relations.includes('publication') ||
        relations.includes('settlement')
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Settlement decision is unavailable from the current stage.');
      }
      const history = paymentSettlementHistory(
        db,
        decision.campaignId,
        collaborationId,
        resource,
        relations
      );
      if (
        history.status !== 'pending_review' || !history.current_submission ||
        history.current_submission.id !== decision.submissionEntryId || history.latest_decision
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'There is no matching settlement submission to review.');
      }
      if (
        history.current_submission.submitted_by === userId ||
        history.current_submission.recorder_user_ids.includes(userId)
      ) {
        throw serviceError(409, 'SETTLEMENT_INDEPENDENT_REVIEW_REQUIRED', 'Settlement requires a reviewer independent from submission and payment recording.');
      }
      if (!['owner', 'org_admin'].includes(context.access.role)) {
        throw serviceError(403, 'SETTLEMENT_DECISION_FORBIDDEN', 'Only the campaign owner or organization administrator may review settlement.');
      }
      if (history.current_submission.payment_digest !== activePaymentsDigest(history.entries)) {
        paymentEvidenceError();
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }
      const rowVersion = decision.expectedVersion + 1;
      const approved = decision.decision === 'approved';
      const update = db.prepare(`
        UPDATE collaborations
        SET cost_actual=CASE WHEN ?=1 THEN ? ELSE cost_actual END,
            cost_actual_confirmed=CASE WHEN ?=1 THEN 1 ELSE cost_actual_confirmed END,
            row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(
        approved ? 1 : 0,
        history.creator_payment_total,
        approved ? 1 : 0,
        collaborationId,
        decision.expectedVersion
      );
      if (update.changes !== 1) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const recordedAt = db.prepare(`
        SELECT replace(CURRENT_TIMESTAMP,' ','T') || '.000Z' AS now
      `).get().now;
      const action = approved ? 'settlement_approved' : 'settlement_changes_requested';
      persistPaymentSettlementEvidence({
        orgId: context.access.campaign.org_id,
        campaignId: decision.campaignId,
        collaborationId,
        userId,
        rowVersion,
        action,
        metadata: {
          schema_version: 1,
          collaboration_id: collaborationId,
          row_version: rowVersion,
          action,
          submission_entry_id: history.current_submission.id,
          payment_digest: history.current_submission.payment_digest,
          review_note: decision.reviewNote,
          actor_user_id: userId,
          recorded_at: recordedAt,
          retrieval_eligible: false
        },
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: approved ? 'Settlement approved' : 'Settlement changes requested',
        emitLinkEvent: !approved
      });
      if (approved) {
        const bundle = activeCollaborationBundle(db, decision.campaignId, collaborationId);
        if (!bundle) paymentEvidenceError();
        const settlementLink = insertLink(db, {
          orgId: context.access.campaign.org_id,
          campaignId: decision.campaignId,
          userId,
          recordType: 'collaboration',
          recordId: collaborationId,
          relationType: 'settlement',
          bundleId: bundle.bundleId,
          metadata: {
            approved_by: userId,
            approved_at: recordedAt,
            submission_entry_id: history.current_submission.id,
            payment_digest: history.current_submission.payment_digest
          }
        });
        insertLinkAttachedEvent(db, {
          orgId: context.access.campaign.org_id,
          campaignId: decision.campaignId,
          userId,
          collaborationId,
          relationType: 'settlement',
          link: settlementLink,
          requestId: input.requestId,
          auditFingerprint: reservation.auditFingerprint,
          reason: 'Independent settlement approval'
        });
      }
      collaborationArchive(db, {
        orgId: context.access.campaign.org_id,
        campaignId: decision.campaignId,
        userId,
        collaborationId,
        campaignRelation: approved ? 'settlement' : null
      });
      const nextRelations = activeRelations(db, decision.campaignId, collaborationId);
      const paymentHistory = paymentSettlementHistory(
        db,
        decision.campaignId,
        collaborationId,
        resource,
        nextRelations
      );
      const response = {
        success: true,
        campaign_id: decision.campaignId,
        collaboration_id: collaborationId,
        status: current.status,
        row_version: rowVersion,
        active_relations: nextRelations,
        payment_settlement: projectPaymentSettlementCapabilities(
          db,
          context.access,
          userId,
          decision.campaignId,
          { ...current, row_version: rowVersion, cost_actual: approved ? history.creator_payment_total : current.cost_actual },
          nextRelations,
          paymentHistory
        )
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function submitContentReview(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const submission = normalizedContentReviewSubmission(input && input.body);
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: submission.campaignId
    });
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const payload = {
      campaign_id: submission.campaignId,
      expected_version: submission.expectedVersion,
      content_url: submission.contentUrl,
      content_version: submission.contentVersion,
      submission_note: submission.submissionNote
    };
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/content-reviews`,
      campaignId: submission.campaignId,
      kind: 'json',
      payload
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: submission.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: submission.campaignId
      });
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);

      const current = context.current;
      if (current.row_version !== submission.expectedVersion) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      if (!v2CollaborationResource(current.proposal_notes)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Content review requires a version 2 order.');
      }
      const relations = activeRelations(db, submission.campaignId, collaborationId);
      if (
        !relations.includes('order') || !relations.includes('execution') ||
        relations.includes('publication') || relations.includes('settlement')
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Content review is unavailable from the current campaign stage.');
      }
      const history = contentReviewHistory(
        db,
        submission.campaignId,
        collaborationId,
        current.content_url
      );
      const initialSubmission = current.status === 'live' && history.status === 'not_submitted';
      const legacySubmission = current.status === 'content_review' && history.status === 'not_submitted';
      const resubmission = current.status === 'live' && history.status === 'changes_requested';
      const historicalCompletedSubmission = current.status === 'completed' && history.status === 'not_submitted';
      if (!initialSubmission && !legacySubmission && !resubmission && !historicalCompletedSubmission) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Content review submission is unavailable from the current status.');
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }
      const rowVersion = submission.expectedVersion + 1;
      const update = db.prepare(`
        UPDATE collaborations
        SET status='content_review',content_url=?,row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(submission.contentUrl, collaborationId, submission.expectedVersion);
      if (update.changes !== 1) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const recordedAt = db.prepare(`
        SELECT replace(CURRENT_TIMESTAMP,' ','T') || '.000Z' AS now
      `).get().now;
      persistContentReviewEvidence({
        orgId: context.access.campaign.org_id,
        campaignId: submission.campaignId,
        collaborationId,
        userId,
        rowVersion,
        action: 'submitted',
        metadata: {
          schema_version: 1,
          collaboration_id: collaborationId,
          row_version: rowVersion,
          action: 'submitted',
          content_url: submission.contentUrl,
          content_url_sha256: submission.contentUrlSha256,
          content_version: submission.contentVersion,
          submission_note: submission.submissionNote,
          actor_user_id: userId,
          recorded_at: recordedAt,
          retrieval_eligible: false
        },
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: 'Content submitted for review'
      });
      collaborationArchive(db, {
        orgId: context.access.campaign.org_id,
        campaignId: submission.campaignId,
        userId,
        collaborationId,
        campaignRelation: null
      });
      const contentReview = contentReviewHistory(
        db,
        submission.campaignId,
        collaborationId,
        submission.contentUrl
      );
      const response = {
        success: true,
        campaign_id: submission.campaignId,
        collaboration_id: collaborationId,
        status: 'content_review',
        row_version: rowVersion,
        active_relations: relations,
        content_review: projectContentReviewCapabilities(
          context.access,
          userId,
          {
            ...current,
            status: 'content_review',
            row_version: rowVersion,
            content_url: submission.contentUrl
          },
          relations,
          contentReview
        )
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function decideContentReview(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const decision = normalizedContentReviewDecision(input && input.body);
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: decision.campaignId
    });
    if (!['owner', 'org_admin'].includes(initialContext.access.role)) {
      throw serviceError(403, 'CONTENT_REVIEW_DECISION_FORBIDDEN', 'Only the campaign owner or organization administrator may review content.');
    }
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const payload = {
      campaign_id: decision.campaignId,
      expected_version: decision.expectedVersion,
      decision: decision.decision,
      review_note: decision.reviewNote
    };
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/content-review-decisions`,
      campaignId: decision.campaignId,
      kind: 'json',
      payload
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: decision.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: decision.campaignId
      });
      if (!['owner', 'org_admin'].includes(context.access.role)) {
        throw serviceError(403, 'CONTENT_REVIEW_DECISION_FORBIDDEN', 'Only the campaign owner or organization administrator may review content.');
      }
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);

      const current = context.current;
      if (current.row_version !== decision.expectedVersion) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      if (current.status !== 'content_review' || !v2CollaborationResource(current.proposal_notes)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Content review decision is unavailable from the current status.');
      }
      const relations = activeRelations(db, decision.campaignId, collaborationId);
      if (
        !relations.includes('order') || !relations.includes('execution') ||
        relations.includes('publication') || relations.includes('settlement')
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Content review decision is unavailable from the current campaign stage.');
      }
      const history = contentReviewHistory(
        db,
        decision.campaignId,
        collaborationId,
        current.content_url
      );
      if (history.status !== 'pending' || !history.current_submission || history.latest_decision) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'There is no pending content submission to review.');
      }
      if (history.current_submission.submitted_by === userId) {
        throw serviceError(409, 'CONTENT_REVIEW_SELF_APPROVAL', 'Content submissions require an independent reviewer.');
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }
      const rowVersion = decision.expectedVersion + 1;
      const nextStatus = decision.decision === 'approved' ? 'content_review' : 'live';
      const update = db.prepare(`
        UPDATE collaborations
        SET status=?,row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(nextStatus, collaborationId, decision.expectedVersion);
      if (update.changes !== 1) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const recordedAt = db.prepare(`
        SELECT replace(CURRENT_TIMESTAMP,' ','T') || '.000Z' AS now
      `).get().now;
      persistContentReviewEvidence({
        orgId: context.access.campaign.org_id,
        campaignId: decision.campaignId,
        collaborationId,
        userId,
        rowVersion,
        action: decision.decision,
        metadata: {
          schema_version: 1,
          collaboration_id: collaborationId,
          row_version: rowVersion,
          action: decision.decision,
          submission_entry_id: history.current_submission.id,
          content_url_sha256: history.current_submission.content_url_sha256,
          content_version: history.current_submission.content_version,
          review_note: decision.reviewNote,
          actor_user_id: userId,
          recorded_at: recordedAt,
          retrieval_eligible: false
        },
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: decision.decision === 'approved'
          ? 'Content review approved'
          : 'Content changes requested'
      });
      collaborationArchive(db, {
        orgId: context.access.campaign.org_id,
        campaignId: decision.campaignId,
        userId,
        collaborationId,
        campaignRelation: null
      });
      const contentReview = contentReviewHistory(
        db,
        decision.campaignId,
        collaborationId,
        current.content_url
      );
      const response = {
        success: true,
        campaign_id: decision.campaignId,
        collaboration_id: collaborationId,
        status: nextStatus,
        row_version: rowVersion,
        active_relations: relations,
        content_review: projectContentReviewCapabilities(
          context.access,
          userId,
          { ...current, status: nextStatus, row_version: rowVersion },
          relations,
          contentReview
        )
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function confirmPublication(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const body = input && input.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw serviceError(400, 'INVALID_PUBLICATION_CONFIRMATION', 'Publication confirmation body is invalid.');
    }
    for (const key of Object.keys(body)) {
      if (!PUBLICATION_CONFIRMATION_KEYS.has(key)) {
        throw serviceError(400, 'INVALID_PUBLICATION_CONFIRMATION', 'Publication confirmation body is invalid.', {
          field: key
        });
      }
    }
    if (
      !Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1 ||
      !Number.isSafeInteger(body.expected_version) || body.expected_version < 1
    ) {
      throw serviceError(400, 'INVALID_PUBLICATION_CONFIRMATION', 'campaign_id and expected_version are required.');
    }
    if (!publicationHandoffService) {
      throw serviceError(503, 'PUBLICATION_TRACKING_UNAVAILABLE', 'Publication tracking is unavailable.');
    }
    const prepared = publicationHandoffService.prepare({
      campaignId: body.campaign_id,
      publications: body.publications
    });
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: body.campaign_id
    });
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const payload = {
      campaign_id: body.campaign_id,
      expected_version: body.expected_version,
      publications: prepared.items.map((item) => ({
        deliverable_key: item.deliverableKey,
        url: item.url,
        published_at: item.publishedAt,
        note: item.note
      }))
    };
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/publication-confirmations`,
      campaignId: body.campaign_id,
      kind: 'json',
      payload
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: body.campaign_id,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: body.campaign_id
      });
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);

      const current = context.current;
      if (current.row_version !== body.expected_version) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const resource = v2CollaborationResource(current.proposal_notes);
      if (!resource) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Publication confirmation requires a version 2 order.');
      }
      const relations = activeRelations(db, body.campaign_id, collaborationId);
      if (
        !['content_review', 'completed'].includes(current.status) ||
        !relations.includes('order') || !relations.includes('execution') ||
        relations.includes('publication') || relations.includes('settlement')
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Publication confirmation is unavailable from the current campaign stage.');
      }
      const review = contentReviewHistory(db, body.campaign_id, collaborationId, current.content_url);
      if (
        !review.publication_ready || !review.current_submission || !review.latest_decision ||
        review.latest_decision.action !== 'approved'
      ) {
        throw serviceError(409, 'CONTENT_REVIEW_REQUIRED', 'Approved content review evidence is required before publication.');
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }
      const update = db.prepare(`
        UPDATE collaborations
        SET status='completed',row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(collaborationId, body.expected_version);
      if (update.changes !== 1) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const activeBundle = activeCollaborationBundle(db, body.campaign_id, collaborationId);
      if (!activeBundle) {
        throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Campaign collaboration evidence is inconsistent.');
      }
      const confirmedAt = db.prepare(`
        SELECT replace(CURRENT_TIMESTAMP,' ','T') || '.000Z' AS now
      `).get().now;
      const link = insertLink(db, {
        orgId: context.access.campaign.org_id,
        campaignId: body.campaign_id,
        userId,
        recordType: 'collaboration',
        recordId: collaborationId,
        relationType: 'publication',
        bundleId: activeBundle.bundleId,
        metadata: {
          confirmed_by: userId,
          confirmed_at: confirmedAt,
          publication_count: prepared.items.length,
          source: 'publication_confirmation'
        }
      });
      insertLinkAttachedEvent(db, {
        orgId: context.access.campaign.org_id,
        campaignId: body.campaign_id,
        userId,
        collaborationId,
        relationType: 'publication',
        link,
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: 'Final public deliverables confirmed'
      });
      const influencer = db.prepare(`
        SELECT influencer.id,influencer.kol_handle
        FROM influencers influencer
        WHERE influencer.id=?
      `).get(current.influencer_id);
      if (!influencer) {
        throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Collaboration influencer evidence is inconsistent.');
      }
      const performanceTracking = publicationHandoffService.confirmBatch({
        orgId: context.access.campaign.org_id,
        campaignId: body.campaign_id,
        collaborationId,
        actorUserId: userId,
        influencerId: influencer.id,
        creatorName: influencer.kol_handle,
        product: resource.product_name || '',
        orderReference: resource.order_reference || '',
        publicationRelationLinkId: link.id,
        reviewSubmissionEntryId: review.current_submission.id,
        reviewDecisionEntryId: review.latest_decision.id,
        prepared
      });
      collaborationArchive(db, {
        orgId: context.access.campaign.org_id,
        campaignId: body.campaign_id,
        userId,
        collaborationId,
        campaignRelation: 'publication'
      });
      const response = {
        success: true,
        campaign_id: body.campaign_id,
        collaboration_id: collaborationId,
        status: 'completed',
        row_version: body.expected_version + 1,
        active_relations: activeRelations(db, body.campaign_id, collaborationId),
        performance_tracking: performanceTracking
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function correctPublication(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(input && input.collaborationId, 'collaborationId');
    const body = input && input.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw serviceError(400, 'INVALID_PUBLICATION_CORRECTION', 'Publication correction body is invalid.');
    }
    for (const key of Object.keys(body)) {
      if (!PUBLICATION_CORRECTION_KEYS.has(key)) {
        throw serviceError(400, 'INVALID_PUBLICATION_CORRECTION', 'Publication correction body is invalid.', { field: key });
      }
    }
    if (
      !Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1 ||
      !Number.isSafeInteger(body.expected_version) || body.expected_version < 1 ||
      !Number.isSafeInteger(body.custody_id) || body.custody_id < 1 ||
      body.same_content_confirmed !== true
    ) {
      throw serviceError(400, 'INVALID_PUBLICATION_CORRECTION', 'Campaign, lifecycle version, custody, and correction confirmation are required.');
    }
    if (!publicationHandoffService) {
      throw serviceError(503, 'PUBLICATION_TRACKING_UNAVAILABLE', 'Publication tracking is unavailable.');
    }
    const prepared = publicationHandoffService.prepareCorrection({
      campaignId: body.campaign_id,
      correction: {
        url: body.url,
        published_at: body.published_at,
        correction_reason: body.correction_reason
      }
    });
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: body.campaign_id
    });
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const payload = {
      campaign_id: body.campaign_id,
      expected_version: body.expected_version,
      custody_id: body.custody_id,
      url: prepared.url,
      published_at: prepared.publishedAt,
      correction_reason: prepared.correctionReason,
      same_content_confirmed: true
    };
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/publication-corrections`,
      campaignId: body.campaign_id,
      kind: 'json',
      payload
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: body.campaign_id,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: body.campaign_id
      });
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const current = context.current;
      const relations = activeRelations(db, body.campaign_id, collaborationId);
      if (current.status !== 'completed' || !relations.includes('publication')) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Publication correction requires a completed publication handoff.');
      }
      const changed = publicationHandoffService.correct({
        orgId: context.access.campaign.org_id,
        campaignId: body.campaign_id,
        collaborationId,
        custodyId: body.custody_id,
        actorUserId: userId,
        expectedLifecycleVersion: body.expected_version,
        collaborationRowVersionObserved: current.row_version,
        prepared
      });
      insertLinkAttachedEvent(db, {
        orgId: context.access.campaign.org_id,
        campaignId: body.campaign_id,
        userId,
        collaborationId,
        recordType: 'knowledge_entry',
        recordId: changed.evidence.knowledgeEntryId,
        relationType: 'knowledge',
        link: changed.evidence,
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: prepared.correctionReason
      });
      return completeJson(db, reservation, hash, 201, {
        success: true,
        campaign_id: body.campaign_id,
        collaboration_id: collaborationId,
        status: 'completed',
        row_version: current.row_version,
        lifecycle_version: changed.lifecycleVersion,
        active_relations: relations,
        performance_tracking: changed.projection
      });
    }).immediate();
  }

  function changePublicationTracking(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(input && input.collaborationId, 'collaborationId');
    const body = input && input.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw serviceError(400, 'INVALID_PUBLICATION_TRACKING', 'Publication tracking body is invalid.');
    }
    for (const key of Object.keys(body)) {
      if (!PUBLICATION_TRACKING_KEYS.has(key)) {
        throw serviceError(400, 'INVALID_PUBLICATION_TRACKING', 'Publication tracking body is invalid.', { field: key });
      }
    }
    if (
      !Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1 ||
      !Number.isSafeInteger(body.expected_version) || body.expected_version < 1 ||
      !Number.isSafeInteger(body.custody_id) || body.custody_id < 1 ||
      !['paused', 'resumed'].includes(body.action) ||
      typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500 ||
      /[\u0000-\u001f\u007f]/.test(body.reason.trim())
    ) {
      throw serviceError(400, 'INVALID_PUBLICATION_TRACKING', 'Campaign, version, custody, action, and reason are required.');
    }
    if (!publicationHandoffService) {
      throw serviceError(503, 'PUBLICATION_TRACKING_UNAVAILABLE', 'Publication tracking is unavailable.');
    }
    const reason = body.reason.trim();
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: body.campaign_id
    });
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const payload = {
      campaign_id: body.campaign_id,
      expected_version: body.expected_version,
      custody_id: body.custody_id,
      action: body.action,
      reason
    };
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/publication-tracking-events`,
      campaignId: body.campaign_id,
      kind: 'json',
      payload
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: body.campaign_id,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: body.campaign_id
      });
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const current = context.current;
      const relations = activeRelations(db, body.campaign_id, collaborationId);
      if (current.status !== 'completed' || !relations.includes('publication')) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Publication tracking control requires a completed publication handoff.');
      }
      const changed = publicationHandoffService.changeTracking({
        orgId: context.access.campaign.org_id,
        campaignId: body.campaign_id,
        collaborationId,
        custodyId: body.custody_id,
        actorUserId: userId,
        expectedLifecycleVersion: body.expected_version,
        collaborationRowVersionObserved: current.row_version,
        action: body.action,
        reason
      });
      insertLinkAttachedEvent(db, {
        orgId: context.access.campaign.org_id,
        campaignId: body.campaign_id,
        userId,
        collaborationId,
        recordType: 'knowledge_entry',
        recordId: changed.evidence.knowledgeEntryId,
        relationType: 'knowledge',
        link: changed.evidence,
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason
      });
      return completeJson(db, reservation, hash, 201, {
        success: true,
        campaign_id: body.campaign_id,
        collaboration_id: collaborationId,
        status: 'completed',
        row_version: current.row_version,
        lifecycle_version: changed.lifecycleVersion,
        active_relations: relations,
        performance_tracking: changed.projection
      });
    }).immediate();
  }

  function listPublicationHistory(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(input && input.collaborationId, 'collaborationId');
    const campaignId = requirePositiveSafeId(input && input.campaignId, 'campaignId');
    const custodyId = requirePositiveSafeId(input && input.custodyId, 'custodyId');
    if (!publicationHandoffService) {
      throw serviceError(503, 'PUBLICATION_TRACKING_UNAVAILABLE', 'Publication tracking is unavailable.');
    }
    const context = contractDocumentContext(userId, collaborationId, { campaignId });
    const relations = activeRelations(db, campaignId, collaborationId);
    if (!relations.includes('publication')) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Publication history was not found.');
    }
    return publicationHandoffService.history({
      orgId: context.access.campaign.org_id,
      campaignId,
      collaborationId,
      custodyId,
      limit: input && input.limit,
      beforeVersion: input && input.beforeVersion
    });
  }

  function downloadContractDocument(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const documentId = requirePositiveSafeId(input && input.documentId, 'documentId');
    const context = contractDocumentContext(userId, collaborationId);
    const row = contractDocumentRecord(
      db,
      context.custody.campaignId,
      collaborationId,
      documentId,
      true
    );
    if (!row) throw serviceError(404, 'RECORD_NOT_FOUND', 'Contract document was not found.');
    return {
      document: projectedContractDocument(row),
      bytes: verifiedContractDocumentBytes(row)
    };
  }

  function uploadContractDocument(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const body = input && input.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        !Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) {
      contractDocumentError('INVALID_CONTRACT_DOCUMENT', 'campaign_id');
    }
    const initialContext = contractDocumentContext(userId, collaborationId, {
      write: true,
      campaignId: body.campaign_id
    });
    const document = normalizedContractDocumentUpload(body);
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/contract-documents`,
      campaignId: document.campaignId,
      kind: 'json',
      payload: {
        campaign_id: document.campaignId,
        expected_version: document.expectedVersion,
        filename: document.filename,
        media_type: document.mediaType,
        file_sha256: document.fileSha256
      }
    });
    const reservationInput = {
      organizationId: initialContext.access.campaign.org_id,
      actorUserId: userId,
      campaignId: document.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const context = contractDocumentContext(userId, collaborationId, {
        write: true,
        campaignId: document.campaignId
      });
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      if (context.current.row_version !== document.expectedVersion) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      if (!['confirmed', 'contract_sent'].includes(context.current.status) ||
          !v2CollaborationResource(context.current.proposal_notes)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Contract document upload is not available from the current status.');
      }
      if (db.prepare(`
        SELECT 1 AS present
        FROM collaboration_contract_documents
        WHERE collaboration_id=? AND file_sha256=?
      `).get(collaborationId, document.fileSha256)) {
        throw serviceError(409, 'CONTRACT_DOCUMENT_EXISTS', 'The same contract document was already uploaded.');
      }
      const maximum = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM collaboration_contract_documents').get().id;
      if (!Number.isSafeInteger(maximum) || maximum >= SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Contract document identifier is exhausted.');
      }
      const documentId = maximum + 1;
      const metadata = {
        schema_version: 1,
        collaboration_id: collaborationId,
        document_id: documentId,
        media_type: document.mediaType,
        file_sha256: document.fileSha256,
        file_bytes: document.bytes.length,
        original_filename: document.filename,
        uploaded_by: userId,
        retrieval_eligible: false
      };
      const evidence = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
        organizationId: context.access.campaign.org_id,
        campaignId: document.campaignId,
        createdBy: userId,
        entryType: 'collaboration_contract_document',
        title: `Campaign file evidence #${collaborationId}-${documentId}`,
        summary: `File evidence recorded for collaboration #${collaborationId}.`,
        content: JSON.stringify({
          collaboration_id: collaborationId,
          checkpoint: 'contract_document',
          file_recorded: true
        }),
        tags: ['campaign', 'collaboration', 'contract-document'],
        sourceType: 'collaboration_contract_document',
        sourceId: String(documentId),
        visibility: 'team',
        metadata
      });
      if (evidence.status !== 'created') {
        throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Contract document evidence already exists.');
      }
      const evidenceLink = insertLink(db, {
        orgId: context.access.campaign.org_id,
        campaignId: document.campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: evidence.entry.id,
        relationType: 'knowledge',
        metadata: {
          producer_type: 'collaboration_contract_document',
          producer_id: collaborationId,
          source_type: 'collaboration_contract_document',
          source_id: String(documentId)
        }
      });
      db.prepare(`
        INSERT INTO collaboration_contract_documents (
          id,org_id,campaign_id,collaboration_id,uploaded_by,knowledge_entry_id,
          original_filename,media_type,file_sha256,file_bytes,document_blob
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        documentId,
        context.access.campaign.org_id,
        document.campaignId,
        collaborationId,
        userId,
        evidence.entry.id,
        document.filename,
        document.mediaType,
        document.fileSha256,
        document.bytes.length,
        document.bytes
      );
      insertLinkAttachedEvent(db, {
        orgId: context.access.campaign.org_id,
        campaignId: document.campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: evidence.entry.id,
        relationType: 'knowledge',
        link: evidenceLink,
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: 'Contract document uploaded'
      });
      knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, evidence.capacityGaugePlan);
      const persisted = contractDocumentRecord(
        db,
        document.campaignId,
        collaborationId,
        documentId,
        false
      );
      const response = {
        success: true,
        campaign_id: document.campaignId,
        collaboration_id: collaborationId,
        document: projectedContractDocument(persisted)
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function updateLegacy(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const body = input && input.body && typeof input.body === 'object'
      ? input.body
      : {};
    return db.transaction(() => {
      if (!requireActiveActor(db, userId)) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
      }
      const authorized = readAuthorizedCollaboration(
        db,
        userId,
        collaborationId,
        true
      );
      if (!authorized) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
      }
      const {
        __custody_campaign_id: custodyCampaignId,
        ...current
      } = authorized;
      if (custodyCampaignId !== null) {
        throw serviceError(
          409,
          'CAMPAIGN_CONTEXT_REQUIRED',
          'Campaign context is required for this collaboration.',
          { campaign_id: custodyCampaignId }
        );
      }
      if (Object.hasOwn(body, 'cost_quoted') && isCanonicalCollaborationResource(current.proposal_notes)) {
        throw serviceError(409, 'RESOURCE_QUOTE_LOCKED', 'A confirmed resource order locks its quoted price.');
      }
      const update = db.prepare(`
        UPDATE collaborations
        SET
          status=COALESCE(?,status),
          cost_quoted=COALESCE(?,cost_quoted),
          cost_actual=COALESCE(?,cost_actual),
          content_url=COALESCE(?,content_url),
          notes=COALESCE(?,notes),
          timeline_start=COALESCE(?,timeline_start),
          timeline_end=COALESCE(?,timeline_end),
          row_version=row_version+1,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version<?
      `).run(
        body.status,
        body.cost_quoted,
        body.cost_actual,
        body.content_url,
        body.notes,
        body.timeline_start,
        body.timeline_end,
        collaborationId,
        Number.MAX_SAFE_INTEGER
      );
      if (update.changes !== 1) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }
      return { current, collaboration: get({ userId, collaborationId }) };
    }).immediate();
  }

  function confirmContract(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const body = input && input.body && typeof input.body === 'object' && !Array.isArray(input.body)
      ? input.body
      : null;
    if (!body || !Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) {
      throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
        field: 'campaign_id'
      });
    }
    if (!requireActiveActor(db, userId)) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    get({ userId, collaborationId });
    const campaignId = body.campaign_id;
    const initialCustody = collaborationCustody(db, collaborationId);
    if (
      initialCustody.classification !== 'campaign_classified' ||
      initialCustody.state !== 'active' ||
      initialCustody.campaignId !== campaignId
    ) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    const initialAccess = requireCampaignWrite(db, userId, campaignId);
    const confirmation = normalizedContractConfirmation(body);
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/contract-confirmations`,
      campaignId,
      kind: 'json',
      payload: body
    });
    const reservationInput = {
      organizationId: initialAccess.campaign.org_id,
      actorUserId: userId,
      campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const access = requireCampaignWrite(db, userId, campaignId);
      get({ userId, collaborationId });
      const custody = collaborationCustody(db, collaborationId);
      if (
        custody.classification !== 'campaign_classified' ||
        custody.state !== 'active' ||
        custody.campaignId !== campaignId
      ) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
      }
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);

      const current = db.prepare('SELECT * FROM collaborations WHERE id=?').get(collaborationId);
      if (contractConfirmation(db, campaignId, collaborationId)) {
        throw serviceError(409, 'CONTRACT_ALREADY_CONFIRMED', 'Signed contract was already confirmed.');
      }
      if (current.row_version !== confirmation.expectedVersion) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      if (!['confirmed', 'contract_sent'].includes(current.status)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Signed contract confirmation is not available from the current status.');
      }
      if (!v2CollaborationResource(current.proposal_notes)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Signed contract confirmation requires a version 2 order.');
      }
      const documentRow = contractDocumentRecord(
        db,
        campaignId,
        collaborationId,
        confirmation.contractDocumentId,
        true
      );
      if (!documentRow) {
        throw serviceError(409, 'CONTRACT_DOCUMENT_REQUIRED', 'A contract document from this collaboration is required.');
      }
      verifiedContractDocumentBytes(documentRow);
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }

      const update = db.prepare(`
        UPDATE collaborations
        SET status='contracted',row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(collaborationId, confirmation.expectedVersion);
      if (update.changes !== 1) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const confirmedAt = db.prepare(`
        SELECT replace(CURRENT_TIMESTAMP,' ','T') || '.000Z' AS now
      `).get().now;
      const metadata = {
        schema_version: 2,
        collaboration_id: collaborationId,
        row_version: confirmation.expectedVersion + 1,
        contract_document_id: documentRow.id,
        contract_document_sha256: documentRow.file_sha256,
        contract_reference: confirmation.contractReference,
        counterparty_name: confirmation.counterpartyName,
        signed_at: confirmation.signedAt,
        confirmation_note: confirmation.confirmationNote,
        confirmed_by: userId,
        confirmed_at: confirmedAt,
        retrieval_eligible: false
      };
      const evidenceContent = JSON.stringify({
        collaboration_id: collaborationId,
        checkpoint: 'signed_contract',
        status: 'contracted',
        evidence_recorded: true
      });
      const evidence = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        createdBy: userId,
        entryType: 'collaboration_contract_confirmation',
        title: `Signed contract checkpoint #${collaborationId}`,
        summary: `Signed contract evidence recorded for collaboration #${collaborationId}.`,
        content: evidenceContent,
        tags: ['campaign', 'collaboration', 'contract'],
        sourceType: 'collaboration_contract_confirmation',
        sourceId: `${collaborationId}:${confirmation.expectedVersion + 1}`,
        visibility: 'team',
        metadata
      });
      if (evidence.status !== 'created') {
        throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence already exists.');
      }
      const evidenceLink = insertLink(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: evidence.entry.id,
        relationType: 'knowledge',
        metadata: {
          producer_type: 'collaboration_contract_confirmation',
          producer_id: collaborationId,
          source_type: 'collaboration_contract_confirmation',
          source_id: `${collaborationId}:${confirmation.expectedVersion + 1}`
        }
      });
      insertLinkAttachedEvent(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: evidence.entry.id,
        relationType: 'knowledge',
        link: evidenceLink,
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: 'Signed contract confirmed'
      });
      knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, evidence.capacityGaugePlan);
      collaborationArchive(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        collaborationId,
        campaignRelation: null
      });
      const persisted = contractConfirmation(db, campaignId, collaborationId);
      const response = {
        success: true,
        campaign_id: campaignId,
        status: 'contracted',
        row_version: confirmation.expectedVersion + 1,
        active_relations: activeRelations(db, campaignId, collaborationId),
        contract_confirmation: persisted
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function createLinked(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const body = input && input.body && typeof input.body === 'object' ? input.body : null;
    if (!body) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'campaign_id and influencer_id are required.');
    }
    assertAllowedKeys(body, LINKED_CREATE_KEYS, 'Linked collaboration body is invalid.');
    if (!Number.isSafeInteger(body.campaign_id) || !Number.isSafeInteger(body.influencer_id)) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'campaign_id and influencer_id are required.');
    }
    if (body.status !== undefined && body.status !== 'confirmed') {
      throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Linked collaborations start confirmed.');
    }
    if (isReservedV2ProposalNotes(body.proposal_notes) && !isV2CollaborationResourceInput(body.resource)) {
      throw serviceError(
        400,
        'RESOURCE_V2_REQUIRES_RESOURCE',
        'Version 2 collaboration orders must be supplied through resource.'
      );
    }
    const campaignId = body.campaign_id;
    const initialAccess = requireCampaignWrite(db, userId, campaignId);
    const rawResource = body.resource && typeof body.resource === 'object' ? body.resource : {};
    const hasLegacyResource = Object.keys(rawResource).length > 0;
    const versionedResourceRequest = isVersionedCollaborationResourceInput(body.resource);
    let resourcePayload = null;
    let proposalNotes = body.proposal_notes || (hasLegacyResource ? JSON.stringify(rawResource) : null);
    let costQuoted = body.cost_quoted !== undefined && body.cost_quoted !== null && body.cost_quoted !== ''
      ? body.cost_quoted
      : (rawResource.quoted_price || rawResource.price || 0);
    try {
      if (versionedResourceRequest) {
        resourcePayload = normalizeCollaborationResource(body.resource);
        if (Object.hasOwn(body, 'proposal_notes')) {
          throw serviceError(
            400,
            'RESOURCE_PROPOSAL_NOTES_CONFLICT',
            'resource and proposal_notes cannot be supplied together.'
          );
        }
        proposalNotes = serializeCollaborationResource(resourcePayload);
        costQuoted = resolveResourceQuotedPrice(resourcePayload, body.cost_quoted);
      }
    } catch (error) {
      if (error instanceof CollaborationResourceContractError) {
        throw serviceError(error.statusCode, error.code, error.message, error.details);
      }
      throw error;
    }
    const resourceFallbacks = versionedResourceRequest && resourcePayload.extensions
      ? resourcePayload.extensions
      : rawResource;
    const resourceNoteFallback = typeof resourceFallbacks.notes === 'string' ? resourceFallbacks.notes : '';
    const resourceTimelineStart = typeof resourceFallbacks.timeline_start === 'string' ? resourceFallbacks.timeline_start : null;
    const resourceTimelineEnd = typeof resourceFallbacks.timeline_end === 'string' ? resourceFallbacks.timeline_end : null;
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const hashPayload = resourcePayload
      ? Object.assign({}, body, { resource: resourcePayload, cost_quoted: costQuoted })
      : body;
    const hash = requestHash({
      method: 'POST',
      path: '/api/collaborations',
      campaignId,
      kind: 'json',
      payload: hashPayload
    });
    const reservationInput = {
      organizationId: initialAccess.campaign.org_id,
      actorUserId: userId,
      campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.create.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };
    return db.transaction(() => {
      const access = requireCampaignWrite(db, userId, campaignId);
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const influencer = db.prepare('SELECT id FROM influencers WHERE id=? AND is_active=1').get(body.influencer_id);
      if (!influencer) throw serviceError(404, 'RECORD_NOT_FOUND', 'Influencer was not found.');
      const result = db.prepare(`
        INSERT INTO collaborations (demand_id,influencer_id,user_id,status,proposal_notes,cost_quoted,notes,timeline_start,timeline_end,row_version,cost_actual_confirmed)
        VALUES (?,?,?,?,?,?,?,?,?,1,0)
      `).run(
        body.demand_id || null, body.influencer_id, userId, 'confirmed', proposalNotes,
        costQuoted, body.notes || resourceNoteFallback || '',
        body.timeline_start || resourceTimelineStart, body.timeline_end || resourceTimelineEnd
      );
      const collaborationId = Number(result.lastInsertRowid);
      const archive = collaborationArchive(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        collaborationId,
        campaignRelation: 'order',
        resource: resourcePayload
      });
      const link = insertLink(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'collaboration',
        recordId: collaborationId,
        relationType: 'order',
        metadata: { knowledge_entry_id: archive.entry.id }
      });
      insertLinkAttachedEvent(db, {
        orgId: access.campaign.org_id, campaignId, userId, collaborationId,
        relationType: 'order', link, requestId: input.requestId, auditFingerprint: reservation.auditFingerprint,
        reason: 'Linked order'
      });
      const response = {
        id: collaborationId,
        campaign_id: campaignId,
        row_version: 1,
        active_relations: activeRelations(db, campaignId, collaborationId)
      };
      idempotencyService.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: 201,
        responseBody: response
      });
      return { status: 201, body: response };
    }).immediate();
  }

  function updateLinked(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(input && input.collaborationId, 'collaborationId');
    const body = input && input.body && typeof input.body === 'object' ? input.body : null;
    if (!body) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'campaign_id, expected_version, and reason are required.');
    }
    const cancellation = Object.hasOwn(body, 'action');
    assertAllowedKeys(
      body,
      cancellation ? LINKED_CANCELLATION_KEYS : LINKED_UPDATE_KEYS,
      cancellation
        ? 'Collaboration cancellation body is invalid.'
        : 'Linked collaboration body is invalid.'
    );
    if (
      !Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1 ||
      !Number.isSafeInteger(body.expected_version) || body.expected_version < 1 ||
      typeof body.reason !== 'string' ||
      body.reason.trim().length < 1 || body.reason.length > 1000
    ) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'campaign_id, expected_version, and reason are required.');
    }
    if (cancellation && body.action !== 'cancel') {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'action is reserved for collaboration cancellation.');
    }
    if (
      body.campaign_relation !== undefined &&
      !COLLABORATION_RELATIONS.includes(body.campaign_relation)
    ) {
      throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
    }
    if (
      Object.hasOwn(body, 'cost_actual') &&
      !isCanonicalCost(body.cost_actual)
    ) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'cost_actual is invalid.');
    }
    if (
      body.campaign_relation === 'settlement' &&
      (
        body.status !== 'completed' ||
        !Object.hasOwn(body, 'cost_actual') ||
        body.confirm_cost_actual !== true
      )
    ) {
      throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
    }
    if (
      body.confirm_cost_actual === true &&
      (
        body.status !== 'completed' ||
        !Object.hasOwn(body, 'cost_actual')
      )
    ) {
      throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Cost reconfirmation is invalid.');
    }
    const campaignId = body.campaign_id;
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const initialAccess = cancellation
      ? requireCampaignAccess(db, userId, campaignId)
      : requireCampaignWrite(db, userId, campaignId);
    get({ userId, collaborationId });
    const initialCustody = collaborationCustody(db, collaborationId);
    if (
      initialCustody.classification === 'campaign_classified' &&
      initialCustody.campaignId !== campaignId
    ) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    const hash = requestHash({ method: 'PUT', path: `/api/collaborations/${collaborationId}`, campaignId, kind: 'json', payload: body });
    const reservationInput = {
      organizationId: initialAccess.campaign.org_id,
      actorUserId: userId, campaignId, secondaryCampaignId: null, resourceClaim: null,
      scope: 'collaboration.update.linked', key, requestHash: hash,
      expectedEventCount: cancellation || body.campaign_relation ? 1 : 0,
      operationTimeoutSeconds: 60
    };
    return db.transaction(() => {
      const access = requireCampaignAccess(db, userId, campaignId);
      get({ userId, collaborationId });
      const preReservationCustody = collaborationCustody(db, collaborationId);
      if (
        preReservationCustody.classification === 'campaign_classified' &&
        preReservationCustody.campaignId !== campaignId
      ) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
      }
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const current = db.prepare('SELECT * FROM collaborations WHERE id=?').get(collaborationId);
      if (current.row_version !== body.expected_version) throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      if (Object.hasOwn(body, 'cost_quoted') && isCanonicalCollaborationResource(current.proposal_notes)) {
        throw serviceError(409, 'RESOURCE_QUOTE_LOCKED', 'A confirmed resource order locks its quoted price.');
      }
      const v2Resource = v2CollaborationResource(current.proposal_notes);
      if (
        v2Resource &&
        (
          body.campaign_relation === 'settlement' ||
          Object.hasOwn(body, 'cost_actual')
        )
      ) {
        throw serviceError(
          409,
          'SETTLEMENT_CHECKPOINT_REQUIRED',
          'Version 2 actual costs and settlements must use the payment checkpoint.'
        );
      }
      if (v2Resource && Object.hasOwn(body, 'content_url')) {
        throw serviceError(409, 'CONTENT_REVIEW_ENDPOINT_REQUIRED', 'Content URLs must be submitted through the content review checkpoint.');
      }
      if (v2Resource && body.campaign_relation === 'publication') {
        throw serviceError(
          409,
          'PUBLICATION_CONFIRMATION_ENDPOINT_REQUIRED',
          'Version 2 publications must use the publication confirmation checkpoint.'
        );
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }

      if (cancellation) {
        if (
          preReservationCustody.classification !== 'campaign_classified' ||
          preReservationCustody.state !== 'active' ||
          preReservationCustody.campaignId !== campaignId ||
          !CANCELLABLE_STATUSES.includes(current.status)
        ) {
          throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration cancellation is invalid.');
        }
        if (access.campaign.operational_status !== 'on_hold') {
          throw serviceError(
            409,
            'INVALID_COLLABORATION_TRANSITION',
            'Collaboration cancellation requires a held campaign.'
          );
        }
        if (isOrderedOrLater(access.campaign.lifecycle_state)) {
          cancelCampaignCascade(db, {
            orgId: access.campaign.org_id,
            campaignId,
            campaignVersion: access.campaign.row_version,
            collaborationId,
            expectedVersion: body.expected_version,
            userId,
            reason: body.reason,
            requestId: input.requestId,
            auditFingerprint: reservation.auditFingerprint
          });
        } else {
          const bundle = revokeCollaborationBundle(db, {
            campaignId,
            collaborationId,
            userId,
            reason: body.reason
          });
          updateCollaborationCancelled(db, {
            collaborationId,
            expectedVersion: body.expected_version
          });
          insertLinkRevokedEvent(db, {
            orgId: access.campaign.org_id,
            campaignId,
            collaborationId,
            userId,
            reason: body.reason,
            bundle,
            requestId: input.requestId,
            auditFingerprint: reservation.auditFingerprint
          });
        }
        collaborationArchive(db, {
          orgId: access.campaign.org_id,
          campaignId,
          userId,
          collaborationId,
          campaignRelation: null
        });
        const response = {
          success: true,
          campaign_id: campaignId,
          row_version: body.expected_version + 1,
          active_relations: []
        };
        return completeJson(db, reservation, hash, 200, response);
      }

      if (!access.permissions.write) {
        throw serviceError(
          409,
          access.campaign.operational_status === 'cancelled'
            ? 'CAMPAIGN_CANCELLED'
            : 'CAMPAIGN_ON_HOLD',
          'Campaign is not writable.',
          { operational_status: access.campaign.operational_status }
        );
      }
      const adopting = preReservationCustody.classification === 'unclassified';
      if (adopting) {
        if (
          body.campaign_relation !== 'order' ||
          !['confirmed', 'contract_sent', 'live', 'content_review', 'completed'].includes(current.status)
        ) {
          throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration adoption is invalid.');
        }
      } else if (
        preReservationCustody.state !== 'active' ||
        preReservationCustody.campaignId !== campaignId
      ) {
        throw serviceError(
          409,
          'RECORD_REQUIRES_LINK_CORRECTION',
          'Collaboration evidence requires link correction.'
        );
      }
      const nextStatus = body.status === undefined ? current.status : body.status;
      const allowed = {
        confirmed: ['confirmed', 'contract_sent', 'contracted', 'live'],
        contract_sent: ['contract_sent', 'contracted', 'live'],
        contracted: ['contracted', 'live'],
        live: ['live', 'content_review', 'completed'],
        content_review: ['content_review', 'completed'],
        completed: ['completed']
      };
      if (!allowed[current.status] || !allowed[current.status].includes(nextStatus)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration transition is invalid.');
      }
      if (
        v2Resource &&
        nextStatus === 'content_review' &&
        current.status !== 'content_review'
      ) {
        throw serviceError(409, 'CONTENT_REVIEW_ENDPOINT_REQUIRED', 'Content must be submitted through the content review checkpoint.');
      }
      if (
        v2Resource &&
        nextStatus === 'completed' &&
        current.status !== 'completed' &&
        body.campaign_relation !== 'publication'
      ) {
        throw serviceError(409, 'CONTENT_REVIEW_REQUIRED', 'Approved content review evidence is required before publication.');
      }
      if (
        nextStatus === 'contracted' &&
        current.status !== 'contracted'
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Signed contracts must be confirmed through the contract checkpoint.');
      }
      if (
        nextStatus === 'live' &&
        ['confirmed', 'contract_sent'].includes(current.status) &&
        isReservedV2ProposalNotes(current.proposal_notes)
      ) {
        throw serviceError(409, 'CONTRACT_CONFIRMATION_REQUIRED', 'Signed contract confirmation is required before execution.');
      }
      const costChanged = Object.hasOwn(body, 'cost_actual') && body.cost_actual !== current.cost_actual;
      const relations = activeRelations(db, campaignId, collaborationId);
      const relation = body.campaign_relation;
      if (relation === 'publication' && v2Resource) {
        const review = contentReviewHistory(db, campaignId, collaborationId, current.content_url);
        if (!review.publication_ready) {
          throw serviceError(409, 'CONTENT_REVIEW_REQUIRED', 'Approved content review evidence is required before publication.');
        }
      }
      if (relation && relations.includes(relation)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      if (relation === 'order' && !adopting) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      if (
        relation === 'execution' &&
        (!relations.includes('order') || !['live', 'content_review', 'completed'].includes(nextStatus))
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      if (
        relation === 'publication' &&
        (
          nextStatus !== 'completed' ||
          !relations.includes('order') ||
          !relations.includes('execution')
        )
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      if (
        relation === 'settlement' &&
        (
          body.status !== 'completed' ||
          !relations.includes('publication') ||
          !Object.hasOwn(body, 'cost_actual') ||
          !isCanonicalCost(body.cost_actual) ||
          body.confirm_cost_actual !== true
        )
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      const activeSettlement = relations.includes('settlement');
      const reconfirmingCost = (
        costChanged &&
        activeSettlement &&
        body.confirm_cost_actual === true
      );
      if (
        body.confirm_cost_actual === true &&
        relation !== 'settlement' &&
        !reconfirmingCost
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Cost reconfirmation is invalid.');
      }
      if (
        reconfirmingCost &&
        (
          body.status !== 'completed' ||
          !relations.includes('publication') ||
          !Object.hasOwn(body, 'cost_actual') ||
          !isCanonicalCost(body.cost_actual)
        )
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Cost reconfirmation is invalid.');
      }
      if (
        costChanged &&
        activeSettlement &&
        body.confirm_cost_actual !== true &&
        ['settled', 'reviewed'].includes(access.campaign.lifecycle_state)
      ) {
        return completeJson(
          db,
          reservation,
          hash,
          409,
          errorResponse(
            'COLLABORATION_COST_CONFIRMATION_REQUIRED',
            'Cost confirmation is required.'
          )
        );
      }
      const confirmed = relation === 'settlement' || reconfirmingCost
        ? 1
        : costChanged
          ? 0
          : current.cost_actual_confirmed;
      const update = db.prepare(`
        UPDATE collaborations SET status=?,cost_quoted=COALESCE(?,cost_quoted),cost_actual=COALESCE(?,cost_actual),
          content_url=COALESCE(?,content_url),notes=COALESCE(?,notes),timeline_start=COALESCE(?,timeline_start),
          timeline_end=COALESCE(?,timeline_end),cost_actual_confirmed=?,row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(nextStatus, body.cost_quoted, body.cost_actual, body.content_url, body.notes, body.timeline_start, body.timeline_end, confirmed, collaborationId, body.expected_version);
      if (update.changes !== 1) throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      if (relation) {
        const activeBundle = adopting
          ? null
          : activeCollaborationBundle(db, campaignId, collaborationId);
        if (!adopting && !activeBundle) {
          throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Campaign collaboration evidence is inconsistent.');
        }
        const link = insertLink(db, {
          orgId: access.campaign.org_id,
          campaignId,
          userId,
          recordType: 'collaboration',
          recordId: collaborationId,
          relationType: relation,
          bundleId: activeBundle && activeBundle.bundleId,
          metadata: relation === 'publication'
            ? {
              confirmed_by: userId,
              confirmed_at: db.prepare('SELECT CURRENT_TIMESTAMP AS now').get().now
            }
            : {}
        });
        insertLinkAttachedEvent(db, {
          orgId: access.campaign.org_id,
          campaignId,
          userId,
          collaborationId,
          relationType: relation,
          link,
          requestId: input.requestId,
          auditFingerprint: reservation.auditFingerprint,
          reason: body.reason
        });
      }
      collaborationArchive(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        collaborationId,
        campaignRelation: relation || null
      });
      const response = { success: true, campaign_id: campaignId, row_version: body.expected_version + 1, active_relations: activeRelations(db, campaignId, collaborationId) };
      return completeJson(db, reservation, hash, 200, response);
    }).immediate();
  }

  function stats(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    if (!requireActiveActor(db, userId)) {
      return {
        stats: {
          byStatus: [],
          totalActive: 0,
          totalCompleted: 0,
          totalCost: 0,
          totalCostCurrency: null,
          costByCurrency: []
        }
      };
    }
    const scope = authorizedCollaborationScope(userId);
    const byStatus = db.prepare(`
      WITH ${scope.sql}
      SELECT collaboration.status,COUNT(*) AS count
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
      GROUP BY collaboration.status
    `).all(...scope.params);
    const totalActive = db.prepare(`
      WITH ${scope.sql}
      SELECT COUNT(*) AS count
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
      WHERE collaboration.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
    `).get(...scope.params, ...ACTIVE_STATUSES).count;
    const totalCompleted = db.prepare(`
      WITH ${scope.sql}
      SELECT COUNT(*) AS count
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
      WHERE collaboration.status='completed'
    `).get(...scope.params).count;
    const costRows = db.prepare(`
      WITH ${scope.sql}
      SELECT collaboration.proposal_notes,collaboration.cost_actual,collaboration.cost_quoted
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
    `).all(...scope.params);
    const totals = new Map();
    costRows.forEach((row) => {
      let currency = 'USD';
      try {
        const resource = JSON.parse(row.proposal_notes || 'null');
        if (
          resource &&
          resource.schema === 'turingmarket.collaboration-order.v2' &&
          /^[A-Z]{3}$/.test(resource.currency || '')
        ) {
          currency = resource.currency;
        }
      } catch (error) {}
      const rawCost = row.cost_actual !== null && row.cost_actual !== undefined
        ? row.cost_actual
        : row.cost_quoted;
      const cost = typeof rawCost === 'number' && Number.isFinite(rawCost) ? rawCost : 0;
      totals.set(currency, (totals.get(currency) || 0) + cost);
    });
    const costByCurrency = Array.from(totals, ([currency, totalCost]) => ({ currency, totalCost }))
      .sort((left, right) => left.currency.localeCompare(right.currency));
    const singleCurrency = costByCurrency.length === 1 ? costByCurrency[0] : null;
    const totalCost = singleCurrency ? singleCurrency.totalCost : (costByCurrency.length ? null : 0);
    const totalCostCurrency = singleCurrency ? singleCurrency.currency : null;
    return {
      stats: { byStatus, totalActive, totalCompleted, totalCost, totalCostCurrency, costByCurrency }
    };
  }

  return Object.freeze({
    changePublicationTracking,
    closeoutSnapshot,
    confirmContract,
    confirmPublication,
    correctPublication,
    createLinked,
    decideContentReview,
    decideSettlement,
    downloadContractDocument,
    get,
    list,
    listContentReviews,
    listContractDocuments,
    listPayments,
    listPublicationHistory,
    recordPayment,
    stats,
    submitContentReview,
    submitSettlement,
    updateLegacy,
    updateLinked,
    uploadContractDocument,
    voidPayment
  });
}

module.exports = {
  CampaignCollaborationServiceError,
  createCampaignCollaborationService
};
