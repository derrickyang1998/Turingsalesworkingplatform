# v0.8.16 Collaboration Commercial Terms / 合作订单商业条款实施计划

> **For agentic workers / 面向执行代理：** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Track every task with checkboxes. / 必须使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，并逐项记录执行状态。

**Goal / 目标：** Make every new M4 collaboration order unambiguously record creator cost, client quote, currency, derived margin, and payment terms while preserving existing v1 and legacy orders, the latest M4 shell, and the frozen PPT build. / 让每个新建 M4 合作订单明确记录达人成本、客户报价、币种、系统计算毛利和付款条件，同时兼容既有 v1/旧订单并保留最新 M4 界面与冻结 PPT。

**Architecture / 架构：** Add an immutable `turingmarket.collaboration-order.v2` JSON contract in the existing `proposal_notes` column. Project its creator cost into the historical `collaborations.cost_quoted` column so settlement, statistics, access control, audit, idempotency, campaign links, and knowledge archival continue to use the proven path. No database migration or new route is required. / 在既有 `proposal_notes` 列中新增不可变的 `turingmarket.collaboration-order.v2` JSON 契约，并把达人成本投影到历史 `collaborations.cost_quoted` 列，使结算、统计、权限、审计、幂等、活动关联和知识归档继续沿用已验证路径；不新增数据库迁移或路由。

**Delivery cadence / 交付节奏：** This is one ordinary feature slice. Run only the exact contract, collaboration-service, M4-client, syntax, diff, credential, deployment-preflight, frozen-PPT, and production core-path checks plus one independent review. After approval, create a verified backup and deploy immediately. / 本版本是单一普通功能切片，只运行精确契约、合作服务、M4 客户端、语法、差异、凭据、部署预检、冻结 PPT 和生产核心路径检查，并完成一次独立审查；通过后创建可验证备份并立即上线。

## Scope Guardrails / 范围边界

- Preserve all legacy and `turingmarket.collaboration-order.v1` create/read/update behavior.
- Keep `cost_quoted` as the historical creator-cost projection; do not reinterpret it as client revenue.
- Derive `margin_amount = client_quote - creator_cost` on the server and reject a conflicting supplied margin.
- Accept only an uppercase three-letter currency and an allowlisted payment term.
- Keep commercial terms immutable after confirmed order creation through the existing canonical-resource lock.
- Reuse current campaign/customer/owner context already returned by `/api/campaigns`; do not widen collaboration-list authorization or schema.
- Do not redesign navigation, colors, typography, routes, PPT generation, Feishu delivery, mutable payment events, or settlement workflow in this slice.
- Do not use real customer rows for production acceptance; create and clean a dedicated temporary fixture.

---

### Task 1: Contract And Service Behavior / 契约与服务行为

**Files:**
- Modify: `platform/server/tests/collaboration_resource_contract.test.js`
- Modify: `platform/server/tests/campaign_collaboration_security.test.js`
- Modify: `platform/server/services/collaboration_resource_contract.js`
- Modify: `platform/server/services/campaign_collaboration_service.js`
- Modify: `platform/server/routes.js`

- [ ] Add failing contract tests for v2 normalization, defaults, derived positive/negative margin, invalid currency, invalid payment terms, conflicting margin, safe integer amounts, v1 compatibility, and creator-cost projection.
- [ ] Add failing service tests proving linked v2 orders store canonical JSON, project creator cost into `cost_quoted`, archive all commercial terms, reject top-level creator-cost conflicts before idempotency reservation, and replay after whitespace normalization.
- [ ] Run only these focused tests and record the expected RED result.
- [ ] Implement schema-dispatched v1/v2 normalization and versioned resource detection while preserving all existing exports used by callers.
- [ ] Route both linked and standalone creates through the shared v2 contract; preserve existing access, audit, knowledge, idempotency, and lock behavior.
- [ ] Re-run the focused tests and record GREEN.

### Task 2: Latest M4 Order Interaction / 最新 M4 下单交互

**Files:**
- Modify: `platform/server/tests/m4_campaign_collaboration_client.test.js`
- Modify: `platform/app.js`

- [ ] Add failing client tests for the v2 payload, creator cost, client quote, currency, payment term, client-side validation, derived margin preview, and campaign customer/owner context.
- [ ] Run only the M4 client test and record RED.
- [ ] Split the ambiguous quote field into `达人成本` and `客户报价`, add currency and payment-term controls, show a live margin preview, and show selected campaign customer/owner context.
- [ ] Render v2 commercial terms clearly in the existing collaboration table while retaining readable fallback output for v1 and legacy rows.
- [ ] Keep existing duplicate-click, lost-response replay, status transition, settlement, focus, sticky-table, and responsive behavior unchanged.
- [ ] Re-run the M4 client test and record GREEN.

### Task 3: Review, Production, And Records / 审查、上线与记录

- [ ] Run the exact affected test files, `node --check` for changed JavaScript, `git diff --check`, focused credential scan, deployment local preflight, and frozen `ppt.js` SHA-256 check. Do not run the full platform suite because this slice has no migration, new permission path, external write, or shared runtime change.
- [ ] Obtain one independent code/security/product review; fix and re-review every material finding. HIGH or CRITICAL findings block release.
- [ ] Commit and push the reviewed feature source, create and verify a timestamped production backup, deploy through `platform/deploy_v8.ps1`, and verify PM2, Nginx, `/api/health`, admin login, M4 load, isolated v2 create/read/archive/idempotency behavior, fixture cleanup, database integrity, and frozen PPT hash.
- [ ] Update `CHANGELOG.md`, the Phase 7 open-boundary note without marking work item 333 complete, a bilingual version record, Obsidian release archive, progress dashboard, and GitHub; verify local, GitHub, production, and archive evidence agree.
