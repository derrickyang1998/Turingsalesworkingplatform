# TuringMarket Production Deployment / 图灵商务平台生产部署

## Source Contract / 发布源契约

- Authoritative checkout / 唯一权威工作区：`C:\Users\29272\Documents\在线商务平台-github-sync`
- Release branch / 发布分支：`codex/v0.3.0-baseline-consolidation`
- Deployment entry / 部署入口：`platform/deploy_v8.ps1`
- Runtime / 运行时：Node.js 20, Express 5 + SQLite (better-sqlite3)
- PM2 contract / PM2 契约：`platform/ecosystem.config.js` starts `server/server.js` as `turingmarket`

Do not publish from an archived or static workspace. The guarded script rejects a different checkout, a different branch, or a dirty tracked worktree. / 不得从归档目录或旧静态工作区发布；脚本会拒绝非权威目录、错误分支或存在未提交改动的工作树。

The script is executable with the installed Windows PowerShell 5.1 and keeps its source ASCII-safe. Run `-ValidateLocalOnly` before any production connection to execute the same local source, build, inventory, and frozen-PPT checks without requiring SSH. / 脚本兼容当前安装的 Windows PowerShell 5.1，并保持源码 ASCII 安全；连接生产前先运行 `-ValidateLocalOnly`，可在不使用 SSH 的情况下执行同一套本地源码、构建、文件清单和冻结 PPT 校验。

## Frozen Client Contract / 冻结前端契约

The v0.3.0 consolidation release keeps the current user interface and PPT implementation frozen. / v0.3.0 基线整合版本保持当前 UI 与 PPT 实现不变。

```text
App build: 20260713-v030-baseline-consolidation
App cache key: app.js?v=20260713v030baselineconsolidation
PPT build: 20260702-v916-kb-bridge-client-cn
PPT cache key: ppt.js?v=20260702v916kbbridge
PPT SHA-256: f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e
window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"
Admin inert preview marker: ?preview=v030
```

Only these modular browser assets are public / 仅以下模块化前端资源允许公开访问：

- `/client/shared/build_info.js`
- `/client/core/navigation.js`

Every other `/client/*` path and private source path such as `/server/server.js` must return `404` through both Express and Nginx. / 其他 `/client/*` 以及 `/server/server.js` 等私有源码路径必须在 Express 与 Nginx 两层均返回 `404`。

## Deploy / 部署

Production host and credentials remain external environment configuration. No host, password, token, provider key, cookie, or bearer value belongs in Git. / 生产主机与凭据由外部环境提供，禁止将主机、密码、令牌、供应商密钥、Cookie 或 Bearer 值写入 Git。

```powershell
$env:TURINGMARKET_SERVER = '<production-host>'
Set-Location 'C:\Users\29272\Documents\在线商务平台-github-sync'
.\platform\deploy_v8.ps1 -ValidateLocalOnly
.\platform\deploy_v8.ps1
```

`-ValidateLocalOnly` is a local-only mode and performs zero remote operations. It cannot be combined with `-RollbackBackup`. Supplying `-RollbackBackup` explicitly with an empty, blank, malformed, or unsupported value is rejected locally and never falls through to deployment. / `-ValidateLocalOnly` 是零远端操作的纯本地模式，禁止与 `-RollbackBackup` 组合使用；显式传入空值、空白、格式错误或不受支持的回滚编号时会在本地拒绝，绝不会回落到正式部署。

By default, deployment invalidates all existing sessions. Use `-PreserveSessions` only after an explicit security decision. / 默认发布会撤销全部现有会话；只有经过明确安全评估后才使用 `-PreserveSessions`。

The Windows PowerShell 5.1 transport writes UTF-8 without BOM and normalizes CRLF or CR input to LF before sending any script to remote Bash. The local preflight executes this exact CRLF-to-LF check. / Windows PowerShell 5.1 传输层会使用无 BOM UTF-8，并在发送远端 Bash 前将 CRLF 或 CR 统一为 LF；本地预检会执行同一项转换自测。

The script performs these gates in order / 脚本按以下顺序执行：

1. Verify checkout, branch, clean state, build markers, cache keys, and frozen PPT hash. / 校验工作区、分支、干净状态、构建标记、缓存键及冻结 PPT 哈希。
2. Acquire the fail-closed lifecycle lock at `/root/turingmarket/.deploy-v030.lock`; deployment and manual rollback share it for their complete remote lifecycle, while production mutation additionally requires the stable global writer mutex. / 获取失败关闭的远端生命周期锁；正式发布与手工回滚在完整远端生命周期内共用该锁，生产变更还必须另外取得稳定的全局 writer 互斥。
3. Create `/root/turingmarket/backups/v030-baseline-consolidation-<timestamp>` with present/absent manifests, both root and server `node_modules`, a consistent `better-sqlite3` backup, Nginx configuration, and SHA-256 checksums. The backup path must not already exist. / 在生产根目录外置建立版本化备份，记录存在/缺失文件、两层 Node 依赖、一致性数据库副本、Nginx 配置与校验和；同名备份存在时立即失败。
4. Upload every runtime, browser, test, and evidence file only to `/root/turingmarket/releases/v030-baseline-consolidation-<timestamp>` and verify every checksum there. The active `/root/turingmarket/platform` tree is not overwritten during validation. / 所有文件只上传到独立候选发布目录并逐项校验；验证期间绝不覆盖活动生产目录。
5. In the candidate directory, install locked dependencies, run the complete Node suite against an absolute isolated database with dotenv disabled, run the Linux deployment browser smoke, and validate the candidate Nginx configuration. The frozen 102-test Windows browser baseline remains the required local gate. / 在候选目录中安装锁定依赖，使用绝对隔离数据库且禁用 dotenv 执行完整 Node、Linux 浏览器冒烟及候选 Nginx 校验；冻结的 102 项 Windows 基线仍为本地门禁。
6. Stop PM2, copy only live mutable state (`.env`, `server/db`, `uploads`, and `tmp`) into the validated candidate, then atomically exchange the candidate and active directories with Linux `renameat2(RENAME_EXCHANGE)`. Restart only from `platform/ecosystem.config.js`. / 停止 PM2 后，仅同步生产可变状态，再通过 Linux 原子目录交换切换版本，并只从版本化 PM2 配置重启；用户不会收到测试中的混合版本。
7. Verify `/api/health`, `/m0`, `/m0-detail`, `/m4`, `/admin`, the exact public allowlist, and private-path denial before session invalidation and success. / 在撤销会话和判定成功前，验证健康检查、核心页面、公开白名单与私有路径拒绝。
8. A candidate-validation failure removes only the candidate and leaves active PM2 untouched. Automatic restore runs only after production mutation begins; it restores code, both dependency trees, repository evidence, and Nginx through the reviewed rollback function before restart and health verification. / 候选验证失败只清理候选目录，不停止活动 PM2；只有生产变更已开始时才自动恢复代码、两层依赖、公开证据与 Nginx，并重启后验证健康状态。

The current lifecycle moves from `locked` directly to writer-protected `mutation-intent`, `mutation-started`, and `cutover-complete`; `candidate-ready` is accepted only for recovery compatibility with an older interrupted run and is never written independently. Before any production mutation, the active cutover or recovery process must also own the stable global atomic writer mutex at `/root/turingmarket/.deploy-v030.writer` and recheck the lifecycle owner after acquiring it. This prevents SSH-disconnect overlap, delayed cutover entry into a replacement lock generation, and stale phase writes. A transport failure before mutation cleans only the candidate; confirmed `mutation-started` runs restore; `mutation-intent`, an unreadable phase, an active/stale writer mutex, or uncertain recovery retains the locks without another automatic production action. Treat retained locks as incident markers: confirm that no deployment, rollback, or remote cutover process is active, inspect production and backup state, and only then remove stale `.deploy-v030.lock` and `.deploy-v030.writer` paths. / 当前生命周期从 `locked` 直接进入受 writer 保护的 `mutation-intent`、`mutation-started` 和 `cutover-complete`；`candidate-ready` 仅用于兼容历史中断恢复，不再独立写入。任何生产变更前，切换或恢复进程还必须持有稳定的全局原子互斥 `/root/turingmarket/.deploy-v030.writer`，并在获取后重新校验生命周期 owner，从而阻止 SSH 中断并发、延迟进程跨锁代际写入和旧阶段覆盖。变更意图、阶段不可读、writer 活动或残留、恢复不确定时均停止自动生产操作并保留锁；必须确认没有活动发布、回滚或远端切换进程，并检查生产与备份状态后，才能清理残留的 lifecycle 与 writer 路径。

The remote full Node gate is equivalent to / 远端完整 Node 门禁等价于：

```bash
cd server
NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH=/root/turingmarket/releases/<release>/tmp/deploy-v030-gate-<timestamp>/test.db npm test -- --test-concurrency=1
```

## Rollback / 回滚

Use only a backup created by this release / 只允许使用本版本生成的备份：

```powershell
.\platform\deploy_v8.ps1 -RollbackBackup backups/v030-baseline-consolidation-<timestamp>
```

`-RollbackBackup backups/v030-baseline-consolidation-<timestamp>` needs only the authoritative script location plus external host/key configuration; it does not require the current branch or worktree to be deployable. Explicit empty, blank, or invalid identifiers are rejected before any server lookup or lock acquisition. It then acquires both lifecycle and writer ownership, verifies `SHA256SUMS`, stops PM2, restores files and both dependency trees, removes release-introduced files, restores Nginx, restarts `turingmarket`, and verifies `/api/health`. / 手工回滚不依赖当前分支或工作树可发布；显式空值、空白或非法备份编号会在查询服务器或获取远端锁之前拒绝。合法回滚随后同时取得生命周期锁和 writer 所有权，完成验签、停止 PM2、恢复文件与两层依赖、删除失败版本新增文件、恢复 Nginx，最后重启并验证健康状态。

The SQLite copy is retained for disaster recovery evidence and is not automatically restored during a code rollback, so old password hashes, sessions, or secret state are never reintroduced. / SQLite 备份仅作为灾备证据保留，代码回滚不会自动覆盖生产数据库，避免恢复旧密码哈希、会话或密钥状态。

## Release Evidence / 发布证据

Record the backup path, commit SHA, uploaded checksum result, full test counts, route smoke result, PM2 state, Nginx validation, and production browser result. Keep real credentials only in protected server-side storage. / 记录备份路径、提交 SHA、上传校验、完整测试计数、路由冒烟、PM2、Nginx 与生产浏览器验收结果；真实凭据仅保存在受保护的服务端存储中。

Credential rotation payloads remain outside Git at `D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json`. From `platform/server`, pass the protected UTF-8 payload through standard input only: / 凭据轮换载荷固定保存在 Git 之外，并且只通过标准输入执行：

```powershell
$payloadPath = 'D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json'
Get-Content -Raw -Encoding UTF8 -LiteralPath $payloadPath | node scripts/rotate_user_credentials.js
```
