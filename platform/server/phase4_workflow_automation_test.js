const db = require('./db');

const BASE = process.env.TM_API_BASE || 'http://localhost:3002/api';

let token = '';
let customerId = null;
const marker = 'phase4-automation-' + Date.now();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch(e) { body = { raw: text }; }
  return { status: res.status, body };
}

function cleanupWorkflowRows() {
  if (!customerId) return;
  const instances = db.prepare("SELECT id FROM workflow_instances WHERE business_type = 'customer' AND business_id = ?").all(customerId);
  for (const instance of instances) {
    db.prepare('DELETE FROM workflow_tasks WHERE instance_id = ?').run(instance.id);
    db.prepare('DELETE FROM workflow_node_logs WHERE instance_id = ?').run(instance.id);
    db.prepare('DELETE FROM workflow_instances WHERE id = ?').run(instance.id);
  }
}

async function cleanup() {
  try { cleanupWorkflowRows(); } catch(e) {}
  try {
    db.prepare('DELETE FROM knowledge_entries WHERE content LIKE ? OR key_terms LIKE ?').run('%' + marker + '%', '%' + marker + '%');
  } catch(e) {}
  if (customerId) {
    try { await api('/customers/' + customerId, { method: 'DELETE' }); } catch(e) {}
  }
}

function findTask(tasks, predicate) {
  return (tasks || []).find(t => String(t.business_id) === String(customerId) && predicate(t));
}

(async () => {
  try {
    const login = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'turing2026' })
    });
    assert(login.status === 200 && login.body.token, 'admin login failed');
    token = login.body.token;

    const created = await api('/customers', {
      method: 'POST',
      body: JSON.stringify({
        brand_name: 'Phase4 Brand ' + marker,
        company_name: 'Phase4 Company',
        industry: '3C',
        stage: 'lead',
        source: 'phase4-test',
        notes: marker
      })
    });
    assert(created.status === 200 && created.body.id, 'customer create failed');
    customerId = created.body.id;

    const updated = await api('/customers/' + customerId, {
      method: 'PUT',
      body: JSON.stringify({ stage: 'proposal' })
    });
    assert(updated.status === 200 && updated.body.success, 'stage update failed');

    const stageTasks = await api('/workflow/tasks?status=pending');
    assert(stageTasks.status === 200 && Array.isArray(stageTasks.body.tasks), 'workflow task list failed after stage change');
    const stageTask = findTask(stageTasks.body.tasks, t => (t.title || '').includes('跟进方案输出'));
    assert(stageTask, 'stage change did not create proposal follow-up task');

    const proposal = await api('/customers/' + customerId + '/archive-result', {
      method: 'POST',
      body: JSON.stringify({
        artifact_type: 'proposal',
        title: 'Phase4 Proposal ' + marker,
        content: 'Proposal content ' + marker,
        tags: ['Phase4 Brand', marker],
        source_type: 'ai_proposal'
      })
    });
    assert(proposal.status === 200 && proposal.body.id, 'proposal archive failed');
    assert(proposal.body.task_id, 'proposal archive should return generated task_id');

    const artifactTasks = await api('/workflow/tasks?status=pending');
    assert(artifactTasks.status === 200 && Array.isArray(artifactTasks.body.tasks), 'workflow task list failed after artifact archive');
    const artifactTask = findTask(artifactTasks.body.tasks, t => String(t.id) === String(proposal.body.task_id) && (t.title || '').includes('确认方案并推进客户反馈'));
    assert(artifactTask, 'proposal archive did not create customer feedback follow-up task');

    const completed = await api('/workflow/tasks/' + artifactTask.id + '/complete', {
      method: 'POST',
      body: JSON.stringify({ comment: 'Phase4 acceptance complete ' + marker })
    });
    assert(completed.status === 200 && completed.body.success, 'task completion failed');

    const detail = await api('/workflow/tasks/' + artifactTask.id);
    assert(detail.status === 200 && detail.body.task && detail.body.task.status === 'completed', 'completed task detail not updated');

    console.log('Phase 4 workflow automation acceptance passed');
  } finally {
    await cleanup();
  }
})().catch(err => {
  console.error('Phase 4 workflow automation acceptance failed:', err.message);
  cleanup().finally(() => process.exit(1));
});
