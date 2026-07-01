# TuringMarket 图灵商务在线工作平台 — 一键部署指南

> 换设备后从 GitHub 下载到上线，5 分钟内完成

## 🚀 一键部署（新服务器）

```bash
# 1. 克隆项目
git clone https://github.com/derrickyang1998/Turingsalesworkingplatform.git
cd Turingsalesworkingplatform/platform

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
cd Turingsalesworkingplatform
git pull origin master
cd platform/server
npm install --production
pm2 restart turingmarket
```

## 👤 登录账号
管理员和团队成员密码必须通过私有 `.env` 或后台一次性临时密码配置，不在仓库中记录固定默认密码。

## 🛠 技术栈
- 前端: 纯 HTML/CSS/JS + Playwright 测试
- 后端: Node.js + Express 5 + sql.js
- 部署: PM2 + Nginx (Ubuntu)
