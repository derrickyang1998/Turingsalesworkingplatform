# Phase 7 Payment And Settlement Checkpoint Implementation Plan / 阶段 7 收付款凭证与结算门禁实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task.

**Goal / 目标:** Replace the campaign-linked v2 one-click settlement with an append-only manual receipt/payment ledger and an independent settlement approval checkpoint, while preserving the existing M4 page and all accepted workflows. / 将活动关联 v2 订单的单人直接结算改为不可覆写的手工收付款台账和独立结算审核，同时保留现有 M4 页面与已验收流程。

**Architecture / 架构:** Reuse the established Campaign-linked knowledge evidence chain at schema v16. Financial evidence uses the reserved `collaboration_payment_settlement` namespace, remains team-visible but excluded from RAG, and is projected by the collaboration service. All mutations use optimistic versions, idempotency keys, atomic audit/evidence writes, and server-projected capabilities. / 复用 schema v16 已有活动知识凭证链；财务凭证采用保留命名空间、团队可见但不进入 RAG，并由合作服务投影。所有写入均使用版本校验、幂等键、原子审计/凭证写入及服务端权限投影。

**Tech Stack / 技术栈:** Express, SQLite, vanilla JavaScript M4 UI, Node test runner, existing deployment and production acceptance scripts.

**Spec / 依据:** `docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md`, Phase 7.

## Global Constraints / 全局约束

- Scope only the existing M4 collaboration table, modals, collaboration service, route policies, and reserved Campaign evidence namespace; no new page, route family, payment provider, or visual redesign.
- Preserve legacy v1 and unlinked collaboration behavior. Existing settled v2 records remain readable as `legacy_settled`; unsettled v2 records must use this checkpoint.
- Treat each payment entry as an operator attestation, not bank verification. Store sensitive values only in protected metadata with `retrieval_eligible:false`.
- Support `creator_payment` and `client_receipt`. Creator payments determine actual creator cost; client receipts provide commercial reconciliation context but do not replace accounting software.
- Keep whole-unit, single-currency amounts aligned with the immutable v2 order contract. No cents, FX, tax, fee, refund, receipt-file, or provider integration in this release.
- Run only affected tests before deployment unless shared security, schema, migration, authentication, or deployment infrastructure changes trigger a broader gate. The production deploy script's mandatory remote checks remain unchanged.
- After acceptance, update `CHANGELOG.md`, version records, Obsidian archive, GitHub, and the external progress dashboard.

## Contract / 功能契约

### Payment Evidence / 收付款凭证

- `POST /api/collaborations/:id/payments` records one immutable entry after signed-contract confirmation.
- `GET /api/collaborations/:id/payments` returns the verified ledger and server-projected capabilities.
- `POST /api/collaborations/:id/payments/:paymentId/void` appends a compensating void event before settlement; no edit or delete path exists.
- Required fields: `campaign_id`, `expected_version`, `direction`, positive safe-integer `amount`, canonical UTC `paid_at`, allowed `payment_method`, `payment_reference`, counterparty name, tranche, and note.
- Currency is derived from the immutable v2 order. Duplicate active fingerprints or conflicting references fail with `409`.

### Settlement / 结算

- `POST /api/collaborations/:id/settlement-submissions` snapshots the server-verified active-entry digest and totals after approved publication.
- `POST /api/collaborations/:id/settlement-decisions` accepts `approved` or `changes_requested` with a required review note.
- The decision maker must be the campaign owner or organization administrator and must differ from the submitter and every recorder represented by the active digest.
- Approval atomically sets `cost_actual` to the active creator-payment total, sets `cost_actual_confirmed=1`, adds the existing `settlement` relation, and writes evidence plus audit records. It does not auto-advance Campaign lifecycle.
- A creator-payment total different from immutable creator cost, or a client-receipt total different from client quote, requires an explicit variance reason before submission. Zero-cost/zero-receipt cases require an explicit zero-value reason.
- Pending review locks ledger mutation. `changes_requested` reopens recording; approved settlement is terminal for this release.

## Task 1: Lock The Contract With Failing Tests / 用失败测试锁定契约

**Files:**
- Create: `platform/server/tests/collaboration_payment_settlement_service.test.js`
- Modify: `platform/server/tests/phase4_request_pipeline.test.js`
- Modify: `platform/server/tests/influencer_workflow.test.js`
- Modify: `platform/server/tests/campaign_knowledge_multipart.test.js`
- Modify: `platform/server/tests/campaign_record_integration.test.js`
- Modify: `platform/server/tests/m4_campaign_collaboration_client.test.js`

**Steps:**
1. Add focused tests for deposit/balance entry, receipts, duplicate/reference rejection, void/replacement, pre-publication recording, publication gate, variance/zero reasons, four-eyes approval, stale version, replay, rollback, legacy compatibility, reserved namespace, routes, policy registration, and M4 actions/modals.
2. Run only the new/changed test files and confirm they fail for the missing checkpoint behavior.

## Task 2: Implement Backend Custody And Projection / 实现后端凭证链与投影

**Files:**
- Modify: `platform/server/services/campaign_collaboration_service.js`
- Modify: `platform/server/services/campaign_link_service.js`
- Modify: `platform/server/contracts/campaign_contract.js`
- Modify: `platform/server/routes.js`
- Modify: `platform/server/server.js`

**Steps:**
1. Add strict normalizers, canonical hashes, paged evidence verification, derived ledger/settlement state, and server capability projection.
2. Add record, list, void, submit, and decide service operations using transactions, idempotency, optimistic `row_version`, access masking, Campaign links, and audit writes.
3. Reserve `collaboration_payment_settlement` against generic knowledge ingestion and reject the old generic v2 settlement mutation with `SETTLEMENT_CHECKPOINT_REQUIRED`.
4. Register route policies and route forwarding without changing existing endpoint behavior.
5. Run the focused backend tests to green.

## Task 3: Upgrade Existing M4 Interaction / 升级现有 M4 交互

**Files:**
- Modify: `platform/app.js`
- Modify only if required by existing layout: `platform/styles.css`

**Steps:**
1. Add a compact in-row summary for receipts, creator payments, variance, entry count, and settlement state.
2. Replace `确认结算` with server-authorized `录入收付款`, `提交结算`, or `审核结算` actions.
3. Add accessible existing-style modals for immutable commercial terms, ledger history, record/void operations, submission notes, variance reasons, and independent decisions.
4. Preserve duplicate-click locking, reload on stale version, zero-value rendering, existing filters, saved views, exports, Feishu controls, knowledge links, and frozen PPT behavior.
5. Run the focused M4 client test to green and syntax-check changed JavaScript.

## Task 4: Review, Release, And Production Acceptance / 审查、发布与线上验收

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/version-records/2026-09-09-v0.8.20-payment-settlement-checkpoint-production.md`
- Create: `archive/versions/2026-09-09-v0.8.20-payment-settlement-checkpoint-production.md`
- Create: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\2026-09-09-v0.8.20-payment-settlement-checkpoint-production.md`
- Modify: `C:\Users\29272\Documents\在线商务平台\TuringMarket-开发进度.html`

**Steps:**
1. Request one independent code/security review and resolve every blocking finding.
2. Run the affected tests, JavaScript syntax checks, frozen-PPT hash check, focused secret scan, and diff review.
3. Commit implementation, create and verify a production backup, deploy immediately, then verify health, admin login, read paths, and a uniquely tagged payment/settlement roundtrip with cleanup.
4. Record exact local/remote verification counts and immutable identifiers in the changelog and bilingual version records.
5. Sync Obsidian, GitHub, and the progress dashboard; verify clean branch and zero upstream divergence.

## Acceptance / 验收标准

- A campaign-linked v2 collaboration can record multiple receipts/payments, void an unsettled mistake, and display verified totals in M4.
- Settlement cannot pass before approved publication, with mismatched/tampered evidence, or by any participant in the submitted financial evidence.
- Independent approval creates the settlement relation and preserves complete immutable history; failed writes leave no partial version, link, audit, evidence, or idempotency residue.
- Legacy collaboration behavior and every previously accepted M4 function remain available.
- The deployed production build passes the focused online roundtrip and cleanup, and all release records point to the deployed Git commit.
