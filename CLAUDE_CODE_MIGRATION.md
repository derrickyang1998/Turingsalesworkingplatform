# TuringMarket Engineering Handoff / 图灵商务平台工程交接

Updated / 更新日期：2026-09-20

## Authoritative Baseline / 权威基线

- Checkout / 工作区：`C:\Users\29272\Documents\在线商务平台-github-sync`
- Current production delivery branch / 当前生产交付分支：`codex/v0.7.0-ai-knowledge-proposal-ppt-loop-production`
- Guarded Phase 6 incremental release branch / 第 6 阶段受控增量发布分支：`codex/v0.7.0-ai-knowledge-proposal-ppt-loop-production`
- Phase 4 development base / 第 4 阶段开发基线：`5960ade03e1bd605ee4bfbe877baa09bc6482083`
- Current accepted production source / 当前已验收生产源码：`f1f9c98e0a4ffa85ac875c1ead66e80cb55f1696` (`v0.9.21-ai-token-quota-admission`)
- Current business-feature source / 当前业务功能源码：implementation range `dbbceb3` through `f1f9c98`; token-usage schema/runtime ownership is in `b4d6ba0`, immutable replacement protection is in `875f3d1`, verified/recoverable release retention is in `4cfe373` plus `0504141`, and unified server-side AI quota admission/accounting is in `f1f9c98` / 业务实现范围为 `dbbceb3` 至 `f1f9c98`，Token 用量 schema/运行时归属位于 `b4d6ba0`，不可替换保护位于 `875f3d1`，可验证且可恢复的发布保留控制位于 `4cfe373` 与 `0504141`，统一服务端 AI 配额准入及记账位于 `f1f9c98`
- Current release-controller source / 当前发布控制器源码：`f1f9c98e0a4ffa85ac875c1ead66e80cb55f1696` (schema-v26 trusted inventory, quota candidate gate, and verified interruption-recoverable retention / schema v26 可信清单、配额候选门禁及可验证可中断恢复的保留控制)
- Backend / 后端：Node.js 20 + Express 5
- Database / 数据库：SQLite through `better-sqlite3`
- PM2 / 进程：`platform/ecosystem.config.js` -> `server/server.js`, process name `turingmarket`
- Production directory / 线上目录：`/root/turingmarket/platform`
- Health route / 健康检查：`/api/health`

This checkout consolidates the latest CRM, AI conversation, knowledge base, influencer workflow, Feishu, proposal, export, and PPT capabilities without reverting the latest interface. / 该工作区整合最新 CRM、AI 对话、知识库、网红执行、飞书、方案、导出与 PPT 能力，不回退最新界面。

## Current Production Status / 当前生产状态

- Release / 版本：`v0.9.21-ai-token-quota-admission`, deployed and verified on `2026-09-20` / 已于 `2026-09-20` 部署并验收。
- Production run / 生产运行：`4e9eaf47f8404033ba3809cf34bcdf94`; backup / 备份：`/root/turingmarket/backups/v060-crm-sales-workspace-20260920-171336`；candidate SHA-256 / 候选摘要：`48e94ed8884e8bbf3a623e96d7f924243be7676187ae086795873c3d11a59c42`。
- Acceptance-time runtime / 验收时运行状态：PM2 `online`, restart count `0`; Nginx is valid; public `/api/health` is `200` with parser ready; schema v26, SQLite `quick_check=ok`, foreign-key violations `0`, quota candidate tests `94/94`, final independent review checks `137/137`, and deployment Chromium smoke `2/2` passed / PM2 在线且无重启，Nginx、公网健康、解析器、schema v26、SQLite 完整性、配额候选测试、独立终审复跑和部署浏览器冒烟均正常。
- Current reachability / 当前可达性：the authoritative host is reachable through the local SOCKS path `127.0.0.1:10808`; SSH alias `turingmarket-production-via-local-proxy` and proxied HTTP were verified. Direct local routing may still time out, so retain the proxy path for subsequent releases. `agent.turingmarket.ai` remains a separate Nuxt application and is not this production target. / 权威主机已通过本机 SOCKS 通道恢复 SSH 与 HTTP；后续发布保留该代理路径，另一 Nuxt 应用仍不得作为替代生产目标。
- Database / 数据库：schema `v26`, integrity `ok`, foreign-key violations `0`; all `126` token-usage ledger rows have organization ownership, null owners are `0`, and the no-replace/no-update/no-delete triggers are present / schema v26、完整性与外键正常；126 条 Token 用量账本全部具备组织归属，空归属为 0，禁止替换、更新和删除的三个触发器齐全。
- Phase 8 current slices / 第 8 阶段当前切片：the fail-closed module/action foundation, authoritative company-owner/read-only facts, scoped member governance, live read-only barrier, four CRM permission families, customer task workspace, task reassignment/editing, atomic organization-owner transfer, protected-account reset, campaign-performance export, customer-report export, influencer-data export/import authorizations, influencer/knowledge/AI-conversation/token-usage tenant ownership, and server-side AI token quota admission are active. Plan catalog, module entitlements, expiry, organization monthly quota, billing, and persistent concurrency reservation remain separate. / 默认拒绝权限底座、企业所有者/只读权威事实、成员治理、CRM 权限与任务工作区、所有权转移、受保护账号重置、三类导出/导入权限、网红/知识库/AI 对话/Token 用量租户归属及服务端 AI Token 配额准入均已上线；套餐目录、模块权益、到期、组织月度配额、账单和持久并发预留继续分离。
- Online authorization / 线上权限：ordinary knowledge, AI/RAG, proposal/PPT context, and business-artifact paths require the active authenticated organization. Ordinary users can access only their own organization-scoped conversations; platform administrators retain global knowledge and AI-conversation visibility only through explicit Admin audit views. Every trusted DeepSeek path now passes live server-side quota admission and verified provider-usage accounting; linked completed replays remain idempotent. / 普通知识、AI/RAG、方案/PPT 上下文及业务产物均强制活动认证组织；普通用户只能访问当前组织内自己的对话，平台管理员仅在显式管理审计界面保留全局知识与 AI 对话可见性。所有可信 DeepSeek 路径现均通过实时服务端配额准入和可信 provider 用量记账，已完成链接会话继续保持幂等重放。
- Product boundary / 产品边界：the accepted v0.6 shell, CRM, M3/M4, AI/knowledge, proposal, and frozen PPT remain intact. / 已验收的 v0.6 产品壳层、CRM、M3/M4、AI/知识、方案与冻结 PPT 均保持不变。
- Upload and recovery note / 上传与恢复说明：v0.9.13 transmits all `403` pinned files over one deterministic SSH stream per attempt instead of starting one SSH process per file. It still sends the full approximately `29.5 MB` payload and does not claim file-level deduplication. The first formal attempt stopped locally before any remote action because Windows PowerShell 5.1 leaked `VoidTaskResult` objects; the silent-pipeline fix and regression passed before the successful deployment. / v0.9.13 将 403 个钉住文件改为每次尝试通过单个确定性 SSH 流上传；仍会完整传输约 29.5 MB，不宣称文件级去重。首次正式尝试因 Windows PowerShell 5.1 管线对象泄漏在本地、远端动作前停止；静默管线修复与回归通过后才成功发布。
- v0.9.20 deployment note / v0.9.20 发布说明：the initial candidate gate exposed insufficient free space after verified historical backups accumulated. Retention was moved before candidate gates and then hardened after independent review with a durable `backup-ready.json`, full-manifest verification, a 20-backup hard cap, and same-run interruption recovery. Run `a3602d90516a4ed8b6befd2c9d3fee8d` completed with `DEPLOY_OK` and `RETENTION_CLEANUP_OK`. / 初始候选门禁暴露已校验历史备份累积后的磁盘空间不足；保留清理前移至候选门禁，并经独立审查补齐持久 `backup-ready.json`、完整清单复验、20 份硬上限与同运行中断恢复，正式运行随后成功完成。
- v0.9.21 deployment note / v0.9.21 发布说明：the accepted run `4e9eaf47f8404033ba3809cf34bcdf94` deployed unified server-side AI quota admission with no schema change. Online acceptance proved an audited quota update/restore and a zero-quota ordinary-user `429 AI_QUOTA_DISABLED` before any provider call, then cleaned all temporary data. / 正式运行在无 schema 变更下上线统一服务端 AI 配额准入；线上验收验证配额更新/恢复审计及普通用户零配额在 provider 调用前返回 429，并清理全部临时数据。
- Delivery cadence / 交付节奏：ordinary features use exact affected tests and one independent review, then verified backup, immediate production deployment, and focused online acceptance in the same round. Authentication, schema, shared deployment infrastructure, and real external writes trigger broader gates. / 普通功能只跑精确受影响测试与一次独立审查，同轮完成可验证备份、立即部署及线上定向验收；认证、schema、共享部署基础设施和真实外部写入触发扩展门禁。
- Full evidence / 完整证据：`docs/version-records/2026-09-20-v0.9.21-ai-token-quota-admission-production.md`。

`v0.6.0-crm-sales-workspace` contains the accepted Phase 5 CRM implementation and the upgraded schema-6 release contract. It MUST NOT be described as production until independent release review, GitHub push, verified backup, guarded deployment, remote runtime/API/UI/access acceptance, and rollback evidence all pass. / `v0.6.0-crm-sales-workspace` 已包含通过验收的第 5 阶段 CRM 实现及 schema-6 发布合同；独立发布复审、GitHub 推送、可校验备份、受控部署、远端运行时/API/UI/权限验收与回滚证据全部通过前，不得称为生产版本。

## Phase 5 CRM Checkpoint / 第 5 阶段 CRM 检查点

- Accepted implementation / 已验收实现：commit `90713b23f417602045d144ca24e80555ff1580b2`, Code Review `APPROVE`, QA `GO`.
- Verification / 验证：342/342 final review matrix, 373/373 fresh pre-commit matrix, six critical JavaScript syntax checks, secret and hard-delete addition audits clean.
- Recovery / 恢复：`phase5-v060-90713b23f417-full-source.bundle`, SHA-256 `fd4b925d82056d1eb53a5c65cc67461bc3eadd9ba88f47020ed37343d5dae887`, complete history verified.
- Data contract / 数据契约：migration `006_crm_sales_workspace`; trusted migration flow is exact v1-to-v6 with two restored runs; trusted source pins migration 006 and the CRM contract, command, query, and scope services.
- Product boundary / 产品边界：customer dashboard and customer detail stay separate; the latest shell, M4, AI/knowledge, proposal, export, Feishu, and frozen PPT paths are retained.

## Phase 4 Contract Checkpoint / 第 4 阶段契约检查点

- Authoritative design / 权威设计：`docs/superpowers/specs/2026-07-14-phase-4-campaign-business-spine-design.md` (`sha256 1db5ce6e020909acff6d39726bdfe1d47d525ddc8cd16596e521040d229f4822`)
- API contract / API 契约：`docs/api/campaign-business-spine.md` (`sha256 3cbc4ae483aa7d12b40f163de55b0dd84313e1f02408a19fd67b65819ce56d91`)
- Implementation plan / 实施计划：`docs/superpowers/plans/2026-07-14-phase-4-campaign-business-spine.md` (`sha256 c750174dd83ff4edcc281bcfd1e846ace7c16557c94a5c2063fbfaf9272ce43c`)
- Review status / 审查状态：all original Product Manager, Workflow Architect, Backend Architect, Security Architect, Data Engineer, and AI Engineer reviews are approved. The final cross-role review and the Backend Architect delta re-review are also `APPROVE`; all 47 raw findings consolidated into 33 categories plus the four final backend implementation blockers are closed. / Product Manager、Workflow Architect、Backend Architect、Security Architect、Data Engineer 与 AI Engineer 六个原始角色审查全部通过；最终跨角色审查及后端架构增量复审也均为 `APPROVE`，47 条原始意见归并的 33 类问题及最后 4 项后端实现阻塞均已关闭。
- Current executable evidence / 当前可执行证据：all seven SQL blocks execute against a v0.4 database copy; ten new tables are `STRICT`; 47 triggers and ten explicit indexes compile; `integrity_check=ok`; `foreign_key_check=0`. Default-organization code mutation and deletion are rejected. Explicit-ID knowledge allocation advances and rolls back `sqlite_sequence` correctly; raw legacy hashes remain distinct before canonical persistence; creatorless knowledge charges the immutable default organization with no user bucket. Deterministic RAG selects 8 of 48 chunks within exactly 98,304 UTF-8 bytes and stops at the first overflow. The full Node suite is 203/204; its sole failure is the intentional v0.4 deploy-script branch lock rejecting this undeployable v0.5 branch. / 七个 SQL 块均可在 v0.4 数据库副本执行；十张新增表均为 `STRICT`，47 个触发器与 10 个显式索引可编译，完整性为 `ok`、外键违规为 0。默认组织代码改写及删除均被拒绝；知识显式 ID 分配可正确推进和回滚 `sqlite_sequence`；旧版原始哈希在规范化持久化前保持区分；无创建者知识归属默认组织且不计入用户桶。RAG 在 48 个分块中确定性选择 8 个，总计精确 98,304 UTF-8 字节，并在首个超限项停止。Node 全量测试为 203/204，唯一失败是 v0.4 发布脚本按设计拒绝当前尚不可部署的 v0.5 分支。
- Product-source boundary / 产品源码边界：no Phase 4 product source has changed at this checkpoint; production remains on the verified v0.4 source and frozen PPT bytes. / 当前检查点尚未修改第 4 阶段产品源码；生产继续运行已验证的 v0.4 源码及冻结 PPT 字节。

## UI And PPT Lock / UI 与 PPT 锁定

```text
App build: 20260811-v060-crm-sales-workspace
App query: 20260811v060crmsalesworkspace
PPT build: 20260702-v916-kb-bridge-client-cn
PPT query: 20260702v916kbbridge
PPT SHA-256: f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e
Admin inert preview marker: ?preview=v030
```

Approved public modules / 获批公开模块：

- `/client/shared/build_info.js`
- `/client/core/navigation.js`
- `/client/core/accessibility.js`
- `/client/core/csp_compat.js`
- `/client/core/shell.js`
- `/client/features/ppt_preview_runtime.js`
- `/client/styles/tokens.css`
- `/client/styles/components.css`
- `/client/styles/layout.css`

The v0.6 candidate additionally publishes the exact campaign modules `/client/features/campaign_context.js`, `/client/features/campaign_workspace.js`, and `/client/features/campaign_ppt_bridge.js`, plus the `/campaigns` SPA path. The current production-v0.4 allowlist remains unchanged until guarded cutover; wildcard `/client/features/*` and `/client/core/*` access remains forbidden in both versions. / v0.6 候选还精确公开三个活动模块及 `/campaigns` SPA 路径；受控切换前，当前生产 v0.4 白名单保持不变，两个版本均禁止通配公开 `/client/features/*` 与 `/client/core/*`。

All other `/client/*` requests and private paths including `/server/server.js` remain denied. The `0.005` pixel-ratio threshold applies only to frozen repeat-capture determinism. The intentional shared-shell redesign uses a separate mandatory reviewed comparison; its approved maximum observed perceptual difference ratio is `0.14496597399441002`. / 其他 `/client/*` 与 `/server/server.js` 等私有路径继续拒绝访问；`0.005` 像素差异阈值仅用于冻结基线的重复截图确定性校验。经批准的共享壳层改版使用独立的强制人工审查对比，其最大感知差异比为 `0.14496597399441002`。

## Current Architecture / 当前架构

- `platform/index.html`: application shell and styles / 应用外壳与样式
- `platform/app.js`: current browser behavior and module orchestration / 当前浏览器行为与模块编排
- `platform/ppt.js`: frozen PPT bridge and generation client / 冻结 PPT 桥接与生成客户端
- `platform/client/shared/build_info.js`: public build metadata / 公开构建元数据
- `platform/client/core/navigation.js`: public navigation registry / 公开导航注册表
- `platform/server/server.js`: Express API and route composition / Express API 与路由装配
- `platform/server/db.js`: `better-sqlite3` schema and persistence / 数据结构与持久化
- `platform/server/services/*`: CRM, AI/RAG, knowledge, ingestion, influencer, access, and export services / 业务服务层
- `platform/server/workflow_engine.js` and `platform/server/routes_workflow.js`: workflow runtime and API / 工作流运行时与 API

## Deploy And Rollback / 发布与回滚

Run only from the authoritative checkout / 仅从权威工作区运行：

```powershell
.\platform\deploy_v8.ps1 -ValidateLocalOnly
.\platform\deploy_v8.ps1
```

`-ValidateLocalOnly` never resolves the production server or performs SSH/SCP. It is mutually exclusive with rollback and destructive-restore controls; an explicitly empty, blank, or invalid rollback value is rejected locally instead of being treated as a formal deployment. / `-ValidateLocalOnly` 不会解析生产服务器，也不会执行 SSH/SCP，并且与回滚和破坏性恢复参数互斥；显式空值、空白或非法回滚参数会在本地拒绝，不会被当作正式发布。

Before the first deployment using the external runtime layout, run `platform/server/scripts/bootstrap_production_runtime.sh` once as root on Ubuntu 26.04. It creates the no-login `turingmarket-gate` account, installs the audited native browser dependencies, loads the narrow AppArmor user-namespace profile, and migrates `.env`, SQLite, uploads, and temporary files to `/etc/turingmarket` and `/var/lib/turingmarket`. It also installs and enables the exact root-owned `/etc/systemd/system/pm2-root.service`, verifies the fixed PM2 runtime entrypoints, and preserves the PM2 dump only after that startup contract passes. The script snapshots host/package state, keeps a root-only state backup, restores the old layout on failure, and proves PM2 health plus SQLite `quick_check`. / 首次使用外置运行时布局发布前，在 Ubuntu 26.04 上以 root 执行该引导脚本；除门禁账号、依赖、AppArmor 与可变状态迁移外，它还会安装并启用精确的 root 所有 `pm2-root.service`，验证固定 PM2 入口，并仅在自启动合同通过后保存 PM2 dump；失败时恢复旧布局，并验证 PM2 健康与 SQLite 完整性。

The bootstrap persists its migration phase under `/var/lib/turingmarket-bootstrap/active` before stopping PM2. It captures the rollback database through the SQLite Backup API only after writers stop, handles `ERR`, `INT`, `TERM`, and `HUP`, and on a later rerun first restores or finalizes an interrupted migration. A restored database must pass `quick_check` before PM2 can restart. The bootstrap and every guarded deploy independently reject gate-account UID, primary/supplementary-group, credential-lock, home, or shell drift. / 引导脚本会在停止 PM2 前把迁移阶段持久化到 root-only journal；停服后才通过 SQLite Backup API 生成回滚数据库。脚本处理错误与常见终止信号，进程或主机中断后再次执行时会先恢复或完成已提交迁移；恢复数据库必须通过 `quick_check` 才能重启。引导和每次发布都会独立拒绝门禁账号的 UID、主组、补充组、凭据锁定、home 或 shell 漂移。

The ASCII-safe script runs under Windows PowerShell 5.1 and normalizes CRLF/CR to LF before no-BOM UTF-8 transport to remote Bash; local preflight executes that exact conversion check. Production deployment requires the exact authoritative checkout, the exact `codex/v0.7.0-ai-knowledge-proposal-ppt-loop-production` branch, and a clean tracked worktree. It retains the frozen v0.6 shell/PPT identity and historical `v060-crm-sales-workspace` backup slug while adding reviewed v0.7 backend slices. / ASCII 安全脚本兼容 Windows PowerShell 5.1；正式发布要求精确权威工作区、精确 v0.7 增量发布分支及干净工作树；冻结的 v0.6 UI/PPT 标识与历史备份 slug 保持不变，仅叠加已审查的 v0.7 后端切片。

Per-feature candidate Node verification is bounded to migration/replay evidence. Affected unit/API/contract tests run locally before deployment; full non-browser regression and browser verification run at phase closeout or when a hard-gate risk boundary requires them. / 单功能候选 Node 验证限定为迁移与重放证据；受影响的单元、API 和合同测试在部署前本地执行，完整非浏览器回归与浏览器验证只在阶段收口或硬门禁风险边界触发时执行：

```bash
NODE_ENV=test TM_DISABLE_DOTENV=1 node server/scripts/verify_phase4_one_request_replay.js
NODE_ENV=test TM_DISABLE_DOTENV=1 node --test server/tests/verify_phase4_one_request_replay.test.js
NODE_ENV=test TM_DISABLE_DOTENV=1 node --test server/tests/release_replay_gate.test.js
```

The candidate lives under `/var/lib/turingmarket-gate/releases`. The accepted v0.9.13 controller keeps the v0.9.11 exact schema-v22 no-op and `task_updated` structural policy while batching all pinned files into one deterministic SSH stream. Migration code never runs as root or receives the production database. Per-feature validation stays bounded to migration/replay, route/static, Nginx, and the named feature journey; full Node and browser matrices remain phase-closeout or risk-trigger checks. / 候选版本位于受限发布目录；v0.9.13 控制器保留 v0.9.11 的精确 schema v22 无操作接纳及 `task_updated` 结构策略，并将全部钉住文件批量放入单个确定性 SSH 流。迁移代码不以 root 运行且不取得生产数据库；单功能门禁继续限定于迁移/重放、路由/静态资源、Nginx 及命名功能旅程，完整 Node 与浏览器矩阵保留到阶段收口或风险触发。

A rejected candidate is deleted without stopping active PM2. The current lifecycle moves from `locked` directly into writer-protected `mutation-intent`, confirmed `mutation-started`, and `cutover-complete`; historical `candidate-ready` is read only for recovery compatibility and is not independently written. Production cutover, recovery, and rollback require the stable global `/root/turingmarket/.deploy-v030.writer` mutex and revalidate the lifecycle owner after acquiring it. Recovery cannot overlap a cutover that survived an SSH disconnect, a delayed cutover cannot enter a replacement lock generation, and an old phase writer cannot overwrite a newer lifecycle. Only confirmed mutation triggers automatic restore. An unreadable or uncertain phase, or an active/stale writer mutex, causes no further automatic production action and retains the locks. / 候选验证失败时仅删除候选目录，不停止活动 PM2；当前生命周期从 `locked` 直接进入受 writer 保护的 `mutation-intent`、确认开始变更与切换完成，历史 `candidate-ready` 仅作恢复兼容读取，不再独立写入。生产切换、恢复与回滚必须取得稳定的全局 `/root/turingmarket/.deploy-v030.writer` 互斥，并在获取后重新校验生命周期 owner，从而阻止 SSH 中断并发、延迟切换进入新锁代际及旧阶段覆盖新生命周期。只有确认开始变更才自动恢复；阶段不可读、不确定或 writer 活动/残留时不再自动操作生产并保留锁。

Manual rollback / 手工回滚：

```powershell
.\platform\deploy_v8.ps1 -RollbackBackup backups/v060-crm-sales-workspace-<timestamp> -RestoreDatabase -ConfirmDataLoss
```

The same restore function is used by automatic and manual rollback. Phase 4 rejects code-only rollback: manual restore requires `-RollbackBackup`, `-RestoreDatabase`, and `-ConfirmDataLoss`; automatic post-mutation recovery always selects the same database/cache path. Every manifest is verified, SQLite and `PPT_CACHE_DIR` are restored as one unit, stale SQLite sidecars are removed, and every session is deleted before PM2 starts with `SERVER_HOST=127.0.0.1`. `-PreserveSessions` is always rejected. / 自动与手工回滚共用同一数据库与缓存恢复函数；手工恢复必须显式提供备份、恢复数据库及确认数据丢失，且始终在 PM2 启动前撤销全部会话。

Production runs accepted v0.9.20 on schema v26. It preserves the accepted product shell and all v0.9.19 capabilities while binding trusted server-side token usage to organization and user, scoping quotas and ordinary reads to that tenant, and allowing cross-organization aggregation only through the explicit audited Admin query. The ledger rejects replacement, update, delete, and client reporting. Subsequent ordinary slices use affected tests plus one independent review, verified backup, immediate deployment, and online feature smoke; heavy full-suite testing remains phase-closeout or risk-triggered. / 生产现运行已验收的 v0.9.20/schema v26，保留产品壳层与 v0.9.19 全部能力，将可信服务端 Token 用量同时绑定组织和用户，按租户计算配额和普通读取，仅允许显式且可审计的管理员查询跨组织聚合；账本拒绝替换、更新、删除和客户端上报。后续普通切片继续采用受影响测试、一次独立审查、可验证备份、当轮部署和线上功能冒烟。

## Security And Secrets / 安全与密钥

Keep production values for `JWT_SECRET`, administrator bootstrap credentials, DeepSeek, Tavily, Feishu, and Obsidian integrations in protected server-side environment storage. Public Git files may contain variable names only. Never print credentials, cookies, bearer tokens, or provider keys in release evidence. / JWT、管理员初始化、DeepSeek、Tavily、飞书与 Obsidian 的生产值仅放在服务端受保护环境中；公开仓库只记录变量名，发布证据不得输出任何真实凭据。

Session invalidation is mandatory for Phase 4 deploy and restore; `-PreserveSessions` is rejected. The remaining security-overlay gate must carry forward exact matching-user password hash, active state, role, department, and quota without restoring sessions, JWT secrets, or plaintext environment backups. / 第 4 阶段发布和恢复必须撤销会话并拒绝 `-PreserveSessions`；剩余安全覆盖门禁需仅回填精确匹配用户的安全字段，不得恢复会话、JWT 或明文环境备份。

## Required Completion Evidence / 完成证据

Before each feature slice is accepted, retain the Git commit and remote SHA, focused test counts, independent-review verdict, backup identifier and checksum verification, frozen PPT hash, route/static smoke, Nginx and PM2 startup state, and authenticated production workflow results. Add full Node, browser, and visual-comparison evidence at phase closeout or when the risk-trigger rule requires those gates. / 每个功能切片验收前必须留存 Git 与远端 SHA、定向测试计数、独立审查结论、备份编号和校验、冻结 PPT 哈希、路由与静态冒烟、Nginx 与 PM2 自启动状态及生产登录态业务验收；完整 Node、浏览器和视觉对比证据仅在阶段收口或风险触发时补充。
