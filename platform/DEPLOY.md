# TuringMarket 阿里云部署指南

## 准备工作

### 1. 购买阿里云 ECS
- 配置: 2核4G（最低）, CentOS 7.9 或 Ubuntu 22.04
- 带宽: 按量计费 5Mbps 起步
- 安全组: 开放 22(SSH), 80(HTTP), 443(HTTPS), 3002(应用)

### 2. 连接服务器
\\\ash
ssh root@你的服务器IP
\\\

### 3. 安装 Node.js
\\\ash
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 或 CentOS
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs
\\\

### 4. 安装 PM2 和编译工具
\\\ash
npm install -g pm2
# better-sqlite3 需要编译
apt-get install -y build-essential python3  # Ubuntu
# yum install -y gcc-c++ make python3       # CentOS
\\\

## 部署步骤

### 5. 上传项目
在本地电脑执行:
\\\powershell
# 打包（排除 node_modules）
cd C:\Users\29272\Documents\海外品牌推广-红人营销-图灵
tar -czf turingmarket.tar.gz --exclude=node_modules --exclude=.git platform/

# 上传到服务器
scp turingmarket.tar.gz root@你的服务器IP:/root/
\\\

### 6. 服务器端部署
\\\ash
# SSH 进入服务器后
cd /root
tar -xzf turingmarket.tar.gz

# 安装依赖
cd platform/server
npm install --production

# 创建数据库目录
mkdir -p db

# 启动
pm2 start ../ecosystem.config.js
pm2 save
pm2 startup
\\\

### 7. 配置 Nginx（可选，推荐）
\\\ash
apt-get install -y nginx
\\\

创建 /etc/nginx/sites-available/turingmarket:
\\\
ginx
server {
    listen 80;
    server_name _;  # 或你的域名

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade ;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host System.Management.Automation.Internal.Host.InternalHost;
        proxy_cache_bypass ;
        proxy_set_header X-Real-IP ;
        proxy_set_header X-Forwarded-For ;
    }
}
\\\

\\\ash
ln -s /etc/nginx/sites-available/turingmarket /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx
\\\

## 访问
- 直接访问: http://你的服务器IP:3002
- 通过 Nginx: http://你的服务器IP

## 更新部署
\\\ash
# 重新上传后
pm2 restart turingmarket
\\\

## 默认账号
- 管理员: admin / turing2026
- 团队成员: 10人 (zhangwei, wangfang...)，统一密码 turing2026
