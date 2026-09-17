# CRM Contact Management And Role Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Follow RED -> GREEN for every behavior change.

**Goal:** Deliver a complete, visible CRM contact workflow inside the existing customer-detail interface and enforce organization-scoped `crm.contact` permissions on every contact read and mutation path.

**Release:** `v0.9.6-crm-contact-management-role-permissions`

**Architecture:** Extend the existing fail-closed module/action permission service, customer-detail aggregate, contact mutation service, login projection, and current sidebar/modal patterns. Do not add a second authorization system or a new standalone contacts page. Keep schema `v21` and preserve the latest accepted product shell and frozen PPT renderer.

**Spec:** `docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md`, Phase 8 and shared delivery gates.

## Global Constraints

- Add organization-scoped `crm.contact.read`, `crm.contact.create`, and `crm.contact.update`.
- `read` is available to company owner, organization administrator, manager, member, and read-only roles in the live organization. `create` and `update` are unavailable to read-only users. Platform-admin status alone grants no tenant contact access.
- Treat contact archive as `crm.contact.update`; retain soft archive and do not add hard delete.
- Keep domain custody rules authoritative after module permission succeeds. Do not widen same-team mutation access or bypass customer ownership rules.
- Customer detail must require embedded contact read permission and return active contacts only, ordered with the primary contact first and a bounded maximum of 100 records.
- Selecting a new primary contact atomically clears the previous active primary contact for the same customer. Archive clears primary status.
- Preserve existing customer dashboard/detail split, CRM tasks, workflow tasks, M3/M4, AI/knowledge, Feishu, exports, and frozen PPT behavior.
- No database migration, standalone contact page, bulk import, ownership transfer, task permissions, or unrelated UI redesign.
- Ordinary feature cadence applies: affected tests, syntax/security checks, one independent review, verified backup, immediate production deployment, online role smoke, and synchronized records.

## Task 1: RED Permission, Aggregate, And Ingress Contracts

- [ ] Add failing policy tests for writable, read-only, platform-admin-only, missing organization, malformed organization, and exact action projection.
- [ ] Add failing customer-detail tests proving active contacts are returned in deterministic primary-first order, archived contacts are omitted, and contact metadata is bounded.
- [ ] Add failing HTTP tests proving customer detail requires `crm.contact.read`; contact create uses `create`; update and archive use `update`; denial stops before command parsing/service dispatch and writes bounded audit evidence.
- [ ] Add failing real-server ingress tests for malformed JSON, case variants, trailing slashes, invalid/noncanonical customer/contact IDs, audit failure, and writable requests reaching the parser.
- [ ] Run only the new/affected tests and record the expected RED failures.

## Task 2: Backend Contact Permission And Read Model

- [ ] Extend `module_action_permission_service.js` and login `module_permissions` projection with `crm.contact`.
- [ ] Add embedded contact-read middleware to customer detail and named create/update middleware to all three contact mutation routes.
- [ ] Generalize the pre-body-parser CRM mutation guard so contact mutations are matched exactly across Express-compatible path variants without matching extra segments.
- [ ] Record only bounded audit fields. Canonical safe IDs may enter `target_id`; invalid/noncanonical segments must become `null`; never record request body, query, raw path segment, token, password, or API key.
- [ ] Extend `getCustomerDetail` with an active-contact projection and bounded metadata while preserving existing customer, opportunity, and activity contracts.
- [ ] Make primary-contact replacement atomic inside the existing mutation transaction.
- [ ] Run the Task 1 tests to GREEN plus existing contact aggregate tests.

## Task 3: Existing-UI Contact Workflow

- [ ] Add failing UI tests for contact rendering, empty state, permission-aware controls, accessible add/edit dialog, escaped server content, non-success responses, archive confirmation, and detail refresh.
- [ ] Add `currentUserHasCrmContactPermission(action)` using only the server projection.
- [ ] Add a compact `联系人 (N)` section to the existing customer-detail sidebar using the established contact-card styling.
- [ ] Show name, role, email, phone, and primary marker. Encode link destinations and escape all visible server values.
- [ ] Add one accessible add/edit dialog with required name, optional role/email/phone, primary checkbox, focus management, and clear create/edit state.
- [ ] Show add/edit/archive controls only when the projected action is present. Read-only users retain contact visibility and receive explanatory unavailable text/tooltips.
- [ ] Archive only after confirmation with wording that the record is archived rather than permanently deleted.
- [ ] Refresh the open customer detail after successful create/update/archive so contacts and activity evidence update immediately.
- [ ] Run the Task 3 tests to GREEN and re-run the affected backend/UI matrix.

## Task 4: Independent Review And Release Gate

- [ ] Run JavaScript syntax, `git diff --check`, focused credential scan, strict UTF-8/mojibake scan, frozen-PPT hash, and local deploy preflight.
- [ ] Independent backend/security reviewer checks authorization order, route coverage, tenant/custody scope, audit bounds, primary-contact transaction behavior, and failure closure.
- [ ] Independent frontend/product reviewer checks permission affordances, XSS resistance, accessibility, focus, error states, responsive containment, and preservation of the latest CRM interface.
- [ ] Resolve all HIGH/MEDIUM/P1/P2 findings and re-run only covering tests.

## Task 5: Production Delivery And Records

- [ ] Commit and push the accepted source to the production delivery branch.
- [ ] Create and verify rollback backup, then deploy immediately with the guarded release script.
- [ ] Verify public health/login/customer pages plus administrator, writable member, read-only, and unauthorized contact paths; verify primary replacement, soft archive, bounded audit, cleanup, schema `v21`, SQLite integrity, PM2, and Nginx.
- [ ] Roll back immediately if any mandatory smoke fails.
- [ ] Update the roadmap, `CHANGELOG.md`, migration handoff, repository version record/archive copy, Obsidian archive, GitHub, and the visual progress board; verify local/remote SHAs and file hashes.

## Acceptance Criteria

- Customer detail visibly supports active contact viewing and authorized add/edit/archive without leaving the existing page.
- Read-only users can read contacts and cannot mutate them; writable users still remain subject to customer custody rules.
- Every contact route and embedded read is protected by the central named permission service, including malformed and case-variant ingress before body parsing.
- Primary replacement is atomic, archived contacts disappear from detail, and hard delete remains unavailable.
- No existing CRM, task, workflow, AI/knowledge, influencer, Feishu, export, or PPT behavior is replaced or regressed.
- Production is backed up, deployed, remotely verified, independently approved, archived, pushed, and reversible.
