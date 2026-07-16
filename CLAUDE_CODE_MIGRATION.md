# TuringMarket Engineering Handoff / 图灵商务平台工程交接

Updated / 更新日期：2026-07-16

## Authoritative Baseline / 权威基线

- Checkout / 工作区：`C:\Users\29272\Documents\在线商务平台-github-sync`
- Current production delivery branch / 当前生产交付分支：`codex/v0.4.0-product-shell-and-design-system`
- Undeployable development branch / 尚不可部署的开发分支：`codex/v0.5.0-campaign-business-spine`
- Phase 4 development base / 第 4 阶段开发基线：`5960ade03e1bd605ee4bfbe877baa09bc6482083`
- Current production source / 当前生产源码：`7511b6395a599a4f683cd60d6366e957c48ae302` (`v0.4.0-product-shell-and-design-system`)
- Backend / 后端：Node.js 20 + Express 5
- Database / 数据库：SQLite through `better-sqlite3`
- PM2 / 进程：`platform/ecosystem.config.js` -> `server/server.js`, process name `turingmarket`
- Production directory / 线上目录：`/root/turingmarket/platform`
- Health route / 健康检查：`/api/health`

This checkout consolidates the latest CRM, AI conversation, knowledge base, influencer workflow, Feishu, proposal, export, and PPT capabilities without reverting the latest interface. / 该工作区整合最新 CRM、AI 对话、知识库、网红执行、飞书、方案、导出与 PPT 能力，不回退最新界面。

`v0.5.0-campaign-business-spine` is contract/development work only. It MUST NOT be deployed or described as the delivery baseline until the Phase 4 migration, static-boundary, populated-data privacy, DB-plus-PPT-cache backup/restore, resumable code/Nginx rollback, accessibility, full-test, and authenticated production release gates are implemented and accepted. / `v0.5.0-campaign-business-spine` 当前仅为契约与开发工作；在第 4 阶段迁移、静态边界、类生产数据隐私、数据库与 PPT 缓存整体备份恢复、可恢复代码/Nginx 回滚、无障碍、完整测试及生产登录态验收门禁全部实现并通过前，不得部署或称为交付基线。

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

`-ValidateLocalOnly` never resolves the production server or performs SSH/SCP. It is mutually exclusive with `-RollbackBackup`; an explicitly empty, blank, or invalid rollback value is rejected locally instead of being treated as a formal deployment. / `-ValidateLocalOnly` 不会解析生产服务器，也不会执行 SSH/SCP，并且与 `-RollbackBackup` 互斥；显式空值、空白或非法回滚参数会在本地拒绝，不会被当作正式发布。

Before the first v0.3.0 deployment, run `platform/server/scripts/bootstrap_production_runtime.sh` once as root on Ubuntu 26.04. It creates the no-login `turingmarket-gate` account, installs the audited native browser dependencies, loads the narrow AppArmor user-namespace profile, and migrates `.env`, SQLite, uploads, and temporary files to `/etc/turingmarket` and `/var/lib/turingmarket`. The script snapshots host/package state, keeps a root-only state backup, restores the old layout on failure, and proves PM2 health plus SQLite `quick_check`. Root PM2 remains intentionally unchanged in this phase. / 首次发布 v0.3.0 前，在 Ubuntu 26.04 上以 root 执行一次生产运行时引导脚本；它创建禁止登录的门禁用户、安装经审查的原生浏览器依赖、加载最小 AppArmor user namespace 配置，并把环境文件、SQLite、上传与临时文件迁移到发布目录之外。脚本会留存主机和软件包快照，失败时恢复旧布局，并验证 PM2 健康与 SQLite 完整性；本阶段保留 root PM2。

The bootstrap persists its migration phase under `/var/lib/turingmarket-bootstrap/active` before stopping PM2. It captures the rollback database through the SQLite Backup API only after writers stop, handles `ERR`, `INT`, `TERM`, and `HUP`, and on a later rerun first restores or finalizes an interrupted migration. A restored database must pass `quick_check` before PM2 can restart. The bootstrap and every guarded deploy independently reject gate-account UID, primary/supplementary-group, credential-lock, home, or shell drift. / 引导脚本会在停止 PM2 前把迁移阶段持久化到 root-only journal；停服后才通过 SQLite Backup API 生成回滚数据库。脚本处理错误与常见终止信号，进程或主机中断后再次执行时会先恢复或完成已提交迁移；恢复数据库必须通过 `quick_check` 才能重启。引导和每次发布都会独立拒绝门禁账号的 UID、主组、补充组、凭据锁定、home 或 shell 漂移。

The ASCII-safe script runs under Windows PowerShell 5.1 and normalizes CRLF/CR to LF before no-BOM UTF-8 transport to remote Bash; local preflight executes that exact conversion check. It requires the exact branch and a clean tracked worktree for deployment, holds the fail-closed lifecycle lock `/root/turingmarket/.deploy-v030.lock` throughout every remote deployment or rollback, requires the stable global writer mutex for production mutation, creates an external `backups/v040-product-shell-design-system-<timestamp>`, uploads only into an isolated release candidate, and keeps the active tree untouched through complete remote Node/browser/Nginx gates. / ASCII 安全脚本兼容 Windows PowerShell 5.1，并在无 BOM UTF-8 发送远端 Bash 前将 CRLF/CR 统一为 LF，本地预检会执行同一转换自测；正式发布要求精确分支与干净工作树，发布或回滚的完整远端生命周期均持有失败关闭的 lifecycle 锁，生产变更还必须取得稳定的全局 writer 互斥；脚本建立外置版本化备份，且仅向隔离候选目录上传，在完整远端 Node、浏览器和 Nginx 门禁期间不修改活动目录。

Remote Node verification includes / 远端 Node 验证包含：

```bash
cd server
NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH=/var/lib/turingmarket-gate/releases/<release>/tmp/deploy-v040-gate-<timestamp>/test.db node --test --test-concurrency=1 tests/*.test.js
```

The candidate lives under `/var/lib/turingmarket-gate/releases` and is tested as the no-login gate user with Playwright 1.61.1 native Ubuntu 26 support and Chromium sandboxing. Root rebuilds a schema-only database from the consistent production backup, verifies the exact production fingerprint, and inserts fixed synthetic sentinels across authentication, CRM, influencer, knowledge, and AI conversation tables. Candidate code runs offline against only that sanitized database and must preserve both its fingerprint and every sentinel; it never receives production rows, credentials, or session tokens. After tests, root kills all gate-user processes, re-verifies uploaded sources, creates only the four exact external-state symlinks, strips candidate write escalation, and seals the complete tree including `node_modules`. The writer-protected cutover rechecks that digest immediately before PM2 stops and Linux `renameat2(RENAME_EXCHANGE)` atomically swaps the candidate and active directories. / 候选位于外置门禁目录，完整测试以禁止登录的门禁用户执行，并使用原生支持 Ubuntu 26 的 Playwright 1.61.1 与 Chromium 沙箱。root 从一致性生产备份中仅重建数据库结构、校验生产结构指纹，并在认证、CRM、网红、知识库和 AI 对话表写入固定合成哨兵；候选代码只在断网环境读取该脱敏数据库，必须保持结构指纹与全部哨兵完整，且不会获得生产业务行、凭据或会话令牌。测试后由 root 清理门禁进程、复验上传源码、仅创建四个精确外置状态链接、移除写权限并封存包含 `node_modules` 的完整目录；writer 保护的切换会在停止 PM2 前立即复核摘要，再原子交换活动版本。

A rejected candidate is deleted without stopping active PM2. The current lifecycle moves from `locked` directly into writer-protected `mutation-intent`, confirmed `mutation-started`, and `cutover-complete`; historical `candidate-ready` is read only for recovery compatibility and is not independently written. Production cutover, recovery, and rollback require the stable global `/root/turingmarket/.deploy-v030.writer` mutex and revalidate the lifecycle owner after acquiring it. Recovery cannot overlap a cutover that survived an SSH disconnect, a delayed cutover cannot enter a replacement lock generation, and an old phase writer cannot overwrite a newer lifecycle. Only confirmed mutation triggers automatic restore. An unreadable or uncertain phase, or an active/stale writer mutex, causes no further automatic production action and retains the locks. / 候选验证失败时仅删除候选目录，不停止活动 PM2；当前生命周期从 `locked` 直接进入受 writer 保护的 `mutation-intent`、确认开始变更与切换完成，历史 `candidate-ready` 仅作恢复兼容读取，不再独立写入。生产切换、恢复与回滚必须取得稳定的全局 `/root/turingmarket/.deploy-v030.writer` 互斥，并在获取后重新校验生命周期 owner，从而阻止 SSH 中断并发、延迟切换进入新锁代际及旧阶段覆盖新生命周期。只有确认开始变更才自动恢复；阶段不可读、不确定或 writer 活动/残留时不再自动操作生产并保留锁。

Manual rollback / 手工回滚：

```powershell
.\platform\deploy_v8.ps1 -RollbackBackup backups/v040-product-shell-design-system-<timestamp>
```

The same restore function is used by automatic and manual rollback. Manual rollback bypasses deploy-only branch and clean-worktree gates. It verifies checksums, stops PM2, restores code plus root/server dependency trees, restores Nginx, restarts `turingmarket` from `platform/ecosystem.config.js`, and verifies health. It does not automatically restore the database or credential state. / 自动与手工回滚共用同一恢复函数；手工回滚跳过正式发布专用的分支与干净工作树门禁，验签后先停止 PM2，再恢复代码、两层依赖与 Nginx，最后重启并验证健康；不会自动恢复数据库或凭据状态。

Phase 4 design requires extending this real `platform/deploy_v8.ps1` path before any schema cutover: checksum-bound code, Nginx, pre-migration database, and private PPT cache restore as one maintenance-mode unit; newest matching-user password/active/role/department/quota state is reapplied from a root-only overlay; and every session is deleted before restart. This is a planned v0.5 gate, not a current v0.4 capability. / 第 4 阶段要求在 schema 切换前扩展当前真实的 `platform/deploy_v8.ps1` 回滚路径：在维护模式下一体验签恢复代码、Nginx、迁移前数据库与私有 PPT 缓存，再从仅 root 可读的安全覆盖层回填最新匹配用户的密码、启用状态、角色、部门与额度，并在重启前删除全部会话。该能力属于 v0.5 计划门禁，不代表当前 v0.4 已具备。

The Phase 4 release gate also treats the SQLite database and `PPT_CACHE_DIR` as one checksummed backup/restore/prune unit; performs WAL-safe stop/checkpoint/atomic restore; carries `department` in the root-only security overlay; reconciles membership projection; and completes checksum-verified resumable code-tree and Nginx restoration before service restart. Until that exact path is implemented and tested, production remains on v0.4. / 第 4 阶段还必须把 SQLite 与 `PPT_CACHE_DIR` 作为同一验签备份/恢复/清理单元，执行 WAL 安全停写、检查点与原子恢复，在安全覆盖层中携带 `department` 并核对成员关系投影，且在服务重启前完成可恢复、验签的代码树与 Nginx 恢复；该路径实现并验证前生产继续保持 v0.4。

## Security And Secrets / 安全与密钥

Keep production values for `JWT_SECRET`, administrator bootstrap credentials, DeepSeek, Tavily, Feishu, and Obsidian integrations in protected server-side environment storage. Public Git files may contain variable names only. Never print credentials, cookies, bearer tokens, or provider keys in release evidence. / JWT、管理员初始化、DeepSeek、Tavily、飞书与 Obsidian 的生产值仅放在服务端受保护环境中；公开仓库只记录变量名，发布证据不得输出任何真实凭据。

Session invalidation is the deploy default. `-PreserveSessions` requires an explicit security decision. Code rollback must never restore old password hashes, JWT secrets, session state, or plaintext environment backups. / 发布默认撤销全部会话；使用 `-PreserveSessions` 必须有明确安全决定；代码回滚不得恢复旧密码哈希、JWT、会话或明文环境备份。

## Required Completion Evidence / 完成证据

Before a release is accepted, retain the Git commit and remote SHA, backup identifier, checksum verification, Node and Playwright counts, frozen PPT hash, 72-image comparison, route/static smoke, Nginx status, PM2 status, and authenticated production workflow results. / 版本验收前必须留存 Git 与远端 SHA、备份编号、校验结果、Node/Playwright 计数、冻结 PPT 哈希、72 图对比、路由与静态冒烟、Nginx、PM2 及生产登录态业务验收证据。
