# CRM Task Reassignment and Editing / CRM 待办编辑与负责人转交实施计划

**Goal / 目标:** Complete the customer-detail task loop by allowing authorized users to edit an open task and reassign it to an eligible member of the task's current team. / 在现有客户详情中补齐任务闭环，让授权用户可编辑未完成任务，并把负责人转交给任务当前团队内的合格成员。

**Release / 版本:** `v0.9.10-crm-task-reassignment-editing`

**Architecture / 架构:** Keep schema `v22` and the current customer board/detail UI. Add a strict task-update command, one scoped assignee-candidate read, server-projected `can_update`, and optimistic concurrency based on the current task snapshot. Reuse the existing task dialog and preserve create/complete/cancel behavior. / 保持数据库版本 `v22` 与现有客户看板、客户详情界面不变；新增严格的任务更新命令、同团队候选负责人查询、服务端下发的 `can_update`，并基于当前任务快照做乐观并发控制；复用现有任务弹窗，不改变创建、完成、取消语义。

## Scope / 开发范围

- Add `PUT /api/customers/:customerId/tasks/:taskId` with exactly seven fields: `title`, `description`, `due_at`, `owner_user_id`, `expected_updated_at`, `expected_owner_user_id`, and `expected_team_id`.
- 新增严格七字段的任务更新接口；拒绝未知字段，不允许客户端修改 `team_id`、关联商机、来源或状态。
- Add `GET /api/customers/:customerId/tasks/:taskId/assignee-candidates`; return only active, read-write members of the task's current team as `{ user_id, display_name }`.
- 候选接口与更新接口共用业务授权：组织管理员、客户负责人、当前任务负责人三者之一，并同时通过 `crm.task.update`。
- Update only `open` tasks through one CAS statement matching task id, organization, customer, status, prior update token, prior owner, and prior team.
- 生成严格递增的新 `updated_at`，避免同一秒连续保存绕过并发检查；不匹配统一返回 `409 CRM_TASK_CONFLICT`。
- Write `task_updated` customer activity and bounded audit metadata in the same immediate transaction; never write title or description content to audit metadata.
- Customer detail returns server-owned `can_update`; the browser shows edit only for `open && can_update === true`.
- Reuse the existing task dialog for edit mode, load candidates on demand, retain the user's draft on conflict, and refresh the current customer detail after success or conflict.
- Preserve schema `v22`, customer dashboard/detail separation, frozen PPT bytes, task create/complete/cancel semantics, and all unrelated modules.

## TDD Tasks / 测试先行任务

### 1. Production deploy gate / 生产部署门

- Update the contract test to require schema `22` in the trusted no-op source allowlist and reject the previous `21`-only pattern.
- Add a focused trusted-source test proving managed source `22` is accepted without adoption while unsupported `23` is rejected.
- Change only the secondary source-version allowlist in `platform/deploy_v8.ps1` from `21` to `22`.

### 2. Service and API / 服务与接口

- Add failing service tests for authorized edit, same-team reassignment, candidate filtering, read-only and same-team coworker denial, cross-team/inactive candidate rejection, terminal-task rejection, stale snapshot conflict, strictly increasing token, and evidence rollback.
- Add failing HTTP and request-pipeline tests for the GET and PUT routes, named permission before body parsing, strict seven-field projection, bounded response, and `CRM_TASK_CONFLICT` mapping.
- Implement the strict service command, candidate read, shared eligibility query, server-projected task authority, routes, contract policies, and error mapping.

### 3. Existing customer-detail UI / 现有客户详情交互

- Add failing UI tests for `open + can_update`, edit prefill, candidate loading, PUT payload, empty description clearing, stale async guards, conflict handling, focus restoration, and responsive fixed controls.
- Reuse the task dialog for create/edit modes; do not load candidates during create mode and do not change the existing create payload.
- Keep user input visible on conflict, refresh server data, and show a concise retry message.

### 4. Focused release / 聚焦发布

- Run only affected service, HTTP, request-pipeline, UI, deployment-source, and release-contract tests plus JavaScript syntax, contract, secret, UTF-8, diff, and frozen-PPT checks.
- Complete one independent code review; close every P1/P2 finding before release.
- Commit and push source, create and verify a production backup, deploy in the same turn, then run authenticated online acceptance for edit, reassignment, conflict, permission denial, candidate scoping, and unchanged close actions.
- Synchronize `CHANGELOG.md`, repository version record, Obsidian archive, GitHub, and the visual progress board.

## Acceptance / 验收标准

- Organization admin, customer owner, and current task owner can edit an open task; an ordinary same-team coworker cannot.
- The candidate list contains only active, read-write members of the current task team and exposes no email, username, role, or other-team data.
- Title, description, due time, and owner update atomically; cross-team reassignment, terminal tasks, stale snapshots, and changed ownership/team fail without partial writes.
- Two saves using the same snapshot cannot both succeed, including within the same second.
- One successful update writes one bounded `task_updated` audit record and customer activity; evidence failure rolls the task update back.
- The edit control appears only when the server returns `can_update: true`; create, complete, and cancel remain unchanged.
- Production remains on schema `22`; deployment accepts managed `22`, rejects unsupported `23`, and the frozen PPT SHA-256 remains `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`.

## Release Cadence / 发布节奏

This slice follows the approved accelerated cadence: one independently useful feature, focused affected checks, one independent review, verified backup, immediate production deployment, and online acceptance. Full suites remain reserved for phase closeout or hard-risk shared changes. / 本轮遵循已批准的加速节奏：一个独立可用功能、受影响范围验证、一次独立审查、可验证备份、立即上线和线上验收；全量测试仅保留给阶段收尾或高风险共享变更。
