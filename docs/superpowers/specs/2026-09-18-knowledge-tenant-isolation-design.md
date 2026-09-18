# Knowledge Tenant Isolation Design / 知识库租户隔离设计

Date / 日期：2026-09-18
Release / 版本：`v0.9.18-knowledge-tenant-isolation`
Status / 状态：Approved roadmap execution / 按已批准路线图执行

## Objective / 目标

Move all knowledge entries from mixed global/unlinked visibility to immutable organization ownership. Ordinary users, uploads, AI RAG, PPT/proposal helpers, category counts, and usage updates must operate only inside the authenticated organization. Platform administrators retain the existing global Admin knowledge audit view, while their AI generation remains scoped to the active organization. / 将全部知识条目从混合的全局/未归属可见性升级为不可变组织归属。普通用户、上传、AI RAG、PPT/方案辅助、分类计数及使用计数只能在当前鉴权组织内工作；平台管理员继续保留现有全局知识审计视图，但管理员发起的 AI 生成仍只使用当前组织知识。

## Current Evidence / 当前证据

- Production is on schema v23 with one organization and 128 knowledge entries. / 生产当前为 schema v23，存在 1 个组织和 128 条知识。
- 122 entries have neither Campaign custody nor organization-methodology custody; 82 of those use team/public/shared visibility. / 其中 122 条既无 Campaign 保管关系也无组织方法论保管关系，82 条为团队/公开/共享可见性。
- Current legacy access treats an unlinked team/public/shared entry as visible to every authenticated user, regardless of organization. / 当前旧访问规则会把未关联的团队/公开/共享知识暴露给所有已登录用户，不区分组织。
- Campaign and organization-methodology knowledge already carry authoritative organization facts through custody tables. The missing boundary is intrinsic ownership for every knowledge row and active-organization filtering on non-Campaign paths. / Campaign 与组织方法论知识已有权威组织事实；缺口是每条知识自身的组织归属，以及非 Campaign 路径的当前组织过滤。

## Selected Design / 选定设计

### Schema v24 / Schema v24

Add migration `024_knowledge_tenant_ownership` with `knowledge_entries.org_id`. SQLite receives the column as nullable for an additive migration, every historical row is deterministically backfilled, and database triggers reject missing, invalid, unknown, or reassigned ownership for all future inserts and updates. / 新增迁移 `024_knowledge_tenant_ownership` 和 `knowledge_entries.org_id`。SQLite 先追加可空列，随后确定性回填全部历史行；数据库触发器拒绝后续任何缺失、非法、未知或被改派的组织归属。

Backfill precedence is authoritative and fail-closed: current/historical Campaign custody organization, organization-methodology custody organization, one unique active creator membership, then the unique legacy default organization. Conflicting custody organizations abort the migration. Ambiguous or creatorless legacy unlinked rows fall back only to the unique default organization, never to an arbitrary membership. / 回填优先级为：当前/历史 Campaign 保管组织、组织方法论保管组织、创建者唯一有效组织成员关系、唯一历史默认组织；保管组织冲突时迁移失败。多组织歧义或无创建者的旧未关联知识只能回填到唯一默认组织，绝不随机选择成员关系。

The migration preserves every pre-v24 knowledge value, ID, chunk, FTS row, digest, and source identity byte-for-byte. New indexes support `(org_id,id)` identity and organization-scoped retrieval order. Link-integrity triggers require Campaign and organization custody rows to match `knowledge_entries.org_id`. / 迁移逐字节保留 v24 前的知识字段、ID、切片、FTS、摘要与来源身份；新增索引支持组织身份与组织范围检索。关联完整性触发器要求 Campaign/组织保管关系与知识条目的 `org_id` 一致。

### Runtime Isolation / 运行时隔离

- JSON ingest, multipart upload, business-artifact archive, AI summary promotion, CRM archive, influencer batch archive, proposal/PPT archive, and organization/Campaign writers persist an authoritative organization ID in the same transaction as the knowledge row. / JSON 入库、上传、业务归档、AI 摘要、CRM 归档、网红批次、方案/PPT 及组织/Campaign 写入均在同一事务内保存权威组织 ID。
- Browser bodies cannot choose organization ownership. HTTP paths use `req.authContext.organization.id`; Campaign and organization writers use existing server-side access facts. / 浏览器请求体不得指定组织；HTTP 路径只使用 `req.authContext.organization.id`，Campaign/组织写入只使用既有服务端权威事实。
- Ordinary search, categories, similar-knowledge lookup, RAG, and usage updates add `entry.org_id=current organization` before limiting, ranking, or payload loading. / 普通搜索、分类、相似知识、RAG 和使用计数在限制、排序和读取正文前先限定当前组织。
- The Admin knowledge control room keeps its global audit/search behavior. Any AI/RAG operation, including one initiated by a platform administrator, explicitly requires the active organization. / 管理端知识控制室保持全局审计/搜索能力；任何 AI/RAG 操作即使由平台管理员发起，也必须显式绑定当前组织。
- New legacy-source hashes are organization-namespaced. Same-organization replay may reuse an exact historical unscoped hash, while another organization receives a distinct scoped identity. / 新的旧式来源哈希加入组织命名空间；同组织可继续复用精确历史未加范围哈希，其他组织使用不同的组织范围身份。

## Alternatives Rejected / 未采用方案

1. **Visibility-only filtering:** `team` has no organization identity and therefore cannot prevent cross-tenant reads. / 仅按可见性过滤无法识别组织，不能阻止跨租户读取。
2. **Side-table ownership:** it leaves `knowledge_entries` intrinsically unowned and cannot fail every direct insert before a later side-table write. / 独立归属表会让知识主表继续无归属，也无法在后续侧表写入前对直接新增失败关闭。
3. **Admin-global RAG:** global Admin audit access is required, but using every tenant's knowledge in an AI answer would leak data across organizations. / 管理员需要全局审计，但 AI 回答若使用全租户知识会造成跨组织泄露。

## Error And Compatibility Contract / 错误与兼容合同

- Missing or stale organization authority fails before knowledge retrieval or persistence. / 缺失或失效的组织权限在知识检索或写入前失败关闭。
- Cross-organization knowledge IDs are concealed from ordinary users and cannot have usage counters changed. / 普通用户看不到跨组织知识 ID，也不能修改其使用计数。
- Existing global numeric knowledge IDs, UI fields, API response shapes, proposal/PPT rendering, and stored source/content digests remain unchanged. / 现有知识数字 ID、界面字段、API 响应、方案/PPT 渲染及已存来源/内容摘要保持不变。
- This release does not add an organization switcher. It scopes to the authoritative organization already resolved for the session. / 本版不新增组织切换器，只使用会话已解析的权威组织。

## Verification / 验证

- Migration tests cover deterministic backfill, conflict rejection, legacy projection preservation, FK/index/trigger shape, null/unknown/reassignment rejection, custody-link mismatch rejection, rerun, and restored-copy equivalence. / 迁移测试覆盖确定性回填、冲突拒绝、旧投影保持、外键/索引/触发器、非法归属拒绝、保管关系不一致拒绝、重跑及恢复副本一致性。
- Two-organization tests cover private/team search, categories, RAG, upload/ingest, same source identity in two organizations, AI summary promotion, and usage updates. / 双组织测试覆盖私有/团队搜索、分类、RAG、上传/入库、跨组织同来源、AI 摘要及使用计数。
- Schema-risk gates are limited to the required migration, sanitizer, trusted-source, deployment inventory, integrity/FK, backup, and production-shaped replay checks. Unrelated full suites remain reserved for phase closeout. / schema 风险门禁仅运行必要的迁移、脱敏、可信源码、部署清单、完整性/外键、备份及类生产重放；无关全量测试留到阶段收口。

## Explicit Exclusions / 明确排除

- No UI redesign, vector database, embedding rollout, plan/quota/billing, provider console, real Feishu write, organization switcher, or AI conversation ownership migration. / 不包含 UI 重设计、向量库、embedding 上线、套餐/配额/计费、provider 控制台、真实飞书写入、组织切换器或 AI 对话归属迁移。
- No changes to frozen PPT renderer bytes or previously accepted report/export contracts. / 不修改冻结 PPT 渲染器字节及已验收的报告/导出合同。

