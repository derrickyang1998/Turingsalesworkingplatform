# v0.8.19 M4 Content Review Checkpoint / M4 内容审核凭证关口

**Goal / 目标:** Replace the current status-only M4 content-review action with an evidence-backed submission, decision, and publication gate for campaign-linked v2 collaboration orders, without changing the current page structure or frozen PPT implementation. / 在不改变当前页面结构和冻结 PPT 实现的前提下，将 M4 现有仅切换状态的内容审核操作升级为面向 Campaign 关联 v2 合作订单的提交、审核决定与发布门禁闭环。

**Release cadence / 发布节奏:** Write focused failing tests first, implement only the affected service/API/M4 paths, obtain one independent review, create a recoverable production backup, then deploy and verify online immediately. Schema remains v16, so migration and parser-registry expansion are not part of this slice. / 先编写聚焦失败测试，只实现受影响的服务、API 与 M4 路径；完成一次独立审查和可恢复生产备份后立即上线并在线验收。本切片 schema 保持 v16，不扩展迁移和解析器注册表。

## Scope / 范围

- Submit one canonical HTTPS content URL, a bounded content-version label, and a submission note from an executing v2 collaboration. / 从执行中的 v2 合作提交一个规范 HTTPS 内容链接、受限内容版本标识和提交说明。
- Record append-only Campaign-linked submission and decision evidence through the existing campaign knowledge custody primitive. / 通过现有 Campaign 知识保管能力记录只追加的提交与审核决定凭证。
- Permit `approved` or `changes_requested` decisions. Approval keeps the collaboration in `content_review`; changes requested returns it to `live` for revision and resubmission. / 审核决定支持 `approved` 或 `changes_requested`；通过后保持 `content_review`，退回修改后返回 `live` 以便修订并重新提交。
- Require the latest submitted content URL and version to have a valid approval before a new v2 order can create its publication relation. Existing historical v1 and already-completed records remain readable and compatible. / 新版 v2 订单创建发布关系前，必须证明最新提交的内容链接与版本已经通过审核；历史 v1 和既有已完成记录继续可读兼容。
- Show review history and compact submit/decision controls in the existing M4 collaboration table and modal language. Do not add a page. / 在既有 M4 合作表格和弹窗语言中展示审核历史及紧凑提交/决定操作，不新增页面。

## API Contract / API 契约

`POST /api/collaborations/:id/content-reviews`

- JSON: `campaign_id`, `expected_version`, `content_url`, `content_version`, `submission_note`.
- Required header: `Idempotency-Key`.
- Success: `201` with the updated row version and current review projection.

`POST /api/collaborations/:id/content-review-decisions`

- JSON: `campaign_id`, `expected_version`, `decision`, `review_note`.
- `decision` is exactly `approved` or `changes_requested`.
- Required header: `Idempotency-Key`.
- Success: `201` with the updated status, row version, and current review projection.

`GET /api/collaborations/:id/content-reviews`

- Returns the authorized collaboration's ordered immutable review history and current publication-readiness projection. / 返回获授权合作记录的有序不可变审核历史和当前发布就绪状态。

## Authorization, Evidence, And Compatibility / 权限、凭证与兼容

- Submission requires active Campaign write access. Decisions require Campaign owner or organization administrator access. Unauthorized records remain non-enumerable. / 提交要求活动可写权限；审核决定要求活动负责人或组织管理员权限；未授权记录保持不可枚举。
- The reviewer cannot decide their own latest submission. Optimistic row versions and idempotency serialize duplicate clicks and concurrent decisions. / 审核人不得决定自己最近一次提交；通过乐观版本和幂等处理串行化重复点击与并发决定。
- URLs must be bounded canonical HTTPS URLs without credentials and are never fetched by the server. Notes and labels reject invalid scalar/control text. / 链接必须是长度受限、无凭据的规范 HTTPS URL，服务器不会主动抓取；说明和版本标识拒绝非法标量或控制字符。
- Evidence uses `entry_type` and `source_type` `collaboration_content_review`, Campaign team visibility, deterministic source identity, and `retrieval_eligible:false`. Raw URLs and review notes therefore never enter general, Campaign, or selected-knowledge RAG. / 凭证使用 `collaboration_content_review` 类型、Campaign 团队可见性和确定性来源身份，并标记 `retrieval_eligible:false`；原始链接及审核说明不会进入通用、Campaign 或显式选择知识的 RAG。
- The service validates the evidence chain, submission/decision alternation, actor, Campaign link, row version, content URL digest, and referenced submission before exposing it or allowing publication. / 服务在展示凭证或允许发布前校验凭证链、提交/决定交替、操作人、Campaign 关联、行版本、内容链接摘要及被引用提交。
- Existing contract PDF upload/download, signed confirmation, commercial terms, imports, filters, saved views, exports, Feishu controls, AI/knowledge flows, and PPT code remain unchanged. / 既有合同 PDF 上传/下载、签约确认、商业条款、导入、筛选、保存视图、导出、飞书控制、AI/知识链路和 PPT 代码保持不变。

## TDD And Acceptance / 测试与验收

1. Add focused failing service, route-policy, route, RAG-exclusion, and M4 client tests. / 先增加服务、请求策略、路由、RAG 排除和 M4 客户端聚焦失败测试。
2. Implement the smallest complete service/API/UI changes required by the accepted contracts. / 实现通过已接受契约所需的最小完整服务、API 与 UI 改动。
3. Prove submit, approve, request-changes, resubmit, idempotent replay, stale/conflict rejection, self-review rejection, masked authorization, evidence integrity, rollback, and v2 publication gating. / 证明提交、通过、退回、重新提交、幂等回放、陈旧/冲突拒绝、自审拒绝、权限遮蔽、凭证完整性、回滚和 v2 发布门禁。
4. Run affected tests, JavaScript syntax, diff and secret checks, frozen PPT hash, request-policy/source contracts, and local deployment preflight. / 运行受影响测试、JavaScript 语法、差异与密钥检查、冻结 PPT 哈希、请求策略/来源契约及本地发布预检。
5. Obtain independent review, resolve blocking findings, commit, back up production, deploy immediately, and verify non-mutating and authorized online paths. / 完成独立审查并修复阻断问题，提交、备份生产、立即上线，并在线验证不产生业务写入的路径和授权路径。
6. Sync `CHANGELOG.md`, version record, bilingual roadmap, progress dashboard, Obsidian archive, and GitHub. / 同步 `CHANGELOG.md`、版本记录、中英双语路线图、进度看板、Obsidian 归档和 GitHub。

## Deferred / 延后

Review attachments and annotations, customer-facing approval portals, automated video inspection, review SLA assignment, e-signature providers, real Feishu writes, payment, settlement expansion, and final campaign review remain separate releases. / 审核附件与批注、客户审核门户、自动视频检测、审核 SLA 分派、电子签平台、真实飞书写入、付款、结算扩展和最终项目复盘继续拆分为后续版本。
