'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const express = require('express');

const migrationService = require('../services/migration_service');
const campaignContract = require('../contracts/campaign_contract');
const { createPhase4RequestPipeline } = require('../middleware/phase4_request_pipeline');
const { createCampaignService } = require('../services/campaign_service');
const {
  createCampaignWorkflowService,
  createCampaignWorkflowWorker,
  startCampaignWorkflowDispatcher
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

function openWorkflowDatabase() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  });
  return db;
}

function workflowIdentity(db, platformRole = 'admin') {
  const identity = db.prepare(`
    SELECT
      user.id AS userId,
      user.role AS platformRole,
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
    WHERE user.is_active=1 AND user.role=?
    ORDER BY
      CASE WHEN organization_membership.role_code='org_admin' THEN 0 ELSE 1 END,
      user.id,team_membership.team_id
    LIMIT 1
  `).get(platformRole);
  assert.ok(identity, `missing active ${platformRole} workflow identity`);
  return identity;
}

function anotherOrganizationMember(db, identity) {
  const user = db.prepare(`
    SELECT user.id AS userId
    FROM users user
    JOIN organization_memberships membership
      ON membership.user_id=user.id
      AND membership.org_id=?
      AND membership.status='active'
    WHERE user.is_active=1
      AND user.id<>?
      AND membership.role_code<>'org_admin'
    ORDER BY user.id
    LIMIT 1
  `).get(identity.orgId, identity.userId);
  assert.ok(user, 'missing non-admin organization member');
  return user.userId;
}

function createCampaignFixture(db, identity, campaignId = 971001) {
  const customerId = campaignId + 1;
  const opportunityId = campaignId + 2;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (?,?,?,'qualified','test',?,?)
  `).run(
    customerId,
    `Workflow Campaign ${campaignId}`,
    `Workflow Campaign ${campaignId} Ltd`,
    identity.userId,
    identity.userId
  );
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,
      channel_type,created_by
    ) VALUES (?,?,'Workflow opportunity','proposal',1000,50,'Workflow','influencer',?)
  `).run(opportunityId, customerId, identity.userId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,?,?,?,?,?,'lead','active',1)
  `).run(
    campaignId,
    identity.orgId,
    `Workflow campaign ${campaignId}`,
    customerId,
    opportunityId,
    identity.userId,
    identity.teamId
  );
  return { ...identity, campaignId, customerId, opportunityId };
}

function trigger() {
  return {
    event_type: 'lifecycle_transition',
    previous_state: 'lead',
    next_state: 'qualified'
  };
}

function terminalGraph() {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Start', config: {} },
      { id: 'end', type: 'end', label: 'End', config: {} }
    ],
    edges: [
      { id: 'start-next', from: 'start', to: 'end', outcome: 'next', priority: 0, condition: null }
    ]
  };
}

function taskGraph(config = {}) {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'task',
        type: 'task',
        label: 'Execute',
        config: {
          title: 'Execute campaign',
          description: 'Execute the pinned campaign task',
          assignee_id: null,
          assignee_role: 'member',
          due_hours: null,
          ...config
        }
      },
      { id: 'end', type: 'end', label: 'End', config: {} }
    ],
    edges: [
      { id: 'start-next', from: 'start', to: 'task', outcome: 'next', priority: 0, condition: null },
      { id: 'task-complete', from: 'task', to: 'end', outcome: 'complete', priority: 0, condition: null }
    ]
  };
}

function approvalGraph(config = {}) {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'approval',
        type: 'approval',
        label: 'Approve',
        config: {
          title: 'Approve campaign',
          description: '',
          assignee_id: null,
          assignee_role: 'org_admin',
          due_hours: null,
          ...config
        }
      },
      { id: 'end', type: 'end', label: 'End', config: {} }
    ],
    edges: [
      { id: 'start-next', from: 'start', to: 'approval', outcome: 'next', priority: 0, condition: null },
      { id: 'approval-ok', from: 'approval', to: 'end', outcome: 'approve', priority: 0, condition: null },
      { id: 'approval-no', from: 'approval', to: 'end', outcome: 'reject', priority: 1, condition: null }
    ]
  };
}

function conditionTaskGraph(config = {}) {
  const graph = taskGraph(config);
  graph.nodes.splice(1, 0, {
    id: 'condition',
    type: 'condition',
    label: 'Check lifecycle',
    config: {}
  });
  graph.edges = [
    { id: 'start-next', from: 'start', to: 'condition', outcome: 'next', priority: 0, condition: null },
    {
      id: 'condition-match',
      from: 'condition',
      to: 'task',
      outcome: 'match',
      priority: 0,
      condition: { op: 'eq', left: { var: 'event.next_state' }, right: 'qualified' }
    },
    { id: 'condition-fallback', from: 'condition', to: 'end', outcome: 'fallback', priority: 1, condition: null },
    { id: 'task-complete', from: 'task', to: 'end', outcome: 'complete', priority: 0, condition: null }
  ];
  return graph;
}

function insertCampaignTemplate(db, identity, id, graph, name = `Workflow template ${id}`) {
  db.prepare(`
    INSERT INTO workflow_templates (
      id,name,description,module,category,nodes,edges,version,is_active,
      created_by,trigger_config_json
    ) VALUES (?,?,?,'campaign','approval',?,?,1,1,?,?)
  `).run(
    id,
    name,
    'Task 6B workflow fixture',
    JSON.stringify(graph.nodes),
    JSON.stringify(graph.edges),
    identity.userId,
    JSON.stringify(trigger())
  );
}

function transitionCampaign(db, context, key = `task6b-transition-${context.campaignId}`) {
  const result = createCampaignService(db).transitionCampaign({
    userId: context.userId,
    campaignId: context.campaignId,
    requestId: `task6b-transition-request-${context.campaignId}`,
    idempotencyKey: key,
    body: {
      expected_state: 'lead',
      expected_version: 1,
      next_state: 'qualified',
      reason: 'Initialize durable campaign workflow'
    }
  });
  assert.equal(result.status, 200);
  assert.ok(result.body.dispatches.length > 0);
  return result;
}

function dispatchRows(db, campaignId) {
  return db.prepare(`
    SELECT *
    FROM campaign_workflow_dispatches
    WHERE campaign_id=?
    ORDER BY id
  `).all(campaignId);
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

function forceDispatchDue(db, dispatchId) {
  withTriggersDisabled(db, ['campaign_workflow_dispatches_legal_transition'], () => {
    db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET next_attempt_at=datetime(CURRENT_TIMESTAMP,'-1 second')
      WHERE id=? AND status='failed_initialization'
    `).run(dispatchId);
  });
}

function forceExpiredProcessing(db, dispatchId, attemptCount) {
  withTriggersDisabled(db, ['campaign_workflow_dispatches_legal_transition'], () => {
    db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET attempt_count=?,lease_until=datetime(CURRENT_TIMESTAMP,'-1 second')
      WHERE id=? AND status='processing'
    `).run(attemptCount, dispatchId);
  });
}

function artifactCounts(db, campaignId) {
  return {
    instances: db.prepare('SELECT COUNT(*) AS count FROM workflow_instances WHERE campaign_id=?').get(campaignId).count,
    tasks: db.prepare(`
      SELECT COUNT(*) AS count
      FROM workflow_tasks task
      JOIN workflow_instances instance ON instance.id=task.instance_id
      WHERE instance.campaign_id=?
    `).get(campaignId).count,
    logs: db.prepare(`
      SELECT COUNT(*) AS count
      FROM workflow_node_logs log
      JOIN workflow_instances instance ON instance.id=log.instance_id
      WHERE instance.campaign_id=?
    `).get(campaignId).count,
    links: db.prepare('SELECT COUNT(*) AS count FROM campaign_record_links WHERE campaign_id=?').get(campaignId).count,
    archives: db.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_entries
      WHERE business_type='campaign' AND business_id=?
        AND source_type='campaign_workflow_log'
    `).get(String(campaignId)).count
  };
}

function operationalAction(db, context, action, expectedStatus, reason) {
  const campaign = db.prepare('SELECT row_version FROM campaigns WHERE id=?').get(context.campaignId);
  return createCampaignService(db).operationalAction({
    userId: context.userId,
    campaignId: context.campaignId,
    requestId: `task6b-${action}-request-${context.campaignId}`,
    idempotencyKey: `task6b-${action}-${context.campaignId}-${campaign.row_version}`,
    body: {
      action,
      expected_status: expectedStatus,
      expected_version: campaign.row_version,
      reason
    }
  });
}

async function startCampaignApi(db, actorUserId) {
  const registry = campaignContract.createRoutePolicyRegistry([
    campaignContract.REQUEST_POLICIES.CAMPAIGN_WORKFLOW_RETRY
  ]);
  const pipeline = createPhase4RequestPipeline({
    registry,
    authenticate(request) {
      if (request.headers.authorization !== 'Bearer task6b-token') return null;
      const user = db.prepare(`
        SELECT id,username,display_name,role,department,is_active
        FROM users WHERE id=? AND is_active=1
      `).get(actorUserId);
      if (!user) return null;
      request.user = user;
      return { user };
    },
    generateRequestId: () => 'task6b-campaign-api-request'
  });
  const app = express();
  app.use(express.json({
    limit: '50mb',
    type(request) {
      const value = request.headers && request.headers['content-type'];
      return !pipeline.shouldSkipGlobalBodyParser(request) &&
        typeof value === 'string' &&
        /^application\/json(?:\s*;|$)/i.test(value.trim());
    }
  }));
  app.use(pipeline.middleware);
  require('../routes_campaigns')(app, db);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(method, requestPath, options = {}) {
      const headers = {
        'X-Request-Id': options.requestId || 'task6b-campaign-api-request'
      };
      if (options.auth !== false) headers.Authorization = 'Bearer task6b-token';
      let body;
      if (Object.hasOwn(options, 'body')) {
        headers['Content-Type'] = options.contentType || 'application/json; charset=utf-8';
        body = options.contentType === 'text/plain'
          ? String(options.body)
          : JSON.stringify(options.body);
      }
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
      const response = await fetch(baseUrl + requestPath, { method, headers, body });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      server.close();
      await once(server, 'close');
    }
  };
}

async function startLegacyWorkflowApi(db, actorUserId) {
  const app = express();
  app.use(express.json());
  const authMiddleware = (request, response, next) => {
    request.user = db.prepare(`
      SELECT id,username,display_name,role,department,is_active
      FROM users WHERE id=? AND is_active=1
    `).get(actorUserId);
    return request.user
      ? next()
      : response.status(401).json({ error: 'Authentication required' });
  };
  const adminOnly = (request, response, next) => next();
  require('../routes_workflow')(app, db, authMiddleware, adminOnly);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    async post(requestPath, options = {}) {
      const requestId = options.requestId || 'task6b-workflow-action-request';
      const headers = {
        Authorization: 'Bearer task6b-token',
        'Content-Type': 'application/json',
        'X-Request-Id': requestId
      };
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
      const response = await fetch(baseUrl + requestPath, {
        method: 'POST',
        headers,
        body: Object.hasOwn(options, 'body') ? JSON.stringify(options.body) : undefined
      });
      return {
        status: response.status,
        body: await response.json(),
        requestId: response.headers.get('x-request-id')
      };
    },
    async close() {
      server.close();
      await once(server, 'close');
    }
  };
}

test('repeated drains initialize pinned end/task/approval paths exactly once and archive only terminal initialization', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const context = createCampaignFixture(db, identity);
    insertCampaignTemplate(db, identity, 981001, terminalGraph(), 'Terminal workflow');
    insertCampaignTemplate(db, identity, 981002, conditionTaskGraph({ due_hours: 3 }), 'Conditional task workflow');
    insertCampaignTemplate(db, identity, 981003, approvalGraph(), 'Approval workflow');
    insertCampaignTemplate(db, identity, 981004, taskGraph({
      assignee_id: identity.userId,
      assignee_role: 'platform_admin'
    }), 'Conjunctive assignment workflow');
    const transition = transitionCampaign(db, context);
    assert.equal(transition.body.dispatches.length, 4);

    const firstWorker = createCampaignWorkflowWorker(db);
    const secondWorker = createCampaignWorkflowWorker(db);
    assert.equal(firstWorker.drain().claimed, 4);
    assert.equal(secondWorker.drain().claimed, 0);
    assert.equal(firstWorker.drain().claimed, 0);

    const dispatches = dispatchRows(db, context.campaignId);
    assert.deepEqual(dispatches.map((row) => row.status), [
      'completed', 'completed', 'completed', 'completed'
    ]);
    assert.deepEqual(dispatches.map((row) => row.attempt_count), [1, 1, 1, 1]);

    const instances = db.prepare(`
      SELECT id,campaign_dispatch_id,status,current_node_id,initialization_status,
             initialization_error,business_type,business_id,campaign_event_id,
             started_by
      FROM workflow_instances
      WHERE campaign_id=?
      ORDER BY campaign_dispatch_id
    `).all(context.campaignId);
    assert.equal(instances.length, 4);
    assert.deepEqual(instances.map((row) => row.status), [
      'completed', 'active', 'active', 'active'
    ]);
    assert.deepEqual(instances.map((row) => row.current_node_id), [
      null, 'task', 'approval', 'task'
    ]);
    for (const instance of instances) {
      assert.equal(instance.initialization_status, 'ready');
      assert.equal(instance.initialization_error, null);
      assert.equal(instance.business_type, 'campaign');
      assert.equal(instance.business_id, context.campaignId);
      assert.equal(instance.campaign_event_id, transition.body.event.id);
      assert.equal(instance.started_by, identity.userId);
    }

    const logs = db.prepare(`
      SELECT log.id,instance.campaign_dispatch_id,log.node_id,log.action,log.details
      FROM workflow_node_logs log
      JOIN workflow_instances instance ON instance.id=log.instance_id
      WHERE instance.campaign_id=?
      ORDER BY instance.campaign_dispatch_id,log.id
    `).all(context.campaignId);
    const actionsByDispatch = new Map();
    for (const log of logs) {
      assert.ok(Buffer.byteLength(log.details, 'utf8') <= 4096);
      assert.equal(JSON.stringify(JSON.parse(log.details)), log.details);
      const actions = actionsByDispatch.get(log.campaign_dispatch_id) || [];
      actions.push(log.action);
      actionsByDispatch.set(log.campaign_dispatch_id, actions);
    }
    assert.deepEqual(actionsByDispatch.get(dispatches[0].id), ['entered', 'completed']);
    assert.deepEqual(actionsByDispatch.get(dispatches[1].id), [
      'entered', 'condition_evaluated', 'task_created'
    ]);
    assert.deepEqual(actionsByDispatch.get(dispatches[2].id), ['entered', 'task_created']);
    assert.deepEqual(actionsByDispatch.get(dispatches[3].id), ['entered', 'task_created']);

    const tasks = db.prepare(`
      SELECT instance.campaign_dispatch_id,task.node_type,task.assignee_id,
             task.assignee_role,task.assignment_version,task.status,
             task.created_at,task.due_at
      FROM workflow_tasks task
      JOIN workflow_instances instance ON instance.id=task.instance_id
      WHERE instance.campaign_id=?
      ORDER BY instance.campaign_dispatch_id
    `).all(context.campaignId);
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map((row) => row.node_type), ['task', 'approval', 'task']);
    assert.ok(tasks.every((row) => row.status === 'pending' && row.assignment_version === 1));
    assert.equal(tasks[0].due_at, db.prepare("SELECT datetime(?,'+3 hours') AS due_at").get(tasks[0].created_at).due_at);
    assert.equal(tasks[1].due_at, null);
    assert.equal(tasks[2].assignee_id, identity.userId);
    assert.equal(tasks[2].assignee_role, 'platform_admin');

    const workflowLinks = db.prepare(`
      SELECT record_id,metadata_json
      FROM campaign_record_links
      WHERE campaign_id=? AND relation_type='workflow' AND revoked_at IS NULL
      ORDER BY CAST(record_id AS INTEGER)
    `).all(context.campaignId);
    assert.equal(workflowLinks.length, 4);
    for (const link of workflowLinks) {
      const instance = instances.find((row) => String(row.id) === link.record_id);
      assert.ok(instance);
      assert.equal(
        link.metadata_json,
        JSON.stringify({
          dispatch_id: instance.campaign_dispatch_id,
          trigger_event_id: transition.body.event.id
        })
      );
    }

    const terminalLog = logs.find((row) => (
      row.campaign_dispatch_id === dispatches[0].id && row.action === 'completed'
    ));
    const archives = db.prepare(`
      SELECT id,entry_type,title,source_type,source_id,content,visibility,tags_json
      FROM knowledge_entries
      WHERE business_type='campaign' AND business_id=?
        AND source_type='campaign_workflow_log'
    `).all(String(context.campaignId));
    assert.equal(archives.length, 1);
    assert.equal(archives[0].entry_type, 'campaign_workflow');
    assert.equal(archives[0].title, `Campaign workflow #${instances[0].id}`);
    assert.equal(String(archives[0].source_id), String(terminalLog.id));
    assert.equal(archives[0].visibility, 'team');
    assert.equal(archives[0].tags_json, '["campaign","workflow"]');
    assert.equal(archives[0].content, JSON.stringify({
      dispatch_id: dispatches[0].id,
      instance_id: instances[0].id,
      node_id: 'end',
      action: 'completed',
      status: 'completed',
      error_code: null
    }));
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM campaign_record_links
        WHERE campaign_id=? AND relation_type='knowledge'
          AND record_id=? AND revoked_at IS NULL
      `).get(context.campaignId, String(archives[0].id)).count,
      1
    );
  } finally {
    db.close();
  }
});

test('stored snapshot, checksum, context, and lineage corruption fail validation without mutable fallback or artifacts', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const context = createCampaignFixture(db, identity, 972001);
    for (let index = 0; index < 4; index += 1) {
      insertCampaignTemplate(db, identity, 982001 + index, terminalGraph());
    }
    transitionCampaign(db, context);
    const dispatches = dispatchRows(db, context.campaignId);
    const triggerNames = [
      'campaign_workflow_dispatches_immutable_evidence',
      'campaign_workflow_dispatches_legal_transition'
    ];
    withTriggersDisabled(db, triggerNames, () => {
      const snapshot = JSON.parse(dispatches[0].template_snapshot_json);
      db.prepare('UPDATE campaign_workflow_dispatches SET template_snapshot_json=? WHERE id=?')
        .run(JSON.stringify(snapshot, null, 1), dispatches[0].id);
      db.prepare('UPDATE campaign_workflow_dispatches SET template_checksum=? WHERE id=?')
        .run('0'.repeat(64), dispatches[1].id);
      const contextDocument = JSON.parse(dispatches[2].execution_context_json);
      contextDocument.campaign.id += 1;
      db.prepare('UPDATE campaign_workflow_dispatches SET execution_context_json=? WHERE id=?')
        .run(JSON.stringify(contextDocument), dispatches[2].id);
      db.prepare('UPDATE campaign_workflow_dispatches SET template_version=template_version+1 WHERE id=?')
        .run(dispatches[3].id);
    });
    db.prepare('UPDATE workflow_templates SET nodes=?,edges=?,version=version+10')
      .run(JSON.stringify(taskGraph().nodes), JSON.stringify(taskGraph().edges));

    const result = createCampaignWorkflowWorker(db).drain();
    assert.equal(result.claimed, 4);
    assert.deepEqual(
      dispatchRows(db, context.campaignId).map((row) => [row.status, row.last_error_code, row.last_error]),
      [
        ['failed_validation', 'WORKFLOW_SNAPSHOT_INVALID', 'Stored workflow snapshot is invalid'],
        ['failed_validation', 'WORKFLOW_SNAPSHOT_CHECKSUM_MISMATCH', 'Stored workflow snapshot checksum is invalid'],
        ['failed_validation', 'WORKFLOW_CONTEXT_INVALID', 'Stored workflow context is invalid'],
        ['failed_validation', 'WORKFLOW_LINEAGE_INVALID', 'Workflow dispatch lineage is invalid']
      ]
    );
    assert.deepEqual(artifactCounts(db, context.campaignId), {
      instances: 0,
      tasks: 0,
      logs: 0,
      links: 0,
      archives: 0
    });
  } finally {
    db.close();
  }
});

test('empty assignment and injected database failures roll back artifacts with exact safe backoff and fifth-attempt dead letter', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const context = createCampaignFixture(db, identity, 973001);
    insertCampaignTemplate(db, identity, 983001, taskGraph({
      assignee_id: Number.MAX_SAFE_INTEGER,
      assignee_role: 'platform_admin'
    }));
    transitionCampaign(db, context);
    const dispatchId = dispatchRows(db, context.campaignId)[0].id;
    const worker = createCampaignWorkflowWorker(db);
    const expectedBackoffs = [5, 30, 120, 600];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const drained = worker.drain();
      assert.equal(drained.claimed, 1);
      const row = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?').get(dispatchId);
      assert.equal(row.attempt_count, attempt);
      assert.equal(row.last_error_code, 'WORKFLOW_ASSIGNMENT_UNRESOLVABLE');
      assert.equal(row.last_error, 'No eligible actor for workflow task');
      if (attempt < 5) {
        assert.equal(row.status, 'failed_initialization');
        const delay = db.prepare(`
          SELECT CAST(strftime('%s',next_attempt_at) AS INTEGER)
               - CAST(strftime('%s',updated_at) AS INTEGER) AS seconds
          FROM campaign_workflow_dispatches WHERE id=?
        `).get(dispatchId).seconds;
        assert.equal(delay, expectedBackoffs[attempt - 1]);
        forceDispatchDue(db, dispatchId);
      } else {
        assert.equal(row.status, 'dead_letter');
        assert.equal(row.next_attempt_at, null);
      }
      assert.deepEqual(artifactCounts(db, context.campaignId), {
        instances: 0,
        tasks: 0,
        logs: 0,
        links: 0,
        archives: 0
      });
    }

    db.prepare('UPDATE workflow_templates SET is_active=0 WHERE id=983001').run();
    const secondContext = createCampaignFixture(db, identity, 973101);
    insertCampaignTemplate(db, identity, 983101, terminalGraph());
    transitionCampaign(db, secondContext);
    db.exec(`
      CREATE TEMP TRIGGER task6b_injected_workflow_log_failure
      BEFORE INSERT ON main.workflow_node_logs
      BEGIN SELECT RAISE(ABORT,'injected raw sqlite secret'); END
    `);
    const failureResult = worker.drain();
    db.exec('DROP TRIGGER task6b_injected_workflow_log_failure');
    assert.equal(failureResult.claimed, 1);
    const failed = dispatchRows(db, secondContext.campaignId)[0];
    assert.equal(failed.status, 'failed_initialization');
    assert.equal(failed.attempt_count, 1);
    assert.equal(failed.last_error_code, 'WORKFLOW_INITIALIZATION_FAILED');
    assert.equal(failed.last_error, 'Workflow initialization failed');
    assert.equal(`${failed.last_error_code} ${failed.last_error}`.includes('sqlite secret'), false);
    assert.deepEqual(artifactCounts(db, secondContext.campaignId), {
      instances: 0,
      tasks: 0,
      logs: 0,
      links: 0,
      archives: 0
    });
  } finally {
    db.close();
  }
});

test('claim, heartbeat, reclaim, hold, cancellation, and expired fifth-attempt fences are exact and never create attempt six', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const context = createCampaignFixture(db, identity, 974001);
    insertCampaignTemplate(db, identity, 984001, terminalGraph());
    insertCampaignTemplate(db, identity, 984002, terminalGraph());
    transitionCampaign(db, context);
    const [firstDispatch, secondDispatch] = dispatchRows(db, context.campaignId);
    const worker = createCampaignWorkflowWorker(db);

    const firstClaim = worker.claimNext();
    assert.equal(firstClaim.dispatchId, firstDispatch.id);
    assert.equal(firstClaim.attemptCount, 1);
    assert.equal(
      db.prepare(`
        SELECT CAST(strftime('%s',lease_until) AS INTEGER)
             - CAST(strftime('%s',updated_at) AS INTEGER) AS seconds
        FROM campaign_workflow_dispatches WHERE id=?
      `).get(firstDispatch.id).seconds,
      60
    );
    assert.equal(worker.heartbeat({ ...firstClaim, leaseToken: `${firstClaim.leaseToken}x` }), null);
    assert.equal(worker.heartbeat({ ...firstClaim, attemptCount: 2 }), null);
    assert.equal(worker.heartbeat({ ...firstClaim, leaseUntil: '2000-01-01 00:00:00' }), null);
    const renewed = worker.heartbeat(firstClaim);
    assert.ok(renewed);
    assert.equal(
      db.prepare("SELECT strftime('%s',?)-strftime('%s',?) AS seconds")
        .get(renewed.leaseUntil, firstClaim.leaseUntil).seconds,
      20
    );

    const held = operationalAction(db, context, 'hold', 'active', 'Fence active worker');
    assert.equal(held.status, 200);
    assert.equal(worker.heartbeat(renewed), null);
    assert.deepEqual(worker.processClaim(renewed), {
      state: 'stale',
      dispatchId: firstDispatch.id
    });
    const resumed = operationalAction(db, context, 'resume', 'on_hold', 'Resume worker');
    assert.equal(resumed.status, 200);
    const afterResume = worker.heartbeat(renewed);
    assert.ok(afterResume);
    assert.equal(worker.processClaim(afterResume).state, 'completed');

    const secondClaim = worker.claimNext();
    assert.equal(secondClaim.dispatchId, secondDispatch.id);
    forceExpiredProcessing(db, secondDispatch.id, 1);
    const reclaimed = worker.claimNext();
    assert.equal(reclaimed.dispatchId, secondDispatch.id);
    assert.equal(reclaimed.attemptCount, 2);
    assert.notEqual(reclaimed.leaseToken, secondClaim.leaseToken);
    forceExpiredProcessing(db, secondDispatch.id, 5);
    assert.equal(worker.claimNext(), null);
    const recovered = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?')
      .get(secondDispatch.id);
    assert.equal(recovered.status, 'dead_letter');
    assert.equal(recovered.attempt_count, 5);
    assert.equal(recovered.lease_token, null);
    assert.equal(recovered.lease_until, null);
    assert.equal(recovered.next_attempt_at, null);
    assert.equal(recovered.last_error_code, 'WORKER_LEASE_EXPIRED_FINAL');
    assert.equal(recovered.last_error, 'Final workflow worker lease expired');

    const cancelledContext = createCampaignFixture(db, identity, 974101);
    insertCampaignTemplate(db, identity, 984101, terminalGraph());
    transitionCampaign(db, cancelledContext);
    const cancelledClaim = worker.claimNext();
    const cancelled = operationalAction(
      db,
      cancelledContext,
      'cancel',
      'active',
      'Cancel racing worker'
    );
    assert.equal(cancelled.status, 200);
    assert.equal(worker.processClaim(cancelledClaim).state, 'stale');
    assert.equal(dispatchRows(db, cancelledContext.campaignId)[0].status, 'cancelled');
    assert.deepEqual(artifactCounts(db, cancelledContext.campaignId), {
      instances: 0,
      tasks: 0,
      logs: 0,
      links: 0,
      archives: 0
    });
  } finally {
    db.close();
  }
});

test('manual retry is authorized, idempotent, audited, atomic, and preserves hold/cancel precedence', async () => {
  const db = openWorkflowDatabase();
  const apis = [];
  try {
    const identity = workflowIdentity(db);
    const context = createCampaignFixture(db, identity, 975001);
    insertCampaignTemplate(db, identity, 985001, taskGraph({
      assignee_id: Number.MAX_SAFE_INTEGER,
      assignee_role: 'member'
    }));
    const transition = transitionCampaign(db, context);
    createCampaignWorkflowWorker(db).drain();
    const failed = dispatchRows(db, context.campaignId)[0];
    assert.equal(failed.status, 'failed_initialization');
    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?')
      .get(context.campaignId).count;

    const forbiddenApi = await startCampaignApi(db, anotherOrganizationMember(db, identity));
    apis.push(forbiddenApi);
    const forbidden = await forbiddenApi.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        idempotencyKey: 'task6b-retry-forbidden',
        body: { expected_status: 'failed_initialization', reason: 'Forbidden retry' }
      }
    );
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'CAMPAIGN_FORBIDDEN');

    const api = await startCampaignApi(db, identity.userId);
    apis.push(api);
    const noAuth = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        auth: false,
        idempotencyKey: 'task6b-retry-no-auth',
        body: { expected_status: 'failed_initialization', reason: 'No auth' }
      }
    );
    assert.equal(noAuth.status, 401);
    const wrongMedia = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        contentType: 'text/plain',
        idempotencyKey: 'task6b-retry-media',
        body: 'not json'
      }
    );
    assert.equal(wrongMedia.status, 415);
    const invalidBody = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        idempotencyKey: 'task6b-retry-invalid-0001',
        body: {
          expected_status: 'completed',
          reason: '',
          unexpected: true
        }
      }
    );
    assert.equal(invalidBody.status, 400);
    assert.equal(invalidBody.body.code, 'INVALID_CAMPAIGN_INPUT');

    const request = {
      idempotencyKey: 'task6b-retry-success-0001',
      body: {
        expected_status: 'failed_initialization',
        reason: 'Operator approved durable recovery'
      }
    };
    const success = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      request
    );
    assert.equal(success.status, 202);
    assert.deepEqual(Object.keys(success.body), ['dispatch']);
    assert.equal(success.body.dispatch.id, failed.id);
    assert.equal(success.body.dispatch.status, 'pending');
    assert.equal(success.body.dispatch.attempt_count, 0);
    assert.equal(success.body.dispatch.next_attempt_at, null);
    assert.equal(success.body.dispatch.error, null);
    const reset = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?').get(failed.id);
    assert.equal(reset.status, 'pending');
    assert.equal(reset.attempt_count, 0);
    assert.equal(reset.lease_token, null);
    assert.equal(reset.lease_until, null);
    assert.equal(reset.next_attempt_at, null);
    assert.equal(reset.last_error_code, null);
    assert.equal(reset.last_error, null);

    const audit = db.prepare(`
      SELECT user_id,action,module,details
      FROM activity_log
      WHERE action='retry_workflow_dispatch'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.deepEqual(audit, {
      user_id: identity.userId,
      action: 'retry_workflow_dispatch',
      module: 'workflow',
      details: JSON.stringify({
        source: 'workflow_recovery',
        campaign_id: context.campaignId,
        dispatch_id: failed.id,
        prior_status: 'failed_initialization',
        prior_attempt_count: 1,
        reason: 'Operator approved durable recovery'
      })
    });
    const ledger = db.prepare(`
      SELECT scope,expected_event_count,state,status_code,response_json
      FROM request_idempotency
      WHERE idempotency_key=?
    `).get(request.idempotencyKey);
    assert.equal(ledger.scope, 'campaign.workflow.retry');
    assert.equal(ledger.expected_event_count, 0);
    assert.equal(ledger.state, 'completed');
    assert.equal(ledger.status_code, 202);
    assert.deepEqual(JSON.parse(ledger.response_json), success.body);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?')
        .get(context.campaignId).count,
      eventCount
    );

    const replay = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      request
    );
    assert.deepEqual(replay, success);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='retry_workflow_dispatch'").get().count,
      1
    );
    const conflict = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        idempotencyKey: request.idempotencyKey,
        body: {
          expected_status: 'failed_initialization',
          reason: 'Changed retained request'
        }
      }
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED');
    const stale = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        idempotencyKey: 'task6b-retry-stale-0001',
        body: request.body
      }
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'DISPATCH_NOT_RETRYABLE');

    withTriggersDisabled(db, ['campaign_workflow_dispatches_legal_transition'], () => {
      db.prepare(`
        UPDATE campaign_workflow_dispatches
        SET status='dead_letter',attempt_count=5,next_attempt_at=NULL,
            last_error_code='WORKFLOW_ASSIGNMENT_UNRESOLVABLE',
            last_error='No eligible actor for workflow task'
        WHERE id=? AND status='pending'
      `).run(failed.id);
    });
    const deadLetterRetry = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        idempotencyKey: 'task6b-retry-dead-letter-0001',
        body: {
          expected_status: 'dead_letter',
          reason: 'Operator approved dead-letter recovery'
        }
      }
    );
    assert.equal(deadLetterRetry.status, 202);
    assert.equal(deadLetterRetry.body.dispatch.status, 'pending');
    assert.equal(deadLetterRetry.body.dispatch.attempt_count, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='retry_workflow_dispatch'").get().count,
      2
    );

    withTriggersDisabled(db, ['campaign_workflow_dispatches_legal_transition'], () => {
      db.prepare(`
        UPDATE campaign_workflow_dispatches
        SET status='failed_initialization',attempt_count=1,
            next_attempt_at=datetime(CURRENT_TIMESTAMP,'+5 seconds'),
            last_error_code='WORKFLOW_INITIALIZATION_FAILED',
            last_error='Workflow initialization failed'
        WHERE id=? AND status='pending'
      `).run(failed.id);
    });
    const maximumReason = '\u{1f600}'.repeat(1000);
    const maximumReasonRetry = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        idempotencyKey: 'task6b-retry-max-reason-0001',
        body: {
          expected_status: 'failed_initialization',
          reason: maximumReason
        }
      }
    );
    assert.equal(maximumReasonRetry.status, 202);
    assert.equal(
      JSON.parse(db.prepare(`
        SELECT details FROM activity_log
        WHERE action='retry_workflow_dispatch'
        ORDER BY id DESC LIMIT 1
      `).get().details).reason,
      maximumReason
    );

    assert.equal(operationalAction(db, context, 'hold', 'active', 'Hold recovery').status, 200);
    const held = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        idempotencyKey: 'task6b-retry-held-0001',
        body: request.body
      }
    );
    assert.equal(held.status, 409);
    assert.equal(held.body.code, 'CAMPAIGN_ON_HOLD');
    assert.equal(operationalAction(db, context, 'resume', 'on_hold', 'Resume recovery').status, 200);
    assert.equal(operationalAction(db, context, 'cancel', 'active', 'Cancel recovery').status, 200);
    const cancelled = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/retry`,
      {
        idempotencyKey: 'task6b-retry-cancelled-0001',
        body: request.body
      }
    );
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.body.code, 'CAMPAIGN_CANCELLED');
    assert.equal(transition.body.event.id > 0, true);
  } finally {
    for (const api of apis.reverse()) await api.close();
    db.close();
  }
});

test('retry activity failure rolls back dispatch reset and idempotency reservation', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const context = createCampaignFixture(db, identity, 976001);
    insertCampaignTemplate(db, identity, 986001, taskGraph({
      assignee_id: Number.MAX_SAFE_INTEGER,
      assignee_role: 'member'
    }));
    transitionCampaign(db, context);
    createCampaignWorkflowWorker(db).drain();
    const failed = dispatchRows(db, context.campaignId)[0];
    db.exec(`
      CREATE TEMP TRIGGER task6b_injected_retry_audit_failure
      BEFORE INSERT ON main.activity_log
      WHEN NEW.action='retry_workflow_dispatch'
      BEGIN SELECT RAISE(ABORT,'retry audit injected failure'); END
    `);
    const service = createCampaignWorkflowService(db);
    assert.throws(() => service.retryWorkflowDispatch({
      userId: identity.userId,
      campaignId: context.campaignId,
      dispatchId: failed.id,
      requestId: 'task6b-retry-atomic-request',
      idempotencyKey: 'task6b-retry-atomic-0001',
      body: {
        expected_status: 'failed_initialization',
        reason: 'Retry must remain atomic'
      }
    }), /retry audit injected failure/);
    db.exec('DROP TRIGGER task6b_injected_retry_audit_failure');
    const after = db.prepare('SELECT status,attempt_count FROM campaign_workflow_dispatches WHERE id=?')
      .get(failed.id);
    assert.deepEqual(after, { status: 'failed_initialization', attempt_count: 1 });
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM request_idempotency WHERE idempotency_key=?')
        .get('task6b-retry-atomic-0001').count,
      0
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='retry_workflow_dispatch'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test('direct linked-route bypass is fenced while all six unlinked no-body routes retain exact legacy behavior', async () => {
  const db = openWorkflowDatabase();
  const previousEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    TM_DISABLE_DOTENV: process.env.TM_DISABLE_DOTENV,
    DB_PATH: process.env.DB_PATH
  };
  process.env.NODE_ENV = 'test';
  process.env.TM_DISABLE_DOTENV = '1';
  process.env.DB_PATH = ':memory:';
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
  const mutationCalls = [];
  const archiveCalls = [];
  let api;
  try {
    const identity = workflowIdentity(db);
    const context = createCampaignFixture(db, identity, 977001);
    insertCampaignTemplate(db, identity, 987001, taskGraph());
    transitionCampaign(db, context);
    createCampaignWorkflowWorker(db).drain();
    const linkedInstance = db.prepare('SELECT id FROM workflow_instances WHERE campaign_id=?')
      .get(context.campaignId);
    const linkedTask = db.prepare('SELECT id FROM workflow_tasks WHERE instance_id=?')
      .get(linkedInstance.id);

    engine.handleTaskAction = (_id, action) => { mutationCalls.push(`task:${action}`); };
    engine.advanceNode = () => { mutationCalls.push('task:complete'); };
    engine.pauseWorkflow = () => { mutationCalls.push('instance:pause'); };
    engine.resumeWorkflow = () => { mutationCalls.push('instance:resume'); };
    engine.cancelWorkflow = () => { mutationCalls.push('instance:cancel'); };
    businessKnowledge.archiveWorkflowTask = (_db, _task, _user, action) => {
      archiveCalls.push(`task:${action}`);
    };
    businessKnowledge.archiveWorkflowInstance = (_db, _instance, _user, action) => {
      archiveCalls.push(`instance:${action}`);
    };
    api = await startLegacyWorkflowApi(db, identity.userId);

    const linkedPaths = [
      `/api/workflow/tasks/${linkedTask.id}/approve`,
      `/api/workflow/tasks/${linkedTask.id}/reject`,
      `/api/workflow/tasks/${linkedTask.id}/complete`,
      `/api/workflow/instances/${linkedInstance.id}/pause`,
      `/api/workflow/instances/${linkedInstance.id}/resume`,
      `/api/workflow/instances/${linkedInstance.id}/cancel`
    ];
    for (const requestPath of linkedPaths) {
      const response = await api.post(requestPath, {
        requestId: 'task6c2-route-time-fence',
        idempotencyKey: 'task6c2-route-time-fence',
        body: requestPath.includes('/tasks/')
          ? { expected_status: 'pending', expected_assignment_version: 1 }
          : { expected_status: 'active', reason: 'Fence direct linked bypass' }
      });
      assert.deepEqual(response, {
        status: 404,
        body: { error: requestPath.includes('/tasks/') ? 'Task not found' : 'Instance not found' },
        requestId: null
      });
    }
    assert.deepEqual(mutationCalls, []);
    assert.deepEqual(archiveCalls, []);
    assert.equal(db.prepare('SELECT status FROM workflow_tasks WHERE id=?').get(linkedTask.id).status, 'pending');
    assert.equal(db.prepare('SELECT status FROM workflow_instances WHERE id=?').get(linkedInstance.id).status, 'active');

    db.prepare(`
      INSERT INTO workflow_templates (
        id,name,description,module,category,nodes,edges,version,is_active,created_by
      ) VALUES (987101,'Legacy fixture','','customer','approval','[]','[]',1,1,?)
    `).run(identity.userId);
    const legacyInstanceId = Number(db.prepare(`
      INSERT INTO workflow_instances (
        template_id,business_type,business_id,current_node_id,status,node_data,started_by
      ) VALUES (987101,'customer',1,'legacy-task','active','{}',?)
    `).run(identity.userId).lastInsertRowid);
    const legacyTaskId = Number(db.prepare(`
      INSERT INTO workflow_tasks (
        instance_id,node_id,node_type,title,description,assignee_id,assignee_role,status
      ) VALUES (?,'legacy-task','task','Legacy task','',?,NULL,'pending')
    `).run(legacyInstanceId, identity.userId).lastInsertRowid);
    for (const action of ['approve', 'reject', 'complete']) {
      assert.deepEqual(await api.post(`/api/workflow/tasks/${legacyTaskId}/${action}`), {
        status: 200,
        body: { success: true },
        requestId: null
      });
    }
    assert.deepEqual(await api.post(`/api/workflow/instances/${legacyInstanceId}/pause`), {
      status: 200,
      body: { success: true },
      requestId: null
    });
    db.prepare("UPDATE workflow_instances SET status='paused' WHERE id=?").run(legacyInstanceId);
    assert.deepEqual(await api.post(`/api/workflow/instances/${legacyInstanceId}/resume`), {
      status: 200,
      body: { success: true },
      requestId: null
    });
    db.prepare("UPDATE workflow_instances SET status='active' WHERE id=?").run(legacyInstanceId);
    assert.deepEqual(await api.post(`/api/workflow/instances/${legacyInstanceId}/cancel`), {
      status: 200,
      body: { success: true },
      requestId: null
    });
    assert.deepEqual(mutationCalls, [
      'task:approve', 'task:reject', 'task:complete',
      'instance:pause', 'instance:resume', 'instance:cancel'
    ]);
    assert.deepEqual(archiveCalls, [
      'task:approve', 'task:reject', 'task:complete',
      'instance:paused', 'instance:resumed', 'instance:cancelled'
    ]);
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
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    db.close();
  }
});

test('dispatcher is a stoppable per-database singleton with one startup drain and 30-second cadence', () => {
  const db = openWorkflowDatabase();
  const isolatedDb = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const first = createCampaignFixture(db, identity, 978001);
    insertCampaignTemplate(db, identity, 988001, terminalGraph());
    transitionCampaign(db, first);
    const scheduled = [];
    const timers = [];
    const clearedTimers = [];
    let unrefCount = 0;
    const schedulerOptions = {
      setIntervalFn(callback, milliseconds) {
        const timerHandle = {
          id: timers.length + 1,
          unref() { unrefCount += 1; }
        };
        timers.push(timerHandle);
        scheduled.push({ callback, milliseconds });
        return timerHandle;
      },
      clearIntervalFn(timer) {
        clearedTimers.push(timer);
      }
    };
    const dispatcher = startCampaignWorkflowDispatcher(db, schedulerOptions);
    assert.equal(dispatchRows(db, first.campaignId)[0].status, 'completed');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].milliseconds, 30_000);
    assert.ok(dispatcher.worker);

    const second = createCampaignFixture(db, identity, 978101);
    transitionCampaign(db, second);
    assert.equal(dispatchRows(db, second.campaignId)[0].status, 'pending');
    const sameDispatcher = startCampaignWorkflowDispatcher(db, schedulerOptions);
    assert.strictEqual(sameDispatcher, dispatcher);
    assert.equal(dispatchRows(db, second.campaignId)[0].status, 'pending');
    assert.equal(scheduled.length, 1);

    const isolatedDispatcher = startCampaignWorkflowDispatcher(isolatedDb, schedulerOptions);
    assert.notStrictEqual(isolatedDispatcher, dispatcher);
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1].milliseconds, 30_000);
    assert.equal(isolatedDispatcher.stop(), true);
    assert.equal(isolatedDispatcher.stop(), false);
    assert.deepEqual(clearedTimers, [timers[1]]);

    scheduled[0].callback();
    assert.equal(dispatchRows(db, second.campaignId)[0].status, 'completed');
    assert.equal(scheduled.length, 2);
    assert.equal(unrefCount, 2);
    assert.equal(dispatcher.stop(), true);
    assert.equal(sameDispatcher.stop(), false);
    assert.deepEqual(clearedTimers, [timers[1], timers[0]]);

    const third = createCampaignFixture(db, identity, 978201);
    transitionCampaign(db, third);
    assert.equal(dispatchRows(db, third.campaignId)[0].status, 'pending');
    const restartedDispatcher = startCampaignWorkflowDispatcher(db, schedulerOptions);
    assert.notStrictEqual(restartedDispatcher, dispatcher);
    assert.equal(dispatchRows(db, third.campaignId)[0].status, 'completed');
    assert.equal(scheduled.length, 3);
    assert.equal(scheduled[2].milliseconds, 30_000);
    assert.equal(unrefCount, 3);
    assert.strictEqual(
      startCampaignWorkflowDispatcher(db, schedulerOptions),
      restartedDispatcher
    );
    assert.equal(scheduled.length, 3);
    assert.equal(dispatcher.stop(), false);
    assert.equal(restartedDispatcher.stop(), true);
    assert.equal(restartedDispatcher.stop(), false);
    assert.deepEqual(clearedTimers, [timers[1], timers[0], timers[2]]);
  } finally {
    isolatedDb.close();
    db.close();
  }
});
