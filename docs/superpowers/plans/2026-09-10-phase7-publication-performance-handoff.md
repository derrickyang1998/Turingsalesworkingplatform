# Phase 7 Publication To Performance Handoff / 阶段 7 发布到效果追踪交接

**Goal / 目标：** When an approved collaboration is confirmed as published, require the operator to record the final public deliverable links and register them in the existing campaign performance monitor in the same transaction, without creating a new page. / 当已审核合作确认发布时，要求运营人员登记最终公开交付链接，并在同一事务内把它们写入现有效果追踪，不新增页面。

## Scope / 范围

- Reuse the existing canonical URL parser and `campaign_publications` store. / 复用现有规范链接解析和 `campaign_publications` 存储。
- Never infer the final public URL from the content-review URL, which may only be a preview or review link. / 不从内容审核链接推断最终公开链接，因为它可能只是预览或审核地址。
- Preserve immutable lineage from campaign, collaboration, explicit deliverable key, order reference, review evidence, publication relation, actor, and tracked publication. / 保留活动、合作、显式交付项键、订单编号、审核凭证、发布关系、操作人和追踪内容的不可变血缘。
- Accept 1-20 final public deliverables in one confirmation. Reuse an existing canonical campaign publication when the link was registered earlier; reject a canonical link already bound to another deliverable. / 一次确认支持 1-20 个最终公开交付项；链接已提前登记时复用同活动的规范内容，已绑定其他交付项时拒绝冲突。
- Project the tracking result into collaboration list/detail responses and add a compact M4 evidence link that opens the existing content monitor with the same campaign selected. / 在合作列表和详情响应中投影追踪结果，并在 M4 增加紧凑入口，打开现有内容监控并选中同一活动。
- Keep the existing frozen PPT renderer and all unrelated screens unchanged. / 保持冻结 PPT 渲染器及无关页面不变。

## Implementation / 实现

1. Add focused failing tests for the dedicated confirmation contract, final-link validation, multiple deliverables, canonical creation, replay/idempotency, pre-existing publication reuse, cross-deliverable duplicate rejection, atomic rollback, authorization isolation, API projection, and M4 navigation/toast behavior. / 先补专用确认契约及关键风险的定向失败测试。
2. Add migration 017 with append-only `collaboration_publication_custody`, uniquely binding each collaboration deliverable key and tracked publication to its review and confirmation evidence. / 新增迁移 017，以只追加的发布保管表唯一绑定交付项、追踪内容、审核与确认凭证。
3. Add `POST /api/collaborations/:id/publication-confirmations`; reject v2 publication attempts through the generic collaboration update endpoint. / 新增专用发布确认接口，并拒绝 v2 通过通用更新接口绕过。
4. Refine the narrow publication-handoff service and inject it into `campaign_collaboration_service`; commit status, relation, event, tracked publications, custody, non-retrieval knowledge provenance, archive, and idempotency result in one immediate transaction. / 完善窄职责交接服务，在同一即时事务内提交状态、关系、事件、追踪内容、保管、不可检索知识血缘、归档和幂等结果。
5. Add a compact final-publication confirmation modal, current M4 evidence, tracking button, campaign-context navigation, and focused client tests without redesigning the page. / 在现有 M4 增加紧凑的最终发布确认弹窗、证据、追踪入口和活动上下文跳转，不重做页面。
6. Run affected service/client/route/migration tests, syntax and release contracts, independent review, verified backup, guarded production deploy, authenticated production smoke, then synchronize release records. / 运行受影响定向测试、语法和发布契约、独立审查、可验证备份、受控生产发布和登录态验收，再同步版本记录。

## Acceptance / 验收

- One publication confirmation creates exactly one trackable campaign content and immutable custody record per explicit deliverable. / 一次确认发布为每个显式交付项各生成一条可追踪内容和不可变保管记录。
- Replaying the same request returns the same publication IDs without duplicate rows. / 重放同一请求返回相同内容 ID，不产生重复记录。
- The approved review URL remains review evidence only; only explicitly confirmed final public URLs enter performance tracking. / 已审核链接只作为审核证据，只有显式确认的最终公开链接进入效果追踪。
- Manual registration of the same canonical link is still rejected as a duplicate. / 后续手工登记同一规范链接仍被判重。
- A user without campaign access cannot discover the handoff or publication. / 无活动权限的用户无法发现交接或内容。
- M4 shows `已加入效果追踪` and opens the existing content monitor on the correct campaign. / M4 显示“已加入效果追踪”，并打开正确活动的现有内容监控。
- Any handoff or provenance failure rolls back collaboration status, relation, archive, and publication together. / 交接或血缘写入失败时，合作状态、关系、归档和内容登记整体回滚。
