const { chromium } = require('playwright');
const db = require('../server/db');

const BASE_URL = process.env.TM_BASE_URL || 'http://localhost:3002';
const API = BASE_URL + '/api';
const USERNAME = process.env.TM_USER || 'admin';
const PASSWORD = process.env.TM_PASSWORD || 'turing2026';

let token = '';
let knowledgeId = null;
const marker = 'phase7-knowledge-' + Date.now();

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

async function cleanup() {
  if (knowledgeId) {
    try { db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(knowledgeId); } catch(e) {}
  }
  try {
    db.prepare('DELETE FROM knowledge_entries WHERE content LIKE ? OR key_terms LIKE ?').run('%' + marker + '%', '%' + marker + '%');
  } catch(e) {}
}

(async () => {
  let browser;
  try {
    const login = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: USERNAME, password: PASSWORD })
    });
    assert(login.status === 200 && login.body.token, 'admin login failed');
    token = login.body.token;

    const created = await api('/knowledge', {
      method: 'POST',
      body: JSON.stringify({
        entry_type: 'proposal',
        source_type: 'phase7_acceptance',
        tags: ['Phase7Brand', '3C', 'North America', marker],
        content: 'Phase7Brand 3C North America proven creator bundle tactic ' + marker
      })
    });
    assert(created.status === 200 && created.body.id, 'knowledge create failed');
    knowledgeId = created.body.id;

    const similar = await api('/knowledge/similar?brand=Phase7Brand&industry=3C&market=North%20America&type=proposal');
    assert(similar.status === 200 && Array.isArray(similar.body.entries), 'similar knowledge API failed');
    assert(similar.body.entries.some(e => e.id === knowledgeId && e.similarity_score > 0), 'similar API did not return seeded case');

    const beforeUse = db.prepare('SELECT usage_count FROM knowledge_entries WHERE id = ?').get(knowledgeId).usage_count || 0;
    const use = await api('/knowledge/' + knowledgeId + '/use', { method: 'POST' });
    assert(use.status === 200 && use.body.success, 'knowledge use marker failed');
    const afterUse = db.prepare('SELECT usage_count FROM knowledge_entries WHERE id = ?').get(knowledgeId).usage_count || 0;
    assert(afterUse === beforeUse + 1, 'usage_count was not incremented');

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

    await page.click('[data-page="m3"]');
    await page.waitForSelector('#page-m3.active', { timeout: 10000 });
    await page.evaluate((markerValue) => {
      eval(`
        curDemand = {
          brand: 'Phase7Brand',
          company: 'Phase7 Company',
          product: 'Phase7 Device',
          usp: 'creator bundle tactic',
          platform: 'YouTube',
          area: 'North America',
          budget: '$15K-50K',
          category: '3C',
          notes: '${markerValue}'
        };
        selTpl = TEMPLATES && TEMPLATES[0] ? TEMPLATES[0].id : null;
      `);
      document.getElementById('m3s1').classList.add('hidden');
      document.getElementById('m3s2').classList.add('hidden');
      document.getElementById('m3s3').classList.remove('hidden');
      if (typeof initM3 === 'function') initM3();
      eval(`if (!selTpl && TEMPLATES && TEMPLATES[0]) selTpl = TEMPLATES[0].id;`);
    }, marker);

    await page.evaluate(() => generateProposal());
    await page.waitForFunction((needle) => document.getElementById('proposalOutput')?.innerText.includes(needle), marker, { timeout: 10000 });
    const proposalText = await page.locator('#proposalOutput').innerText();
    assert(proposalText.includes('proposal #' + knowledgeId) || proposalText.includes('案例 #' + knowledgeId), 'proposal output missing reuse case id');
    assert(proposalText.includes(marker), 'proposal output missing seeded reusable case');
    assert(errors.length === 0, 'browser errors: ' + errors.join(' | '));

    console.log('Phase 7 knowledge reuse acceptance passed');
  } finally {
    if (browser) await browser.close();
    await cleanup();
  }
})().catch(err => {
  console.error('Phase 7 knowledge reuse acceptance failed:', err.message);
  cleanup().finally(() => process.exit(1));
});
