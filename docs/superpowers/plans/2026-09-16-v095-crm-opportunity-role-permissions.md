# CRM Opportunity Role Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-enforced `crm.opportunity` `read/create/update` permissions, tenant-safe scope enforcement, auditable decisions, and matching controls in the existing CRM interface.

**Status:** Complete and production-verified on `2026-09-17`. Source `a4a91cf7341fc7623bd4bf0329c6d5fa8abd6d94`; guarded run `e35726dff0d348c7968e4e3c640f3d8a`; rollback backup `/root/turingmarket/backups/v060-crm-sales-workspace-20260917-145108`.

**Architecture:** Extend the existing fail-closed module/action permission service and login projection rather than creating a second authorization system. Reuse the current customer ownership/team/organization query boundaries, but require the named opportunity permission on every direct opportunity route and on customer detail because that payload embeds opportunity records. Keep the current UI and database schema unchanged; only hide or block opportunity write affordances when the projected action is absent.

**Tech Stack:** Node.js 20, Express 5, SQLite through `better-sqlite3`, browser JavaScript, Node test runner.

**Spec:** `docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md` Phase 8, especially lines 396-422 and 518-533.

## Global Constraints

- This is the independently deployable `v0.9.5-crm-opportunity-role-permissions` Phase 8 slice.
- Keep schema at `v21`; do not add a migration.
- Preserve the latest customer dashboard/detail split, product shell, M3/M4, AI/knowledge, Feishu, workflow, exports, and frozen PPT behavior.
- `crm.opportunity.read` is allowed for company owner, administrator, manager, member, and read-only roles inside the live organization.
- `crm.opportunity.create` and `crm.opportunity.update` are allowed for company owner, administrator, manager, and member roles, but never read-only.
- Platform-admin status alone never grants tenant opportunity data access.
- Organization-wide and team-wide reads keep the same scope rules as CRM customers; denied scope widening and organization-wide reads produce bounded audit evidence without query content.
- Direct opportunity list/detail/create/update routes and the opportunity collection embedded in customer detail must be permission protected.
- Opportunity hard delete remains unavailable; contacts and tasks stay outside this release.
- Use test-first red/green cycles and the ordinary lightweight release gate: affected tests, syntax, focused security/secret checks, `git diff --check`, one independent review, verified backup, immediate production deployment, and online core-path smoke.

---

### Task 1: Central Opportunity Policy And Authentication Projection

**Files:**
- Modify: `platform/server/tests/module_action_permission_service.test.js`
- Modify: `platform/server/tests/phase4_server_integration.test.js`
- Modify: `platform/server/services/module_action_permission_service.js`
- Modify: `platform/server/server.js`

**Interfaces:**
- Consumes: `createModuleActionPermissionService(db).authorize(...)` and `.projectModuleAccess(...)`.
- Produces: exported `CRM_OPPORTUNITY_MODULE`, `CRM_OPPORTUNITY_READ_ACTION`, `CRM_OPPORTUNITY_CREATE_ACTION`, and `CRM_OPPORTUNITY_UPDATE_ACTION`; login and `/api/auth/me` projections at `user.module_permissions['crm.opportunity']`.

- [x] **Step 1: Add failing policy tests**

Add assertions that writable organization roles receive `['read', 'create', 'update']`, read-only receives `['read']`, an unrelated platform role receives no action, and missing/corrupt organization IDs fail closed for module `crm.opportunity`.

- [x] **Step 2: Verify the policy tests fail for the missing module**

Run:

```powershell
node --test tests/module_action_permission_service.test.js
```

Expected: failure because `crm.opportunity` is an unknown module or its constants are absent.

- [x] **Step 3: Add failing authentication projection assertions**

Update the existing exact `module_permissions` assertions so normal writable and read-only logins require both:

```js
{
  'crm.customer': expectedCustomerActions,
  'crm.opportunity': expectedOpportunityActions
}
```

- [x] **Step 4: Verify the integration test fails on the missing projection**

Run:

```powershell
node --test tests/phase4_server_integration.test.js
```

Expected: exact-object assertion failure showing the missing `crm.opportunity` key.

- [x] **Step 5: Implement the central policy and projection**

Add the opportunity constants and policy next to the customer module, include it in `ORGANIZATION_SCOPED_MODULES`, export it, and project both module action arrays from `projectModulePermissions(principal, organizationId)`.

- [x] **Step 6: Run focused green tests**

Run:

```powershell
node --test tests/module_action_permission_service.test.js tests/phase4_server_integration.test.js
```

Expected: all tests pass.

---

### Task 2: Route Guards, Scope Audit, And Embedded Opportunity Protection

**Files:**
- Modify: `platform/server/tests/crm_phase5_http.test.js`
- Modify: `platform/server/routes_customers.js`

**Interfaces:**
- Consumes: Task 1 opportunity module/action constants and existing CRM request organization context.
- Produces: `requireCrmOpportunityRead`, `requireCrmOpportunityCreate`, and `requireCrmOpportunityUpdate` middleware using the same problem response and audit sink as customer permissions.

- [x] **Step 1: Add failing route-contract tests**

Require exact authorization calls for:

```text
GET /api/opportunities                    -> crm.opportunity.read
GET /api/opportunities/:id/detail         -> crm.opportunity.read
POST /api/opportunities                   -> crm.opportunity.create
PUT /api/opportunities/:id                -> crm.opportunity.update
GET /api/customers/:id/detail             -> crm.customer.read, then crm.opportunity.read
```

Add a denied-update test proving permission rejection occurs before request parsing/service dispatch and emits `permission: 'crm.opportunity.update'`, `target_type: 'opportunity'`, and a bounded target ID. Add member team/organization scope widening cases for opportunity list reads.

- [x] **Step 2: Verify the route tests fail before implementation**

Run:

```powershell
node --test tests/crm_phase5_http.test.js
```

Expected: failures showing opportunity routes have no named permission checks and customer detail only checks customer read.

- [x] **Step 3: Generalize the existing CRM permission middleware without changing response contracts**

Parameterize module, action, target type, target parameter, and whether scope rules apply. Retain `CRM_PERMISSION_FORBIDDEN`, `CRM_SCOPE_FORBIDDEN`, organization-read audit behavior, and fail-closed audit persistence.

- [x] **Step 4: Protect every opportunity read/write path**

Apply the new opportunity middleware to list, detail, create, and update. Apply opportunity read after customer read on the customer-detail route so embedded records cannot bypass the module policy. Leave hard-delete unavailable.

- [x] **Step 5: Run focused green tests**

Run:

```powershell
node --test tests/crm_phase5_http.test.js tests/module_action_permission_service.test.js
```

Expected: all tests pass.

---

### Task 3: Existing CRM UI Permission Projection

**Files:**
- Modify: `platform/server/tests/customer_workspace_ui.test.js`
- Modify: `platform/index.html`
- Modify: `platform/app.js`

**Interfaces:**
- Consumes: `CURRENT_USER.module_permissions['crm.opportunity']` from Task 1.
- Produces: `currentUserHasCrmOpportunityPermission(action)` and matching presentation guards for create/update controls.

- [x] **Step 1: Add failing static UI contract tests**

Assert that the UI reads `crm.opportunity`, marks the modal save action with an opportunity action attribute, hides create affordances without `create`, prevents `showOppModal` and `saveOpportunity` without their actions, and does not make opportunity table rows editable without `update`.

- [x] **Step 2: Verify the UI test fails**

Run:

```powershell
node --test tests/customer_workspace_ui.test.js
```

Expected: failures for the absent opportunity permission projection and guards.

- [x] **Step 3: Implement minimal UI controls**

Preserve `currentUserHasCrmPermission(action)` as the customer wrapper, add the opportunity helper, extend `applyCrmPermissionPresentation()`, add `data-crm-opportunity-action` to the existing modal save button, conditionally render customer-detail creation and opportunity-list edit behavior, and guard create/save/edit functions before opening or writing.

- [x] **Step 4: Run focused green tests and syntax checks**

Run:

```powershell
node --test tests/customer_workspace_ui.test.js tests/crm_phase5_http.test.js tests/module_action_permission_service.test.js tests/phase4_server_integration.test.js
node --check app.js
node --check server/server.js
node --check server/routes_customers.js
node --check server/services/module_action_permission_service.js
```

Expected: all focused tests and syntax checks pass.

---

### Task 4: Independent Review, Immediate Production Release, And Records

**Files:**
- Modify after acceptance: `CHANGELOG.md`
- Modify after acceptance: `CLAUDE_CODE_MIGRATION.md`
- Modify after acceptance: `docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md`
- Create after acceptance: `docs/version-records/2026-09-16-v0.9.5-crm-opportunity-role-permissions-production.md`
- Create after acceptance: `archive/versions/2026-09-16-v0.9.5-crm-opportunity-role-permissions-production.md`
- Update after acceptance: `C:\Users\29272\Documents\在线商务平台\TuringMarket-开发进度.html`
- Sync after acceptance: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档`

**Interfaces:**
- Consumes: reviewed feature commit and the guarded `platform/deploy_v8.ps1` release path.
- Produces: a verified production run, recoverable backup, online role-matrix evidence, synchronized version records, and matching GitHub/Obsidian state.

- [x] **Step 1: Obtain independent minimal-change and code/security approval**

Review the exact feature diff for tenant bypass, embedded opportunity disclosure, audit data leakage, read-only writes, latest-UI regression, and missing tests. Any HIGH or CRITICAL finding blocks deployment.

- [x] **Step 2: Run the lightweight local release gate**

Run the four affected test files, changed-file `node --check`, focused credential scan, UTF-8/mojibake scan for changed user-facing text, `git diff --check`, and the deploy preflight. Do not run unrelated full suites unless the review reveals a broad-risk trigger.

- [x] **Step 3: Commit and push the reviewed feature**

Use a scoped feature commit, push the production delivery branch, and verify local/upstream SHA equality.

- [x] **Step 4: Create a verified backup and deploy immediately**

Use `platform/deploy_v8.ps1` from the authoritative checkout. Require explicit `DEPLOY_OK`; any mandatory remote failure triggers rollback.

- [x] **Step 5: Run production smoke**

Verify `/api/health`, `/m0`, `/m0-detail`, administrator login, writable role opportunity read/create/update projection, read-only opportunity read-only projection, member scope-widening denial, audit rows, PM2, Nginx, schema `v21`, database integrity, session cleanup, and unchanged frozen PPT hash.

- [x] **Step 6: Publish the release record everywhere**

Record the run ID, backup path/checksum, tested role matrix, review verdict, hashes, and rollback target. Synchronize `CHANGELOG.md`, the bilingual roadmap, migration handoff, repository version records, progress dashboard, Obsidian archive/Git repository, and GitHub; verify final SHAs and archive hashes.
