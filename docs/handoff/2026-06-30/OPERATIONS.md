# Operations Handoff / 服务器、部署与运维交接

Updated / 更新时间：2026-07-13

## Current Production Platform / 当前生产平台

The current production platform is Express + SQLite (better-sqlite3) behind PM2 and Nginx, serving the vanilla JavaScript TuringMarket application and API from the `platform/` directory. / 当前生产平台是 Express + SQLite (better-sqlite3)，由 PM2 和 Nginx 承载，从 `platform/` 目录提供原生 JavaScript 图灵商务应用与 API。

Authoritative checkout / 权威代码库：

```text
C:\Users\29272\Documents\在线商务平台-github-sync
```

Do not deploy from the older local static workspace or from archived handoff folders. / 不要从旧本地静态工作区或归档交接目录发布。

## Runtime / 运行基线

| Item / 项 | Current contract / 当前契约 |
|---|---|
| Backend / 后端 | Node.js 20 + Express 5 / Node.js 20 + Express 5 |
| Database / 数据库 | SQLite via `better-sqlite3` / 通过 `better-sqlite3` 使用 SQLite |
| Process manager / 进程管理 | PM2 process named `turingmarket` / PM2 进程名 `turingmarket` |
| Reverse proxy / 反向代理 | Nginx proxies public traffic to the local Node service / Nginx 将公网流量代理到本机 Node 服务 |
| Health check / 健康检查 | `/api/health` / `/api/health` |
| Public env template / 公开环境模板 | `.env.example`, variable names only / `.env.example` 只记录变量名 |

## Deployment Source Guardrails / 发布源护栏

- Use `platform/deploy_v8.ps1` from `C:\Users\29272\Documents\在线商务平台-github-sync`. / 从权威 checkout 运行 `platform/deploy_v8.ps1`。
- The deploy script refuses non-`github-sync` paths and validates the PPT build markers before upload. / 部署脚本会拒绝非 `github-sync` 路径，并在上传前校验 PPT 构建标记。
- Keep these PPT markers unchanged unless a separate PPT release explicitly changes them. / 除非单独 PPT 版本明确变更，否则保持以下标记不变。

```text
ppt.js?v=20260702v916kbbridge
window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"
```

- Preserve CRM, AI, knowledge-base, influencer, export, and PPT behavior during security work. / 安全工作期间保持 CRM、AI、知识库、红人、导出和 PPT 行为不变。

## Secrets And Environment / 密钥与环境变量

Public docs and `.env.example` may name these variables, but real production values remain server-side. / 公开文档和 `.env.example` 可以列出这些变量名，但真实生产值仅保存在服务器端。

Required or supported names / 必需或支持的变量名：

- `JWT_SECRET`
- `DEFAULT_ADMIN_USERNAME`
- `DEFAULT_ADMIN_PASSWORD` for seed-only initialization, removed from production after rotation when no longer needed / `DEFAULT_ADMIN_PASSWORD` 仅用于初始化，轮换后不再需要时从生产移除
- `DEEPSEEK_API_KEY`
- `DEEPSEEK_API_URL`
- `DEEPSEEK_MODEL`
- `WEB_SEARCH_PROVIDER`
- `TAVILY_API_KEY`
- `FEISHU_WEBHOOK_URL`
- `OBSIDIAN_KB_ROOT`
- `PLATFORM_KB_VAULT_ROOT`

Private credential destination / 私有凭据目标目录：

```text
D:\主盘\图灵集市\图灵商务平台开发\99-private
```

## Credential Rotation Operations / 凭据轮换运维

Follow `docs/runbooks/credential-rotation.md` for preparation, protected backup, stdin-only CLI execution, all-session revocation verification, JWT rotation, provider evidence classification, `.env.bak` cleanup, smoke tests, rollback, and evidence retention. / 凭据轮换需遵循 `docs/runbooks/credential-rotation.md`，覆盖准备、受保护备份、仅标准输入 CLI、全会话撤销验证、JWT 轮换、供应商证据分类、`.env.bak` 清理、冒烟、回滚和证据留存。

Operational rules / 运维规则：

- Do not print credentials, provider keys, JWT values, cookies, or bearer tokens. / 不输出凭据、供应商密钥、JWT 值、Cookie 或 Bearer Token。
- Run the rotation CLI through stdin only: `node scripts/rotate_user_credentials.js < ./rotation-payload.private.json`. / 轮换 CLI 只通过标准输入执行。
- Verify `SELECT COUNT(*) AS count FROM sessions;` returns `0` after all-session invalidation. / 全会话失效后验证会话数量为 `0`。
- Rollback may restore code but must never restore old password hashes, old JWT secrets, or plaintext `.env.bak*` files. / 回滚可以恢复代码，但不得恢复旧密码哈希、旧 JWT 密钥或明文 `.env.bak*` 文件。

## Smoke Checklist / 冒烟清单

- `/api/health` returns healthy. / `/api/health` 健康。
- New administrator and one rotated team user can authenticate; known old credentials fail. / 新管理员和一个已轮换团队账号可登录，已知旧凭据失败。
- `/api/auth/me` accepts only newly issued tokens. / `/api/auth/me` 只接受新令牌。
- AI chat, DeepSeek, Tavily web search, template download, influencer export, Feishu fallback, and PPT generation still work. / AI 对话、DeepSeek、Tavily 联网、模板下载、红人导出、飞书兜底和 PPT 生成仍可用。
- Sensitive static paths remain denied by Express and Nginx. / 敏感静态路径继续被 Express 和 Nginx 拒绝。
- Final session count is zero after logout and rotation verification. / 退出和轮换验证后最终会话数为 0。

## Evidence / 证据

Keep public evidence limited to command names, redacted status summaries, counts, checksums, and commit SHAs. / 公开证据仅保留命令名、脱敏状态摘要、数量、校验和和 commit SHA。

Keep private evidence that contains account context or credential handling notes under `99-private`; do not copy it into Git. / 涉及账号上下文或凭据处理说明的私有证据保存在 `99-private`，不得复制到 Git。
