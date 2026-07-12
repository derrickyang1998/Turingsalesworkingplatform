# Production Static Exposure Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop anonymous access to backend source, SQLite files, uploads, and deployment files while preserving the current production UI and APIs.

**Architecture:** Register an explicit Express public-asset surface instead of mounting the whole platform directory, then enforce the same private-path blocks at Nginx. Verify with a real spawned server, deploy through the guarded PowerShell script, invalidate sessions, and test the public production URL.

**Tech Stack:** Node.js 20, Express 5, Node test runner, Nginx, PM2, PowerShell deployment, SQLite via `better-sqlite3`.

## Global Constraints

- Authoritative checkout: `C:\Users\29272\Documents\在线商务平台-github-sync`.
- Preserve `ppt.js?v=20260702v916kbbridge` and `20260702-v916-kb-bridge-client-cn`.
- Do not expose or print credentials.
- Do not change CRM, AI, knowledge-base, PPT, or influencer business behavior.
- Production verification is required before completion.

---

### Task 1: Reproduce The Exposure

**Files:**
- Create: `platform/server/tests/public_static_security.test.js`

**Interfaces:**
- Consumes: `platform/server/server.js` started with isolated `PORT` and `DB_PATH` environment values.
- Produces: assertions for public `200` paths and private `404` paths.

- [ ] Write a test that starts the real server and issues `HEAD` requests to `/app.js`, `/ppt.js`, `/data/influencer_schema.json`, `/server/server.js`, `/server/db/turingmarket.db`, and `/deploy_v8.ps1`.
- [ ] Run `node --test tests/public_static_security.test.js` and confirm the private-path assertions fail with `200 !== 404`.

### Task 2: Add The Express Public Asset Policy

**Files:**
- Create: `platform/server/services/public_assets_service.js`
- Modify: `platform/server/server.js`
- Test: `platform/server/tests/public_static_security.test.js`

**Interfaces:**
- Produces: `registerPublicAssets(app, express, publicRoot)` and `isPrivateRequestPath(requestPath)`.

- [ ] Register private-path denial before any static or SPA route.
- [ ] Serve only `index.html`, `app.js`, `ppt.js`, and `data/` browser assets.
- [ ] Remove the broad platform-root `express.static` mount.
- [ ] Run the focused test and confirm all assertions pass.

### Task 3: Add Nginx Defense In Depth

**Files:**
- Create: `platform/nginx/turingmarket.conf`
- Modify: `platform/deploy_v8.ps1`
- Test: `platform/server/tests/public_static_security.test.js`

**Interfaces:**
- Produces: an Nginx server config that blocks private paths and proxies allowed traffic to `127.0.0.1:3002`.

- [ ] Add static assertions for Nginx deny locations and deployment installation commands; confirm they fail before implementation.
- [ ] Add the Nginx config and deploy wiring, including backup, `nginx -t`, symlink installation, and reload.
- [ ] Run the focused test and confirm it passes.

### Task 4: Verify And Review

**Files:**
- Modify: `CHANGELOG.md`
- Create: `archive/versions/2026-07-12-v0.2.9-production-static-exposure-hotfix.md`

- [ ] Run `npm test` in `platform/server`.
- [ ] Run `node --check` for changed JavaScript files and `git diff --check`.
- [ ] Run an independent code review and security review; address all critical and important findings.

### Task 5: Deploy And Prove Production Safety

**Files:**
- Use: `platform/deploy_v8.ps1`

- [ ] Deploy from the guarded `github-sync` checkout.
- [ ] Delete all rows from the production `sessions` table without printing credentials.
- [ ] Verify PM2 and `/api/health`.
- [ ] Verify public assets return `200` and every sensitive path returns `404`.
- [ ] Run the full remote test suite and confirm the PPT build marker is unchanged.
- [ ] Record the release in CHANGELOG, Obsidian, Git, and GitHub.
