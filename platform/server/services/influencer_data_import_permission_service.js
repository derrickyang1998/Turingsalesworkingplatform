'use strict';

const {
  INFLUENCER_DATA_MODULE,
  INFLUENCER_DATA_IMPORT_ACTION
} = require('./module_action_permission_service');

const IMPORT_KINDS = new Set(['manual', 'json', 'upload']);
const SUCCESS_OUTCOMES = new Set(['previewed', 'imported']);

function positiveInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedText(value, fallback, maxLength) {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maxLength)
    : fallback;
}

function organizationId(request) {
  return request && request.authContext && request.authContext.organization
    ? request.authContext.organization.id
    : undefined;
}

function requestId(request) {
  const header = request && request.headers && request.headers['x-request-id'];
  return boundedText(
    request && request.requestId || request && request.phase4Request && request.phase4Request.requestId || header,
    'influencer-import-request',
    120
  );
}

function authorize(permissionService, request, overrides = {}) {
  let decision;
  try {
    decision = permissionService.authorize({
      principal: overrides.principal || request.user,
      organizationId: overrides.organizationId === undefined
        ? organizationId(request)
        : overrides.organizationId,
      module: INFLUENCER_DATA_MODULE,
      action: INFLUENCER_DATA_IMPORT_ACTION
    });
  } catch (_error) {
    decision = { allowed: false, code: 'AUTHORITATIVE_FACTS_UNAVAILABLE' };
  }
  return decision && typeof decision === 'object'
    ? decision
    : { allowed: false, code: 'PERMISSION_DECISION_INVALID' };
}

function auditEvent(request, decision, outcome, input = {}) {
  const kind = IMPORT_KINDS.has(input.importKind) ? input.importKind : 'json';
  const event = {
    actor_user_id: positiveInteger(input.actorUserId === undefined
      ? request && request.user && request.user.id
      : input.actorUserId),
    organization_id: positiveInteger(input.organizationId === undefined
      ? organizationId(request)
      : input.organizationId),
    permission: `${INFLUENCER_DATA_MODULE}.${INFLUENCER_DATA_IMPORT_ACTION}`,
    outcome,
    reason_code: boundedText(decision && decision.code, 'PERMISSION_DECISION_INVALID', 80),
    request_id: requestId(request),
    target_type: 'influencer_dataset',
    target_id: null,
    import_kind: kind,
    ip_address: boundedText(request && request.ip, null, 255)
  };
  if (SUCCESS_OUTCOMES.has(outcome)) {
    event.record_count = nonnegativeInteger(input.recordCount);
    event.skipped_count = nonnegativeInteger(input.skippedCount);
    event.total_count = nonnegativeInteger(input.totalCount);
    event.replayed = input.replayed === true;
  }
  return event;
}

function error(request, statusCode, code, message) {
  const failure = new Error(message);
  failure.statusCode = statusCode;
  failure.code = code;
  failure.requestId = requestId(request);
  return failure;
}

module.exports = Object.freeze({
  authorize,
  auditEvent,
  error,
  organizationId,
  requestId
});
