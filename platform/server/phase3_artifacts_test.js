const db = require('./db');

const BASE = process.env.TM_API_BASE || 'http://localhost:3002/api';

let token = '';
let customerId = null;
let marker = 'phase3-artifact-' + Date.now();

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

async function cleanup() {
  if (customerId) {
    try { await api('/customers/' + customerId, { method: 'DELETE' }); } catch(e) {}
  }
  try {
    db.prepare('DELETE FROM knowledge_entries WHERE content LIKE ? OR key_terms LIKE ?').run('%' + marker + '%', '%' + marker + '%');
  } catch(e) {}
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
        brand_name: 'Phase3 Brand ' + marker,
        company_name: 'Phase3 Company',
        industry: '3C',
        stage: 'proposal',
        source: 'phase3-test',
        notes: marker
      })
    });
    assert(created.status === 200 && created.body.id, 'customer create failed');
    customerId = created.body.id;

    const strategyContent = 'AI strategy content ' + marker;
    const proposalContent = 'Proposal content ' + marker;

    const strategy = await api('/customers/' + customerId + '/archive-result', {
      method: 'POST',
      body: JSON.stringify({
        artifact_type: 'strategy',
        title: 'Phase3 Strategy ' + marker,
        content: strategyContent,
        tags: ['Phase3 Brand', marker],
        source_type: 'ai_strategy'
      })
    });
    assert(strategy.status === 200 && strategy.body.id, 'strategy archive failed');

    const proposal = await api('/customers/' + customerId + '/archive-result', {
      method: 'POST',
      body: JSON.stringify({
        artifact_type: 'proposal',
        title: 'Phase3 Proposal ' + marker,
        content: proposalContent,
        tags: ['Phase3 Brand', marker],
        source_type: 'ai_proposal'
      })
    });
    assert(proposal.status === 200 && proposal.body.id, 'proposal archive failed');

    const detail = await api('/customers/' + customerId + '/detail');
    assert(detail.status === 200, 'customer detail failed');
    const actions = (detail.body.activity || []).map(a => a.action);
    assert(actions.includes('archive_strategy'), 'customer activity missing archive_strategy');
    assert(actions.includes('archive_proposal'), 'customer activity missing archive_proposal');

    const knowledge = await api('/knowledge?search=' + encodeURIComponent(marker));
    assert(knowledge.status === 200, 'knowledge search failed');
    const contents = (knowledge.body.entries || []).map(e => e.content || '').join('\n');
    assert(contents.includes(strategyContent), 'knowledge search missing strategy content');
    assert(contents.includes(proposalContent), 'knowledge search missing proposal content');

    console.log('Phase 3 artifact acceptance passed');
  } finally {
    await cleanup();
  }
})().catch(err => {
  console.error('Phase 3 artifact acceptance failed:', err.message);
  cleanup().finally(() => process.exit(1));
});
