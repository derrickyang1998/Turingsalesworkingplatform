const engine = require('./workflow_engine');

module.exports = function(app, db, authMiddleware, adminOnly) {
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

  // GET /api/workflow/templates/:id - Get single template with nodes/edges parsed
  app.get('/api/workflow/templates/:id', authMiddleware, (req, res) => {
    try {
      const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(req.params.id);
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
      res.json({ id: result.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/workflow/templates/:id - Update template (increments version)
  app.put('/api/workflow/templates/:id', authMiddleware, (req, res) => {
    try {
      const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(req.params.id);
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
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/workflow/templates/:id - Delete template (admin only)
  app.delete('/api/workflow/templates/:id', authMiddleware, adminOnly, (req, res) => {
    try {
      const result = db.prepare('DELETE FROM workflow_templates WHERE id = ?').run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/templates/:id/publish - Set is_active=1 (admin only)
  app.post('/api/workflow/templates/:id/publish', authMiddleware, adminOnly, (req, res) => {
    try {
      const result = db.prepare("UPDATE workflow_templates SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
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
      const instanceId = engine.startWorkflow(template_id, business_type, business_id, data || {}, req.user.id);
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
      const instances = db.prepare(`
        SELECT wi.*, wt.name as template_name
        FROM workflow_instances wi
        JOIN workflow_templates wt ON wi.template_id = wt.id
        WHERE wi.business_type = ? AND wi.business_id = ?
        ORDER BY wi.created_at DESC
      `).all(business_type, business_id);
      res.json({ instances });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/workflow/instances - List instances
  app.get('/api/workflow/instances', authMiddleware, (req, res) => {
    try {
      let query = `
        SELECT wi.*, wt.name as template_name
        FROM workflow_instances wi
        JOIN workflow_templates wt ON wi.template_id = wt.id
        WHERE 1=1
      `;
      const params = [];

      // Non-admin users see only their own instances
      if (req.user.role !== 'admin') {
        query += ' AND wi.started_by = ?';
        params.push(req.user.id);
      }

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
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'Instance not found' });

      // Permission check: admin can see all, regular users see only their own
      if (req.user.role !== 'admin' && instance.started_by !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(instance.template_id);
      const rawNodes = JSON.parse(template.nodes);
      const edges = JSON.parse(template.edges);
      const logs = db.prepare('SELECT * FROM workflow_node_logs WHERE instance_id = ? ORDER BY created_at ASC').all(req.params.id);
      const tasks = db.prepare('SELECT * FROM workflow_tasks WHERE instance_id = ? ORDER BY created_at ASC').all(req.params.id);

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
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'Instance not found' });
      if (instance.status !== 'active') return res.status(400).json({ error: 'Only active instances can be paused' });

      engine.pauseWorkflow(req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/instances/:id/resume - Resume instance
  app.post('/api/workflow/instances/:id/resume', authMiddleware, (req, res) => {
    try {
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'Instance not found' });
      if (instance.status !== 'paused') return res.status(400).json({ error: 'Only paused instances can be resumed' });

      engine.resumeWorkflow(req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/instances/:id/cancel - Cancel instance
  app.post('/api/workflow/instances/:id/cancel', authMiddleware, (req, res) => {
    try {
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'Instance not found' });
      if (instance.status === 'completed' || instance.status === 'cancelled') {
        return res.status(400).json({ error: 'Instance is already finished' });
      }

      engine.cancelWorkflow(req.params.id);
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
      let query = `
        SELECT wt.*, wi.business_type, wi.business_id, wi.template_id, wtn.name as template_name
        FROM workflow_tasks wt
        JOIN workflow_instances wi ON wt.instance_id = wi.id
        JOIN workflow_templates wtn ON wi.template_id = wtn.id
        WHERE (wt.assignee_id = ? OR wt.assignee_id IS NULL)
      `;
      const params = [req.user.id];

      if (req.query.status) {
        query += ' AND wt.status = ?';
        params.push(req.query.status);
      }

      query += ' ORDER BY wt.created_at DESC LIMIT 200';

      const tasks = db.prepare(query).all(...params);
      res.json({ tasks });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/workflow/tasks/:id - Task detail with business info
  app.get('/api/workflow/tasks/:id', authMiddleware, (req, res) => {
    try {
      const task = db.prepare(`
        SELECT wt.*, wi.business_type, wi.business_id, wi.template_id, wi.node_data,
               wtn.name as template_name
        FROM workflow_tasks wt
        JOIN workflow_instances wi ON wt.instance_id = wi.id
        JOIN workflow_templates wtn ON wi.template_id = wtn.id
        WHERE wt.id = ?
      `).get(req.params.id);

      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Check access: admin or the assignee (or unassigned tasks)
      if (req.user.role !== 'admin' && task.assignee_id !== req.user.id && task.assignee_id !== null) {
        return res.status(403).json({ error: 'Access denied' });
      }

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
      const logs = db.prepare('SELECT * FROM workflow_node_logs WHERE instance_id = ? AND node_id = ? ORDER BY created_at ASC')
        .all(task.instance_id, task.node_id);

      res.json({ task, business: businessRecord, business_data: businessData, logs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/tasks/:id/approve - Approve task
  app.post('/api/workflow/tasks/:id/approve', authMiddleware, (req, res) => {
    try {
      const task = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (req.user.role !== 'admin' && task.assignee_id !== req.user.id && task.assignee_id !== null) {
        return res.status(403).json({ error: 'Access denied' });
      }

      engine.handleTaskAction(req.params.id, 'approve', req.user.id, req.body.comment || '');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/tasks/:id/reject - Reject task
  app.post('/api/workflow/tasks/:id/reject', authMiddleware, (req, res) => {
    try {
      const task = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (req.user.role !== 'admin' && task.assignee_id !== req.user.id && task.assignee_id !== null) {
        return res.status(403).json({ error: 'Access denied' });
      }

      engine.handleTaskAction(req.params.id, 'reject', req.user.id, req.body.comment || '');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/workflow/tasks/:id/complete - Complete task (for non-approval task nodes)
  app.post('/api/workflow/tasks/:id/complete', authMiddleware, (req, res) => {
    try {
      const task = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
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
      const stats = {
        totalTemplates: db.prepare('SELECT COUNT(*) as count FROM workflow_templates').get().count,
        activeTemplates: db.prepare('SELECT COUNT(*) as count FROM workflow_templates WHERE is_active = 1').get().count,
        totalInstances: db.prepare('SELECT COUNT(*) as count FROM workflow_instances').get().count,
        instancesByStatus: db.prepare('SELECT status, COUNT(*) as count FROM workflow_instances GROUP BY status').all(),
        tasksByStatus: db.prepare('SELECT status, COUNT(*) as count FROM workflow_tasks GROUP BY status').all(),
        pendingTasks: db.prepare("SELECT COUNT(*) as count FROM workflow_tasks WHERE status = 'pending'").get().count,
        instancesByType: db.prepare('SELECT business_type, COUNT(*) as count FROM workflow_instances GROUP BY business_type').all(),
        recentInstances: db.prepare(`
          SELECT wi.id, wi.business_type, wi.business_id, wi.status, wt.name as template_name, wi.created_at
          FROM workflow_instances wi
          JOIN workflow_templates wt ON wi.template_id = wt.id
          ORDER BY wi.created_at DESC LIMIT 10
        `).all()
      };
      res.json({ stats });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
