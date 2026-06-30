# 安全与密钥管理

## 规则

- 不把真实 API key、服务器密码、SSH 私钥、Cookie、Token 提交到 GitHub。
- `.env`、`.env.local`、`.pem`、`.key` 默认被 `.gitignore` 排除。
- 公开文档只写密钥名称、用途、配置位置和获取方式。
- 本地 Obsidian 可以保存私有交接材料，但不建议把真实密钥同步到公开云端。

## 当前密钥清单

| 名称 | 用途 | GitHub 状态 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 历史远端 AI 策略/助手调用 | 仅在 `.env.example` 占位 |
| SSH 私钥 | 登录历史远端服务器 | 不提交 |
| GitHub 凭证 | 推送代码和创建 PR | 不提交 |
| 管理员账号/密码 | 历史平台管理后台 | 不提交 |

真实值请看本机 Obsidian 私有目录或团队密钥管理器。

