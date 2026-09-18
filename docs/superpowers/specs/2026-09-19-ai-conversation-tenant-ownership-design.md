# AI Conversation Tenant Ownership Design / AI 对话租户归属设计

Date / 日期：2026-09-19  
Release / 版本：`v0.9.19-ai-conversation-tenant-ownership`  
Status / 状态：Approved roadmap execution / 按已批准路线图执行

## Objective / 目标

Give every AI conversation one immutable organization owner. Ordinary conversation creation, continuation, reads, promotion to knowledge, proposal/PPT generation, and Campaign-linked AI runs must stay inside the authenticated organization. Platform administrators keep global visibility only through the explicit, audited Admin conversation views; generation and knowledge promotion remain scoped to their active organization. / 为每条 AI 对话建立唯一且不可变的组织归属。普通对话创建、续聊、读取、沉淀知识、方案/PPT 生成及 Campaign 关联 AI 运行均只能在当前鉴权组织内执行。平台管理员仅在显式且有审计日志的 Admin 对话视图中保持全局可见；生成与知识沉淀仍限定在其活动组织。

## Current Evidence / 当前证据

- Schema v24 stores conversation ownership indirectly through Campaign links or the owner's current membership. Membership is mutable and therefore cannot prove historical ownership. / Schema v24 通过 Campaign 关联或所有者当前成员关系间接推断对话组织；成员关系可变，不能证明历史归属。
- Production contains 34 conversations: 31 have one consistent authoritative organization signal, 3 have no authoritative signal and can use the unique legacy default organization, with zero conflicts or unresolved rows. / 生产有 34 条对话：31 条具有唯一一致的权威组织证据，3 条无权威证据且可归入唯一历史默认组织，无冲突、无未解析记录。
- The current manual promotion path may read a globally visible Admin conversation and write its summary into the Admin's active organization. / 当前手动沉淀路径可能读取管理员全局可见对话，并把摘要写入管理员当前组织，存在跨租户派生写入风险。

## Selected Design / 选定设计

### Schema v25 / Schema v25

Migration `025_ai_conversation_tenant_ownership` adds `ai_conversations.org_id`. SQLite receives the additive column, all historical rows are backfilled inside the migration transaction, and database triggers reject null, invalid, unknown, or reassigned ownership thereafter. / 迁移 `025_ai_conversation_tenant_ownership` 为 `ai_conversations` 增加 `org_id`。SQLite 追加列后在同一迁移事务中回填全部历史数据，之后由数据库触发器拒绝空值、非法值、未知组织或归属改派。

Backfill gathers all authoritative evidence for each conversation: Campaign record-link organization, linked Campaign organization, archived-summary knowledge organization, referenced Campaign organization, and referenced knowledge organization. More than one distinct organization aborts the migration. Rows with no evidence use only the unique legacy default organization; current user membership is never historical evidence. / 回填为每条对话汇总全部权威证据：Campaign 记录关联组织、关联 Campaign 组织、归档摘要知识组织、引用 Campaign 组织及引用知识组织。出现多个不同组织时迁移失败；无证据记录只能归入唯一历史默认组织，当前用户成员关系不作为历史证据。

The migration preserves all pre-v25 conversation, message, reference, token, timestamp, archive, and link values byte-for-byte. New indexes support `(org_id,id)` identity and organization/owner/update ordering. / 迁移逐字节保留 v25 前的对话、消息、引用、token、时间戳、归档及关联字段；新增索引支持 `(org_id,id)` 身份和组织/所有者/更新时间排序。

Database guards enforce same-organization archived summaries, AI references, and AI-conversation Campaign links. Organization ownership cannot be changed after creation. / 数据库保护要求归档摘要、AI 引用及 AI 对话 Campaign 关联与对话同组织，且创建后不得修改组织归属。

### Runtime Isolation / 运行时隔离

- New conversations obtain `org_id` only from the server-resolved active organization or the already authorized Campaign. Request bodies cannot select ownership. / 新对话仅从服务端解析的活动组织或已授权 Campaign 获取 `org_id`，请求体不得指定归属。
- Continuing a conversation requires its `org_id` to equal the active organization, including for a platform administrator. / 续聊要求对话 `org_id` 与活动组织一致，平台管理员也不例外。
- Ordinary owners and organization administrators can read only conversations in the active organization. Existing Campaign row-level access continues to apply. / 普通所有者和组织管理员只能读取活动组织内的对话，现有 Campaign 行级权限继续生效。
- Platform administrators can read across organizations only through the explicit Admin list/detail paths, which continue to write audit logs. / 平台管理员仅可通过显式 Admin 列表/详情路径跨组织读取，并继续写入审计日志。
- Manual promotion to knowledge requires conversation ownership to match the active organization before reading messages or writing knowledge. / 手动沉淀知识必须先验证对话归属与活动组织一致，再读取消息或写入知识。
- Knowledge capacity attribution for AI references uses the conversation's immutable organization rather than current memberships or optional reference targets. / AI 引用的知识容量归属改用对话不可变组织，不再依赖当前成员关系或可选引用目标。

## Error And Compatibility Contract / 错误与兼容合同

- Missing active organization or cross-organization conversation access fails as not found/forbidden before message persistence, provider use where practical, or knowledge writes. / 缺失活动组织或跨组织访问在消息落库、可行情况下调用 provider、或写知识前失败关闭，并按未找到/禁止处理。
- Existing conversation IDs, API response fields, Admin filters, UI, proposal/report output, and frozen PPT renderer bytes remain unchanged. / 现有对话 ID、API 响应字段、Admin 筛选、UI、方案/报告输出及冻结 PPT 渲染字节保持不变。
- This release does not add an organization switcher, role redesign, provider console, billing, or new UI. / 本版不增加组织切换器、角色重设计、provider 控制台、计费或新 UI。

## Verification / 验证

- Migration tests cover evidence precedence, conflict rejection, default fallback, legacy projection preservation, indexes/triggers, rerun, integrity, and foreign keys. / 迁移测试覆盖证据回填、冲突拒绝、默认回退、旧投影保持、索引/触发器、重跑、完整性及外键。
- Two-organization runtime tests cover create, continue, ordinary/Admin reads, Campaign links, manual promotion, and direct database mismatch guards. / 双组织运行测试覆盖创建、续聊、普通/Admin 读取、Campaign 关联、手动沉淀及数据库不一致保护。
- Per-function release uses exact affected tests, one independent backend/security/code review, guarded backup/deploy, and focused production smoke. Broader regression remains for Phase 8 closeout. / 单功能版本仅运行精确受影响测试、一次独立后端/安全/代码审查、受保护备份部署和生产定向烟测；更广回归留到阶段 8 收口。
