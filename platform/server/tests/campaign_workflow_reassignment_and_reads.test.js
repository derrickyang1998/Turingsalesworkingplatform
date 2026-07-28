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
const { createCampaignService } = require('../services/campaign_service');
const idempotency = require('../services/idempotency_service');
const { requestHash } = require('../services/sqlite_digest_service');
const {
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

function openWorkflowDatabase(options = {}) {
  const db = new Database(':memory:', options);
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

function workflowIdentity(db) {
  const row = db.prepare(`
    SELECT
      user.id AS userId,user.role AS platformRole,
      membership.org_id AS orgId,membership.role_code AS organizationRole,
      team.team_id AS teamId,team.role_code AS teamRole
    FROM users user
    JOIN organization_memberships membership
      ON membership.user_id=user.id AND membership.status='active'
    JOIN team_memberships team
      ON team.user_id=user.id AND team.org_id=membership.org_id
     AND team.status='active'
    WHERE user.is_active=1 AND user.role='admin'
    ORDER BY
      CASE WHEN membership.role_code='org_admin' THEN 0 ELSE 1 END,
      user.id,team.team_id
    LIMIT 1
  `).get();
  assert.ok(row);
  return row;
}

function addActor(db, context, userId, options = {}) {
  const platformRole = options.platformRole || 'user';
  const organizationRole = options.organizationRole || 'member';
  const teamRole = options.teamRole || 'member';
  db.prepare(`
    INSERT INTO users (
      id,username,password_hash,display_name,role,is_active
    ) VALUES (?,?,?,?,?,?)
  `).run(
    userId,
    `task6c3-user-${userId}`,
    'task6c3-password-hash',
    `Task 6C-3 user ${userId}`,
    platformRole,
    options.active === false ? 0 : 1
  );
  if (options.organizationMembership !== false) {
    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (?,?,?,?)
    `).run(
      context.orgId,
      userId,
      organizationRole,
      options.organizationStatus || 'active'
    );
  }
  if (options.teamMembership !== false) {
    db.prepare(`
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
      VALUES (?,?,?,?,?)
    `).run(
      context.orgId,
      context.teamId,
      userId,
      teamRole,
      options.teamStatus || 'active'
    );
  }
  return userId;
}

function terminalTaskGraph(taskConfig = {}) {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'human',
        type: 'task',
        label: 'Human task',
        config: {
          title: 'Human task',
          description: 'Reassignment fixture',
          assignee_id: null,
          assignee_role: 'member',
          due_hours: null,
          ...taskConfig
        }
      },
      { id: 'end', type: 'end', label: 'End', config: {} }
    ],
    edges: [
      {
        id: 'start-next',
        from: 'start',
        to: 'human',
        outcome: 'next',
        priority: 0,
        condition: null
      },
      {
        id: 'human-complete',
        from: 'human',
        to: 'end',
        outcome: 'complete',
        priority: 0,
        condition: null
      }
    ]
  };
}

function initializeFixture(db, identity, campaignId, templateId, options = {}) {
  const customerId = campaignId + 1;
  const opportunityId = campaignId + 2;
  const graph = terminalTaskGraph(options.taskConfig);
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (?,?,?,'qualified','test',?,?)
  `).run(
    customerId,
    `Task 6C-3 brand ${campaignId}`,
    `Task 6C-3 company ${campaignId}`,
    identity.userId,
    identity.userId
  );
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,
      channel_type,created_by
    ) VALUES (?,?,'Task 6C-3 opportunity','proposal',1000,50,'Workflow','influencer',?)
  `).run(opportunityId, customerId, identity.userId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,?,?,?,?,?,'lead','active',1)
  `).run(
    campaignId,
    identity.orgId,
    `Task 6C-3 campaign ${campaignId}`,
    customerId,
    opportunityId,
    identity.userId,
    identity.teamId
  );
  db.prepare(`
    INSERT INTO workflow_templates (
      id,name,description,module,category,nodes,edges,version,is_active,
      created_by,trigger_config_json
    ) VALUES (?,?,'Task 6C-3 fixture','campaign','task',?,?,1,1,?,?)
  `).run(
    templateId,
    `Task 6C-3 template ${templateId}`,
    JSON.stringify(graph.nodes),
    JSON.stringify(graph.edges),
    identity.userId,
    JSON.stringify({
      event_type: 'lifecycle_transition',
      previous_state: 'lead',
      next_state: 'qualified'
    })
  );
  const transition = createCampaignService(db).transitionCampaign({
    userId: identity.userId,
    campaignId,
    requestId: `task6c3-transition-request-${campaignId}`,
    idempotencyKey: `task6c3-transition-${campaignId}`,
    body: {
      expected_state: 'lead',
      expected_version: 1,
      next_state: 'qualified',
      reason: 'Initialize Task 6C-3 workflow'
    }
  });
  assert.equal(transition.status, 200);
  assert.equal(createCampaignWorkflowWorker(db).drain().claimed, 1);
  const instance = db.prepare('SELECT * FROM workflow_instances WHERE campaign_id=?')
    .get(campaignId);
  const task = db.prepare('SELECT * FROM workflow_tasks WHERE instance_id=?')
    .get(instance.id);
  const dispatch = db.prepare('SELECT * FROM campaign_workflow_dispatches WHERE campaign_id=?')
    .get(campaignId);
  assert.ok(instance && task && dispatch);
  db.prepare('UPDATE workflow_templates SET is_active=0 WHERE id=?').run(templateId);
  return {
    ...identity,
    campaignId,
    customerId,
    opportunityId,
    templateId,
    transition,
    instance,
    task,
    dispatch
  };
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

async function startWorkflowReadApi(db, actorUserId) {
  const app = express();
  const authMiddleware = (request, response, next) => {
    const user = db.prepare(`
      SELECT id,username,display_name,role,department,is_active
      FROM users WHERE id=? AND is_active=1
    `).get(actorUserId);
    if (!user) return response.status(401).json({ error: 'Unauthorized' });
    request.user = user;
    return next();
  };
  loadWorkflowRoutes()(app, db, authMiddleware, (_request, _response, next) => next());
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    async get(requestPath) {
      const response = await fetch(baseUrl + requestPath);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      server.close();
      await once(server, 'close');
    }
  };
}

function createLegacyWorkflowTemplate(db, identity, templateId) {
  db.prepare(`
    INSERT INTO workflow_templates (
      id,name,description,module,category,nodes,edges,version,is_active,created_by
    ) VALUES (?,?,'Task 6C-3 legacy fixture','customer','task','[]','[]',1,1,?)
  `).run(templateId, `Task 6C-3 legacy template ${templateId}`, identity.userId);
}

function createLegacyTask(db, identity, templateId, options = {}) {
  const instanceId = Number(db.prepare(`
    INSERT INTO workflow_instances (
      template_id,business_type,business_id,current_node_id,status,node_data,started_by
    ) VALUES (?,'customer',?,'legacy-node','active','{}',?)
  `).run(templateId, options.businessId || 1, identity.userId).lastInsertRowid);
  const taskId = Number(db.prepare(`
    INSERT INTO workflow_tasks (
      instance_id,node_id,node_type,title,description,assignee_id,assignee_role,status
    ) VALUES (?,'legacy-node','task',?,'Legacy task',?,NULL,?)
  `).run(
    instanceId,
    options.title || `Legacy task ${instanceId}`,
    Object.hasOwn(options, 'assigneeId') ? options.assigneeId : null,
    options.status || 'pending'
  ).lastInsertRowid);
  return { instanceId, taskId };
}

function attachMalformedWorkflowLink(db, context, instanceId, nonce) {
  const linkId = Number(db.prepare(`
    SELECT COALESCE(MAX(id),0)+1 AS id FROM campaign_record_links
  `).get().id);
  const bundleId = crypto.createHash('sha256')
    .update(`task6c3-malformed-link-${nonce}`).digest('hex');
  db.prepare(`
    INSERT INTO campaign_record_links (
      id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,'workflow_instance',?,?,'workflow',?,'{}')
  `).run(
    linkId,
    context.orgId,
    context.campaignId,
    bundleId,
    String(instanceId),
    context.userId
  );
}

function corruptDispatchCampaignIdentity(db, fixture, orgId, campaignId) {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.pragma('foreign_keys = OFF');
  try {
    withTriggersDisabled(db, [
      'campaign_events_no_update',
      'campaign_workflow_dispatches_immutable_evidence',
      'campaign_workflow_dispatches_legal_transition'
    ], () => {
      db.prepare(`
        UPDATE campaign_events SET org_id=?,campaign_id=? WHERE id=?
      `).run(orgId, campaignId, fixture.dispatch.trigger_event_id);
      db.prepare(`
        UPDATE campaign_workflow_dispatches SET org_id=?,campaign_id=? WHERE id=?
      `).run(orgId, campaignId, fixture.dispatch.id);
    });
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function corruptCoherentWorkflowOrganization(db, fixture, organizationId) {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.pragma('foreign_keys = OFF');
  try {
    withTriggersDisabled(db, [
      'campaign_events_no_update',
      'workflow_instances_campaign_context_immutable',
      'campaign_links_update_only_revoke',
      'campaign_workflow_dispatches_immutable_evidence',
      'campaign_workflow_dispatches_legal_transition'
    ], () => {
      const events = db.prepare(`
        UPDATE campaign_events SET org_id=? WHERE id IN (?,?)
      `).run(
        organizationId,
        fixture.dispatch.event_id,
        fixture.dispatch.trigger_event_id
      );
      assert.ok(events.changes >= 1 && events.changes <= 2);
      assert.equal(db.prepare(`
        UPDATE campaign_workflow_dispatches SET org_id=? WHERE id=?
      `).run(organizationId, fixture.dispatch.id).changes, 1);
      assert.equal(db.prepare(`
        UPDATE workflow_instances SET org_id=? WHERE id=?
      `).run(organizationId, fixture.instance.id).changes, 1);
      assert.equal(db.prepare(`
        UPDATE campaign_record_links SET org_id=?
        WHERE record_type='workflow_instance' AND relation_type='workflow'
          AND record_id=? AND revoked_at IS NULL
      `).run(organizationId, String(fixture.instance.id)).changes, 1);
    });
  } finally {
    db.pragma('foreign_keys = ON');
  }
  assert.deepEqual(db.prepare(`
    SELECT
      instance.org_id AS instance_org_id,
      workflow_link.org_id AS link_org_id,
      dispatch.org_id AS dispatch_org_id,
      dispatch_event.org_id AS dispatch_event_org_id,
      root_event.org_id AS root_event_org_id,
      instance.campaign_id,workflow_link.campaign_id AS link_campaign_id,
      dispatch.campaign_id AS dispatch_campaign_id,
      dispatch_event.campaign_id AS dispatch_event_campaign_id,
      root_event.campaign_id AS root_event_campaign_id
    FROM workflow_instances instance
    JOIN campaign_record_links workflow_link
      ON workflow_link.record_type='workflow_instance'
     AND workflow_link.relation_type='workflow'
     AND workflow_link.record_id=CAST(instance.id AS TEXT)
     AND workflow_link.revoked_at IS NULL
    JOIN campaign_workflow_dispatches dispatch
      ON dispatch.id=instance.campaign_dispatch_id
    JOIN campaign_events dispatch_event ON dispatch_event.id=dispatch.event_id
    JOIN campaign_events root_event ON root_event.id=dispatch.trigger_event_id
    WHERE instance.id=?
  `).get(fixture.instance.id), {
    instance_org_id: organizationId,
    link_org_id: organizationId,
    dispatch_org_id: organizationId,
    dispatch_event_org_id: organizationId,
    root_event_org_id: organizationId,
    campaign_id: fixture.campaignId,
    link_campaign_id: fixture.campaignId,
    dispatch_campaign_id: fixture.campaignId,
    dispatch_event_campaign_id: fixture.campaignId,
    root_event_campaign_id: fixture.campaignId
  });
}

function duplicateActiveWorkflowLink(db, fixture, nonce) {
  db.exec('DROP INDEX ux_campaign_active_relation');
  withTriggersDisabled(db, ['campaign_links_bundle_identity_insert'], () => {
    attachMalformedWorkflowLink(db, fixture, fixture.instance.id, nonce);
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM campaign_record_links
    WHERE org_id=? AND campaign_id=? AND record_type='workflow_instance'
      AND relation_type='workflow' AND record_id=? AND revoked_at IS NULL
  `).get(
    fixture.orgId,
    fixture.campaignId,
    String(fixture.instance.id)
  ).count, 2);
}

function reassignmentInput(fixture, overrides = {}) {
  return {
    userId: overrides.userId || fixture.userId,
    campaignId: Object.hasOwn(overrides, 'campaignId')
      ? overrides.campaignId
      : fixture.campaignId,
    taskId: Object.hasOwn(overrides, 'taskId') ? overrides.taskId : fixture.task.id,
    requestId: overrides.requestId || `task6c3-reassign-request-${fixture.campaignId}`,
    idempotencyKey: Object.hasOwn(overrides, 'idempotencyKey')
      ? overrides.idempotencyKey
      : `task6c3-reassign-${fixture.campaignId}`,
    body: overrides.body || {
      expected_task_status: 'pending',
      expected_instance_status: 'active',
      expected_assignment_version: fixture.task.assignment_version,
      assignee_id: overrides.assigneeId,
      assignee_role: Object.hasOwn(overrides, 'assigneeRole')
        ? overrides.assigneeRole
        : 'member',
      reason: overrides.reason || 'Assign to the current campaign delivery owner'
    }
  };
}

function callError(operation) {
  try {
    operation();
  } catch (error) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      retryAfterSeconds: error.retryAfterSeconds
    };
  }
  assert.fail('expected operation to throw');
}

function taskWithoutAssignment(task) {
  const copy = { ...task };
  delete copy.assignee_id;
  delete copy.assignee_role;
  delete copy.assignment_version;
  return copy;
}

const INSTANCE_COLLECTION_KEYS = Object.freeze([
  'id', 'template_id', 'business_type', 'business_id', 'current_node_id',
  'status', 'node_data', 'started_by', 'completed_at', 'created_at',
  'template_name'
]);

function workflowMutationSnapshot(db, fixture) {
  return {
    task: db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(fixture.task.id),
    instance: db.prepare('SELECT * FROM workflow_instances WHERE id=?')
      .get(fixture.instance.id),
    logs: db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_node_logs WHERE instance_id=?
    `).get(fixture.instance.id).count,
    activities: db.prepare(`
      SELECT COUNT(*) AS count FROM activity_log
      WHERE module='workflow' AND json_extract(details,'$.instance_id')=?
    `).get(fixture.instance.id).count,
    archives: db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE business_type='campaign' AND business_id=?
        AND source_type='campaign_workflow_log'
    `).get(String(fixture.campaignId)).count,
    links: db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE campaign_id=? AND revoked_at IS NULL
    `).get(fixture.campaignId).count,
    events: db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?
    `).get(fixture.campaignId).count
  };
}

function assertWorkflowMutationEvidenceUnchanged(after, before, label) {
  for (const key of ['logs', 'activities', 'archives', 'links', 'events']) {
    assert.equal(typeof before[key], 'number', `${label}: before ${key} must be numeric`);
    assert.equal(typeof after[key], 'number', `${label}: after ${key} must be numeric`);
    assert.equal(after[key], before[key], `${label}: ${key}`);
  }
}

test('only the current owner or active organization admin can reassign a campaign task', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const ownerFixture = initializeFixture(db, identity, 910001, 911001);
    const ownerTarget = addActor(db, ownerFixture, 912001);
    db.prepare(`
      UPDATE organization_memberships SET role_code='member'
      WHERE org_id=? AND user_id=?
    `).run(identity.orgId, identity.userId);

    const ownerBefore = db.prepare('SELECT * FROM workflow_tasks WHERE id=?')
      .get(ownerFixture.task.id);
    const ownerResult = createCampaignWorkflowService(db).reassignWorkflowTask(
      reassignmentInput(ownerFixture, { assigneeId: ownerTarget })
    );
    assert.deepEqual(ownerResult, {
      status: 200,
      body: {
        success: true,
        task_id: ownerFixture.task.id,
        task_status: 'pending',
        workflow_instance_id: ownerFixture.instance.id,
        instance_status: 'active',
        assignment: {
          assignee_id: ownerTarget,
          assignee_role: 'member',
          assignment_version: 2
        }
      },
      headers: {}
    });
    const ownerAfter = db.prepare('SELECT * FROM workflow_tasks WHERE id=?')
      .get(ownerFixture.task.id);
    assert.deepEqual(taskWithoutAssignment(ownerAfter), taskWithoutAssignment(ownerBefore));
    assert.equal(ownerAfter.assignee_id, ownerTarget);
    assert.equal(ownerAfter.assignee_role, 'member');
    assert.equal(ownerAfter.assignment_version, 2);

    db.prepare(`
      UPDATE organization_memberships SET role_code='org_admin'
      WHERE org_id=? AND user_id=?
    `).run(identity.orgId, identity.userId);
    const adminFixture = initializeFixture(db, identity, 910101, 911101);
    const adminTarget = addActor(db, adminFixture, 912101);
    const adminResult = createCampaignWorkflowService(db).reassignWorkflowTask(
      reassignmentInput(adminFixture, { assigneeId: adminTarget })
    );
    assert.equal(adminResult.status, 200);
    assert.equal(adminResult.body.assignment.assignee_id, adminTarget);

    const deniedFixture = initializeFixture(db, identity, 910201, 911201);
    const deniedTarget = addActor(db, deniedFixture, 912201);
    const teamWriter = addActor(db, deniedFixture, 912202);
    const legacyAdminWriter = addActor(db, deniedFixture, 912203, {
      platformRole: 'admin'
    });
    const beforeDenied = db.prepare('SELECT * FROM workflow_tasks WHERE id=?')
      .get(deniedFixture.task.id);
    for (const caller of [teamWriter, legacyAdminWriter]) {
      const denied = callError(() => createCampaignWorkflowService(db).reassignWorkflowTask(
        reassignmentInput(deniedFixture, {
          userId: caller,
          assigneeId: deniedTarget,
          idempotencyKey: `task6c3-denied-${caller}`
        })
      ));
      assert.deepEqual(denied, {
        status: 403,
        code: 'CAMPAIGN_FORBIDDEN',
        message: 'Campaign access is forbidden.',
        details: undefined,
        retryAfterSeconds: undefined
      });
    }
    assert.deepEqual(
      db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(deniedFixture.task.id),
      beforeDenied
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE scope='workflow.campaign-task.reassign'
    `).get().count, 2);
  } finally {
    db.close();
  }
});

test('reassignment closes exact body, integer, enum, null, text, and idempotency boundaries before mutation', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const fixture = initializeFixture(db, identity, 913001, 914001);
    const target = addActor(db, fixture, 915001);
    const validBody = reassignmentInput(fixture, { assigneeId: target }).body;
    const cases = [
      ['missing field', { ...validBody, reason: undefined }, 'task6c3-boundary-001'],
      ['unknown field', { ...validBody, source: 'caller' }, 'task6c3-boundary-002'],
      ['wrong task status', { ...validBody, expected_task_status: 'completed' }, 'task6c3-boundary-003'],
      ['wrong instance status', { ...validBody, expected_instance_status: 'paused' }, 'task6c3-boundary-004'],
      ['string version', { ...validBody, expected_assignment_version: '1' }, 'task6c3-boundary-005'],
      ['zero version', { ...validBody, expected_assignment_version: 0 }, 'task6c3-boundary-006'],
      ['unsafe version', { ...validBody, expected_assignment_version: Number.MAX_SAFE_INTEGER + 1 }, 'task6c3-boundary-007'],
      ['string assignee', { ...validBody, assignee_id: String(target) }, 'task6c3-boundary-008'],
      ['zero assignee', { ...validBody, assignee_id: 0 }, 'task6c3-boundary-009'],
      ['unsafe assignee', { ...validBody, assignee_id: Number.MAX_SAFE_INTEGER + 1 }, 'task6c3-boundary-010'],
      ['wrong role', { ...validBody, assignee_role: 'Member' }, 'task6c3-boundary-011'],
      ['undefined role', { ...validBody, assignee_role: undefined }, 'task6c3-boundary-012'],
      ['empty assignment', { ...validBody, assignee_id: null, assignee_role: null }, 'task6c3-boundary-013'],
      ['non-string reason', { ...validBody, reason: 7 }, 'task6c3-boundary-014'],
      ['empty reason', { ...validBody, reason: '   ' }, 'task6c3-boundary-015'],
      ['leading C0', { ...validBody, reason: '\tforbidden control' }, 'task6c3-boundary-016'],
      ['embedded DEL', { ...validBody, reason: 'forbidden\u007fcontrol' }, 'task6c3-boundary-017'],
      ['invalid scalar', { ...validBody, reason: '\ud800' }, 'task6c3-boundary-018'],
      ['long reason', { ...validBody, reason: '馃榾'.repeat(1001) }, 'task6c3-boundary-019']
    ];
    const before = db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(fixture.task.id);
    for (const [name, body, idempotencyKey] of cases) {
      const input = reassignmentInput(fixture, {
        assigneeId: target,
        idempotencyKey,
        body
      });
      const error = callError(() => createCampaignWorkflowService(db).reassignWorkflowTask(input));
      assert.equal(error.status, 400, name);
      assert.equal(error.code, 'INVALID_CAMPAIGN_INPUT', name);
    }
    for (const [name, campaignId, taskId, idempotencyKey] of [
      ['campaign leading zero', '01', fixture.task.id, 'task6c3-invalid-campaign'],
      ['campaign unsafe', '9007199254740992', fixture.task.id, 'task6c3-unsafe-campaign'],
      ['task leading zero', fixture.campaignId, '01', 'task6c3-invalid-task'],
      ['task unsafe', fixture.campaignId, '9007199254740992', 'task6c3-unsafe-task']
    ]) {
      const error = callError(() => createCampaignWorkflowService(db).reassignWorkflowTask({
        ...reassignmentInput(fixture, { assigneeId: target, idempotencyKey }),
        campaignId,
        taskId
      }));
      assert.equal(error.status, 400, name);
      assert.equal(error.code, 'INVALID_CAMPAIGN_INPUT', name);
    }
    for (const [name, idempotencyKey, code] of [
      ['missing key', undefined, 'IDEMPOTENCY_REQUIRED'],
      ['short key', 'short', 'INVALID_CAMPAIGN_INPUT'],
      ['bad character', 'task6c3 bad key', 'INVALID_CAMPAIGN_INPUT']
    ]) {
      const error = callError(() => createCampaignWorkflowService(db).reassignWorkflowTask(
        reassignmentInput(fixture, { assigneeId: target, idempotencyKey })
      ));
      assert.equal(error.status, 400, name);
      assert.equal(error.code, code, name);
    }
    assert.deepEqual(
      db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(fixture.task.id),
      before
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE scope='workflow.campaign-task.reassign'
    `).get().count, 0);
  } finally {
    db.close();
  }
});

test('successful reassignment writes exact ordered bounded evidence and zero campaign events atomically', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const fixture = initializeFixture(db, identity, 916001, 917001);
    const target = addActor(db, fixture, 918001, { teamRole: 'team_lead' });
    const beforeEvents = db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?
    `).get(fixture.campaignId).count;
    const beforeLogs = db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_node_logs WHERE instance_id=?
    `).get(fixture.instance.id).count;
    const beforeActivities = db.prepare(`
      SELECT COUNT(*) AS count FROM activity_log
      WHERE module='workflow' AND json_extract(details,'$.instance_id')=?
    `).get(fixture.instance.id).count;
    const beforeArchives = db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE business_type='campaign' AND business_id=?
        AND source_type='campaign_workflow_log'
    `).get(String(fixture.campaignId)).count;
    const reason = '  Cafe\u0301\r\nreassignment  ';
    const normalizedReason = 'Caf\u00e9\nreassignment';
    const input = reassignmentInput(fixture, {
      assigneeId: target,
      assigneeRole: 'team_lead',
      idempotencyKey: 'task6c3-exact-evidence',
      reason
    });
    const result = createCampaignWorkflowService(db).reassignWorkflowTask(input);
    assert.equal(result.status, 200);

    const logs = db.prepare(`
      SELECT id,instance_id,node_id,action,user_id,details,created_at
      FROM workflow_node_logs WHERE instance_id=? ORDER BY id
    `).all(fixture.instance.id);
    assert.equal(logs.length, beforeLogs + 1);
    const log = logs.at(-1);
    assert.equal(log.action, 'task_reassigned');
    assert.equal(log.user_id, identity.userId);
    const logDetails = JSON.parse(log.details);
    assert.deepEqual(Object.keys(logDetails), [
      'source',
      'action',
      'task_id',
      'previous_assignee_id',
      'previous_assignee_role',
      'assignee_id',
      'assignee_role',
      'previous_assignment_version',
      'assignment_version',
      'reason_sha256',
      'reason_scalars'
    ]);
    assert.deepEqual(logDetails, {
      source: 'workflow_task_reassignment',
      action: 'reassign',
      task_id: fixture.task.id,
      previous_assignee_id: null,
      previous_assignee_role: 'member',
      assignee_id: target,
      assignee_role: 'team_lead',
      previous_assignment_version: 1,
      assignment_version: 2,
      reason_sha256: crypto.createHash('sha256')
        .update(Buffer.from(normalizedReason, 'utf8')).digest('hex'),
      reason_scalars: Array.from(normalizedReason).length
    });
    assert.equal(log.details.includes(normalizedReason), false);

    const activities = db.prepare(`
      SELECT id,user_id,action,module,details,created_at
      FROM activity_log
      WHERE module='workflow' AND json_extract(details,'$.instance_id')=?
      ORDER BY id
    `).all(fixture.instance.id);
    assert.equal(activities.length, beforeActivities + 1);
    const activity = activities.at(-1);
    assert.equal(activity.action, 'workflow_task_reassignment');
    assert.equal(activity.module, 'workflow');
    const activityDetails = JSON.parse(activity.details);
    assert.deepEqual(Object.keys(activityDetails), [
      'source',
      'campaign_id',
      'dispatch_id',
      'instance_id',
      'task_id',
      'node_id',
      'action',
      'task_status',
      'instance_status',
      'previous_assignee_id',
      'previous_assignee_role',
      'assignee_id',
      'assignee_role',
      'previous_assignment_version',
      'assignment_version',
      'reason',
      'reason_sha256',
      'reason_scalars'
    ]);
    assert.deepEqual(activityDetails, {
      source: 'workflow_task_reassignment',
      campaign_id: fixture.campaignId,
      dispatch_id: fixture.dispatch.id,
      instance_id: fixture.instance.id,
      task_id: fixture.task.id,
      node_id: fixture.task.node_id,
      action: 'reassign',
      task_status: 'pending',
      instance_status: 'active',
      previous_assignee_id: null,
      previous_assignee_role: 'member',
      assignee_id: target,
      assignee_role: 'team_lead',
      previous_assignment_version: 1,
      assignment_version: 2,
      reason: normalizedReason,
      reason_sha256: logDetails.reason_sha256,
      reason_scalars: logDetails.reason_scalars
    });

    const archives = db.prepare(`
      SELECT id,entry_type,title,content,source_type,source_id,visibility,tags_json
      FROM knowledge_entries
      WHERE business_type='campaign' AND business_id=?
        AND source_type='campaign_workflow_log'
      ORDER BY id
    `).all(String(fixture.campaignId));
    assert.equal(archives.length, beforeArchives + 1);
    const archive = archives.at(-1);
    assert.equal(archive.entry_type, 'campaign_workflow');
    assert.equal(archive.title, `Campaign workflow #${fixture.instance.id}`);
    assert.equal(String(archive.source_id), String(log.id));
    assert.equal(archive.visibility, 'team');
    assert.deepEqual(JSON.parse(archive.tags_json), ['campaign', 'workflow']);
    const archiveContent = JSON.parse(archive.content);
    assert.deepEqual(Object.keys(archiveContent), [
      'dispatch_id', 'instance_id', 'node_id', 'action', 'status', 'error_code'
    ]);
    assert.deepEqual(archiveContent, {
      dispatch_id: fixture.dispatch.id,
      instance_id: fixture.instance.id,
      node_id: fixture.task.node_id,
      action: 'reassign',
      status: 'active',
      error_code: null
    });
    assert.equal(archive.content.includes('assignee'), false);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE org_id=? AND campaign_id=? AND record_type='knowledge_entry'
        AND record_id=? AND relation_type='knowledge' AND revoked_at IS NULL
    `).get(
      fixture.orgId,
      fixture.campaignId,
      String(archive.id)
    ).count, 1);

    const ledger = db.prepare(`
      SELECT scope,state,status_code,response_json,expected_event_count
      FROM request_idempotency WHERE idempotency_key=?
    `).get(input.idempotencyKey);
    assert.deepEqual({
      scope: ledger.scope,
      state: ledger.state,
      status_code: ledger.status_code,
      expected_event_count: ledger.expected_event_count,
      response: JSON.parse(ledger.response_json)
    }, {
      scope: 'workflow.campaign-task.reassign',
      state: 'completed',
      status_code: 200,
      expected_event_count: 0,
      response: result.body
    });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?
    `).get(fixture.campaignId).count, beforeEvents);
  } finally {
    db.close();
  }
});

test('ordinary authenticated template list and detail preserve exact public projections', async () => {
  const db = openWorkflowDatabase();
  let api;
  try {
    const identity = workflowIdentity(db);
    const ordinaryUserId = addActor(db, identity, 949001, {
      organizationMembership: false,
      teamMembership: false
    });
    createLegacyWorkflowTemplate(db, identity, 949101);
    const graph = terminalTaskGraph();
    db.prepare(`
      INSERT INTO workflow_templates (
        id,name,description,module,category,nodes,edges,version,is_active,
        created_by,trigger_config_json
      ) VALUES (?,?,'Campaign template','campaign','task',?,?,3,1,?,?)
    `).run(
      949102,
      'Task 6 final campaign template',
      JSON.stringify(graph.nodes),
      JSON.stringify(graph.edges),
      identity.userId,
      JSON.stringify({
        event_type: 'lifecycle_transition',
        previous_state: 'lead',
        next_state: 'qualified'
      })
    );

    const listKeys = [
      'id', 'name', 'description', 'module', 'category', 'version',
      'is_active', 'created_by', 'created_at', 'updated_at'
    ];
    const detailKeys = [
      'id', 'name', 'description', 'module', 'category', 'nodes', 'edges',
      'version', 'is_active', 'created_by', 'created_at', 'updated_at'
    ];

    api = await startWorkflowReadApi(db, ordinaryUserId);
    const list = await api.get('/api/workflow/templates');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(Object.keys(list.body), ['templates']);
    const listedCampaign = list.body.templates.find((item) => item.id === 949102);
    const listedLegacy = list.body.templates.find((item) => item.id === 949101);
    assert.ok(listedCampaign);
    assert.ok(listedLegacy);
    for (const template of list.body.templates) {
      assert.deepEqual(Object.keys(template), listKeys);
      assert.equal(Object.hasOwn(template, 'nodes'), false);
      assert.equal(Object.hasOwn(template, 'edges'), false);
      assert.equal(Object.hasOwn(template, 'trigger_config_json'), false);
    }

    const detail = await api.get('/api/workflow/templates/949102');
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(Object.keys(detail.body), ['template']);
    assert.deepEqual(Object.keys(detail.body.template), detailKeys);
    assert.deepEqual(detail.body.template.nodes, graph.nodes);
    assert.deepEqual(detail.body.template.edges, graph.edges);
    assert.equal(Object.hasOwn(detail.body.template, 'trigger_config_json'), false);
  } finally {
    if (api) await api.close();
    db.close();
  }
});

test('instance list keeps unlinked starter rules while linked rows use campaign read access', async () => {
  const db = openWorkflowDatabase();
  let api;
  try {
    const identity = workflowIdentity(db);
    const readerId = addActor(db, identity, 949201);
    const platformAdminWithoutCampaignAccess = addActor(db, identity, 949202, {
      platformRole: 'admin',
      organizationMembership: false,
      teamMembership: false
    });
    const otherTeamId = 949901;
    db.prepare('INSERT INTO teams (id,org_id,code,name) VALUES (?,?,?,?)').run(
      otherTeamId,
      identity.orgId,
      'task6-final-list-other',
      'Task 6 final list other team'
    );
    const otherTeamOwnerId = addActor(
      db,
      { ...identity, teamId: otherTeamId },
      949203
    );
    const accessible = initializeFixture(db, identity, 950001, 951001);
    const inaccessible = initializeFixture(
      db,
      { ...identity, userId: otherTeamOwnerId, teamId: otherTeamId },
      950101,
      951101
    );
    createLegacyWorkflowTemplate(db, identity, 951901);
    const ownLegacy = createLegacyTask(
      db,
      { ...identity, userId: readerId },
      951901,
      { title: 'Reader-started legacy instance' }
    );
    const otherLegacy = createLegacyTask(db, identity, 951901, {
      title: 'Other-started legacy instance'
    });
    const malformedLink = createLegacyTask(
      db,
      { ...identity, userId: readerId },
      951901,
      { title: 'Active-link malformed instance' }
    );
    attachMalformedWorkflowLink(
      db,
      accessible,
      malformedLink.instanceId,
      'instance-list-active-link'
    );
    const partialContext = createLegacyTask(
      db,
      { ...identity, userId: readerId },
      951901,
      { title: 'Partial-context malformed instance' }
    );
    withTriggersDisabled(db, ['workflow_instances_campaign_context_immutable'], () => {
      db.prepare('UPDATE workflow_instances SET org_id=? WHERE id=?')
        .run(identity.orgId, partialContext.instanceId);
      const updateCreatedAt = db.prepare(
        'UPDATE workflow_instances SET created_at=? WHERE id=?'
      );
      updateCreatedAt.run('2030-01-06 00:00:00', accessible.instance.id);
      updateCreatedAt.run('2030-01-05 00:00:00', inaccessible.instance.id);
      updateCreatedAt.run('2030-01-04 00:00:00', malformedLink.instanceId);
      updateCreatedAt.run('2030-01-03 00:00:00', partialContext.instanceId);
      updateCreatedAt.run('2030-01-02 00:00:00', otherLegacy.instanceId);
      updateCreatedAt.run('2030-01-01 00:00:00', ownLegacy.instanceId);
    });

    api = await startWorkflowReadApi(db, readerId);
    const readerList = await api.get('/api/workflow/instances');
    assert.equal(readerList.status, 200, JSON.stringify(readerList.body));
    assert.deepEqual(Object.keys(readerList.body), ['instances']);
    assert.deepEqual(readerList.body.instances.map((instance) => instance.id), [
      accessible.instance.id,
      ownLegacy.instanceId
    ]);
    readerList.body.instances.forEach((instance) => {
      assert.deepEqual(Object.keys(instance), INSTANCE_COLLECTION_KEYS);
    });
    const filtered = await api.get(
      '/api/workflow/instances?status=active&business_type=campaign' +
        `&business_id=${accessible.campaignId}&template_id=${accessible.templateId}`
    );
    assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
    assert.deepEqual(filtered.body.instances.map((instance) => instance.id), [
      accessible.instance.id
    ]);
    assert.deepEqual(Object.keys(filtered.body.instances[0]), INSTANCE_COLLECTION_KEYS);
    await api.close();
    api = null;

    api = await startWorkflowReadApi(db, platformAdminWithoutCampaignAccess);
    const adminList = await api.get('/api/workflow/instances');
    assert.equal(adminList.status, 200, JSON.stringify(adminList.body));
    assert.deepEqual(adminList.body.instances.map((instance) => instance.id), [
      otherLegacy.instanceId,
      ownLegacy.instanceId
    ]);
    adminList.body.instances.forEach((instance) => {
      assert.deepEqual(Object.keys(instance), INSTANCE_COLLECTION_KEYS);
    });
  } finally {
    if (api) await api.close();
    db.close();
  }
});

test('instance list applies visibility and filters before ordering and the 200-row limit in one query', async () => {
  const executedSql = [];
  const db = openWorkflowDatabase({ verbose: (sql) => executedSql.push(sql) });
  let api;
  try {
    const identity = workflowIdentity(db);
    const readerId = addActor(db, identity, 949301);
    const linked = initializeFixture(db, identity, 952001, 953001);
    createLegacyWorkflowTemplate(db, identity, 953901);
    const visible = [];
    const malformed = [];
    for (let index = 0; index < 205; index += 1) {
      visible.push(createLegacyTask(
        db,
        { ...identity, userId: readerId },
        953901,
        { title: `Visible bounded instance ${index}` }
      ));
      const malformedInstance = createLegacyTask(
        db,
        { ...identity, userId: readerId },
        953901,
        { title: `Malformed bounded instance ${index}` }
      );
      attachMalformedWorkflowLink(
        db,
        linked,
        malformedInstance.instanceId,
        `instance-list-bounded-${index}`
      );
      malformed.push(malformedInstance);
    }
    withTriggersDisabled(db, ['workflow_instances_campaign_context_immutable'], () => {
      db.prepare('UPDATE workflow_instances SET created_at=? WHERE id=?')
        .run('2035-01-01 00:00:00', linked.instance.id);
      const updateCreatedAt = db.prepare(`
        UPDATE workflow_instances SET created_at=datetime(?,?) WHERE id=?
      `);
      visible.forEach((item, index) => {
        updateCreatedAt.run('2030-01-01', `+${index} seconds`, item.instanceId);
      });
      malformed.forEach((item, index) => {
        updateCreatedAt.run('2040-01-01', `+${index} seconds`, item.instanceId);
      });
    });

    api = await startWorkflowReadApi(db, readerId);
    executedSql.length = 0;
    const response = await api.get('/api/workflow/instances?status=active');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const selects = executedSql.filter((sql) => /^\s*SELECT\b/i.test(sql));
    assert.equal(
      selects.length,
      2,
      `expected auth plus one bounded instance SELECT; got ${selects.length}`
    );
    const expectedIds = [
      linked.instance.id,
      ...visible.map((item) => item.instanceId).reverse().slice(0, 199)
    ];
    assert.equal(response.body.instances.length, 200);
    assert.deepEqual(
      response.body.instances.map((instance) => instance.id),
      expectedIds
    );
    response.body.instances.forEach((instance) => {
      assert.deepEqual(Object.keys(instance), INSTANCE_COLLECTION_KEYS);
    });

    executedSql.length = 0;
    const fullyFiltered = await api.get(
      '/api/workflow/instances?status=active&business_type=campaign' +
        `&business_id=${linked.campaignId}&template_id=${linked.templateId}`
    );
    assert.equal(fullyFiltered.status, 200, JSON.stringify(fullyFiltered.body));
    assert.deepEqual(fullyFiltered.body.instances.map((instance) => instance.id), [
      linked.instance.id
    ]);
    assert.equal(
      executedSql.filter((sql) => /^\s*SELECT\b/i.test(sql)).length,
      2
    );
  } finally {
    if (api) await api.close();
    db.close();
  }
});

test('instance by-business keeps global unlinked reads and filters malformed or inaccessible linked rows', async () => {
  const db = openWorkflowDatabase();
  let api;
  try {
    const identity = workflowIdentity(db);
    const readerId = addActor(db, identity, 954001);
    const otherTeamId = 954901;
    db.prepare('INSERT INTO teams (id,org_id,code,name) VALUES (?,?,?,?)').run(
      otherTeamId,
      identity.orgId,
      'task6-final-business-other',
      'Task 6 final by-business other team'
    );
    const otherTeamOwnerId = addActor(
      db,
      { ...identity, teamId: otherTeamId },
      954002
    );
    const accessible = initializeFixture(db, identity, 955001, 956001);
    const inaccessible = initializeFixture(
      db,
      { ...identity, userId: otherTeamOwnerId, teamId: otherTeamId },
      955101,
      956101
    );
    createLegacyWorkflowTemplate(db, identity, 956901);
    const bulkInsert = db.prepare(`
      WITH RECURSIVE fixture(value) AS (
        SELECT 1
        UNION ALL SELECT value+1 FROM fixture WHERE value<201
      )
      INSERT INTO workflow_instances (
        template_id,business_type,business_id,current_node_id,status,node_data,
        started_by,created_at
      )
      SELECT
        ?,'customer',957001,'legacy-node','active','{}',
        CASE WHEN value % 2=0 THEN ? ELSE ? END,
        datetime('2030-01-01','+' || value || ' seconds')
      FROM fixture
    `).run(956901, readerId, identity.userId);
    assert.equal(bulkInsert.changes, 201);
    const malformed = createLegacyTask(db, identity, 956901, {
      title: 'Malformed matching campaign projection'
    });
    attachMalformedWorkflowLink(
      db,
      accessible,
      malformed.instanceId,
      'by-business-malformed'
    );
    withTriggersDisabled(db, ['workflow_instances_campaign_context_immutable'], () => {
      db.prepare(`
        UPDATE workflow_instances
        SET business_type='campaign',business_id=?,created_at=?
        WHERE id=?
      `).run(accessible.campaignId, '2050-01-01 00:00:00', malformed.instanceId);
      db.prepare('UPDATE workflow_instances SET created_at=? WHERE id=?')
        .run('2040-01-01 00:00:00', accessible.instance.id);
    });

    api = await startWorkflowReadApi(db, readerId);
    assert.deepEqual(await api.get('/api/workflow/instances/by-business'), {
      status: 400,
      body: { error: 'business_type and business_id query params are required' }
    });
    const unlinked = await api.get(
      '/api/workflow/instances/by-business?business_type=customer&business_id=957001'
    );
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
    assert.deepEqual(Object.keys(unlinked.body), ['instances']);
    assert.equal(unlinked.body.instances.length, 201);
    unlinked.body.instances.forEach((instance) => {
      assert.deepEqual(Object.keys(instance), INSTANCE_COLLECTION_KEYS);
    });
    assert.ok(unlinked.body.instances.some((instance) => instance.started_by === readerId));
    assert.ok(unlinked.body.instances.some((instance) => instance.started_by === identity.userId));

    const linked = await api.get(
      '/api/workflow/instances/by-business?business_type=campaign' +
        `&business_id=${accessible.campaignId}`
    );
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.deepEqual(linked.body.instances.map((instance) => instance.id), [
      accessible.instance.id
    ]);
    assert.deepEqual(Object.keys(linked.body.instances[0]), INSTANCE_COLLECTION_KEYS);

    const denied = await api.get(
      '/api/workflow/instances/by-business?business_type=campaign' +
        `&business_id=${inaccessible.campaignId}`
    );
    assert.deepEqual(denied, { status: 200, body: { instances: [] } });
  } finally {
    if (api) await api.close();
    db.close();
  }
});

test('workflow stats keep global templates and aggregate only unlinked plus readable linked rows', async () => {
  const executedSql = [];
  const db = openWorkflowDatabase({ verbose: (sql) => executedSql.push(sql) });
  let api;
  try {
    const identity = workflowIdentity(db);
    const readerId = addActor(db, identity, 958001);
    const otherTeamId = 958901;
    db.prepare('INSERT INTO teams (id,org_id,code,name) VALUES (?,?,?,?)').run(
      otherTeamId,
      identity.orgId,
      'task6-final-stats-other',
      'Task 6 final stats other team'
    );
    const otherTeamOwnerId = addActor(
      db,
      { ...identity, teamId: otherTeamId },
      958002
    );
    const accessible = initializeFixture(db, identity, 959001, 960001);
    const inaccessible = initializeFixture(
      db,
      { ...identity, userId: otherTeamOwnerId, teamId: otherTeamId },
      959101,
      960101
    );
    const danglingTemplateLinked = initializeFixture(
      db,
      identity,
      959201,
      960201
    );
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.pragma('foreign_keys = OFF');
    try {
      assert.equal(
        db.prepare('DELETE FROM workflow_templates WHERE id=?')
          .run(danglingTemplateLinked.templateId).changes,
        1
      );
    } finally {
      db.pragma('foreign_keys = ON');
    }
    createLegacyWorkflowTemplate(db, identity, 960901);
    const activeLegacy = createLegacyTask(db, identity, 960901, {
      title: 'Stats active unlinked'
    });
    const completedLegacy = createLegacyTask(db, identity, 960901, {
      title: 'Stats completed unlinked',
      status: 'completed'
    });
    createLegacyWorkflowTemplate(db, identity, 960902);
    const danglingTemplateLegacy = createLegacyTask(db, identity, 960902, {
      title: 'Stats dangling-template unlinked'
    });
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.pragma('foreign_keys = OFF');
    try {
      assert.equal(
        db.prepare('DELETE FROM workflow_templates WHERE id=?').run(960902).changes,
        1
      );
    } finally {
      db.pragma('foreign_keys = ON');
    }
    db.prepare("UPDATE workflow_instances SET status='completed' WHERE id=?")
      .run(completedLegacy.instanceId);
    const malformed = [];
    for (let index = 0; index < 12; index += 1) {
      const item = createLegacyTask(db, identity, 960901, {
        title: `Stats malformed linked ${index}`
      });
      attachMalformedWorkflowLink(
        db,
        accessible,
        item.instanceId,
        `stats-malformed-${index}`
      );
      malformed.push(item);
    }
    const partial = createLegacyTask(db, identity, 960901, {
      title: 'Stats partial campaign context'
    });
    withTriggersDisabled(db, ['workflow_instances_campaign_context_immutable'], () => {
      db.prepare('UPDATE workflow_instances SET org_id=? WHERE id=?')
        .run(identity.orgId, partial.instanceId);
      const updateCreatedAt = db.prepare(
        'UPDATE workflow_instances SET created_at=? WHERE id=?'
      );
      updateCreatedAt.run('2030-01-03 00:00:00', accessible.instance.id);
      updateCreatedAt.run('2050-01-01 00:00:00', inaccessible.instance.id);
      updateCreatedAt.run('2080-01-01 00:00:00', danglingTemplateLinked.instance.id);
      updateCreatedAt.run('2070-01-01 00:00:00', danglingTemplateLegacy.instanceId);
      updateCreatedAt.run('2030-01-02 00:00:00', activeLegacy.instanceId);
      updateCreatedAt.run('2030-01-01 00:00:00', completedLegacy.instanceId);
      updateCreatedAt.run('2060-01-01 00:00:00', partial.instanceId);
      malformed.forEach((item, index) => {
        updateCreatedAt.run(
          `2040-01-${String(index + 1).padStart(2, '0')} 00:00:00`,
          item.instanceId
        );
      });
    });

    api = await startWorkflowReadApi(db, readerId);
    executedSql.length = 0;
    const response = await api.get('/api/workflow/stats');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(Object.keys(response.body), ['stats']);
    assert.deepEqual(Object.keys(response.body.stats), [
      'totalTemplates', 'activeTemplates', 'totalInstances',
      'instancesByStatus', 'tasksByStatus', 'pendingTasks',
      'instancesByType', 'recentInstances'
    ]);
    assert.equal(response.body.stats.totalTemplates, 3);
    assert.equal(response.body.stats.activeTemplates, 1);
    assert.equal(response.body.stats.totalInstances, 4);
    response.body.stats.instancesByStatus.forEach((row) => {
      assert.deepEqual(Object.keys(row), ['status', 'count']);
    });
    response.body.stats.tasksByStatus.forEach((row) => {
      assert.deepEqual(Object.keys(row), ['status', 'count']);
    });
    response.body.stats.instancesByType.forEach((row) => {
      assert.deepEqual(Object.keys(row), ['business_type', 'count']);
    });
    assert.deepEqual(
      response.body.stats.instancesByStatus
        .map((row) => [row.status, row.count])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [['active', 3], ['completed', 1]]
    );
    assert.deepEqual(
      response.body.stats.tasksByStatus
        .map((row) => [row.status, row.count])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [['completed', 1], ['pending', 3]]
    );
    assert.equal(response.body.stats.pendingTasks, 3);
    assert.deepEqual(
      response.body.stats.instancesByType
        .map((row) => [row.business_type, row.count])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [['campaign', 1], ['customer', 3]]
    );
    assert.deepEqual(
      response.body.stats.recentInstances.map((instance) => instance.id),
      [accessible.instance.id, activeLegacy.instanceId, completedLegacy.instanceId]
    );
    response.body.stats.recentInstances.forEach((instance) => {
      assert.deepEqual(Object.keys(instance), [
        'id', 'business_type', 'business_id', 'status', 'template_name',
        'created_at'
      ]);
    });
    const statements = executedSql.filter((sql) => /^\s*(?:SELECT|WITH)\b/i.test(sql));
    assert.equal(
      statements.length,
      9,
      `expected auth plus eight fixed stats queries; got ${statements.length}`
    );
  } finally {
    if (api) await api.close();
    db.close();
  }
});

test('task list filters mixed linked access before status order and limit with exact conditional keys', async () => {
  const db = openWorkflowDatabase();
  let api;
  try {
    const identity = workflowIdentity(db);
    const readerId = addActor(db, identity, 919001);
    const otherAssignee = addActor(db, identity, 919002);
    const active = initializeFixture(db, identity, 920001, 921001, {
      taskConfig: { assignee_id: otherAssignee, assignee_role: 'member' }
    });
    const onHold = initializeFixture(db, identity, 920101, 921101, {
      taskConfig: { assignee_id: otherAssignee, assignee_role: 'member' }
    });
    db.prepare(`UPDATE campaigns SET operational_status='on_hold' WHERE id=?`)
      .run(onHold.campaignId);
    const cancelled = initializeFixture(db, identity, 920201, 921201, {
      taskConfig: { assignee_id: otherAssignee, assignee_role: 'member' }
    });
    db.prepare(`UPDATE campaigns SET operational_status='cancelled' WHERE id=?`)
      .run(cancelled.campaignId);

    createLegacyWorkflowTemplate(db, identity, 921901);
    const assignedLegacy = createLegacyTask(db, identity, 921901, {
      title: 'Assigned legacy',
      assigneeId: readerId
    });
    const unassignedLegacy = createLegacyTask(db, identity, 921901, {
      title: 'Unassigned legacy',
      assigneeId: null
    });
    createLegacyTask(db, identity, 921901, {
      title: 'Other legacy',
      assigneeId: otherAssignee
    });
    createLegacyTask(db, identity, 921901, {
      title: 'Completed legacy',
      assigneeId: readerId,
      status: 'completed'
    });
    for (let index = 0; index < 205; index += 1) {
      const malformed = createLegacyTask(db, identity, 921901, {
        title: `Malformed linked ${index}`,
        assigneeId: null
      });
      attachMalformedWorkflowLink(db, active, malformed.instanceId, index);
    }

    api = await startWorkflowReadApi(db, readerId);
    const response = await api.get('/api/workflow/tasks?status=pending');
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body), ['tasks']);
    const ids = response.body.tasks.map((task) => task.id).sort((left, right) => left - right);
    assert.deepEqual(ids, [
      active.task.id,
      onHold.task.id,
      cancelled.task.id,
      assignedLegacy.taskId,
      unassignedLegacy.taskId
    ].sort((left, right) => left - right));
    const linkedKeys = [
      'id', 'instance_id', 'node_id', 'node_type', 'title', 'description',
      'assignee_id', 'assignee_role', 'status', 'comment', 'due_at',
      'completed_at', 'completed_by', 'created_at', 'business_type',
      'business_id', 'template_id', 'template_name', 'assignment_version'
    ];
    const unlinkedKeys = linkedKeys.slice(0, -1);
    for (const task of response.body.tasks) {
      if ([active.task.id, onHold.task.id, cancelled.task.id].includes(task.id)) {
        assert.deepEqual(Object.keys(task), linkedKeys);
        assert.equal(task.assignment_version, 1);
      } else {
        assert.deepEqual(Object.keys(task), unlinkedKeys);
        assert.equal(Object.hasOwn(task, 'assignment_version'), false);
      }
    }
    assert.equal(response.body.tasks.some((task) => task.title.startsWith('Malformed')), false);
  } finally {
    if (api) await api.close();
    db.close();
  }
});

test('task list applies access and status in one bounded query with SQLite null ordering', async () => {
  const executedSql = [];
  const db = openWorkflowDatabase({ verbose: (sql) => executedSql.push(sql) });
  let api;
  try {
    const identity = workflowIdentity(db);
    const readerId = addActor(db, identity, 921951);
    const otherAssignee = addActor(db, identity, 921952);
    const linked = initializeFixture(db, identity, 921953, 921954, {
      taskConfig: { assignee_id: otherAssignee, assignee_role: 'member' }
    });
    createLegacyWorkflowTemplate(db, identity, 921955);
    const assignedLegacy = createLegacyTask(db, identity, 921955, {
      title: 'Bounded assigned legacy',
      assigneeId: readerId
    });
    const nullCreatedLegacy = createLegacyTask(db, identity, 921955, {
      title: 'Bounded null-created legacy',
      assigneeId: null
    });
    createLegacyTask(db, identity, 921955, {
      title: 'Bounded hidden assignee',
      assigneeId: otherAssignee
    });
    db.prepare('UPDATE workflow_tasks SET created_at=? WHERE id=?')
      .run('2030-01-03 00:00:00', linked.task.id);
    db.prepare('UPDATE workflow_tasks SET created_at=? WHERE id=?')
      .run('2030-01-02 00:00:00', assignedLegacy.taskId);
    db.prepare('UPDATE workflow_tasks SET created_at=NULL WHERE id=?')
      .run(nullCreatedLegacy.taskId);

    for (let index = 0; index < 205; index += 1) {
      const malformed = createLegacyTask(db, identity, 921955, {
        title: `Bounded malformed newer ${index}`,
        assigneeId: null
      });
      db.prepare('UPDATE workflow_tasks SET created_at=? WHERE id=?')
        .run(`2040-01-${String((index % 28) + 1).padStart(2, '0')} 00:00:00`, malformed.taskId);
      attachMalformedWorkflowLink(db, linked, malformed.instanceId, `bounded-${index}`);
    }
    for (let index = 0; index < 205; index += 1) {
      const completed = createLegacyTask(db, identity, 921955, {
        title: `Bounded completed newer ${index}`,
        assigneeId: readerId,
        status: 'completed'
      });
      db.prepare('UPDATE workflow_tasks SET created_at=? WHERE id=?')
        .run(`2050-01-${String((index % 28) + 1).padStart(2, '0')} 00:00:00`, completed.taskId);
    }

    api = await startWorkflowReadApi(db, readerId);
    executedSql.length = 0;
    const response = await api.get('/api/workflow/tasks?status=pending');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const selects = executedSql.filter((sql) => /^\s*SELECT\b/i.test(sql));
    assert.equal(selects.length, 2, `expected auth plus one bounded task SELECT; got ${selects.length}`);
    assert.deepEqual(response.body.tasks.map((task) => task.id), [
      linked.task.id,
      assignedLegacy.taskId,
      nullCreatedLegacy.taskId
    ]);
    assert.deepEqual(Object.keys(response.body.tasks[0]), [
      'id', 'instance_id', 'node_id', 'node_type', 'title', 'description',
      'assignee_id', 'assignee_role', 'status', 'comment', 'due_at',
      'completed_at', 'completed_by', 'created_at', 'business_type',
      'business_id', 'template_id', 'template_name', 'assignment_version'
    ]);
    assert.deepEqual(Object.keys(response.body.tasks[1]), [
      'id', 'instance_id', 'node_id', 'node_type', 'title', 'description',
      'assignee_id', 'assignee_role', 'status', 'comment', 'due_at',
      'completed_at', 'completed_by', 'created_at', 'business_type',
      'business_id', 'template_id', 'template_name'
    ]);
    assert.deepEqual(Object.keys(response.body.tasks[2]), Object.keys(response.body.tasks[1]));
    assert.equal(response.body.tasks[0].assignment_version, 1);
    assert.equal(Object.hasOwn(response.body.tasks[1], 'assignment_version'), false);
    assert.equal(Object.hasOwn(response.body.tasks[2], 'assignment_version'), false);
  } finally {
    if (api) await api.close();
    db.close();
  }
});

test('task detail preserves legacy shape and uses campaign read access for valid linked context', async () => {
  const db = openWorkflowDatabase();
  let api;
  try {
    const identity = workflowIdentity(db);
    const readerId = addActor(db, identity, 922001);
    const otherAssignee = addActor(db, identity, 922002);
    const forbiddenReader = addActor(db, identity, 922003, {
      teamMembership: false
    });
    db.prepare(`
      INSERT INTO teams (id,org_id,code,name) VALUES (?,?,?,?)
    `).run(922903, identity.orgId, 'task6c3-other-team', 'Task 6C-3 other team');
    db.prepare(`
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
      VALUES (?,?,?,'member','active')
    `).run(identity.orgId, 922903, forbiddenReader);
    const concealedReader = addActor(db, identity, 922004, {
      organizationMembership: false,
      teamMembership: false
    });
    const linked = initializeFixture(db, identity, 923001, 924001, {
      taskConfig: { assignee_id: otherAssignee, assignee_role: 'member' }
    });
    createLegacyWorkflowTemplate(db, identity, 924901);
    const legacy = createLegacyTask(db, identity, 924901, {
      title: 'Legacy task detail',
      assigneeId: readerId,
      businessId: linked.customerId
    });
    const deniedLegacy = createLegacyTask(db, identity, 924901, {
      title: 'Denied legacy task detail',
      assigneeId: otherAssignee,
      businessId: linked.customerId
    });
    const malformed = createLegacyTask(db, identity, 924901, {
      title: 'Malformed task detail',
      assigneeId: readerId
    });
    attachMalformedWorkflowLink(db, linked, malformed.instanceId, 'task-detail');

    const linkedKeys = [
      'id', 'instance_id', 'node_id', 'node_type', 'title', 'description',
      'assignee_id', 'assignee_role', 'status', 'comment', 'due_at',
      'completed_at', 'completed_by', 'created_at', 'business_type',
      'business_id', 'template_id', 'node_data', 'template_name',
      'assignment_version'
    ];
    const unlinkedKeys = linkedKeys.slice(0, -1);
    const logKeys = [
      'id', 'instance_id', 'node_id', 'action', 'user_id', 'details', 'created_at'
    ];

    api = await startWorkflowReadApi(db, readerId);
    for (const operationalStatus of ['active', 'on_hold', 'cancelled']) {
      db.prepare('UPDATE campaigns SET operational_status=? WHERE id=?')
        .run(operationalStatus, linked.campaignId);
      const response = await api.get(`/api/workflow/tasks/${linked.task.id}`);
      assert.equal(response.status, 200, operationalStatus);
      assert.deepEqual(Object.keys(response.body), [
        'task', 'business', 'business_data', 'logs'
      ]);
      assert.deepEqual(Object.keys(response.body.task), linkedKeys);
      assert.equal(response.body.task.assignment_version, 1);
      assert.equal(response.body.business, null);
      assert.equal(typeof response.body.business_data, 'object');
      response.body.logs.forEach((log) => assert.deepEqual(Object.keys(log), logKeys));
    }
    const legacyResponse = await api.get(`/api/workflow/tasks/${legacy.taskId}`);
    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(Object.keys(legacyResponse.body.task), unlinkedKeys);
    assert.equal(Object.hasOwn(legacyResponse.body.task, 'assignment_version'), false);
    const deniedLegacyResponse = await api.get(`/api/workflow/tasks/${deniedLegacy.taskId}`);
    assert.deepEqual(deniedLegacyResponse, {
      status: 403,
      body: { error: 'Access denied' }
    });
    const malformedResponse = await api.get(`/api/workflow/tasks/${malformed.taskId}`);
    assert.deepEqual(malformedResponse, {
      status: 404,
      body: { error: 'Task not found' }
    });
    await api.close();
    api = null;

    api = await startWorkflowReadApi(db, forbiddenReader);
    assert.deepEqual(await api.get(`/api/workflow/tasks/${linked.task.id}`), {
      status: 403,
      body: { error: 'Access denied' }
    });
    await api.close();
    api = null;

    api = await startWorkflowReadApi(db, concealedReader);
    assert.deepEqual(await api.get(`/api/workflow/tasks/${linked.task.id}`), {
      status: 404,
      body: { error: 'Task not found' }
    });
    await api.close();
    api = null;

    api = await startWorkflowReadApi(db, identity.userId);
    const adminLegacy = await api.get(`/api/workflow/tasks/${deniedLegacy.taskId}`);
    assert.equal(adminLegacy.status, 200);
    assert.deepEqual(Object.keys(adminLegacy.body.task), unlinkedKeys);
  } finally {
    if (api) await api.close();
    db.close();
  }
});

test('instance detail exposes exact legacy projections and lets linked parent campaign access govern all children', async () => {
  const db = openWorkflowDatabase();
  let api;
  try {
    const identity = workflowIdentity(db);
    const readerId = addActor(db, identity, 925001);
    const otherAssignee = addActor(db, identity, 925002);
    const forbiddenReader = addActor(db, identity, 925003, {
      teamMembership: false
    });
    db.prepare(`
      INSERT INTO teams (id,org_id,code,name) VALUES (?,?,?,?)
    `).run(925903, identity.orgId, 'task6c3-instance-other', 'Task 6C-3 instance other');
    db.prepare(`
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
      VALUES (?,?,?,'member','active')
    `).run(identity.orgId, 925903, forbiddenReader);
    const concealedReader = addActor(db, identity, 925004, {
      organizationMembership: false,
      teamMembership: false
    });
    const linked = initializeFixture(db, identity, 926001, 927001, {
      taskConfig: { assignee_id: otherAssignee, assignee_role: 'member' }
    });
    createLegacyWorkflowTemplate(db, identity, 927901);
    const legacy = createLegacyTask(db, { ...identity, userId: readerId }, 927901, {
      title: 'Legacy instance detail',
      assigneeId: otherAssignee
    });
    const deniedLegacy = createLegacyTask(db, identity, 927901, {
      title: 'Denied legacy instance detail',
      assigneeId: readerId
    });
    const malformed = createLegacyTask(db, { ...identity, userId: readerId }, 927901, {
      title: 'Malformed instance detail',
      assigneeId: readerId
    });
    attachMalformedWorkflowLink(db, linked, malformed.instanceId, 'instance-detail');

    const instanceKeys = [
      'id', 'template_id', 'business_type', 'business_id', 'current_node_id',
      'status', 'node_data', 'started_by', 'completed_at', 'created_at'
    ];
    const taskKeys = [
      'id', 'instance_id', 'node_id', 'node_type', 'title', 'description',
      'assignee_id', 'assignee_role', 'status', 'comment', 'due_at',
      'completed_at', 'completed_by', 'created_at'
    ];
    const linkedTaskKeys = [...taskKeys, 'assignment_version'];
    const logKeys = [
      'id', 'instance_id', 'node_id', 'action', 'user_id', 'details', 'created_at'
    ];
    const topLevelKeys = [
      'instance', 'nodes', 'edges', 'tasks', 'logs', 'node_statuses'
    ];

    api = await startWorkflowReadApi(db, readerId);
    for (const operationalStatus of ['active', 'on_hold', 'cancelled']) {
      db.prepare('UPDATE campaigns SET operational_status=? WHERE id=?')
        .run(operationalStatus, linked.campaignId);
      const response = await api.get(`/api/workflow/instances/${linked.instance.id}`);
      assert.equal(response.status, 200, operationalStatus);
      assert.deepEqual(Object.keys(response.body), topLevelKeys);
      assert.deepEqual(Object.keys(response.body.instance), instanceKeys);
      response.body.tasks.forEach((task) => {
        assert.deepEqual(Object.keys(task), linkedTaskKeys);
        assert.equal(task.assignment_version, 1);
      });
      response.body.logs.forEach((log) => assert.deepEqual(Object.keys(log), logKeys));
      assert.equal(Object.hasOwn(response.body.instance, 'org_id'), false);
      assert.equal(Object.hasOwn(response.body.instance, 'campaign_id'), false);
      assert.equal(Object.hasOwn(response.body.instance, 'campaign_dispatch_id'), false);
      assert.equal(Object.hasOwn(response.body.instance, 'initialization_status'), false);
    }
    const legacyResponse = await api.get(`/api/workflow/instances/${legacy.instanceId}`);
    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(Object.keys(legacyResponse.body), topLevelKeys);
    assert.deepEqual(Object.keys(legacyResponse.body.instance), instanceKeys);
    legacyResponse.body.tasks.forEach((task) => {
      assert.deepEqual(Object.keys(task), taskKeys);
      assert.equal(Object.hasOwn(task, 'assignment_version'), false);
    });
    assert.deepEqual(await api.get(`/api/workflow/instances/${deniedLegacy.instanceId}`), {
      status: 403,
      body: { error: 'Access denied' }
    });
    assert.deepEqual(await api.get(`/api/workflow/instances/${malformed.instanceId}`), {
      status: 404,
      body: { error: 'Instance not found' }
    });
    await api.close();
    api = null;

    api = await startWorkflowReadApi(db, forbiddenReader);
    assert.deepEqual(await api.get(`/api/workflow/instances/${linked.instance.id}`), {
      status: 403,
      body: { error: 'Access denied' }
    });
    await api.close();
    api = null;

    api = await startWorkflowReadApi(db, concealedReader);
    assert.deepEqual(await api.get(`/api/workflow/instances/${linked.instance.id}`), {
      status: 404,
      body: { error: 'Instance not found' }
    });
    await api.close();
    api = null;

    api = await startWorkflowReadApi(db, identity.userId);
    const adminLegacy = await api.get(`/api/workflow/instances/${deniedLegacy.instanceId}`);
    assert.equal(adminLegacy.status, 200);
    assert.deepEqual(Object.keys(adminLegacy.body.instance), instanceKeys);
  } finally {
    if (api) await api.close();
    db.close();
  }
});

test('target eligibility covers every role and retains stale when the target is lost after reservation', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const roleCases = [
      {
        role: 'platform_admin',
        campaignId: 928001,
        templateId: 929001,
        targetId: 930001,
        actor: { platformRole: 'admin' }
      },
      {
        role: 'org_admin',
        campaignId: 928101,
        templateId: 929101,
        targetId: 930101,
        actor: { organizationRole: 'org_admin', teamMembership: false }
      },
      {
        role: 'team_lead',
        campaignId: 928201,
        templateId: 929201,
        targetId: 930201,
        actor: { teamRole: 'team_lead' }
      },
      {
        role: 'member',
        campaignId: 928301,
        templateId: 929301,
        targetId: 930301,
        actor: { teamRole: 'member' }
      }
    ];
    for (const item of roleCases) {
      const target = addActor(db, identity, item.targetId, item.actor);
      const fixture = initializeFixture(db, identity, item.campaignId, item.templateId);
      const result = createCampaignWorkflowService(db).reassignWorkflowTask(
        reassignmentInput(fixture, {
          assigneeId: target,
          assigneeRole: item.role,
          idempotencyKey: `task6c3-role-${item.role}`
        })
      );
      assert.equal(result.status, 200, item.role);
      assert.deepEqual(result.body.assignment, {
        assignee_id: target,
        assignee_role: item.role,
        assignment_version: 2
      });
    }

    const idOnlyTarget = addActor(db, identity, 930401);
    const idOnly = initializeFixture(db, identity, 928401, 929401);
    const idOnlyResult = createCampaignWorkflowService(db).reassignWorkflowTask(
      reassignmentInput(idOnly, {
        assigneeId: idOnlyTarget,
        assigneeRole: null,
        idempotencyKey: 'task6c3-target-id-only'
      })
    );
    assert.deepEqual(idOnlyResult.body.assignment, {
      assignee_id: idOnlyTarget,
      assignee_role: null,
      assignment_version: 2
    });

    addActor(db, identity, 930501, { teamRole: 'team_lead' });
    const roleOnly = initializeFixture(db, identity, 928501, 929501);
    const roleOnlyResult = createCampaignWorkflowService(db).reassignWorkflowTask(
      reassignmentInput(roleOnly, {
        assigneeId: null,
        assigneeRole: 'team_lead',
        idempotencyKey: 'task6c3-target-role-only'
      })
    );
    assert.deepEqual(roleOnlyResult.body.assignment, {
      assignee_id: null,
      assignee_role: 'team_lead',
      assignment_version: 2
    });

    const errors = initializeFixture(db, identity, 928601, 929601);
    const inactiveTarget = addActor(db, identity, 930601, { active: false });
    const visibleIneligible = addActor(db, identity, 930602, {
      teamMembership: false
    });
    const memberTarget = addActor(db, identity, 930603);
    for (const [name, assigneeId, assigneeRole, status, code] of [
      ['missing target', 930699, 'member', 404, 'RECORD_NOT_FOUND'],
      ['inactive target', inactiveTarget, 'member', 404, 'RECORD_NOT_FOUND'],
      ['visible ineligible', visibleIneligible, null, 403, 'RECORD_FORBIDDEN'],
      ['id role intersection', memberTarget, 'team_lead', 403, 'RECORD_FORBIDDEN']
    ]) {
      const error = callError(() => createCampaignWorkflowService(db).reassignWorkflowTask(
        reassignmentInput(errors, {
          assigneeId,
          assigneeRole,
          idempotencyKey: `task6c3-target-${name.replace(/ /g, '-')}`
        })
      ));
      assert.equal(error.status, status, name);
      assert.equal(error.code, code, name);
      assert.equal(
        error.message,
        status === 404 ? 'Record was not found.' : 'Record access is forbidden.',
        name
      );
    }

    const emptyRole = initializeFixture(db, identity, 928701, 929701);
    db.prepare(`
      UPDATE team_memberships SET role_code='member'
      WHERE org_id=? AND team_id=? AND role_code='team_lead'
    `).run(identity.orgId, identity.teamId);
    const emptyRoleError = callError(() => createCampaignWorkflowService(db).reassignWorkflowTask(
      reassignmentInput(emptyRole, {
        assigneeId: null,
        assigneeRole: 'team_lead',
        idempotencyKey: 'task6c3-target-empty-role'
      })
    ));
    assert.equal(emptyRoleError.status, 403);
    assert.equal(emptyRoleError.code, 'RECORD_FORBIDDEN');

    const raceTarget = addActor(db, identity, 930801);
    const race = initializeFixture(db, identity, 928801, 929801);
    const raceBefore = db.prepare('SELECT * FROM workflow_tasks WHERE id=?')
      .get(race.task.id);
    const raceInput = reassignmentInput(race, {
      assigneeId: raceTarget,
      assigneeRole: 'member',
      idempotencyKey: 'task6c3-target-post-reservation-loss'
    });
    const raceResult = createCampaignWorkflowService(db, {
      transactionBoundaryProbe(stage) {
        if (stage !== 'reassignment.after_reservation') return;
        db.prepare(`
          UPDATE team_memberships SET status='revoked',revoked_at=CURRENT_TIMESTAMP
          WHERE org_id=? AND team_id=? AND user_id=?
        `).run(identity.orgId, identity.teamId, raceTarget);
      }
    }).reassignWorkflowTask(raceInput);
    assert.deepEqual(raceResult, {
      status: 409,
      body: {
        error: 'Workflow task action is stale.',
        code: 'STALE_WORKFLOW_TASK_ACTION',
        request_id: raceInput.requestId,
        details: {
          task_status: 'pending',
          instance_status: 'active',
          campaign_operational_status: 'active'
        }
      },
      headers: {}
    });
    assert.deepEqual(
      db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(race.task.id),
      raceBefore
    );
    const raceLedger = db.prepare(`
      SELECT state,status_code,response_json FROM request_idempotency
      WHERE idempotency_key=?
    `).get(raceInput.idempotencyKey);
    assert.equal(raceLedger.state, 'completed');
    assert.equal(raceLedger.status_code, 409);
    assert.deepEqual(JSON.parse(raceLedger.response_json), raceResult.body);
  } finally {
    db.close();
  }
});

test('reassignment replay precedes later state loss and preserves processing recovery and retained no-op results', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const target = addActor(db, identity, 931001);
    const fixture = initializeFixture(db, identity, 932001, 933001);
    const input = reassignmentInput(fixture, {
      assigneeId: target,
      idempotencyKey: 'task6c3-dropped-response-replay'
    });
    const service = createCampaignWorkflowService(db);
    const first = service.reassignWorkflowTask(input);
    const evidenceAfterFirst = {
      logs: db.prepare(`
        SELECT COUNT(*) AS count FROM workflow_node_logs WHERE instance_id=?
      `).get(fixture.instance.id).count,
      activities: db.prepare(`
        SELECT COUNT(*) AS count FROM activity_log
        WHERE action='workflow_task_reassignment'
          AND json_extract(details,'$.instance_id')=?
      `).get(fixture.instance.id).count,
      archives: db.prepare(`
        SELECT COUNT(*) AS count FROM knowledge_entries
        WHERE business_type='campaign' AND business_id=?
          AND source_type='campaign_workflow_log'
      `).get(String(fixture.campaignId)).count,
      links: db.prepare(`
        SELECT COUNT(*) AS count FROM campaign_record_links
        WHERE campaign_id=? AND relation_type='knowledge' AND revoked_at IS NULL
      `).get(fixture.campaignId).count
    };
    db.prepare(`UPDATE campaigns SET operational_status='on_hold' WHERE id=?`)
      .run(fixture.campaignId);
    db.prepare(`
      UPDATE team_memberships SET status='revoked',revoked_at=CURRENT_TIMESTAMP
      WHERE org_id=? AND team_id=? AND user_id=?
    `).run(identity.orgId, identity.teamId, target);
    assert.deepEqual(service.reassignWorkflowTask(input), first);
    assert.deepEqual({
      logs: db.prepare(`SELECT COUNT(*) AS count FROM workflow_node_logs WHERE instance_id=?`)
        .get(fixture.instance.id).count,
      activities: db.prepare(`
        SELECT COUNT(*) AS count FROM activity_log
        WHERE action='workflow_task_reassignment'
          AND json_extract(details,'$.instance_id')=?
      `).get(fixture.instance.id).count,
      archives: db.prepare(`
        SELECT COUNT(*) AS count FROM knowledge_entries
        WHERE business_type='campaign' AND business_id=?
          AND source_type='campaign_workflow_log'
      `).get(String(fixture.campaignId)).count,
      links: db.prepare(`
        SELECT COUNT(*) AS count FROM campaign_record_links
        WHERE campaign_id=? AND relation_type='knowledge' AND revoked_at IS NULL
      `).get(fixture.campaignId).count
    }, evidenceAfterFirst);
    const changedHash = callError(() => service.reassignWorkflowTask({
      ...input,
      body: { ...input.body, reason: 'Changed replay request' }
    }));
    assert.equal(changedHash.status, 409);
    assert.equal(changedHash.code, 'IDEMPOTENCY_KEY_REUSED');

    const processingTarget = addActor(db, identity, 931101);
    const processing = initializeFixture(db, identity, 932101, 933101);
    const processingInput = reassignmentInput(processing, {
      assigneeId: processingTarget,
      idempotencyKey: 'task6c3-live-processing-lease'
    });
    const processingHash = requestHash({
      method: 'POST',
      path: `/api/campaigns/${processing.campaignId}/workflow-tasks/${processing.task.id}/reassign`,
      campaignId: processing.campaignId,
      kind: 'json',
      payload: processingInput.body
    });
    const reservationInput = {
      organizationId: identity.orgId,
      actorUserId: identity.userId,
      campaignId: processing.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'workflow.campaign-task.reassign',
      key: processingInput.idempotencyKey,
      requestHash: processingHash,
      expectedEventCount: 0,
      operationTimeoutSeconds: 60
    };
    db.transaction(() => idempotency.reserveProcessingInTransaction(
      db,
      reservationInput
    )).immediate();
    const live = callError(() => createCampaignWorkflowService(db)
      .reassignWorkflowTask(processingInput));
    assert.equal(live.status, 409);
    assert.equal(live.code, 'IDEMPOTENCY_IN_PROGRESS');
    assert.ok(live.retryAfterSeconds >= 1);
    withTriggersDisabled(db, ['request_idempotency_legal_transition'], () => {
      db.prepare(`
        UPDATE request_idempotency
        SET lease_until=datetime(CURRENT_TIMESTAMP,'-1 second')
        WHERE scope=? AND idempotency_key=?
      `).run(reservationInput.scope, reservationInput.key);
    });
    const recovered = createCampaignWorkflowService(db)
      .reassignWorkflowTask(processingInput);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.assignment.assignee_id, processingTarget);

    const noOp = initializeFixture(db, identity, 932201, 933201);
    const noOpInput = reassignmentInput(noOp, {
      assigneeId: null,
      assigneeRole: 'member',
      idempotencyKey: 'task6c3-retained-no-op'
    });
    const noOpBefore = db.prepare('SELECT * FROM workflow_tasks WHERE id=?')
      .get(noOp.task.id);
    const noOpResult = createCampaignWorkflowService(db).reassignWorkflowTask(noOpInput);
    assert.deepEqual(noOpResult, {
      status: 400,
      body: {
        error: 'Campaign workflow input is invalid.',
        code: 'INVALID_CAMPAIGN_INPUT',
        request_id: noOpInput.requestId
      },
      headers: {}
    });
    db.prepare(`UPDATE campaigns SET operational_status='cancelled' WHERE id=?`)
      .run(noOp.campaignId);
    assert.deepEqual(
      createCampaignWorkflowService(db).reassignWorkflowTask(noOpInput),
      noOpResult
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(noOp.task.id),
      noOpBefore
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_node_logs
      WHERE instance_id=? AND action='task_reassigned'
    `).get(noOp.instance.id).count, 0);
  } finally {
    db.close();
  }
});

test('locked reassignment precedence keeps operational and stale winners ahead of target no-op and exhaustion', () => {
  const db = openWorkflowDatabase();
  try {
    const identity = workflowIdentity(db);
    const target = addActor(db, identity, 934001);
    const operationalCases = [
      ['on_hold', 'CAMPAIGN_ON_HOLD', 935001, 936001],
      ['cancelled', 'CAMPAIGN_CANCELLED', 935101, 936101]
    ];
    for (const [status, code, campaignId, templateId] of operationalCases) {
      const fixture = initializeFixture(db, identity, campaignId, templateId);
      db.prepare('UPDATE campaigns SET operational_status=? WHERE id=?')
        .run(status, fixture.campaignId);
      const input = reassignmentInput(fixture, {
        assigneeId: 934999,
        idempotencyKey: `task6c3-precedence-${status}`
      });
      const result = createCampaignWorkflowService(db).reassignWorkflowTask(input);
      assert.equal(result.status, 409, status);
      assert.equal(result.body.code, code, status);
      assert.deepEqual(result.body.details, { operational_status: status }, status);
      const ledger = db.prepare(`
        SELECT state,status_code,response_json FROM request_idempotency
        WHERE idempotency_key=?
      `).get(input.idempotencyKey);
      assert.equal(ledger.state, 'completed');
      assert.equal(ledger.status_code, 409);
      assert.deepEqual(JSON.parse(ledger.response_json), result.body);
    }

    const staleCases = [
      ['task', 935201, 936201, (fixture) => {
        db.prepare(`UPDATE workflow_tasks SET status='completed' WHERE id=?`)
          .run(fixture.task.id);
      }],
      ['instance', 935301, 936301, (fixture) => {
        db.prepare(`UPDATE workflow_instances SET status='paused' WHERE id=?`)
          .run(fixture.instance.id);
      }],
      ['version', 935401, 936401, (fixture) => {
        db.prepare(`
          UPDATE workflow_tasks
          SET assignee_id=?,assignee_role='member',assignment_version=2
          WHERE id=?
        `).run(target, fixture.task.id);
      }],
      ['lineage', 935501, 936501, (fixture) => {
        db.prepare(`UPDATE workflow_instances SET current_node_id='winner-node' WHERE id=?`)
          .run(fixture.instance.id);
      }]
    ];
    for (const [name, campaignId, templateId, win] of staleCases) {
      const fixture = initializeFixture(db, identity, campaignId, templateId);
      win(fixture);
      const input = reassignmentInput(fixture, {
        assigneeId: 934999,
        idempotencyKey: `task6c3-precedence-stale-${name}`
      });
      const result = createCampaignWorkflowService(db).reassignWorkflowTask(input);
      assert.equal(result.status, 409, `${name}: ${JSON.stringify(result)}`);
      assert.equal(result.body.code, 'STALE_WORKFLOW_TASK_ACTION', name);
      assert.deepEqual(Object.keys(result.body.details), [
        'task_status', 'instance_status', 'campaign_operational_status'
      ]);
      assert.equal(result.body.details.campaign_operational_status, 'active');
    }

    const noOp = initializeFixture(db, identity, 935601, 936601);
    withTriggersDisabled(db, ['campaign_workflow_task_assignment_update'], () => {
      db.prepare(`UPDATE workflow_tasks SET assignment_version=? WHERE id=?`)
        .run(Number.MAX_SAFE_INTEGER, noOp.task.id);
    });
    const noOpInput = reassignmentInput(noOp, {
      assigneeId: null,
      assigneeRole: 'member',
      idempotencyKey: 'task6c3-max-version-no-op',
      body: {
        expected_task_status: 'pending',
        expected_instance_status: 'active',
        expected_assignment_version: Number.MAX_SAFE_INTEGER,
        assignee_id: null,
        assignee_role: 'member',
        reason: 'No change at maximum version'
      }
    });
    const noOpResult = createCampaignWorkflowService(db).reassignWorkflowTask(noOpInput);
    assert.equal(noOpResult.status, 400);
    assert.equal(noOpResult.body.code, 'INVALID_CAMPAIGN_INPUT');

    const exhausted = initializeFixture(db, identity, 935701, 936701);
    withTriggersDisabled(db, ['campaign_workflow_task_assignment_update'], () => {
      db.prepare(`UPDATE workflow_tasks SET assignment_version=? WHERE id=?`)
        .run(Number.MAX_SAFE_INTEGER, exhausted.task.id);
    });
    const exhaustedInput = reassignmentInput(exhausted, {
      assigneeId: target,
      idempotencyKey: 'task6c3-max-version-exhausted',
      body: {
        expected_task_status: 'pending',
        expected_instance_status: 'active',
        expected_assignment_version: Number.MAX_SAFE_INTEGER,
        assignee_id: target,
        assignee_role: 'member',
        reason: 'Attempt increment at maximum version'
      }
    });
    const exhaustedResult = createCampaignWorkflowService(db)
      .reassignWorkflowTask(exhaustedInput);
    assert.deepEqual(exhaustedResult, {
      status: 409,
      body: {
        error: 'Workflow task assignment version is exhausted.',
        code: 'ROW_VERSION_EXHAUSTED',
        request_id: exhaustedInput.requestId
      },
      headers: {}
    });

    const pausedRaceTarget = addActor(db, identity, 934801);
    const pausedRace = initializeFixture(db, identity, 935801, 936801);
    const raceTaskBefore = db.prepare('SELECT * FROM workflow_tasks WHERE id=?')
      .get(pausedRace.task.id);
    const raceEvidenceBefore = db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_node_logs WHERE instance_id=?
    `).get(pausedRace.instance.id).count;
    const raceInput = reassignmentInput(pausedRace, {
      assigneeId: pausedRaceTarget,
      idempotencyKey: 'task6c3-after-reservation-pause'
    });
    const pausedResult = createCampaignWorkflowService(db, {
      transactionBoundaryProbe(stage) {
        if (stage !== 'reassignment.after_reservation') return;
        db.prepare(`UPDATE workflow_instances SET status='paused' WHERE id=?`)
          .run(pausedRace.instance.id);
      }
    }).reassignWorkflowTask(raceInput);
    assert.equal(pausedResult.status, 409);
    assert.equal(pausedResult.body.code, 'STALE_WORKFLOW_TASK_ACTION');
    assert.equal(pausedResult.body.details.instance_status, 'paused');
    assert.deepEqual(
      db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(pausedRace.task.id),
      raceTaskBefore
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_node_logs WHERE instance_id=?
    `).get(pausedRace.instance.id).count, raceEvidenceBefore);
  } finally {
    db.close();
  }
});

test('reassignment race matrix preserves one winner and leaves every loser without partial evidence', () => {
  function runAfterReservationRace(name, intervene, expectedCode, ids) {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const target = addActor(db, identity, 938001, {
        organizationRole: name === 'target org-role demotion' ? 'org_admin' : 'member',
        teamRole: name === 'empty target role set' ? 'team_lead' : 'member'
      });
      const fixture = initializeFixture(db, identity, ids[0], ids[1]);
      const input = reassignmentInput(fixture, {
        assigneeId: name === 'empty target role set' ? null : target,
        assigneeRole: name === 'target org-role demotion'
          ? 'org_admin'
          : name === 'empty target role set' ? 'team_lead' : 'member',
        idempotencyKey: `task6c3-race-${name.replaceAll(' ', '-')}`
      });
      const before = workflowMutationSnapshot(db, fixture);
      const result = createCampaignWorkflowService(db, {
        transactionBoundaryProbe(stage) {
          if (stage === 'reassignment.after_reservation') {
            intervene(db, fixture, identity, target);
          }
        }
      }).reassignWorkflowTask(input);
      assert.equal(result.status, 409, `${name}: ${JSON.stringify(result)}`);
      assert.equal(result.body.code, expectedCode, name);
      const after = workflowMutationSnapshot(db, fixture);
      assert.deepEqual(after.task, before.task, name);
      assertWorkflowMutationEvidenceUnchanged(after, before, name);
      const ledger = db.prepare(`
        SELECT state,status_code,response_json,expected_event_count
        FROM request_idempotency
        WHERE scope='workflow.campaign-task.reassign' AND idempotency_key=?
      `).get(input.idempotencyKey);
      assert.deepEqual(
        {
          state: ledger.state,
          status_code: ledger.status_code,
          response_json: JSON.parse(ledger.response_json),
          expected_event_count: ledger.expected_event_count
        },
        {
          state: 'completed',
          status_code: 409,
          response_json: result.body,
          expected_event_count: 0
        },
        name
      );
    } finally {
      db.close();
    }
  }

  {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const winnerTarget = addActor(db, identity, 938101);
      const loserTarget = addActor(db, identity, 938102);
      const fixture = initializeFixture(db, identity, 938201, 938301);
      const loserInput = reassignmentInput(fixture, {
        assigneeId: loserTarget,
        idempotencyKey: 'task6c3-race-different-key-loser'
      });
      let winner;
      const result = createCampaignWorkflowService(db, {
        transactionBoundaryProbe(stage) {
          if (stage !== 'reassignment.before_write') return;
          winner = createCampaignWorkflowService(db).reassignWorkflowTask(
            reassignmentInput(fixture, {
              assigneeId: winnerTarget,
              idempotencyKey: 'task6c3-race-different-key-winner'
            })
          );
        }
      }).reassignWorkflowTask(loserInput);
      assert.equal(winner.status, 200);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'STALE_WORKFLOW_TASK_ACTION');
      assert.deepEqual(
        db.prepare(`
          SELECT assignee_id,assignee_role,assignment_version
          FROM workflow_tasks WHERE id=?
        `).get(fixture.task.id),
        { assignee_id: winnerTarget, assignee_role: 'member', assignment_version: 2 }
      );
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM workflow_node_logs
        WHERE instance_id=? AND action='task_reassigned'
      `).get(fixture.instance.id).count, 1);
      assert.deepEqual(db.prepare(`
        SELECT status_code,expected_event_count FROM request_idempotency
        WHERE scope='workflow.campaign-task.reassign' ORDER BY idempotency_key
      `).all(), [
        { status_code: 409, expected_event_count: 0 },
        { status_code: 200, expected_event_count: 0 }
      ]);
    } finally {
      db.close();
    }
  }

  {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const target = addActor(db, identity, 938401);
      const fixture = initializeFixture(db, identity, 938501, 938601);
      let actionWinner;
      const result = createCampaignWorkflowService(db, {
        transactionBoundaryProbe(stage) {
          if (stage !== 'reassignment.before_write') return;
          actionWinner = createCampaignWorkflowService(db).actOnWorkflowTask({
            userId: identity.userId,
            taskId: fixture.task.id,
            action: 'complete',
            requestId: 'task6c3-race-action-winner-request',
            idempotencyKey: 'task6c3-race-action-winner',
            body: {
              expected_status: 'pending',
              expected_assignment_version: 1
            }
          });
        }
      }).reassignWorkflowTask(reassignmentInput(fixture, {
        assigneeId: target,
        idempotencyKey: 'task6c3-race-action-loser'
      }));
      assert.equal(actionWinner.status, 200);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'STALE_WORKFLOW_TASK_ACTION');
      assert.equal(db.prepare('SELECT status FROM workflow_tasks WHERE id=?')
        .get(fixture.task.id).status, 'completed');
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM workflow_node_logs
        WHERE instance_id=? AND action='task_reassigned'
      `).get(fixture.instance.id).count, 0);
    } finally {
      db.close();
    }
  }

  runAfterReservationRace('instance pause', (db, fixture) => {
    db.prepare("UPDATE workflow_instances SET status='paused' WHERE id=?")
      .run(fixture.instance.id);
  }, 'STALE_WORKFLOW_TASK_ACTION', [938701, 938801]);
  runAfterReservationRace('instance cancellation', (db, fixture) => {
    db.prepare("UPDATE workflow_instances SET status='cancelled' WHERE id=?")
      .run(fixture.instance.id);
  }, 'STALE_WORKFLOW_TASK_ACTION', [938901, 939001]);
  runAfterReservationRace('campaign hold', (db, fixture) => {
    db.prepare("UPDATE campaigns SET operational_status='on_hold' WHERE id=?")
      .run(fixture.campaignId);
  }, 'CAMPAIGN_ON_HOLD', [939101, 939201]);
  runAfterReservationRace('campaign cancellation', (db, fixture) => {
    db.prepare("UPDATE campaigns SET operational_status='cancelled' WHERE id=?")
      .run(fixture.campaignId);
  }, 'CAMPAIGN_CANCELLED', [939301, 939401]);
  runAfterReservationRace('campaign team transfer', (db, fixture, identity) => {
    const nextTeamId = 939502;
    db.prepare('INSERT INTO teams (id,org_id,code,name) VALUES (?,?,?,?)').run(
      nextTeamId,
      identity.orgId,
      'task6c3-race-transfer',
      'Task 6C-3 race transfer'
    );
    db.prepare(`
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
      VALUES (?,?,?,'member','active')
    `).run(identity.orgId, nextTeamId, identity.userId);
    db.prepare('UPDATE campaigns SET team_id=? WHERE id=?')
      .run(nextTeamId, fixture.campaignId);
  }, 'STALE_WORKFLOW_TASK_ACTION', [939501, 939601]);
  runAfterReservationRace('target deactivation', (db, _fixture, _identity, target) => {
    db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(target);
  }, 'STALE_WORKFLOW_TASK_ACTION', [939701, 939801]);
  runAfterReservationRace('target org-role demotion', (db, _fixture, identity, target) => {
    db.prepare(`
      UPDATE organization_memberships SET role_code='member'
      WHERE org_id=? AND user_id=?
    `).run(identity.orgId, target);
  }, 'STALE_WORKFLOW_TASK_ACTION', [939901, 940001]);
  runAfterReservationRace('target membership revocation', (db, _fixture, identity, target) => {
    db.prepare(`
      UPDATE team_memberships SET status='revoked',revoked_at=CURRENT_TIMESTAMP
      WHERE org_id=? AND team_id=? AND user_id=?
    `).run(identity.orgId, identity.teamId, target);
  }, 'STALE_WORKFLOW_TASK_ACTION', [940101, 940201]);
  runAfterReservationRace('empty target role set', (db, _fixture, identity) => {
    db.prepare(`
      UPDATE team_memberships SET role_code='member'
      WHERE org_id=? AND team_id=? AND role_code='team_lead'
    `).run(identity.orgId, identity.teamId);
  }, 'STALE_WORKFLOW_TASK_ACTION', [940301, 940401]);
});

test('reassignment proves route lineage and current caller authorization before ledger replay', () => {
  {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const target = addActor(db, identity, 940501);
      const fixture = initializeFixture(db, identity, 940601, 940701);
      const other = initializeFixture(db, identity, 940801, 940901);
      const wrongRouteInput = reassignmentInput(fixture, {
        assigneeId: target,
        campaignId: other.campaignId,
        idempotencyKey: 'task6c3-lineage-wrong-route'
      });
      const wrongRoute = callError(() => createCampaignWorkflowService(db)
        .reassignWorkflowTask(wrongRouteInput));
      assert.deepEqual(wrongRoute, {
        status: 404,
        code: 'CAMPAIGN_NOT_FOUND',
        message: 'Campaign was not found.',
        details: undefined,
        retryAfterSeconds: undefined
      });

      withTriggersDisabled(db, ['workflow_instances_campaign_context_immutable'], () => {
        db.prepare(`
          UPDATE workflow_instances SET campaign_dispatch_id=NULL WHERE id=?
        `).run(fixture.instance.id);
      });
      const brokenDispatchInput = reassignmentInput(fixture, {
        assigneeId: target,
        idempotencyKey: 'task6c3-lineage-broken-dispatch'
      });
      const brokenDispatch = callError(() => createCampaignWorkflowService(db)
        .reassignWorkflowTask(brokenDispatchInput));
      assert.equal(brokenDispatch.status, 404);
      assert.equal(brokenDispatch.code, 'CAMPAIGN_NOT_FOUND');

      const missingLink = initializeFixture(db, identity, 941001, 941101);
      db.prepare(`
        UPDATE campaign_record_links
        SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?,revoke_reason='Task 6C-3 lineage fixture'
        WHERE campaign_id=? AND record_type='workflow_instance'
          AND relation_type='workflow' AND record_id=? AND revoked_at IS NULL
      `).run(identity.userId, missingLink.campaignId, String(missingLink.instance.id));
      const missingLinkInput = reassignmentInput(missingLink, {
        assigneeId: target,
        idempotencyKey: 'task6c3-lineage-missing-link'
      });
      const missingLinkError = callError(() => createCampaignWorkflowService(db)
        .reassignWorkflowTask(missingLinkInput));
      assert.equal(missingLinkError.status, 404);
      assert.equal(missingLinkError.code, 'CAMPAIGN_NOT_FOUND');
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM request_idempotency
        WHERE scope='workflow.campaign-task.reassign'
          AND idempotency_key IN (?,?,?)
      `).get(
        wrongRouteInput.idempotencyKey,
        brokenDispatchInput.idempotencyKey,
        missingLinkInput.idempotencyKey
      ).count, 0);
    } finally {
      db.close();
    }
  }

  {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const target = addActor(db, identity, 941201);
      const fixture = initializeFixture(db, identity, 941301, 941401);
      const input = reassignmentInput(fixture, {
        assigneeId: target,
        idempotencyKey: 'task6c3-replay-caller-revoked'
      });
      const service = createCampaignWorkflowService(db);
      const success = service.reassignWorkflowTask(input);
      assert.equal(success.status, 200);
      db.prepare(`
        UPDATE organization_memberships
        SET status='revoked',revoked_at=CURRENT_TIMESTAMP
        WHERE org_id=? AND user_id=?
      `).run(identity.orgId, identity.userId);
      const replayDenied = callError(() => service.reassignWorkflowTask(input));
      assert.equal(replayDenied.status, 404);
      assert.equal(replayDenied.code, 'CAMPAIGN_NOT_FOUND');
      const retained = db.prepare(`
        SELECT state,status_code,response_json FROM request_idempotency
        WHERE scope='workflow.campaign-task.reassign' AND idempotency_key=?
      `).get(input.idempotencyKey);
      assert.equal(retained.state, 'completed');
      assert.equal(retained.status_code, 200);
      assert.deepEqual(JSON.parse(retained.response_json), success.body);
    } finally {
      db.close();
    }
  }

  {
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const nextOwner = addActor(db, identity, 941501);
      const target = addActor(db, identity, 941502);
      const fixture = initializeFixture(db, identity, 941601, 941701);
      const input = reassignmentInput(fixture, {
        assigneeId: target,
        idempotencyKey: 'task6c3-replay-caller-demoted'
      });
      const service = createCampaignWorkflowService(db);
      const success = service.reassignWorkflowTask(input);
      assert.equal(success.status, 200);
      db.prepare('UPDATE campaigns SET owner_user_id=? WHERE id=?')
        .run(nextOwner, fixture.campaignId);
      db.prepare(`
        UPDATE organization_memberships SET role_code='member'
        WHERE org_id=? AND user_id=?
      `).run(identity.orgId, identity.userId);
      const replayDenied = callError(() => service.reassignWorkflowTask(input));
      assert.equal(replayDenied.status, 403);
      assert.equal(replayDenied.code, 'CAMPAIGN_FORBIDDEN');
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM workflow_node_logs
        WHERE instance_id=? AND action='task_reassigned'
      `).get(fixture.instance.id).count, 1);
    } finally {
      db.close();
    }
  }
});

test('reciprocal campaign lineage rejects cross-scope dispatches and duplicate links before reads or mutation', async () => {
  const scenarios = [
    {
      name: 'cross-campaign dispatch and root event',
      corrupt(db, fixture, identity, other) {
        corruptDispatchCampaignIdentity(db, fixture, identity.orgId, other.campaignId);
      }
    },
    {
      name: 'cross-organization dispatch and root event',
      corrupt(db, fixture, identity) {
        corruptDispatchCampaignIdentity(
          db,
          fixture,
          identity.orgId + 700000,
          fixture.campaignId
        );
      }
    },
    {
      name: 'duplicate reciprocal active workflow link',
      corrupt(db, fixture) {
        duplicateActiveWorkflowLink(db, fixture, 'reciprocal-static');
      }
    }
  ];
  const modes = ['pre-ledger', 'locked'];
  const outcomes = [];
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    for (const mode of modes) {
      const db = openWorkflowDatabase();
      let api;
      try {
        const scenario = scenarios[scenarioIndex];
        const identity = workflowIdentity(db);
        const reader = addActor(db, identity, 942001);
        const target = addActor(db, identity, 942002);
        const fixture = initializeFixture(db, identity, 942101, 942201);
        const other = initializeFixture(db, identity, 942301, 942401);
        let expectedSnapshot;
        const corrupt = () => {
          scenario.corrupt(db, fixture, identity, other);
          expectedSnapshot = workflowMutationSnapshot(db, fixture);
        };
        if (mode === 'pre-ledger') corrupt();
        const input = reassignmentInput(fixture, {
          assigneeId: target,
          idempotencyKey: `task6c3-reciprocal-${scenarioIndex}-${mode}`
        });
        let mutation;
        try {
          const result = createCampaignWorkflowService(db, {
            transactionBoundaryProbe(stage) {
              if (mode === 'locked' && stage === 'reassignment.before_write') corrupt();
            }
          }).reassignWorkflowTask(input);
          mutation = { status: result.status, code: result.body.code };
        } catch (error) {
          mutation = { status: error.statusCode, code: error.code };
        }
        const afterMutation = workflowMutationSnapshot(db, fixture);
        const ledgerCount = db.prepare(`
          SELECT COUNT(*) AS count FROM request_idempotency
          WHERE scope='workflow.campaign-task.reassign' AND idempotency_key=?
        `).get(input.idempotencyKey).count;
        api = await startWorkflowReadApi(db, reader);
        const taskDetail = await api.get(`/api/workflow/tasks/${fixture.task.id}`);
        const instanceDetail = await api.get(`/api/workflow/instances/${fixture.instance.id}`);
        const list = await api.get('/api/workflow/tasks?status=pending');
        outcomes.push({
          name: scenario.name,
          mode,
          mutation,
          ledgerCount,
          mutationPreservedSnapshot: JSON.stringify(afterMutation) === JSON.stringify(expectedSnapshot),
          taskDetail: { status: taskDetail.status, body: taskDetail.body },
          instanceDetail: { status: instanceDetail.status, body: instanceDetail.body },
          listContainsTask: list.body.tasks.some((task) => task.id === fixture.task.id)
        });
      } finally {
        if (api) await api.close();
        db.close();
      }
    }
  }
  assert.deepEqual(outcomes, scenarios.flatMap((scenario) => modes.map((mode) => ({
    name: scenario.name,
    mode,
    mutation: { status: 404, code: 'CAMPAIGN_NOT_FOUND' },
    ledgerCount: 0,
    mutationPreservedSnapshot: true,
    taskDetail: { status: 404, body: { error: 'Task not found' } },
    instanceDetail: { status: 404, body: { error: 'Instance not found' } },
    listContainsTask: false
  }))));
});

test('authoritative campaign organization conceals a coherent wrong-organization workflow chain', async () => {
  const outcomes = [];
  for (const mode of ['pre-ledger', 'locked']) {
    const db = openWorkflowDatabase();
    let api;
    try {
      const identity = workflowIdentity(db);
      const target = addActor(db, identity, 943001);
      const forbiddenReader = addActor(db, identity, 943002, {
        teamMembership: false
      });
      db.prepare(`
        INSERT INTO teams (id,org_id,code,name) VALUES (?,?,?,?)
      `).run(
        943003,
        identity.orgId,
        'task6c3-authoritative-other-team',
        'Task 6C-3 authoritative other team'
      );
      db.prepare(`
        INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
        VALUES (?,?,?,'member','active')
      `).run(identity.orgId, 943003, forbiddenReader);
      const fixture = initializeFixture(db, identity, 943101, 943201);
      const validFixture = initializeFixture(db, identity, 943301, 943401);
      const wrongOrganizationId = identity.orgId + 943000;
      let expectedSnapshot;
      const corrupt = () => {
        corruptCoherentWorkflowOrganization(db, fixture, wrongOrganizationId);
        expectedSnapshot = workflowMutationSnapshot(db, fixture);
      };
      if (mode === 'pre-ledger') corrupt();
      const input = reassignmentInput(fixture, {
        assigneeId: target,
        idempotencyKey: `task6c3-authoritative-org-${mode}`
      });
      let mutation;
      try {
        const result = createCampaignWorkflowService(db, {
          transactionBoundaryProbe(stage) {
            if (mode === 'locked' && stage === 'reassignment.before_write') corrupt();
          }
        }).reassignWorkflowTask(input);
        mutation = { status: result.status, code: result.body.code };
      } catch (error) {
        mutation = { status: error.statusCode, code: error.code };
      }
      const afterMutation = workflowMutationSnapshot(db, fixture);
      const ledgerCount = db.prepare(`
        SELECT COUNT(*) AS count FROM request_idempotency
        WHERE scope='workflow.campaign-task.reassign' AND idempotency_key=?
      `).get(input.idempotencyKey).count;
      api = await startWorkflowReadApi(db, identity.userId);
      const taskDetail = await api.get(`/api/workflow/tasks/${fixture.task.id}`);
      const instanceDetail = await api.get(`/api/workflow/instances/${fixture.instance.id}`);
      const list = await api.get('/api/workflow/tasks?status=pending');
      await api.close();
      api = await startWorkflowReadApi(db, forbiddenReader);
      const malformedForbiddenTask = await api.get(`/api/workflow/tasks/${fixture.task.id}`);
      const malformedForbiddenInstance = await api.get(
        `/api/workflow/instances/${fixture.instance.id}`
      );
      const validForbiddenTask = await api.get(`/api/workflow/tasks/${validFixture.task.id}`);
      const validForbiddenInstance = await api.get(
        `/api/workflow/instances/${validFixture.instance.id}`
      );
      const forbiddenList = await api.get('/api/workflow/tasks?status=pending');
      outcomes.push({
        mode,
        mutation,
        ledgerCount,
        mutationPreservedSnapshot: JSON.stringify(afterMutation) === JSON.stringify(expectedSnapshot),
        taskDetail: { status: taskDetail.status, body: taskDetail.body },
        instanceDetail: { status: instanceDetail.status, body: instanceDetail.body },
        listStatus: list.status,
        listContainsTask: list.body.tasks.some((task) => task.id === fixture.task.id),
        malformedForbiddenTask,
        malformedForbiddenInstance,
        validForbiddenTask,
        validForbiddenInstance,
        forbiddenListStatus: forbiddenList.status,
        forbiddenListContainsMalformed: forbiddenList.body.tasks.some(
          (task) => task.id === fixture.task.id
        ),
        forbiddenListContainsValid: forbiddenList.body.tasks.some(
          (task) => task.id === validFixture.task.id
        )
      });
    } finally {
      if (api) await api.close();
      db.close();
    }
  }
  assert.deepEqual(outcomes, [
    {
      mode: 'pre-ledger',
      mutation: { status: 404, code: 'CAMPAIGN_NOT_FOUND' },
      ledgerCount: 0,
      mutationPreservedSnapshot: true,
      taskDetail: { status: 404, body: { error: 'Task not found' } },
      instanceDetail: { status: 404, body: { error: 'Instance not found' } },
      listStatus: 200,
      listContainsTask: false,
      malformedForbiddenTask: { status: 404, body: { error: 'Task not found' } },
      malformedForbiddenInstance: { status: 404, body: { error: 'Instance not found' } },
      validForbiddenTask: { status: 403, body: { error: 'Access denied' } },
      validForbiddenInstance: { status: 403, body: { error: 'Access denied' } },
      forbiddenListStatus: 200,
      forbiddenListContainsMalformed: false,
      forbiddenListContainsValid: false
    },
    {
      mode: 'locked',
      mutation: { status: 404, code: 'CAMPAIGN_NOT_FOUND' },
      ledgerCount: 0,
      mutationPreservedSnapshot: true,
      taskDetail: { status: 404, body: { error: 'Task not found' } },
      instanceDetail: { status: 404, body: { error: 'Instance not found' } },
      listStatus: 200,
      listContainsTask: false,
      malformedForbiddenTask: { status: 404, body: { error: 'Task not found' } },
      malformedForbiddenInstance: { status: 404, body: { error: 'Instance not found' } },
      validForbiddenTask: { status: 403, body: { error: 'Access denied' } },
      validForbiddenInstance: { status: 403, body: { error: 'Access denied' } },
      forbiddenListStatus: 200,
      forbiddenListContainsMalformed: false,
      forbiddenListContainsValid: false
    }
  ]);
});

test('reassignment persistence and capacity failures roll back task evidence and ledger atomically', () => {
  const cases = [
    {
      name: 'node log',
      install(db) {
        db.exec(`
          CREATE TRIGGER task6c3_fail_reassignment_log
          BEFORE INSERT ON workflow_node_logs
          WHEN NEW.action='task_reassigned'
          BEGIN SELECT RAISE(ABORT,'injected reassignment log failure'); END;
        `);
      }
    },
    {
      name: 'activity',
      install(db) {
        db.exec(`
          CREATE TRIGGER task6c3_fail_reassignment_activity
          BEFORE INSERT ON activity_log
          WHEN NEW.action='workflow_task_reassignment'
          BEGIN SELECT RAISE(ABORT,'injected reassignment activity failure'); END;
        `);
      }
    },
    {
      name: 'archive',
      install(db) {
        db.exec(`
          CREATE TRIGGER task6c3_fail_reassignment_archive
          BEFORE INSERT ON knowledge_entries
          WHEN NEW.source_type='campaign_workflow_log'
          BEGIN SELECT RAISE(ABORT,'injected reassignment archive failure'); END;
        `);
      }
    },
    {
      name: 'knowledge link',
      install(db) {
        db.exec(`
          CREATE TRIGGER task6c3_fail_reassignment_link
          BEFORE INSERT ON campaign_record_links
          WHEN NEW.record_type='knowledge_entry' AND NEW.relation_type='knowledge'
          BEGIN SELECT RAISE(ABORT,'injected reassignment link failure'); END;
        `);
      }
    },
    {
      name: 'generic archive writer',
      serviceOptions: {
        writeKnowledgeInTransaction() {
          throw new Error('private injected archive writer failure');
        }
      }
    },
    {
      name: 'knowledge capacity',
      expectedStatus: 507,
      serviceOptions: {
        writeKnowledgeInTransaction() {
          const error = new Error('private injected capacity failure');
          error.name = 'CampaignKnowledgeCapacityError';
          error.code = 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED';
          error.details = { limit: 'campaign-workflow-archive' };
          throw error;
        }
      }
    },
    {
      name: 'ledger completion',
      ledgerFailure: true,
      install(db) {
        db.exec(`
          CREATE TRIGGER task6c3_fail_reassignment_ledger
          BEFORE UPDATE ON request_idempotency
          WHEN OLD.scope='workflow.campaign-task.reassign' AND NEW.state='completed'
          BEGIN SELECT RAISE(ABORT,'injected reassignment ledger failure'); END;
        `);
      }
    }
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const db = openWorkflowDatabase();
    try {
      const identity = workflowIdentity(db);
      const target = addActor(db, identity, 940001);
      const fixture = initializeFixture(db, identity, 941001, 942001);
      if (item.install) item.install(db);
      const before = workflowMutationSnapshot(db, fixture);
      const input = reassignmentInput(fixture, {
        assigneeId: target,
        idempotencyKey: `task6c3-failure-${index}`
      });
      const result = createCampaignWorkflowService(db, item.serviceOptions || {})
        .reassignWorkflowTask(input);
      const expectedStatus = item.expectedStatus || 500;
      assert.equal(result.status, expectedStatus, item.name);
      if (expectedStatus === 507) {
        assert.deepEqual(result.body, {
          error: 'Campaign knowledge storage capacity exceeded',
          code: 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED',
          request_id: input.requestId,
          details: { limit: 'campaign-workflow-archive' }
        });
      } else {
        assert.deepEqual(result.body, {
          error: 'Campaign workflow task reassignment could not be persisted safely.',
          code: 'AUDIT_PERSISTENCE_FAILED',
          request_id: input.requestId
        }, item.name);
      }
      assert.deepEqual(workflowMutationSnapshot(db, fixture), before, item.name);
      const ledgers = db.prepare(`
        SELECT state,status_code,response_json FROM request_idempotency
        WHERE scope='workflow.campaign-task.reassign' AND idempotency_key=?
      `).all(input.idempotencyKey);
      if (item.ledgerFailure) {
        assert.equal(ledgers.length, 0, item.name);
      } else {
        assert.equal(ledgers.length, 1, item.name);
        assert.equal(ledgers[0].state, 'completed', item.name);
        assert.equal(ledgers[0].status_code, expectedStatus, item.name);
        assert.deepEqual(JSON.parse(ledgers[0].response_json), result.body, item.name);
      }
    } finally {
      db.close();
    }
  }
});
