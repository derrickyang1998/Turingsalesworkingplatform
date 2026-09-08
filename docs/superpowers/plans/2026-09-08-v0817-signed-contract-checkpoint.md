# v0.8.17 M4 Signed Contract Checkpoint / M4 签约确认节点

**Goal / 目标:** Add one production-ready signed-contract checkpoint between confirmed ordering and execution for campaign-linked v2 collaboration orders. / 在活动关联的 v2 合作订单“确认下单”和“开始执行”之间增加一个可上线的签约确认节点。

**Release cadence / 发布节奏:** Run only affected tests, one independent review, recoverable backup, immediate production deployment, and authenticated online smoke. / 仅运行受影响测试、一次独立审查、可恢复备份，随后立即部署生产并做登录态线上冒烟。

## Scope / 范围

- Keep `confirmed -> contract_sent`, displayed as `合同待回签`. / 保留“已确认 -> 合同待回签”。
- Add `confirmed|contract_sent -> contracted` through signed-contract evidence. / 通过签约证据新增“已确认或合同待回签 -> 已签约”。
- Require v2 orders to be `contracted` before entering `live`; grandfather already-live/completed orders and preserve v1/legacy behavior. / v2 新版订单必须先签约才能进入执行；既有执行中/已完成订单及 v1/历史订单保持兼容。
- Store the confirmation as immutable campaign knowledge evidence linked to the campaign, while keeping sensitive fields out of indexed chunk content. / 将确认记录保存为活动归属的不可变知识证据，敏感字段不进入可检索正文切片。
- Add a compact confirmation modal and show the persisted evidence in the existing M4 table. / 在现有 M4 表格中增加紧凑确认弹窗并展示已保存证据。
- Add missing `合同待回签`、`已签约`、`内容审核` status filters. / 补齐状态筛选项。

## Contract / 合同

`POST /api/collaborations/:id/contract-confirmations`

- Required JSON: `campaign_id`, `expected_version`, `contract_reference`, `counterparty_name`, `signed_at`, `confirmation_note`.
- Required headers: `Idempotency-Key`; `X-Request-Id` remains supported by the shared request pipeline.
- Server-generated: `confirmed_by`, `confirmed_at`.
- Errors: `400 INVALID_CONTRACT_CONFIRMATION`, `404 RECORD_NOT_FOUND`, `409 STALE_COLLABORATION_VERSION`, `409 INVALID_COLLABORATION_TRANSITION`, `409 CONTRACT_ALREADY_CONFIRMED`, `409 CONTRACT_CONFIRMATION_REQUIRED`.

## TDD And Acceptance / 测试与验收

1. Add failing service, route, client, and request-policy tests. / 先增加失败的服务、路由、前端和请求策略测试。
2. Implement the smallest server and M4 changes needed to pass them. / 实施最小服务端与 M4 改动。
3. Run affected collaboration/request/client tests, syntax, diff, secret scan, and frozen PPT hash check. / 运行受影响测试、语法、差异、密钥扫描与冻结 PPT 哈希检查。
4. Obtain independent review and fix blocking findings. / 独立审查并修复阻断项。
5. Commit, backup, deploy production, verify health/login/M4/contract route, then sync changelog, version record, roadmap, progress dashboard, Obsidian, and GitHub. / 提交、备份、上线、验证健康/登录/M4/签约接口后，同步变更记录、版本记录、路线图、进度看板、Obsidian 与 GitHub。

## Deferred / 延后

Negotiation term revisions, contract file uploads, e-signature providers, content-review evidence, publication proof, payment ledger, settlement expansion, and review integration remain separate feature releases. / 谈判条款版本、合同文件上传、电子签平台、内容审核证据、发布证明、付款台账、结算扩展及复盘串联继续拆分为后续独立功能。
