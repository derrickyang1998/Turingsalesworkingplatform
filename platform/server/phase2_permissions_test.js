const BASE = process.env.TM_API_BASE || 'http://localhost:3002/api';

let adminToken = '';
let userToken = '';
let createdIds = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(path, opts = {}, token = adminToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch(e) { body = { raw: text }; }
  return { status: res.status, body };
}

async function login(username, password = 'turing2026') {
  const res = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  }, '');
  assert(res.status === 200 && res.body.token, 'login failed for ' + username + ': ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 200));
  return res.body.token;
}

async function createCustomer(payload) {
  const res = await api('/customers', {
    method: 'POST',
    body: JSON.stringify({
      brand_name: payload.brand,
      company_name: payload.company || payload.brand + ' Co',
      industry: payload.industry || '3C',
      stage: 'lead',
      source: 'phase2-test',
      budget_estimate: '$15K-50K',
      assigned_to: payload.assigned_to,
      notes: 'phase2 permission acceptance'
    })
  });
  assert(res.status === 200 && res.body.id, 'failed to create customer ' + payload.brand);
  createdIds.push(res.body.id);
  return res.body.id;
}

async function cleanup() {
  for (const id of createdIds.reverse()) {
    try { await api('/customers/' + id, { method: 'DELETE' }); } catch(e) {}
  }
}

(async () => {
  try {
    adminToken = await login('admin');
    const usersRes = await api('/admin/users');
    assert(usersRes.status === 200 && Array.isArray(usersRes.body.users), 'admin users list failed');

    const zhangwei = usersRes.body.users.find(u => u.username === 'zhangwei');
    const wangfang = usersRes.body.users.find(u => u.username === 'wangfang');
    const liming = usersRes.body.users.find(u => u.username === 'liming');
    assert(zhangwei && wangfang && liming, 'required seeded users not found');

    const suffix = Date.now();
    const ownId = await createCustomer({ brand: 'P2 Own ' + suffix, assigned_to: zhangwei.id });
    const teamId = await createCustomer({ brand: 'P2 Team ' + suffix, assigned_to: wangfang.id });
    const otherId = await createCustomer({ brand: 'P2 Other ' + suffix, assigned_to: liming.id });
    const poolId = await createCustomer({ brand: 'P2 Pool ' + suffix, assigned_to: zhangwei.id });
    const returnRes = await api('/customers/' + poolId + '/return-pool', { method: 'POST' });
    assert(returnRes.status === 200, 'failed to return test customer to pool');

    userToken = await login('zhangwei');

    const search = encodeURIComponent(String(suffix));

    const my = await api('/customers?scope=my&search=' + search, {}, userToken);
    const myIds = (my.body.customers || []).map(c => c.id);
    assert(my.status === 200 && myIds.includes(ownId), 'my scope should include own customer; got ids=' + JSON.stringify(myIds) + ' ownId=' + ownId + ' status=' + my.status);
    assert(!myIds.includes(teamId) && !myIds.includes(otherId) && !myIds.includes(poolId), 'my scope leaked team/other/pool customer');

    const team = await api('/customers?scope=team&search=' + search, {}, userToken);
    const teamIds = (team.body.customers || []).map(c => c.id);
    assert(team.status === 200 && teamIds.includes(ownId) && teamIds.includes(teamId), 'team scope should include same department customers; got ids=' + JSON.stringify(teamIds) + ' ownId=' + ownId + ' teamId=' + teamId);
    assert(!teamIds.includes(otherId) && !teamIds.includes(poolId), 'team scope leaked other department or pool customer');

    const all = await api('/customers?scope=all&search=' + search, {}, userToken);
    const allIds = (all.body.customers || []).map(c => c.id);
    assert(all.status === 200 && allIds.includes(ownId), 'non-admin all fallback should include own customer');
    assert(!allIds.includes(teamId) && !allIds.includes(otherId), 'non-admin all scope should not expose all customers');

    const pool = await api('/customers/sea-pool', {}, userToken);
    const poolIds = (pool.body.customers || []).map(c => c.id);
    assert(pool.status === 200 && poolIds.includes(poolId), 'pool endpoint should include unassigned public customer');

    assert((await api('/customers/' + ownId + '/detail', {}, userToken)).status === 200, 'own detail should be readable');
    assert((await api('/customers/' + teamId + '/detail', {}, userToken)).status === 200, 'team detail should be readable');
    assert((await api('/customers/' + poolId + '/detail', {}, userToken)).status === 200, 'pool detail should be readable');
    assert((await api('/customers/' + otherId + '/detail', {}, userToken)).status === 403, 'other department detail should be forbidden');

    const forbiddenWrite = await api('/customers/' + teamId, {
      method: 'PUT',
      body: JSON.stringify({ notes: 'should not update' })
    }, userToken);
    assert(forbiddenWrite.status === 403, 'team customer write should be forbidden for non-owner');

    console.log('Phase 2 permissions acceptance passed');
  } finally {
    await cleanup();
  }
})().catch(err => {
  console.error('Phase 2 permissions acceptance failed:', err.message);
  cleanup().finally(() => process.exit(1));
});
