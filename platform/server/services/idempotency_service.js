'use strict';

const { randomBytes } = require('node:crypto');
const { types: utilTypes } = require('node:util');
const {
  auditFingerprint,
  canonicalJsonBytes
} = require('./sqlite_digest_service');

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const LEASE_SECONDS = 120;
const MAX_OPERATION_SECONDS = 600;
const HEX_64 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const SCOPE = /^[a-z0-9.-]{1,120}$/;
const PERFORMANCE_AI_REVIEW_SCOPE = 'ai.conversation.create.linked';
const RESERVATION_KEYS = Object.freeze([
  'organizationId',
  'actorUserId',
  'campaignId',
  'secondaryCampaignId',
  'resourceClaim',
  'scope',
  'key',
  'requestHash',
  'expectedEventCount',
  'operationTimeoutSeconds'
]);
const COMPLETION_KEYS = Object.freeze([
  'ledgerId',
  'requestHash',
  'leaseToken',
  'statusCode',
  'responseBody',
  'responseHeaders'
]);
const BINARY_COMPLETION_KEYS = Object.freeze([
  'ledgerId',
  'requestHash',
  'leaseToken',
  'statusCode',
  'responseCacheKey',
  'responseSha256',
  'responseBytes',
  'responseContentType',
  'responseFilename',
  'responseHeaders'
]);
const BINARY_EXPIRY_CLEANUP_KEYS = Object.freeze([
  'ledgerId',
  'requestHash',
  'responseCacheKey',
  'responseSha256',
  'responseBytes',
  'responseContentType',
  'responseFilename'
]);
const OWNER_KEYS = Object.freeze([
  'ledgerId',
  'requestHash',
  'leaseToken'
]);
const DEFAULT_JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8'
});
const PPT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DEADLINE_RESPONSE = Object.freeze({
  error: 'Idempotent operation deadline expired.',
  code: 'IDEMPOTENCY_EXPIRED',
  request_id: 'idempotency-recovery'
});
const REPLAY_HEADER_NAMES = new Set([
  'Content-Type',
  'Content-Disposition',
  'Content-Length',
  'ETag',
  'Cache-Control'
]);
const SCOPES = new Set([
  'campaign.create',
  'campaign.update',
  'campaign.transition',
  'campaign.operational',
  'campaign.transfer',
  'campaign.link.attach',
  'campaign.link.correct',
  'campaign.review.create',
  'campaign.workflow.retry',
  'campaign.workflow.reconcile',
  'workflow.campaign-template.create',
  'workflow.campaign-template.graph',
  'workflow.campaign-template.trigger',
  'workflow.campaign-template.publish',
  'workflow.campaign-task.approve',
  'workflow.campaign-task.reject',
  'workflow.campaign-task.complete',
  'workflow.campaign-task.reassign',
  'workflow.campaign-instance.pause',
  'workflow.campaign-instance.resume',
  'workflow.campaign-instance.cancel',
  'demand.create.linked',
  'proposal.create.linked',
  'proposal.ppt.generate.linked',
  'proposal.ppt.generate.unlinked.admission',
  'collaboration.create.linked',
  'collaboration.update.linked',
  'knowledge.create.linked',
  'knowledge.ingest.linked',
  'knowledge.upload.linked',
  'knowledge.use.linked',
  PERFORMANCE_AI_REVIEW_SCOPE,
  'ai.conversation.continue.linked',
  'parser.knowledge-upload.admission',
  'parser.influencer-upload.admission',
  'parser.demand-parse.admission'
]);
const NULL_CAMPAIGN_SCOPES = new Set([
  'workflow.campaign-template.create',
  'workflow.campaign-template.graph',
  'workflow.campaign-template.trigger',
  'workflow.campaign-template.publish',
  'proposal.ppt.generate.unlinked.admission',
  'parser.knowledge-upload.admission',
  'parser.influencer-upload.admission',
  'parser.demand-parse.admission'
]);
const ONE_EVENT_SCOPES = new Set([
  'campaign.create',
  'campaign.transition',
  'campaign.operational',
  'campaign.transfer',
  'campaign.link.attach',
  'campaign.review.create',
  'campaign.workflow.reconcile',
  'demand.create.linked',
  'proposal.create.linked',
  'proposal.ppt.generate.linked',
  'collaboration.create.linked',
  'knowledge.create.linked',
  'knowledge.ingest.linked',
  'knowledge.upload.linked',
  PERFORMANCE_AI_REVIEW_SCOPE
]);
const PPT_SCOPES = new Set([
  'proposal.ppt.generate.linked',
  'proposal.ppt.generate.unlinked.admission'
]);
const PARSER_SCOPES = new Set([
  'parser.knowledge-upload.admission',
  'parser.influencer-upload.admission',
  'parser.demand-parse.admission'
]);

function requireTransaction(db) {
  if (!db || db.inTransaction !== true) {
    throw new TypeError('idempotency mutation requires an active transaction');
  }
}

function invalidInput() {
  return new TypeError('invalid idempotency input');
}

function serviceError(statusCode, code, message, details) {
  const error = new Error(message);
  error.name = 'IdempotencyServiceError';
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function snapshotPlainOptions(value, allowedKeys) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return null;
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))
    ) {
      return null;
    }
    const snapshot = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= SAFE_MAX
    ? value
    : null;
}

function isWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function cloneJsonData(value, state = { depth: 0, nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > 100000 || state.depth > 64) throw invalidInput();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidInput();
    return value;
  }
  if (typeof value === 'string') {
    if (!isWellFormedString(value)) throw invalidInput();
    return value;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    utilTypes.isProxy(value)
  ) {
    throw invalidInput();
  }

  state.depth += 1;
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidInput();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some((key) => (
          typeof key !== 'string' ||
          key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)
        ))
      ) {
        throw invalidInput();
      }
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          throw invalidInput();
        }
        output.push(cloneJsonData(descriptor.value, state));
      }
      return output;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw invalidInput();
    const output = {};
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of ownKeys) {
      const descriptor = descriptors[key];
      if (
        typeof key !== 'string' ||
        !isWellFormedString(key) ||
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw invalidInput();
      }
      Object.defineProperty(output, key, {
        value: cloneJsonData(descriptor.value, state),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return output;
  } catch (error) {
    if (error instanceof TypeError && error.message === 'invalid idempotency input') {
      throw error;
    }
    throw invalidInput();
  } finally {
    state.depth -= 1;
  }
}

function canonicalJsonDocument(value, byteLimit) {
  const snapshot = cloneJsonData(value);
  let bytes;
  try {
    bytes = canonicalJsonBytes(snapshot);
  } catch {
    throw invalidInput();
  }
  if (bytes.length > byteLimit) throw invalidInput();
  return {
    json: bytes.toString('utf8'),
    value: JSON.parse(bytes.toString('utf8'))
  };
}

function canonicalResponseHeaders(value) {
  const headers = value === undefined
    ? DEFAULT_JSON_HEADERS
    : value;
  const snapshot = cloneJsonData(headers);
  for (const [name, headerValue] of Object.entries(snapshot)) {
    if (
      !REPLAY_HEADER_NAMES.has(name) ||
      typeof headerValue !== 'string' ||
      /[\u0000-\u001f\u007f]/.test(headerValue)
    ) {
      throw invalidInput();
    }
  }
  return canonicalJsonDocument(snapshot, 4096);
}

function canonicalBinaryFilename(value) {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > 180 ||
    /[\\/\u0000-\u001f\u007f]/.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw invalidInput();
  }
  return value;
}

function normalizeBinaryExpiryCleanupInput(options) {
  const input = snapshotPlainOptions(options, BINARY_EXPIRY_CLEANUP_KEYS);
  if (!input) throw invalidInput();
  const ledgerId = positiveSafeInteger(input.ledgerId);
  if (
    ledgerId === null ||
    typeof input.requestHash !== 'string' ||
    !HEX_64.test(input.requestHash) ||
    typeof input.responseCacheKey !== 'string' ||
    !HEX_64.test(input.responseCacheKey) ||
    typeof input.responseSha256 !== 'string' ||
    !HEX_64.test(input.responseSha256) ||
    !Number.isSafeInteger(input.responseBytes) ||
    input.responseBytes < 0 ||
    input.responseBytes > 64 * 1024 * 1024 ||
    input.responseContentType !== PPT_CONTENT_TYPE
  ) {
    throw invalidInput();
  }
  return Object.freeze({
    ledgerId,
    requestHash: input.requestHash,
    responseCacheKey: input.responseCacheKey,
    responseSha256: input.responseSha256,
    responseBytes: input.responseBytes,
    responseContentType: input.responseContentType,
    responseFilename: canonicalBinaryFilename(input.responseFilename)
  });
}

function storedBinaryArtifactMetadata(row) {
  let headers;
  let filename;
  try {
    headers = canonicalResponseHeaders(JSON.parse(row.response_headers_json));
    filename = canonicalBinaryFilename(row.response_filename);
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Expired binary idempotency evidence was invalid.'
    );
  }
  if (
    typeof row.response_cache_key !== 'string' ||
    !HEX_64.test(row.response_cache_key) ||
    typeof row.response_sha256 !== 'string' ||
    !HEX_64.test(row.response_sha256) ||
    !Number.isSafeInteger(row.response_bytes) ||
    row.response_bytes < 0 ||
    row.response_bytes > 64 * 1024 * 1024 ||
    row.response_content_type !== PPT_CONTENT_TYPE ||
    headers.value['Content-Type'] !== row.response_content_type ||
    headers.value['Content-Length'] !== String(row.response_bytes) ||
    headers.value.ETag !== `"${row.response_sha256}"` ||
    typeof headers.value['Content-Disposition'] !== 'string' ||
    !headers.value['Content-Disposition'].includes(filename)
  ) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Expired binary idempotency evidence was invalid.'
    );
  }
  return {
    responseCacheKey: row.response_cache_key,
    responseSha256: row.response_sha256,
    responseBytes: row.response_bytes,
    responseContentType: row.response_content_type,
    responseFilename: filename
  };
}

function assertJsonCompletionQuota(db, owner, projectedBytes) {
  const bytes = db.prepare(`
    SELECT
      COALESCE(SUM(CASE
        WHEN user_id=@userId AND scope=@scope
        THEN length(CAST(response_json AS BLOB)) ELSE 0
      END),0) AS user_scope_bytes,
      COALESCE(SUM(CASE
        WHEN user_id=@userId
        THEN length(CAST(response_json AS BLOB)) ELSE 0
      END),0) AS user_bytes,
      COALESCE(SUM(CASE
        WHEN org_id=@organizationId
        THEN length(CAST(response_json AS BLOB)) ELSE 0
      END),0) AS organization_bytes
    FROM request_idempotency
    WHERE state='completed' AND response_kind='json'
  `).get({
    userId: owner.user_id,
    scope: owner.scope,
    organizationId: owner.org_id
  });
  if (
    bytes.user_scope_bytes + projectedBytes > 32 * 1024 * 1024 ||
    bytes.user_bytes + projectedBytes > 128 * 1024 * 1024 ||
    bytes.organization_bytes + projectedBytes > 1024 * 1024 * 1024
  ) {
    throw serviceError(
      507,
      'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED',
      'Idempotency retained JSON response capacity was reached.'
    );
  }
}

function optionalPositiveSafeInteger(value) {
  return value === null
    ? null
    : positiveSafeInteger(value);
}

function expectedCountIsValid(scope, secondaryCampaignId, expectedEventCount) {
  if (
    !Number.isSafeInteger(expectedEventCount) ||
    expectedEventCount < 0 ||
    expectedEventCount > 2
  ) {
    return false;
  }
  if (scope === 'campaign.link.correct') {
    return secondaryCampaignId === null
      ? expectedEventCount === 1
      : expectedEventCount === 2;
  }
  if (scope === 'collaboration.update.linked') {
    return expectedEventCount === 0 || expectedEventCount === 1;
  }
  if (ONE_EVENT_SCOPES.has(scope)) return expectedEventCount === 1;
  return expectedEventCount === 0;
}

function normalizeReservationInput(options) {
  const input = snapshotPlainOptions(options, RESERVATION_KEYS);
  if (!input) throw invalidInput();

  const organizationId = positiveSafeInteger(input.organizationId);
  const actorUserId = positiveSafeInteger(input.actorUserId);
  const campaignId = optionalPositiveSafeInteger(input.campaignId);
  const secondaryCampaignId = optionalPositiveSafeInteger(
    input.secondaryCampaignId
  );
  const operationTimeoutSeconds = positiveSafeInteger(
    input.operationTimeoutSeconds
  );
  const resourceClaim = input.resourceClaim;
  if (
    organizationId === null ||
    actorUserId === null ||
    campaignId === null && input.campaignId !== null ||
    secondaryCampaignId === null && input.secondaryCampaignId !== null ||
    typeof input.scope !== 'string' ||
    !SCOPE.test(input.scope) ||
    !SCOPES.has(input.scope) ||
    typeof input.key !== 'string' ||
    !IDEMPOTENCY_KEY.test(input.key) ||
    typeof input.requestHash !== 'string' ||
    !HEX_64.test(input.requestHash) ||
    operationTimeoutSeconds === null ||
    operationTimeoutSeconds > MAX_OPERATION_SECONDS ||
    resourceClaim !== null && (
      typeof resourceClaim !== 'string' || !HEX_64.test(resourceClaim)
    )
  ) {
    throw invalidInput();
  }
  if (
    NULL_CAMPAIGN_SCOPES.has(input.scope) !== (campaignId === null) ||
    (input.scope === 'proposal.ppt.generate.linked') !== (
      resourceClaim !== null
    ) ||
    (input.scope !== 'campaign.link.correct' && secondaryCampaignId !== null) ||
    (secondaryCampaignId !== null && secondaryCampaignId === campaignId) ||
    !expectedCountIsValid(
      input.scope,
      secondaryCampaignId,
      input.expectedEventCount
    )
  ) {
    throw invalidInput();
  }

  return Object.freeze({
    organizationId,
    actorUserId,
    campaignId,
    secondaryCampaignId,
    resourceClaim,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    expectedEventCount: input.expectedEventCount,
    operationTimeoutSeconds
  });
}

function normalizeLookupInput(options) {
  const input = snapshotPlainOptions(options, RESERVATION_KEYS);
  if (!input) throw invalidInput();
  const organizationId = positiveSafeInteger(input.organizationId);
  const actorUserId = positiveSafeInteger(input.actorUserId);
  if (
    organizationId === null ||
    actorUserId === null ||
    typeof input.scope !== 'string' ||
    !SCOPE.test(input.scope) ||
    !SCOPES.has(input.scope) ||
    typeof input.key !== 'string' ||
    !IDEMPOTENCY_KEY.test(input.key) ||
    typeof input.requestHash !== 'string' ||
    !HEX_64.test(input.requestHash)
  ) {
    throw invalidInput();
  }
  const hasCampaignId = Object.hasOwn(input, 'campaignId');
  const hasSecondaryCampaignId = Object.hasOwn(input, 'secondaryCampaignId');
  if (input.scope === 'campaign.create' && !hasCampaignId) {
    if (
      hasSecondaryCampaignId &&
      input.secondaryCampaignId !== null
    ) {
      throw invalidInput();
    }
    return Object.freeze({
      organizationId,
      actorUserId,
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      preauthorizationOnly: true
    });
  }
  if (!hasCampaignId) throw invalidInput();
  const campaignId = optionalPositiveSafeInteger(input.campaignId);
  if (
    campaignId === null && input.campaignId !== null ||
    NULL_CAMPAIGN_SCOPES.has(input.scope) !== (campaignId === null)
  ) {
    throw invalidInput();
  }

  let secondaryCampaignId = null;
  if (input.scope === 'campaign.link.correct') {
    if (!hasSecondaryCampaignId) throw invalidInput();
    secondaryCampaignId = optionalPositiveSafeInteger(
      input.secondaryCampaignId
    );
    if (
      secondaryCampaignId === null &&
        input.secondaryCampaignId !== null ||
      secondaryCampaignId !== null &&
        secondaryCampaignId === campaignId
    ) {
      throw invalidInput();
    }
  } else if (
    hasSecondaryCampaignId &&
    input.secondaryCampaignId !== null
  ) {
    throw invalidInput();
  }

  return Object.freeze({
    organizationId,
    actorUserId,
    campaignId,
    secondaryCampaignId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    suppliedResourceClaim: input.resourceClaim,
    suppliedExpectedEventCount: input.expectedEventCount,
    hasResourceClaim: Object.hasOwn(input, 'resourceClaim'),
    hasExpectedEventCount: Object.hasOwn(input, 'expectedEventCount'),
    preauthorizationOnly: false
  });
}

function assertStandardReservationQuota(db, input) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE
        WHEN user_id=@actorUserId AND state='processing'
          AND datetime(operation_deadline)>CURRENT_TIMESTAMP
        THEN 1 ELSE 0
      END) AS user_processing,
      SUM(CASE
        WHEN org_id=@organizationId AND state='processing'
          AND datetime(operation_deadline)>CURRENT_TIMESTAMP
        THEN 1 ELSE 0
      END) AS organization_processing,
      SUM(CASE
        WHEN user_id=@actorUserId
          AND datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
        THEN 1 ELSE 0
      END) AS user_hourly,
      SUM(CASE
        WHEN org_id=@organizationId
          AND datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
        THEN 1 ELSE 0
      END) AS organization_hourly,
      SUM(CASE WHEN user_id=@actorUserId THEN 1 ELSE 0 END) AS user_retained,
      SUM(CASE
        WHEN user_id=@actorUserId AND scope=@scope THEN 1 ELSE 0
      END) AS user_scope_retained,
      SUM(CASE WHEN org_id=@organizationId THEN 1 ELSE 0 END)
        AS organization_retained
    FROM request_idempotency
    WHERE scope NOT IN (
      'proposal.ppt.generate.linked',
      'proposal.ppt.generate.unlinked.admission',
      'parser.knowledge-upload.admission',
      'parser.influencer-upload.admission',
      'parser.demand-parse.admission'
    )
  `).get(input);
  if (
    counts.user_processing >= 8 ||
    counts.organization_processing >= 64 ||
    counts.user_hourly >= 200 ||
    counts.organization_hourly >= 2000
  ) {
    throw serviceError(
      429,
      'IDEMPOTENCY_RATE_LIMITED',
      'Idempotency concurrency or hourly-start capacity was reached.'
    );
  }
  if (
    counts.user_retained >= 5000 ||
    counts.user_scope_retained >= 500 ||
    counts.organization_retained >= 50000
  ) {
    throw serviceError(
      507,
      'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED',
      'Idempotency retained-ledger capacity was reached.'
    );
  }
}

function assertPptReservationQuota(db, input) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE
        WHEN user_id=@actorUserId AND state='processing'
          AND datetime(operation_deadline)>CURRENT_TIMESTAMP
        THEN 1 ELSE 0
      END) AS user_processing,
      SUM(CASE
        WHEN org_id=@organizationId AND state='processing'
          AND datetime(operation_deadline)>CURRENT_TIMESTAMP
        THEN 1 ELSE 0
      END) AS organization_processing,
      SUM(CASE
        WHEN user_id=@actorUserId
          AND datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
        THEN 1 ELSE 0
      END) AS user_hourly,
      SUM(CASE
        WHEN org_id=@organizationId
          AND datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
        THEN 1 ELSE 0
      END) AS organization_hourly,
      SUM(CASE
        WHEN user_id=@actorUserId
          AND state IN ('completed','expiring') AND response_kind='binary'
        THEN 1 ELSE 0
      END) AS user_artifacts,
      SUM(CASE
        WHEN org_id=@organizationId
          AND state IN ('completed','expiring') AND response_kind='binary'
        THEN 1 ELSE 0
      END) AS organization_artifacts,
      SUM(CASE
        WHEN user_id=@actorUserId
          AND state IN ('completed','expiring') AND response_kind='binary'
        THEN response_bytes ELSE 0
      END) AS user_artifact_bytes,
      SUM(CASE
        WHEN org_id=@organizationId
          AND state IN ('completed','expiring') AND response_kind='binary'
        THEN response_bytes ELSE 0
      END) AS organization_artifact_bytes
    FROM request_idempotency
    WHERE scope IN (
      'proposal.ppt.generate.linked',
      'proposal.ppt.generate.unlinked.admission'
    )
  `).get(input);
  if (
    counts.user_processing >= 2 ||
    counts.organization_processing >= 8 ||
    counts.user_hourly >= 20 ||
    counts.organization_hourly >= 200
  ) {
    throw serviceError(
      429,
      'PPT_GENERATION_RATE_LIMITED',
      'PPT generation concurrency or hourly-start capacity was reached.'
    );
  }
  if (
    counts.user_artifacts >= 50 ||
    counts.organization_artifacts >= 500 ||
    counts.user_artifact_bytes >= 2 * 1024 * 1024 * 1024 ||
    counts.organization_artifact_bytes >= 20 * 1024 * 1024 * 1024
  ) {
    throw serviceError(
      507,
      'PPT_STORAGE_CAPACITY_EXCEEDED',
      'PPT retained-artifact capacity was reached.'
    );
  }
}

function assertPptCompletionQuota(db, owner, projectedBytes) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE
        WHEN user_id=@userId AND state IN ('completed','expiring') AND response_kind='binary'
        THEN 1 ELSE 0
      END) AS user_artifacts,
      SUM(CASE
        WHEN org_id=@organizationId AND state IN ('completed','expiring') AND response_kind='binary'
        THEN 1 ELSE 0
      END) AS organization_artifacts,
      SUM(CASE
        WHEN user_id=@userId AND state IN ('completed','expiring') AND response_kind='binary'
        THEN response_bytes ELSE 0
      END) AS user_artifact_bytes,
      SUM(CASE
        WHEN org_id=@organizationId AND state IN ('completed','expiring') AND response_kind='binary'
        THEN response_bytes ELSE 0
      END) AS organization_artifact_bytes
    FROM request_idempotency
    WHERE scope IN (
      'proposal.ppt.generate.linked',
      'proposal.ppt.generate.unlinked.admission'
    )
  `).get({ userId: owner.user_id, organizationId: owner.org_id });
  if (
    counts.user_artifacts >= 50 ||
    counts.organization_artifacts >= 500 ||
    counts.user_artifact_bytes + projectedBytes > 2 * 1024 * 1024 * 1024 ||
    counts.organization_artifact_bytes + projectedBytes > 20 * 1024 * 1024 * 1024
  ) {
    throw serviceError(
      507,
      'PPT_STORAGE_CAPACITY_EXCEEDED',
      'PPT retained-artifact capacity was reached.'
    );
  }
}

function assertParserReservationQuota(db, input) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE
        WHEN user_id=@actorUserId AND state='processing'
          AND datetime(operation_deadline)>CURRENT_TIMESTAMP
        THEN 1 ELSE 0
      END) AS user_processing,
      SUM(CASE
        WHEN org_id=@organizationId AND state='processing'
          AND datetime(operation_deadline)>CURRENT_TIMESTAMP
        THEN 1 ELSE 0
      END) AS organization_processing,
      SUM(CASE
        WHEN state='processing' AND datetime(operation_deadline)>CURRENT_TIMESTAMP
        THEN 1 ELSE 0
      END) AS global_processing,
      SUM(CASE
        WHEN user_id=@actorUserId
          AND datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
        THEN 1 ELSE 0
      END) AS user_hourly,
      SUM(CASE
        WHEN org_id=@organizationId
          AND datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
        THEN 1 ELSE 0
      END) AS organization_hourly,
      SUM(CASE
        WHEN datetime(created_at)>=datetime(CURRENT_TIMESTAMP,'-1 hour')
        THEN 1 ELSE 0
      END) AS global_hourly
    FROM request_idempotency
    WHERE scope IN (
      'parser.knowledge-upload.admission',
      'parser.influencer-upload.admission',
      'parser.demand-parse.admission'
    )
  `).get(input);
  if (
    counts.user_processing >= 1 ||
    counts.organization_processing >= 3 ||
    counts.global_processing >= 4 ||
    counts.user_hourly >= 20 ||
    counts.organization_hourly >= 100 ||
    counts.global_hourly >= 200
  ) {
    throw serviceError(
      429,
      'IDEMPOTENCY_RATE_LIMITED',
      'Parser admission concurrency or hourly-start capacity was reached.'
    );
  }
}

function assertReservationQuota(db, input) {
  if (PPT_SCOPES.has(input.scope)) {
    assertPptReservationQuota(db, input);
  } else if (PARSER_SCOPES.has(input.scope)) {
    assertParserReservationQuota(db, input);
  } else {
    assertStandardReservationQuota(db, input);
  }
}

function assertStandardReclaimProcessingQuota(db, row) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS user_processing,
      SUM(CASE WHEN org_id=? THEN 1 ELSE 0 END) AS organization_processing
    FROM request_idempotency
    WHERE state='processing'
      AND datetime(operation_deadline)>CURRENT_TIMESTAMP
      AND scope NOT IN (
        'proposal.ppt.generate.linked',
        'proposal.ppt.generate.unlinked.admission',
        'parser.knowledge-upload.admission',
        'parser.influencer-upload.admission',
        'parser.demand-parse.admission'
      )
  `).get(row.user_id, row.org_id);
  if (
    counts.user_processing >= 8 ||
    counts.organization_processing >= 64
  ) {
    throw serviceError(
      429,
      'IDEMPOTENCY_RATE_LIMITED',
      'Idempotency processing capacity was reached.'
    );
  }
}

function assertPptReclaimProcessingQuota(db, row) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS user_processing,
      SUM(CASE WHEN org_id=? THEN 1 ELSE 0 END) AS organization_processing
    FROM request_idempotency
    WHERE state='processing'
      AND datetime(operation_deadline)>CURRENT_TIMESTAMP
      AND scope IN (
        'proposal.ppt.generate.linked',
        'proposal.ppt.generate.unlinked.admission'
      )
  `).get(row.user_id, row.org_id);
  if (
    counts.user_processing >= 2 ||
    counts.organization_processing >= 8
  ) {
    throw serviceError(
      429,
      'PPT_GENERATION_RATE_LIMITED',
      'PPT generation processing capacity was reached.'
    );
  }
}

function assertParserReclaimProcessingQuota(db, row) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS user_processing,
      SUM(CASE WHEN org_id=? THEN 1 ELSE 0 END) AS organization_processing,
      COUNT(*) AS global_processing
    FROM request_idempotency
    WHERE state='processing'
      AND datetime(operation_deadline)>CURRENT_TIMESTAMP
      AND scope IN (
        'parser.knowledge-upload.admission',
        'parser.influencer-upload.admission',
        'parser.demand-parse.admission'
      )
  `).get(row.user_id, row.org_id);
  if (
    counts.user_processing >= 1 ||
    counts.organization_processing >= 3 ||
    counts.global_processing >= 4
  ) {
    throw serviceError(
      429,
      'IDEMPOTENCY_RATE_LIMITED',
      'Parser admission processing capacity was reached.'
    );
  }
}

function assertReclaimProcessingQuota(db, row) {
  if (PPT_SCOPES.has(row.scope)) {
    assertPptReclaimProcessingQuota(db, row);
  } else if (PARSER_SCOPES.has(row.scope)) {
    assertParserReclaimProcessingQuota(db, row);
  } else {
    assertStandardReclaimProcessingQuota(db, row);
  }
}

function readRetainedRow(db, input) {
  return db.prepare(`
    SELECT
      id,org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,lease_until,lease_token,status_code,response_kind,
      response_json,response_headers_json,response_cache_key,response_sha256,
      response_bytes,response_content_type,response_filename,created_at,updated_at,
      operation_deadline,expires_at,
      CASE
        WHEN lease_until IS NOT NULL AND datetime(lease_until)>CURRENT_TIMESTAMP
        THEN 1 ELSE 0
      END AS lease_active,
      CASE
        WHEN datetime(operation_deadline)>CURRENT_TIMESTAMP THEN 1 ELSE 0
      END AS deadline_active,
      CASE
        WHEN expires_at IS NOT NULL AND datetime(expires_at)<=CURRENT_TIMESTAMP
        THEN 1 ELSE 0
      END AS retention_expired,
      CASE
        WHEN lease_until IS NULL THEN 0
        ELSE MAX(0,unixepoch(lease_until)-unixepoch(CURRENT_TIMESTAMP))
      END AS retry_after_seconds
    FROM request_idempotency
    WHERE org_id=? AND user_id=? AND scope=? AND idempotency_key=?
  `).get(
    input.organizationId,
    input.actorUserId,
    input.scope,
    input.key
  );
}

function expiredDisposition(row) {
  if (
    row.retention_expired === 1 &&
    (
      row.state === 'failed' ||
      row.state === 'completed' &&
        (row.response_kind === 'json' || row.response_kind === 'admission')
    )
  ) {
    return {
      state: 'expired',
      ledgerId: row.id,
      statusCode: 410,
      code: 'IDEMPOTENCY_EXPIRED',
      cleanup: 'delete'
    };
  }
  if (
    row.state === 'expiring' ||
    row.state === 'completed' &&
      row.response_kind === 'binary' &&
      row.retention_expired === 1
  ) {
    return {
      state: 'expired',
      ledgerId: row.id,
      statusCode: 410,
      code: 'IDEMPOTENCY_EXPIRED',
      cleanup: 'binary'
    };
  }
  return null;
}

function readExpiredBinaryArtifact(db, options) {
  const input = normalizeLookupInput(options);
  const row = readRetainedRow(db, input);
  if (!row) return { state: 'absent' };
  if (retainedIdentityConflict(row, input) || row.request_hash !== input.requestHash) {
    return {
      state: 'conflict',
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    };
  }
  if (
    row.state !== 'expiring' ||
    row.response_kind !== 'binary' ||
    row.retention_expired !== 1
  ) {
    return { state: 'not_ready' };
  }
  return {
    state: 'ready',
    ledgerId: row.id,
    requestHash: row.request_hash,
    ...storedBinaryArtifactMetadata(row)
  };
}

function immutableReservationMetadata(row) {
  return {
    campaignId: row.campaign_id,
    secondaryCampaignId: row.secondary_campaign_id,
    resourceClaim: row.resource_claim,
    expectedEventCount: row.expected_event_count
  };
}

function storedMetadataNeeded(row, input) {
  return !(
    input.hasResourceClaim &&
    input.hasExpectedEventCount &&
    input.suppliedResourceClaim === row.resource_claim &&
    input.suppliedExpectedEventCount === row.expected_event_count
  );
}

function storedMetadataProjection(row, input) {
  return storedMetadataNeeded(row, input)
    ? immutableReservationMetadata(row)
    : {};
}

function retainedIdentityConflict(row, input) {
  return (
    row.campaign_id !== input.campaignId ||
    row.secondary_campaign_id !== input.secondaryCampaignId
  );
}

function retainedTerminalDisposition(row, input) {
  if (
    row.state !== 'completed' ||
    row.retention_expired === 1
  ) {
    return null;
  }
  if (row.response_kind === 'json') {
    let responseBody;
    let responseHeaders;
    try {
      responseBody = JSON.parse(row.response_json);
      responseHeaders = JSON.parse(row.response_headers_json);
    } catch {
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'Retained idempotency response evidence was invalid.'
      );
    }
    return {
      state: 'replay',
      ledgerId: row.id,
      statusCode: row.status_code,
      responseKind: 'json',
      responseBody,
      responseHeaders,
      ...storedMetadataProjection(row, input)
    };
  }
  if (row.response_kind === 'binary') {
    let responseHeaders;
    try {
      responseHeaders = JSON.parse(row.response_headers_json);
    } catch {
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'Retained binary idempotency evidence was invalid.'
      );
    }
    return {
      state: 'replay',
      ledgerId: row.id,
      statusCode: row.status_code,
      responseKind: 'binary',
      responseCacheKey: row.response_cache_key,
      responseSha256: row.response_sha256,
      responseBytes: row.response_bytes,
      responseContentType: row.response_content_type,
      responseFilename: row.response_filename,
      responseHeaders,
      ...storedMetadataProjection(row, input)
    };
  }
  if (row.response_kind === 'admission') {
    return {
      state: 'retained',
      ledgerId: row.id,
      responseKind: 'admission',
      replayable: false,
      ...storedMetadataProjection(row, input)
    };
  }
  return null;
}

function inspectRetained(db, options) {
  if (!db || typeof db.prepare !== 'function') throw invalidInput();
  const input = normalizeLookupInput(options);
  const row = readRetainedRow(db, input);
  if (!row) return { state: 'absent' };
  if (input.preauthorizationOnly) {
    return {
      state: 'retained',
      ledgerId: row.id,
      campaignId: row.campaign_id
    };
  }
  if (retainedIdentityConflict(row, input)) {
    return {
      state: 'conflict',
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    };
  }
  const expired = expiredDisposition(row);
  if (expired) return expired;
  if (row.request_hash !== input.requestHash) {
    return {
      state: 'conflict',
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    };
  }
  if (row.state === 'processing') {
    return {
      state: 'processing',
      ledgerId: row.id,
      recoverable: row.lease_active !== 1,
      retryAfterSeconds: row.lease_active === 1
        ? row.retry_after_seconds
        : 0,
      ...(row.deadline_active !== 1 ? { deadlineExpired: true } : {}),
      ...storedMetadataProjection(row, input)
    };
  }
  const terminal = retainedTerminalDisposition(row, input);
  if (terminal) return terminal;
  if (
    row.state === 'failed' &&
    row.retention_expired !== 1
  ) {
    return {
      state: 'processing',
      ledgerId: row.id,
      recoverable: true,
      retryAfterSeconds: 0,
      fromFailed: true,
      ...(row.deadline_active !== 1 ? { deadlineExpired: true } : {}),
      ...storedMetadataProjection(row, input)
    };
  }
  throw serviceError(
    500,
    'AUDIT_PERSISTENCE_FAILED',
    'Retained idempotency state evidence was invalid.'
  );
}

function activePptResourceClaimError(db, {
  organizationId,
  scope,
  resourceClaim
}) {
  if (
    resourceClaim === null ||
    !PPT_SCOPES.has(scope)
  ) {
    return null;
  }
  const claim = db.prepare(`
    SELECT
      state,response_kind,
      CASE
        WHEN state='processing'
        THEN MAX(
          1,
          unixepoch(lease_until)-unixepoch(CURRENT_TIMESTAMP)
        )
        ELSE NULL
      END AS retry_after_seconds
    FROM request_idempotency
    WHERE org_id=? AND scope=? AND resource_claim=?
      AND (
        state='processing'
        OR state='completed' AND response_kind='binary'
        OR state='expiring'
      )
    ORDER BY id
    LIMIT 1
  `).get(organizationId, scope, resourceClaim);
  if (claim && claim.state === 'processing') {
    const inProgress = serviceError(
      409,
      'PPT_GENERATION_IN_PROGRESS',
      'PPT generation is already in progress for this resource.'
    );
    inProgress.retryAfterSeconds = claim.retry_after_seconds;
    return inProgress;
  }
  if (claim) {
    return serviceError(
      409,
      'RECORD_ALREADY_LINKED',
      'The retained PPT resource is already linked.'
    );
  }
  return null;
}

function reserveProcessingInTransaction(db, options) {
  requireTransaction(db);
  const retained = inspectRetained(db, options);
  if (retained.state !== 'absent') return retained;
  const input = normalizeReservationInput(options);
  assertReservationQuota(db, input);

  const reservationNonce = randomBytes(32).toString('hex');
  const leaseToken = randomBytes(32).toString('hex');
  if (
    !HEX_64.test(reservationNonce) ||
    !HEX_64.test(leaseToken)
  ) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Secure idempotency reservation material could not be created.'
    );
  }
  const fingerprint = auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const timestamps = db.prepare(`
    SELECT
      CURRENT_TIMESTAMP AS created_at,
      datetime(
        CURRENT_TIMESTAMP,
        '+' || MIN(?,?) || ' seconds'
      ) AS lease_until,
      datetime(
        CURRENT_TIMESTAMP,
        '+' || ? || ' seconds'
      ) AS operation_deadline
  `).get(
    LEASE_SECONDS,
    input.operationTimeoutSeconds,
    input.operationTimeoutSeconds
  );
  let result;
  try {
    result = db.prepare(`
      INSERT INTO request_idempotency (
        org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
        idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
        expected_event_count,state,lease_until,lease_token,created_at,updated_at,
        operation_deadline
      ) VALUES (
        @organizationId,@actorUserId,@campaignId,@secondaryCampaignId,@resourceClaim,
        @scope,@key,@reservationNonce,@requestHash,@auditFingerprint,
        @expectedEventCount,'processing',@leaseUntil,@leaseToken,@createdAt,@createdAt,
        @operationDeadline
      )
    `).run({
      ...input,
      reservationNonce,
      auditFingerprint: fingerprint,
      leaseUntil: timestamps.lease_until,
      leaseToken,
      createdAt: timestamps.created_at,
      operationDeadline: timestamps.operation_deadline
    });
  } catch (error) {
    const sqliteCode = error && typeof error.code === 'string'
      ? error.code
      : '';
    if (sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
      const raced = inspectRetained(db, input);
      if (raced.state !== 'absent') return raced;
      const claimError = activePptResourceClaimError(db, input);
      if (claimError) throw claimError;
      throw serviceError(
        400,
        'INVALID_CAMPAIGN_INPUT',
        'Idempotency reservation identity was rejected.'
      );
    }
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Idempotency reservation could not be persisted safely.'
    );
  }
  const ledgerId = Number(result.lastInsertRowid);
  if (!Number.isSafeInteger(ledgerId) || ledgerId <= 0) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Idempotency reservation identifier was invalid.'
    );
  }
  return {
    state: 'reserved',
    ledgerId,
    reservationNonce,
    auditFingerprint: fingerprint,
    leaseToken,
    leaseUntil: timestamps.lease_until,
    operationDeadline: timestamps.operation_deadline
  };
}

function renewLeaseInTransaction(db, options) {
  requireTransaction(db);
  const input = snapshotPlainOptions(options, OWNER_KEYS);
  if (!input) throw invalidInput();
  const ledgerId = positiveSafeInteger(input.ledgerId);
  if (
    ledgerId === null ||
    typeof input.requestHash !== 'string' ||
    !HEX_64.test(input.requestHash) ||
    typeof input.leaseToken !== 'string' ||
    !HEX_64.test(input.leaseToken)
  ) {
    throw invalidInput();
  }
  const owner = db.prepare(`
    SELECT lease_until,operation_deadline
    FROM request_idempotency
    WHERE id=? AND request_hash=? AND state='processing' AND lease_token=?
      AND datetime(lease_until)>CURRENT_TIMESTAMP
      AND datetime(operation_deadline)>CURRENT_TIMESTAMP
  `).get(ledgerId, input.requestHash, input.leaseToken);
  if (!owner) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease is no longer owned by this operation.'
    );
  }
  const leaseUntil = db.prepare(`
    SELECT MIN(
      datetime(CURRENT_TIMESTAMP,'+' || ? || ' seconds'),
      datetime(?)
    ) AS value
  `).get(LEASE_SECONDS, owner.operation_deadline).value;
  if (leaseUntil <= owner.lease_until) {
    return {
      state: 'processing',
      ledgerId,
      leaseToken: input.leaseToken,
      leaseUntil: owner.lease_until,
      operationDeadline: owner.operation_deadline,
      renewed: false
    };
  }

  let update;
  try {
    update = db.prepare(`
      UPDATE request_idempotency
      SET lease_until=@newLeaseUntil,updated_at=CURRENT_TIMESTAMP
      WHERE id=@ledgerId
        AND request_hash=@requestHash
        AND state='processing'
        AND lease_token=@leaseToken
        AND lease_until=@oldLeaseUntil
        AND operation_deadline=@operationDeadline
        AND datetime(lease_until)>CURRENT_TIMESTAMP
        AND datetime(operation_deadline)>CURRENT_TIMESTAMP
        AND datetime(@newLeaseUntil)>datetime(lease_until)
        AND datetime(@newLeaseUntil)<=datetime(operation_deadline)
    `).run({
      ledgerId,
      requestHash: input.requestHash,
      leaseToken: input.leaseToken,
      oldLeaseUntil: owner.lease_until,
      operationDeadline: owner.operation_deadline,
      newLeaseUntil: leaseUntil
    });
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Idempotency lease renewal could not be persisted safely.'
    );
  }
  if (update.changes !== 1) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease renewal lost its reservation race.'
    );
  }
  return {
    state: 'processing',
    ledgerId,
    leaseToken: input.leaseToken,
    leaseUntil,
    operationDeadline: owner.operation_deadline,
    renewed: true
  };
}

function completeJsonInTransaction(db, options) {
  requireTransaction(db);
  const input = snapshotPlainOptions(options, COMPLETION_KEYS);
  if (!input) throw invalidInput();
  const ledgerId = positiveSafeInteger(input.ledgerId);
  if (
    ledgerId === null ||
    typeof input.requestHash !== 'string' ||
    !HEX_64.test(input.requestHash) ||
    typeof input.leaseToken !== 'string' ||
    !HEX_64.test(input.leaseToken) ||
    !Number.isSafeInteger(input.statusCode) ||
    !(
      input.statusCode >= 200 && input.statusCode <= 299 ||
      input.statusCode >= 400 && input.statusCode <= 599
    )
  ) {
    throw invalidInput();
  }
  const body = canonicalJsonDocument(input.responseBody, 1048576);
  const headers = canonicalResponseHeaders(input.responseHeaders);
  const owner = db.prepare(`
    SELECT
      id,org_id,user_id,campaign_id,secondary_campaign_id,audit_fingerprint,
      expected_event_count,scope,lease_until,operation_deadline
    FROM request_idempotency
    WHERE id=? AND request_hash=? AND state='processing' AND lease_token=?
      AND datetime(lease_until)>CURRENT_TIMESTAMP
      AND datetime(operation_deadline)>CURRENT_TIMESTAMP
  `).get(ledgerId, input.requestHash, input.leaseToken);
  if (!owner) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease is no longer owned by this operation.'
    );
  }
  assertJsonCompletionQuota(db, owner, Buffer.byteLength(body.json, 'utf8'));

  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN campaign_id=? THEN 1 ELSE 0 END) AS primary_count,
      SUM(CASE WHEN campaign_id=? THEN 1 ELSE 0 END) AS secondary_count
    FROM campaign_events
    WHERE org_id=? AND actor_user_id=? AND audit_fingerprint=?
  `).get(
    owner.campaign_id,
    owner.secondary_campaign_id,
    owner.org_id,
    owner.user_id,
    owner.audit_fingerprint
  );
  const terminalAuditCount = owner.scope === PERFORMANCE_AI_REVIEW_SCOPE
    ? db.prepare(`
      SELECT COUNT(*) AS count
      FROM performance_ai_review_audits
      WHERE request_idempotency_id=?
        AND org_id=? AND campaign_id=? AND actor_user_id=? AND audit_fingerprint=?
    `).get(
      owner.id,
      owner.org_id,
      owner.campaign_id,
      owner.user_id,
      owner.audit_fingerprint
    ).count
    : 0;
  const success = input.statusCode >= 200 && input.statusCode <= 299;
  const terminalReviewAuditMatches = owner.scope === PERFORMANCE_AI_REVIEW_SCOPE &&
    owner.expected_event_count === 1 &&
    owner.secondary_campaign_id === null &&
    counts.total === 0 &&
    terminalAuditCount === 1;
  const cardinalityMatches = success
    ? (
      terminalReviewAuditMatches || (
        terminalAuditCount === 0 &&
        counts.total === owner.expected_event_count &&
        (
          owner.expected_event_count === 0 ||
          owner.expected_event_count === 1 &&
            owner.secondary_campaign_id === null &&
            counts.primary_count === 1 ||
          owner.expected_event_count === 2 &&
            owner.scope === 'campaign.link.correct' &&
            owner.secondary_campaign_id !== null &&
            counts.primary_count === 1 &&
            counts.secondary_count === 1
        )
      )
    )
    : counts.total === 0 && terminalAuditCount === 0;
  if (!cardinalityMatches) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Idempotency audit event cardinality did not match the reserved outcome.'
    );
  }

  let update;
  try {
    update = db.prepare(`
      UPDATE request_idempotency
      SET
        state='completed',
        lease_until=NULL,
        lease_token=NULL,
        status_code=@statusCode,
        response_kind='json',
        response_json=@responseJson,
        response_headers_json=@responseHeadersJson,
        updated_at=CURRENT_TIMESTAMP,
        expires_at=datetime(CURRENT_TIMESTAMP,'+30 days')
      WHERE id=@ledgerId
        AND request_hash=@requestHash
        AND state='processing'
        AND lease_token=@leaseToken
        AND lease_until=@leaseUntil
        AND operation_deadline=@operationDeadline
        AND datetime(lease_until)>CURRENT_TIMESTAMP
        AND datetime(operation_deadline)>CURRENT_TIMESTAMP
    `).run({
      ledgerId,
      requestHash: input.requestHash,
      leaseToken: input.leaseToken,
      leaseUntil: owner.lease_until,
      operationDeadline: owner.operation_deadline,
      statusCode: input.statusCode,
      responseJson: body.json,
      responseHeadersJson: headers.json
    });
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Idempotency completion could not persist its audited outcome.'
    );
  }
  if (update.changes !== 1) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease is no longer owned by this operation.'
    );
  }
  return {
    state: 'replay',
    ledgerId,
    statusCode: input.statusCode,
    responseKind: 'json',
    responseBody: body.value,
    responseHeaders: headers.value
  };
}

function completeAdmissionInTransaction(db, options) {
  requireTransaction(db);
  const input = snapshotPlainOptions(options, OWNER_KEYS);
  if (!input) throw invalidInput();
  const ledgerId = positiveSafeInteger(input.ledgerId);
  if (
    ledgerId === null ||
    typeof input.requestHash !== 'string' ||
    !HEX_64.test(input.requestHash) ||
    typeof input.leaseToken !== 'string' ||
    !HEX_64.test(input.leaseToken)
  ) {
    throw invalidInput();
  }

  const owner = db.prepare(`
    SELECT
      id,org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,lease_until,lease_token,operation_deadline
    FROM request_idempotency
    WHERE id=? AND request_hash=? AND state='processing' AND lease_token=?
      AND datetime(lease_until)>CURRENT_TIMESTAMP
      AND datetime(operation_deadline)>CURRENT_TIMESTAMP
  `).get(ledgerId, input.requestHash, input.leaseToken);
  if (!owner) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease is no longer owned by this operation.'
    );
  }
  if (
    !PARSER_SCOPES.has(owner.scope) ||
    owner.campaign_id !== null ||
    owner.secondary_campaign_id !== null ||
    owner.resource_claim !== null ||
    owner.expected_event_count !== 0 ||
    typeof owner.reservation_nonce !== 'string' ||
    !HEX_64.test(owner.reservation_nonce) ||
    typeof owner.audit_fingerprint !== 'string' ||
    !HEX_64.test(owner.audit_fingerprint)
  ) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Parser admission reservation evidence was invalid.'
    );
  }

  let expectedFingerprint;
  try {
    expectedFingerprint = auditFingerprint({
      organizationId: owner.org_id,
      actorUserId: owner.user_id,
      scope: owner.scope,
      key: owner.idempotency_key,
      requestHash: owner.request_hash,
      reservationNonce: owner.reservation_nonce
    });
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Parser admission reservation evidence was invalid.'
    );
  }
  if (expectedFingerprint !== owner.audit_fingerprint) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Parser admission reservation evidence was invalid.'
    );
  }

  const eventCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM campaign_events
    WHERE org_id=? AND actor_user_id=? AND audit_fingerprint=?
  `).get(
    owner.org_id,
    owner.user_id,
    owner.audit_fingerprint
  ).count;
  if (eventCount !== 0) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Parser admission completion cannot retain campaign events.'
    );
  }

  let update;
  try {
    update = db.prepare(`
      UPDATE request_idempotency
      SET
        state='completed',
        lease_until=NULL,
        lease_token=NULL,
        status_code=200,
        response_kind='admission',
        updated_at=CURRENT_TIMESTAMP,
        expires_at=datetime(CURRENT_TIMESTAMP,'+1 day')
      WHERE id=@ledgerId
        AND request_hash=@requestHash
        AND state='processing'
        AND scope=@scope
        AND idempotency_key=@key
        AND reservation_nonce=@reservationNonce
        AND audit_fingerprint=@auditFingerprint
        AND expected_event_count=0
        AND campaign_id IS NULL
        AND secondary_campaign_id IS NULL
        AND resource_claim IS NULL
        AND lease_token=@leaseToken
        AND lease_until=@leaseUntil
        AND operation_deadline=@operationDeadline
        AND datetime(lease_until)>CURRENT_TIMESTAMP
        AND datetime(operation_deadline)>CURRENT_TIMESTAMP
    `).run({
      ledgerId,
      requestHash: input.requestHash,
      scope: owner.scope,
      key: owner.idempotency_key,
      reservationNonce: owner.reservation_nonce,
      auditFingerprint: owner.audit_fingerprint,
      leaseToken: input.leaseToken,
      leaseUntil: owner.lease_until,
      operationDeadline: owner.operation_deadline
    });
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Parser admission completion could not be persisted safely.'
    );
  }
  if (update.changes !== 1) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease is no longer owned by this operation.'
    );
  }
  return {
    state: 'retained',
    ledgerId,
    responseKind: 'admission',
    replayable: false
  };
}

function completeBinaryInTransaction(db, options) {
  requireTransaction(db);
  const input = snapshotPlainOptions(options, BINARY_COMPLETION_KEYS);
  if (!input) throw invalidInput();
  const ledgerId = positiveSafeInteger(input.ledgerId);
  if (
    ledgerId === null ||
    typeof input.requestHash !== 'string' ||
    !HEX_64.test(input.requestHash) ||
    typeof input.leaseToken !== 'string' ||
    !HEX_64.test(input.leaseToken) ||
    !Number.isSafeInteger(input.statusCode) ||
    input.statusCode < 200 ||
    input.statusCode > 299 ||
    typeof input.responseCacheKey !== 'string' ||
    !HEX_64.test(input.responseCacheKey) ||
    typeof input.responseSha256 !== 'string' ||
    !HEX_64.test(input.responseSha256) ||
    !Number.isSafeInteger(input.responseBytes) ||
    input.responseBytes < 0 ||
    input.responseBytes > 64 * 1024 * 1024 ||
    input.responseContentType !== PPT_CONTENT_TYPE ||
    input.responseHeaders === undefined
  ) {
    throw invalidInput();
  }
  const filename = canonicalBinaryFilename(input.responseFilename);
  const headers = canonicalResponseHeaders(input.responseHeaders);
  if (
    headers.value['Content-Type'] !== input.responseContentType ||
    headers.value['Content-Length'] !== String(input.responseBytes) ||
    headers.value.ETag !== `"${input.responseSha256}"` ||
    typeof headers.value['Content-Disposition'] !== 'string' ||
    !headers.value['Content-Disposition'].includes(filename)
  ) {
    throw invalidInput();
  }
  const owner = db.prepare(`
    SELECT
      id,org_id,user_id,campaign_id,secondary_campaign_id,audit_fingerprint,
      expected_event_count,scope,lease_until,operation_deadline
    FROM request_idempotency
    WHERE id=? AND request_hash=? AND state='processing' AND lease_token=?
      AND datetime(lease_until)>CURRENT_TIMESTAMP
      AND datetime(operation_deadline)>CURRENT_TIMESTAMP
  `).get(ledgerId, input.requestHash, input.leaseToken);
  if (!owner) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease is no longer owned by this operation.'
    );
  }
  if (!PPT_SCOPES.has(owner.scope)) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Binary idempotency completion is reserved for PPT generation.'
    );
  }
  assertPptCompletionQuota(db, owner, input.responseBytes);

  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN campaign_id=? THEN 1 ELSE 0 END) AS primary_count,
      SUM(CASE WHEN campaign_id=? THEN 1 ELSE 0 END) AS secondary_count
    FROM campaign_events
    WHERE org_id=? AND actor_user_id=? AND audit_fingerprint=?
  `).get(
    owner.campaign_id,
    owner.secondary_campaign_id,
    owner.org_id,
    owner.user_id,
    owner.audit_fingerprint
  );
  const cardinalityMatches =
    counts.total === owner.expected_event_count &&
    (
      owner.expected_event_count === 0 ||
      owner.expected_event_count === 1 &&
        owner.secondary_campaign_id === null &&
        counts.primary_count === 1 ||
      owner.expected_event_count === 2 &&
        owner.scope === 'campaign.link.correct' &&
        owner.secondary_campaign_id !== null &&
        counts.primary_count === 1 &&
        counts.secondary_count === 1
    );
  if (!cardinalityMatches) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Idempotency audit event cardinality did not match the reserved outcome.'
    );
  }

  let update;
  try {
    update = db.prepare(`
      UPDATE request_idempotency
      SET
        state='completed',
        lease_until=NULL,
        lease_token=NULL,
        status_code=@statusCode,
        response_kind='binary',
        response_json=NULL,
        response_headers_json=@responseHeadersJson,
        response_cache_key=@responseCacheKey,
        response_sha256=@responseSha256,
        response_bytes=@responseBytes,
        response_content_type=@responseContentType,
        response_filename=@responseFilename,
        updated_at=CURRENT_TIMESTAMP,
        expires_at=datetime(CURRENT_TIMESTAMP,'+30 days')
      WHERE id=@ledgerId
        AND request_hash=@requestHash
        AND state='processing'
        AND lease_token=@leaseToken
        AND lease_until=@leaseUntil
        AND operation_deadline=@operationDeadline
        AND datetime(lease_until)>CURRENT_TIMESTAMP
        AND datetime(operation_deadline)>CURRENT_TIMESTAMP
    `).run({
      ledgerId,
      requestHash: input.requestHash,
      leaseToken: input.leaseToken,
      leaseUntil: owner.lease_until,
      operationDeadline: owner.operation_deadline,
      statusCode: input.statusCode,
      responseHeadersJson: headers.json,
      responseCacheKey: input.responseCacheKey,
      responseSha256: input.responseSha256,
      responseBytes: input.responseBytes,
      responseContentType: input.responseContentType,
      responseFilename: filename
    });
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Binary idempotency completion could not persist its audited outcome.'
    );
  }
  if (update.changes !== 1) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease is no longer owned by this operation.'
    );
  }
  return {
    state: 'replay',
    ledgerId,
    statusCode: input.statusCode,
    responseKind: 'binary',
    responseCacheKey: input.responseCacheKey,
    responseSha256: input.responseSha256,
    responseBytes: input.responseBytes,
    responseContentType: input.responseContentType,
    responseFilename: filename,
    responseHeaders: headers.value
  };
}

function failInternalInTransaction(db, options) {
  requireTransaction(db);
  const input = snapshotPlainOptions(options, OWNER_KEYS);
  if (!input) throw invalidInput();
  const ledgerId = positiveSafeInteger(input.ledgerId);
  if (
    ledgerId === null ||
    typeof input.requestHash !== 'string' ||
    !HEX_64.test(input.requestHash) ||
    typeof input.leaseToken !== 'string' ||
    !HEX_64.test(input.leaseToken)
  ) {
    throw invalidInput();
  }
  const owner = db.prepare(`
    SELECT
      org_id,user_id,audit_fingerprint,lease_until,operation_deadline
    FROM request_idempotency
    WHERE id=? AND request_hash=? AND state='processing' AND lease_token=?
      AND datetime(lease_until)>CURRENT_TIMESTAMP
      AND datetime(operation_deadline)>CURRENT_TIMESTAMP
  `).get(ledgerId, input.requestHash, input.leaseToken);
  if (!owner) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease is no longer owned by this operation.'
    );
  }
  const eventCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM campaign_events
    WHERE org_id=? AND actor_user_id=? AND audit_fingerprint=?
  `).get(
    owner.org_id,
    owner.user_id,
    owner.audit_fingerprint
  ).count;
  if (eventCount !== 0) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Internal idempotency failure cannot retain campaign events.'
    );
  }

  let update;
  try {
    update = db.prepare(`
      UPDATE request_idempotency
      SET
        state='failed',
        lease_until=NULL,
        lease_token=NULL,
        updated_at=CURRENT_TIMESTAMP,
        expires_at=datetime(CURRENT_TIMESTAMP,'+1 day')
      WHERE id=@ledgerId
        AND request_hash=@requestHash
        AND state='processing'
        AND lease_token=@leaseToken
        AND lease_until=@leaseUntil
        AND operation_deadline=@operationDeadline
        AND datetime(lease_until)>CURRENT_TIMESTAMP
        AND datetime(operation_deadline)>CURRENT_TIMESTAMP
    `).run({
      ledgerId,
      requestHash: input.requestHash,
      leaseToken: input.leaseToken,
      leaseUntil: owner.lease_until,
      operationDeadline: owner.operation_deadline
    });
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Internal idempotency failure could not be persisted safely.'
    );
  }
  if (update.changes !== 1) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency lease is no longer owned by this operation.'
    );
  }
  return {
    state: 'processing',
    ledgerId,
    recoverable: true,
    retryAfterSeconds: 0,
    fromFailed: true
  };
}

function terminalizeDeadlineInTransaction(db, row, input) {
  const eventCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM campaign_events
    WHERE org_id=? AND actor_user_id=? AND audit_fingerprint=?
  `).get(
    row.org_id,
    row.user_id,
    row.audit_fingerprint
  ).count;
  if (eventCount !== 0) {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Expired idempotency work cannot retain campaign events.'
    );
  }
  const body = canonicalJsonDocument(DEADLINE_RESPONSE, 1048576);
  const headers = canonicalResponseHeaders(undefined);
  let update;
  try {
    update = db.prepare(`
      UPDATE request_idempotency
      SET
        state='completed',
        lease_until=NULL,
        lease_token=NULL,
        status_code=503,
        response_kind='json',
        response_json=@responseJson,
        response_headers_json=@responseHeadersJson,
        updated_at=CURRENT_TIMESTAMP,
        expires_at=datetime(CURRENT_TIMESTAMP,'+30 days')
      WHERE id=@ledgerId
        AND request_hash=@requestHash
        AND state=@oldState
        AND lease_until IS @oldLeaseUntil
        AND lease_token IS @oldLeaseToken
        AND operation_deadline=@operationDeadline
        AND updated_at=@oldUpdatedAt
        AND datetime(operation_deadline)<=CURRENT_TIMESTAMP
    `).run({
      ledgerId: row.id,
      requestHash: input.requestHash,
      oldState: row.state,
      oldLeaseUntil: row.lease_until,
      oldLeaseToken: row.lease_token,
      operationDeadline: row.operation_deadline,
      oldUpdatedAt: row.updated_at,
      responseJson: body.json,
      responseHeadersJson: headers.json
    });
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Expired idempotency work could not persist its terminal response.'
    );
  }
  if (update.changes !== 1) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Idempotency deadline recovery lost its reservation race.'
    );
  }
  return {
    state: 'replay',
    ledgerId: row.id,
    statusCode: 503,
    responseKind: 'json',
    responseBody: body.value,
    responseHeaders: headers.value
  };
}

function deleteExpiredRetainedInTransaction(db, row) {
  let deletion;
  try {
    deletion = db.prepare(`
      DELETE FROM request_idempotency
      WHERE id=@ledgerId
        AND request_hash=@requestHash
        AND state=@state
        AND response_kind IS @responseKind
        AND updated_at=@updatedAt
        AND expires_at=@expiresAt
        AND datetime(expires_at)<=CURRENT_TIMESTAMP
        AND (
          state='failed'
          OR (state='completed' AND response_kind IN ('json','admission'))
        )
    `).run({
      ledgerId: row.id,
      requestHash: row.request_hash,
      state: row.state,
      responseKind: row.response_kind,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at
    });
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Expired idempotency cleanup could not be persisted safely.'
    );
  }
  if (deletion.changes !== 1) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Expired idempotency cleanup lost its reservation race.'
    );
  }
  return {
    state: 'absent',
    expired: true,
    deleted: true
  };
}

function markBinaryExpiringInTransaction(db, row, disposition) {
  if (row.state === 'expiring') return disposition;
  let update;
  try {
    update = db.prepare(`
      UPDATE request_idempotency
      SET state='expiring',updated_at=CURRENT_TIMESTAMP
      WHERE id=@ledgerId
        AND request_hash=@requestHash
        AND state='completed'
        AND status_code=@statusCode
        AND response_kind='binary'
        AND response_json IS @responseJson
        AND response_headers_json=@responseHeadersJson
        AND response_cache_key=@responseCacheKey
        AND response_sha256=@responseSha256
        AND response_bytes=@responseBytes
        AND response_content_type=@responseContentType
        AND response_filename=@responseFilename
        AND expires_at=@expiresAt
        AND updated_at=@oldUpdatedAt
        AND datetime(expires_at)<=CURRENT_TIMESTAMP
    `).run({
      ledgerId: row.id,
      requestHash: row.request_hash,
      statusCode: row.status_code,
      responseJson: row.response_json,
      responseHeadersJson: row.response_headers_json,
      responseCacheKey: row.response_cache_key,
      responseSha256: row.response_sha256,
      responseBytes: row.response_bytes,
      responseContentType: row.response_content_type,
      responseFilename: row.response_filename,
      expiresAt: row.expires_at,
      oldUpdatedAt: row.updated_at
    });
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Binary idempotency expiry could not be persisted safely.'
    );
  }
  if (update.changes !== 1) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Binary idempotency expiry lost its reservation race.'
    );
  }
  return disposition;
}

function discardExpiredBinaryInTransaction(db, options) {
  requireTransaction(db);
  const input = normalizeBinaryExpiryCleanupInput(options);
  const row = db.prepare(`
    SELECT
      id,request_hash,state,response_kind,response_headers_json,response_cache_key,
      response_sha256,response_bytes,response_content_type,response_filename,
      expires_at,
      CASE
        WHEN datetime(expires_at)<=CURRENT_TIMESTAMP THEN 1 ELSE 0
      END AS retention_expired
    FROM request_idempotency
    WHERE id=? AND request_hash=?
  `).get(input.ledgerId, input.requestHash);
  if (!row) {
    return { state: 'absent', expired: true, deleted: false };
  }
  const artifact = storedBinaryArtifactMetadata(row);
  if (
    row.state !== 'expiring' ||
    row.response_kind !== 'binary' ||
    row.retention_expired !== 1 ||
    artifact.responseCacheKey !== input.responseCacheKey ||
    artifact.responseSha256 !== input.responseSha256 ||
    artifact.responseBytes !== input.responseBytes ||
    artifact.responseContentType !== input.responseContentType ||
    artifact.responseFilename !== input.responseFilename
  ) {
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Expired binary artifact cleanup lost its reservation race.'
    );
  }

  let deletion;
  try {
    deletion = db.prepare(`
      DELETE FROM request_idempotency
      WHERE id=@ledgerId
        AND request_hash=@requestHash
        AND state='expiring'
        AND response_kind='binary'
        AND response_cache_key=@responseCacheKey
        AND response_sha256=@responseSha256
        AND response_bytes=@responseBytes
        AND response_content_type=@responseContentType
        AND response_filename=@responseFilename
        AND datetime(expires_at)<=CURRENT_TIMESTAMP
    `).run(input);
  } catch {
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Expired binary artifact cleanup could not be persisted safely.'
    );
  }
  if (deletion.changes !== 1) {
    const remaining = db.prepare(`
      SELECT id FROM request_idempotency WHERE id=? AND request_hash=?
    `).get(input.ledgerId, input.requestHash);
    if (!remaining) {
      return { state: 'absent', expired: true, deleted: false };
    }
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Expired binary artifact cleanup lost its reservation race.'
    );
  }
  return { state: 'absent', expired: true, deleted: true };
}

function recoverExpiredInTransaction(db, options) {
  requireTransaction(db);
  const input = normalizeLookupInput(options);
  const row = readRetainedRow(db, input);
  if (!row) return { state: 'absent' };
  if (input.preauthorizationOnly) {
    return {
      state: 'retained',
      ledgerId: row.id,
      campaignId: row.campaign_id
    };
  }
  if (retainedIdentityConflict(row, input)) {
    return {
      state: 'conflict',
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    };
  }
  const expired = expiredDisposition(row);
  if (expired && expired.cleanup === 'delete') {
    return deleteExpiredRetainedInTransaction(db, row);
  }
  if (expired && expired.cleanup === 'binary') {
    return markBinaryExpiringInTransaction(db, row, expired);
  }
  if (row.request_hash !== input.requestHash) {
    return {
      state: 'conflict',
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    };
  }
  const terminal = retainedTerminalDisposition(row, input);
  if (terminal) return terminal;
  if (
    (row.state === 'processing' || row.state === 'failed') &&
    row.deadline_active !== 1
  ) {
    return terminalizeDeadlineInTransaction(db, row, input);
  }
  if (row.state === 'processing' && row.lease_active === 1) {
    return {
      state: 'processing',
      ledgerId: row.id,
      recoverable: false,
      retryAfterSeconds: row.retry_after_seconds,
      ...storedMetadataProjection(row, input)
    };
  }
  if (
    row.state === 'failed' &&
    row.deadline_active === 1 &&
    row.retention_expired !== 1
  ) {
    const eventCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_events
      WHERE org_id=? AND actor_user_id=? AND audit_fingerprint=?
    `).get(
      row.org_id,
      row.user_id,
      row.audit_fingerprint
    ).count;
    if (eventCount !== 0) {
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'Failed idempotency work with campaign events cannot be reclaimed.'
      );
    }
    assertReclaimProcessingQuota(db, row);
    const leaseToken = randomBytes(32).toString('hex');
    if (!HEX_64.test(leaseToken)) {
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'Secure idempotency lease material could not be created.'
      );
    }
    const leaseUntil = db.prepare(`
      SELECT MIN(
        datetime(CURRENT_TIMESTAMP,'+' || ? || ' seconds'),
        datetime(?)
      ) AS value
    `).get(LEASE_SECONDS, row.operation_deadline).value;
    let update;
    try {
      update = db.prepare(`
        UPDATE request_idempotency
        SET
          state='processing',
          lease_until=@newLeaseUntil,
          lease_token=@newLeaseToken,
          updated_at=CURRENT_TIMESTAMP,
          expires_at=NULL
        WHERE id=@ledgerId
          AND request_hash=@requestHash
          AND state='failed'
          AND lease_until IS NULL
          AND lease_token IS NULL
          AND operation_deadline=@operationDeadline
          AND expires_at=@oldExpiresAt
          AND updated_at=@oldUpdatedAt
          AND datetime(operation_deadline)>CURRENT_TIMESTAMP
          AND datetime(expires_at)>CURRENT_TIMESTAMP
      `).run({
        ledgerId: row.id,
        requestHash: input.requestHash,
        operationDeadline: row.operation_deadline,
        oldExpiresAt: row.expires_at,
        oldUpdatedAt: row.updated_at,
        newLeaseToken: leaseToken,
        newLeaseUntil: leaseUntil
      });
    } catch (error) {
      const sqliteCode = error && typeof error.code === 'string'
        ? error.code
        : '';
      if (sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
        const claimError = activePptResourceClaimError(db, {
          organizationId: row.org_id,
          scope: row.scope,
          resourceClaim: row.resource_claim
        });
        if (claimError) throw claimError;
      }
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'Failed idempotency reclaim could not be persisted safely.'
      );
    }
    if (update.changes !== 1) {
      throw serviceError(
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        'Failed idempotency reclaim lost its reservation race.'
      );
    }
    return {
      state: 'reserved',
      ledgerId: row.id,
      reservationNonce: row.reservation_nonce,
      auditFingerprint: row.audit_fingerprint,
      leaseToken,
      leaseUntil,
      operationDeadline: row.operation_deadline,
      recovered: true,
      fromFailed: true,
      ...storedMetadataProjection(row, input)
    };
  }
  if (
    row.state === 'processing' &&
    row.lease_active !== 1 &&
    row.deadline_active === 1
  ) {
    let leaseToken;
    do {
      leaseToken = randomBytes(32).toString('hex');
    } while (leaseToken === row.lease_token);
    if (!HEX_64.test(leaseToken)) {
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'Secure idempotency lease material could not be created.'
      );
    }
    const leaseUntil = db.prepare(`
      SELECT MIN(
        datetime(CURRENT_TIMESTAMP,'+' || ? || ' seconds'),
        datetime(?)
      ) AS value
    `).get(LEASE_SECONDS, row.operation_deadline).value;
    let update;
    try {
      update = db.prepare(`
        UPDATE request_idempotency
        SET
          lease_until=@newLeaseUntil,
          lease_token=@newLeaseToken,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=@ledgerId
          AND request_hash=@requestHash
          AND state='processing'
          AND lease_token=@oldLeaseToken
          AND lease_until=@oldLeaseUntil
          AND operation_deadline=@operationDeadline
          AND datetime(lease_until)<=CURRENT_TIMESTAMP
          AND datetime(operation_deadline)>CURRENT_TIMESTAMP
      `).run({
        ledgerId: row.id,
        requestHash: input.requestHash,
        oldLeaseToken: row.lease_token,
        oldLeaseUntil: row.lease_until,
        operationDeadline: row.operation_deadline,
        newLeaseToken: leaseToken,
        newLeaseUntil: leaseUntil
      });
    } catch {
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'Idempotency lease recovery could not be persisted safely.'
      );
    }
    if (update.changes !== 1) {
      throw serviceError(
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        'Idempotency lease recovery lost its reservation race.'
      );
    }
    return {
      state: 'reserved',
      ledgerId: row.id,
      reservationNonce: row.reservation_nonce,
      auditFingerprint: row.audit_fingerprint,
      leaseToken,
      leaseUntil,
      operationDeadline: row.operation_deadline,
      recovered: true,
      fromFailed: false,
      ...storedMetadataProjection(row, input)
    };
  }
  throw serviceError(
    500,
    'AUDIT_PERSISTENCE_FAILED',
    'Retained idempotency recovery evidence was invalid.'
  );
}

function recoverParserAdmissionsInTransaction(db) {
  requireTransaction(db);
  const candidates = db.prepare(`
    SELECT
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,request_hash,expected_event_count
    FROM request_idempotency
    WHERE scope IN (
      'parser.knowledge-upload.admission',
      'parser.influencer-upload.admission',
      'parser.demand-parse.admission'
    )
      AND (
        state IN ('processing','failed')
          AND datetime(operation_deadline)<=CURRENT_TIMESTAMP
        OR state='failed'
          AND datetime(expires_at)<=CURRENT_TIMESTAMP
        OR state='completed'
          AND response_kind IN ('json','admission')
          AND datetime(expires_at)<=CURRENT_TIMESTAMP
      )
    ORDER BY id
  `).all();
  let terminalized = 0;
  let deleted = 0;
  for (const row of candidates) {
    const outcome = recoverExpiredInTransaction(db, {
      organizationId: row.org_id,
      actorUserId: row.user_id,
      campaignId: row.campaign_id,
      secondaryCampaignId: row.secondary_campaign_id,
      resourceClaim: row.resource_claim,
      scope: row.scope,
      key: row.idempotency_key,
      requestHash: row.request_hash,
      expectedEventCount: row.expected_event_count
    });
    if (
      outcome.state === 'replay' &&
      outcome.statusCode === 503 &&
      outcome.responseKind === 'json'
    ) {
      terminalized += 1;
    } else if (
      outcome.state === 'absent' &&
      outcome.expired === true &&
      outcome.deleted === true
    ) {
      deleted += 1;
    } else {
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'Parser admission startup recovery returned an invalid outcome.'
      );
    }
  }
  return {
    scanned: candidates.length,
    terminalized,
    deleted
  };
}

module.exports = {
  inspectRetained,
  readExpiredBinaryArtifact,
  reserveProcessingInTransaction,
  renewLeaseInTransaction,
  completeJsonInTransaction,
  completeAdmissionInTransaction,
  completeBinaryInTransaction,
  failInternalInTransaction,
  discardExpiredBinaryInTransaction,
  recoverExpiredInTransaction,
  recoverParserAdmissionsInTransaction
};
