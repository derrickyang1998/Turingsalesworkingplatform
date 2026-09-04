# Customer-Safe Performance Report Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a customer-report preview and immutable customer-safe report snapshot to the existing performance dashboard, then release it in the same development cycle.

**Architecture:** A dedicated snapshot service derives customer_safe_v1 reports from the human-confirmed performance review and the canonical current evidence hash. It persists only pre-redacted JSON and exposes campaign-scoped preview, seal, list, and detail operations. The existing performance module retains its stale-response, campaign-identity, idempotency, and frozen-PPT conventions.

**Tech Stack:** Node.js, Express, SQLite STRICT tables and triggers, vanilla JavaScript, existing TuringMarket CSS tokens, Node built-in test runner, PowerShell deployment guard.

**Spec:** docs/superpowers/specs/2026-09-04-v088-performance-report-snapshot-design.md

## Global Constraints

- Persist only pre-redacted customer-safe JSON. Do not add an unredacted report, recipient, delivery, URL, provider, diagnostic, knowledge-content, or financial-value column.
- The exact persisted contract is customer_safe_v1 and redaction policy is customer-safe-v1.
- v1 exposes observed content totals and engagement rate only. CPM, CPC, ROI, ROAS, cost, revenue, and other commercial values must be represented as withheld_pending_approved_scope.
- The service, not the browser, resolves the latest campaign-local performance_ai_review_confirmation source.
- Campaign owner or organization administrator with write access may preview and seal. Campaign readers may retrieve only a sealed pre-redacted snapshot.
- Keep existing AI-review confirmation, PPT, Feishu, provider, scheduler, and media-analysis behavior unchanged.
- Follow the approved accelerated cadence: affected-scope checks, one independent review, verified backup, same-cycle deployment, and online smoke. Migration and authorization gates remain mandatory for this slice.

---

### Task 1: Add the v13 Immutable Snapshot Schema

**Files:**
- Create: platform/server/migrations/013_customer_report_snapshot.js
- Create: platform/server/tests/customer_report_snapshot_migration.test.js
- Modify: platform/server/db.js
- Modify: platform/deploy_v8.ps1
- Modify: platform/server/tests/release_v060_contract.test.js
- Modify: platform/server/tests/deployment_source_contract.test.js

**Interfaces:**
- Produces migration { version: 13, name: '013_customer_report_snapshot', sourcePath: 'migrations/013_customer_report_snapshot.js', engineVersion: 1, dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'], apply(db) }.
- Produces one STRICT table customer_report_snapshots with these columns, in order: id, org_id, campaign_id, created_by, source_knowledge_entry_id, report_contract_version, redaction_policy_version, selected_metric, source_review_content_sha256, source_review_snapshot_hash, current_evidence_snapshot_hash, request_fingerprint, report_sha256, report_json, created_at.

- [ ] **Step 1: Write the failing migration test**

~~~js
test('migration 013 creates an immutable customer-safe report snapshot table', () => {
  applyMigration13(db);
  assert.equal(db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE name='customer_report_snapshots'").get().present, 1);
  assert.throws(() => db.prepare("UPDATE customer_report_snapshots SET selected_metric='views'").run());
  assert.throws(() => db.prepare('DELETE FROM customer_report_snapshots').run());
});
~~~

- [ ] **Step 2: Run the test to verify RED**

Run: node --test --test-concurrency=1 server/tests/customer_report_snapshot_migration.test.js

Expected: FAIL because migration 013 and customer_report_snapshots do not exist.

- [ ] **Step 3: Implement the migration and release registration**

~~~js
CREATE TABLE customer_report_snapshots (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  source_knowledge_entry_id INTEGER NOT NULL,
  report_contract_version TEXT NOT NULL CHECK(report_contract_version='customer_safe_v1'),
  redaction_policy_version TEXT NOT NULL CHECK(redaction_policy_version='customer-safe-v1'),
  selected_metric TEXT NOT NULL,
  source_review_content_sha256 TEXT NOT NULL CHECK(length(source_review_content_sha256)=64),
  source_review_snapshot_hash TEXT NOT NULL CHECK(length(source_review_snapshot_hash)=64),
  current_evidence_snapshot_hash TEXT NOT NULL CHECK(length(current_evidence_snapshot_hash)=64),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
  report_sha256 TEXT NOT NULL CHECK(length(report_sha256)=64),
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,campaign_id,request_fingerprint)
) STRICT
~~~

Add composite campaign/membership and knowledge foreign keys, a campaign-created index, no-update/no-delete triggers, a schema manifest, db.js registration, deploy_v8.ps1 trusted source entry, and exact 013 expectations in release tests.

- [ ] **Step 4: Run migration and release checks to verify GREEN**

Run: node --test --test-concurrency=1 server/tests/customer_report_snapshot_migration.test.js server/tests/release_v060_contract.test.js server/tests/deployment_source_contract.test.js

Expected: PASS; a v12 candidate upgrades to v13, schema objects match the manifest, and trusted deployment source includes migration 013.

- [ ] **Step 5: Commit**

~~~bash
git add platform/server/migrations/013_customer_report_snapshot.js platform/server/tests/customer_report_snapshot_migration.test.js platform/server/db.js platform/deploy_v8.ps1 platform/server/tests/release_v060_contract.test.js platform/server/tests/deployment_source_contract.test.js
git commit -m "feat(performance): add customer report snapshot schema"
~~~

### Task 2: Build the Customer-Safe Service

**Files:**
- Create: platform/server/services/customer_report_snapshot_service.js
- Create: platform/server/tests/customer_report_snapshot_service.test.js
- Modify: platform/server/services/performance_manual_service.js

**Interfaces:**
- Consumes getCampaignAccess(db, { userId, campaignId }), performanceService.getReviewEvidence({ userId, campaignId, query: { top_metric } }), and a new buildPerformanceReviewEvidenceSnapshot(evidence) export.
- Produces CustomerReportSnapshotServiceError and createCustomerReportSnapshotService(db, { performanceService, getCampaignAccess }).
- Produces methods:
  - preview({ user, campaignId, body: { top_metric, title, optimization_actions, next_cycle_plan } })
  - seal({ user, campaignId, body: { top_metric, title, optimization_actions, next_cycle_plan, expected_evidence_snapshot_hash }, idempotencyKey, requestId })
  - list({ userId, campaignId })
  - get({ userId, campaignId, snapshotId })

- [ ] **Step 1: Write failing service tests**

~~~js
test('creates a pre-redacted customer-safe preview', () => {
  const preview = snapshots.preview({
    user: owner, campaignId: campaign.id,
    body: { top_metric: 'views', title: 'September review', optimization_actions: [], next_cycle_plan: '' }
  });
  assert.equal(preview.contract_version, 'customer_safe_v1');
  assert.equal(preview.redaction_policy_version, 'customer-safe-v1');
  assert.equal(preview.sections.key_indicators.commercial.status, 'withheld_pending_approved_scope');
  assert.equal(JSON.stringify(preview).includes('https://'), false);
  assert.equal(JSON.stringify(preview).includes('attributed_revenue'), false);
});

test('rejects stale evidence before seal', () => {
  assert.throws(() => snapshots.seal(staleSealInput), (error) => error.code === 'CUSTOMER_REPORT_STALE_EVIDENCE');
});

test('replays one seal idempotently', () => {
  const first = snapshots.seal(sealInput);
  const replay = snapshots.seal(sealInput);
  assert.equal(first.snapshot.id, replay.snapshot.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_report_snapshots').get().count, 1);
});
~~~

- [ ] **Step 2: Run the service test to verify RED**

Run: node --test --test-concurrency=1 server/tests/customer_report_snapshot_service.test.js

Expected: FAIL because the snapshot service and canonical evidence helper do not exist.

- [ ] **Step 3: Export the one canonical evidence snapshot helper**

~~~js
function buildPerformanceReviewEvidenceSnapshot(evidence) {
  const references = aiReviewEvidenceReferences(evidence);
  const projection = aiReviewEvidenceProjection(evidence, references);
  return Object.freeze({ references, projection, snapshotHash: aiReviewSnapshotHash(projection) });
}
~~~

Replace repeated AI-review projection/hash construction with the helper and export it without changing AI-review result contracts.

- [ ] **Step 4: Implement the service**

Use crypto SHA-256 over canonical JSON for request_fingerprint and report_sha256. Resolve the source server-side from active campaign-custodied knowledge_entries with source_type performance_ai_review_confirmation. Require owner/org_admin plus write for preview/seal and read for list/detail. Repeat evidence/source hash equality inside the immediate transaction.

Build only these seven allowlisted sections: project_overview, data_summary, eligible_comparisons, key_indicators, excellent_cases, data_limits_and_risks, optimization_and_next_cycle. Map case labels to case-1 through case-5. Reject URLs, emails, phone patterns, currency/amounts, financial KPI words, control characters, and confidential labels in title/actions/plan. Accept title up to 120 characters, at most five actions of 400 characters, and one 800-character plan.

- [ ] **Step 5: Run focused service checks to verify GREEN**

Run: node --test --test-concurrency=1 server/tests/customer_report_snapshot_service.test.js server/tests/performance_manual_service.test.js

Expected: PASS; preview and stored JSON are pre-redacted, access and stale/replay/conflict paths are enforced, and v0.8.7 AI review remains green.

- [ ] **Step 6: Commit**

~~~bash
git add platform/server/services/customer_report_snapshot_service.js platform/server/tests/customer_report_snapshot_service.test.js platform/server/services/performance_manual_service.js platform/server/tests/performance_manual_service.test.js
git commit -m "feat(performance): build customer-safe report snapshots"
~~~

### Task 3: Expose Protected APIs

**Files:**
- Modify: platform/server/contracts/campaign_contract.js
- Modify: platform/server/server.js
- Modify: platform/server/routes_performance.js
- Modify: platform/server/tests/routes_performance.test.js

**Interfaces:**
- Produces policies and routes:
  - CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_PREVIEW: POST /api/campaigns/:id/performance/customer-report-preview
  - CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_SNAPSHOT_CREATE: POST /api/campaigns/:id/performance/customer-report-snapshots
  - CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_SNAPSHOT_LIST: GET /api/campaigns/:id/performance/customer-report-snapshots
  - CAMPAIGN_PERFORMANCE_CUSTOMER_REPORT_SNAPSHOT_DETAIL: GET /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId

- [ ] **Step 1: Write failing route tests**

~~~js
test('routes customer report preview and snapshot operations through protected contracts', async () => {
  const response = await invokeAsync(routes.get('POST /api/campaigns/:id/performance/customer-report-snapshots'), request);
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0][0], 'customer-report-seal');
  assert.equal(calls[0][1].idempotencyKey, 'customer-report-key');
});
~~~

- [ ] **Step 2: Run the route test to verify RED**

Run: node --test --test-concurrency=1 server/tests/routes_performance.test.js

Expected: FAIL because the four policy names and routes are absent.

- [ ] **Step 3: Implement the policy registration and routes**

Create the service in server.js with the existing performanceManualService, pass it to registerPerformanceRoutes, add all four policy names to phase4PolicyNames, and add CustomerReportSnapshotServiceError to known route errors.

~~~js
app.post('/api/campaigns/:id/performance/customer-report-preview', options.authMiddleware, (request, response) => {
  try {
    return sendResult(request, response, customerReportSnapshotService.preview({
      user: request.user, campaignId: request.params.id, body: request.body
    }));
  } catch (error) { return sendError(request, response, error); }
});
~~~

Add seal/list/detail equivalents. Pass Idempotency-Key and request id only to seal.

- [ ] **Step 4: Run route checks to verify GREEN**

Run: node --test --test-concurrency=1 server/tests/routes_performance.test.js

Expected: PASS; all four endpoints are authenticated, policy-registered, campaign scoped, and preserve stable request ids/errors.

- [ ] **Step 5: Commit**

~~~bash
git add platform/server/contracts/campaign_contract.js platform/server/server.js platform/server/routes_performance.js platform/server/tests/routes_performance.test.js
git commit -m "feat(performance): expose customer report snapshot APIs"
~~~

### Task 4: Add the Existing-Dashboard Interaction

**Files:**
- Modify: platform/index.html
- Modify: platform/app.js
- Modify: platform/client/styles/components.css
- Modify: platform/server/tests/performance_frontend_contract.test.js

**Interfaces:**
- Produces loadPerformanceCustomerReportSnapshots, generatePerformanceCustomerReportPreview, sealPerformanceCustomerReportSnapshot, invalidatePerformanceCustomerReportPreview, renderPerformanceCustomerReportPreview, and renderPerformanceCustomerReportSnapshots.

- [ ] **Step 1: Write failing UI contract coverage**

~~~js
test('performance dashboard exposes customer-safe preview and immutable snapshots', () => {
  assert.match(indexHtml, /id="performanceCustomerReportPreview"/);
  assert.match(indexHtml, /onclick="generatePerformanceCustomerReportPreview\(\)"/);
  assert.match(appSource, /function invalidatePerformanceCustomerReportPreview\(/);
  assert.match(appSource, /customer-report-preview/);
  assert.match(appSource, /customer-report-snapshots/);
  assert.match(componentStyles, /\.tm-performance-customer-report/);
});
~~~

- [ ] **Step 2: Run the UI contract test to verify RED**

Run: node --test --test-concurrency=1 server/tests/performance_frontend_contract.test.js

Expected: FAIL because customer report controls, stale sequencing, and styles are absent.

- [ ] **Step 3: Implement the compact UI**

Add one 客户复盘 subsection below the AI-review confirmation. Include preview, commercial-scope disclosure, seven responsive sections, action/next-plan inputs, a seal button, busy/stale/permission states, snapshot list, and read-only snapshot detail. Use existing tm-performance styles and no new page or nested card.

Increment a dedicated request sequence and abort its controller on campaign switch, top-metric change, review-evidence refresh, and data mutation. Invalidate only unsealed previews; retain sealed snapshots. Use server-returned data, esc, and renderSafeMarkdown; do not calculate or redact customer data in the browser.

- [ ] **Step 4: Run the UI contract test to verify GREEN**

Run: node --test --test-concurrency=1 server/tests/performance_frontend_contract.test.js

Expected: PASS; the dashboard is campaign-scoped, stale-safe, seal-idempotent, compact, and leaves AI review/PPT controls intact.

- [ ] **Step 5: Commit**

~~~bash
git add platform/index.html platform/app.js platform/client/styles/components.css platform/server/tests/performance_frontend_contract.test.js
git commit -m "feat(performance): add customer report dashboard flow"
~~~

### Task 5: Independent Review and Same-Cycle Production Release

**Files:**
- Modify: CHANGELOG.md
- Create: docs/version-records/2026-09-04-v0.8.8-customer-report-snapshot-production.md
- Create: archive/versions/2026-09-04-v0.8.8-customer-report-snapshot-production.md
- Create: D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\2026-09-04-v0.8.8-customer-report-snapshot-production.md
- Modify: C:\Users\29272\Documents\在线商务平台\TuringMarket-开发进度.html

**Interfaces:**
- Produces a committed, pushed, backed-up, deployed, and remotely accepted v0.8.8 release.

- [ ] **Step 1: Run focused checks**

~~~powershell
node --test --test-concurrency=1 server/tests/customer_report_snapshot_migration.test.js server/tests/customer_report_snapshot_service.test.js server/tests/performance_manual_service.test.js server/tests/routes_performance.test.js server/tests/performance_frontend_contract.test.js server/tests/release_v060_contract.test.js server/tests/deployment_source_contract.test.js
node -c server/server.js
node -c server/routes_performance.js
node -c server/services/customer_report_snapshot_service.js
node -c app.js
git diff --check
.\deploy_v8.ps1 -ValidateLocalOnly
~~~

Expected: all focused tests, syntax, diff, secret scan, and preflight checks pass.

- [ ] **Step 2: Request an independent review**

The reviewer must verify pre-persistence allowlist redaction, schema immutability, campaign custody, owner/admin seal rights, source/evidence lineage, stale/replay/conflict handling, absence of commercial values, UI staleness, unchanged PPT/Feishu/provider behavior, and migration 013 release registration.

- [ ] **Step 3: Back up and deploy**

Run the guarded deployment script, retain the generated backup path, and verify SHA256SUMS inside that backup directory. Do not create real campaign, content, financial, AI, provider, Feishu, or customer-report records during production acceptance.

- [ ] **Step 4: Run online acceptance**

Verify public /api/health, /performance-dashboard, PM2, Nginx, deployed hashes, SQLite quick_check, zero foreign-key violations, schema version 13, and unauthenticated customer-report route returns 401. If an authenticated non-mutating session exists, call only the snapshot list route; otherwise explicitly record authenticated acceptance as pending.

- [ ] **Step 5: Update release records and push**

Record actual test counts, reviewer verdict, backup manifest hash, production evidence, non-goals, and any pending acceptance in changelog, version record, archive record, Obsidian, and progress dashboard. Push all v0.8.8 commits to origin/codex/v0.7.0-ai-knowledge-proposal-ppt-loop-production.

~~~bash
git add CHANGELOG.md docs/version-records archive/versions
git commit -m "docs(release): record v0.8.8 customer report snapshot deployment"
git push origin codex/v0.7.0-ai-knowledge-proposal-ppt-loop-production
~~~

## Plan Self-Review

- Spec coverage: Tasks 1-4 implement the customer-safe contract, seven sections, source lineage, stale evidence, immutable storage, access, UI behavior, and frozen-PPT boundary. Task 5 implements the risk-trigger release gates and all required sync targets.
- Placeholder scan: no unfinished-marker phrases or vague test directives remain. Every task has named files, expected interfaces, RED/GREEN commands, and a commit command.
- Type consistency: buildPerformanceReviewEvidenceSnapshot, createCustomerReportSnapshotService, preview, seal, list, get, policy names, endpoint paths, customer_safe_v1, and customer-safe-v1 use the same spelling throughout.
