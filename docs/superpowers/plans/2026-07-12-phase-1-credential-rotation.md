# Phase 1 Credential Rotation And Incident Closure Implementation Plan / 阶段 1 凭据轮换与安全事件闭环实施计划

> **For agentic workers / 面向执行代理：** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Every production behavior change follows test-first RED -> GREEN -> REFACTOR. / 必须使用 `superpowers:subagent-driven-development` 按任务实施；所有生产行为变更遵循测试优先的 RED -> GREEN -> REFACTOR。

**Goal / 目标：** Rotate all active platform user credentials and the JWT signing secret, revoke stale sessions, preserve provider functionality unless evidence requires a provider-key rotation, record the incident review, and deploy `v0.2.10-security-credential-rotation` without changing CRM, AI, knowledge, influencer, or PPT behavior. / 轮换全部活动平台账号凭据与 JWT 签名密钥，撤销旧会话；除非证据表明必须轮换，否则保持第三方服务可用；记录安全事件审查，并在不改变 CRM、AI、知识库、网红和 PPT 行为的前提下部署 `v0.2.10-security-credential-rotation`。

**Architecture / 架构：** Add one focused credential-rotation service over the existing `users`, `sessions`, and `activity_log` tables. Both the administrator reset route and a stdin-only batch CLI call the same transactional service. Production passwords are generated outside Git, stored once in the ignored local Obsidian `99-private` directory with restrictive file permissions, streamed to the server without command-line values, and never printed by application tooling. / 在现有 `users`、`sessions` 和 `activity_log` 表之上增加一个聚焦的凭据轮换服务；管理员重置接口与仅从标准输入读取的批量 CLI 共用同一事务服务。生产密码在 Git 之外生成，仅写入本机 Obsidian 的 `99-private` 忽略目录并限制文件权限，通过不含命令行明文的标准输入传输到服务器，应用工具不得打印密码。

**Tech Stack / 技术栈：** Node.js 20, Express 5, better-sqlite3, bcryptjs, Node test runner, PowerShell, PM2, Nginx, SQLite backup API, Git/GitHub, Obsidian private archive.

## Global Constraints / 全局约束

- Authoritative checkout / 权威代码库：`C:\Users\29272\Documents\在线商务平台-github-sync`.
- Current isolated worktree and branch / 当前隔离工作树与分支：`codex/ai-knowledge-foundation`.
- Preserve / 保留：`ppt.js?v=20260702v916kbbridge` and `window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"`.
- No schema change is permitted in Phase 1 / 阶段 1 不允许修改数据库结构。
- Never print, commit, archive in a public note, or place a password/key in a process argument / 禁止输出、提交、写入公开归档或通过进程参数传递密码/密钥。
- Existing DeepSeek and Tavily values remain installed only if the Nginx evidence confirms `.env` bodies were not served; Feishu is currently unconfigured. Provider-console revocation remains an external action when required. / 仅当 Nginx 证据确认未返回 `.env` 正文时才保留现有 DeepSeek/Tavily 值；飞书当前未配置。如需供应商控制台撤销，仍属于外部操作。
- Production rollback may restore code but must never restore old password hashes, the old JWT secret, or plaintext `.env` backups. / 生产回滚可恢复代码，但不得恢复旧密码哈希、旧 JWT 密钥或明文 `.env` 备份。

---

### Task 1: Credential Rotation Service / 凭据轮换服务

**Files / 文件：**

- Create / 创建：`platform/server/services/credential_rotation_service.js`
- Create / 创建：`platform/server/tests/credential_rotation.test.js`

**Interfaces / 接口：**

- Produces / 产出：`passwordPolicyErrors(password) -> string[]`
- Produces / 产出：`generateTemporaryPassword() -> string`
- Produces / 产出：`rotateUserPasswords(db, options) -> { rotatedUsers, sessionsRevoked }`
- `options` contains `actorUserId`, `rotations: [{ username, password }]`, `invalidateAllSessions`, `ipAddress`, and `reason`.

- [ ] **RED:** Add service tests proving passwords shorter than 12 characters or missing uppercase, lowercase, digit, or symbol categories are rejected before any database mutation. / 添加服务测试，证明少于 12 位或缺少大小写字母、数字、符号类别的密码会在数据库变更前被拒绝。
- [ ] Run `node --test tests/credential_rotation.test.js`; expect failure because the service does not exist. / 运行测试并确认因服务不存在而失败。
- [ ] **GREEN:** Implement password policy validation and a generated temporary password of at least 20 characters containing every required category. / 实现密码策略和至少 20 位、包含全部必需类别的临时密码生成器。
- [ ] **RED:** Add tests proving a multi-user rotation is atomic, changes bcrypt hashes, revokes each affected user's sessions, optionally revokes all sessions, writes one `credential_rotation` audit row per user, and never includes password values in results or audit details. / 添加测试，证明批量轮换具备事务原子性、更新 bcrypt 哈希、撤销相关用户会话、可选择撤销全部会话、每个用户写入一条审计记录，且结果和审计详情不包含密码。
- [ ] Run the focused test and confirm the expected missing-rotation failure. / 运行聚焦测试并确认预期失败。
- [ ] **GREEN:** Implement the smallest transaction that satisfies the tests using existing tables only. / 仅使用现有表实现满足测试的最小事务。
- [ ] Run the focused test and confirm all Task 1 tests pass. / 运行聚焦测试并确认 Task 1 全部通过。

---

### Task 2: Administrator Reset Route Revokes Sessions / 管理员重置密码同步撤销会话

**Files / 文件：**

- Modify / 修改：`platform/server/server.js`
- Modify / 修改：`platform/server/tests/credential_rotation.test.js`

**Interfaces / 接口：**

- `POST /api/admin/users/reset-password/:id` calls `rotateUserPasswords`.
- A successful response returns `success`, `sessions_revoked`, and an optional one-time `temporary_password`; it never echoes a caller-supplied password.

- [ ] **RED:** Start the real server on an isolated port/database and prove the current reset route leaves an existing member token valid. / 在隔离端口和数据库启动真实服务器，证明当前重置接口仍会让成员旧令牌保持有效。
- [ ] Extend the same test to require: weak supplied password returns `400`; valid reset returns `200`; old password login returns `401`; old token `/api/auth/me` returns `401`; new password login returns `200`; an `admin_reset_password` audit row identifies the actor and target without secret values. / 扩展测试，要求弱密码返回 `400`、有效重置返回 `200`、旧密码登录返回 `401`、旧令牌访问 `/api/auth/me` 返回 `401`、新密码登录返回 `200`，并写入不含密钥的管理员重置审计记录。
- [ ] Run the focused test and confirm it fails on the current route behavior. / 运行聚焦测试并确认因当前接口行为而失败。
- [ ] **GREEN:** Replace the route's direct hash update with the shared service; return `404` for an unknown user and revoke the target user's sessions in the same transaction. / 使用共享服务替换接口中的直接哈希更新；未知用户返回 `404`，并在同一事务中撤销目标用户会话。
- [ ] Set Express `trust proxy` to loopback so audit IPs reflect the Nginx-forwarded client while direct public-port callers cannot forge proxy headers. / 将 Express `trust proxy` 设为 loopback，使审计 IP 反映 Nginx 转发客户端，同时避免直接访问公开端口的调用者伪造代理头。
- [ ] Run the focused test and confirm all route assertions pass. / 运行聚焦测试并确认接口断言全部通过。

---

### Task 3: Stdin-Only Batch Rotation CLI / 仅标准输入的批量轮换 CLI

**Files / 文件：**

- Create / 创建：`platform/server/scripts/rotate_user_credentials.js`
- Modify / 修改：`platform/server/tests/credential_rotation.test.js`
- Modify / 修改：`platform/deploy_v8.ps1`

**Interfaces / 接口：**

- CLI input is UTF-8 JSON from stdin: `{ "actor_username": "derrick", "invalidate_all_sessions": true, "rotations": [{ "username": "...", "password": "..." }], "reason": "..." }`.
- CLI output is summary-only: `ROTATED_USERS=<n>`, `SESSIONS_REVOKED=<n>`, `PASSWORD_VALUES_PRINTED=0`.

- [ ] **RED:** Add subprocess tests proving the CLI rejects TTY/no-input execution, malformed JSON, weak passwords, unknown users, and actor mismatch without partial mutation. / 添加子进程测试，证明 CLI 会拒绝终端/无输入执行、无效 JSON、弱密码、未知用户和操作者不匹配，且不会产生部分变更。
- [ ] Add a success test proving stdin JSON rotates two users atomically and stdout/stderr do not contain either password. / 添加成功测试，证明标准输入 JSON 可原子轮换两个用户，且标准输出/错误输出均不包含密码。
- [ ] Run the focused test and confirm expected failure because the CLI is absent. / 运行聚焦测试并确认因 CLI 不存在而失败。
- [ ] **GREEN:** Implement the CLI as a thin adapter over `credential_rotation_service`; do not add a second rotation implementation. / 将 CLI 实现为凭据轮换服务的薄适配层，不得增加第二套轮换逻辑。
- [ ] Add the service, CLI, and test file to the guarded deployment manifest and remote `node --check` list. / 将服务、CLI 和测试加入受保护部署清单与远端 `node --check` 清单。
- [ ] Run focused tests and static checks. / 运行聚焦测试与静态检查。

---

### Task 4: Security Runbook And Public Configuration Contract / 安全运行手册与公开配置契约

**Files / 文件：**

- Create / 创建：`docs/runbooks/credential-rotation.md`
- Modify / 修改：`.env.example`
- Modify / 修改：`platform/DEPLOY.md`
- Modify / 修改：`docs/handoff/2026-06-30/SECURITY.md`
- Modify / 修改：`docs/handoff/2026-06-30/OPERATIONS.md`
- Modify / 修改：`platform/server/tests/security_and_crm_access.test.js`

- [ ] **RED:** Add static contract assertions requiring the runbook, stdin-only CLI command, session-revocation verification, provider-status classification, private credential destination, backup/rollback rule, and Feishu environment variable names. / 添加静态契约断言，要求文档包含运行手册、仅标准输入 CLI 命令、会话撤销校验、第三方服务状态分类、私有凭据位置、备份/回滚规则和飞书环境变量名称。
- [ ] Run the security test and confirm the documentation assertions fail. / 运行安全测试并确认文档断言失败。
- [ ] **GREEN:** Write a bilingual operator runbook covering preparation, protected backup, user/JWT rotation, provider evidence classification, provider-console steps, `.env` backup removal, smoke tests, rollback, and evidence retention without real values. / 编写双语运维手册，覆盖准备、受保护备份、用户/JWT 轮换、第三方服务证据分类、供应商控制台操作、`.env` 备份清理、冒烟、回滚和证据保留，且不包含真实值。
- [ ] Update `.env.example` with `DEFAULT_ADMIN_USERNAME`, `FEISHU_WEBHOOK_URL`, `WEB_SEARCH_PROVIDER`, and comments that real values remain server-side. / 更新公开环境变量示例并说明真实值仅保存在服务器端。
- [ ] Correct stale operations documentation so it identifies the current Express/SQLite production platform and authoritative checkout. / 修正过时运维文档，明确当前 Express/SQLite 生产平台和权威代码库。
- [ ] Run the security test and confirm documentation contracts pass. / 运行安全测试并确认文档契约通过。

---

### Task 5: Review, Release Records, And Production Rotation / 审查、版本记录与生产轮换

**Files / 文件：**

- Modify / 修改：`CHANGELOG.md`
- Create / 创建：`docs/version-records/2026-07-12-v0.2.10-security-credential-rotation.md`
- Create / 创建：`archive/versions/2026-07-12-v0.2.10-security-credential-rotation.md`
- Create private local credential manifest at / 创建本机私有凭据清单：`D:\主盘\图灵集市\图灵商务平台开发\99-private\2026-07-12-v0.2.10-user-credentials.md`
- Create Obsidian release archive / 创建 Obsidian 版本归档：`D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\2026-07-12-v0.2.10-security-credential-rotation.md`

- [ ] Run `node --check` for every changed JavaScript file, focused tests, full `npm test`, secret scan, UTF-8 scan, and `git diff --check`. / 运行全部静态检查、聚焦测试、完整测试、密钥扫描、UTF-8 检查和差异检查。
- [ ] Obtain independent `minimal-change-engineer`, `code-reviewer`, and `application-security-engineer` approvals; resolve every critical/important finding and re-review. / 取得三个独立审查批准，修复全部关键/重要问题并复审。
- [ ] Create a timestamped production backup containing a consistent SQLite backup, changed code, Nginx config, and checksums; exclude plaintext `.env` from general release backups. / 创建含一致性 SQLite 备份、变更代码、Nginx 配置和校验和的带时间戳生产备份；常规版本备份不得包含明文 `.env`。
- [ ] Deploy code with default all-session invalidation; verify PM2, Nginx, `/api/health`, static private-path `404`, and unchanged PPT markers. / 使用默认全会话失效部署代码，并验证运行状态、健康检查、敏感路径和 PPT 标记。
- [ ] Generate strong temporary passwords for all 11 active users, write them once to the ignored local private manifest, restrict file permissions, stream the rotation JSON to the production CLI, and confirm `ROTATED_USERS=11` and zero sessions without printing values. / 为 11 个活动用户生成强临时密码，仅写入本机忽略的私有清单并限制权限，通过标准输入传输轮换 JSON，确认轮换 11 个用户且会话为 0，全程不输出密码。
- [ ] Generate a new 96-character-or-stronger JWT secret, update production `.env` without printing it, remove `DEFAULT_ADMIN_PASSWORD`, remove plaintext `.env.bak-*` files after rotation, restart PM2, and verify no secret file became public. / 生成不低于 96 字符强度的新 JWT 密钥，无输出更新生产 `.env`，移除 `DEFAULT_ADMIN_PASSWORD`，轮换后删除明文 `.env.bak-*`，重启 PM2 并验证密钥文件未公开。
- [ ] Preserve the current DeepSeek/Tavily values only after recording evidence that `.env` response sizes did not match the 617-byte production file; record Feishu as unconfigured and provider-console rotation as not required by current exposure evidence. / 仅在记录 `.env` 响应大小与 617 字节生产文件不匹配的证据后保留当前 DeepSeek/Tavily 值；记录飞书未配置，并根据当前暴露证据将供应商控制台轮换标记为非必需。
- [ ] Run authenticated production smoke: new `derrick` login, old admin password rejection, one rotated team login, old team password rejection when known, `/api/auth/me`, template download, AI chat/DeepSeek, Tavily web search, logout, and final zero sessions. / 运行生产鉴权冒烟，覆盖新管理员、旧管理员密码拒绝、一个已轮换团队账号、已知旧团队密码拒绝、鉴权信息、模板下载、AI/DeepSeek、Tavily 联网、退出和最终零会话。
- [ ] Run the full remote test suite and verify incident evidence/checksums. / 运行完整远端测试套件并验证安全事件证据与校验和。
- [ ] Commit, push, deploy/archive the same version record to CHANGELOG, repository version records, Obsidian, and GitHub; verify local, remote, and production SHAs. / 将同一版本记录同步到变更日志、仓库版本记录、Obsidian 和 GitHub，并校验本地、远端和生产 SHA。

## Phase Definition Of Done / 阶段完成定义

Phase 1 is complete only when all 11 active users have new passwords, the old administrator password and all pre-rotation sessions fail, JWT signing has changed, plaintext environment backups are removed, provider exposure is evidence-classified, production AI/web/PPT/influencer smoke passes, independent reviewers return `APPROVE`, and the release is archived and pushed. / 只有当 11 个活动用户全部使用新密码、旧管理员密码与全部轮换前会话失效、JWT 签名已变更、明文环境备份已删除、第三方服务暴露完成证据分类、生产 AI/联网/PPT/网红冒烟通过、独立审查均为 `APPROVE` 且版本完成归档推送时，阶段 1 才算完成。
