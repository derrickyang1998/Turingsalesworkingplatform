# v0.8.7 Performance AI Review Approval Implementation Plan

> **For agentic workers / 面向执行代理：** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or inline execution with independent review. Steps use checkbox (`- [ ]`) syntax for tracking. / 必须使用独立实现与独立审查；使用复选框跟踪进度。

**Goal / 目标：** Turn one validated Phase 7B AI performance-review draft into one human-edited, campaign-local knowledge artifact with durable evidence lineage and no automatic cross-project promotion.

**Architecture / 架构：** Reuse the persisted linked AI conversation/message, retained idempotency response envelope, current evidence snapshot, campaign access service, and immutable campaign-knowledge writer. Add one performance-specific confirmation route and one new campaign-only business-artifact definition. The immutable knowledge entry is the confirmation record for this slice; no new schema/table is introduced because the source AI draft already persists in `ai_messages` and its evidence envelope in `request_idempotency`.

**Tech Stack / 技术栈：** Express 5, SQLite/FTS5, existing campaign access, immutable campaign knowledge, vanilla JavaScript, Node test runner, guarded PM2/Nginx deployment.

**Spec / 依据：** `docs/superpowers/plans/2026-07-30-phase-7b-content-performance-intelligence.md`, Phase 7B.3 human confirmation before knowledge archive.

## Global Constraints / 全局约束

- Preserve the production `v0.6` interface shell and frozen `ppt.js`; do not change proposal/PPT generation.
- Keep the review metadata-only: no video/media fetch, no hook/style/cause analysis, no web search, no provider call, no Feishu write, and no organization-wide knowledge promotion.
- A confirmation requires campaign owner or organization administrator access with write permission. Team members can still read the generated draft under the existing access policy.
- The request body is exactly `conversation_id`, `message_id`, `expected_snapshot_hash`, `edited_draft`, and optional `visibility` (`private` or `team`). Any other field is rejected.
- The server must validate that the persisted assistant message belongs to a successful `performance_review` linked AI run, that its retained response envelope is a valid generated draft, that its stored snapshot equals `expected_snapshot_hash`, and that a fresh current snapshot still equals it.
- The edited text must remain inside the existing metadata-only safety boundary and retain every validated `[PERF-n]` citation from the source draft. The canonical knowledge content is the human-edited final text; the original draft remains immutable in `ai_messages` and is referenced by SHA-256 in knowledge metadata.
- Use a new `performance_review_confirmation` campaign artifact instead of `project_review`; `project_review` is reserved for settled campaign lifecycle events.
- Repeated confirmation of the same conversation/message with the same canonical content returns the existing result. A changed confirmation for that immutable draft returns a conflict; regenerate a new draft instead of mutating history.
- Every feature slice follows the user-approved fast cadence: focused tests, syntax/contract/secret checks, one independent review, verified backup, immediate production deployment, health/login/feature smoke, then version/archive/dashboard/GitHub sync. Do not run the full platform suite unless a risk trigger requires it.

---

### Task 1: Red Tests For Confirmation Lineage

**Files:**
- Modify: `platform/server/tests/campaign_ai_rag.test.js`
- Modify: `platform/server/tests/routes_performance.test.js`
- Modify: `platform/server/tests/performance_frontend_contract.test.js`

**Interfaces:**
- Produces the expected `approveDraft(input)` service contract and `POST /api/campaigns/:id/performance/ai-review-draft/approve` route contract.
- Uses a real linked AI conversation, retained generated envelope, campaign knowledge storage, and a deterministic performance-evidence fixture.

- [x] **Step 1: Write failing approval service tests.**

```js
const result = await reviewService.approveDraft({
  user: owner,
  campaignId,
  body: {
    conversation_id: generated.ai.conversation_id,
    message_id: generated.ai.message_id,
    expected_snapshot_hash: generated.evidence.snapshot_hash,
    edited_draft: generated.draft,
    visibility: 'team'
  },
  idempotencyKey: 'performance-review-approval-0001',
  requestId: 'performance-review-approval-request-0001'
});
assert.equal(result.status, 'confirmed');
assert.equal(result.knowledge_entry_id > 0, true);
assert.equal(result.evidence_snapshot_hash, generated.evidence.snapshot_hash);
```

Cover the exact confirmation, human-edited final content with original/final hashes, unchanged replay, changed-content conflict, stale snapshot, unauthorized actor, cross-campaign message, unsafe media claim, and missing required citation.

- [x] **Step 2: Write failing route and client-contract tests.**

Assert the new frozen campaign request policy and protected route pass the authenticated user, campaign id, body, idempotency key, and request id into `approveDraft`. Assert the performance dashboard renders an editable confirmation textarea, private/team visibility control, a confirmation command, and campaign/request staleness guards without changing the existing draft generation controls.

- [x] **Step 3: Run the new tests to verify RED.**

Run:

```powershell
node --test --test-concurrency=1 tests/campaign_ai_rag.test.js tests/routes_performance.test.js tests/performance_frontend_contract.test.js
```

Expected: the service/route/client confirmation symbols are absent or the new behavior fails before implementation.

### Task 2: Implement The Bounded Confirmation And Archive Flow

**Files:**
- Modify: `platform/server/services/performance_manual_service.js`
- Modify: `platform/server/services/knowledge_service.js`
- Modify: `platform/server/routes_performance.js`
- Modify: `platform/server/contracts/campaign_contract.js`
- Modify: `platform/server/server.js`
- Modify: `platform/server/services/campaign_access_service.js`

**Interfaces:**
- Add `performance_review_confirmation` with state `confirmed`, campaign entry/source type `performance_ai_review_confirmation`, business type `campaign`, and no legacy representation.
- Add `approveDraft(input)` to the existing `createPerformanceAiReviewService` return value.
- Add policy `CAMPAIGN_PERFORMANCE_AI_REVIEW_APPROVE` and route `POST /api/campaigns/:id/performance/ai-review-draft/approve`.

- [x] **Step 1: Parse and verify one immutable source draft.**

`approveDraft` must load the campaign-linked `performance_review` conversation and assistant message, find its completed retained linked-AI response, validate it with the existing review-envelope helper, compare stored/current/client snapshot hashes, and hash the canonical stored and edited drafts with SHA-256.

- [x] **Step 2: Enforce approval and content policy.**

Use the existing campaign access primitive plus owner/org-admin write capability. Reject a non-owner/member, cross-campaign conversation, non-generated draft, stale snapshot, unknown body field, invalid visibility, unsupported media/causal wording, or removal of any source `[PERF-n]` citation with a stable `PERFORMANCE_AI_REVIEW_*` error.

- [x] **Step 3: Atomically create or replay campaign knowledge.**

Within one immediate SQLite transaction, reject a prior different confirmation for the same `{campaign, conversation, message}` source; otherwise write the new business artifact, attach one `knowledge` campaign record link, apply the returned knowledge-capacity gauge plan, and write an `activity_log` entry containing identifiers, hashes, visibility, and request id but no body text. Return `confirmed` for the first write and `already_confirmed` for an exact replay.

- [x] **Step 4: Add the route and request policy.**

Register the frozen JSON policy in `campaign_contract.js` and `server.js`; call the service from the protected performance route. Reuse the existing error-envelope helpers and do not change authentication, rate-limit, or upload pipelines.

- [x] **Step 5: Add the knowledge-source projection.**

Map `performance_ai_review_confirmation` to the existing review-style source label so campaign knowledge views expose its origin without leaking AI prompts or private metrics.

- [x] **Step 6: Run the focused backend tests to verify GREEN.**

Run:

```powershell
node --test --test-concurrency=1 tests/campaign_ai_rag.test.js tests/routes_performance.test.js
```

Expected: all direct confirmation, custody, immutable knowledge, and existing linked-AI promotion contracts pass.

### Task 3: Add The In-Place Human Confirmation UI

**Files:**
- Modify: `platform/app.js`
- Modify: `platform/server/tests/performance_frontend_contract.test.js`

**Interfaces:**
- Use the current `performanceAiReviewDraft`, request sequence, campaign identity, and `apiFetch` helpers.
- Call `/campaigns/:id/performance/ai-review-draft/approve` only after a generated draft has been rendered.

- [x] **Step 1: Render an editable approval state.**

For a generated draft, render a textarea prefilled with the reviewed draft, a compact private/team selector, boundary copy, and a disabled/busy-safe confirmation command. Show the control only when the current performance capabilities allow approval; otherwise state that an activity owner or organization administrator must confirm it.

- [x] **Step 2: Submit and reconcile one confirmation.**

Build a per-draft idempotency key, pass conversation/message/snapshot identifiers and the edited text, reject stale or switched-campaign responses, and show the archived knowledge-entry identifier plus final snapshot hash on success. Preserve the generated draft in view; do not reset the surrounding dashboard or alter AI-draft generation behavior.

- [x] **Step 3: Run the focused client contract test.**

Run:

```powershell
node --test --test-concurrency=1 tests/performance_frontend_contract.test.js
```

Expected: the existing review-generation contract and the new confirmation interaction contract pass.

### Task 4: Feature-Level Review, Release, And Evidence

**Files:**
- Modify after production acceptance: `CHANGELOG.md`
- Create after production acceptance: `docs/version-records/2026-09-04-v0.8.7-performance-ai-review-approval-production.md`
- Create after production acceptance: `archive/versions/2026-09-04-v0.8.7-performance-ai-review-approval-production.md`
- Modify after production acceptance: `C:\Users\29272\Documents\在线商务平台\TuringMarket-开发进度.html`

- [x] **Step 1: Run only focused release checks.**

Run changed JavaScript syntax checks, the three targeted test groups, `git diff --check`, targeted secret scan, and `platform/deploy_v8.ps1 -ValidateLocalOnly`. Do not run the complete platform matrix for this ordinary no-migration feature.

- [x] **Step 2: Obtain an independent code-review verdict.**

The reviewer must check source-draft lineage, permission boundary, stale-snapshot rejection, exact replay/conflict behavior, knowledge custody/linking, unsafe-edit rejection, prompt/secret non-disclosure, and preservation of PPT/media/web/Feishu boundaries.

- [ ] **Step 3: Back up, deploy immediately, and accept online.**

Create a verified production backup, deploy the exact reviewed commit, and verify public/loopback health, PM2/Nginx, administrator login plus `/api/auth/me` and logout, and an authenticated protected-route smoke without creating production business data. The complete confirmation mutation remains covered by the real isolated SQLite fixture in the candidate release gate. Run no manual browser automation without the user's explicit browser authorization.

- [ ] **Step 4: Sync records and move to the next slice.**

Record release SHA, backup identity, focused test counts, independent verdict, online URL/path evidence, and rollback state in `CHANGELOG.md`, both version record locations, the progress board, Obsidian, and GitHub. The next independent slice is an immutable customer-report snapshot, not media analysis or PPT generation.

## Plan Self-Review / 计划自检

- Scope coverage: human edit, human confirmation, campaign-local archive, original/final lineage, access, visibility, stale detection, replay/conflict behavior, UI, independent review, release, and version synchronization are all covered.
- Deliberate ruling: use existing immutable AI conversations plus immutable campaign knowledge instead of new draft/confirmation tables. This avoids a schema migration in the current normal feature slice while retaining queryable source/final hashes. A future reporting slice may add a dedicated immutable projection if report snapshot queries require it.
- Deferred intentionally: organization-wide promotion, provider polling, Feishu writes, media-rights collection, video content analysis, client-facing report generation, and PPT generation.
