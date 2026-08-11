'use strict';

const { types } = require('node:util');
const knowledgeService = require('./knowledge_service');

const {
  CrmScopeError,
  resolveCrmAccessContext,
  CUSTOMER_CUSTODY_CASE_SQL
} = require('./crm_scope_service');
const {
  CUSTOMER_LIFECYCLE_REGISTRY,
  OPPORTUNITY_STAGE_REGISTRY,
  CrmContractError,
  assertCustomerLifecycle,
  assertOpportunityStage,
  assertCustomerPriority,
  buildCustomerIdentity
} = require('./crm_contract');

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]+$/;
const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CUSTOMER_LIFECYCLE_REASONS = Object.freeze([
  'requirements_changed',
  'budget_changed',
  'timeline_changed',
  'stakeholder_changed',
  'data_correction',
  'no_response',
  'competitive_loss',
  'no_opportunity_exception'
]);
const CUSTOMER_CUSTODY_REASONS = Object.freeze([
  'capacity_rebalance',
  'territory_change',
  'manager_assignment',
  'legacy_custody_repair',
  'data_correction'
]);
const OPPORTUNITY_REASONS = Object.freeze([
  'requirements_changed',
  'budget_changed',
  'timeline_changed',
  'stakeholder_changed',
  'data_correction',
  'competitive_loss',
  'no_response'
]);
const CAMPAIGN_DISPOSITIONS = Object.freeze(['continue', 'close', 'none']);
const OPPORTUNITY_TEXT_LIMITS = Object.freeze({
  name: 240,
  product_name: 240,
  channel_type: 160,
  competitor_info: 4000,
  decision_chain: 4000,
  notes: 4000,
  loss_reason: 1000
});
const CONTACT_TEXT_LIMITS = Object.freeze({
  name: 200,
  role: 200,
  email: 320,
  phone: 80
});
const TASK_SOURCES = Object.freeze(['manual', 'stage_transition', 'reminder']);
const CUSTOMER_ARTIFACT_TYPES = Object.freeze(['strategy', 'proposal', 'note']);
const CUSTOMER_ACTIVITY_ACTIONS = Object.freeze(['followup_recorded', 'note_recorded']);
const CUSTOMER_ACTIVITY_REFERENCE_TYPES = Object.freeze(['task', 'opportunity']);
const CUSTOMER_CUSTODY_KEYS = Object.freeze({
  release: Object.freeze(['action', 'customerId', 'reason_code']),
  claim: Object.freeze(['action', 'customerId', 'team_id']),
  transfer: Object.freeze(['action', 'assigned_to', 'customerId', 'reason_code', 'team_id']),
  repair: Object.freeze(['action', 'assigned_to', 'customerId', 'reason_code', 'team_id'])
});
const CUSTOMER_PROFILE_FIELDS = Object.freeze([
  'brand_name',
  'company_name',
  'contact_person',
  'contact_info',
  'industry',
  'country',
  'source',
  'budget_estimate',
  'notes',
  'tags',
  'priority',
  'next_action_at'
]);
const LEAD_CUSTOMER_FIELDS = Object.freeze([
  'brand_name',
  'company_name',
  'contact_person',
  'contact_info',
  'source',
  'industry',
  'notes'
]);
const CUSTOMER_TEXT_LIMITS = Object.freeze({
  brand_name: 1000,
  company_name: 1000,
  contact_person: 1000,
  contact_info: 4000,
  industry: 1000,
  country: 120,
  source: 1000,
  budget_estimate: 1000,
  notes: 4000,
  tags: 4000
});
const OUTER_KEYS = Object.freeze([
  'actorUserId',
  'organizationId',
  'organizationCode',
  'requestId',
  'correlationId',
  'command'
]);

const COMMAND_KEYS = Object.freeze({
  customer: Object.freeze(['mode', 'customerId', 'sourceLeadId', 'values', 'transition']),
  lifecycle: Object.freeze([
    'customerId',
    'to_stage',
    'reason_code',
    'next_action_at',
    'no_opportunity_exception'
  ]),
  custody: Object.freeze(['action', 'customerId', 'assigned_to', 'team_id', 'reason_code']),
  opportunity: Object.freeze(['mode', 'customerId', 'opportunityId', 'values', 'transition']),
  contact: Object.freeze(['action', 'customerId', 'contactId', 'values']),
  task: Object.freeze(['action', 'customerId', 'taskId', 'values']),
  archive: Object.freeze(['customerId', 'artifact_type', 'title', 'content', 'tags', 'source_type']),
  activity: Object.freeze(['customerId', 'action', 'reference_type', 'reference_id'])
});

const VALUE_KEYS = Object.freeze({
  customer: Object.freeze([
    'brand_name',
    'company_name',
    'contact_person',
    'contact_info',
    'industry',
    'country',
    'source',
    'budget_estimate',
    'notes',
    'tags',
    'priority',
    'next_action_at',
    'assigned_to',
    'team_id'
  ]),
  opportunity: Object.freeze([
    'name',
    'value',
    'win_probability',
    'product_name',
    'channel_type',
    'expected_close_date',
    'competitor_info',
    'decision_chain',
    'notes',
    'next_action_at',
    'loss_reason',
    'campaign_id'
  ]),
  contact: Object.freeze(['name', 'role', 'email', 'phone', 'is_preferred']),
  task: Object.freeze([
    'opportunity_id',
    'owner_user_id',
    'team_id',
    'title',
    'description',
    'due_at',
    'source',
    'completion_note'
  ])
});

const AUDIT_METADATA_KEYS = Object.freeze({
  duplicate_detected: Object.freeze(['identity_hash', 'visibility', 'source_lead_id']),
  customer_created: Object.freeze(['changed_fields', 'source_lead_id']),
  customer_updated: Object.freeze(['changed_fields']),
  customer_stage_changed: Object.freeze([
    'from_stage',
    'to_stage',
    'reason_code',
    'no_opportunity_exception',
    'changed_fields'
  ]),
  opportunity_created: Object.freeze(['changed_fields', 'stage']),
  opportunity_updated: Object.freeze(['changed_fields']),
  opportunity_stage_changed: Object.freeze([
    'from_stage',
    'to_stage',
    'reason_code',
    'campaign_disposition',
    'changed_fields'
  ]),
  contact_created: Object.freeze(['changed_fields']),
  contact_updated: Object.freeze(['changed_fields']),
  contact_archived: Object.freeze(['changed_fields']),
  task_created: Object.freeze(['opportunity_id', 'owner_user_id', 'team_id']),
  task_completed: Object.freeze(['from_status', 'to_status']),
  task_cancelled: Object.freeze(['from_status', 'to_status']),
  customer_result_archived: Object.freeze([
    'knowledge_entry_id',
    'artifact_type',
    'source_code'
  ]),
  customer_activity_recorded: Object.freeze(['action', 'reference_type', 'reference_id']),
  mutation_denied: Object.freeze(['operation', 'outcome']),
  customer_released_to_pool: Object.freeze([
    'reason_code',
    'from_assigned_to',
    'from_team_id',
    'to_assigned_to',
    'to_team_id'
  ]),
  customer_claimed: Object.freeze([
    'from_assigned_to',
    'from_team_id',
    'to_assigned_to',
    'to_team_id'
  ]),
  customer_transferred: Object.freeze([
    'reason_code',
    'from_assigned_to',
    'from_team_id',
    'to_assigned_to',
    'to_team_id'
  ]),
  customer_custody_repaired: Object.freeze([
    'reason_code',
    'from_assigned_to',
    'from_team_id',
    'to_assigned_to',
    'to_team_id'
  ])
});

const TRANSITION_KEYS = Object.freeze({
  customer: Object.freeze(['to_stage', 'reason_code', 'next_action_at', 'no_opportunity_exception']),
  opportunity: Object.freeze(['to_stage', 'reason_code', 'campaign_disposition'])
});

const ERROR_DEFINITIONS = Object.freeze({
  CRM_MUTATION_INVALID: Object.freeze({ status: 400, title: 'CRM mutation command is not valid' }),
  CRM_CUSTOMER_NOT_FOUND: Object.freeze({ status: 404, title: 'CRM customer was not found' }),
  CRM_CHILD_NOT_FOUND: Object.freeze({ status: 404, title: 'CRM child record was not found' }),
  CRM_CUSTOMER_FORBIDDEN: Object.freeze({ status: 403, title: 'CRM customer mutation is not allowed' }),
  CRM_CUSTOMER_DUPLICATE: Object.freeze({ status: 409, title: 'Customer identity conflicts with an existing record' }),
  CRM_PUBLIC_POOL_UNAVAILABLE: Object.freeze({ status: 409, title: 'CRM public-pool customer is unavailable' }),
  CRM_CUSTODY_CONFLICT: Object.freeze({ status: 409, title: 'CRM customer custody changed' }),
  CRM_TRANSITION_INVALID: Object.freeze({ status: 409, title: 'CRM transition is not allowed' }),
  CRM_STORAGE_BUSY: Object.freeze({ status: 503, title: 'CRM storage is temporarily unavailable', retryable: true }),
  CRM_MUTATION_FAILED: Object.freeze({ status: 500, title: 'CRM mutation failed' })
});

class CrmMutationError extends Error {
  constructor(code, status, title, details, retryable) {
    super(title);
    this.name = 'CrmMutationError';
    this.code = code;
    this.status = status;
    this.title = title;
    this.details = details === undefined ? null : details;
    if (retryable === true) this.retryable = true;
  }

  toJSON() {
    const result = {
      code: this.code,
      status: this.status,
      title: this.title,
      details: this.details
    };
    if (this.retryable === true) result.retryable = true;
    return result;
  }
}

function mutationError(code, details) {
  const definition = ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.CRM_MUTATION_FAILED;
  const safeDetails = details === undefined ? null : deepFreeze(details);
  return new CrmMutationError(
    code,
    definition.status,
    definition.title,
    safeDetails,
    definition.retryable === true
  );
}

function invalidMutation() {
  return mutationError('CRM_MUTATION_INVALID');
}

function invalidTransition() {
  return mutationError('CRM_TRANSITION_INVALID');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalText(value, field, required = false) {
  if (value === null) {
    if (required) throw invalidMutation();
    return null;
  }
  if (typeof value !== 'string') throw invalidMutation();
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw invalidMutation();
    return null;
  }
  if (normalized.length > CUSTOMER_TEXT_LIMITS[field]) throw invalidMutation();
  return normalized;
}

function canonicalBoundedText(value, maximum, required = false) {
  if (value === null) {
    if (required) throw invalidMutation();
    return null;
  }
  if (typeof value !== 'string') throw invalidMutation();
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw invalidMutation();
    return null;
  }
  if (normalized.length > maximum) throw invalidMutation();
  return normalized;
}

function canonicalTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !SQLITE_TIMESTAMP.test(value)) throw invalidMutation();
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19).replace('T', ' ') !== value
  ) throw invalidMutation();
  return value;
}

function canonicalPriority(value) {
  try {
    return assertCustomerPriority(value);
  } catch (error) {
    if (error instanceof CrmContractError) throw invalidMutation();
    throw error;
  }
}

function customerIdentity(brandName, companyName) {
  try {
    return buildCustomerIdentity({
      brand_name: brandName,
      company_name: companyName
    }).key;
  } catch (error) {
    if (error instanceof CrmContractError) throw invalidMutation();
    throw error;
  }
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function snapshotValue(value, depth) {
  if (depth > 6) throw invalidMutation();
  if (value === null || value === undefined) return value;
  if (types.isProxy(value)) throw invalidMutation();

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
  if (valueType !== 'object') throw invalidMutation();

  if (Array.isArray(value)) {
    if (value.length > 256) throw invalidMutation();
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== 'string') throw invalidMutation();
      if (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)) throw invalidMutation();
    }
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidMutation();
      copy.push(snapshotValue(descriptor.value, depth + 1));
    }
    return Object.freeze(copy);
  }

  return snapshotRecord(value, null, depth + 1);
}

function snapshotRecord(value, allowedKeys, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    throw invalidMutation();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidMutation();

  const allowed = allowedKeys ? new Set(allowedKeys) : null;
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed && !allowed.has(key))) throw invalidMutation();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidMutation();
    copy[key] = snapshotValue(descriptor.value, depth + 1);
  }
  return Object.freeze(copy);
}

function validateOptionalIdentifier(value, maximum) {
  if (value === undefined || value === null) return;
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    !SAFE_IDENTIFIER.test(value)
  ) throw invalidMutation();
}

function validateIdProperty(record, key) {
  if (Object.hasOwn(record, key) && !positiveSafeInteger(record[key])) throw invalidMutation();
}

function snapshotCommand(operation, value) {
  const command = snapshotRecord(value, COMMAND_KEYS[operation]);
  const copy = { ...command };

  if (Object.hasOwn(command, 'values')) {
    if (!VALUE_KEYS[operation]) throw invalidMutation();
    copy.values = snapshotRecord(command.values, VALUE_KEYS[operation]);
  }
  if (Object.hasOwn(command, 'transition')) {
    if (!TRANSITION_KEYS[operation]) throw invalidMutation();
    copy.transition = snapshotRecord(command.transition, TRANSITION_KEYS[operation]);
  }

  for (const key of [
    'customerId',
    'sourceLeadId',
    'opportunityId',
    'contactId',
    'taskId',
    'assigned_to',
    'team_id',
    'reference_id'
  ]) validateIdProperty(copy, key);

  if (copy.values) {
    for (const key of ['assigned_to', 'team_id', 'campaign_id', 'opportunity_id', 'owner_user_id']) {
      validateIdProperty(copy.values, key);
    }
  }

  return Object.freeze(copy);
}

function snapshotCall(operation, options) {
  const input = snapshotRecord(options, OUTER_KEYS);
  if (!positiveSafeInteger(input.actorUserId)) throw invalidMutation();

  const hasOrganizationId = Object.hasOwn(input, 'organizationId');
  const hasOrganizationCode = Object.hasOwn(input, 'organizationCode');
  if (hasOrganizationId && hasOrganizationCode) throw invalidMutation();
  if (hasOrganizationId && !positiveSafeInteger(input.organizationId)) throw invalidMutation();
  if (
    hasOrganizationCode &&
    (typeof input.organizationCode !== 'string' || input.organizationCode.length < 1 || input.organizationCode.length > 120)
  ) throw invalidMutation();

  validateOptionalIdentifier(input.requestId, 120);
  validateOptionalIdentifier(input.correlationId, 128);
  if (!Object.hasOwn(input, 'command')) throw invalidMutation();

  return Object.freeze({
    actorUserId: input.actorUserId,
    ...(hasOrganizationId ? { organizationId: input.organizationId } : {}),
    ...(hasOrganizationCode ? { organizationCode: input.organizationCode } : {}),
    requestId: Object.hasOwn(input, 'requestId') ? input.requestId : null,
    correlationId: Object.hasOwn(input, 'correlationId') ? input.correlationId : null,
    command: snapshotCommand(operation, input.command)
  });
}

function contextOptions(input) {
  return {
    actorUserId: input.actorUserId,
    ...(Object.hasOwn(input, 'organizationId') ? { organizationId: input.organizationId } : {}),
    ...(Object.hasOwn(input, 'organizationCode') ? { organizationCode: input.organizationCode } : {}),
    requestId: input.requestId
  };
}

function isActiveAssignment(db, organizationId, ownerUserId, teamId) {
  if (!positiveSafeInteger(ownerUserId) || !positiveSafeInteger(teamId)) return false;
  return Boolean(db.prepare(`
    SELECT 1 AS allowed
    FROM organization_memberships om
    JOIN users u
      ON u.id=om.user_id
    JOIN team_memberships tm
      ON tm.org_id=om.org_id
     AND tm.user_id=om.user_id
    JOIN teams t
      ON t.org_id=tm.org_id
     AND t.id=tm.team_id
    WHERE om.org_id=?
      AND om.user_id=?
      AND u.is_active=1
      AND om.status='active'
      AND om.revoked_at IS NULL
      AND tm.team_id=?
      AND tm.status='active'
      AND tm.revoked_at IS NULL
    LIMIT 1
  `).get(organizationId, ownerUserId, teamId));
}

function readCustomer(db, organizationId, customerId) {
  if (!positiveSafeInteger(customerId)) throw invalidMutation();
  return db.prepare(`
    SELECT
      id,org_id,team_id,assigned_to,created_by,is_public,stage,
      brand_name,company_name,contact_person,contact_info,industry,country,
      source,budget_estimate,notes,tags,priority,next_action_at,
      normalized_identity_key,duplicate_enforced,updated_at
    FROM customers
    WHERE id=? AND org_id=?
  `).get(customerId, organizationId) || null;
}

function classifyCustody(db, customer) {
  if (
    customer.is_public === 1 &&
    customer.assigned_to === null &&
    customer.team_id === null
  ) return 'public';

  if (
    customer.is_public === 0 &&
    isActiveAssignment(db, customer.org_id, customer.assigned_to, customer.team_id)
  ) return 'owned';

  return 'quarantined';
}

function canonicalAuditMetadataValue(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!positiveSafeInteger(value)) throw mutationError('CRM_MUTATION_FAILED');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length < 1 || value.length > 120 || !SAFE_IDENTIFIER.test(value)) {
      throw mutationError('CRM_MUTATION_FAILED');
    }
    return value;
  }
  if (!Array.isArray(value) || value.length > 50) {
    throw mutationError('CRM_MUTATION_FAILED');
  }
  const copy = value.map((item) => {
    if (
      typeof item !== 'string' ||
      item.length < 1 ||
      item.length > 120 ||
      !SAFE_IDENTIFIER.test(item)
    ) throw mutationError('CRM_MUTATION_FAILED');
    return item;
  });
  Object.setPrototypeOf(copy, null);
  return Object.freeze(copy);
}

function canonicalAuditMetadata(eventType, metadata) {
  const allowedKeys = AUDIT_METADATA_KEYS[eventType];
  if (
    !allowedKeys ||
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    types.isProxy(metadata)
  ) throw mutationError('CRM_MUTATION_FAILED');
  const prototype = Object.getPrototypeOf(metadata);
  if (prototype !== Object.prototype && prototype !== null) {
    throw mutationError('CRM_MUTATION_FAILED');
  }

  const canonical = Object.create(null);
  for (const key of Reflect.ownKeys(metadata)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) {
      throw mutationError('CRM_MUTATION_FAILED');
    }
    const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw mutationError('CRM_MUTATION_FAILED');
    }
    canonical[key] = canonicalAuditMetadataValue(descriptor.value);
  }
  return Object.freeze(canonical);
}

function writeAuditEvent(db, context, input, eventType, customerId, metadata, references = {}) {
  const metadataJson = JSON.stringify(canonicalAuditMetadata(eventType, metadata));
  if (Buffer.byteLength(metadataJson, 'utf8') > 8192) throw mutationError('CRM_MUTATION_FAILED');
  db.prepare(`
    INSERT INTO crm_audit_events (
      org_id,customer_id,opportunity_id,task_id,contact_id,actor_user_id,
      event_type,request_id,correlation_id,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    context.organization.id,
    customerId,
    references.opportunity_id || null,
    references.task_id || null,
    references.contact_id || null,
    input.actorUserId,
    eventType,
    input.requestId,
    input.correlationId,
    metadataJson
  );
}

function customerFinalState(command, currentCustomer, lifecycle = null) {
  const creating = command.mode === 'create';
  const values = command.values || Object.freeze({});
  if (creating && !command.values) throw invalidMutation();
  if (creating) {
    if (
      Object.hasOwn(command, 'customerId') ||
      Object.hasOwn(command, 'transition')
    ) throw invalidMutation();
  } else {
    if (
      Object.hasOwn(command, 'sourceLeadId') ||
      (Object.hasOwn(command, 'transition') && !lifecycle) ||
      Object.hasOwn(values, 'assigned_to') ||
      Object.hasOwn(values, 'team_id')
    ) throw invalidMutation();
  }

  const changedFields = Object.keys(values).sort();
  const profileFields = changedFields.filter((field) => CUSTOMER_PROFILE_FIELDS.includes(field));
  if (!creating && profileFields.length === 0 && !lifecycle) throw invalidMutation();

  function mergedText(field, required = false) {
    if (Object.hasOwn(values, field)) {
      return canonicalText(values[field], field, required);
    }
    if (currentCustomer) return currentCustomer[field];
    return canonicalText(null, field, required);
  }

  const final = {
    brand_name: mergedText('brand_name', true),
    company_name: mergedText('company_name'),
    contact_person: mergedText('contact_person'),
    contact_info: mergedText('contact_info'),
    industry: mergedText('industry'),
    country: mergedText('country'),
    source: mergedText('source'),
    budget_estimate: mergedText('budget_estimate'),
    notes: mergedText('notes'),
    tags: mergedText('tags'),
    priority: Object.hasOwn(values, 'priority')
      ? canonicalPriority(values.priority)
      : (currentCustomer ? currentCustomer.priority : 'medium'),
    next_action_at: Object.hasOwn(values, 'next_action_at')
      ? canonicalTimestamp(values.next_action_at)
      : (currentCustomer ? currentCustomer.next_action_at : null)
  };
  if (lifecycle && lifecycle.has_next_action) {
    if (
      Object.hasOwn(values, 'next_action_at') &&
      final.next_action_at !== lifecycle.next_action_at
    ) throw invalidMutation();
    final.next_action_at = lifecycle.next_action_at;
  }
  final.normalized_identity_key = customerIdentity(final.brand_name, final.company_name);
  const finalStage = lifecycle
    ? lifecycle.to_stage
    : (currentCustomer ? currentCustomer.stage : 'lead');
  const finalLifecycle = lifecycleDefinition(finalStage);
  final.duplicate_enforced = finalLifecycle && finalLifecycle.class === 'active' ? 1 : 0;
  return Object.freeze({
    values: Object.freeze(final),
    changed_fields: Object.freeze(changedFields)
  });
}

function readDuplicateCandidates(db, context, identityKey, excludedCustomerId) {
  return db.prepare(`
    SELECT
      c.id,c.brand_name,c.stage,c.assigned_to,c.created_by,c.team_id,
      (${CUSTOMER_CUSTODY_CASE_SQL}) AS custody
    FROM customers c
    WHERE c.org_id=?
      AND c.normalized_identity_key=?
      AND (? IS NULL OR c.id<>?)
      AND (c.stage IS NULL OR c.stage NOT IN ('paused','won','lost'))
    ORDER BY c.id ASC
  `).all(
    context.organization.id,
    identityKey,
    excludedCustomerId,
    excludedCustomerId
  );
}

function duplicateVisibility(context, candidate) {
  if (context.is_org_admin === true) return 'readable';
  if (candidate.custody === 'public') return 'public_pool';
  if (
    candidate.custody === 'owned' &&
    (
      candidate.assigned_to === context.actor_user_id ||
      candidate.created_by === context.actor_user_id ||
      context.team_ids.includes(candidate.team_id)
    )
  ) return 'readable';
  return 'restricted';
}

function duplicateConflict(db, context, identityKey, excludedCustomerId) {
  const candidates = readDuplicateCandidates(db, context, identityKey, excludedCustomerId);
  if (candidates.length === 0) return null;

  const classified = candidates.map((candidate) => ({
    candidate,
    visibility: duplicateVisibility(context, candidate)
  }));
  const readable = classified.find((item) => item.visibility === 'readable');
  if (readable) {
    return deepFreeze({
      conflict: {
        visibility: 'readable',
        customer: {
          id: readable.candidate.id,
          display_name: readable.candidate.brand_name,
          stage: publicCustomerStage(readable.candidate.stage)
        }
      }
    });
  }
  if (classified.some((item) => item.visibility === 'public_pool')) {
    return deepFreeze({
      conflict: { visibility: 'public_pool', action: 'review_public_pool' }
    });
  }
  return deepFreeze({ conflict: { visibility: 'restricted' } });
}

function duplicateDecision(db, context, input, identityKey, excludedCustomerId) {
  const details = duplicateConflict(db, context, identityKey, excludedCustomerId);
  if (!details) return null;
  writeAuditEvent(
    db,
    context,
    input,
    'duplicate_detected',
    excludedCustomerId,
    {
      identity_hash: identityKey,
      visibility: details.conflict.visibility,
      ...(Object.hasOwn(input.command, 'sourceLeadId')
        ? { source_lead_id: input.command.sourceLeadId }
        : {})
    }
  );
  return { error: mutationError('CRM_CUSTOMER_DUPLICATE', details) };
}

function customerSuccessResult(customer, action, input) {
  return deepFreeze({
    ok: true,
    entity: 'customer',
    action,
    record: {
      id: customer.id,
      org_id: customer.org_id,
      team_id: customer.team_id,
      assigned_to: customer.assigned_to,
      is_public: customer.is_public,
      stage: publicCustomerStage(customer.stage),
      priority: customer.priority,
      updated_at: customer.updated_at
    },
    meta: {
      request_id: input.requestId,
      correlation_id: input.correlationId,
      ...(Object.hasOwn(input.command, 'sourceLeadId')
        ? { source_lead_id: input.command.sourceLeadId }
        : {})
    }
  });
}

function writeCustomerActivity(db, customerId, actorUserId, action, stage, notes) {
  db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes
    ) VALUES (?,?,?,?,?,?)
  `).run(
    customerId,
    actorUserId,
    action,
    action === 'created' ? null : stage,
    stage,
    notes
  );
}

function writeCustomerStageActivity(db, customerId, actorUserId, fromStage, toStage) {
  db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes
    ) VALUES (?,?,?,?,?,?)
  `).run(
    customerId,
    actorUserId,
    'stage_change',
    fromStage,
    toStage,
    'customer_stage_changed'
  );
}

function lifecycleDefinition(stage) {
  if (typeof stage !== 'string') return null;
  return Object.hasOwn(CUSTOMER_LIFECYCLE_REGISTRY, stage)
    ? CUSTOMER_LIFECYCLE_REGISTRY[stage]
    : null;
}

function publicCustomerStage(stage) {
  return lifecycleDefinition(stage)?.code || 'legacy_unknown';
}

function canonicalLifecycleStage(value) {
  try {
    return assertCustomerLifecycle(value);
  } catch (error) {
    if (error instanceof CrmContractError) throw invalidTransition();
    throw error;
  }
}

function canonicalLifecycleReason(transition) {
  if (!Object.hasOwn(transition, 'reason_code')) return null;
  if (
    typeof transition.reason_code !== 'string' ||
    !CUSTOMER_LIFECYCLE_REASONS.includes(transition.reason_code)
  ) throw invalidTransition();
  return transition.reason_code;
}

function isFutureTimestamp(db, value) {
  if (value === null) return false;
  return db.prepare('SELECT CASE WHEN ?>CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_future')
    .get(value).is_future === 1;
}

function hasWonOpportunity(db, context, customerId) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM opportunities
    WHERE org_id=? AND customer_id=? AND stage='won'
    LIMIT 1
  `).get(context.organization.id, customerId));
}

function canonicalCustomerLifecycle(db, context, customer, transition) {
  const source = lifecycleDefinition(customer.stage);
  const toStage = canonicalLifecycleStage(transition.to_stage);
  const target = CUSTOMER_LIFECYCLE_REGISTRY[toStage];
  const reasonCode = canonicalLifecycleReason(transition);
  const hasNextAction = Object.hasOwn(transition, 'next_action_at');
  const nextActionAt = hasNextAction
    ? canonicalTimestamp(transition.next_action_at)
    : null;
  const hasException = Object.hasOwn(transition, 'no_opportunity_exception');
  if (hasException && typeof transition.no_opportunity_exception !== 'boolean') {
    throw invalidMutation();
  }
  const noOpportunityException = transition.no_opportunity_exception === true;

  if (customer.stage === toStage || (source && source.code === 'won')) throw invalidTransition();
  if (reasonCode === 'no_opportunity_exception' && !noOpportunityException) throw invalidTransition();
  if (noOpportunityException && toStage !== 'won') throw invalidTransition();

  const requireReason = () => {
    if (!reasonCode) throw invalidTransition();
  };
  const requireFutureAction = () => {
    if (!hasNextAction || !isFutureTimestamp(db, nextActionAt)) throw invalidTransition();
  };
  const requireWonEvidence = () => {
    if (noOpportunityException) {
      if (context.is_org_admin !== true || reasonCode !== 'no_opportunity_exception') {
        throw invalidTransition();
      }
      return;
    }
    if (!hasWonOpportunity(db, context, customer.id)) throw invalidTransition();
  };

  if (!source) {
    requireReason();
    if (target.class === 'active') requireFutureAction();
    if (toStage === 'paused') requireFutureAction();
    if (toStage === 'won') requireWonEvidence();
  } else if (source.class === 'active') {
    if (target.class === 'active') {
      if (target.order < source.order) requireReason();
    } else if (toStage === 'paused') {
      requireReason();
      requireFutureAction();
    } else if (toStage === 'won') {
      requireWonEvidence();
    } else if (toStage === 'lost') {
      requireReason();
    } else {
      throw invalidTransition();
    }
  } else if (source.code === 'paused') {
    if (target.class === 'active') {
      requireReason();
      requireFutureAction();
    } else if (toStage === 'lost') {
      requireReason();
    } else {
      throw invalidTransition();
    }
  } else if (source.code === 'lost') {
    if (target.class !== 'active') throw invalidTransition();
    requireReason();
    requireFutureAction();
  } else {
    throw invalidTransition();
  }

  return Object.freeze({
    from_stage: source ? source.code : 'legacy_unknown',
    to_stage: toStage,
    reason_code: reasonCode,
    no_opportunity_exception: noOpportunityException,
    has_next_action: hasNextAction,
    next_action_at: nextActionAt
  });
}

function isIdentityUniqueFailure(error) {
  return Boolean(
    error &&
    typeof error.code === 'string' &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

function readLeadForConversion(db, context, input) {
  if (!Object.hasOwn(input.command, 'sourceLeadId')) return null;
  const lead = db.prepare(`
    SELECT
      id,brand_name,company_name,contact_person,contact_info,source,industry,
      status,assigned_to,notes,converted_customer_id
    FROM leads
    WHERE id=?
  `).get(input.command.sourceLeadId);
  if (
    !lead ||
    !positiveSafeInteger(lead.assigned_to) ||
    lead.assigned_to !== input.command.values.assigned_to ||
    lead.converted_customer_id !== null ||
    String(lead.status || '').toLowerCase() === 'converted' ||
    (context.is_org_admin !== true && lead.assigned_to !== context.actor_user_id)
  ) return { error: mutationError('CRM_CUSTOMER_NOT_FOUND') };
  return { lead };
}

function inputWithLeadDefaults(input, lead) {
  const mappedValues = {};
  for (const field of LEAD_CUSTOMER_FIELDS) mappedValues[field] = lead[field];
  return Object.freeze({
    ...input,
    command: Object.freeze({
      ...input.command,
      values: Object.freeze({ ...mappedValues, ...input.command.values })
    })
  });
}

function markLeadConverted(db, input, customerId) {
  if (!Object.hasOwn(input.command, 'sourceLeadId')) return;
  const updated = db.prepare(`
    UPDATE leads
    SET status='converted',converted_customer_id=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=?
      AND assigned_to=?
      AND converted_customer_id IS NULL
      AND (status IS NULL OR lower(status)<>'converted')
  `).run(
    customerId,
    input.command.sourceLeadId,
    input.command.values.assigned_to
  );
  if (updated.changes !== 1) throw mutationError('CRM_CUSTOMER_NOT_FOUND');
}

function createCustomer(db, context, input) {
  const final = customerFinalState(input.command, null);
  const duplicate = duplicateDecision(
    db,
    context,
    input,
    final.values.normalized_identity_key,
    null
  );
  if (duplicate) return duplicate;

  let inserted;
  try {
    inserted = db.prepare(`
      INSERT INTO customers (
        brand_name,company_name,contact_person,contact_info,industry,country,
        source,budget_estimate,notes,tags,priority,next_action_at,stage,
        created_by,assigned_to,is_public,org_id,team_id,
        normalized_identity_key,duplicate_enforced
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      final.values.brand_name,
      final.values.company_name,
      final.values.contact_person,
      final.values.contact_info,
      final.values.industry,
      final.values.country,
      final.values.source,
      final.values.budget_estimate,
      final.values.notes,
      final.values.tags,
      final.values.priority,
      final.values.next_action_at,
      'lead',
      input.actorUserId,
      input.command.values.assigned_to,
      0,
      context.organization.id,
      input.command.values.team_id,
      final.values.normalized_identity_key,
      1
    );
  } catch (error) {
    if (!isIdentityUniqueFailure(error)) throw error;
    const racedDuplicate = duplicateDecision(
      db,
      context,
      input,
      final.values.normalized_identity_key,
      null
    );
    if (racedDuplicate) return racedDuplicate;
    throw error;
  }

  const customerId = Number(inserted.lastInsertRowid);
  if (!positiveSafeInteger(customerId)) throw mutationError('CRM_MUTATION_FAILED');
  markLeadConverted(db, input, customerId);
  writeCustomerActivity(db, customerId, input.actorUserId, 'created', 'lead', 'customer_created');
  writeAuditEvent(db, context, input, 'customer_created', customerId, {
    changed_fields: final.changed_fields,
    ...(Object.hasOwn(input.command, 'sourceLeadId')
      ? { source_lead_id: input.command.sourceLeadId }
      : {})
  });
  return customerSuccessResult(
    readCustomer(db, context.organization.id, customerId),
    'created',
    input
  );
}

function updateCustomer(db, context, input, customer, profileCommand = input.command, lifecycle = null) {
  const final = customerFinalState(profileCommand, customer, lifecycle);
  const duplicate = final.values.duplicate_enforced === 1
    ? duplicateDecision(
      db,
      context,
      input,
      final.values.normalized_identity_key,
      customer.id
    )
    : null;
  if (duplicate) return duplicate;

  const profileValues = [
    final.values.brand_name,
    final.values.company_name,
    final.values.contact_person,
    final.values.contact_info,
    final.values.industry,
    final.values.country,
    final.values.source,
    final.values.budget_estimate,
    final.values.notes,
    final.values.tags,
    final.values.priority,
    final.values.next_action_at
  ];
  let updated;
  try {
    updated = lifecycle
      ? db.prepare(`
          UPDATE customers
          SET brand_name=?,company_name=?,contact_person=?,contact_info=?,industry=?,
              country=?,source=?,budget_estimate=?,notes=?,tags=?,priority=?,
              next_action_at=?,stage=?,normalized_identity_key=?,duplicate_enforced=?,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND org_id=? AND stage IS ?
        `).run(
          ...profileValues,
          lifecycle.to_stage,
          final.values.normalized_identity_key,
          final.values.duplicate_enforced,
          customer.id,
          context.organization.id,
          customer.stage
        )
      : db.prepare(`
          UPDATE customers
          SET brand_name=?,company_name=?,contact_person=?,contact_info=?,industry=?,
              country=?,source=?,budget_estimate=?,notes=?,tags=?,priority=?,
              next_action_at=?,normalized_identity_key=?,duplicate_enforced=?,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND org_id=?
        `).run(
          ...profileValues,
          final.values.normalized_identity_key,
          final.values.duplicate_enforced,
          customer.id,
          context.organization.id
        );
  } catch (error) {
    if (!isIdentityUniqueFailure(error)) throw error;
    const racedDuplicate = duplicateDecision(
      db,
      context,
      input,
      final.values.normalized_identity_key,
      customer.id
    );
    if (racedDuplicate) return racedDuplicate;
    throw error;
  }
  if (updated.changes !== 1) {
    throw lifecycle ? invalidTransition() : mutationError('CRM_MUTATION_FAILED');
  }

  if (lifecycle) {
    writeCustomerStageActivity(
      db,
      customer.id,
      input.actorUserId,
      lifecycle.from_stage,
      lifecycle.to_stage
    );
    writeAuditEvent(db, context, input, 'customer_stage_changed', customer.id, {
      from_stage: lifecycle.from_stage,
      to_stage: lifecycle.to_stage,
      reason_code: lifecycle.reason_code,
      no_opportunity_exception: lifecycle.no_opportunity_exception,
      changed_fields: final.changed_fields
    });
  } else {
    writeCustomerActivity(
      db,
      customer.id,
      input.actorUserId,
      'updated',
      customer.stage,
      'customer_profile_updated'
    );
    writeAuditEvent(db, context, input, 'customer_updated', customer.id, {
      changed_fields: final.changed_fields
    });
  }
  return customerSuccessResult(
    readCustomer(db, context.organization.id, customer.id),
    lifecycle ? 'stage_changed' : 'updated',
    input
  );
}

function readOpportunity(db, organizationId, customerId, opportunityId) {
  return db.prepare(`
    SELECT
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,
      expected_close_date,competitor_info,decision_chain,notes,created_by,
      created_at,updated_at,org_id,team_id,owner_user_id,next_action_at,
      loss_reason,closed_at,campaign_id
    FROM opportunities
    WHERE id=? AND org_id=? AND customer_id=?
  `).get(opportunityId, organizationId, customerId) || null;
}

function canonicalOpportunityStage(value) {
  try {
    return assertOpportunityStage(value);
  } catch (error) {
    if (error instanceof CrmContractError) throw invalidTransition();
    throw error;
  }
}

function canonicalOpportunityReason(transition) {
  if (!Object.hasOwn(transition, 'reason_code')) return null;
  if (
    typeof transition.reason_code !== 'string' ||
    !OPPORTUNITY_REASONS.includes(transition.reason_code)
  ) throw invalidTransition();
  return transition.reason_code;
}

function canonicalCampaignDisposition(transition) {
  if (!Object.hasOwn(transition, 'campaign_disposition')) return null;
  if (
    typeof transition.campaign_disposition !== 'string' ||
    !CAMPAIGN_DISPOSITIONS.includes(transition.campaign_disposition)
  ) throw invalidTransition();
  return transition.campaign_disposition;
}

function canonicalOpportunityNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidMutation();
  if (field === 'value' && value < 0) throw invalidMutation();
  if (
    field === 'win_probability' &&
    (!Number.isSafeInteger(value) || value < 0 || value > 100)
  ) throw invalidMutation();
  return value;
}

function validateOpportunityCampaign(db, context, campaignId) {
  if (campaignId === null) return;
  const campaign = db.prepare(`
    SELECT 1 AS present FROM campaigns WHERE id=? AND org_id=?
  `).get(campaignId, context.organization.id);
  if (!campaign) throw invalidMutation();
}

function opportunityTransitionState(db, currentOpportunity, transition, final) {
  if (!transition || !Object.hasOwn(transition, 'to_stage')) throw invalidTransition();
  const source = Object.hasOwn(OPPORTUNITY_STAGE_REGISTRY, currentOpportunity.stage)
    ? OPPORTUNITY_STAGE_REGISTRY[currentOpportunity.stage]
    : null;
  if (!source) throw invalidTransition();
  const toStage = canonicalOpportunityStage(transition.to_stage);
  const target = OPPORTUNITY_STAGE_REGISTRY[toStage];
  if (source.code === target.code) throw invalidTransition();

  const reasonCode = canonicalOpportunityReason(transition);
  const campaignDisposition = canonicalCampaignDisposition(transition);
  const sourceTerminal = source.class === 'terminal';
  const targetTerminal = target.class === 'terminal';
  if (sourceTerminal && targetTerminal) throw invalidTransition();
  if ((sourceTerminal || target.order < source.order) && !reasonCode) throw invalidTransition();

  if (toStage === 'won') {
    if (
      !(final.value > 0) ||
      !Number.isSafeInteger(final.win_probability) ||
      final.win_probability < 0 ||
      final.win_probability > 100 ||
      !final.expected_close_date ||
      !final.decision_chain ||
      !campaignDisposition
    ) throw invalidTransition();
  }
  if (toStage === 'lost' && (!final.loss_reason || !campaignDisposition)) {
    throw invalidTransition();
  }

  const closedAt = targetTerminal
    ? db.prepare('SELECT CURRENT_TIMESTAMP AS value').get().value
    : (sourceTerminal ? null : currentOpportunity.closed_at);
  return Object.freeze({
    from_stage: source.code,
    to_stage: target.code,
    reason_code: reasonCode,
    campaign_disposition: campaignDisposition,
    closed_at: closedAt,
    clear_loss_reason: sourceTerminal || toStage === 'won'
  });
}

function opportunityFinalState(db, context, customer, command, currentOpportunity) {
  const creating = command.mode === 'create';
  const transitioningOnly = command.mode === 'transition';
  if (!creating && command.mode !== 'update' && !transitioningOnly) throw invalidMutation();
  if (creating) {
    if (
      Object.hasOwn(command, 'opportunityId') ||
      Object.hasOwn(command, 'transition') ||
      !command.values
    ) throw invalidMutation();
  } else if (!positiveSafeInteger(command.opportunityId)) {
    throw invalidMutation();
  }
  if (transitioningOnly) {
    if (!command.transition || Object.hasOwn(command, 'values')) throw invalidMutation();
  }

  const values = command.values || Object.freeze({});
  const changedFields = Object.keys(values).sort();
  if (!creating && changedFields.length === 0 && !command.transition) throw invalidMutation();

  function mergedText(field, required = false) {
    if (Object.hasOwn(values, field)) {
      return canonicalBoundedText(values[field], OPPORTUNITY_TEXT_LIMITS[field], required);
    }
    if (currentOpportunity) return currentOpportunity[field];
    return canonicalBoundedText(null, OPPORTUNITY_TEXT_LIMITS[field], required);
  }

  function mergedNumber(field, defaultValue) {
    if (Object.hasOwn(values, field)) return canonicalOpportunityNumber(values[field], field);
    return currentOpportunity ? currentOpportunity[field] : defaultValue;
  }

  function mergedTimestamp(field) {
    if (Object.hasOwn(values, field)) return canonicalTimestamp(values[field]);
    return currentOpportunity ? currentOpportunity[field] : null;
  }

  const final = {
    name: mergedText('name', true),
    value: mergedNumber('value', 0),
    win_probability: mergedNumber('win_probability', 50),
    product_name: mergedText('product_name'),
    channel_type: mergedText('channel_type'),
    expected_close_date: mergedTimestamp('expected_close_date'),
    competitor_info: mergedText('competitor_info'),
    decision_chain: mergedText('decision_chain'),
    notes: mergedText('notes'),
    next_action_at: mergedTimestamp('next_action_at'),
    loss_reason: mergedText('loss_reason'),
    campaign_id: Object.hasOwn(values, 'campaign_id')
      ? values.campaign_id
      : (currentOpportunity ? currentOpportunity.campaign_id : null),
    stage: currentOpportunity ? currentOpportunity.stage : 'discovery',
    closed_at: currentOpportunity ? currentOpportunity.closed_at : null
  };
  validateOpportunityCampaign(db, context, final.campaign_id);

  const transition = command.transition
    ? opportunityTransitionState(db, currentOpportunity, command.transition, final)
    : null;
  if (transition) {
    final.stage = transition.to_stage;
    final.closed_at = transition.closed_at;
    if (transition.clear_loss_reason) final.loss_reason = null;
  }
  if (creating && final.loss_reason !== null) throw invalidMutation();
  if (
    final.stage === 'won' &&
    (
      !(final.value > 0) ||
      !Number.isSafeInteger(final.win_probability) ||
      final.win_probability < 0 ||
      final.win_probability > 100 ||
      !final.expected_close_date ||
      !final.decision_chain
    )
  ) throw invalidTransition();
  if (final.stage === 'lost' && !final.loss_reason) throw invalidTransition();

  return Object.freeze({
    values: Object.freeze(final),
    changed_fields: Object.freeze(changedFields),
    transition
  });
}

function opportunitySuccessResult(opportunity, action, input) {
  return deepFreeze({
    ok: true,
    entity: 'opportunity',
    action,
    record: {
      id: opportunity.id,
      customer_id: opportunity.customer_id,
      stage: opportunity.stage,
      updated_at: opportunity.updated_at
    },
    meta: {
      request_id: input.requestId,
      correlation_id: input.correlationId
    }
  });
}

function writeOpportunityActivity(db, input, customerId, eventType, transition = null) {
  db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes
    ) VALUES (?,?,?,?,?,?)
  `).run(
    customerId,
    input.actorUserId,
    eventType,
    transition ? transition.from_stage : null,
    transition ? transition.to_stage : null,
    eventType
  );
}

function writeOpportunityEvidence(db, context, input, customer, opportunity, final, eventType) {
  writeOpportunityActivity(db, input, customer.id, eventType, final.transition);
  const metadata = final.transition
    ? {
        from_stage: final.transition.from_stage,
        to_stage: final.transition.to_stage,
        reason_code: final.transition.reason_code,
        campaign_disposition: final.transition.campaign_disposition,
        changed_fields: final.changed_fields
      }
    : {
        changed_fields: final.changed_fields,
        ...(eventType === 'opportunity_created' ? { stage: opportunity.stage } : {})
      };
  writeAuditEvent(
    db,
    context,
    input,
    eventType,
    customer.id,
    metadata,
    { opportunity_id: opportunity.id }
  );
}

function createOpportunity(db, context, input, customer) {
  const final = opportunityFinalState(db, context, customer, input.command, null);
  const inserted = db.prepare(`
    INSERT INTO opportunities (
      customer_id,name,stage,value,win_probability,product_name,channel_type,
      expected_close_date,competitor_info,decision_chain,notes,created_by,
      org_id,team_id,owner_user_id,next_action_at,loss_reason,closed_at,campaign_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    customer.id,
    final.values.name,
    final.values.stage,
    final.values.value,
    final.values.win_probability,
    final.values.product_name,
    final.values.channel_type,
    final.values.expected_close_date,
    final.values.competitor_info,
    final.values.decision_chain,
    final.values.notes,
    input.actorUserId,
    context.organization.id,
    customer.team_id,
    customer.assigned_to,
    final.values.next_action_at,
    final.values.loss_reason,
    final.values.closed_at,
    final.values.campaign_id
  );
  const opportunityId = Number(inserted.lastInsertRowid);
  if (!positiveSafeInteger(opportunityId)) throw mutationError('CRM_MUTATION_FAILED');
  const opportunity = readOpportunity(db, context.organization.id, customer.id, opportunityId);
  writeOpportunityEvidence(db, context, input, customer, opportunity, final, 'opportunity_created');
  return opportunitySuccessResult(opportunity, 'created', input);
}

function updateOpportunity(db, context, input, customer, opportunity) {
  const final = opportunityFinalState(db, context, customer, input.command, opportunity);
  const updated = db.prepare(`
    UPDATE opportunities
    SET name=?,stage=?,value=?,win_probability=?,product_name=?,channel_type=?,
        expected_close_date=?,competitor_info=?,decision_chain=?,notes=?,
        next_action_at=?,loss_reason=?,closed_at=?,campaign_id=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND org_id=? AND customer_id=? AND stage IS ? AND updated_at IS ?
  `).run(
    final.values.name,
    final.values.stage,
    final.values.value,
    final.values.win_probability,
    final.values.product_name,
    final.values.channel_type,
    final.values.expected_close_date,
    final.values.competitor_info,
    final.values.decision_chain,
    final.values.notes,
    final.values.next_action_at,
    final.values.loss_reason,
    final.values.closed_at,
    final.values.campaign_id,
    opportunity.id,
    context.organization.id,
    customer.id,
    opportunity.stage,
    opportunity.updated_at
  );
  if (updated.changes !== 1) {
    throw final.transition ? invalidTransition() : mutationError('CRM_MUTATION_FAILED');
  }
  const stored = readOpportunity(db, context.organization.id, customer.id, opportunity.id);
  const eventType = final.transition ? 'opportunity_stage_changed' : 'opportunity_updated';
  writeOpportunityEvidence(db, context, input, customer, stored, final, eventType);
  return opportunitySuccessResult(stored, final.transition ? 'stage_changed' : 'updated', input);
}

function mutateOpportunity(db, context, input, customer) {
  if (input.command.mode === 'create') return createOpportunity(db, context, input, customer);
  if (input.command.mode !== 'update' && input.command.mode !== 'transition') throw invalidMutation();
  const opportunity = readOpportunity(
    db,
    context.organization.id,
    customer.id,
    input.command.opportunityId
  );
  if (!opportunity) return { error: mutationError('CRM_CHILD_NOT_FOUND') };
  return updateOpportunity(db, context, input, customer, opportunity);
}

function readContact(db, organizationId, customerId, contactId) {
  return db.prepare(`
    SELECT id,org_id,customer_id,name,role,email,phone,is_preferred,
           created_by,created_at,updated_at,archived_at
    FROM customer_contacts
    WHERE id=? AND org_id=? AND customer_id=?
  `).get(contactId, organizationId, customerId) || null;
}

function canonicalPreferred(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw invalidMutation();
}

function contactFinalState(command, currentContact) {
  const creating = command.action === 'create';
  if (!creating && command.action !== 'update') throw invalidMutation();
  if (creating) {
    if (Object.hasOwn(command, 'contactId') || !command.values) throw invalidMutation();
  } else if (!positiveSafeInteger(command.contactId) || !command.values) {
    throw invalidMutation();
  }
  const values = command.values;
  const changedFields = Object.keys(values).sort();
  if (!creating && changedFields.length === 0) throw invalidMutation();

  function mergedText(field, required = false) {
    if (Object.hasOwn(values, field)) {
      return canonicalBoundedText(values[field], CONTACT_TEXT_LIMITS[field], required);
    }
    if (currentContact) return currentContact[field];
    return canonicalBoundedText(null, CONTACT_TEXT_LIMITS[field], required);
  }

  const email = mergedText('email');
  if (email !== null && email.length < 3) throw invalidMutation();

  return Object.freeze({
    values: Object.freeze({
      name: mergedText('name', true),
      role: mergedText('role'),
      email,
      phone: mergedText('phone'),
      is_preferred: Object.hasOwn(values, 'is_preferred')
        ? canonicalPreferred(values.is_preferred)
        : (currentContact ? currentContact.is_preferred : 0)
    }),
    changed_fields: Object.freeze(changedFields)
  });
}

function isPreferredContactConflict(error) {
  return Boolean(
    error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT') &&
    typeof error.message === 'string' &&
    (
      error.message.includes('ux_customer_contacts_preferred_active') ||
      error.message.includes('customer_contacts.org_id, customer_contacts.customer_id')
    )
  );
}

function contactSuccessResult(contact, action, input) {
  return deepFreeze({
    ok: true,
    entity: 'contact',
    action,
    record: {
      id: contact.id,
      customer_id: contact.customer_id,
      archived_at: contact.archived_at,
      updated_at: contact.updated_at
    },
    meta: { request_id: input.requestId, correlation_id: input.correlationId }
  });
}

function writeContactEvidence(db, context, input, customer, contact, eventType, changedFields) {
  writeOpportunityActivity(db, input, customer.id, eventType);
  writeAuditEvent(
    db,
    context,
    input,
    eventType,
    customer.id,
    { changed_fields: changedFields },
    { contact_id: contact.id }
  );
}

function createContact(db, context, input, customer) {
  const final = contactFinalState(input.command, null);
  let inserted;
  try {
    inserted = db.prepare(`
      INSERT INTO customer_contacts (
        org_id,customer_id,name,role,email,phone,is_preferred,created_by
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      context.organization.id,
      customer.id,
      final.values.name,
      final.values.role,
      final.values.email,
      final.values.phone,
      final.values.is_preferred,
      input.actorUserId
    );
  } catch (error) {
    if (isPreferredContactConflict(error)) throw invalidMutation();
    throw error;
  }
  const contactId = Number(inserted.lastInsertRowid);
  if (!positiveSafeInteger(contactId)) throw mutationError('CRM_MUTATION_FAILED');
  const contact = readContact(db, context.organization.id, customer.id, contactId);
  writeContactEvidence(db, context, input, customer, contact, 'contact_created', final.changed_fields);
  return contactSuccessResult(contact, 'created', input);
}

function updateContact(db, context, input, customer, contact) {
  if (contact.archived_at !== null) throw invalidTransition();
  const final = contactFinalState(input.command, contact);
  let updated;
  try {
    updated = db.prepare(`
      UPDATE customer_contacts
      SET name=?,role=?,email=?,phone=?,is_preferred=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND org_id=? AND customer_id=?
        AND archived_at IS NULL AND updated_at IS ?
    `).run(
      final.values.name,
      final.values.role,
      final.values.email,
      final.values.phone,
      final.values.is_preferred,
      contact.id,
      context.organization.id,
      customer.id,
      contact.updated_at
    );
  } catch (error) {
    if (isPreferredContactConflict(error)) throw invalidMutation();
    throw error;
  }
  if (updated.changes !== 1) throw mutationError('CRM_MUTATION_FAILED');
  const stored = readContact(db, context.organization.id, customer.id, contact.id);
  writeContactEvidence(db, context, input, customer, stored, 'contact_updated', final.changed_fields);
  return contactSuccessResult(stored, 'updated', input);
}

function archiveContact(db, context, input, customer, contact) {
  if (Object.hasOwn(input.command, 'values')) throw invalidMutation();
  if (contact.archived_at !== null) throw invalidTransition();
  const updated = db.prepare(`
    UPDATE customer_contacts
    SET archived_at=CURRENT_TIMESTAMP,is_preferred=0,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND org_id=? AND customer_id=?
      AND archived_at IS NULL AND updated_at IS ?
  `).run(
    contact.id,
    context.organization.id,
    customer.id,
    contact.updated_at
  );
  if (updated.changes !== 1) throw invalidTransition();
  const stored = readContact(db, context.organization.id, customer.id, contact.id);
  writeContactEvidence(db, context, input, customer, stored, 'contact_archived', Object.freeze([]));
  return contactSuccessResult(stored, 'archived', input);
}

function mutateContact(db, context, input, customer) {
  if (input.command.action === 'create') return createContact(db, context, input, customer);
  if (input.command.action !== 'update' && input.command.action !== 'archive') throw invalidMutation();
  if (!positiveSafeInteger(input.command.contactId)) throw invalidMutation();
  const contact = readContact(
    db,
    context.organization.id,
    customer.id,
    input.command.contactId
  );
  if (!contact) return { error: mutationError('CRM_CHILD_NOT_FOUND') };
  return input.command.action === 'update'
    ? updateContact(db, context, input, customer, contact)
    : archiveContact(db, context, input, customer, contact);
}

function readTask(db, organizationId, customerId, taskId) {
  return db.prepare(`
    SELECT id,org_id,team_id,customer_id,opportunity_id,owner_user_id,
           title,description,due_at,status,source,completed_at,completed_by,
           completion_note,created_by,created_at,updated_at
    FROM crm_tasks
    WHERE id=? AND org_id=? AND customer_id=?
  `).get(taskId, organizationId, customerId) || null;
}

function validateTaskOpportunity(db, context, customerId, opportunityId) {
  if (opportunityId === null) return;
  const opportunity = readOpportunity(db, context.organization.id, customerId, opportunityId);
  if (!opportunity) throw mutationError('CRM_CHILD_NOT_FOUND');
}

function taskSuccessResult(task, action, input) {
  return deepFreeze({
    ok: true,
    entity: 'task',
    action,
    record: {
      id: task.id,
      customer_id: task.customer_id,
      status: task.status,
      updated_at: task.updated_at
    },
    meta: { request_id: input.requestId, correlation_id: input.correlationId }
  });
}

function writeTaskEvidence(db, context, input, customer, task, eventType, metadata) {
  writeOpportunityActivity(db, input, customer.id, eventType);
  writeAuditEvent(
    db,
    context,
    input,
    eventType,
    customer.id,
    metadata,
    { task_id: task.id }
  );
}

function canonicalTaskCreate(command) {
  if (Object.hasOwn(command, 'taskId') || !command.values) throw invalidMutation();
  const values = command.values;
  if (Object.hasOwn(values, 'completion_note')) throw invalidMutation();
  if (!positiveSafeInteger(values.owner_user_id) || !positiveSafeInteger(values.team_id)) {
    throw invalidMutation();
  }
  const source = Object.hasOwn(values, 'source') ? values.source : 'manual';
  if (typeof source !== 'string' || !TASK_SOURCES.includes(source)) throw invalidMutation();
  return Object.freeze({
    opportunity_id: Object.hasOwn(values, 'opportunity_id') ? values.opportunity_id : null,
    owner_user_id: values.owner_user_id,
    team_id: values.team_id,
    title: canonicalBoundedText(values.title, 240, true),
    description: Object.hasOwn(values, 'description')
      ? canonicalBoundedText(values.description, 4000)
      : null,
    due_at: canonicalTimestamp(values.due_at),
    source
  });
}

function createTask(db, context, input, customer) {
  const values = canonicalTaskCreate(input.command);
  validateTargetAssignment(db, context, values.owner_user_id, values.team_id);
  validateTaskOpportunity(db, context, customer.id, values.opportunity_id);
  const inserted = db.prepare(`
    INSERT INTO crm_tasks (
      org_id,team_id,customer_id,opportunity_id,owner_user_id,title,
      description,due_at,status,source,created_by
    ) VALUES (?,?,?,?,?,?,?,?,'open',?,?)
  `).run(
    context.organization.id,
    values.team_id,
    customer.id,
    values.opportunity_id,
    values.owner_user_id,
    values.title,
    values.description,
    values.due_at,
    values.source,
    input.actorUserId
  );
  const taskId = Number(inserted.lastInsertRowid);
  if (!positiveSafeInteger(taskId)) throw mutationError('CRM_MUTATION_FAILED');
  const task = readTask(db, context.organization.id, customer.id, taskId);
  writeTaskEvidence(db, context, input, customer, task, 'task_created', {
    opportunity_id: task.opportunity_id,
    owner_user_id: task.owner_user_id,
    team_id: task.team_id
  });
  return taskSuccessResult(task, 'created', input);
}

function canCloseTask(context, customer, task) {
  return (
    context.is_org_admin === true ||
    customer.assigned_to === context.actor_user_id ||
    task.owner_user_id === context.actor_user_id
  );
}

function closeTask(db, context, input, customer, task) {
  if (!canCloseTask(context, customer, task)) {
    return forbiddenDecision(db, context, input, `customer_task_${input.command.action}`);
  }
  if (task.status !== 'open') throw invalidTransition();
  const values = input.command.values || Object.freeze({});
  const changedFields = Object.keys(values);
  const completing = input.command.action === 'complete';
  if (
    (!completing && changedFields.length > 0) ||
    changedFields.some((field) => field !== 'completion_note')
  ) throw invalidMutation();
  const completionNote = completing && Object.hasOwn(values, 'completion_note')
    ? canonicalBoundedText(values.completion_note, 2000)
    : null;
  const status = completing ? 'completed' : 'cancelled';
  const updated = db.prepare(`
    UPDATE crm_tasks
    SET status=?,completed_at=?,completed_by=?,completion_note=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND org_id=? AND customer_id=? AND status='open' AND updated_at IS ?
  `).run(
    status,
    completing ? db.prepare('SELECT CURRENT_TIMESTAMP AS value').get().value : null,
    completing ? input.actorUserId : null,
    completionNote,
    task.id,
    context.organization.id,
    customer.id,
    task.updated_at
  );
  if (updated.changes !== 1) throw invalidTransition();
  const stored = readTask(db, context.organization.id, customer.id, task.id);
  const eventType = completing ? 'task_completed' : 'task_cancelled';
  writeTaskEvidence(db, context, input, customer, stored, eventType, {
    from_status: 'open',
    to_status: status
  });
  return taskSuccessResult(stored, status, input);
}

function mutateTask(db, context, input, customer) {
  if (input.command.action === 'create') return createTask(db, context, input, customer);
  if (input.command.action !== 'complete' && input.command.action !== 'cancel') throw invalidMutation();
  if (!positiveSafeInteger(input.command.taskId)) throw invalidMutation();
  const task = readTask(db, context.organization.id, customer.id, input.command.taskId);
  if (!task) return { error: mutationError('CRM_CHILD_NOT_FOUND') };
  return closeTask(db, context, input, customer, task);
}

function canonicalArchiveCommand(command) {
  if (
    typeof command.artifact_type !== 'string' ||
    !CUSTOMER_ARTIFACT_TYPES.includes(command.artifact_type)
  ) throw invalidMutation();
  const sourceCode = Object.hasOwn(command, 'source_type')
    ? canonicalBoundedText(command.source_type, 120, true)
    : 'customer';
  const acceptedSourceCodes = [
    'customer',
    `ai_${command.artifact_type}`,
    `manual_${command.artifact_type}`
  ];
  if (!SAFE_IDENTIFIER.test(sourceCode) || !acceptedSourceCodes.includes(sourceCode)) {
    throw invalidMutation();
  }
  let tags = Object.freeze([]);
  if (Object.hasOwn(command, 'tags')) {
    if (!Array.isArray(command.tags) || command.tags.length > 50) throw invalidMutation();
    tags = Object.freeze(command.tags.map((tag) => canonicalBoundedText(tag, 120, true)));
  }
  return Object.freeze({
    artifact_type: command.artifact_type,
    title: canonicalBoundedText(command.title, 1000, true),
    content: canonicalBoundedText(command.content, 1000000, true),
    tags,
    source_code: sourceCode
  });
}

function writeArchiveActivity(db, input, customer, artifactType) {
  const inserted = db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes
    ) VALUES (?,?,?,?,?,?)
  `).run(
    customer.id,
    input.actorUserId,
    `archive_${artifactType}`,
    publicCustomerStage(customer.stage),
    publicCustomerStage(customer.stage),
    'customer_result_archived'
  );
  const activityId = Number(inserted.lastInsertRowid);
  if (!positiveSafeInteger(activityId)) throw mutationError('CRM_MUTATION_FAILED');
  return activityId;
}

function archiveCustomerKnowledge(db, context, input, customer) {
  const archive = canonicalArchiveCommand(input.command);
  const activityId = writeArchiveActivity(db, input, customer, archive.artifact_type);
  const sourceIdParts = [
    'org',
    context.organization.id,
    'customer',
    customer.id,
    archive.artifact_type
  ];
  if (archive.artifact_type === 'note') {
    sourceIdParts.push('activity', activityId);
  }
  const sourceId = sourceIdParts.join(':');
  const knowledgeEntry = knowledgeService.ingestKnowledge(db, {
    entry_type: archive.artifact_type,
    title: archive.title,
    content: archive.content,
    tags: archive.tags,
    source_type: 'crm_customer_archive',
    source_id: sourceId,
    business_type: 'customer',
    business_id: String(customer.id),
    created_by: customer.assigned_to,
    visibility: 'private',
    metadata: {
      organization_id: context.organization.id,
      customer_id: customer.id,
      artifact_type: archive.artifact_type,
      source_code: archive.source_code
    },
    actor_role: context.is_org_admin === true ? 'admin' : 'user'
  });
  if (!knowledgeEntry || !positiveSafeInteger(knowledgeEntry.id)) {
    throw mutationError('CRM_MUTATION_FAILED');
  }
  writeAuditEvent(db, context, input, 'customer_result_archived', customer.id, {
    knowledge_entry_id: knowledgeEntry.id,
    artifact_type: archive.artifact_type,
    source_code: archive.source_code
  });
  return deepFreeze({
    ok: true,
    entity: 'customer_archive',
    action: 'archived',
    record: {
      customer_id: customer.id,
      knowledge_entry_id: knowledgeEntry.id,
      activity_id: activityId,
      artifact_type: archive.artifact_type
    },
    meta: { request_id: input.requestId, correlation_id: input.correlationId }
  });
}

function canonicalActivityCommand(command) {
  if (
    typeof command.action !== 'string' ||
    !CUSTOMER_ACTIVITY_ACTIONS.includes(command.action) ||
    typeof command.reference_type !== 'string' ||
    !CUSTOMER_ACTIVITY_REFERENCE_TYPES.includes(command.reference_type) ||
    !positiveSafeInteger(command.reference_id)
  ) throw invalidMutation();
  return Object.freeze({
    action: command.action,
    reference_type: command.reference_type,
    reference_id: command.reference_id
  });
}

function validateActivityReference(db, context, customer, activity) {
  const reference = activity.reference_type === 'task'
    ? readTask(db, context.organization.id, customer.id, activity.reference_id)
    : readOpportunity(db, context.organization.id, customer.id, activity.reference_id);
  if (!reference) throw mutationError('CRM_CHILD_NOT_FOUND');
}

function recordCompatibilityActivity(db, context, input, customer) {
  const activity = canonicalActivityCommand(input.command);
  validateActivityReference(db, context, customer, activity);
  const inserted = db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes
    ) VALUES (?,?,?,?,?,?)
  `).run(
    customer.id,
    input.actorUserId,
    activity.action,
    publicCustomerStage(customer.stage),
    publicCustomerStage(customer.stage),
    `${activity.reference_type}_reference`
  );
  const activityId = Number(inserted.lastInsertRowid);
  if (!positiveSafeInteger(activityId)) throw mutationError('CRM_MUTATION_FAILED');
  writeAuditEvent(
    db,
    context,
    input,
    'customer_activity_recorded',
    customer.id,
    {
      action: activity.action,
      reference_type: activity.reference_type,
      reference_id: activity.reference_id
    },
    activity.reference_type === 'task'
      ? { task_id: activity.reference_id }
      : { opportunity_id: activity.reference_id }
  );
  const stored = db.prepare(`
    SELECT id,customer_id,action,created_at
    FROM customer_activity WHERE id=?
  `).get(activityId);
  return deepFreeze({
    ok: true,
    entity: 'customer_activity',
    action: 'recorded',
    record: stored,
    meta: { request_id: input.requestId, correlation_id: input.correlationId }
  });
}

function writeDeniedAudit(db, context, input, operation) {
  writeAuditEvent(db, context, input, 'mutation_denied', null, {
    operation,
    outcome: 'forbidden'
  });
}

function forbiddenDecision(db, context, input, operation) {
  writeDeniedAudit(db, context, input, operation);
  return { error: mutationError('CRM_CUSTOMER_FORBIDDEN') };
}

function notFoundDecision() {
  return { error: mutationError('CRM_CUSTOMER_NOT_FOUND') };
}

function unsupportedDecision() {
  return { error: invalidMutation() };
}

function operationLabel(operation, command) {
  if (operation === 'customer') return command.mode === 'create' ? 'customer_create' : 'customer_update';
  if (operation === 'lifecycle') return 'customer_lifecycle';
  if (operation === 'custody') {
    return typeof command.action === 'string' ? `customer_${command.action}` : 'customer_custody';
  }
  return `customer_${operation}`;
}

function canManageProfile(context, customer, custody) {
  if (custody !== 'owned') return false;
  return context.is_org_admin === true || customer.assigned_to === context.actor_user_id;
}

function canWriteTeamActivity(context, customer, custody) {
  if (custody !== 'owned') return false;
  return (
    context.is_org_admin === true ||
    customer.assigned_to === context.actor_user_id ||
    context.team_ids.includes(customer.team_id)
  );
}

function validateTargetAssignment(db, context, ownerUserId, teamId) {
  if (!isActiveAssignment(db, context.organization.id, ownerUserId, teamId)) throw invalidMutation();
}

function canonicalCustodyCommand(command, action) {
  const expectedKeys = CUSTOMER_CUSTODY_KEYS[action];
  if (!expectedKeys) throw invalidMutation();
  const actualKeys = Object.keys(command).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) throw invalidMutation();

  if (action === 'claim') {
    return Object.freeze({ action, customer_id: command.customerId, team_id: command.team_id });
  }
  if (
    typeof command.reason_code !== 'string' ||
    !CUSTOMER_CUSTODY_REASONS.includes(command.reason_code)
  ) throw invalidMutation();
  return Object.freeze({
    action,
    customer_id: command.customerId,
    reason_code: command.reason_code,
    ...(action === 'transfer' || action === 'repair'
      ? { assigned_to: command.assigned_to, team_id: command.team_id }
      : {})
  });
}

function custodyMetadata(customer, assignedTo, teamId, reasonCode) {
  return {
    ...(reasonCode ? { reason_code: reasonCode } : {}),
    from_assigned_to: customer.assigned_to,
    from_team_id: customer.team_id,
    to_assigned_to: assignedTo,
    to_team_id: teamId
  };
}

function writeCustodyEvidence(db, context, input, customer, eventType, activityAction, metadata) {
  writeCustomerActivity(
    db,
    customer.id,
    input.actorUserId,
    activityAction,
    publicCustomerStage(customer.stage),
    eventType
  );
  writeAuditEvent(db, context, input, eventType, customer.id, metadata);
}

function custodySuccess(db, context, input, customerId, action) {
  return customerSuccessResult(
    readCustomer(db, context.organization.id, customerId),
    action,
    input
  );
}

function releaseCustomerCustody(db, context, input, customer, command) {
  const updated = db.prepare(`
    UPDATE customers
    SET assigned_to=NULL,team_id=NULL,is_public=1,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND org_id=? AND is_public=0 AND assigned_to=? AND team_id=?
  `).run(
    customer.id,
    context.organization.id,
    customer.assigned_to,
    customer.team_id
  );
  if (updated.changes !== 1) throw mutationError('CRM_CUSTODY_CONFLICT');
  writeCustodyEvidence(
    db,
    context,
    input,
    customer,
    'customer_released_to_pool',
    'returned_to_pool',
    custodyMetadata(customer, null, null, command.reason_code)
  );
  return custodySuccess(db, context, input, customer.id, 'released');
}

function claimCustomerCustody(db, context, input, customer, command) {
  const updated = db.prepare(`
    UPDATE customers
    SET assigned_to=?,team_id=?,is_public=0,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND org_id=? AND is_public=1 AND assigned_to IS NULL AND team_id IS NULL
  `).run(
    context.actor_user_id,
    command.team_id,
    customer.id,
    context.organization.id
  );
  if (updated.changes !== 1) throw mutationError('CRM_PUBLIC_POOL_UNAVAILABLE');
  writeCustodyEvidence(
    db,
    context,
    input,
    customer,
    'customer_claimed',
    'claimed',
    custodyMetadata(customer, context.actor_user_id, command.team_id, null)
  );
  return custodySuccess(db, context, input, customer.id, 'claimed');
}

function transferCustomerCustody(db, context, input, customer, command) {
  if (customer.assigned_to === command.assigned_to && customer.team_id === command.team_id) {
    throw invalidMutation();
  }
  const updated = db.prepare(`
    UPDATE customers
    SET assigned_to=?,team_id=?,is_public=0,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND org_id=? AND is_public=0 AND assigned_to=? AND team_id=?
  `).run(
    command.assigned_to,
    command.team_id,
    customer.id,
    context.organization.id,
    customer.assigned_to,
    customer.team_id
  );
  if (updated.changes !== 1) throw mutationError('CRM_CUSTODY_CONFLICT');

  const openTaskCount = db.prepare(`
    SELECT COUNT(*) AS count FROM crm_tasks
    WHERE org_id=? AND customer_id=? AND status='open'
  `).get(context.organization.id, customer.id).count;
  const tasks = db.prepare(`
    UPDATE crm_tasks
    SET owner_user_id=?,team_id=?,updated_at=CURRENT_TIMESTAMP
    WHERE org_id=? AND customer_id=? AND status='open'
  `).run(
    command.assigned_to,
    command.team_id,
    context.organization.id,
    customer.id
  );
  if (tasks.changes !== openTaskCount) throw mutationError('CRM_CUSTODY_CONFLICT');

  writeCustodyEvidence(
    db,
    context,
    input,
    customer,
    'customer_transferred',
    'assigned',
    custodyMetadata(customer, command.assigned_to, command.team_id, command.reason_code)
  );
  return custodySuccess(db, context, input, customer.id, 'transferred');
}

function repairCustomerCustody(db, context, input, customer, command) {
  const updated = db.prepare(`
    UPDATE customers
    SET assigned_to=?,team_id=?,is_public=0,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND org_id=?
      AND assigned_to IS ? AND team_id IS ? AND is_public IS ?
  `).run(
    command.assigned_to,
    command.team_id,
    customer.id,
    context.organization.id,
    customer.assigned_to,
    customer.team_id,
    customer.is_public
  );
  if (updated.changes !== 1) throw mutationError('CRM_CUSTODY_CONFLICT');
  writeCustodyEvidence(
    db,
    context,
    input,
    customer,
    'customer_custody_repaired',
    'custody_repaired',
    custodyMetadata(customer, command.assigned_to, command.team_id, command.reason_code)
  );
  return custodySuccess(db, context, input, customer.id, 'repaired');
}

function authorizeCreate(db, context, input) {
  const command = input.command;
  if (!command.values || !positiveSafeInteger(command.values.assigned_to) || !positiveSafeInteger(command.values.team_id)) {
    throw invalidMutation();
  }
  if (
    context.is_org_admin !== true &&
    (
      command.values.assigned_to !== context.actor_user_id ||
      !context.team_ids.includes(command.values.team_id)
    )
  ) return forbiddenDecision(db, context, input, 'customer_create');
  validateTargetAssignment(db, context, command.values.assigned_to, command.values.team_id);
  return null;
}

function authorizeCustomerCommand(db, context, input, operation) {
  const command = input.command;
  const label = operationLabel(operation, command);

  if (operation === 'customer' && command.mode === 'create') {
    const denied = authorizeCreate(db, context, input);
    if (denied) return denied;
    const conversion = readLeadForConversion(db, context, input);
    if (conversion && conversion.error) return conversion;
    return createCustomer(
      db,
      context,
      conversion ? inputWithLeadDefaults(input, conversion.lead) : input
    );
  }
  if (operation === 'customer' && command.mode !== 'update') throw invalidMutation();

  const customer = readCustomer(db, context.organization.id, command.customerId);
  if (!customer) return notFoundDecision();
  const custody = classifyCustody(db, customer);

  if (operation === 'custody') {
    const action = command.action;
    if (action === 'claim') {
      if (custody !== 'public') {
        return { error: mutationError('CRM_PUBLIC_POOL_UNAVAILABLE') };
      }
      const canonical = canonicalCustodyCommand(command, action);
      validateTargetAssignment(db, context, context.actor_user_id, canonical.team_id);
      return claimCustomerCustody(db, context, input, customer, canonical);
    }
    if (action === 'repair') {
      if (custody !== 'quarantined' || context.is_org_admin !== true) {
        return forbiddenDecision(db, context, input, label);
      }
      const canonical = canonicalCustodyCommand(command, action);
      validateTargetAssignment(db, context, canonical.assigned_to, canonical.team_id);
      return repairCustomerCustody(db, context, input, customer, canonical);
    }
    if (action === 'release' || action === 'transfer') {
      if (!canManageProfile(context, customer, custody)) {
        return forbiddenDecision(db, context, input, label);
      }
      const canonical = canonicalCustodyCommand(command, action);
      if (action === 'transfer') {
        validateTargetAssignment(db, context, canonical.assigned_to, canonical.team_id);
        return transferCustomerCustody(db, context, input, customer, canonical);
      }
      return releaseCustomerCustody(db, context, input, customer, canonical);
    }
    throw invalidMutation();
  }

  const closingTask = operation === 'task' && (
    command.action === 'complete' || command.action === 'cancel'
  );
  if (closingTask) {
    if (custody !== 'owned') return forbiddenDecision(db, context, input, label);
    return mutateTask(db, context, input, customer);
  }
  const teamCollaboration = (
    operation === 'task' ||
    operation === 'activity' ||
    (operation === 'archive' && command.artifact_type === 'note')
  );
  const allowed = teamCollaboration
    ? canWriteTeamActivity(context, customer, custody)
    : canManageProfile(context, customer, custody);
  if (!allowed) return forbiddenDecision(db, context, input, label);
  if (operation === 'opportunity') {
    return mutateOpportunity(db, context, input, customer);
  }
  if (operation === 'contact') {
    return mutateContact(db, context, input, customer);
  }
  if (operation === 'task') {
    return mutateTask(db, context, input, customer);
  }
  if (operation === 'archive') {
    return archiveCustomerKnowledge(db, context, input, customer);
  }
  if (operation === 'activity') {
    return recordCompatibilityActivity(db, context, input, customer);
  }
  const lifecyclePayload = operation === 'lifecycle'
    ? command
    : (
      operation === 'customer' && Object.hasOwn(command, 'transition')
        ? command.transition
        : null
    );
  if (
    lifecyclePayload &&
    !lifecycleDefinition(customer.stage) &&
    context.is_org_admin !== true
  ) return forbiddenDecision(db, context, input, label);
  const lifecycle = lifecyclePayload
    ? canonicalCustomerLifecycle(db, context, customer, lifecyclePayload)
    : null;
  if (operation === 'customer') {
    return updateCustomer(db, context, input, customer, input.command, lifecycle);
  }
  if (operation === 'lifecycle') {
    return updateCustomer(
      db,
      context,
      input,
      customer,
      Object.freeze({
        mode: 'update',
        customerId: customer.id,
        values: Object.freeze({})
      }),
      lifecycle
    );
  }
  return unsupportedDecision();
}

function isScopeFailure(error) {
  return error instanceof CrmScopeError || Boolean(
    error && typeof error.code === 'string' && error.code.startsWith('CRM_SCOPE_')
  );
}

function mapFailure(error) {
  if (error instanceof CrmMutationError) return error;
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (
    code === 'SQLITE_BUSY' ||
    code.startsWith('SQLITE_BUSY_') ||
    code === 'SQLITE_LOCKED' ||
    code.startsWith('SQLITE_LOCKED_')
  ) {
    return mutationError('CRM_STORAGE_BUSY');
  }
  return mutationError('CRM_MUTATION_FAILED');
}

function runCommand(db, operation, options) {
  const input = snapshotCall(operation, options);
  let outcome;
  try {
    const transaction = db.transaction(() => {
      let context;
      try {
        context = resolveCrmAccessContext(db, contextOptions(input));
      } catch (error) {
        if (isScopeFailure(error)) return notFoundDecision();
        throw error;
      }
      return authorizeCustomerCommand(db, context, input, operation);
    });
    outcome = transaction.immediate();
  } catch (error) {
    throw mapFailure(error);
  }

  if (outcome && outcome.error) throw outcome.error;
  return outcome;
}

function createOrUpdateCustomer(db, options) { return runCommand(db, 'customer', options); }
function transitionCustomerLifecycle(db, options) { return runCommand(db, 'lifecycle', options); }
function mutateCustomerCustody(db, options) { return runCommand(db, 'custody', options); }
function createOrUpdateOpportunity(db, options) { return runCommand(db, 'opportunity', options); }
function mutateCustomerContact(db, options) { return runCommand(db, 'contact', options); }
function mutateCrmTask(db, options) { return runCommand(db, 'task', options); }
function archiveCustomerResult(db, options) { return runCommand(db, 'archive', options); }
function recordCustomerActivity(db, options) { return runCommand(db, 'activity', options); }

module.exports = {
  CrmMutationError,
  createOrUpdateCustomer,
  transitionCustomerLifecycle,
  mutateCustomerCustody,
  createOrUpdateOpportunity,
  mutateCustomerContact,
  mutateCrmTask,
  archiveCustomerResult,
  recordCustomerActivity
};
