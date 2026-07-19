const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CAMPAIGN_MIGRATIONS = Object.freeze([Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function openCampaignDatabase(t) {
  const db = new Database(':memory:');
  t.after(() => {
    if (db.open) db.close();
  });

  assert.deepEqual(
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: CAMPAIGN_MIGRATIONS
    }),
    { status: 'managed', currentVersion: 2 }
  );
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('recursive_triggers', { simple: true }), 1);
  return db;
}

function assertDatabaseHealthy(db) {
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
}

function seedBusinessRecords(db) {
  const actor = db.prepare(`
    SELECT membership.org_id AS orgId,membership.team_id AS teamId,
      membership.user_id AS userId
    FROM team_memberships membership
    JOIN organizations organization ON organization.id=membership.org_id
    WHERE organization.code='turingmarket-default'
      AND membership.status='active'
    ORDER BY membership.user_id,membership.team_id
    LIMIT 1
  `).get();
  assert.ok(actor);

  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (101,'Behavior Brand','Behavior Brand Ltd','qualified','schema-test',?,?)
  `).run(actor.userId, actor.userId);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (201,101,'Behavior Launch','proposal',25000,80,'Behavior Device','influencer',?)
  `).run(actor.userId);
  db.prepare(`
    INSERT INTO demands (
      id,user_id,brand_name,company_name,product_name,industry,budget,target_market,
      platform,status,data_json
    ) VALUES (
      301,?,'Behavior Brand','Behavior Brand Ltd','Behavior Device','3C','$25000',
      'US','YouTube','confirmed','{"source":"schema-behavior"}'
    )
  `).run(actor.userId);
  db.prepare(`
    INSERT INTO proposals (id,user_id,demand_id,template_id,content)
    VALUES (401,?,301,'behavior-template','Approved behavior proposal')
  `).run(actor.userId);

  const influencer = db.prepare(`
    SELECT id,kol_handle
    FROM influencers
    WHERE is_active=1
    ORDER BY id
    LIMIT 1
  `).get();
  assert.ok(influencer);
  db.prepare(`
    INSERT INTO collaborations (
      id,demand_id,influencer_id,user_id,status,proposal_notes,cost_quoted,cost_actual,
      content_url,roi_data,timeline_start,timeline_end,notes,row_version,
      cost_actual_confirmed
    ) VALUES (
      501,301,?,?,'completed','Approved order',2500,2200,
      'https://example.invalid/behavior-publication','{"views":12000}',
      '2026-07-01','2026-07-15','Behavior collaboration',1,1
    )
  `).run(influencer.id, actor.userId);

  return {
    actor,
    customerId: 101,
    opportunityId: 201,
    demandId: 301,
    proposalId: 401,
    influencerId: influencer.id,
    collaborationId: 501
  };
}

function insertCampaign(db, context, overrides = {}) {
  const campaign = {
    id: 601,
    orgId: context.actor.orgId,
    name: 'Behavior Campaign',
    customerId: context.customerId,
    opportunityId: context.opportunityId,
    ownerUserId: context.actor.userId,
    teamId: context.actor.teamId,
    lifecycleState: 'lead',
    operationalStatus: 'active',
    rowVersion: 1,
    ...overrides
  };
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version,product_name,region,currency,
      budget_minor,start_date,end_date
    ) VALUES (
      @id,@orgId,@name,@customerId,@opportunityId,@ownerUserId,@teamId,
      @lifecycleState,@operationalStatus,@rowVersion,'Behavior Device','US','USD',
      2500000,'2026-07-01','2026-07-31'
    )
  `).run(campaign);
  return campaign;
}

function insertOrganizationScope(db, userId) {
  const scope = { orgId: 2, teamId: 202, userId };
  db.prepare(`
    INSERT INTO organizations (id,code,name,created_at)
    VALUES (2,'behavior-scope-two','Behavior Scope Two','2026-07-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO organization_memberships (
      org_id,user_id,role_code,status,created_at
    ) VALUES (2,?,'org_admin','active','2026-07-01 00:00:00')
  `).run(userId);
  db.prepare(`
    INSERT INTO teams (id,org_id,code,name,created_at)
    VALUES (202,2,'behavior-team-two','Behavior Team Two','2026-07-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO team_memberships (
      org_id,team_id,user_id,role_code,status,created_at
    ) VALUES (2,202,?,'team_lead','active','2026-07-01 00:00:00')
  `).run(userId);
  return scope;
}

function reserveCampaignEvent(db, {
  label,
  scope,
  campaignId,
  orgId,
  userId,
  expectedEventCount = 1
}) {
  const fingerprint = sha256(`audit:${label}`);
  db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,scope,idempotency_key,reservation_nonce,
      request_hash,audit_fingerprint,expected_event_count,state,lease_until,
      lease_token,operation_deadline
    ) VALUES (
      @orgId,@userId,@campaignId,@scope,@idempotencyKey,@reservationNonce,
      @requestHash,@fingerprint,@expectedEventCount,'processing',
      datetime('now','+1 hour'),@leaseToken,datetime('now','+1 day')
    )
  `).run({
    orgId,
    userId,
    campaignId,
    scope,
    idempotencyKey: `behavior:${sha256(label).slice(0, 24)}`,
    reservationNonce: sha256(`nonce:${label}`),
    requestHash: sha256(`request:${label}`),
    fingerprint,
    expectedEventCount,
    leaseToken: `behavior-lease-${sha256(`lease:${label}`).slice(0, 24)}`
  });
  return fingerprint;
}

function insertCampaignEventRow(db, {
  label,
  orgId,
  campaignId,
  actorUserId,
  eventType,
  previousState = null,
  nextState = null,
  reason,
  source,
  metadata,
  auditFingerprint,
  correlationId = `behavior-${sha256(`correlation:${label}`).slice(0, 20)}`
}) {
  const result = db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    orgId,
    campaignId,
    eventType,
    previousState,
    nextState,
    actorUserId,
    reason,
    source,
    JSON.stringify(metadata),
    correlationId,
    auditFingerprint
  );
  return Number(result.lastInsertRowid);
}

function insertAuditedCampaignEvent(db, {
  label,
  scope,
  campaign,
  actorUserId,
  eventType,
  previousState = null,
  nextState = null,
  reason,
  source,
  metadata
}) {
  const auditFingerprint = reserveCampaignEvent(db, {
    label,
    scope,
    campaignId: campaign.id,
    orgId: campaign.orgId,
    userId: actorUserId
  });
  return insertCampaignEventRow(db, {
    label,
    orgId: campaign.orgId,
    campaignId: campaign.id,
    actorUserId,
    eventType,
    previousState,
    nextState,
    reason,
    source,
    metadata,
    auditFingerprint
  });
}

function insertLinkBundle(db, {
  label,
  orgId,
  campaignId,
  userId,
  recordType,
  recordId,
  relationTypes,
  metadata = {}
}) {
  const bundleId = sha256(`bundle:${label}`);
  const insert = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?)
  `);
  const linkIds = relationTypes.map((relationType) => Number(insert.run(
    orgId,
    campaignId,
    recordType,
    bundleId,
    String(recordId),
    relationType,
    userId,
    JSON.stringify(metadata)
  ).lastInsertRowid));
  return { bundleId, linkIds, recordType, recordId: String(recordId), relationTypes };
}

function insertLinkAttachmentEvent(db, {
  label,
  scope,
  source,
  reason,
  campaign,
  actorUserId,
  bundle
}) {
  return insertAuditedCampaignEvent(db, {
    label,
    scope,
    campaign,
    actorUserId,
    eventType: 'link_attached',
    reason,
    source,
    metadata: {
      bundle_id: bundle.bundleId,
      relation_types: [...bundle.relationTypes].sort(),
      record_type: bundle.recordType,
      record_id: bundle.recordId,
      link_ids: [...bundle.linkIds].sort((left, right) => left - right)
    }
  });
}

function insertReviewEvidence(db, {
  entryId = 701,
  chunkId = 801,
  campaignId,
  settledEventId,
  userId
}) {
  const content = 'Campaign results, confirmed expense, and publication evidence.';
  db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      title,summary,tags_json,visibility,business_type,business_id,metadata_json,
      source_identity_sha256,content_sha256
    ) VALUES (
      @entryId,'campaign_review','campaign_review',@sourceId,'campaign review',
      @content,@userId,0,'Behavior campaign review','Verified campaign closeout',
      '["campaign-review"]','team','campaign',@businessId,'{"schema_version":1}',
      @sourceIdentitySha256,@contentSha256
    )
  `).run({
    entryId,
    sourceId: `${campaignId}:${settledEventId}`,
    content,
    userId,
    businessId: String(campaignId),
    sourceIdentitySha256: sha256(`review-source:${campaignId}:${settledEventId}`),
    contentSha256: sha256(content)
  });
  if (chunkId !== null) {
    db.prepare(`
      INSERT INTO knowledge_chunks (
        id,entry_id,chunk_index,content,metadata_json,token_count,content_sha256
      ) VALUES (
        @chunkId,@entryId,0,@content,'{"kind":"campaign-review"}',8,@contentSha256
      )
    `).run({
      chunkId,
      entryId,
      content,
      contentSha256: sha256(`chunk:${content}`)
    });
  }
  return entryId;
}

function sqliteDate(db, modifier) {
  return db.prepare("SELECT datetime('now',?) AS value").get(modifier).value;
}

function sqliteDateFrom(db, value, modifier) {
  return db.prepare('SELECT datetime(?,?) AS value').get(value, modifier).value;
}

function insertRequestRecord(db, {
  label,
  orgId,
  userId,
  campaignId = null,
  secondaryCampaignId = null,
  resourceClaim = null,
  scope,
  expectedEventCount,
  state = 'processing',
  createdAt = sqliteDate(db, '-1 minute'),
  updatedAt = createdAt,
  operationDeadline = sqliteDate(db, '+1 day'),
  leaseUntil,
  leaseToken,
  statusCode = null,
  responseKind = null,
  responseJson = null,
  responseHeadersJson = null,
  expiresAt
}) {
  const auditFingerprint = sha256(`audit:${label}`);
  const effectiveLeaseUntil = leaseUntil === undefined
    ? (state === 'processing' ? sqliteDate(db, '+1 hour') : null)
    : leaseUntil;
  const effectiveLeaseToken = leaseToken === undefined
    ? (state === 'processing'
      ? `behavior-lease-${sha256(`lease:${label}`).slice(0, 24)}`
      : null)
    : leaseToken;
  const effectiveExpiresAt = expiresAt === undefined
    ? (state === 'failed'
      ? sqliteDateFrom(db, updatedAt, '+1 day')
      : (state === 'completed'
        ? sqliteDateFrom(db, updatedAt, responseKind === 'admission' ? '+1 day' : '+30 days')
        : null))
    : expiresAt;
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,lease_until,lease_token,status_code,response_kind,
      response_json,response_headers_json,created_at,updated_at,operation_deadline,
      expires_at
    ) VALUES (
      @orgId,@userId,@campaignId,@secondaryCampaignId,@resourceClaim,@scope,
      @idempotencyKey,@reservationNonce,@requestHash,@auditFingerprint,
      @expectedEventCount,@state,@leaseUntil,@leaseToken,@statusCode,@responseKind,
      @responseJson,@responseHeadersJson,@createdAt,@updatedAt,@operationDeadline,
      @expiresAt
    )
  `).run({
    orgId,
    userId,
    campaignId,
    secondaryCampaignId,
    resourceClaim,
    scope,
    idempotencyKey: `behavior:${sha256(label).slice(0, 24)}`,
    reservationNonce: sha256(`nonce:${label}`),
    requestHash: sha256(`request:${label}`),
    auditFingerprint,
    expectedEventCount,
    state,
    leaseUntil: effectiveLeaseUntil,
    leaseToken: effectiveLeaseToken,
    statusCode,
    responseKind,
    responseJson,
    responseHeadersJson,
    createdAt,
    updatedAt,
    operationDeadline,
    expiresAt: effectiveExpiresAt
  });
  return {
    id: Number(result.lastInsertRowid),
    auditFingerprint,
    operationDeadline,
    leaseUntil: effectiveLeaseUntil
  };
}

function completeJsonRequest(db, requestId, statusCode, body = { ok: true }) {
  return db.prepare(`
    UPDATE request_idempotency
    SET state='completed',lease_until=NULL,lease_token=NULL,status_code=?,
      response_kind='json',response_json=?,response_headers_json=?,
      updated_at=CURRENT_TIMESTAMP,expires_at=datetime(CURRENT_TIMESTAMP,'+30 days')
    WHERE id=?
  `).run(
    statusCode,
    JSON.stringify(body),
    JSON.stringify({ 'Content-Type': 'application/json' }),
    requestId
  );
}

function insertCampaignCreatedEvent(db, context, campaign, label) {
  return insertAuditedCampaignEvent(db, {
    label,
    scope: 'campaign.create',
    campaign,
    actorUserId: context.actor.userId,
    eventType: 'campaign_created',
    nextState: 'lead',
    reason: 'Campaign created',
    source: 'campaign_api',
    metadata: {
      customer_id: context.customerId,
      opportunity_id: context.opportunityId,
      owner_user_id: campaign.ownerUserId,
      team_id: campaign.teamId,
      row_version: campaign.rowVersion
    }
  });
}

function insertWorkflowTemplate(db, userId, {
  id = 901,
  version = 4,
  name = 'Behavior Campaign Workflow'
} = {}) {
  db.prepare(`
    INSERT INTO workflow_templates (
      id,name,description,module,category,nodes,edges,version,is_active,
      created_by,trigger_config_json
    ) VALUES (
      @id,@name,'Campaign schema behavior workflow','campaign','approval',
      '[{"id":"start","type":"start"},{"id":"approve","type":"approval"}]',
      '[{"source":"start","target":"approve"}]',@version,1,@userId,
      '{"event_type":"campaign_created"}'
    )
  `).run({ id, name, version, userId });
  return { id, version, name };
}

function insertWorkflowDispatch(db, {
  id = 1001,
  campaign,
  eventId,
  triggerEventId = eventId,
  template,
  workflowInstanceId = null,
  reconcilesDispatchId = null,
  status = 'pending',
  attemptCount = 0,
  leaseUntil = null,
  leaseToken = null,
  nextAttemptAt = null,
  lastErrorCode = null,
  lastError = null,
  templateChecksum = sha256(`workflow-template:${template.id}:${template.version}`),
  templateSnapshotJson = JSON.stringify({
    template_id: template.id,
    version: template.version,
    nodes: ['start', 'approve']
  }),
  executionContextJson = JSON.stringify({
    campaign_id: campaign.id,
    source: 'schema-behavior'
  })
}) {
  db.prepare(`
    INSERT INTO campaign_workflow_dispatches (
      id,org_id,campaign_id,event_id,trigger_event_id,template_id,template_version,
      template_checksum,template_snapshot_json,execution_context_json,
      workflow_instance_id,reconciles_dispatch_id,status,attempt_count,lease_until,
      lease_token,next_attempt_at,last_error_code,last_error
    ) VALUES (
      @id,@orgId,@campaignId,@eventId,@triggerEventId,@templateId,@templateVersion,
      @templateChecksum,@templateSnapshotJson,@executionContextJson,
      @workflowInstanceId,@reconcilesDispatchId,@status,@attemptCount,@leaseUntil,
      @leaseToken,@nextAttemptAt,@lastErrorCode,@lastError
    )
  `).run({
    id,
    orgId: campaign.orgId,
    campaignId: campaign.id,
    eventId,
    triggerEventId,
    templateId: template.id,
    templateVersion: template.version,
    templateChecksum,
    templateSnapshotJson,
    executionContextJson,
    workflowInstanceId,
    reconcilesDispatchId,
    status,
    attemptCount,
    leaseUntil,
    leaseToken,
    nextAttemptAt,
    lastErrorCode,
    lastError
  });
  return {
    id,
    eventId,
    triggerEventId,
    templateChecksum,
    templateSnapshotJson,
    executionContextJson
  };
}

function insertCampaignWorkflowInstance(db, {
  id = 1101,
  campaign,
  eventId,
  dispatch,
  template,
  startedBy,
  status = 'active',
  initializationStatus = 'ready',
  initializationError = null,
  executionErrorCode = null,
  executionError = null,
  executionFailedAt = null
}) {
  db.prepare(`
    INSERT INTO workflow_instances (
      id,template_id,business_type,business_id,current_node_id,status,node_data,
      started_by,org_id,campaign_id,campaign_event_id,campaign_dispatch_id,
      initialization_status,initialization_error,execution_error_code,
      execution_error,execution_failed_at
    ) VALUES (
      @id,@templateId,'campaign',@campaignId,'start',@status,'{}',
      @startedBy,@orgId,@campaignId,@eventId,@dispatchId,
      @initializationStatus,@initializationError,@executionErrorCode,
      @executionError,@executionFailedAt
    )
  `).run({
    id,
    templateId: template.id,
    campaignId: campaign.id,
    status,
    startedBy,
    orgId: campaign.orgId,
    eventId,
    dispatchId: dispatch.id,
    initializationStatus,
    initializationError,
    executionErrorCode,
    executionError,
    executionFailedAt
  });
  return id;
}

function insertCampaignWorkflowTask(db, {
  id = 1201,
  instanceId,
  assigneeId,
  assigneeRole = 'member',
  status = 'pending'
}) {
  db.prepare(`
    INSERT INTO workflow_tasks (
      id,instance_id,node_id,node_type,title,description,assignee_id,
      assignee_role,status,comment
    ) VALUES (
      @id,@instanceId,'approve','approval','Approve campaign',
      'Campaign schema behavior task',@assigneeId,@assigneeRole,@status,''
    )
  `).run({ id, instanceId, assigneeId, assigneeRole, status });
  return id;
}

function seedWorkflowContext(db, {
  campaignId = 601,
  eventLabel = 'workflow-root-event',
  templateId = 901,
  dispatchId = 1001
} = {}) {
  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context, { id: campaignId });
  const eventId = insertCampaignCreatedEvent(db, context, campaign, eventLabel);
  const template = insertWorkflowTemplate(db, context.actor.userId, { id: templateId });
  const dispatch = insertWorkflowDispatch(db, {
    id: dispatchId,
    campaign,
    eventId,
    template
  });
  return { context, campaign, eventId, template, dispatch };
}

function insertLinkAlias(db, {
  orgId,
  campaignId,
  userId,
  recordType,
  recordId,
  relationType,
  bundleId,
  metadata = {}
}) {
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    orgId,
    campaignId,
    recordType,
    bundleId,
    String(recordId),
    relationType,
    userId,
    JSON.stringify(metadata)
  );
  return Number(result.lastInsertRowid);
}

function revokeCampaignLinks(db, linkIds, userId, reason = 'Behavior correction') {
  const revoke = db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at='2099-01-02 00:00:00',revoked_by=?,revoke_reason=?
    WHERE id=?
  `);
  const dependencyOrder = new Map([
    ['settlement', 0],
    ['publication', 1],
    ['execution', 2],
    ['order', 3]
  ]);
  const orderedLinks = linkIds
    .map((linkId) => db.prepare(`
      SELECT id,relation_type
      FROM campaign_record_links
      WHERE id=?
    `).get(linkId))
    .sort((left, right) => (
      (dependencyOrder.get(left.relation_type) ?? 10) -
      (dependencyOrder.get(right.relation_type) ?? 10)
    ));
  for (const link of orderedLinks) revoke.run(userId, reason, link.id);
}

function insertUnclassifiedKnowledge(db, {
  entryId = 702,
  chunkId = 802,
  userId
}) {
  const content = `Unclassified knowledge ${entryId}`;
  db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      title,summary,tags_json,visibility,metadata_json,
      source_identity_sha256,content_sha256
    ) VALUES (
      @entryId,'note','manual',@sourceId,'unclassified',@content,@userId,0,
      'Unclassified behavior knowledge','Mutable before campaign classification',
      '["unclassified"]','team','{}',@sourceIdentitySha256,@contentSha256
    )
  `).run({
    entryId,
    sourceId: `manual-${entryId}`,
    content,
    userId,
    sourceIdentitySha256: sha256(`unclassified-source:${entryId}`),
    contentSha256: sha256(content)
  });
  db.prepare(`
    INSERT INTO knowledge_chunks (
      id,entry_id,chunk_index,content,metadata_json,token_count,content_sha256
    ) VALUES (@chunkId,@entryId,0,@content,'{}',3,@contentSha256)
  `).run({
    chunkId,
    entryId,
    content,
    contentSha256: sha256(`unclassified-chunk:${content}`)
  });
  return { entryId, chunkId };
}

test('composite foreign keys isolate organization, team, opportunity, and campaign scopes', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const secondScope = insertOrganizationScope(db, context.actor.userId);
  const organizationSnapshot = () => db.prepare(`
    SELECT id,code,name,created_at
    FROM organizations
    WHERE id IN (?,?)
    ORDER BY id
  `).all(context.actor.orgId, secondScope.orgId);
  const beforeReplaceAttempts = organizationSnapshot();
  db.pragma('recursive_triggers = OFF');
  try {
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO organizations
        SELECT *
        FROM organizations
        WHERE id=?
      `).run(context.actor.orgId),
      /organization cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        REPLACE INTO organizations (id,code,name,created_at)
        SELECT 9000,code,'Replacement organization',created_at
        FROM organizations
        WHERE id=?
      `).run(secondScope.orgId),
      /organization cannot be replaced/
    );
  } finally {
    db.pragma('recursive_triggers = ON');
  }
  assert.deepEqual(organizationSnapshot(), beforeReplaceAttempts);

  db.prepare(`
    INSERT INTO customers (id,brand_name,stage,source,created_by,assigned_to)
    VALUES (102,'Other Customer','qualified','schema-test',?,?)
  `).run(context.actor.userId, context.actor.userId);

  assert.throws(
    () => insertCampaign(db, context, {
      id: 610,
      customerId: 102,
      opportunityId: context.opportunityId
    }),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => insertCampaign(db, context, {
      id: 611,
      orgId: secondScope.orgId,
      ownerUserId: secondScope.userId,
      teamId: context.actor.teamId
    }),
    /FOREIGN KEY constraint failed/
  );

  const firstCampaign = insertCampaign(db, context);
  insertCampaign(db, context, {
    id: 602,
    orgId: secondScope.orgId,
    ownerUserId: secondScope.userId,
    teamId: secondScope.teamId,
    name: 'Second Scope Campaign'
  });

  assert.throws(
    () => insertLinkBundle(db, {
      label: 'cross-org-link',
      orgId: secondScope.orgId,
      campaignId: firstCampaign.id,
      userId: secondScope.userId,
      recordType: 'influencer',
      recordId: context.influencerId,
      relationTypes: ['shortlist']
    }),
    /FOREIGN KEY constraint failed/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_record_links').get().count, 0);
  assertDatabaseHealthy(db);
});

test('triggers reject illegal event states and cross-campaign business references', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const firstCampaign = insertCampaign(db, context);
  const secondCampaign = insertCampaign(db, context, {
    id: 602,
    name: 'Reference Boundary Campaign'
  });

  const fingerprint = reserveCampaignEvent(db, {
    label: 'invalid-lifecycle-shape',
    scope: 'campaign.transition',
    campaignId: firstCampaign.id,
    orgId: firstCampaign.orgId,
    userId: context.actor.userId
  });
  assert.throws(
    () => insertCampaignEventRow(db, {
      label: 'invalid-lifecycle-shape',
      orgId: firstCampaign.orgId,
      campaignId: firstCampaign.id,
      actorUserId: context.actor.userId,
      eventType: 'lifecycle_transition',
      previousState: null,
      nextState: 'qualified',
      reason: 'Missing previous state',
      source: 'project_workspace',
      metadata: { previous_version: 1, next_version: 2 },
      auditFingerprint: fingerprint
    }),
    /invalid campaign event source or state shape/
  );

  const collaborationBundle = insertLinkBundle(db, {
    label: 'owned-collaboration',
    orgId: firstCampaign.orgId,
    campaignId: firstCampaign.id,
    userId: context.actor.userId,
    recordType: 'collaboration',
    recordId: context.collaborationId,
    relationTypes: ['order', 'execution', 'publication', 'settlement']
  });
  assert.equal(collaborationBundle.linkIds.length, 4);
  assert.throws(
    () => insertLinkBundle(db, {
      label: 'cross-campaign-collaboration',
      orgId: secondCampaign.orgId,
      campaignId: secondCampaign.id,
      userId: context.actor.userId,
      recordType: 'collaboration',
      recordId: context.collaborationId,
      relationTypes: ['execution']
    }),
    /active record already belongs to another campaign/
  );

  db.prepare(`
    UPDATE campaigns
    SET lifecycle_state='settled',row_version=2
    WHERE id=?
  `).run(firstCampaign.id);
  assert.throws(
    () => db.prepare(`
      UPDATE collaborations
      SET cost_actual=cost_actual+1,cost_actual_confirmed=0
      WHERE id=?
    `).run(context.collaborationId),
    /settled campaign collaboration cost must remain confirmed/
  );

  const reviewEntryId = insertReviewEvidence(db, {
    campaignId: firstCampaign.id,
    settledEventId: 91,
    userId: context.actor.userId
  });
  assert.throws(
    () => insertLinkBundle(db, {
      label: 'cross-campaign-review',
      orgId: secondCampaign.orgId,
      campaignId: secondCampaign.id,
      userId: context.actor.userId,
      recordType: 'knowledge_entry',
      recordId: reviewEntryId,
      relationTypes: ['review'],
      metadata: { settled_event_id: 91 }
    }),
    /campaign review evidence cannot move across campaigns/
  );
  assertDatabaseHealthy(db);
});

test('legal campaign project influencer order expense and review path persists end to end', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context);

  insertAuditedCampaignEvent(db, {
    label: 'campaign-created',
    scope: 'campaign.create',
    campaign,
    actorUserId: context.actor.userId,
    eventType: 'campaign_created',
    nextState: 'lead',
    reason: 'Campaign created',
    source: 'campaign_api',
    metadata: {
      customer_id: context.customerId,
      opportunity_id: context.opportunityId,
      owner_user_id: context.actor.userId,
      team_id: context.actor.teamId,
      row_version: 1
    }
  });

  const demandBundle = insertLinkBundle(db, {
    label: 'main-demand',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'demand',
    recordId: context.demandId,
    relationTypes: ['demand']
  });
  insertLinkAttachmentEvent(db, {
    label: 'main-demand-event',
    scope: 'demand.create.linked',
    source: 'demand_link',
    reason: 'Linked demand',
    campaign,
    actorUserId: context.actor.userId,
    bundle: demandBundle
  });

  const proposalBundle = insertLinkBundle(db, {
    label: 'main-proposal',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'proposal',
    recordId: context.proposalId,
    relationTypes: ['proposal']
  });
  insertLinkAttachmentEvent(db, {
    label: 'main-proposal-event',
    scope: 'proposal.create.linked',
    source: 'proposal_link',
    reason: 'Linked proposal',
    campaign,
    actorUserId: context.actor.userId,
    bundle: proposalBundle
  });

  const influencerBundle = insertLinkBundle(db, {
    label: 'main-influencer',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'influencer',
    recordId: context.influencerId,
    relationTypes: ['shortlist']
  });
  insertLinkAttachmentEvent(db, {
    label: 'main-influencer-event',
    scope: 'campaign.link.attach',
    source: 'project_workspace',
    reason: 'Shortlisted influencer',
    campaign,
    actorUserId: context.actor.userId,
    bundle: influencerBundle
  });

  const collaborationBundle = insertLinkBundle(db, {
    label: 'main-collaboration',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'collaboration',
    recordId: context.collaborationId,
    relationTypes: ['order', 'execution', 'publication', 'settlement']
  });
  insertLinkAttachmentEvent(db, {
    label: 'main-collaboration-event',
    scope: 'collaboration.create.linked',
    source: 'collaboration_link',
    reason: 'Linked order',
    campaign,
    actorUserId: context.actor.userId,
    bundle: collaborationBundle
  });

  const settledEventId = insertAuditedCampaignEvent(db, {
    label: 'campaign-settled',
    scope: 'campaign.transition',
    campaign,
    actorUserId: context.actor.userId,
    eventType: 'lifecycle_transition',
    previousState: 'lead',
    nextState: 'settled',
    reason: 'Delivery and expense confirmed',
    source: 'project_workspace',
    metadata: { previous_version: 1, next_version: 2 }
  });
  db.prepare(`
    UPDATE campaigns
    SET lifecycle_state='settled',row_version=2,updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(campaign.id);
  db.prepare(`
    UPDATE collaborations
    SET cost_actual=2300,cost_actual_confirmed=1,row_version=row_version+1
    WHERE id=?
  `).run(context.collaborationId);

  const reviewEntryId = insertReviewEvidence(db, {
    campaignId: campaign.id,
    settledEventId,
    userId: context.actor.userId
  });
  const reviewBundle = insertLinkBundle(db, {
    label: 'main-review',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'knowledge_entry',
    recordId: reviewEntryId,
    relationTypes: ['review'],
    metadata: { settled_event_id: settledEventId }
  });
  insertLinkAttachmentEvent(db, {
    label: 'main-review-event',
    scope: 'campaign.review.create',
    source: 'campaign_review',
    reason: 'Campaign reviewed',
    campaign,
    actorUserId: context.actor.userId,
    bundle: reviewBundle
  });

  insertAuditedCampaignEvent(db, {
    label: 'campaign-reviewed',
    scope: 'campaign.transition',
    campaign,
    actorUserId: context.actor.userId,
    eventType: 'lifecycle_transition',
    previousState: 'settled',
    nextState: 'reviewed',
    reason: 'Review evidence archived',
    source: 'project_workspace',
    metadata: { previous_version: 2, next_version: 3 }
  });
  db.prepare(`
    UPDATE campaigns
    SET lifecycle_state='reviewed',row_version=3,updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(campaign.id);

  assert.deepEqual(
    db.prepare(`
      SELECT lifecycle_state,row_version,operational_status
      FROM campaigns
      WHERE id=?
    `).get(campaign.id),
    { lifecycle_state: 'reviewed', row_version: 3, operational_status: 'active' }
  );
  assert.deepEqual(
    db.prepare(`
      SELECT relation_type
      FROM campaign_record_links
      WHERE campaign_id=? AND revoked_at IS NULL
      ORDER BY relation_type
    `).all(campaign.id).map((row) => row.relation_type),
    ['demand', 'execution', 'order', 'proposal', 'publication', 'review', 'settlement', 'shortlist']
  );
  assert.deepEqual(
    db.prepare(`
      SELECT cost_actual,cost_actual_confirmed,row_version
      FROM collaborations
      WHERE id=?
    `).get(context.collaborationId),
    { cost_actual: 2300, cost_actual_confirmed: 1, row_version: 2 }
  );
  assert.deepEqual(
    db.prepare(`
      SELECT entry_type,source_type,source_id,business_type,business_id
      FROM knowledge_entries
      WHERE id=?
    `).get(reviewEntryId),
    {
      entry_type: 'campaign_review',
      source_type: 'campaign_review',
      source_id: `${campaign.id}:${settledEventId}`,
      business_type: 'campaign',
      business_id: String(campaign.id)
    }
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?')
      .get(campaign.id).count,
    8
  );
  assertDatabaseHealthy(db);
});

test('unique active links and append-only evidence enforce update and delete policy', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context);
  const eventId = insertAuditedCampaignEvent(db, {
    label: 'policy-campaign-created',
    scope: 'campaign.create',
    campaign,
    actorUserId: context.actor.userId,
    eventType: 'campaign_created',
    nextState: 'lead',
    reason: 'Campaign created',
    source: 'campaign_api',
    metadata: {
      customer_id: context.customerId,
      opportunity_id: context.opportunityId,
      owner_user_id: context.actor.userId,
      team_id: context.actor.teamId,
      row_version: 1
    }
  });
  const original = insertLinkBundle(db, {
    label: 'policy-original-link',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'influencer',
    recordId: context.influencerId,
    relationTypes: ['shortlist']
  });
  const replaceFingerprint = reserveCampaignEvent(db, {
    label: 'policy-replace-event',
    scope: 'campaign.operational',
    campaignId: campaign.id,
    orgId: campaign.orgId,
    userId: context.actor.userId
  });

  db.pragma('recursive_triggers = OFF');
  assert.throws(
    () => db.prepare(`
      INSERT OR REPLACE INTO campaign_record_links (
        id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json,created_at,revoked_at,revoked_by,revoke_reason
      )
      SELECT
        id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,'{"tampered":true}',created_at,revoked_at,revoked_by,revoke_reason
      FROM campaign_record_links
      WHERE id=?
    `).run(original.linkIds[0]),
    /campaign link bundle identity is invalid/
  );
  assert.throws(
    () => db.prepare(`
      REPLACE INTO campaign_events (
        id,org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
        reason,source,metadata_json,correlation_id,audit_fingerprint,created_at
      ) VALUES (
        ?,?,?,'operational_status_changed',NULL,NULL,?,
        'Campaign placed on hold','project_workspace',?,
        'tampered-correlation',?,CURRENT_TIMESTAMP
      )
    `).run(
      eventId,
      campaign.orgId,
      campaign.id,
      context.actor.userId,
      JSON.stringify({
        previous_status: 'active',
        next_status: 'on_hold',
        previous_version: 1,
        next_version: 2
      }),
      replaceFingerprint
    ),
    /campaign_events are append-only/
  );
  db.pragma('recursive_triggers = ON');

  assert.throws(
    () => insertLinkAlias(db, {
      orgId: campaign.orgId,
      campaignId: campaign.id,
      userId: context.actor.userId,
      recordType: 'influencer',
      recordId: context.influencerId,
      relationType: 'shortlist',
      bundleId: original.bundleId
    }),
    /campaign link bundle identity is invalid/
  );
  assert.throws(
    () => db.prepare('UPDATE campaign_events SET reason=? WHERE id=?')
      .run('Rewritten evidence', eventId),
    /campaign_events are append-only/
  );
  assert.throws(
    () => db.prepare('DELETE FROM campaign_events WHERE id=?').run(eventId),
    /campaign_events are append-only/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE campaign_record_links
      SET metadata_json='{"rewritten":true}'
      WHERE id=?
    `).run(original.linkIds[0]),
    /campaign links are immutable except revocation/
  );
  assert.throws(
    () => db.prepare('DELETE FROM campaign_record_links WHERE id=?')
      .run(original.linkIds[0]),
    /campaign links cannot be deleted/
  );
  assert.throws(
    () => db.prepare('UPDATE campaigns SET id=999 WHERE id=?').run(campaign.id),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => db.prepare('DELETE FROM campaigns WHERE id=?').run(campaign.id),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE organizations
      SET code='rewritten-default'
      WHERE code='turingmarket-default'
    `).run(),
    /organization code is immutable/
  );
  assert.throws(
    () => db.prepare(`
      DELETE FROM organizations
      WHERE code='turingmarket-default'
    `).run(),
    /default organization is required/
  );

  db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at='2099-01-02 00:00:00',revoked_by=?,revoke_reason='Replaced shortlist'
    WHERE id=?
  `).run(context.actor.userId, original.linkIds[0]);
  const replacement = insertLinkBundle(db, {
    label: 'policy-replacement-link',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'influencer',
    recordId: context.influencerId,
    relationTypes: ['shortlist']
  });

  assert.equal(replacement.linkIds.length, 1);
  assert.deepEqual(
    db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active
      FROM campaign_record_links
      WHERE campaign_id=? AND record_type='influencer' AND record_id=?
    `).get(campaign.id, String(context.influencerId)),
    { total: 2, active: 1 }
  );
  assertDatabaseHealthy(db);
});

test('trigger failure rolls back the complete campaign transaction', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const before = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM campaigns) AS campaigns,
      (SELECT COUNT(*) FROM campaign_record_links) AS links,
      (SELECT COUNT(*) FROM request_idempotency) AS requests,
      (SELECT COUNT(*) FROM campaign_events) AS events
  `).get();

  const writeCampaign = db.transaction(() => {
    const campaign = insertCampaign(db, context, {
      id: 777,
      name: 'Rollback Campaign'
    });
    insertLinkBundle(db, {
      label: 'rollback-link',
      orgId: campaign.orgId,
      campaignId: campaign.id,
      userId: context.actor.userId,
      recordType: 'influencer',
      recordId: context.influencerId,
      relationTypes: ['shortlist']
    });
    const auditFingerprint = reserveCampaignEvent(db, {
      label: 'rollback-invalid-event',
      scope: 'campaign.transition',
      campaignId: campaign.id,
      orgId: campaign.orgId,
      userId: context.actor.userId
    });
    insertCampaignEventRow(db, {
      label: 'rollback-invalid-event',
      orgId: campaign.orgId,
      campaignId: campaign.id,
      actorUserId: context.actor.userId,
      eventType: 'lifecycle_transition',
      previousState: null,
      nextState: 'qualified',
      reason: 'Force transaction rollback',
      source: 'project_workspace',
      metadata: { previous_version: 1, next_version: 2 },
      auditFingerprint
    });
  });

  assert.throws(
    () => writeCampaign(),
    /invalid campaign event source or state shape/
  );
  assert.equal(db.inTransaction, false);
  assert.deepEqual(
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM campaigns) AS campaigns,
        (SELECT COUNT(*) FROM campaign_record_links) AS links,
        (SELECT COUNT(*) FROM request_idempotency) AS requests,
        (SELECT COUNT(*) FROM campaign_events) AS events
    `).get(),
    before
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM campaigns WHERE id=777').get().count,
    0
  );
  assertDatabaseHealthy(db);
});

test('managed-v2 STRICT tables reject unsafe INTEGER storage while preserving lossless affinity', (t) => {
  const db = openCampaignDatabase(t);
  const domainTables = [
    'organizations',
    'organization_memberships',
    'teams',
    'team_memberships',
    'campaigns',
    'campaign_events',
    'campaign_record_links',
    'campaign_workflow_dispatches',
    'request_idempotency'
  ];
  const tableList = new Map(
    db.pragma('table_list')
      .filter((row) => row.schema === 'main')
      .map((row) => [row.name, row])
  );
  for (const tableName of domainTables) {
    assert.equal(tableList.get(tableName)?.strict, 1, `${tableName} must be STRICT`);
  }

  const textTemporalColumns = {
    organizations: ['created_at'],
    organization_memberships: ['created_at', 'revoked_at'],
    teams: ['created_at'],
    team_memberships: ['created_at', 'revoked_at'],
    campaigns: ['start_date', 'end_date', 'created_at', 'updated_at'],
    campaign_events: ['created_at'],
    campaign_record_links: ['created_at', 'revoked_at'],
    campaign_workflow_dispatches: [
      'lease_until',
      'next_attempt_at',
      'created_at',
      'updated_at'
    ],
    request_idempotency: [
      'lease_until',
      'created_at',
      'updated_at',
      'operation_deadline',
      'expires_at'
    ]
  };
  for (const [tableName, columnNames] of Object.entries(textTemporalColumns)) {
    const declaredTypes = new Map(
      db.pragma(`table_info(${JSON.stringify(tableName)})`)
        .map((column) => [column.name, column.type])
    );
    for (const columnName of columnNames) {
      assert.equal(
        declaredTypes.get(columnName),
        'TEXT',
        `${tableName}.${columnName} must use TEXT storage`
      );
    }
  }

  const insertOrganization = db.prepare(`
    INSERT INTO organizations (id,code,name,created_at)
    VALUES (?,?,?,'2026-07-01 00:00:00')
  `);
  insertOrganization.run('2', 'affinity-string-id', 'String Affinity');
  insertOrganization.run(3.0, 'affinity-real-id', 'Integral Real Affinity');
  assert.deepEqual(
    db.prepare(`
      SELECT id,typeof(id) AS id_type,typeof(created_at) AS created_at_type
      FROM organizations
      WHERE id IN (2,3)
      ORDER BY id
    `).all(),
    [
      { id: 2, id_type: 'integer', created_at_type: 'text' },
      { id: 3, id_type: 'integer', created_at_type: 'text' }
    ]
  );

  const invalidOrganizationIds = [
    { value: 3.5, label: 'lossy-real' },
    { value: '9007199254740992', label: 'unsafe-integer' },
    { value: Buffer.from([0x04]), label: 'blob-id' }
  ];
  for (const [index, invalid] of invalidOrganizationIds.entries()) {
    assert.throws(
      () => insertOrganization.run(
        invalid.value,
        `invalid-org-${index}`,
        invalid.label
      ),
      /cannot store|CHECK constraint failed|datatype mismatch/
    );
  }

  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context, {
    id: '601',
    rowVersion: 3.0
  });
  assert.deepEqual(
    db.prepare(`
      SELECT id,typeof(id) AS id_type,row_version,
        typeof(row_version) AS row_version_type
      FROM campaigns
      WHERE id=601
    `).get(),
    { id: 601, id_type: 'integer', row_version: 3, row_version_type: 'integer' }
  );
  for (const invalidVersion of [
    3.5,
    '9007199254740992',
    Buffer.from([0x01])
  ]) {
    assert.throws(
      () => db.prepare('UPDATE campaigns SET row_version=? WHERE id=601')
        .run(invalidVersion),
      /cannot store|CHECK constraint failed/
    );
  }

  const request = insertRequestRecord(db, {
    label: 'strict-storage-request',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'campaign.transition',
    expectedEventCount: 1
  });
  assert.deepEqual(
    db.prepare(`
      SELECT typeof(id) AS id_type,typeof(org_id) AS org_id_type,
        typeof(campaign_id) AS campaign_id_type,
        typeof(expected_event_count) AS event_count_type
      FROM request_idempotency
      WHERE id=?
    `).get(request.id),
    {
      id_type: 'integer',
      org_id_type: 'integer',
      campaign_id_type: 'integer',
      event_count_type: 'integer'
    }
  );
  assertDatabaseHealthy(db);
});

test('identity events have canonical nine-key shape and all activity rows are append-only', (t) => {
  const db = openCampaignDatabase(t);
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM organization_memberships) AS organization_memberships,
      (SELECT COUNT(*) FROM team_memberships) AS team_memberships,
      (SELECT COUNT(*) FROM activity_log
        WHERE module='identity' AND action='identity_state_changed') AS identity_events
  `).get();
  assert.equal(counts.organization_memberships, counts.users);
  assert.equal(counts.team_memberships, counts.users);
  assert.equal(counts.identity_events, counts.users);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM activity_log
      WHERE module='identity'
        AND (
          json_valid(details)=0
          OR json_type(details)<>'object'
          OR (SELECT COUNT(*) FROM json_each(details))<>9
          OR json_type(details,'$.schema_version')<>'integer'
          OR json_extract(details,'$.schema_version')<>1
          OR json_type(details,'$.subject_user_id')<>'integer'
          OR json_type(details,'$.organization_id')<>'integer'
          OR json_type(details,'$.changed_fields')<>'array'
        )
    `).get().count,
    0
  );

  const actor = db.prepare(`
    SELECT org_id,user_id
    FROM organization_memberships
    WHERE status='active'
    ORDER BY user_id
    LIMIT 1
  `).get();
  const subject = db.prepare(`
    SELECT user_id
    FROM organization_memberships
    WHERE org_id=? AND status='active' AND user_id<>?
    ORDER BY user_id
    LIMIT 1
  `).get(actor.org_id, actor.user_id);
  assert.ok(subject);
  const validDetails = {
    schema_version: 1,
    actor_user_id: actor.user_id,
    subject_user_id: subject.user_id,
    organization_id: actor.org_id,
    reason: 'behavior_identity_change',
    request_id: 'identity-request-001',
    changed_fields: ['status'],
    before: { status: 'active' },
    after: { status: 'revoked' }
  };
  const insertActivity = db.prepare(`
    INSERT INTO activity_log (user_id,action,module,details,created_at)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP)
  `);
  const result = insertActivity.run(
    subject.user_id,
    'identity_state_changed',
    'identity',
    JSON.stringify(validDetails)
  );
  const eventId = Number(result.lastInsertRowid);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM json_each((SELECT details FROM activity_log WHERE id=?))
    `).get(eventId).count,
    9
  );
  db.pragma('recursive_triggers = OFF');
  assert.throws(
    () => db.prepare(`
      INSERT OR REPLACE INTO activity_log (
        id,user_id,action,module,details,created_at
      )
      SELECT id,user_id,action,module,?,created_at
      FROM activity_log
      WHERE id=?
    `).run(
      JSON.stringify({ ...validDetails, reason: 'replacement_tamper' }),
      eventId
    ),
    /activity_log is append-only/
  );
  db.pragma('recursive_triggers = ON');

  const missingKey = { ...validDetails };
  delete missingKey.after;
  assert.throws(
    () => insertActivity.run(
      subject.user_id,
      'identity_state_changed',
      'identity',
      JSON.stringify(missingKey)
    ),
    /invalid identity audit event/
  );
  assert.throws(
    () => insertActivity.run(
      subject.user_id,
      'identity_state_changed',
      'identity',
      JSON.stringify({ ...validDetails, subject_user_id: String(subject.user_id) })
    ),
    /invalid identity audit event/
  );
  const duplicateKeyJson = JSON.stringify(validDetails).replace(
    '"schema_version":1',
    '"schema_version":1,"schema_version":1'
  );
  assert.throws(
    () => insertActivity.run(
      subject.user_id,
      'identity_state_changed',
      'identity',
      duplicateKeyJson
    ),
    /invalid identity audit event/
  );
  assert.throws(
    () => insertActivity.run(
      subject.user_id,
      'identity_changed',
      'identity',
      JSON.stringify(validDetails)
    ),
    /invalid identity audit event/
  );
  assert.throws(
    () => db.prepare('UPDATE activity_log SET details=? WHERE id=?')
      .run(JSON.stringify({ ...validDetails, reason: 'rewrite' }), eventId),
    /activity_log is append-only/
  );
  assert.throws(
    () => db.prepare('DELETE FROM activity_log WHERE id=?').run(eventId),
    /activity_log is append-only/
  );
  assertDatabaseHealthy(db);
});

test('campaign event provenance rejects missing expired terminal and cross-campaign reservations', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context);
  const otherCampaign = insertCampaign(db, context, {
    id: 602,
    name: 'Event Provenance Boundary'
  });
  const eventShape = {
    label: 'provenance-event',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    actorUserId: context.actor.userId,
    eventType: 'lifecycle_transition',
    previousState: 'lead',
    nextState: 'qualified',
    reason: 'Qualified by behavior test',
    source: 'project_workspace',
    metadata: { previous_version: 1, next_version: 2 }
  };

  assert.throws(
    () => insertCampaignEventRow(db, {
      ...eventShape,
      label: 'missing-reservation',
      auditFingerprint: sha256('missing-reservation')
    }),
    /campaign event request fingerprint is not reserved/
  );

  const expired = insertRequestRecord(db, {
    label: 'expired-reservation',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'campaign.transition',
    expectedEventCount: 1,
    leaseUntil: sqliteDate(db, '-1 hour')
  });
  assert.throws(
    () => insertCampaignEventRow(db, {
      ...eventShape,
      label: 'expired-reservation',
      auditFingerprint: expired.auditFingerprint
    }),
    /campaign event request fingerprint is not reserved/
  );

  const terminal = insertRequestRecord(db, {
    label: 'terminal-reservation',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'campaign.transition',
    expectedEventCount: 1,
    state: 'completed',
    statusCode: 409,
    responseKind: 'json',
    responseJson: '{"error":"terminal"}',
    responseHeadersJson: '{"Content-Type":"application/json"}'
  });
  assert.throws(
    () => insertCampaignEventRow(db, {
      ...eventShape,
      label: 'terminal-reservation',
      auditFingerprint: terminal.auditFingerprint
    }),
    /campaign event request fingerprint is not reserved/
  );

  const wrongCampaign = insertRequestRecord(db, {
    label: 'cross-campaign-reservation',
    orgId: otherCampaign.orgId,
    userId: context.actor.userId,
    campaignId: otherCampaign.id,
    scope: 'campaign.transition',
    expectedEventCount: 1
  });
  assert.throws(
    () => insertCampaignEventRow(db, {
      ...eventShape,
      label: 'cross-campaign-reservation',
      auditFingerprint: wrongCampaign.auditFingerprint
    }),
    /campaign event request fingerprint is not reserved/
  );

  const valid = insertRequestRecord(db, {
    label: 'valid-provenance-reservation',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'campaign.transition',
    expectedEventCount: 1
  });
  for (const correlationId of [
    'short',
    'behavior-control\n',
    'behavior-nonascii-é',
    'x'.repeat(121)
  ]) {
    assert.throws(
      () => insertCampaignEventRow(db, {
        ...eventShape,
        label: 'valid-provenance-reservation',
        auditFingerprint: valid.auditFingerprint,
        correlationId
      }),
      /CHECK constraint failed/
    );
  }
  const eventId = insertCampaignEventRow(db, {
    ...eventShape,
    label: 'valid-provenance-reservation',
    auditFingerprint: valid.auditFingerprint
  });
  assert.ok(eventId > 0);
  assert.equal(completeJsonRequest(db, valid.id, 200).changes, 1);
  assert.equal(
    db.prepare('SELECT state FROM request_idempotency WHERE id=?').get(valid.id).state,
    'completed'
  );
  assertDatabaseHealthy(db);
});

test('campaign record_id rejects noncanonical and unsafe identifiers at the database boundary', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context);
  const insert = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?, 'influencer', ?, ?, 'shortlist', ?, '{}')
  `);
  const invalidRecordIds = [
    0,
    '07',
    '+7',
    '7.0',
    7.5,
    '-7',
    '9007199254740992',
    '9223372036854775808',
    Buffer.from('7')
  ];
  for (const [index, recordId] of invalidRecordIds.entries()) {
    assert.throws(
      () => insert.run(
        campaign.orgId,
        campaign.id,
        sha256(`invalid-record-id:${index}`),
        recordId,
        context.actor.userId
      ),
      /CHECK constraint failed|cannot store BLOB/
    );
  }

  insert.run(
    campaign.orgId,
    campaign.id,
    sha256('canonical-record-id:7'),
    '7',
    context.actor.userId
  );
  insert.run(
    campaign.orgId,
    campaign.id,
    sha256('canonical-record-id:max'),
    '9007199254740991',
    context.actor.userId
  );
  assert.deepEqual(
    db.prepare(`
      SELECT record_id,typeof(record_id) AS record_id_type
      FROM campaign_record_links
      ORDER BY id
    `).all(),
    [
      { record_id: '7', record_id_type: 'text' },
      { record_id: '9007199254740991', record_id_type: 'text' }
    ]
  );
  assertDatabaseHealthy(db);
});

test('campaign workflow task assignments require pending state real change and one-step versioning', (t) => {
  const db = openCampaignDatabase(t);
  const {
    context,
    campaign,
    eventId,
    template,
    dispatch
  } = seedWorkflowContext(db, { eventLabel: 'task-assignment-root' });
  const instanceId = insertCampaignWorkflowInstance(db, {
    campaign,
    eventId,
    dispatch,
    template,
    startedBy: context.actor.userId
  });
  const taskId = insertCampaignWorkflowTask(db, {
    instanceId,
    assigneeId: context.actor.userId
  });
  db.pragma('recursive_triggers = OFF');
  assert.throws(
    () => db.prepare(`
      REPLACE INTO workflow_tasks
      SELECT *
      FROM workflow_tasks
      WHERE id=?
    `).run(taskId),
    /campaign workflow task cannot be replaced/
  );
  db.pragma('recursive_triggers = ON');
  assert.deepEqual(
    db.prepare(`
      SELECT assignment_version,typeof(assignment_version) AS version_type
      FROM workflow_tasks
      WHERE id=?
    `).get(taskId),
    { assignment_version: 1, version_type: 'integer' }
  );
  assert.throws(
    () => insertCampaignWorkflowInstance(db, {
      id: 1102,
      campaign,
      eventId,
      dispatch,
      template,
      startedBy: context.actor.userId
    }),
    /campaign workflow instance cannot be replaced/
  );

  const otherUser = db.prepare(`
    SELECT id
    FROM users
    WHERE id<>? AND is_active=1
    ORDER BY id
    LIMIT 1
  `).get(context.actor.userId);
  assert.ok(otherUser);
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_tasks
      SET assignee_id=?,assignment_version=1
      WHERE id=?
    `).run(otherUser.id, taskId),
    /invalid campaign workflow task reassignment/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_tasks
      SET assignment_version=2
      WHERE id=?
    `).run(taskId),
    /invalid campaign workflow task reassignment/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_tasks
      SET assignee_id=NULL,assignee_role=NULL,assignment_version=2
      WHERE id=?
    `).run(taskId),
    /invalid campaign workflow task reassignment/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_tasks
      SET assignee_id=?,assignee_role='external',assignment_version=2
      WHERE id=?
    `).run(otherUser.id, taskId),
    /invalid campaign workflow task reassignment/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_tasks
      SET assignee_id=?,assignment_version=2.5
      WHERE id=?
    `).run(otherUser.id, taskId),
    /invalid campaign workflow task reassignment|CHECK constraint failed/
  );

  assert.equal(
    db.prepare(`
      UPDATE workflow_tasks
      SET assignee_id=?,assignee_role='member',assignment_version=2
      WHERE id=?
    `).run(otherUser.id, taskId).changes,
    1
  );
  assert.deepEqual(
    db.prepare(`
      SELECT assignee_id,assignee_role,assignment_version,
        typeof(assignment_version) AS version_type
      FROM workflow_tasks
      WHERE id=?
    `).get(taskId),
    {
      assignee_id: otherUser.id,
      assignee_role: 'member',
      assignment_version: 2,
      version_type: 'integer'
    }
  );

  db.prepare("UPDATE workflow_tasks SET status='completed' WHERE id=?").run(taskId);
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_tasks
      SET assignee_id=?,assignment_version=3
      WHERE id=?
    `).run(context.actor.userId, taskId),
    /invalid campaign workflow task reassignment/
  );
  assertDatabaseHealthy(db);
});

test('campaign workflow instances accept coherent terminal states and reject incoherent execution fields', (t) => {
  const db = openCampaignDatabase(t);
  const {
    context,
    campaign,
    eventId,
    template,
    dispatch
  } = seedWorkflowContext(db, { eventLabel: 'instance-state-root' });
  const instanceId = insertCampaignWorkflowInstance(db, {
    campaign,
    eventId,
    dispatch,
    template,
    startedBy: context.actor.userId
  });
  const unscopedInstanceId = 1200;
  db.prepare(`
    INSERT INTO workflow_instances (
      id,template_id,business_type,business_id,status,node_data,started_by
    ) VALUES (?,?,'customer',?,'active','{}',?)
  `).run(
    unscopedInstanceId,
    template.id,
    context.customerId,
    context.actor.userId
  );
  const unscopedSnapshot = db.prepare(`
    SELECT *
    FROM workflow_instances
    WHERE id=?
  `).get(unscopedInstanceId);
  db.pragma('recursive_triggers = OFF');
  try {
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO workflow_instances
        SELECT *
        FROM workflow_instances
        WHERE id=?
      `).run(instanceId),
      /campaign workflow instance cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        REPLACE INTO workflow_instances
        SELECT *
        FROM workflow_instances
        WHERE id=?
      `).run(unscopedInstanceId),
      /campaign workflow instance cannot be replaced/
    );
  } finally {
    db.pragma('recursive_triggers = ON');
  }
  assert.deepEqual(
    db.prepare('SELECT * FROM workflow_instances WHERE id=?').get(unscopedInstanceId),
    unscopedSnapshot
  );
  assert.deepEqual(
    db.prepare(`
      SELECT typeof(org_id) AS org_type,typeof(campaign_id) AS campaign_type,
        typeof(campaign_event_id) AS event_type,
        typeof(campaign_dispatch_id) AS dispatch_type,
        initialization_status,status
      FROM workflow_instances
      WHERE id=?
    `).get(instanceId),
    {
      org_type: 'integer',
      campaign_type: 'integer',
      event_type: 'integer',
      dispatch_type: 'integer',
      initialization_status: 'ready',
      status: 'active'
    }
  );

  for (const status of ['paused', 'completed', 'cancelled', 'active']) {
    assert.equal(
      db.prepare('UPDATE workflow_instances SET status=? WHERE id=?')
        .run(status, instanceId).changes,
      1
    );
  }
  assert.equal(
    db.prepare(`
      UPDATE workflow_instances
      SET status='failed_validation',execution_error_code='INVALID_GRAPH',
        execution_error='Workflow graph failed validation',
        execution_failed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(instanceId).changes,
    1
  );
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_instances
      SET status='active'
      WHERE id=?
    `).run(instanceId),
    /invalid campaign workflow execution state/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_instances
      SET execution_error=NULL
      WHERE id=?
    `).run(instanceId),
    /invalid campaign workflow execution state/
  );
  assert.equal(
    db.prepare(`
      UPDATE workflow_instances
      SET status='active',execution_error_code=NULL,execution_error=NULL,
        execution_failed_at=NULL
      WHERE id=?
    `).run(instanceId).changes,
    1
  );
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_instances
      SET status='pending'
      WHERE id=?
    `).run(instanceId),
    /invalid campaign workflow execution state/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_instances
      SET initialization_status='failed',initialization_error='not ready'
      WHERE id=?
    `).run(instanceId),
    /invalid campaign workflow execution state/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE workflow_instances
      SET business_id=?
      WHERE id=?
    `).run(campaign.id + 1, instanceId),
    /campaign workflow context is immutable/
  );
  assert.throws(
    () => insertCampaignWorkflowInstance(db, {
      id: 1102,
      campaign,
      eventId,
      dispatch,
      template,
      startedBy: context.actor.userId,
      status: 'pending'
    }),
    /invalid campaign workflow execution state/
  );
  assertDatabaseHealthy(db);
});

test('campaign workflow dispatches enforce initial claim heartbeat finalize and immutable evidence', (t) => {
  const db = openCampaignDatabase(t);
  const {
    context,
    campaign,
    eventId,
    template,
    dispatch
  } = seedWorkflowContext(db, { eventLabel: 'dispatch-state-root' });
  db.pragma('recursive_triggers = OFF');
  assert.throws(
    () => db.prepare(`
      REPLACE INTO campaign_workflow_dispatches
      SELECT *
      FROM campaign_workflow_dispatches
      WHERE id=?
    `).run(dispatch.id),
    /campaign workflow dispatches cannot be replaced/
  );
  db.pragma('recursive_triggers = ON');
  const invalidTemplate = insertWorkflowTemplate(db, context.actor.userId, {
    id: 902,
    name: 'Invalid Initial Dispatch Template'
  });
  assert.throws(
    () => insertWorkflowDispatch(db, {
      id: 1002,
      campaign,
      eventId,
      template: invalidTemplate,
      status: 'processing',
      attemptCount: 1,
      leaseUntil: sqliteDate(db, '+1 hour'),
      leaseToken: 'invalid-initial-token'
    }),
    /campaign workflow dispatch must start pending/
  );

  assert.throws(
    () => db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET status='processing',attempt_count=1,
        lease_until=datetime('now','+1 hour'),lease_token='dispatch-token-0001',
        template_checksum=?
      WHERE id=?
    `).run(sha256('mutated-template-evidence'), dispatch.id),
    /campaign workflow evidence is immutable/
  );
  assert.equal(
    db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET status='processing',attempt_count=1,
        lease_until=datetime('now','+1 hour'),lease_token='dispatch-token-0001',
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(dispatch.id).changes,
    1
  );
  assert.throws(
    () => db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET lease_until=datetime('now','+2 hours'),lease_token='dispatch-token-0002'
      WHERE id=?
    `).run(dispatch.id),
    /invalid campaign workflow dispatch transition/
  );
  assert.equal(
    db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET lease_until=datetime('now','+2 hours'),updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(dispatch.id).changes,
    1
  );

  const instanceId = insertCampaignWorkflowInstance(db, {
    campaign,
    eventId,
    dispatch,
    template,
    startedBy: context.actor.userId
  });
  assert.equal(
    db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET status='completed',workflow_instance_id=?,lease_until=NULL,
        lease_token=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(instanceId, dispatch.id).changes,
    1
  );
  assert.deepEqual(
    db.prepare(`
      SELECT status,attempt_count,workflow_instance_id,
        typeof(attempt_count) AS attempt_type
      FROM campaign_workflow_dispatches
      WHERE id=?
    `).get(dispatch.id),
    {
      status: 'completed',
      attempt_count: 1,
      workflow_instance_id: instanceId,
      attempt_type: 'integer'
    }
  );
  assert.throws(
    () => db.prepare('DELETE FROM campaign_workflow_dispatches WHERE id=?')
      .run(dispatch.id),
    /campaign workflow dispatches cannot be deleted/
  );

  const cancelTemplate = insertWorkflowTemplate(db, context.actor.userId, {
    id: 903,
    name: 'Cancellation Dispatch Template'
  });
  const cancelled = insertWorkflowDispatch(db, {
    id: 1003,
    campaign,
    eventId,
    template: cancelTemplate
  });
  assert.equal(
    db.prepare(`
      UPDATE campaign_workflow_dispatches
      SET status='cancelled',last_error_code='CAMPAIGN_CANCELLED',
        last_error='Campaign operation cancelled',updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(cancelled.id).changes,
    1
  );

  db.prepare(`
    UPDATE campaigns
    SET operational_status='on_hold'
    WHERE id=?
  `).run(campaign.id);
  const heldTemplate = insertWorkflowTemplate(db, context.actor.userId, {
    id: 904,
    name: 'Held Campaign Dispatch Template'
  });
  assert.throws(
    () => insertWorkflowDispatch(db, {
      id: 1004,
      campaign,
      eventId,
      template: heldTemplate
    }),
    /campaign workflow dispatch requires active campaign/
  );
  assertDatabaseHealthy(db);
});

test('settlement custody releases confirmed expense only after revocation and rejects cancelled aliases', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context);
  const collaborationBundle = insertLinkBundle(db, {
    label: 'settlement-custody',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'collaboration',
    recordId: context.collaborationId,
    relationTypes: ['order', 'execution', 'publication', 'settlement']
  });
  const collaborationSnapshot = () => db.prepare(`
    SELECT *
    FROM collaborations
    WHERE id=?
  `).get(context.collaborationId);
  const beforeReplaceAttempt = collaborationSnapshot();
  db.pragma('recursive_triggers = OFF');
  try {
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO collaborations
        SELECT *
        FROM collaborations
        WHERE id=?
      `).run(context.collaborationId),
      /campaign collaboration cannot be replaced/
    );
  } finally {
    db.pragma('recursive_triggers = ON');
  }
  assert.deepEqual(collaborationSnapshot(), beforeReplaceAttempt);
  assert.throws(
    () => db.prepare(`
      UPDATE collaborations
      SET status='live'
      WHERE id=?
    `).run(context.collaborationId),
    /published or settled collaboration must remain completed/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE collaborations
      SET status=NULL
      WHERE id=?
    `).run(context.collaborationId),
    /published or settled collaboration must remain completed/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE collaborations
      SET cost_actual_confirmed=0,row_version=row_version+1
      WHERE id=?
    `).run(context.collaborationId),
    /settled campaign collaboration cost must remain confirmed/
  );
  const orderLink = db.prepare(`
    SELECT id
    FROM campaign_record_links
    WHERE bundle_id=? AND relation_type='order'
  `).get(collaborationBundle.bundleId);
  assert.throws(
    () => db.prepare(`
      UPDATE campaign_record_links
      SET revoked_at='2099-01-02 00:00:00',revoked_by=?,revoke_reason='Invalid partial revocation'
      WHERE id=?
    `).run(context.actor.userId, orderLink.id),
    /active publication dependencies must be revoked downstream first/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO campaign_record_links (
        org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json,revoked_at,revoked_by,revoke_reason
      ) VALUES (
        ?,?,'collaboration',?,'999','settlement',?,'{}',
        '2099-01-02 00:00:00',?,'Pre-revoked bypass'
      )
    `).run(
      campaign.orgId,
      campaign.id,
      sha256('pre-revoked-settlement-bypass'),
      context.actor.userId,
      context.actor.userId
    ),
    /campaign link bundle identity is invalid/
  );
  db.prepare(`
    UPDATE campaigns
    SET lifecycle_state='settled',row_version=2
    WHERE id=?
  `).run(campaign.id);
  assert.throws(
    () => db.prepare(`
      UPDATE collaborations
      SET cost_actual_confirmed=0,row_version=row_version+1
      WHERE id=?
    `).run(context.collaborationId),
    /settled campaign collaboration cost must remain confirmed/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE collaborations
      SET status='cancelled'
      WHERE id=?
    `).run(context.collaborationId),
    /cancelled collaboration cannot retain active campaign aliases/
  );

  revokeCampaignLinks(
    db,
    collaborationBundle.linkIds,
    context.actor.userId,
    'Collaboration lifecycle cancelled'
  );
  assert.equal(
    db.prepare(`
      UPDATE collaborations
      SET cost_actual_confirmed=0,row_version=row_version+1
      WHERE id=?
    `).run(context.collaborationId).changes,
    1
  );
  db.prepare(`
    UPDATE collaborations
    SET status='cancelled'
    WHERE id=?
  `).run(context.collaborationId);
  assert.deepEqual(
    db.prepare(`
      SELECT status,cost_actual_confirmed
      FROM collaborations
      WHERE id=?
    `).get(context.collaborationId),
    { status: 'cancelled', cost_actual_confirmed: 0 }
  );
  assert.throws(
    () => insertLinkBundle(db, {
      label: 'cancelled-collaboration-order',
      orgId: campaign.orgId,
      campaignId: campaign.id,
      userId: context.actor.userId,
      recordType: 'collaboration',
      recordId: context.collaborationId,
      relationTypes: ['order']
    }),
    /campaign link bundle identity is invalid/
  );
  assertDatabaseHealthy(db);
});

test('request idempotency identity is immutable and legal transitions enforce event cardinality and deadlines', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context);

  const immutable = insertRequestRecord(db, {
    label: 'immutable-request-identity',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'collaboration.update.linked',
    expectedEventCount: 0
  });
  const claimed = insertRequestRecord(db, {
    label: 'immutable-resource-claim',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    resourceClaim: sha256('immutable-resource-claim'),
    scope: 'proposal.ppt.generate.linked',
    expectedEventCount: 1
  });
  const reservationSnapshot = () => db.prepare(`
    SELECT *
    FROM request_idempotency
    WHERE id IN (?,?)
    ORDER BY id
  `).all(immutable.id, claimed.id);
  const beforeReplaceAttempts = reservationSnapshot();
  db.pragma('recursive_triggers = OFF');
  try {
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO request_idempotency
        SELECT *
        FROM request_idempotency
        WHERE id=?
      `).run(immutable.id),
      /request idempotency reservation cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO request_idempotency (
          id,org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
          idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
          expected_event_count,state,lease_until,lease_token,status_code,response_kind,
          response_json,response_headers_json,response_cache_key,response_sha256,
          response_bytes,response_content_type,response_filename,created_at,updated_at,
          operation_deadline,expires_at
        )
        SELECT
          id+10000,org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
          idempotency_key,reservation_nonce,request_hash,?,
          expected_event_count,state,lease_until,lease_token,status_code,response_kind,
          response_json,response_headers_json,response_cache_key,response_sha256,
          response_bytes,response_content_type,response_filename,created_at,updated_at,
          operation_deadline,expires_at
        FROM request_idempotency
        WHERE id=?
      `).run(sha256('distinct-audit-fingerprint'), immutable.id),
      /request idempotency reservation cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO request_idempotency (
          id,org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
          idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
          expected_event_count,state,lease_until,lease_token,status_code,response_kind,
          response_json,response_headers_json,response_cache_key,response_sha256,
          response_bytes,response_content_type,response_filename,created_at,updated_at,
          operation_deadline,expires_at
        )
        SELECT
          id+20000,org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
          ?,reservation_nonce,request_hash,audit_fingerprint,
          expected_event_count,state,lease_until,lease_token,status_code,response_kind,
          response_json,response_headers_json,response_cache_key,response_sha256,
          response_bytes,response_content_type,response_filename,created_at,updated_at,
          operation_deadline,expires_at
        FROM request_idempotency
        WHERE id=?
      `).run(
        `behavior:${sha256('distinct-idempotency-key').slice(0, 24)}`,
        immutable.id
      ),
      /request idempotency reservation cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO request_idempotency (
          id,org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
          idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
          expected_event_count,state,lease_until,lease_token,status_code,response_kind,
          response_json,response_headers_json,response_cache_key,response_sha256,
          response_bytes,response_content_type,response_filename,created_at,updated_at,
          operation_deadline,expires_at
        )
        SELECT
          id+30000,org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
          ?,reservation_nonce,request_hash,?,
          expected_event_count,state,lease_until,lease_token,status_code,response_kind,
          response_json,response_headers_json,response_cache_key,response_sha256,
          response_bytes,response_content_type,response_filename,created_at,updated_at,
          operation_deadline,expires_at
        FROM request_idempotency
        WHERE id=?
      `).run(
        `behavior:${sha256('distinct-resource-idempotency-key').slice(0, 24)}`,
        sha256('distinct-resource-audit-fingerprint'),
        claimed.id
      ),
      /request idempotency reservation cannot be replaced/
    );
  } finally {
    db.pragma('recursive_triggers = ON');
  }
  assert.deepEqual(reservationSnapshot(), beforeReplaceAttempts);
  assert.throws(
    () => db.prepare(`
      UPDATE request_idempotency
      SET idempotency_key='rewritten:key:001',
        lease_until=datetime(lease_until,'+10 minutes')
      WHERE id=?
    `).run(immutable.id),
    /request idempotency identity is immutable/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE request_idempotency
      SET operation_deadline=datetime(operation_deadline,'+1 day'),
        lease_until=datetime(lease_until,'+10 minutes')
      WHERE id=?
    `).run(immutable.id),
    /request idempotency identity is immutable/
  );

  const missingEvent = insertRequestRecord(db, {
    label: 'missing-success-event',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'campaign.transition',
    expectedEventCount: 1
  });
  assert.throws(
    () => completeJsonRequest(db, missingEvent.id, 200),
    /invalid request idempotency transition/
  );
  assert.equal(
    db.prepare('SELECT state FROM request_idempotency WHERE id=?')
      .get(missingEvent.id).state,
    'processing'
  );

  const successful = insertRequestRecord(db, {
    label: 'successful-request-transition',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'campaign.transition',
    expectedEventCount: 1
  });
  insertCampaignEventRow(db, {
    label: 'successful-request-transition',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    actorUserId: context.actor.userId,
    eventType: 'lifecycle_transition',
    previousState: 'lead',
    nextState: 'qualified',
    reason: 'Qualified for request transition',
    source: 'project_workspace',
    metadata: { previous_version: 1, next_version: 2 },
    auditFingerprint: successful.auditFingerprint
  });
  assert.equal(completeJsonRequest(db, successful.id, 200).changes, 1);

  const processing503 = insertRequestRecord(db, {
    label: 'processing-503-zero-event',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'collaboration.update.linked',
    expectedEventCount: 0
  });
  assert.equal(
    completeJsonRequest(db, processing503.id, 503, { error: 'retry later' }).changes,
    1
  );

  const expiredFailure = insertRequestRecord(db, {
    label: 'expired-failed-503',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'collaboration.update.linked',
    expectedEventCount: 0,
    state: 'failed',
    createdAt: sqliteDate(db, '-2 days'),
    updatedAt: sqliteDate(db, '-1 day'),
    operationDeadline: sqliteDate(db, '-36 hours')
  });
  assert.equal(
    completeJsonRequest(db, expiredFailure.id, 503, { error: 'deadline expired' }).changes,
    1
  );

  const earlyFailure = insertRequestRecord(db, {
    label: 'early-failed-503',
    orgId: campaign.orgId,
    userId: context.actor.userId,
    campaignId: campaign.id,
    scope: 'collaboration.update.linked',
    expectedEventCount: 0,
    state: 'failed'
  });
  assert.throws(
    () => completeJsonRequest(db, earlyFailure.id, 503, { error: 'too early' }),
    /invalid request idempotency transition/
  );
  assert.deepEqual(
    db.prepare(`
      SELECT state,status_code
      FROM request_idempotency
      WHERE id IN (?,?,?,?)
      ORDER BY id
    `).all(
      missingEvent.id,
      successful.id,
      processing503.id,
      expiredFailure.id
    ),
    [
      { state: 'processing', status_code: null },
      { state: 'completed', status_code: 200 },
      { state: 'completed', status_code: 503 },
      { state: 'completed', status_code: 503 }
    ]
  );
  assertDatabaseHealthy(db);
});

test('bundle identity supports complete revocation and new-root reactivation while aliases inherit one root', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context);
  const root = insertLinkBundle(db, {
    label: 'aggregate-root',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'collaboration',
    recordId: context.collaborationId,
    relationTypes: ['order']
  });
  const executionId = insertLinkAlias(db, {
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'collaboration',
    recordId: context.collaborationId,
    relationType: 'execution',
    bundleId: root.bundleId
  });
  assert.throws(
    () => insertLinkAlias(db, {
      orgId: campaign.orgId,
      campaignId: campaign.id,
      userId: context.actor.userId,
      recordType: 'collaboration',
      recordId: context.collaborationId + 1,
      relationType: 'publication',
      bundleId: root.bundleId
    }),
    /campaign link bundle identity is invalid/
  );

  revokeCampaignLinks(
    db,
    [...root.linkIds, executionId],
    context.actor.userId,
    'Replace aggregate root'
  );
  assert.throws(
    () => insertLinkAlias(db, {
      orgId: campaign.orgId,
      campaignId: campaign.id,
      userId: context.actor.userId,
      recordType: 'collaboration',
      recordId: context.collaborationId,
      relationType: 'publication',
      bundleId: root.bundleId
    }),
    /campaign link bundle identity is invalid/
  );

  const replacement = insertLinkBundle(db, {
    label: 'aggregate-reactivation-root',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'collaboration',
    recordId: context.collaborationId,
    relationTypes: ['order', 'execution']
  });
  assert.notEqual(replacement.bundleId, root.bundleId);

  const reviewEntryId = insertReviewEvidence(db, {
    campaignId: campaign.id,
    settledEventId: 91,
    userId: context.actor.userId
  });
  const reviewRoot = sha256('review-aggregate-root');
  const knowledgeLinkId = insertLinkAlias(db, {
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'knowledge_entry',
    recordId: reviewEntryId,
    relationType: 'knowledge',
    bundleId: reviewRoot
  });
  const reviewLinkId = insertLinkAlias(db, {
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'knowledge_entry',
    recordId: reviewEntryId,
    relationType: 'review',
    bundleId: reviewRoot,
    metadata: { settled_event_id: 91 }
  });
  assert.deepEqual(
    db.prepare(`
      SELECT id,bundle_id
      FROM campaign_record_links
      WHERE id IN (?,?)
      ORDER BY id
    `).all(knowledgeLinkId, reviewLinkId),
    [
      { id: knowledgeLinkId, bundle_id: reviewRoot },
      { id: reviewLinkId, bundle_id: reviewRoot }
    ]
  );

  assert.throws(() => insertLinkAlias(db, {
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'collaboration',
    recordId: context.collaborationId,
    relationType: 'publication',
    bundleId: sha256('incorrect-later-alias-root')
  }), 'later aliases must inherit the active aggregate root bundle');
  assertDatabaseHealthy(db);
});

test('historically campaign-classified knowledge and chunks remain immutable after link revocation', (t) => {
  const db = openCampaignDatabase(t);
  const context = seedBusinessRecords(db);
  const campaign = insertCampaign(db, context);
  const classifiedEntryId = insertReviewEvidence(db, {
    entryId: 701,
    chunkId: 801,
    campaignId: campaign.id,
    settledEventId: 91,
    userId: context.actor.userId
  });
  const unclassified = insertUnclassifiedKnowledge(db, {
    entryId: 702,
    chunkId: 802,
    userId: context.actor.userId
  });
  const entryOnlyId = insertReviewEvidence(db, {
    entryId: 703,
    chunkId: null,
    campaignId: campaign.id,
    settledEventId: 92,
    userId: context.actor.userId
  });
  const entryOnlySourceHash = sha256('historical-entry-only-source-hash');
  db.prepare('UPDATE knowledge_entries SET source_hash=? WHERE id=?')
    .run(entryOnlySourceHash, entryOnlyId);
  const classifiedLink = insertLinkBundle(db, {
    label: 'historical-knowledge-custody',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'knowledge_entry',
    recordId: classifiedEntryId,
    relationTypes: ['review'],
    metadata: { settled_event_id: 91 }
  });
  const entryOnlyLink = insertLinkBundle(db, {
    label: 'historical-entry-only-custody',
    orgId: campaign.orgId,
    campaignId: campaign.id,
    userId: context.actor.userId,
    recordType: 'knowledge_entry',
    recordId: entryOnlyId,
    relationTypes: ['review'],
    metadata: { settled_event_id: 92 }
  });
  revokeCampaignLinks(
    db,
    classifiedLink.linkIds,
    context.actor.userId,
    'Retain historical custody'
  );
  revokeCampaignLinks(
    db,
    entryOnlyLink.linkIds,
    context.actor.userId,
    'Retain historical entry-only custody'
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_record_links
      WHERE record_type='knowledge_entry' AND record_id=?
        AND revoked_at IS NOT NULL
    `).get(String(classifiedEntryId)).count,
    1
  );
  db.prepare(`
    INSERT INTO ai_conversations (
      id,user_id,title,visibility,source_module
    ) VALUES (901,?,'Campaign evidence snapshot','team','assistant')
  `).run(context.actor.userId);
  db.prepare(`
    INSERT INTO ai_messages (
      id,conversation_id,user_id,role,content,metadata_json
    ) VALUES (
      902,901,?,'assistant','Campaign evidence is archived.','{"schema_version":1}'
    )
  `).run(context.actor.userId);
  const classifiedDigests = db.prepare(`
    SELECT entry.source_identity_sha256,
      entry.content_sha256 AS entry_content_sha256,
      chunk.content_sha256 AS chunk_content_sha256
    FROM knowledge_entries entry
    JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
    WHERE entry.id=? AND chunk.id=801
  `).get(classifiedEntryId);
  const unclassifiedDigests = db.prepare(`
    SELECT entry.source_identity_sha256,
      entry.content_sha256 AS entry_content_sha256,
      chunk.content_sha256 AS chunk_content_sha256
    FROM knowledge_entries entry
    JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
    WHERE entry.id=? AND chunk.id=?
  `).get(unclassified.entryId, unclassified.chunkId);
  db.prepare(`
    INSERT INTO ai_references (
      id,message_id,reference_type,reference_id,title,url,snippet,provider,
      metadata_json,reference_schema_version,knowledge_entry_id,
      knowledge_chunk_id,campaign_id,source_identity_sha256,
      entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
    ) VALUES (
      903,902,'knowledge',?,'Campaign review evidence','',
      'Immutable campaign evidence snapshot','knowledge_base','{"schema_version":1}',
      1,?,801,?,?,?,?,1,'retrieved'
    )
  `).run(
    String(classifiedEntryId),
    classifiedEntryId,
    campaign.id,
    classifiedDigests.source_identity_sha256,
    classifiedDigests.entry_content_sha256,
    classifiedDigests.chunk_content_sha256
  );
  db.prepare(`
    INSERT INTO knowledge_chunks_fts(rowid,title,content,tags,entry_id,chunk_id)
    SELECT chunk.id,entry.title,chunk.content,'campaign-review',
      CAST(entry.id AS TEXT),CAST(chunk.id AS TEXT)
    FROM knowledge_chunks chunk
    JOIN knowledge_entries entry ON entry.id=chunk.entry_id
    WHERE chunk.id=801
  `).run();
  db.prepare(`
    INSERT INTO knowledge_chunks_fts(rowid,title,content,tags,entry_id,chunk_id)
    SELECT chunk.id,entry.title,chunk.content,'unclassified',
      CAST(entry.id AS TEXT),CAST(chunk.id AS TEXT)
    FROM knowledge_chunks chunk
    JOIN knowledge_entries entry ON entry.id=chunk.entry_id
    WHERE chunk.id=802
  `).run();
  const custodySnapshot = () => ({
    entries: db.prepare(`
      SELECT id,entry_type,source_type,CAST(source_id AS TEXT) AS source_id,
        content,source_hash,source_identity_sha256,content_sha256
      FROM knowledge_entries
      WHERE id IN (701,702,703,704,705,706)
      ORDER BY id
    `).all(),
    chunks: db.prepare(`
      SELECT id,entry_id,chunk_index,content,metadata_json,token_count,content_sha256
      FROM knowledge_chunks
      WHERE id IN (801,802,803)
      ORDER BY id
    `).all(),
    fts: db.prepare(`
      SELECT rowid,title,content,tags,entry_id,chunk_id
      FROM knowledge_chunks_fts
      ORDER BY rowid
    `).all(),
    links: db.prepare(`
      SELECT id,record_id,relation_type,revoked_at
      FROM campaign_record_links
      WHERE record_type='knowledge_entry'
      ORDER BY id
    `).all(),
    references: db.prepare(`
      SELECT id,message_id,reference_type,reference_id,title,snippet,provider,
        metadata_json,reference_schema_version,knowledge_entry_id,
        knowledge_chunk_id,campaign_id,source_identity_sha256,
        entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
      FROM ai_references
      WHERE message_id=902
      ORDER BY id
    `).all()
  });
  const beforeReplaceAttempts = custodySnapshot();
  const entryOnly = db.prepare(`
    SELECT source_type,CAST(source_id AS TEXT) AS source_id,business_type,business_id,
      source_identity_sha256
    FROM knowledge_entries
    WHERE id=?
  `).get(entryOnlyId);

  db.pragma('recursive_triggers = OFF');
  try {
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO knowledge_entries
        SELECT *
        FROM knowledge_entries
        WHERE id=?
      `).run(unclassified.entryId),
      /knowledge entry cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        REPLACE INTO knowledge_chunks
        SELECT *
        FROM knowledge_chunks
        WHERE id=?
      `).run(unclassified.chunkId),
      /knowledge chunk cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO knowledge_entries (
          id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
          usage_count,created_at,updated_at,title,summary,tags_json,visibility,
          source_hash,business_type,business_id,metadata_json,
          source_identity_sha256,content_sha256
        )
        SELECT
          id,entry_type,source_type,source_id,key_terms,'replaced historical entry',
          created_by,is_public,usage_count,created_at,updated_at,title,summary,tags_json,
          visibility,source_hash,business_type,business_id,metadata_json,
          source_identity_sha256,?
        FROM knowledge_entries
        WHERE id=?
      `).run(sha256('replaced historical entry'), entryOnlyId),
      /knowledge entry cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO knowledge_entries (
          id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
          title,summary,tags_json,visibility,metadata_json,
          source_identity_sha256,content_sha256
        ) VALUES (
          704,'note','manual','identity-collision','collision','identity collision',
          ?,0,'Identity collision','Blocked','[]','team','{}',?,?
        )
      `).run(
        context.actor.userId,
        entryOnly.source_identity_sha256,
        sha256('identity collision')
      ),
      /knowledge entry cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO knowledge_entries (
          id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
          title,summary,tags_json,visibility,business_type,business_id,metadata_json,
          source_identity_sha256,content_sha256
        ) VALUES (
          705,'campaign_review','campaign_review',?,'collision','review source collision',
          ?,0,'Review collision','Blocked','[]','team',?,?, '{}',?,?
        )
      `).run(
        entryOnly.source_id,
        context.actor.userId,
        entryOnly.business_type,
        entryOnly.business_id,
        sha256('review-source-collision'),
        sha256('review source collision')
      ),
      /knowledge entry cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO knowledge_entries (
          id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
          title,summary,tags_json,visibility,source_hash,metadata_json,
          source_identity_sha256,content_sha256
        ) VALUES (
          706,'note','manual','source-hash-collision','collision','source hash collision',
          ?,0,'Source hash collision','Blocked','[]','team',?,'{}',?,?
        )
      `).run(
        context.actor.userId,
        entryOnlySourceHash,
        sha256('source-hash-collision-identity'),
        sha256('source hash collision')
      ),
      /knowledge entry cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO knowledge_chunks (
          id,entry_id,chunk_index,content,metadata_json,token_count,embedding_json,
          created_at,content_sha256
        )
        SELECT id,?,1,'moved classified chunk','{}',token_count,embedding_json,
          created_at,?
        FROM knowledge_chunks
        WHERE id=801
      `).run(unclassified.entryId, sha256('moved classified chunk')),
      /knowledge chunk cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        REPLACE INTO knowledge_chunks (
          id,entry_id,chunk_index,content,metadata_json,token_count,content_sha256
        ) VALUES (803,?,0,'replacement classified chunk','{}',3,?)
      `).run(classifiedEntryId, sha256('replacement classified chunk')),
      /knowledge chunk cannot be/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO ai_references (
          id,message_id,reference_type,reference_id,title,url,snippet,provider,
          metadata_json,reference_schema_version,knowledge_entry_id,
          knowledge_chunk_id,campaign_id,source_identity_sha256,
          entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
        ) VALUES (
          903,902,'knowledge',?,'Replacement evidence','',
          'Unclassified replacement snapshot','knowledge_base','{"schema_version":1}',
          1,?,?,?,?,?,?,1,'retrieved'
        )
      `).run(
        String(unclassified.entryId),
        unclassified.entryId,
        unclassified.chunkId,
        campaign.id,
        unclassifiedDigests.source_identity_sha256,
        unclassifiedDigests.entry_content_sha256,
        unclassifiedDigests.chunk_content_sha256
      ),
      /versioned knowledge reference cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO ai_references (
          id,message_id,reference_type,reference_id,title,url,snippet,provider,
          metadata_json,reference_schema_version,knowledge_entry_id,
          knowledge_chunk_id,campaign_id,source_identity_sha256,
          entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
        ) VALUES (
          904,902,'knowledge',?,'Rank collision','',
          'Replacement rank snapshot','knowledge_base','{"schema_version":1}',
          1,?,?,?,?,?,?,1,'retrieved'
        )
      `).run(
        String(unclassified.entryId),
        unclassified.entryId,
        unclassified.chunkId,
        campaign.id,
        unclassifiedDigests.source_identity_sha256,
        unclassifiedDigests.entry_content_sha256,
        unclassifiedDigests.chunk_content_sha256
      ),
      /versioned knowledge reference cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO ai_references (
          id,message_id,reference_type,reference_id,title,url,snippet,provider,
          metadata_json,reference_schema_version,knowledge_entry_id,
          knowledge_chunk_id,campaign_id,source_identity_sha256,
          entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
        ) VALUES (
          905,902,'knowledge',?,'Chunk collision','',
          'Replacement chunk snapshot','knowledge_base','{"schema_version":1}',
          1,?,801,?,?,?,?,2,'retrieved'
        )
      `).run(
        String(classifiedEntryId),
        classifiedEntryId,
        campaign.id,
        classifiedDigests.source_identity_sha256,
        classifiedDigests.entry_content_sha256,
        classifiedDigests.chunk_content_sha256
      ),
      /versioned knowledge reference cannot be replaced/
    );
  } finally {
    db.pragma('recursive_triggers = ON');
  }
  assert.deepEqual(custodySnapshot(), beforeReplaceAttempts);

  assert.throws(
    () => db.prepare(`
      UPDATE knowledge_entries
      SET content='rewritten classified content',content_sha256=?
      WHERE id=?
    `).run(sha256('rewritten classified content'), classifiedEntryId),
    /campaign knowledge content is immutable/
  );
  assert.throws(
    () => db.prepare('DELETE FROM knowledge_entries WHERE id=?')
      .run(classifiedEntryId),
    /campaign knowledge entry cannot be deleted/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO knowledge_chunks (
        id,entry_id,chunk_index,content,metadata_json,token_count,content_sha256
      ) VALUES (803,?,1,'late classified chunk','{}',3,?)
    `).run(classifiedEntryId, sha256('late classified chunk')),
    /campaign knowledge chunk cannot be appended/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE knowledge_chunks
      SET content='mutated classified chunk',content_sha256=?
      WHERE id=801
    `).run(sha256('mutated classified chunk')),
    /campaign knowledge chunk is immutable/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE knowledge_chunks
      SET entry_id=?
      WHERE id=801
    `).run(unclassified.entryId),
    /campaign knowledge chunk is immutable/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE knowledge_chunks
      SET entry_id=?
      WHERE id=?
    `).run(classifiedEntryId, unclassified.chunkId),
    /campaign knowledge chunk is immutable/
  );
  assert.throws(
    () => db.prepare('DELETE FROM knowledge_chunks WHERE id=801').run(),
    /campaign knowledge chunk cannot be deleted/
  );

  const mutableContent = 'Updated unclassified knowledge';
  assert.equal(
    db.prepare(`
      UPDATE knowledge_chunks
      SET content=?,content_sha256=?
      WHERE id=?
    `).run(
      mutableContent,
      sha256(`unclassified-chunk:${mutableContent}`),
      unclassified.chunkId
    ).changes,
    1
  );
  assert.equal(
    db.prepare('SELECT content FROM knowledge_chunks WHERE id=?')
      .get(unclassified.chunkId).content,
    mutableContent
  );
  assertDatabaseHealthy(db);
});
