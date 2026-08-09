'use strict';

const { types } = require('node:util');

const {
  CrmScopeError,
  resolveCrmAccessContext
} = require('./crm_scope_service');

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]+$/;
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
  return new CrmMutationError(
    code,
    definition.status,
    definition.title,
    details === undefined ? null : details,
    definition.retryable === true
  );
}

function invalidMutation() {
  return mutationError('CRM_MUTATION_INVALID');
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
    JOIN team_memberships tm
      ON tm.org_id=om.org_id
     AND tm.user_id=om.user_id
    JOIN teams t
      ON t.org_id=tm.org_id
     AND t.id=tm.team_id
    WHERE om.org_id=?
      AND om.user_id=?
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

function writeDeniedAudit(db, context, input, operation) {
  db.prepare(`
    INSERT INTO crm_audit_events (
      org_id,actor_user_id,event_type,request_id,correlation_id,metadata_json
    ) VALUES (?,?,'mutation_denied',?,?,?)
  `).run(
    context.organization.id,
    input.actorUserId,
    input.requestId,
    input.correlationId,
    JSON.stringify({ operation, outcome: 'forbidden' })
  );
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
  return unsupportedDecision();
}

function authorizeCustomerCommand(db, context, input, operation) {
  const command = input.command;
  const label = operationLabel(operation, command);

  if (operation === 'customer' && command.mode === 'create') {
    return authorizeCreate(db, context, input);
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
