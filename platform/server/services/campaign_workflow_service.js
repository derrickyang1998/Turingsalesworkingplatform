const crypto = require('node:crypto');
const idempotency = require('./idempotency_service');
const { resolveOrganizationScope } = require('./organization_access_service');
const {
  getCampaignAccess,
  serializeEventMetadata
} = require('./campaign_access_service');
const knowledgeService = require('./knowledge_service');
const { canonicalJsonBytes, requestHash } = require('./sqlite_digest_service');

const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
const NODE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const LIFECYCLE_STATES = Object.freeze([
  'lead', 'qualified', 'demand_confirmed', 'proposal_draft', 'proposal_confirmed',
  'influencer_shortlist', 'ordered', 'executing', 'published', 'settled', 'reviewed'
]);
const NODE_TYPES = new Set(['start', 'end', 'approval', 'task', 'condition']);
const ROLES = new Set(['platform_admin', 'org_admin', 'team_lead', 'member']);
const COMPARISON_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']);
const ROOT_VARIABLES = new Set([
  'campaign.id', 'campaign.lifecycle_state', 'campaign.operational_status',
  'event.event_type', 'event.previous_state', 'event.next_state', 'task.action'
]);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const CAMPAIGN_TEMPLATE_CREATE_FIELDS = new Set([
  'name', 'description', 'module', 'category', 'nodes', 'edges'
]);
const CAMPAIGN_TEMPLATE_GRAPH_FIELDS = new Set([
  'expected_version', 'name', 'description', 'module', 'category', 'nodes', 'edges'
]);
const CAMPAIGN_WORKFLOW_LEASE_SECONDS = 60;
const CAMPAIGN_WORKFLOW_HEARTBEAT_SECONDS = 20;
const CAMPAIGN_WORKFLOW_HEARTBEAT_MS = 20_000;
const CAMPAIGN_WORKFLOW_DRAIN_MS = 30_000;
const CAMPAIGN_WORKFLOW_MAX_DRAIN = 100;
const CAMPAIGN_WORKFLOW_AUDIT_MAX_BYTES = 8 * 1024;
const CAMPAIGN_WORKFLOW_DISPATCHERS = new WeakMap();
const RETRYABLE_DISPATCH_STATUSES = new Set([
  'failed_initialization', 'dead_letter'
]);
const WORKFLOW_INITIALIZATION_FAILURE = Object.freeze({
  code: 'WORKFLOW_INITIALIZATION_FAILED',
  message: 'Workflow initialization failed'
});

class CampaignWorkflowServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'CampaignWorkflowServiceError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

class CampaignWorkflowValidationError extends Error {
  constructor(message, reason = validationReason(message)) {
    super(message);
    this.name = 'CampaignWorkflowValidationError';
    this.code = 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE';
    this.reason = reason;
  }
}

class CampaignWorkflowInitializationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CampaignWorkflowInitializationError';
    this.code = code;
  }
}

class CampaignWorkflowFenceLostError extends Error {
  constructor() {
    super('Campaign workflow worker fence was lost');
    this.name = 'CampaignWorkflowFenceLostError';
  }
}

function validationReason(message) {
  const value = String(message || '').toLowerCase();
  if (value.includes('trigger')) return 'TRIGGER_INVALID';
  if (value.includes('condition')) return 'CONDITION_INVALID';
  if (value.includes('edge') || value.includes('outcome') || value.includes('priority')) {
    return 'EDGE_INVALID';
  }
  if (
    value.includes('node') || value.includes('assignee') ||
    value.includes('layout') || value.includes('label')
  ) {
    return 'NODE_INVALID';
  }
  return 'GRAPH_INVALID';
}

function invalid(message) {
  throw new CampaignWorkflowValidationError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function workflowServiceError(statusCode, code, message, details) {
  return new CampaignWorkflowServiceError(statusCode, code, message, details);
}

function invalidCampaignInput(message = 'Campaign workflow input is invalid.') {
  return workflowServiceError(400, 'INVALID_CAMPAIGN_INPUT', message);
}

function positiveSafeId(value, label) {
  const number = typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw invalidCampaignInput(`${label} is invalid.`);
  }
  return number;
}

function positiveSafeJsonNumber(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalidCampaignInput(`${label} is invalid.`);
  }
  return value;
}

function exactBodyKeys(body, required, allowed = required) {
  if (!isPlainObject(body)) throw invalidCampaignInput();
  const actual = Object.keys(body);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(body, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw invalidCampaignInput();
  }
}

function hasDisallowedTextControls(value) {
  return /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value);
}

function campaignText(value, label, { required = false, defaultValue = '' } = {}) {
  if (value === undefined) {
    if (required) throw invalidCampaignInput(`${label} is required.`);
    return defaultValue;
  }
  if (typeof value !== 'string' || !hasOnlyUnicodeScalars(value)) {
    throw invalidCampaignInput(`${label} is invalid.`);
  }
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (hasDisallowedTextControls(normalized)) throw invalidCampaignInput(`${label} is invalid.`);
  if (required && normalized.length === 0) throw invalidCampaignInput(`${label} is required.`);
  if (Array.from(normalized).length > 1000) throw invalidCampaignInput(`${label} is too long.`);
  return normalized;
}

function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw workflowServiceError(
      400,
      'IDEMPOTENCY_REQUIRED',
      'Idempotency-Key is required.'
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw invalidCampaignInput('Idempotency-Key is invalid.');
  }
  return value;
}

function requirePlatformAdmin(db, userId) {
  const id = positiveSafeId(userId, 'user_id');
  const user = db.prepare(`
    SELECT id
    FROM users
    WHERE id=? AND is_active=1 AND role='admin'
  `).get(id);
  if (!user) {
    throw workflowServiceError(
      403,
      'RECORD_FORBIDDEN',
      'Campaign workflow template access is forbidden.'
    );
  }
  const scope = resolveOrganizationScope(db, {
    userId: id,
    repairMissing: false
  });
  if (!scope.ok) {
    throw workflowServiceError(
      403,
      'RECORD_FORBIDDEN',
      'Campaign workflow template access is forbidden.'
    );
  }
  return {
    userId: id,
    organizationId: scope.authContext.organization.id
  };
}

function workflowTemplateNotFound() {
  return workflowServiceError(
    404,
    'WORKFLOW_TEMPLATE_NOT_FOUND',
    'Workflow template was not found.'
  );
}

function campaignTemplateRequired() {
  return workflowServiceError(
    409,
    'CAMPAIGN_TEMPLATE_REQUIRED',
    'A campaign workflow template is required.'
  );
}

function staleWorkflowTemplate(currentVersion) {
  return workflowServiceError(
    409,
    'STALE_WORKFLOW_TEMPLATE_VERSION',
    'Workflow template version is stale.',
    { current_version: currentVersion }
  );
}

function invalidTemplateError(error) {
  const reason = error instanceof CampaignWorkflowValidationError
    ? error.reason
    : 'WORKFLOW_DOCUMENT_INVALID';
  return workflowServiceError(
    409,
    'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE',
    'Campaign workflow template is invalid.',
    { reason }
  );
}

function exactKeys(value, expected, context) {
  if (!isPlainObject(value)) invalid(`${context} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${context} has unknown or missing keys`);
  }
}

function allowedKeys(value, allowed, context) {
  if (!isPlainObject(value)) invalid(`${context} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${context} has unknown key ${key}`);
  }
}

function hasOnlyUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalString(value, context, minimum, maximum) {
  if (typeof value !== 'string' || !hasOnlyUnicodeScalars(value)) invalid(`${context} must be a Unicode scalar string`);
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n');
  if (normalized !== value) invalid(`${context} must be NFC with LF line endings`);
  const scalarLength = Array.from(value).length;
  if (scalarLength < minimum || scalarLength > maximum) invalid(`${context} has invalid length`);
  return value;
}

function safeInteger(value, context, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${context} must be a safe integer`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function finiteLayout(value, context, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${context} must be a finite in-range number`);
  }
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value)) output[key] = clone(value[key]);
    return output;
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isAdjacentLifecycleTransition(previousState, nextState) {
  const previousIndex = LIFECYCLE_STATES.indexOf(previousState);
  return previousIndex >= 0 && LIFECYCLE_STATES[previousIndex + 1] === nextState;
}

function validateTrigger(trigger) {
  exactKeys(trigger, ['event_type', 'previous_state', 'next_state'], 'trigger');
  if (trigger.event_type !== 'lifecycle_transition') invalid('trigger event_type must be lifecycle_transition');
  canonicalString(trigger.previous_state, 'trigger.previous_state', 1, 80);
  canonicalString(trigger.next_state, 'trigger.next_state', 1, 80);
  if (!isAdjacentLifecycleTransition(trigger.previous_state, trigger.next_state)) invalid('trigger lifecycle states must be adjacent');
  return { event_type: trigger.event_type, previous_state: trigger.previous_state, next_state: trigger.next_state };
}

function validateAssigneeConfig(config, nodeType) {
  exactKeys(config, ['title', 'description', 'assignee_id', 'assignee_role', 'due_hours'], `${nodeType}.config`);
  canonicalString(config.title, `${nodeType}.config.title`, 1, 160);
  canonicalString(config.description, `${nodeType}.config.description`, 0, 1000);
  if (config.assignee_id !== null) safeInteger(config.assignee_id, `${nodeType}.config.assignee_id`, 1, MAX_SAFE_ID);
  if (config.assignee_role !== null && !ROLES.has(config.assignee_role)) invalid(`${nodeType}.config.assignee_role is invalid`);
  if (config.due_hours !== null) safeInteger(config.due_hours, `${nodeType}.config.due_hours`, 1, 8760);
  if (config.assignee_id === null && config.assignee_role === null) invalid(`${nodeType}.config requires an assignee`);
  return clone(config);
}

function validateNode(node, index, allowLayout) {
  const context = `nodes[${index}]`;
  if (allowLayout) {
    allowedKeys(node, new Set(['id', 'type', 'label', 'config', 'x', 'y', 'width', 'height']), context);
    for (const key of ['id', 'type', 'label', 'config']) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) invalid(`${context} is missing ${key}`);
    }
  } else {
    exactKeys(node, ['id', 'type', 'label', 'config'], context);
  }
  canonicalString(node.id, `${context}.id`, 1, 80);
  if (!NODE_ID_PATTERN.test(node.id)) invalid(`${context}.id is invalid`);
  if (!NODE_TYPES.has(node.type)) invalid(`${context}.type is unsupported`);
  canonicalString(node.label, `${context}.label`, 1, 160);
  if (allowLayout) {
    if (Object.prototype.hasOwnProperty.call(node, 'x')) finiteLayout(node.x, `${context}.x`, -100000, 100000);
    if (Object.prototype.hasOwnProperty.call(node, 'y')) finiteLayout(node.y, `${context}.y`, -100000, 100000);
    if (Object.prototype.hasOwnProperty.call(node, 'width')) finiteLayout(node.width, `${context}.width`, 1, 100000);
    if (Object.prototype.hasOwnProperty.call(node, 'height')) finiteLayout(node.height, `${context}.height`, 1, 100000);
  }

  let config;
  if (node.type === 'approval' || node.type === 'task') config = validateAssigneeConfig(node.config, node.type);
  else {
    exactKeys(node.config, [], `${context}.config`);
    config = {};
  }
  return { id: node.id, type: node.type, label: node.label, config };
}

function validateScalar(value, context) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return safeInteger(value, context, -MAX_SAFE_ID, MAX_SAFE_ID);
  if (typeof value === 'string') return canonicalString(value, context, 0, 160);
  invalid(`${context} must be a scalar literal`);
}

function validateOperand(value, context, allowArray) {
  if (isPlainObject(value)) {
    exactKeys(value, ['var'], context);
    if (!ROOT_VARIABLES.has(value.var)) invalid(`${context} has unsupported variable`);
    return { var: value.var };
  }
  if (Array.isArray(value)) {
    if (!allowArray || value.length > 20) invalid(`${context} has invalid array operand`);
    let type = null;
    const output = value.map((item, index) => {
      const scalar = validateScalar(item, `${context}[${index}]`);
      const scalarType = scalar === null ? 'null' : typeof scalar;
      if (type === null) type = scalarType;
      else if (type !== scalarType) invalid(`${context} array types must match`);
      return scalar;
    });
    return output;
  }
  return validateScalar(value, context);
}

function validateConditionExpression(expression, state) {
  const tracker = state || { count: 0, depth: 0 };
  tracker.count += 1;
  if (tracker.count > 100) invalid('condition has too many expression nodes');
  tracker.depth += 1;
  if (tracker.depth > 8) invalid('condition exceeds maximum depth');
  if (!isPlainObject(expression) || typeof expression.op !== 'string') invalid('condition must be a closed expression');
  let output;
  if (COMPARISON_OPERATORS.has(expression.op)) {
    exactKeys(expression, ['op', 'left', 'right'], 'condition comparison');
    const left = validateOperand(expression.left, 'condition.left', false);
    const right = validateOperand(expression.right, 'condition.right', expression.op === 'in');
    if (expression.op === 'in' && !Array.isArray(right)) invalid('condition in requires an array right operand');
    if (expression.op !== 'in' && Array.isArray(right)) invalid('condition array operand is only valid for in');
    output = { op: expression.op, left, right };
  } else if (expression.op === 'and' || expression.op === 'or') {
    exactKeys(expression, ['op', 'args'], 'condition boolean expression');
    if (!Array.isArray(expression.args) || expression.args.length < 2 || expression.args.length > 10) {
      invalid('condition boolean args must contain 2 to 10 expressions');
    }
    output = { op: expression.op, args: expression.args.map((item) => validateConditionExpression(item, tracker)) };
  } else if (expression.op === 'not') {
    exactKeys(expression, ['op', 'arg'], 'condition not expression');
    output = { op: 'not', arg: validateConditionExpression(expression.arg, tracker) };
  } else {
    invalid('condition has unsupported operator');
  }
  tracker.depth -= 1;
  return output;
}

function validateEdge(edge, index) {
  const context = `edges[${index}]`;
  exactKeys(edge, ['id', 'from', 'to', 'outcome', 'priority', 'condition'], context);
  for (const key of ['id', 'from', 'to', 'outcome']) {
    canonicalString(edge[key], `${context}.${key}`, 1, key === 'outcome' ? 32 : 80);
  }
  if (!NODE_ID_PATTERN.test(edge.id) || !NODE_ID_PATTERN.test(edge.from) || !NODE_ID_PATTERN.test(edge.to)) invalid(`${context} has invalid id`);
  const priority = safeInteger(edge.priority, `${context}.priority`, 0, 1000000);
  const condition = edge.condition === null ? null : validateConditionExpression(edge.condition);
  if (edge.outcome === 'match' && condition === null) invalid(`${context}.match requires condition`);
  if (edge.outcome !== 'match' && condition !== null) invalid(`${context}.condition is only valid for match`);
  return { id: edge.id, from: edge.from, to: edge.to, outcome: edge.outcome, priority, condition };
}

function validateGraph(nodes, edges) {
  const byId = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) invalid('node ids must be unique');
    byId.set(node.id, node);
  }
  const starts = nodes.filter((node) => node.type === 'start');
  if (starts.length !== 1) invalid('workflow must contain one start node');
  const bySource = new Map(nodes.map((node) => [node.id, []]));
  const edgeIds = new Set();
  const priorities = new Set();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) invalid('edge ids must be unique');
    edgeIds.add(edge.id);
    if (!byId.has(edge.from) || !byId.has(edge.to)) invalid('edge endpoint must resolve to a node');
    const priorityKey = `${edge.from}\u0000${edge.priority}`;
    if (priorities.has(priorityKey)) invalid('edge priorities must be unique per source');
    priorities.add(priorityKey);
    bySource.get(edge.from).push(edge);
  }

  for (const node of nodes) {
    const outgoing = bySource.get(node.id);
    const outcomes = outgoing.map((edge) => edge.outcome);
    if (node.type === 'start') {
      if (outgoing.length !== 1 || outcomes[0] !== 'next') invalid('start requires exactly one next edge');
    } else if (node.type === 'task') {
      if (outgoing.length !== 1 || outcomes[0] !== 'complete') invalid('task requires exactly one complete edge');
    } else if (node.type === 'approval') {
      if (outgoing.length !== 2 || new Set(outcomes).size !== 2 || !outcomes.includes('approve') || !outcomes.includes('reject')) {
        invalid('approval requires exactly one approve and reject edge');
      }
    } else if (node.type === 'condition') {
      const matches = outgoing.filter((edge) => edge.outcome === 'match');
      const fallbacks = outgoing.filter((edge) => edge.outcome === 'fallback');
      if (matches.length < 1 || fallbacks.length !== 1 || outgoing.length !== matches.length + 1) {
        invalid('condition requires match edges and exactly one fallback edge');
      }
      if (matches.some((edge) => fallbacks[0].priority <= edge.priority)) {
        invalid('condition fallback priority must be greater than every match priority');
      }
    } else if (outgoing.length !== 0) {
      invalid('end may not have outgoing edges');
    }
  }

  const reachable = new Set();
  const queue = [starts[0].id];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex];
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of bySource.get(current)) queue.push(edge.to);
  }
  if (reachable.size !== nodes.length) invalid('all nodes must be reachable from start');

  const automaticTypes = new Set(['start', 'condition']);
  const colors = new Map();
  const longestRuns = new Map();

  for (const node of nodes) {
    if (!automaticTypes.has(node.type) || colors.get(node.id) === 2) continue;
    colors.set(node.id, 1);
    const stack = [{ nodeId: node.id, edgeIndex: 0, longest: 1 }];

    while (stack.length) {
      const frame = stack[stack.length - 1];
      const outgoing = bySource.get(frame.nodeId);
      let descended = false;

      while (frame.edgeIndex < outgoing.length) {
        const edge = outgoing[frame.edgeIndex];
        frame.edgeIndex += 1;
        const target = byId.get(edge.to);
        if (!automaticTypes.has(target.type)) continue;

        const targetColor = colors.get(target.id) || 0;
        if (targetColor === 1) invalid('workflow contains a pure automatic cycle');
        if (targetColor === 2) {
          frame.longest = Math.max(frame.longest, 1 + longestRuns.get(target.id));
          if (frame.longest > 100) invalid('workflow exceeds 100 automatic nodes before a boundary');
          continue;
        }
        if (stack.length >= 100) invalid('workflow exceeds 100 automatic nodes before a boundary');

        colors.set(target.id, 1);
        stack.push({ nodeId: target.id, edgeIndex: 0, longest: 1 });
        descended = true;
        break;
      }

      if (descended) continue;
      colors.set(frame.nodeId, 2);
      longestRuns.set(frame.nodeId, frame.longest);
      stack.pop();
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.longest = Math.max(parent.longest, 1 + frame.longest);
        if (parent.longest > 100) invalid('workflow exceeds 100 automatic nodes before a boundary');
      }
    }
  }
}

function normalizeCampaignWorkflow(input, allowLayout) {
  exactKeys(input, ['snapshot_version', 'template_id', 'template_version', 'module', 'trigger', 'nodes', 'edges'], 'workflow snapshot');
  if (input.snapshot_version !== 1) invalid('snapshot_version must be 1');
  safeInteger(input.template_id, 'template_id', 1, MAX_SAFE_ID);
  safeInteger(input.template_version, 'template_version', 1, MAX_SAFE_ID);
  if (input.module !== 'campaign') invalid('module must be campaign');
  const trigger = validateTrigger(input.trigger);
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) invalid('nodes must be a nonempty array');
  if (!Array.isArray(input.edges)) invalid('edges must be an array');
  const nodes = input.nodes.map((node, index) => validateNode(node, index, allowLayout));
  const edges = input.edges.map(validateEdge);
  validateGraph(nodes, edges);
  nodes.sort((left, right) => utf8Compare(left.id, right.id));
  edges.sort((left, right) => (
    utf8Compare(left.from, right.from) || left.priority - right.priority || utf8Compare(left.outcome, right.outcome) || utf8Compare(left.to, right.to) || utf8Compare(left.id, right.id)
  ));
  return deepFreeze({
    snapshot_version: 1,
    template_id: input.template_id,
    template_version: input.template_version,
    module: 'campaign',
    trigger,
    nodes,
    edges
  });
}

function validateCampaignWorkflowSnapshot(input) {
  return normalizeCampaignWorkflow(input, false);
}

function buildCampaignWorkflowSnapshot(input) {
  return normalizeCampaignWorkflow(input, true);
}

function frame32(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

function checksumCampaignWorkflowSnapshot(input) {
  const snapshot = validateCampaignWorkflowSnapshot(input);
  const canonicalBytes = canonicalJsonBytes(snapshot);
  return crypto.createHash('sha256').update(Buffer.concat([
    frame32(Buffer.from('tm-workflow-snapshot-v1', 'utf8')),
    frame32(canonicalBytes)
  ])).digest('hex');
}

function resolveVariable(variable, context) {
  if (!isPlainObject(context)) invalid('condition context must be an object');
  const [root, field] = variable.split('.');
  const rootValue = context[root];
  if (!isPlainObject(rootValue) || !Object.prototype.hasOwnProperty.call(rootValue, field)) {
    invalid(`condition context is missing ${variable}`);
  }
  const value = rootValue[field];
  if (variable === 'task.action' && value !== null && !['approve', 'reject', 'complete'].includes(value)) {
    invalid('condition task.action is invalid');
  }
  return validateScalar(value, `condition context ${variable}`);
}

function evaluateOperand(operand, context) {
  return isPlainObject(operand) && Object.prototype.hasOwnProperty.call(operand, 'var')
    ? resolveVariable(operand.var, context)
    : operand;
}

function sameScalarType(left, right) {
  return (left === null ? 'null' : typeof left) === (right === null ? 'null' : typeof right);
}

function strictScalarEqual(left, right) {
  return sameScalarType(left, right) && Object.is(left, right);
}

function evaluateNormalizedCondition(expression, context) {
  if (expression.op === 'and') return expression.args.every((item) => evaluateNormalizedCondition(item, context));
  if (expression.op === 'or') return expression.args.some((item) => evaluateNormalizedCondition(item, context));
  if (expression.op === 'not') return !evaluateNormalizedCondition(expression.arg, context);
  const left = evaluateOperand(expression.left, context);
  const right = evaluateOperand(expression.right, context);
  if (expression.op === 'in') return right.some((item) => strictScalarEqual(left, item));
  if (expression.op === 'eq') return strictScalarEqual(left, right);
  if (expression.op === 'neq') return !strictScalarEqual(left, right);
  if (!sameScalarType(left, right)) return false;
  if (typeof left !== 'number') return false;
  if (expression.op === 'gt') return left > right;
  if (expression.op === 'gte') return left >= right;
  if (expression.op === 'lt') return left < right;
  return left <= right;
}

function evaluateCampaignWorkflowCondition(expression, context) {
  return evaluateNormalizedCondition(validateConditionExpression(expression), context);
}

function templateErrorBody(error, requestId) {
  const body = {
    error: error.message,
    code: error.code,
    request_id: requestId || 'workflow-template-request'
  };
  if (error.details !== undefined) body.details = error.details;
  return body;
}

function templateIdempotencyDisposition(result) {
  if (result.state === 'replay') {
    return {
      status: result.statusCode,
      body: result.responseBody,
      headers: result.responseHeaders || {}
    };
  }
  if (result.state === 'conflict') {
    throw workflowServiceError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'The idempotency key was already used for a different request.'
    );
  }
  if (result.state === 'processing') {
    const error = workflowServiceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'The idempotent request is still processing.'
    );
    error.retryAfterSeconds = Math.max(1, result.retryAfterSeconds || 1);
    throw error;
  }
  if (result.state === 'expired') {
    throw workflowServiceError(
      410,
      'IDEMPOTENCY_EXPIRED',
      'The retained idempotent response expired.'
    );
  }
  return null;
}

function runCampaignTemplateMutation(db, input, operation) {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const authorization = requirePlatformAdmin(db, input.userId);
  const hash = requestHash({
    method: input.method,
    path: input.path,
    campaignId: null,
    kind: 'json',
    payload: input.body
  });
  const reservationInput = {
    organizationId: authorization.organizationId,
    actorUserId: authorization.userId,
    campaignId: null,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: input.scope,
    key,
    requestHash: hash,
    expectedEventCount: 0,
    operationTimeoutSeconds: 60
  };
  idempotency.inspectRetained(db, reservationInput);

  return db.transaction(() => {
    const lockedAuthorization = requirePlatformAdmin(db, input.userId);
    if (lockedAuthorization.organizationId !== authorization.organizationId) {
      throw workflowServiceError(
        403,
        'RECORD_FORBIDDEN',
        'Campaign workflow template access is forbidden.'
      );
    }
    let reservation = idempotency.recoverExpiredInTransaction(db, reservationInput);
    if (reservation.state === 'absent') {
      reservation = idempotency.reserveProcessingInTransaction(db, reservationInput);
    }
    if (reservation.state !== 'reserved') {
      return templateIdempotencyDisposition(reservation);
    }

    db.exec('SAVEPOINT campaign_workflow_template_operation');
    try {
      const outcome = operation({
        userId: authorization.userId,
        organizationId: authorization.organizationId
      });
      db.exec('RELEASE SAVEPOINT campaign_workflow_template_operation');
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: outcome.status,
        responseBody: outcome.body
      });
      return { status: outcome.status, body: outcome.body, headers: {} };
    } catch (error) {
      if (!(error instanceof CampaignWorkflowServiceError)) throw error;
      db.exec('ROLLBACK TO SAVEPOINT campaign_workflow_template_operation');
      db.exec('RELEASE SAVEPOINT campaign_workflow_template_operation');
      const body = templateErrorBody(error, input.requestId);
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: error.statusCode,
        responseBody: body
      });
      return { status: error.statusCode, body, headers: {} };
    }
  }).immediate();
}

function normalizeCampaignTemplateCreateBody(body) {
  exactBodyKeys(body, ['name', 'module'], CAMPAIGN_TEMPLATE_CREATE_FIELDS);
  if (body.module !== 'campaign') throw invalidCampaignInput('module must be campaign.');
  if (body.nodes !== undefined && !Array.isArray(body.nodes)) throw invalidCampaignInput('nodes is invalid.');
  if (body.edges !== undefined && !Array.isArray(body.edges)) throw invalidCampaignInput('edges is invalid.');
  return {
    name: campaignText(body.name, 'name', { required: true }),
    description: campaignText(body.description, 'description'),
    module: 'campaign',
    category: campaignText(body.category, 'category', { defaultValue: 'approval' }),
    nodes: clone(body.nodes || []),
    edges: clone(body.edges || [])
  };
}

function normalizeCampaignTemplateGraphBody(body) {
  exactBodyKeys(body, ['expected_version'], CAMPAIGN_TEMPLATE_GRAPH_FIELDS);
  const output = {
    expected_version: positiveSafeId(body.expected_version, 'expected_version')
  };
  for (const key of ['name', 'description', 'module', 'category', 'nodes', 'edges']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) output[key] = clone(body[key]);
  }
  if (Object.hasOwn(output, 'name')) output.name = campaignText(output.name, 'name', { required: true });
  if (Object.hasOwn(output, 'description')) output.description = campaignText(output.description, 'description');
  if (Object.hasOwn(output, 'category')) output.category = campaignText(output.category, 'category');
  if (Object.hasOwn(output, 'module') && typeof output.module !== 'string') {
    throw invalidCampaignInput('module is invalid.');
  }
  if (Object.hasOwn(output, 'nodes') && !Array.isArray(output.nodes)) throw invalidCampaignInput('nodes is invalid.');
  if (Object.hasOwn(output, 'edges') && !Array.isArray(output.edges)) throw invalidCampaignInput('edges is invalid.');
  return output;
}

function normalizeCampaignTemplateTriggerBody(body) {
  const keys = new Set([
    'expected_version', 'event_type', 'previous_state', 'next_state'
  ]);
  exactBodyKeys(body, [...keys], keys);
  const expectedVersion = positiveSafeId(body.expected_version, 'expected_version');
  let trigger;
  try {
    trigger = validateTrigger({
      event_type: body.event_type,
      previous_state: body.previous_state,
      next_state: body.next_state
    });
  } catch (error) {
    if (error instanceof CampaignWorkflowValidationError) {
      throw invalidCampaignInput('Campaign workflow trigger is invalid.');
    }
    throw error;
  }
  return { expected_version: expectedVersion, ...trigger };
}

function normalizeCampaignTemplatePublishBody(body) {
  const keys = new Set(['expected_version']);
  exactBodyKeys(body, ['expected_version'], keys);
  return { expected_version: positiveSafeId(body.expected_version, 'expected_version') };
}

function parseTemplateDocument(value, reason) {
  try {
    return JSON.parse(value);
  } catch {
    throw new CampaignWorkflowValidationError(
      'Stored campaign workflow document is invalid',
      reason
    );
  }
}

function buildSnapshotFromTemplate(template) {
  const trigger = template.trigger_config_json === null
    ? null
    : parseTemplateDocument(template.trigger_config_json, 'TRIGGER_INVALID');
  const nodes = parseTemplateDocument(template.nodes, 'NODE_INVALID');
  const edges = parseTemplateDocument(template.edges, 'EDGE_INVALID');
  return buildCampaignWorkflowSnapshot({
    snapshot_version: 1,
    template_id: template.id,
    template_version: template.version,
    module: template.module,
    trigger,
    nodes,
    edges
  });
}

function validateTemplateLabel(value) {
  try {
    const label = canonicalString(value, 'workflow template name', 1, 1000);
    if (label.trim().length === 0 || hasDisallowedTextControls(label)) {
      invalid('workflow template name is invalid');
    }
    return label;
  } catch (error) {
    if (error instanceof CampaignWorkflowValidationError) {
      throw new CampaignWorkflowValidationError(
        'Stored campaign workflow document is invalid',
        'WORKFLOW_DOCUMENT_INVALID'
      );
    }
    throw error;
  }
}

function normalizeWorkflowRetryBody(body) {
  const fields = new Set(['expected_status', 'reason']);
  exactBodyKeys(body, ['expected_status', 'reason'], fields);
  if (!RETRYABLE_DISPATCH_STATUSES.has(body.expected_status)) {
    throw invalidCampaignInput(
      'expected_status must be failed_initialization or dead_letter.'
    );
  }
  return {
    expected_status: body.expected_status,
    reason: campaignText(body.reason, 'reason', { required: true })
  };
}

function campaignWorkflowOperationalError(status) {
  return workflowServiceError(
    409,
    status === 'cancelled' ? 'CAMPAIGN_CANCELLED' : 'CAMPAIGN_ON_HOLD',
    status === 'cancelled' ? 'Campaign is cancelled.' : 'Campaign is on hold.',
    { operational_status: status }
  );
}

function requireWorkflowRecoveryAccess(db, userIdValue, campaignIdValue) {
  const userId = positiveSafeId(userIdValue, 'user_id');
  const campaignId = positiveSafeId(campaignIdValue, 'campaign_id');
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) {
    throw workflowServiceError(
      access.status,
      access.code,
      access.code === 'CAMPAIGN_NOT_FOUND'
        ? 'Campaign was not found.'
        : 'Campaign access is forbidden.'
    );
  }
  if (access.role !== 'owner' && access.role !== 'org_admin') {
    throw workflowServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  if (access.campaign.operational_status !== 'active') {
    throw campaignWorkflowOperationalError(access.campaign.operational_status);
  }
  return {
    userId,
    campaignId,
    organizationId: access.campaign.org_id
  };
}

function selectWorkflowDispatchSummaryRow(db, dispatchId) {
  return db.prepare(`
    SELECT
      dispatch.id,dispatch.event_id,dispatch.trigger_event_id,
      dispatch.template_id,dispatch.template_label,
      dispatch.template_version,dispatch.status,dispatch.attempt_count,
      dispatch.workflow_instance_id,instance.status AS instance_status,
      instance.initialization_status,
      instance.execution_error_code AS instance_error_code,
      instance.execution_error AS instance_error,
      dispatch.reconciles_dispatch_id,dispatch.next_attempt_at,
      dispatch.last_error_code,dispatch.last_error,
      dispatch.created_at,dispatch.updated_at
    FROM campaign_workflow_dispatches dispatch
    LEFT JOIN workflow_instances instance ON instance.id=dispatch.workflow_instance_id
    WHERE dispatch.id=?
  `).get(dispatchId);
}

function retryWorkflowDispatch(db, input) {
  const dispatchId = positiveSafeId(input.dispatchId, 'dispatch_id');
  const body = normalizeWorkflowRetryBody(input.body);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const authorization = requireWorkflowRecoveryAccess(
    db,
    input.userId,
    input.campaignId
  );
  const path = `/api/campaigns/${authorization.campaignId}` +
    `/workflow-dispatches/${dispatchId}/retry`;
  const hash = requestHash({
    method: 'POST',
    path,
    campaignId: authorization.campaignId,
    kind: 'json',
    payload: body
  });
  const reservationInput = {
    organizationId: authorization.organizationId,
    actorUserId: authorization.userId,
    campaignId: authorization.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: 'campaign.workflow.retry',
    key,
    requestHash: hash,
    expectedEventCount: 0,
    operationTimeoutSeconds: 60
  };
  idempotency.inspectRetained(db, reservationInput);

  return db.transaction(() => {
    const lockedAuthorization = requireWorkflowRecoveryAccess(
      db,
      input.userId,
      authorization.campaignId
    );
    if (lockedAuthorization.organizationId !== authorization.organizationId) {
      throw workflowServiceError(
        403,
        'CAMPAIGN_FORBIDDEN',
        'Campaign access is forbidden.'
      );
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
      return templateIdempotencyDisposition(reservation);
    }

    db.exec('SAVEPOINT campaign_workflow_retry_operation');
    try {
      const dispatch = db.prepare(`
        SELECT id,status,attempt_count
        FROM campaign_workflow_dispatches
        WHERE id=? AND org_id=? AND campaign_id=?
      `).get(
        dispatchId,
        authorization.organizationId,
        authorization.campaignId
      );
      if (
        !dispatch ||
        dispatch.status !== body.expected_status ||
        !RETRYABLE_DISPATCH_STATUSES.has(dispatch.status)
      ) {
        throw workflowServiceError(
          409,
          'DISPATCH_NOT_RETRYABLE',
          'Workflow dispatch is not retryable.'
        );
      }
      const reset = db.prepare(`
        UPDATE campaign_workflow_dispatches
        SET status='pending',attempt_count=0,lease_until=NULL,lease_token=NULL,
            next_attempt_at=NULL,last_error_code=NULL,last_error=NULL,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND org_id=? AND campaign_id=? AND status=?
          AND EXISTS (
            SELECT 1 FROM campaigns campaign
            WHERE campaign.org_id=campaign_workflow_dispatches.org_id
              AND campaign.id=campaign_workflow_dispatches.campaign_id
              AND campaign.operational_status='active'
          )
      `).run(
        dispatchId,
        authorization.organizationId,
        authorization.campaignId,
        body.expected_status
      );
      if (reset.changes !== 1) {
        throw workflowServiceError(
          409,
          'DISPATCH_NOT_RETRYABLE',
          'Workflow dispatch is not retryable.'
        );
      }
      const auditDetails = JSON.stringify({
        source: 'workflow_recovery',
        campaign_id: authorization.campaignId,
        dispatch_id: dispatchId,
        prior_status: dispatch.status,
        prior_attempt_count: dispatch.attempt_count,
        reason: body.reason
      });
      if (Buffer.byteLength(auditDetails, 'utf8') > CAMPAIGN_WORKFLOW_AUDIT_MAX_BYTES) {
        throw new Error('workflow retry audit details exceed storage bound');
      }
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details)
        VALUES (?,'retry_workflow_dispatch','workflow',?)
      `).run(authorization.userId, auditDetails);
      const summaryRow = selectWorkflowDispatchSummaryRow(db, dispatchId);
      const responseBody = { dispatch: workflowDispatchSummary(summaryRow) };
      db.exec('RELEASE SAVEPOINT campaign_workflow_retry_operation');
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: 202,
        responseBody
      });
      return { status: 202, body: responseBody, headers: {} };
    } catch (error) {
      if (!(error instanceof CampaignWorkflowServiceError)) throw error;
      db.exec('ROLLBACK TO SAVEPOINT campaign_workflow_retry_operation');
      db.exec('RELEASE SAVEPOINT campaign_workflow_retry_operation');
      const responseBody = templateErrorBody(error, input.requestId);
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: error.statusCode,
        responseBody
      });
      return {
        status: error.statusCode,
        body: responseBody,
        headers: {}
      };
    }
  }).immediate();
}

function campaignWorkflowNotFound() {
  return workflowServiceError(
    404,
    'CAMPAIGN_NOT_FOUND',
    'Campaign was not found.'
  );
}

function requireWorkflowReconciliationAccess(db, userIdValue, campaignIdValue) {
  const userId = positiveSafeId(userIdValue, 'user_id');
  const campaignId = positiveSafeId(campaignIdValue, 'campaign_id');
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) {
    throw workflowServiceError(
      access.status,
      access.code,
      access.code === 'CAMPAIGN_NOT_FOUND'
        ? 'Campaign was not found.'
        : 'Campaign access is forbidden.'
    );
  }
  if (access.role !== 'owner' && access.role !== 'org_admin') {
    throw workflowServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  return {
    userId,
    campaignId,
    organizationId: access.campaign.org_id,
    operationalStatus: access.campaign.operational_status
  };
}

function normalizeWorkflowReconciliationQuery(query) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw invalidCampaignInput();
  }
  const prototype = Object.getPrototypeOf(query);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidCampaignInput();
  }
  const keys = Object.keys(query);
  if (keys.length !== 1 || keys[0] !== 'dispatch_id') {
    throw invalidCampaignInput();
  }
  return {
    dispatchId: positiveSafeId(query.dispatch_id, 'dispatch_id')
  };
}

function normalizeWorkflowReconciliationBody(body) {
  const fields = new Set([
    'expected_dispatch_status',
    'expected_instance_status',
    'template_id',
    'expected_template_version',
    'reason'
  ]);
  exactBodyKeys(body, Array.from(fields), fields);
  const preInitialization = body.expected_dispatch_status === 'failed_validation' &&
    body.expected_instance_status === null;
  const postInitialization = body.expected_dispatch_status === 'completed' &&
    body.expected_instance_status === 'failed_validation';
  if (!preInitialization && !postInitialization) {
    throw invalidCampaignInput('Workflow reconciliation status pair is invalid.');
  }
  return {
    expected_dispatch_status: body.expected_dispatch_status,
    expected_instance_status: body.expected_instance_status,
    template_id: positiveSafeJsonNumber(body.template_id, 'template_id'),
    expected_template_version: positiveSafeJsonNumber(
      body.expected_template_version,
      'expected_template_version'
    ),
    reason: campaignText(body.reason, 'reason', { required: true })
  };
}

function selectWorkflowReconciliationDispatch(db, authorization, dispatchId) {
  return db.prepare(`
    SELECT
      dispatch.*,
      instance.status AS instance_status,
      instance.initialization_status,
      instance.campaign_dispatch_id AS instance_campaign_dispatch_id,
      instance.execution_error_code AS instance_error_code,
      instance.execution_error AS instance_error
    FROM campaign_workflow_dispatches dispatch
    LEFT JOIN workflow_instances instance
      ON instance.id=dispatch.workflow_instance_id
     AND instance.org_id=dispatch.org_id
     AND instance.campaign_id=dispatch.campaign_id
     AND instance.campaign_dispatch_id=dispatch.id
    WHERE dispatch.id=? AND dispatch.org_id=? AND dispatch.campaign_id=?
  `).get(
    dispatchId,
    authorization.organizationId,
    authorization.campaignId
  );
}

function requireWorkflowReconciliationDispatch(db, authorization, dispatchId) {
  const row = selectWorkflowReconciliationDispatch(db, authorization, dispatchId);
  if (!row) throw campaignWorkflowNotFound();
  return row;
}

function workflowReconciliationFailureShape(row) {
  if (
    row.status === 'failed_validation' &&
    row.workflow_instance_id === null
  ) {
    return Object.freeze({
      failureShape: 'pre_initialization',
      expectedDispatchStatus: 'failed_validation',
      expectedInstanceStatus: null
    });
  }
  if (
    row.status === 'completed' &&
    row.workflow_instance_id !== null &&
    row.instance_status === 'failed_validation' &&
    row.initialization_status === 'ready' &&
    row.instance_campaign_dispatch_id === row.id
  ) {
    return Object.freeze({
      failureShape: 'post_initialization',
      expectedDispatchStatus: 'completed',
      expectedInstanceStatus: 'failed_validation'
    });
  }
  return null;
}

function workflowReconciliationRequired(shape) {
  return {
    failure_shape: shape.failureShape,
    expected_dispatch_status: shape.expectedDispatchStatus,
    expected_instance_status: shape.expectedInstanceStatus
  };
}

function selectWorkflowRootTrigger(db, row) {
  return db.prepare(`
    SELECT event_type,previous_state,next_state
    FROM campaign_events
    WHERE id=? AND org_id=? AND campaign_id=?
  `).get(row.trigger_event_id, row.org_id, row.campaign_id);
}

function exactWorkflowTrigger(left, right) {
  return Boolean(left && right) &&
    left.event_type === right.event_type &&
    left.previous_state === right.previous_state &&
    left.next_state === right.next_state;
}

function buildWorkflowReconciliationTemplate(template, rootTrigger) {
  const label = validateTemplateLabel(template.name);
  const snapshot = buildSnapshotFromTemplate(template);
  if (!exactWorkflowTrigger(snapshot.trigger, rootTrigger)) {
    throw new CampaignWorkflowValidationError(
      'Campaign workflow root trigger does not match',
      'TRIGGER_INVALID'
    );
  }
  return {
    row: template,
    label,
    snapshot,
    snapshotJson: canonicalJsonBytes(snapshot).toString('utf8'),
    checksum: checksumCampaignWorkflowSnapshot(snapshot)
  };
}

function workflowReconciliationTemplates(db, row) {
  const rootTrigger = selectWorkflowRootTrigger(db, row);
  if (
    !rootTrigger ||
    rootTrigger.event_type !== 'lifecycle_transition' ||
    !isAdjacentLifecycleTransition(
      rootTrigger.previous_state,
      rootTrigger.next_state
    )
  ) {
    return [];
  }
  const candidates = [];
  const templates = db.prepare(`
    SELECT id,name,module,nodes,edges,version,trigger_config_json
    FROM workflow_templates
    WHERE module='campaign' AND is_active=1
    ORDER BY id
  `).all();
  for (const template of templates) {
    try {
      const selected = buildWorkflowReconciliationTemplate(template, rootTrigger);
      candidates.push({
        id: template.id,
        label: selected.label,
        version: template.version,
        published_checksum: selected.checksum,
        trigger: selected.snapshot.trigger
      });
    } catch (error) {
      if (
        error instanceof CampaignWorkflowValidationError ||
        error instanceof SyntaxError
      ) {
        continue;
      }
      throw error;
    }
  }
  candidates.sort((left, right) => (
    utf8Compare(left.label, right.label) || left.id - right.id
  ));
  return candidates;
}

function workflowReconciliationReplacement(db, dispatchId) {
  return db.prepare(`
    SELECT id
    FROM campaign_workflow_dispatches
    WHERE reconciles_dispatch_id=?
    LIMIT 1
  `).get(dispatchId);
}

function getWorkflowReconciliationOptions(db, input) {
  const query = normalizeWorkflowReconciliationQuery(input.query);
  const authorization = requireWorkflowReconciliationAccess(
    db,
    input.userId,
    input.campaignId
  );
  const dispatch = requireWorkflowReconciliationDispatch(
    db,
    authorization,
    query.dispatchId
  );
  const publicDispatch = workflowDispatchSummary(dispatch);
  if (
    authorization.operationalStatus === 'cancelled' ||
    authorization.operationalStatus === 'on_hold'
  ) {
    return {
      state: 'campaign_not_active',
      dispatch: publicDispatch,
      operational_status: authorization.operationalStatus
    };
  }
  const replacement = workflowReconciliationReplacement(db, dispatch.id);
  if (replacement) {
    return {
      state: 'already_reconciled',
      dispatch: publicDispatch,
      replacement_dispatch_id: replacement.id
    };
  }
  const shape = workflowReconciliationFailureShape(dispatch);
  if (!shape) {
    return {
      state: 'dispatch_not_reconcilable',
      dispatch: publicDispatch,
      dispatch_status: dispatch.status,
      instance_status: dispatch.workflow_instance_id === null
        ? null
        : dispatch.instance_status
    };
  }
  const required = workflowReconciliationRequired(shape);
  const templates = workflowReconciliationTemplates(db, dispatch);
  if (templates.length === 0) {
    return {
      state: 'no_matching_template',
      dispatch: publicDispatch,
      required,
      templates: []
    };
  }
  return {
    state: 'eligible',
    dispatch: publicDispatch,
    required,
    templates
  };
}

function invalidWorkflowReconciliationTemplate() {
  return workflowServiceError(
    409,
    'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE',
    'Campaign workflow template is invalid.'
  );
}

function requireWorkflowReconciliationTemplate(db, body, dispatch) {
  const template = db.prepare(`
    SELECT id,name,module,nodes,edges,version,trigger_config_json,is_active
    FROM workflow_templates
    WHERE id=?
  `).get(body.template_id);
  if (
    !template ||
    template.module !== 'campaign' ||
    template.is_active !== 1 ||
    template.version !== body.expected_template_version
  ) {
    throw invalidWorkflowReconciliationTemplate();
  }
  const rootTrigger = selectWorkflowRootTrigger(db, dispatch);
  if (
    !rootTrigger ||
    rootTrigger.event_type !== 'lifecycle_transition' ||
    !isAdjacentLifecycleTransition(
      rootTrigger.previous_state,
      rootTrigger.next_state
    )
  ) {
    throw invalidWorkflowReconciliationTemplate();
  }
  try {
    return buildWorkflowReconciliationTemplate(template, rootTrigger);
  } catch (error) {
    if (
      error instanceof CampaignWorkflowValidationError ||
      error instanceof SyntaxError
    ) {
      throw invalidWorkflowReconciliationTemplate();
    }
    throw error;
  }
}

function workflowReconciliationStateError() {
  return workflowServiceError(
    409,
    'DISPATCH_NOT_RECONCILABLE',
    'Workflow dispatch is not reconcilable.'
  );
}

function assertWorkflowReconciliationShape(dispatch, body) {
  const shape = workflowReconciliationFailureShape(dispatch);
  if (
    !shape ||
    shape.expectedDispatchStatus !== body.expected_dispatch_status ||
    shape.expectedInstanceStatus !== body.expected_instance_status
  ) {
    throw workflowReconciliationStateError();
  }
  return shape;
}

function preallocateWorkflowReconciliationDispatchId(db) {
  const row = db.prepare(`
    SELECT COALESCE(MAX(id),0)+1 AS replacement_id
    FROM campaign_workflow_dispatches
  `).get();
  const replacementId = row && row.replacement_id;
  if (
    !Number.isSafeInteger(replacementId) ||
    replacementId < 1 ||
    replacementId > MAX_SAFE_ID ||
    db.prepare('SELECT 1 FROM campaign_workflow_dispatches WHERE id=?').get(
      replacementId
    )
  ) {
    throw new Error('campaign workflow replacement identifier is unavailable');
  }
  return replacementId;
}

function workflowEventProjection(db, eventId) {
  const row = db.prepare(`
    SELECT event.*,actor.display_name AS actor_name,
           actor.username AS actor_username
    FROM campaign_events event
    LEFT JOIN users actor ON actor.id=event.actor_user_id
    WHERE event.id=?
  `).get(eventId);
  if (!row) throw new Error('campaign workflow reconciliation event disappeared');
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
    metadata: serializeEventMetadata(
      row.event_type,
      JSON.parse(row.metadata_json)
    ),
    correlation_id: row.correlation_id,
    created_at: row.created_at
  };
}

function insertWorkflowReconciliationEvent(db, input) {
  const metadataJson = canonicalJsonBytes(input.metadata).toString('utf8');
  const result = db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (
      ?,?,'workflow_reconciliation',NULL,NULL,?,
      ?,'workflow_recovery',?,?,?
    )
  `).run(
    input.organizationId,
    input.campaignId,
    input.userId,
    input.reason,
    metadataJson,
    input.requestId,
    input.auditFingerprint
  );
  const eventId = Number(result.lastInsertRowid);
  if (!Number.isSafeInteger(eventId) || eventId < 1) {
    throw new Error('campaign workflow reconciliation event identifier is invalid');
  }
  return {
    id: eventId,
    metadataJson,
    projection: workflowEventProjection(db, eventId)
  };
}

function insertWorkflowReconciliationDispatch(
  db,
  dispatch,
  eventId,
  replacementId,
  selected
) {
  db.prepare(`
    INSERT INTO campaign_workflow_dispatches (
      id,org_id,campaign_id,event_id,trigger_event_id,template_id,
      template_version,template_checksum,template_snapshot_json,
      execution_context_json,reconciles_dispatch_id,template_label
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    replacementId,
    dispatch.org_id,
    dispatch.campaign_id,
    eventId,
    dispatch.trigger_event_id,
    selected.row.id,
    selected.row.version,
    selected.checksum,
    selected.snapshotJson,
    dispatch.execution_context_json,
    dispatch.id,
    selected.label
  );
  const row = selectWorkflowDispatchSummaryRow(db, replacementId);
  if (!row) throw new Error('campaign workflow replacement dispatch disappeared');
  return row;
}

function applyWorkflowArchiveGaugePlan(db, archive) {
  return knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(
    db,
    archive && Array.isArray(archive.capacityGaugePlan)
      ? archive.capacityGaugePlan
      : []
  );
}

function archiveWorkflowReconciliation(db, input) {
  const summary = Array.from(input.metadataJson).slice(0, 1000).join('');
  const archive = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: input.organizationId,
    campaignId: input.campaignId,
    createdBy: input.userId,
    entryType: 'campaign_workflow',
    title: `Campaign workflow reconciliation #${input.replacementId}`,
    summary,
    content: input.metadataJson,
    sourceType: 'campaign_workflow_reconciliation',
    sourceId: String(input.eventId),
    visibility: 'team',
    tags: ['campaign', 'reconciliation', 'workflow'],
    metadata: {}
  });
  if (archive.status !== 'created') {
    throw new Error('campaign workflow reconciliation archive was not created');
  }
  insertCampaignRecordLink(db, {
    organizationId: input.organizationId,
    campaignId: input.campaignId,
    recordType: 'knowledge_entry',
    recordId: archive.entry.id,
    relationType: 'knowledge',
    createdBy: input.userId,
    metadata: {}
  });
  applyWorkflowArchiveGaugePlan(db, archive);
}

function workflowReconciliationErrorBody(error, requestId) {
  const body = {
    error: error.message,
    code: error.code,
    request_id: requestId || 'campaign-workflow-reconciliation'
  };
  if (error.details !== undefined) body.details = error.details;
  return body;
}

function asWorkflowReconciliationExpectedError(error) {
  if (error instanceof CampaignWorkflowServiceError) return error;
  if (error instanceof knowledgeService.CampaignKnowledgeCapacityError) {
    return workflowServiceError(
      507,
      'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED',
      error.message,
      error.details
    );
  }
  return null;
}

function reconcileWorkflowDispatch(db, input) {
  const dispatchId = positiveSafeId(input.dispatchId, 'dispatch_id');
  const body = normalizeWorkflowReconciliationBody(input.body);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const authorization = requireWorkflowReconciliationAccess(
    db,
    input.userId,
    input.campaignId
  );
  const path = `/api/campaigns/${authorization.campaignId}` +
    `/workflow-dispatches/${dispatchId}/reconcile`;
  const hash = requestHash({
    method: 'POST',
    path,
    campaignId: authorization.campaignId,
    kind: 'json',
    payload: body
  });
  const reservationInput = {
    organizationId: authorization.organizationId,
    actorUserId: authorization.userId,
    campaignId: authorization.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: 'campaign.workflow.reconcile',
    key,
    requestHash: hash,
    expectedEventCount: 1,
    operationTimeoutSeconds: 60
  };
  const retained = idempotency.inspectRetained(db, reservationInput);
  if (retained.state !== 'absent' && !retained.recoverable) {
    return templateIdempotencyDisposition(retained);
  }

  try {
    return db.transaction(() => {
      const lockedAuthorization = requireWorkflowReconciliationAccess(
        db,
        input.userId,
        authorization.campaignId
      );
      if (lockedAuthorization.organizationId !== authorization.organizationId) {
        throw workflowServiceError(
          403,
          'CAMPAIGN_FORBIDDEN',
          'Campaign access is forbidden.'
        );
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
        return templateIdempotencyDisposition(reservation);
      }

      db.exec('SAVEPOINT campaign_workflow_reconciliation_operation');
      try {
        const dispatch = requireWorkflowReconciliationDispatch(
          db,
          lockedAuthorization,
          dispatchId
        );
        if (
          lockedAuthorization.operationalStatus === 'cancelled' ||
          lockedAuthorization.operationalStatus === 'on_hold'
        ) {
          throw campaignWorkflowOperationalError(
            lockedAuthorization.operationalStatus
          );
        }
        const priorReplacement = workflowReconciliationReplacement(
          db,
          dispatch.id
        );
        if (priorReplacement) {
          throw workflowServiceError(
            409,
            'DISPATCH_ALREADY_RECONCILED',
            'Workflow dispatch was already reconciled.',
            { replacement_dispatch_id: priorReplacement.id }
          );
        }
        assertWorkflowReconciliationShape(dispatch, body);
        const selected = requireWorkflowReconciliationTemplate(
          db,
          body,
          dispatch
        );
        const replacementId = preallocateWorkflowReconciliationDispatchId(db);
        const metadata = {
          original_dispatch_id: dispatch.id,
          replacement_dispatch_id: replacementId,
          template_id: selected.row.id,
          template_version: selected.row.version
        };
        const event = insertWorkflowReconciliationEvent(db, {
          organizationId: lockedAuthorization.organizationId,
          campaignId: lockedAuthorization.campaignId,
          userId: lockedAuthorization.userId,
          reason: body.reason,
          requestId: input.requestId,
          auditFingerprint: reservation.auditFingerprint,
          metadata
        });
        const replacement = insertWorkflowReconciliationDispatch(
          db,
          dispatch,
          event.id,
          replacementId,
          selected
        );
        archiveWorkflowReconciliation(db, {
          organizationId: lockedAuthorization.organizationId,
          campaignId: lockedAuthorization.campaignId,
          userId: lockedAuthorization.userId,
          eventId: event.id,
          replacementId,
          metadataJson: event.metadataJson
        });
        const failedRow = selectWorkflowDispatchSummaryRow(db, dispatch.id);
        if (!failedRow) {
          throw new Error('campaign workflow failed dispatch disappeared');
        }
        const responseBody = {
          failed_dispatch: workflowDispatchSummary(failedRow),
          replacement_dispatch: workflowDispatchSummary(replacement),
          event: event.projection
        };
        db.exec('RELEASE SAVEPOINT campaign_workflow_reconciliation_operation');
        idempotency.completeJsonInTransaction(db, {
          ledgerId: reservation.ledgerId,
          requestHash: hash,
          leaseToken: reservation.leaseToken,
          statusCode: 202,
          responseBody
        });
        return {
          status: 202,
          body: responseBody,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        };
      } catch (error) {
        const expected = asWorkflowReconciliationExpectedError(error);
        if (!expected) throw error;
        db.exec('ROLLBACK TO SAVEPOINT campaign_workflow_reconciliation_operation');
        db.exec('RELEASE SAVEPOINT campaign_workflow_reconciliation_operation');
        const responseBody = workflowReconciliationErrorBody(
          expected,
          input.requestId
        );
        idempotency.completeJsonInTransaction(db, {
          ledgerId: reservation.ledgerId,
          requestHash: hash,
          leaseToken: reservation.leaseToken,
          statusCode: expected.statusCode,
          responseBody
        });
        return {
          status: expected.statusCode,
          body: responseBody,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        };
      }
    }).immediate();
  } catch (error) {
    if (
      error instanceof CampaignWorkflowServiceError ||
      error && error.name === 'IdempotencyServiceError'
    ) {
      throw error;
    }
    throw workflowServiceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Campaign workflow reconciliation could not be persisted safely.'
    );
  }
}

const TASK_ACTION_CONFIG = Object.freeze({
  approve: Object.freeze({
    scope: 'workflow.campaign-task.approve',
    nodeType: 'approval',
    taskStatus: 'completed',
    logAction: 'task_approved'
  }),
  reject: Object.freeze({
    scope: 'workflow.campaign-task.reject',
    nodeType: 'approval',
    taskStatus: 'rejected',
    logAction: 'task_rejected'
  }),
  complete: Object.freeze({
    scope: 'workflow.campaign-task.complete',
    nodeType: 'task',
    taskStatus: 'completed',
    logAction: 'task_completed'
  })
});

const INSTANCE_CONTROL_CONFIG = Object.freeze({
  pause: Object.freeze({
    scope: 'workflow.campaign-instance.pause',
    expectedStatuses: Object.freeze(['active']),
    status: 'paused',
    logAction: 'instance_paused'
  }),
  resume: Object.freeze({
    scope: 'workflow.campaign-instance.resume',
    expectedStatuses: Object.freeze(['paused']),
    status: 'active',
    logAction: 'instance_resumed'
  }),
  cancel: Object.freeze({
    scope: 'workflow.campaign-instance.cancel',
    expectedStatuses: Object.freeze(['active', 'paused']),
    status: 'cancelled',
    logAction: 'instance_cancelled'
  })
});

const ACTION_VALIDATION_MESSAGES = Object.freeze({
  WORKFLOW_SNAPSHOT_INVALID: 'Stored workflow snapshot is invalid',
  WORKFLOW_SNAPSHOT_CHECKSUM_MISMATCH: 'Stored workflow snapshot checksum is invalid',
  WORKFLOW_CONTEXT_INVALID: 'Stored workflow context is invalid',
  WORKFLOW_LINEAGE_INVALID: 'Workflow dispatch lineage is invalid',
  WORKFLOW_ASSIGNMENT_UNRESOLVABLE: 'No eligible actor for workflow task'
});

function normalizeTaskActionBody(body) {
  const fields = new Set([
    'expected_status', 'expected_assignment_version', 'comment'
  ]);
  exactBodyKeys(
    body,
    ['expected_status', 'expected_assignment_version'],
    fields
  );
  if (body.expected_status !== 'pending') {
    throw invalidCampaignInput('expected_status must be pending.');
  }
  if (
    !Number.isSafeInteger(body.expected_assignment_version) ||
    body.expected_assignment_version < 1
  ) {
    throw invalidCampaignInput('expected_assignment_version is invalid.');
  }
  let comment = body.comment;
  if (comment === undefined) comment = '';
  if (typeof comment !== 'string' || !hasOnlyUnicodeScalars(comment)) {
    throw invalidCampaignInput('comment is invalid.');
  }
  comment = comment.normalize('NFC').replace(/\r\n?/g, '\n');
  if (hasDisallowedTextControls(comment)) {
    throw invalidCampaignInput('comment is invalid.');
  }
  if (Array.from(comment).length > 2000) {
    throw invalidCampaignInput('comment is too long.');
  }
  return {
    expected_status: 'pending',
    expected_assignment_version: body.expected_assignment_version,
    comment
  };
}

function normalizeTaskReassignmentBody(body) {
  const keys = [
    'expected_task_status',
    'expected_instance_status',
    'expected_assignment_version',
    'assignee_id',
    'assignee_role',
    'reason'
  ];
  exactBodyKeys(body, keys, new Set(keys));
  if (body.expected_task_status !== 'pending') {
    throw invalidCampaignInput('expected_task_status must be pending.');
  }
  if (body.expected_instance_status !== 'active') {
    throw invalidCampaignInput('expected_instance_status must be active.');
  }
  if (
    !Number.isSafeInteger(body.expected_assignment_version) ||
    body.expected_assignment_version < 1
  ) {
    throw invalidCampaignInput('expected_assignment_version is invalid.');
  }
  if (
    body.assignee_id !== null && (
      !Number.isSafeInteger(body.assignee_id) ||
      body.assignee_id < 1
    )
  ) {
    throw invalidCampaignInput('assignee_id is invalid.');
  }
  if (body.assignee_role !== null && !ROLES.has(body.assignee_role)) {
    throw invalidCampaignInput('assignee_role is invalid.');
  }
  if (body.assignee_id === null && body.assignee_role === null) {
    throw invalidCampaignInput();
  }
  if (
    typeof body.reason === 'string' &&
    hasDisallowedTextControls(body.reason.replace(/\r/g, ''))
  ) {
    throw invalidCampaignInput('reason is invalid.');
  }
  return {
    expected_task_status: 'pending',
    expected_instance_status: 'active',
    expected_assignment_version: body.expected_assignment_version,
    assignee_id: body.assignee_id,
    assignee_role: body.assignee_role,
    reason: campaignText(body.reason, 'reason', { required: true })
  };
}

function normalizeInstanceControlBody(body, action) {
  exactBodyKeys(body, ['expected_status', 'reason'], new Set([
    'expected_status', 'reason'
  ]));
  const config = INSTANCE_CONTROL_CONFIG[action];
  if (!config.expectedStatuses.includes(body.expected_status)) {
    const allowed = config.expectedStatuses.join(' or ');
    throw invalidCampaignInput(`expected_status must be ${allowed}.`);
  }
  return {
    expected_status: body.expected_status,
    reason: campaignText(body.reason, 'reason', { required: true })
  };
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function linkedWorkflowErrorBody(error, requestId) {
  const body = {
    error: error.message,
    code: error.code,
    request_id: requestId
  };
  if (error.details !== undefined) body.details = error.details;
  return body;
}

function taskActionPersistenceError(requestId, error) {
  if (
    error && (
      error.name === 'CampaignKnowledgeCapacityError' ||
      error.code === 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED'
    )
  ) {
    return {
      status: 507,
      body: {
        error: 'Campaign knowledge storage capacity exceeded',
        code: 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED',
        request_id: requestId,
        ...(error.details === undefined ? {} : { details: error.details })
      },
      headers: {}
    };
  }
  return {
    status: 500,
    body: {
      error: 'Campaign workflow task action could not be persisted safely.',
      code: 'AUDIT_PERSISTENCE_FAILED',
      request_id: requestId
    },
    headers: {}
  };
}

function instanceControlPersistenceError(requestId, error) {
  if (
    error && (
      error.name === 'CampaignKnowledgeCapacityError' ||
      error.code === 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED'
    )
  ) {
    return {
      status: 507,
      body: {
        error: 'Campaign knowledge storage capacity exceeded',
        code: 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED',
        request_id: requestId,
        ...(error.details === undefined ? {} : { details: error.details })
      },
      headers: {}
    };
  }
  return {
    status: 500,
    body: {
      error: 'Campaign workflow instance control could not be persisted safely.',
      code: 'AUDIT_PERSISTENCE_FAILED',
      request_id: requestId
    },
    headers: {}
  };
}

function taskReassignmentPersistenceError(requestId, error) {
  if (
    error && (
      error.name === 'CampaignKnowledgeCapacityError' ||
      error.code === 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED'
    )
  ) {
    return {
      status: 507,
      body: {
        error: 'Campaign knowledge storage capacity exceeded',
        code: 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED',
        request_id: requestId,
        ...(error.details === undefined ? {} : { details: error.details })
      },
      headers: {}
    };
  }
  return {
    status: 500,
    body: {
      error: 'Campaign workflow task reassignment could not be persisted safely.',
      code: 'AUDIT_PERSISTENCE_FAILED',
      request_id: requestId
    },
    headers: {}
  };
}

function completeRetainedJson(db, reservation, hash, result) {
  idempotency.completeJsonInTransaction(db, {
    ledgerId: reservation.ledgerId,
    requestHash: hash,
    leaseToken: reservation.leaseToken,
    statusCode: result.status,
    responseBody: result.body,
    responseHeaders: result.headers
  });
  return result;
}

function campaignAccessFailure(access) {
  return workflowServiceError(
    access.status,
    access.code,
    access.code === 'CAMPAIGN_NOT_FOUND'
      ? 'Campaign was not found.'
      : 'Campaign access is forbidden.'
  );
}

function requireLinkedWorkflowAccess(db, userIdValue, campaignIdValue) {
  const userId = positiveSafeId(userIdValue, 'user_id');
  const campaignId = positiveSafeId(campaignIdValue, 'campaign_id');
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) throw campaignAccessFailure(access);
  if (access.campaign.operational_status !== 'active') {
    throw campaignWorkflowOperationalError(access.campaign.operational_status);
  }
  if (!access.permissions.write) {
    throw workflowServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  return {
    userId,
    campaignId,
    organizationId: access.campaign.org_id,
    campaign: access.campaign,
    access
  };
}

function requireWorkflowReassignmentAccess(db, userIdValue, campaignIdValue) {
  const userId = positiveSafeId(userIdValue, 'user_id');
  const campaignId = positiveSafeId(campaignIdValue, 'campaign_id');
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) throw campaignAccessFailure(access);
  if (access.role !== 'owner' && access.role !== 'org_admin') {
    throw workflowServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
  return {
    userId,
    campaignId,
    organizationId: access.campaign.org_id,
    campaign: access.campaign,
    access
  };
}

function reassignmentTargetFailure(kind) {
  if (kind === 'not_found') {
    return workflowServiceError(404, 'RECORD_NOT_FOUND', 'Record was not found.');
  }
  return workflowServiceError(403, 'RECORD_FORBIDDEN', 'Record access is forbidden.');
}

function reassignmentTargetState(db, row, body) {
  const matchesRole = (candidate) => {
    if (body.assignee_role === null) return true;
    if (body.assignee_role === 'platform_admin') return candidate.platform_role === 'admin';
    if (body.assignee_role === 'org_admin') return candidate.organization_role === 'org_admin';
    if (body.assignee_role === 'team_lead') return candidate.team_role === 'team_lead';
    return candidate.team_role !== null;
  };
  const candidates = db.prepare(`
    SELECT
      user.id,user.role AS platform_role,
      organization_membership.role_code AS organization_role,
      team_membership.role_code AS team_role,
      CASE WHEN organization_membership.role_code='org_admin'
             OR campaign.owner_user_id=user.id
             OR team_membership.user_id IS NOT NULL
        THEN 1 ELSE 0 END AS has_campaign_write
    FROM campaigns campaign
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=campaign.org_id
     AND organization_membership.status='active'
    JOIN users user
      ON user.id=organization_membership.user_id
     AND user.is_active=1
    LEFT JOIN team_memberships team_membership
      ON team_membership.org_id=campaign.org_id
     AND team_membership.team_id=campaign.team_id
     AND team_membership.user_id=user.id
     AND team_membership.status='active'
    WHERE campaign.org_id=? AND campaign.id=?
      AND (? IS NULL OR user.id=?)
    ORDER BY user.id
  `).all(
    row.org_id,
    row.campaign_id,
    body.assignee_id,
    body.assignee_id
  );
  if (body.assignee_id !== null && candidates.length === 0) {
    return { visible: false, eligible: false };
  }
  const eligible = candidates.some((candidate) => (
    candidate.has_campaign_write === 1 && matchesRole(candidate)
  ));
  return { visible: candidates.length > 0, eligible };
}

function requireInitialReassignmentTarget(db, row, body) {
  const target = reassignmentTargetState(db, row, body);
  if (target.eligible) return;
  if (body.assignee_id !== null && !target.visible) {
    throw reassignmentTargetFailure('not_found');
  }
  throw reassignmentTargetFailure('forbidden');
}

function hasReassignmentRouteOwnership(db, row, campaignId, organizationId) {
  if (
    !row ||
    row.org_id !== organizationId ||
    row.instance_org_id !== organizationId ||
    row.campaign_id !== campaignId ||
    row.instance_campaign_id !== campaignId ||
    row.task_instance_id !== row.instance_id
  ) {
    return false;
  }
  const links = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      COALESCE(SUM(CASE WHEN org_id=? AND campaign_id=? THEN 1 ELSE 0 END),0)
        AS reciprocal_count
    FROM campaign_record_links
    WHERE record_type='workflow_instance'
      AND relation_type='workflow'
      AND record_id=? AND revoked_at IS NULL
  `).get(organizationId, campaignId, String(row.instance_id));
  return links.total_count === 1 && links.reciprocal_count === 1;
}

function hasReassignmentLineage(db, row, campaignId, organizationId) {
  if (!hasReassignmentRouteOwnership(db, row, campaignId, organizationId)) return false;
  if (
    row.dispatch_org_id !== organizationId ||
    row.dispatch_event_org_id !== organizationId ||
    row.root_event_org_id !== organizationId
  ) {
    return false;
  }
  try {
    validateControlLineage(row);
  } catch (_error) {
    return false;
  }
  return true;
}

function reassignmentStateMatches(row, body) {
  return row.task_status === body.expected_task_status &&
    row.instance_status === body.expected_instance_status &&
    row.assignment_version === body.expected_assignment_version &&
    row.current_node_id === row.task_node_id;
}

function taskReassignmentRequestHash(campaignId, taskId, body) {
  return requestHash({
    method: 'POST',
    path: `/api/campaigns/${campaignId}/workflow-tasks/${taskId}/reassign`,
    campaignId,
    kind: 'json',
    payload: body
  });
}

function taskReassignmentResult(row, body) {
  return {
    status: 200,
    body: {
      success: true,
      task_id: row.task_id,
      task_status: 'pending',
      workflow_instance_id: row.instance_id,
      instance_status: 'active',
      assignment: {
        assignee_id: body.assignee_id,
        assignee_role: body.assignee_role,
        assignment_version: row.assignment_version + 1
      }
    },
    headers: {}
  };
}

function applyTaskReassignment(db, runtime, row, authorization, body) {
  if (!reassignmentStateMatches(row, body)) throw staleTaskAction(row);
  if (!reassignmentTargetState(db, row, body).eligible) throw staleTaskAction(row);
  if (
    row.assignee_id === body.assignee_id &&
    row.assignee_role === body.assignee_role
  ) {
    throw invalidCampaignInput();
  }
  if (row.assignment_version === MAX_SAFE_ID) {
    throw workflowServiceError(
      409,
      'ROW_VERSION_EXHAUSTED',
      'Workflow task assignment version is exhausted.'
    );
  }
  const update = db.prepare(`
    UPDATE workflow_tasks
    SET assignee_id=?,assignee_role=?,assignment_version=?
    WHERE id=? AND instance_id=? AND status='pending' AND assignment_version=?
  `).run(
    body.assignee_id,
    body.assignee_role,
    row.assignment_version + 1,
    row.task_id,
    row.instance_id,
    row.assignment_version
  );
  if (update.changes !== 1) {
    throw staleTaskAction(selectTaskActionRow(db, row.task_id));
  }
  const reasonSha = sha256Text(body.reason);
  const reasonScalars = Array.from(body.reason).length;
  const logId = insertOrderedWorkflowLog(db, {
    instanceId: row.instance_id,
    nodeId: row.task_node_id,
    action: 'task_reassigned',
    userId: authorization.userId,
    details: {
      source: 'workflow_task_reassignment',
      action: 'reassign',
      task_id: row.task_id,
      previous_assignee_id: row.assignee_id,
      previous_assignee_role: row.assignee_role,
      assignee_id: body.assignee_id,
      assignee_role: body.assignee_role,
      previous_assignment_version: row.assignment_version,
      assignment_version: row.assignment_version + 1,
      reason_sha256: reasonSha,
      reason_scalars: reasonScalars
    }
  });
  insertWorkflowActivity(
    db,
    authorization.userId,
    'workflow_task_reassignment',
    {
      source: 'workflow_task_reassignment',
      campaign_id: row.campaign_id,
      dispatch_id: row.id,
      instance_id: row.instance_id,
      task_id: row.task_id,
      node_id: row.task_node_id,
      action: 'reassign',
      task_status: 'pending',
      instance_status: 'active',
      previous_assignee_id: row.assignee_id,
      previous_assignee_role: row.assignee_role,
      assignee_id: body.assignee_id,
      assignee_role: body.assignee_role,
      previous_assignment_version: row.assignment_version,
      assignment_version: row.assignment_version + 1,
      reason: body.reason,
      reason_sha256: reasonSha,
      reason_scalars: reasonScalars
    }
  );
  writeActionArchive(db, runtime, {
    organizationId: row.org_id,
    campaignId: row.campaign_id,
    userId: authorization.userId,
    dispatchId: row.id,
    instanceId: row.instance_id,
    nodeId: row.task_node_id,
    action: 'reassign',
    status: 'active',
    errorCode: null,
    logId
  });
  return taskReassignmentResult(row, body);
}

function reassignWorkflowTask(db, runtime, input) {
  const campaignId = positiveSafeId(input.campaignId, 'campaign_id');
  const taskId = positiveSafeId(input.taskId, 'task_id');
  const body = normalizeTaskReassignmentBody(input.body);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const authorization = requireWorkflowReassignmentAccess(db, input.userId, campaignId);
  const initial = selectTaskActionRow(db, taskId);
  if (!hasReassignmentLineage(
    db,
    initial,
    campaignId,
    authorization.organizationId
  )) throw linkedTaskNotFound();
  const hash = taskReassignmentRequestHash(campaignId, taskId, body);
  const reservationInput = {
    organizationId: authorization.organizationId,
    actorUserId: authorization.userId,
    campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: 'workflow.campaign-task.reassign',
    key,
    requestHash: hash,
    expectedEventCount: 0,
    operationTimeoutSeconds: 60
  };
  const retained = idempotency.inspectRetained(db, reservationInput);
  if (retained.state !== 'absent' && !retained.recoverable) {
    return templateIdempotencyDisposition(retained);
  }
  if (
    initial.operational_status === 'active' &&
    reassignmentStateMatches(initial, body)
  ) {
    requireInitialReassignmentTarget(db, initial, body);
  }
  runtime.transactionBoundaryProbe('reassignment.before_write', {
    campaignId,
    taskId
  });
  try {
    return db.transaction(() => {
      let row = selectTaskActionRow(db, taskId);
      const lockedAuthorization = requireWorkflowReassignmentAccess(
        db,
        input.userId,
        campaignId
      );
      if (!hasReassignmentLineage(
        db,
        row,
        campaignId,
        lockedAuthorization.organizationId
      )) {
        throw linkedTaskNotFound();
      }
      let reservation = idempotency.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotency.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') {
        return templateIdempotencyDisposition(reservation);
      }
      runtime.transactionBoundaryProbe('reassignment.after_reservation', {
        campaignId,
        taskId,
        ledgerId: reservation.ledgerId
      });
      db.exec('SAVEPOINT campaign_workflow_task_reassignment');
      try {
        row = selectTaskActionRow(db, taskId);
        if (row && row.operational_status !== 'active') {
          throw campaignWorkflowOperationalError(
            row.operational_status
          );
        }
        if (!hasReassignmentRouteOwnership(
          db,
          row,
          campaignId,
          lockedAuthorization.organizationId
        )) {
          throw staleTaskAction(row);
        }
        if (!hasReassignmentLineage(
          db,
          row,
          campaignId,
          lockedAuthorization.organizationId
        )) {
          throw staleTaskAction(row);
        }
        const result = applyTaskReassignment(
          db,
          runtime,
          row,
          lockedAuthorization,
          body
        );
        db.exec('RELEASE SAVEPOINT campaign_workflow_task_reassignment');
        return completeRetainedJson(db, reservation, hash, result);
      } catch (error) {
        db.exec('ROLLBACK TO SAVEPOINT campaign_workflow_task_reassignment');
        db.exec('RELEASE SAVEPOINT campaign_workflow_task_reassignment');
        if (error instanceof CampaignWorkflowServiceError) {
          return completeRetainedJson(db, reservation, hash, {
            status: error.statusCode,
            body: linkedWorkflowErrorBody(error, input.requestId),
            headers: {}
          });
        }
        const safe = taskReassignmentPersistenceError(input.requestId, error);
        return completeRetainedJson(db, reservation, hash, safe);
      }
    }).immediate();
  } catch (error) {
    if (
      error instanceof CampaignWorkflowServiceError ||
      error && error.name === 'IdempotencyServiceError' &&
        error.code !== 'AUDIT_PERSISTENCE_FAILED'
    ) {
      throw error;
    }
    return taskReassignmentPersistenceError(input.requestId, error);
  }
}

function selectTaskActionRow(db, taskId) {
  return db.prepare(`
    SELECT
      task.id AS task_id,
      task.instance_id AS task_instance_id,
      task.node_id AS task_node_id,
      task.node_type AS task_node_type,
      task.assignee_id,task.assignee_role,
      task.status AS task_status,
      task.comment AS task_comment,
      task.due_at AS task_due_at,
      task.completed_at AS task_completed_at,
      task.completed_by AS task_completed_by,
      task.assignment_version,
      instance.id AS instance_id,
      instance.template_id AS instance_template_id,
      instance.business_type,instance.business_id,
      instance.current_node_id,
      instance.status AS instance_status,
      instance.node_data,
      instance.started_by,
      instance.completed_at AS instance_completed_at,
      instance.org_id AS instance_org_id,
      instance.campaign_id AS instance_campaign_id,
      instance.campaign_event_id,
      instance.campaign_dispatch_id,
      instance.initialization_status,instance.initialization_error,
      instance.execution_error_code,instance.execution_error,
      instance.execution_failed_at,
      COALESCE(instance.org_id,workflow_link.org_id) AS org_id,
      COALESCE(instance.campaign_id,workflow_link.campaign_id) AS campaign_id,
      campaign.owner_user_id,campaign.team_id,campaign.operational_status,
      dispatch.id AS id,
      dispatch.org_id AS dispatch_org_id,
      dispatch.campaign_id AS dispatch_campaign_id,
      dispatch.event_id,dispatch.trigger_event_id,
      dispatch.template_id,dispatch.template_version,
      dispatch.template_checksum,dispatch.template_snapshot_json,
      dispatch.execution_context_json,
      dispatch.workflow_instance_id,dispatch.reconciles_dispatch_id,
      dispatch.status AS dispatch_status,
      dispatch_event.org_id AS dispatch_event_org_id,
      dispatch_event.campaign_id AS dispatch_event_campaign_id,
      dispatch_event.event_type AS dispatch_event_type,
      root_event.id AS root_event_id,
      root_event.org_id AS root_event_org_id,
      root_event.campaign_id AS root_event_campaign_id,
      root_event.event_type AS root_event_type,
      root_event.previous_state AS root_previous_state,
      root_event.next_state AS root_next_state,
      root_event.actor_user_id AS root_actor_user_id
    FROM workflow_tasks task
    JOIN workflow_instances instance ON instance.id=task.instance_id
    LEFT JOIN campaign_record_links workflow_link
      ON workflow_link.record_type='workflow_instance'
     AND workflow_link.relation_type='workflow'
     AND workflow_link.record_id=CAST(instance.id AS TEXT)
     AND workflow_link.revoked_at IS NULL
    LEFT JOIN campaigns campaign
      ON campaign.org_id=COALESCE(instance.org_id,workflow_link.org_id)
     AND campaign.id=COALESCE(instance.campaign_id,workflow_link.campaign_id)
    LEFT JOIN campaign_workflow_dispatches dispatch
      ON dispatch.id=instance.campaign_dispatch_id
    LEFT JOIN campaign_events dispatch_event
      ON dispatch_event.org_id=dispatch.org_id
     AND dispatch_event.campaign_id=dispatch.campaign_id
     AND dispatch_event.id=dispatch.event_id
    LEFT JOIN campaign_events root_event
      ON root_event.org_id=dispatch.org_id
     AND root_event.campaign_id=dispatch.campaign_id
     AND root_event.id=dispatch.trigger_event_id
    WHERE task.id=?
    ORDER BY workflow_link.id
    LIMIT 1
  `).get(taskId);
}

function selectInstanceControlRow(db, instanceId) {
  return db.prepare(`
    SELECT
      instance.id AS instance_id,
      instance.template_id AS instance_template_id,
      instance.business_type,instance.business_id,
      instance.current_node_id,
      instance.status AS instance_status,
      instance.node_data,instance.started_by,
      instance.completed_at AS instance_completed_at,
      instance.org_id AS instance_org_id,
      instance.campaign_id AS instance_campaign_id,
      instance.campaign_event_id,
      instance.campaign_dispatch_id,
      instance.initialization_status,instance.initialization_error,
      instance.execution_error_code,instance.execution_error,
      instance.execution_failed_at,
      COALESCE(instance.org_id,workflow_link.org_id) AS org_id,
      COALESCE(instance.campaign_id,workflow_link.campaign_id) AS campaign_id,
      campaign.owner_user_id,campaign.team_id,campaign.operational_status,
      dispatch.id AS id,
      dispatch.org_id AS dispatch_org_id,
      dispatch.campaign_id AS dispatch_campaign_id,
      dispatch.event_id,dispatch.trigger_event_id,
      dispatch.template_id,dispatch.template_version,
      dispatch.template_checksum,dispatch.template_snapshot_json,
      dispatch.execution_context_json,
      dispatch.workflow_instance_id,dispatch.reconciles_dispatch_id,
      dispatch.status AS dispatch_status,
      dispatch_event.org_id AS dispatch_event_org_id,
      dispatch_event.campaign_id AS dispatch_event_campaign_id,
      dispatch_event.event_type AS dispatch_event_type,
      root_event.id AS root_event_id,
      root_event.org_id AS root_event_org_id,
      root_event.campaign_id AS root_event_campaign_id,
      root_event.event_type AS root_event_type,
      root_event.previous_state AS root_previous_state,
      root_event.next_state AS root_next_state,
      root_event.actor_user_id AS root_actor_user_id
    FROM workflow_instances instance
    LEFT JOIN campaign_record_links workflow_link
      ON workflow_link.record_type='workflow_instance'
     AND workflow_link.relation_type='workflow'
     AND workflow_link.record_id=CAST(instance.id AS TEXT)
     AND workflow_link.revoked_at IS NULL
    LEFT JOIN campaigns campaign
      ON campaign.org_id=COALESCE(instance.org_id,workflow_link.org_id)
     AND campaign.id=COALESCE(instance.campaign_id,workflow_link.campaign_id)
    LEFT JOIN campaign_workflow_dispatches dispatch
      ON dispatch.id=instance.campaign_dispatch_id
    LEFT JOIN campaign_events dispatch_event
      ON dispatch_event.org_id=dispatch.org_id
     AND dispatch_event.campaign_id=dispatch.campaign_id
     AND dispatch_event.id=dispatch.event_id
    LEFT JOIN campaign_events root_event
      ON root_event.org_id=dispatch.org_id
     AND root_event.campaign_id=dispatch.campaign_id
     AND root_event.id=dispatch.trigger_event_id
    WHERE instance.id=?
    ORDER BY workflow_link.id
    LIMIT 1
  `).get(instanceId);
}

function resolveWorkflowReadAccess(db, input) {
  const userId = positiveSafeId(input.userId, 'user_id');
  const instanceId = positiveSafeId(input.instanceId, 'instance_id');
  const row = selectInstanceControlRow(db, instanceId);
  if (!row) {
    return { exists: false, linked: false, allowed: false, forbidden: false };
  }
  const links = db.prepare(`
    SELECT org_id,campaign_id,record_id
    FROM campaign_record_links
    WHERE record_type='workflow_instance'
      AND relation_type='workflow'
      AND record_id=? AND revoked_at IS NULL
    ORDER BY id
  `).all(String(instanceId));
  const linked = row.instance_org_id !== null ||
    row.instance_campaign_id !== null ||
    row.campaign_event_id !== null ||
    row.campaign_dispatch_id !== null ||
    row.business_type === 'campaign' ||
    links.length > 0;
  if (!linked) {
    return { exists: true, linked: false, allowed: true, forbidden: false };
  }
  const completeContext = Number.isSafeInteger(row.instance_org_id) &&
    row.instance_org_id > 0 &&
    Number.isSafeInteger(row.instance_campaign_id) &&
    row.instance_campaign_id > 0 &&
    Number.isSafeInteger(row.campaign_event_id) &&
    row.campaign_event_id > 0 &&
    Number.isSafeInteger(row.campaign_dispatch_id) &&
    row.campaign_dispatch_id > 0 &&
    row.org_id === row.instance_org_id &&
    row.campaign_id === row.instance_campaign_id &&
    row.business_type === 'campaign' &&
    row.business_id === row.instance_campaign_id &&
    links.length === 1 &&
    links[0].org_id === row.instance_org_id &&
    links[0].campaign_id === row.instance_campaign_id;
  if (!completeContext) {
    return { exists: true, linked: true, allowed: false, forbidden: false };
  }
  try {
    validateControlLineage(row);
  } catch (_error) {
    return { exists: true, linked: true, allowed: false, forbidden: false };
  }
  const campaignIdentity = db.prepare(`
    SELECT id,org_id FROM campaigns WHERE id=?
  `).get(row.campaign_id);
  if (
    !campaignIdentity ||
    campaignIdentity.id !== row.instance_campaign_id ||
    campaignIdentity.org_id !== row.instance_org_id ||
    campaignIdentity.org_id !== row.org_id
  ) {
    return { exists: true, linked: true, allowed: false, forbidden: false };
  }
  const access = getCampaignAccess(db, {
    userId,
    campaignId: row.instance_campaign_id
  });
  if (!access.ok || !access.permissions.read) {
    return {
      exists: true,
      linked: true,
      allowed: false,
      forbidden: Boolean(access && access.code === 'CAMPAIGN_FORBIDDEN')
    };
  }
  if (
    !access.campaign ||
    !access.organization ||
    access.campaign.id !== row.instance_campaign_id ||
    access.campaign.org_id !== row.instance_org_id ||
    access.organization.id !== row.instance_org_id
  ) {
    return { exists: true, linked: true, allowed: false, forbidden: false };
  }
  return {
    exists: true,
    linked: true,
    allowed: true,
    forbidden: false,
    campaignId: row.instance_campaign_id,
    organizationId: row.instance_org_id
  };
}

function linkedTaskNotFound() {
  return workflowServiceError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
}

function linkedInstanceNotFound() {
  return workflowServiceError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
}

function taskAssignmentMatches(db, row, userId) {
  if (row.assignee_id !== null && row.assignee_id !== userId) return false;
  if (row.assignee_role === null) return true;
  const predicates = {
    platform_admin: "user.role='admin'",
    org_admin: "organization_membership.role_code='org_admin'",
    team_lead: `EXISTS (
      SELECT 1 FROM team_memberships role_team
      WHERE role_team.org_id=campaign.org_id
        AND role_team.team_id=campaign.team_id
        AND role_team.user_id=user.id
        AND role_team.status='active'
        AND role_team.role_code='team_lead'
    )`,
    member: `EXISTS (
      SELECT 1 FROM team_memberships role_team
      WHERE role_team.org_id=campaign.org_id
        AND role_team.team_id=campaign.team_id
        AND role_team.user_id=user.id
        AND role_team.status='active'
    )`
  };
  const rolePredicate = predicates[row.assignee_role];
  if (!rolePredicate) return false;
  return Boolean(db.prepare(`
    SELECT 1
    FROM users user
    JOIN campaigns campaign ON campaign.org_id=? AND campaign.id=?
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=campaign.org_id
     AND organization_membership.user_id=user.id
     AND organization_membership.status='active'
    WHERE user.id=? AND user.is_active=1
      AND (${rolePredicate})
    LIMIT 1
  `).get(row.org_id, row.campaign_id, userId));
}

function requireTaskAssignment(db, row, userId) {
  if (!taskAssignmentMatches(db, row, userId)) {
    throw workflowServiceError(
      403,
      'CAMPAIGN_FORBIDDEN',
      'Campaign access is forbidden.'
    );
  }
}

function taskActionNotAllowed() {
  return workflowServiceError(
    409,
    'WORKFLOW_TASK_ACTION_NOT_ALLOWED',
    'Workflow task action is not allowed.'
  );
}

function assertValidNodeActionBeforeReservation(row, action) {
  let snapshot;
  try {
    snapshot = parsePinnedSnapshot(row);
  } catch (error) {
    if (error instanceof CampaignWorkflowInitializationError) return;
    throw error;
  }
  const node = snapshot.nodes.find((candidate) => candidate.id === row.task_node_id);
  if (node && node.type !== TASK_ACTION_CONFIG[action].nodeType) {
    throw taskActionNotAllowed();
  }
}

function validateReciprocalLineage(row, snapshot) {
  validatePinnedLineage(row, snapshot);
  if (
    row.dispatch_status !== 'completed' ||
    row.workflow_instance_id !== row.instance_id ||
    row.campaign_dispatch_id !== row.id ||
    row.instance_org_id !== row.org_id ||
    row.instance_campaign_id !== row.campaign_id ||
    row.campaign_event_id !== row.trigger_event_id ||
    row.instance_template_id !== row.template_id ||
    row.business_type !== 'campaign' ||
    row.business_id !== row.campaign_id ||
    row.initialization_status !== 'ready' ||
    row.initialization_error !== null
  ) {
    throw lineageInvalid();
  }
}

function staleTaskAction(row) {
  return workflowServiceError(
    409,
    'STALE_WORKFLOW_TASK_ACTION',
    'Workflow task action is stale.',
    {
      task_status: row ? row.task_status : null,
      instance_status: row ? row.instance_status : null,
      campaign_operational_status: 'active'
    }
  );
}

function staleInstanceControl(row) {
  return workflowServiceError(
    409,
    'STALE_WORKFLOW_INSTANCE_STATUS',
    'Workflow instance status is stale.',
    {
      instance_status: row ? row.instance_status : null,
      campaign_operational_status: 'active'
    }
  );
}

function actionContinuationPlan(db, row, action) {
  const snapshot = parsePinnedSnapshot(row);
  const context = parsePinnedContext(row);
  validateReciprocalLineage(row, snapshot);
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const taskNode = nodes.get(row.task_node_id);
  const currentNode = nodes.get(row.current_node_id);
  if (!taskNode || !currentNode) throw lineageInvalid();
  if (taskNode.type !== TASK_ACTION_CONFIG[action].nodeType) {
    throw taskActionNotAllowed();
  }
  if (row.current_node_id !== row.task_node_id) throw staleTaskAction(row);
  const outgoing = snapshot.edges.filter((edge) => edge.from === taskNode.id);
  const actionEdge = outgoing.find((edge) => edge.outcome === action);
  if (!actionEdge) throw lineageInvalid();
  const conditionContext = {
    campaign: context.campaign,
    event: context.event,
    task: { action }
  };
  const conditionLogs = [];
  let boundary = nodes.get(actionEdge.to);
  let automaticCount = 0;
  while (boundary && boundary.type === 'condition') {
    automaticCount += 1;
    if (automaticCount > 100) throw lineageInvalid();
    const edges = snapshot.edges.filter((edge) => edge.from === boundary.id);
    let selected = null;
    for (const edge of edges) {
      if (
        edge.outcome === 'match' &&
        evaluateCampaignWorkflowCondition(edge.condition, conditionContext)
      ) {
        selected = edge;
        break;
      }
    }
    if (!selected) selected = edges.find((edge) => edge.outcome === 'fallback');
    if (!selected) throw lineageInvalid();
    conditionLogs.push({
      nodeId: boundary.id,
      details: { edge_id: selected.id, matched: selected.outcome === 'match' }
    });
    boundary = nodes.get(selected.to);
  }
  if (!boundary || !['task', 'approval', 'end'].includes(boundary.type)) {
    throw lineageInvalid();
  }
  if (
    (boundary.type === 'task' || boundary.type === 'approval') &&
    !hasEligibleAssignee(db, row, boundary.config)
  ) {
    throw assignmentUnresolvable();
  }
  return { snapshot, context, boundary, conditionLogs };
}

function orderedDetails(value, maximumBytes = 4096) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maximumBytes) {
    throw new Error('campaign workflow evidence exceeds storage bound');
  }
  return json;
}

function insertOrderedWorkflowLog(db, input) {
  const result = db.prepare(`
    INSERT INTO workflow_node_logs (instance_id,node_id,action,user_id,details)
    VALUES (?,?,?,?,?)
  `).run(
    input.instanceId,
    input.nodeId,
    input.action,
    input.userId,
    orderedDetails(input.details)
  );
  return Number(result.lastInsertRowid);
}

function insertWorkflowActivity(db, userId, action, details) {
  db.prepare(`
    INSERT INTO activity_log (user_id,action,module,details)
    VALUES (?,?,'workflow',?)
  `).run(userId, action, orderedDetails(details, CAMPAIGN_WORKFLOW_AUDIT_MAX_BYTES));
}

function writeActionArchive(db, runtime, input) {
  const content = JSON.stringify({
    dispatch_id: input.dispatchId,
    instance_id: input.instanceId,
    node_id: input.nodeId,
    action: input.action,
    status: input.status,
    error_code: input.errorCode
  });
  const archive = runtime.writeKnowledgeInTransaction(db, {
    organizationId: input.organizationId,
    campaignId: input.campaignId,
    createdBy: input.userId,
    entryType: 'campaign_workflow',
    title: `Campaign workflow #${input.instanceId}`,
    summary: Array.from(content).slice(0, 1000).join(''),
    content,
    sourceType: 'campaign_workflow_log',
    sourceId: String(input.logId),
    visibility: 'team',
    tags: ['campaign', 'workflow'],
    metadata: {}
  });
  if (!archive || archive.status !== 'created' || !archive.entry) {
    throw new Error('campaign workflow archive was not created');
  }
  insertCampaignRecordLink(db, {
    organizationId: input.organizationId,
    campaignId: input.campaignId,
    recordType: 'knowledge_entry',
    recordId: archive.entry.id,
    relationType: 'knowledge',
    createdBy: input.userId,
    metadata: {}
  });
  applyWorkflowArchiveGaugePlan(db, archive);
  return archive.entry.id;
}

function taskActionResultBody(row, taskStatus, instanceStatus, currentNodeId, createdIds) {
  return {
    success: true,
    task_id: row.task_id,
    task_status: taskStatus,
    workflow_instance_id: row.instance_id,
    instance_status: instanceStatus,
    current_node_id: currentNodeId,
    created_task_ids: createdIds.slice().sort((left, right) => left - right)
  };
}

function applyTaskAction(db, runtime, row, authorization, action, body) {
  if (
    row.task_status !== body.expected_status ||
    row.assignment_version !== body.expected_assignment_version ||
    row.instance_status !== 'active'
  ) {
    throw staleTaskAction(row);
  }
  const plan = actionContinuationPlan(db, row, action);
  const commentSha = sha256Text(body.comment);
  const commentScalars = Array.from(body.comment).length;
  const taskUpdate = db.prepare(`
    UPDATE workflow_tasks
    SET status=?,comment=?,completed_at=CURRENT_TIMESTAMP,completed_by=?
    WHERE id=? AND status='pending' AND assignment_version=?
  `).run(
    TASK_ACTION_CONFIG[action].taskStatus,
    body.comment,
    authorization.userId,
    row.task_id,
    body.expected_assignment_version
  );
  if (taskUpdate.changes !== 1) {
    throw staleTaskAction(selectTaskActionRow(db, row.task_id));
  }
  const mutationLogId = insertOrderedWorkflowLog(db, {
    instanceId: row.instance_id,
    nodeId: row.task_node_id,
    action: TASK_ACTION_CONFIG[action].logAction,
    userId: authorization.userId,
    details: {
      source: 'workflow_task_action',
      action,
      task_id: row.task_id,
      assignment_version: row.assignment_version,
      comment_sha256: commentSha,
      comment_scalars: commentScalars
    }
  });
  for (const condition of plan.conditionLogs) {
    insertOrderedWorkflowLog(db, {
      instanceId: row.instance_id,
      nodeId: condition.nodeId,
      action: 'condition_evaluated',
      userId: authorization.userId,
      details: condition.details
    });
  }
  const createdTaskIds = [];
  let instanceStatus;
  let currentNodeId;
  if (plan.boundary.type === 'end') {
    const update = db.prepare(`
      UPDATE workflow_instances
      SET status='completed',current_node_id=NULL,completed_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='active' AND current_node_id=?
    `).run(row.instance_id, row.task_node_id);
    if (update.changes !== 1) {
      throw staleTaskAction(selectTaskActionRow(db, row.task_id));
    }
    instanceStatus = 'completed';
    currentNodeId = null;
    insertOrderedWorkflowLog(db, {
      instanceId: row.instance_id,
      nodeId: plan.boundary.id,
      action: 'completed',
      userId: authorization.userId,
      details: { status: 'completed' }
    });
  } else {
    const update = db.prepare(`
      UPDATE workflow_instances
      SET current_node_id=?
      WHERE id=? AND status='active' AND current_node_id=?
    `).run(plan.boundary.id, row.instance_id, row.task_node_id);
    if (update.changes !== 1) {
      throw staleTaskAction(selectTaskActionRow(db, row.task_id));
    }
    const config = plan.boundary.config;
    const dueModifier = config.due_hours === null
      ? null
      : `+${config.due_hours} hours`;
    const result = db.prepare(`
      INSERT INTO workflow_tasks (
        instance_id,node_id,node_type,title,description,assignee_id,
        assignee_role,status,due_at,assignment_version
      ) VALUES (?,?,?,?,?,?,?,'pending',
        CASE WHEN ? IS NULL THEN NULL ELSE datetime(CURRENT_TIMESTAMP,?) END,
        1
      )
    `).run(
      row.instance_id,
      plan.boundary.id,
      plan.boundary.type,
      config.title,
      config.description,
      config.assignee_id,
      config.assignee_role,
      dueModifier,
      dueModifier
    );
    const createdId = Number(result.lastInsertRowid);
    createdTaskIds.push(createdId);
    instanceStatus = 'active';
    currentNodeId = plan.boundary.id;
    insertOrderedWorkflowLog(db, {
      instanceId: row.instance_id,
      nodeId: plan.boundary.id,
      action: 'task_created',
      userId: authorization.userId,
      details: { task_id: createdId }
    });
  }
  insertWorkflowActivity(db, authorization.userId, 'workflow_task_action', {
    source: 'workflow_task_action',
    campaign_id: row.campaign_id,
    dispatch_id: row.id,
    instance_id: row.instance_id,
    task_id: row.task_id,
    node_id: row.task_node_id,
    action,
    task_status: TASK_ACTION_CONFIG[action].taskStatus,
    instance_status: instanceStatus,
    assignment_version: row.assignment_version,
    comment_sha256: commentSha,
    comment_scalars: commentScalars
  });
  writeActionArchive(db, runtime, {
    organizationId: row.org_id,
    campaignId: row.campaign_id,
    userId: authorization.userId,
    dispatchId: row.id,
    instanceId: row.instance_id,
    nodeId: row.task_node_id,
    action,
    status: instanceStatus,
    errorCode: null,
    logId: mutationLogId
  });
  return {
    status: 200,
    body: taskActionResultBody(
      row,
      TASK_ACTION_CONFIG[action].taskStatus,
      instanceStatus,
      currentNodeId,
      createdTaskIds
    ),
    headers: {}
  };
}

function validationFailureResult(error, requestId) {
  return {
    status: 409,
    body: {
      error: 'Campaign workflow template is invalid.',
      code: 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE',
      request_id: requestId,
      details: { reason: error.code }
    },
    headers: {}
  };
}

function detectTaskValidationFailure(db, row, action) {
  try {
    actionContinuationPlan(db, row, action);
  } catch (error) {
    if (error instanceof CampaignWorkflowInitializationError) return error;
    throw error;
  }
  return null;
}

function taskActionRequestHash(taskId, action, campaignId, body) {
  return requestHash({
    method: 'POST',
    path: `/api/workflow/tasks/${taskId}/${action}`,
    campaignId,
    kind: 'json',
    payload: body
  });
}

function taskActionIdentity(row) {
  return {
    organizationId: row.org_id,
    campaignId: row.campaign_id,
    instanceId: row.instance_id,
    dispatchId: row.id,
    campaignEventId: row.campaign_event_id,
    taskNodeId: row.task_node_id,
    currentNodeId: row.current_node_id
  };
}

function taskActionIdentityMatches(row, identity) {
  return Boolean(identity) &&
    row.org_id === identity.organizationId &&
    row.campaign_id === identity.campaignId &&
    row.instance_id === identity.instanceId &&
    row.task_instance_id === identity.instanceId &&
    row.id === identity.dispatchId &&
    row.campaign_dispatch_id === identity.dispatchId &&
    row.campaign_event_id === identity.campaignEventId &&
    row.task_node_id === identity.taskNodeId &&
    row.current_node_id === identity.currentNodeId;
}

function finalizeTaskValidationFailure(db, runtime, descriptor) {
  let transactionResult;
  try {
    transactionResult = db.transaction(() => {
      const row = selectTaskActionRow(db, descriptor.taskId);
      if (!row || !row.campaign_id) {
        idempotency.failInternalInTransaction(db, descriptor.reservation);
        return { throwError: linkedTaskNotFound() };
      }
      let authorization;
      try {
        authorization = requireLinkedWorkflowAccess(
          db,
          descriptor.userId,
          row.campaign_id
        );
        requireTaskAssignment(db, row, authorization.userId);
      } catch (error) {
        if (
          error instanceof CampaignWorkflowServiceError &&
          (error.statusCode === 403 || error.statusCode === 404)
        ) {
          idempotency.failInternalInTransaction(db, descriptor.reservation);
          return { throwError: error };
        }
        if (error instanceof CampaignWorkflowServiceError) {
          const retained = {
            status: error.statusCode,
            body: linkedWorkflowErrorBody(error, descriptor.requestId),
            headers: {}
          };
          return completeRetainedJson(
            db,
            descriptor.reservation,
            descriptor.hash,
            retained
          );
        }
        throw error;
      }
      if (
        !taskActionIdentityMatches(row, descriptor.identity) ||
        descriptor.reservation.requestHash !== descriptor.hash ||
        taskActionRequestHash(
          descriptor.taskId,
          descriptor.action,
          authorization.campaignId,
          descriptor.body
        ) !== descriptor.hash ||
        row.task_status !== descriptor.body.expected_status ||
        row.assignment_version !== descriptor.body.expected_assignment_version ||
        row.instance_status !== 'active'
      ) {
        const error = staleTaskAction(row);
        return completeRetainedJson(db, descriptor.reservation, descriptor.hash, {
          status: error.statusCode,
          body: linkedWorkflowErrorBody(error, descriptor.requestId),
          headers: {}
        });
      }
      let observed;
      try {
        observed = detectTaskValidationFailure(db, row, descriptor.action);
      } catch (error) {
        if (
          error instanceof CampaignWorkflowServiceError &&
          error.code === 'STALE_WORKFLOW_TASK_ACTION'
        ) {
          return completeRetainedJson(db, descriptor.reservation, descriptor.hash, {
            status: error.statusCode,
            body: linkedWorkflowErrorBody(error, descriptor.requestId),
            headers: {}
          });
        }
        throw error;
      }
      if (!observed || observed.code !== descriptor.failure.code) {
        const error = staleTaskAction(row);
        return completeRetainedJson(db, descriptor.reservation, descriptor.hash, {
          status: error.statusCode,
          body: linkedWorkflowErrorBody(error, descriptor.requestId),
          headers: {}
        });
      }

      db.exec('SAVEPOINT campaign_workflow_task_guarded_failure');
      try {
        const instanceUpdate = db.prepare(`
          UPDATE workflow_instances
          SET status='failed_validation',
              execution_error_code=?,execution_error=?,
              execution_failed_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='active' AND current_node_id=?
        `).run(
          observed.code,
          ACTION_VALIDATION_MESSAGES[observed.code],
          row.instance_id,
          row.current_node_id
        );
        if (instanceUpdate.changes !== 1) throw staleTaskAction(row);
        db.prepare(`
          UPDATE workflow_tasks SET status='cancelled'
          WHERE instance_id=? AND status='pending'
        `).run(row.instance_id);
        const logId = insertOrderedWorkflowLog(db, {
          instanceId: row.instance_id,
          nodeId: row.task_node_id,
          action: 'failed_validation',
          userId: authorization.userId,
          details: {
            source: 'workflow_task_action',
            action: descriptor.action,
            task_id: row.task_id,
            error_code: observed.code
          }
        });
        insertWorkflowActivity(db, authorization.userId, 'workflow_task_action', {
          source: 'workflow_task_action',
          campaign_id: row.campaign_id,
          dispatch_id: row.id,
          instance_id: row.instance_id,
          task_id: row.task_id,
          node_id: row.task_node_id,
          action: descriptor.action,
          task_status: 'cancelled',
          instance_status: 'failed_validation',
          error_code: observed.code
        });
        writeActionArchive(db, runtime, {
          organizationId: row.org_id,
          campaignId: row.campaign_id,
          userId: authorization.userId,
          dispatchId: row.id,
          instanceId: row.instance_id,
          nodeId: row.task_node_id,
          action: descriptor.action,
          status: 'failed_validation',
          errorCode: observed.code,
          logId
        });
        const result = validationFailureResult(observed, descriptor.requestId);
        const completed = completeRetainedJson(
          db,
          descriptor.reservation,
          descriptor.hash,
          result
        );
        db.exec('RELEASE SAVEPOINT campaign_workflow_task_guarded_failure');
        return completed;
      } catch (error) {
        db.exec('ROLLBACK TO SAVEPOINT campaign_workflow_task_guarded_failure');
        db.exec('RELEASE SAVEPOINT campaign_workflow_task_guarded_failure');
        if (
          error && error.name === 'IdempotencyServiceError' &&
          error.code === 'IDEMPOTENCY_IN_PROGRESS'
        ) {
          throw error;
        }
        if (
          error instanceof CampaignWorkflowServiceError &&
          error.code === 'STALE_WORKFLOW_TASK_ACTION'
        ) {
          return completeRetainedJson(db, descriptor.reservation, descriptor.hash, {
            status: error.statusCode,
            body: linkedWorkflowErrorBody(error, descriptor.requestId),
            headers: {}
          });
        }
        const safe = taskActionPersistenceError(descriptor.requestId, error);
        return completeRetainedJson(
          db,
          descriptor.reservation,
          descriptor.hash,
          safe
        );
      }
    }).immediate();
  } catch (error) {
    if (
      error && error.name === 'IdempotencyServiceError' &&
      error.code === 'IDEMPOTENCY_IN_PROGRESS'
    ) {
      throw error;
    }
    return taskActionPersistenceError(descriptor.requestId, error);
  }
  if (transactionResult && transactionResult.throwError) {
    throw transactionResult.throwError;
  }
  return transactionResult;
}

function actOnWorkflowTask(db, runtime, input) {
  const taskId = positiveSafeId(input.taskId, 'task_id');
  const action = input.action;
  if (!Object.hasOwn(TASK_ACTION_CONFIG, action)) {
    throw invalidCampaignInput('action is invalid.');
  }
  const body = normalizeTaskActionBody(input.body);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const initial = selectTaskActionRow(db, taskId);
  if (!initial || !initial.campaign_id) throw linkedTaskNotFound();
  const authorization = requireLinkedWorkflowAccess(
    db,
    input.userId,
    initial.campaign_id
  );
  requireTaskAssignment(db, initial, authorization.userId);
  assertValidNodeActionBeforeReservation(initial, action);
  const hash = taskActionRequestHash(taskId, action, authorization.campaignId, body);
  const reservationInput = {
    organizationId: authorization.organizationId,
    actorUserId: authorization.userId,
    campaignId: authorization.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: TASK_ACTION_CONFIG[action].scope,
    key,
    requestHash: hash,
    expectedEventCount: 0,
    operationTimeoutSeconds: 60
  };
  const retained = idempotency.inspectRetained(db, reservationInput);
  if (retained.state !== 'absent' && !retained.recoverable) {
    return templateIdempotencyDisposition(retained);
  }
  runtime.transactionBoundaryProbe('task.before_write', {
    taskId,
    action,
    campaignId: authorization.campaignId
  });

  let result;
  try {
    result = db.transaction(() => {
      const row = selectTaskActionRow(db, taskId);
      if (!row || row.campaign_id !== authorization.campaignId) {
        throw linkedTaskNotFound();
      }
      const lockedAuthorization = requireLinkedWorkflowAccess(
        db,
        input.userId,
        row.campaign_id
      );
      requireTaskAssignment(db, row, lockedAuthorization.userId);
      assertValidNodeActionBeforeReservation(row, action);
      let reservation = idempotency.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotency.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') {
        return templateIdempotencyDisposition(reservation);
      }
      db.exec('SAVEPOINT campaign_workflow_task_action');
      try {
        const outcome = applyTaskAction(
          db,
          runtime,
          row,
          lockedAuthorization,
          action,
          body
        );
        db.exec('RELEASE SAVEPOINT campaign_workflow_task_action');
        return completeRetainedJson(db, reservation, hash, outcome);
      } catch (error) {
        db.exec('ROLLBACK TO SAVEPOINT campaign_workflow_task_action');
        db.exec('RELEASE SAVEPOINT campaign_workflow_task_action');
        if (error instanceof CampaignWorkflowInitializationError) {
          return {
            guardedFailure: true,
            taskId,
            userId: input.userId,
            action,
            body,
            requestId: input.requestId,
            hash,
            identity: taskActionIdentity(row),
            reservation: {
              ledgerId: reservation.ledgerId,
              requestHash: hash,
              leaseToken: reservation.leaseToken
            },
            failure: error
          };
        }
        if (error instanceof CampaignWorkflowServiceError) {
          return completeRetainedJson(db, reservation, hash, {
            status: error.statusCode,
            body: linkedWorkflowErrorBody(error, input.requestId),
            headers: {}
          });
        }
        const safe = taskActionPersistenceError(input.requestId, error);
        return completeRetainedJson(db, reservation, hash, safe);
      }
    }).immediate();
  } catch (error) {
    if (
      error instanceof CampaignWorkflowServiceError ||
      error && error.name === 'IdempotencyServiceError' &&
        error.code !== 'AUDIT_PERSISTENCE_FAILED'
    ) {
      throw error;
    }
    return taskActionPersistenceError(input.requestId, error);
  }
  if (result && result.guardedFailure) {
    runtime.transactionBoundaryProbe('task.before_guarded_failure', {
      taskId,
      action,
      ledgerId: result.reservation.ledgerId,
      failureCode: result.failure.code
    });
    return finalizeTaskValidationFailure(db, runtime, result);
  }
  return result;
}

function validateControlLineage(row) {
  if (
    row.dispatch_status !== 'completed' ||
    row.workflow_instance_id !== row.instance_id ||
    row.campaign_dispatch_id !== row.id ||
    row.instance_org_id !== row.org_id ||
    row.instance_campaign_id !== row.campaign_id ||
    row.dispatch_org_id !== row.instance_org_id ||
    row.dispatch_campaign_id !== row.instance_campaign_id ||
    row.dispatch_event_org_id !== row.instance_org_id ||
    row.dispatch_event_campaign_id !== row.instance_campaign_id ||
    row.root_event_org_id !== row.instance_org_id ||
    row.root_event_campaign_id !== row.instance_campaign_id ||
    row.campaign_event_id !== row.trigger_event_id ||
    row.instance_template_id !== row.template_id ||
    row.root_event_id !== row.trigger_event_id ||
    row.root_event_type !== 'lifecycle_transition' ||
    !Number.isSafeInteger(row.root_actor_user_id) ||
    row.root_actor_user_id < 1 ||
    (
      row.reconciles_dispatch_id === null &&
      (
        row.event_id !== row.trigger_event_id ||
        row.dispatch_event_type !== 'lifecycle_transition'
      )
    ) ||
    (
      row.reconciles_dispatch_id !== null &&
      (
        row.event_id === row.trigger_event_id ||
        row.dispatch_event_type !== 'workflow_reconciliation'
      )
    ) ||
    row.business_type !== 'campaign' ||
    row.business_id !== row.campaign_id ||
    row.initialization_status !== 'ready' ||
    row.initialization_error !== null
  ) {
    throw lineageInvalid();
  }
}

function applyInstanceControl(db, runtime, row, authorization, action, body) {
  const config = INSTANCE_CONTROL_CONFIG[action];
  if (row.instance_status !== body.expected_status) {
    throw staleInstanceControl(row);
  }
  validateControlLineage(row);
  const update = db.prepare(`
    UPDATE workflow_instances SET status=?
    WHERE id=? AND status=? AND initialization_status='ready'
  `).run(config.status, row.instance_id, body.expected_status);
  if (update.changes !== 1) {
    throw staleInstanceControl(selectInstanceControlRow(db, row.instance_id));
  }
  if (action === 'cancel') {
    db.prepare(`
      UPDATE workflow_tasks SET status='cancelled'
      WHERE instance_id=? AND status='pending'
    `).run(row.instance_id);
  }
  const reasonSha = sha256Text(body.reason);
  const reasonScalars = Array.from(body.reason).length;
  const logId = insertOrderedWorkflowLog(db, {
    instanceId: row.instance_id,
    nodeId: row.current_node_id,
    action: config.logAction,
    userId: authorization.userId,
    details: {
      source: 'workflow_instance_control',
      action,
      instance_id: row.instance_id,
      previous_status: row.instance_status,
      status: config.status,
      reason_sha256: reasonSha,
      reason_scalars: reasonScalars
    }
  });
  insertWorkflowActivity(db, authorization.userId, 'workflow_instance_control', {
    source: 'workflow_instance_control',
    campaign_id: row.campaign_id,
    dispatch_id: row.id,
    instance_id: row.instance_id,
    node_id: row.current_node_id,
    action,
    previous_status: row.instance_status,
    status: config.status,
    reason: body.reason,
    reason_sha256: reasonSha,
    reason_scalars: reasonScalars
  });
  writeActionArchive(db, runtime, {
    organizationId: row.org_id,
    campaignId: row.campaign_id,
    userId: authorization.userId,
    dispatchId: row.id,
    instanceId: row.instance_id,
    nodeId: row.current_node_id,
    action,
    status: config.status,
    errorCode: null,
    logId
  });
  return {
    status: 200,
    body: { success: true, instance_id: row.instance_id, status: config.status },
    headers: {}
  };
}

function controlWorkflowInstance(db, runtime, input) {
  const instanceId = positiveSafeId(input.instanceId, 'instance_id');
  const action = input.action;
  if (!Object.hasOwn(INSTANCE_CONTROL_CONFIG, action)) {
    throw invalidCampaignInput('action is invalid.');
  }
  const body = normalizeInstanceControlBody(input.body, action);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const initial = selectInstanceControlRow(db, instanceId);
  if (!initial || !initial.campaign_id) throw linkedInstanceNotFound();
  const authorization = requireLinkedWorkflowAccess(
    db,
    input.userId,
    initial.campaign_id
  );
  const hash = requestHash({
    method: 'POST',
    path: `/api/workflow/instances/${instanceId}/${action}`,
    campaignId: authorization.campaignId,
    kind: 'json',
    payload: body
  });
  const reservationInput = {
    organizationId: authorization.organizationId,
    actorUserId: authorization.userId,
    campaignId: authorization.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: INSTANCE_CONTROL_CONFIG[action].scope,
    key,
    requestHash: hash,
    expectedEventCount: 0,
    operationTimeoutSeconds: 60
  };
  const retained = idempotency.inspectRetained(db, reservationInput);
  if (retained.state !== 'absent' && !retained.recoverable) {
    return templateIdempotencyDisposition(retained);
  }
  runtime.transactionBoundaryProbe('instance.before_write', {
    instanceId,
    action,
    campaignId: authorization.campaignId
  });
  try {
    return db.transaction(() => {
      const row = selectInstanceControlRow(db, instanceId);
      if (!row || row.campaign_id !== authorization.campaignId) {
        throw linkedInstanceNotFound();
      }
      const lockedAuthorization = requireLinkedWorkflowAccess(
        db,
        input.userId,
        row.campaign_id
      );
      let reservation = idempotency.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotency.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') {
        return templateIdempotencyDisposition(reservation);
      }
      db.exec('SAVEPOINT campaign_workflow_instance_control');
      try {
        const result = applyInstanceControl(
          db,
          runtime,
          row,
          lockedAuthorization,
          action,
          body
        );
        db.exec('RELEASE SAVEPOINT campaign_workflow_instance_control');
        return completeRetainedJson(db, reservation, hash, result);
      } catch (error) {
        db.exec('ROLLBACK TO SAVEPOINT campaign_workflow_instance_control');
        db.exec('RELEASE SAVEPOINT campaign_workflow_instance_control');
        if (error instanceof CampaignWorkflowServiceError) {
          return completeRetainedJson(db, reservation, hash, {
            status: error.statusCode,
            body: linkedWorkflowErrorBody(error, input.requestId),
            headers: {}
          });
        }
        if (error instanceof CampaignWorkflowInitializationError) {
          const invalidError = invalidTemplateError(error);
          invalidError.details = { reason: error.code };
          return completeRetainedJson(db, reservation, hash, {
            status: invalidError.statusCode,
            body: linkedWorkflowErrorBody(invalidError, input.requestId),
            headers: {}
          });
        }
        const safe = instanceControlPersistenceError(input.requestId, error);
        return completeRetainedJson(db, reservation, hash, safe);
      }
    }).immediate();
  } catch (error) {
    if (
      error instanceof CampaignWorkflowServiceError ||
      error && error.name === 'IdempotencyServiceError' &&
        error.code !== 'AUDIT_PERSISTENCE_FAILED'
    ) {
      throw error;
    }
    return instanceControlPersistenceError(input.requestId, error);
  }
}

function createCampaignWorkflowService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('A SQLite database is required');
  }
  const runtime = Object.freeze({
    transactionBoundaryProbe: typeof options.transactionBoundaryProbe === 'function'
      ? options.transactionBoundaryProbe
      : () => {},
    writeKnowledgeInTransaction: typeof options.writeKnowledgeInTransaction === 'function'
      ? options.writeKnowledgeInTransaction
      : knowledgeService.writeCampaignKnowledgeInTransaction
  });

  function createCampaignTemplate(input) {
    const body = normalizeCampaignTemplateCreateBody(input.body);
    return runCampaignTemplateMutation(db, {
      ...input,
      method: 'POST',
      path: '/api/workflow/templates',
      scope: 'workflow.campaign-template.create',
      body
    }, ({ userId }) => {
      const result = db.prepare(`
        INSERT INTO workflow_templates (
          name,description,module,category,nodes,edges,version,is_active,
          created_by,trigger_config_json
        ) VALUES (?,?,?,?,?,?,1,0,?,NULL)
      `).run(
        body.name,
        body.description,
        'campaign',
        body.category,
        JSON.stringify(body.nodes),
        JSON.stringify(body.edges),
        userId
      );
      return { status: 200, body: { id: Number(result.lastInsertRowid) } };
    });
  }

  function getCampaignTemplateTrigger(input) {
    const templateId = positiveSafeId(input.templateId, 'template_id');
    requirePlatformAdmin(db, input.userId);
    const template = db.prepare(`
      SELECT id,module,version,is_active,trigger_config_json
      FROM workflow_templates
      WHERE id=?
    `).get(templateId);
    if (!template) throw workflowTemplateNotFound();
    if (template.module !== 'campaign') throw campaignTemplateRequired();
    let trigger = null;
    if (template.trigger_config_json !== null) {
      try {
        trigger = validateTrigger(parseTemplateDocument(
          template.trigger_config_json,
          'TRIGGER_INVALID'
        ));
      } catch (error) {
        if (error instanceof CampaignWorkflowValidationError) {
          throw invalidTemplateError(error);
        }
        throw error;
      }
    }
    return {
      template_id: template.id,
      version: template.version,
      is_active: template.is_active === 1,
      trigger
    };
  }

  function updateCampaignTemplateTrigger(input) {
    const templateId = positiveSafeId(input.templateId, 'template_id');
    const body = normalizeCampaignTemplateTriggerBody(input.body);
    return runCampaignTemplateMutation(db, {
      ...input,
      method: 'PUT',
      path: `/api/workflow/templates/${templateId}/campaign-trigger`,
      scope: 'workflow.campaign-template.trigger',
      body
    }, () => {
      const template = db.prepare(`
        SELECT id,module,version
        FROM workflow_templates
        WHERE id=?
      `).get(templateId);
      if (!template) throw workflowTemplateNotFound();
      if (template.module !== 'campaign') throw campaignTemplateRequired();
      if (template.version !== body.expected_version) {
        throw staleWorkflowTemplate(template.version);
      }
      if (template.version === MAX_SAFE_ID) {
        throw workflowServiceError(409, 'ROW_VERSION_EXHAUSTED', 'Workflow template version is exhausted.');
      }
      const trigger = {
        event_type: body.event_type,
        previous_state: body.previous_state,
        next_state: body.next_state
      };
      const version = template.version + 1;
      const update = db.prepare(`
        UPDATE workflow_templates
        SET trigger_config_json=?,version=?,is_active=0,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND module='campaign' AND version=?
      `).run(JSON.stringify(trigger), version, templateId, body.expected_version);
      if (update.changes !== 1) {
        const current = db.prepare('SELECT module,version FROM workflow_templates WHERE id=?').get(templateId);
        if (!current) throw workflowTemplateNotFound();
        if (current.module !== 'campaign') throw campaignTemplateRequired();
        throw staleWorkflowTemplate(current.version);
      }
      return {
        status: 200,
        body: {
          template_id: templateId,
          version,
          is_active: false,
          trigger
        }
      };
    });
  }

  function updateCampaignTemplateGraph(input) {
    const templateId = positiveSafeId(input.templateId, 'template_id');
    const body = normalizeCampaignTemplateGraphBody(input.body);
    return runCampaignTemplateMutation(db, {
      ...input,
      method: 'PUT',
      path: `/api/workflow/templates/${templateId}`,
      scope: 'workflow.campaign-template.graph',
      body
    }, () => {
      const template = db.prepare(`
        SELECT id,name,description,module,category,nodes,edges,version
        FROM workflow_templates
        WHERE id=?
      `).get(templateId);
      if (!template) throw workflowTemplateNotFound();
      if (template.module !== 'campaign') {
        if (body.module === 'campaign') {
          throw workflowServiceError(
            409,
            'CAMPAIGN_TEMPLATE_CREATE_REQUIRED',
            'Create a new campaign workflow template instead.'
          );
        }
        throw campaignTemplateRequired();
      }
      if (Object.hasOwn(body, 'module') && body.module !== 'campaign') {
        throw workflowServiceError(
          409,
          'CAMPAIGN_TEMPLATE_MODULE_IMMUTABLE',
          'Campaign workflow template module is immutable.'
        );
      }
      if (template.version !== body.expected_version) {
        throw staleWorkflowTemplate(template.version);
      }
      if (template.version === MAX_SAFE_ID) {
        throw workflowServiceError(409, 'ROW_VERSION_EXHAUSTED', 'Workflow template version is exhausted.');
      }
      const version = template.version + 1;
      const update = db.prepare(`
        UPDATE workflow_templates
        SET name=?,description=?,module='campaign',category=?,nodes=?,edges=?,
            version=?,is_active=0,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND module='campaign' AND version=?
      `).run(
        Object.hasOwn(body, 'name') ? body.name : template.name,
        Object.hasOwn(body, 'description') ? body.description : template.description,
        Object.hasOwn(body, 'category') ? body.category : template.category,
        Object.hasOwn(body, 'nodes') ? JSON.stringify(body.nodes) : template.nodes,
        Object.hasOwn(body, 'edges') ? JSON.stringify(body.edges) : template.edges,
        version,
        templateId,
        body.expected_version
      );
      if (update.changes !== 1) {
        const current = db.prepare('SELECT module,version FROM workflow_templates WHERE id=?').get(templateId);
        if (!current) throw workflowTemplateNotFound();
        if (current.module !== 'campaign') throw campaignTemplateRequired();
        throw staleWorkflowTemplate(current.version);
      }
      return {
        status: 200,
        body: { success: true, version, is_active: false }
      };
    });
  }

  function publishCampaignTemplate(input) {
    const templateId = positiveSafeId(input.templateId, 'template_id');
    const body = normalizeCampaignTemplatePublishBody(input.body);
    return runCampaignTemplateMutation(db, {
      ...input,
      method: 'POST',
      path: `/api/workflow/templates/${templateId}/publish`,
      scope: 'workflow.campaign-template.publish',
      body
    }, () => {
      const template = db.prepare(`
        SELECT id,name,module,nodes,edges,version,trigger_config_json
        FROM workflow_templates
        WHERE id=?
      `).get(templateId);
      if (!template) throw workflowTemplateNotFound();
      if (template.module !== 'campaign') throw campaignTemplateRequired();
      if (template.version !== body.expected_version) {
        throw staleWorkflowTemplate(template.version);
      }
      let snapshot;
      try {
        validateTemplateLabel(template.name);
        snapshot = buildSnapshotFromTemplate(template);
      } catch (error) {
        if (error instanceof CampaignWorkflowValidationError) {
          throw invalidTemplateError(error);
        }
        throw error;
      }
      const publishedChecksum = checksumCampaignWorkflowSnapshot(snapshot);
      const update = db.prepare(`
        UPDATE workflow_templates
        SET is_active=1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND module='campaign' AND version=?
      `).run(templateId, body.expected_version);
      if (update.changes !== 1) {
        const current = db.prepare('SELECT module,version FROM workflow_templates WHERE id=?').get(templateId);
        if (!current) throw workflowTemplateNotFound();
        if (current.module !== 'campaign') throw campaignTemplateRequired();
        throw staleWorkflowTemplate(current.version);
      }
      return {
        status: 200,
        body: {
          success: true,
          version: template.version,
          is_active: true,
          published_checksum: publishedChecksum
        }
      };
    });
  }

  function deleteWorkflowTemplate(input) {
    const templateId = positiveSafeId(input.templateId, 'template_id');
    requirePlatformAdmin(db, input.userId);
    return db.transaction(() => {
      requirePlatformAdmin(db, input.userId);
      const template = db.prepare('SELECT id FROM workflow_templates WHERE id=?').get(templateId);
      if (!template) throw workflowTemplateNotFound();
      const dispatchCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM campaign_workflow_dispatches
        WHERE template_id=?
      `).get(templateId).count;
      const instanceCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM workflow_instances
        WHERE template_id=?
      `).get(templateId).count;
      if (dispatchCount > 0 || instanceCount > 0) {
        throw workflowServiceError(
          409,
          'WORKFLOW_TEMPLATE_HAS_DEPENDENCIES',
          'Workflow template has dependencies.',
          { dispatch_count: dispatchCount }
        );
      }
      const result = db.prepare('DELETE FROM workflow_templates WHERE id=?').run(templateId);
      if (result.changes !== 1) throw workflowTemplateNotFound();
      return { status: 200, body: { success: true }, headers: {} };
    }).immediate();
  }

  return Object.freeze({
    actOnWorkflowTask: (input) => actOnWorkflowTask(db, runtime, input),
    controlWorkflowInstance: (input) => controlWorkflowInstance(db, runtime, input),
    createCampaignTemplate,
    deleteWorkflowTemplate,
    getCampaignTemplateTrigger,
    getWorkflowReconciliationOptions: (input) => (
      getWorkflowReconciliationOptions(db, input)
    ),
    publishCampaignTemplate,
    retryWorkflowDispatch: (input) => retryWorkflowDispatch(db, input),
    reconcileWorkflowDispatch: (input) => reconcileWorkflowDispatch(db, input),
    reassignWorkflowTask: (input) => reassignWorkflowTask(db, runtime, input),
    resolveWorkflowReadAccess: (input) => resolveWorkflowReadAccess(db, input),
    updateCampaignTemplateGraph,
    updateCampaignTemplateTrigger
  });
}

function workflowDispatchSummary(row) {
  const dispatchError = row.last_error_code === null
    ? null
    : { code: row.last_error_code, message: row.last_error };
  const instanceError = row.instance_error_code === null || row.instance_error_code === undefined
    ? null
    : { code: row.instance_error_code, message: row.instance_error };
  return {
    id: row.id,
    event_id: row.event_id,
    trigger_event_id: row.trigger_event_id,
    template: {
      id: row.template_id,
      label: row.template_label,
      version: row.template_version
    },
    status: row.status,
    attempt_count: row.attempt_count,
    workflow_instance_id: row.workflow_instance_id,
    instance: row.workflow_instance_id === null
      ? null
      : {
          id: row.workflow_instance_id,
          status: row.instance_status,
          initialization_status: row.initialization_status,
          error: instanceError
        },
    reconciles_dispatch_id: row.reconciles_dispatch_id,
    next_attempt_at: row.next_attempt_at,
    error: dispatchError,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function createLifecycleDispatchesInTransaction(db, input) {
  if (!db || db.inTransaction !== true) {
    throw new TypeError('campaign workflow dispatch creation requires an active transaction');
  }
  const organizationId = positiveSafeId(input.organizationId, 'organization_id');
  const campaignId = positiveSafeId(input.campaignId, 'campaign_id');
  const eventId = positiveSafeId(input.eventId, 'event_id');
  const root = db.prepare(`
    SELECT
      campaign.id AS campaign_id,
      campaign.lifecycle_state,
      campaign.operational_status,
      event.id AS event_id,
      event.event_type,
      event.previous_state,
      event.next_state
    FROM campaigns campaign
    JOIN campaign_events event
      ON event.org_id=campaign.org_id
     AND event.campaign_id=campaign.id
     AND event.id=?
    WHERE campaign.org_id=? AND campaign.id=?
  `).get(eventId, organizationId, campaignId);
  if (
    !root || root.operational_status !== 'active' ||
    root.event_type !== 'lifecycle_transition' ||
    root.lifecycle_state !== root.next_state ||
    !isAdjacentLifecycleTransition(root.previous_state, root.next_state)
  ) {
    throw new CampaignWorkflowValidationError(
      'Campaign workflow root transition is invalid',
      'ROOT_CONTEXT_INVALID'
    );
  }

  const templates = db.prepare(`
    SELECT id,name,module,nodes,edges,version,trigger_config_json
    FROM workflow_templates
    WHERE module='campaign' AND is_active=1
    ORDER BY id
  `).all();
  const dispatches = [];
  for (const template of templates) {
    const templateLabel = validateTemplateLabel(template.name);
    let rawTrigger;
    let trigger;
    try {
      rawTrigger = JSON.parse(template.trigger_config_json);
      trigger = validateTrigger(rawTrigger);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof CampaignWorkflowValidationError) {
        throw new CampaignWorkflowValidationError(
          'Campaign workflow trigger is invalid.',
          'TRIGGER_INVALID'
        );
      }
      throw error;
    }
    if (
      trigger.event_type !== root.event_type ||
      trigger.previous_state !== root.previous_state ||
      trigger.next_state !== root.next_state
    ) {
      continue;
    }

    const snapshot = buildSnapshotFromTemplate(template);
    const snapshotJson = canonicalJsonBytes(snapshot).toString('utf8');
    const checksum = checksumCampaignWorkflowSnapshot(snapshot);
    const executionContextJson = JSON.stringify({
      campaign: {
        id: campaignId,
        lifecycle_state: root.next_state,
        operational_status: 'active'
      },
      event: {
        event_type: 'lifecycle_transition',
        previous_state: root.previous_state,
        next_state: root.next_state
      }
    });
    const inserted = db.prepare(`
      INSERT INTO campaign_workflow_dispatches (
        org_id,campaign_id,event_id,trigger_event_id,template_id,
        template_version,template_label,template_checksum,template_snapshot_json,
        execution_context_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      organizationId,
      campaignId,
      eventId,
      eventId,
      template.id,
      template.version,
      templateLabel,
      checksum,
      snapshotJson,
      executionContextJson
    );
    const row = db.prepare(`
      SELECT
        dispatch.id,dispatch.event_id,dispatch.trigger_event_id,
        dispatch.template_id,dispatch.template_label,
        dispatch.template_version,dispatch.status,dispatch.attempt_count,
        dispatch.workflow_instance_id,instance.status AS instance_status,
        instance.initialization_status,
        instance.execution_error_code AS instance_error_code,
        instance.execution_error AS instance_error,
        dispatch.reconciles_dispatch_id,dispatch.next_attempt_at,
        dispatch.last_error_code,dispatch.last_error,
        dispatch.created_at,dispatch.updated_at
      FROM campaign_workflow_dispatches dispatch
      LEFT JOIN workflow_instances instance ON instance.id=dispatch.workflow_instance_id
      WHERE dispatch.id=?
    `).get(Number(inserted.lastInsertRowid));
    dispatches.push(workflowDispatchSummary(row));
  }
  return dispatches;
}

const TERMINAL_VALIDATION_ERRORS = new Set([
  'WORKFLOW_SNAPSHOT_INVALID',
  'WORKFLOW_SNAPSHOT_CHECKSUM_MISMATCH',
  'WORKFLOW_CONTEXT_INVALID',
  'WORKFLOW_LINEAGE_INVALID'
]);

function initializationError(code, message) {
  return new CampaignWorkflowInitializationError(code, message);
}

function snapshotInvalid() {
  return initializationError(
    'WORKFLOW_SNAPSHOT_INVALID',
    'Stored workflow snapshot is invalid'
  );
}

function checksumInvalid() {
  return initializationError(
    'WORKFLOW_SNAPSHOT_CHECKSUM_MISMATCH',
    'Stored workflow snapshot checksum is invalid'
  );
}

function contextInvalid() {
  return initializationError(
    'WORKFLOW_CONTEXT_INVALID',
    'Stored workflow context is invalid'
  );
}

function lineageInvalid() {
  return initializationError(
    'WORKFLOW_LINEAGE_INVALID',
    'Workflow dispatch lineage is invalid'
  );
}

function assignmentUnresolvable() {
  return initializationError(
    'WORKFLOW_ASSIGNMENT_UNRESOLVABLE',
    'No eligible actor for workflow task'
  );
}

function randomWorkerToken() {
  return crypto.randomBytes(32).toString('hex');
}

function campaignLinkBundleId() {
  return crypto.randomBytes(32).toString('hex');
}

function claimProjection(row) {
  return {
    dispatchId: row.id,
    attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until
  };
}

function normalizeWorkerClaim(value) {
  if (!isPlainObject(value)) return null;
  if (!Number.isSafeInteger(value.dispatchId) || value.dispatchId < 1) return null;
  if (!Number.isSafeInteger(value.attemptCount) || value.attemptCount < 1 || value.attemptCount > 5) {
    return null;
  }
  if (
    typeof value.leaseToken !== 'string' ||
    value.leaseToken.length < 16 ||
    value.leaseToken.length > 120
  ) {
    return null;
  }
  if (typeof value.leaseUntil !== 'string' || value.leaseUntil.length !== 19) {
    return null;
  }
  return {
    dispatchId: value.dispatchId,
    attemptCount: value.attemptCount,
    leaseToken: value.leaseToken,
    leaseUntil: value.leaseUntil
  };
}

function recoverExpiredFinalDispatchesInTransaction(db) {
  const rows = db.prepare(`
    SELECT dispatch.id,dispatch.lease_token,dispatch.lease_until
    FROM campaign_workflow_dispatches dispatch
    JOIN campaigns campaign
      ON campaign.org_id=dispatch.org_id
      AND campaign.id=dispatch.campaign_id
    WHERE dispatch.status='processing'
      AND dispatch.attempt_count=5
      AND datetime(dispatch.lease_until)<=CURRENT_TIMESTAMP
      AND campaign.operational_status='active'
    ORDER BY dispatch.lease_until,dispatch.created_at,dispatch.id
  `).all();
  const recover = db.prepare(`
    UPDATE campaign_workflow_dispatches
    SET status='dead_letter',lease_until=NULL,lease_token=NULL,
        next_attempt_at=NULL,
        last_error_code='WORKER_LEASE_EXPIRED_FINAL',
        last_error='Final workflow worker lease expired',
        updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='processing' AND attempt_count=5
      AND lease_token=? AND lease_until=?
      AND datetime(lease_until)<=CURRENT_TIMESTAMP
      AND EXISTS (
        SELECT 1 FROM campaigns campaign
        WHERE campaign.org_id=campaign_workflow_dispatches.org_id
          AND campaign.id=campaign_workflow_dispatches.campaign_id
          AND campaign.operational_status='active'
      )
  `);
  let recovered = 0;
  for (const row of rows) {
    recovered += recover.run(row.id, row.lease_token, row.lease_until).changes;
  }
  return recovered;
}

function recoverExpiredFinalDispatches(db) {
  return db.transaction(() => (
    recoverExpiredFinalDispatchesInTransaction(db)
  )).immediate();
}

function claimNextCampaignWorkflowDispatch(db) {
  return db.transaction(() => {
    recoverExpiredFinalDispatchesInTransaction(db);
    const candidate = db.prepare(`
      SELECT
        dispatch.id,dispatch.status,dispatch.attempt_count,
        dispatch.lease_token,dispatch.lease_until,dispatch.next_attempt_at
      FROM campaign_workflow_dispatches dispatch
      JOIN campaigns campaign
        ON campaign.org_id=dispatch.org_id
        AND campaign.id=dispatch.campaign_id
      WHERE campaign.operational_status='active'
        AND (
          (dispatch.status='pending' AND dispatch.attempt_count=0)
          OR (
            dispatch.status='failed_initialization'
            AND dispatch.attempt_count BETWEEN 1 AND 4
            AND datetime(dispatch.next_attempt_at)<=CURRENT_TIMESTAMP
          )
          OR (
            dispatch.status='processing'
            AND dispatch.attempt_count BETWEEN 1 AND 4
            AND datetime(dispatch.lease_until)<=CURRENT_TIMESTAMP
          )
        )
      ORDER BY
        COALESCE(
          dispatch.next_attempt_at,
          dispatch.lease_until,
          dispatch.created_at
        ),
        dispatch.created_at,
        dispatch.id
      LIMIT 1
    `).get();
    if (!candidate) return null;
    const token = randomWorkerToken();
    const claimed = db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET status='processing',attempt_count=attempt_count+1,
          lease_until=datetime(CURRENT_TIMESTAMP,'+60 seconds'),
          lease_token=?,next_attempt_at=NULL,last_error_code=NULL,last_error=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status=? AND attempt_count=?
        AND lease_token IS ? AND lease_until IS ? AND next_attempt_at IS ?
        AND (
          (status='pending' AND attempt_count=0)
          OR (
            status='failed_initialization' AND attempt_count BETWEEN 1 AND 4
            AND datetime(next_attempt_at)<=CURRENT_TIMESTAMP
          )
          OR (
            status='processing' AND attempt_count BETWEEN 1 AND 4
            AND datetime(lease_until)<=CURRENT_TIMESTAMP
          )
        )
        AND EXISTS (
          SELECT 1 FROM campaigns campaign
          WHERE campaign.org_id=campaign_workflow_dispatches.org_id
            AND campaign.id=campaign_workflow_dispatches.campaign_id
            AND campaign.operational_status='active'
        )
    `).run(
      token,
      candidate.id,
      candidate.status,
      candidate.attempt_count,
      candidate.lease_token,
      candidate.lease_until,
      candidate.next_attempt_at
    );
    if (claimed.changes !== 1) return null;
    const row = db.prepare(`
      SELECT id,attempt_count,lease_token,lease_until
      FROM campaign_workflow_dispatches
      WHERE id=?
    `).get(candidate.id);
    return claimProjection(row);
  }).immediate();
}

function heartbeatCampaignWorkflowDispatch(db, claimValue) {
  const claim = normalizeWorkerClaim(claimValue);
  if (!claim) return null;
  return db.transaction(() => {
    const renewed = db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET lease_until=datetime(lease_until,'+20 seconds'),
          updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='processing' AND attempt_count=?
        AND lease_token=? AND lease_until=?
        AND datetime(lease_until)>CURRENT_TIMESTAMP
        AND EXISTS (
          SELECT 1 FROM campaigns campaign
          WHERE campaign.org_id=campaign_workflow_dispatches.org_id
            AND campaign.id=campaign_workflow_dispatches.campaign_id
            AND campaign.operational_status='active'
        )
    `).run(
      claim.dispatchId,
      claim.attemptCount,
      claim.leaseToken,
      claim.leaseUntil
    );
    if (renewed.changes !== 1) return null;
    const row = db.prepare(`
      SELECT id,attempt_count,lease_token,lease_until
      FROM campaign_workflow_dispatches
      WHERE id=?
    `).get(claim.dispatchId);
    return claimProjection(row);
  }).immediate();
}

function readFencedDispatch(db, claim) {
  const row = db.prepare(`
    SELECT
      dispatch.*,
      campaign.owner_user_id,campaign.team_id,campaign.operational_status,
      event.event_type AS dispatch_event_type,
      root_event.id AS root_event_id,
      root_event.event_type AS root_event_type,
      root_event.previous_state AS root_previous_state,
      root_event.next_state AS root_next_state,
      root_event.actor_user_id AS root_actor_user_id
    FROM campaign_workflow_dispatches dispatch
    JOIN campaigns campaign
      ON campaign.org_id=dispatch.org_id
      AND campaign.id=dispatch.campaign_id
    LEFT JOIN campaign_events event
      ON event.org_id=dispatch.org_id
      AND event.campaign_id=dispatch.campaign_id
      AND event.id=dispatch.event_id
    LEFT JOIN campaign_events root_event
      ON root_event.org_id=dispatch.org_id
      AND root_event.campaign_id=dispatch.campaign_id
      AND root_event.id=dispatch.trigger_event_id
    WHERE dispatch.id=? AND dispatch.status='processing'
      AND dispatch.attempt_count=? AND dispatch.lease_token=?
      AND dispatch.lease_until=?
      AND datetime(dispatch.lease_until)>CURRENT_TIMESTAMP
      AND campaign.operational_status='active'
  `).get(
    claim.dispatchId,
    claim.attemptCount,
    claim.leaseToken,
    claim.leaseUntil
  );
  if (!row) throw new CampaignWorkflowFenceLostError();
  return row;
}

function parsePinnedSnapshot(row) {
  let parsed;
  let snapshot;
  try {
    parsed = JSON.parse(row.template_snapshot_json);
    snapshot = validateCampaignWorkflowSnapshot(parsed);
  } catch (error) {
    if (
      error instanceof CampaignWorkflowValidationError &&
      error.message === 'workflow exceeds 100 automatic nodes before a boundary'
    ) {
      throw lineageInvalid();
    }
    throw snapshotInvalid();
  }
  const canonicalBytes = canonicalJsonBytes(snapshot).toString('utf8');
  if (row.template_snapshot_json !== canonicalBytes) throw snapshotInvalid();
  let checksum;
  try {
    checksum = checksumCampaignWorkflowSnapshot(snapshot);
  } catch (_error) {
    throw snapshotInvalid();
  }
  if (checksum !== row.template_checksum) throw checksumInvalid();
  return snapshot;
}

function parsePinnedContext(row) {
  let context;
  try {
    context = JSON.parse(row.execution_context_json);
  } catch (_error) {
    throw contextInvalid();
  }
  if (!isPlainObject(context)) throw contextInvalid();
  const expected = JSON.stringify({
    campaign: {
      id: row.campaign_id,
      lifecycle_state: row.root_next_state,
      operational_status: 'active'
    },
    event: {
      event_type: 'lifecycle_transition',
      previous_state: row.root_previous_state,
      next_state: row.root_next_state
    }
  });
  if (row.execution_context_json !== expected) throw contextInvalid();
  return context;
}

function validatePinnedLineage(row, snapshot) {
  if (
    row.root_event_id !== row.trigger_event_id ||
    row.root_event_type !== 'lifecycle_transition' ||
    !Number.isSafeInteger(row.root_actor_user_id) ||
    row.root_actor_user_id < 1 ||
    snapshot.template_id !== row.template_id ||
    snapshot.template_version !== row.template_version ||
    snapshot.module !== 'campaign' ||
    snapshot.trigger.event_type !== row.root_event_type ||
    snapshot.trigger.previous_state !== row.root_previous_state ||
    snapshot.trigger.next_state !== row.root_next_state ||
    (
      row.reconciles_dispatch_id === null &&
      (
        row.event_id !== row.trigger_event_id ||
        row.dispatch_event_type !== 'lifecycle_transition'
      )
    ) ||
    (
      row.reconciles_dispatch_id !== null &&
      (
        row.event_id === row.trigger_event_id ||
        row.dispatch_event_type !== 'workflow_reconciliation'
      )
    )
  ) {
    throw lineageInvalid();
  }
}

function initialWorkflowPlan(snapshot, context, dispatchId) {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edges = new Map(snapshot.nodes.map((node) => [node.id, []]));
  for (const edge of snapshot.edges) edges.get(edge.from).push(edge);
  const start = snapshot.nodes.find((node) => node.type === 'start');
  if (!start) throw lineageInvalid();
  const plan = [{
    nodeId: start.id,
    action: 'entered',
    details: JSON.stringify({ dispatch_id: dispatchId })
  }];
  let automaticCount = 1;
  const startEdge = edges.get(start.id).find((edge) => edge.outcome === 'next');
  if (!startEdge) throw lineageInvalid();
  let current = nodes.get(startEdge.to);
  const conditionContext = {
    campaign: context.campaign,
    event: context.event,
    task: { action: null }
  };
  while (current && current.type === 'condition') {
    automaticCount += 1;
    if (automaticCount > 100) throw lineageInvalid();
    const outgoing = edges.get(current.id);
    let selected = null;
    for (const edge of outgoing) {
      if (
        edge.outcome === 'match' &&
        evaluateCampaignWorkflowCondition(edge.condition, conditionContext)
      ) {
        selected = edge;
        break;
      }
    }
    if (!selected) selected = outgoing.find((edge) => edge.outcome === 'fallback');
    if (!selected) throw lineageInvalid();
    plan.push({
      nodeId: current.id,
      action: 'condition_evaluated',
      details: JSON.stringify({
        edge_id: selected.id,
        matched: selected.outcome === 'match'
      })
    });
    current = nodes.get(selected.to);
  }
  if (!current || !['task', 'approval', 'end'].includes(current.type)) {
    throw lineageInvalid();
  }
  return { boundary: current, logs: plan };
}

function hasEligibleAssignee(db, row, config) {
  const roleSql = {
    platform_admin: "user.role='admin'",
    org_admin: "organization_membership.role_code='org_admin'",
    team_lead: `EXISTS (
      SELECT 1 FROM team_memberships role_team
      WHERE role_team.org_id=campaign.org_id
        AND role_team.team_id=campaign.team_id
        AND role_team.user_id=user.id
        AND role_team.status='active'
        AND role_team.role_code='team_lead'
    )`,
    member: `EXISTS (
      SELECT 1 FROM team_memberships role_team
      WHERE role_team.org_id=campaign.org_id
        AND role_team.team_id=campaign.team_id
        AND role_team.user_id=user.id
        AND role_team.status='active'
    )`
  };
  const rolePredicate = config.assignee_role === null
    ? '1=1'
    : roleSql[config.assignee_role];
  if (!rolePredicate) return false;
  return Boolean(db.prepare(`
    SELECT 1
    FROM campaigns campaign
    JOIN users user ON user.is_active=1 AND typeof(user.is_active)='integer'
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=campaign.org_id
      AND organization_membership.user_id=user.id
      AND organization_membership.status='active'
    WHERE campaign.org_id=? AND campaign.id=?
      AND campaign.operational_status='active'
      AND (? IS NULL OR user.id=?)
      AND EXISTS (
        SELECT 1 FROM team_memberships identity_team
        WHERE identity_team.org_id=campaign.org_id
          AND identity_team.user_id=user.id
          AND identity_team.status='active'
      )
      AND (
        organization_membership.role_code='org_admin'
        OR campaign.owner_user_id=user.id
        OR EXISTS (
          SELECT 1 FROM team_memberships access_team
          WHERE access_team.org_id=campaign.org_id
            AND access_team.team_id=campaign.team_id
            AND access_team.user_id=user.id
            AND access_team.status='active'
        )
      )
      AND (${rolePredicate})
    LIMIT 1
  `).get(
    row.org_id,
    row.campaign_id,
    config.assignee_id,
    config.assignee_id
  ));
}

function boundedLogDetails(value) {
  const details = canonicalJsonBytes(value).toString('utf8');
  if (Buffer.byteLength(details, 'utf8') > 4096) {
    throw new Error('campaign workflow log details exceed storage bound');
  }
  return details;
}

function insertWorkflowNodeLog(db, instanceId, nodeId, action, userId, details) {
  const result = db.prepare(`
    INSERT INTO workflow_node_logs (instance_id,node_id,action,user_id,details)
    VALUES (?,?,?,?,?)
  `).run(
    instanceId,
    nodeId,
    action,
    userId,
    typeof details === 'string'
      ? boundedLogDetails(JSON.parse(details))
      : boundedLogDetails(details)
  );
  return Number(result.lastInsertRowid);
}

function insertCampaignRecordLink(db, options) {
  const metadataJson = boundedLogDetails(options.metadata || {});
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    options.organizationId,
    options.campaignId,
    options.recordType,
    campaignLinkBundleId(),
    String(options.recordId),
    options.relationType,
    options.createdBy,
    metadataJson
  );
  return Number(result.lastInsertRowid);
}

function archiveTerminalInitialization(db, row, instanceId, nodeId, logId) {
  const content = JSON.stringify({
    dispatch_id: row.id,
    instance_id: instanceId,
    node_id: nodeId,
    action: 'completed',
    status: 'completed',
    error_code: null
  });
  const summary = Array.from(content.replace(/\s+/gu, ' ').trim())
    .slice(0, 1000)
    .join('');
  const archive = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: row.org_id,
    campaignId: row.campaign_id,
    createdBy: row.root_actor_user_id,
    entryType: 'campaign_workflow',
    title: `Campaign workflow #${instanceId}`,
    summary,
    content,
    sourceType: 'campaign_workflow_log',
    sourceId: String(logId),
    visibility: 'team',
    tags: ['campaign', 'workflow'],
    metadata: {}
  });
  insertCampaignRecordLink(db, {
    organizationId: row.org_id,
    campaignId: row.campaign_id,
    recordType: 'knowledge_entry',
    recordId: archive.entry.id,
    relationType: 'knowledge',
    createdBy: row.root_actor_user_id,
    metadata: {}
  });
  applyWorkflowArchiveGaugePlan(db, archive);
  return archive.entry.id;
}

function finalizeValidationFailure(db, row, claim, error) {
  const result = db.prepare(`
    UPDATE campaign_workflow_dispatches
    SET status='failed_validation',workflow_instance_id=NULL,
        lease_until=NULL,lease_token=NULL,next_attempt_at=NULL,
        last_error_code=?,last_error=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='processing' AND attempt_count=?
      AND lease_token=? AND lease_until=?
      AND datetime(lease_until)>CURRENT_TIMESTAMP
      AND EXISTS (
        SELECT 1 FROM campaigns campaign
        WHERE campaign.org_id=campaign_workflow_dispatches.org_id
          AND campaign.id=campaign_workflow_dispatches.campaign_id
          AND campaign.operational_status='active'
      )
  `).run(
    error.code,
    error.message,
    row.id,
    claim.attemptCount,
    claim.leaseToken,
    claim.leaseUntil
  );
  if (result.changes !== 1) throw new CampaignWorkflowFenceLostError();
  return { state: 'failed_validation', dispatchId: row.id };
}

function initializeClaimedCampaignWorkflowDispatch(db, claimValue) {
  const claim = normalizeWorkerClaim(claimValue);
  if (!claim) {
    return { state: 'stale', dispatchId: claimValue && claimValue.dispatchId };
  }
  return db.transaction(() => {
    const row = readFencedDispatch(db, claim);
    let snapshot;
    let context;
    let plan;
    try {
      snapshot = parsePinnedSnapshot(row);
      validatePinnedLineage(row, snapshot);
      context = parsePinnedContext(row);
      plan = initialWorkflowPlan(snapshot, context, row.id);
    } catch (error) {
      if (
        error instanceof CampaignWorkflowInitializationError &&
        TERMINAL_VALIDATION_ERRORS.has(error.code)
      ) {
        return finalizeValidationFailure(db, row, claim, error);
      }
      if (error instanceof CampaignWorkflowValidationError) {
        return finalizeValidationFailure(db, row, claim, lineageInvalid());
      }
      throw error;
    }

    if (
      (plan.boundary.type === 'task' || plan.boundary.type === 'approval') &&
      !hasEligibleAssignee(db, row, plan.boundary.config)
    ) {
      throw assignmentUnresolvable();
    }
    const terminal = plan.boundary.type === 'end';
    const instanceResult = db.prepare(`
      INSERT INTO workflow_instances (
        template_id,business_type,business_id,current_node_id,status,node_data,
        started_by,completed_at,org_id,campaign_id,campaign_event_id,
        campaign_dispatch_id,initialization_status,initialization_error,
        execution_error_code,execution_error,execution_failed_at
      ) VALUES (
        ?,'campaign',?,?,?, ?,?,
        CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
        ?,?,?,?,'ready',NULL,NULL,NULL,NULL
      )
    `).run(
      row.template_id,
      row.campaign_id,
      terminal ? null : plan.boundary.id,
      terminal ? 'completed' : 'active',
      JSON.stringify({ data: context }),
      row.root_actor_user_id,
      terminal ? 1 : 0,
      row.org_id,
      row.campaign_id,
      row.trigger_event_id,
      row.id
    );
    const instanceId = Number(instanceResult.lastInsertRowid);
    for (const log of plan.logs) {
      insertWorkflowNodeLog(
        db,
        instanceId,
        log.nodeId,
        log.action,
        row.root_actor_user_id,
        log.details
      );
    }

    let terminalLogId = null;
    if (terminal) {
      terminalLogId = insertWorkflowNodeLog(
        db,
        instanceId,
        plan.boundary.id,
        'completed',
        row.root_actor_user_id,
        { status: 'completed' }
      );
    } else {
      const config = plan.boundary.config;
      const taskResult = db.prepare(`
        INSERT INTO workflow_tasks (
          instance_id,node_id,node_type,title,description,assignee_id,
          assignee_role,status,due_at,assignment_version
        ) VALUES (
          ?,?,?,?,?,?,?,'pending',
          CASE WHEN ? IS NULL THEN NULL
            ELSE datetime(CURRENT_TIMESTAMP,'+' || ? || ' hours') END,
          1
        )
      `).run(
        instanceId,
        plan.boundary.id,
        plan.boundary.type,
        config.title,
        config.description,
        config.assignee_id,
        config.assignee_role,
        config.due_hours,
        config.due_hours
      );
      insertWorkflowNodeLog(
        db,
        instanceId,
        plan.boundary.id,
        'task_created',
        row.root_actor_user_id,
        { task_id: Number(taskResult.lastInsertRowid) }
      );
    }

    insertCampaignRecordLink(db, {
      organizationId: row.org_id,
      campaignId: row.campaign_id,
      recordType: 'workflow_instance',
      recordId: instanceId,
      relationType: 'workflow',
      createdBy: row.root_actor_user_id,
      metadata: {
        dispatch_id: row.id,
        trigger_event_id: row.trigger_event_id
      }
    });
    if (terminal) {
      archiveTerminalInitialization(
        db,
        row,
        instanceId,
        plan.boundary.id,
        terminalLogId
      );
    }
    const finalized = db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET status='completed',workflow_instance_id=?,
          lease_until=NULL,lease_token=NULL,next_attempt_at=NULL,
          last_error_code=NULL,last_error=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='processing' AND attempt_count=?
        AND lease_token=? AND lease_until=?
        AND datetime(lease_until)>CURRENT_TIMESTAMP
        AND EXISTS (
          SELECT 1 FROM campaigns campaign
          WHERE campaign.org_id=campaign_workflow_dispatches.org_id
            AND campaign.id=campaign_workflow_dispatches.campaign_id
            AND campaign.operational_status='active'
        )
    `).run(
      instanceId,
      row.id,
      claim.attemptCount,
      claim.leaseToken,
      claim.leaseUntil
    );
    if (finalized.changes !== 1) throw new CampaignWorkflowFenceLostError();
    return { state: 'completed', dispatchId: row.id, instanceId };
  }).immediate();
}

function safeInitializationFailure(error) {
  if (
    error instanceof CampaignWorkflowInitializationError &&
    error.code === 'WORKFLOW_ASSIGNMENT_UNRESOLVABLE'
  ) {
    return { code: error.code, message: error.message };
  }
  return WORKFLOW_INITIALIZATION_FAILURE;
}

function recordInitializationFailure(db, claimValue, error) {
  const claim = normalizeWorkerClaim(claimValue);
  if (!claim) return { state: 'stale', dispatchId: claimValue && claimValue.dispatchId };
  const safe = safeInitializationFailure(error);
  return db.transaction(() => {
    const terminal = claim.attemptCount === 5;
    const backoff = {
      1: '+5 seconds',
      2: '+30 seconds',
      3: '+2 minutes',
      4: '+10 minutes'
    }[claim.attemptCount];
    const result = db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET status=?,lease_until=NULL,lease_token=NULL,
          next_attempt_at=CASE WHEN ? THEN NULL
            ELSE datetime(CURRENT_TIMESTAMP,?) END,
          last_error_code=?,last_error=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='processing' AND attempt_count=?
        AND lease_token=? AND lease_until=?
        AND datetime(lease_until)>CURRENT_TIMESTAMP
        AND EXISTS (
          SELECT 1 FROM campaigns campaign
          WHERE campaign.org_id=campaign_workflow_dispatches.org_id
            AND campaign.id=campaign_workflow_dispatches.campaign_id
            AND campaign.operational_status='active'
        )
    `).run(
      terminal ? 'dead_letter' : 'failed_initialization',
      terminal ? 1 : 0,
      backoff || '+10 minutes',
      safe.code,
      safe.message,
      claim.dispatchId,
      claim.attemptCount,
      claim.leaseToken,
      claim.leaseUntil
    );
    if (result.changes !== 1) {
      return { state: 'stale', dispatchId: claim.dispatchId };
    }
    return {
      state: terminal ? 'dead_letter' : 'failed_initialization',
      dispatchId: claim.dispatchId
    };
  }).immediate();
}

function processClaimedCampaignWorkflowDispatch(db, claim) {
  try {
    return initializeClaimedCampaignWorkflowDispatch(db, claim);
  } catch (error) {
    if (error instanceof CampaignWorkflowFenceLostError) {
      return { state: 'stale', dispatchId: claim && claim.dispatchId };
    }
    return recordInitializationFailure(db, claim, error);
  }
}

function createCampaignWorkflowWorker(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('A SQLite database is required');
  }
  const worker = {
    claimNext: () => claimNextCampaignWorkflowDispatch(db),
    heartbeat: (claim) => heartbeatCampaignWorkflowDispatch(db, claim),
    processClaim: (claim) => processClaimedCampaignWorkflowDispatch(db, claim),
    recoverExpiredFinal: () => recoverExpiredFinalDispatches(db),
    drain(options = {}) {
      const limit = Number.isSafeInteger(options.limit) && options.limit > 0
        ? Math.min(options.limit, CAMPAIGN_WORKFLOW_MAX_DRAIN)
        : CAMPAIGN_WORKFLOW_MAX_DRAIN;
      const outcomes = [];
      while (outcomes.length < limit) {
        const claim = worker.claimNext();
        if (!claim) break;
        outcomes.push(worker.processClaim(claim));
      }
      return {
        claimed: outcomes.length,
        completed: outcomes.filter((outcome) => outcome.state === 'completed').length,
        failed: outcomes.filter((outcome) => !['completed', 'stale'].includes(outcome.state)).length,
        outcomes
      };
    }
  };
  return Object.freeze(worker);
}

function startCampaignWorkflowDispatcher(db, options = {}) {
  const existing = CAMPAIGN_WORKFLOW_DISPATCHERS.get(db);
  if (existing) return existing;
  const worker = options.worker || createCampaignWorkflowWorker(db);
  const onError = typeof options.onError === 'function'
    ? options.onError
    : () => console.error('Campaign workflow dispatcher tick failed');
  const tick = () => {
    try {
      return worker.drain();
    } catch (_error) {
      onError();
      return null;
    }
  };
  const startupResult = tick();
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const timer = setIntervalFn(tick, CAMPAIGN_WORKFLOW_DRAIN_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  let stopped = false;
  let dispatcher;
  const stop = () => {
    if (stopped) return false;
    stopped = true;
    try {
      if (timer !== null && timer !== undefined) clearIntervalFn(timer);
    } finally {
      if (CAMPAIGN_WORKFLOW_DISPATCHERS.get(db) === dispatcher) {
        CAMPAIGN_WORKFLOW_DISPATCHERS.delete(db);
      }
    }
    return true;
  };
  dispatcher = Object.freeze({ worker, timer, startupResult, tick, stop });
  CAMPAIGN_WORKFLOW_DISPATCHERS.set(db, dispatcher);
  return dispatcher;
}

module.exports = Object.freeze({
  CAMPAIGN_WORKFLOW_DRAIN_MS,
  CAMPAIGN_WORKFLOW_HEARTBEAT_MS,
  CAMPAIGN_WORKFLOW_LEASE_SECONDS,
  CampaignWorkflowServiceError,
  CampaignWorkflowValidationError,
  buildCampaignWorkflowSnapshot,
  checksumCampaignWorkflowSnapshot,
  createCampaignWorkflowService,
  createCampaignWorkflowWorker,
  createLifecycleDispatchesInTransaction,
  evaluateCampaignWorkflowCondition,
  heartbeatCampaignWorkflowDispatch,
  initializeClaimedCampaignWorkflowDispatch,
  isAdjacentLifecycleTransition,
  recoverExpiredFinalDispatches,
  startCampaignWorkflowDispatcher,
  validateCampaignWorkflowSnapshot,
  validationReason,
  workflowDispatchSummary
});
