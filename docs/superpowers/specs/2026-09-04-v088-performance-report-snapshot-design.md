# v0.8.8 Customer-Safe Performance Report Snapshot Design / 客户版效果复盘快照设计

## Decision / 决策

This is the next independently deployable Phase 7B.3 slice already approved in the bilingual TuringMarket roadmap. It adds a visible, campaign-local **customer report preview** and an immutable **customer-safe report snapshot** created from a human-confirmed performance review and current verified campaign evidence. The service applies a strict allowlist and redaction policy before persistence; it never stores a privileged internal report and hides it later.

本切片是已批准双语路线图中 Phase 7B.3 的下一项独立上线能力：基于人工确认的效果复盘与当前已核验的项目证据，在现有效果看板中提供可见的**客户版复盘预览**，并可封存为不可变的**客户安全版复盘快照**。服务端在写入前执行严格白名单和脱敏策略；不会先保存包含内部信息的报告再在读取时隐藏。

The feature is not external delivery, PPT generation, media-analysis, web-search, provider polling, Feishu writing, or a scheduler slice. Those remain separately deployable follow-ons.

本功能不包含对外发送、PPT 生成、视频内容分析、联网搜索、外部数据服务商轮询、飞书写入或定时任务；这些能力保持为后续可独立上线的功能切片。

## Goals / 目标

- Freeze a deterministic customer-safe report dataset, its approved-review lineage, selected KPI, and evidence snapshot identity at one point in time.
- Show a compact customer-report preview in the existing Performance Dashboard before an authorized user seals it.
- Present seven customer-facing modules: project overview, data summary, eligible comparisons, key indicators, excellent cases, data limits and risks, and editable optimization / next-cycle actions.
- Preserve the user's requested review structure while making unavailable or withheld metrics explicit rather than fabricating data: current v1 includes observed content metrics and engagement rate; financial/commercial metrics such as CPM, CPC, ROI and ROAS are marked as not included until an approved commercial-scope slice exists.
- Prevent later metric refreshes, internal AI edits, campaign changes, or UI changes from mutating an existing sealed report snapshot.
- Keep report access campaign-scoped. Only a campaign owner or organization administrator with write access can seal a snapshot.

## Explicit Non-Goals / 明确不在范围内

- No report/PPT download, customer delivery, recipient email, external artifact storage, or external sharing link.
- No media, transcript, hook, style, causal, or scene-level analysis. The report explicitly discloses that this release is metadata-only.
- No DeepSeek invocation, web search, provider polling, Feishu read/write, scheduler, or real business-data mutation during production smoke.
- No organization-wide methodology promotion or change to the v0.8.7 confirmed campaign knowledge entry.
- No hidden financial values, raw video URLs, provider metadata, internal diagnostic fields, non-customer identifiers, unconfirmed AI reasoning, or knowledge-base content in the customer-safe snapshot.

## Customer-Safe Report Contract / 客户安全版报告合同

The versioned contract is `customer_safe_v1`, with recipient profile `customer`, redaction policy `customer-safe-v1`, and a fixed seven-section order:

1. `project_overview`: campaign name, platform mix, publish / observation window, content count, and data-coverage disclosure.
2. `data_summary`: allowlisted totals for views, likes, comments, favorites, shares, interactions, and engagement rate when observed.
3. `eligible_comparisons`: only aggregate platform/product/creator-tier comparisons that meet the existing 80% coverage threshold; otherwise state the reason no comparison is shown.
4. `key_indicators`: the selected metric and its definition; commercial KPI slots are explicit `withheld_pending_approved_scope` values in this release.
5. `excellent_cases`: only eligible top-content evidence with a generic report reference and performance value; no raw link, provider handle, internal content id, or unsupported causal claim.
6. `data_limits_and_risks`: observation freshness, coverage, source mode, and the existing evidence limitations in customer-safe language.
7. `optimization_and_next_cycle`: at most five bounded, operator-supplied action items and one bounded next-cycle plan. They are stored only after server-side validation rejects URLs, emails, phone numbers, financial figures/currency, confidential labels, and unsupported fields.

The canonical report JSON includes the contract and redaction versions, report title, selected metric, report sections, source-review content hash, source-review evidence hash, current-evidence hash, quality disclosure, actor, and timestamp. All metric values and the title come from server data or bounded server-validated input; browser-supplied evidence, hashes, content labels, and calculated metrics are ignored.

## Data Model / 数据模型

Add schema migration `v13` with one append-only STRICT table `customer_report_snapshots`:

- Identity and custody: `id`, `org_id`, `campaign_id`, `created_by`, `source_knowledge_entry_id`.
- Immutable lineage: `report_contract_version`, `redaction_policy_version`, `selected_metric`, `source_review_content_sha256`, `source_review_snapshot_hash`, `current_evidence_snapshot_hash`, `request_fingerprint`, `report_sha256`, and canonical pre-redacted `report_json`.
- Lifecycle: `created_at` only. Database triggers reject update and delete. A unique `(org_id, campaign_id, request_fingerprint)` supports exact replay; the same idempotency request returns its original snapshot, while a duplicate-with-different request returns a stable conflict rather than silently replacing history.
- Composite campaign and organization-membership foreign keys, plus the source knowledge foreign key, preserve campaign custody and actor lineage.

There is no column for an unredacted report, delivery target, recipient address, or external provider record.

## Evidence, Freshness, And Approval / 证据、新鲜度与封存权限

Preview and seal resolve the campaign-local `performance_ai_review_confirmation` knowledge entry, validate the source metadata and final content hash, then build the current review-evidence projection using the same canonical projection/hash routine used by v0.8.7. Seal requires the current evidence hash to equal the confirmed review evidence hash. If metrics changed, sealing returns a stable stale-evidence result; the owner must regenerate and confirm a current review.

Preview is calculated server-side and is never treated as a persisted artifact. Seal accepts only a bounded title, action items, and next-cycle plan. It reruns the redaction and evidence checks immediately before inserting the immutable row.

Campaign readers may retrieve only the already pre-redacted snapshot. Campaign owners and organization administrators with write permission may preview and seal. A caller without the required write capability cannot seal, even if they can view the campaign dashboard.

## API And Access / 接口与权限

- `POST /api/campaigns/:id/performance/customer-report-preview`: returns a non-persisted `customer_safe_v1` preview from the current confirmed review and evidence.
- `POST /api/campaigns/:id/performance/customer-report-snapshots`: seals or exactly replays one snapshot.
- `GET /api/campaigns/:id/performance/customer-report-snapshots`: lists compact customer-safe snapshot lineage for eligible campaign users.
- `GET /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId`: returns one immutable customer-safe snapshot.

All endpoints require frozen JSON contracts, campaign authorization, request identifiers, campaign-identity guards, and idempotency for sealing. Cross-campaign knowledge IDs, stale evidence, invalid hashes, unapproved source review, unsafe operator text, unsupported fields, missing source review, and duplicate-but-different requests are rejected with stable report-specific errors.

## UI / 界面

Add one compact `客户复盘` section below the existing AI-review confirmation area in the existing Performance Dashboard. It contains:

- a customer-safe preview command for authorized users;
- a clear data-range and commercial-metric disclosure;
- seven stacked, responsive report sections with no nested cards or horizontal overflow;
- editable action items and next-cycle plan only for users who can seal;
- a single confirm-and-seal command with busy, stale-data, permission, and exact-replay states;
- a compact immutable snapshot list and selected read-only snapshot panel.

Existing dashboard, evidence, and AI-review controls retain their campaign-identity and stale-response protections. A campaign switch, metric change, or data refresh invalidates the unsealed preview but never alters a sealed snapshot. The frozen PPT path remains unchanged.

## Verification And Release / 验证与发布

The project-wide cadence remains lightweight: a normal independently usable feature is released in the same cycle after affected-scope checks, one independent review, a verified backup, and online smoke. This particular slice is a risk-trigger exception because it adds a migration, immutable customer-visible data, and an authorization boundary. Its checks stay focused on those risks:

1. RED/GREEN service, route, frontend-contract, migration, access and source-trust tests for the above boundaries.
2. Focused migration/replay and release-contract checks, syntax, diff, and targeted secret scan.
3. One independent code review covering pre-persistence redaction, schema immutability, customer/report custody, source-review lineage, stale-evidence rejection, commercial boundary, idempotency/conflict behavior, UI staleness, and frozen PPT preservation.
4. Verified backup, guarded production deployment, public/loopback health, PM2/Nginx, authenticated read-only snapshot-route smoke without creating production business data, then same-cycle CHANGELOG, version record, Obsidian, progress board, and GitHub synchronization.

## Deferred Follow-On / 后续拆分

The next slices may add approved financial-metric scope, customer delivery approval/audit, frozen-PPT report output, Feishu delivery, media-content analysis, and safe methodology promotion. They must create new immutable artifacts or explicit versioned derivatives and must not modify a v0.8.8 customer-safe snapshot.
