const { chromium } = require('playwright');
const db = require('../server/db');

const BASE_URL = process.env.TM_BASE_URL || 'http://localhost:3002';
const API = BASE_URL + '/api';
const USERNAME = process.env.TM_USER || 'admin';
const PASSWORD = process.env.TM_PASSWORD || 'turing2026';

let token = '';
let customerId = null;
const marker = 'phase5-task-ui-' + Date.now();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
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
  if (customerId) {
    try { await api('/customers/' + customerId, { method: 'DELETE' }); } catch(e) {}
  }
}

async function seedTask() {
  const login = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD })
  });
  assert(login.status === 200 && login.body.token, 'API login failed');
  token = login.body.token;

  const created = await api('/customers', {
    method: 'POST',
    body: JSON.stringify({
      brand_name: 'Phase5 Brand ' + marker,
      company_name: 'Phase5 Company',
      industry: '3C',
      stage: 'lead',
      source: 'phase5-test',
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
}

(async () => {
  let browser;
  try {
    await seedTask();

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

    await page.click('[data-page="workflow-tasks"]');
    await page.waitForSelector('#page-workflow-tasks.active', { timeout: 10000 });
    await page.waitForSelector('#wf-tasks-list .wf-task-card', { timeout: 10000 });

    await page.selectOption('#wf-task-filter', 'pending');
    await page.fill('#wf-task-search', marker);
    await page.click('.wf-task-toolbar button:has-text("筛选")');
    await page.waitForTimeout(500);

    const cards = page.locator('#wf-tasks-list .wf-task-card');
    assert(await cards.count() >= 1, 'filtered task card not found');
    const cardText = await cards.first().innerText();
    assert(cardText.includes('跟进方案输出') || cardText.includes(marker), 'task card does not show seeded follow-up task');

    const pendingCount = Number(await page.locator('#wfTaskPending').innerText());
    assert(pendingCount >= 1, 'task summary pending count not updated');

    await cards.first().locator('button:has-text("详情")').click();
    await page.waitForSelector('#wf-instance-modal[style*="flex"]', { timeout: 10000 });
    const detailText = await page.locator('#wf-instance-modal-body').innerText();
    assert(detailText.includes('Phase5 Brand') && detailText.includes(marker), 'task detail missing customer context');
    await page.locator('#wf-instance-modal .wf-modal-close').click();

    await cards.first().locator('button:has-text("打开客户")').click();
    await page.waitForSelector('#page-m0.active', { timeout: 10000 });
    await page.waitForSelector('#custDetailSidebar.open', { timeout: 10000 });
    const customerDetail = await page.locator('#custDetailBody').innerText();
    assert(customerDetail.includes('Phase5 Brand') && customerDetail.includes(marker), 'open customer did not show seeded customer detail');
    await page.locator('#custDetailSidebar .modal-close').click();

    await page.click('[data-page="workflow-tasks"]');
    await page.waitForSelector('#page-workflow-tasks.active', { timeout: 10000 });
    await page.fill('#wf-task-search', marker);
    await page.click('.wf-task-toolbar button:has-text("筛选")');
    await page.waitForSelector('#wf-tasks-list .wf-task-card', { timeout: 10000 });
    await page.fill('#wf-tasks-list .wf-task-card input[placeholder="处理备注..."]', 'Phase5 UI acceptance complete');
    await page.click('#wf-tasks-list .wf-task-card button:has-text("完成")');
    await page.waitForTimeout(800);

    await page.selectOption('#wf-task-filter', 'completed');
    await page.fill('#wf-task-search', marker);
    await page.click('.wf-task-toolbar button:has-text("筛选")');
    await page.waitForTimeout(500);
    const completedText = await page.locator('#wf-tasks-list').innerText();
    assert(completedText.includes('已完成') || completedText.includes('跟进方案输出'), 'completed task not visible after completion filter');

    assert(errors.length === 0, 'browser errors: ' + errors.join(' | '));
    console.log('Phase 5 task center UI acceptance passed');
  } finally {
    if (browser) await browser.close();
    await cleanup();
  }
})().catch(err => {
  console.error('Phase 5 task center UI acceptance failed:', err.message);
  cleanup().finally(() => process.exit(1));
});
