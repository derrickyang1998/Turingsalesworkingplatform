# v0.8.21 Campaign Closeout Review / 项目结案复盘

**Goal / 目标:** Complete the existing M4 campaign execution loop with a human-confirmed closeout review that is archived to the knowledge base and advances a settled campaign to `reviewed`. / 在现有 M4 活动执行链路中补齐人工确认的结案复盘，将成果归档到知识库，并把已结算活动推进到 `reviewed`。

**Scope / 范围:** Reuse the accepted Campaign review and lifecycle APIs. Modify only the existing M4 context controls, client behavior, focused tests, and release records. No schema migration, new page, visual redesign, AI provider, Feishu provider, or PPT change. / 复用已验收的活动复盘与生命周期接口，仅修改现有 M4 上下文控件、客户端行为、聚焦测试和版本记录；不做数据库迁移、新页面、视觉重构、AI/飞书服务商或 PPT 改动。

## Contract / 功能契约

- Only a selected, active, `settled` campaign exposes an enabled `结案复盘` command; `reviewed` campaigns show a completed state and earlier states explain that settlement is required first. / 仅已选择、启用且处于 `settled` 的活动可执行“结案复盘”；`reviewed` 显示完成状态，更早阶段提示需先完成结算。
- The existing-style accessible dialog captures title, executive summary, outcomes, reusable methods, problems/root causes, next actions, optional client-report reference, and private/team visibility. / 沿用现有无障碍弹窗，采集标题、总结、成果、可复用方法、问题与根因、下一步行动、可选客户报告引用及个人/团队可见性。
- Human confirmation first calls `POST /api/campaigns/:id/reviews`, then advances the returned campaign version through `POST /api/campaigns/:id/transitions` to `reviewed`. / 人工确认后先调用复盘归档接口，再以返回的活动版本调用状态推进接口进入 `reviewed`。
- The knowledge content uses deterministic headings and includes a compact execution snapshot derived from the currently loaded campaign collaborations. Sensitive payment references are never copied. / 知识内容使用固定章节，并包含由当前合作记录派生的精简执行快照；不复制敏感收付款凭证号。
- Stable idempotency keys, duplicate-click locking, reload on stale state, and recovery from an already-created review keep interrupted two-step completion replayable. / 使用稳定幂等键、防重复点击、过期状态刷新，以及已归档复盘后的继续结案机制，确保两步流程可恢复。

## Delivery / 交付

1. Add failing focused client tests for action state, payload composition, request order, version handoff, and recovery.
2. Implement the smallest M4 UI/client change needed to pass those tests.
3. Run only the affected M4 client, Campaign API, static security, and JavaScript syntax checks; widen only if a shared contract fails.
4. Obtain one independent code review, resolve blockers, back up production, deploy immediately, and run authenticated production acceptance with transaction-safe cleanup.
5. Update the roadmap, changelog, bilingual version records, Obsidian archive, GitHub, and the external progress dashboard.

## Acceptance / 验收

- A settled production campaign can be reviewed once, archived as `campaign_review`, linked as both `knowledge` and `review`, and advanced to `reviewed`.
- The UI cannot submit incomplete content or start duplicate requests; a lost response can be retried without duplicate knowledge.
- Existing M4 import, search, collaboration, contract, content review, publication, payment, settlement, Feishu, knowledge, and PPT behavior remains unchanged.
- Focused local checks, independent review, production health/auth checks, online closeout roundtrip, cleanup, and source/runtime hash verification pass.
