'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');

const idempotencyService = require('./idempotency_service');
const knowledgeService = require('./knowledge_service');
const {
  canonicalJsonBytes,
  requestHash,
  sha256Hex
} = require('./sqlite_digest_service');
const {
  getCampaignAccess,
  getTargetAccess,
  resolveRecordCustody
} = require('./campaign_access_service');

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const LOWER_HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const MULTIPART_KNOWLEDGE_ROUTE = 'parser.knowledge-upload';
const MULTIPART_KNOWLEDGE_ADMISSION_SCOPE = 'parser.knowledge-upload.admission';
const MULTIPART_KNOWLEDGE_SCOPE = 'knowledge.upload.linked';
const MAX_LINKED_JSON_DEPTH = 64;
const MAX_LINKED_JSON_NODES = 10_000;
const MAX_LINKED_JSON_ARRAY_ITEMS = 10_000;
const MAX_LINKED_JSON_OBJECT_KEYS = 1_000;
const MAX_LINKED_KNOWLEDGE_INPUT_BYTES = 393_216;
const MAX_RETAINED_RESPONSE_BYTES = 900_000;
const RESERVED_KNOWLEDGE_SOURCE_TYPES = new Set([
  'campaign_demand',
  'campaign_proposal',
  'campaign_review',
  'campaign_workflow_reconciliation',
  'campaign_workflow_log'
]);
const RESERVED_KNOWLEDGE_ENTRY_TYPES = new Set([
  'campaign_demand',
  'campaign_proposal',
  'campaign_review',
  'campaign_workflow'
]);
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
const PROPOSAL_CONFIRMATION_FIELDS = Object.freeze([
  'demand',
  'proposal',
  'draft'
]);
const PROPOSAL_CONFIRMATION_DEMAND_FIELDS = Object.freeze([
  'brand_name',
  'company_name',
  'product_name',
  'industry',
  'budget',
  'target_market',
  'platform',
  'data_json'
]);
const PROPOSAL_CONFIRMATION_PROPOSAL_FIELDS = Object.freeze([
  'template_id',
  'content'
]);
const PROPOSAL_CONFIRMATION_DRAFT_FIELDS = Object.freeze([
  'demand_entry_id',
  'ai_conversation_id',
  'ai_message_id',
  'source'
]);
const KNOWLEDGE_FIELDS = Object.freeze([
  'campaign_id',
  'entry_type',
  'title',
  'summary',
  'content',
  'tags',
  'source_type',
  'source_id',
  'visibility',
  'metadata'
]);
const MULTIPART_FINALIZER_FIELDS = Object.freeze([
  'campaignId',
  'idempotencyKey',
  'canonicalRequestHash',
  'requestId',
  'admission',
  'authority'
]);
const MULTIPART_ADMISSION_FIELDS = Object.freeze([
  'state',
  'ledgerId',
  'reservationNonce',
  'auditFingerprint',
  'leaseToken',
  'leaseUntil',
  'operationDeadline',
  'requestHash',
  'key',
  'route',
  'organizationId',
  'userId'
]);
const MULTIPART_AUTHORITY_FIELDS = Object.freeze([
  'userId',
  'organizationId',
  'assertFresh'
]);
const MULTIPART_FINALIZE_FIELDS = Object.freeze([
  'body',
  'rows',
  'lifecycle'
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

function positiveSafeIdOrPathSegment(value, label) {
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && String(parsed) === value) return parsed;
  }
  return positiveSafeId(value, label);
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

function snapshotJsonValue(value, label, state) {
  const traversal = state || { depth: 0, nodes: 0, seen: new Set() };
  traversal.nodes += 1;
  if (traversal.nodes > MAX_LINKED_JSON_NODES) {
    throw invalidInput(`${label} contains too many JSON values.`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return validScalarText(value, label, { required: true });
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidInput(`${label} is invalid.`);
    return value;
  }
  if (
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    traversal.seen.has(value)
  ) {
    throw invalidInput(`${label} must contain plain JSON values.`);
  }
  if (traversal.depth >= MAX_LINKED_JSON_DEPTH) {
    throw invalidInput(`${label} exceeds the JSON nesting limit.`);
  }

  traversal.seen.add(value);
  traversal.depth += 1;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw invalidInput(`${label} must contain plain JSON arrays.`);
      }
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor && lengthDescriptor.value;
      const itemKeys = keys.filter((key) => key !== 'length');
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_LINKED_JSON_ARRAY_ITEMS ||
        itemKeys.length !== length
      ) {
        throw invalidInput(`${label} must contain dense JSON arrays.`);
      }
      const output = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = descriptors[key];
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          throw invalidInput(`${label} must contain dense JSON arrays.`);
        }
        output[index] = snapshotJsonValue(
          descriptor.value,
          `${label}[${index}]`,
          traversal
        );
      }
      if (itemKeys.some((key, index) => key !== String(index))) {
        throw invalidInput(`${label} must contain plain JSON arrays.`);
      }
      return Object.freeze(output);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidInput(`${label} must contain plain JSON objects.`);
    }
    const output = Object.create(null);
    if (keys.length > MAX_LINKED_JSON_OBJECT_KEYS) {
      throw invalidInput(`${label} contains too many JSON object keys.`);
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        typeof key !== 'string' ||
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw invalidInput(`${label} must contain plain JSON objects.`);
      }
      const canonicalKey = validScalarText(key, `${label} key`, { required: true });
      if (Object.hasOwn(output, canonicalKey)) {
        throw invalidInput(`${label} contains duplicate canonical keys.`);
      }
      output[canonicalKey] = snapshotJsonValue(
        descriptor.value,
        `${label}.${canonicalKey}`,
        traversal
      );
    }
    return Object.freeze(output);
  } finally {
    traversal.depth -= 1;
    traversal.seen.delete(value);
  }
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
    data_json: Object.hasOwn(body, 'data_json')
      ? snapshotJsonValue(body.data_json, 'data_json')
      : null
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

function normalizeProposalConfirmationDemand(value, campaignId) {
  const body = snapshotBody(
    value,
    PROPOSAL_CONFIRMATION_DEMAND_FIELDS,
    []
  );
  return Object.freeze({
    campaign_id: campaignId,
    brand_name: validScalarText(body.brand_name, 'demand.brand_name'),
    company_name: validScalarText(body.company_name, 'demand.company_name'),
    product_name: validScalarText(body.product_name, 'demand.product_name'),
    industry: validScalarText(body.industry, 'demand.industry'),
    budget: validScalarText(body.budget, 'demand.budget'),
    target_market: validScalarText(body.target_market, 'demand.target_market'),
    platform: validScalarText(body.platform, 'demand.platform'),
    data_json: Object.hasOwn(body, 'data_json')
      ? snapshotJsonValue(body.data_json, 'demand.data_json')
      : null
  });
}

function normalizeProposalConfirmationProposal(value) {
  const body = snapshotBody(
    value,
    PROPOSAL_CONFIRMATION_PROPOSAL_FIELDS,
    ['template_id', 'content']
  );
  return Object.freeze({
    template_id: requiredNonemptyText(body.template_id, 'proposal.template_id'),
    content: requiredNonemptyText(body.content, 'proposal.content')
  });
}

function normalizeProposalConfirmationDraft(value) {
  if (value === undefined) return null;
  const body = snapshotBody(
    value,
    PROPOSAL_CONFIRMATION_DRAFT_FIELDS,
    []
  );
  return Object.freeze({
    demand_entry_id: Object.hasOwn(body, 'demand_entry_id')
      ? positiveSafeId(body.demand_entry_id, 'draft.demand_entry_id')
      : null,
    ai_conversation_id: Object.hasOwn(body, 'ai_conversation_id')
      ? positiveSafeId(body.ai_conversation_id, 'draft.ai_conversation_id')
      : null,
    ai_message_id: Object.hasOwn(body, 'ai_message_id')
      ? positiveSafeId(body.ai_message_id, 'draft.ai_message_id')
      : null,
    source: Object.hasOwn(body, 'source')
      ? validScalarText(body.source, 'draft.source', { required: true })
      : null
  });
}

function normalizeProposalConfirmationBody(value, campaignId) {
  const body = snapshotBody(
    value,
    PROPOSAL_CONFIRMATION_FIELDS,
    ['demand', 'proposal']
  );
  return Object.freeze({
    campaign_id: campaignId,
    demand: normalizeProposalConfirmationDemand(body.demand, campaignId),
    proposal: normalizeProposalConfirmationProposal(body.proposal),
    draft: normalizeProposalConfirmationDraft(body.draft)
  });
}

function requiredNonemptyText(value, label) {
  const text = validScalarText(value, label, { required: true });
  if (!text.trim()) throw invalidInput(`${label} is required.`);
  return text;
}

function normalizeKnowledgeSourceId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  const text = requiredNonemptyText(value, 'source_id');
  if (Buffer.byteLength(text, 'utf8') > 4096) {
    throw invalidInput('source_id exceeds 4096 UTF-8 bytes.');
  }
  const sqliteNumericLiteral =
    /^[\u0009-\u000d\u0020]*[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?[\u0009-\u000d\u0020]*$/;
  if (sqliteNumericLiteral.test(text)) {
    const numeric = Number(text);
    if (
      !/^[1-9][0-9]{0,15}$/.test(text) ||
      !Number.isSafeInteger(numeric) ||
      numeric < 1 ||
      String(numeric) !== text
    ) {
      throw invalidInput('Numeric source_id must be a positive canonical safe integer.');
    }
  }
  return text;
}

function normalizeKnowledgeBody(value) {
  const body = snapshotBody(value, KNOWLEDGE_FIELDS, [
    'campaign_id',
    'entry_type',
    'title',
    'summary',
    'content',
    'tags',
    'source_type',
    'source_id'
  ]);
  const tagValues = snapshotJsonValue(body.tags, 'tags');
  if (
    !Array.isArray(tagValues) ||
    tagValues.some((tag) => typeof tag !== 'string')
  ) {
    throw invalidInput('tags is invalid.');
  }
  const tags = tagValues.map((tag) => validScalarText(tag, 'tags'));
  const visibility = Object.hasOwn(body, 'visibility')
    ? body.visibility
    : 'private';
  if (visibility !== 'private' && visibility !== 'team') {
    throw invalidInput('visibility must be private or team.');
  }
  const metadata = Object.hasOwn(body, 'metadata')
    ? snapshotJsonValue(body.metadata, 'metadata')
    : Object.freeze(Object.create(null));
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw invalidInput('metadata must be a JSON object.');
  }
  const entryType = requiredNonemptyText(body.entry_type, 'entry_type');
  const sourceType = requiredNonemptyText(body.source_type, 'source_type');
  if (
    RESERVED_KNOWLEDGE_ENTRY_TYPES.has(entryType) ||
    RESERVED_KNOWLEDGE_SOURCE_TYPES.has(sourceType)
  ) {
    throw invalidInput('The requested knowledge source namespace is reserved.');
  }
  const normalized = Object.freeze({
    campaign_id: positiveSafeId(body.campaign_id, 'campaign_id'),
    entry_type: entryType,
    title: requiredNonemptyText(body.title, 'title'),
    summary: validScalarText(body.summary, 'summary', { required: true }),
    content: validScalarText(body.content, 'content', { required: true }),
    tags: Object.freeze(tags),
    source_type: sourceType,
    source_id: normalizeKnowledgeSourceId(body.source_id),
    visibility,
    metadata
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_LINKED_KNOWLEDGE_INPUT_BYTES) {
    throw serviceError(
      413,
      'KNOWLEDGE_ENTRY_TOO_LARGE',
      'Campaign-linked knowledge exceeds the retained response limit.',
      { limit_bytes: MAX_LINKED_KNOWLEDGE_INPUT_BYTES }
    );
  }
  return normalized;
}

function normalizeMultipartKnowledgeAdmission(value) {
  const admission = snapshotBody(
    value,
    MULTIPART_ADMISSION_FIELDS,
    MULTIPART_ADMISSION_FIELDS
  );
  if (
    admission.state !== 'reserved' ||
    admission.route !== MULTIPART_KNOWLEDGE_ROUTE ||
    !Number.isSafeInteger(admission.ledgerId) ||
    admission.ledgerId < 1 ||
    typeof admission.key !== 'string' ||
    !IDEMPOTENCY_KEY_PATTERN.test(admission.key) ||
    typeof admission.requestHash !== 'string' ||
    !LOWER_HEX_64_PATTERN.test(admission.requestHash) ||
    typeof admission.leaseToken !== 'string' ||
    !LOWER_HEX_64_PATTERN.test(admission.leaseToken) ||
    typeof admission.reservationNonce !== 'string' ||
    !LOWER_HEX_64_PATTERN.test(admission.reservationNonce) ||
    typeof admission.auditFingerprint !== 'string' ||
    !LOWER_HEX_64_PATTERN.test(admission.auditFingerprint) ||
    typeof admission.leaseUntil !== 'string' ||
    typeof admission.operationDeadline !== 'string'
  ) {
    throw invalidInput('Parser admission identity is invalid.');
  }
  return Object.freeze({
    ...admission,
    organizationId: positiveSafeId(
      admission.organizationId,
      'admission organization_id'
    ),
    userId: positiveSafeId(admission.userId, 'admission user_id')
  });
}

function normalizeMultipartAuthority(value, admission) {
  const authority = snapshotBody(
    value,
    MULTIPART_AUTHORITY_FIELDS,
    MULTIPART_AUTHORITY_FIELDS
  );
  const userId = positiveSafeId(authority.userId, 'authority user_id');
  const organizationId = positiveSafeId(
    authority.organizationId,
    'authority organization_id'
  );
  if (
    typeof authority.assertFresh !== 'function' ||
    userId !== admission.userId ||
    organizationId !== admission.organizationId
  ) {
    throw invalidInput('Fresh upload authority does not match parser admission.');
  }
  return Object.freeze({
    userId,
    organizationId,
    assertFresh: authority.assertFresh
  });
}

function canonicalMultipartRequestHash(value) {
  if (typeof value !== 'string' || !LOWER_HEX_64_PATTERN.test(value)) {
    throw invalidInput('canonicalRequestHash is invalid.');
  }
  return value;
}

function requireFreshMultipartAuthority(db, values) {
  const current = values.authority.assertFresh(Object.freeze({
    db,
    phase: values.phase,
    userId: values.authority.userId,
    organizationId: values.authority.organizationId,
    campaignId: values.campaignId
  }));
  if (current && typeof current.then === 'function') {
    throw new TypeError(
      'Fresh upload authority callback must complete synchronously inside SQLite transactions'
    );
  }
  let identity;
  try {
    identity = snapshotBody(
      current,
      ['userId', 'organizationId', 'campaignId'],
      ['userId', 'organizationId', 'campaignId']
    );
  } catch (_error) {
    throw serviceError(
      401,
      'AUTHORITY_REVOKED',
      'Current upload authority could not be verified.'
    );
  }
  if (
    identity.userId !== values.authority.userId ||
    identity.organizationId !== values.authority.organizationId ||
    identity.campaignId !== values.campaignId
  ) {
    throw serviceError(
      401,
      'AUTHORITY_REVOKED',
      'Current upload authority no longer matches the admitted request.'
    );
  }
  const access = requireCampaignAccess(
    db,
    values.authority.userId,
    values.campaignId
  );
  if (access.campaign.org_id !== values.authority.organizationId) {
    throw serviceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  assertCampaignWritable(access);
  return access;
}

function requireLiveMultipartKnowledgeAdmission(db, admission) {
  const row = db.prepare(`
    SELECT
      org_id,user_id,campaign_id,scope,idempotency_key,request_hash,state,
      lease_token,
      CASE WHEN datetime(lease_until)>CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS lease_active,
      CASE WHEN datetime(operation_deadline)>CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS deadline_active
    FROM request_idempotency
    WHERE id=?
    LIMIT 1
  `).get(admission.ledgerId);
  if (!row) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Parser admission is no longer owned by this upload.'
    );
  }
  if (
    row.org_id !== admission.organizationId ||
    row.user_id !== admission.userId ||
    row.campaign_id !== null ||
    row.scope !== MULTIPART_KNOWLEDGE_ADMISSION_SCOPE ||
    row.idempotency_key !== admission.key ||
    row.request_hash !== admission.requestHash
  ) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Parser admission identity did not match the linked upload.'
    );
  }
  if (
    row.state !== 'processing' ||
    row.lease_token !== admission.leaseToken ||
    row.lease_active !== 1 ||
    row.deadline_active !== 1
  ) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Parser admission is no longer owned by this upload.'
    );
  }
  return row;
}

function assertMultipartUploadReplay(disposition) {
  if (disposition.status < 200 || disposition.status > 299) return disposition;
  let body;
  try {
    body = snapshotBody(
      disposition.body,
      ['entry', 'rows'],
      ['entry', 'rows']
    );
  } catch (_error) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Retained multipart knowledge response was invalid.'
    );
  }
  if (
    disposition.status !== 200 ||
    body.entry === null ||
    typeof body.entry !== 'object' ||
    Array.isArray(body.entry) ||
    !Number.isSafeInteger(body.entry.id) ||
    body.entry.id < 1 ||
    !Number.isSafeInteger(body.rows) ||
    body.rows < 0
  ) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Retained multipart knowledge response was invalid.'
    );
  }
  return disposition;
}

function validateLegacyKnowledgeBody(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const entryTypes = [];
  for (const field of ['entry_type', 'type']) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== 'string') throw invalidInput(`${field} is invalid.`);
    entryTypes.push(validScalarText(value[field], field, { required: true }));
  }
  let sourceType = null;
  if (Object.hasOwn(value, 'source_type')) {
    if (typeof value.source_type !== 'string') {
      throw invalidInput('source_type is invalid.');
    }
    sourceType = validScalarText(value.source_type, 'source_type', { required: true });
  }
  if (
    entryTypes.some((entryType) => RESERVED_KNOWLEDGE_ENTRY_TYPES.has(entryType)) ||
    RESERVED_KNOWLEDGE_SOURCE_TYPES.has(sourceType)
  ) {
    throw invalidInput('The requested knowledge source namespace is reserved.');
  }
  if (
    Object.hasOwn(value, 'tags') &&
    (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string'))
  ) {
    throw invalidInput('tags is invalid.');
  }
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

function requireKnowledgeTargetAccess(
  db,
  userId,
  campaignId,
  entryId,
  intent = 'manage_authority'
) {
  const access = getTargetAccess(db, {
    userId,
    campaignId,
    recordType: 'knowledge_entry',
    recordId: entryId,
    relationType: 'knowledge',
    intent
  });
  if (!access.ok) {
    const messages = {
      CAMPAIGN_NOT_FOUND: 'Campaign was not found.',
      CAMPAIGN_FORBIDDEN: 'Campaign access is forbidden.',
      KNOWLEDGE_ENTRY_NOT_FOUND: 'Knowledge entry was not found.',
      RECORD_FORBIDDEN: 'Knowledge entry access is forbidden.'
    };
    throw serviceError(
      access.status,
      access.code,
      messages[access.code] || 'Knowledge entry access failed.'
    );
  }
  return access;
}

function retainedKnowledgeTargetId(db, options) {
  const retained = db.prepare(`
    SELECT state,status_code,response_kind,response_json
    FROM request_idempotency
    WHERE org_id=? AND user_id=? AND campaign_id=?
      AND scope=? AND idempotency_key=?
    LIMIT 1
  `).get(
    options.organizationId,
    options.userId,
    options.campaignId,
    options.scope,
    options.key
  );
  if (!retained) return null;
  if (retained.status_code >= 400) return null;
  if (retained.status_code >= 200 && retained.status_code <= 299) {
    if (retained.response_kind !== 'json' || typeof retained.response_json !== 'string') {
      throw new Error('Retained knowledge response evidence was invalid.');
    }
    let responseBody;
    try {
      responseBody = JSON.parse(retained.response_json);
    } catch (_error) {
      throw new Error('Retained knowledge response evidence was invalid.');
    }
    const responseId = options.scope === MULTIPART_KNOWLEDGE_SCOPE
      ? responseBody && responseBody.entry && responseBody.entry.id
      : responseBody && responseBody.id;
    if (!Number.isSafeInteger(responseId) || responseId < 1) {
      throw new Error('Retained knowledge response evidence was invalid.');
    }
    return responseId;
  }
  if (!['processing', 'failed'].includes(retained.state)) return null;
  const sourceType = options.body && options.body.source_type;
  const sourceId = options.body && options.body.source_id;
  if (typeof sourceType !== 'string' || sourceId === null || sourceId === undefined) {
    return null;
  }
  const candidate = db.prepare(`
    SELECT entry.id
    FROM knowledge_entries entry
    JOIN campaign_record_links link
      ON link.record_type='knowledge_entry'
     AND link.relation_type='knowledge'
     AND link.record_id=CAST(entry.id AS TEXT)
    WHERE link.campaign_id=?
      AND entry.source_type=?
      AND CAST(entry.source_id AS TEXT)=?
    ORDER BY CASE WHEN link.revoked_at IS NULL THEN 0 ELSE 1 END,link.id DESC
    LIMIT 1
  `).get(options.campaignId, sourceType, String(sourceId));
  return candidate ? candidate.id : null;
}

function requireRetainedKnowledgeAccess(db, options) {
  const entryId = retainedKnowledgeTargetId(db, options);
  if (entryId === null) return null;
  const custody = resolveRecordCustody(db, {
    recordType: 'knowledge_entry',
    recordId: entryId
  });
  if (custody.classification !== 'campaign_classified') {
    throw serviceError(
      404,
      'KNOWLEDGE_ENTRY_NOT_FOUND',
      'Knowledge entry was not found.'
    );
  }
  return requireKnowledgeTargetAccess(
    db,
    options.userId,
    custody.campaignId,
    entryId,
    'read'
  );
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
    error instanceof knowledgeService.CampaignKnowledgeConflictError ||
    error instanceof knowledgeService.CampaignKnowledgeInputError
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

function assertRetainedResponseFits(responseBody) {
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(responseBody), 'utf8');
  } catch (_error) {
    throw new Error('Linked response could not be serialized');
  }
  if (bytes > MAX_RETAINED_RESPONSE_BYTES) {
    throw serviceError(
      413,
      'RESPONSE_RETENTION_LIMIT_EXCEEDED',
      'Linked response exceeds the idempotency retention limit.',
      { limit_bytes: MAX_RETAINED_RESPONSE_BYTES }
    );
  }
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
    kind: input.payloadKind || 'json',
    payload: input.payloadKind === 'empty' ? null : input.body
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
    expectedEventCount: input.expectedEventCount === undefined
      ? 1
      : input.expectedEventCount,
    operationTimeoutSeconds: 60
  };

  return db.transaction(() => {
    const access = requireCampaignAccess(db, userId, campaignId);
    if (input.authorize) input.authorize(access);
    if (input.authorizeRetained) {
      input.authorizeRetained({
        access,
        campaignId,
        key,
        organizationId: access.campaign.org_id,
        requestHash: hash,
        scope: input.scope,
        userId
      });
    }
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
      assertRetainedResponseFits(outcome.body);
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
  const metadata = values.metadata || {
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

function canonicalProjectionValue(value, label) {
  let snapshot;
  let bytes;
  try {
    snapshot = snapshotJsonValue(value, label);
    bytes = canonicalJsonBytes(snapshot);
    return JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    throw invalidInput(`${label} is invalid.`);
  }
}

function parseCommittedJson(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalidInput(`${label} is invalid.`);
  try {
    return canonicalProjectionValue(JSON.parse(value), label);
  } catch (_error) {
    throw invalidInput(`${label} is invalid.`);
  }
}

function proposalContentSha256(content) {
  const proposalContent = parseCommittedJson(content, 'proposal content');
  if (
    proposalContent === null ||
    typeof proposalContent !== 'object' ||
    Array.isArray(proposalContent)
  ) {
    throw invalidInput('proposal content is invalid.');
  }
  return sha256Hex(canonicalJsonBytes(proposalContent));
}

function proposalTextContentSha256(content) {
  if (typeof content !== 'string') throw invalidInput('proposal content is invalid.');
  return sha256Hex(Buffer.from(content, 'utf8'));
}

function proposalArchiveProjection(content, { allowTextContent = false } = {}) {
  try {
    const proposalContent = parseCommittedJson(content, 'committed proposal content');
    if (
      proposalContent !== null &&
      typeof proposalContent === 'object' &&
      !Array.isArray(proposalContent)
    ) {
      return {
        kind: 'json',
        title: requiredNonemptyText(
          proposalContent.title,
          'committed proposal title'
        ),
        content: proposalContent,
        contentSha256: sha256Hex(canonicalJsonBytes(proposalContent))
      };
    }
  } catch (_error) {
    if (!allowTextContent) throw invalidInput('committed proposal content is invalid.');
  }
  if (!allowTextContent) throw invalidInput('committed proposal content is invalid.');
  return {
    kind: 'text',
    title: 'Human-confirmed proposal',
    content,
    contentSha256: proposalTextContentSha256(content)
  };
}

function archiveSummary(content) {
  return Array.from(content.replace(/\s+/gu, ' ').trim()).slice(0, 1000).join('');
}

function readCommittedDemand(db, demandId) {
  const row = db.prepare(`
    SELECT id,brand_name,company_name,product_name,industry,budget,
      target_market,platform,status,data_json
    FROM demands WHERE id=?
  `).get(demandId);
  if (!row) throw new Error('Committed demand was not found.');
  return row;
}

function readCommittedProposal(db, proposalId) {
  const row = db.prepare(`
    SELECT id,demand_id,content FROM proposals WHERE id=?
  `).get(proposalId);
  if (!row) throw new Error('Committed proposal was not found.');
  return row;
}

function applyProducerGaugePlan(db, archive) {
  return knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(
    db,
    archive.capacityGaugePlan
  );
}

function persistLinkedKnowledge(db, values) {
  let archive;
  try {
    archive = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
      organizationId: values.access.campaign.org_id,
      campaignId: values.campaignId,
      createdBy: values.userId,
      entryType: values.body.entry_type,
      title: values.body.title,
      summary: values.body.summary,
      content: values.body.content,
      tags: values.body.tags,
      sourceType: values.body.source_type,
      sourceId: values.body.source_id,
      visibility: values.body.visibility,
      metadata: values.body.metadata
    });
  } catch (error) {
    if (error instanceof knowledgeService.CampaignKnowledgeInputError) {
      throw invalidInput(error.message);
    }
    throw error;
  }
  if (archive.status !== 'created') {
    throw serviceError(
      409,
      'RECORD_ALREADY_LINKED',
      'Knowledge entry is already linked.'
    );
  }
  const knowledgeLink = insertRecordLink(db, {
    organizationId: values.access.campaign.org_id,
    campaignId: values.campaignId,
    userId: values.userId,
    recordType: 'knowledge_entry',
    recordId: archive.entry.id,
    relationType: 'knowledge',
    metadata: {
      producer_type: 'knowledge',
      source_type: values.body.source_type,
      source_id: String(values.body.source_id)
    }
  });
  insertLinkEvent(db, {
    organizationId: values.access.campaign.org_id,
    campaignId: values.campaignId,
    userId: values.userId,
    requestId: values.requestId,
    auditFingerprint: values.auditFingerprint,
    source: 'knowledge_link',
    reason: 'Linked knowledge',
    recordType: 'knowledge_entry',
    recordId: archive.entry.id,
    relationType: 'knowledge',
    producerLink: knowledgeLink
  });
  applyProducerGaugePlan(db, archive);
  return { archive, knowledgeLink };
}

function archiveDemand(db, values) {
  const demand = readCommittedDemand(db, values.demandId);
  const content = JSON.stringify({
    id: positiveSafeId(demand.id, 'committed demand id'),
    brand_name: canonicalProjectionValue(demand.brand_name, 'committed demand brand_name'),
    company_name: canonicalProjectionValue(demand.company_name, 'committed demand company_name'),
    product_name: canonicalProjectionValue(demand.product_name, 'committed demand product_name'),
    industry: canonicalProjectionValue(demand.industry, 'committed demand industry'),
    budget: canonicalProjectionValue(demand.budget, 'committed demand budget'),
    target_market: canonicalProjectionValue(demand.target_market, 'committed demand target_market'),
    platform: canonicalProjectionValue(demand.platform, 'committed demand platform'),
    status: canonicalProjectionValue(demand.status, 'committed demand status'),
    data: parseCommittedJson(demand.data_json, 'committed demand data_json')
  });
  const written = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: values.organizationId,
    campaignId: values.campaignId,
    createdBy: values.userId,
    sourceType: 'campaign_demand',
    sourceId: demand.id,
    entryType: 'campaign_demand',
    title: `Campaign demand #${demand.id}`,
    summary: archiveSummary(content),
    content,
    tags: ['campaign', 'demand'],
    visibility: 'team'
  });
  if (written.status !== 'created') {
    throw new knowledgeService.CampaignKnowledgeConflictError(
      'Demand archive source identity is already in use'
    );
  }
  return written;
}

function archiveProposal(db, values) {
  const proposal = readCommittedProposal(db, values.proposalId);
  const projection = proposalArchiveProjection(proposal.content, {
    allowTextContent: values.allowTextContent === true
  });
  const content = projection.kind === 'json'
    ? JSON.stringify({
        id: positiveSafeId(proposal.id, 'committed proposal id'),
        demand_id: positiveSafeId(proposal.demand_id, 'committed proposal demand_id'),
        title: projection.title,
        content_sha256: projection.contentSha256,
        content: projection.content
      })
    : JSON.stringify({
        id: positiveSafeId(proposal.id, 'committed proposal id'),
        demand_id: positiveSafeId(proposal.demand_id, 'committed proposal demand_id'),
        title: projection.title,
        content_sha256: projection.contentSha256,
        content_kind: projection.kind,
        content: projection.content
      });
  const written = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: values.organizationId,
    campaignId: values.campaignId,
    createdBy: values.userId,
    sourceType: 'campaign_proposal',
    sourceId: proposal.id,
    entryType: 'campaign_proposal',
    title: `Campaign proposal #${proposal.id}`,
    summary: archiveSummary(content),
    content,
    tags: ['campaign', 'proposal'],
    visibility: 'team'
  });
  if (written.status !== 'created') {
    throw new knowledgeService.CampaignKnowledgeConflictError(
      'Proposal archive source identity is already in use'
    );
  }
  Object.defineProperty(written, 'contentSha256', {
    configurable: false,
    enumerable: true,
    value: projection.contentSha256,
    writable: false
  });
  return written;
}

function proposalConfirmationAuditMetadata(draft) {
  const metadata = {};
  if (!draft) return metadata;
  if (draft.demand_entry_id !== null) metadata.demand_entry_id = draft.demand_entry_id;
  if (draft.ai_conversation_id !== null) {
    metadata.ai_conversation_id = draft.ai_conversation_id;
  }
  if (draft.ai_message_id !== null) metadata.ai_message_id = draft.ai_message_id;
  if (draft.source !== null) metadata.source = draft.source;
  return metadata;
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
        metadata: {}
      });
      insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: archive.entry.id,
        relationType: 'knowledge',
        metadata: {}
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
      applyProducerGaugePlan(db, archive);
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

  function createProposalConfirmation(input) {
    const campaignId = positiveSafeIdOrPathSegment(input.campaignId, 'campaign_id');
    const body = normalizeProposalConfirmationBody(input.body, campaignId);
    return runLinkedMutation(db, {
      userId: input.userId,
      campaignId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      path: `/api/campaigns/${campaignId}/proposal-confirmations`,
      scope: 'proposal.create.linked',
      body
    }, ({ access, auditFingerprint, campaignId, userId }) => {
      assertCampaignWritable(access);
      const dataJson = body.demand.data_json === null
        ? null
        : JSON.stringify(body.demand.data_json);
      const demandResult = db.prepare(`
        INSERT INTO demands (
          user_id,brand_name,company_name,product_name,industry,budget,
          target_market,platform,data_json
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        userId,
        body.demand.brand_name,
        body.demand.company_name,
        body.demand.product_name,
        body.demand.industry,
        body.demand.budget,
        body.demand.target_market,
        body.demand.platform,
        dataJson
      );
      const demandId = Number(demandResult.lastInsertRowid);
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details,ip_address)
        VALUES (?,?,?,?,?)
      `).run(
        userId,
        'create_demand',
        'demand',
        `Created demand for ${body.demand.brand_name || ''}`,
        input.ipAddress || null
      );
      const demandArchive = archiveDemand(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        demandId,
        body: body.demand
      });
      const demandLink = insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'demand',
        recordId: demandId,
        relationType: 'demand',
        metadata: proposalConfirmationAuditMetadata(body.draft)
      });
      const demandArchiveLink = insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: demandArchive.entry.id,
        relationType: 'knowledge',
        metadata: proposalConfirmationAuditMetadata(body.draft)
      });
      applyProducerGaugePlan(db, demandArchive);

      const proposalResult = db.prepare(`
        INSERT INTO proposals (user_id,demand_id,template_id,content)
        VALUES (?,?,?,?)
      `).run(
        userId,
        demandId,
        body.proposal.template_id,
        body.proposal.content
      );
      const proposalId = Number(proposalResult.lastInsertRowid);
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details,ip_address)
        VALUES (?,?,?,?,?)
      `).run(
        userId,
        'generate_proposal',
        'proposal',
        `Generated proposal with template ${body.proposal.template_id}`,
        input.ipAddress || null
      );
      const proposalArchive = archiveProposal(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        proposalId,
        allowTextContent: true
      });
      const proposalLink = insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'proposal',
        recordId: proposalId,
        relationType: 'proposal',
        metadata: proposalConfirmationAuditMetadata(body.draft)
      });
      const proposalArchiveLink = insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: proposalArchive.entry.id,
        relationType: 'knowledge',
        metadata: proposalConfirmationAuditMetadata(body.draft)
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
        producerLink: proposalLink,
        metadata: {
          record_type: 'proposal',
          record_id: String(proposalId),
          relation_types: ['demand', 'knowledge', 'proposal'],
          link_ids: [
            demandLink.id,
            demandArchiveLink.id,
            proposalLink.id,
            proposalArchiveLink.id
          ].sort((left, right) => left - right),
          bundle_id: proposalLink.bundleId
        }
      });
      applyProducerGaugePlan(db, proposalArchive);
      return {
        status: 201,
        body: {
          campaign_id: campaignId,
          demand: {
            id: demandId,
            link_id: demandLink.id
          },
          proposal: {
            id: proposalId,
            content_sha256: proposalArchive.contentSha256
          }
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
        proposalId
      });
      const producerLink = insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'proposal',
        recordId: proposalId,
        relationType: 'proposal',
        metadata: {}
      });
      insertRecordLink(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: archive.entry.id,
        relationType: 'knowledge',
        metadata: {}
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
      applyProducerGaugePlan(db, archive);
      return {
        status: 201,
        body: {
          id: proposalId,
          campaign_id: campaignId,
          content_sha256: archive.contentSha256
        }
      };
    });
  }

  function writeKnowledge(input, scope, requestPath) {
    const body = normalizeKnowledgeBody(input.body);
    const userId = positiveSafeId(input.userId, 'user_id');
    return runLinkedMutation(db, {
      userId,
      campaignId: body.campaign_id,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      path: requestPath,
      scope,
      body,
      authorizeRetained: (retained) => requireRetainedKnowledgeAccess(db, {
        ...retained,
        body
      })
    }, ({ access, auditFingerprint, campaignId, userId }) => {
      assertCampaignWritable(access);
      const { archive, knowledgeLink } = persistLinkedKnowledge(db, {
        access,
        auditFingerprint,
        body,
        campaignId,
        requestId: input.requestId,
        userId
      });
      return {
        status: 201,
        body: {
          entry: archive.entry,
          id: archive.entry.id,
          campaign_id: campaignId,
          link_id: knowledgeLink.id
        }
      };
    });
  }

  function createMultipartKnowledgeFinalizer(input) {
    const options = snapshotBody(
      input,
      MULTIPART_FINALIZER_FIELDS,
      MULTIPART_FINALIZER_FIELDS
    );
    const campaignId = positiveSafeId(options.campaignId, 'campaign_id');
    const key = requireIdempotencyKey(options.idempotencyKey);
    const canonicalRequestHash = canonicalMultipartRequestHash(
      options.canonicalRequestHash
    );
    const requestId = requiredNonemptyText(options.requestId, 'request_id');
    const admission = normalizeMultipartKnowledgeAdmission(options.admission);
    const authority = normalizeMultipartAuthority(options.authority, admission);

    requireFreshMultipartAuthority(db, {
      admission,
      authority,
      campaignId,
      phase: 'preauthorize'
    });
    requireLiveMultipartKnowledgeAdmission(db, admission);

    let finalized = false;
    const finalizer = function finalizeMultipartKnowledge(finalizeInput) {
      if (finalized) {
        throw new TypeError('Multipart knowledge finalizer is single-use');
      }
      const finalInput = snapshotBody(
        finalizeInput,
        MULTIPART_FINALIZE_FIELDS,
        MULTIPART_FINALIZE_FIELDS
      );
      const body = normalizeKnowledgeBody(finalInput.body);
      if (body.campaign_id !== campaignId) {
        throw invalidInput('Final knowledge campaign does not match multipart admission.');
      }
      if (!Number.isSafeInteger(finalInput.rows) || finalInput.rows < 0) {
        throw invalidInput('Parsed upload row count is invalid.');
      }
      const lifecycle = snapshotBody(
        finalInput.lifecycle,
        ['completeAdmissionInTransaction'],
        ['completeAdmissionInTransaction']
      );
      if (typeof lifecycle.completeAdmissionInTransaction !== 'function') {
        throw new TypeError('Parser admission completion lifecycle is required');
      }
      finalized = true;

      const reservationInput = {
        organizationId: authority.organizationId,
        actorUserId: authority.userId,
        campaignId,
        secondaryCampaignId: null,
        resourceClaim: null,
        scope: MULTIPART_KNOWLEDGE_SCOPE,
        key,
        requestHash: canonicalRequestHash,
        expectedEventCount: 1,
        operationTimeoutSeconds: 60
      };

      return db.transaction(() => {
        const access = requireFreshMultipartAuthority(db, {
          admission,
          authority,
          campaignId,
          phase: 'final_transaction'
        });
        requireLiveMultipartKnowledgeAdmission(db, admission);
        requireRetainedKnowledgeAccess(db, {
          access,
          body,
          campaignId,
          key,
          organizationId: authority.organizationId,
          requestHash: canonicalRequestHash,
          scope: MULTIPART_KNOWLEDGE_SCOPE,
          userId: authority.userId
        });

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
          const disposition = assertMultipartUploadReplay(
            idempotencyDisposition(reservation)
          );
          lifecycle.completeAdmissionInTransaction(db);
          return disposition;
        }

        const { archive } = persistLinkedKnowledge(db, {
          access,
          auditFingerprint: reservation.auditFingerprint,
          body,
          campaignId,
          requestId,
          userId: authority.userId
        });
        const responseBody = {
          entry: archive.entry,
          rows: finalInput.rows
        };
        assertRetainedResponseFits(responseBody);
        const completed = idempotencyService.completeJsonInTransaction(db, {
          ledgerId: reservation.ledgerId,
          requestHash: canonicalRequestHash,
          leaseToken: reservation.leaseToken,
          statusCode: 200,
          responseBody
        });
        lifecycle.completeAdmissionInTransaction(db);
        return {
          status: completed.statusCode,
          body: completed.responseBody,
          headers: completed.responseHeaders || {}
        };
      }).immediate();
    };
    return Object.freeze(finalizer);
  }

  function createKnowledge(input) {
    return writeKnowledge(
      input,
      'knowledge.create.linked',
      '/api/knowledge'
    );
  }

  function ingestKnowledge(input) {
    return writeKnowledge(
      input,
      'knowledge.ingest.linked',
      '/api/knowledge/ingest'
    );
  }

  function useKnowledge(input) {
    const entryId = positiveSafeId(input.entryId, 'knowledge_entry_id');
    const userId = positiveSafeId(input.userId, 'user_id');
    const custody = resolveRecordCustody(db, {
      recordType: 'knowledge_entry',
      recordId: entryId
    });
    if (custody.classification !== 'campaign_classified') return null;
    const visible = getTargetAccess(db, {
      userId,
      campaignId: custody.campaignId,
      recordType: 'knowledge_entry',
      recordId: entryId,
      relationType: 'knowledge',
      intent: 'read'
    });
    if (!visible.ok) return null;
    if (input.bodyIsEmpty === false) {
      throw invalidInput('Campaign-linked knowledge use requests must have an empty body.');
    }
    const authorize = () => requireKnowledgeTargetAccess(
      db,
      userId,
      custody.campaignId,
      entryId
    );
    return runLinkedMutation(db, {
      userId: input.userId,
      campaignId: custody.campaignId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      path: `/api/knowledge/${entryId}/use`,
      scope: 'knowledge.use.linked',
      body: null,
      payloadKind: 'empty',
      authorize,
      expectedEventCount: 0
    }, ({ access }) => {
      assertCampaignWritable(access);
      const result = db.prepare(`
        UPDATE knowledge_entries
        SET usage_count=usage_count+1,updated_at=datetime('now')
        WHERE id=?
      `).run(entryId);
      if (result.changes !== 1) {
        throw serviceError(
          404,
          'KNOWLEDGE_ENTRY_NOT_FOUND',
          'Knowledge entry was not found.'
        );
      }
      return { status: 200, body: { success: true } };
    });
  }

  return Object.freeze({
    createDemand,
    createProposalConfirmation,
    createProposal,
    createKnowledge,
    createMultipartKnowledgeFinalizer,
    ingestKnowledge,
    useKnowledge
  });
}

module.exports = {
  CampaignLinkServiceError,
  createCampaignLinkService,
  proposalContentSha256,
  validateLegacyKnowledgeBody
};
