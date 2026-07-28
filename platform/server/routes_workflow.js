const engine = require('./workflow_engine');
const businessKnowledge = require('./services/business_knowledge_service');
const {
  CampaignWorkflowServiceError,
  createCampaignWorkflowService
} = require('./services/campaign_workflow_service');
const {
  buildCollectionAccessPredicate
} = require('./services/campaign_access_service');

function workflowRequestId(request) {
  return request.requestId ||
    request.phase4Request && request.phase4Request.requestId ||
    'workflow-template-request';
}

function isCampaignLinkedInstance(db, instance) {
  if (!instance) return false;
  if (
    instance.org_id !== null && instance.org_id !== undefined ||
    instance.campaign_id !== null && instance.campaign_id !== undefined ||
    instance.campaign_event_id !== null && instance.campaign_event_id !== undefined ||
    instance.campaign_dispatch_id !== null && instance.campaign_dispatch_id !== undefined ||
    instance.business_type === 'campaign'
  ) {
    return true;
  }
  return Boolean(db.prepare(`
    SELECT 1
    FROM campaign_record_links
    WHERE record_type='workflow_instance'
      AND relation_type='workflow'
      AND record_id=?
      AND revoked_at IS NULL
    LIMIT 1
  `).get(String(instance.id)));
}

function hasCampaignWorkflowPipelineProof(request) {
  const policyId = request.phase4Request && request.phase4Request.policy &&
    request.phase4Request.policy.id;
  return typeof policyId === 'string' && (
    policyId.startsWith('workflow.task.') ||
    policyId.startsWith('workflow.instance.')
  );
}

function isCanonicalWorkflowRouteId(value) {
  return typeof value === 'string' &&
    /^[1-9][0-9]*$/.test(value) &&
    Number.isSafeInteger(Number(value));
}

function campaignWorkflowRouteFence(response, kind) {
  response.removeHeader('X-Request-Id');
  return response.status(404).json({
    error: kind === 'task' ? 'Task not found' : 'Instance not found'
  });
}

function sendCampaignWorkflowError(request, response, error) {
  const known = error instanceof CampaignWorkflowServiceError ||
    error && error.name === 'IdempotencyServiceError';
  const status = known ? error.statusCode : 500;
  const body = {
    error: known ? error.message : 'Workflow template request failed.',
    code: known ? error.code : 'AUDIT_PERSISTENCE_FAILED',
    request_id: workflowRequestId(request)
  };
  if (known && error.details !== undefined) body.details = error.details;
  if (known && error.retryAfterSeconds) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  return response.status(status).json(body);
}

function sendCampaignWorkflowResult(response, result) {
  for (const [name, value] of Object.entries(result.headers || {})) {
    response.setHeader(name, value);
  }
  return response.status(result.status).json(result.body);
}

function requireCampaignWorkflowJson(request) {
  const parsedMediaKind = request.phase4Request && request.phase4Request.mediaKind;
  const contentType = request.get && request.get('Content-Type');
  const isJson = parsedMediaKind
    ? parsedMediaKind === 'json'
    : typeof contentType === 'string' && /^application\/json(?:\s*;|$)/i.test(contentType.trim());
  if (!isJson) {
    throw new CampaignWorkflowServiceError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Unsupported request media type'
    );
  }
}

function isPositiveSafeAssignmentVersion(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function serializeTaskListRow(row, linked) {
  const task = {
    id: row.id,
    instance_id: row.instance_id,
    node_id: row.node_id,
    node_type: row.node_type,
    title: row.title,
    description: row.description,
    assignee_id: row.assignee_id,
    assignee_role: row.assignee_role,
    status: row.status,
    comment: row.comment,
    due_at: row.due_at,
    completed_at: row.completed_at,
    completed_by: row.completed_by,
    created_at: row.created_at,
    business_type: row.business_type,
    business_id: row.business_id,
    template_id: row.template_id,
    template_name: row.template_name
  };
  if (linked) task.assignment_version = row.assignment_version;
  return task;
}

function serializeTaskDetailRow(row, linked) {
  const task = {
    id: row.id,
    instance_id: row.instance_id,
    node_id: row.node_id,
    node_type: row.node_type,
    title: row.title,
    description: row.description,
    assignee_id: row.assignee_id,
    assignee_role: row.assignee_role,
    status: row.status,
    comment: row.comment,
    due_at: row.due_at,
    completed_at: row.completed_at,
    completed_by: row.completed_by,
    created_at: row.created_at,
    business_type: row.business_type,
    business_id: row.business_id,
    template_id: row.template_id,
    node_data: row.node_data,
    template_name: row.template_name
  };
  if (linked) task.assignment_version = row.assignment_version;
  return task;
}

function serializeWorkflowInstance(row) {
  return {
    id: row.id,
    template_id: row.template_id,
    business_type: row.business_type,
    business_id: row.business_id,
    current_node_id: row.current_node_id,
    status: row.status,
    node_data: row.node_data,
    started_by: row.started_by,
    completed_at: row.completed_at,
    created_at: row.created_at
  };
}

function serializeInstanceTask(row, linked) {
  const task = {
    id: row.id,
    instance_id: row.instance_id,
    node_id: row.node_id,
    node_type: row.node_type,
    title: row.title,
    description: row.description,
    assignee_id: row.assignee_id,
    assignee_role: row.assignee_role,
    status: row.status,
    comment: row.comment,
    due_at: row.due_at,
    completed_at: row.completed_at,
    completed_by: row.completed_by,
    created_at: row.created_at
  };
  if (linked) task.assignment_version = row.assignment_version;
  return task;
}

const WORKFLOW_INSTANCE_COLLECTION_PROJECTION = `
  wi.id,wi.template_id,wi.business_type,wi.business_id,wi.current_node_id,
  wi.status,wi.node_data,wi.started_by,wi.completed_at,wi.created_at,
  wt.name AS template_name
`;

const WORKFLOW_INSTANCE_LINEAGE_JOINS = `
  LEFT JOIN (
    SELECT
      record_id,COUNT(*) AS active_link_count,
      MIN(org_id) AS org_id,MIN(campaign_id) AS campaign_id
    FROM campaign_record_links
    WHERE record_type='workflow_instance'
      AND relation_type='workflow'
      AND revoked_at IS NULL
    GROUP BY record_id
  ) workflow_link ON workflow_link.record_id=CAST(wi.id AS TEXT)
  LEFT JOIN campaign_workflow_dispatches dispatch
    ON dispatch.id=wi.campaign_dispatch_id
  LEFT JOIN campaign_events dispatch_event
    ON dispatch_event.id=dispatch.event_id
  LEFT JOIN campaign_events root_event
    ON root_event.id=dispatch.trigger_event_id
  LEFT JOIN (
    SELECT org_id,id AS campaign_id
    FROM campaigns
  ) campaign_scope
    ON campaign_scope.org_id=wi.org_id
   AND campaign_scope.campaign_id=wi.campaign_id
`;

const WORKFLOW_INSTANCE_COLLECTION_FROM = `
  FROM workflow_instances wi
  JOIN workflow_templates wt ON wi.template_id=wt.id
  ${WORKFLOW_INSTANCE_LINEAGE_JOINS}
`;

const WORKFLOW_INSTANCE_STATS_FROM = `
  FROM workflow_instances wi
  LEFT JOIN workflow_templates wt ON wi.template_id=wt.id
  ${WORKFLOW_INSTANCE_LINEAGE_JOINS}
`;

const WORKFLOW_INSTANCE_LINKED_CONTEXT = `(
  wi.org_id IS NOT NULL
  OR wi.campaign_id IS NOT NULL
  OR wi.campaign_event_id IS NOT NULL
  OR wi.campaign_dispatch_id IS NOT NULL
  OR wi.business_type='campaign'
  OR COALESCE(workflow_link.active_link_count,0)>0
)`;

const WORKFLOW_INSTANCE_VALID_LINKED_LINEAGE = `(
  typeof(wi.org_id)='integer'
  AND wi.org_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
  AND typeof(wi.campaign_id)='integer'
  AND wi.campaign_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
  AND typeof(wi.campaign_event_id)='integer'
  AND wi.campaign_event_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
  AND typeof(wi.campaign_dispatch_id)='integer'
  AND wi.campaign_dispatch_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
  AND wi.business_type='campaign'
  AND wi.business_id=wi.campaign_id
  AND workflow_link.active_link_count=1
  AND workflow_link.org_id=wi.org_id
  AND workflow_link.campaign_id=wi.campaign_id
  AND wt.id IS NOT NULL
  AND campaign_scope.campaign_id IS NOT NULL
  AND dispatch.status='completed'
  AND dispatch.workflow_instance_id=wi.id
  AND dispatch.id=wi.campaign_dispatch_id
  AND dispatch.org_id=wi.org_id
  AND dispatch.campaign_id=wi.campaign_id
  AND dispatch.trigger_event_id=wi.campaign_event_id
  AND dispatch.template_id=wi.template_id
  AND dispatch_event.org_id=wi.org_id
  AND dispatch_event.campaign_id=wi.campaign_id
  AND root_event.id=dispatch.trigger_event_id
  AND root_event.org_id=wi.org_id
  AND root_event.campaign_id=wi.campaign_id
  AND root_event.event_type='lifecycle_transition'
  AND typeof(root_event.actor_user_id)='integer'
  AND root_event.actor_user_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
  AND (
    (
      dispatch.reconciles_dispatch_id IS NULL
      AND dispatch.event_id=dispatch.trigger_event_id
      AND dispatch_event.event_type='lifecycle_transition'
    )
    OR
    (
      dispatch.reconciles_dispatch_id IS NOT NULL
      AND dispatch.event_id<>dispatch.trigger_event_id
      AND dispatch_event.event_type='workflow_reconciliation'
    )
  )
  AND wi.initialization_status='ready'
  AND wi.initialization_error IS NULL
)`;

function buildWorkflowInstanceCollectionVisibility(userId, requireLegacyStarter = false) {
  const campaignAccess = buildCollectionAccessPredicate('workflow_children', { userId });
  const legacyPredicate = requireLegacyStarter ? 'wi.started_by=?' : '1=1';
  return {
    sql: `(
      (
        NOT ${WORKFLOW_INSTANCE_LINKED_CONTEXT}
        AND ${legacyPredicate}
      )
      OR
      (
        ${WORKFLOW_INSTANCE_LINKED_CONTEXT}
        AND ${WORKFLOW_INSTANCE_VALID_LINKED_LINEAGE}
        AND ${campaignAccess.sql}
      )
    )`,
    params: [
      ...(requireLegacyStarter ? [userId] : []),
      ...campaignAccess.params
    ]
  };
}

function legacyWorkflowTemplateArchiveRecord(db, templateId) {
  return db.prepare(`
    SELECT
      id,name,description,module,category,nodes,edges,version,is_active,
      created_by,created_at,updated_at
    FROM workflow_templates
    WHERE id=?
  `).get(templateId);
}

module.exports = function(app, db, authMiddleware, adminOnly) {
  const campaignWorkflow = createCampaignWorkflowService(db);

  function runCampaignTaskAction(req, res, action) {
    try {
      requireCampaignWorkflowJson(req);
      return sendCampaignWorkflowResult(res, campaignWorkflow.actOnWorkflowTask({
        userId: req.user && req.user.id,
        taskId: req.params.id,
        action,
        requestId: workflowRequestId(req),
        idempotencyKey: req.get('Idempotency-Key'),
        body: req.body
      }));
    } catch (error) {
      return sendCampaignWorkflowError(req, res, error);
    }
  }

  function runCampaignInstanceControl(req, res, action) {
    try {
      requireCampaignWorkflowJson(req);
      return sendCampaignWorkflowResult(res, campaignWorkflow.controlWorkflowInstance({
        userId: req.user && req.user.id,
        instanceId: req.params.id,
        action,
        requestId: workflowRequestId(req),
        idempotencyKey: req.get('Idempotency-Key'),
        body: req.body
      }));
    } catch (error) {
      return sendCampaignWorkflowError(req, res, error);
    }
  }
  // ============================================================
  // TEMPLATE ROUTES (CRUD + Publish)
  // ============================================================

  // GET /api/workflow/templates - List all templates (without nodes/edges for performance)
  app.get('/api/workflow/templates', authMiddleware, (req, res) => {
    try {
      const templates = db.prepare(`
        SELECT id, name, description, module, category, version, is_active, created_by, created_at, updated_at
        FROM workflow_templates ORDER BY updated_at DESC
      `).all();
      res.json({ templates });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/workflow/templates/:id/campaign-trigger', authMiddleware, (req, res) => {
    try {
      return res.json(campaignWorkflow.getCampaignTemplateTrigger({
        userId: req.user && req.user.id,
        templateId: req.params.id
      }));
    } catch (error) {
      return sendCampaignWorkflowError(req, res, error);
    }
  });

  // GET /api/workflow/templates/:id - Get single template with nodes/edges parsed
  app.get('/api/workflow/templates/:id', authMiddleware, (req, res) => {
    try {
      const template = db.prepare(`
        SELECT
          id,name,description,module,category,nodes,edges,version,is_active,
          created_by,created_at,updated_at
        FROM workflow_templates
        WHERE id=?
      `).get(req.params.id);
      if (!template) return res.status(404).json({ error: 'Template not found' });

      template.nodes = JSON.parse(template.nodes);
      template.edges = JSON.parse(template.edges);
      res.json({ template });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/templates - Create template
  app.post('/api/workflow/templates', authMiddleware, (req, res) => {
    try {
      if (req.body && req.body.module === 'campaign') {
        requireCampaignWorkflowJson(req);
        return sendCampaignWorkflowResult(res, campaignWorkflow.createCampaignTemplate({
          userId: req.user && req.user.id,
          requestId: workflowRequestId(req),
          idempotencyKey: req.get('Idempotency-Key'),
          body: req.body
        }));
      }
      const { name, description, module, category, nodes, edges } = req.body;
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const result = db.prepare(`
        INSERT INTO workflow_templates (name, description, module, category, nodes, edges, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        name, description || '', module || '', category || 'approval',
        JSON.stringify(nodes || []), JSON.stringify(edges || []),
        req.user.id
      );
      businessKnowledge.archiveWorkflowTemplate(
        db,
        legacyWorkflowTemplateArchiveRecord(db, result.lastInsertRowid),
        req.user
      );
      res.json({ id: result.lastInsertRowid });
    } catch (error) {
      if (error instanceof CampaignWorkflowServiceError || error && error.name === 'IdempotencyServiceError') {
        return sendCampaignWorkflowError(req, res, error);
      }
      res.status(500).json({ error: error.message });
    }
  });

  // PUT /api/workflow/templates/:id - Update template (increments version)
  app.put('/api/workflow/templates/:id', authMiddleware, (req, res) => {
    try {
      const hasCampaignSignature =
        Boolean(req.body && req.body.module === 'campaign') ||
        Boolean(
          req.body &&
          Object.prototype.hasOwnProperty.call(req.body, 'expected_version')
        );
      const template = hasCampaignSignature
        ? null
        : db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(req.params.id);
      const campaignSemantics = hasCampaignSignature || Boolean(template && template.module === 'campaign');
      if (campaignSemantics) {
        requireCampaignWorkflowJson(req);
        return sendCampaignWorkflowResult(res, campaignWorkflow.updateCampaignTemplateGraph({
          userId: req.user && req.user.id,
          templateId: req.params.id,
          requestId: workflowRequestId(req),
          idempotencyKey: req.get('Idempotency-Key'),
          body: req.body
        }));
      }
      if (!template) return res.status(404).json({ error: 'Template not found' });

      const { name, description, module, category, nodes, edges } = req.body;
      db.prepare(`
        UPDATE workflow_templates SET
          name = COALESCE(?, name),
          description = COALESCE(?, description),
          module = COALESCE(?, module),
          category = COALESCE(?, category),
          nodes = ?,
          edges = ?,
          version = version + 1,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        name || null, description || null, module || null, category || null,
        nodes ? JSON.stringify(nodes) : template.nodes,
        edges ? JSON.stringify(edges) : template.edges,
        req.params.id
      );
      businessKnowledge.archiveWorkflowTemplate(
        db,
        legacyWorkflowTemplateArchiveRecord(db, req.params.id),
        req.user
      );
      res.json({ success: true });
    } catch (error) {
      if (error instanceof CampaignWorkflowServiceError || error && error.name === 'IdempotencyServiceError') {
        return sendCampaignWorkflowError(req, res, error);
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/workflow/templates/:id/campaign-trigger', authMiddleware, (req, res) => {
    try {
      return sendCampaignWorkflowResult(res, campaignWorkflow.updateCampaignTemplateTrigger({
        userId: req.user && req.user.id,
        templateId: req.params.id,
        requestId: workflowRequestId(req),
        idempotencyKey: req.get('Idempotency-Key'),
        body: req.body
      }));
    } catch (error) {
      return sendCampaignWorkflowError(req, res, error);
    }
  });

  // DELETE /api/workflow/templates/:id - Delete template (admin only)
  app.delete('/api/workflow/templates/:id', authMiddleware, (req, res) => {
    try {
      return sendCampaignWorkflowResult(res, campaignWorkflow.deleteWorkflowTemplate({
        userId: req.user && req.user.id,
        templateId: req.params.id
      }));
    } catch (error) {
      return sendCampaignWorkflowError(req, res, error);
    }
  });

  // POST /api/workflow/templates/:id/publish - Set is_active=1 (admin only)
  app.post('/api/workflow/templates/:id/publish', authMiddleware, (req, res) => {
    try {
      const hasCampaignSignature = Boolean(
        req.body && Object.prototype.hasOwnProperty.call(req.body, 'expected_version')
      );
      const template = hasCampaignSignature
        ? null
        : db.prepare('SELECT id,module FROM workflow_templates WHERE id=?').get(req.params.id);
      const campaignSemantics = template && template.module === 'campaign' || hasCampaignSignature;
      if (campaignSemantics) {
        requireCampaignWorkflowJson(req);
        return sendCampaignWorkflowResult(res, campaignWorkflow.publishCampaignTemplate({
          userId: req.user && req.user.id,
          templateId: req.params.id,
          requestId: workflowRequestId(req),
          idempotencyKey: req.get('Idempotency-Key'),
          body: req.body
        }));
      }
      return adminOnly(req, res, () => {
        const result = db.prepare("UPDATE workflow_templates SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
        businessKnowledge.archiveWorkflowTemplate(
          db,
          legacyWorkflowTemplateArchiveRecord(db, req.params.id),
          req.user
        );
        return res.json({ success: true });
      });
    } catch (error) {
      if (error instanceof CampaignWorkflowServiceError || error && error.name === 'IdempotencyServiceError') {
        return sendCampaignWorkflowError(req, res, error);
      }
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // INSTANCE ROUTES
  // ============================================================

  // POST /api/workflow/instances - Start workflow manually via engine
  app.post('/api/workflow/instances', authMiddleware, (req, res) => {
    try {
      const { template_id, business_type, business_id, data } = req.body;
      if (!template_id || !business_type || !business_id) {
        return res.status(400).json({ error: 'template_id, business_type, and business_id are required' });
      }
      const template = db.prepare('SELECT module FROM workflow_templates WHERE id=?').get(template_id);
      const hasCampaignContext = business_type === 'campaign' ||
        Object.prototype.hasOwnProperty.call(req.body, 'campaign_id') ||
        data !== null && typeof data === 'object' && !Array.isArray(data) &&
          Object.prototype.hasOwnProperty.call(data, 'campaign_id');
      if (template && template.module === 'campaign' || hasCampaignContext) {
        return sendCampaignWorkflowError(req, res, new CampaignWorkflowServiceError(
          400,
          'INVALID_CAMPAIGN_INPUT',
          'Campaign workflows can only be started by lifecycle dispatch.'
        ));
      }
      const instanceId = engine.startWorkflow(template_id, business_type, business_id, data || {}, req.user.id);
      businessKnowledge.archiveWorkflowInstance(db, db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId), req.user, 'started');
      res.json({ id: instanceId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/workflow/instances/by-business - Get by business_type + business_id
  // NOTE: This MUST be defined before the /:id route to avoid Express matching 'by-business' as an id
  app.get('/api/workflow/instances/by-business', authMiddleware, (req, res) => {
    try {
      const { business_type, business_id } = req.query;
      if (!business_type || !business_id) {
        return res.status(400).json({ error: 'business_type and business_id query params are required' });
      }
      const visibility = buildWorkflowInstanceCollectionVisibility(req.user.id);
      const instances = db.prepare(`
        SELECT ${WORKFLOW_INSTANCE_COLLECTION_PROJECTION}
        ${WORKFLOW_INSTANCE_COLLECTION_FROM}
        WHERE wi.business_type = ? AND wi.business_id = ?
          AND ${visibility.sql}
        ORDER BY wi.created_at DESC
      `).all(business_type, business_id, ...visibility.params);
      res.json({ instances });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/workflow/instances - List instances
  app.get('/api/workflow/instances', authMiddleware, (req, res) => {
    try {
      const visibility = buildWorkflowInstanceCollectionVisibility(
        req.user.id,
        req.user.role !== 'admin'
      );
      let query = `
        SELECT ${WORKFLOW_INSTANCE_COLLECTION_PROJECTION}
        ${WORKFLOW_INSTANCE_COLLECTION_FROM}
        WHERE ${visibility.sql}
      `;
      const params = [...visibility.params];

      // Optional filters
      if (req.query.status) {
        query += ' AND wi.status = ?';
        params.push(req.query.status);
      }
      if (req.query.business_type) {
        query += ' AND wi.business_type = ?';
        params.push(req.query.business_type);
      }
      if (req.query.business_id) {
        query += ' AND wi.business_id = ?';
        params.push(req.query.business_id);
      }
      if (req.query.template_id) {
        query += ' AND wi.template_id = ?';
        params.push(req.query.template_id);
      }

      query += ' ORDER BY wi.created_at DESC LIMIT 200';

      const instances = db.prepare(query).all(...params);
      res.json({ instances });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/workflow/instances/:id - Instance detail with tasks, logs, enriched nodes
  app.get('/api/workflow/instances/:id', authMiddleware, (req, res) => {
    try {
      const instanceRow = db.prepare(`
        SELECT
          id,template_id,business_type,business_id,current_node_id,status,
          node_data,started_by,completed_at,created_at
        FROM workflow_instances WHERE id=?
      `).get(req.params.id);
      if (!instanceRow) return res.status(404).json({ error: 'Instance not found' });

      const access = campaignWorkflow.resolveWorkflowReadAccess({
        userId: req.user.id,
        instanceId: instanceRow.id
      });
      if (access.linked && !access.allowed) {
        return access.forbidden
          ? res.status(403).json({ error: 'Access denied' })
          : res.status(404).json({ error: 'Instance not found' });
      }
      if (
        !access.linked &&
        req.user.role !== 'admin' &&
        instanceRow.started_by !== req.user.id
      ) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const instance = serializeWorkflowInstance(instanceRow);

      const template = db.prepare(`
        SELECT nodes,edges FROM workflow_templates WHERE id=?
      `).get(instance.template_id);
      const rawNodes = JSON.parse(template.nodes);
      const edges = JSON.parse(template.edges);
      const logs = db.prepare(`
        SELECT id,instance_id,node_id,action,user_id,details,created_at
        FROM workflow_node_logs WHERE instance_id=? ORDER BY created_at ASC
      `).all(instance.id);
      const taskRows = db.prepare(`
        SELECT
          id,instance_id,node_id,node_type,title,description,assignee_id,
          assignee_role,status,comment,due_at,completed_at,completed_by,
          created_at,assignment_version
        FROM workflow_tasks WHERE instance_id=? ORDER BY created_at ASC
      `).all(instance.id);
      if (
        access.linked &&
        taskRows.some((task) => !isPositiveSafeAssignmentVersion(task.assignment_version))
      ) {
        return res.status(404).json({ error: 'Instance not found' });
      }
      const tasks = taskRows.map((task) => serializeInstanceTask(task, access.linked));

      // Build node status map from logs
      const nodeStatuses = {};
      for (const log of logs) {
        if (!log.node_id) continue;
        if (!nodeStatuses[log.node_id]) {
          nodeStatuses[log.node_id] = {
            nodeId: log.node_id,
            entered: false,
            exited: false,
            completed: false,
            lastAction: null,
            lastActionAt: null
          };
        }

        const ns = nodeStatuses[log.node_id];
        ns.lastAction = log.action;
        ns.lastActionAt = log.created_at;

        if (log.action === 'entered') {
          ns.entered = true;
        } else if (log.action === 'exited' || log.action === 'completed') {
          ns.exited = true;
          ns.completed = true;
        }
      }

      // Enrich each node with status info
      const enrichedNodes = rawNodes.map(node => {
        const status = nodeStatuses[node.id] || {
          nodeId: node.id, entered: false, exited: false, completed: false,
          lastAction: null, lastActionAt: null
        };
        return {
          ...node,
          is_current: node.id === instance.current_node_id,
          status: status.completed ? 'completed' : (status.entered ? 'active' : 'pending'),
          lastAction: status.lastAction,
          lastActionAt: status.lastActionAt
        };
      });

      res.json({
        instance,
        nodes: enrichedNodes,
        edges,
        tasks,
        logs,
        node_statuses: nodeStatuses
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/instances/:id/pause - Pause instance
  app.post('/api/workflow/instances/:id/pause', authMiddleware, (req, res) => {
    try {
      if (hasCampaignWorkflowPipelineProof(req) && !isCanonicalWorkflowRouteId(req.params.id)) {
        return runCampaignInstanceControl(req, res, 'pause');
      }
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'Instance not found' });
      if (isCampaignLinkedInstance(db, instance)) {
        if (!hasCampaignWorkflowPipelineProof(req)) {
          return campaignWorkflowRouteFence(res, 'instance');
        }
        return runCampaignInstanceControl(req, res, 'pause');
      }
      if (instance.status !== 'active') return res.status(400).json({ error: 'Only active instances can be paused' });

      engine.pauseWorkflow(req.params.id);
      businessKnowledge.archiveWorkflowInstance(db, db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id), req.user, 'paused');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/instances/:id/resume - Resume instance
  app.post('/api/workflow/instances/:id/resume', authMiddleware, (req, res) => {
    try {
      if (hasCampaignWorkflowPipelineProof(req) && !isCanonicalWorkflowRouteId(req.params.id)) {
        return runCampaignInstanceControl(req, res, 'resume');
      }
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'Instance not found' });
      if (isCampaignLinkedInstance(db, instance)) {
        if (!hasCampaignWorkflowPipelineProof(req)) {
          return campaignWorkflowRouteFence(res, 'instance');
        }
        return runCampaignInstanceControl(req, res, 'resume');
      }
      if (instance.status !== 'paused') return res.status(400).json({ error: 'Only paused instances can be resumed' });

      engine.resumeWorkflow(req.params.id);
      businessKnowledge.archiveWorkflowInstance(db, db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id), req.user, 'resumed');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/instances/:id/cancel - Cancel instance
  app.post('/api/workflow/instances/:id/cancel', authMiddleware, (req, res) => {
    try {
      if (hasCampaignWorkflowPipelineProof(req) && !isCanonicalWorkflowRouteId(req.params.id)) {
        return runCampaignInstanceControl(req, res, 'cancel');
      }
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'Instance not found' });
      if (isCampaignLinkedInstance(db, instance)) {
        if (!hasCampaignWorkflowPipelineProof(req)) {
          return campaignWorkflowRouteFence(res, 'instance');
        }
        return runCampaignInstanceControl(req, res, 'cancel');
      }
      if (instance.status === 'completed' || instance.status === 'cancelled') {
        return res.status(400).json({ error: 'Instance is already finished' });
      }

      engine.cancelWorkflow(req.params.id);
      businessKnowledge.archiveWorkflowInstance(db, db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id), req.user, 'cancelled');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // TASK ROUTES
  // ============================================================

  // GET /api/workflow/tasks - Get tasks for current user (filter by status)
  app.get('/api/workflow/tasks', authMiddleware, (req, res) => {
    try {
      const campaignAccess = buildCollectionAccessPredicate('workflow_children', {
        userId: req.user.id
      });
      const requestedStatus = typeof req.query.status === 'string' && req.query.status.length > 0
        ? req.query.status
        : null;
      const linkedContext = `(
        wi.org_id IS NOT NULL
        OR wi.campaign_id IS NOT NULL
        OR wi.campaign_event_id IS NOT NULL
        OR wi.campaign_dispatch_id IS NOT NULL
        OR wi.business_type='campaign'
        OR COALESCE(workflow_link.active_link_count,0)>0
      )`;
      const rows = db.prepare(`
        SELECT
          wt.id,wt.instance_id,wt.node_id,wt.node_type,wt.title,wt.description,
          wt.assignee_id,wt.assignee_role,wt.status,wt.comment,wt.due_at,
          wt.completed_at,wt.completed_by,wt.created_at,wt.assignment_version,
          wi.business_type,wi.business_id,wi.template_id,
          wtn.name AS template_name,
          CASE WHEN ${linkedContext} THEN 1 ELSE 0 END AS is_linked
        FROM workflow_tasks wt
        JOIN workflow_instances wi ON wt.instance_id = wi.id
        JOIN workflow_templates wtn ON wi.template_id = wtn.id
        LEFT JOIN (
          SELECT
            record_id,COUNT(*) AS active_link_count,
            MIN(org_id) AS org_id,MIN(campaign_id) AS campaign_id
          FROM campaign_record_links
          WHERE record_type='workflow_instance'
            AND relation_type='workflow'
            AND revoked_at IS NULL
          GROUP BY record_id
        ) workflow_link ON workflow_link.record_id=CAST(wi.id AS TEXT)
        LEFT JOIN campaign_workflow_dispatches dispatch
          ON dispatch.id=wi.campaign_dispatch_id
        LEFT JOIN campaign_events dispatch_event
          ON dispatch_event.id=dispatch.event_id
        LEFT JOIN campaign_events root_event
          ON root_event.id=dispatch.trigger_event_id
        LEFT JOIN (
          SELECT org_id,id AS campaign_id
          FROM campaigns
        ) campaign_scope
          ON campaign_scope.org_id=wi.org_id
         AND campaign_scope.campaign_id=wi.campaign_id
        WHERE (? IS NULL OR wt.status=?)
          AND (
            (
              NOT ${linkedContext}
              AND (wt.assignee_id=? OR wt.assignee_id IS NULL)
            )
            OR
            (
              ${linkedContext}
              AND typeof(wi.org_id)='integer'
              AND wi.org_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
              AND typeof(wi.campaign_id)='integer'
              AND wi.campaign_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
              AND typeof(wi.campaign_event_id)='integer'
              AND wi.campaign_event_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
              AND typeof(wi.campaign_dispatch_id)='integer'
              AND wi.campaign_dispatch_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
              AND wi.business_type='campaign'
              AND wi.business_id=wi.campaign_id
              AND workflow_link.active_link_count=1
              AND workflow_link.org_id=wi.org_id
              AND workflow_link.campaign_id=wi.campaign_id
              AND campaign_scope.campaign_id IS NOT NULL
              AND dispatch.status='completed'
              AND dispatch.workflow_instance_id=wi.id
              AND dispatch.id=wi.campaign_dispatch_id
              AND dispatch.org_id=wi.org_id
              AND dispatch.campaign_id=wi.campaign_id
              AND dispatch.trigger_event_id=wi.campaign_event_id
              AND dispatch.template_id=wi.template_id
              AND dispatch_event.org_id=wi.org_id
              AND dispatch_event.campaign_id=wi.campaign_id
              AND root_event.id=dispatch.trigger_event_id
              AND root_event.org_id=wi.org_id
              AND root_event.campaign_id=wi.campaign_id
              AND root_event.event_type='lifecycle_transition'
              AND typeof(root_event.actor_user_id)='integer'
              AND root_event.actor_user_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
              AND (
                (
                  dispatch.reconciles_dispatch_id IS NULL
                  AND dispatch.event_id=dispatch.trigger_event_id
                  AND dispatch_event.event_type='lifecycle_transition'
                )
                OR
                (
                  dispatch.reconciles_dispatch_id IS NOT NULL
                  AND dispatch.event_id<>dispatch.trigger_event_id
                  AND dispatch_event.event_type='workflow_reconciliation'
                )
              )
              AND wi.initialization_status='ready'
              AND wi.initialization_error IS NULL
              AND typeof(wt.assignment_version)='integer'
              AND wt.assignment_version BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
              AND ${campaignAccess.sql}
            )
          )
        ORDER BY wt.created_at DESC
        LIMIT 200
      `).all(
        requestedStatus,
        requestedStatus,
        req.user.id,
        ...campaignAccess.params
      );
      const tasks = rows.map((row) => serializeTaskListRow(row, row.is_linked === 1));
      res.json({ tasks });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/workflow/tasks/:id - Task detail with business info
  app.get('/api/workflow/tasks/:id', authMiddleware, (req, res) => {
    try {
      const row = db.prepare(`
        SELECT
          wt.id,wt.instance_id,wt.node_id,wt.node_type,wt.title,wt.description,
          wt.assignee_id,wt.assignee_role,wt.status,wt.comment,wt.due_at,
          wt.completed_at,wt.completed_by,wt.created_at,wt.assignment_version,
          wi.business_type,wi.business_id,wi.template_id,wi.node_data,
          wtn.name AS template_name
        FROM workflow_tasks wt
        JOIN workflow_instances wi ON wt.instance_id = wi.id
        JOIN workflow_templates wtn ON wi.template_id = wtn.id
        WHERE wt.id = ?
      `).get(req.params.id);

      if (!row) return res.status(404).json({ error: 'Task not found' });

      const access = campaignWorkflow.resolveWorkflowReadAccess({
        userId: req.user.id,
        instanceId: row.instance_id
      });
      if (access.linked) {
        if (!access.allowed || !isPositiveSafeAssignmentVersion(row.assignment_version)) {
          return access.forbidden
            ? res.status(403).json({ error: 'Access denied' })
            : res.status(404).json({ error: 'Task not found' });
        }
      } else if (
        req.user.role !== 'admin' &&
        row.assignee_id !== req.user.id &&
        row.assignee_id !== null
      ) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const task = serializeTaskDetailRow(row, access.linked);

      // Parse instance node_data for business context
      let businessData = {};
      try { businessData = JSON.parse(task.node_data || '{}'); } catch (e) {}

      // Look up the associated business record
      let businessRecord = null;
      const tableMap = {
        customer: 'customers',
        demand: 'demands',
        proposal: 'proposals',
        collaboration: 'collaborations'
      };
      const tableName = tableMap[task.business_type];
      if (tableName) {
        try {
          businessRecord = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(task.business_id);
        } catch (e) { /* table may not exist */ }
      }

      // Get node logs for this task's node
      const logs = db.prepare(`
        SELECT id,instance_id,node_id,action,user_id,details,created_at
        FROM workflow_node_logs
        WHERE instance_id = ? AND node_id = ?
        ORDER BY created_at ASC
      `)
        .all(task.instance_id, task.node_id);

      res.json({ task, business: businessRecord, business_data: businessData, logs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/tasks/:id/approve - Approve task
  app.post('/api/workflow/tasks/:id/approve', authMiddleware, (req, res) => {
    try {
      if (hasCampaignWorkflowPipelineProof(req) && !isCanonicalWorkflowRouteId(req.params.id)) {
        return runCampaignTaskAction(req, res, 'approve');
      }
      const task = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id=?')
        .get(task.instance_id);
      if (isCampaignLinkedInstance(db, instance)) {
        if (!hasCampaignWorkflowPipelineProof(req)) {
          return campaignWorkflowRouteFence(res, 'task');
        }
        return runCampaignTaskAction(req, res, 'approve');
      }
      if (req.user.role !== 'admin' && task.assignee_id !== req.user.id && task.assignee_id !== null) {
        return res.status(403).json({ error: 'Access denied' });
      }

      engine.handleTaskAction(req.params.id, 'approve', req.user.id, req.body.comment || '');
      businessKnowledge.archiveWorkflowTask(db, db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(req.params.id), req.user, 'approve', req.body.comment || '');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/tasks/:id/reject - Reject task
  app.post('/api/workflow/tasks/:id/reject', authMiddleware, (req, res) => {
    try {
      if (hasCampaignWorkflowPipelineProof(req) && !isCanonicalWorkflowRouteId(req.params.id)) {
        return runCampaignTaskAction(req, res, 'reject');
      }
      const task = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id=?')
        .get(task.instance_id);
      if (isCampaignLinkedInstance(db, instance)) {
        if (!hasCampaignWorkflowPipelineProof(req)) {
          return campaignWorkflowRouteFence(res, 'task');
        }
        return runCampaignTaskAction(req, res, 'reject');
      }
      if (req.user.role !== 'admin' && task.assignee_id !== req.user.id && task.assignee_id !== null) {
        return res.status(403).json({ error: 'Access denied' });
      }

      engine.handleTaskAction(req.params.id, 'reject', req.user.id, req.body.comment || '');
      businessKnowledge.archiveWorkflowTask(db, db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(req.params.id), req.user, 'reject', req.body.comment || '');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/tasks/:id/complete - Complete task (for non-approval task nodes)
  app.post('/api/workflow/tasks/:id/complete', authMiddleware, (req, res) => {
    try {
      if (hasCampaignWorkflowPipelineProof(req) && !isCanonicalWorkflowRouteId(req.params.id)) {
        return runCampaignTaskAction(req, res, 'complete');
      }
      const task = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id=?')
        .get(task.instance_id);
      if (isCampaignLinkedInstance(db, instance)) {
        if (!hasCampaignWorkflowPipelineProof(req)) {
          return campaignWorkflowRouteFence(res, 'task');
        }
        return runCampaignTaskAction(req, res, 'complete');
      }
      if (req.user.role !== 'admin' && task.assignee_id !== req.user.id && task.assignee_id !== null) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Mark task as completed, log the action, and advance the workflow
      db.prepare("UPDATE workflow_tasks SET status = 'completed', comment = ?, completed_at = datetime('now'), completed_by = ? WHERE id = ?")
        .run(req.body.comment || '', req.user.id, req.params.id);

      db.prepare('INSERT INTO workflow_node_logs (instance_id, node_id, action, user_id, details) VALUES (?, ?, ?, ?, ?)')
        .run(task.instance_id, task.node_id, 'completed_by_user', req.user.id,
          JSON.stringify({ taskId: parseInt(req.params.id), comment: req.body.comment || '' }));

      engine.advanceNode(task.instance_id, { userId: req.user.id });
      businessKnowledge.archiveWorkflowTask(db, db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(req.params.id), req.user, 'complete', req.body.comment || '');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // ENGINE ROUTES
  // ============================================================

  // POST /api/workflow/check-timers - Manually trigger timer check (admin only)
  app.post('/api/workflow/check-timers', authMiddleware, adminOnly, (req, res) => {
    try {
      const fired = engine.checkTimers();
      res.json({ fired, message: fired + ' timer(s) fired' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/workflow/stats - Workflow statistics
  app.get('/api/workflow/stats', authMiddleware, (req, res) => {
    try {
      const visibility = buildWorkflowInstanceCollectionVisibility(req.user.id);
      const visibleInstances = `
        WITH visible_instances AS (
          SELECT
            wi.id,wi.business_type,wi.business_id,wi.status,
            wt.id AS template_row_id,wt.name AS template_name,wi.created_at
          ${WORKFLOW_INSTANCE_STATS_FROM}
          WHERE ${visibility.sql}
        )
      `;
      const visibleGet = (sql) => db.prepare(`${visibleInstances}${sql}`)
        .get(...visibility.params);
      const visibleAll = (sql) => db.prepare(`${visibleInstances}${sql}`)
        .all(...visibility.params);
      const stats = {
        totalTemplates: db.prepare('SELECT COUNT(*) as count FROM workflow_templates').get().count,
        activeTemplates: db.prepare('SELECT COUNT(*) as count FROM workflow_templates WHERE is_active = 1').get().count,
        totalInstances: visibleGet('SELECT COUNT(*) AS count FROM visible_instances').count,
        instancesByStatus: visibleAll(`
          SELECT status,COUNT(*) AS count
          FROM visible_instances
          GROUP BY status
        `),
        tasksByStatus: visibleAll(`
          SELECT task.status,COUNT(*) AS count
          FROM workflow_tasks task
          JOIN visible_instances instance ON task.instance_id=instance.id
          GROUP BY task.status
        `),
        pendingTasks: visibleGet(`
          SELECT COUNT(*) AS count
          FROM workflow_tasks task
          JOIN visible_instances instance ON task.instance_id=instance.id
          WHERE task.status='pending'
        `).count,
        instancesByType: visibleAll(`
          SELECT business_type,COUNT(*) AS count
          FROM visible_instances
          GROUP BY business_type
        `),
        recentInstances: visibleAll(`
          SELECT id,business_type,business_id,status,template_name,created_at
          FROM visible_instances
          WHERE template_row_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 10
        `)
      };
      res.json({ stats });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
