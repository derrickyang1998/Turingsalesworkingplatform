'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const platformRoot = path.resolve(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(platformRoot, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(platformRoot, 'app.js'), 'utf8');
const navigationSource = fs.readFileSync(path.join(platformRoot, 'client', 'core', 'navigation.js'), 'utf8');
const componentStyles = fs.readFileSync(path.join(platformRoot, 'client', 'styles', 'components.css'), 'utf8');

test('performance workspace exposes separate monitor and dashboard routes', () => {
  for (const route of ['performance-monitor', 'performance-dashboard']) {
    assert.match(navigationSource, new RegExp("id: '" + route + "'"));
    assert.match(navigationSource, new RegExp("'" + route + "': '/" + route + "'"));
    assert.match(indexHtml, new RegExp('id="page-' + route + '"'));
  }
  assert.match(appSource, /if \(id === 'performance-monitor'\) \{ initPerformanceMonitor\(\); \}/);
  assert.match(appSource, /if \(id === 'performance-dashboard'\) \{ initPerformanceDashboard\(\); \}/);
});

test('performance monitor uses the sandboxed import API with explicit header mapping', () => {
  assert.match(indexHtml, /id="performanceImportFile"[^>]+accept="\.csv,\.xlsx"/);
  assert.match(indexHtml, /id="performanceMappingUrl"/);
  assert.match(appSource, /form\.append\('campaign_id', String\(campaignId\)\)/);
  assert.match(appSource, /form\.append\('column_mapping', JSON\.stringify\(performanceUploadMapping\(\)\)\)/);
  assert.match(appSource, /apiFetch\('\/performance\/upload', \{ method: 'POST', body: form \}\)/);
  assert.match(appSource, /accepted_count/);
  assert.match(appSource, /duplicate_count/);
});

test('manual data entry keeps performance inputs and commercial confirmation distinct', () => {
  assert.match(appSource, /performanceCapabilities && performanceCapabilities\.can_edit_commercial/);
  assert.match(appSource, /performanceImpressions', '展示量'/);
  assert.match(appSource, /id="performanceConfirmed"/);
  assert.match(appSource, /confirmed: confirmed/);
  assert.match(appSource, /performance\/contents\/' \+ encodeURIComponent\(contentId\) \+ '\/manual-inputs/);
  assert.match(appSource, /performanceRate\(metrics\.core_view_er\)/);
  assert.match(appSource, /performanceMoney\(metrics\.cpm\)/);
  assert.match(appSource, /performanceMoney\(metrics\.cpc\)/);
  assert.match(appSource, /performanceRate\(metrics\.roi\)/);
  assert.match(appSource, /performanceRatio\(metrics\.roas\)/);
});

test('performance tables retain compact, sticky operational controls', () => {
  assert.match(componentStyles, /\.tm-performance-table-container[\s\S]*?overflow-y: auto/);
  assert.match(componentStyles, /\.tm-performance-table th:first-child[\s\S]*?position: sticky/);
  assert.match(componentStyles, /\.tm-performance-confirmation[\s\S]*?align-items: center/);
  assert.match(componentStyles, /\.tm-performance-metric-grid[\s\S]*?grid-template-columns/);
});

test('performance monitor offers both current-filter and full-campaign CSV exports', () => {
  assert.match(indexHtml, /id="performanceExportFiltered"[^>]+onclick="exportPerformanceContents\('filtered'\)"/);
  assert.match(indexHtml, /id="performanceExportAll"[^>]+onclick="exportPerformanceContents\('all'\)"/);
  assert.match(appSource, /function exportPerformanceContents\(scope\)/);
  assert.match(appSource, /params\.set\('scope', scope\)/);
  assert.match(appSource, /performance\/contents\/export\?/);
  assert.match(appSource, /dlFile\('content_performance_' \+ scope \+ '\.csv'/);
});

test('performance monitor exposes a collapsed, campaign-scoped integration preview without dispatch controls', () => {
  assert.match(indexHtml, /id="performanceIntegrationPreview"/);
  assert.match(indexHtml, /id="performanceIntegrationStatus"/);
  assert.match(indexHtml, /onclick="loadPerformanceIntegrationPreview\(\)"/);
  assert.match(indexHtml, /飞书字段映射预览/);
  assert.match(appSource, /async function loadPerformanceIntegrationPreview\(\)/);
  assert.match(appSource, /performance\/integration-preview/);
  assert.match(appSource, /function renderPerformanceIntegrationPreview\(/);
  assert.match(appSource, /provider_validation/);
  assert.match(appSource, /write_attempted/);
  assert.match(appSource, /var performanceIntegrationRequestSequence = 0;/);
  assert.match(
    appSource,
    /requestSequence !== performanceIntegrationRequestSequence \|\| campaignId !== getPerformanceCampaignId\(\)/
  );
});
