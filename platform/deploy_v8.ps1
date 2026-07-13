# TuringMarket v0.3.0 guarded production deploy and rollback.

param(
    [switch]$PreserveSessions,
    [string]$RollbackBackup,
    [switch]$ValidateLocalOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$SERVER = $env:TURINGMARKET_SERVER
$SSH_KEY = "$env:USERPROFILE\.ssh\turingmarket_deploy"
$REMOTE_ROOT = "/root/turingmarket"
$REMOTE_DIR = "$REMOTE_ROOT/platform"
$LOCAL_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO_DIR = Split-Path -Parent $LOCAL_DIR
$EXPECTED_REPO_DIR_B64 = "QzpcVXNlcnNcMjkyNzJcRG9jdW1lbnRzXOWcqOe6v+WVhuWKoeW5s+WPsC1naXRodWItc3luYw=="
$EXPECTED_REPO_DIR = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EXPECTED_REPO_DIR_B64))
$EXPECTED_BRANCH = "codex/v0.3.0-baseline-consolidation"
$EXPECTED_APP_BUILD = "20260713-v030-baseline-consolidation"
$EXPECTED_APP_QUERY = "20260713v030baselineconsolidation"
$EXPECTED_PPT_BUILD = "20260702-v916-kb-bridge-client-cn"
$EXPECTED_PPT_QUERY = "20260702v916kbbridge"
$EXPECTED_PPT_SHA256 = "f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e"
$invalidateSessionsFlag = if ($PreserveSessions) { "0" } else { "1" }
$deploymentLockToken = $null
$deploymentWriterToken = $null

$FILES = @(
    "app.js",
    "index.html",
    "ppt.js",
    "DEPLOY.md",
    "deploy_v8.ps1",
    "ecosystem.config.js",
    "package.json",
    "package-lock.json",
    "nginx\turingmarket.conf",
    "client\shared\build_info.js",
    "client\core\navigation.js",
    "data\demand_form_schema.json",
    "data\industry_brands.json",
    "data\industry_brands_v2.json",
    "data\influencer_schema.json",
    "data\proposal_templates.json",
    "server\package.json",
    "server\package-lock.json",
    "server\config\runtime_config.js",
    "server\db.js",
    "server\build_feishu_env.py",
    "server\extract_document_text.py",
    "server\extract_xlsx_text.py",
    "server\feishu_client.js",
    "server\generate_ppt.py",
    "server\ocr_document_text.py",
    "server\ppt_generator.js",
    "server\requirements.txt",
    "server\requirements-ocr.txt",
    "server\routes.js",
    "server\routes_brands.js",
    "server\routes_customers.js",
    "server\routes_feishu.js",
    "server\routes_feishu_v2.js",
    "server\routes_workflow.js",
    "server\server.js",
    "server\workflow_engine.js",
    "server\services\ai_service.js",
    "server\services\business_knowledge_service.js",
    "server\services\credential_rotation_service.js",
    "server\services\crm_access_service.js",
    "server\services\file_ingest_service.js",
    "server\services\influencer_workflow_service.js",
    "server\services\knowledge_service.js",
    "server\services\latest_ui_compat_service.js",
    "server\services\llm_service.js",
    "server\services\obsidian_ingest_service.js",
    "server\services\path_policy_service.js",
    "server\services\public_assets_service.js",
    "server\services\rag_service.js",
    "server\services\vault_export_service.js",
    "server\services\web_search_service.js",
    "server\scripts\bootstrap_production_browser_state.js",
    "server\scripts\capture_production_browser_baseline.js",
    "server\scripts\compare_ui_baseline_runs.js",
    "server\scripts\generate_ui_baseline_manifest.js",
    "server\scripts\lib\production_browser_evidence.js",
    "server\scripts\rotate_user_credentials.js",
    "server\scripts\update_ui_baseline.js",
    "server\tests\ai_knowledge_foundation.test.js",
    "server\tests\brand_workspace_ui.test.js",
    "server\tests\browser_baseline_tools.test.js",
    "server\tests\credential_rotation.test.js",
    "server\tests\customer_workspace_ui.test.js",
    "server\tests\deployment_source_contract.test.js",
    "server\tests\file_ingest_service.test.js",
    "server\tests\frontend_architecture_inventory.test.js",
    "server\tests\frontend_event_binding_contract.test.js",
    "server\tests\frontend_navigation_contract.test.js",
    "server\tests\frontend_public_assets.test.js",
    "server\tests\influencer_workflow.test.js",
    "server\tests\obsidian_and_business_knowledge.test.js",
    "server\tests\ppt_bridge_browser_contract.test.js",
    "server\tests\production_browser_evidence_tools.test.js",
    "server\tests\public_static_security.test.js",
    "server\tests\security_and_crm_access.test.js",
    "server\tests\browser-baseline.config.js",
    "server\tests\browser-baseline.spec.js",
    "server\tests\deployment-browser-smoke.config.js",
    "server\tests\deployment-browser-smoke.spec.js",
    "server\tests\fixtures\browser-baseline-data.json",
    "server\tests\fixtures\frontend-active-definitions.json",
    "server\tests\fixtures\task-9-upload-header-contract.json",
    "server\tests\fixtures\start_browser_fixture_server.js",
    "server\tests\helpers\browser_fixture.js",
    "server\tests\helpers\safe_fixture_paths.js"
)

$ROOT_RELATIVE_FILES = @(
    ".gitignore",
    ".env.example",
    "CHANGELOG.md",
    "CLAUDE_CODE_MIGRATION.md",
    "docs\runbooks\credential-rotation.md",
    "docs\handoff\2026-06-30\SECURITY.md",
    "docs\handoff\2026-06-30\OPERATIONS.md",
    "docs\superpowers\plans\2026-07-12-phase-1-credential-rotation.md",
    "docs\superpowers\plans\2026-07-12-turingmarket-platform-roadmap.md",
    "docs\baselines\v0.2.9\ui-ppt-manifest.json"
)

function Convert-ToRemotePath {
    param([Parameter(Mandatory = $true)][string]$PathValue)
    return $PathValue -replace '\\', '/'
}

function Assert-LastExitCode {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [int]$ExitCode = $LASTEXITCODE
    )
    if ($ExitCode -ne 0) {
        throw $Message
    }
}

function Add-FrozenScreenshotFiles {
    $screenshotRoot = Join-Path $REPO_DIR "docs\baselines\v0.2.9\screenshots"
    if (-not (Test-Path -LiteralPath $screenshotRoot -PathType Container)) {
        throw "Frozen screenshot directory is missing: $screenshotRoot"
    }

    $repoPrefix = [IO.Path]::GetFullPath($REPO_DIR).TrimEnd('\') + '\'
    $screenshots = Get-ChildItem -LiteralPath $screenshotRoot -Recurse -File | ForEach-Object {
        $fullPath = [IO.Path]::GetFullPath($_.FullName)
        if (-not $fullPath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Frozen screenshot escaped the repository root."
        }
        $fullPath.Substring($repoPrefix.Length)
    }
    $script:ROOT_RELATIVE_FILES += $screenshots | Sort-Object
}

function Assert-RollbackBackupPath {
    param([Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][string]$BackupPath)
    if ($BackupPath -notmatch '^backups/v030-baseline-consolidation-\d{8}-\d{6}$') {
        throw "Rollback backup must match backups/v030-baseline-consolidation-YYYYMMDD-HHMMSS"
    }
}

function Get-RemoteServer {
    if ([string]::IsNullOrWhiteSpace($SERVER)) {
        throw "TURINGMARKET_SERVER environment variable is required for production deploy."
    }
    $normalized = $SERVER.Trim()
    if ($normalized -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$') {
        throw "TURINGMARKET_SERVER must be a plain hostname or IPv4 address."
    }
    if (-not (Test-Path -LiteralPath $SSH_KEY -PathType Leaf)) {
        throw "SSH deployment key is missing."
    }
    return $normalized
}

function Convert-ToNativeArgument {
    param([Parameter(Mandatory = $true)][string]$Argument)
    if ($Argument -notmatch '[\s"]') { return $Argument }
    return '"' + $Argument.Replace('"', '\"') + '"'
}

function Invoke-NativeWithUtf8Input {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$InputText,
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [switch]$CaptureOutput
    )

    $inputPath = Join-Path $env:TEMP ("tm-native-stdin-{0}.tmp" -f ([Guid]::NewGuid().ToString('N')))
    $outputPath = Join-Path $env:TEMP ("tm-native-stdout-{0}.tmp" -f ([Guid]::NewGuid().ToString('N')))
    $errorPath = Join-Path $env:TEMP ("tm-native-stderr-{0}.tmp" -f ([Guid]::NewGuid().ToString('N')))
    $normalizedInput = $InputText -replace "`r`n?", "`n"
    [IO.File]::WriteAllText($inputPath, $normalizedInput, (New-Object Text.UTF8Encoding($false)))
    $nativeArguments = ($ArgumentList | ForEach-Object { Convert-ToNativeArgument $_ }) -join ' '
    try {
        $startArguments = @{
            FilePath = $FileName
            ArgumentList = $nativeArguments
            RedirectStandardInput = $inputPath
            NoNewWindow = $true
            Wait = $true
            PassThru = $true
        }
        if ($CaptureOutput) {
            $startArguments.RedirectStandardOutput = $outputPath
            $startArguments.RedirectStandardError = $errorPath
        }
        $process = Start-Process @startArguments
        $exitCode = $process.ExitCode
        if ($CaptureOutput) {
            $capturedOutput = [IO.File]::ReadAllText($outputPath, [Text.Encoding]::UTF8)
        }
    }
    finally {
        Remove-Item -LiteralPath $inputPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errorPath -Force -ErrorAction SilentlyContinue
    }
    Assert-LastExitCode -Message $FailureMessage -ExitCode $exitCode
    if ($CaptureOutput) {
        return $capturedOutput.Trim()
    }
}

function Assert-Utf8StandardInputTransport {
    $probePath = Join-Path $env:TEMP ("tm-utf8-stdin-{0}.js" -f ([Guid]::NewGuid().ToString('N')))
    $probeSource = @'
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  const hasBom = input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf;
  if (hasBom || input.toString('utf8') !== 'set -euo pipefail\n') {
    process.exitCode = 1;
    return;
  }
  process.stdout.write('TRANSPORT_OK\n');
});
'@
    [IO.File]::WriteAllText($probePath, $probeSource, (New-Object Text.UTF8Encoding($false)))
    try {
        $transportResult = Invoke-NativeWithUtf8Input -FileName 'node.exe' -ArgumentList @($probePath) -InputText "set -euo pipefail`r`n" -FailureMessage "UTF-8 standard-input transport self-test failed" -CaptureOutput
        if ($transportResult -ne 'TRANSPORT_OK') {
            throw "UTF-8 standard-input capture self-test failed"
        }
    }
    finally {
        Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-RemoteBash {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [switch]$RequireDeploymentLock,
        [switch]$RequireWriterLock,
        [switch]$CaptureOutput
    )

    $guards = New-Object 'Collections.Generic.List[string]'
    if ($RequireDeploymentLock) {
        if ([string]::IsNullOrWhiteSpace($deploymentLockToken)) {
            throw "A deployment lock token is required for this remote operation."
        }
        $lockGuard = @'
set -euo pipefail
LockDir="__REMOTE_ROOT__/.deploy-v030.lock"
test -f "$LockDir/owner"
test "$(cat "$LockDir/owner")" = "__LOCK_TOKEN__"
'@
        $lockGuard = $lockGuard.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
        $lockGuard = $lockGuard.Replace('__LOCK_TOKEN__', $deploymentLockToken)
        $guards.Add($lockGuard)
    }

    if ($RequireWriterLock) {
        if (-not $RequireDeploymentLock) {
            throw "A writer-protected remote operation must also require the deployment lock."
        }
        if ([string]::IsNullOrWhiteSpace($deploymentWriterToken)) {
            throw "A deployment writer token is required for this remote operation."
        }
        $writerGuard = @'
set -euo pipefail
WriterDir="__REMOTE_ROOT__/.deploy-v030.writer"
test -f "$WriterDir/owner"
test "$(cat "$WriterDir/owner")" = "__WRITER_TOKEN__"
'@
        $writerGuard = $writerGuard.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
        $writerGuard = $writerGuard.Replace('__WRITER_TOKEN__', $deploymentWriterToken)
        $guards.Add($writerGuard)
    }

    if ($guards.Count -gt 0) {
        $Script = ($guards -join "`n") + "`n" + $Script
    }

    $arguments = @(
        '-i',
        $SSH_KEY,
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        "root@$SERVER",
        'bash',
        '-se'
    )
    $result = Invoke-NativeWithUtf8Input -FileName 'ssh.exe' -ArgumentList $arguments -InputText $Script -FailureMessage $FailureMessage -CaptureOutput:$CaptureOutput
    if ($CaptureOutput) {
        return $result
    }
}

function Enter-RemoteDeploymentLock {
    $remoteScript = @'
set -euo pipefail
LockDir="__REMOTE_ROOT__/.deploy-v030.lock"
umask 077
if ! mkdir "$LockDir" 2>/dev/null; then
  echo "Another deployment or rollback holds the production lock" >&2
  exit 1
fi
printf '%s\n' "__LOCK_TOKEN__" > "$LockDir/owner"
printf '%s\n' "locked" > "$LockDir/phase"
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__LOCK_TOKEN__', $deploymentLockToken)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Unable to acquire the remote deployment lock"
}

function Exit-RemoteDeploymentLock {
    param([switch]$ReleaseWriterLock)

    if ($ReleaseWriterLock -and [string]::IsNullOrWhiteSpace($deploymentWriterToken)) {
        throw "A deployment writer token is required to release the writer and deployment locks."
    }

    $remoteScript = @'
set -euo pipefail
LockDir="__REMOTE_ROOT__/.deploy-v030.lock"
WriterDir="__REMOTE_ROOT__/.deploy-v030.writer"
RetiredDir="$LockDir.released.__LOCK_TOKEN__"
RetiredWriterDir="$WriterDir.released.__WRITER_TOKEN__"
test -f "$LockDir/owner"
test "$(cat "$LockDir/owner")" = "__LOCK_TOKEN__"
if [ "__RELEASE_WRITER__" = "1" ]; then
  test -f "$WriterDir/owner"
  test "$(cat "$WriterDir/owner")" = "__WRITER_TOKEN__"
  test ! -e "$RetiredWriterDir"
else
  test ! -e "$WriterDir"
fi
test ! -e "$RetiredDir"
mv "$LockDir" "$RetiredDir"
rm -rf "$RetiredDir"
if [ "__RELEASE_WRITER__" = "1" ]; then
  mv "$WriterDir" "$RetiredWriterDir"
  rm -rf "$RetiredWriterDir"
fi
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__LOCK_TOKEN__', $deploymentLockToken)
    $remoteScript = $remoteScript.Replace('__RELEASE_WRITER__', $(if ($ReleaseWriterLock) { '1' } else { '0' }))
    $remoteScript = $remoteScript.Replace('__WRITER_TOKEN__', $(if ($ReleaseWriterLock) { $deploymentWriterToken } else { '' }))
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Unable to release the remote deployment lock"
}

function Enter-RemoteWriterLock {
    if ([string]::IsNullOrWhiteSpace($deploymentWriterToken)) {
        throw "A deployment writer token is required to acquire the remote writer lock."
    }

    $remoteScript = @'
set -euo pipefail
LockDir="__REMOTE_ROOT__/.deploy-v030.lock"
WriterDir="__REMOTE_ROOT__/.deploy-v030.writer"
RetiredWriterDir="$WriterDir.released.__WRITER_TOKEN__"
umask 077
if ! mkdir "$WriterDir" 2>/dev/null; then
  echo "A production writer is still active or requires operator recovery" >&2
  exit 1
fi
printf '%s\n' "__WRITER_TOKEN__" > "$WriterDir/owner"
if ! test -f "$LockDir/owner" ||
   ! test "$(cat "$LockDir/owner")" = "__LOCK_TOKEN__"; then
  test ! -e "$RetiredWriterDir"
  mv "$WriterDir" "$RetiredWriterDir"
  rm -rf "$RetiredWriterDir"
  echo "The deployment lock generation changed before writer acquisition" >&2
  exit 1
fi
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__LOCK_TOKEN__', $deploymentLockToken)
    $remoteScript = $remoteScript.Replace('__WRITER_TOKEN__', $deploymentWriterToken)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Unable to acquire the remote production writer lock" -RequireDeploymentLock
}

function Get-RemoteDeploymentPhase {
    $remoteScript = @'
set -euo pipefail
LockDir="__REMOTE_ROOT__/.deploy-v030.lock"
test -f "$LockDir/phase"
cat "$LockDir/phase"
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $phase = Invoke-RemoteBash -Script $remoteScript -FailureMessage "Unable to determine the remote deployment phase" -RequireDeploymentLock -RequireWriterLock -CaptureOutput
    $allowed = @('locked', 'candidate-ready', 'mutation-intent', 'mutation-started', 'cutover-complete')
    if ($allowed -notcontains $phase) {
        throw "Remote deployment phase is missing or invalid."
    }
    return $phase
}

function Invoke-SecureCopy {
    param(
        [Parameter(Mandatory = $true)][string]$LocalPath,
        [Parameter(Mandatory = $true)][string]$RemotePath,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    scp -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes $LocalPath "root@${SERVER}:$RemotePath"
    Assert-LastExitCode -Message $FailureMessage
}

function Invoke-RemoteBackup {
    param([Parameter(Mandatory = $true)][string]$BackupPath)

    Assert-RollbackBackupPath -BackupPath $BackupPath
    $requiredPublicAssets = @("client/shared/build_info.js", "client/core/navigation.js")
    $platformManifest = (($FILES | ForEach-Object { Convert-ToRemotePath $_ }) -join "`n") + "`n"
    foreach ($asset in $requiredPublicAssets) {
        if (-not $platformManifest.Contains($asset)) {
            throw "Backup manifest is missing required public asset: $asset"
        }
    }
    $rootManifest = (($ROOT_RELATIVE_FILES | ForEach-Object { Convert-ToRemotePath $_ }) -join "`n") + "`n"

    $remoteScript = @'
set -euo pipefail
LiveDir="__REMOTE_DIR__"
RemoteRoot="__REMOTE_ROOT__"
BackupPath="__BACKUP_PATH__"
BackupAbsolute="$RemoteRoot/$BackupPath"
test -d "$LiveDir"
test ! -L "$LiveDir"
test ! -e "$BackupAbsolute"
mkdir -p "$BackupAbsolute/platform" "$BackupAbsolute/nginx" "$BackupAbsolute/database" "$BackupAbsolute/repository"
: > "$BackupAbsolute/files.present"
: > "$BackupAbsolute/files.absent"
: > "$BackupAbsolute/root-files.present"
: > "$BackupAbsolute/root-files.absent"
cat > "$BackupAbsolute/files.requested" <<'TM_PLATFORM_FILES'
__PLATFORM_MANIFEST__
TM_PLATFORM_FILES
cd "$LiveDir"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  if [ -f "$file" ]; then
    mkdir -p "$BackupAbsolute/platform/$(dirname "$file")"
    cp -- "$file" "$BackupAbsolute/platform/$file"
    printf '%s\n' "$file" >> "$BackupAbsolute/files.present"
  else
    printf '%s\n' "$file" >> "$BackupAbsolute/files.absent"
  fi
done < "$BackupAbsolute/files.requested"
cat > "$BackupAbsolute/root-files.requested" <<'TM_ROOT_FILES'
__ROOT_MANIFEST__
TM_ROOT_FILES
cd "$RemoteRoot"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  if [ -f "$file" ]; then
    mkdir -p "$BackupAbsolute/repository/$(dirname "$file")"
    cp -- "$file" "$BackupAbsolute/repository/$file"
    printf '%s\n' "$file" >> "$BackupAbsolute/root-files.present"
  else
    printf '%s\n' "$file" >> "$BackupAbsolute/root-files.absent"
  fi
done < "$BackupAbsolute/root-files.requested"
test -f /etc/nginx/sites-enabled/turingmarket
cp -L /etc/nginx/sites-enabled/turingmarket "$BackupAbsolute/nginx/turingmarket.conf"
if [ -d "$LiveDir/node_modules" ]; then
  tar -czf "$BackupAbsolute/root-node_modules.tgz" -C "$LiveDir" node_modules
  : > "$BackupAbsolute/root-node-modules.present"
else
  : > "$BackupAbsolute/root-node-modules.absent"
fi
test -d "$LiveDir/server/node_modules"
tar -czf "$BackupAbsolute/server-node_modules.tgz" -C "$LiveDir" server/node_modules
cd "__REMOTE_DIR__/server"
node - "$BackupAbsolute/database/turingmarket.db" <<'NODE'
const Database = require('better-sqlite3');
const destination = process.argv[2];
const database = new Database('db/turingmarket.db', { readonly: true, fileMustExist: true });
database.backup(destination)
  .then(() => database.close())
  .catch((error) => {
    database.close();
    console.error(error.message);
    process.exitCode = 1;
  });
NODE
cd "$BackupAbsolute"
find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum --check --status SHA256SUMS
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__BACKUP_PATH__', $BackupPath)
    $remoteScript = $remoteScript.Replace('__PLATFORM_MANIFEST__', $platformManifest.TrimEnd())
    $remoteScript = $remoteScript.Replace('__ROOT_MANIFEST__', $rootManifest.TrimEnd())

    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Remote backup failed" -RequireDeploymentLock
}

function Invoke-RemoteRestore {
    param([Parameter(Mandatory = $true)][string]$BackupPath)

    Assert-RollbackBackupPath -BackupPath $BackupPath
    $remoteScript = @'
set -euo pipefail
LiveDir="__REMOTE_DIR__"
RemoteRoot="__REMOTE_ROOT__"
BackupPath="__BACKUP_PATH__"
BackupAbsolute="$RemoteRoot/$BackupPath"
test -f "$BackupAbsolute/SHA256SUMS"
cd "$BackupAbsolute"
sha256sum --check --status SHA256SUMS

if pm2 describe turingmarket >/dev/null 2>&1; then
  pm2 stop turingmarket
fi
node <<'NODE'
const { execFileSync } = require('node:child_process');
const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }));
const application = processes.find((entry) => entry && entry.name === 'turingmarket');
const status = application && application.pm2_env && application.pm2_env.status;
if (application && status !== 'stopped') {
  throw new Error(`PM2 process did not stop before rollback: ${status || 'unknown'}`);
}
console.log(`ROLLBACK_PM2_STATE=${status || 'missing'}`);
NODE

# RESTORE_CODE
cd "$LiveDir"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  mkdir -p "$(dirname "$file")"
  cp -- "$BackupAbsolute/platform/$file" "$file"
done < "$BackupAbsolute/files.present"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  rm -f -- "$file"
done < "$BackupAbsolute/files.absent"
rm -rf node_modules
if [ -f "$BackupAbsolute/root-node-modules.present" ]; then
  test -f "$BackupAbsolute/root-node_modules.tgz"
  tar -xzf "$BackupAbsolute/root-node_modules.tgz" -C .
fi
rm -rf server/node_modules
test -f "$BackupAbsolute/server-node_modules.tgz"
tar -xzf "$BackupAbsolute/server-node_modules.tgz" -C .
cd "$RemoteRoot"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  mkdir -p "$(dirname "$file")"
  cp -- "$BackupAbsolute/repository/$file" "$file"
done < "$BackupAbsolute/root-files.present"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  rm -f -- "$file"
done < "$BackupAbsolute/root-files.absent"

# RESTORE_NGINX
test -f "$BackupAbsolute/nginx/turingmarket.conf"
install -m 0644 "$BackupAbsolute/nginx/turingmarket.conf" /etc/nginx/sites-available/turingmarket
rm -f /etc/nginx/sites-enabled/turingmarket
ln -s /etc/nginx/sites-available/turingmarket /etc/nginx/sites-enabled/turingmarket
nginx -t
systemctl reload nginx

# RESTORE_PROCESS
cd "$LiveDir"
pm2 restart ecosystem.config.js --only turingmarket --update-env || pm2 start ecosystem.config.js --only turingmarket --update-env

# RESTORE_HEALTH
for attempt in $(seq 1 30); do
  if curl -fsS http://localhost:3002/api/health >/dev/null; then
    echo "ROLLBACK_OK"
    exit 0
  fi
  sleep 1
done
echo "Rollback health verification failed" >&2
exit 1
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__BACKUP_PATH__', $BackupPath)

    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Remote rollback failed" -RequireDeploymentLock -RequireWriterLock
}

function Invoke-RemoteCandidateCleanup {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

    $remoteScript = @'
set -euo pipefail
rm -rf "__RELEASE_ROOT__"
'@
    $remoteScript = $remoteScript.Replace('__RELEASE_ROOT__', $ReleaseRoot)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Deployment recovery candidate cleanup failed" -RequireDeploymentLock -RequireWriterLock
}

function Invoke-DeploymentFailureRecovery {
    param(
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][bool]$BackupCreated
    )

    $script:deploymentWriterToken = [Guid]::NewGuid().ToString('N')
    Enter-RemoteWriterLock

    $phase = Get-RemoteDeploymentPhase
    switch ($phase) {
        'mutation-started' {
            if (-not $BackupCreated) {
                throw "Production mutation started without a completed rollback backup."
            }
            Invoke-RemoteRestore -BackupPath $BackupPath
            Invoke-RemoteCandidateCleanup -ReleaseRoot $ReleaseRoot
        }
        'mutation-intent' {
            throw "Production mutation state is uncertain; retain the lock for operator recovery."
        }
        'locked' {
            Write-Host "Production was not mutated; candidate cleanup only." -ForegroundColor Yellow
            Invoke-RemoteCandidateCleanup -ReleaseRoot $ReleaseRoot
        }
        'candidate-ready' {
            Write-Host "Candidate validation or cutover transport failed before production mutation; candidate cleanup only." -ForegroundColor Yellow
            Invoke-RemoteCandidateCleanup -ReleaseRoot $ReleaseRoot
        }
        'cutover-complete' {
            Write-Warning "Remote cutover completed but local confirmation failed; keep the deployed release and clean transient candidate state."
            Invoke-RemoteCandidateCleanup -ReleaseRoot $ReleaseRoot
        }
        default {
            throw "Remote deployment phase is not safe for automatic recovery."
        }
    }

    Exit-RemoteDeploymentLock -ReleaseWriterLock
}

function Invoke-ManualRollback {
    param([Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][string]$BackupPath)

    Assert-RollbackBackupPath -BackupPath $BackupPath
    $script:SERVER = Get-RemoteServer
    $script:deploymentLockToken = [Guid]::NewGuid().ToString('N')
    $script:deploymentWriterToken = [Guid]::NewGuid().ToString('N')
    $manualLockAcquired = $false
    try {
        Enter-RemoteDeploymentLock
        $manualLockAcquired = $true
        Enter-RemoteWriterLock
        Invoke-RemoteRestore -BackupPath $BackupPath
        Exit-RemoteDeploymentLock -ReleaseWriterLock
        $manualLockAcquired = $false
    }
    catch {
        if ($manualLockAcquired) {
            Write-Warning "Manual rollback failed while holding the remote deployment lock; retain the lock for operator recovery."
        }
        throw
    }
    Write-Host "Rollback complete" -ForegroundColor Cyan
}

function Assert-AuthoritativeCheckout {
    $actualRepoDir = [IO.Path]::GetFullPath($REPO_DIR).TrimEnd('\')
    $expectedRepoDir = [IO.Path]::GetFullPath($EXPECTED_REPO_DIR).TrimEnd('\')
    if (-not $actualRepoDir.Equals($expectedRepoDir, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to run from a non-authoritative checkout."
    }
}

function Assert-LocalReleaseSource {
    Add-FrozenScreenshotFiles
    Assert-Utf8StandardInputTransport

    $currentBranch = (& git -C $REPO_DIR branch --show-current).Trim()
    Assert-LastExitCode -Message "Unable to resolve current Git branch"
    if ($currentBranch -ne $EXPECTED_BRANCH) {
        throw "Refusing to deploy branch '$currentBranch'; expected '$EXPECTED_BRANCH'."
    }

    if (-not $ValidateLocalOnly) {
        $dirtyState = (& git -C $REPO_DIR status --porcelain) -join "`n"
        Assert-LastExitCode -Message "Unable to inspect Git worktree"
        if (-not [string]::IsNullOrWhiteSpace($dirtyState)) {
            throw "Refusing to deploy a dirty tracked worktree."
        }
    }

    foreach ($file in $FILES) {
        $localPath = Join-Path $LOCAL_DIR $file
        if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) {
            throw "Local deploy file is missing: $file"
        }
    }
    foreach ($file in $ROOT_RELATIVE_FILES) {
        $localPath = Join-Path $REPO_DIR $file
        if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) {
            throw "Local release evidence file is missing: $file"
        }
    }

    $buildInfoPath = Join-Path $LOCAL_DIR "client\shared\build_info.js"
    $navigationPath = Join-Path $LOCAL_DIR "client\core\navigation.js"
    $pptPath = Join-Path $LOCAL_DIR "ppt.js"
    $buildInfoContractCheck = @'
const fs = require('node:fs');
const vm = require('node:vm');
const sourcePath = process.argv[1];
const expected = { app: process.argv[2], ppt: process.argv[3] };
const window = {};
window.window = window;
vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), { window }, { filename: sourcePath });
if (JSON.stringify(window.TMBuild) !== JSON.stringify(expected)) {
  throw new Error(`TMBuild contract mismatch: ${JSON.stringify(window.TMBuild)}`);
}
if (window.tmAppBuild !== expected.app) {
  throw new Error(`tmAppBuild compatibility marker mismatch: ${window.tmAppBuild}`);
}
'@
    node -e $buildInfoContractCheck $buildInfoPath $EXPECTED_APP_BUILD $EXPECTED_PPT_BUILD
    Assert-LastExitCode -Message "Local build metadata contract failed"
    node --check $navigationPath
    Assert-LastExitCode -Message "Local navigation syntax check failed"
    if (-not (Select-String -LiteralPath (Join-Path $LOCAL_DIR "index.html") -Pattern $EXPECTED_APP_QUERY -Quiet)) {
        throw "index.html does not contain the locked app cache key."
    }
    if (-not (Select-String -LiteralPath $pptPath -Pattern $EXPECTED_PPT_BUILD -Quiet)) {
        throw "ppt.js does not contain the locked PPT build marker."
    }
    if (-not (Select-String -LiteralPath (Join-Path $LOCAL_DIR "index.html") -Pattern $EXPECTED_PPT_QUERY -Quiet)) {
        throw "index.html does not contain the locked PPT cache key."
    }
    $actualPptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $pptPath).Hash.ToLowerInvariant()
    if ($actualPptSha256 -ne $EXPECTED_PPT_SHA256) {
        throw "ppt.js SHA-256 does not match the frozen release contract."
    }
}

Assert-AuthoritativeCheckout

$rollbackRequested = $PSBoundParameters.ContainsKey('RollbackBackup')
if ($ValidateLocalOnly -and $rollbackRequested) {
    throw "ValidateLocalOnly cannot be combined with RollbackBackup."
}

if ($ValidateLocalOnly) {
    Assert-LocalReleaseSource
    Write-Host "LOCAL_DEPLOY_PREFLIGHT_OK" -ForegroundColor Cyan
    exit 0
}

if ($rollbackRequested) {
    Invoke-ManualRollback -BackupPath $RollbackBackup
    exit 0
}

Assert-LocalReleaseSource

$SERVER = Get-RemoteServer
$deploymentLockToken = [Guid]::NewGuid().ToString('N')
if ($PreserveSessions) {
    Write-Warning "Existing sessions will be preserved because -PreserveSessions was explicitly supplied."
}

$uploadChecksumLines = New-Object 'Collections.Generic.List[string]'
$remoteRelativePaths = New-Object 'Collections.Generic.List[string]'
foreach ($file in $FILES) {
    $localPath = Join-Path $LOCAL_DIR $file
    $remoteRelative = "platform/$(Convert-ToRemotePath $file)"
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash.ToLowerInvariant()
    $uploadChecksumLines.Add("$hash  $remoteRelative")
    $remoteRelativePaths.Add($remoteRelative)
}
foreach ($file in $ROOT_RELATIVE_FILES) {
    $localPath = Join-Path $REPO_DIR $file
    $remoteRelative = Convert-ToRemotePath $file
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash.ToLowerInvariant()
    $uploadChecksumLines.Add("$hash  $remoteRelative")
    $remoteRelativePaths.Add($remoteRelative)
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = "backups/v030-baseline-consolidation-$stamp"
$releaseDir = "releases/v030-baseline-consolidation-$stamp"
$remoteReleaseRoot = "$REMOTE_ROOT/$releaseDir"
$remoteCandidateDir = "$remoteReleaseRoot/platform"
$backupCreated = $false
$deploymentLockAcquired = $false

Write-Host "TuringMarket guarded deploy starting" -ForegroundColor Cyan
try {
    Enter-RemoteDeploymentLock
    $deploymentLockAcquired = $true
    Invoke-RemoteBackup -BackupPath $backupDir
    $backupCreated = $true

    $remotePathManifest = $remoteRelativePaths -join "`n"
    $prepareScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
ReleaseRoot="__RELEASE_ROOT__"
CandidateDir="__CANDIDATE_DIR__"
test ! -e "$ReleaseRoot"
mkdir -p "$CandidateDir"
cat > "$ReleaseRoot/.deploy-v030-paths" <<'TM_DEPLOY_PATHS'
__REMOTE_PATHS__
TM_DEPLOY_PATHS
while IFS= read -r file; do
  [ -n "$file" ] || continue
  mkdir -p "$ReleaseRoot/$(dirname "$file")"
done < "$ReleaseRoot/.deploy-v030-paths"
rm -f "$ReleaseRoot/.deploy-v030-paths"
'@
    $prepareScript = $prepareScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $prepareScript = $prepareScript.Replace('__RELEASE_ROOT__', $remoteReleaseRoot)
    $prepareScript = $prepareScript.Replace('__CANDIDATE_DIR__', $remoteCandidateDir)
    $prepareScript = $prepareScript.Replace('__REMOTE_PATHS__', $remotePathManifest)
    Invoke-RemoteBash -Script $prepareScript -FailureMessage "Remote candidate preparation failed" -RequireDeploymentLock

    foreach ($file in $FILES) {
        $localPath = Join-Path $LOCAL_DIR $file
        $remotePath = "$remoteCandidateDir/$(Convert-ToRemotePath $file)"
        Invoke-SecureCopy -LocalPath $localPath -RemotePath $remotePath -FailureMessage "Candidate upload failed: $file"
    }
    foreach ($file in $ROOT_RELATIVE_FILES) {
        $localPath = Join-Path $REPO_DIR $file
        $remotePath = "$remoteReleaseRoot/$(Convert-ToRemotePath $file)"
        Invoke-SecureCopy -LocalPath $localPath -RemotePath $remotePath -FailureMessage "Candidate evidence upload failed: $file"
    }

    $uploadChecksums = $uploadChecksumLines -join "`n"
    $verifyUploadScript = @'
set -euo pipefail
ReleaseRoot="__RELEASE_ROOT__"
cd "$ReleaseRoot"
cat > .deploy-v030-sha256 <<'TM_UPLOAD_SHA256'
__UPLOAD_CHECKSUMS__
TM_UPLOAD_SHA256
sha256sum --check --status .deploy-v030-sha256
rm -f .deploy-v030-sha256
'@
    $verifyUploadScript = $verifyUploadScript.Replace('__RELEASE_ROOT__', $remoteReleaseRoot)
    $verifyUploadScript = $verifyUploadScript.Replace('__UPLOAD_CHECKSUMS__', $uploadChecksums)
    Invoke-RemoteBash -Script $verifyUploadScript -FailureMessage "Candidate upload checksum verification failed" -RequireDeploymentLock

    $candidateGate = @'
set -euo pipefail
LiveDir="__REMOTE_DIR__"
RemoteRoot="__REMOTE_ROOT__"
ReleaseRoot="__RELEASE_ROOT__"
CandidateDir="__CANDIDATE_DIR__"
cd "$CandidateDir"
node --check app.js
node --check ppt.js
node --check client/shared/build_info.js
node --check client/core/navigation.js
node --check server/server.js
grep -Fq "__APP_QUERY__" index.html
grep -Fq "__APP_BUILD__" client/shared/build_info.js
grep -Fq "__PPT_QUERY__" index.html
grep -Fq "__PPT_BUILD__" ppt.js
echo "__PPT_SHA256__  ppt.js" | sha256sum --check --status

TestRoot="$ReleaseRoot/tmp/deploy-v030-gate-__STAMP__"
TestDb="$TestRoot/test.db"
mkdir -p "$TestRoot"
cleanup_test_gate() {
  rm -rf "$TestRoot" "$ReleaseRoot/.superpowers/sdd/deployment-smoke-artifacts"
}
trap cleanup_test_gate EXIT

npm ci --ignore-scripts
cd server
npm ci --ignore-scripts
npm rebuild better-sqlite3
NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH="$TestDb" node --test --test-concurrency=1 tests/*.test.js
cd ..
npx playwright install chromium
TM_DEPLOYMENT_SMOKE_PORT=43188 npx playwright test -c server/tests/deployment-browser-smoke.config.js

cat > "$ReleaseRoot/nginx-test.conf" <<'TM_NGINX_TEST'
pid __RELEASE_ROOT__/nginx-test.pid;
events {}
http {
  include /etc/nginx/mime.types;
  include __CANDIDATE_DIR__/nginx/turingmarket.conf;
}
TM_NGINX_TEST
if ! nginx -t -p / -c "$ReleaseRoot/nginx-test.conf"; then
  exit 1
fi
rm -f "$ReleaseRoot/nginx-test.conf" "$ReleaseRoot/nginx-test.pid"

test -d "$LiveDir"
test ! -L "$LiveDir"
test "$(stat -c '%d' "$LiveDir")" = "$(stat -c '%d' "$CandidateDir")"
python3 - "$RemoteRoot" <<'PY'
import ctypes
import os
import shutil
import sys
import tempfile
root = sys.argv[1]
probe = tempfile.mkdtemp(prefix='.rename-exchange-', dir=root)
left = os.path.join(probe, 'left')
right = os.path.join(probe, 'right')
try:
    os.mkdir(left)
    os.mkdir(right)
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        raise OSError(ctypes.get_errno(), 'renameat2 RENAME_EXCHANGE preflight failed')
finally:
    shutil.rmtree(probe)
PY
echo "CANDIDATE_OK"
'@
    $candidateGate = $candidateGate.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    $candidateGate = $candidateGate.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $candidateGate = $candidateGate.Replace('__RELEASE_ROOT__', $remoteReleaseRoot)
    $candidateGate = $candidateGate.Replace('__CANDIDATE_DIR__', $remoteCandidateDir)
    $candidateGate = $candidateGate.Replace('__APP_QUERY__', $EXPECTED_APP_QUERY)
    $candidateGate = $candidateGate.Replace('__APP_BUILD__', $EXPECTED_APP_BUILD)
    $candidateGate = $candidateGate.Replace('__PPT_QUERY__', $EXPECTED_PPT_QUERY)
    $candidateGate = $candidateGate.Replace('__PPT_BUILD__', $EXPECTED_PPT_BUILD)
    $candidateGate = $candidateGate.Replace('__PPT_SHA256__', $EXPECTED_PPT_SHA256)
    $candidateGate = $candidateGate.Replace('__STAMP__', $stamp)
    Invoke-RemoteBash -Script $candidateGate -FailureMessage "Remote candidate validation failed" -RequireDeploymentLock

    $deploymentWriterToken = [Guid]::NewGuid().ToString('N')
    $cutoverGate = @'
set -euo pipefail
LiveDir="__REMOTE_DIR__"
RemoteRoot="__REMOTE_ROOT__"
ReleaseRoot="__RELEASE_ROOT__"
CandidateDir="__CANDIDATE_DIR__"
BackupAbsolute="$RemoteRoot/__BACKUP_PATH__"
LockDir="$RemoteRoot/.deploy-v030.lock"
WriterDir="$RemoteRoot/.deploy-v030.writer"
RetiredWriterDir="$WriterDir.released.__WRITER_TOKEN__"

writer_acquired=0
release_writer() {
  if [ "$writer_acquired" = "1" ] &&
     [ -f "$WriterDir/owner" ] &&
     [ "$(cat "$WriterDir/owner")" = "__WRITER_TOKEN__" ]; then
    test ! -e "$RetiredWriterDir"
    mv "$WriterDir" "$RetiredWriterDir"
    writer_acquired=0
    rm -rf "$RetiredWriterDir"
  fi
}
trap release_writer EXIT

umask 077
if ! mkdir "$WriterDir" 2>/dev/null; then
  echo "Another production writer is active" >&2
  exit 1
fi
writer_acquired=1
printf '%s\n' "__WRITER_TOKEN__" > "$WriterDir/owner"
if ! test -f "$LockDir/owner" ||
   ! test "$(cat "$LockDir/owner")" = "__LOCK_TOKEN__"; then
  echo "The deployment lock generation changed before cutover" >&2
  exit 1
fi

record_phase() {
  printf '%s\n' "$1" > "$LockDir/phase.next"
  mv -f "$LockDir/phase.next" "$LockDir/phase"
}

record_phase mutation-intent

cd "$RemoteRoot"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  mkdir -p "$(dirname "$file")"
  cp -- "$ReleaseRoot/$file" "$file"
done < "$BackupAbsolute/root-files.requested"

record_phase mutation-started
pm2 stop turingmarket
sync_runtime_path() {
  relative="$1"
  source="$LiveDir/$relative"
  target="$CandidateDir/$relative"
  rm -rf -- "$target"
  if [ -e "$source" ] || [ -L "$source" ]; then
    mkdir -p "$(dirname "$target")"
    cp -a -- "$source" "$target"
  fi
}
sync_runtime_path .env
sync_runtime_path server/db
sync_runtime_path uploads
sync_runtime_path tmp

python3 - "$LiveDir" "$CandidateDir" <<'PY'
import ctypes
import os
import sys
live, candidate = sys.argv[1:3]
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
RENAME_EXCHANGE = 2
if renameat2(-100, os.fsencode(live), -100, os.fsencode(candidate), RENAME_EXCHANGE) != 0:
    raise OSError(ctypes.get_errno(), 'atomic release exchange failed')
PY

install -m 0644 "$LiveDir/nginx/turingmarket.conf" /etc/nginx/sites-available/turingmarket
rm -f /etc/nginx/sites-enabled/turingmarket
ln -s /etc/nginx/sites-available/turingmarket /etc/nginx/sites-enabled/turingmarket
nginx -t
systemctl reload nginx
cd "$LiveDir"
pm2 restart ecosystem.config.js --only turingmarket --update-env || pm2 start ecosystem.config.js --only turingmarket --update-env

for attempt in $(seq 1 30); do
  if curl -fsS http://localhost:3002/api/health >/dev/null; then
    break
  fi
  if [ "$attempt" = "30" ]; then
    echo "Health check failed after process restart" >&2
    exit 1
  fi
  sleep 1
done

expect_status() {
  expected="$1"
  request_path="$2"
  actual=$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost$request_path")
  if [ "$actual" != "$expected" ]; then
    echo "$request_path returned $actual; expected $expected" >&2
    exit 1
  fi
}
expect_status 200 /api/health
expect_status 200 /m0
expect_status 200 /m0-detail
expect_status 200 /m4
expect_status 200 /admin
expect_status 200 /client/shared/build_info.js
expect_status 200 /client/core/navigation.js
expect_status 404 /client/unknown.js
expect_status 404 /server/server.js

rm -rf "$ReleaseRoot"
if [ "__INVALIDATE_SESSIONS__" = "1" ]; then
  cd "$LiveDir/server"
  node <<'NODE'
const Database = require('better-sqlite3');
const database = new Database('db/turingmarket.db');
const removed = database.prepare('DELETE FROM sessions').run();
const remaining = database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
database.close();
if (remaining !== 0) throw new Error('Session invalidation verification failed');
console.log(`SESSIONS_INVALIDATED=${removed.changes}`);
console.log('SESSIONS_REMAINING=0');
NODE
fi

record_phase cutover-complete
release_writer
echo "DEPLOY_OK"
'@
    $cutoverGate = $cutoverGate.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    $cutoverGate = $cutoverGate.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $cutoverGate = $cutoverGate.Replace('__RELEASE_ROOT__', $remoteReleaseRoot)
    $cutoverGate = $cutoverGate.Replace('__CANDIDATE_DIR__', $remoteCandidateDir)
    $cutoverGate = $cutoverGate.Replace('__BACKUP_PATH__', $backupDir)
    $cutoverGate = $cutoverGate.Replace('__INVALIDATE_SESSIONS__', $invalidateSessionsFlag)
    $cutoverGate = $cutoverGate.Replace('__LOCK_TOKEN__', $deploymentLockToken)
    $cutoverGate = $cutoverGate.Replace('__WRITER_TOKEN__', $deploymentWriterToken)
    Invoke-RemoteBash -Script $cutoverGate -FailureMessage "Remote atomic release failed" -RequireDeploymentLock

    Exit-RemoteDeploymentLock
    $deploymentLockAcquired = $false
}
catch {
    $deployError = $_
    if (-not $deploymentLockAcquired) {
        throw $deployError
    }

    try {
        Invoke-DeploymentFailureRecovery -BackupPath $backupDir -ReleaseRoot $remoteReleaseRoot -BackupCreated $backupCreated
        $deploymentLockAcquired = $false
    }
    catch {
        Write-Warning "Deployment recovery failed while holding the remote deployment lock; retain the lock for operator recovery."
        throw "Deploy failed and automatic recovery also failed. Original: $($deployError.Exception.Message); recovery: $($_.Exception.Message)"
    }

    throw $deployError
}

Write-Host "Deploy complete" -ForegroundColor Cyan
