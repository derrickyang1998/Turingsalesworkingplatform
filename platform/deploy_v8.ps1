# TuringMarket guarded deploy script.
# Run from the current github-sync checkout only.

$ErrorActionPreference = "Stop"

$SERVER = "8.163.129.160"
$SSH_KEY = "$env:USERPROFILE\.ssh\turingmarket_deploy"
$REMOTE_DIR = "/root/turingmarket/platform"
$LOCAL_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO_DIR = Split-Path -Parent $LOCAL_DIR
$EXPECTED_PPT_BUILD = "20260702-v916-kb-bridge-client-cn"
$EXPECTED_PPT_QUERY = "20260702v916kbbridge"

if ((Split-Path -Leaf $REPO_DIR) -notmatch "github-sync$") {
    throw "Refusing to deploy from non github-sync checkout: $REPO_DIR"
}
if (-not (Test-Path $SSH_KEY)) {
    throw "SSH key not found: $SSH_KEY"
}
if (-not (Select-String -LiteralPath "$LOCAL_DIR\ppt.js" -Pattern $EXPECTED_PPT_BUILD -Quiet)) {
    throw "ppt.js does not contain expected build $EXPECTED_PPT_BUILD"
}
if (-not (Select-String -LiteralPath "$LOCAL_DIR\index.html" -Pattern $EXPECTED_PPT_QUERY -Quiet)) {
    throw "index.html does not reference expected ppt.js cache key $EXPECTED_PPT_QUERY"
}

Write-Host "TuringMarket guarded deploy starting" -ForegroundColor Cyan
Write-Host "Source: $LOCAL_DIR" -ForegroundColor Yellow
Write-Host "Target: ${SERVER}:$REMOTE_DIR" -ForegroundColor Yellow

$FILES = @(
    "app.js",
    "index.html",
    "ppt.js",
    "DEPLOY.md",
    "deploy_v8.ps1",
    "server\db.js",
    "server\server.js",
    "server\routes_customers.js",
    "server\routes_brands.js",
    "server\routes.js",
    "server\services\latest_ui_compat_service.js",
    "server\services\ai_service.js",
    "server\services\knowledge_service.js",
    "server\services\rag_service.js",
    "server\services\web_search_service.js",
    "server\tests\ai_knowledge_foundation.test.js",
    "server\tests\obsidian_and_business_knowledge.test.js",
    "server\tests\customer_workspace_ui.test.js",
    "server\tests\security_and_crm_access.test.js",
    "server\generate_ppt.py"
)

$ROOT_FILES = @(
    @{ Local = (Join-Path $REPO_DIR "CHANGELOG.md"); Remote = "$REMOTE_DIR/CHANGELOG.md" }
)

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
ssh -i $SSH_KEY -o StrictHostKeyChecking=no root@$SERVER "cd $REMOTE_DIR && mkdir -p backups/backup-v024-$stamp && cp index.html app.js ppt.js CHANGELOG.md server/server.js server/services/latest_ui_compat_service.js backups/backup-v024-$stamp/ 2>/dev/null || true"

foreach ($file in $FILES) {
    $local = Join-Path $LOCAL_DIR $file
    if (-not (Test-Path $local)) {
        throw "Local deploy file missing: $local"
    }
    $remote = "$REMOTE_DIR/$($file -replace '\\', '/')"
    Write-Host "Uploading $file ..." -NoNewline
    scp -i $SSH_KEY -o StrictHostKeyChecking=no $local "root@${SERVER}:$remote" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Upload failed: $file"
    }
    Write-Host " ok" -ForegroundColor Green
}

foreach ($item in $ROOT_FILES) {
    if (-not (Test-Path $item.Local)) {
        throw "Local deploy file missing: $($item.Local)"
    }
    Write-Host "Uploading $(Split-Path -Leaf $item.Local) ..." -NoNewline
    scp -i $SSH_KEY -o StrictHostKeyChecking=no $item.Local "root@${SERVER}:$($item.Remote)" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Upload failed: $($item.Local)"
    }
    Write-Host " ok" -ForegroundColor Green
}

ssh -i $SSH_KEY -o StrictHostKeyChecking=no root@$SERVER @"
set -e
cd $REMOTE_DIR
node --check app.js
node --check ppt.js
node --check server/server.js
node --check server/services/latest_ui_compat_service.js
pm2 restart turingmarket 2>/dev/null || pm2 start server/server.js --name turingmarket
grep -q "$EXPECTED_PPT_QUERY" index.html
grep -q "$EXPECTED_PPT_BUILD" ppt.js
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS http://127.0.0.1:3002/api/health >/dev/null 2>&1; then
    break
  fi
  if [ "`$i" = "20" ]; then
    echo "Health check failed after restart" >&2
    exit 1
  fi
  sleep 1
done
echo "DEPLOY_OK"
"@

Write-Host "Deploy complete: http://$SERVER/" -ForegroundColor Cyan
