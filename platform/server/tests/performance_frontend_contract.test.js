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

test('manual data entry submits commercial drafts for distinct approval while retaining KPI rendering', () => {
  assert.match(appSource, /performanceCapabilities && performanceCapabilities\.can_edit_commercial/);
  assert.match(appSource, /performanceImpressions', '展示量'/);
  assert.doesNotMatch(appSource, /id="performanceConfirmed"/);
  assert.doesNotMatch(appSource, /confirmed: confirmed/);
  assert.match(appSource, /performance\/contents\/' \+ encodeURIComponent\(contentId\) \+ '\/manual-inputs/);
  assert.match(appSource, /function performanceCommercialApprovalHtml\(content\)/);
  assert.match(appSource, /function performanceCommercialStateHtml\(content, canViewCommercial\)/);
  assert.match(appSource, /if \(!canViewCommercial\) return '<span class="tm-performance-approval-state">受限<\/span>'/);
  assert.match(appSource, /function approvePerformanceCommercialInput\(contentId, inputId\)/);
  assert.match(appSource, /performance\/manual-inputs\/' \+ encodeURIComponent\(inputId\) \+ '\/approve'/);
  assert.match(appSource, /需另一位负责人或组织管理员复核/);
  assert.match(appSource, /上一已批准版本继续用于 KPI/);
  assert.match(appSource, /performanceRate\(metrics\.core_view_er\)/);
  assert.match(appSource, /performanceMoney\(metrics\.cpm\)/);
  assert.match(appSource, /performanceMoney\(metrics\.cpc\)/);
  assert.match(appSource, /performanceRate\(metrics\.roi\)/);
  assert.match(appSource, /performanceRatio\(metrics\.roas\)/);
});

test('manual data entry exposes a compact paginated observation history without changing the dashboard snapshot contract', () => {
  for (const id of [
    'performanceObservationHistoryPanel',
    'performanceObservationHistory',
    'performanceObservationHistoryMore'
  ]) {
    assert.match(appSource, new RegExp(id));
  }
  assert.match(appSource, /var performanceObservationHistoryRequestSequence = 0;/);
  assert.match(appSource, /var activePerformanceObservationHistoryRequest = null;/);
  assert.match(appSource, /function renderPerformanceObservationHistory\(/);
  assert.match(appSource, /async function loadPerformanceObservationHistory\(/);
  assert.match(
    appSource,
    /performance\/contents\/' \+ encodeURIComponent\(normalizedContentId\) \+ '\/observations'/
  );
  assert.match(appSource, /performanceObservationHistoryIsCurrent\(context\)/);
  assert.match(appSource, /data_rollback_or_correction/);
  assert.match(appSource, /不可比/);
  assert.match(
    appSource,
    /function closePerformanceInputModal\(\)[\s\S]*?activePerformanceObservationHistoryRequest\.controller\.abort\(\)/
  );
  assert.match(componentStyles, /\.tm-performance-observation-history/);
  assert.match(componentStyles, /\.tm-performance-observation-table-wrap[\s\S]*?overflow: auto/);
  assert.match(componentStyles, /\.tm-performance-observation-table th[\s\S]*?position: sticky/);
});

test('performance tables retain compact, sticky operational controls', () => {
  assert.match(componentStyles, /\.tm-performance-table-container[\s\S]*?overflow-y: auto/);
  assert.match(componentStyles, /\.tm-performance-table th:first-child[\s\S]*?position: sticky/);
  assert.match(componentStyles, /\.tm-performance-commercial-approval[\s\S]*?align-items: center/);
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

test('performance monitor shows a campaign-scoped freshness queue and controlled YouTube refresh', () => {
  assert.match(indexHtml, /id="performanceFreshnessQueue"/);
  assert.match(indexHtml, /id="performanceFreshnessSummary"/);
  assert.match(indexHtml, /id="performanceProviderRefresh"[^>]+onclick="runPerformanceProviderRefresh\(\)"[^>]+disabled/);
  assert.match(indexHtml, /数据新鲜度与待更新清单/);
  assert.match(appSource, /var performanceFreshnessRequestSequence = 0;/);
  assert.match(appSource, /async function loadPerformanceFreshnessQueue\(\)/);
  assert.match(appSource, /function renderPerformanceFreshnessQueue\(/);
  assert.match(appSource, /function openPerformanceFreshnessInput\(/);
  assert.match(appSource, /performance\/freshness-queue/);
  assert.match(appSource, /provider\.dispatch_available/);
  assert.match(appSource, /YouTube 自动采集尚未配置/);
  assert.match(appSource, /async function runPerformanceProviderRefresh\(\)/);
  assert.match(appSource, /performance\/provider-refresh/);
  assert.match(appSource, /'Idempotency-Key': performanceProviderRefreshRetry\.idempotencyKey/);
  assert.match(appSource, /body: JSON\.stringify\(\{\}\)/);
  assert.match(appSource, /requestSequence !== performanceProviderRefreshRequestSequence \|\| campaignId !== getPerformanceCampaignId\(\)/);
  assert.match(appSource, /openPerformanceFreshnessInput\(/);
  assert.match(appSource, /performanceContents\.push\(item\.content\)/);
  assert.match(
    appSource,
    /requestSequence !== performanceFreshnessRequestSequence \|\| campaignId !== getPerformanceCampaignId\(\)/
  );
  assert.match(
    appSource,
    /function changePerformanceCampaignContext\(value\) \{[\s\S]*?performanceFreshnessRequestSequence \+= 1;[\s\S]*?performanceCampaignContextId = performancePositiveId\(value\);/
  );
  assert.match(componentStyles, /\.tm-performance-freshness/);
  assert.match(componentStyles, /\.tm-performance-freshness-row/);
  assert.match(serverSource, /CAMPAIGN_PERFORMANCE_FRESHNESS_QUEUE/);
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

test('an approved Feishu mapping can export the current observed snapshot from the existing connection panel', () => {
  assert.match(appSource, /function downloadPerformanceFeishuSnapshot\(\)/);
  assert.match(appSource, /function invalidatePerformanceFeishuSnapshotExport\(\)/);
  assert.match(appSource, /function performanceFeishuSnapshotExportIsCurrent\(context\)/);
  assert.match(appSource, /performance\/feishu-projection-preview\/export/);
  assert.match(appSource, /data-performance-feishu-action="snapshot-export"/);
  assert.match(appSource, /下载当前效果快照 CSV/);
  assert.match(appSource, /未录入效果数据的视频不会被填为 0/);
  assert.match(appSource, /下载始终使用已批准版本 v/);
  assert.match(appSource, /if \(!performanceFeishuSnapshotExportIsCurrent\(context\)\) return null;/);
  assert.match(appSource, /apiFetch\([^\n]+feishu-projection-preview\/export[^\n]+signal: context\.abortController\.signal/);
  assert.match(
    appSource,
    /function changePerformanceCampaignContext\(value\) \{[\s\S]*?invalidatePerformanceFeishuSnapshotExport\(\);[\s\S]*?performanceCampaignContextId = performancePositiveId\(value\);/
  );
  assert.match(serverSource, /createPerformanceFeishuProjectionService/);
  assert.match(serverSource, /feishuProjectionService/);
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
  assert.match(appSource, /var performanceAiReviewApprovalRequestSequence = 0;/);
  assert.match(appSource, /var activePerformanceAiReviewApprovalRequest = null;/);
  assert.match(appSource, /function invalidatePerformanceAiReviewDraft\(/);
  assert.match(appSource, /async function generatePerformanceAiReviewDraft\(\)/);
  assert.match(appSource, /async function approvePerformanceAiReviewDraft\(\)/);
  assert.match(appSource, /performance\/ai-review-draft/);
  assert.match(appSource, /performance\/ai-review-draft\/approve/);
  assert.match(appSource, /'Idempotency-Key': performanceAiReviewRetry\.idempotencyKey/);
  assert.match(appSource, /'Idempotency-Key': performanceAiReviewApprovalRetry\.idempotencyKey/);
  assert.match(performanceServiceSource, /allowWeb: false/);
  assert.match(performanceServiceSource, /archiveSummary: false/);
  assert.match(appSource, /performanceAiReviewIsCurrent\(context\)/);
  assert.match(appSource, /performanceAiReviewApprovalIsCurrent\(context\)/);
  assert.match(appSource, /不读取视频素材、不联网、不自动沉淀知识库/);
  const approvalBusyStart = appSource.indexOf('function setPerformanceAiReviewApprovalBusy(busy)');
  const approvalBusyEnd = appSource.indexOf('function performanceAiReviewIsCurrent', approvalBusyStart);
  assert.ok(approvalBusyStart >= 0 && approvalBusyEnd > approvalBusyStart);
  const approvalBusySource = appSource.slice(approvalBusyStart, approvalBusyEnd);
  assert.match(approvalBusySource, /performanceAiReviewEditedDraft/);
  assert.match(approvalBusySource, /performanceAiReviewVisibility/);
  assert.match(approvalBusySource, /\.disabled = !!busy/);
  assert.match(componentStyles, /\.tm-performance-ai-review/);
  assert.match(componentStyles, /\.tm-performance-ai-review-references/);
  assert.match(serverSource, /CAMPAIGN_PERFORMANCE_AI_REVIEW_DRAFT/);
});

test('performance dashboard adds authorized content evidence analysis without changing the existing review path', () => {
  for (const id of [
    'performanceContentAnalysisContent',
    'performanceContentAnalysisAcquisitionMode',
    'performanceContentAnalysisRightsBasis',
    'performanceContentAnalysisRightsConfirmed',
    'performanceContentAnalysisTranscript',
    'performanceContentAnalysisHookNotes',
    'performanceContentAnalysisVisualNotes',
    'performanceContentAnalysisGenerate',
    'performanceContentAnalysisStatus',
    'performanceContentAnalysisDraft'
  ]) {
    assert.match(indexHtml, new RegExp('id="' + id + '"'));
  }
  assert.match(indexHtml, /onclick="generatePerformanceContentAnalysisDraft\(\)"/);
  assert.match(indexHtml, /原始文本仅用于本次分析/);
  assert.doesNotMatch(indexHtml, /approved_public_access/);
  assert.match(appSource, /var performanceContentAnalysisDraft = null;/);
  assert.match(appSource, /var performanceContentAnalysisPendingEvidence = null;/);
  assert.match(appSource, /function invalidatePerformanceContentAnalysisDraft\(/);
  assert.match(appSource, /async function generatePerformanceContentAnalysisDraft\(\)/);
  assert.match(appSource, /async function approvePerformanceContentAnalysisDraft\(\)/);
  assert.match(appSource, /performance\/content-analysis-draft/);
  assert.match(appSource, /performance\/content-analysis-draft\/approve/);
  assert.match(appSource, /'Idempotency-Key': performanceContentAnalysisRetry\.idempotencyKey/);
  assert.match(appSource, /rights_confirmed: rightsConfirmed/);
  assert.match(appSource, /evidence: performanceContentAnalysisPendingEvidence/);
  assert.match(appSource, /performanceContentAnalysisPendingEvidence = JSON\.parse\(JSON\.stringify\(body\)\)/);
  assert.match(appSource, /performanceContentAnalysisInputBody\(\)[^\n]+performanceContentAnalysisPendingEvidence/);
  assert.match(appSource, /performance_reference/);
  assert.match(appSource, /YouTube API/);
  assert.match(appSource, /function doLogout\(\)[\s\S]*?invalidatePerformanceContentAnalysisDraft\('', true\)/);
  assert.match(appSource, /function handleAuthExpired\(message\)[\s\S]*?invalidatePerformanceContentAnalysisDraft\('', true\)/);
  assert.match(appSource, /raw_storage[^\n]+not_retained/);
  assert.match(componentStyles, /\.tm-performance-content-analysis/);
  assert.match(componentStyles, /\.tm-performance-content-analysis-form/);
  assert.match(serverSource, /createPerformanceContentAnalysisService/);
  assert.match(serverSource, /CAMPAIGN_PERFORMANCE_CONTENT_ANALYSIS_DRAFT/);
  assert.match(serverSource, /CAMPAIGN_PERFORMANCE_CONTENT_ANALYSIS_APPROVE/);
});

test('performance dashboard exposes a customer-safe preview, immutable snapshot, and customer PPT delivery flow', () => {
  for (const id of [
    'performanceCustomerReportTitle',
    'performanceCustomerReportActions',
    'performanceCustomerReportNextCyclePlan',
    'performanceCustomerReportStatus',
    'performanceCustomerReportPreview',
    'performanceCustomerReportSeal',
    'performanceCustomerReportSnapshots'
  ]) {
    assert.match(indexHtml, new RegExp('id="' + id + '"'));
  }
  assert.match(indexHtml, /onclick="generatePerformanceCustomerReportPreview\(\)"/);
  assert.match(indexHtml, /onclick="sealPerformanceCustomerReportSnapshot\(\)"/);
  assert.match(appSource, /var performanceCustomerReportRequestSequence = 0;/);
  assert.match(appSource, /var activePerformanceCustomerReportRequest = null;/);
  assert.match(appSource, /var performanceCustomerReportSealRequestSequence = 0;/);
  assert.match(appSource, /var performanceCustomerReportPptDownloadGeneration = 0;/);
  assert.match(appSource, /var performanceCustomerReportHtmlDownloadGeneration = 0;/);
  assert.match(appSource, /function invalidatePerformanceCustomerReportPreview\(/);
  assert.match(
    appSource,
    /function invalidatePerformanceCustomerReportPreview\([\s\S]*?performanceCustomerReportPptDownloadGeneration \+= 1;[\s\S]*?performanceCustomerReportPptDownloads = Object\.create\(null\);/
  );
  assert.match(
    appSource,
    /function invalidatePerformanceCustomerReportPreview\([\s\S]*?performanceCustomerReportHtmlDownloadGeneration \+= 1;[\s\S]*?performanceCustomerReportHtmlDownloads = Object\.create\(null\);/
  );
  assert.match(appSource, /async function generatePerformanceCustomerReportPreview\(\)/);
  assert.match(appSource, /async function sealPerformanceCustomerReportSnapshot\(\)/);
  assert.match(appSource, /async function loadPerformanceCustomerReportSnapshots\(\)/);
  assert.match(appSource, /async function downloadPerformanceCustomerReportPpt\(snapshotId\)/);
  assert.match(appSource, /async function downloadPerformanceCustomerReportHtml\(snapshotId\)/);
  assert.match(
    appSource,
    /function performanceCustomerReportPptDownloadIsCurrent\([\s\S]*?context\.generation === performanceCustomerReportPptDownloadGeneration/
  );
  assert.match(
    appSource,
    /async function downloadPerformanceCustomerReportPpt\([\s\S]*?generation: performanceCustomerReportPptDownloadGeneration/
  );
  assert.match(
    appSource,
    /function performanceCustomerReportHtmlDownloadIsCurrent\([\s\S]*?context\.generation === performanceCustomerReportHtmlDownloadGeneration/
  );
  assert.match(
    appSource,
    /async function downloadPerformanceCustomerReportHtml\([\s\S]*?generation: performanceCustomerReportHtmlDownloadGeneration/
  );
  assert.match(appSource, /function renderPerformanceCustomerReportPreview\(/);
  assert.match(appSource, /function renderPerformanceCustomerReportSnapshots\(/);
  assert.match(appSource, /performance\/customer-report-preview/);
  assert.match(appSource, /performance\/customer-report-snapshots/);
  assert.match(appSource, /customer-report-snapshots\/.*\/ppt/);
  assert.match(appSource, /customer-report-snapshots\/.*\/html/);
  assert.match(appSource, /onclick=\\"downloadPerformanceCustomerReportPpt\(/);
  assert.match(appSource, /onclick=\\"downloadPerformanceCustomerReportHtml\(/);
  assert.match(appSource, /response\.blob\(\)/);
  assert.match(appSource, /dlFile\('customer-report-'/);
  assert.match(appSource, /expected_evidence_snapshot_hash/);
  assert.match(appSource, /'Idempotency-Key': performanceCustomerReportSealRetry\.idempotencyKey/);
  assert.match(
    appSource,
    /function invalidatePerformanceAiReviewDraft\([\s\S]*?invalidatePerformanceCustomerReportPreview\(/
  );
  assert.match(componentStyles, /\.tm-performance-customer-report/);
  assert.match(componentStyles, /\.tm-performance-customer-report-preview/);
  assert.match(componentStyles, /\.tm-performance-customer-report-snapshots/);
  assert.match(serverSource, /CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_SNAPSHOT_CREATE/);
  assert.match(serverSource, /CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_PPT_GENERATE/);
});
