# TuringMarket v8.0 一键部署脚本
# 以管理员身份运行 PowerShell，执行这个脚本

$SERVER = "8.163.129.160"
$SSH_KEY = "$env:USERPROFILE\.ssh\turingmarket_deploy"
$REMOTE_DIR = "/root/turingmarket/platform"
$LOCAL_DIR = "$env:USERPROFILE\Documents\海外品牌推广-红人营销-图灵\platform"

Write-Host "🚀 TuringMarket v8.0 部署开始" -ForegroundColor Cyan
Write-Host "目标服务器: $SERVER" -ForegroundColor Yellow

# 需要上传的文件
$FILES = @(
    "app.js",
    "index.html",
    "server\db.js",
    "server\server.js",
    "server\routes_customers.js",
    "server\routes.js",
    "server\generate_ppt.py"
)

# 1. 逐个上传文件
foreach ($file in $FILES) {
    $local = "$LOCAL_DIR\$file"
    $remote = "$REMOTE_DIR/$($file -replace '\\', '/')"
    Write-Host "  📤 上传 $file ..." -NoNewline
    scp -i $SSH_KEY -o StrictHostKeyChecking=no $local "root@${SERVER}:$remote" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host " ✅" -ForegroundColor Green
    } else {
        Write-Host " ❌" -ForegroundColor Red
    }
}

# 2. 安装依赖 + 重启
Write-Host "`n⚙️ 安装 python-pptx 并重启服务..." -ForegroundColor Yellow
ssh -i $SSH_KEY -o StrictHostKeyChecking=no root@$SERVER @"
cd $REMOTE_DIR
mkdir -p tmp
pip3 install python-pptx --break-system-packages 2>/dev/null
cd server
pm2 restart turingmarket 2>/dev/null || pm2 start server.js --name turingmarket
echo "DONE"
"@

Write-Host "`n✅ 部署完成!" -ForegroundColor Green
Write-Host "   访问: http://$SERVER/" -ForegroundColor Cyan
