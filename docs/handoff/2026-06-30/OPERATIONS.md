# Operations Handoff / 生产运维交接

Updated / 更新日期：2026-07-13

The current production platform uses Express + SQLite with `better-sqlite3`, PM2, and Nginx. / 当前生产平台使用 Express、SQLite、PM2 与 Nginx。

## Runtime Contract / 运行契约

| Item / 项目 | Contract / 契约 |
|---|---|
| Authoritative checkout / 权威工作区 | `C:\Users\29272\Documents\在线商务平台-github-sync` |
| Release branch / 发布分支 | `codex/v0.3.0-baseline-consolidation` |
| Backend / 后端 | Node.js 20 + Express 5 |
| Database / 数据库 | SQLite through `better-sqlite3` |
| PM2 / 进程 | `platform/ecosystem.config.js` -> `server/server.js`, name `turingmarket` |
| Production directory / 生产目录 | `/root/turingmarket/platform` |
| Reverse proxy / 反向代理 | Versioned Nginx configuration to local port 3002 |
| Health / 健康检查 | `/api/health` |

Do not deploy from an older static workspace. Use `platform/deploy_v8.ps1` only after the target commit is pushed and the authoritative branch is clean. / 禁止从旧静态工作区发布；仅在目标提交已推送且权威分支干净时运行部署脚本。

Windows PowerShell 5.1 is the supported local runner. Execute `.\platform\deploy_v8.ps1 -ValidateLocalOnly` first; this performs the real local preflight with zero remote operations, including CRLF/CR normalization to LF before no-BOM UTF-8 Bash transport. It cannot be combined with `-RollbackBackup`, and an explicit empty, blank, or invalid rollback value is rejected locally rather than falling through to deployment. / 本地执行环境锁定为 Windows PowerShell 5.1；先运行 `.\platform\deploy_v8.ps1 -ValidateLocalOnly`，以零远端操作完成真实本地预检，包括远端 Bash 无 BOM UTF-8 传输前的 CRLF/CR 到 LF 转换。该模式禁止与 `-RollbackBackup` 组合，显式空值、空白或非法回滚参数会在本地拒绝，不会回落为正式发布。

## Release Locks / 版本锁

```text
App: 20260713-v030-baseline-consolidation
App cache: 20260713v030baselineconsolidation
PPT: 20260702-v916-kb-bridge-client-cn
PPT cache: 20260702v916kbbridge
PPT SHA-256: f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e
Admin inert preview: ?preview=v030
```

Exact public client allowlist / 精确公开前端白名单：

- `/client/shared/build_info.js`
- `/client/core/navigation.js`

Unknown client files and private source paths, including `/client/unknown.js` and `/server/server.js`, must return `404`. / 未知前端文件与私有源码路径必须返回 `404`。

## Guarded Deployment / 受控发布

The deploy script validates source, branch, clean state, app/PPT markers, cache keys, and the frozen PPT checksum before contacting production. It never stores the production host or credentials in the repository. / 脚本在连接生产前校验发布源、分支、干净状态、构建标记、缓存键和 PPT 哈希；生产主机及凭据不进入仓库。

Formal deployment and manual rollback hold the fail-closed lifecycle lock `/root/turingmarket/.deploy-v030.lock` for their complete remote lifecycle. Cutover, recovery, and rollback must additionally own the stable global atomic mutex `/root/turingmarket/.deploy-v030.writer` and recheck lifecycle ownership after acquisition; a second or stale-generation production writer is rejected before mutation. / 正式发布与手工回滚在完整远端生命周期内持有失败关闭的生命周期锁；切换、恢复和回滚还必须取得稳定的全局原子互斥 `/root/turingmarket/.deploy-v030.writer`，并在获取后重新校验生命周期 owner，第二个写入者或旧代际延迟写入者会在生产变更前被拒绝。

Each release creates `/root/turingmarket/backups/v030-baseline-consolidation-<timestamp>` outside the active platform tree. It refuses to reuse an existing path and contains:

- Present and absent manifests for every deployed platform and repository evidence file / 全部发布文件的存在与缺失清单
- Prior public client assets, runtime code, root and server runtime dependencies, tests, and documentation / 上一版公开前端、运行代码、根目录与服务端两层运行依赖、测试与文档
- A consistent `better-sqlite3` database copy for disaster recovery evidence / 一致性数据库灾备副本
- The active Nginx configuration / 当前 Nginx 配置
- `SHA256SUMS` for fail-closed verification / 用于失败关闭校验的哈希清单

After backup, files are uploaded only to an isolated `/root/turingmarket/releases/v030-baseline-consolidation-<timestamp>` candidate and checksum-verified there. The candidate gate installs locked dependencies, rebuilds only the required native SQLite module, runs the full Node suite with an absolute isolated database and dotenv disabled, installs Chromium, and runs the cross-platform deployment browser smoke. The active tree remains untouched during these gates. / 备份后所有文件只进入隔离候选目录并逐项校验；候选门禁安装锁定依赖、重建必要原生模块，以绝对隔离数据库且禁用 dotenv 运行完整 Node 和浏览器冒烟；期间活动目录保持不变。

```bash
cd server
NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH=/root/turingmarket/releases/<release>/tmp/deploy-v030-gate-<timestamp>/test.db node --test --test-concurrency=1 tests/*.test.js
```

The complete deterministic 102-test browser baseline runs locally on locked Windows browser/font revisions; the Linux server runs the deployment smoke. After all candidate gates pass, PM2 is stopped, live mutable state is copied into the candidate, and `renameat2(RENAME_EXCHANGE)` atomically swaps the candidate with `/root/turingmarket/platform`. Nginx and PM2 are restarted only after the exchange. / 完整 102 项确定性浏览器基线在锁定的 Windows 环境执行，Linux 服务器执行部署冒烟；候选门禁全部通过后停止 PM2，同步生产可变状态，并用原子目录交换切换活动版本，随后才重载 Nginx 和重启 PM2。

If candidate validation fails, only the candidate is removed and active PM2 remains untouched. The current lifecycle moves from `locked` directly into writer-protected `mutation-intent`, confirmed `mutation-started`, and `cutover-complete`; historical `candidate-ready` is accepted only for recovery compatibility and is not independently written. Recovery first acquires the stable global writer mutex and rechecks the lifecycle generation, so it cannot overlap an original cutover process that survived an SSH disconnect, admit an old delayed process into a new lifecycle lock, or overwrite a newer phase. An unreadable or uncertain phase, or an active/stale writer mutex, performs no further automatic production action and deliberately retains the locks as incident markers. / 候选验证失败时只清理候选目录，活动 PM2 保持不变；当前生命周期从 `locked` 直接进入受 writer 保护的 `mutation-intent`、确认开始变更和切换完成，历史 `candidate-ready` 仅作恢复兼容，不再独立写入。恢复前必须取得稳定的全局 writer 互斥并重新校验生命周期代际，因此不会与 SSH 中断后仍存活的原切换进程并发，不会让旧延迟进程进入新生命周期锁，也不会覆盖新阶段。阶段不可读、不确定或 writer 活动/残留时不再自动操作生产，并保留锁作为故障标记。

## Smoke Matrix / 冒烟矩阵

Expected `200` / 预期 `200`：

- `/api/health`
- `/m0`
- `/m0-detail`
- `/m4`
- `/admin`
- `/client/shared/build_info.js`
- `/client/core/navigation.js`

Expected `404` / 预期 `404`：

- `/client/unknown.js`
- `/server/server.js`

Deployment succeeds only after these checks and the `turingmarket` process is online. / 只有上述检查全部通过且 `turingmarket` 在线，发布才可判定成功。

## Rollback / 回滚

Automatic rollback and manual rollback invoke the same reviewed restore path. / 自动回滚与手工回滚使用同一个已审查恢复路径。

```powershell
.\platform\deploy_v8.ps1 -RollbackBackup backups/v030-baseline-consolidation-<timestamp>
```

`-RollbackBackup backups/v030-baseline-consolidation-<timestamp>` accepts no other prefix and can run even when the branch or worktree is not deployable. The identifier is validated before server lookup or lock acquisition. Restore order is PM2 stop, code and both dependency trees, repository evidence, Nginx, PM2 restart, then health verification. The database backup is not applied automatically, preventing rollback from reintroducing old password hashes, sessions, JWT state, or provider credentials. / 参数只接受本版本前缀，且不要求当前分支可发布；编号会在服务器查询或加锁前校验。恢复顺序为停止 PM2、恢复代码与两层依赖、公开证据、Nginx、重启 PM2、健康检查；数据库不会自动覆盖，避免恢复旧认证状态。

## Credentials And Evidence / 凭据与证据

Production values for administrator bootstrap, JWT, DeepSeek, Tavily, Feishu, and Obsidian integrations remain in protected server-side storage. Do not print or commit them. Session invalidation is the default; `-PreserveSessions` is an explicit exception. / 管理员初始化、JWT、DeepSeek、Tavily、飞书和 Obsidian 生产值仅保存在服务端受保护存储中；不得输出或提交；会话撤销为默认行为。

The approved credential rotation payload path is `D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json`. Run it from `platform/server` through standard input only: / 获批轮换载荷路径如下，并且只能通过标准输入执行：

```powershell
$payloadPath = 'D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json'
Get-Content -Raw -Encoding UTF8 -LiteralPath $payloadPath | node scripts/rotate_user_credentials.js
```

Retain only redacted evidence: commit SHA, backup path, checksums, test counts, route outcomes, Nginx result, PM2 state, PPT hash, screenshot comparison, and authenticated workflow status. / 只保留脱敏证据：提交 SHA、备份路径、哈希、测试计数、路由结果、Nginx、PM2、PPT 哈希、截图对比及登录态业务状态。
