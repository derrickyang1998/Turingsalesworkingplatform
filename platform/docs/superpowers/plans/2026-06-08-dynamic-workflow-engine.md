# 动态工作流引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full-featured dynamic workflow engine with SVG visual designer for the Turing Business Platform.

**Architecture:** Express 5 backend with better-sqlite3, pure Vanilla JS frontend. Core engine in `workflow_engine.js`, API routes in `routes_workflow.js`, SVG designer integrated into existing `app.js`/`index.html` SPA pattern.

**Tech Stack:** Express 5, better-sqlite3, SVG DOM API, Vanilla JS ES6+

---

## File Structure

### New files:
- `server/workflow_engine.js` — Core engine: state machine, condition eval, timer checker
- `server/routes_workflow.js` — All `/api/workflow/*` routes

### Modified files:
- `server/db.js` — Append 5 workflow tables
- `server/server.js` — Register workflow routes + init timer loop
- `index.html` — Add workflow designer/instances/tasks pages
- `app.js` — Add workflow frontend logic

### Integration (Phase 3):
- `server/routes_customers.js` — Add workflow trigger on customer stage change

---

### Task 1: Add workflow tables to db.js

**Files:**
- Modify: `server/db.js` (append before `module.exports = db`)

- [ ] **Step 1: Append workflow tables**

Add 5 new tables to the existing `db.exec()` call in db.js. Insert right before `module.exports = db`:

```sql
-- Workflow Templates
CREATE TABLE IF NOT EXISTS workflow_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  module TEXT DEFAULT '',
  category TEXT DEFAULT 'approval',
  nodes TEXT NOT NULL DEFAULT '[]',
  edges TEXT NOT NULL DEFAULT '[]',
  version INTEGER DEFAULT 1,
  is_active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Workflow Instances
CREATE TABLE IF NOT EXISTS workflow_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  business_type TEXT NOT NULL,
  business_id INTEGER NOT NULL,
  current_node_id TEXT,
  status TEXT DEFAULT 'active',
  node_data TEXT DEFAULT '{}',
  started_by INTEGER,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Workflow Tasks
CREATE TABLE IF NOT EXISTS workflow_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  assignee_id INTEGER,
  assignee_role TEXT,
  status TEXT DEFAULT 'pending',
  comment TEXT DEFAULT '',
  due_at DATETIME,
  completed_at DATETIME,
  completed_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Workflow Timers
CREATE TABLE IF NOT EXISTS workflow_timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  fire_at DATETIME NOT NULL,
  action TEXT DEFAULT 'advance',
  fired INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Workflow Node Logs
CREATE TABLE IF NOT EXISTS workflow_node_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  action TEXT NOT NULL,
  user_id INTEGER,
  details TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 2: Verify db.js loads without errors**

Run: `node server/db.js`
Expected: No errors, exits cleanly (the file also seeds data when run directly).

---

### Task 2: Create workflow_engine.js

**Files:**
- Create: `server/workflow_engine.js`

This file exports the core engine with these methods:
```js
module.exports = {
  initEngine,
  startWorkflow,
  advanceNode,
  handleTaskAction,
  checkTimers,
  evaluateCondition,
  getNodeById,
  getNextNodes,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow
};
```

- [ ] **Step 1: Create workflow_engine.js with complete implementation**

```javascript
const db = require('./db');

// Node type configurations
const NODE_TYPES = {
  start: { hasTask: false, autoAdvance: true },
  end: { hasTask: false, autoAdvance: false },
  approval: { hasTask: true, autoAdvance: false },
  task: { hasTask: true, autoAdvance: false },
  condition: { hasTask: false, autoAdvance: true },
  parallel: { hasTask: false, autoAdvance: true },
  timer: { hasTask: false, autoAdvance: false },
  webhook: { hasTask: false, autoAdvance: true },
  auto_action: { hasTask: false, autoAdvance: true },
  sub_process: { hasTask: false, autoAdvance: true }
};

function initEngine() {
  // Start timer checker - runs every 30 seconds
  setInterval(() => {
    try { checkTimers(); } catch(e) { console.error('Timer check error:', e); }
  }, 30000);
  console.log('⏱ Workflow timer engine started (30s interval)');
}

function startWorkflow(templateId, businessType, businessId, data, userId) {
  const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(templateId);
  if (!template) throw new Error('Template not found');
  
  const nodes = JSON.parse(template.nodes);
  const edges = JSON.parse(template.edges);
  const startNode = nodes.find(n => n.type === 'start');
  if (!startNode) throw new Error('Template has no start node');
  
  const result = db.prepare(`INSERT INTO workflow_instances 
    (template_id, business_type, business_id, current_node_id, status, node_data, started_by) 
    VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .run(templateId, businessType, businessId, startNode.id, JSON.stringify({
      data: data || {},
      context: { edges, nodes }
    }), userId);
  
  const instanceId = result.lastInsertRowid;
  
  // Log entry
  logNodeAction(instanceId, startNode.id, 'entered', userId, { message: 'Workflow started' });
  
  // Auto-advance if start node is auto
  if (startNode.type === 'start') {
    advanceNode(instanceId, { userId });
  }
  
  return instanceId;
}

function advanceNode(instanceId, options = {}) {
  const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
  if (!instance || instance.status !== 'active') return;
  
  const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(instance.template_id);
  const nodes = JSON.parse(template.nodes);
  const edges = JSON.parse(template.edges);
  const nodeData = JSON.parse(instance.node_data);
  
  const currentNode = nodes.find(n => n.id === instance.current_node_id);
  if (!currentNode) return;
  
  // Log exit
  logNodeAction(instanceId, currentNode.id, 'exited', options.userId, {});
  
  // Find next nodes based on edges
  const nextEdges = getOutgoingEdges(edges, currentNode.id, nodeData.data);
  
  for (const edge of nextEdges) {
    const nextNode = nodes.find(n => n.id === edge.to);
    if (!nextNode) continue;
    
    // Enter next node
    db.prepare('UPDATE workflow_instances SET current_node_id = ? WHERE id = ?')
      .run(nextNode.id, instanceId);
    
    logNodeAction(instanceId, nextNode.id, 'entered', options.userId, {});
    
    executeNode(instanceId, nextNode, options.userId);
  }
}

function executeNode(instanceId, node, userId) {
  const config = node.config || {};
  
  switch (node.type) {
    case 'end':
      db.prepare(`UPDATE workflow_instances SET status = 'completed', completed_at = datetime('now') WHERE id = ?`)
        .run(instanceId);
      logNodeAction(instanceId, node.id, 'completed', userId, {});
      break;
      
    case 'approval':
    case 'task':
      // Create task
      db.prepare(`INSERT INTO workflow_tasks 
        (instance_id, node_id, node_type, title, description, assignee_id, assignee_role, due_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(instanceId, node.id, node.type, config.title || node.label, 
          config.description || '', config.assignee_id || null, 
          config.assignee_role || null, config.due_at || null);
      break;
      
    case 'condition':
      // Evaluate condition and follow matching edge
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
      const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(instance.template_id);
      const edges = JSON.parse(template.edges);
      const nodeData = JSON.parse(instance.node_data);
      
      const conditionResult = evaluateCondition(config.expression, nodeData.data);
      logNodeAction(instanceId, node.id, 'condition_evaluated', userId, { result: conditionResult });
      
      // The advanceNode will be called after this
      // We need to return control and let the caller continue
      break;
      
    case 'timer':
      if (config.delay_minutes) {
        const fireAt = new Date(Date.now() + config.delay_minutes * 60 * 1000).toISOString();
        db.prepare('INSERT INTO workflow_timers (instance_id, node_id, fire_at) VALUES (?, ?, ?)')
          .run(instanceId, node.id, fireAt);
        logNodeAction(instanceId, node.id, 'timer_set', userId, { fire_at: fireAt });
      }
      break;
      
    case 'webhook':
      // Execute webhook call (fire and forget - async)
      if (config.url) {
        const payload = buildWebhookPayload(config, instanceId, node.id);
        callWebhook(config.url, config.method || 'POST', config.headers || {}, payload)
          .then(response => {
            // Log result
            const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
            if (instance && instance.current_node_id === node.id) {
              logNodeAction(instanceId, node.id, 'webhook_completed', userId, { status: response.status });
              advanceNode(instanceId, { userId });
            }
          })
          .catch(err => {
            logNodeAction(instanceId, node.id, 'webhook_failed', userId, { error: err.message });
            if (config.on_error === 'advance') {
              advanceNode(instanceId, { userId });
            }
          });
        logNodeAction(instanceId, node.id, 'webhook_called', userId, { url: config.url });
      }
      return; // Don't auto-advance, wait for callback
      
    case 'auto_action':
      executeAutoAction(config, instanceId, node.id, userId);
      // Auto-advance is handled by the caller
      break;
      
    case 'sub_process':
      if (config.template_id) {
        const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
        const nodeData = JSON.parse(instance.node_data);
        startWorkflow(config.template_id, 'sub_process', instanceId, nodeData.data, userId);
        logNodeAction(instanceId, node.id, 'subprocess_started', userId, { sub_template_id: config.template_id });
      }
      break;
  }
  
  // Auto-advance for non-task, non-timer nodes (unless already handled async)
  if (NODE_TYPES[node.type] && NODE_TYPES[node.type].autoAdvance && 
      node.type !== 'webhook' && node.type !== 'timer') {
    // For condition nodes, evaluate before advancing
    if (node.type === 'condition') {
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
      advanceNode(instanceId, { userId });
    } else {
      advanceNode(instanceId, { userId });
    }
  }
}

function handleTaskAction(taskId, action, userId, comment) {
  const task = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(taskId);
  if (!task || task.status !== 'pending') throw new Error('Task not available');
  
  const now = new Date().toISOString();
  const newStatus = action === 'approve' ? 'completed' : 'rejected';
  
  db.prepare(`UPDATE workflow_tasks SET status = ?, comment = ?, completed_at = ?, completed_by = ? WHERE id = ?`)
    .run(newStatus, comment || '', now, userId, taskId);
  
  logNodeAction(task.instance_id, task.node_id, `${newStatus}_by_user`, userId, { taskId, comment });
  
  // If rejected, check if there's a rejection path
  if (action === 'reject') {
    const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(task.instance_id);
    const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(instance.template_id);
    const edges = JSON.parse(template.edges);
    
    // Look for "rejected" edges (edge with condition matching rejection)
    const rejectEdges = edges.filter(e => e.from === task.node_id && e.label === 'rejected');
    if (rejectEdges.length > 0) {
      const rejectNode = rejectEdges[0];
      db.prepare('UPDATE workflow_instances SET current_node_id = ? WHERE id = ?')
        .run(rejectNode.to, task.instance_id);
      const nodes = JSON.parse(template.nodes);
      const nextNode = nodes.find(n => n.id === rejectNode.to);
      if (nextNode) {
        logNodeAction(task.instance_id, nextNode.id, 'entered', userId, { from_rejection: true });
        executeNode(task.instance_id, nextNode, userId);
      }
    }
  } else {
    // Approved - advance
    advanceNode(task.instance_id, { userId });
  }
}

function checkTimers() {
  const dueTimers = db.prepare(`SELECT * FROM workflow_timers 
    WHERE fired = 0 AND fire_at <= datetime('now')`).all();
  
  for (const timer of dueTimers) {
    db.prepare('UPDATE workflow_timers SET fired = 1 WHERE id = ?').run(timer.id);
    logNodeAction(timer.instance_id, timer.node_id, 'timer_fired', null, {});
    advanceNode(timer.instance_id, {});
  }
  
  return dueTimers.length;
}

function evaluateCondition(expression, data) {
  if (!expression) return true;
  
  try {
    // Simple expression evaluator
    // Supports: {operator: "==", left: "...", right: "..."}
    // Operators: ==, !=, >, <, >=, <=, in, and, or
    
    const evalExpr = (expr) => {
      if (!expr || typeof expr !== 'object') return expr;
      
      const op = expr.operator || expr.op;
      const left = typeof expr.left === 'object' ? resolveValue(expr.left, data) : expr.left;
      const right = typeof expr.right === 'object' ? resolveValue(expr.right, data) : expr.right;
      
      switch (op) {
        case '==': return left == right;
        case '!=': return left != right;
        case '>': return Number(left) > Number(right);
        case '<': return Number(left) < Number(right);
        case '>=': return Number(left) >= Number(right);
        case '<=': return Number(left) <= Number(right);
        case 'in': return Array.isArray(right) ? right.includes(left) : String(right).includes(String(left));
        case 'and': return evalExpr(left) && evalExpr(right);
        case 'or': return evalExpr(left) || evalExpr(right);
        case 'not': return !evalExpr(left);
        default: return true;
      }
    };
    
    return evalExpr(expression);
  } catch(e) {
    console.error('Condition eval error:', e);
    return false;
  }
}

function resolveValue(val, data) {
  if (typeof val === 'object' && val.var) {
    const keys = val.var.split('.');
    let current = data;
    for (const key of keys) {
      if (current === null || current === undefined) return undefined;
      current = current[key];
    }
    return current;
  }
  return val;
}

function getNodeById(template, nodeId) {
  const nodes = JSON.parse(template.nodes);
  return nodes.find(n => n.id === nodeId);
}

function getNextNodes(template, currentNodeId, conditionResult) {
  const edges = JSON.parse(template.edges);
  const outgoing = edges.filter(e => e.from === currentNodeId);
  
  if (outgoing.length === 0) return [];
  
  // Check if any edge has conditions
  const hasConditions = outgoing.some(e => e.condition);
  
  if (hasConditions) {
    // Filter by condition
    return outgoing.filter(e => {
      if (!e.condition) return false;
      return evaluateCondition(e.condition, conditionResult || {});
    }).map(e => ({ nodeId: e.to, edgeId: e.id, label: e.label }));
  }
  
  // No conditions - follow all
  return outgoing.map(e => ({ nodeId: e.to, edgeId: e.id, label: e.label }));
}

function getOutgoingEdges(edges, nodeId, data) {
  const outgoing = edges.filter(e => e.from === nodeId);
  
  if (outgoing.length === 0) return [];
  
  // Check if any edge has a condition
  const hasConditions = outgoing.some(e => e.condition);
  
  if (hasConditions) {
    // Return only edges whose conditions evaluate to true
    return outgoing.filter(e => {
      if (!e.condition) return false;
      return evaluateCondition(e.condition, data);
    });
  }
  
  return outgoing;
}

function pauseWorkflow(instanceId) {
  db.prepare("UPDATE workflow_instances SET status = 'paused' WHERE id = ?").run(instanceId);
  logNodeAction(instanceId, null, 'paused', null, {});
}

function resumeWorkflow(instanceId) {
  db.prepare("UPDATE workflow_instances SET status = 'active' WHERE id = ?").run(instanceId);
  logNodeAction(instanceId, null, 'resumed', null, {});
}

function cancelWorkflow(instanceId) {
  const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
  if (!instance) return;
  db.prepare("UPDATE workflow_instances SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?").run(instanceId);
  
  // Cancel pending tasks
  db.prepare("UPDATE workflow_tasks SET status = 'cancelled' WHERE instance_id = ? AND status = 'pending'").run(instanceId);
  
  logNodeAction(instanceId, instance.current_node_id, 'cancelled', null, {});
}

// Helper functions
function logNodeAction(instanceId, nodeId, action, userId, details) {
  db.prepare(`INSERT INTO workflow_node_logs (instance_id, node_id, action, user_id, details) VALUES (?, ?, ?, ?, ?)`)
    .run(instanceId, nodeId, action, userId, JSON.stringify(details));
}

function buildWebhookPayload(config, instanceId, nodeId) {
  const base = config.body_template || {};
  return { ...base, instance_id: instanceId, node_id: nodeId, timestamp: new Date().toISOString() };
}

async function callWebhook(url, method, headers, payload) {
  try {
    const https = require('https');
    const http = require('http');
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers
        },
        timeout: 10000
      };
      
      const req = mod.request(options, (res) => {
        resolve({ status: res.statusCode });
      });
      
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Webhook timeout')); });
      req.write(body);
      req.end();
    });
  } catch(e) {
    throw e;
  }
}

function executeAutoAction(config, instanceId, nodeId, userId) {
  const actionType = config.action_type; // 'update_field', 'create_record', 'notify'
  
  switch (actionType) {
    case 'update_field':
      // Update a field in the business object
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
      if (instance && config.field && config.value) {
        try {
          const tableMap = {
            customer: 'customers',
            demand: 'demands',
            proposal: 'proposals',
            collaboration: 'collaborations'
          };
          const tableName = tableMap[instance.business_type];
          if (tableName) {
            const safeField = config.field.replace(/[^a-z_]/gi, '');
            const safeValue = config.value;
            db.prepare(`UPDATE ${tableName} SET ${safeField} = ?, updated_at = datetime('now') WHERE id = ?`)
              .run(safeValue, instance.business_id);
            logNodeAction(instanceId, nodeId, 'field_updated', userId, { field: safeField, value: safeValue });
          }
        } catch(e) {
          logNodeAction(instanceId, nodeId, 'field_update_failed', userId, { error: e.message });
        }
      }
      break;
      
    case 'notify':
      // Create notification (for future use with a notification system)
      logNodeAction(instanceId, nodeId, 'notification_sent', userId, { message: config.message || '' });
      break;
      
    default:
      logNodeAction(instanceId, nodeId, 'auto_action_unknown', userId, { action_type: actionType });
  }
}

module.exports = {
  initEngine,
  startWorkflow,
  advanceNode,
  handleTaskAction,
  checkTimers,
  evaluateCondition,
  getNodeById,
  getNextNodes,
  getOutgoingEdges,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  NODE_TYPES,
  callWebhook
};
```

---

### Task 3: Create routes_workflow.js

**Files:**
- Create: `server/routes_workflow.js`

- [ ] **Step 1: Create routes_workflow.js with all API routes**

```javascript
const engine = require('./workflow_engine');

module.exports = function(app, db, authMiddleware, adminOnly) {
  
  // ===== TEMPLATE ROUTES =====
  
  // List templates
  app.get('/api/workflow/templates', authMiddleware, (req, res) => {
    const templates = db.prepare(`
      SELECT id, name, description, module, category, version, is_active, 
             created_by, created_at, updated_at 
      FROM workflow_templates ORDER BY updated_at DESC
    `).all();
    res.json({ templates });
  });
  
  // Get template detail (with nodes + edges)
  app.get('/api/workflow/templates/:id', authMiddleware, (req, res) => {
    const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    template.nodes = JSON.parse(template.nodes);
    template.edges = JSON.parse(template.edges);
    res.json({ template });
  });
  
  // Create template
  app.post('/api/workflow/templates', authMiddleware, (req, res) => {
    const { name, description, module, category, nodes, edges } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    
    const result = db.prepare(`INSERT INTO workflow_templates 
      (name, description, module, category, nodes, edges, created_by) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(name, description || '', module || '', category || 'approval', 
        JSON.stringify(nodes || []), JSON.stringify(edges || []), req.user.id);
    
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, 'create_workflow_template', 'workflow', `Created template: ${name}`, req.ip);
    
    res.json({ id: result.lastInsertRowid });
  });
  
  // Update template
  app.put('/api/workflow/templates/:id', authMiddleware, (req, res) => {
    const { name, description, module, category, nodes, edges } = req.body;
    const existing = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });
    
    db.prepare(`UPDATE workflow_templates SET 
      name = COALESCE(?, name), 
      description = COALESCE(?, description),
      module = COALESCE(?, module),
      category = COALESCE(?, category),
      nodes = COALESCE(?, nodes),
      edges = COALESCE(?, edges),
      version = version + 1,
      updated_at = datetime('now')
      WHERE id = ?`)
      .run(name, description, module, category, 
        nodes ? JSON.stringify(nodes) : null, 
        edges ? JSON.stringify(edges) : null,
        req.params.id);
    
    res.json({ success: true });
  });
  
  // Delete template
  app.delete('/api/workflow/templates/:id', authMiddleware, adminOnly, (req, res) => {
    db.prepare('DELETE FROM workflow_templates WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });
  
  // Publish template (set is_active = 1)
  app.post('/api/workflow/templates/:id/publish', authMiddleware, adminOnly, (req, res) => {
    db.prepare("UPDATE workflow_templates SET is_active = 1, updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    res.json({ success: true });
  });
  
  
  // ===== INSTANCE ROUTES =====
  
  // Start workflow manually
  app.post('/api/workflow/instances', authMiddleware, (req, res) => {
    const { template_id, business_type, business_id, data } = req.body;
    if (!template_id || !business_type || !business_id) {
      return res.status(400).json({ error: 'template_id, business_type, business_id required' });
    }
    
    try {
      const instanceId = engine.startWorkflow(template_id, business_type, business_id, data, req.user.id);
      res.json({ id: instanceId });
    } catch(e) {
      res.status(400).json({ error: e.message });
    }
  });
  
  // List instances
  app.get('/api/workflow/instances', authMiddleware, (req, res) => {
    const { status, business_type, business_id, template_id } = req.query;
    let query = `SELECT wi.*, wt.name as template_name FROM workflow_instances wi 
                 JOIN workflow_templates wt ON wi.template_id = wt.id WHERE 1=1`;
    let params = [];
    
    if (status) { query += ' AND wi.status = ?'; params.push(status); }
    if (business_type) { query += ' AND wi.business_type = ?'; params.push(business_type); }
    if (business_id) { query += ' AND wi.business_id = ?'; params.push(business_id); }
    if (template_id) { query += ' AND wi.template_id = ?'; params.push(template_id); }
    
    if (req.user.role !== 'admin') {
      query += ' AND wi.started_by = ?';
      params.push(req.user.id);
    }
    
    query += ' ORDER BY wi.created_at DESC LIMIT 100';
    
    const instances = db.prepare(query).all(...params);
    res.json({ instances });
  });
  
  // Get instance detail
  app.get('/api/workflow/instances/:id', authMiddleware, (req, res) => {
    const instance = db.prepare(`SELECT wi.*, wt.name as template_name, wt.nodes, wt.edges 
      FROM workflow_instances wi JOIN workflow_templates wt ON wi.template_id = wt.id 
      WHERE wi.id = ?`).get(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    
    instance.node_data = JSON.parse(instance.node_data || '{}');
    
    // Get tasks for this instance
    const tasks = db.prepare('SELECT * FROM workflow_tasks WHERE instance_id = ? ORDER BY created_at').all(req.params.id);
    
    // Get logs
    const logs = db.prepare('SELECT * FROM workflow_node_logs WHERE instance_id = ? ORDER BY created_at').all(req.params.id);
    
    // Parse nodes/edges for frontend
    const templateNodes = JSON.parse(instance.nodes || '[]');
    const templateEdges = JSON.parse(instance.edges || '[]');
    
    // Mark current node
    const enrichedNodes = templateNodes.map(n => ({
      ...n,
      is_current: n.id === instance.current_node_id
    }));
    
    // Determine node statuses from logs
    const nodeStatuses = {};
    for (const log of logs) {
      if (log.node_id && !nodeStatuses[log.node_id]) {
        if (log.action === 'completed' || log.action === 'exited') {
          nodeStatuses[log.node_id] = 'completed';
        } else if (log.action === 'entered') {
          nodeStatuses[log.node_id] = 'active';
        }
      }
    }
    
    res.json({ instance, nodes: enrichedNodes, edges: templateEdges, tasks, logs, node_statuses: nodeStatuses });
  });
  
  // Pause/Resume/Cancel
  app.post('/api/workflow/instances/:id/pause', authMiddleware, (req, res) => {
    engine.pauseWorkflow(req.params.id);
    res.json({ success: true });
  });
  
  app.post('/api/workflow/instances/:id/resume', authMiddleware, (req, res) => {
    engine.resumeWorkflow(req.params.id);
    res.json({ success: true });
  });
  
  app.post('/api/workflow/instances/:id/cancel', authMiddleware, (req, res) => {
    engine.cancelWorkflow(req.params.id);
    res.json({ success: true });
  });
  
  // Get instances by business object
  app.get('/api/workflow/instances/by-business', authMiddleware, (req, res) => {
    const { business_type, business_id } = req.query;
    if (!business_type || !business_id) {
      return res.status(400).json({ error: 'business_type and business_id required' });
    }
    const instances = db.prepare(`SELECT wi.*, wt.name as template_name 
      FROM workflow_instances wi JOIN workflow_templates wt ON wi.template_id = wt.id 
      WHERE wi.business_type = ? AND wi.business_id = ? 
      ORDER BY wi.created_at DESC`).all(business_type, business_id);
    res.json({ instances });
  });
  
  
  // ===== TASK ROUTES =====
  
  // Get my tasks
  app.get('/api/workflow/tasks', authMiddleware, (req, res) => {
    const { status } = req.query;
    let query = `SELECT wt.*, wi.business_type, wi.business_id, wf.name as template_name
      FROM workflow_tasks wt 
      JOIN workflow_instances wi ON wt.instance_id = wi.id
      JOIN workflow_templates wf ON wi.template_id = wf.id
      WHERE (wt.assignee_id = ? OR wt.assignee_role = ? OR wt.assignee_id IS NULL)
      AND wi.status = 'active'`;
    let params = [req.user.id, req.user.role];
    
    if (status) { query += ' AND wt.status = ?'; params.push(status); }
    
    query += ' ORDER BY wt.created_at DESC LIMIT 100';
    
    const tasks = db.prepare(query).all(...params);
    res.json({ tasks });
  });
  
  // Get task detail
  app.get('/api/workflow/tasks/:id', authMiddleware, (req, res) => {
    const task = db.prepare(`SELECT wt.*, wi.business_type, wi.business_id, wi.node_data, 
      wf.name as template_name, wf.nodes as template_nodes
      FROM workflow_tasks wt 
      JOIN workflow_instances wi ON wt.instance_id = wi.id
      JOIN workflow_templates wf ON wi.template_id = wf.id
      WHERE wt.id = ?`).get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ task });
  });
  
  // Approve task
  app.post('/api/workflow/tasks/:id/approve', authMiddleware, (req, res) => {
    try {
      engine.handleTaskAction(parseInt(req.params.id), 'approve', req.user.id, req.body.comment);
      res.json({ success: true });
    } catch(e) {
      res.status(400).json({ error: e.message });
    }
  });
  
  // Reject task
  app.post('/api/workflow/tasks/:id/reject', authMiddleware, (req, res) => {
    try {
      engine.handleTaskAction(parseInt(req.params.id), 'reject', req.user.id, req.body.comment);
      res.json({ success: true });
    } catch(e) {
      res.status(400).json({ error: e.message });
    }
  });
  
  // Complete task (for task nodes)
  app.post('/api/workflow/tasks/:id/complete', authMiddleware, (req, res) => {
    try {
      engine.handleTaskAction(parseInt(req.params.id), 'approve', req.user.id, req.body.comment);
      res.json({ success: true });
    } catch(e) {
      res.status(400).json({ error: e.message });
    }
  });
  
  
  // ===== ENGINE ROUTES =====
  
  // Trigger timer check
  app.post('/api/workflow/check-timers', authMiddleware, adminOnly, (req, res) => {
    const count = engine.checkTimers();
    res.json({ timers_fired: count });
  });
  
  // Get workflow stats
  app.get('/api/workflow/stats', authMiddleware, (req, res) => {
    const stats = {
      totalTemplates: db.prepare('SELECT COUNT(*) as c FROM workflow_templates').get().c,
      activeTemplates: db.prepare('SELECT COUNT(*) as c FROM workflow_templates WHERE is_active = 1').get().c,
      activeInstances: db.prepare("SELECT COUNT(*) as c FROM workflow_instances WHERE status = 'active'").get().c,
      completedInstances: db.prepare("SELECT COUNT(*) as c FROM workflow_instances WHERE status = 'completed'").get().c,
      pendingTasks: db.prepare("SELECT COUNT(*) as c FROM workflow_tasks WHERE status = 'pending'").get().c,
      myPendingTasks: db.prepare("SELECT COUNT(*) as c FROM workflow_tasks WHERE status = 'pending' AND (assignee_id = ? OR assignee_role = ?)")
        .get(req.user.id, req.user.role).c,
      instancesByModule: db.prepare('SELECT business_type, COUNT(*) as c FROM workflow_instances GROUP BY business_type').all()
    };
    res.json({ stats });
  });
};
```

---

### Task 4: Register workflow routes in server.js

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Add require for routes_workflow and engine init**

In server.js, find the line that reads:
```js
require('./routes_brands')(app, db, authMiddleware);
```

Add after it:
```js
// ===== WORKFLOW ROUTES =====
require('./routes_workflow')(app, db, authMiddleware, adminOnly);

// ===== WORKFLOW ENGINE INIT =====
const workflowEngine = require('./workflow_engine');
workflowEngine.initEngine();
```

- [ ] **Step 2: Verify server starts without errors**

Run: `cd platform/server && node server.js`
Expected: Server starts, shows workflow engine message "⏱ Workflow timer engine started (30s interval)"

---

### Task 5: Add workflow SVG designer and pages to index.html

**Files:**
- Modify: `index.html` (40KB, append workflow pages before `</body>`)

- [ ] **Step 1: Add workflow navigation menu items**

Find the existing navigation menu in index.html. Add workflow entries:
```html
<a href="#" onclick="switchPage('workflow-templates')">📋 流程模板</a>
<a href="#" onclick="switchPage('workflow-instances')">⚡ 流程实例</a>
<a href="#" onclick="switchPage('workflow-tasks')">📌 我的待办</a>
<a href="#" onclick="switchPage('workflow-designer')">✏️ 流程设计器</a>
```

- [ ] **Step 2: Add workflow page sections**

After the last existing page `<div>` and before `</body>`, add the workflow sections:

```html
<!-- ===== FLOW DESIGNER PAGE ===== -->
<div id="page-workflow-designer" class="page" style="display:none;">
  <div class="wf-designer-container">
    <!-- Toolbar -->
    <div class="wf-toolbar">
      <input type="text" id="wf-template-name" placeholder="流程名称..." style="font-size:16px;font-weight:bold;border:none;outline:none;flex:1;">
      <button onclick="wfSaveTemplate()">💾 保存</button>
      <button onclick="wfPublishTemplate()">🚀 发布</button>
      <button onclick="wfUndo()">↩ 撤销</button>
      <button onclick="wfRedo()">↪ 重做</button>
      <button onclick="wfClearCanvas()">🗑 清空</button>
      <span id="wf-template-id" style="display:none;"></span>
    </div>
    <div style="display:flex;flex:1;overflow:hidden;">
      <!-- Node Toolbox -->
      <div class="wf-toolbox">
        <div class="wf-toolbox-title">节点工具箱</div>
        <div class="wf-toolbox-group">
          <div class="wf-node-palette" data-type="start" draggable="true">● 开始</div>
          <div class="wf-node-palette" data-type="end" draggable="true">● 结束</div>
          <div class="wf-node-palette" data-type="approval" draggable="true">✓ 审批</div>
          <div class="wf-node-palette" data-type="task" draggable="true">☰ 任务</div>
          <div class="wf-node-palette" data-type="condition" draggable="true">◇ 条件</div>
          <div class="wf-node-palette" data-type="parallel" draggable="true">≡ 并行</div>
          <div class="wf-node-palette" data-type="timer" draggable="true">⏱ 定时</div>
          <div class="wf-node-palette" data-type="webhook" draggable="true">↻ Webhook</div>
          <div class="wf-node-palette" data-type="auto_action" draggable="true">⚡ 自动</div>
          <div class="wf-node-palette" data-type="sub_process" draggable="true">⊞ 子流程</div>
        </div>
      </div>
      <!-- SVG Canvas -->
      <div class="wf-canvas-wrapper" id="wf-canvas-wrapper">
        <svg id="wf-svg-canvas" width="100%" height="100%">
          <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
              <polygon points="0 0, 10 3.5, 0 7" fill="#666" />
            </marker>
          </defs>
          <!-- Edges layer -->
          <g id="wf-edges-layer"></g>
          <!-- Nodes layer -->
          <g id="wf-nodes-layer"></g>
          <!-- Connection temp line -->
          <line id="wf-connection-line" stroke="#2196F3" stroke-width="2" stroke-dasharray="5,5" style="display:none" marker-end="url(#arrowhead)"/>
          <!-- Selection box -->
          <rect id="wf-selection-box" stroke="#2196F3" stroke-width="1" fill="rgba(33,150,243,0.1)" style="display:none"/>
        </svg>
        <div id="wf-canvas-empty" class="wf-canvas-empty">
          从左侧拖拽节点到这里开始设计流程<br>
          <small>从一个「开始」节点 -> 添加审批/任务 -> 连接到「结束」节点</small>
        </div>
      </div>
      <!-- Property Panel -->
      <div class="wf-property-panel" id="wf-property-panel">
        <div class="wf-prop-header">属性配置</div>
        <div id="wf-prop-content">
          <p style="color:#999;padding:20px;text-align:center;">点击节点或连线<br>编辑属性</p>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ===== WORKFLOW TEMPLATES PAGE ===== -->
<div id="page-workflow-templates" class="page" style="display:none;">
  <div style="padding:20px;max-width:1200px;margin:0 auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h2>📋 流程模板</h2>
      <div>
        <input type="text" id="wf-tpl-search" placeholder="搜索模板..." oninput="wfLoadTemplates()" style="padding:6px;margin-right:8px;">
        <button onclick="switchPage('workflow-designer')" style="padding:8px 16px;background:#4CAF50;color:white;border:none;border-radius:4px;cursor:pointer;">+ 新建模板</button>
      </div>
    </div>
    <table class="wf-table" id="wf-templates-table">
      <thead><tr>
        <th>名称</th><th>模块</th><th>分类</th><th>版本</th><th>状态</th><th>创建时间</th><th>操作</th>
      </tr></thead>
      <tbody id="wf-templates-body">
        <tr><td colspan="7" style="text-align:center;color:#999;">加载中...</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- ===== WORKFLOW INSTANCES PAGE ===== -->
<div id="page-workflow-instances" class="page" style="display:none;">
  <div style="padding:20px;max-width:1200px;margin:0 auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h2>⚡ 流程实例</h2>
      <div>
        <select id="wf-inst-filter-status" onchange="wfLoadInstances()"><option value="">全部状态</option>
          <option value="active">运行中</option><option value="completed">已完成</option>
          <option value="paused">已暂停</option><option value="cancelled">已取消</option><option value="rejected">已拒绝</option>
        </select>
      </div>
    </div>
    <table class="wf-table" id="wf-instances-table">
      <thead><tr>
        <th>ID</th><th>模板</th><th>业务类型</th><th>业务ID</th><th>状态</th><th>启动人</th><th>时间</th><th>操作</th>
      </tr></thead>
      <tbody id="wf-instances-body">
        <tr><td colspan="8" style="text-align:center;color:#999;">加载中...</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- ===== WORKFLOW TASKS PAGE ===== -->
<div id="page-workflow-tasks" class="page" style="display:none;">
  <div style="padding:20px;max-width:1200px;margin:0 auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h2>📌 我的待办</h2>
      <div>
        <select id="wf-task-filter" onchange="wfLoadTasks()">
          <option value="pending">待处理</option><option value="">全部</option>
          <option value="completed">已完成</option><option value="rejected">已拒绝</option>
        </select>
      </div>
    </div>
    <div id="wf-tasks-list"></div>
  </div>
</div>

<!-- ===== WORKFLOW INSTANCE DETAIL MODAL ===== -->
<div id="wf-instance-modal" class="wf-modal" style="display:none;">
  <div class="wf-modal-content" style="width:80%;max-width:900px;">
    <span class="wf-modal-close" onclick="document.getElementById('wf-instance-modal').style.display='none'">&times;</span>
    <h3 id="wf-instance-modal-title">流程实例详情</h3>
    <div id="wf-instance-modal-body"></div>
  </div>
</div>
```

- [ ] **Step 3: Add workflow CSS styles**

Add to the `<style>` section of index.html:
```css
/* ===== WORKFLOW DESIGNER STYLES ===== */
.wf-designer-container { display:flex;flex-direction:column;height:calc(100vh - 80px); }
.wf-toolbar { display:flex;align-items:center;gap:8px;padding:8px 16px;background:#f5f5f5;border-bottom:1px solid #ddd; }
.wf-toolbar button { padding:6px 14px;border:1px solid #ccc;border-radius:4px;background:white;cursor:pointer;font-size:13px; }
.wf-toolbar button:hover { background:#e8e8e8; }
.wf-toolbox { width:140px;background:#fafafa;border-right:1px solid #ddd;padding:8px;overflow-y:auto;flex-shrink:0; }
.wf-toolbox-title { font-weight:bold;padding:8px 0;font-size:13px;color:#555; }
.wf-toolbox-group { display:flex;flex-direction:column;gap:4px; }
.wf-node-palette { padding:8px 10px;background:white;border:1px solid #ddd;border-radius:4px;cursor:grab;font-size:13px;transition:all 0.15s; }
.wf-node-palette:hover { border-color:#2196F3;background:#e3f2fd; }
.wf-node-palette:active { cursor:grabbing; }
.wf-canvas-wrapper { flex:1;position:relative;overflow:hidden;background:#fff;background-image:radial-gradient(circle,#ddd 1px,transparent 1px);background-size:20px 20px; }
#wf-svg-canvas { display:block;width:100%;height:100%; }
.wf-canvas-empty { position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#bbb;font-size:16px;pointer-events:none; }
.wf-node-svg { cursor:pointer; }
.wf-node-svg:hover .wf-node-bg { stroke:#2196F3;stroke-width:2; }
.wf-node-selected .wf-node-bg { stroke:#2196F3;stroke-width:2;stroke-dasharray:4,2; }
.wf-node-completed .wf-node-bg { fill:#e8f5e9;stroke:#4CAF50; }
.wf-node-current .wf-node-bg { fill:#fff3e0;stroke:#FF9800;stroke-width:2; }
.wf-anchor { fill:#fff;stroke:#2196F3;stroke-width:2;cursor:crosshair; }
.wf-anchor:hover { fill:#2196F3; }
.wf-edge { stroke:#666;stroke-width:2;fill:none;cursor:pointer; }
.wf-edge:hover { stroke:#2196F3;stroke-width:3; }
.wf-edge-label { font-size:11px;fill:#666; }
.wf-prop-panel { width:280px;background:#fafafa;border-left:1px solid #ddd;padding:0;flex-shrink:0;overflow-y:auto; }
.wf-prop-header { font-weight:bold;padding:12px 16px;background:#f0f0f0;border-bottom:1px solid #ddd; }
.wf-prop-field { padding:10px 16px; }
.wf-prop-field label { display:block;font-size:12px;color:#666;margin-bottom:4px; }
.wf-prop-field input,.wf-prop-field select,.wf-prop-field textarea { width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:3px;font-size:13px;box-sizing:border-box; }
.wf-prop-field textarea { min-height:60px;resize:vertical; }
/* Workflow tables */
.wf-table { width:100%;border-collapse:collapse;background:white; }
.wf-table th,.wf-table td { padding:10px 12px;text-align:left;border-bottom:1px solid #eee;font-size:13px; }
.wf-table th { background:#f5f5f5;font-weight:600; }
.wf-table tr:hover td { background:#f8f9fa; }
/* Status badges */
.wf-badge { display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600; }
.wf-badge-active { background:#fff3e0;color:#e65100; }
.wf-badge-completed { background:#e8f5e9;color:#2e7d32; }
.wf-badge-paused { background:#e3f2fd;color:#1565c0; }
.wf-badge-cancelled { background:#fbe9e7;color:#c62828; }
.wf-badge-pending { background:#fff8e1;color:#f57f17; }
.wf-badge-approved { background:#e8f5e9;color:#2e7d32; }
/* Task cards */
.wf-task-card { background:white;border:1px solid #eee;border-radius:8px;padding:16px;margin-bottom:12px; }
.wf-task-card:hover { box-shadow:0 2px 8px rgba(0,0,0,0.1); }
.wf-task-title { font-size:15px;font-weight:600;margin-bottom:6px; }
.wf-task-meta { font-size:12px;color:#888;margin-bottom:10px; }
.wf-task-actions { display:flex;gap:8px; }
.wf-task-actions button { padding:8px 20px;border:none;border-radius:4px;cursor:pointer;font-size:13px; }
.btn-approve { background:#4CAF50;color:white; }
.btn-reject { background:#f44336;color:white; }
.btn-complete { background:#2196F3;color:white; }
/* Modal */
.wf-modal { position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center; }
.wf-modal-content { background:white;border-radius:8px;padding:24px;max-height:80vh;overflow-y:auto;position:relative; }
.wf-modal-close { position:absolute;top:10px;right:15px;font-size:24px;cursor:pointer;color:#999; }
.wf-modal-close:hover { color:#333; }
```

---

### Task 6: Add workflow frontend JS to app.js

**Files:**
- Modify: `app.js` (81KB, append workflow functions before the end)

- [ ] **Step 1: Add workflow API helper functions**

Before the final `})` of any existing module pattern, or at the end of app.js before any closing, add:

```javascript
// ==========================================
// WORKFLOW ENGINE - Frontend Module
// ==========================================

// ---- API Helpers ----
function wfApi(path, method, body) {
  return fetch('/api/workflow' + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (localStorage.getItem('token') || '') },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json());
}

// ---- State ----
let wfState = {
  templateId: null,
  nodes: [],
  edges: [],
  selectedNode: null,
  selectedEdge: null,
  nodeCounter: 0,
  draggingNodeType: null,
  connectingFrom: null,
  svgPoint: null,
  history: [],
  historyIndex: -1
};

// ---- Designer Init ----
function initWorkflowDesigner() {
  const canvas = document.getElementById('wf-svg-canvas');
  if (!canvas) return;
  
  const wrapper = document.getElementById('wf-canvas-wrapper');
  
  // Update SVG size on resize
  const resizeObserver = new ResizeObserver(() => {
    canvas.setAttribute('width', wrapper.clientWidth);
    canvas.setAttribute('height', wrapper.clientHeight);
  });
  resizeObserver.observe(wrapper);
  
  // SVG coordinate helper
  wfState.svgPoint = canvas.createSVGPoint();
  
  // Canvas click - deselect
  canvas.addEventListener('click', (e) => {
    if (e.target === canvas || e.target.id === 'wf-edges-layer' || e.target.id === 'wf-nodes-layer') {
      wfDeselectAll();
    }
  });
  
  // Drag over - allow drop
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); });
  
  // Drop - create node
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (!type) return;
    const pt = wfGetSVGPoint(e);
    wfAddNode(type, pt.x, pt.y);
  });
  
  // Palette drag
  document.querySelectorAll('.wf-node-palette').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', el.dataset.type);
    });
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('page-workflow-designer').style.display === 'none') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        wfDeleteSelected();
      }
    }
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); wfUndo(); }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); wfRedo(); }
  });
}

function wfGetSVGPoint(e) {
  const rect = document.getElementById('wf-svg-canvas').getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ---- Node Management ----
function wfAddNode(type, x, y) {
  const nodeId = 'node_' + (++wfState.nodeCounter);
  const labels = {
    start: '开始', end: '结束', approval: '审批', task: '任务',
    condition: '条件', parallel: '并行', timer: '定时',
    webhook: 'Webhook', auto_action: '自动动作', sub_process: '子流程'
  };
  
  const widths = { start: 100, end: 100, approval: 120, task: 120, condition: 100, 
    parallel: 100, timer: 100, webhook: 120, auto_action: 120, sub_process: 120 };
  
  const node = {
    id: nodeId, type: type, label: labels[type] || type,
    x: x - (widths[type] || 100) / 2, y: y - 30,
    width: widths[type] || 100, height: 60,
    config: wfDefaultConfig(type)
  };
  
  wfSaveState();
  wfState.nodes.push(node);
  wfRenderAll();
  wfSelectNode(nodeId);
}

function wfDefaultConfig(type) {
  switch (type) {
    case 'start': return { trigger: 'manual' };
    case 'approval': return { title: '请审批', assignee_role: 'admin' };
    case 'task': return { title: '请处理', assignee_role: 'user' };
    case 'condition': return { expression: { operator: '==', left: { var: 'data.status' }, right: 'approved' } };
    case 'parallel': return {};
    case 'timer': return { delay_minutes: 60 };
    case 'webhook': return { url: '', method: 'POST', headers: {} };
    case 'auto_action': return { action_type: 'update_field', field: 'status', value: 'processed' };
    case 'sub_process': return { template_id: null };
    default: return {};
  }
}

// ---- SVG Rendering ----
function wfRenderAll() {
  const nodesLayer = document.getElementById('wf-nodes-layer');
  const edgesLayer = document.getElementById('wf-edges-layer');
  const empty = document.getElementById('wf-canvas-empty');
  
  // Show/hide empty state
  empty.style.display = wfState.nodes.length === 0 ? 'block' : 'none';
  
  // Clear and re-render nodes
  nodesLayer.innerHTML = '';
  wfState.nodes.forEach(node => wfRenderNode(node));
  
  // Clear and re-render edges
  edgesLayer.innerHTML = '';
  wfState.edges.forEach(edge => wfRenderEdge(edge));
}

function wfRenderNode(node) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'wf-node-svg' + (wfState.selectedNode === node.id ? ' wf-node-selected' : ''));
  g.dataset.nodeId = node.id;
  g.style.cursor = 'pointer';
  
  const isRounded = node.type === 'start' || node.type === 'end';
  const rx = isRounded ? 30 : 6;
  
  // Node background
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('class', 'wf-node-bg');
  rect.setAttribute('x', node.x);
  rect.setAttribute('y', node.y);
  rect.setAttribute('width', node.width);
  rect.setAttribute('height', node.height);
  rect.setAttribute('rx', rx);
  rect.setAttribute('ry', rx);
  rect.setAttribute('fill', wfNodeColor(node.type));
  rect.setAttribute('stroke', '#999');
  rect.setAttribute('stroke-width', '1.5');
  g.appendChild(rect);
  
  // Node label
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('x', node.x + node.width / 2);
  text.setAttribute('y', node.y + node.height / 2);
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'middle');
  text.setAttribute('font-size', '13px');
  text.setAttribute('fill', '#333');
  text.setAttribute('pointer-events', 'none');
  text.textContent = node.label;
  g.appendChild(text);
  
  // Type label
  const typeText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  typeText.setAttribute('x', node.x + node.width / 2);
  typeText.setAttribute('y', node.y + node.height - 10);
  typeText.setAttribute('text-anchor', 'middle');
  typeText.setAttribute('font-size', '9px');
  typeText.setAttribute('fill', '#999');
  typeText.setAttribute('pointer-events', 'none');
  typeText.textContent = node.type;
  g.appendChild(typeText);
  
  // Top anchor (input)
  if (node.type !== 'start') {
    const topAnchor = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    topAnchor.setAttribute('class', 'wf-anchor');
    topAnchor.setAttribute('cx', node.x + node.width / 2);
    topAnchor.setAttribute('cy', node.y);
    topAnchor.setAttribute('r', '5');
    topAnchor.dataset.anchor = 'input';
    topAnchor.dataset.nodeId = node.id;
    g.appendChild(topAnchor);
  }
  
  // Bottom anchor (output)
  if (node.type !== 'end') {
    const botAnchor = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    botAnchor.setAttribute('class', 'wf-anchor');
    botAnchor.setAttribute('cx', node.x + node.width / 2);
    botAnchor.setAttribute('cy', node.y + node.height);
    botAnchor.setAttribute('r', '5');
    botAnchor.dataset.anchor = 'output';
    botAnchor.dataset.nodeId = node.id;
    g.appendChild(botAnchor);
  }
  
  // Click handler
  g.addEventListener('click', (e) => {
    e.stopPropagation();
    wfSelectNode(node.id);
  });
  
  // Drag handler
  let dragging = false, startX, startY, nodeStartX, nodeStartY;
  g.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('wf-anchor')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    nodeStartX = node.x;
    nodeStartY = node.y;
    g.style.cursor = 'grabbing';
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    node.x = Math.max(0, nodeStartX + dx);
    node.y = Math.max(0, nodeStartY + dy);
    wfRenderAll();
    if (wfState.selectedNode === node.id) wfSelectNode(node.id);
  });
  
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      g.style.cursor = 'pointer';
      wfSaveState();
    }
  });
  
  // Anchor connection handlers
  g.querySelectorAll('.wf-anchor').forEach(anchor => {
    anchor.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const isOutput = anchor.dataset.anchor === 'output';
      if (isOutput) {
        wfState.connectingFrom = { nodeId: node.id };
        const line = document.getElementById('wf-connection-line');
        const cx = parseFloat(anchor.getAttribute('cx'));
        const cy = parseFloat(anchor.getAttribute('cy'));
        line.setAttribute('x1', cx);
        line.setAttribute('y1', cy);
        line.setAttribute('x2', cx);
        line.setAttribute('y2', cy);
        line.style.display = 'block';
      }
    });
  });
  
  document.getElementById('wf-nodes-layer').appendChild(g);
}

function wfRenderEdge(edge) {
  const fromNode = wfState.nodes.find(n => n.id === edge.from);
  const toNode = wfState.nodes.find(n => n.id === edge.to);
  if (!fromNode || !toNode) return;
  
  const x1 = fromNode.x + fromNode.width / 2;
  const y1 = fromNode.y + fromNode.height;
  const x2 = toNode.x + toNode.width / 2;
  const y2 = toNode.y;
  
  // Bezier curve
  const cy1 = y1 + Math.abs(y2 - y1) * 0.5;
  const cy2 = y2 - Math.abs(y2 - y1) * 0.5;
  const d = `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;
  
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.style.cursor = 'pointer';
  g.dataset.edgeId = edge.id;
  
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'wf-edge');
  path.setAttribute('d', d);
  path.setAttribute('marker-end', 'url(#arrowhead)');
  if (edge.condition) path.setAttribute('stroke-dasharray', '5,3');
  g.appendChild(path);
  
  // Edge label
  if (edge.label) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - 10;
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('class', 'wf-edge-label');
    label.setAttribute('x', mx);
    label.setAttribute('y', my);
    label.setAttribute('text-anchor', 'middle');
    label.textContent = edge.label;
    g.appendChild(label);
  }
  
  // Click to select edge
  g.addEventListener('click', (e) => {
    e.stopPropagation();
    wfSelectEdge(edge.id);
  });
  
  document.getElementById('wf-edges-layer').appendChild(g);
}

function wfNodeColor(type) {
  const colors = {
    start: '#e8f5e9', end: '#fbe9e7', approval: '#fff3e0', task: '#e3f2fd',
    condition: '#f3e5f5', parallel: '#e0f2f1', timer: '#fff8e1',
    webhook: '#fce4ec', auto_action: '#e8eaf6', sub_process: '#f1f8e9'
  };
  return colors[type] || '#f5f5f5';
}

// ---- Connection ----
document.addEventListener('mousemove', (e) => {
  if (!wfState.connectingFrom) return;
  const line = document.getElementById('wf-connection-line');
  const rect = document.getElementById('wf-svg-canvas').getBoundingClientRect();
  line.setAttribute('x2', e.clientX - rect.left);
  line.setAttribute('y2', e.clientY - rect.top);
});

document.addEventListener('mouseup', (e) => {
  if (!wfState.connectingFrom) return;
  const line = document.getElementById('wf-connection-line');
  line.style.display = 'none';
  
  // Check if dropped on a node input anchor
  const target = e.target;
  if (target.classList.contains('wf-anchor') && target.dataset.anchor === 'input') {
    const toNodeId = target.dataset.nodeId;
    const fromNodeId = wfState.connectingFrom.nodeId;
    
    if (fromNodeId !== toNodeId) {
      // Check for duplicate
      const exists = wfState.edges.some(e => e.from === fromNodeId && e.to === toNodeId);
      if (!exists) {
        wfSaveState();
        wfState.edges.push({
          id: 'edge_' + Date.now(),
          from: fromNodeId,
          to: toNodeId,
          label: '',
          condition: null
        });
        wfRenderAll();
      }
    }
  }
  
  wfState.connectingFrom = null;
});

// ---- Selection ----
function wfSelectNode(nodeId) {
  wfState.selectedNode = nodeId;
  wfState.selectedEdge = null;
  wfRenderAll();
  wfShowNodeProperties(nodeId);
}

function wfSelectEdge(edgeId) {
  wfState.selectedNode = null;
  wfState.selectedEdge = edgeId;
  wfRenderAll();
  wfShowEdgeProperties(edgeId);
}

function wfDeselectAll() {
  wfState.selectedNode = null;
  wfState.selectedEdge = null;
  wfRenderAll();
  document.getElementById('wf-prop-content').innerHTML = '<p style="color:#999;padding:20px;text-align:center;">点击节点或连线<br>编辑属性</p>';
}

function wfDeleteSelected() {
  if (wfState.selectedNode) {
    wfSaveState();
    wfState.nodes = wfState.nodes.filter(n => n.id !== wfState.selectedNode);
    wfState.edges = wfState.edges.filter(e => e.from !== wfState.selectedNode && e.to !== wfState.selectedNode);
    wfState.selectedNode = null;
    wfRenderAll();
    document.getElementById('wf-prop-content').innerHTML = '<p style="color:#999;padding:20px;text-align:center;">点击节点或连线<br>编辑属性</p>';
  } else if (wfState.selectedEdge) {
    wfSaveState();
    wfState.edges = wfState.edges.filter(e => e.id !== wfState.selectedEdge);
    wfState.selectedEdge = null;
    wfRenderAll();
    document.getElementById('wf-prop-content').innerHTML = '<p style="color:#999;padding:20px;text-align:center;">点击节点或连线<br>编辑属性</p>';
  }
}

// ---- Property Panels ----
function wfShowNodeProperties(nodeId) {
  const node = wfState.nodes.find(n => n.id === nodeId);
  if (!node) return;
  
  const config = node.config || {};
  let html = `<div class="wf-prop-field"><label>节点ID</label><input value="${node.id}" readonly></div>`;
  html += `<div class="wf-prop-field"><label>类型</label><input value="${node.type}" readonly></div>`;
  html += `<div class="wf-prop-field"><label>显示名称</label><input value="${node.label}" onchange="wfUpdateNodeProp('${nodeId}','label',this.value)"></div>`;
  
  // Type-specific config
  if (node.type === 'approval' || node.type === 'task') {
    html += `<div class="wf-prop-field"><label>标题</label><input value="${config.title || ''}" onchange="wfUpdateNodeConfig('${nodeId}','title',this.value)"></div>`;
    html += `<div class="wf-prop-field"><label>负责人角色</label><select onchange="wfUpdateNodeConfig('${nodeId}','assignee_role',this.value)">
      <option value="user" ${config.assignee_role === 'user' ? 'selected' : ''}>普通用户</option>
      <option value="admin" ${config.assignee_role === 'admin' ? 'selected' : ''}>管理员</option>
    </select></div>`;
  }
  
  if (node.type === 'condition') {
    const expr = config.expression || {};
    html += `<div class="wf-prop-field"><label>条件表达式 (JSON)</label>
      <textarea onchange="wfUpdateCondition('${nodeId}',this.value)">${JSON.stringify(expr, null, 2)}</textarea>
      <small style="color:#999">示例: {"operator":"==","left":{"var":"data.value"},"right":"high"}</small></div>`;
  }
  
  if (node.type === 'timer') {
    html += `<div class="wf-prop-field"><label>延迟(分钟)</label><input type="number" value="${config.delay_minutes || 60}" onchange="wfUpdateNodeConfig('${nodeId}','delay_minutes',parseInt(this.value))"></div>`;
  }
  
  if (node.type === 'webhook') {
    html += `<div class="wf-prop-field"><label>URL</label><input value="${config.url || ''}" onchange="wfUpdateNodeConfig('${nodeId}','url',this.value)"></div>`;
    html += `<div class="wf-prop-field"><label>方法</label><select onchange="wfUpdateNodeConfig('${nodeId}','method',this.value)">
      <option value="POST" ${config.method === 'POST' ? 'selected' : ''}>POST</option>
      <option value="GET" ${config.method === 'GET' ? 'selected' : ''}>GET</option>
      <option value="PUT" ${config.method === 'PUT' ? 'selected' : ''}>PUT</option>
    </select></div>`;
  }
  
  if (node.type === 'auto_action') {
    html += `<div class="wf-prop-field"><label>动作类型</label><select onchange="wfUpdateNodeConfig('${nodeId}','action_type',this.value)">
      <option value="update_field" ${config.action_type === 'update_field' ? 'selected' : ''}>更新字段</option>
      <option value="notify" ${config.action_type === 'notify' ? 'selected' : ''}>发送通知</option>
    </select></div>`;
    html += `<div class="wf-prop-field"><label>字段名</label><input value="${config.field || ''}" onchange="wfUpdateNodeConfig('${nodeId}','field',this.value)"></div>`;
    html += `<div class="wf-prop-field"><label>字段值</label><input value="${config.value || ''}" onchange="wfUpdateNodeConfig('${nodeId}','value',this.value)"></div>`;
  }
  
  if (node.type === 'sub_process') {
    html += `<div class="wf-prop-field"><label>子流程模板ID</label><input type="number" value="${config.template_id || ''}" onchange="wfUpdateNodeConfig('${nodeId}','template_id',parseInt(this.value))"></div>`;
  }
  
  if (node.type === 'start') {
    html += `<div class="wf-prop-field"><label>触发方式</label><select onchange="wfUpdateNodeConfig('${nodeId}','trigger',this.value)">
      <option value="manual" ${config.trigger === 'manual' ? 'selected' : ''}>手动触发</option>
      <option value="auto" ${config.trigger === 'auto' ? 'selected' : ''}>自动触发</option>
    </select></div>`;
  }
  
  html += `<div style="padding:10px 16px;"><button onclick="wfDeleteSelected()" style="padding:6px 14px;background:#f44336;color:white;border:none;border-radius:4px;cursor:pointer;">删除节点</button></div>`;
  
  document.getElementById('wf-prop-content').innerHTML = html;
}

function wfShowEdgeProperties(edgeId) {
  const edge = wfState.edges.find(e => e.id === edgeId);
  if (!edge) return;
  
  const fromNode = wfState.nodes.find(n => n.id === edge.from);
  const toNode = wfState.nodes.find(n => n.id === edge.to);
  
  let html = `<div class="wf-prop-field"><label>连线ID</label><input value="${edge.id}" readonly></div>`;
  html += `<div class="wf-prop-field"><label>从</label><input value="${fromNode ? fromNode.label + ' (' + fromNode.id + ')' : edge.from}" readonly></div>`;
  html += `<div class="wf-prop-field"><label>到</label><input value="${toNode ? toNode.label + ' (' + toNode.id + ')' : edge.to}" readonly></div>`;
  html += `<div class="wf-prop-field"><label>标签</label><input value="${edge.label || ''}" onchange="wfUpdateEdgeProp('${edgeId}','label',this.value)"></div>`;
  html += `<div class="wf-prop-field"><label>条件(JSON,可选)</label>
    <textarea onchange="wfUpdateEdgeCondition('${edgeId}',this.value)">${edge.condition ? JSON.stringify(edge.condition, null, 2) : ''}</textarea>
    <small style="color:#999">边上有条件时用虚线显示</small></div>`;
  html += `<div style="padding:10px 16px;"><button onclick="wfDeleteSelected()" style="padding:6px 14px;background:#f44336;color:white;border:none;border-radius:4px;cursor:pointer;">删除连线</button></div>`;
  
  document.getElementById('wf-prop-content').innerHTML = html;
}

// ---- Property Update Helpers ----
function wfUpdateNodeProp(nodeId, prop, value) {
  const node = wfState.nodes.find(n => n.id === nodeId);
  if (node) { node[prop] = value; wfRenderAll(); wfSaveState(); }
}

function wfUpdateNodeConfig(nodeId, key, value) {
  const node = wfState.nodes.find(n => n.id === nodeId);
  if (node) { node.config[key] = value; wfSaveState(); }
}

function wfUpdateEdgeProp(edgeId, prop, value) {
  const edge = wfState.edges.find(e => e.id === edgeId);
  if (edge) { edge[prop] = value; wfRenderAll(); wfSaveState(); }
}

function wfUpdateCondition(nodeId, jsonStr) {
  try {
    const node = wfState.nodes.find(n => n.id === nodeId);
    if (node) { node.config.expression = JSON.parse(jsonStr); wfSaveState(); }
  } catch(e) { alert('JSON格式错误: ' + e.message); }
}

function wfUpdateEdgeCondition(edgeId, jsonStr) {
  try {
    const edge = wfState.edges.find(e => e.id === edgeId);
    if (edge) { edge.condition = jsonStr ? JSON.parse(jsonStr) : null; wfRenderAll(); wfSaveState(); }
  } catch(e) { alert('JSON格式错误: ' + e.message); }
}

// ---- Undo/Redo ----
function wfSaveState() {
  const state = { nodes: JSON.parse(JSON.stringify(wfState.nodes)), edges: JSON.parse(JSON.stringify(wfState.edges)), nodeCounter: wfState.nodeCounter };
  // Remove future states if we're not at the end
  if (wfState.historyIndex < wfState.history.length - 1) {
    wfState.history = wfState.history.slice(0, wfState.historyIndex + 1);
  }
  wfState.history.push(state);
  if (wfState.history.length > 50) wfState.history.shift();
  wfState.historyIndex = wfState.history.length - 1;
}

function wfUndo() {
  if (wfState.historyIndex <= 0) return;
  wfState.historyIndex--;
  const state = wfState.history[wfState.historyIndex];
  wfState.nodes = JSON.parse(JSON.stringify(state.nodes));
  wfState.edges = JSON.parse(JSON.stringify(state.edges));
  wfState.nodeCounter = state.nodeCounter;
  wfState.selectedNode = null;
  wfState.selectedEdge = null;
  wfRenderAll();
  document.getElementById('wf-prop-content').innerHTML = '<p style="color:#999;padding:20px;text-align:center;">点击节点或连线<br>编辑属性</p>';
}

function wfRedo() {
  if (wfState.historyIndex >= wfState.history.length - 1) return;
  wfState.historyIndex++;
  const state = wfState.history[wfState.historyIndex];
  wfState.nodes = JSON.parse(JSON.stringify(state.nodes));
  wfState.edges = JSON.parse(JSON.stringify(state.edges));
  wfState.nodeCounter = state.nodeCounter;
  wfState.selectedNode = null;
  wfState.selectedEdge = null;
  wfRenderAll();
  document.getElementById('wf-prop-content').innerHTML = '<p style="color:#999;padding:20px;text-align:center;">点击节点或连线<br>编辑属性</p>';
}

function wfClearCanvas() {
  if (!confirm('确定清空画布？')) return;
  wfSaveState();
  wfState.nodes = [];
  wfState.edges = [];
  wfState.selectedNode = null;
  wfState.selectedEdge = null;
  wfState.templateId = null;
  document.getElementById('wf-template-name').value = '';
  document.getElementById('wf-template-id').textContent = '';
  wfRenderAll();
  document.getElementById('wf-prop-content').innerHTML = '<p style="color:#999;padding:20px;text-align:center;">点击节点或连线<br>编辑属性</p>';
}

// ---- Save/Load Template ----
function wfSaveTemplate() {
  const name = document.getElementById('wf-template-name').value.trim();
  if (!name) { alert('请输入流程名称'); return; }
  if (wfState.nodes.length === 0) { alert('画布为空'); return; }
  
  const templateId = document.getElementById('wf-template-id').textContent;
  const data = {
    name: name,
    nodes: wfState.nodes,
    edges: wfState.edges
  };
  
  if (templateId) {
    wfApi('/templates/' + templateId, 'PUT', data).then(r => {
      if (r.success) alert('保存成功');
      else alert('保存失败: ' + (r.error || '未知错误'));
    });
  } else {
    wfApi('/templates', 'POST', data).then(r => {
      if (r.id) {
        document.getElementById('wf-template-id').textContent = r.id;
        alert('保存成功，ID: ' + r.id);
      } else alert('保存失败: ' + (r.error || '未知错误'));
    });
  }
}

function wfPublishTemplate() {
  const templateId = document.getElementById('wf-template-id').textContent;
  if (!templateId) { alert('请先保存模板'); return; }
  
  wfApi('/templates/' + templateId + '/publish', 'POST').then(r => {
    if (r.success) alert('发布成功');
  });
}

function wfLoadTemplate(templateId) {
  wfApi('/templates/' + templateId).then(r => {
    if (!r.template) { alert('模板不存在'); return; }
    const t = r.template;
    switchPage('workflow-designer');
    document.getElementById('wf-template-name').value = t.name;
    document.getElementById('wf-template-id').textContent = t.id;
    wfState.nodes = t.nodes || [];
    wfState.edges = t.edges || [];
    wfState.nodeCounter = wfState.nodes.length;
    wfState.selectedNode = null;
    wfState.selectedEdge = null;
    wfState.history = [{ nodes: JSON.parse(JSON.stringify(wfState.nodes)), edges: JSON.parse(JSON.stringify(wfState.edges)), nodeCounter: wfState.nodeCounter }];
    wfState.historyIndex = 0;
    wfRenderAll();
  });
}


// ---- Templates List ----
function wfLoadTemplates() {
  const search = (document.getElementById('wf-tpl-search') || { value: '' }).value;
  wfApi('/templates').then(r => {
    const tbody = document.getElementById('wf-templates-body');
    const filtered = search ? r.templates.filter(t => t.name.includes(search) || (t.module || '').includes(search)) : r.templates;
    
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;">暂无模板</td></tr>';
      return;
    }
    
    tbody.innerHTML = filtered.map(t => `
      <tr>
        <td><strong>${t.name}</strong></td>
        <td>${t.module || '-'}</td>
        <td>${t.category || '-'}</td>
        <td>v${t.version}</td>
        <td><span class="wf-badge ${t.is_active ? 'wf-badge-completed' : 'wf-badge-paused'}">${t.is_active ? '已发布' : '草稿'}</span></td>
        <td>${t.created_at || '-'}</td>
        <td>
          <button onclick="wfLoadTemplate(${t.id})" style="padding:4px 10px;border:1px solid #ccc;border-radius:3px;cursor:pointer;background:white;">编辑</button>
          <button onclick="wfDeleteTemplate(${t.id})" style="padding:4px 10px;border:1px solid #f44336;border-radius:3px;cursor:pointer;background:white;color:#f44336;">删除</button>
        </td>
      </tr>
    `).join('');
  });
}

function wfDeleteTemplate(id) {
  if (!confirm('确定删除模板？')) return;
  wfApi('/templates/' + id, 'DELETE').then(r => {
    if (r.success) wfLoadTemplates();
  });
}


// ---- Instances ----
function wfLoadInstances() {
  const status = document.getElementById('wf-inst-filter-status').value;
  let url = '/instances';
  if (status) url += '?status=' + status;
  
  wfApi(url).then(r => {
    const tbody = document.getElementById('wf-instances-body');
    if (!r.instances || r.instances.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;">暂无流程实例</td></tr>';
      return;
    }
    
    tbody.innerHTML = r.instances.map(inst => `
      <tr>
        <td>#${inst.id}</td>
        <td>${inst.template_name}</td>
        <td>${inst.business_type}</td>
        <td>${inst.business_id}</td>
        <td><span class="wf-badge wf-badge-${inst.status}">${inst.status}</span></td>
        <td>${inst.started_by || '-'}</td>
        <td>${inst.created_at || '-'}</td>
        <td>
          <button onclick="wfShowInstanceDetail(${inst.id})" style="padding:4px 10px;border:1px solid #2196F3;border-radius:3px;cursor:pointer;background:white;color:#2196F3;">详情</button>
          ${inst.status === 'active' ? `<button onclick="wfCancelInstance(${inst.id})" style="padding:4px 10px;border:1px solid #f44336;border-radius:3px;cursor:pointer;background:white;color:#f44336;">取消</button>` : ''}
        </td>
      </tr>
    `).join('');
  });
}

function wfShowInstanceDetail(instanceId) {
  wfApi('/instances/' + instanceId).then(r => {
    if (!r.instance) { alert('实例不存在'); return; }
    
    const modal = document.getElementById('wf-instance-modal');
    const body = document.getElementById('wf-instance-modal-body');
    document.getElementById('wf-instance-modal-title').textContent = '流程实例 #' + instanceId;
    
    // Build node status map
    const nodeStatuses = r.node_statuses || {};
    
    // Render flow visualization
    let html = '<div style="margin-bottom:20px;">';
    html += `<p>模板: <strong>${r.instance.template_name}</strong> | 状态: <span class="wf-badge wf-badge-${r.instance.status}">${r.instance.status}</span></p>`;
    
    // Flow steps
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:16px 0;">';
    (r.nodes || []).forEach((node, i) => {
      const status = nodeStatuses[node.id];
      const borderColor = node.is_current ? '#FF9800' : (status === 'completed' ? '#4CAF50' : '#ddd');
      html += `<div style="padding:8px 16px;border:2px solid ${borderColor};border-radius:6px;background:${wfNodeColor(node.type)};font-size:13px;">
        ${node.label} ${node.is_current ? '⬅' : ''}</div>`;
      if (i < r.nodes.length - 1) html += '<span style="color:#999;">→</span>';
    });
    html += '</div>';
    
    // Tasks
    if (r.tasks && r.tasks.length > 0) {
      html += '<h4 style="margin:16px 0 8px;">任务列表</h4><table class="wf-table"><thead><tr><th>任务</th><th>类型</th><th>状态</th><th>处理人</th><th>备注</th></tr></thead><tbody>';
      r.tasks.forEach(task => {
        html += `<tr><td>${task.title}</td><td>${task.node_type}</td>
          <td><span class="wf-badge wf-badge-${task.status}">${task.status}</span></td>
          <td>${task.completed_by || '-'}</td><td>${task.comment || '-'}</td></tr>`;
      });
      html += '</tbody></table>';
    }
    
    // Logs
    if (r.logs && r.logs.length > 0) {
      html += '<h4 style="margin:16px 0 8px;">执行日志</h4><div style="max-height:200px;overflow-y:auto;background:#fafafa;padding:12px;border-radius:4px;font-size:12px;">';
      r.logs.forEach(log => {
        html += `<div style="padding:4px 0;border-bottom:1px solid #eee;">
          <span style="color:#999;">${log.created_at}</span> 
          <span style="font-weight:600;">${log.node_id || '-'}</span> 
          <span>${log.action}</span>
          ${log.user_id ? `<span style="color:#888;">by user#${log.user_id}</span>` : ''}
        </div>`;
      });
      html += '</div>';
    }
    
    html += '</div>';
    body.innerHTML = html;
    modal.style.display = 'flex';
  });
}

// Close modal on outside click
document.addEventListener('click', (e) => {
  const modal = document.getElementById('wf-instance-modal');
  if (e.target === modal) modal.style.display = 'none';
});

function wfCancelInstance(id) {
  if (!confirm('确定取消此流程？')) return;
  wfApi('/instances/' + id + '/cancel', 'POST').then(r => {
    if (r.success) wfLoadInstances();
  });
}


// ---- Tasks ----
function wfLoadTasks() {
  const status = document.getElementById('wf-task-filter').value;
  let url = '/tasks';
  if (status) url += '?status=' + status;
  
  wfApi(url).then(r => {
    const container = document.getElementById('wf-tasks-list');
    if (!r.tasks || r.tasks.length === 0) {
      container.innerHTML = '<p style="text-align:center;color:#999;padding:40px;">暂无任务</p>';
      return;
    }
    
    container.innerHTML = r.tasks.map(task => `
      <div class="wf-task-card">
        <div class="wf-task-title">${task.title}</div>
        <div class="wf-task-meta">
          流程: ${task.template_name || '-'} | 
          业务: ${task.business_type || '-'}#${task.business_id || '-'} | 
          状态: <span class="wf-badge wf-badge-${task.status}">${task.status}</span> |
          ${task.created_at ? '创建: ' + task.created_at : ''}
        </div>
        ${task.description ? '<p style="font-size:13px;color:#555;margin-bottom:10px;">' + task.description + '</p>' : ''}
        <div class="wf-task-actions">
          ${task.node_type === 'approval' ? `
            <button class="btn-approve" onclick="wfHandleTask(${task.id},'approve')">✓ 批准</button>
            <button class="btn-reject" onclick="wfHandleTask(${task.id},'reject')">✗ 驳回</button>
          ` : `
            <button class="btn-complete" onclick="wfHandleTask(${task.id},'approve')">完成</button>
          `}
          <input id="wf-task-comment-${task.id}" placeholder="备注..." style="flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;">
        </div>
      </div>
    `).join('');
  });
}

function wfHandleTask(taskId, action) {
  const comment = document.getElementById('wf-task-comment-' + taskId)?.value || '';
  const endpoint = action === 'reject' ? '/reject' : (action === 'approve' ? '/approve' : '/complete');
  
  wfApi('/tasks/' + taskId + endpoint, 'POST', { comment }).then(r => {
    if (r.success) {
      wfLoadTasks();
    } else {
      alert('操作失败: ' + (r.error || '未知错误'));
    }
  });
}


// ---- Page init hooks ----
// Override switchPage to init workflow pages when shown
const origSwitchPage = window.switchPage || function(){};
window.switchPage = function(pageId) {
  // Call original if it exists
  if (typeof origSwitchPage === 'function' && origSwitchPage !== window.switchPage) {
    origSwitchPage(pageId);
  }
  
  // Hide all pages, show target
  document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
  const target = document.getElementById('page-' + pageId);
  if (target) target.style.display = 'block';
  
  // Init workflow pages
  if (pageId === 'workflow-designer') {
    setTimeout(initWorkflowDesigner, 100);
  }
  if (pageId === 'workflow-templates') {
    setTimeout(wfLoadTemplates, 100);
  }
  if (pageId === 'workflow-instances') {
    setTimeout(wfLoadInstances, 100);
  }
  if (pageId === 'workflow-tasks') {
    setTimeout(wfLoadTasks, 100);
  }
};
```

---

### Task 7: CRM Integration - Add workflow trigger on stage change

**Files:**
- Modify: `server/routes_customers.js` (add workflow trigger)

- [ ] **Step 1: Add workflow trigger to customer update**

Find the customer update route that changes stage. After the update query, add:

```javascript
// Trigger workflow on stage change
try {
  const workflowEngine = require('./workflow_engine');
  // Find matching templates for customer module
  const templates = db.prepare(`SELECT id FROM workflow_templates 
    WHERE module = 'customer' AND is_active = 1`).all();
  
  for (const tpl of templates) {
    try {
      workflowEngine.startWorkflow(tpl.id, 'customer', customerId, { customer: updatedCustomer, stage: newStage }, userId);
    } catch(e) {
      console.error('Workflow trigger error:', e.message);
    }
  }
} catch(e) {
  // Workflow engine not available - ignore
}
```

---

### Task 8: Integration and Testing

- [ ] **Step 1: Verify server starts cleanly**

Run: `cd platform/server && node server.js`
Expected: Server starts, no errors, workflow timer engine initialized

- [ ] **Step 2: Test workflow API endpoints**

```bash
# Login first
TOKEN=$(curl -s -X POST http://localhost:3002/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$SMOKE_ADMIN_PASSWORD\"}" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).token)}catch(e){console.log('FAIL')}})")

echo "Token: $TOKEN"

# Create template
curl -s -X POST http://localhost:3002/api/workflow/templates \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"测试流程","nodes":[{"id":"n1","type":"start","x":200,"y":50,"label":"开始","config":{}},{"id":"n2","type":"approval","x":200,"y":180,"label":"审批","config":{"assignee_role":"admin"}},{"id":"n3","type":"end","x":200,"y":320,"label":"结束","config":{}}],"edges":[{"id":"e1","from":"n1","to":"n2"},{"id":"e2","from":"n2","to":"n3"}]}'

# Verify template list
curl -s http://localhost:3002/api/workflow/templates \
  -H "Authorization: Bearer $TOKEN"
```

Expected: Template created and listed successfully.
