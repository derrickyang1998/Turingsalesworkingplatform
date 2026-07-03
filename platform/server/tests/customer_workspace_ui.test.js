const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'platform', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(repoRoot, 'platform', 'app.js'), 'utf8');

function pageSection(id) {
  const marker = `id="${id}"`;
  const start = indexHtml.indexOf(marker);
  assert.notEqual(start, -1, `missing ${id}`);
  const next = indexHtml.indexOf('<div class="page"', start + marker.length);
  return indexHtml.slice(start, next === -1 ? indexHtml.length : next);
}

test('customer workspace exposes separate board and detail pages', () => {
  assert.match(indexHtml, /id="page-m0"/);
  assert.match(indexHtml, /id="page-m0-detail"/);
  assert.match(appJs, /id:\s*'m0',\s*icon:\s*'看',\s*label:\s*'客户看板'/);
  assert.match(appJs, /id:\s*'m0-detail',\s*icon:\s*'客',\s*label:\s*'客户明细'/);
});

test('customer board page keeps the operating dashboard out of customer details', () => {
  const board = pageSection('page-m0');
  assert.match(board, /id="m0StageBars"/);
  assert.match(board, /id="m0FocusBrand"/);
  assert.match(board, /id="m0AiInsightText"/);
  assert.doesNotMatch(board, /id="custSearch"/);
  assert.doesNotMatch(board, /id="custTableBody"/);
  assert.doesNotMatch(board, /id="seaPoolTable"/);
});

test('customer detail page owns list filters, public pool, and opportunity views', () => {
  const detail = pageSection('page-m0-detail');
  assert.match(detail, /客户明细/);
  assert.match(detail, /id="custSearch"/);
  assert.match(detail, /id="custTableBody"/);
  assert.match(detail, /id="seaPoolTable"/);
  assert.match(detail, /id="crmOpportunityView"/);
  assert.match(detail, /id="m0StageFilter"/);
  assert.doesNotMatch(detail, /id="m0StageBars"/);
});

test('customer navigation initializes board and detail views independently', () => {
  assert.match(appJs, /id === 'm0'[\s\S]*?loadCustomerStats\(\)/);
  assert.match(appJs, /id === 'm0-detail'[\s\S]*?switchCrmView\(curCrmView \|\| 'pipeline'\)/);
  assert.match(appJs, /await loadCustomers\(\)/);
  assert.match(indexHtml, /ppt\.js\?v=20260702v916kbbridge/);
});
