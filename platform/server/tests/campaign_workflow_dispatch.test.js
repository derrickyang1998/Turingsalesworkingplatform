const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const express = require('express');

const migrationService = require('../services/migration_service');
const workflowEvidenceMigration = require('../migrations/003_campaign_workflow_dispatch_evidence');
const campaignContract = require('../contracts/campaign_contract');
const { createPhase4RequestPipeline } = require('../middleware/phase4_request_pipeline');
const { createCampaignService } = require('../services/campaign_service');
const { canonicalJsonBytes } = require('../services/sqlite_digest_service');

const {
  CampaignWorkflowValidationError,
  buildCampaignWorkflowSnapshot,
  checksumCampaignWorkflowSnapshot,
  evaluateCampaignWorkflowCondition,
  validateCampaignWorkflowSnapshot
} = require('../services/campaign_workflow_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CAMPAIGN_MIGRATION_DESCRIPTOR = Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
});
const WORKFLOW_EVIDENCE_MIGRATION_DESCRIPTOR = Object.freeze({
  version: 3,
  name: '003_campaign_workflow_dispatch_evidence',
  sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
});
const WORKFLOW_MIGRATIONS = Object.freeze([
  CAMPAIGN_MIGRATION_DESCRIPTOR,
  WORKFLOW_EVIDENCE_MIGRATION_DESCRIPTOR
]);
const WORKFLOW_TEMPLATE_POLICIES = Object.freeze([
  'WORKFLOW_TEMPLATE_CREATE',
  'WORKFLOW_TEMPLATE_UPDATE',
  'WORKFLOW_TEMPLATE_TRIGGER_GET',
  'WORKFLOW_TEMPLATE_TRIGGER_UPDATE',
  'WORKFLOW_TEMPLATE_PUBLISH',
  'WORKFLOW_TEMPLATE_DELETE'
]);

function goldenWorkflow(overrides = {}) {
  const workflow = {
    snapshot_version: 1,
    template_id: 9,
    template_version: 4,
    module: 'campaign',
    trigger: {
      event_type: 'lifecycle_transition',
      previous_state: 'qualified',
      next_state: 'demand_confirmed'
    },
    nodes: [
      { id: 'task', type: 'task', label: 'Execute', config: { title: 'Execute campaign', description: '', assignee_id: null, assignee_role: 'member', due_hours: null }, x: 180, y: 20, width: 240, height: 96 },
      { id: 'start', type: 'start', label: 'Start', config: {}, x: 0, y: 0 },
      { id: 'end', type: 'end', label: 'End', config: {} },
      { id: 'condition', type: 'condition', label: 'Check state', config: {} },
      { id: 'approve', type: 'approval', label: 'Approval', config: { title: 'Approve campaign', description: '', assignee_id: null, assignee_role: 'org_admin', due_hours: null } }
    ],
    edges: [
      { id: 'task-complete', from: 'task', to: 'end', outcome: 'complete', priority: 0, condition: null },
      { id: 'condition-fallback', from: 'condition', to: 'end', outcome: 'fallback', priority: 1, condition: null },
      { id: 'approve-reject', from: 'approve', to: 'end', outcome: 'reject', priority: 1, condition: null },
      { id: 'start-next', from: 'start', to: 'approve', outcome: 'next', priority: 0, condition: null },
      { id: 'condition-match', from: 'condition', to: 'task', outcome: 'match', priority: 0, condition: { op: 'eq', left: { var: 'event.next_state' }, right: 'demand_confirmed' } },
      { id: 'approve-ok', from: 'approve', to: 'condition', outcome: 'approve', priority: 0, condition: null }
    ]
  };
  return Object.assign(workflow, overrides);
}

function clone(value) {
  return structuredClone(value);
}

function conditionContext(campaignId = 9) {
  return {
    campaign: { id: campaignId, lifecycle_state: 'qualified', operational_status: 'active' },
    event: { event_type: 'lifecycle_transition', previous_state: 'qualified', next_state: 'demand_confirmed' },
    task: { action: null }
  };
}

function comparison(left = true, right = true) {
  return { op: 'eq', left, right };
}

function workflowWithPostHumanConditionRun(count, options = {}) {
  const nodes = [
    { id: 'start', type: 'start', label: 'Start', config: {} },
    { id: 'task', type: 'task', label: 'Task', config: { title: 'Task', description: '', assignee_id: null, assignee_role: 'member', due_hours: null } },
    { id: 'end', type: 'end', label: 'End', config: {} }
  ];
  const edges = [
    { id: 'start-next', from: 'start', to: 'task', outcome: 'next', priority: 0, condition: null },
    { id: 'task-complete', from: 'task', to: count ? 'condition-1' : 'end', outcome: 'complete', priority: 0, condition: null }
  ];
  for (let index = 1; index <= count; index += 1) {
    const id = `condition-${index}`;
    const next = options.cycle && index === count ? 'condition-1' : (index === count ? 'end' : `condition-${index + 1}`);
    nodes.push({ id, type: 'condition', label: `Condition ${index}`, config: {} });
    edges.push({ id: `${id}-match`, from: id, to: next, outcome: 'match', priority: 0, condition: comparison() });
    edges.push({ id: `${id}-fallback`, from: id, to: 'end', outcome: 'fallback', priority: 1, condition: null });
  }
  return goldenWorkflow({ nodes, edges });
}

function workflowWithReconvergentConditions(width) {
  const nodes = [
    { id: 'start', type: 'start', label: 'Start', config: {} },
    { id: 'task', type: 'task', label: 'Task', config: { title: 'Task', description: '', assignee_id: null, assignee_role: 'member', due_hours: null } },
    { id: 'root', type: 'condition', label: 'Root', config: {} },
    { id: 'merge', type: 'condition', label: 'Merge', config: {} },
    { id: 'end', type: 'end', label: 'End', config: {} }
  ];
  const edges = [
    { id: 'start-next', from: 'start', to: 'task', outcome: 'next', priority: 0, condition: null },
    { id: 'task-complete', from: 'task', to: 'root', outcome: 'complete', priority: 0, condition: null },
    { id: 'root-fallback', from: 'root', to: 'end', outcome: 'fallback', priority: width, condition: null },
    { id: 'merge-match', from: 'merge', to: 'end', outcome: 'match', priority: 0, condition: comparison() },
    { id: 'merge-fallback', from: 'merge', to: 'end', outcome: 'fallback', priority: 1, condition: null }
  ];
  for (let index = 0; index < width; index += 1) {
    const id = `branch-${index}`;
    nodes.push({ id, type: 'condition', label: `Branch ${index}`, config: {} });
    edges.push({ id: `root-match-${index}`, from: 'root', to: id, outcome: 'match', priority: index, condition: comparison(index, index) });
    edges.push({ id: `${id}-match`, from: id, to: 'merge', outcome: 'match', priority: 0, condition: comparison() });
    edges.push({ id: `${id}-fallback`, from: id, to: 'end', outcome: 'fallback', priority: 1, condition: null });
  }
  return goldenWorkflow({ nodes, edges });
}

function nestedNot(wrapperCount) {
  let expression = comparison();
  for (let index = 0; index < wrapperCount; index += 1) expression = { op: 'not', arg: expression };
  return expression;
}

function expressionWithNodeCount(count) {
  if (count === 100) {
    return { op: 'and', args: Array.from({ length: 9 }, () => ({ op: 'and', args: Array.from({ length: 10 }, () => comparison()) })) };
  }
  if (count === 101) {
    return {
      op: 'and',
      args: [
        ...Array.from({ length: 9 }, () => ({ op: 'and', args: Array.from({ length: 10 }, () => comparison()) })),
        comparison()
      ]
    };
  }
  throw new Error(`unsupported test expression count ${count}`);
}

function setMatchCondition(workflow, condition) {
  workflow.edges.find((edge) => edge.id === 'condition-match').condition = condition;
  return workflow;
}

function openCampaignV2Database() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: [CAMPAIGN_MIGRATION_DESCRIPTOR]
  });
  return db;
}

function openWorkflowDatabase() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: WORKFLOW_MIGRATIONS
  });
  return db;
}

function workflowIdentity(db, role = 'admin') {
  const identity = db.prepare(`
    SELECT
      user.id AS userId,
      user.role AS platformRole,
      organization_membership.org_id AS orgId,
      organization_membership.role_code AS organizationRole,
      team_membership.team_id AS teamId
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
  `).get(role);
  assert.ok(identity, `missing active ${role} workflow identity`);
  return identity;
}

async function startWorkflowApi(db, actorUserId) {
  process.env.NODE_ENV = 'test';
  process.env.TM_DISABLE_DOTENV = '1';
  process.env.DB_PATH = ':memory:';
  const registerWorkflowRoutes = require('../routes_workflow');
  const registry = campaignContract.createRoutePolicyRegistry(
    WORKFLOW_TEMPLATE_POLICIES.map((name) => campaignContract.REQUEST_POLICIES[name])
  );
  const app = express();
  const pipeline = createPhase4RequestPipeline({
    registry,
    authenticate(request) {
      const user = db.prepare(`
        SELECT id,username,display_name,role,department,is_active
        FROM users
        WHERE id=? AND is_active=1
      `).get(actorUserId);
      if (!user) return null;
      request.user = user;
      return { user };
    },
    generateRequestId: () => 'task6-workflow-request'
  });
  const authMiddleware = (request, response, next) => {
    if (!request.user) {
      request.user = db.prepare(`
        SELECT id,username,display_name,role,department,is_active
        FROM users
        WHERE id=? AND is_active=1
      `).get(actorUserId);
    }
    return request.user
      ? next()
      : response.status(401).json({ error: 'Authentication required' });
  };
  const adminOnly = (request, response, next) => (
    request.user && request.user.role === 'admin'
      ? next()
      : response.status(403).json({ error: 'Admin only' })
  );
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
  registerWorkflowRoutes(app, db, authMiddleware, adminOnly);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    async request(method, requestPath, options = {}) {
      const headers = {
        Authorization: 'Bearer task6-workflow-token',
        'X-Request-Id': options.requestId || 'task6-workflow-request'
      };
      let body;
      if (Object.hasOwn(options, 'form')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
        body = new URLSearchParams(options.form).toString();
      } else if (Object.hasOwn(options, 'body')) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        body = JSON.stringify(options.body);
      }
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
      const response = await fetch(baseUrl + requestPath, { method, headers, body });
      return {
        status: response.status,
        body: await response.json()
      };
    },
    async close() {
      server.close();
      await once(server, 'close');
    }
  };
}

function minimalCampaignGraph() {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Start', config: {}, x: 20, y: 40 },
      { id: 'end', type: 'end', label: 'End', config: {}, x: 260, y: 40 }
    ],
    edges: [
      { id: 'start-next', from: 'start', to: 'end', outcome: 'next', priority: 0, condition: null }
    ]
  };
}

function campaignTemplateBody(overrides = {}) {
  const graph = minimalCampaignGraph();
  return {
    name: 'Campaign lifecycle workflow',
    description: 'Task 6 campaign workflow fixture',
    module: 'campaign',
    category: 'approval',
    nodes: graph.nodes,
    edges: graph.edges,
    ...overrides
  };
}

function createCampaignFixture(db, identity, campaignId = 970001) {
  const customerId = campaignId + 1;
  const opportunityId = campaignId + 2;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (?,?,?,'qualified','test',?,?)
  `).run(customerId, 'Workflow Campaign', 'Workflow Campaign Ltd', identity.userId, identity.userId);
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
    'Workflow campaign fixture',
    customerId,
    opportunityId,
    identity.userId,
    identity.teamId
  );
  return {
    ...identity,
    campaignId,
    customerId,
    opportunityId
  };
}

function insertCampaignTemplate(db, {
  id,
  createdBy,
  trigger,
  name = `Workflow template ${id}`,
  active = 1,
  module = 'campaign',
  version = 1,
  graph = minimalCampaignGraph()
}) {
  db.prepare(`
    INSERT INTO workflow_templates (
      id,name,description,module,category,nodes,edges,version,is_active,
      created_by,trigger_config_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    name,
    'Task 6 dispatch fixture',
    module,
    'approval',
    JSON.stringify(graph.nodes),
    JSON.stringify(graph.edges),
    version,
    active,
    createdBy,
    trigger === null ? null : JSON.stringify(trigger)
  );
}

function leadQualifiedTrigger() {
  return {
    event_type: 'lifecycle_transition',
    previous_state: 'lead',
    next_state: 'qualified'
  };
}

test('003 upgrades an applied checksum-pinned v2 database and backfills immutable dispatch labels', () => {
  const db = openCampaignV2Database();
  const identity = workflowIdentity(db, 'admin');
  const context = createCampaignFixture(db, identity, 969001);
  const service = createCampaignService(db);
  const transition = service.transitionCampaign({
    userId: identity.userId,
    campaignId: context.campaignId,
    requestId: 'task6-v2-upgrade-root-request',
    idempotencyKey: 'task6-v2-upgrade-root-0001',
    body: {
      expected_state: 'lead',
      expected_version: 1,
      next_state: 'qualified',
      reason: 'Create v2 workflow dispatch upgrade fixture'
    }
  });
  assert.equal(transition.status, 200);
  const templateId = 979901;
  const templateName = 'Pinned v2 campaign workflow';
  insertCampaignTemplate(db, {
    id: templateId,
    createdBy: identity.userId,
    name: templateName,
    trigger: leadQualifiedTrigger(),
    active: 1
  });
  const snapshot = buildCampaignWorkflowSnapshot({
    snapshot_version: 1,
    template_id: templateId,
    template_version: 1,
    module: 'campaign',
    trigger: leadQualifiedTrigger(),
    ...minimalCampaignGraph()
  });
  const snapshotJson = canonicalJsonBytes(snapshot).toString('utf8');
  db.prepare(`
    INSERT INTO campaign_workflow_dispatches (
      org_id,campaign_id,event_id,trigger_event_id,template_id,template_version,
      template_checksum,template_snapshot_json,execution_context_json
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    context.orgId,
    context.campaignId,
    transition.body.event.id,
    transition.body.event.id,
    templateId,
    1,
    checksumCampaignWorkflowSnapshot(snapshot),
    snapshotJson,
    JSON.stringify({
      campaign: {
        id: context.campaignId,
        lifecycle_state: 'qualified',
        operational_status: 'active'
      },
      event: leadQualifiedTrigger()
    })
  );
  const fallbackLabels = [
    { templateId: 979902, name: '' },
    { templateId: 979903, name: 'x'.repeat(1001) },
    { templateId: 979904, name: 'Unsafe\u0000label' }
  ];
  for (const scenario of fallbackLabels) {
    insertCampaignTemplate(db, {
      id: scenario.templateId,
      createdBy: identity.userId,
      name: scenario.name,
      trigger: leadQualifiedTrigger(),
      active: 1
    });
    const fallbackSnapshot = buildCampaignWorkflowSnapshot({
      snapshot_version: 1,
      template_id: scenario.templateId,
      template_version: 1,
      module: 'campaign',
      trigger: leadQualifiedTrigger(),
      ...minimalCampaignGraph()
    });
    db.prepare(`
      INSERT INTO campaign_workflow_dispatches (
        org_id,campaign_id,event_id,trigger_event_id,template_id,template_version,
        template_checksum,template_snapshot_json,execution_context_json
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      context.orgId,
      context.campaignId,
      transition.body.event.id,
      transition.body.event.id,
      scenario.templateId,
      1,
      checksumCampaignWorkflowSnapshot(fallbackSnapshot),
      canonicalJsonBytes(fallbackSnapshot).toString('utf8'),
      JSON.stringify({
        campaign: {
          id: context.campaignId,
          lifecycle_state: 'qualified',
          operational_status: 'active'
        },
        event: leadQualifiedTrigger()
      })
    );
  }
  const v2Ledger = db.prepare(`
    SELECT checksum
    FROM schema_migrations
    WHERE version=2 AND name='002_campaign_business_spine'
  `).get();
  assert.ok(v2Ledger);

  try {
    assert.deepEqual(
      migrationService.runMigrations(db, {
        rootDir: SERVER_ROOT,
        registeredMigrations: WORKFLOW_MIGRATIONS
      }),
      { status: 'managed', currentVersion: 3 }
    );
    assert.deepEqual(
      db.prepare(`
        SELECT template_id,template_label
        FROM campaign_workflow_dispatches
        ORDER BY template_id
      `).all(),
      [
        { template_id: templateId, template_label: templateName },
        { template_id: 979902, template_label: 'Workflow template #979902' },
        { template_id: 979903, template_label: 'Workflow template #979903' },
        { template_id: 979904, template_label: 'Workflow template #979904' }
      ]
    );
    const labelColumn = db.pragma('table_xinfo("campaign_workflow_dispatches")')
      .find((column) => column.name === 'template_label');
    assert.deepEqual(
      { type: labelColumn.type, notnull: labelColumn.notnull, defaultValue: labelColumn.dflt_value },
      { type: 'TEXT', notnull: 1, defaultValue: "'Workflow template'" }
    );
    assert.throws(
      () => db.prepare(`
        UPDATE campaign_workflow_dispatches
        SET template_label='Changed label'
      `).run(),
      /campaign workflow template label is immutable/
    );
    assert.equal(
      db.prepare('SELECT checksum FROM schema_migrations WHERE version=2').get().checksum,
      v2Ledger.checksum
    );
    assert.deepEqual(
      db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all(),
      [
        { version: 1, name: '001_legacy_compat_columns' },
        { version: 2, name: '002_campaign_business_spine' },
        { version: 3, name: '003_campaign_workflow_dispatch_evidence' }
      ]
    );
    assert.deepEqual(
      migrationService.runMigrations(db, {
        rootDir: SERVER_ROOT,
        registeredMigrations: WORKFLOW_MIGRATIONS
      }),
      { status: 'managed', currentVersion: 3 }
    );
  } finally {
    db.close();
  }
});

test('003 rejects partial template-label column and trigger states before mutation', () => {
  const scenarios = [
    {
      expected: /partial 003 template_label column exists/,
      arrange(db) {
        db.exec(`
          ALTER TABLE campaign_workflow_dispatches
          ADD COLUMN template_label TEXT NOT NULL DEFAULT 'Workflow template'
        `);
      }
    },
    {
      expected: /partial 003 template label trigger exists/,
      arrange(db) {
        db.exec(`
          CREATE TRIGGER campaign_workflow_dispatches_template_label_immutable
          BEFORE UPDATE ON campaign_workflow_dispatches
          BEGIN
            SELECT 1;
          END
        `);
      }
    }
  ];

  for (const scenario of scenarios) {
    const db = openCampaignV2Database();
    try {
      scenario.arrange(db);
      assert.throws(() => workflowEvidenceMigration.apply(db), scenario.expected);
      assert.ok(db.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type='trigger' AND name='campaign_workflow_dispatches_legal_transition'
      `).get());
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=3').get().count,
        0
      );
    } finally {
      db.close();
    }
  }
});

test('builds the documented immutable v1 workflow snapshot and checksum', () => {
  const snapshot = buildCampaignWorkflowSnapshot(goldenWorkflow());

  assert.deepEqual(Object.keys(snapshot), [
    'snapshot_version', 'template_id', 'template_version', 'module', 'trigger', 'nodes', 'edges'
  ]);
  assert.deepEqual(snapshot.nodes.map((node) => node.id), ['approve', 'condition', 'end', 'start', 'task']);
  assert.deepEqual(snapshot.edges.map((edge) => edge.id), [
    'approve-ok', 'approve-reject', 'condition-match', 'condition-fallback', 'start-next', 'task-complete'
  ]);
  assert.equal('x' in snapshot.nodes[4], false);
  assert.equal('y' in snapshot.nodes[4], false);
  assert.equal('width' in snapshot.nodes[4], false);
  assert.equal('height' in snapshot.nodes[4], false);
  assert.equal(
    checksumCampaignWorkflowSnapshot(snapshot),
    '4327b1af3ab96b895a2e93eebb0d4223d1fe79f39f6cf24edc25b8d2a3d22fd9'
  );
});

test('deep-freezes snapshots and detaches every nested execution value from authoring input', () => {
  const authoring = goldenWorkflow();
  const snapshot = buildCampaignWorkflowSnapshot(authoring);

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.trigger), true);
  assert.equal(Object.isFrozen(snapshot.nodes), true);
  assert.equal(Object.isFrozen(snapshot.nodes[0]), true);
  assert.equal(Object.isFrozen(snapshot.nodes[0].config), true);
  assert.equal(Object.isFrozen(snapshot.edges), true);
  assert.equal(Object.isFrozen(snapshot.edges[2]), true);
  assert.equal(Object.isFrozen(snapshot.edges[2].condition), true);
  assert.equal(Object.isFrozen(snapshot.edges[2].condition.left), true);

  authoring.trigger.next_state = 'proposal_draft';
  authoring.nodes[0].config.title = 'Mutated title';
  authoring.edges.find((edge) => edge.id === 'condition-match').condition.right = 'mutated';
  assert.equal(snapshot.trigger.next_state, 'demand_confirmed');
  assert.equal(snapshot.nodes.find((node) => node.id === 'task').config.title, 'Execute campaign');
  assert.equal(snapshot.edges.find((edge) => edge.id === 'condition-match').condition.right, 'demand_confirmed');
});

test('keeps checksum invariant across authoring layout and permutations but sensitive to execution semantics', () => {
  const first = goldenWorkflow();
  const second = clone(first);
  second.nodes.reverse();
  second.edges.reverse();
  for (const [index, node] of second.nodes.entries()) {
    node.x = index * 17;
    node.y = index * -11;
    node.width = 300 + index;
    node.height = 100 + index;
  }
  const semanticChange = clone(first);
  semanticChange.nodes.find((node) => node.id === 'task').config.title = 'Different execution title';

  assert.equal(
    checksumCampaignWorkflowSnapshot(buildCampaignWorkflowSnapshot(first)),
    checksumCampaignWorkflowSnapshot(buildCampaignWorkflowSnapshot(second))
  );
  assert.notEqual(
    checksumCampaignWorkflowSnapshot(buildCampaignWorkflowSnapshot(first)),
    checksumCampaignWorkflowSnapshot(buildCampaignWorkflowSnapshot(semanticChange))
  );
});

test('accepts layout only while building and rejects it in stored execution snapshots and checksums', () => {
  const authoring = goldenWorkflow();
  const snapshot = buildCampaignWorkflowSnapshot(authoring);

  assert.doesNotThrow(() => validateCampaignWorkflowSnapshot(snapshot));
  assert.throws(() => validateCampaignWorkflowSnapshot(authoring), /unknown|layout/i);
  assert.throws(() => checksumCampaignWorkflowSnapshot(authoring), /unknown|layout/i);

  const invalidLayout = goldenWorkflow();
  invalidLayout.nodes[0].x = Number.POSITIVE_INFINITY;
  assert.throws(() => buildCampaignWorkflowSnapshot(invalidLayout), /finite/i);
});

test('normalizes negative zero before snapshot hashing and condition semantics', () => {
  const positiveZero = goldenWorkflow();
  const negativeZero = goldenWorkflow();
  negativeZero.edges.find((edge) => edge.id === 'start-next').priority = -0;
  const positiveSnapshot = buildCampaignWorkflowSnapshot(positiveZero);
  const negativeSnapshot = buildCampaignWorkflowSnapshot(negativeZero);
  const normalizedPriority = negativeSnapshot.edges.find((edge) => edge.id === 'start-next').priority;

  assert.equal(Object.is(normalizedPriority, 0), true);
  assert.equal(Object.is(normalizedPriority, -0), false);
  assert.equal(checksumCampaignWorkflowSnapshot(negativeSnapshot), checksumCampaignWorkflowSnapshot(positiveSnapshot));

  const context = conditionContext(-0);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'eq', left: { var: 'campaign.id' }, right: 0 }, context), true);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'neq', left: { var: 'campaign.id' }, right: 0 }, context), false);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'in', left: { var: 'campaign.id' }, right: [0] }, context), true);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'eq', left: 0, right: -0 }, context), true);

  const positiveLiteral = setMatchCondition(goldenWorkflow(), { op: 'eq', left: 0, right: 0 });
  const negativeLiteral = setMatchCondition(goldenWorkflow(), { op: 'eq', left: 0, right: -0 });
  const positiveLiteralSnapshot = buildCampaignWorkflowSnapshot(positiveLiteral);
  const negativeLiteralSnapshot = buildCampaignWorkflowSnapshot(negativeLiteral);
  const normalizedLiteral = negativeLiteralSnapshot.edges.find((edge) => edge.id === 'condition-match').condition.right;
  assert.equal(Object.is(normalizedLiteral, 0), true);
  assert.equal(Object.is(normalizedLiteral, -0), false);
  assert.equal(checksumCampaignWorkflowSnapshot(negativeLiteralSnapshot), checksumCampaignWorkflowSnapshot(positiveLiteralSnapshot));
});

test('uses one strict equality relation for eq, neq, and in', () => {
  const context = conditionContext();

  assert.equal(evaluateCampaignWorkflowCondition({ op: 'eq', left: 9, right: '9' }, context), false);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'neq', left: 9, right: '9' }, context), true);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'in', left: 9, right: ['9'] }, context), false);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'gt', left: 'b', right: 'a' }, context), false);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'gte', left: 9, right: 9 }, context), true);
});

test('requires condition fallback priority to be greater than every match priority', () => {
  const workflow = goldenWorkflow();
  workflow.edges.find((edge) => edge.id === 'condition-match').priority = 2;
  workflow.edges.find((edge) => edge.id === 'condition-fallback').priority = 1;

  assert.throws(() => buildCampaignWorkflowSnapshot(workflow), /fallback.*priority|priority.*fallback/i);
});

test('rejects pure automatic cycles reached after a human task boundary', () => {
  assert.throws(
    () => buildCampaignWorkflowSnapshot(workflowWithPostHumanConditionRun(2, { cycle: true })),
    /automatic cycle/i
  );
});

test('allows 100 but rejects 101 automatic nodes after a human boundary', () => {
  assert.doesNotThrow(() => buildCampaignWorkflowSnapshot(workflowWithPostHumanConditionRun(100)));
  assert.throws(() => buildCampaignWorkflowSnapshot(workflowWithPostHumanConditionRun(101)), /100 automatic nodes/i);
});

test('rejects adversarial automatic chains with a bounded validation error instead of overflowing the call stack', () => {
  assert.throws(
    () => buildCampaignWorkflowSnapshot(workflowWithPostHumanConditionRun(5000)),
    (error) => {
      assert.equal(error instanceof CampaignWorkflowValidationError, true);
      assert.match(error.message, /100 automatic nodes/i);
      return true;
    }
  );
});

test('validates a wide reconvergent automatic DAG without repeated-path expansion', () => {
  assert.doesNotThrow(() => buildCampaignWorkflowSnapshot(workflowWithReconvergentConditions(500)));
});

test('counts bounded strings by Unicode scalar values and rejects isolated surrogates', () => {
  const astral = '\u{1F680}';
  const exactBoundary = goldenWorkflow();
  exactBoundary.nodes.find((node) => node.id === 'start').label = astral.repeat(160);
  const overBoundary = goldenWorkflow();
  overBoundary.nodes.find((node) => node.id === 'start').label = astral.repeat(161);
  const isolatedSurrogate = goldenWorkflow();
  isolatedSurrogate.nodes.find((node) => node.id === 'start').label = '\uD800';

  assert.equal(buildCampaignWorkflowSnapshot(exactBoundary).nodes.find((node) => node.id === 'start').label, astral.repeat(160));
  assert.throws(() => buildCampaignWorkflowSnapshot(overBoundary), /length/i);
  assert.throws(() => buildCampaignWorkflowSnapshot(isolatedSurrogate), /Unicode scalar/i);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'eq', left: astral.repeat(160), right: astral.repeat(160) }, conditionContext()), true);
  assert.throws(
    () => evaluateCampaignWorkflowCondition({ op: 'eq', left: astral.repeat(161), right: astral.repeat(161) }, conditionContext()),
    /length/i
  );
});

test('locks graph identifier, priority, start, and end schema boundaries', () => {
  const duplicateNode = goldenWorkflow();
  duplicateNode.nodes.find((node) => node.id === 'end').id = 'task';
  const duplicateEdge = goldenWorkflow();
  duplicateEdge.edges.find((edge) => edge.id === 'task-complete').id = 'start-next';
  const duplicatePriority = goldenWorkflow();
  duplicatePriority.edges.find((edge) => edge.id === 'condition-fallback').priority = 0;
  const multipleStart = goldenWorkflow();
  multipleStart.nodes.find((node) => node.id === 'end').type = 'start';
  const endOutgoing = goldenWorkflow();
  endOutgoing.edges.push({ id: 'end-next', from: 'end', to: 'end', outcome: 'next', priority: 0, condition: null });

  assert.throws(() => buildCampaignWorkflowSnapshot(duplicateNode), /node ids.*unique/i);
  assert.throws(() => buildCampaignWorkflowSnapshot(duplicateEdge), /edge ids.*unique/i);
  assert.throws(() => buildCampaignWorkflowSnapshot(duplicatePriority), /priorities.*unique/i);
  assert.throws(() => buildCampaignWorkflowSnapshot(multipleStart), /one start/i);
  assert.throws(() => buildCampaignWorkflowSnapshot(endOutgoing), /end.*outgoing/i);
});

test('locks condition depth, count, homogeneous arrays, and explicit empty-in behavior', () => {
  assert.doesNotThrow(() => buildCampaignWorkflowSnapshot(setMatchCondition(goldenWorkflow(), nestedNot(7))));
  assert.throws(() => buildCampaignWorkflowSnapshot(setMatchCondition(goldenWorkflow(), nestedNot(8))), /depth/i);
  assert.doesNotThrow(() => buildCampaignWorkflowSnapshot(setMatchCondition(goldenWorkflow(), expressionWithNodeCount(100))));
  assert.throws(() => buildCampaignWorkflowSnapshot(setMatchCondition(goldenWorkflow(), expressionWithNodeCount(101))), /too many/i);
  assert.throws(
    () => evaluateCampaignWorkflowCondition({ op: 'in', left: 1, right: [1, '1'] }, conditionContext()),
    /types.*match/i
  );
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'in', left: 1, right: [] }, conditionContext()), false);
});

test('requires an exact adjacent campaign lifecycle trigger', () => {
  const invalidEventType = goldenWorkflow({ trigger: { event_type: 'campaign_updated', previous_state: 'qualified', next_state: 'demand_confirmed' } });
  const skippedState = goldenWorkflow({ trigger: { event_type: 'lifecycle_transition', previous_state: 'qualified', next_state: 'proposal_draft' } });

  assert.throws(() => validateCampaignWorkflowSnapshot(invalidEventType), /trigger/i);
  assert.throws(() => validateCampaignWorkflowSnapshot(skippedState), /adjacent/i);
});

test('rejects unknown workflow fields, unsupported nodes, invalid action edges, and unreachable graph paths', () => {
  const unknownNodeField = goldenWorkflow();
  unknownNodeField.nodes[0].extra = true;
  const unsupportedNode = goldenWorkflow();
  unsupportedNode.nodes[0].type = 'timer';
  const missingApprovalReject = goldenWorkflow();
  missingApprovalReject.edges = missingApprovalReject.edges.filter((edge) => edge.id !== 'approve-reject');
  const unreachableNode = goldenWorkflow();
  unreachableNode.nodes.push({ id: 'unused', type: 'end', label: 'Unused', config: {} });

  assert.throws(() => buildCampaignWorkflowSnapshot(unknownNodeField), /unknown/i);
  assert.throws(() => buildCampaignWorkflowSnapshot(unsupportedNode), /unsupported/i);
  assert.throws(() => buildCampaignWorkflowSnapshot(missingApprovalReject), /reject/i);
  assert.throws(() => buildCampaignWorkflowSnapshot(unreachableNode), /reachable/i);
});

test('enforces strict condition variables and comparisons without coercion', () => {
  const context = {
    campaign: { id: 9, lifecycle_state: 'qualified', operational_status: 'active' },
    event: { event_type: 'lifecycle_transition', previous_state: 'qualified', next_state: 'demand_confirmed' },
    task: { action: null },
    mutableCampaign: { lifecycle_state: 'settled' }
  };

  assert.equal(evaluateCampaignWorkflowCondition({ op: 'eq', left: { var: 'event.next_state' }, right: 'demand_confirmed' }, context), true);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'eq', left: { var: 'campaign.id' }, right: '9' }, context), false);
  assert.equal(evaluateCampaignWorkflowCondition({ op: 'in', left: { var: 'task.action' }, right: [null] }, context), true);
  assert.throws(() => evaluateCampaignWorkflowCondition({ op: 'eq', left: { var: 'mutableCampaign.lifecycle_state' }, right: 'settled' }, context), /variable/i);
  assert.throws(
    () => evaluateCampaignWorkflowCondition({ op: 'eq', left: { var: 'campaign.id' }, right: Number.POSITIVE_INFINITY }, context),
    CampaignWorkflowValidationError
  );
});

test('keeps legacy non-campaign template response shapes and authoring behavior unchanged', async () => {
  const db = openWorkflowDatabase();
  const admin = workflowIdentity(db, 'admin');
  const api = await startWorkflowApi(db, admin.userId);
  try {
    const created = await api.request('POST', '/api/workflow/templates', {
      form: {
        name: 'Legacy approval',
        description: 'Legacy workflow',
        module: 'customer',
        category: 'approval'
      }
    });
    assert.equal(created.status, 200);
    assert.deepEqual(Object.keys(created.body), ['id']);

    const detail = await api.request('GET', `/api/workflow/templates/${created.body.id}`);
    assert.equal(detail.status, 200);
    assert.equal(Object.hasOwn(detail.body.template, 'trigger_config_json'), false);
    assert.deepEqual(detail.body.template.nodes, []);
    assert.deepEqual(detail.body.template.edges, []);
    const archived = db.prepare(`
      SELECT content
      FROM knowledge_entries
      WHERE source_type='workflow_template' AND source_id=?
      ORDER BY id DESC
      LIMIT 1
    `).get(String(created.body.id));
    assert.ok(archived);
    assert.equal(Object.hasOwn(JSON.parse(archived.content), 'trigger_config_json'), false);

    const updated = await api.request('PUT', `/api/workflow/templates/${created.body.id}`, {
      form: { description: 'Legacy workflow updated' }
    });
    assert.deepEqual(updated, { status: 200, body: { success: true } });
    const row = db.prepare(`
      SELECT module,description,version,is_active
      FROM workflow_templates
      WHERE id=?
    `).get(created.body.id);
    assert.deepEqual(row, {
      module: 'customer',
      description: 'Legacy workflow updated',
      version: 2,
      is_active: 1
    });

    const published = await api.request('POST', `/api/workflow/templates/${created.body.id}/publish`, {
      idempotencyKey: 'legacy-publish-header-is-ignored'
    });
    assert.deepEqual(published, { status: 200, body: { success: true } });
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM request_idempotency WHERE idempotency_key=?')
        .get('legacy-publish-header-is-ignored').count,
      0
    );
    const deleted = await api.request('DELETE', `/api/workflow/templates/${created.body.id}`);
    assert.deepEqual(deleted, { status: 200, body: { success: true } });
  } finally {
    await api.close();
    db.close();
  }
});

test('shared template routes retain legacy media while campaign operations require JSON', async () => {
  const db = openWorkflowDatabase();
  const admin = workflowIdentity(db, 'admin');
  const templateId = 979601;
  insertCampaignTemplate(db, {
    id: templateId,
    createdBy: admin.userId,
    trigger: leadQualifiedTrigger(),
    active: 0
  });
  const api = await startWorkflowApi(db, admin.userId);
  try {
    const create = await api.request('POST', '/api/workflow/templates', {
      idempotencyKey: 'campaign-form-create-is-rejected',
      form: { name: 'Campaign form', module: 'campaign' }
    });
    assert.equal(create.status, 415);
    assert.equal(create.body.code, 'UNSUPPORTED_MEDIA_TYPE');

    const update = await api.request('PUT', `/api/workflow/templates/${templateId}`, {
      idempotencyKey: 'campaign-form-update-is-rejected',
      form: { expected_version: '1', description: 'Form update' }
    });
    assert.equal(update.status, 415);
    assert.equal(update.body.code, 'UNSUPPORTED_MEDIA_TYPE');

    const publish = await api.request('POST', `/api/workflow/templates/${templateId}/publish`, {
      idempotencyKey: 'campaign-empty-publish-rejected'
    });
    assert.equal(publish.status, 415);
    assert.equal(publish.body.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.deepEqual(
      db.prepare('SELECT version,is_active FROM workflow_templates WHERE id=?').get(templateId),
      { version: 1, is_active: 0 }
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM request_idempotency
        WHERE idempotency_key IN (
          'campaign-form-create-is-rejected',
          'campaign-form-update-is-rejected',
          'campaign-empty-publish-rejected'
        )
      `).get().count,
      0
    );
  } finally {
    await api.close();
    db.close();
  }
});

test('campaign template text is normalized before storage and hashing and rejects controls', async () => {
  const db = openWorkflowDatabase();
  const admin = workflowIdentity(db, 'admin');
  const api = await startWorkflowApi(db, admin.userId);
  const idempotencyKey = 'campaign-template-normalized-text';
  try {
    const created = await api.request('POST', '/api/workflow/templates', {
      idempotencyKey,
      body: campaignTemplateBody({
        name: '  Cafe\u0301\r\nWorkflow  ',
        description: '  Canonical\r\ndescription  '
      })
    });
    assert.equal(created.status, 200);
    assert.deepEqual(
      db.prepare('SELECT name,description FROM workflow_templates WHERE id=?').get(created.body.id),
      { name: 'Cafe\u0301\nWorkflow'.normalize('NFC'), description: 'Canonical\ndescription' }
    );

    const replay = await api.request('POST', '/api/workflow/templates', {
      idempotencyKey,
      body: campaignTemplateBody({
        name: 'Cafe\u0301\nWorkflow'.normalize('NFC'),
        description: 'Canonical\ndescription'
      })
    });
    assert.deepEqual(replay, created);

    const invalid = await api.request('POST', '/api/workflow/templates', {
      idempotencyKey: 'campaign-template-control-text',
      body: campaignTemplateBody({ name: 'Unsafe\u0000workflow' })
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INVALID_CAMPAIGN_INPUT');
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM workflow_templates WHERE module='campaign'`).get().count,
      1
    );
  } finally {
    await api.close();
    db.close();
  }
});

test('manual workflow start rejects campaign templates and campaign business context', async () => {
  const db = openWorkflowDatabase();
  const identity = workflowIdentity(db, 'admin');
  insertCampaignTemplate(db, {
    id: 979001,
    createdBy: identity.userId,
    trigger: leadQualifiedTrigger(),
    active: 1
  });
  insertCampaignTemplate(db, {
    id: 979002,
    createdBy: identity.userId,
    trigger: null,
    active: 1,
    module: 'customer'
  });
  const api = await startWorkflowApi(db, identity.userId);
  try {
    const campaignTemplate = await api.request('POST', '/api/workflow/instances', {
      body: {
        template_id: 979001,
        business_type: 'customer',
        business_id: 123,
        data: {}
      }
    });
    assert.equal(campaignTemplate.status, 400, JSON.stringify(campaignTemplate));
    assert.equal(campaignTemplate.body.code, 'INVALID_CAMPAIGN_INPUT');

    const campaignContext = await api.request('POST', '/api/workflow/instances', {
      body: {
        template_id: 979002,
        business_type: 'campaign',
        business_id: 456,
        data: {}
      }
    });
    assert.equal(campaignContext.status, 400);
    assert.equal(campaignContext.body.code, 'INVALID_CAMPAIGN_INPUT');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM workflow_instances').get().count,
      0
    );
  } finally {
    await api.close();
    db.close();
  }
});

test('template deletion reports a stable dependency conflict for legacy workflow instances', async () => {
  const db = openWorkflowDatabase();
  const admin = workflowIdentity(db, 'admin');
  const api = await startWorkflowApi(db, admin.userId);
  try {
    const created = await api.request('POST', '/api/workflow/templates', {
      body: { name: 'Referenced legacy template', module: 'customer', nodes: [], edges: [] }
    });
    assert.equal(created.status, 200);
    db.prepare(`
      INSERT INTO workflow_instances (
        template_id,business_type,business_id,status,node_data,started_by
      ) VALUES (?,'customer',123,'active','{}',?)
    `).run(created.body.id, admin.userId);

    const blocked = await api.request('DELETE', `/api/workflow/templates/${created.body.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'WORKFLOW_TEMPLATE_HAS_DEPENDENCIES');
    assert.deepEqual(blocked.body.details, { dispatch_count: 0 });
    assert.ok(db.prepare('SELECT id FROM workflow_templates WHERE id=?').get(created.body.id));
  } finally {
    await api.close();
    db.close();
  }
});

test('campaign graph, publish, and delete validate requests before platform-admin authorization', async () => {
  const db = openWorkflowDatabase();
  const admin = workflowIdentity(db, 'admin');
  const member = workflowIdentity(db, 'user');
  const templateId = 979701;
  insertCampaignTemplate(db, {
    id: templateId,
    createdBy: admin.userId,
    trigger: leadQualifiedTrigger(),
    active: 0
  });
  const legacyTemplateId = 979702;
  insertCampaignTemplate(db, {
    id: legacyTemplateId,
    createdBy: admin.userId,
    trigger: null,
    active: 1,
    module: 'customer'
  });
  const api = await startWorkflowApi(db, member.userId);
  try {
    const missingGraphKey = await api.request(
      'PUT',
      `/api/workflow/templates/${legacyTemplateId}`,
      { body: { expected_version: 1, name: 'Must not use the legacy branch' } }
    );
    assert.equal(missingGraphKey.status, 400);
    assert.equal(missingGraphKey.body.code, 'IDEMPOTENCY_REQUIRED');
    assert.deepEqual(
      db.prepare('SELECT name,version FROM workflow_templates WHERE id=?').get(legacyTemplateId),
      { name: `Workflow template ${legacyTemplateId}`, version: 1 }
    );

    const malformedGraph = await api.request(
      'PUT',
      '/api/workflow/templates/not-an-id',
      { body: { expected_version: 1 } }
    );
    assert.equal(malformedGraph.status, 400);
    assert.equal(malformedGraph.body.code, 'INVALID_CAMPAIGN_INPUT');

    const unresolvedGraph = await api.request(
      'PUT',
      '/api/workflow/templates/979799',
      { body: { expected_version: 1 } }
    );
    assert.equal(unresolvedGraph.status, 400);
    assert.equal(unresolvedGraph.body.code, 'IDEMPOTENCY_REQUIRED');

    const missingKey = await api.request(
      'POST',
      `/api/workflow/templates/${templateId}/publish`,
      { body: { expected_version: 1 } }
    );
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.code, 'IDEMPOTENCY_REQUIRED');

    const malformedPublish = await api.request(
      'POST',
      '/api/workflow/templates/not-an-id/publish',
      {
        idempotencyKey: 'campaign-template-invalid-publish-id',
        body: { expected_version: 1 }
      }
    );
    assert.equal(malformedPublish.status, 400);
    assert.equal(malformedPublish.body.code, 'INVALID_CAMPAIGN_INPUT');

    const unresolvedMissingKey = await api.request(
      'POST',
      '/api/workflow/templates/979799/publish',
      { body: { expected_version: 1 } }
    );
    assert.equal(unresolvedMissingKey.status, 400);
    assert.equal(unresolvedMissingKey.body.code, 'IDEMPOTENCY_REQUIRED');

    const malformedDelete = await api.request('DELETE', '/api/workflow/templates/not-an-id');
    assert.equal(malformedDelete.status, 400);
    assert.equal(malformedDelete.body.code, 'INVALID_CAMPAIGN_INPUT');
  } finally {
    await api.close();
    db.close();
  }
});

test('campaign template APIs enforce admin, idempotency, version, trigger, graph, and publish contracts', async () => {
  const db = openWorkflowDatabase();
  const admin = workflowIdentity(db, 'admin');
  const member = workflowIdentity(db, 'user');
  const adminApi = await startWorkflowApi(db, admin.userId);
  const memberApi = await startWorkflowApi(db, member.userId);
  const body = campaignTemplateBody();
  try {
    const malformedMember = await memberApi.request('POST', '/api/workflow/templates', {
      idempotencyKey: 'campaign-template-member-invalid',
      body: { name: '   ', module: 'campaign' }
    });
    assert.equal(malformedMember.status, 400);
    assert.equal(malformedMember.body.code, 'INVALID_CAMPAIGN_INPUT');

    const missingKeyMember = await memberApi.request('POST', '/api/workflow/templates', { body });
    assert.equal(missingKeyMember.status, 400);
    assert.equal(missingKeyMember.body.code, 'IDEMPOTENCY_REQUIRED');

    const malformedMissingKey = await adminApi.request('POST', '/api/workflow/templates', {
      body: { name: '   ', module: 'campaign' }
    });
    assert.equal(malformedMissingKey.status, 400);
    assert.equal(malformedMissingKey.body.code, 'INVALID_CAMPAIGN_INPUT');

    const malformedTriggerId = await memberApi.request(
      'GET',
      '/api/workflow/templates/not-an-id/campaign-trigger'
    );
    assert.equal(malformedTriggerId.status, 400);
    assert.equal(malformedTriggerId.body.code, 'INVALID_CAMPAIGN_INPUT');

    const forbidden = await memberApi.request('POST', '/api/workflow/templates', {
      idempotencyKey: 'campaign-template-member-create',
      body
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'RECORD_FORBIDDEN');

    const missingKey = await adminApi.request('POST', '/api/workflow/templates', { body });
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.code, 'IDEMPOTENCY_REQUIRED');

    const createKey = 'campaign-template-create-0001';
    const created = await adminApi.request('POST', '/api/workflow/templates', {
      idempotencyKey: createKey,
      body
    });
    assert.equal(created.status, 200);
    assert.deepEqual(Object.keys(created.body), ['id']);
    const templateId = created.body.id;
    assert.deepEqual(
      db.prepare(`SELECT module,version,is_active,trigger_config_json FROM workflow_templates WHERE id=?`).get(templateId),
      { module: 'campaign', version: 1, is_active: 0, trigger_config_json: null }
    );

    const memberGraph = await memberApi.request('PUT', `/api/workflow/templates/${templateId}`, {
      idempotencyKey: 'campaign-template-member-graph',
      body: { expected_version: 1, module: 'campaign', ...minimalCampaignGraph() }
    });
    assert.equal(memberGraph.status, 403);
    assert.equal(memberGraph.body.code, 'RECORD_FORBIDDEN');
    const memberPublish = await memberApi.request('POST', `/api/workflow/templates/${templateId}/publish`, {
      idempotencyKey: 'campaign-template-member-publish',
      body: { expected_version: 1 }
    });
    assert.equal(memberPublish.status, 403);
    assert.equal(memberPublish.body.code, 'RECORD_FORBIDDEN');
    const memberDelete = await memberApi.request('DELETE', `/api/workflow/templates/${templateId}`);
    assert.equal(memberDelete.status, 403);
    assert.equal(memberDelete.body.code, 'RECORD_FORBIDDEN');
    assert.ok(db.prepare('SELECT id FROM workflow_templates WHERE id=?').get(templateId));

    const replay = await adminApi.request('POST', '/api/workflow/templates', {
      idempotencyKey: createKey,
      body
    });
    assert.deepEqual(replay, created);
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM workflow_templates WHERE module='campaign'`).get().count,
      1
    );
    const changedReplay = await adminApi.request('POST', '/api/workflow/templates', {
      idempotencyKey: createKey,
      body: campaignTemplateBody({ name: 'Changed replay body' })
    });
    assert.equal(changedReplay.status, 409);
    assert.equal(changedReplay.body.code, 'IDEMPOTENCY_KEY_REUSED');

    const initialTrigger = await adminApi.request('GET', `/api/workflow/templates/${templateId}/campaign-trigger`);
    assert.deepEqual(initialTrigger, {
      status: 200,
      body: { template_id: templateId, version: 1, is_active: false, trigger: null }
    });
    const memberTrigger = await memberApi.request('GET', `/api/workflow/templates/${templateId}/campaign-trigger`);
    assert.equal(memberTrigger.status, 403);
    assert.equal(memberTrigger.body.code, 'RECORD_FORBIDDEN');

    const wildcardTrigger = await adminApi.request(
      'PUT',
      `/api/workflow/templates/${templateId}/campaign-trigger`,
      {
        idempotencyKey: 'campaign-template-trigger-wildcard',
        body: { expected_version: 1, ...leadQualifiedTrigger(), wildcard: true }
      }
    );
    assert.equal(wildcardTrigger.status, 400);
    assert.equal(wildcardTrigger.body.code, 'INVALID_CAMPAIGN_INPUT');
    assert.equal(
      db.prepare('SELECT version FROM workflow_templates WHERE id=?').get(templateId).version,
      1
    );

    const triggerBody = { expected_version: 1, ...leadQualifiedTrigger() };
    const triggerUpdated = await adminApi.request(
      'PUT',
      `/api/workflow/templates/${templateId}/campaign-trigger`,
      { idempotencyKey: 'campaign-template-trigger-0001', body: triggerBody }
    );
    assert.deepEqual(triggerUpdated, {
      status: 200,
      body: {
        template_id: templateId,
        version: 2,
        is_active: false,
        trigger: leadQualifiedTrigger()
      }
    });
    assert.deepEqual(
      await adminApi.request(
        'PUT',
        `/api/workflow/templates/${templateId}/campaign-trigger`,
        { idempotencyKey: 'campaign-template-trigger-0001', body: triggerBody }
      ),
      triggerUpdated
    );

    const graph = minimalCampaignGraph();
    const graphUpdated = await adminApi.request('PUT', `/api/workflow/templates/${templateId}`, {
      idempotencyKey: 'campaign-template-graph-0001',
      body: {
        expected_version: 2,
        module: 'campaign',
        description: 'Updated campaign graph',
        nodes: graph.nodes,
        edges: graph.edges
      }
    });
    assert.deepEqual(graphUpdated, {
      status: 200,
      body: { success: true, version: 3, is_active: false }
    });
    assert.deepEqual(
      await adminApi.request('PUT', `/api/workflow/templates/${templateId}`, {
        idempotencyKey: 'campaign-template-graph-0001',
        body: {
          expected_version: 2,
          module: 'campaign',
          description: 'Updated campaign graph',
          nodes: graph.nodes,
          edges: graph.edges
        }
      }),
      graphUpdated
    );
    assert.equal(
      db.prepare('SELECT version FROM workflow_templates WHERE id=?').get(templateId).version,
      3
    );

    const stale = await adminApi.request('PUT', `/api/workflow/templates/${templateId}`, {
      idempotencyKey: 'campaign-template-graph-stale',
      body: { expected_version: 2, module: 'campaign', nodes: graph.nodes, edges: graph.edges }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'STALE_WORKFLOW_TEMPLATE_VERSION');
    assert.deepEqual(stale.body.details, { current_version: 3 });

    const missingGraph = await adminApi.request('PUT', '/api/workflow/templates/99999999', {
      idempotencyKey: 'campaign-template-graph-missing',
      body: { expected_version: 1, module: 'campaign', nodes: graph.nodes, edges: graph.edges }
    });
    assert.equal(missingGraph.status, 404);
    assert.equal(missingGraph.body.code, 'WORKFLOW_TEMPLATE_NOT_FOUND');

    const published = await adminApi.request('POST', `/api/workflow/templates/${templateId}/publish`, {
      idempotencyKey: 'campaign-template-publish-0001',
      body: { expected_version: 3 }
    });
    assert.equal(published.status, 200);
    assert.deepEqual(Object.keys(published.body), [
      'success', 'version', 'is_active', 'published_checksum'
    ]);
    assert.equal(published.body.success, true);
    assert.equal(published.body.version, 3);
    assert.equal(published.body.is_active, true);
    assert.equal(
      published.body.published_checksum,
      checksumCampaignWorkflowSnapshot(buildCampaignWorkflowSnapshot({
        snapshot_version: 1,
        template_id: templateId,
        template_version: 3,
        module: 'campaign',
        trigger: leadQualifiedTrigger(),
        ...graph
      }))
    );
    assert.equal(
      db.prepare('SELECT is_active FROM workflow_templates WHERE id=?').get(templateId).is_active,
      1
    );
    assert.deepEqual(
      await adminApi.request('POST', `/api/workflow/templates/${templateId}/publish`, {
        idempotencyKey: 'campaign-template-publish-0001',
        body: { expected_version: 3 }
      }),
      published
    );

    const immutable = await adminApi.request('PUT', `/api/workflow/templates/${templateId}`, {
      idempotencyKey: 'campaign-template-module-immutable',
      body: { expected_version: 3, module: 'customer' }
    });
    assert.equal(immutable.status, 409);
    assert.equal(immutable.body.code, 'CAMPAIGN_TEMPLATE_MODULE_IMMUTABLE');

    const invalidGraph = minimalCampaignGraph();
    invalidGraph.nodes[0] = {
      id: 'start', type: 'timer', label: 'Unsupported timer', config: {}
    };
    const invalidDraft = await adminApi.request('PUT', `/api/workflow/templates/${templateId}`, {
      idempotencyKey: 'campaign-template-invalid-draft',
      body: {
        expected_version: 3,
        module: 'campaign',
        nodes: invalidGraph.nodes,
        edges: invalidGraph.edges
      }
    });
    assert.deepEqual(invalidDraft, {
      status: 200,
      body: { success: true, version: 4, is_active: false }
    });
    const invalidPublish = await adminApi.request('POST', `/api/workflow/templates/${templateId}/publish`, {
      idempotencyKey: 'campaign-template-publish-invalid',
      body: { expected_version: 4 }
    });
    assert.equal(invalidPublish.status, 409);
    assert.equal(invalidPublish.body.code, 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE');
    assert.match(invalidPublish.body.details.reason, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(Object.hasOwn(invalidPublish.body.details, 'message'), false);
    assert.equal(
      db.prepare('SELECT is_active FROM workflow_templates WHERE id=?').get(templateId).is_active,
      0
    );

    const legacy = await adminApi.request('POST', '/api/workflow/templates', {
      body: { name: 'Legacy conversion target', module: 'customer', nodes: [], edges: [] }
    });
    const conversion = await adminApi.request('PUT', `/api/workflow/templates/${legacy.body.id}`, {
      idempotencyKey: 'campaign-template-conversion',
      body: { expected_version: 1, module: 'campaign', nodes: graph.nodes, edges: graph.edges }
    });
    assert.equal(conversion.status, 409);
    assert.equal(conversion.body.code, 'CAMPAIGN_TEMPLATE_CREATE_REQUIRED');
    const campaignPublishOnLegacy = await adminApi.request(
      'POST',
      `/api/workflow/templates/${legacy.body.id}/publish`,
      {
        idempotencyKey: 'campaign-template-publish-legacy',
        body: { expected_version: 1 }
      }
    );
    assert.equal(campaignPublishOnLegacy.status, 409);
    assert.equal(campaignPublishOnLegacy.body.code, 'CAMPAIGN_TEMPLATE_REQUIRED');

    const scopeRows = db.prepare(`
      SELECT idempotency_key,scope
      FROM request_idempotency
      WHERE idempotency_key IN (
        'campaign-template-create-0001',
        'campaign-template-trigger-0001',
        'campaign-template-graph-0001',
        'campaign-template-publish-0001'
      )
      ORDER BY idempotency_key
    `).all();
    assert.deepEqual(scopeRows, [
      {
        idempotency_key: 'campaign-template-create-0001',
        scope: 'workflow.campaign-template.create'
      },
      {
        idempotency_key: 'campaign-template-graph-0001',
        scope: 'workflow.campaign-template.graph'
      },
      {
        idempotency_key: 'campaign-template-publish-0001',
        scope: 'workflow.campaign-template.publish'
      },
      {
        idempotency_key: 'campaign-template-trigger-0001',
        scope: 'workflow.campaign-template.trigger'
      }
    ]);
  } finally {
    await memberApi.close();
    await adminApi.close();
    db.close();
  }
});

test('invalid historical template labels fail publish and lifecycle dispatch with retained safe errors', async () => {
  const cases = [
    { suffix: 1, label: '' },
    { suffix: 2, label: 'x'.repeat(1001) },
    { suffix: 3, label: 'Unsafe\u0000label' }
  ];
  for (const scenario of cases) {
    const db = openWorkflowDatabase();
    const identity = workflowIdentity(db, 'admin');
    const templateId = 979100 + scenario.suffix;
    insertCampaignTemplate(db, {
      id: templateId,
      createdBy: identity.userId,
      name: scenario.label,
      trigger: leadQualifiedTrigger(),
      active: 0
    });
    const api = await startWorkflowApi(db, identity.userId);
    try {
      const publishInput = {
        idempotencyKey: `campaign-invalid-label-publish-${scenario.suffix}`,
        body: { expected_version: 1 }
      };
      const published = await api.request(
        'POST',
        `/api/workflow/templates/${templateId}/publish`,
        publishInput
      );
      assert.equal(published.status, 409);
      assert.equal(published.body.code, 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE');
      assert.deepEqual(published.body.details, { reason: 'WORKFLOW_DOCUMENT_INVALID' });
      assert.deepEqual(
        await api.request('POST', `/api/workflow/templates/${templateId}/publish`, publishInput),
        published
      );
      assert.equal(
        db.prepare('SELECT is_active FROM workflow_templates WHERE id=?').get(templateId).is_active,
        0
      );

      db.prepare('UPDATE workflow_templates SET is_active=1 WHERE id=?').run(templateId);
      const context = createCampaignFixture(db, identity, 969100 + scenario.suffix);
      const service = createCampaignService(db);
      const transitionInput = {
        userId: identity.userId,
        campaignId: context.campaignId,
        requestId: `task6-invalid-label-transition-${scenario.suffix}`,
        idempotencyKey: `task6-invalid-label-transition-${scenario.suffix}`,
        body: {
          expected_state: 'lead',
          expected_version: 1,
          next_state: 'qualified',
          reason: 'Reject unsafe historical workflow label'
        }
      };
      const transition = service.transitionCampaign(transitionInput);
      assert.equal(transition.status, 409);
      assert.equal(transition.body.code, 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE');
      assert.deepEqual(transition.body.details, { reason: 'WORKFLOW_DOCUMENT_INVALID' });
      assert.deepEqual(
        db.prepare('SELECT lifecycle_state,row_version FROM campaigns WHERE id=?')
          .get(context.campaignId),
        { lifecycle_state: 'lead', row_version: 1 }
      );
      const transitionReplay = service.transitionCampaign(transitionInput);
      assert.equal(transitionReplay.status, transition.status);
      assert.deepEqual(transitionReplay.body, transition.body);
    } finally {
      await api.close();
      db.close();
    }
  }
});

test('campaign transition atomically pins one exact matching workflow dispatch and replays it', async () => {
  const db = openWorkflowDatabase();
  const identity = workflowIdentity(db, 'admin');
  const context = createCampaignFixture(db, identity);
  insertCampaignTemplate(db, {
    id: 980001,
    createdBy: identity.userId,
    trigger: leadQualifiedTrigger(),
    active: 1
  });
  insertCampaignTemplate(db, {
    id: 980002,
    createdBy: identity.userId,
    trigger: leadQualifiedTrigger(),
    active: 0
  });
  insertCampaignTemplate(db, {
    id: 980003,
    createdBy: identity.userId,
    trigger: {
      event_type: 'lifecycle_transition',
      previous_state: 'qualified',
      next_state: 'demand_confirmed'
    },
    active: 1
  });
  insertCampaignTemplate(db, {
    id: 980004,
    createdBy: identity.userId,
    trigger: leadQualifiedTrigger(),
    active: 1,
    module: 'customer'
  });
  const service = createCampaignService(db);
  const input = {
    userId: identity.userId,
    campaignId: context.campaignId,
    requestId: 'task6-transition-request',
    idempotencyKey: 'task6-transition-dispatch-0001',
    body: {
      expected_state: 'lead',
      expected_version: 1,
      next_state: 'qualified',
      reason: 'Qualify campaign and dispatch workflow'
    }
  };
  try {
    const result = service.transitionCampaign(input);
    assert.equal(result.status, 200);
    assert.equal(result.body.dispatches.length, 1);
    assert.deepEqual(Object.keys(result.body.dispatches[0]), [
      'id', 'event_id', 'trigger_event_id', 'template', 'status',
      'attempt_count', 'workflow_instance_id', 'instance',
      'reconciles_dispatch_id', 'next_attempt_at', 'error',
      'created_at', 'updated_at'
    ]);
    assert.equal(result.body.dispatches[0].event_id, result.body.event.id);
    assert.equal(result.body.dispatches[0].trigger_event_id, result.body.event.id);
    assert.deepEqual(result.body.dispatches[0].template, {
      id: 980001,
      label: 'Workflow template 980001',
      version: 1
    });
    assert.equal(result.body.dispatches[0].status, 'pending');
    assert.equal(result.body.dispatches[0].attempt_count, 0);
    assert.equal(result.body.dispatches[0].workflow_instance_id, null);
    assert.equal(result.body.dispatches[0].instance, null);
    assert.equal(result.body.dispatches[0].reconciles_dispatch_id, null);
    assert.equal(result.body.dispatches[0].next_attempt_at, null);
    assert.equal(result.body.dispatches[0].error, null);

    const row = db.prepare(`
      SELECT * FROM campaign_workflow_dispatches
      WHERE campaign_id=?
    `).get(context.campaignId);
    assert.ok(row);
    assert.equal(row.org_id, context.orgId);
    assert.equal(row.event_id, result.body.event.id);
    assert.equal(row.trigger_event_id, result.body.event.id);
    assert.equal(row.template_id, 980001);
    assert.equal(row.template_version, 1);
    assert.equal(row.template_label, 'Workflow template 980001');
    assert.equal(row.status, 'pending');
    assert.equal(row.attempt_count, 0);
    assert.equal(row.workflow_instance_id, null);
    assert.equal(row.reconciles_dispatch_id, null);
    assert.equal(
      row.execution_context_json,
      `{"campaign":{"id":${context.campaignId},"lifecycle_state":"qualified","operational_status":"active"},"event":{"event_type":"lifecycle_transition","previous_state":"lead","next_state":"qualified"}}`
    );
    const storedSnapshot = JSON.parse(row.template_snapshot_json);
    assert.deepEqual(storedSnapshot, buildCampaignWorkflowSnapshot({
      snapshot_version: 1,
      template_id: 980001,
      template_version: 1,
      module: 'campaign',
      trigger: leadQualifiedTrigger(),
      ...minimalCampaignGraph()
    }));
    assert.equal(
      row.template_snapshot_json,
      canonicalJsonBytes(storedSnapshot).toString('utf8')
    );
    assert.equal(row.template_checksum, checksumCampaignWorkflowSnapshot(storedSnapshot));

    const pinnedEvidence = {
      snapshot: row.template_snapshot_json,
      checksum: row.template_checksum,
      context: row.execution_context_json
    };
    db.prepare(`
      UPDATE workflow_templates
      SET name='Later mutable edit',version=version+1,is_active=0
      WHERE id=980001
    `).run();
    assert.equal(
      db.prepare('SELECT template_label FROM campaign_workflow_dispatches WHERE campaign_id=?')
        .get(context.campaignId).template_label,
      'Workflow template 980001'
    );
    const replay = service.transitionCampaign(input);
    assert.equal(replay.status, result.status);
    assert.deepEqual(replay.body, result.body);
    assert.deepEqual(
      db.prepare(`
        SELECT template_snapshot_json AS snapshot,template_checksum AS checksum,
               execution_context_json AS context
        FROM campaign_workflow_dispatches
        WHERE campaign_id=?
      `).get(context.campaignId),
      pinnedEvidence
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?').get(context.campaignId).count,
      1
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM campaign_workflow_dispatches WHERE campaign_id=?').get(context.campaignId).count,
      1
    );

    const api = await startWorkflowApi(db, identity.userId);
    try {
      const blockedDelete = await api.request('DELETE', '/api/workflow/templates/980001');
      assert.equal(blockedDelete.status, 409);
      assert.equal(blockedDelete.body.code, 'WORKFLOW_TEMPLATE_HAS_DEPENDENCIES');
      assert.deepEqual(blockedDelete.body.details, { dispatch_count: 1 });
      assert.ok(db.prepare('SELECT id FROM workflow_templates WHERE id=980001').get());
    } finally {
      await api.close();
    }
  } finally {
    db.close();
  }
});

test('invalid active campaign workflow rolls back state, event, dispatch, and retains exact failure replay', () => {
  const db = openWorkflowDatabase();
  const identity = workflowIdentity(db, 'admin');
  const context = createCampaignFixture(db, identity, 971001);
  insertCampaignTemplate(db, {
    id: 981001,
    createdBy: identity.userId,
    trigger: leadQualifiedTrigger(),
    active: 1,
    graph: { nodes: [], edges: [] }
  });
  const service = createCampaignService(db);
  const input = {
    userId: identity.userId,
    campaignId: context.campaignId,
    requestId: 'task6-invalid-dispatch-request',
    idempotencyKey: 'task6-invalid-dispatch-0001',
    body: {
      expected_state: 'lead',
      expected_version: 1,
      next_state: 'qualified',
      reason: 'Reject invalid workflow atomically'
    }
  };
  try {
    const result = service.transitionCampaign(input);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE');
    assert.match(result.body.details.reason, /^[A-Z][A-Z0-9_]*$/);
    assert.deepEqual(
      db.prepare('SELECT lifecycle_state,row_version FROM campaigns WHERE id=?').get(context.campaignId),
      { lifecycle_state: 'lead', row_version: 1 }
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?').get(context.campaignId).count,
      0
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM campaign_workflow_dispatches WHERE campaign_id=?').get(context.campaignId).count,
      0
    );
    const replay = service.transitionCampaign(input);
    assert.equal(replay.status, result.status);
    assert.deepEqual(replay.body, result.body);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM request_idempotency
        WHERE campaign_id=? AND scope='campaign.transition' AND state='completed'
      `).get(context.campaignId).count,
      1
    );
  } finally {
    db.close();
  }
});

test('active campaign templates with missing or malformed triggers fail the transition closed', () => {
  for (const scenario of [
    { label: 'missing', trigger: null },
    { label: 'malformed', trigger: { event_type: 'lifecycle_transition' } }
  ]) {
    const db = openWorkflowDatabase();
    const identity = workflowIdentity(db, 'admin');
    const suffix = scenario.label === 'missing' ? 1 : 2;
    const context = createCampaignFixture(db, identity, 972000 + suffix);
    insertCampaignTemplate(db, {
      id: 982000 + suffix,
      createdBy: identity.userId,
      trigger: scenario.trigger,
      active: 1
    });
    const service = createCampaignService(db);
    const input = {
      userId: identity.userId,
      campaignId: context.campaignId,
      requestId: `task6-${scenario.label}-trigger-request`,
      idempotencyKey: `task6-${scenario.label}-trigger-0001`,
      body: {
        expected_state: 'lead',
        expected_version: 1,
        next_state: 'qualified',
        reason: `Reject ${scenario.label} active trigger atomically`
      }
    };
    try {
      const result = service.transitionCampaign(input);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE');
      assert.deepEqual(result.body.details, { reason: 'TRIGGER_INVALID' });
      assert.deepEqual(
        db.prepare('SELECT lifecycle_state,row_version FROM campaigns WHERE id=?').get(context.campaignId),
        { lifecycle_state: 'lead', row_version: 1 }
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?')
          .get(context.campaignId).count,
        0
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM campaign_workflow_dispatches WHERE campaign_id=?')
          .get(context.campaignId).count,
        0
      );
      const replay = service.transitionCampaign(input);
      assert.equal(replay.status, result.status);
      assert.deepEqual(replay.body, result.body);
    } finally {
      db.close();
    }
  }
});
