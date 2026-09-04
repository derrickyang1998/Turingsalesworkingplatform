'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const platformRoot = path.resolve(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(platformRoot, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(platformRoot, 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(platformRoot, 'server', 'server.js'), 'utf8');
const performanceServiceSource = fs.readFileSync(path.join(platformRoot, 'server', 'services', 'performance_manual_service.js'), 'utf8');
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

test('performance monitor supports a separate sandboxed batch-metrics update with explicit mapping', () => {
  assert.match(indexHtml, /id="performanceMetricsImportFile"[^>]+accept="\.csv,\.xlsx"/);
  assert.match(indexHtml, /id="performanceMetricsMappingUrl"/);
  assert.match(indexHtml, /id="performanceMetricsMappingViews"/);
  assert.match(indexHtml, /onclick="downloadPerformanceMetricsTemplate\(\)"/);
  assert.match(appSource, /function performanceMetricsUploadMapping\(\)/);
  assert.match(appSource, /form\.append\('mapping_version', 'performance-metrics-ui-v1'\)/);
  assert.match(appSource, /performanceMetricsUploadMapping\(\)/);
  assert.match(appSource, /apiFetch\('\/performance\/metrics\/upload', \{ method: 'POST', body: form \}\)/);
  assert.match(appSource, /function handlePerformanceMetricsImport\(event\)/);
  assert.match(appSource, /function handlePerformanceMetricsDrop\(event\)/);
  assert.match(serverSource, /app\.post\('\/api\/performance\/metrics\/upload', authMiddleware/);
  assert.match(serverSource, /req\.phase4Request\.multipart\.sandboxMultipart/);
  assert.match(serverSource, /performanceManualService\.importMetricRows/);
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

test('performance monitor exposes a permission-aware Feishu connection configuration without external synchronization', () => {
  assert.match(indexHtml, /id="performanceFeishuConnection"/);
  assert.match(indexHtml, /活动飞书连接配置/);
  assert.match(appSource, /var performanceFeishuConnectionRequestSequence = 0;/);
  assert.match(appSource, /async function loadPerformanceFeishuConnection\(\)/);
  assert.match(appSource, /function renderPerformanceFeishuConnection\(/);
  assert.match(appSource, /function savePerformanceFeishuConnectionDraft\(\)/);
  assert.match(appSource, /function approvePerformanceFeishuConnectionDraft\(\)/);
  assert.match(appSource, /performance\/feishu-connection/);
  assert.match(appSource, /not_enabled_in_this_release/);
  assert.match(appSource, /field\.access !== 'commercial'/);
  for (const action of ['savePerformanceFeishuConnectionDraft', 'approvePerformanceFeishuConnectionDraft']) {
    assert.match(
      appSource,
      new RegExp(
        'async function ' + action + '\\(\\)[\\s\\S]*?var requestSequence = \\+\\+performanceFeishuConnectionRequestSequence;[\\s\\S]*?requestSequence !== performanceFeishuConnectionRequestSequence \\|\\| campaignId !== getPerformanceCampaignId\\(\\)'
      )
    );
  }
  assert.match(componentStyles, /\.tm-performance-feishu-connection-form/);
  assert.match(componentStyles, /\.tm-performance-feishu-connection-mapping/);
  assert.match(serverSource, /CAMPAIGN_PERFORMANCE_FEISHU_CONNECTION_APPROVE/);
});

test('performance dashboard exposes metadata-only review evidence with a stale-response guard', () => {
  assert.match(indexHtml, /id="performanceReviewEvidence"/);
  assert.match(indexHtml, /id="performanceReviewStatus"/);
  assert.match(indexHtml, /onclick="refreshPerformanceReviewEvidence\(\)"/);
  assert.match(indexHtml, /复盘依据/);
  assert.match(appSource, /var performanceReviewRequestSequence = 0;/);
  assert.match(appSource, /var performanceDashboardRequestSequence = 0;/);
  assert.match(appSource, /async function loadPerformanceReviewEvidence\(\)/);
  assert.match(appSource, /function renderPerformanceReviewEvidence\(/);
  assert.match(appSource, /performance\/review-evidence/);
  assert.match(appSource, /metadata_only/);
  assert.match(
    appSource,
    /requestSequence !== performanceReviewRequestSequence \|\| campaignId !== getPerformanceCampaignId\(\)/
  );
  assert.match(
    appSource,
    /async function loadPerformanceDashboard\(\)[\s\S]*?requestSequence !== performanceDashboardRequestSequence \|\| campaignId !== getPerformanceCampaignId\(\)/
  );
  assert.match(componentStyles, /\.tm-performance-review-evidence/);
  assert.match(componentStyles, /\.tm-performance-review-ranking/);
  assert.match(serverSource, /CAMPAIGN_PERFORMANCE_REVIEW_EVIDENCE/);
});

test('performance dashboard exposes an evidence-bound AI review draft with isolated stale-response protection', () => {
  assert.match(indexHtml, /id="performanceAiReviewGenerate"/);
  assert.match(indexHtml, /id="performanceAiReviewStatus"/);
  assert.match(indexHtml, /id="performanceAiReviewDraft"/);
  assert.match(indexHtml, /onclick="generatePerformanceAiReviewDraft\(\)"/);
  assert.match(indexHtml, /onchange="handlePerformanceTopMetricChange\(\)"/);
  assert.match(appSource, /var performanceAiReviewRequestSequence = 0;/);
  assert.match(appSource, /var activePerformanceAiReviewRequest = null;/);
  assert.match(appSource, /function invalidatePerformanceAiReviewDraft\(/);
  assert.match(appSource, /async function generatePerformanceAiReviewDraft\(\)/);
  assert.match(appSource, /performance\/ai-review-draft/);
  assert.match(appSource, /'Idempotency-Key': performanceAiReviewRetry\.idempotencyKey/);
  assert.match(performanceServiceSource, /allowWeb: false/);
  assert.match(performanceServiceSource, /archiveSummary: false/);
  assert.match(appSource, /performanceAiReviewIsCurrent\(context\)/);
  assert.match(appSource, /不读取视频素材、不联网、不自动沉淀知识库/);
  assert.match(componentStyles, /\.tm-performance-ai-review/);
  assert.match(componentStyles, /\.tm-performance-ai-review-references/);
  assert.match(serverSource, /CAMPAIGN_PERFORMANCE_AI_REVIEW_DRAFT/);
});
