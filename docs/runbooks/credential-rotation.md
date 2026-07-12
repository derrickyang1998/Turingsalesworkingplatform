# Credential Rotation Runbook / 凭据轮换运行手册

Scope / 范围：This runbook covers the current TuringMarket production platform: Express 5 + SQLite (better-sqlite3), PM2, Nginx, and the authoritative checkout `C:\Users\29272\Documents\在线商务平台-github-sync`. / 本手册覆盖当前图灵商务生产平台：Express 5 + SQLite (better-sqlite3)、PM2、Nginx，以及权威代码库 `C:\Users\29272\Documents\在线商务平台-github-sync`。

Non-negotiables / 禁止事项：

- Never write real passwords, JWT secrets, DeepSeek keys, Tavily keys, Feishu webhook values, cookies, or private server evidence into Git, public notes, command arguments, or chat output. / 禁止把真实密码、JWT 密钥、DeepSeek/Tavily 密钥、飞书 Webhook、Cookie 或服务器私密证据写入 Git、公开笔记、命令参数或聊天输出。
- Preserve CRM, AI, knowledge-base, influencer, and PPT behavior. The production UI must keep `ppt.js?v=20260702v916kbbridge` and `window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"`. / 保持 CRM、AI、知识库、红人和 PPT 行为不变；生产 UI 必须保留上述 PPT 版本标记。
- Rotate with `invalidate_all_sessions: true` unless an incident lead explicitly records a narrower scope. / 除非事件负责人书面记录更小范围，否则轮换时必须使用 `invalidate_all_sessions: true`。

## Preparation / 准备

1. Confirm the checkout and branch. / 确认代码库和分支。

```powershell
cd C:\Users\29272\Documents\在线商务平台-github-sync
git status --short
git branch --show-current
```

2. Confirm no unrelated files will be touched. The owned files for this documentation task are the runbook, `.env.example`, deployment docs, handoff docs, and the static security test. / 确认不会触碰无关文件；本文档任务只允许修改运行手册、`.env.example`、部署文档、交接文档和静态安全测试。
3. Prepare the private credential destination before generating any values. / 生成任何值之前先准备私有凭据目标目录。

Private credential destination / 私有凭据目标目录：

```text
D:\主盘\图灵集市\图灵商务平台开发\99-private
```

Recommended private manifest path / 建议私有清单路径：

```text
D:\主盘\图灵集市\图灵商务平台开发\99-private\2026-07-12-v0.2.10-user-credentials.md
```

Required private rotation payload path / 必须使用的私有轮换载荷路径：

```text
D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json
```

4. Restrict the local private directory to the operator account before writing generated credentials. / 写入生成凭据前，先把本机私有目录权限限制为操作者账号可读写。

```powershell
New-Item -ItemType Directory -Force -Path "D:\主盘\图灵集市\图灵商务平台开发\99-private" | Out-Null
icacls "D:\主盘\图灵集市\图灵商务平台开发\99-private" /inheritance:r
icacls "D:\主盘\图灵集市\图灵商务平台开发\99-private" /grant:r "${env:USERNAME}:(OI)(CI)F"
icacls "D:\主盘\图灵集市\图灵商务平台开发\99-private" /remove:g "Users" "Authenticated Users" "Everyone"
```

5. Create placeholders for evidence records. Public evidence may contain timestamps, command names, counts, checksums, and redacted screenshots; private evidence that identifies secret locations stays under `99-private`. / 建立证据记录占位；公开证据只能包含时间、命令、数量、校验和和脱敏截图，涉及密钥位置的私有证据保存在 `99-private`。

## Protected Backup / 受保护备份

Create a timestamped backup before rotation. / 轮换前创建带时间戳的备份。

Required contents / 必备内容：

- SQLite backup created through the SQLite backup API or an equivalent consistent database copy while the service is paused or quiescent. / 使用 SQLite backup API，或在服务暂停/静默时创建一致性数据库副本。
- Changed code files, Nginx config, PM2 process metadata, and checksums. / 变更代码、Nginx 配置、PM2 进程信息和校验和。
- Redacted environment inventory listing variable names only. / 只列变量名的脱敏环境清单。

Excluded from general backups / 常规备份排除：

- Plaintext `.env`, `.env.bak*`, generated passwords, JWT secret values, DeepSeek/Tavily values, and Feishu webhook values. / 明文 `.env`、`.env.bak*`、生成密码、JWT 密钥值、DeepSeek/Tavily 值和飞书 Webhook 值。

If a short-lived protected copy is needed for emergency recovery, store it only in a private root-owned directory with mode `700`, record the filename in private evidence, and remove it after successful smoke tests. / 如需临时受保护副本用于紧急恢复，只能放在 root 私有目录并设置 `700` 权限，在私有证据中记录文件名，冒烟通过后删除。

## Safe Generation, Storage, And Transfer / 安全生成、存储与传输

Generate user temporary passwords outside Git with a password manager or local secure generator. / 使用密码管理器或本机安全生成器在 Git 之外生成用户临时密码。

Storage rules / 存储规则：

- Write each generated password once to the private manifest under `99-private`. / 每个生成密码只写入一次 `99-private` 下的私有清单。
- Do not paste generated values into terminals, shell history, public Markdown, issue trackers, or chat. / 不得把生成值粘贴到终端、Shell 历史、公开 Markdown、工单或聊天。
- Build the rotation payload with placeholders in public docs and real values only in the ignored private workspace. / 公开文档只写占位符，真实值只放在被忽略的私有工作区。

Payload shape / 输入结构：

```json
{
  "actor_username": "<active-admin-username>",
  "invalidate_all_sessions": true,
  "reason": "security credential rotation",
  "rotations": [
    {
      "username": "<active-platform-username>",
      "password": "<temporary-password-generated-offline>"
    }
  ]
}
```

## STDIN-ONLY CLI / 仅标准输入 CLI

The batch rotation CLI must receive UTF-8 JSON through stdin only. / 批量轮换 CLI 必须只通过标准输入接收 UTF-8 JSON。

Allowed local form / 允许的本地形式：

```powershell
$payloadPath = 'D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json'
cd platform/server
Get-Content -Raw -Encoding UTF8 -LiteralPath $payloadPath | node scripts/rotate_user_credentials.js
```

Allowed production form / 允许的生产形式：

```powershell
$payloadPath = 'D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json'
$productionHost = '<production-host>'
Get-Content -Raw -Encoding UTF8 -LiteralPath $payloadPath | ssh $productionHost "cd /root/turingmarket/platform/server && node scripts/rotate_user_credentials.js"
```

Expected summary-only output / 预期只输出汇总：

```text
ROTATED_USERS=<count>
SESSIONS_REVOKED=<count>
PASSWORD_VALUES_PRINTED=0
```

Forbidden forms / 禁止形式：

- `--password`, `--jwt-secret`, query strings, command-line JSON, or any process argument that contains a secret. / 禁止使用包含密钥的命令参数。
- Printing the payload before or after execution. / 禁止执行前后打印输入载荷。
- Saving the production payload outside the ignored private workspace. / 禁止把生产载荷保存到被忽略私有工作区之外。

## SESSION REVOCATION VERIFICATION / 会话撤销验证

The rotation payload must set `invalidate_all_sessions` to `true`. / 轮换载荷必须设置 `invalidate_all_sessions` 为 `true`。

Database verification / 数据库验证：

```sql
SELECT COUNT(*) AS count FROM sessions;
```

Expected result / 预期结果：`count = 0`.

Authenticated verification / 鉴权验证：

- Old password login returns `401`. / 旧密码登录返回 `401`。
- Any pre-rotation token calling `/api/auth/me` returns `401`. / 任意轮换前令牌访问 `/api/auth/me` 返回 `401`。
- New temporary password login returns `200`, then logout succeeds. / 新临时密码登录返回 `200`，随后退出成功。

Record only counts and HTTP statuses; do not record credential values or bearer tokens. / 只记录数量和 HTTP 状态，不记录凭据值或 Bearer Token。

## JWT Rotation / JWT 轮换

Generate a new JWT secret of at least 96 characters or equivalent entropy outside public logs. / 在公开日志之外生成不少于 96 字符或等强度的新 JWT 密钥。

Required controls / 必备控制：

- Store the new `JWT_SECRET` only in the server-side secret store or protected production `.env`. / 新 `JWT_SECRET` 只保存在服务端密钥存储或受保护的生产 `.env`。
- Do not echo the value. Do not pass the value as a process argument. / 不输出该值，不通过进程参数传递该值。
- Restart PM2 after updating the value. / 更新后重启 PM2。
- Verify old JWT tokens fail and newly issued tokens work. / 验证旧 JWT 令牌失败、新签发令牌可用。
- Remove `DEFAULT_ADMIN_PASSWORD` from production after the rotation no longer needs seed initialization. / 轮换后不再需要种子初始化时，从生产环境移除 `DEFAULT_ADMIN_PASSWORD`。

## Provider Evidence Classification / 第三方服务证据分类

Classify each provider before deciding whether console rotation is required. / 决定是否进入供应商控制台轮换前，先对每个供应商做证据分类。

| Provider / 服务 | Environment name / 环境变量名 | Status classes / 状态分类 | Console action / 控制台操作 |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `NO_ROTATION_REQUIRED`, `ROTATION_REQUIRED`, `UNKNOWN_NEEDS_REVIEW` | If evidence shows exposure or unauthorized use, revoke the old key in the DeepSeek console and install a new server-side key. / 如证据显示泄露或未授权使用，在 DeepSeek 控制台撤销旧密钥并安装新的服务端密钥。 |
| Tavily | `TAVILY_API_KEY`, `WEB_SEARCH_PROVIDER` | `NO_ROTATION_REQUIRED`, `ROTATION_REQUIRED`, `UNKNOWN_NEEDS_REVIEW` | If evidence shows exposure or unauthorized use, revoke the old key in the Tavily console and install a new server-side key. / 如证据显示泄露或未授权使用，在 Tavily 控制台撤销旧密钥并安装新的服务端密钥。 |
| Feishu | `FEISHU_WEBHOOK_URL` | `UNCONFIGURED`, `NO_ROTATION_REQUIRED`, `ROTATION_REQUIRED` | If configured and exposed, rotate the webhook in the Feishu console; if unconfigured, record `UNCONFIGURED` and keep CSV fallback. / 如已配置且暴露，在飞书控制台轮换 Webhook；如未配置，记录 `UNCONFIGURED` 并保留 CSV 兜底。 |

Evidence examples / 证据示例：

- Public path checks returned no secret body and response sizes did not match protected `.env` content. / 公开路径检查未返回密钥正文，响应大小不匹配受保护 `.env` 内容。
- Provider usage dashboard shows no unexpected calls. / 供应商用量面板没有异常调用。
- Webhook variable is absent from production, so Feishu is `UNCONFIGURED`. / 生产未配置 Webhook 变量，因此飞书为 `UNCONFIGURED`。

Do not paste console screenshots that reveal key fragments into public records. / 不要把含密钥片段的控制台截图写入公开记录。

## `.env.bak` Cleanup / `.env.bak` 清理

After rotation and smoke tests pass, remove plaintext environment backups from production deployment directories. / 轮换和冒烟通过后，删除生产部署目录中的明文环境备份。

```bash
find /root/turingmarket/platform -maxdepth 3 -type f -name ".env.bak*" -print -delete
```

Then verify no matching files remain. / 然后确认没有匹配文件残留。

```bash
find /root/turingmarket/platform -maxdepth 3 -type f -name ".env.bak*" -print
```

The command output may list filenames, but it must never print file contents. / 命令可以列出文件名，但绝不能打印文件内容。

## Smoke Tests / 冒烟测试

Run these after user password rotation, JWT rotation, PM2 restart, and `.env.bak` cleanup. / 在用户密码轮换、JWT 轮换、PM2 重启和 `.env.bak` 清理后运行。

- `/api/health` returns healthy. / `/api/health` 返回健康。
- New administrator login succeeds; old administrator password fails. / 新管理员凭据登录成功，旧管理员密码失败。
- One rotated team-member login succeeds; known old team-member password fails. / 一个已轮换团队账号登录成功，已知旧团队密码失败。
- `/api/auth/me` works only with newly issued tokens. / `/api/auth/me` 只接受新签发令牌。
- Template download, AI chat, DeepSeek, Tavily web search, influencer export, and Feishu fallback behavior remain usable. / 模板下载、AI 对话、DeepSeek、Tavily 联网搜索、红人导出和飞书兜底保持可用。
- PPT markers remain unchanged: `ppt.js?v=20260702v916kbbridge` and `window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"`. / PPT 标记保持不变。
- Final session count is zero after logout. / 退出后最终会话数为 0。

## Rollback Rule / 回滚规则

Production rollback may restore code only; it must never restore old password hashes, the old JWT secret, plaintext `.env.bak` files, or provider keys that were rotated. / 生产回滚只允许回滚代码；不得恢复旧密码哈希、旧 JWT 密钥、明文 `.env.bak` 文件或已轮换的供应商密钥。

If code rollback is required / 如需代码回滚：

1. Restore the previous code artifact and Nginx config only. / 只恢复旧代码工件和 Nginx 配置。
2. Keep the current `users.password_hash`, `sessions`, and `JWT_SECRET` state. / 保留当前 `users.password_hash`、`sessions` 和 `JWT_SECRET` 状态。
3. Re-run session verification and authenticated smoke tests. / 重新运行会话验证和鉴权冒烟。
4. If rollback accidentally reintroduces default-password behavior, stop and re-run the credential rotation flow before reopening access. / 如果回滚意外恢复默认密码行为，立即停止并重新执行凭据轮换后再开放访问。

## Evidence Retention / 证据留存

Public evidence may include / 公开证据可包含：

- Commit SHA, deployment timestamp, test command names, pass/fail counts, `ROTATED_USERS=<count>`, `SESSIONS_REVOKED=<count>`, and `PASSWORD_VALUES_PRINTED=0`. / Commit SHA、部署时间、测试命令名、通过/失败数量、轮换用户数量、撤销会话数量和 `PASSWORD_VALUES_PRINTED=0`。
- Checksums for code and backup artifacts. / 代码和备份工件校验和。
- Provider classification labels without secret fragments. / 不含密钥片段的供应商分类标签。

Private evidence under `99-private` may include / `99-private` 下的私有证据可包含：

- The generated credential manifest. / 生成凭据清单。
- Operator-only notes describing where server-side secrets were changed. / 仅操作者可见的服务端密钥变更位置说明。
- Access-controlled screenshots that reveal account names or provider-console context. / 包含账号名或供应商控制台上下文的受控截图。

Retention rule / 留存规则：keep public records sufficient for audit, but keep secret material out of Git permanently. / 公开记录必须足够审计，但密钥材料永远不得进入 Git。
