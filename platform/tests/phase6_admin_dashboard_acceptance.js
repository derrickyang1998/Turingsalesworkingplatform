const { chromium } = require('playwright');

const BASE_URL = process.env.TM_BASE_URL || 'http://localhost:3002';
const API = BASE_URL + '/api';
const USERNAME = process.env.TM_USER || 'admin';
const PASSWORD = process.env.TM_PASSWORD || 'turing2026';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(path, opts = {}, token = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch(e) { body = { raw: text }; }
  return { status: res.status, body };
}

(async () => {
  let browser;
  try {
    const login = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: USERNAME, password: PASSWORD })
    });
    assert(login.status === 200 && login.body.token, 'admin API login failed');

    const overview = await api('/admin/overview', {}, login.body.token);
    assert(overview.status === 200 && overview.body.stats, 'admin overview failed');
    const stats = overview.body.stats;
    const required = [
      'totalCustomers',
      'activeCustomers',
      'totalOpportunityValue',
      'totalTasks',
      'pendingTasks',
      'completedTasks',
      'overdueTasks',
      'taskCompletionRate',
      'aiArtifacts',
      'totalKnowledgeEntries'
    ];
    for (const key of required) {
      assert(Object.prototype.hasOwnProperty.call(stats, key), 'admin overview missing ' + key);
    }
    assert(Array.isArray(stats.customerStages), 'customerStages should be an array');
    assert(Array.isArray(stats.opportunityStages), 'opportunityStages should be an array');
    assert(Array.isArray(stats.teamPerformance), 'teamPerformance should be an array');
    assert(Array.isArray(stats.taskStatus), 'taskStatus should be an array');
    assert(Array.isArray(stats.knowledgeByType), 'knowledgeByType should be an array');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.fill('#loginUser', USERNAME);
    await page.fill('#loginPass', PASSWORD);
    await page.click('#authOverlay button');
    await page.waitForSelector('#custTableBody tr', { timeout: 10000 });

    await page.click('[data-page="admin"]');
    await page.waitForSelector('#page-admin.active', { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('ad_totalCustomers')?.textContent !== '-', null, { timeout: 10000 });

    const totalCustomers = await page.locator('#ad_totalCustomers').innerText();
    const taskRate = await page.locator('#ad_taskRate').innerText();
    const stageText = await page.locator('#ad_customerStageChart').innerText();
    const taskHealthText = await page.locator('#ad_taskHealth').innerText();
    const knowledgeText = await page.locator('#ad_knowledgeHealth').innerText();
    const teamText = await page.locator('#ad_teamPerformance').innerText();

    assert(totalCustomers.trim() !== '-', 'total customers card did not render');
    assert(taskRate.includes('%'), 'task completion rate did not render as percent');
    assert(stageText.includes('客户') || stageText.length > 0, 'customer stage chart did not render');
    assert(taskHealthText.includes('待处理') && taskHealthText.includes('已逾期'), 'task health panel missing key labels');
    assert(knowledgeText.includes('知识条目') && knowledgeText.includes('AI策略/方案'), 'knowledge health panel missing key labels');
    assert(teamText.includes('成员') || teamText.length > 0, 'team performance panel did not render');
    assert(errors.length === 0, 'browser errors: ' + errors.join(' | '));

    console.log('Phase 6 admin dashboard acceptance passed');
  } finally {
    if (browser) await browser.close();
  }
})().catch(err => {
  console.error('Phase 6 admin dashboard acceptance failed:', err.message);
  process.exit(1);
});
