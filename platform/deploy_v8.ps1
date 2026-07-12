# TuringMarket guarded deploy script.
# Run from the current github-sync checkout only.

param(
    [switch]$PreserveSessions
)

$ErrorActionPreference = "Stop"

$SERVER = $env:TURINGMARKET_SERVER
$SSH_KEY = "$env:USERPROFILE\.ssh\turingmarket_deploy"
$REMOTE_DIR = "/root/turingmarket/platform"
$LOCAL_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO_DIR = Split-Path -Parent $LOCAL_DIR
$EXPECTED_PPT_BUILD = "20260702-v916-kb-bridge-client-cn"
$EXPECTED_PPT_QUERY = "20260702v916kbbridge"
$invalidateSessionsFlag = if ($PreserveSessions) { "0" } else { "1" }

if ($PreserveSessions) {
    Write-Warning "Existing sessions will be preserved because -PreserveSessions was explicitly supplied."
}

if ([string]::IsNullOrWhiteSpace($SERVER)) {
    throw "TURINGMARKET_SERVER environment variable is required for production deploy."
}
$SERVER = $SERVER.Trim()
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

$FILES = @(
    "app.js",
    "index.html",
    "ppt.js",
    "DEPLOY.md",
    "deploy_v8.ps1",
    "nginx\turingmarket.conf",
    "server\db.js",
    "server\server.js",
    "server\routes_customers.js",
    "server\routes_brands.js",
    "server\routes.js",
    "server\scripts\rotate_user_credentials.js",
    "server\services\latest_ui_compat_service.js",
    "server\services\credential_rotation_service.js",
    "server\services\ai_service.js",
    "server\services\knowledge_service.js",
    "server\services\rag_service.js",
    "server\services\web_search_service.js",
    "server\services\file_ingest_service.js",
    "server\services\influencer_workflow_service.js",
    "server\services\public_assets_service.js",
    "server\tests\ai_knowledge_foundation.test.js",
    "server\tests\brand_workspace_ui.test.js",
    "server\tests\obsidian_and_business_knowledge.test.js",
    "server\tests\customer_workspace_ui.test.js",
    "server\tests\security_and_crm_access.test.js",
    "server\tests\credential_rotation.test.js",
    "server\tests\influencer_workflow.test.js",
    "server\tests\file_ingest_service.test.js",
    "server\tests\public_static_security.test.js",
    "server\generate_ppt.py"
)

$ROOT_FILES = @(
    @{ Local = (Join-Path $REPO_DIR "CHANGELOG.md"); Remote = "$REMOTE_DIR/CHANGELOG.md" }
)

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = "backups/v0210-security-$stamp"
ssh -i $SSH_KEY -o BatchMode=yes root@$SERVER "cd $REMOTE_DIR && mkdir -p $backupDir/nginx $backupDir/server/scripts $backupDir/server/services $backupDir/server/tests && cp index.html app.js ppt.js CHANGELOG.md $backupDir/ 2>/dev/null || true; cp server/server.js $backupDir/server/server.js 2>/dev/null || true; cp server/services/credential_rotation_service.js $backupDir/server/services/credential_rotation_service.js 2>/dev/null || true; cp server/scripts/rotate_user_credentials.js $backupDir/server/scripts/rotate_user_credentials.js 2>/dev/null || true; if [ -f /etc/nginx/sites-enabled/turingmarket ]; then cp -L /etc/nginx/sites-enabled/turingmarket $backupDir/nginx/turingmarket.conf; fi"

foreach ($file in $FILES) {
    $local = Join-Path $LOCAL_DIR $file
    if (-not (Test-Path $local)) {
        throw "Local deploy file missing: $local"
    }
    $remote = "$REMOTE_DIR/$($file -replace '\\', '/')"
    Write-Host "Uploading $file ..." -NoNewline
    scp -i $SSH_KEY -o BatchMode=yes $local "root@${SERVER}:$remote" 2>$null
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
    scp -i $SSH_KEY -o BatchMode=yes $item.Local "root@${SERVER}:$($item.Remote)" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Upload failed: $($item.Local)"
    }
    Write-Host " ok" -ForegroundColor Green
}

ssh -i $SSH_KEY -o BatchMode=yes root@$SERVER @"
set -e
cd $REMOTE_DIR
node --check app.js
node --check ppt.js
node --check server/server.js
node --check server/scripts/rotate_user_credentials.js
node --check server/services/latest_ui_compat_service.js
node --check server/services/credential_rotation_service.js
node --check server/services/file_ingest_service.js
node --check server/services/influencer_workflow_service.js
node --check server/services/public_assets_service.js
node --check server/tests/credential_rotation.test.js
install -m 0644 nginx/turingmarket.conf /etc/nginx/sites-available/turingmarket.candidate
rm -f /etc/nginx/sites-enabled/turingmarket
ln -s /etc/nginx/sites-available/turingmarket.candidate /etc/nginx/sites-enabled/turingmarket
if ! nginx -t; then
  rm -f /etc/nginx/sites-enabled/turingmarket
  if [ -f "$REMOTE_DIR/$backupDir/nginx/turingmarket.conf" ]; then
    install -m 0644 "$REMOTE_DIR/$backupDir/nginx/turingmarket.conf" /etc/nginx/sites-available/turingmarket
    ln -s /etc/nginx/sites-available/turingmarket /etc/nginx/sites-enabled/turingmarket
  elif [ -f /etc/nginx/sites-available/turingmarket ]; then
    ln -s /etc/nginx/sites-available/turingmarket /etc/nginx/sites-enabled/turingmarket
  fi
  rm -f /etc/nginx/sites-available/turingmarket.candidate
  exit 1
fi
mv /etc/nginx/sites-available/turingmarket.candidate /etc/nginx/sites-available/turingmarket
rm -f /etc/nginx/sites-enabled/turingmarket
ln -s /etc/nginx/sites-available/turingmarket /etc/nginx/sites-enabled/turingmarket
nginx -t
systemctl reload nginx
pm2 restart turingmarket 2>/dev/null || pm2 start server/server.js --name turingmarket
grep -q "$EXPECTED_PPT_QUERY" index.html
grep -q "$EXPECTED_PPT_BUILD" ppt.js
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS http://localhost:3002/api/health >/dev/null 2>&1; then
    break
  fi
  if [ "`$i" = "20" ]; then
    echo "Health check failed after restart" >&2
    exit 1
  fi
  sleep 1
done
if [ "$invalidateSessionsFlag" = "1" ]; then
  cd server
  node <<'NODE'
const Database = require('better-sqlite3');
const database = new Database('db/turingmarket.db');
const removed = database.prepare('DELETE FROM sessions').run();
const remaining = database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
database.close();
if (remaining !== 0) throw new Error('Session invalidation verification failed');
console.log('SESSIONS_INVALIDATED=' + removed.changes);
console.log('SESSIONS_REMAINING=0');
NODE
  cd ..
fi
echo "DEPLOY_OK"
"@

Write-Host "Deploy complete" -ForegroundColor Cyan
