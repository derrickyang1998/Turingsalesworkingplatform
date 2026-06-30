# 服务器、部署与密钥说明

更新时间：2026-06-30

## 当前仓库运行信息

当前 `C:\Users\29272\Documents\在线商务平台` 仓库是静态前端版本：

- 无后端 API 配置。
- 无数据库配置。
- 无 `.env` 文件。
- 无部署脚本。
- 本地运行方式：`python -m http.server 8017` 后访问 `site_home.html`。

## 历史远端生产信息

以下信息来自历史迁移资料和 2026-06-30 健康检查，属于远端生产线索，需要以服务器当前状态为准。

| 项 | 值 |
|---|---|
| 服务器 IP | `8.163.129.160` |
| 健康检查 | `http://8.163.129.160/api/health` |
| 2026-06-30 检查结果 | `status=ok` |
| 历史服务器目录 | `/root/turingmarket/platform` |
| 历史 Node 端口 | `3002` |
| 历史 Nginx 端口 | `80` |
| 历史 Node 版本 | `v20.20.2 (Ubuntu)` |
| 历史 GitHub 仓库 | `https://github.com/derrickyang1998/Turingsalesworkingplatform` |

## SSH 与凭据

不要把真实凭据写入 GitHub。历史迁移资料记录过：

- DeepSeek API key
- 服务器 IP
- SSH key 本机路径
- GitHub 仓库和分支信息
- 管理员账号/密码或初始化凭据

这些内容已复制到 Obsidian 本地私有目录：

```text
D:\主盘\图灵集市\图灵商务平台开发\99-private
```

如果团队多人协作，建议改用 1Password、Bitwarden、Doppler、Vault、阿里云 KMS 或 GitHub Actions Secrets 管理，Obsidian 只保留“在哪里取密钥”和“如何配置”的说明。

## 环境变量

公开仓库只保留 `.env.example`：

```env
DEEPSEEK_API_KEY=replace_with_private_value
SERVER_IP=8.163.129.160
SERVER_PORT=3002
PUBLIC_HTTP_PORT=80
SERVER_DIR=/root/turingmarket/platform
GITHUB_REPO=https://github.com/derrickyang1998/Turingsalesworkingplatform
```

本地开发使用 `.env.local`，服务器使用 systemd、PM2、Docker secret 或 CI/CD secret 注入。

## 后续部署建议

短期如果继续静态版：

- 使用 GitHub Pages、Vercel、Nginx 静态目录或对象存储托管。
- 将 `pptxgenjs` 从 CDN 改为本地依赖，减少外部网络风险。

中期如果恢复完整后端：

- 建立 `server/` 或 `api/` 目录。
- 使用 `.env.example` 定义变量，不提交真实 `.env`。
- 增加 `/api/health`、日志、数据库迁移和备份脚本。
- 用 GitHub Actions 做 lint/test/build/deploy。

