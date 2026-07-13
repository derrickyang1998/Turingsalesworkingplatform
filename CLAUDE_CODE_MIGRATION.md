# TuringMarket Engineering Handoff / 图灵商务平台工程交接

Updated / 更新日期：2026-07-13

## Authoritative Baseline / 权威基线

- Checkout / 工作区：`C:\Users\29272\Documents\在线商务平台-github-sync`
- Branch / 分支：`codex/v0.3.0-baseline-consolidation`
- Backend / 后端：Node.js 20 + Express 5
- Database / 数据库：SQLite through `better-sqlite3`
- PM2 / 进程：`platform/ecosystem.config.js` -> `server/server.js`, process name `turingmarket`
- Production directory / 线上目录：`/root/turingmarket/platform`
- Health route / 健康检查：`/api/health`

This checkout consolidates the latest CRM, AI conversation, knowledge base, influencer workflow, Feishu, proposal, export, and PPT capabilities without reverting the latest interface. / 该工作区整合最新 CRM、AI 对话、知识库、网红执行、飞书、方案、导出与 PPT 能力，不回退最新界面。

## UI And PPT Lock / UI 与 PPT 锁定

```text
App build: 20260713-v030-baseline-consolidation
App query: 20260713v030baselineconsolidation
PPT build: 20260702-v916-kb-bridge-client-cn
PPT query: 20260702v916kbbridge
PPT SHA-256: f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e
Admin inert preview marker: ?preview=v030
```

Approved public modules / 获批公开模块：

- `/client/shared/build_info.js`
- `/client/core/navigation.js`

All other `/client/*` requests and private paths including `/server/server.js` remain denied. The 72 baseline screenshots under `docs/baselines/v0.2.9/screenshots` are frozen; post-edit comparison must remain within a `0.005` pixel ratio threshold. / 其他 `/client/*` 与 `/server/server.js` 等私有路径继续拒绝访问；72 张 UI 基线截图保持冻结，改造后像素差异比不得超过 `0.005`。

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

The ASCII-safe script runs under Windows PowerShell 5.1 and normalizes CRLF/CR to LF before no-BOM UTF-8 transport to remote Bash; local preflight executes that exact conversion check. It requires the exact branch and a clean tracked worktree for deployment, holds the fail-closed lifecycle lock `/root/turingmarket/.deploy-v030.lock` throughout every remote deployment or rollback, requires the stable global writer mutex for production mutation, creates an external `backups/v030-baseline-consolidation-<timestamp>`, uploads only into an isolated release candidate, and keeps the active tree untouched through complete remote Node/browser/Nginx gates. / ASCII 安全脚本兼容 Windows PowerShell 5.1，并在无 BOM UTF-8 发送远端 Bash 前将 CRLF/CR 统一为 LF，本地预检会执行同一转换自测；正式发布要求精确分支与干净工作树，发布或回滚的完整远端生命周期均持有失败关闭的 lifecycle 锁，生产变更还必须取得稳定的全局 writer 互斥；脚本建立外置版本化备份，且仅向隔离候选目录上传，在完整远端 Node、浏览器和 Nginx 门禁期间不修改活动目录。

Remote Node verification includes / 远端 Node 验证包含：

```bash
cd server
NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH=/root/turingmarket/releases/<release>/tmp/deploy-v030-gate-<timestamp>/test.db node --test --test-concurrency=1 tests/*.test.js
```

It also installs Chromium and runs the Linux-compatible deployment browser smoke before process cutover. After candidate approval, PM2 stops, `.env`, `server/db`, `uploads`, and `tmp` are synchronized, and Linux `renameat2(RENAME_EXCHANGE)` atomically swaps the candidate and active directories before Nginx/PM2 restart. / 同时安装 Chromium 并在切换前运行 Linux 兼容冒烟；候选通过后停止 PM2，同步生产可变状态，通过 Linux 原子目录交换切换版本，再重载 Nginx 与重启 PM2。

A rejected candidate is deleted without stopping active PM2. The current lifecycle moves from `locked` directly into writer-protected `mutation-intent`, confirmed `mutation-started`, and `cutover-complete`; historical `candidate-ready` is read only for recovery compatibility and is not independently written. Production cutover, recovery, and rollback require the stable global `/root/turingmarket/.deploy-v030.writer` mutex and revalidate the lifecycle owner after acquiring it. Recovery cannot overlap a cutover that survived an SSH disconnect, a delayed cutover cannot enter a replacement lock generation, and an old phase writer cannot overwrite a newer lifecycle. Only confirmed mutation triggers automatic restore. An unreadable or uncertain phase, or an active/stale writer mutex, causes no further automatic production action and retains the locks. / 候选验证失败时仅删除候选目录，不停止活动 PM2；当前生命周期从 `locked` 直接进入受 writer 保护的 `mutation-intent`、确认开始变更与切换完成，历史 `candidate-ready` 仅作恢复兼容读取，不再独立写入。生产切换、恢复与回滚必须取得稳定的全局 `/root/turingmarket/.deploy-v030.writer` 互斥，并在获取后重新校验生命周期 owner，从而阻止 SSH 中断并发、延迟切换进入新锁代际及旧阶段覆盖新生命周期。只有确认开始变更才自动恢复；阶段不可读、不确定或 writer 活动/残留时不再自动操作生产并保留锁。

Manual rollback / 手工回滚：

```powershell
.\platform\deploy_v8.ps1 -RollbackBackup backups/v030-baseline-consolidation-<timestamp>
```

The same restore function is used by automatic and manual rollback. Manual rollback bypasses deploy-only branch and clean-worktree gates. It verifies checksums, stops PM2, restores code plus root/server dependency trees, restores Nginx, restarts `turingmarket` from `platform/ecosystem.config.js`, and verifies health. It does not automatically restore the database or credential state. / 自动与手工回滚共用同一恢复函数；手工回滚跳过正式发布专用的分支与干净工作树门禁，验签后先停止 PM2，再恢复代码、两层依赖与 Nginx，最后重启并验证健康；不会自动恢复数据库或凭据状态。

## Security And Secrets / 安全与密钥

Keep production values for `JWT_SECRET`, administrator bootstrap credentials, DeepSeek, Tavily, Feishu, and Obsidian integrations in protected server-side environment storage. Public Git files may contain variable names only. Never print credentials, cookies, bearer tokens, or provider keys in release evidence. / JWT、管理员初始化、DeepSeek、Tavily、飞书与 Obsidian 的生产值仅放在服务端受保护环境中；公开仓库只记录变量名，发布证据不得输出任何真实凭据。

Session invalidation is the deploy default. `-PreserveSessions` requires an explicit security decision. Code rollback must never restore old password hashes, JWT secrets, session state, or plaintext environment backups. / 发布默认撤销全部会话；使用 `-PreserveSessions` 必须有明确安全决定；代码回滚不得恢复旧密码哈希、JWT、会话或明文环境备份。

## Required Completion Evidence / 完成证据

Before a release is accepted, retain the Git commit and remote SHA, backup identifier, checksum verification, Node and Playwright counts, frozen PPT hash, 72-image comparison, route/static smoke, Nginx status, PM2 status, and authenticated production workflow results. / 版本验收前必须留存 Git 与远端 SHA、备份编号、校验结果、Node/Playwright 计数、冻结 PPT 哈希、72 图对比、路由与静态冒烟、Nginx、PM2 及生产登录态业务验收证据。
