const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'platform', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(repoRoot, 'platform', 'app.js'), 'utf8');

test('brand library exposes the command workspace shell without changing the PPT bridge', () => {
  [
    'brandWorkspace',
    'brandWorkspaceStats',
    'brandResults',
    'brandDetailPanel',
    'brandKnowledgeStatus',
    'brandOpportunityPanel',
    'brandSocialSources'
  ].forEach((id) => assert.match(indexHtml, new RegExp(`id="${id}"`), id));

  assert.match(indexHtml, /ppt\.js\?v=20260702v916kbbridge/);
});

test('brand workspace implements selection, knowledge status, competitors, and social actions', () => {
  [
    'selectBrand',
    'renderBrandWorkspaceStats',
    'renderBrandDetail',
    'renderBrandKnowledgeStatus',
    'renderBrandOpportunityPanel',
    'openBrandSocialSearch',
    'copyBrandBriefToDemand',
    'showRelatedBrands'
  ].forEach((fn) => assert.match(appJs, new RegExp(`function\\s+${fn}\\s*\\(`), fn));

  assert.match(appJs, /apiFetch\('\/brands'/);
  assert.match(appJs, /apiFetch\('\/brands\/enrich'/);
});
