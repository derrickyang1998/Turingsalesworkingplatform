# Phase 7 Feishu Connection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing M4 influencer-to-Feishu action observable and safely connectable through webhook or Feishu Bitable configuration, without exposing credentials or changing customer campaign data.

**Architecture:** Replace the inline webhook branch with a server-only Feishu client that resolves configuration from environment variables and returns only safe status metadata. Keep the legacy selected-influencer endpoint and CSV fallback compatible, add separate status and administrator-only connection-test routes, and use the current M4 panel to show connection state before a user pushes records. Webhook remains the only live write transport in this slice; Bitable is limited to configuration and a read-only connection check until a mapped, idempotent write contract exists.

**Tech Stack:** Node.js 20, Express 5, SQLite activity log, native `fetch`, existing M4 plain-JavaScript UI, Feishu server APIs.

**Spec:** `docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md` Phase 7, approved by the user.

## Global Constraints

- Preserve the approved 20-column influencer export contract and the current CSV fallback when Feishu is not configured.
- Credentials remain server-side only. Public APIs, client code, logs, tests, version records, and deployment output must never contain a webhook URL, app secret, access token, or table token.
- Support `webhook` and `bitable` configuration modes through server environment variables. Webhook may deliver selected influencer records; Bitable must remain on CSV fallback and permit only a read-only connection check. Do not invent production credentials or mutate a customer Feishu table during deployment verification.
- The user-approved incremental release cadence applies: targeted tests, syntax/contract checks, independent review, verified backup, production health and feature smoke, then release records, dashboard, Obsidian, and GitHub.
- Do not modify PPT generation, AI/RAG, campaign write semantics, or existing customer data in this slice.

---

### Task 1: Feishu Provider Contract

**Files:**
- Create: `platform/server/feishu_client.js`
- Test: `platform/server/tests/feishu_client.test.js`

**Interfaces:**
- Consumes: server environment, injected `fetch` for tests, approved influencer-template record objects, optional CSV fallback payload.
- Produces: safe provider status, a no-record connection test, webhook delivery results, and an explicit CSV fallback for Bitable.

- [ ] **Step 1: Write failing provider tests.**

Cover unconfigured status, webhook selection, Bitable configuration validation, secret redaction, webhook request shape, Bitable CSV fallback with no write request, Bitable token plus read-only table access check, safe error codes, and connection-test payloads that contain no influencer records.

- [ ] **Step 2: Confirm RED.**

Run:

```powershell
node --test platform/server/tests/feishu_client.test.js
```

Expected: the empty placeholder client cannot satisfy the provider contract.

- [ ] **Step 3: Implement the minimal provider client.**

Implement a small factory with explicit configuration detection, safe public status, bounded request timeout, webhook delivery, Bitable tenant-token acquisition plus read-only access verification, and normalized public errors. Keep raw remote response bodies and secret-bearing configuration out of returned values and logs. Do not add Bitable writes in this slice.

- [ ] **Step 4: Verify Task 1.**

Run the focused client test. Expected: all provider contract tests pass with no network access.

### Task 2: Compatible API Wiring And M4 Connection State

**Files:**
- Create: `platform/server/routes_feishu.js`
- Modify: `platform/server/routes.js`
- Modify: `platform/server/server.js`
- Modify: `platform/index.html`
- Modify: `platform/app.js`
- Modify: `platform/server/tests/influencer_workflow.test.js`
- Modify: `platform/server/tests/helpers/browser_fixture.js`

**Interfaces:**
- Consumes: the provider client, existing authentication and admin middleware, selected influencer IDs, existing M4 status surface.
- Produces: `GET /api/feishu/status`, admin-only `POST /api/feishu/test`, and the compatible `POST /api/influencers/feishu/sync` endpoint backed by the provider client.

- [ ] **Step 1: Write failing route and UI contract tests.**

Extend the influencer workflow tests for status redaction, admin-only connection testing, legacy CSV fallback, webhook compatibility, Bitable CSV fallback with no write, and activity-log success/failure facts. Extend the M4 static/browser fixture contract so status loading, refresh, and the administrator test action remain wired without browser automation.

- [ ] **Step 2: Confirm RED.**

Run:

```powershell
node --test platform/server/tests/feishu_client.test.js platform/server/tests/influencer_workflow.test.js
```

Expected: current inline route lacks status/test routes, provider modes, and safe operational feedback.

- [ ] **Step 3: Wire APIs and UI.**

Move only the provider responsibility out of the inline route. Keep the old sync path, output contract, and CSV fallback. Register the new status/test routes with `adminOnly`; load a concise connection indicator on M4 import/Feishu view, refresh it after sync, and hide or disable the connection test for non-admin users. Bitable configuration must show its read-only limitation plainly and never issue a write request.

- [ ] **Step 4: Verify Task 2.**

Run the focused tests plus syntax checks for every edited JavaScript file. Expected: existing importer, template, export, M4 order, and CSV fallback tests remain green.

### Task 3: Independent Review, Immediate Production Release, And Evidence

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/version-records/2026-09-01-v0.7.1-feishu-connection-foundation-production.md`
- Create: `archive/versions/2026-09-01-v0.7.1-feishu-connection-foundation-production.md`
- Modify: `C:\Users\29272\Documents\在线商务平台\TuringMarket-开发进度.html`
- Create: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\2026-09-01-v0.7.1-feishu-connection-foundation-production.md`

- [ ] **Step 1: Obtain an independent code review.**

Reviewer must check credential exposure, request behavior, API authorization, CSV compatibility, user-visible state, and that Bitable cannot write records in this slice. Confirm that no real customer Feishu data was written by test or deployment.

- [ ] **Step 2: Run release-scoped verification.**

Run the two focused test files, targeted existing M4 client tests, JavaScript syntax checks, `git diff --check`, and the local deployment contract validation. Do not run the unrelated full suite unless a migration, shared runtime, or reviewer finding requires it.

- [ ] **Step 3: Back up and deploy immediately.**

Use the guarded production deployment script, verify public and loopback health, PM2, Nginx, and a safe authenticated Feishu-status smoke. Do not click the connection test or sync production records unless a disposable Feishu endpoint/table is explicitly configured.

- [ ] **Step 4: Record and publish evidence.**

Update changelog, version record, progress dashboard, repository archive, Obsidian archive, and GitHub. State whether real webhook/Bitable credentials were configured and whether the non-mutating connection test was executed.
