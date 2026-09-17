# CRM Task Workspace Implementation Plan

**Goal:** Add a bounded, tenant-scoped task list and permission-aware task actions to the existing customer-detail experience.

**Release:** `v0.9.8-crm-task-workspace`

**Architecture:** Extend the existing customer-detail aggregate with a bounded task collection, protect that aggregate with `crm.task.read`, and reuse the current task create/complete/cancel APIs from an accessible task section in the existing detail drawer. Keep schema `v21`, the current customer board/detail split, and the frozen PPT renderer unchanged.

## Scope

- Return at most 100 customer tasks from the active organization, ordered open first, then due date, then newest id.
- Include task owner display name, status, due time, description, completion details, and linked opportunity id without exposing cross-organization data.
- Require `crm.task.read` before the customer-detail handler runs.
- Add an in-drawer task section with complete empty, read-only, open, completed, and cancelled states.
- Add an accessible create-task dialog that defaults assignment to the customer's current owner and team.
- Show create controls only with `crm.task.create`; show complete/cancel controls only with `crm.task.update` and only for open tasks.
- Refresh the same customer detail after successful task mutations while preserving stale-response protection and focus.
- Do not add a standalone task page, schema migration, reassignment UI, hard delete, or unrelated visual redesign.

## Delivery Checklist

- [x] Add failing query, HTTP permission-chain, UI rendering, interaction, and responsive-layout tests.
- [x] Implement the bounded task read model and task-read middleware on customer detail.
- [x] Implement exact server-projected browser permission checks and the in-drawer task controls.
- [x] Run only affected tests plus syntax, diff, credential, UTF-8, and frozen-PPT checks.
- [x] Complete independent code review and close all P1/P2 findings.
- [ ] Commit and push source, create a verified production backup, deploy immediately, and run authenticated online smoke tests.
- [ ] Synchronize changelog, handoff, repository record, Obsidian archive, GitHub, and the visual progress board.

## Acceptance

- A permitted customer detail returns only same-organization tasks for that customer and reports `{ limit: 100, has_more }`.
- Open tasks are shown before closed tasks; open tasks are due-date ordered; the result remains immutable.
- Missing `crm.task.read` returns `403 CRM_PERMISSION_FORBIDDEN` before the detail query service runs and writes bounded permission evidence.
- Read-only users can view tasks but cannot render or invoke create, complete, or cancel controls.
- Writable users can create, complete, and cancel through the existing APIs; successful actions refresh the same drawer and stale responses cannot overwrite newer state.
- Desktop and 320px mobile layouts contain long legal task titles/descriptions without horizontal overflow.
- M3/M4, AI/knowledge, influencer, Feishu, workflow, export, and PPT behavior remain unchanged.

## Release Cadence

This slice follows the approved accelerated cadence: one feature, focused affected checks, one independent review, verified backup, immediate production deployment, and named online acceptance. Full-suite regression remains reserved for phase closeout or high-risk shared changes.
