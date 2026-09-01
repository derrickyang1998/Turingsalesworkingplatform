# Phase 7 Feishu Bitable Explicit Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, explicit, append-only retry flow for known no-write Feishu Bitable failures without mutating any historical delivery receipt.

**Architecture:** A schema-9 retry-link ledger connects an immutable failed outbox receipt to a new pending child receipt. The outbox service owns eligibility, lineage, and idempotency; `routes.js` owns the explicit provider invocation; M4 owns only user intent, client validation, and single-flight state. Pending uncertain receipts remain reconciliation-only.

**Tech Stack:** Node.js 20, Express 5, SQLite `STRICT` tables/triggers, `better-sqlite3`, native browser JavaScript, existing guarded `deploy_v8.ps1` release path.

**Spec:** `docs/superpowers/specs/2026-09-02-phase7-feishu-explicit-retry-design.md`

## Global Constraints

- No silent retry, refresh-triggered retry, or automatic compensation is permitted.
- Do not modify/delete remote Bitable records or mutate terminal local receipts.
- Required API inputs are `Idempotency-Key: <uuid>` and `{ "reason": "1-280 chars" }`.
- Only campaign Owner/organization administrator can retry, and the campaign must be writable.
- Only the exact safe no-write failure-code allowlist is retryable; `pending` delivery remains reconciliation-only.
- Retain the user-approved cadence: focused verification, independent review, verified backup, production deploy, online acceptance, changelog/version/Obsidian/GitHub/progress synchronization.

---

### Task 1: Retry-Lineage Migration And Service Contract

**Files:**
- Create: `platform/server/migrations/009_feishu_bitable_retry_lineage.js`
- Modify: `platform/server/db.js`
- Modify: `platform/server/services/feishu_bitable_outbox_service.js`
- Modify: `platform/server/tests/feishu_bitable_outbox.test.js`
- Modify: migration/trusted-source fixture files identified by their failing release-contract tests.

**Interfaces:**
- Consumes: a failed `feishu_bitable_outbox` receipt and a UUID operation ID.
- Produces: `retry({ userId, campaignId, deliveryId, operationId, reason })` returning `{ state, delivery, sourceDelivery, reservationToken?, records? }`.

- [ ] **Step 1: Write failing retry-lineage tests.**

Add tests that call a not-yet-existing `service.retry` and assert: a safe failed source produces a new pending child with the same stored payload; source and child receive append-only lineage; same actor/key replays without a second child; a different key cannot create another child; a pending source, succeeded source, non-retryable failure, non-owner, and held/cancelled campaign are rejected.

- [ ] **Step 2: Confirm RED.**

Run:

```powershell
node --test platform/server/tests/feishu_bitable_outbox.test.js
```

Expected: the new retry tests fail because `service.retry` and schema-9 lineage do not exist.

- [ ] **Step 3: Implement the smallest append-only retry contract.**

Create migration `009` with a strict retry-link ledger, unique source/child constraints, immutable/no-delete/cross-scope validation triggers, and a schema manifest. Register it in `db.js` and release fixtures. Refactor only enough outbox-service internals to reserve a new delivery from a verified stored snapshot, preserve the original receipt, expose lineage-safe public fields, and enforce the defined allowlist/replay rules.

- [ ] **Step 4: Confirm GREEN.**

Run the focused outbox test and `node -c` on the migration, DB registration, and service. Expected: all current receipt/reconciliation tests plus new retry tests pass.

### Task 2: Explicit Retry Route And Provider Invocation

**Files:**
- Modify: `platform/server/routes.js`
- Modify: `platform/server/tests/influencer_workflow.test.js`

**Interfaces:**
- Consumes: `POST /api/campaigns/:id/feishu-deliveries/:deliveryId/retry`, a UUID header, and a reason.
- Produces: a child delivery receipt after a single Bitable request, or `202` for a child requiring reconciliation.

- [ ] **Step 1: Write failing route tests.**

Use the existing route harness to prove: a safe failed source retries with the exact stored `bitableRecords`, uses the new idempotency key once, creates one child lineage row, rejects missing reason/header and unauthorized users before provider call, returns a replay without another provider call, and leaves ambiguity as a new pending child.

- [ ] **Step 2: Confirm RED.**

Run:

```powershell
node --test platform/server/tests/influencer_workflow.test.js
```

Expected: retry route lookup fails because the endpoint is not mounted.

- [ ] **Step 3: Implement the route without a new provider abstraction.**

Require current Bitable write availability, call `feishuBitableOutbox.retry`, pass its preserved payload as both the count source and `bitableRecords` to existing `syncInfluencers`, finalize only the new child, audit retry/reconcile/failure facts, and handle same-key replay without another write. Keep all existing sync and reconciliation responses compatible.

- [ ] **Step 4: Confirm GREEN.**

Run the focused workflow test and `node -c platform/server/routes.js`. Expected: existing Feishu sync tests and new retry contract tests pass.

### Task 3: M4 Explicit Retry Interaction

**Files:**
- Modify: `platform/index.html`
- Modify: `platform/app.js`
- Create: `platform/server/tests/m4_feishu_retry_client.test.js`

**Interfaces:**
- Consumes: delivery projections with `retry_available` and a user-entered reason.
- Produces: one user-initiated retry POST per active campaign/delivery, with client-side validation and refresh.

- [ ] **Step 1: Write failing client/markup tests.**

Extract the new browser functions in a VM fixture and prove: only retry-available failures render; pending/non-retryable receipts render no retry control; blank reason and non-owner state issue no network request; a click sends the expected route/body/UUID header once; context switches retain the per-delivery lock; a 409 refreshes receipts.

- [ ] **Step 2: Confirm RED.**

Run:

```powershell
node --test platform/server/tests/m4_feishu_retry_client.test.js
```

Expected: the fixture cannot extract the retry functions or retry markup.

- [ ] **Step 3: Implement the smallest M4 panel.**

Add a compact retry panel below reconciliation. Reuse campaign ownership detection, load delivery data through the current `loadFeishuOutbox`, require a reason, use a UUID per action key, lock duplicate clicks across context switches, and refresh state after success, failure, or conflict. Do not add automatic scheduling or remote-update controls.

- [ ] **Step 4: Confirm GREEN.**

Run the new client test, reconciliation client test, and `node -c platform/app.js`. Expected: UI contract tests pass without browser automation.

### Task 4: Review, Production Release, And Evidence

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/version-records/2026-09-02-v0.7.4c-feishu-explicit-retry-production.md`
- Create: `archive/versions/2026-09-02-v0.7.4c-feishu-explicit-retry-production.md`
- Modify: `C:\Users\29272\Documents\在线商务平台\TuringMarket-开发进度.html`
- Create: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\2026-09-02-v0.7.4c-feishu-explicit-retry-production.md`

- [ ] **Step 1: Run targeted migration and user-flow verification.**

Run the service, route, M4 client, existing reconciliation, source-trust/migration tests required by schema 9, syntax checks, `git diff --check`, and `deploy_v8.ps1 -ValidateLocalOnly`. Record exact results; do not claim a full unrelated suite.

- [ ] **Step 2: Obtain an independent review.**

Review schema immutability, source/child consistency, authorization, idempotency/replay, provider ambiguity, no-silent-write behavior, client single-flight, and public-secret exposure. Address blocking findings and re-review if necessary.

- [ ] **Step 3: Back up, deploy, and verify online.**

Run the guarded deploy, verify the database migration/version/integrity, parser/health, M4 route/static surface, PM2, and Nginx. Do not issue a real Feishu retry or modify remote customer records for release acceptance.

- [ ] **Step 4: Publish release evidence.**

Commit/push code and version records; synchronize the version note to Obsidian and update the local development-progress dashboard. Report the backup identifier/checksum, online acceptance, and the absence of real external writes.
