# Brand Intelligence Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old M1 brand library shell with a usable brand intelligence workspace connected to existing brand enrichment and knowledge archive flows.

**Architecture:** Keep the change scoped to M1. `platform/index.html` owns the workspace layout and M1-only styles. `platform/app.js` owns brand filtering, selected brand state, detail rendering, related/competitor lists, social source actions, AI enrichment, and exports. Existing backend routes remain the source for enrichment and brand persistence.

**Tech Stack:** Plain HTML/CSS/JavaScript, Express, SQLite, node:test static regression checks.

---

### Task 1: Lock The Expected M1 Workspace Surface

**Files:**
- Create: `platform/server/tests/brand_workspace_ui.test.js`

- [ ] **Step 1: Write the failing test**

Create a node:test file that reads `platform/index.html` and `platform/app.js` and asserts the new M1 workspace ids/functions exist while PPT bridge assets remain unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform/server && node --test tests/brand_workspace_ui.test.js`

Expected: FAIL because the old M1 does not contain the new workspace ids.

### Task 2: Replace The Old M1 Shell

**Files:**
- Modify: `platform/index.html`

- [ ] **Step 1: Replace only the M1 HTML block**

Replace the old `page-m1` content with a three-zone workspace: taxonomy rail, searchable brand list, and selected brand detail panel.

- [ ] **Step 2: Add M1-only CSS**

Add `.brand-workspace-*` classes without changing global PPT, proposal, or admin styles.

### Task 3: Implement M1 Workspace Behavior

**Files:**
- Modify: `platform/app.js`

- [ ] **Step 1: Add selected brand state and normalization helpers**

Add helpers for social metrics, brand tags, content angles, related brands, and source links.

- [ ] **Step 2: Update filtering/rendering**

Make `filterBrands()` render list results and keep a selected detail panel populated.

- [ ] **Step 3: Wire actions**

Wire AI Search, CSV export, related brand selection, social source opening, CRM/demand handoff, and knowledge archive indicators.

### Task 4: Verify And Deploy

**Files:**
- Modify: `CHANGELOG.md`
- Add: `archive/versions/2026-07-02-v0.2.5-brand-intelligence-workspace.md`

- [ ] **Step 1: Run syntax and test checks**

Run `node --check` for changed JS and server files, `npm test` in `platform/server`, and a browser smoke of M1 plus PPT version.

- [ ] **Step 2: Deploy**

Deploy only after checks pass, then verify remote service and M1/PPT smoke online.

- [ ] **Step 3: Record and commit**

Update changelog/version archive, commit, push, and report evidence.
