# v0.8.10 Customer Report HTML Export Plan / 客户复盘 HTML 导出计划

> **Cadence / 节奏:** One independently useful feature, affected-scope tests only, independent review, verified backup, immediate production deployment, and online smoke.

## Scope / 范围

Deliver a downloadable, deterministic, customer-safe HTML document from each immutable customer report snapshot without changing the current screen layout, database schema, or either PPT generation path.

## Steps / 步骤

1. Add failing focused tests for deterministic safe HTML rendering, escaping, owner/admin authorization inheritance, audit logging, strict empty-object request handling, request policy registration, and the existing-screen button/download contract.
2. Extend `customer_report_delivery_service.js` with a fixed seven-section HTML renderer and an `exportHtml` operation that reuses the snapshot delivery boundary.
3. Add the protected POST route and request policy, wire the policy into server startup, and return the service body with restrictive response headers.
4. Add the compact `客户版 HTML` action and isolated busy/stale-response handling to the existing sealed snapshot list.
5. Run only the affected service/route/frontend/request-boundary contract matrix plus JavaScript syntax, focused credential scan, and `git diff --check`.
6. Obtain an independent code/security review and fix blocking findings.
7. Create a verified production backup, deploy immediately, and check public health, dashboard availability, anonymous `401`, PM2/Nginx, remote syntax, database integrity, and unchanged frozen PPT hash.
8. Update CHANGELOG, version records, Obsidian, GitHub, and the visible progress board.

## Exclusions / 排除

- No Feishu/provider/scheduler work because production entry prerequisites are absent.
- No schema migration or retained HTML artifact table.
- No redesign, new page, new card hierarchy, external asset, or browser-only preview.
- No change to proposal PPT or customer report PPT generation/storage.

## Release Gate / 发布门禁

This slice uses the lightweight normal-feature gate. Any authorization regression, executable/unescaped content, secret exposure, broken PPT regression, failed backup, failed production health/core smoke, or unresolved Important/Critical review finding blocks deployment.
