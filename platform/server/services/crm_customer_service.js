'use strict';

const { types } = require('node:util');

const {
  CrmScopeError,
  resolveCrmAccessContext,
  CUSTOMER_CUSTODY_CASE_SQL
} = require('./crm_scope_service');
const {
  CUSTOMER_LIFECYCLE_REGISTRY,
  CrmContractError,
  assertCustomerLifecycle,
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

function writeAuditEvent(db, context, input, eventType, customerId, metadata) {
  const metadataJson = JSON.stringify(metadata);
  if (Buffer.byteLength(metadataJson, 'utf8') > 8192) throw mutationError('CRM_MUTATION_FAILED');
  db.prepare(`
    INSERT INTO crm_audit_events (
      org_id,customer_id,actor_user_id,event_type,request_id,correlation_id,metadata_json
    ) VALUES (?,?,?,?,?,?,?)
  `).run(
    context.organization.id,
    customerId,
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
      if (custody !== 'public') return forbiddenDecision(db, context, input, label);
      validateTargetAssignment(db, context, context.actor_user_id, command.team_id);
      if (!context.team_ids.includes(command.team_id)) return forbiddenDecision(db, context, input, label);
      return unsupportedDecision();
    }
    if (action === 'repair') {
      if (custody !== 'quarantined' || context.is_org_admin !== true) {
        return forbiddenDecision(db, context, input, label);
      }
      validateTargetAssignment(db, context, command.assigned_to, command.team_id);
      return unsupportedDecision();
    }
    if (action === 'release' || action === 'transfer') {
      if (!canManageProfile(context, customer, custody)) {
        return forbiddenDecision(db, context, input, label);
      }
      if (action === 'transfer') {
        validateTargetAssignment(db, context, command.assigned_to, command.team_id);
      }
      return unsupportedDecision();
    }
    throw invalidMutation();
  }

  const teamActivity = operation === 'task' || operation === 'activity';
  const allowed = teamActivity
    ? canWriteTeamActivity(context, customer, custody)
    : canManageProfile(context, customer, custody);
  if (!allowed) return forbiddenDecision(db, context, input, label);
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
  if (error && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')) {
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
