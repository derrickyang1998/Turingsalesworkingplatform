const db = require('./db');

const NODE_TYPES = {
  start: { hasTask: false, autoAdvance: true },
  end: { hasTask: false, autoAdvance: false },
  approval: { hasTask: true, autoAdvance: false },
  task: { hasTask: true, autoAdvance: false },
  condition: { hasTask: false, autoAdvance: true },
  parallel: { hasTask: false, autoAdvance: true },
  timer: { hasTask: false, autoAdvance: false },
  webhook: { hasTask: false, autoAdvance: false },
  auto_action: { hasTask: false, autoAdvance: true },
  sub_process: { hasTask: false, autoAdvance: true }
};

function initEngine() {
  setInterval(() => {
    try { checkTimers(); } catch(e) { console.error('Timer check error:', e); }
  }, 30000);
  console.log('⏱ Workflow timer engine started (30s interval)');
}

function startWorkflow(templateId, businessType, businessId, data, userId) {
  const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(templateId);
  if (!template) throw new Error('Template not found');

  const nodes = JSON.parse(template.nodes);
  const startNode = nodes.find(n => n.type === 'start');
  if (!startNode) throw new Error('Template has no start node');

  const result = db.prepare(`INSERT INTO workflow_instances
    (template_id, business_type, business_id, current_node_id, status, node_data, started_by)
    VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .run(templateId, businessType, businessId, startNode.id, JSON.stringify({ data: data || {} }), userId);

  const instanceId = result.lastInsertRowid;

  logNodeAction(instanceId, startNode.id, 'entered', userId, { message: 'Workflow started' });

  // Auto-advance from start
  setTimeout(() => {
    try { advanceNode(instanceId, { userId }); } catch(e) { console.error('Start advance error:', e); }
  }, 100);

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

  logNodeAction(instanceId, currentNode.id, 'exited', options.userId, {});

  const nextEdges = getOutgoingEdges(edges, currentNode.id, nodeData.data);

  for (const edge of nextEdges) {
    const nextNode = nodes.find(n => n.id === edge.to);
    if (!nextNode) continue;

    db.prepare('UPDATE workflow_instances SET current_node_id = ? WHERE id = ?').run(nextNode.id, instanceId);
    logNodeAction(instanceId, nextNode.id, 'entered', options.userId, {});

    executeNode(instanceId, nextNode, options.userId);
  }
}

function executeNode(instanceId, node, userId) {
  const config = node.config || {};

  switch (node.type) {
    case 'end':
      db.prepare(`UPDATE workflow_instances SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).run(instanceId);
      logNodeAction(instanceId, node.id, 'completed', userId, {});
      break;

    case 'approval':
    case 'task':
      db.prepare(`INSERT INTO workflow_tasks
        (instance_id, node_id, node_type, title, description, assignee_id, assignee_role, due_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(instanceId, node.id, node.type, config.title || node.label,
          config.description || '', config.assignee_id || null,
          config.assignee_role || null, config.due_at || null);
      break;

    case 'condition': {
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
      const tpl = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(instance.template_id);
      const edgs = JSON.parse(tpl.edges);
      const nd = JSON.parse(instance.node_data);

      const conditionResult = evaluateCondition(config.expression, nd.data);
      logNodeAction(instanceId, node.id, 'condition_evaluated', userId, { result: conditionResult });

      // Auto-advance handled by caller
      break;
    }

    case 'timer':
      if (config.delay_minutes) {
        const fireAt = new Date(Date.now() + config.delay_minutes * 60 * 1000).toISOString();
        db.prepare('INSERT INTO workflow_timers (instance_id, node_id, fire_at) VALUES (?, ?, ?)')
          .run(instanceId, node.id, fireAt);
        logNodeAction(instanceId, node.id, 'timer_set', userId, { fire_at: fireAt });
      }
      break;

    case 'webhook':
      if (config.url) {
        callWebhook(config.url, config.method || 'POST', config.headers || {}, { instance_id: instanceId, node_id: node.id, timestamp: new Date().toISOString() })
          .then(response => {
            const inst = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
            if (inst && inst.current_node_id === node.id) {
              logNodeAction(instanceId, node.id, 'webhook_completed', userId, { status: response.status });
              advanceNode(instanceId, { userId });
            }
          })
          .catch(err => {
            logNodeAction(instanceId, node.id, 'webhook_failed', userId, { error: err.message });
            if (config.on_error === 'advance') advanceNode(instanceId, { userId });
          });
        logNodeAction(instanceId, node.id, 'webhook_called', userId, { url: config.url });
      }
      return;

    case 'auto_action':
      executeAutoAction(config, instanceId, node.id, userId);
      break;

    case 'sub_process':
      if (config.template_id) {
        const inst = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
        const nd = JSON.parse(inst.node_data);
        startWorkflow(config.template_id, 'sub_process', instanceId, nd.data, userId);
        logNodeAction(instanceId, node.id, 'subprocess_started', userId, { sub_template_id: config.template_id });
      }
      break;
  }

  // Auto-advance for non-task, non-timer, non-webhook nodes
  if (NODE_TYPES[node.type] && NODE_TYPES[node.type].autoAdvance &&
      node.type !== 'webhook' && node.type !== 'timer') {
    advanceNode(instanceId, { userId });
  }
}

function handleTaskAction(taskId, action, userId, comment) {
  const task = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(taskId);
  if (!task || task.status !== 'pending') throw new Error('Task not available');

  const newStatus = action === 'approve' ? 'completed' : 'rejected';

  db.prepare(`UPDATE workflow_tasks SET status = ?, comment = ?, completed_at = datetime('now'), completed_by = ? WHERE id = ?`)
    .run(newStatus, comment || '', userId, taskId);

  logNodeAction(task.instance_id, task.node_id, `${newStatus}_by_user`, userId, { taskId, comment });

  if (action === 'reject') {
    const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(task.instance_id);
    const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(instance.template_id);
    const edges = JSON.parse(template.edges);

    const rejectEdges = edges.filter(e => e.from === task.node_id && (e.label === 'rejected' || e.label === '驳回'));
    if (rejectEdges.length > 0) {
      const rejectEdge = rejectEdges[0];
      db.prepare('UPDATE workflow_instances SET current_node_id = ? WHERE id = ?').run(rejectEdge.to, task.instance_id);
      const nodes = JSON.parse(template.nodes);
      const nextNode = nodes.find(n => n.id === rejectEdge.to);
      if (nextNode) {
        logNodeAction(task.instance_id, nextNode.id, 'entered', userId, { from_rejection: true });
        executeNode(task.instance_id, nextNode, userId);
      }
    }
  } else {
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

  const hasConditions = outgoing.some(e => e.condition);
  if (hasConditions) {
    return outgoing.filter(e => {
      if (!e.condition) return false;
      return evaluateCondition(e.condition, conditionResult || {});
    }).map(e => ({ nodeId: e.to, edgeId: e.id, label: e.label }));
  }

  return outgoing.map(e => ({ nodeId: e.to, edgeId: e.id, label: e.label }));
}

function getOutgoingEdges(edges, nodeId, data) {
  const outgoing = edges.filter(e => e.from === nodeId);
  if (outgoing.length === 0) return [];

  const hasConditions = outgoing.some(e => e.condition);
  if (hasConditions) {
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
  db.prepare("UPDATE workflow_tasks SET status = 'cancelled' WHERE instance_id = ? AND status = 'pending'").run(instanceId);
  logNodeAction(instanceId, instance.current_node_id, 'cancelled', null, {});
}

function logNodeAction(instanceId, nodeId, action, userId, details) {
  db.prepare('INSERT INTO workflow_node_logs (instance_id, node_id, action, user_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(instanceId, nodeId, action, userId, JSON.stringify(details));
}

function callWebhook(url, method, headers, payload) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
      const body = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(headers || {})
        },
        timeout: 10000
      };

      const req = mod.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Webhook timeout')); });
      req.write(body);
      req.end();
    } catch(e) { reject(e); }
  });
}

function executeAutoAction(config, instanceId, nodeId, userId) {
  const actionType = config.action_type;

  switch (actionType) {
    case 'update_field': {
      const instance = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
      if (instance && config.field && config.value !== undefined) {
        try {
          const tableMap = { customer: 'customers', demand: 'demands', proposal: 'proposals', collaboration: 'collaborations' };
          const tableName = tableMap[instance.business_type];
          if (tableName) {
            const safeField = config.field.replace(/[^a-z_]/gi, '');
            db.prepare(`UPDATE ${tableName} SET ${safeField} = ?, updated_at = datetime('now') WHERE id = ?`)
              .run(config.value, instance.business_id);
            logNodeAction(instanceId, nodeId, 'field_updated', userId, { field: safeField, value: config.value });
          }
        } catch(e) {
          logNodeAction(instanceId, nodeId, 'field_update_failed', userId, { error: e.message });
        }
      }
      break;
    }
    case 'notify':
      logNodeAction(instanceId, nodeId, 'notification_sent', userId, { message: config.message || '' });
      break;
    default:
      logNodeAction(instanceId, nodeId, 'auto_action_unknown', userId, { action_type: actionType });
  }
}

module.exports = {
  initEngine, startWorkflow, advanceNode, executeNode,
  handleTaskAction, checkTimers, evaluateCondition,
  getNodeById, getNextNodes, getOutgoingEdges,
  pauseWorkflow, resumeWorkflow, cancelWorkflow,
  NODE_TYPES, callWebhook
};
