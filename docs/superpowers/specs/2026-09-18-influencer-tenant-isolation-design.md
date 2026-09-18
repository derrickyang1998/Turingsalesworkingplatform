# Influencer Tenant Isolation Design / 网红数据租户隔离设计

Date / 日期：2026-09-18
Release / 版本：`v0.9.17-influencer-tenant-isolation`
Status / 状态：Approved roadmap execution / 按已批准路线图执行

## Objective / 目标

Move the existing influencer inventory from a globally readable and writable dataset to an organization-owned dataset without changing the accepted M4 interface, import template, export columns, Feishu behavior, AI/knowledge flows, proposal generation, or frozen PPT renderer. / 将现有全局共享网红库升级为组织归属数据集，同时不改变已验收的 M4 界面、导入模板、导出字段、飞书行为、AI/知识流程、方案生成或冻结 PPT 渲染器。

## Current Evidence / 当前证据

- Production schema is v22 and contains exactly one organization, the unique `turingmarket-default` organization with ID `1`. / 生产 schema 为 v22，且只有唯一默认组织。
- Production contains `4,786` influencer rows, `3` legacy collaboration rows, `1` campaign, and no active campaign-record links for collaborations. / 生产有 4,786 条网红、3 条旧合作、1 个活动，当前无活动合作关联记录。
- All historical influencer rows predate multi-tenant influencer ownership. Assigning them to the unique default organization is deterministic and does not infer ownership between multiple tenants. / 历史网红数据均早于多租户归属，回填唯一默认组织不涉及多组织猜测。
- v0.9.15 and v0.9.16 already enforce named export/import actor permissions, but row-level tenant ownership is not yet present. / v0.9.15 与 v0.9.16 已限制导出/导入操作者，但尚无行级组织归属。

## Selected Design / 选定设计

### Schema / 数据结构

Add migration `023_influencer_tenant_ownership` with an `influencers.org_id` foreign-key column. SQLite receives the column as nullable for a safe additive migration, then every existing row is backfilled to the unique `turingmarket-default` organization. Database triggers reject null, non-integer, unknown, or changed organization IDs on every future insert/update. Indexes support `(org_id,id)` identity and organization-active list ordering. / 新增 `023_influencer_tenant_ownership` 迁移。SQLite 先以可空列安全追加，再将全部历史记录回填到唯一默认组织；数据库触发器随后拒绝空值、非整数、未知组织和归属变更，并增加组织范围索引。

The migration preserves every pre-v23 influencer column byte-for-byte, validates row counts and a deterministic legacy projection digest before commit, and is checksum-bound in the migration ledger, sanitizer profile, trusted-source manifest, deployment inventory, and migration verifier. / 迁移在提交前验证全部旧字段、行数和确定性摘要不变，并纳入迁移账本、脱敏策略、可信源码清单、部署清单与迁移验证器。

### Runtime Isolation / 运行时隔离

- `GET /api/influencers`, matching, selected/all/filtered export, JSON import, multipart import, manual create, and Feishu selection read/write only the authenticated request's current organization. / 网红列表、匹配、三类导出、JSON/上传导入、手工新增及飞书选择均只读写当前鉴权组织。
- Batch replay checks use `(org_id, import_batch)`. New knowledge source identities are organization-namespaced; exact historical default-organization batch replays retain compatibility with legacy archived knowledge. / 批次重放按 `(org_id, import_batch)` 判断；新知识来源按组织命名空间隔离，默认组织历史批次重放继续兼容旧知识归档。
- Manual and imported rows persist `org_id` inside the same transaction as knowledge/audit evidence. / 手工与批量导入在知识和审计事务内同步写入 `org_id`。
- Requests never accept an organization ID from the browser body. The authoritative ID comes only from the live server-side authentication context. / 浏览器请求体不能指定组织，组织 ID 只能来自服务端实时鉴权上下文。

### Campaign And Collaboration Boundary / 活动与合作边界

- Influencer shortlist attachment, Campaign workspace availability, linked collaboration creation, final publication evidence, and legacy collaboration creation require the influencer's `org_id` to equal the actor or Campaign organization. / 网红候选关联、Campaign 工作区、关联合作创建、最终发布证据及旧合作创建均要求网红与操作者或活动属于同一组织。
- Cross-organization IDs return the existing not-found/forbidden contract without exposing that the record exists. / 跨组织 ID 沿用现有不存在或禁止合同，不泄露记录是否存在。
- Existing global numeric IDs remain stable; no UI or API client is required to remap identifiers. / 现有全局数字 ID 保持不变，不要求前端或 API 客户端重映射。

## Alternatives Rejected / 未采用方案

1. **Side-table custody only:** lower schema impact, but leaves `influencers` intrinsically global and contradicts the explicitly deferred `org_id` migration. / 仅使用侧表会继续保留全局主表，不满足已确认的 `org_id` 迁移边界。
2. **Full table rebuild with `NOT NULL`:** stronger column metadata but unnecessarily risks parent-table foreign keys and 4,786 production rows. Additive column plus fail-closed triggers gives the same runtime invariant with a safer rollback surface. / 全表重建会放大外键和数据风险；追加列与失败关闭触发器可实现同等运行时约束。
3. **Actor permission only:** already shipped in v0.9.15/v0.9.16 and does not prevent two authorized organizations from reading each other's rows. / 仅操作者权限不能解决已授权组织之间的行级隔离。

## Error And Privacy Contract / 错误与隐私合同

- Missing or invalid live organization context fails closed before querying or persisting influencer business data. / 缺失或无效实时组织上下文时，在查询或持久化前失败关闭。
- Cross-organization selected IDs are omitted from list/export and rejected for direct Campaign/collaboration attachment without revealing foreign data. / 跨组织选中 ID 不会进入列表或导出，直接活动/合作关联会拒绝且不泄露数据。
- Audit and error payloads do not include uploaded rows, file names, filters, foreign organization IDs, knowledge content, credentials, or tokens. / 审计与错误不记录上传行、文件名、筛选词、外部组织 ID、知识正文或凭据。

## Verification / 验证

- Migration RED/GREEN tests prove exact default backfill, legacy projection preservation, foreign-key/index/trigger shape, null/unknown/reassignment rejection, migration rerun, and restore behavior. / 迁移测试证明默认组织回填、旧字段保持、外键/索引/触发器结构、非法归属拒绝、重跑和恢复。
- HTTP/service tests create two organizations with overlapping batches and verify list, match, import, export, Feishu selection, shortlist, order, and collaboration boundaries. / 双组织测试覆盖列表、匹配、导入、导出、飞书选择、候选、下单和合作边界。
- Schema-risk gates include sanitizer v23, trusted-source and deploy inventories, production-shaped sanitized migration replay, SQLite integrity/FK checks, independent review, verified backup, remote candidate tests, and focused production API/browser acceptance. / schema 风险门禁覆盖 v23 脱敏策略、可信源码、部署清单、类生产迁移重放、SQLite 完整性、独立审查、备份、远端候选及线上定向验收。

## Explicit Exclusions / 明确排除

- No organization switcher, subscription plan, quota, billing, invitation, external Feishu write, or vector database work. / 不增加组织切换器、套餐、配额、计费、邀请、真实飞书写入或向量数据库。
- No redesign of M4, CRM, AI assistant, knowledge base, proposal, report, or PPT surfaces. / 不重设计 M4、CRM、AI 助手、知识库、方案、报告或 PPT 界面。
- Organization-wide isolation for legacy non-Campaign knowledge entries remains a later Phase 8 slice; this release only prevents influencer row and new influencer-batch identity crossover. / 旧非 Campaign 知识条目的组织级隔离继续作为后续 Phase 8 切片，本版只阻止网红数据行及新网红批次身份跨组织。

## Production Acceptance / 生产验收

1. v22 sanitized production copy upgrades to v23 twice with identical result, preserved 4,786 influencer rows, one organization assignment, `quick_check=ok`, and zero foreign-key violations. / 类生产副本可重复升级且无数据损失。
2. Production administrator sees the same M4 row count after migration, can preview a one-row upload without persistence, and can export only the current organization's selected row. / 管理员迁移前后行数一致，上传预览不写业务数据，导出仅限当前组织。
3. A temporary second-organization fixture cannot list, export, shortlist, order, or Feishu-sync a default-organization influencer, and its own imported row is invisible to the default organization. Fixture rows and sessions are removed after acceptance. / 临时第二组织无法访问默认组织网红，双方数据互不可见，验收夹具与会话随后清理。
4. Latest UI and frozen `ppt.js` SHA-256 remain unchanged. / 最新 UI 与冻结 PPT 摘要保持不变。
