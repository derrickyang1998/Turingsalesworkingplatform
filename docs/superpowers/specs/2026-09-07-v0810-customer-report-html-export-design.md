# v0.8.10 Customer Report HTML Export Design / 客户复盘 HTML 导出设计

## Decision / 决策

Add one compact `客户版 HTML` download beside the existing sealed-report PPT action. The export is generated only from the immutable `customer_safe_v1` snapshot and does not read current campaign data.

在现有效果看板的已封存报告列表中增加一个紧凑的“客户版 HTML”下载。导出内容只来自不可变 `customer_safe_v1` 快照，不读取当前活动数据。

## Why This Slice / 本切片原因

Production currently has no configured Feishu application credentials and no approved campaign projection mapping. A live Feishu write therefore cannot pass its entry gate without inventing an external target. The HTML export is the next independent customer deliverable that can be completed and deployed without that external dependency.

生产环境当前没有飞书应用凭据，也没有已批准的活动投影映射，不能在缺少真实目标的情况下启用外部写入。HTML 导出不依赖外部系统，可作为下一项独立客户交付能力立即上线。

## Product Contract / 产品约束

- Campaign owners and organization administrators with campaign write access can download the HTML; readers remain denied, matching the customer PPT boundary.
- The endpoint accepts only a plain empty JSON object, caps that control body at 64 raw bytes, and rejects any non-empty object or array before export or audit work begins.
- The document contains the same seven customer-safe sections as the PPT and no additional fields.
- The HTML contains inline fixed CSS only: no script, external asset, link, form, iframe, or remote request.
- Every dynamic value is HTML-escaped. Response headers enforce attachment download, `nosniff`, a restrictive CSP, private no-store caching, content length, and an output ETag.
- Each successful export records a safe activity-log event containing only campaign ID, snapshot ID, format, and source report hash.
- No schema migration, retained binary artifact, external provider, Feishu write, AI call, or existing proposal/customer PPT change is included.

## API And UI / 接口与界面

`POST /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/html`

- Request: `{}`
- Any non-empty object, array, missing JSON object, or body above the 64-byte control limit is rejected.
- Response: `text/html; charset=utf-8` attachment named `customer-report-<snapshotId>.html`
- Authorization: existing `getForDelivery` owner/org-admin write boundary

The existing sealed snapshot row receives one `客户版 HTML` action beside `查看` and `客户版 PPT`. It reuses the current compact button style, duplicate-click guard, campaign/auth generation guard, download helper, status line, and error presentation.

## Acceptance / 验收

- Authorized HTML download is deterministic for the same sealed snapshot.
- Reader access is rejected server-side.
- Markup-like customer text is escaped and cannot become executable HTML.
- The body contains all seven section headings and no raw URL, contact, commercial field, prompt, or external-delivery data.
- Existing snapshot detail and PPT download behavior remain unchanged.
- Focused service, route, frontend-contract, syntax, secret, and diff checks pass; one independent review approves; verified backup, production deployment, health/dashboard/anonymous-route smoke, and remote syntax checks pass.
