# CRM Task Role Permissions Implementation Plan

**Goal:** Apply the existing organization-scoped permission model to CRM task creation and closure without changing the accepted customer interface or task data model.

**Release:** `v0.9.7-crm-task-role-permissions`

**Architecture:** Extend the fail-closed module/action permission service with `crm.task`, project it through login and `/api/auth/me`, guard the existing create/complete/cancel routes, and reject unauthorized task writes before request-body parsing. Keep schema `v21`, the current product shell, and the frozen PPT renderer unchanged.

## Scope

- Add `crm.task.read`, `crm.task.create`, and `crm.task.update` within the active organization.
- Give company owner, organization administrator, manager, and member roles read/create/update; give read-only roles read only. Platform-admin status alone grants no tenant task access.
- Treat complete and cancel as `crm.task.update`.
- Persist only bounded permission-denial evidence. Never retain raw paths, bodies, titles, tokens, passwords, or credentials.
- Match supported case variants, trailing slashes, and malformed identifiers before body parsing.
- Close denied requests that still have unread bodies so a client cannot keep the application connection occupied.
- Preserve existing CRM custody checks after named permission succeeds.
- Do not add a task list, task editor, schema migration, ownership transfer, or unrelated UI change in this slice.

## Delivery Checklist

- [x] Add failing policy and route tests for task read/create/update projections and read-only denial.
- [x] Add real HTTP tests for malformed JSON, case/trailing-slash variants, invalid identifiers, bounded audit, writable parser behavior, and a slow unread request body.
- [x] Implement the central policy, login/session projection, route middleware, pre-parser ingress guard, bounded audit, and connection closure.
- [x] Run focused affected tests, syntax, diff, UTF-8, credential, frozen-PPT, and local deployment checks.
- [x] Complete independent scope/backend review; close the unread-body connection finding; receive final `APPROVE` with no P1/P2.
- [x] Push the source, create a verified backup, deploy immediately, and run authenticated production smoke tests.
- [x] Synchronize the changelog, handoff, repository records, Obsidian archive, GitHub, and visual progress board.

## Acceptance

- Administrator and writable organization roles project `read/create/update`; read-only projects `read`.
- Unauthorized create, complete, and cancel requests return `403 CRM_PERMISSION_FORBIDDEN` before malformed JSON is parsed.
- Slow denied request bodies receive `Connection: close` promptly.
- Authorized task create and cancel complete through the existing production API and remain subject to CRM custody rules.
- The latest CRM pages and all M3/M4, AI/knowledge, influencer, Feishu, workflow, export, and PPT behavior remain unchanged.

## Next Slice

- Add the bounded task read model and controls inside the existing customer-detail experience as a separate feature release, or separately design ownership transfer.
- Continue the cadence: one useful feature, affected checks, one independent review, verified backup, immediate production deployment, and named online smoke.
