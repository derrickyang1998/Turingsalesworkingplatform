'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const express = require('express');

const migrationService = require('../services/migration_service');
const idempotency = require('../services/idempotency_service');
const campaignContract = require('../contracts/campaign_contract');
const { requestHash } = require('../services/sqlite_digest_service');
const { createPhase4RequestPipeline } = require('../middleware/phase4_request_pipeline');
const { createCampaignService } = require('../services/campaign_service');
const {
  buildCampaignWorkflowSnapshot,
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

function openDatabase() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  });
  return db;
}

function identity(db, role = 'org_admin') {
  const row = db.prepare(`
    SELECT user.id AS userId,membership.org_id AS orgId,
           membership.role_code AS organizationRole,team.team_id AS teamId
    FROM users user
    JOIN organization_memberships membership
      ON membership.user_id=user.id AND membership.status='active'
    JOIN team_memberships team
      ON team.user_id=user.id AND team.org_id=membership.org_id
     AND team.status='active'
    WHERE user.is_active=1 AND membership.role_code=?
    ORDER BY user.id,team.team_id LIMIT 1
  `).get(role);
  assert.ok(row, `missing ${role} identity`);
  return row;
}

function sameOrgMember(db, owner) {
  const row = db.prepare(`
    SELECT user.id AS userId,membership.org_id AS orgId,team.team_id AS teamId
    FROM users user
    JOIN organization_memberships membership
      ON membership.user_id=user.id AND membership.org_id=?
     AND membership.status='active' AND membership.role_code<>'org_admin'
    JOIN team_memberships team
      ON team.user_id=user.id AND team.org_id=membership.org_id
     AND team.status='active'
    WHERE user.is_active=1 AND user.id<>?
    ORDER BY user.id LIMIT 1
  `).get(owner.orgId, owner.userId);
  assert.ok(row, 'missing same-organization member');
  return row;
}

function anotherSameOrgMember(db, organizationId, excludedUserIds) {
  const placeholders = excludedUserIds.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT user.id AS userId,membership.org_id AS orgId,team.team_id AS teamId
    FROM users user
    JOIN organization_memberships membership
      ON membership.user_id=user.id AND membership.org_id=?
     AND membership.status='active' AND membership.role_code<>'org_admin'
    JOIN team_memberships team
      ON team.user_id=user.id AND team.org_id=membership.org_id
     AND team.status='active'
    WHERE user.is_active=1 AND user.id NOT IN (${placeholders})
    ORDER BY user.id LIMIT 1
  `).get(organizationId, ...excludedUserIds);
  assert.ok(row, 'missing same-organization non-owner member');
  return row;
}

function crossOrganizationCampaign(db, supportingUser, campaignId) {
  const organizationId = campaignId + 100;
  const teamId = campaignId + 101;
  db.prepare('INSERT INTO organizations (id,code,name) VALUES (?,?,?)').run(
    organizationId,
    `cross-org-${campaignId}`,
    `Cross organization ${campaignId}`
  );
  db.prepare('INSERT INTO teams (id,org_id,code,name) VALUES (?,?,?,?)').run(
    teamId,
    organizationId,
    `cross-team-${campaignId}`,
    `Cross team ${campaignId}`
  );
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,?,'member','active')
  `).run(organizationId, supportingUser.userId);
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (?,?,?,'member','active')
  `).run(organizationId, teamId, supportingUser.userId);
  const customerId = campaignId + 1;
  const opportunityId = campaignId + 2;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (?,?,?,'qualified','test',?,?)
  `).run(customerId, `Cross ${campaignId}`, `Cross ${campaignId} Ltd`, supportingUser.userId, supportingUser.userId);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,
      channel_type,created_by
    ) VALUES (?,?,'Cross opportunity','proposal',1000,50,'Workflow','influencer',?)
  `).run(opportunityId, customerId, supportingUser.userId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,?,?,?,?,?,'lead','active',1)
  `).run(
    campaignId, organizationId, `Cross campaign ${campaignId}`,
    customerId, opportunityId, supportingUser.userId, teamId
  );
  return campaignId;
}

function campaignFixture(db, owner, campaignId) {
  const customerId = campaignId + 1;
  const opportunityId = campaignId + 2;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (?,?,?,'qualified','test',?,?)
  `).run(customerId, `Campaign ${campaignId}`, `Campaign ${campaignId} Ltd`, owner.userId, owner.userId);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,
      channel_type,created_by
    ) VALUES (?,?,'Reconciliation opportunity','proposal',1000,50,'Workflow','influencer',?)
  `).run(opportunityId, customerId, owner.userId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,?,?,?,?,?,'lead','active',1)
  `).run(campaignId, owner.orgId, `Campaign ${campaignId}`, customerId, opportunityId, owner.userId, owner.teamId);
  return { ...owner, campaignId };
}

function rootTrigger() {
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

function taskGraph() {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'task', type: 'task', label: 'Task',
        config: {
          title: 'Reconcile task', description: '', assignee_id: null,
          assignee_role: 'member', due_hours: null
        }
      },
      { id: 'end', type: 'end', label: 'End', config: {} }
    ],
    edges: [
      { id: 'start-next', from: 'start', to: 'task', outcome: 'next', priority: 0, condition: null },
      { id: 'task-end', from: 'task', to: 'end', outcome: 'complete', priority: 0, condition: null }
    ]
  };
}

function insertTemplate(db, owner, id, name, graph = terminalGraph(), options = {}) {
  const trigger = options.trigger === undefined ? rootTrigger() : options.trigger;
  db.prepare(`
    INSERT INTO workflow_templates (
      id,name,description,module,category,nodes,edges,version,is_active,
      created_by,trigger_config_json
    ) VALUES (?,?,?,'campaign','approval',?,?,?,?,?,?)
  `).run(
    id,
    name,
    'Task 6C-1 fixture',
    options.nodes === undefined ? JSON.stringify(graph.nodes) : options.nodes,
    options.edges === undefined ? JSON.stringify(graph.edges) : options.edges,
    options.version || 1,
    options.active === false ? 0 : 1,
    owner.userId,
    trigger === null ? null : JSON.stringify(trigger)
  );
}

function transition(db, context, key = `task6c1-transition-${context.campaignId}`) {
  const result = createCampaignService(db).transitionCampaign({
    userId: context.userId,
    campaignId: context.campaignId,
    requestId: `task6c1-transition-request-${context.campaignId}`,
    idempotencyKey: key,
    body: {
      expected_state: 'lead',
      expected_version: 1,
      next_state: 'qualified',
      reason: 'Create workflow dispatch for reconciliation'
    }
  });
  assert.equal(result.status, 200);
  return result;
}

function dispatches(db, campaignId) {
  return db.prepare(`
    SELECT * FROM campaign_workflow_dispatches
    WHERE campaign_id=? ORDER BY id
  `).all(campaignId);
}

function withTriggerDisabled(db, name, operation) {
  const row = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?
  `).get(name);
  assert.ok(row && row.sql, `missing trigger ${name}`);
  db.exec(`DROP TRIGGER ${name}`);
  try {
    return operation();
  } finally {
    db.exec(row.sql);
  }
}

function failBeforeInitialization(db, dispatchId) {
  withTriggerDisabled(db, 'campaign_workflow_dispatches_legal_transition', () => {
    db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET status='failed_validation',attempt_count=1,
          last_error_code='WORKFLOW_SNAPSHOT_INVALID',
          last_error='Stored campaign workflow snapshot is invalid',
          updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(dispatchId);
  });
  return db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?').get(dispatchId);
}

function failInitializedInstance(db, dispatchId) {
  const dispatch = db.prepare(`
    SELECT * FROM campaign_workflow_dispatches WHERE id=?
  `).get(dispatchId);
  assert.equal(dispatch.status, 'completed');
  db.prepare(`
    UPDATE workflow_instances
    SET status='failed_validation',
        execution_error_code='WORKFLOW_CONTEXT_INVALID',
        execution_error='Stored workflow execution context is invalid',
        execution_failed_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(dispatch.workflow_instance_id);
  return db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?').get(dispatchId);
}

function reconciliationBody(dispatch, templateId, version = 1, reason = 'Repair immutable workflow evidence') {
  return {
    expected_dispatch_status: dispatch.status,
    expected_instance_status: dispatch.workflow_instance_id === null ? null : 'failed_validation',
    template_id: templateId,
    expected_template_version: version,
    reason
  };
}

function reconciliationInput(context, dispatch, templateId, key, overrides = {}) {
  return {
    userId: context.userId,
    campaignId: context.campaignId,
    dispatchId: dispatch.id,
    requestId: `task6c1-reconcile-${key}`,
    idempotencyKey: key,
    body: { ...reconciliationBody(dispatch, templateId), ...overrides }
  };
}

function reconcile(service, context, dispatch, templateId, key, overrides = {}) {
  return service.reconcileWorkflowDispatch(
    reconciliationInput(context, dispatch, templateId, key, overrides)
  );
}

function reconciliationReservationInput(context, dispatch, templateId, key, overrides = {}) {
  const input = reconciliationInput(
    context,
    dispatch,
    templateId,
    key,
    overrides
  );
  return {
    organizationId: context.orgId,
    actorUserId: context.userId,
    campaignId: context.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: 'campaign.workflow.reconcile',
    key,
    requestHash: requestHash({
      method: 'POST',
      path: `/api/campaigns/${context.campaignId}` +
        `/workflow-dispatches/${dispatch.id}/reconcile`,
      campaignId: context.campaignId,
      kind: 'json',
      payload: input.body
    }),
    expectedEventCount: 1,
    operationTimeoutSeconds: 60
  };
}

function reserveReconciliation(db, context, dispatch, templateId, key, overrides = {}) {
  const input = reconciliationReservationInput(
    context,
    dispatch,
    templateId,
    key,
    overrides
  );
  const reservation = db.transaction(() => (
    idempotency.reserveProcessingInTransaction(db, input)
  )).immediate();
  assert.equal(reservation.state, 'reserved');
  return { input, reservation };
}

function databaseAdapter(db, hooks = {}) {
  let transactionNumber = 0;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql);
          if (typeof hooks.prepare !== 'function') return statement;
          return hooks.prepare({
            db: target,
            sql,
            statement
          }) || statement;
        };
      }
      if (property === 'transaction') {
        return (operation) => {
          transactionNumber += 1;
          if (typeof hooks.beforeTransaction === 'function') {
            hooks.beforeTransaction(target, transactionNumber);
          }
          return target.transaction((...args) => {
            if (typeof hooks.insideTransaction === 'function') {
              hooks.insideTransaction(target, transactionNumber);
            }
            return operation(...args);
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function productionPolicyRegistry() {
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'server.js'), 'utf8');
  const declaration = source.match(
    /const phase4PolicyNames = (\[[\s\S]*?\]);\r?\nconst phase4Registry/u
  );
  assert.ok(declaration, 'production Phase 4 policy registry declaration is missing');
  const names = vm.runInNewContext(declaration[1], Object.create(null));
  assert.ok(Array.isArray(names));
  return campaignContract.createRoutePolicyRegistry(
    Array.from(names, (name) => campaignContract.REQUEST_POLICIES[name])
  );
}

function artifactCounts(db, campaignId) {
  return {
    events: db.prepare(`SELECT COUNT(*) count FROM campaign_events WHERE campaign_id=? AND event_type='workflow_reconciliation'`).get(campaignId).count,
    dispatches: db.prepare(`SELECT COUNT(*) count FROM campaign_workflow_dispatches WHERE campaign_id=? AND reconciles_dispatch_id IS NOT NULL`).get(campaignId).count,
    archives: db.prepare(`SELECT COUNT(*) count FROM knowledge_entries WHERE business_type='campaign' AND business_id=? AND source_type='campaign_workflow_reconciliation'`).get(String(campaignId)).count,
    links: db.prepare(`SELECT COUNT(*) count FROM campaign_record_links WHERE campaign_id=? AND relation_type='knowledge'`).get(campaignId).count,
    ledgers: db.prepare(`SELECT COUNT(*) count FROM request_idempotency WHERE campaign_id=? AND scope='campaign.workflow.reconcile'`).get(campaignId).count
  };
}

function bulkFillUserKnowledgeEntries(db, createdBy, count) {
  if (count === 0) return;
  const guard = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='knowledge_entries_no_replace_insert'
  `).get();
  assert.ok(guard && guard.sql);
  db.exec('DROP TRIGGER knowledge_entries_no_replace_insert');
  try {
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL SELECT value+1 FROM fixture_rows WHERE value<@count
      )
      INSERT INTO knowledge_entries (
        entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,source_hash,business_type,business_id,
        metadata_json,embedding_json,source_identity_sha256,content_sha256
      )
      SELECT
        'note','capacity_fixture',NULL,'[]','',@createdBy,0,
        '','','[]','private',NULL,NULL,NULL,'{}',NULL,
        lower(printf('e%063x',2000000+value)),
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      FROM fixture_rows
    `).run({ count, createdBy });
  } finally {
    db.exec(guard.sql);
  }
}

const PUBLIC_DISPATCH_KEYS = Object.freeze([
  'id', 'event_id', 'trigger_event_id', 'template', 'status', 'attempt_count',
  'workflow_instance_id', 'instance', 'reconciles_dispatch_id',
  'next_attempt_at', 'error', 'created_at', 'updated_at'
]);

function option(service, context, dispatchId, userId = context.userId) {
  return service.getWorkflowReconciliationOptions({
    userId,
    campaignId: context.campaignId,
    query: { dispatch_id: String(dispatchId) }
  });
}

async function startApi(db, actorUserId) {
  const registry = campaignContract.createRoutePolicyRegistry([
    campaignContract.REQUEST_POLICIES.CAMPAIGN_WORKFLOW_RECONCILIATION_OPTIONS,
    campaignContract.REQUEST_POLICIES.CAMPAIGN_WORKFLOW_RECONCILE
  ]);
  const pipeline = createPhase4RequestPipeline({
    registry,
    authenticate(request) {
      if (request.headers.authorization !== 'Bearer task6c1-token') return null;
      const user = db.prepare(`
        SELECT id,username,display_name,role,department,is_active
        FROM users WHERE id=? AND is_active=1
      `).get(actorUserId);
      if (!user) return null;
      request.user = user;
      return { user };
    },
    generateRequestId: () => 'task6c1-api-request'
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
  require('../routes_campaigns')(app, db);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(method, requestPath, options = {}) {
      const headers = {
        Authorization: 'Bearer task6c1-token',
        'X-Request-Id': options.requestId || 'task6c1-api-request'
      };
      let body;
      if (Object.hasOwn(options, 'body')) {
        headers['Content-Type'] = options.contentType || 'application/json';
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

test('options returns exact closed variants in precedence order and valid UTF-8-sorted candidates', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991001);
    insertTemplate(db, owner, 992001, 'zeta');
    insertTemplate(db, owner, 992002, 'Alpha');
    insertTemplate(db, owner, 992003, 'Alpha');
    insertTemplate(db, owner, 992004, 'wrong root', terminalGraph(), {
      trigger: { event_type: 'lifecycle_transition', previous_state: 'qualified', next_state: 'demand_confirmed' }
    });
    const transitionResult = transition(db, context);
    insertTemplate(db, owner, 992005, 'invalid graph', terminalGraph(), { nodes: '[]' });
    const failed = failBeforeInitialization(db, transitionResult.body.dispatches[0].id);
    const service = createCampaignWorkflowService(db);

    const eligible = option(service, context, failed.id);
    assert.deepEqual(Object.keys(eligible), ['state', 'dispatch', 'required', 'templates']);
    assert.equal(eligible.state, 'eligible');
    assert.deepEqual(eligible.required, {
      failure_shape: 'pre_initialization',
      expected_dispatch_status: 'failed_validation',
      expected_instance_status: null
    });
    assert.deepEqual(eligible.templates.map((item) => item.id), [992002, 992003, 992001]);
    for (const item of eligible.templates) {
      assert.deepEqual(Object.keys(item), ['id', 'label', 'version', 'published_checksum', 'trigger']);
      const graph = item.id === 992001 || item.id === 992002 || item.id === 992003
        ? terminalGraph() : null;
      const snapshot = buildCampaignWorkflowSnapshot({
        snapshot_version: 1,
        template_id: item.id,
        template_version: 1,
        module: 'campaign',
        trigger: rootTrigger(),
        nodes: graph.nodes,
        edges: graph.edges
      });
      assert.equal(item.published_checksum, checksumCampaignWorkflowSnapshot(snapshot));
    }

    db.prepare('UPDATE workflow_templates SET is_active=0 WHERE id IN (992001,992002,992003)').run();
    const noMatch = option(service, context, failed.id);
    assert.deepEqual(Object.keys(noMatch), ['state', 'dispatch', 'required', 'templates']);
    assert.equal(noMatch.state, 'no_matching_template');
    assert.deepEqual(noMatch.templates, []);

    db.prepare("UPDATE campaigns SET operational_status='on_hold' WHERE id=?").run(context.campaignId);
    const held = option(service, context, failed.id);
    assert.deepEqual(Object.keys(held), ['state', 'dispatch', 'operational_status']);
    assert.deepEqual(held, { state: 'campaign_not_active', dispatch: held.dispatch, operational_status: 'on_hold' });
    db.prepare("UPDATE campaigns SET operational_status='cancelled' WHERE id=?").run(context.campaignId);
    assert.equal(option(service, context, failed.id).operational_status, 'cancelled');
  } finally {
    db.close();
  }
});

test('options closes authorization, query, reconciliation, and failure-shape states without leakage', () => {
  const db = openDatabase();
  try {
    const admin = identity(db);
    const owner = sameOrgMember(db, admin);
    const context = campaignFixture(db, owner, 991101);
    insertTemplate(db, admin, 992101, 'Recovery');
    const pending = dispatches(db, context.campaignId);
    assert.deepEqual(pending, []);
    const transitionResult = transition(db, context);
    const dispatch = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?')
      .get(transitionResult.body.dispatches[0].id);
    const service = createCampaignWorkflowService(db);
    const ownerResult = option(service, context, dispatch.id, owner.userId);
    const adminResult = option(service, context, dispatch.id, admin.userId);
    assert.deepEqual(adminResult, ownerResult);
    const nonReconcilable = ownerResult;
    assert.deepEqual(Object.keys(nonReconcilable), ['state', 'dispatch', 'dispatch_status', 'instance_status']);
    assert.equal(nonReconcilable.state, 'dispatch_not_reconcilable');

    assert.throws(() => service.getWorkflowReconciliationOptions({
      userId: owner.userId,
      campaignId: context.campaignId,
      query: { dispatch_id: `0${dispatch.id}` }
    }), (error) => error.code === 'INVALID_CAMPAIGN_INPUT');
    assert.throws(() => service.getWorkflowReconciliationOptions({
      userId: owner.userId,
      campaignId: context.campaignId,
      query: { dispatch_id: String(dispatch.id), extra: 'x' }
    }), (error) => error.code === 'INVALID_CAMPAIGN_INPUT');

    const member = anotherSameOrgMember(db, owner.orgId, [owner.userId, admin.userId]);
    assert.throws(() => option(service, context, dispatch.id, member.userId), (error) => (
      error.statusCode === 403 && error.code === 'CAMPAIGN_FORBIDDEN'
    ));
    const crossCampaignId = crossOrganizationCampaign(db, member, 991191);
    assert.throws(() => service.getWorkflowReconciliationOptions({
      userId: owner.userId,
      campaignId: crossCampaignId,
      query: { dispatch_id: String(dispatch.id) }
    }), (error) => (
      error.statusCode === 404 && error.code === 'CAMPAIGN_NOT_FOUND'
    ));
    assert.throws(() => option(service, context, Number.MAX_SAFE_INTEGER), (error) => (
      error.statusCode === 404 && error.code === 'CAMPAIGN_NOT_FOUND'
    ));
  } finally {
    db.close();
  }
});

test('unchanged legal failure shape keeps options and mutation consistent for worker-invalid copied context', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991151);
    insertTemplate(db, owner, 992151, 'Context consistency recovery');
    const transitionResult = transition(
      db,
      context,
      'task6c1-transition-context-consistency'
    );
    const failed = failBeforeInitialization(
      db,
      transitionResult.body.dispatches[0].id
    );
    withTriggerDisabled(
      db,
      'campaign_workflow_dispatches_immutable_evidence',
      () => {
        withTriggerDisabled(
          db,
          'campaign_workflow_dispatches_legal_transition',
          () => {
            db.prepare(`
              UPDATE campaign_workflow_dispatches
              SET execution_context_json='{}'
              WHERE id=?
            `).run(failed.id);
          }
        );
      }
    );
    const unchanged = db.prepare(`
      SELECT * FROM campaign_workflow_dispatches WHERE id=?
    `).get(failed.id);
    const service = createCampaignWorkflowService(db);
    const options = option(service, context, unchanged.id);
    assert.equal(options.state, 'eligible');
    assert.deepEqual(options.required, {
      failure_shape: 'pre_initialization',
      expected_dispatch_status: 'failed_validation',
      expected_instance_status: null
    });

    const result = reconcile(
      service,
      context,
      unchanged,
      992151,
      'task6c1-context-consistency-0001'
    );
    assert.equal(result.status, 202);
    const replacement = db.prepare(`
      SELECT * FROM campaign_workflow_dispatches WHERE id=?
    `).get(result.body.replacement_dispatch.id);
    assert.equal(replacement.execution_context_json, '{}');
    assert.equal(replacement.execution_context_json, unchanged.execution_context_json);
  } finally {
    db.close();
  }
});

test('pre-initialization reconciliation atomically creates exact event-first dispatch/archive evidence and replays', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991201);
    insertTemplate(db, owner, 992201, 'Original');
    insertTemplate(db, owner, 992202, 'Repaired', terminalGraph(), { version: 7 });
    const transitionResult = transition(db, context);
    const failed = failBeforeInitialization(db, transitionResult.body.dispatches[0].id);
    const parentBefore = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?').get(failed.id);
    const service = createCampaignWorkflowService(db);
    const key = 'task6c1-pre-success-0001';
    const result = reconcile(service, context, failed, 992202, key, {
      expected_template_version: 7,
      reason: '  Repair immutable workflow evidence\r\nnow  '
    });
    assert.equal(result.status, 202);
    assert.deepEqual(Object.keys(result.body), ['failed_dispatch', 'replacement_dispatch', 'event']);
    assert.deepEqual(Object.keys(result.body.failed_dispatch), PUBLIC_DISPATCH_KEYS);
    assert.deepEqual(Object.keys(result.body.replacement_dispatch), PUBLIC_DISPATCH_KEYS);
    for (const summary of [result.body.failed_dispatch, result.body.replacement_dispatch]) {
      assert.equal(Object.hasOwn(summary, 'template_snapshot_json'), false);
      assert.equal(Object.hasOwn(summary, 'template_checksum'), false);
      assert.equal(Object.hasOwn(summary, 'execution_context_json'), false);
      assert.equal(Object.hasOwn(summary, 'lease_token'), false);
    }
    assert.deepEqual(Object.keys(result.body.event), [
      'id', 'event_type', 'previous_state', 'next_state', 'actor', 'reason',
      'source', 'metadata', 'correlation_id', 'created_at'
    ]);
    const replacement = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?')
      .get(result.body.replacement_dispatch.id);
    const event = db.prepare('SELECT * FROM campaign_events WHERE id=?').get(result.body.event.id);
    assert.equal(replacement.event_id, event.id);
    assert.equal(replacement.id, Math.max(...dispatches(db, context.campaignId).map((row) => row.id)));
    assert.equal(replacement.status, 'pending');
    assert.equal(replacement.reconciles_dispatch_id, failed.id);
    assert.equal(replacement.trigger_event_id, parentBefore.trigger_event_id);
    assert.equal(replacement.execution_context_json, parentBefore.execution_context_json);
    assert.equal(replacement.template_label, 'Repaired');
    const expectedSnapshot = buildCampaignWorkflowSnapshot({
      snapshot_version: 1,
      template_id: 992202,
      template_version: 7,
      module: 'campaign',
      trigger: rootTrigger(),
      nodes: terminalGraph().nodes,
      edges: terminalGraph().edges
    });
    assert.deepEqual(JSON.parse(replacement.template_snapshot_json), expectedSnapshot);
    assert.equal(replacement.template_checksum, checksumCampaignWorkflowSnapshot(expectedSnapshot));
    const expectedEventMetadata = {
      original_dispatch_id: failed.id,
      replacement_dispatch_id: replacement.id,
      template_id: 992202,
      template_version: 7
    };
    assert.deepEqual(JSON.parse(event.metadata_json), expectedEventMetadata);
    assert.deepEqual(result.body.event.metadata, expectedEventMetadata);
    const alreadyReconciled = option(service, context, failed.id);
    assert.deepEqual(
      Object.keys(alreadyReconciled),
      ['state', 'dispatch', 'replacement_dispatch_id']
    );
    assert.equal(alreadyReconciled.state, 'already_reconciled');
    assert.equal(alreadyReconciled.replacement_dispatch_id, replacement.id);
    assert.equal(event.previous_state, null);
    assert.equal(event.next_state, null);
    assert.equal(event.actor_user_id, owner.userId);
    assert.equal(event.reason, 'Repair immutable workflow evidence\nnow');
    assert.equal(event.source, 'workflow_recovery');
    assert.equal(event.correlation_id, `task6c1-reconcile-${key}`);

    const archive = db.prepare(`
      SELECT * FROM knowledge_entries
      WHERE source_type='campaign_workflow_reconciliation' AND source_id=?
    `).get(String(event.id));
    assert.ok(archive);
    const canonicalContent = JSON.stringify(JSON.parse(event.metadata_json));
    assert.equal(archive.entry_type, 'campaign_workflow');
    assert.equal(archive.title, `Campaign workflow reconciliation #${replacement.id}`);
    assert.equal(archive.content, canonicalContent);
    assert.equal(archive.summary, Array.from(canonicalContent).slice(0, 1000).join(''));
    assert.equal(archive.visibility, 'team');
    assert.deepEqual(JSON.parse(archive.tags_json), ['campaign', 'reconciliation', 'workflow']);
    assert.ok(db.prepare('SELECT 1 FROM knowledge_chunks WHERE entry_id=? LIMIT 1').get(archive.id));
    assert.equal(db.prepare(`
      SELECT COUNT(*) count FROM campaign_record_links
      WHERE campaign_id=? AND record_type='knowledge_entry'
        AND record_id=? AND relation_type='knowledge' AND revoked_at IS NULL
    `).get(context.campaignId, String(archive.id)).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM workflow_instances WHERE campaign_id=?').get(context.campaignId).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM workflow_node_logs').get().count, 0);
    assert.deepEqual(db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?').get(failed.id), parentBefore);

    const replay = reconcile(service, context, failed, 992202, key, {
      expected_template_version: 7,
      reason: '  Repair immutable workflow evidence\r\nnow  '
    });
    assert.deepEqual(replay, result);
    assert.deepEqual(artifactCounts(db, context.campaignId), {
      events: 1, dispatches: 1, archives: 1, links: 1, ledgers: 1
    });
    assert.throws(() => reconcile(service, context, failed, 992202, key, {
      expected_template_version: 7,
      reason: 'Changed request'
    }), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');
    const loser = reconcile(service, context, failed, 992202, 'task6c1-pre-loser-0002', {
      expected_template_version: 7
    });
    assert.equal(loser.status, 409);
    assert.equal(loser.body.code, 'DISPATCH_ALREADY_RECONCILED');
    assert.deepEqual(loser.body.details, { replacement_dispatch_id: replacement.id });
  } finally {
    db.close();
  }
});

test('post-initialization and chained reconciliation preserve immediate-parent and immutable root lineage', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991301);
    insertTemplate(db, owner, 992301, 'Task original', taskGraph());
    insertTemplate(db, owner, 992302, 'Task repaired', taskGraph(), {
      version: 2,
      active: false
    });
    const transitionResult = transition(db, context);
    db.prepare('UPDATE workflow_templates SET is_active=1 WHERE id=?').run(992302);
    createCampaignWorkflowWorker(db).drain();
    const parent = failInitializedInstance(db, transitionResult.body.dispatches[0].id);
    const service = createCampaignWorkflowService(db);
    const options = option(service, context, parent.id);
    assert.deepEqual(options.required, {
      failure_shape: 'post_initialization',
      expected_dispatch_status: 'completed',
      expected_instance_status: 'failed_validation'
    });
    const first = reconcile(service, context, parent, 992302, 'task6c1-post-success-0001', {
      expected_template_version: 2
    });
    const firstReplacement = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?')
      .get(first.body.replacement_dispatch.id);
    failBeforeInitialization(db, firstReplacement.id);
    const failedReplacement = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?')
      .get(firstReplacement.id);
    const second = reconcile(service, context, failedReplacement, 992302, 'task6c1-chain-success-0002', {
      expected_template_version: 2
    });
    const chained = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?')
      .get(second.body.replacement_dispatch.id);
    assert.equal(chained.reconciles_dispatch_id, firstReplacement.id);
    assert.equal(chained.trigger_event_id, parent.trigger_event_id);
    assert.equal(chained.execution_context_json, parent.execution_context_json);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM workflow_instances WHERE campaign_id=?').get(context.campaignId).count, 1);
  } finally {
    db.close();
  }
});

test('reconciliation body IDs reject numeric strings before authorization or evidence', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991351);
    insertTemplate(db, owner, 992351, 'Strict JSON number recovery');
    const transitionResult = transition(db, context);
    const failed = failBeforeInitialization(db, transitionResult.body.dispatches[0].id);
    const unauthorizedMember = sameOrgMember(db, owner);
    const service = createCampaignWorkflowService(db);
    const beforeCounts = artifactCounts(db, context.campaignId);
    const beforeDispatch = db.prepare(
      'SELECT * FROM campaign_workflow_dispatches WHERE id=?'
    ).get(failed.id);
    const failures = [];

    for (const [field, value, key] of [
      ['template_id', String(992351), 'task6-final-string-template-0001'],
      ['expected_template_version', '1', 'task6-final-string-version-0001']
    ]) {
      const input = reconciliationInput(context, failed, 992351, key, {
        [field]: value
      });
      input.userId = unauthorizedMember.userId;
      try {
        service.reconcileWorkflowDispatch(input);
        assert.fail(`${field} numeric string must be rejected`);
      } catch (error) {
        failures.push({
          field,
          status: error.statusCode,
          code: error.code,
          message: error.message
        });
      }
      assert.deepEqual(
        artifactCounts(db, context.campaignId),
        beforeCounts,
        `${field} must not reserve a ledger or create evidence`
      );
      assert.deepEqual(
        db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE id=?').get(failed.id),
        beforeDispatch,
        `${field} must not mutate the failed dispatch`
      );
    }

    assert.deepEqual(failures, [
      {
        field: 'template_id',
        status: 400,
        code: 'INVALID_CAMPAIGN_INPUT',
        message: 'template_id is invalid.'
      },
      {
        field: 'expected_template_version',
        status: 400,
        code: 'INVALID_CAMPAIGN_INPUT',
        message: 'expected_template_version is invalid.'
      }
    ]);

    const validNumberResult = reconcile(
      service,
      context,
      failed,
      992351,
      'task6-final-valid-number-0001'
    );
    assert.equal(validNumberResult.status, 202);
    assert.deepEqual(artifactCounts(db, context.campaignId), {
      events: beforeCounts.events + 1,
      dispatches: beforeCounts.dispatches + 1,
      archives: beforeCounts.archives + 1,
      links: beforeCounts.links + 1,
      ledgers: beforeCounts.ledgers + 1
    });
  } finally {
    db.close();
  }
});

test('mutation validation, authorization, replay, operational, failure-shape, and template precedence are closed', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991401);
    insertTemplate(db, owner, 992401, 'Recovery');
    const transitionResult = transition(db, context);
    const failed = failBeforeInitialization(db, transitionResult.body.dispatches[0].id);
    const service = createCampaignWorkflowService(db);
    assert.throws(() => reconcile(service, context, failed, 992401, 'short'), (error) => (
      error.code === 'INVALID_CAMPAIGN_INPUT'
    ));
    assert.throws(() => service.reconcileWorkflowDispatch({
      userId: context.userId,
      campaignId: context.campaignId,
      dispatchId: failed.id,
      requestId: 'task6c1-unknown-body',
      idempotencyKey: 'task6c1-unknown-body-0001',
      body: { ...reconciliationBody(failed, 992401), unknown: true }
    }), (error) => error.code === 'INVALID_CAMPAIGN_INPUT');
    assert.throws(() => service.reconcileWorkflowDispatch({
      userId: context.userId,
      campaignId: context.campaignId,
      dispatchId: failed.id,
      requestId: 'task6c1-invalid-pair',
      idempotencyKey: 'task6c1-invalid-pair-0001',
      body: {
        ...reconciliationBody(failed, 992401),
        expected_instance_status: 'failed_validation'
      }
    }), (error) => error.code === 'INVALID_CAMPAIGN_INPUT');
    const member = sameOrgMember(db, owner);
    assert.throws(() => service.reconcileWorkflowDispatch({
      userId: member.userId,
      campaignId: context.campaignId,
      dispatchId: failed.id,
      requestId: 'task6c1-forbidden',
      idempotencyKey: 'task6c1-forbidden-0001',
      body: reconciliationBody(failed, 992401)
    }), (error) => error.statusCode === 403 && error.code === 'CAMPAIGN_FORBIDDEN');

    const retained = reconcile(service, context, failed, 992401, 'task6c1-replay-precedence-0001');
    db.prepare("UPDATE campaigns SET operational_status='on_hold' WHERE id=?").run(context.campaignId);
    const held = reconcile(service, context, failed, 992401, 'task6c1-held-replacement-0002');
    assert.equal(held.status, 409);
    assert.equal(held.body.code, 'CAMPAIGN_ON_HOLD');
    assert.deepEqual(held.body.details, { operational_status: 'on_hold' });
    db.prepare("UPDATE campaigns SET operational_status='cancelled' WHERE id=?").run(context.campaignId);
    assert.deepEqual(
      reconcile(service, context, failed, 992401, 'task6c1-replay-precedence-0001'),
      retained
    );
    const cancelled = reconcile(service, context, failed, 992401, 'task6c1-cancelled-new-0002');
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.body.code, 'CAMPAIGN_CANCELLED');
    assert.deepEqual(cancelled.body.details, { operational_status: 'cancelled' });
    db.prepare("UPDATE campaigns SET operational_status='active' WHERE id=?").run(context.campaignId);

    const secondContext = campaignFixture(db, owner, 991411);
    const secondTransition = transition(db, secondContext, 'task6c1-transition-second-0001');
    const secondFailed = failBeforeInitialization(db, secondTransition.body.dispatches[0].id);
    const staleShape = reconcile(service, secondContext, secondFailed, 992401, 'task6c1-shape-0001', {
      expected_dispatch_status: 'completed',
      expected_instance_status: 'failed_validation'
    });
    assert.equal(staleShape.status, 409);
    assert.equal(staleShape.body.code, 'DISPATCH_NOT_RECONCILABLE');
    const staleTemplate = reconcile(service, secondContext, secondFailed, 992401, 'task6c1-version-0001', {
      expected_template_version: 2
    });
    assert.equal(staleTemplate.status, 409);
    assert.equal(staleTemplate.body.code, 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE');
    db.prepare('UPDATE workflow_templates SET is_active=0 WHERE id=?').run(992401);
    const inactive = reconcile(service, secondContext, secondFailed, 992401, 'task6c1-inactive-0001');
    assert.equal(inactive.status, 409);
    assert.equal(inactive.body.code, 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE');
  } finally {
    db.close();
  }
});

test('active processing wins precedence and expired processing is reclaimed once then replays', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const service = createCampaignWorkflowService(db);
    const context = campaignFixture(db, owner, 991451);
    insertTemplate(db, owner, 992451, 'Idempotency recovery');
    const transitionResult = transition(
      db,
      context,
      'task6c1-transition-active-processing'
    );
    const failed = failBeforeInitialization(
      db,
      transitionResult.body.dispatches[0].id
    );
    const activeKey = 'task6c1-active-processing-0001';
    reserveReconciliation(db, context, failed, 992451, activeKey);
    const winner = reconcile(
      service,
      context,
      failed,
      992451,
      'task6c1-active-processing-winner'
    );
    assert.equal(winner.status, 202);
    db.prepare(`
      UPDATE campaigns SET operational_status='on_hold' WHERE id=?
    `).run(context.campaignId);
    assert.throws(
      () => reconcile(service, context, failed, 992451, activeKey),
      (error) => (
        error.statusCode === 409 &&
        error.code === 'IDEMPOTENCY_IN_PROGRESS' &&
        Number.isSafeInteger(error.retryAfterSeconds) &&
        error.retryAfterSeconds >= 1
      )
    );

    const recoveryContext = campaignFixture(db, owner, 991452);
    const recoveryTransition = transition(
      db,
      recoveryContext,
      'task6c1-transition-expired-processing'
    );
    const recoveryFailed = failBeforeInitialization(
      db,
      recoveryTransition.body.dispatches[0].id
    );
    const recoveryKey = 'task6c1-expired-processing-0001';
    const reserved = reserveReconciliation(
      db,
      recoveryContext,
      recoveryFailed,
      992451,
      recoveryKey
    );
    withTriggerDisabled(db, 'request_idempotency_legal_transition', () => {
      db.prepare(`
        UPDATE request_idempotency
        SET lease_until=datetime(CURRENT_TIMESTAMP,'-1 second')
        WHERE id=?
      `).run(reserved.reservation.ledgerId);
    });
    const recovered = reconcile(
      service,
      recoveryContext,
      recoveryFailed,
      992451,
      recoveryKey
    );
    assert.equal(recovered.status, 202);
    assert.deepEqual(
      reconcile(
        service,
        recoveryContext,
        recoveryFailed,
        992451,
        recoveryKey
      ),
      recovered
    );
    assert.deepEqual(db.prepare(`
      SELECT id,state FROM request_idempotency WHERE id=?
    `).get(reserved.reservation.ledgerId), {
      id: reserved.reservation.ledgerId,
      state: 'completed'
    });
    assert.deepEqual(artifactCounts(db, recoveryContext.campaignId), {
      events: 1, dispatches: 1, archives: 1, links: 1, ledgers: 1
    });
  } finally {
    db.close();
  }
});

test('transaction-boundary reauthorization loss returns current access result without reservation or evidence', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991460);
    insertTemplate(db, owner, 992460, 'Reauthorization identity loss');
    const transitionResult = transition(
      db,
      context,
      'task6c1-transition-reauthorization-loss'
    );
    const failed = failBeforeInitialization(
      db,
      transitionResult.body.dispatches[0].id
    );
    const before = artifactCounts(db, context.campaignId);
    let boundaryCalls = 0;
    const adapter = databaseAdapter(db, {
      beforeTransaction(target) {
        boundaryCalls += 1;
        target.prepare('UPDATE users SET is_active=0 WHERE id=?')
          .run(context.userId);
      }
    });
    assert.throws(
      () => reconcile(
        createCampaignWorkflowService(adapter),
        context,
        failed,
        992460,
        'task6c1-reauthorization-loss-0001'
      ),
      (error) => (
        error.statusCode === 404 && error.code === 'CAMPAIGN_NOT_FOUND'
      )
    );
    assert.equal(boundaryCalls, 1);
    assert.equal(
      db.prepare('SELECT is_active FROM users WHERE id=?').get(context.userId).is_active,
      0
    );
    assert.deepEqual(artifactCounts(db, context.campaignId), before);
  } finally {
    db.close();
  }
});

test('transaction-time template version graph and trigger changes fail before reconciliation evidence', () => {
  const cases = [
    {
      name: 'version',
      mutate(db, templateId) {
        db.prepare('UPDATE workflow_templates SET version=version+1 WHERE id=?')
          .run(templateId);
      }
    },
    {
      name: 'checksum graph',
      mutate(db, templateId) {
        db.prepare("UPDATE workflow_templates SET edges='[]' WHERE id=?")
          .run(templateId);
      }
    },
    {
      name: 'trigger',
      mutate(db, templateId) {
        db.prepare(`
          UPDATE workflow_templates SET trigger_config_json=? WHERE id=?
        `).run(JSON.stringify({
          event_type: 'lifecycle_transition',
          previous_state: 'qualified',
          next_state: 'demand_confirmed'
        }), templateId);
      }
    }
  ];
  for (const scenario of cases) {
    const db = openDatabase();
    try {
      const owner = identity(db);
      const index = cases.indexOf(scenario);
      const context = campaignFixture(db, owner, 991470 + index);
      const templateId = 992470 + index;
      insertTemplate(db, owner, templateId, `Template race ${scenario.name}`);
      const transitionResult = transition(
        db,
        context,
        `task6c1-transition-template-race-${index}`
      );
      const failed = failBeforeInitialization(
        db,
        transitionResult.body.dispatches[0].id
      );
      let lockHooks = 0;
      const adapter = databaseAdapter(db, {
        insideTransaction(target) {
          lockHooks += 1;
          assert.equal(target.inTransaction, true);
          scenario.mutate(target, templateId);
        }
      });
      const key = `task6c1-template-race-${scenario.name.replace(/ /g, '-')}-0001`;
      const result = reconcile(
        createCampaignWorkflowService(adapter),
        context,
        failed,
        templateId,
        key
      );
      assert.equal(lockHooks, 1);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'INVALID_CAMPAIGN_WORKFLOW_TEMPLATE');
      assert.deepEqual(artifactCounts(db, context.campaignId), {
        events: 0, dispatches: 0, archives: 0, links: 0, ledgers: 1
      });
      assert.deepEqual(
        reconcile(
          createCampaignWorkflowService(db),
          context,
          failed,
          templateId,
          key
        ),
        result
      );
    } finally {
      db.close();
    }
  }
});

test('serialized different-key loser observes the committed replacement under its final write lock', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991480);
    insertTemplate(db, owner, 992480, 'Serialized winner recovery');
    const transitionResult = transition(
      db,
      context,
      'task6c1-transition-serialized-loser'
    );
    const failed = failBeforeInitialization(
      db,
      transitionResult.body.dispatches[0].id
    );
    let winner;
    let boundaryCalls = 0;
    let replacementProbeUnderLock = false;
    const adapter = databaseAdapter(db, {
      beforeTransaction(target) {
        boundaryCalls += 1;
        winner = reconcile(
          createCampaignWorkflowService(target),
          context,
          failed,
          992480,
          'task6c1-serialized-winner-0001'
        );
      },
      prepare({ db: target, sql, statement }) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (
          normalized.includes('FROM campaign_workflow_dispatches') &&
          normalized.includes('WHERE reconciles_dispatch_id=?')
        ) {
          replacementProbeUnderLock = target.inTransaction;
        }
        return statement;
      }
    });
    const loser = reconcile(
      createCampaignWorkflowService(adapter),
      context,
      failed,
      992480,
      'task6c1-serialized-loser-0001'
    );
    assert.equal(boundaryCalls, 1);
    assert.equal(winner.status, 202);
    assert.equal(replacementProbeUnderLock, true);
    assert.equal(loser.status, 409);
    assert.equal(loser.body.code, 'DISPATCH_ALREADY_RECONCILED');
    assert.deepEqual(loser.body.details, {
      replacement_dispatch_id: winner.body.replacement_dispatch.id
    });
    assert.deepEqual(artifactCounts(db, context.campaignId), {
      events: 1, dispatches: 1, archives: 1, links: 1, ledgers: 2
    });
  } finally {
    db.close();
  }
});

test('injected SQL/archive/ledger failures and replacement ID exhaustion roll back every artifact safely', () => {
  const cases = [
    {
      name: 'event',
      trigger: `CREATE TEMP TRIGGER task6c1_event_failure BEFORE INSERT ON main.campaign_events
        WHEN NEW.event_type='workflow_reconciliation'
        BEGIN SELECT RAISE(ABORT,'secret event sql'); END`
    },
    {
      name: 'dispatch',
      trigger: `CREATE TEMP TRIGGER task6c1_dispatch_failure BEFORE INSERT ON main.campaign_workflow_dispatches
        WHEN NEW.reconciles_dispatch_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'secret dispatch sql'); END`
    },
    {
      name: 'archive',
      trigger: `CREATE TEMP TRIGGER task6c1_archive_failure BEFORE INSERT ON main.knowledge_entries
        WHEN NEW.source_type='campaign_workflow_reconciliation'
        BEGIN SELECT RAISE(ABORT,'secret archive sql'); END`
    },
    {
      name: 'link',
      trigger: `CREATE TEMP TRIGGER task6c1_link_failure BEFORE INSERT ON main.campaign_record_links
        WHEN NEW.relation_type='knowledge'
        BEGIN SELECT RAISE(ABORT,'secret link sql'); END`
    },
    {
      name: 'ledger',
      trigger: `CREATE TEMP TRIGGER task6c1_ledger_failure BEFORE UPDATE ON main.request_idempotency
        WHEN OLD.scope='campaign.workflow.reconcile' AND NEW.state='completed'
        BEGIN SELECT RAISE(ABORT,'secret ledger sql'); END`
    }
  ];
  for (const fault of cases) {
    const db = openDatabase();
    try {
      const owner = identity(db);
      const campaignId = 991500 + cases.indexOf(fault) * 10;
      const context = campaignFixture(db, owner, campaignId);
      insertTemplate(db, owner, 992500 + cases.indexOf(fault), `Recovery ${fault.name}`);
      const transitionResult = transition(db, context, `task6c1-transition-${fault.name}-0001`);
      const failed = failBeforeInitialization(db, transitionResult.body.dispatches[0].id);
      const before = artifactCounts(db, context.campaignId);
      db.exec(fault.trigger);
      assert.throws(() => reconcile(
        createCampaignWorkflowService(db), context, failed,
        992500 + cases.indexOf(fault), `task6c1-fault-${fault.name}-0001`
      ), (error) => (
        error.statusCode === 500 && error.code === 'AUDIT_PERSISTENCE_FAILED' &&
        !String(error.message).includes('secret')
      ));
      assert.deepEqual(artifactCounts(db, context.campaignId), before);
    } finally {
      db.close();
    }
  }

  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991590);
    insertTemplate(db, owner, 992590, 'Exhausted recovery');
    const transitionResult = transition(db, context, 'task6c1-transition-exhaustion-0001');
    const failed = failBeforeInitialization(db, transitionResult.body.dispatches[0].id);
    const supportContext = campaignFixture(db, owner, 991592);
    const supportTransition = transition(
      db,
      supportContext,
      'task6c1-transition-exhaustion-support'
    );
    withTriggerDisabled(db, 'campaign_workflow_dispatches_legal_transition', () => {
      db.prepare('UPDATE campaign_workflow_dispatches SET id=? WHERE id=?').run(
        Number.MAX_SAFE_INTEGER,
        supportTransition.body.dispatches[0].id
      );
    });
    const before = artifactCounts(db, context.campaignId);
    assert.throws(() => reconcile(
      createCampaignWorkflowService(db), context, failed, 992590,
      'task6c1-id-exhaustion-0001'
    ), (error) => error.statusCode === 500 && error.code === 'AUDIT_PERSISTENCE_FAILED');
    assert.deepEqual(artifactCounts(db, context.campaignId), before);
  } finally {
    db.close();
  }
});

test('explicit replacement ID collision probe fails closed and rolls back reservation and evidence', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991593);
    insertTemplate(db, owner, 992593, 'Collision recovery');
    const transitionResult = transition(
      db,
      context,
      'task6c1-transition-id-collision'
    );
    const failed = failBeforeInitialization(
      db,
      transitionResult.body.dispatches[0].id
    );
    const before = artifactCounts(db, context.campaignId);
    let collisionProbes = 0;
    let collisionProbeUnderLock = false;
    const adapter = databaseAdapter(db, {
      prepare({ db: target, sql, statement }) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (
          normalized ===
          'SELECT 1 FROM campaign_workflow_dispatches WHERE id=?'
        ) {
          collisionProbes += 1;
          collisionProbeUnderLock = target.inTransaction;
          return {
            get() {
              return { collision: 1 };
            }
          };
        }
        return statement;
      }
    });
    assert.throws(
      () => reconcile(
        createCampaignWorkflowService(adapter),
        context,
        failed,
        992593,
        'task6c1-id-collision-0001'
      ),
      (error) => (
        error.statusCode === 500 &&
        error.code === 'AUDIT_PERSISTENCE_FAILED' &&
        error.message ===
          'Campaign workflow reconciliation could not be persisted safely.' &&
        !/SELECT|SQLITE|campaign_workflow_dispatches/iu.test(error.message) &&
        !Object.hasOwn(error, 'details')
      )
    );
    assert.equal(collisionProbes, 1);
    assert.equal(collisionProbeUnderLock, true);
    assert.deepEqual(artifactCounts(db, context.campaignId), before);
  } finally {
    db.close();
  }
});

test('knowledge capacity failure maps to stable retained 507 and leaves no reconciliation evidence', () => {
  const db = openDatabase();
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991595);
    insertTemplate(db, owner, 992595, 'Capacity recovery');
    const transitionResult = transition(db, context, 'task6c1-transition-capacity-0001');
    const failed = failBeforeInitialization(db, transitionResult.body.dispatches[0].id);
    const existing = db.prepare('SELECT COUNT(*) count FROM knowledge_entries WHERE created_by=?')
      .get(owner.userId).count;
    bulkFillUserKnowledgeEntries(db, owner.userId, 50000 - existing);
    const key = 'task6c1-capacity-0001';
    const result = reconcile(createCampaignWorkflowService(db), context, failed, 992595, key);
    assert.equal(result.status, 507);
    assert.equal(result.body.code, 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED');
    assert.deepEqual(result.body.details, {
      scope: 'user', metric: 'entries', limit: 50000, projected: 50001
    });
    assert.deepEqual(artifactCounts(db, context.campaignId), {
      events: 0, dispatches: 0, archives: 0, links: 0, ledgers: 1
    });
    const replay = reconcile(createCampaignWorkflowService(db), context, failed, 992595, key);
    assert.deepEqual(replay, result);
  } finally {
    db.close();
  }
});

test('HTTP endpoints use the common policies, exact media contract, and production policy registration', async () => {
  const db = openDatabase();
  let api;
  try {
    const owner = identity(db);
    const context = campaignFixture(db, owner, 991601);
    insertTemplate(db, owner, 992601, 'HTTP recovery');
    const transitionResult = transition(db, context);
    const failed = failBeforeInitialization(db, transitionResult.body.dispatches[0].id);
    api = await startApi(db, owner.userId);
    const options = await api.request(
      'GET',
      `/api/campaigns/${context.campaignId}/workflow-reconciliation-options?dispatch_id=${failed.id}`
    );
    assert.equal(options.status, 200);
    assert.equal(options.body.state, 'eligible');
    const unsupported = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/reconcile`,
      {
        idempotencyKey: 'task6c1-http-media-0001',
        contentType: 'text/plain',
        body: 'not json'
      }
    );
    assert.equal(unsupported.status, 415);
    assert.equal(unsupported.body.code, 'UNSUPPORTED_MEDIA_TYPE');
    const success = await api.request(
      'POST',
      `/api/campaigns/${context.campaignId}/workflow-dispatches/${failed.id}/reconcile`,
      {
        idempotencyKey: 'task6c1-http-success-0001',
        body: reconciliationBody(failed, 992601)
      }
    );
    assert.equal(success.status, 202);

    const productionRegistry = productionPolicyRegistry();
    assert.equal(
      productionRegistry.match(
        'GET',
        `/api/campaigns/${context.campaignId}/workflow-reconciliation-options` +
          `?dispatch_id=${failed.id}`
      ),
      campaignContract.REQUEST_POLICIES.CAMPAIGN_WORKFLOW_RECONCILIATION_OPTIONS
    );
    assert.equal(
      productionRegistry.match(
        'POST',
        `/api/campaigns/${context.campaignId}` +
          `/workflow-dispatches/${failed.id}/reconcile`
      ),
      campaignContract.REQUEST_POLICIES.CAMPAIGN_WORKFLOW_RECONCILE
    );
    assert.equal(
      productionRegistry.isOwnedRoute(
        'POST',
        `/api/campaigns/${context.campaignId}` +
          `/workflow-dispatches/${failed.id}/reconcile`
      ),
      true
    );
  } finally {
    if (api) await api.close();
    db.close();
  }
});
