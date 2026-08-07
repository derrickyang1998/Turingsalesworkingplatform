# TuringMarket Engineering Handoff / 图灵商务平台工程交接

Updated / 更新日期：2026-07-29

## Authoritative Baseline / 权威基线

- Checkout / 工作区：`C:\Users\29272\Documents\在线商务平台-github-sync`
- Current production delivery branch / 当前生产交付分支：`codex/v0.4.0-product-shell-and-design-system`
- Guarded Phase 4 release branch / 第 4 阶段受控发布分支：`codex/v0.5.0-campaign-business-spine`
- Phase 4 development base / 第 4 阶段开发基线：`5960ade03e1bd605ee4bfbe877baa09bc6482083`
- Current production source / 当前生产源码：`7511b6395a599a4f683cd60d6366e957c48ae302` (`v0.4.0-product-shell-and-design-system`)
- Backend / 后端：Node.js 20 + Express 5
- Database / 数据库：SQLite through `better-sqlite3`
- PM2 / 进程：`platform/ecosystem.config.js` -> `server/server.js`, process name `turingmarket`
- Production directory / 线上目录：`/root/turingmarket/platform`
- Health route / 健康检查：`/api/health`

This checkout consolidates the latest CRM, AI conversation, knowledge base, influencer workflow, Feishu, proposal, export, and PPT capabilities without reverting the latest interface. / 该工作区整合最新 CRM、AI 对话、知识库、网红执行、飞书、方案、导出与 PPT 能力，不回退最新界面。

`v0.5.0-campaign-business-spine` is now wired into the guarded deployment source and destructive-restore contract, but it MUST NOT be cut over or described as the production baseline until every remaining Task 9 and Task 10 gate below is implemented and independently accepted. / `v0.5.0-campaign-business-spine` 已接入受控发布源与破坏性恢复契约，但在下列 Task 9 与 Task 10 剩余门禁全部实现并独立验收前，仍不得切换或称为生产基线。

## Phase 4 Contract Checkpoint / 第 4 阶段契约检查点

- Authoritative design / 权威设计：`docs/superpowers/specs/2026-07-14-phase-4-campaign-business-spine-design.md` (`sha256 1db5ce6e020909acff6d39726bdfe1d47d525ddc8cd16596e521040d229f4822`)
- API contract / API 契约：`docs/api/campaign-business-spine.md` (`sha256 3cbc4ae483aa7d12b40f163de55b0dd84313e1f02408a19fd67b65819ce56d91`)
- Implementation plan / 实施计划：`docs/superpowers/plans/2026-07-14-phase-4-campaign-business-spine.md` (`sha256 c750174dd83ff4edcc281bcfd1e846ace7c16557c94a5c2063fbfaf9272ce43c`)
- Review status / 审查状态：all original Product Manager, Workflow Architect, Backend Architect, Security Architect, Data Engineer, and AI Engineer reviews are approved. The final cross-role review and the Backend Architect delta re-review are also `APPROVE`; all 47 raw findings consolidated into 33 categories plus the four final backend implementation blockers are closed. / Product Manager、Workflow Architect、Backend Architect、Security Architect、Data Engineer 与 AI Engineer 六个原始角色审查全部通过；最终跨角色审查及后端架构增量复审也均为 `APPROVE`，47 条原始意见归并的 33 类问题及最后 4 项后端实现阻塞均已关闭。
- Current executable evidence / 当前可执行证据：all seven SQL blocks execute against a v0.4 database copy; ten new tables are `STRICT`; 47 triggers and ten explicit indexes compile; `integrity_check=ok`; `foreign_key_check=0`. Default-organization code mutation and deletion are rejected. Explicit-ID knowledge allocation advances and rolls back `sqlite_sequence` correctly; raw legacy hashes remain distinct before canonical persistence; creatorless knowledge charges the immutable default organization with no user bucket. Deterministic RAG selects 8 of 48 chunks within exactly 98,304 UTF-8 bytes and stops at the first overflow. The full Node suite is 203/204; its sole failure is the intentional v0.4 deploy-script branch lock rejecting this undeployable v0.5 branch. / 七个 SQL 块均可在 v0.4 数据库副本执行；十张新增表均为 `STRICT`，47 个触发器与 10 个显式索引可编译，完整性为 `ok`、外键违规为 0。默认组织代码改写及删除均被拒绝；知识显式 ID 分配可正确推进和回滚 `sqlite_sequence`；旧版原始哈希在规范化持久化前保持区分；无创建者知识归属默认组织且不计入用户桶。RAG 在 48 个分块中确定性选择 8 个，总计精确 98,304 UTF-8 字节，并在首个超限项停止。Node 全量测试为 203/204，唯一失败是 v0.4 发布脚本按设计拒绝当前尚不可部署的 v0.5 分支。
- Product-source boundary / 产品源码边界：no Phase 4 product source has changed at this checkpoint; production remains on the verified v0.4 source and frozen PPT bytes. / 当前检查点尚未修改第 4 阶段产品源码；生产继续运行已验证的 v0.4 源码及冻结 PPT 字节。

## UI And PPT Lock / UI 与 PPT 锁定

```text
App build: 20260714-v040-product-shell-design-system
App query: 20260714v040productshelldesignsystem
PPT build: 20260702-v916-kb-bridge-client-cn
PPT query: 20260702v916kbbridge
PPT SHA-256: f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e
Admin inert preview marker: ?preview=v030
```

Approved public modules / 获批公开模块：

- `/client/shared/build_info.js`
- `/client/core/navigation.js`
- `/client/core/accessibility.js`
- `/client/core/shell.js`
- `/client/styles/tokens.css`
- `/client/styles/components.css`
- `/client/styles/layout.css`

Phase 4 plans five additional exact public files—`/client/features/campaign_context.js`, `/client/features/campaign_workspace.js`, `/client/features/campaign_ppt_bridge.js`, `/client/core/csp_compat.js`, and `/client/features/ppt_preview_runtime.js`—plus the `/campaigns` SPA path. They are not part of the current v0.4 production allowlist and become public only after matching Express, Nginx, build/deployment-manifest, source-boundary, CSP/frozen-PPT, and route-smoke gates land together. Wildcard `/client/features/*` and `/client/core/*` access remains forbidden. / 第 4 阶段计划增加五个精确公开文件及 `/campaigns` SPA 路径；它们当前不属于 v0.4 生产白名单，只有 Express、Nginx、构建/发布清单、源码边界、CSP/冻结 PPT 与路由冒烟门禁同步落地后方可公开，仍禁止通配公开 `/client/features/*` 与 `/client/core/*`。

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

Before the first v0.3.0 deployment, run `platform/server/scripts/bootstrap_production_runtime.sh` once as root on Ubuntu 26.04. It creates the no-login `turingmarket-gate` account, installs the audited native browser dependencies, loads the narrow AppArmor user-namespace profile, and migrates `.env`, SQLite, uploads, and temporary files to `/etc/turingmarket` and `/var/lib/turingmarket`. The script snapshots host/package state, keeps a root-only state backup, restores the old layout on failure, and proves PM2 health plus SQLite `quick_check`. Root PM2 remains intentionally unchanged in this phase. / 首次发布 v0.3.0 前，在 Ubuntu 26.04 上以 root 执行一次生产运行时引导脚本；它创建禁止登录的门禁用户、安装经审查的原生浏览器依赖、加载最小 AppArmor user namespace 配置，并把环境文件、SQLite、上传与临时文件迁移到发布目录之外。脚本会留存主机和软件包快照，失败时恢复旧布局，并验证 PM2 健康与 SQLite 完整性；本阶段保留 root PM2。

The bootstrap persists its migration phase under `/var/lib/turingmarket-bootstrap/active` before stopping PM2. It captures the rollback database through the SQLite Backup API only after writers stop, handles `ERR`, `INT`, `TERM`, and `HUP`, and on a later rerun first restores or finalizes an interrupted migration. A restored database must pass `quick_check` before PM2 can restart. The bootstrap and every guarded deploy independently reject gate-account UID, primary/supplementary-group, credential-lock, home, or shell drift. / 引导脚本会在停止 PM2 前把迁移阶段持久化到 root-only journal；停服后才通过 SQLite Backup API 生成回滚数据库。脚本处理错误与常见终止信号，进程或主机中断后再次执行时会先恢复或完成已提交迁移；恢复数据库必须通过 `quick_check` 才能重启。引导和每次发布都会独立拒绝门禁账号的 UID、主组、补充组、凭据锁定、home 或 shell 漂移。

The ASCII-safe script runs under Windows PowerShell 5.1 and normalizes CRLF/CR to LF before no-BOM UTF-8 transport to remote Bash; local preflight executes that exact conversion check. Production deployment still requires the exact authoritative checkout, the exact v0.5 branch, and a clean tracked worktree. It creates `backups/v050-campaign-business-spine-<timestamp>`, binds the `better-sqlite3` copy and private `PPT_CACHE_DIR=/var/lib/turingmarket/ppt-cache` tree into nested plus aggregate checksum manifests, and uploads only into an isolated release candidate. / ASCII 安全脚本兼容 Windows PowerShell 5.1；正式发布继续要求精确权威工作区、精确 v0.5 分支及干净工作树，并把数据库与私有 PPT 缓存绑定为同一验签备份单元。

Remote Node verification includes / 远端 Node 验证包含：

```bash
cd server
NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH=/var/lib/turingmarket-gate/releases/<release>/tmp/deploy-v050-gate-<timestamp>/test.db node --test --test-concurrency=1 tests/*.test.js
```

The candidate lives under `/var/lib/turingmarket-gate/releases`. Trusted active-runtime code first rebuilds a non-secret v4 fixture from the checksummed production schema and copies only the migration ledger. Candidate migration code never runs as root and never receives the production database: it runs as `turingmarket-gate` in a bounded systemd cgroup with private network/PID/mount namespaces, read-only paths, production-state denial, resource limits, and root-only output. Trusted active-runtime code then verifies preserved business tables, exact user security fields, organization/team/campaign rows, rerun idempotence, and unchanged production-backup plus PPT-manifest hashes before the existing Node, Playwright, and Nginx gates. / 可信活动运行时先根据已验签生产结构重建不含真实数据的 v4 合成副本，并且只复制迁移账本。候选迁移代码不再以 root 运行，也不会取得生产数据库；它以门禁用户在受限 systemd cgroup 中运行，使用独立网络、PID 与挂载命名空间、只读路径、生产状态拒绝、资源上限及仅 root 可读输出。随后由可信活动运行时核对保留业务表、用户安全字段、组织/团队/项目数据、重复迁移幂等性，以及生产备份与 PPT 清单哈希不变，再进入 Node、Playwright 与 Nginx 门禁。

A rejected candidate is deleted without stopping active PM2. The current lifecycle moves from `locked` directly into writer-protected `mutation-intent`, confirmed `mutation-started`, and `cutover-complete`; historical `candidate-ready` is read only for recovery compatibility and is not independently written. Production cutover, recovery, and rollback require the stable global `/root/turingmarket/.deploy-v030.writer` mutex and revalidate the lifecycle owner after acquiring it. Recovery cannot overlap a cutover that survived an SSH disconnect, a delayed cutover cannot enter a replacement lock generation, and an old phase writer cannot overwrite a newer lifecycle. Only confirmed mutation triggers automatic restore. An unreadable or uncertain phase, or an active/stale writer mutex, causes no further automatic production action and retains the locks. / 候选验证失败时仅删除候选目录，不停止活动 PM2；当前生命周期从 `locked` 直接进入受 writer 保护的 `mutation-intent`、确认开始变更与切换完成，历史 `candidate-ready` 仅作恢复兼容读取，不再独立写入。生产切换、恢复与回滚必须取得稳定的全局 `/root/turingmarket/.deploy-v030.writer` 互斥，并在获取后重新校验生命周期 owner，从而阻止 SSH 中断并发、延迟切换进入新锁代际及旧阶段覆盖新生命周期。只有确认开始变更才自动恢复；阶段不可读、不确定或 writer 活动/残留时不再自动操作生产并保留锁。

Manual rollback / 手工回滚：

```powershell
.\platform\deploy_v8.ps1 -RollbackBackup backups/v050-campaign-business-spine-<timestamp> -RestoreDatabase -ConfirmDataLoss
```

The same restore function is used by automatic and manual rollback. Phase 4 rejects code-only rollback: manual restore requires `-RollbackBackup`, `-RestoreDatabase`, and `-ConfirmDataLoss`; automatic post-mutation recovery always selects the same database/cache path. Every manifest is verified, SQLite and `PPT_CACHE_DIR` are restored as one unit, stale SQLite sidecars are removed, and every session is deleted before PM2 starts with `SERVER_HOST=127.0.0.1`. `-PreserveSessions` is always rejected. / 自动与手工回滚共用同一数据库与缓存恢复函数；手工恢复必须显式提供备份、恢复数据库及确认数据丢失，且始终在 PM2 启动前撤销全部会话。

This acceleration slice does not close Task 9. Remaining blockers are the exhaustive sanitizer and stale-run cleanup; all-API maintenance and the accepted-marker irreversible boundary; persistent loopback firewall/listener proof; the one-request replay helper and bypass-removal proof; the resumable rollback journal and matching-user security overlay including `department`; WAL-quiesced DB/cache ledger parity; retention cleanup; and authenticated browser/accessibility acceptance. Production therefore remains on the verified v0.4 source. / 本次加速切片未关闭 Task 9；完整脱敏与残留清理、维护与 accepted marker 边界、回环防火墙、单次 replay、可恢复 journal 与安全覆盖、WAL 停写及数据库/缓存账本一致性、保留清理和登录态浏览器/无障碍验收仍为阻塞项，生产继续保持已验证的 v0.4。

## Security And Secrets / 安全与密钥

Keep production values for `JWT_SECRET`, administrator bootstrap credentials, DeepSeek, Tavily, Feishu, and Obsidian integrations in protected server-side environment storage. Public Git files may contain variable names only. Never print credentials, cookies, bearer tokens, or provider keys in release evidence. / JWT、管理员初始化、DeepSeek、Tavily、飞书与 Obsidian 的生产值仅放在服务端受保护环境中；公开仓库只记录变量名，发布证据不得输出任何真实凭据。

Session invalidation is mandatory for Phase 4 deploy and restore; `-PreserveSessions` is rejected. The remaining security-overlay gate must carry forward exact matching-user password hash, active state, role, department, and quota without restoring sessions, JWT secrets, or plaintext environment backups. / 第 4 阶段发布和恢复必须撤销会话并拒绝 `-PreserveSessions`；剩余安全覆盖门禁需仅回填精确匹配用户的安全字段，不得恢复会话、JWT 或明文环境备份。

## Required Completion Evidence / 完成证据

Before a release is accepted, retain the Git commit and remote SHA, backup identifier, checksum verification, Node and Playwright counts, frozen PPT hash, 72-image comparison, route/static smoke, Nginx status, PM2 status, and authenticated production workflow results. / 版本验收前必须留存 Git 与远端 SHA、备份编号、校验结果、Node/Playwright 计数、冻结 PPT 哈希、72 图对比、路由与静态冒烟、Nginx、PM2 及生产登录态业务验收证据。
