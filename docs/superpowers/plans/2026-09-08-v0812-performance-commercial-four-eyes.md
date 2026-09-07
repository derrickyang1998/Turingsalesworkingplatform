# v0.8.12 Performance Commercial Four-Eyes Approval

## Goal / 目标

Split commercial-data submission from approval so the submitter cannot approve the same version, while campaign KPI calculations continue using the latest approved commercial baseline until a newer draft receives independent approval. / 将商业数据提交与批准拆开，禁止提交人批准自己的版本；新草稿等待独立复核期间，项目 KPI 继续使用最近一版已批准商业数据。

## Scope / 范围

- Reuse the append-only `performance_manual_inputs` table; no schema migration. / 复用只追加的 `performance_manual_inputs` 表，不新增迁移。
- Add `POST /api/campaigns/:id/performance/manual-inputs/:inputId/approve`. / 新增独立批准接口。
- New commercial submissions are always drafts. The approval actor must be a different authorized owner or organization administrator. / 新商业数据始终先成为草稿，批准人必须是另一位有权限的项目负责人或组织管理员。
- Content rows expose the latest submitted version and the latest approved baseline separately. Financial KPI calculations use only the approved baseline. / 内容记录分别返回最新提交版本与最新已批准基线，财务 KPI 仅使用已批准基线。
- Update the existing content-monitor modal and table with compact pending/approved states and an independent approval command. / 在现有内容监控弹窗和表格中增加紧凑的待复核/已批准状态与独立批准操作。
- Preserve existing proposal/PPT, AI review, observation history, Feishu and provider boundaries. / 保持方案/PPT、AI 复盘、观测历史、飞书和服务商边界不变。

## Steps / 步骤

1. Add failing service tests for distinct approver enforcement, stale-draft rejection, idempotent approval replay, stable approved KPI selection, and restricted-field redaction. / 先补失败测试。
2. Add the protected route and request-policy contract. / 增加受保护接口与请求策略。
3. Implement append-only approval and separate latest-submitted/latest-approved projections. / 实现只追加批准及双版本投影。
4. Replace the self-confirm checkbox with submit-for-review and independent-approval interactions in the current UI. / 替换同人确认勾选框。
5. Run affected tests, syntax, secret scan and diff checks; obtain one independent review and fix blockers. / 执行聚焦验证并完成独立审查。
6. Create a verified production backup, deploy, run online acceptance, and sync CHANGELOG, version record, Obsidian, GitHub and progress board. / 备份、上线、远端验收并同步版本记录。

## Acceptance / 验收

- A commercial submitter cannot approve the same input, even if they hold approval capability. / 提交人即使具备批准权限也不能自批。
- Only the current draft can be approved; retries return the existing approval without creating duplicates. / 仅当前草稿可批准，重试不产生重复记录。
- A pending replacement draft never removes or changes KPI values calculated from the previous approved baseline. / 待复核新草稿不改变上一已批准 KPI。
- After independent approval, all authorized list/dashboard/export reads select the new approved version consistently; restricted data remains hidden from ordinary members. / 独立批准后各读取口径一致，普通成员仍不可见受限数据。
- Production health, protected-route behavior, database integrity, runtime hashes and rollback backup are verified. / 验证生产健康、受保护接口、数据库完整性、线上文件与回滚备份。
