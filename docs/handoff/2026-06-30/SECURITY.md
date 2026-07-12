# Security And Secret Management / 安全与密钥管理

Updated / 更新时间：2026-07-13

## Rules / 规则

- Do not commit real API keys, server passwords, SSH private keys, cookies, JWT secrets, provider tokens, or Feishu webhook values to GitHub. / 不把真实 API Key、服务器密码、SSH 私钥、Cookie、JWT 密钥、供应商 Token 或飞书 Webhook 值提交到 GitHub。
- Public documents may list secret names, purposes, storage locations, and rotation steps only. / 公开文档只写密钥名称、用途、存储位置和轮换步骤。
- Real production values remain server-side in protected `.env` or a secret manager. / 真实生产值仅保存在服务器端受保护 `.env` 或密钥管理器中。
- Credential rotation must follow `docs/runbooks/credential-rotation.md`. / 凭据轮换必须遵循 `docs/runbooks/credential-rotation.md`。

## Current Secret Inventory / 当前密钥清单

| Name / 名称 | Purpose / 用途 | Public GitHub status / 公开仓库状态 |
|---|---|---|
| `JWT_SECRET` | Signs platform sessions / 签发平台会话 | Placeholder only in `.env.example` / 仅占位 |
| `DEFAULT_ADMIN_USERNAME` | Seed administrator username when no admin exists / 无管理员时的初始化管理员用户名 | Placeholder only / 仅占位 |
| `DEFAULT_ADMIN_PASSWORD` | Seed-only password before rotation / 仅初始化阶段使用的密码 | Placeholder only; production should remove after rotation / 仅占位，生产轮换后应移除 |
| `DEEPSEEK_API_KEY` | AI provider calls / AI 服务调用 | Placeholder only / 仅占位 |
| `TAVILY_API_KEY` | Web search provider calls / 联网搜索服务调用 | Placeholder only / 仅占位 |
| `WEB_SEARCH_PROVIDER` | Selects the web search provider, currently documented as `tavily` / 选择联网搜索供应商，当前示例为 `tavily` | Non-secret selector / 非密钥选择项 |
| `FEISHU_WEBHOOK_URL` | Optional Feishu notification webhook / 可选飞书通知 Webhook | Placeholder only; unconfigured systems use CSV fallback / 仅占位，未配置时使用 CSV 兜底 |
| SSH key / SSH 私钥 | Server access / 服务器访问 | Not committed / 不提交 |
| GitHub credential / GitHub 凭证 | Push and release operations / 推送与发布 | Not committed / 不提交 |

## Private Credential Destination / 私有凭据目标目录

Private credential destination / 私有凭据目标目录：

```text
D:\主盘\图灵集市\图灵商务平台开发\99-private
```

Use this directory only for operator-controlled private manifests and redacted incident notes that must not enter Git. / 该目录仅用于操作者控制的私有清单和不得进入 Git 的脱敏事件说明。

Recommended credential manifest path / 建议凭据清单路径：

```text
D:\主盘\图灵集市\图灵商务平台开发\99-private\2026-07-12-v0.2.10-user-credentials.md
```

## Rotation Controls / 轮换控制

- User password rotation uses the stdin-only CLI documented in `docs/runbooks/credential-rotation.md`; do not pass passwords as command arguments. / 用户密码轮换使用运行手册中的仅标准输入 CLI，不得通过命令参数传递密码。
- Session revocation must be verified with `SELECT COUNT(*) AS count FROM sessions;` returning `0` after all-session invalidation. / 全会话撤销后必须用 `SELECT COUNT(*) AS count FROM sessions;` 验证返回 `0`。
- JWT rotation must generate a new high-entropy server-side `JWT_SECRET`, restart PM2, and prove old tokens fail. / JWT 轮换必须生成新的高熵服务端 `JWT_SECRET`、重启 PM2，并证明旧令牌失败。
- Production rollback may restore code only; it must not restore old password hashes, the old JWT secret, or plaintext `.env.bak*` files. / 生产回滚只允许恢复代码，不得恢复旧密码哈希、旧 JWT 密钥或明文 `.env.bak*` 文件。

## Provider Evidence Classification / 第三方服务证据分类

Classify DeepSeek, Tavily, and Feishu evidence before rotating provider-side keys. / 轮换供应商侧密钥前，先对 DeepSeek、Tavily 和飞书证据分类。

- `NO_ROTATION_REQUIRED`: Evidence shows protected `.env` bodies were not served and provider dashboards show no unexpected usage. / 证据显示受保护 `.env` 正文未被访问，且供应商用量无异常。
- `ROTATION_REQUIRED`: Evidence shows exposure, unknown access, or suspicious provider usage; rotate in the provider console. / 证据显示暴露、未知访问或供应商异常用量；必须进入供应商控制台轮换。
- `UNCONFIGURED`: The variable is absent from production, such as an unset `FEISHU_WEBHOOK_URL`; record the state and keep fallback behavior. / 生产未配置该变量，例如 `FEISHU_WEBHOOK_URL` 缺失；记录状态并保留兜底行为。
- `UNKNOWN_NEEDS_REVIEW`: Evidence is incomplete; keep the provider under review until a console owner confirms status. / 证据不完整；由控制台负责人确认前保持复核状态。

Evidence records must contain labels, timestamps, HTTP statuses, response-size summaries, and redacted screenshots only. / 证据记录只能包含分类、时间、HTTP 状态、响应大小摘要和脱敏截图。
