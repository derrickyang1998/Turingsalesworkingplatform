#!/bin/bash
# TuringMarket — 一键安装脚本
# 用法: sudo bash install.sh

set -e
echo "=== TuringMarket 一键部署开始 ==="

# 1. Node.js 20
if ! command -v node &>/dev/null; then
  echo ">>> 安装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js $(node -v)"

# 2. PM2
if ! command -v pm2 &>/dev/null; then
  echo ">>> 安装 PM2..."
  npm install -g pm2
fi

# 3. 项目依赖
echo ">>> 安装项目依赖..."
cd "$(dirname "$0")/server"
npm install --production
mkdir -p db

# 4. 启动服务
echo ">>> 启动 TuringMarket..."
pm2 delete turingmarket 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# 5. Nginx (可选)
if ! command -v nginx &>/dev/null; then
  apt-get install -y nginx
fi
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

echo ""
echo "=== 部署完成! ==="
echo "访问地址: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo "管理员账号: admin / turing2026"