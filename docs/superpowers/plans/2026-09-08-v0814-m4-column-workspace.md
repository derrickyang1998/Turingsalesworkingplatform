# v0.8.14 M4 Column Workspace / M4 列工作区

## Goal / 目标

Complete the existing M4 shortlist's field-search and reusable-workspace contract without replacing the latest interface: expose the commercial columns users need, persist views by account, and let each user control visible columns and order. / 在不替换最新界面的前提下完成 M4 名单的字段检索与可复用工作区：补齐商业字段、按账号持久化视图，并允许用户管理显示列和顺序。

## Scope / 范围

- Add dedicated cost, client quote, CPM, and CPV display/filter fields while preserving legacy displayed-cost semantics. / 增加成本、客户报价、CPM、CPV 独立展示与筛选，并保留旧展示成本语义。
- Add schema v15 and owner-isolated `/api/influencer-views` list/save/delete APIs with a 20-view account limit and versioned same-name updates. / 增加 schema v15 与按所有者隔离的保存视图 API，每账号最多 20 个视图，同名更新保留版本。
- Add column visibility/order controls, server-backed workspaces, incremental legacy local-view merge, and responsive popover containment inside the existing M4 screen. / 在既有 M4 界面增加列显示/顺序、服务端工作区、旧本地视图增量合并和响应式弹层边界。
- Preserve template/import, global and column search, all/filtered/selected export, campaign context, ordering, Feishu, AI/knowledge, proposal, and frozen PPT behavior. / 保留模板/导入、全局与逐列搜索、三种导出、活动上下文、下单、飞书、AI/知识、方案和冻结 PPT。

## Verification / 验证

1. Prove migration idempotence, owner isolation, validation, legacy-filter compatibility, commercial filters, workspace rendering, and import/export preservation with focused tests. / 用定向测试证明迁移幂等、账号隔离、校验、旧筛选兼容、商业筛选、工作区渲染及导入导出保持。
2. Obtain independent product/frontend and code/security reviews; close every release-blocking finding. / 完成产品/前端及代码/安全独立审查，关闭全部发布阻断项。
3. Create and verify the production backup, run the guarded schema release, then smoke login, four filters, and a uniquely tagged saved-view create/read/update/delete cycle with cleanup. / 创建并验证生产备份，执行受控 schema 发布，再验收登录、四项筛选及唯一标记视图的增删改查与清理。

## Release Outcome / 发布结果

- Production deployed on `2026-09-08`; implementation and gate commits are `2924e8e`, `93e5a26`, and `2a9e1c9`; schema is `v15`. / 已于 `2026-09-08` 上线，schema 为 `v15`。
- Focused M4 `44/44`, migration exactness `15/15`, trusted source `32/32`, deployment contract `57/57`, release contract `37/37`, replay `8/8`, release guard `21/21`, and built-in browser smoke `2/2` passed. / 定向功能、迁移、可信来源与生产发布门禁全部通过。
- Authenticated production smoke completed view create `201`, read/update/delete `200`, row version `2`, four commercial filter requests `200`, and zero saved-view/session residue. / 登录态线上冒烟完成视图创建、读取、覆盖和删除，四项商业筛选均成功且无测试残留。
- Verified backup: `/root/turingmarket/backups/v060-crm-sales-workspace-20260908-071052`; manifest SHA-256 `0e171d07050489d80a2ba30ebb442452affd0665fdb729de99874957c9e42ee8`. / 可恢复备份与清单已完整复验。
