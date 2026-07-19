'use strict';

const BODY_LIMITS = Object.freeze({
  CAMPAIGN_CONTROL_JSON: 65_536,
  CAMPAIGN_REVIEW_JSON: 1_048_576,
  EXISTING_DUAL_MODE_JSON: 52_428_800,
  MULTIPART_ENVELOPE: 22_020_096
});

const MULTIPART_LIMITS = Object.freeze({
  fileBytes: 15_728_640,
  files: 1,
  fields: 20,
  parts: 25,
  fieldBytes: 262_144
});

const MEDIA_KINDS = Object.freeze({
  EMPTY: 'empty',
  JSON: 'json',
  MULTIPART: 'multipart'
});

function definePolicy(id, method, pathTemplate, mediaKind, maxRawBytes, options = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new TypeError(`Invalid request policy id: ${id}`);
  }
  if (!/^(?:DELETE|GET|HEAD|PATCH|POST|PUT)$/.test(method)) {
    throw new TypeError(`Invalid request policy method: ${method}`);
  }
  if (typeof pathTemplate !== 'string' || !pathTemplate.startsWith('/api/')) {
    throw new TypeError(`Invalid request policy path: ${pathTemplate}`);
  }
  if (!Object.values(MEDIA_KINDS).includes(mediaKind)) {
    throw new TypeError(`Invalid request policy media kind: ${mediaKind}`);
  }
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes < 0) {
    throw new TypeError(`Invalid request policy byte limit: ${maxRawBytes}`);
  }

  return Object.freeze({
    id,
    method,
    pathTemplate,
    mediaKind,
    maxRawBytes,
    multipartLimits: mediaKind === MEDIA_KINDS.MULTIPART ? MULTIPART_LIMITS : null,
    admission: options.admission || null
  });
}

const controlJson = (id, method, pathTemplate) => definePolicy(
  id,
  method,
  pathTemplate,
  MEDIA_KINDS.JSON,
  BODY_LIMITS.CAMPAIGN_CONTROL_JSON
);
const existingJson = (id, method, pathTemplate) => definePolicy(
  id,
  method,
  pathTemplate,
  MEDIA_KINDS.JSON,
  BODY_LIMITS.EXISTING_DUAL_MODE_JSON
);
const empty = (id, method, pathTemplate) => definePolicy(
  id,
  method,
  pathTemplate,
  MEDIA_KINDS.EMPTY,
  0
);
const multipart = (id, pathTemplate, admission) => definePolicy(
  id,
  'POST',
  pathTemplate,
  MEDIA_KINDS.MULTIPART,
  BODY_LIMITS.MULTIPART_ENVELOPE,
  { admission }
);

const REQUEST_POLICIES = Object.freeze({
  CAMPAIGN_OPTIONS: empty('campaign.options', 'GET', '/api/campaigns/options'),
  CAMPAIGN_CREATE: controlJson('campaign.create', 'POST', '/api/campaigns'),
  CAMPAIGN_LIST: empty('campaign.list', 'GET', '/api/campaigns'),
  CAMPAIGN_DETAIL: empty('campaign.detail', 'GET', '/api/campaigns/:id'),
  CAMPAIGN_UPDATE: controlJson('campaign.update', 'PATCH', '/api/campaigns/:id'),
  CAMPAIGN_TRANSITION: controlJson(
    'campaign.transition',
    'POST',
    '/api/campaigns/:id/transitions'
  ),
  CAMPAIGN_OPERATIONAL_ACTION: controlJson(
    'campaign.operational',
    'POST',
    '/api/campaigns/:id/operational-actions'
  ),
  CAMPAIGN_TRANSFER: controlJson(
    'campaign.transfer',
    'POST',
    '/api/campaigns/:id/transfers'
  ),
  CAMPAIGN_LINK_ATTACH: controlJson(
    'campaign.link.attach',
    'POST',
    '/api/campaigns/:id/links'
  ),
  CAMPAIGN_LINK_CORRECT: controlJson(
    'campaign.link.correct',
    'POST',
    '/api/campaigns/:id/link-corrections'
  ),
  CAMPAIGN_LINK_CANDIDATES: empty(
    'campaign.link.candidates',
    'GET',
    '/api/campaigns/:id/link-candidates'
  ),
  CAMPAIGN_WORKSPACE: empty(
    'campaign.workspace',
    'GET',
    '/api/campaigns/:id/workspace'
  ),
  CAMPAIGN_KNOWLEDGE_LIST: empty(
    'campaign.knowledge.list',
    'GET',
    '/api/campaigns/:id/knowledge'
  ),
  CAMPAIGN_KNOWLEDGE_DETAIL: empty(
    'campaign.knowledge.detail',
    'GET',
    '/api/campaigns/:id/knowledge/:entryId'
  ),
  CAMPAIGN_REVIEW_CREATE: definePolicy(
    'campaign.review.create',
    'POST',
    '/api/campaigns/:id/reviews',
    MEDIA_KINDS.JSON,
    BODY_LIMITS.CAMPAIGN_REVIEW_JSON
  ),
  CAMPAIGN_WORKFLOW_RECONCILIATION_OPTIONS: empty(
    'campaign.workflow.reconciliation-options',
    'GET',
    '/api/campaigns/:id/workflow-reconciliation-options'
  ),
  CAMPAIGN_WORKFLOW_RETRY: controlJson(
    'campaign.workflow.retry',
    'POST',
    '/api/campaigns/:id/workflow-dispatches/:dispatchId/retry'
  ),
  CAMPAIGN_WORKFLOW_RECONCILE: controlJson(
    'campaign.workflow.reconcile',
    'POST',
    '/api/campaigns/:id/workflow-dispatches/:dispatchId/reconcile'
  ),
  CAMPAIGN_WORKFLOW_TASK_REASSIGN: controlJson(
    'campaign.workflow.task.reassign',
    'POST',
    '/api/campaigns/:id/workflow-tasks/:taskId/reassign'
  ),

  LEGACY_DEMAND_CREATE: existingJson('legacy.demand.create', 'POST', '/api/demands'),
  LEGACY_PROPOSAL_CREATE: existingJson('legacy.proposal.create', 'POST', '/api/proposals'),
  LEGACY_PPT_GENERATE: existingJson(
    'legacy.proposal.ppt.generate',
    'POST',
    '/api/proposal/generate-ppt'
  ),
  LEGACY_COLLABORATION_CREATE: existingJson(
    'legacy.collaboration.create',
    'POST',
    '/api/collaborations'
  ),
  LEGACY_COLLABORATION_UPDATE: existingJson(
    'legacy.collaboration.update',
    'PUT',
    '/api/collaborations/:id'
  ),
  LEGACY_KNOWLEDGE_CREATE: existingJson(
    'legacy.knowledge.create',
    'POST',
    '/api/knowledge'
  ),
  LEGACY_KNOWLEDGE_INGEST: existingJson(
    'legacy.knowledge.ingest',
    'POST',
    '/api/knowledge/ingest'
  ),
  KNOWLEDGE_USE: empty('knowledge.use', 'POST', '/api/knowledge/:id/use'),
  LEGACY_AI_CHAT: existingJson('legacy.ai.chat', 'POST', '/api/ai/chat'),

  SHARED_KNOWLEDGE_UPLOAD: multipart(
    'parser.knowledge-upload',
    '/api/knowledge/upload',
    'parser.knowledge-upload.admission'
  ),
  SHARED_INFLUENCER_UPLOAD: multipart(
    'parser.influencer-upload',
    '/api/influencers/upload',
    'parser.influencer-upload.admission'
  ),
  SHARED_DEMAND_PARSE_FILE: multipart(
    'parser.demand-parse',
    '/api/demand/parse-file',
    'parser.demand-parse.admission'
  ),

  CUSTOMER_DELETE: empty('customer.delete', 'DELETE', '/api/customers/:id'),
  OPPORTUNITY_DELETE: empty('opportunity.delete', 'DELETE', '/api/opportunities/:id'),

  WORKFLOW_TEMPLATE_CREATE: existingJson(
    'workflow.template.create',
    'POST',
    '/api/workflow/templates'
  ),
  WORKFLOW_TEMPLATE_UPDATE: existingJson(
    'workflow.template.update',
    'PUT',
    '/api/workflow/templates/:id'
  ),
  WORKFLOW_TEMPLATE_TRIGGER_GET: empty(
    'workflow.template.campaign-trigger.get',
    'GET',
    '/api/workflow/templates/:id/campaign-trigger'
  ),
  WORKFLOW_TEMPLATE_TRIGGER_UPDATE: existingJson(
    'workflow.template.campaign-trigger.update',
    'PUT',
    '/api/workflow/templates/:id/campaign-trigger'
  ),
  WORKFLOW_TEMPLATE_PUBLISH: existingJson(
    'workflow.template.publish',
    'POST',
    '/api/workflow/templates/:id/publish'
  ),
  WORKFLOW_TEMPLATE_DELETE: empty(
    'workflow.template.delete',
    'DELETE',
    '/api/workflow/templates/:id'
  ),
  WORKFLOW_TASK_APPROVE: existingJson(
    'workflow.task.approve',
    'POST',
    '/api/workflow/tasks/:id/approve'
  ),
  WORKFLOW_TASK_REJECT: existingJson(
    'workflow.task.reject',
    'POST',
    '/api/workflow/tasks/:id/reject'
  ),
  WORKFLOW_TASK_COMPLETE: existingJson(
    'workflow.task.complete',
    'POST',
    '/api/workflow/tasks/:id/complete'
  ),
  WORKFLOW_INSTANCE_PAUSE: existingJson(
    'workflow.instance.pause',
    'POST',
    '/api/workflow/instances/:id/pause'
  ),
  WORKFLOW_INSTANCE_RESUME: existingJson(
    'workflow.instance.resume',
    'POST',
    '/api/workflow/instances/:id/resume'
  ),
  WORKFLOW_INSTANCE_CANCEL: existingJson(
    'workflow.instance.cancel',
    'POST',
    '/api/workflow/instances/:id/cancel'
  )
});

const POLICY_GROUPS = Object.freeze({
  CAMPAIGN: Object.freeze(
    Object.keys(REQUEST_POLICIES).filter((name) => name.startsWith('CAMPAIGN_'))
  ),
  SHARED_PARSERS: Object.freeze([
    'SHARED_KNOWLEDGE_UPLOAD',
    'SHARED_INFLUENCER_UPLOAD',
    'SHARED_DEMAND_PARSE_FILE'
  ])
});

const POLICIES_BY_ID = new Map(
  Object.values(REQUEST_POLICIES).map((policy) => [policy.id, policy])
);

function isValidRequestId(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 8 || value.length > 120) return false;
  if (Buffer.byteLength(value, 'utf8') !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function isCanonicalSafeIntegerPathSegment(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value;
}

function requestPath(requestTarget) {
  if (typeof requestTarget !== 'string' || !requestTarget.startsWith('/')) return null;
  const query = requestTarget.indexOf('?');
  const fragment = requestTarget.indexOf('#');
  let end = requestTarget.length;
  if (query !== -1) end = Math.min(end, query);
  if (fragment !== -1) end = Math.min(end, fragment);
  return requestTarget.slice(0, end);
}

function pathTemplateMatches(pathTemplate, actualPath) {
  const expectedSegments = pathTemplate.split('/');
  const actualSegments = actualPath.split('/');
  if (expectedSegments.length !== actualSegments.length) return false;

  for (let index = 0; index < expectedSegments.length; index += 1) {
    const expected = expectedSegments[index];
    const actual = actualSegments[index];
    if (expected.startsWith(':')) {
      if (!isCanonicalSafeIntegerPathSegment(actual)) return false;
    } else if (expected !== actual) {
      return false;
    }
  }
  return true;
}

function resolvePolicy(policyOrName) {
  if (policyOrName && typeof policyOrName === 'object') return policyOrName;
  if (typeof policyOrName !== 'string') return null;
  return REQUEST_POLICIES[policyOrName] || POLICIES_BY_ID.get(policyOrName) || null;
}

function createRoutePolicyRegistry(initialPolicies = []) {
  const registeredById = new Map();
  const registered = [];

  function register(policyOrName) {
    const policy = resolvePolicy(policyOrName);
    if (!policy || !POLICIES_BY_ID.has(policy.id) || POLICIES_BY_ID.get(policy.id) !== policy) {
      throw new TypeError('Only frozen campaign request contract policies can be registered');
    }
    if (registeredById.has(policy.id)) {
      throw new Error(`Request policy already registered: ${policy.id}`);
    }
    if (registered.some((candidate) => (
      candidate.method === policy.method &&
      candidate.pathTemplate === policy.pathTemplate
    ))) {
      throw new Error(`Request route already registered: ${policy.method} ${policy.pathTemplate}`);
    }
    registeredById.set(policy.id, policy);
    registered.push(policy);
    return policy;
  }

  function registerMany(policies) {
    if (!Array.isArray(policies)) throw new TypeError('Request policies must be an array');
    return policies.map(register);
  }

  function match(method, requestTarget) {
    const normalizedMethod = String(method || '').toUpperCase();
    const actualPath = requestPath(requestTarget);
    if (!actualPath) return null;
    const methods = normalizedMethod === 'HEAD' ? ['HEAD', 'GET'] : [normalizedMethod];
    for (const candidateMethod of methods) {
      for (const policy of registered) {
        if (
          policy.method === candidateMethod &&
          pathTemplateMatches(policy.pathTemplate, actualPath)
        ) {
          return policy;
        }
      }
    }
    return null;
  }

  function isOwnedRoute(requestOrMethod, requestTarget) {
    if (requestOrMethod && typeof requestOrMethod === 'object') {
      return Boolean(match(
        requestOrMethod.method,
        requestOrMethod.originalUrl || requestOrMethod.url || requestOrMethod.path
      ));
    }
    return Boolean(match(requestOrMethod, requestTarget));
  }

  function list() {
    return registered.slice();
  }

  registerMany(initialPolicies);

  return Object.freeze({
    register,
    registerMany,
    match,
    isOwnedRoute,
    list
  });
}

function createOwnedRoutePredicate(registry) {
  if (!registry || typeof registry.isOwnedRoute !== 'function') {
    throw new TypeError('A route policy registry is required');
  }
  return function ownedRoutePredicate(request) {
    return registry.isOwnedRoute(request);
  };
}

module.exports = {
  BODY_LIMITS,
  MULTIPART_LIMITS,
  MEDIA_KINDS,
  REQUEST_POLICIES,
  POLICY_GROUPS,
  createRoutePolicyRegistry,
  createOwnedRoutePredicate,
  isCanonicalSafeIntegerPathSegment,
  isValidRequestId
};

