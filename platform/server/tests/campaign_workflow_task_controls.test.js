'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');

const Database = require('better-sqlite3');
const express = require('express');

const migrationService = require('../services/migration_service');
const campaignContract = require('../contracts/campaign_contract');
const { createPhase4RequestPipeline } = require('../middleware/phase4_request_pipeline');
const { createCampaignService } = require('../services/campaign_service');
const idempotency = require('../services/idempotency_service');
const { canonicalJsonBytes, requestHash } = require('../services/sqlite_digest_service');
const {
  checksumCampaignWorkflowSnapshot,
  createCampaignWorkflowService,
  createCampaignWorkflowWorker
} = require('../services/campaign_workflow_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 2,
    name: '002_campaign_business_spine',
    sourcePath: 'migrations/002_campaign_business_spine.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 3,
    name: '003_campaign_workflow_dispatch_evidence',
    sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);
const SHARED_POLICIES = Object.freeze([
  'WORKFLOW_TASK_APPROVE',
  'WORKFLOW_TASK_REJECT',
  'WORKFLOW_TASK_COMPLETE',
  'WORKFLOW_INSTANCE_PAUSE',
  'WORKFLOW_INSTANCE_RESUME',
  'WORKFLOW_INSTANCE_CANCEL'
]);

function openWorkflowDatabase() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  });
  return db;
}

function withTriggersDisabled(db, names, operation) {
  const definitions = names.map((name) => {
    const row = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?
    `).get(name);
    assert.ok(row && row.sql, `missing trigger ${name}`);
    return row.sql;
  });
  names.forEach((name) => db.exec(`DROP TRIGGER ${name}`));
  try {
    return operation();
  } finally {
    definitions.forEach((sql) => db.exec(sql));
  }
}

function loadWorkflowRoutes() {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    TM_DISABLE_DOTENV: process.env.TM_DISABLE_DOTENV,
    DB_PATH: process.env.DB_PATH
  };
  process.env.NODE_ENV = 'test';
  process.env.TM_DISABLE_DOTENV = '1';
  process.env.DB_PATH = ':memory:';
  try {
    return require('../routes_workflow');
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function workflowIdentity(db) {
  const row = db.prepare(`
    SELECT
      user.id AS userId,user.role AS platformRole,
      organization_membership.org_id AS orgId,
      organization_membership.role_code AS organizationRole,
      team_membership.team_id AS teamId,
      team_membership.role_code AS teamRole
    FROM users user
    JOIN organization_memberships organization_membership
      ON organization_membership.user_id=user.id
     AND organization_membership.status='active'
    JOIN team_memberships team_membership
      ON team_membership.user_id=user.id
     AND team_membership.org_id=organization_membership.org_id
     AND team_membership.status='active'
    WHERE user.is_active=1 AND user.role='admin'
    ORDER BY
      CASE WHEN organization_membership.role_code='org_admin' THEN 0 ELSE 1 END,
      user.id,team_membership.team_id
    LIMIT 1
  `).get();
  assert.ok(row);
  return row;
}

function otherActiveUser(db, identity) {
  const row = db.prepare(`
    SELECT user.id
    FROM users user
    JOIN organization_memberships membership
      ON membership.user_id=user.id AND membership.org_id=?
     AND membership.status='active'
    JOIN team_memberships team
      ON team.user_id=user.id AND team.org_id=membership.org_id
     AND team.status='active'
    WHERE user.is_active=1 AND user.id<>?
    ORDER BY user.id
    LIMIT 1
  `).get(identity.orgId, identity.userId);
  assert.ok(row);
  return row.id;
}

function trigger() {
  return {
    event_type: 'lifecycle_transition',
    previous_state: 'lead',
    next_state: 'qualified'
  };
}

function humanNode(id, type, config = {}) {
  return {
    id,
    type,
    label: id,
    config: {
      title: `${id} title`,
      description: `${id} description`,
      assignee_id: null,
      assignee_role: 'member',
      due_hours: null,
      ...config
    }
  };
}

function terminalGraph(type = 'approval', config = {}) {
  const action = type === 'approval' ? 'approve' : 'complete';
  const nodes = [
    { id: 'start', type: 'start', label: 'Start', config: {} },
    humanNode('human', type, config),
    { id: 'end', type: 'end', label: 'End', config: {} }
  ];
  const edges = [
    { id: 'start-next', from: 'start', to: 'human', outcome: 'next', priority: 0, condition: null },
    { id: `human-${action}`, from: 'human', to: 'end', outcome: action, priority: 0, condition: null }
  ];
  if (type === 'approval') {
    edges.push({ id: 'human-reject', from: 'human', to: 'end', outcome: 'reject', priority: 1, condition: null });
  }
  return { nodes, edges };
}

function continuationGraph(config = {}) {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Start', config: {} },
      humanNode('approval', 'approval', config.approval),
      { id: 'condition', type: 'condition', label: 'Condition', config: {} },
      humanNode('next-task', 'task', {
        assignee_role: 'member',
        due_hours: 2,
        ...(config.nextTask || {})
      }),
      { id: 'end', type: 'end', label: 'End', config: {} }
    ],
    edges: [
      { id: 'start-next', from: 'start', to: 'approval', outcome: 'next', priority: 0, condition: null },
      { id: 'approval-ok', from: 'approval', to: 'condition', outcome: 'approve', priority: 0, condition: null },
      { id: 'approval-no', from: 'approval', to: 'end', outcome: 'reject', priority: 1, condition: null },
      {
        id: 'condition-match',
        from: 'condition',
        to: 'next-task',
        outcome: 'match',
        priority: 0,
        condition: { op: 'eq', left: { var: 'task.action' }, right: 'approve' }
      },
      { id: 'condition-fallback', from: 'condition', to: 'end', outcome: 'fallback', priority: 1, condition: null },
      { id: 'next-complete', from: 'next-task', to: 'end', outcome: 'complete', priority: 0, condition: null }
    ]
  };
}

function conditionBudgetGraph(conditionCount) {
  const nodes = [
    { id: 'start', type: 'start', label: 'Start', config: {} },
    humanNode('approval', 'approval'),
    { id: 'end', type: 'end', label: 'End', config: {} }
  ];
  const edges = [
    { id: 'start-next', from: 'start', to: 'approval', outcome: 'next', priority: 0, condition: null },
    { id: 'approval-ok', from: 'approval', to: 'condition-001', outcome: 'approve', priority: 0, condition: null },
    { id: 'approval-no', from: 'approval', to: 'end', outcome: 'reject', priority: 1, condition: null }
  ];
  for (let index = 1; index <= conditionCount; index += 1) {
    const id = `condition-${String(index).padStart(3, '0')}`;
    const next = index === conditionCount
      ? 'end'
      : `condition-${String(index + 1).padStart(3, '0')}`;
    nodes.push({ id, type: 'condition', label: id, config: {} });
    edges.push({
      id: `${id}-match`,
      from: id,
      to: next,
      outcome: 'match',
      priority: 0,
      condition: { op: 'eq', left: { var: 'task.action' }, right: 'approve' }
    });
    edges.push({
      id: `${id}-fallback`,
      from: id,
      to: 'end',
      outcome: 'fallback',
      priority: 1,
      condition: null
    });
  }
  return { nodes, edges };
}

function rawSnapshotChecksum(snapshot) {
  const frame = (bytes) => {
    const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    return Buffer.concat([length, payload]);
  };
  return crypto.createHash('sha256').update(Buffer.concat([
    frame(Buffer.from('tm-workflow-snapshot-v1', 'utf8')),
    frame(canonicalJsonBytes(snapshot))
  ])).digest('hex');
}

function createCampaignFixture(db, identity, campaignId) {
  const customerId = campaignId + 1;
  const opportunityId = campaignId + 2;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (?,?,?,'qualified','test',?,?)
  `).run(
    customerId,
    `Task controls brand ${campaignId}`,
    `Task controls company ${campaignId}`,
    identity.userId,
    identity.userId
  );
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,
      channel_type,created_by
    ) VALUES (?,?,'Task controls opportunity','proposal',1000,50,'Workflow','influencer',?)
  `).run(opportunityId, customerId, identity.userId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,?,?,?,?,?,'lead','active',1)
  `).run(
    campaignId,
    identity.orgId,
    `Task controls campaign ${campaignId}`,
    customerId,
    opportunityId,
    identity.userId,
    identity.teamId
  );
  return { ...identity, campaignId, customerId, opportunityId };
}

function insertCampaignTemplate(db, identity, templateId, graph) {
  db.prepare(`
    INSERT INTO workflow_templates (
      id,name,description,module,category,nodes,edges,version,is_active,
      created_by,trigger_config_json
    ) VALUES (?,?,'Task 6C-2 fixture','campaign','approval',?,?,1,1,?,?)
  `).run(
    templateId,
    `Task controls template ${templateId}`,
    JSON.stringify(graph.nodes),
    JSON.stringify(graph.edges),
    identity.userId,
    JSON.stringify(trigger())
  );
}

function initializeFixture(db, identity, campaignId, templateId, graph) {
  const context = createCampaignFixture(db, identity, campaignId);
  insertCampaignTemplate(db, identity, templateId, graph);
  const transition = createCampaignService(db).transitionCampaign({
    userId: identity.userId,
    campaignId,
    requestId: `task6c2-transition-request-${campaignId}`,
    idempotencyKey: `task6c2-transition-${campaignId}`,
    body: {
      expected_state: 'lead',
      expected_version: 1,
      next_state: 'qualified',
      reason: 'Initialize Task 6C-2 workflow'
    }
  });
  assert.equal(transition.status, 200);
  assert.equal(createCampaignWorkflowWorker(db).drain().claimed, 1);
  const instance = db.prepare('SELECT * FROM workflow_instances WHERE campaign_id=?')
    .get(campaignId);
  const task = db.prepare('SELECT * FROM workflow_tasks WHERE instance_id=? ORDER BY id')
    .get(instance.id);
  const dispatch = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE campaign_id=?')
    .get(campaignId);
  assert.ok(instance && task && dispatch);
  db.prepare('UPDATE workflow_templates SET is_active=0 WHERE id=?').run(templateId);
  return { ...context, transition, instance, task, dispatch, templateId };
}

function taskInput(fixture, action, overrides = {}) {
  return {
    userId: fixture.userId,
    taskId: fixture.task.id,
    action,
    requestId: overrides.requestId || `task6c2-${action}-request`,
    idempotencyKey: overrides.idempotencyKey || `task6c2-${action}-${fixture.campaignId}`,
    body: overrides.body || {
      expected_status: 'pending',
      expected_assignment_version: fixture.task.assignment_version,
      ...(Object.hasOwn(overrides, 'comment') ? { comment: overrides.comment } : {})
    }
  };
}

function controlInput(fixture, action, expectedStatus, overrides = {}) {
  return {
    userId: fixture.userId,
    instanceId: fixture.instance.id,
    action,
    requestId: overrides.requestId || `task6c2-${action}-request`,
    idempotencyKey: overrides.idempotencyKey || `task6c2-${action}-${fixture.campaignId}`,
    body: overrides.body || {
      expected_status: expectedStatus,
      reason: overrides.reason || `Operator requested ${action}`
    }
  };
}

function outcomeError(error) {
  return {
    status: error.statusCode,
    code: error.code,
    message: error.message,
    details: error.details,
    retryAfterSeconds: error.retryAfterSeconds
  };
}

function callError(operation) {
  try {
    operation();
  } catch (error) {
    return outcomeError(error);
  }
  assert.fail('expected operation to throw');
}

function workflowEvidenceCounts(db, fixture) {
  return {
    tasks: db.prepare('SELECT COUNT(*) AS count FROM workflow_tasks WHERE instance_id=?')
      .get(fixture.instance.id).count,
    logs: db.prepare('SELECT COUNT(*) AS count FROM workflow_node_logs WHERE instance_id=?')
      .get(fixture.instance.id).count,
    activities: db.prepare(`
      SELECT COUNT(*) AS count FROM activity_log
      WHERE module='workflow' AND json_extract(details,'$.instance_id')=?
    `).get(fixture.instance.id).count,
    archives: db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE business_type='campaign' AND business_id=?
        AND source_type='campaign_workflow_log'
    `).get(String(fixture.campaignId)).count,
    knowledgeLinks: db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE campaign_id=? AND relation_type='knowledge' AND revoked_at IS NULL
    `).get(fixture.campaignId).count
  };
}

function sharedRouteOwner(db) {
  return (request, policy) => {
    if (!SHARED_POLICIES.some((name) => campaignContract.REQUEST_POLICIES[name] === policy)) {
      return true;
    }
    const url = new URL(request.originalUrl || request.url, 'http://phase4.local');
    const match = /^\/api\/workflow\/(tasks|instances)\/([^/]+)\/(approve|reject|complete|pause|resume|cancel)\/?$/i
      .exec(url.pathname);
    if (!match) return true;
    if (!/^[1-9][0-9]*$/.test(match[2]) || !Number.isSafeInteger(Number(match[2]))) {
      return true;
    }
    const id = Number(match[2]);
    const instance = match[1].toLowerCase() === 'tasks'
      ? db.prepare(`
          SELECT instance.*
          FROM workflow_tasks task
          JOIN workflow_instances instance ON instance.id=task.instance_id
          WHERE task.id=?
        `).get(id)
      : db.prepare('SELECT * FROM workflow_instances WHERE id=?').get(id);
    if (!instance) return false;
    return instance.org_id !== null || instance.campaign_id !== null ||
      instance.campaign_event_id !== null || instance.campaign_dispatch_id !== null ||
      instance.business_type === 'campaign' || Boolean(db.prepare(`
        SELECT 1 FROM campaign_record_links
        WHERE record_type='workflow_instance' AND relation_type='workflow'
          AND record_id=? AND revoked_at IS NULL
        LIMIT 1
      `).get(String(instance.id)));
  };
}

async function startWorkflowApi(db, actorUserId, options = {}) {
  const registry = campaignContract.createRoutePolicyRegistry(
    SHARED_POLICIES.map((name) => campaignContract.REQUEST_POLICIES[name])
  );
  const pipeline = createPhase4RequestPipeline({
    registry,
    shouldOwnRequest: options.shouldOwnRequest || sharedRouteOwner(db),
    authenticate(request) {
      if (request.headers.authorization !== 'Bearer task6c2-token') return null;
      const user = db.prepare(`
        SELECT id,username,display_name,role,department,is_active
        FROM users WHERE id=? AND is_active=1
      `).get(actorUserId);
      if (!user) return null;
      request.user = user;
      return { user };
    },
    generateRequestId: () => 'task6c2-generated-request'
  });
  const app = express();
  app.use(express.json({
    limit: '50mb',
    type(request) {
      const value = request.headers && request.headers['content-type'];
      return !pipeline.shouldSkipGlobalBodyParser(request) &&
        typeof value === 'string' && /^application\/json(?:\s*;|$)/i.test(value.trim());
    }
  }));
  app.use(pipeline.middleware);
  const authMiddleware = (request, response, next) => {
    if (request.user) return next();
    if (request.headers.authorization === 'Bearer task6c2-token') {
      request.user = db.prepare(`
        SELECT id,username,display_name,role,department,is_active
        FROM users WHERE id=? AND is_active=1
      `).get(actorUserId);
      if (request.user) return next();
    }
    return response.status(401).json({ error: 'Unauthorized' });
  };
  loadWorkflowRoutes()(app, db, authMiddleware, (_request, _response, next) => next());
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(requestPath, requestOptions = {}) {
      const headers = { 'X-Request-Id': requestOptions.requestId || 'task6c2-http-request' };
      if (requestOptions.auth !== false) headers.Authorization = 'Bearer task6c2-token';
      if (requestOptions.idempotencyKey) headers['Idempotency-Key'] = requestOptions.idempotencyKey;
      let body;
      if (Object.hasOwn(requestOptions, 'body')) {
        headers['Content-Type'] = requestOptions.contentType || 'application/json; charset=utf-8';
        body = requestOptions.rawBody === true
          ? String(requestOptions.body)
          : JSON.stringify(requestOptions.body);
      } else if (requestOptions.contentType) {
        headers['Content-Type'] = requestOptions.contentType;
      }
      const response = await fetch(baseUrl + requestPath, { method: 'POST', headers, body });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
        requestId: response.headers.get('x-request-id'),
        retryAfter: response.headers.get('retry-after')
      };
    },
    async close() {
      server.close();
      await once(server, 'close');
    }
  };
}

test('linked HTTP routes enforce auth-first IDs, media, closed bodies, key grammar, and server-owned action contracts', async () => {
  const db = openWorkflowDatabase();
  const identity = workflowIdentity(db);
  const fixture = initializeFixture(db, identity, 861001, 862001, terminalGraph('approval'));
  const api = await startWorkflowApi(db, identity.userId);
  try {
    const validBody = { expected_status: 'pending', expected_assignment_version: 1 };
    const noAuth = await api.request(`/api/workflow/tasks/${fixture.task.id}/approve`, {
      auth: false,
      idempotencyKey: 'task6c2-no-auth',
      body: validBody
    });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.code, 'AUTHENTICATION_REQUIRED');

    const invalidRequestId = await api.request(`/api/workflow/tasks/${fixture.task.id}/approve`, {
      requestId: 'short',
      idempotencyKey: 'task6c2-bad-request-id',
      body: validBody
    });
    assert.deepEqual(invalidRequestId, {
      status: 400,
      body: {
        error: 'Invalid X-Request-Id',
        code: 'INVALID_REQUEST_ID',
        request_id: 'task6c2-generated-request'
      },
      requestId: 'task6c2-generated-request',
      retryAfter: null
    });

    const invalidPath = await api.request('/api/workflow/tasks/01/approve', {
      idempotencyKey: 'task6c2-invalid-path',
      body: validBody
    });
    assert.equal(invalidPath.status, 400);
    assert.equal(invalidPath.body.code, 'INVALID_CAMPAIGN_INPUT');
    assert.equal(invalidPath.body.error, 'task_id is invalid.');
    assert.equal(invalidPath.requestId, 'task6c2-http-request');

    const wrongMedia = await api.request(`/api/workflow/tasks/${fixture.task.id}/approve`, {
      idempotencyKey: 'task6c2-wrong-media',
      contentType: 'text/plain',
      body: '{}',
      rawBody: true
    });
    assert.equal(wrongMedia.status, 415);
    assert.equal(wrongMedia.body.code, 'UNSUPPORTED_MEDIA_TYPE');

    for (const [name, body] of [
      ['missing-key', validBody],
      ['unknown-key', { ...validBody, source: 'caller' }],
      ['string-version', { ...validBody, expected_assignment_version: '1' }],
      ['wrong-status', { ...validBody, expected_status: 'active' }],
      ['bad-comment', { ...validBody, comment: 'bad\u0000comment' }],
      ['long-comment', { ...validBody, comment: '😀'.repeat(2001) }]
    ]) {
      const response = await api.request(`/api/workflow/tasks/${fixture.task.id}/approve`, {
        idempotencyKey: name === 'missing-key' ? undefined : `task6c2-${name}`,
        body
      });
      assert.equal(response.status, 400, name);
      assert.equal(
        response.body.code,
        name === 'missing-key' ? 'IDEMPOTENCY_REQUIRED' : 'INVALID_CAMPAIGN_INPUT',
        name
      );
    }

    const mismatch = await api.request(`/api/workflow/tasks/${fixture.task.id}/complete`, {
      idempotencyKey: 'task6c2-node-action-mismatch',
      body: validBody
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, 'WORKFLOW_TASK_ACTION_NOT_ALLOWED');

    const success = await api.request(`/api/workflow/tasks/${fixture.task.id}/approve`, {
      idempotencyKey: 'task6c2-http-success',
      body: { ...validBody, comment: '  Cafe\u0301\r\nkept  ' }
    });
    assert.equal(success.status, 200);
    assert.equal(success.requestId, 'task6c2-http-request');
    assert.equal(success.body.success, true);
    assert.equal(db.prepare('SELECT comment FROM workflow_tasks WHERE id=?').get(fixture.task.id).comment, '  Café\nkept  ');
  } finally {
    await api.close();
    db.close();
  }
});

test('approve, reject, and complete use pinned routes, retain exact responses, replay, and ordered evidence', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const cases = [
      ['approve', 863001, 864001, terminalGraph('approval'), 'completed'],
      ['reject', 863101, 864101, terminalGraph('approval'), 'rejected'],
      ['complete', 863201, 864201, terminalGraph('task'), 'completed']
    ];
    for (const [action, campaignId, templateId, graph, taskStatus] of cases) {
      const fixture = initializeFixture(db, identity, campaignId, templateId, graph);
      db.prepare("UPDATE workflow_templates SET nodes='[]',edges='[]',version=99 WHERE id=?")
        .run(templateId);
      const service = createCampaignWorkflowService(db);
      const input = taskInput(fixture, action, { comment: action === 'approve' ? undefined : ` ${action} reason ` });
      const result = service.actOnWorkflowTask(input);
      assert.deepEqual(result, {
        status: 200,
        body: {
          success: true,
          task_id: fixture.task.id,
          task_status: taskStatus,
          workflow_instance_id: fixture.instance.id,
          instance_status: 'completed',
          current_node_id: null,
          created_task_ids: []
        },
        headers: {}
      });
      assert.deepEqual(service.actOnWorkflowTask(input), result);
      const changedHash = callError(() => service.actOnWorkflowTask({
        ...input,
        body: { ...input.body, comment: `${action} changed` }
      }));
      assert.equal(changedHash.code, 'IDEMPOTENCY_KEY_REUSED');

      const task = db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(fixture.task.id);
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id=?').get(fixture.instance.id);
      assert.equal(task.status, taskStatus);
      assert.equal(task.completed_by, identity.userId);
      assert.ok(task.completed_at);
      assert.equal(instance.status, 'completed');
      assert.equal(instance.current_node_id, null);
      assert.ok(instance.completed_at);

      const logs = db.prepare(`
        SELECT id,node_id,action,details FROM workflow_node_logs
        WHERE instance_id=? ORDER BY id
      `).all(fixture.instance.id);
      assert.deepEqual(logs.slice(-2).map((row) => row.action), [
        `task_${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'completed'}`,
        'completed'
      ]);
      const mutation = JSON.parse(logs.at(-2).details);
      assert.deepEqual(Object.keys(mutation), [
        'source', 'action', 'task_id', 'assignment_version',
        'comment_sha256', 'comment_scalars'
      ]);
      assert.equal(mutation.source, 'workflow_task_action');
      assert.equal(mutation.action, action);

      const activity = db.prepare(`
        SELECT action,module,details FROM activity_log
        WHERE action='workflow_task_action'
          AND json_extract(details,'$.instance_id')=?
      `).get(fixture.instance.id);
      assert.equal(activity.module, 'workflow');
      assert.deepEqual(Object.keys(JSON.parse(activity.details)), [
        'source', 'campaign_id', 'dispatch_id', 'instance_id', 'task_id',
        'node_id', 'action', 'task_status', 'instance_status',
        'assignment_version', 'comment_sha256', 'comment_scalars'
      ]);
      const archive = db.prepare(`
        SELECT id,entry_type,title,content,source_type,source_id,visibility,tags_json
        FROM knowledge_entries
        WHERE business_type='campaign' AND business_id=?
          AND source_type='campaign_workflow_log'
      `).get(String(campaignId));
      assert.equal(archive.entry_type, 'campaign_workflow');
      assert.equal(archive.title, `Campaign workflow #${fixture.instance.id}`);
      assert.equal(String(archive.source_id), String(logs.at(-2).id));
      assert.equal(archive.visibility, 'team');
      assert.deepEqual(JSON.parse(archive.tags_json), ['campaign', 'workflow']);
      assert.deepEqual(Object.keys(JSON.parse(archive.content)), [
        'dispatch_id', 'instance_id', 'node_id', 'action', 'status', 'error_code'
      ]);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM campaign_record_links
        WHERE campaign_id=? AND record_type='knowledge_entry'
          AND record_id=? AND relation_type='knowledge' AND revoked_at IS NULL
      `).get(campaignId, String(archive.id)).count, 1);
      const ledger = db.prepare(`
        SELECT scope,state,status_code,response_json FROM request_idempotency
        WHERE idempotency_key=?
      `).get(input.idempotencyKey);
      assert.equal(ledger.scope, `workflow.campaign-task.${action}`);
      assert.equal(ledger.state, 'completed');
      assert.equal(ledger.status_code, 200);
      assert.deepEqual(JSON.parse(ledger.response_json), result.body);
    }
  } finally {
    db.close();
  }
});

test('continuation evaluates immutable context, creates a version-one task with deadline, and enforces assignment predicates', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const fixture = initializeFixture(db, identity, 865001, 866001, continuationGraph());
    db.prepare("UPDATE workflow_templates SET nodes='broken',edges='broken',version=101 WHERE id=?")
      .run(fixture.templateId);
    const service = createCampaignWorkflowService(db);
    const result = service.actOnWorkflowTask(taskInput(fixture, 'approve', {
      comment: 'Advance to the next task'
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.instance_status, 'active');
    assert.equal(result.body.current_node_id, 'next-task');
    assert.equal(result.body.created_task_ids.length, 1);
    const nextTask = db.prepare('SELECT * FROM workflow_tasks WHERE id=?')
      .get(result.body.created_task_ids[0]);
    assert.equal(nextTask.node_id, 'next-task');
    assert.equal(nextTask.status, 'pending');
    assert.equal(nextTask.assignment_version, 1);
    assert.equal(
      nextTask.due_at,
      db.prepare("SELECT datetime(?,'+2 hours') AS value").get(nextTask.created_at).value
    );
    const actionLogs = db.prepare(`
      SELECT action,details FROM workflow_node_logs
      WHERE instance_id=? ORDER BY id
    `).all(fixture.instance.id).slice(-3);
    assert.deepEqual(actionLogs.map((row) => row.action), [
      'task_approved', 'condition_evaluated', 'task_created'
    ]);
    assert.deepEqual(JSON.parse(actionLogs[1].details), {
      edge_id: 'condition-match',
      matched: true
    });
    assert.deepEqual(JSON.parse(actionLogs[2].details), { task_id: nextTask.id });

    const roles = ['platform_admin', 'org_admin', 'team_lead', 'member'];
    for (let index = 0; index < roles.length; index += 1) {
      const roleFixture = initializeFixture(
        db,
        identity,
        865101 + index * 10,
        866101 + index * 10,
        terminalGraph('task', { assignee_role: roles[index] })
      );
      const roleResult = createCampaignWorkflowService(db).actOnWorkflowTask(
        taskInput(roleFixture, 'complete')
      );
      assert.equal(roleResult.status, 200, roles[index]);
    }

    const deniedFixture = initializeFixture(
      db,
      identity,
      865201,
      866201,
      terminalGraph('task')
    );
    db.prepare(`
      UPDATE workflow_tasks
      SET assignee_id=?,assignee_role='org_admin',
          assignment_version=assignment_version+1
      WHERE id=?
    `).run(otherActiveUser(db, identity), deniedFixture.task.id);
    const denied = callError(() => createCampaignWorkflowService(db).actOnWorkflowTask(
      taskInput(deniedFixture, 'complete')
    ));
    assert.equal(denied.status, 403);
    assert.equal(denied.code, 'CAMPAIGN_FORBIDDEN');
    assert.equal(db.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(deniedFixture.task.id).status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM request_idempotency WHERE idempotency_key=?')
      .get(`task6c2-complete-${deniedFixture.campaignId}`).count, 0);
  } finally {
    db.close();
  }
});

test('continuation allows exactly 100 consecutive conditions and maps an attempted 101st condition to the lineage fingerprint', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const hundred = initializeFixture(
      db,
      identity,
      866501,
      866601,
      conditionBudgetGraph(100)
    );
    const success = createCampaignWorkflowService(db).actOnWorkflowTask(
      taskInput(hundred, 'approve')
    );
    assert.equal(success.status, 200);
    assert.equal(success.body.instance_status, 'completed');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_node_logs
      WHERE instance_id=? AND action='condition_evaluated'
    `).get(hundred.instance.id).count, 100);

    const hundredOne = initializeFixture(
      db,
      identity,
      866701,
      866801,
      conditionBudgetGraph(100)
    );
    const snapshot = JSON.parse(hundredOne.dispatch.template_snapshot_json);
    const lastMatch = snapshot.edges.find((edge) => edge.id === 'condition-100-match');
    lastMatch.to = 'condition-101';
    snapshot.nodes.push({
      id: 'condition-101',
      type: 'condition',
      label: 'condition-101',
      config: {}
    });
    snapshot.edges.push({
      id: 'condition-101-match',
      from: 'condition-101',
      to: 'end',
      outcome: 'match',
      priority: 0,
      condition: { op: 'eq', left: { var: 'task.action' }, right: 'approve' }
    });
    snapshot.edges.push({
      id: 'condition-101-fallback',
      from: 'condition-101',
      to: 'end',
      outcome: 'fallback',
      priority: 1,
      condition: null
    });
    const snapshotJson = canonicalJsonBytes(snapshot).toString('utf8');
    withTriggersDisabled(db, [
      'campaign_workflow_dispatches_immutable_evidence',
      'campaign_workflow_dispatches_legal_transition'
    ], () => {
      db.prepare(`
        UPDATE campaign_workflow_dispatches
        SET template_snapshot_json=?,template_checksum=?
        WHERE id=?
      `).run(snapshotJson, rawSnapshotChecksum(snapshot), hundredOne.dispatch.id);
    });
    const failure = createCampaignWorkflowService(db).actOnWorkflowTask(
      taskInput(hundredOne, 'approve')
    );
    assert.equal(failure.status, 409);
    assert.deepEqual(failure.body.details, { reason: 'WORKFLOW_LINEAGE_INVALID' });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_node_logs
      WHERE instance_id=? AND action='condition_evaluated'
    `).get(hundredOne.instance.id).count, 0);
  } finally {
    db.close();
  }
});

test('authorization and operational checks precede replay while stale and live-processing dispositions are retained safely', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const fixture = initializeFixture(db, identity, 867001, 868001, terminalGraph('task'));
    const input = taskInput(fixture, 'complete');
    const service = createCampaignWorkflowService(db);
    assert.equal(service.actOnWorkflowTask(input).status, 200);
    db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(identity.userId);
    const revokedReplay = callError(() => service.actOnWorkflowTask(input));
    assert.equal(revokedReplay.status, 404);
    db.prepare('UPDATE users SET is_active=1 WHERE id=?').run(identity.userId);

    const staleFixture = initializeFixture(db, identity, 867101, 868101, terminalGraph('task'));
    const staleService = createCampaignWorkflowService(db, {
      transactionBoundaryProbe(event) {
        if (event === 'task.before_write') {
          db.prepare("UPDATE workflow_tasks SET status='completed' WHERE id=?")
            .run(staleFixture.task.id);
        }
      }
    });
    const stale = staleService.actOnWorkflowTask(taskInput(staleFixture, 'complete'));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'STALE_WORKFLOW_TASK_ACTION');
    assert.deepEqual(stale.body.details, {
      task_status: 'completed',
      instance_status: 'active',
      campaign_operational_status: 'active'
    });

    const heldFixture = initializeFixture(db, identity, 867201, 868201, terminalGraph('task'));
    db.prepare("UPDATE campaigns SET operational_status='on_hold' WHERE id=?")
      .run(heldFixture.campaignId);
    const held = callError(() => createCampaignWorkflowService(db).actOnWorkflowTask(
      taskInput(heldFixture, 'complete')
    ));
    assert.equal(held.code, 'CAMPAIGN_ON_HOLD');
    db.prepare("UPDATE campaigns SET operational_status='cancelled' WHERE id=?")
      .run(heldFixture.campaignId);
    const cancelled = callError(() => createCampaignWorkflowService(db).actOnWorkflowTask(
      taskInput(heldFixture, 'complete', { idempotencyKey: 'task6c2-cancel-precedence' })
    ));
    assert.equal(cancelled.code, 'CAMPAIGN_CANCELLED');

    const processingFixture = initializeFixture(db, identity, 867301, 868301, terminalGraph('task'));
    const processingInput = taskInput(processingFixture, 'complete');
    const processingHash = requestHash({
      method: 'POST',
      path: `/api/workflow/tasks/${processingFixture.task.id}/complete`,
      campaignId: processingFixture.campaignId,
      kind: 'json',
      payload: { ...processingInput.body, comment: '' }
    });
    db.transaction(() => idempotency.reserveProcessingInTransaction(db, {
      organizationId: identity.orgId,
      actorUserId: identity.userId,
      campaignId: processingFixture.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'workflow.campaign-task.complete',
      key: processingInput.idempotencyKey,
      requestHash: processingHash,
      expectedEventCount: 0,
      operationTimeoutSeconds: 60
    })).immediate();
    const processing = callError(() => createCampaignWorkflowService(db).actOnWorkflowTask(processingInput));
    assert.equal(processing.code, 'IDEMPOTENCY_IN_PROGRESS');
    assert.ok(processing.retryAfterSeconds >= 1);
  } finally {
    db.close();
  }
});

test('guarded snapshot, checksum, context, lineage, and assignment failures terminalize atomically with closed fingerprints', () => {
  const cases = [
    ['WORKFLOW_SNAPSHOT_INVALID', (db, fixture) => {
      db.prepare('UPDATE campaign_workflow_dispatches SET template_snapshot_json=? WHERE id=?')
        .run(JSON.stringify(JSON.parse(fixture.dispatch.template_snapshot_json), null, 1), fixture.dispatch.id);
    }],
    ['WORKFLOW_SNAPSHOT_CHECKSUM_MISMATCH', (db, fixture) => {
      db.prepare('UPDATE campaign_workflow_dispatches SET template_checksum=? WHERE id=?')
        .run('0'.repeat(64), fixture.dispatch.id);
    }],
    ['WORKFLOW_CONTEXT_INVALID', (db, fixture) => {
      db.prepare('UPDATE campaign_workflow_dispatches SET execution_context_json=? WHERE id=?')
        .run(JSON.stringify(JSON.parse(fixture.dispatch.execution_context_json), null, 1), fixture.dispatch.id);
    }],
    ['WORKFLOW_LINEAGE_INVALID', (db, fixture) => {
      db.prepare("UPDATE workflow_instances SET current_node_id='impossible-node' WHERE id=?")
        .run(fixture.instance.id);
    }],
    ['WORKFLOW_ASSIGNMENT_UNRESOLVABLE', (db, fixture) => {
      const snapshot = JSON.parse(fixture.dispatch.template_snapshot_json);
      const nextTask = snapshot.nodes.find((node) => node.id === 'next-task');
      nextTask.config.assignee_id = Number.MAX_SAFE_INTEGER;
      nextTask.config.assignee_role = 'member';
      const snapshotJson = JSON.stringify(snapshot);
      db.prepare(`
        UPDATE campaign_workflow_dispatches
        SET template_snapshot_json=?,template_checksum=?
        WHERE id=?
      `).run(snapshotJson, checksumCampaignWorkflowSnapshot(snapshot), fixture.dispatch.id);
    }]
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const [reason, corrupt] = cases[index];
      const fixture = initializeFixture(
        db,
        identity,
        869001 + index * 10,
        870001 + index * 10,
        reason === 'WORKFLOW_ASSIGNMENT_UNRESOLVABLE'
          ? continuationGraph()
          : terminalGraph('task')
      );
      const before = workflowEvidenceCounts(db, fixture);
      if (reason === 'WORKFLOW_LINEAGE_INVALID') {
        corrupt(db, fixture);
      } else {
        withTriggersDisabled(db, [
          'campaign_workflow_dispatches_immutable_evidence',
          'campaign_workflow_dispatches_legal_transition'
        ], () => corrupt(db, fixture));
      }
      const input = taskInput(fixture, 'complete');
      if (reason === 'WORKFLOW_ASSIGNMENT_UNRESOLVABLE') input.action = 'approve';
      const result = createCampaignWorkflowService(db).actOnWorkflowTask(input);
      assert.equal(result.status, 409, reason);
      assert.deepEqual(result.body, {
        error: 'Campaign workflow template is invalid.',
        code: 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE',
        request_id: input.requestId,
        details: { reason }
      });
      assert.deepEqual(createCampaignWorkflowService(db).actOnWorkflowTask(input), result);
      const task = db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(fixture.task.id);
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id=?').get(fixture.instance.id);
      assert.equal(task.status, 'cancelled');
      assert.equal(instance.status, 'failed_validation');
      assert.equal(instance.execution_error_code, reason);
      assert.equal(instance.execution_error, {
        WORKFLOW_SNAPSHOT_INVALID: 'Stored workflow snapshot is invalid',
        WORKFLOW_SNAPSHOT_CHECKSUM_MISMATCH: 'Stored workflow snapshot checksum is invalid',
        WORKFLOW_CONTEXT_INVALID: 'Stored workflow context is invalid',
        WORKFLOW_LINEAGE_INVALID: 'Workflow dispatch lineage is invalid',
        WORKFLOW_ASSIGNMENT_UNRESOLVABLE: 'No eligible actor for workflow task'
      }[reason]);
      assert.ok(instance.execution_failed_at);
      const after = workflowEvidenceCounts(db, fixture);
      assert.equal(after.tasks, before.tasks);
      assert.equal(after.logs, before.logs + 1);
      assert.equal(after.activities, before.activities + 1);
      assert.equal(after.archives, before.archives + 1);
      assert.equal(after.knowledgeLinks, before.knowledgeLinks + 1);
      const failureLog = db.prepare(`
        SELECT * FROM workflow_node_logs WHERE instance_id=? ORDER BY id DESC LIMIT 1
      `).get(fixture.instance.id);
      assert.equal(failureLog.action, 'failed_validation');
      assert.deepEqual(JSON.parse(failureLog.details), {
        source: 'workflow_task_action',
        action: input.action,
        task_id: fixture.task.id,
        error_code: reason
      });
    } finally {
      db.close();
    }
  }
});

test('guarded validation failure loses its lease without mutating workflow or masking the winner disposition', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const fixture = initializeFixture(db, identity, 870101, 870201, terminalGraph('task'));
    withTriggersDisabled(db, [
      'campaign_workflow_dispatches_immutable_evidence',
      'campaign_workflow_dispatches_legal_transition'
    ], () => {
      db.prepare('UPDATE campaign_workflow_dispatches SET template_checksum=? WHERE id=?')
        .run('0'.repeat(64), fixture.dispatch.id);
    });
    const input = taskInput(fixture, 'complete');
    const before = workflowEvidenceCounts(db, fixture);
    const winnerToken = 'f'.repeat(64);
    const service = createCampaignWorkflowService(db, {
      transactionBoundaryProbe(event, details) {
        if (event === 'task.before_guarded_failure') {
          const update = db.prepare(`
            UPDATE request_idempotency SET lease_token=?
            WHERE id=? AND state='processing'
          `).run(winnerToken, details.ledgerId);
          assert.equal(update.changes, 1);
        }
      }
    });

    const lost = withTriggersDisabled(db, [
      'request_idempotency_legal_transition'
    ], () => callError(() => service.actOnWorkflowTask(input)));
    assert.equal(lost.status, 409);
    assert.equal(lost.code, 'IDEMPOTENCY_IN_PROGRESS');
    assert.equal(
      db.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(fixture.task.id).status,
      'pending'
    );
    assert.equal(
      db.prepare('SELECT status FROM workflow_instances WHERE id=?').get(fixture.instance.id).status,
      'active'
    );
    assert.deepEqual(workflowEvidenceCounts(db, fixture), before);
    const ledger = db.prepare(`
      SELECT state,lease_token,status_code,response_json FROM request_idempotency
      WHERE idempotency_key=?
    `).get(input.idempotencyKey);
    assert.equal(ledger.state, 'processing');
    assert.equal(ledger.lease_token, winnerToken);
    assert.equal(ledger.status_code, null);
    assert.equal(ledger.response_json, null);
  } finally {
    db.close();
  }
});

test('guarded validation failure retains stale when an intervening winner changes the current node', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const fixture = initializeFixture(db, identity, 870301, 870401, terminalGraph('task'));
    withTriggersDisabled(db, [
      'campaign_workflow_dispatches_immutable_evidence',
      'campaign_workflow_dispatches_legal_transition'
    ], () => {
      db.prepare('UPDATE campaign_workflow_dispatches SET template_checksum=? WHERE id=?')
        .run('0'.repeat(64), fixture.dispatch.id);
    });
    const input = taskInput(fixture, 'complete');
    const before = workflowEvidenceCounts(db, fixture);
    const winnerNodeId = 'winner-current-node';
    const service = createCampaignWorkflowService(db, {
      transactionBoundaryProbe(event) {
        if (event === 'task.before_guarded_failure') {
          const update = db.prepare(`
            UPDATE workflow_instances SET current_node_id=?
            WHERE id=? AND status='active'
          `).run(winnerNodeId, fixture.instance.id);
          assert.equal(update.changes, 1);
        }
      }
    });

    const result = service.actOnWorkflowTask(input);

    assert.deepEqual(result, {
      status: 409,
      body: {
        error: 'Workflow task action is stale.',
        code: 'STALE_WORKFLOW_TASK_ACTION',
        request_id: input.requestId,
        details: {
          task_status: 'pending',
          instance_status: 'active',
          campaign_operational_status: 'active'
        }
      },
      headers: {}
    });
    const instance = db.prepare(`
      SELECT status,current_node_id,execution_error_code,execution_error,execution_failed_at
      FROM workflow_instances WHERE id=?
    `).get(fixture.instance.id);
    assert.deepEqual(instance, {
      status: 'active',
      current_node_id: winnerNodeId,
      execution_error_code: null,
      execution_error: null,
      execution_failed_at: null
    });
    assert.equal(
      db.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(fixture.task.id).status,
      'pending'
    );
    assert.deepEqual(workflowEvidenceCounts(db, fixture), before);
    const ledger = db.prepare(`
      SELECT state,status_code,response_json FROM request_idempotency
      WHERE idempotency_key=?
    `).get(input.idempotencyKey);
    assert.equal(ledger.state, 'completed');
    assert.equal(ledger.status_code, 409);
    assert.deepEqual(JSON.parse(ledger.response_json), result.body);
  } finally {
    db.close();
  }
});

test('guarded validation failure reapplies assignment and access after demotion, transfer, and revocation', () => {
  const cases = [
    {
      label: 'organization-role demotion',
      graph: terminalGraph('task', { assignee_role: 'org_admin' }),
      expectedStatus: 403,
      expectedCode: 'CAMPAIGN_FORBIDDEN',
      intervene(db, fixture) {
        const update = db.prepare(`
          UPDATE organization_memberships SET role_code='member'
          WHERE org_id=? AND user_id=? AND role_code='org_admin' AND status='active'
        `).run(fixture.orgId, fixture.userId);
        assert.equal(update.changes, 1);
      },
      assertWinner(db, fixture) {
        assert.equal(db.prepare(`
          SELECT role_code FROM organization_memberships WHERE org_id=? AND user_id=?
        `).get(fixture.orgId, fixture.userId).role_code, 'member');
      }
    },
    {
      label: 'campaign team transfer',
      graph: terminalGraph('task', { assignee_role: 'member' }),
      expectedStatus: 403,
      expectedCode: 'CAMPAIGN_FORBIDDEN',
      intervene(db, fixture) {
        const nextTeamId = db.prepare('SELECT COALESCE(MAX(id),0)+1000 AS id FROM teams').get().id;
        const nextOwnerId = otherActiveUser(db, fixture);
        db.prepare('INSERT INTO teams (id,org_id,code,name) VALUES (?,?,?,?)').run(
          nextTeamId,
          fixture.orgId,
          `task6c2-transfer-${fixture.campaignId}`,
          `Task 6C-2 transferred team ${fixture.campaignId}`
        );
        db.prepare(`
          INSERT INTO team_memberships (org_id,team_id,user_id,role_code)
          VALUES (?,?,?,'member')
        `).run(fixture.orgId, nextTeamId, nextOwnerId);
        db.prepare('UPDATE campaigns SET owner_user_id=?,team_id=? WHERE id=?')
          .run(nextOwnerId, nextTeamId, fixture.campaignId);
        fixture.winnerTeamId = nextTeamId;
        fixture.winnerOwnerId = nextOwnerId;
      },
      assertWinner(db, fixture) {
        assert.deepEqual(
          db.prepare('SELECT owner_user_id,team_id FROM campaigns WHERE id=?').get(fixture.campaignId),
          { owner_user_id: fixture.winnerOwnerId, team_id: fixture.winnerTeamId }
        );
      }
    },
    {
      label: 'organization membership revocation',
      graph: terminalGraph('task', { assignee_role: 'member' }),
      expectedStatus: 404,
      expectedCode: 'CAMPAIGN_NOT_FOUND',
      intervene(db, fixture) {
        const update = db.prepare(`
          UPDATE organization_memberships
          SET status='revoked',revoked_at=CURRENT_TIMESTAMP
          WHERE org_id=? AND user_id=? AND status='active'
        `).run(fixture.orgId, fixture.userId);
        assert.equal(update.changes, 1);
      },
      assertWinner(db, fixture) {
        const membership = db.prepare(`
          SELECT status,revoked_at FROM organization_memberships
          WHERE org_id=? AND user_id=?
        `).get(fixture.orgId, fixture.userId);
        assert.equal(membership.status, 'revoked');
        assert.ok(membership.revoked_at);
      }
    }
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const scenario = cases[index];
      const fixture = initializeFixture(
        db,
        identity,
        870501 + index * 10,
        870601 + index * 10,
        scenario.graph
      );
      withTriggersDisabled(db, [
        'campaign_workflow_dispatches_immutable_evidence',
        'campaign_workflow_dispatches_legal_transition'
      ], () => {
        db.prepare('UPDATE campaign_workflow_dispatches SET template_checksum=? WHERE id=?')
          .run('0'.repeat(64), fixture.dispatch.id);
      });
      const input = taskInput(fixture, 'complete');
      const before = workflowEvidenceCounts(db, fixture);
      const service = createCampaignWorkflowService(db, {
        transactionBoundaryProbe(event) {
          if (event === 'task.before_guarded_failure') scenario.intervene(db, fixture);
        }
      });

      const denied = callError(() => service.actOnWorkflowTask(input));

      assert.equal(
        denied.status,
        scenario.expectedStatus,
        `${scenario.label}: ${JSON.stringify(denied)}`
      );
      assert.equal(denied.code, scenario.expectedCode, scenario.label);
      assert.equal(
        db.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(fixture.task.id).status,
        'pending',
        scenario.label
      );
      const instance = db.prepare(`
        SELECT status,current_node_id,execution_error_code,execution_error,execution_failed_at
        FROM workflow_instances WHERE id=?
      `).get(fixture.instance.id);
      assert.deepEqual(instance, {
        status: 'active',
        current_node_id: fixture.instance.current_node_id,
        execution_error_code: null,
        execution_error: null,
        execution_failed_at: null
      }, scenario.label);
      scenario.assertWinner(db, fixture);
      assert.deepEqual(workflowEvidenceCounts(db, fixture), before, scenario.label);
      const ledger = db.prepare(`
        SELECT state,lease_token,status_code,response_json FROM request_idempotency
        WHERE idempotency_key=?
      `).get(input.idempotencyKey);
      assert.deepEqual(ledger, {
        state: 'failed',
        lease_token: null,
        status_code: null,
        response_json: null
      }, scenario.label);
    } finally {
      db.close();
    }
  }
});

test('pause, resume, and cancel preserve frozen fields, cancel pending tasks, replay, and emit exact control evidence', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const fixture = initializeFixture(db, identity, 871001, 872001, terminalGraph('task'));
    const service = createCampaignWorkflowService(db);
    const pauseInput = controlInput(fixture, 'pause', 'active', { reason: ' Pause\r\nnow ' });
    const paused = service.controlWorkflowInstance(pauseInput);
    assert.deepEqual(paused, {
      status: 200,
      body: { success: true, instance_id: fixture.instance.id, status: 'paused' },
      headers: {}
    });
    assert.deepEqual(service.controlWorkflowInstance(pauseInput), paused);
    fixture.instance.status = 'paused';
    const resumed = service.controlWorkflowInstance(controlInput(fixture, 'resume', 'paused'));
    assert.equal(resumed.body.status, 'active');
    fixture.instance.status = 'active';

    const beforeInstance = db.prepare('SELECT * FROM workflow_instances WHERE id=?').get(fixture.instance.id);
    const beforeTask = db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(fixture.task.id);
    const cancelled = service.controlWorkflowInstance(controlInput(fixture, 'cancel', 'active'));
    assert.deepEqual(cancelled.body, {
      success: true,
      instance_id: fixture.instance.id,
      status: 'cancelled'
    });
    const afterInstance = db.prepare('SELECT * FROM workflow_instances WHERE id=?').get(fixture.instance.id);
    const afterTask = db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(fixture.task.id);
    assert.equal(afterInstance.status, 'cancelled');
    assert.equal(afterTask.status, 'cancelled');
    for (const key of Object.keys(beforeInstance)) {
      if (key !== 'status') assert.deepEqual(afterInstance[key], beforeInstance[key], `instance.${key}`);
    }
    for (const key of Object.keys(beforeTask)) {
      if (key !== 'status') assert.deepEqual(afterTask[key], beforeTask[key], `task.${key}`);
    }

    const logs = db.prepare(`
      SELECT id,node_id,action,details FROM workflow_node_logs
      WHERE instance_id=? AND action LIKE 'instance_%' ORDER BY id
    `).all(fixture.instance.id);
    assert.deepEqual(logs.map((row) => row.action), [
      'instance_paused', 'instance_resumed', 'instance_cancelled'
    ]);
    assert.ok(logs.every((row) => row.node_id === beforeInstance.current_node_id));
    const cancelDetails = JSON.parse(logs.at(-1).details);
    assert.deepEqual(Object.keys(cancelDetails), [
      'source', 'action', 'instance_id', 'previous_status', 'status',
      'reason_sha256', 'reason_scalars'
    ]);
    const activity = db.prepare(`
      SELECT details FROM activity_log
      WHERE action='workflow_instance_control'
        AND json_extract(details,'$.instance_id')=?
      ORDER BY id DESC LIMIT 1
    `).get(fixture.instance.id);
    assert.deepEqual(Object.keys(JSON.parse(activity.details)), [
      'source', 'campaign_id', 'dispatch_id', 'instance_id', 'node_id',
      'action', 'previous_status', 'status', 'reason', 'reason_sha256',
      'reason_scalars'
    ]);

    const staleFixture = initializeFixture(db, identity, 871101, 872101, terminalGraph('task'));
    const stale = createCampaignWorkflowService(db, {
      transactionBoundaryProbe(event) {
        if (event === 'instance.before_write') {
          db.prepare("UPDATE workflow_instances SET status='paused' WHERE id=?")
            .run(staleFixture.instance.id);
        }
      }
    }).controlWorkflowInstance(controlInput(staleFixture, 'pause', 'active'));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'STALE_WORKFLOW_INSTANCE_STATUS');
    assert.deepEqual(stale.body.details, {
      instance_status: 'paused',
      campaign_operational_status: 'active'
    });
  } finally {
    db.close();
  }
});

test('instance controls reject inconsistent reconciliation dispatch lineage before mutation and retain the deterministic error', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const fixture = initializeFixture(db, identity, 872201, 872301, terminalGraph('task'));
    withTriggersDisabled(db, [
      'campaign_workflow_dispatches_immutable_evidence',
      'campaign_workflow_dispatches_legal_transition'
    ], () => {
      db.pragma('ignore_check_constraints = ON');
      try {
        db.prepare(`
          UPDATE campaign_workflow_dispatches
          SET reconciles_dispatch_id=id
          WHERE id=?
        `).run(fixture.dispatch.id);
      } finally {
        db.pragma('ignore_check_constraints = OFF');
      }
    });

    const before = workflowEvidenceCounts(db, fixture);
    const input = controlInput(fixture, 'pause', 'active');
    const result = createCampaignWorkflowService(db).controlWorkflowInstance(input);

    assert.deepEqual(result, {
      status: 409,
      body: {
        error: 'Campaign workflow template is invalid.',
        code: 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE',
        request_id: input.requestId,
        details: { reason: 'WORKFLOW_LINEAGE_INVALID' }
      },
      headers: {}
    });
    assert.equal(
      db.prepare('SELECT status FROM workflow_instances WHERE id=?').get(fixture.instance.id).status,
      'active'
    );
    assert.deepEqual(workflowEvidenceCounts(db, fixture), before);
    const ledger = db.prepare(`
      SELECT state,status_code,response_json FROM request_idempotency
      WHERE idempotency_key=?
    `).get(input.idempotencyKey);
    assert.equal(ledger.state, 'completed');
    assert.equal(ledger.status_code, 409);
    assert.deepEqual(JSON.parse(ledger.response_json), result.body);
  } finally {
    db.close();
  }
});

test('log, activity, archive, link, and ledger failures roll back business state and retain only safe deterministic errors', () => {
  const injections = [
    ['workflow_node_logs', 'log'],
    ['activity_log', 'activity'],
    ['campaign_record_links', 'link'],
    ['request_idempotency', 'ledger']
  ];
  for (let index = 0; index < injections.length; index += 1) {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const fixture = initializeFixture(
        db,
        identity,
        873001 + index * 10,
        874001 + index * 10,
        terminalGraph('task')
      );
      const [table, label] = injections[index];
      const triggerName = `task6c2_injected_${label}_failure`;
      const when = table === 'request_idempotency'
        ? "BEFORE UPDATE ON request_idempotency WHEN OLD.scope='workflow.campaign-task.complete'"
        : `BEFORE INSERT ON ${table}`;
      db.exec(`
        CREATE TEMP TRIGGER ${triggerName}
        ${when}
        BEGIN SELECT RAISE(ABORT,'injected ${label} sqlite secret'); END
      `);
      const input = taskInput(fixture, 'complete');
      const result = createCampaignWorkflowService(db).actOnWorkflowTask(input);
      db.exec(`DROP TRIGGER ${triggerName}`);
      assert.equal(result.status, 500, label);
      assert.deepEqual(result.body, {
        error: 'Campaign workflow task action could not be persisted safely.',
        code: 'AUDIT_PERSISTENCE_FAILED',
        request_id: input.requestId
      });
      assert.equal(JSON.stringify(result).includes('sqlite secret'), false);
      assert.equal(db.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(fixture.task.id).status, 'pending');
      assert.equal(db.prepare('SELECT status FROM workflow_instances WHERE id=?').get(fixture.instance.id).status, 'active');
      const ledger = db.prepare('SELECT * FROM request_idempotency WHERE idempotency_key=?')
        .get(input.idempotencyKey);
      if (label === 'ledger') assert.equal(ledger, undefined);
      else {
        assert.equal(ledger.state, 'completed');
        assert.equal(ledger.status_code, 500);
        assert.deepEqual(JSON.parse(ledger.response_json), result.body);
      }
    } finally {
      db.close();
    }
  }

  const capacityDb = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(capacityDb);
    const fixture = initializeFixture(
      capacityDb,
      identity,
      873101,
      874101,
      terminalGraph('task')
    );
    const service = createCampaignWorkflowService(capacityDb, {
      writeKnowledgeInTransaction() {
        const error = new Error('Campaign knowledge storage capacity exceeded');
        error.name = 'CampaignKnowledgeCapacityError';
        error.code = 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED';
        error.statusCode = 507;
        error.details = { used_bytes: 10, limit_bytes: 10, requested_bytes: 1 };
        throw error;
      }
    });
    const result = service.actOnWorkflowTask(taskInput(fixture, 'complete'));
    assert.equal(result.status, 507);
    assert.equal(result.body.code, 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED');
    assert.deepEqual(result.body.details, {
      used_bytes: 10,
      limit_bytes: 10,
      requested_bytes: 1
    });
    assert.equal(capacityDb.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(fixture.task.id).status, 'pending');
  } finally {
    capacityDb.close();
  }
});

test('instance-control persistence and capacity failures roll back every field and retain exact safe dispositions', () => {
  const injections = [
    ['workflow_node_logs', 'log'],
    ['activity_log', 'activity'],
    ['knowledge_entries', 'archive'],
    ['campaign_record_links', 'link'],
    ['request_idempotency', 'ledger']
  ];
  for (let index = 0; index < injections.length; index += 1) {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const fixture = initializeFixture(
        db,
        identity,
        874201 + index * 10,
        874301 + index * 10,
        terminalGraph('task')
      );
      const beforeInstance = db.prepare('SELECT * FROM workflow_instances WHERE id=?')
        .get(fixture.instance.id);
      const beforeTasks = db.prepare('SELECT * FROM workflow_tasks WHERE instance_id=? ORDER BY id')
        .all(fixture.instance.id);
      const beforeEvidence = workflowEvidenceCounts(db, fixture);
      const [table, label] = injections[index];
      const triggerName = `task6c2_control_injected_${label}_failure`;
      const timing = table === 'request_idempotency'
        ? "BEFORE UPDATE ON request_idempotency WHEN OLD.scope='workflow.campaign-instance.pause'"
        : `BEFORE INSERT ON ${table}`;
      db.exec(`
        CREATE TEMP TRIGGER ${triggerName}
        ${timing}
        BEGIN SELECT RAISE(ABORT,'injected control ${label} sqlite secret'); END
      `);
      const input = controlInput(fixture, 'pause', 'active', {
        idempotencyKey: `task6c2-control-injected-${label}-${fixture.campaignId}`
      });

      const result = createCampaignWorkflowService(db).controlWorkflowInstance(input);

      db.exec(`DROP TRIGGER ${triggerName}`);
      assert.deepEqual(result, {
        status: 500,
        body: {
          error: 'Campaign workflow instance control could not be persisted safely.',
          code: 'AUDIT_PERSISTENCE_FAILED',
          request_id: input.requestId
        },
        headers: {}
      }, label);
      assert.equal(JSON.stringify(result).includes('sqlite secret'), false, label);
      assert.deepEqual(
        db.prepare('SELECT * FROM workflow_instances WHERE id=?').get(fixture.instance.id),
        beforeInstance,
        label
      );
      assert.deepEqual(
        db.prepare('SELECT * FROM workflow_tasks WHERE instance_id=? ORDER BY id')
          .all(fixture.instance.id),
        beforeTasks,
        label
      );
      assert.deepEqual(workflowEvidenceCounts(db, fixture), beforeEvidence, label);
      const ledger = db.prepare(`
        SELECT state,status_code,response_json FROM request_idempotency
        WHERE idempotency_key=?
      `).get(input.idempotencyKey);
      if (label === 'ledger') {
        assert.equal(ledger, undefined);
      } else {
        assert.equal(ledger.state, 'completed', label);
        assert.equal(ledger.status_code, 500, label);
        assert.deepEqual(JSON.parse(ledger.response_json), result.body, label);
      }
    } finally {
      db.close();
    }
  }

  const capacityDb = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(capacityDb);
    const fixture = initializeFixture(
      capacityDb,
      identity,
      874401,
      874501,
      terminalGraph('task')
    );
    const beforeInstance = capacityDb.prepare('SELECT * FROM workflow_instances WHERE id=?')
      .get(fixture.instance.id);
    const beforeTasks = capacityDb.prepare('SELECT * FROM workflow_tasks WHERE instance_id=? ORDER BY id')
      .all(fixture.instance.id);
    const beforeEvidence = workflowEvidenceCounts(capacityDb, fixture);
    const input = controlInput(fixture, 'pause', 'active', {
      idempotencyKey: `task6c2-control-capacity-${fixture.campaignId}`
    });
    const service = createCampaignWorkflowService(capacityDb, {
      writeKnowledgeInTransaction() {
        const error = new Error('injected control capacity secret');
        error.name = 'CampaignKnowledgeCapacityError';
        error.code = 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED';
        error.details = { used_bytes: 20, limit_bytes: 20, requested_bytes: 1 };
        throw error;
      }
    });

    const result = service.controlWorkflowInstance(input);

    assert.deepEqual(result, {
      status: 507,
      body: {
        error: 'Campaign knowledge storage capacity exceeded',
        code: 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED',
        request_id: input.requestId,
        details: { used_bytes: 20, limit_bytes: 20, requested_bytes: 1 }
      },
      headers: {}
    });
    assert.equal(JSON.stringify(result).includes('capacity secret'), false);
    assert.deepEqual(
      capacityDb.prepare('SELECT * FROM workflow_instances WHERE id=?').get(fixture.instance.id),
      beforeInstance
    );
    assert.deepEqual(
      capacityDb.prepare('SELECT * FROM workflow_tasks WHERE instance_id=? ORDER BY id')
        .all(fixture.instance.id),
      beforeTasks
    );
    assert.deepEqual(workflowEvidenceCounts(capacityDb, fixture), beforeEvidence);
    const ledger = capacityDb.prepare(`
      SELECT state,status_code,response_json FROM request_idempotency
      WHERE idempotency_key=?
    `).get(input.idempotencyKey);
    assert.equal(ledger.state, 'completed');
    assert.equal(ledger.status_code, 507);
    assert.deepEqual(JSON.parse(ledger.response_json), result.body);
  } finally {
    capacityDb.close();
  }
});

test('cached false ownership is a route-time 404 fence and linked branches never call legacy mutation or archive services', async () => {
  const db = openWorkflowDatabase();
  const identity = workflowIdentity(db);
  const fixture = initializeFixture(db, identity, 875001, 876001, terminalGraph('task'));
  loadWorkflowRoutes();
  const engine = require('../workflow_engine');
  const businessKnowledge = require('../services/business_knowledge_service');
  const originals = {
    handleTaskAction: engine.handleTaskAction,
    advanceNode: engine.advanceNode,
    pauseWorkflow: engine.pauseWorkflow,
    resumeWorkflow: engine.resumeWorkflow,
    cancelWorkflow: engine.cancelWorkflow,
    archiveWorkflowTask: businessKnowledge.archiveWorkflowTask,
    archiveWorkflowInstance: businessKnowledge.archiveWorkflowInstance
  };
  const calls = [];
  let api;
  try {
    engine.handleTaskAction = () => calls.push('handleTaskAction');
    engine.advanceNode = () => calls.push('advanceNode');
    engine.pauseWorkflow = () => calls.push('pauseWorkflow');
    engine.resumeWorkflow = () => calls.push('resumeWorkflow');
    engine.cancelWorkflow = () => calls.push('cancelWorkflow');
    businessKnowledge.archiveWorkflowTask = () => calls.push('archiveWorkflowTask');
    businessKnowledge.archiveWorkflowInstance = () => calls.push('archiveWorkflowInstance');
    let first = true;
    api = await startWorkflowApi(db, identity.userId, {
      shouldOwnRequest(request, policy) {
        if (first && policy.id === 'workflow.task.complete') {
          first = false;
          return false;
        }
        return sharedRouteOwner(db)(request, policy);
      }
    });
    const fenced = await api.request(`/api/workflow/tasks/${fixture.task.id}/complete`, {
      body: { expected_status: 'pending', expected_assignment_version: 1 },
      idempotencyKey: 'task6c2-route-fence'
    });
    assert.deepEqual(fenced, {
      status: 404,
      body: { error: 'Task not found' },
      requestId: null,
      retryAfter: null
    });
    assert.deepEqual(calls, []);
    assert.equal(db.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(fixture.task.id).status, 'pending');

    const success = await api.request(`/api/workflow/tasks/${fixture.task.id}/complete`, {
      body: { expected_status: 'pending', expected_assignment_version: 1 },
      idempotencyKey: 'task6c2-linked-no-legacy'
    });
    assert.equal(success.status, 200);
    assert.deepEqual(calls, []);

    db.prepare(`
      INSERT INTO workflow_templates (
        id,name,description,module,category,nodes,edges,version,is_active,created_by
      ) VALUES (876101,'Partial context fixture','','customer','approval','[]','[]',1,1,?)
    `).run(identity.userId);
    const partialInstanceId = withTriggersDisabled(db, [
      'workflow_instances_campaign_context_insert'
    ], () => Number(db.prepare(`
        INSERT INTO workflow_instances (
          template_id,business_type,business_id,current_node_id,status,node_data,
          started_by,org_id
        ) VALUES (876101,'customer',1,'partial-node','active','{}',?,?)
      `).run(identity.userId, identity.orgId).lastInsertRowid));
    const partialTaskId = Number(db.prepare(`
      INSERT INTO workflow_tasks (
        instance_id,node_id,node_type,title,description,assignee_id,status
      ) VALUES (?,'partial-node','approval','Partial task','',?,'pending')
    `).run(partialInstanceId, identity.userId).lastInsertRowid);
    const partial = await api.request(`/api/workflow/tasks/${partialTaskId}/approve`, {
      body: { expected_status: 'pending', expected_assignment_version: 1 },
      idempotencyKey: 'task6c2-partial-context'
    });
    assert.deepEqual(partial, {
      status: 404,
      body: {
        error: 'Campaign was not found.',
        code: 'CAMPAIGN_NOT_FOUND',
        request_id: 'task6c2-http-request'
      },
      requestId: 'task6c2-http-request',
      retryAfter: null
    });
    assert.deepEqual(calls, []);
    assert.equal(
      db.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(partialTaskId).status,
      'pending'
    );
  } finally {
    if (api) await api.close();
    Object.assign(engine, {
      handleTaskAction: originals.handleTaskAction,
      advanceNode: originals.advanceNode,
      pauseWorkflow: originals.pauseWorkflow,
      resumeWorkflow: originals.resumeWorkflow,
      cancelWorkflow: originals.cancelWorkflow
    });
    businessKnowledge.archiveWorkflowTask = originals.archiveWorkflowTask;
    businessKnowledge.archiveWorkflowInstance = originals.archiveWorkflowInstance;
    db.close();
  }
});
