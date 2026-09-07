# v0.8.11 Performance Observation History Plan / 单视频指标历史计划

> **Cadence / 节奏:** One independently useful feature, affected-scope tests only, independent review, verified backup, immediate production deployment, and online smoke.

## Scope / 范围

Expose the immutable metric observations already stored for one monitored video as a compact, paginated history inside the existing data-entry dialog. Each snapshot keeps its original timestamp and source, recalculates core interaction rate from that snapshot only, and shows deltas only when the same metric exists in both adjacent snapshots.

## Steps / 步骤

1. Add failing focused service, route, and frontend contract tests for stable history order, bounded cursor pagination, snapshot-local KPI calculation, comparable-only deltas, rollback labeling, campaign isolation, and correction-note redaction.
2. Add a read-only `getObservationHistory` operation to the existing performance service without changing schema, current-dashboard semantics, AI review inputs, or report generation.
3. Add `GET /api/campaigns/:id/performance/contents/:contentId/observations` and reuse existing campaign read authorization.
4. Extend the current `录入内容数据` dialog with a collapsed `历史快照` section, isolated loading/pagination state, compact metric rows, and clear empty/error states.
5. Run the affected service, route, frontend, request-policy/release-contract tests, JavaScript syntax, focused credential scan, and `git diff --check`.
6. Obtain one independent code/security review and fix every blocking finding.
7. Create a verified production backup, deploy immediately, and check public health, login/auth, protected history route behavior, PM2/Nginx, remote syntax, database integrity, and unchanged frozen PPT hash.
8. Update CHANGELOG, version records, Obsidian, GitHub, and the visible progress board.

## Contract / 合同

- History is ordered by `observed_at DESC, id DESC`; insertion time never changes business order.
- The opaque cursor carries the last returned business timestamp and identifier; page size is 1-50 and defaults to 20.
- Returned public metrics are `views`, `impressions`, `likes`, `comments`, `saves`, `shares`, `clicks`, `conversions`, and snapshot-local `core_view_er`.
- A delta is available only when both adjacent snapshots contain the same valid metric. Missing values remain missing and are never inherited, interpolated, or converted to zero.
- A negative cumulative-count delta is labeled `data_rollback_or_correction`; the platform does not claim it represents worse performance.
- Correction notes remain visible only to the same privileged roles that can currently view commercial data.

## Exclusions / 排除

- No project-wide aggregate trend chart, historical ROI/ROAS, or commercial-input history in this slice.
- No TikTok/Instagram/YouTube provider, scheduler, Feishu read/write, or external credential work.
- No media, transcript, hook, style, scene, or causal analysis.
- No schema migration, new page, AI-review input change, customer report change, or PPT/HTML mutation.

## Release Gate / 发布门禁

This is a normal read-only feature slice. Cross-campaign disclosure, hidden correction-note leakage, unstable pagination, false deltas, secret exposure, broken existing performance/report contracts, failed backup, failed production health/core smoke, or an unresolved Important/Critical review finding blocks deployment.
