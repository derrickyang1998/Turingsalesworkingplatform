# TuringMarket 图灵商务在线工作平台 — 一键部署指南

> 换设备后从 GitHub 下载到上线，5 分钟内完成

## 🚀 一键部署（新服务器）

```bash
# 1. 克隆项目
git clone <github-repo-url>
cd <repo-directory>/platform

# 2. 运行安装脚本（自动安装 Node.js + 依赖 + PM2 + Nginx）
chmod +x install.sh
sudo bash install.sh
```

安装完成后访问: `http://你的服务器IP`

## 📋 手动部署步骤

### 环境要求
- Ubuntu 22.04+ / Debian 12+
- 安全组开放: 22(SSH), 80(HTTP), 3002(应用)

### 1. 安装 Node.js 20
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

### 2. 安装 PM2
```bash
npm install -g pm2
```

### 3. 安装项目依赖并启动
```bash
cd platform/server
npm install --production
mkdir -p db
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

### 4. 配置 Nginx（可选）
```bash
apt-get install -y nginx
cat > /etc/nginx/sites-available/turingmarket << 'NGINX'
server {
    listen 80;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/turingmarket /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
```

## 🔄 从 GitHub 更新
```bash
cd /root/turingmarket/platform
git fetch origin
git checkout codex/ai-knowledge-foundation
git pull --ff-only origin codex/ai-knowledge-foundation
cd server
npm install --production
pm2 restart turingmarket
```

## 🚫 发布源护栏
- 当前唯一发布源是 `C:\Users\29272\Documents\在线商务平台-github-sync\platform` 或线上同源 Git 分支 `codex/ai-knowledge-foundation`。
- 不要从 `C:\Users\29272\Documents\在线商务平台` 或旧 `海外品牌推广-红人营销-图灵` 静态目录发布。
- PowerShell 部署请使用 `platform/deploy_v8.ps1`；脚本会拒绝非 `github-sync` 路径，并校验 `ppt.js` build 与首页缓存版本。
- 发布后必须确认首页包含 `ppt.js?v=20260702v916kbbridge`，且 `ppt.js` 包含 `window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"`。
- 安全事件热修后，`deploy_v8.ps1` 默认清空现有登录会话并校验剩余为 0；只有明确评估无需强制重新登录时才可显式传入 `-PreserveSessions`。
- 部署脚本会安装版本化 Nginx 配置；候选配置必须通过 `nginx -t`，失败时自动恢复上一版配置。

## 👤 登录账号
管理员和团队成员密码必须通过私有 `.env` 或后台一次性临时密码配置，不在仓库中记录固定默认密码。

## 凭据轮换与会话撤销
- 凭据轮换运行手册：`docs/runbooks/credential-rotation.md`。
- 生产密码、JWT、DeepSeek、Tavily 和 `FEISHU_WEBHOOK_URL` 真实值只保存在服务端密钥存储或受保护的生产 `.env`，不得进入 Git。
- 批量账号轮换必须使用仅标准输入 CLI：`node scripts/rotate_user_credentials.js < ./rotation-payload.private.json`。
- 轮换后必须确认 `SELECT COUNT(*) AS count FROM sessions;` 返回 `0`，并完成旧密码/旧令牌拒绝测试。
- 回滚只允许恢复代码，不得恢复旧密码哈希、旧 JWT 密钥或明文 `.env.bak*`。

## 🛠 技术栈
- 前端: 纯 HTML/CSS/JS + Playwright 测试
- 后端: Node.js + Express 5 + SQLite (better-sqlite3)
- 部署: PM2 + Nginx (Ubuntu)
