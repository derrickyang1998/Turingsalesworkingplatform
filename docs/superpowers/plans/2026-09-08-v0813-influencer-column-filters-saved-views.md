# v0.8.13 Influencer Column Filters And Saved Views

## Goal / 目标

Make the existing M4 influencer shortlist usable at production volume without changing the latest product shell: users can filter each displayed field, keep the two-row header visible while scrolling, and reuse bounded browser-local filters. / 在不更换最新产品界面的前提下，让 M4 网红名单可在生产数据量下操作：逐列筛选、滚动时双层表头保持可见，并可复用有界的浏览器本地筛选条件。

## Scope / 范围

- Add filters for ID, handle, platform, followers, project, product, region, type/tags, parent record, profile link, deliverable, and displayed cost. / 为当前显示字段增加逐列筛选。
- Reuse one validated server query builder for list and filtered export. / 列表与筛选导出共用一套经校验的后端查询。
- Keep the table shell mounted, debounce input, and ignore stale responses. / 保持表头挂载、输入防抖并忽略陈旧响应。
- Save at most 20 allowlisted filter views in the current browser under the current user ID; clear active filters when the login user changes. / 当前浏览器按用户 ID 最多保存 20 个白名单筛选视图，切换账号时清空活动筛选。
- Preserve import, selection/export, campaign context, ordering, Feishu fallback, AI/knowledge, proposal, and PPT behavior. / 保持导入、选择/导出、活动、下单、飞书降级、AI/知识、方案和 PPT 行为。

## Verification / 验证

1. Write failing list/export, malformed-filter, and frontend contract tests. / 先补失败测试。
2. Implement the shared filters and stable table interaction in the existing M4 surface. / 在既有 M4 页面实现。
3. Run affected tests, syntax, secret scan, diff check, and one independent review. / 执行聚焦验证与独立审查。
4. Create a verified backup, deploy immediately, and accept the online read-only paths without creating business data. / 创建可验证备份后立即上线，以只读路径验收且不制造业务数据。

## Release Outcome / 发布结果

- Production deployed on `2026-09-08`; implementation commit `94bdbcb`; schema remains `v14`. / 已于 `2026-09-08` 上线，schema 保持 `v14`。
- Focused tests `52/52`; independent review `APPROVE`; candidate replay `8/8`; release guard `21/21`; built-in browser smoke `2/2`. / 聚焦测试与发布门禁全部通过。
- Public health/home `200`; anonymous filter `401`; authenticated exact filter, invalid-filter contract, and one-row filtered export passed; acceptance session removed. / 公网健康、权限及只读筛选/导出均通过，临时会话已清理。
- Verified backup: `/root/turingmarket/backups/v060-crm-sales-workspace-20260908-045018`. / 可恢复备份已验证。
