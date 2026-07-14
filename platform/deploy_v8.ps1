# TuringMarket v0.4.0 guarded production deploy and rollback.

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
$CANDIDATE_ROOT = "/var/lib/turingmarket-gate/releases"
$GATE_USER = "turingmarket-gate"
$LOCAL_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO_DIR = Split-Path -Parent $LOCAL_DIR
$EXPECTED_REPO_DIR_B64 = "QzpcVXNlcnNcMjkyNzJcRG9jdW1lbnRzXOWcqOe6v+WVhuWKoeW5s+WPsC1naXRodWItc3luYw=="
$EXPECTED_REPO_DIR = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EXPECTED_REPO_DIR_B64))
$EXPECTED_BRANCH = "codex/v0.4.0-product-shell-and-design-system"
$EXPECTED_APP_BUILD = "20260714-v040-product-shell-design-system"
$EXPECTED_APP_QUERY = "20260714v040productshelldesignsystem"
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
    "client\core\accessibility.js",
    "client\core\shell.js",
    "client\styles\tokens.css",
    "client\styles\components.css",
    "client\styles\layout.css",
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
    "server\scripts\bootstrap_production_runtime.sh",
    "server\scripts\capture_production_browser_baseline.js",
    "server\scripts\compare_ui_baseline_runs.js",
    "server\scripts\generate_ui_baseline_manifest.js",
    "server\scripts\generate_phase3_visual_evidence_manifest.js",
    "server\scripts\lib\production_browser_evidence.js",
    "server\scripts\rotate_user_credentials.js",
    "server\scripts\update_ui_baseline.js",
    "server\tests\ai_knowledge_foundation.test.js",
    "server\tests\accessibility_shell.test.js",
    "server\tests\brand_workspace_ui.test.js",
    "server\tests\browser_baseline_tools.test.js",
    "server\tests\credential_rotation.test.js",
    "server\tests\customer_workspace_ui.test.js",
    "server\tests\deployment_source_contract.test.js",
    "server\tests\deployment_runtime_hardening.test.js",
    "server\tests\file_ingest_service.test.js",
    "server\tests\frontend_architecture_inventory.test.js",
    "server\tests\frontend_event_binding_contract.test.js",
    "server\tests\frontend_navigation_contract.test.js",
    "server\tests\frontend_public_assets.test.js",
    "server\tests\influencer_workflow.test.js",
    "server\tests\obsidian_and_business_knowledge.test.js",
    "server\tests\ppt_bridge_browser_contract.test.js",
    "server\tests\production_browser_evidence_tools.test.js",
    "server\tests\product_shell_contract.test.js",
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
    "docs\superpowers\plans\2026-07-12-turingmarket-platform-roadmap.md"
)

$CANDIDATE_ONLY_FILES = @(
    ".gitattributes",
    "docs\baselines\v0.2.9\ui-ppt-manifest.json",
    "docs\product\turingmarket-design-system.md",
    "docs\product\2026-07-phase3-visual-change-record.md",
    "docs\product\2026-07-phase3-accessibility-residual-risks.md",
    "docs\product\evidence\2026-07-phase3-post\raw-contact-sheet-manifest.json",
    "docs\product\evidence\2026-07-phase3-post\fixture-1440-1.png",
    "docs\product\evidence\2026-07-phase3-post\fixture-1440-2.png",
    "docs\product\evidence\2026-07-phase3-post\fixture-1440-3.png",
    "docs\product\evidence\2026-07-phase3-post\fixture-1920-1.png",
    "docs\product\evidence\2026-07-phase3-post\fixture-1920-2.png",
    "docs\product\evidence\2026-07-phase3-post\fixture-1920-3.png",
    "docs\product\evidence\2026-07-phase3-post\fixture-mobile-1.png",
    "docs\product\evidence\2026-07-phase3-post\fixture-mobile-2.png",
    "docs\product\evidence\2026-07-phase3-post\fixture-mobile-3.png"
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
    $script:CANDIDATE_ONLY_FILES += $screenshots | Sort-Object
}

function Assert-RollbackBackupPath {
    param([Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][string]$BackupPath)
    if ($BackupPath -notmatch '^backups/v040-product-shell-design-system-\d{8}-\d{6}$') {
        throw "Rollback backup must match backups/v040-product-shell-design-system-YYYYMMDD-HHMMSS"
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
    $requiredPublicAssets = @(
        "client/shared/build_info.js",
        "client/core/navigation.js",
        "client/core/accessibility.js",
        "client/core/shell.js",
        "client/styles/tokens.css",
        "client/styles/components.css",
        "client/styles/layout.css"
    )
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
    foreach ($file in $CANDIDATE_ONLY_FILES) {
        $localPath = Join-Path $REPO_DIR $file
        if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) {
            throw "Local candidate-only evidence file is missing: $file"
        }
    }

    $trackedReleasePaths = New-Object 'Collections.Generic.List[string]'
    foreach ($file in $FILES) {
        $trackedReleasePaths.Add("platform/$(Convert-ToRemotePath $file)")
    }
    foreach ($file in $ROOT_RELATIVE_FILES) {
        $trackedReleasePaths.Add((Convert-ToRemotePath $file))
    }
    foreach ($file in $CANDIDATE_ONLY_FILES) {
        $trackedReleasePaths.Add((Convert-ToRemotePath $file))
    }
    foreach ($trackedPath in ($trackedReleasePaths | Sort-Object -Unique)) {
        $trackedResult = & git -C $REPO_DIR ls-files --error-unmatch -- $trackedPath 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Release inventory file is not tracked by Git: $trackedPath"
        }
    }

    $buildInfoPath = Join-Path $LOCAL_DIR "client\shared\build_info.js"
    $navigationPath = Join-Path $LOCAL_DIR "client\core\navigation.js"
    $accessibilityPath = Join-Path $LOCAL_DIR "client\core\accessibility.js"
    $shellPath = Join-Path $LOCAL_DIR "client\core\shell.js"
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
    node --check $accessibilityPath
    Assert-LastExitCode -Message "Local accessibility syntax check failed"
    node --check $shellPath
    Assert-LastExitCode -Message "Local shell syntax check failed"
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
foreach ($file in $CANDIDATE_ONLY_FILES) {
    $localPath = Join-Path $REPO_DIR $file
    $remoteRelative = Convert-ToRemotePath $file
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash.ToLowerInvariant()
    $uploadChecksumLines.Add("$hash  $remoteRelative")
    $remoteRelativePaths.Add($remoteRelative)
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = "backups/v040-product-shell-design-system-$stamp"
$releaseDir = "v040-product-shell-design-system-$stamp"
$remoteReleaseRoot = "$CANDIDATE_ROOT/$releaseDir"
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
CandidateRoot="__CANDIDATE_ROOT__"
GateUser="__GATE_USER__"
validate_gate_identity() {
  local GatePasswd GateGroup GateName GateUid GatePrimaryGid GateHome GateShell GateGroupName GateGroupGid GateExpectedHome
  GatePasswd="$(getent passwd "$GateUser")"
  GateGroup="$(getent group "$GateUser")"
  GateExpectedHome="$(dirname "$CandidateRoot")"
  IFS=: read -r GateName _ GateUid GatePrimaryGid _ GateHome GateShell <<< "$GatePasswd"
  IFS=: read -r GateGroupName _ GateGroupGid _ <<< "$GateGroup"
  test "$GateName" = "$GateUser"
  test "$GateUid" -gt 0
  test "$GateUid" -lt 1000
  test "$GateGroupName" = "$GateUser"
  test "$GatePrimaryGid" = "$GateGroupGid"
  test "$GateHome" = "$GateExpectedHome"
  test "$GateShell" = "/usr/sbin/nologin"
  test "$(id -nG "$GateUser")" = "$GateUser"
  test "$(passwd -S "$GateUser" | awk '{print $2}')" = "L"
}
validate_gate_identity
test -d "$CandidateRoot"
test ! -L "$CandidateRoot"
test "$(stat -c '%U:%G' "$CandidateRoot")" = "root:root"
test -L "$RemoteRoot/platform/.env"
test "$(readlink "$RemoteRoot/platform/.env")" = "/etc/turingmarket/turingmarket.env"
test -L "$RemoteRoot/platform/server/db"
test "$(readlink "$RemoteRoot/platform/server/db")" = "/var/lib/turingmarket/db"
test -L "$RemoteRoot/platform/uploads"
test "$(readlink "$RemoteRoot/platform/uploads")" = "/var/lib/turingmarket/uploads"
test -L "$RemoteRoot/platform/tmp"
test "$(readlink "$RemoteRoot/platform/tmp")" = "/var/lib/turingmarket/tmp"
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
    $prepareScript = $prepareScript.Replace('__CANDIDATE_ROOT__', $CANDIDATE_ROOT)
    $prepareScript = $prepareScript.Replace('__GATE_USER__', $GATE_USER)
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
    foreach ($file in $CANDIDATE_ONLY_FILES) {
        $localPath = Join-Path $REPO_DIR $file
        $remotePath = "$remoteReleaseRoot/$(Convert-ToRemotePath $file)"
        Invoke-SecureCopy -LocalPath $localPath -RemotePath $remotePath -FailureMessage "Candidate-only evidence upload failed: $file"
    }

    $uploadChecksums = $uploadChecksumLines -join "`n"
    $verifyUploadScript = @'
set -euo pipefail
ReleaseRoot="__RELEASE_ROOT__"
RemoteRoot="__REMOTE_ROOT__"
LockDir="$RemoteRoot/.deploy-v030.lock"
cd "$ReleaseRoot"
cat > "$LockDir/upload.sha256" <<'TM_UPLOAD_SHA256'
__UPLOAD_CHECKSUMS__
TM_UPLOAD_SHA256
chmod 0600 "$LockDir/upload.sha256"
chown root:root "$LockDir/upload.sha256"
sha256sum --check --status "$LockDir/upload.sha256"
'@
    $verifyUploadScript = $verifyUploadScript.Replace('__RELEASE_ROOT__', $remoteReleaseRoot)
    $verifyUploadScript = $verifyUploadScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $verifyUploadScript = $verifyUploadScript.Replace('__UPLOAD_CHECKSUMS__', $uploadChecksums)
    Invoke-RemoteBash -Script $verifyUploadScript -FailureMessage "Candidate upload checksum verification failed" -RequireDeploymentLock

    $candidateGate = @'
set -euo pipefail
LiveDir="__REMOTE_DIR__"
RemoteRoot="__REMOTE_ROOT__"
ReleaseRoot="__RELEASE_ROOT__"
CandidateDir="__CANDIDATE_DIR__"
CandidateRoot="__CANDIDATE_ROOT__"
GateUser="__GATE_USER__"
LockDir="$RemoteRoot/.deploy-v030.lock"
BackupAbsolute="$RemoteRoot/__BACKUP_PATH__"
ProductionBackupDb="$BackupAbsolute/database/turingmarket.db"
ProductionLiveDb="/var/lib/turingmarket/db/turingmarket.db"
TestRoot="$ReleaseRoot/tmp/deploy-v040-gate-__STAMP__"
TestDb="$TestRoot/test.db"
SchemaDb="$TestRoot/schema.db"
BrowserCache="$TestRoot/browser-cache"

validate_gate_identity() {
  local GatePasswd GateGroup GateName GateUid GatePrimaryGid GateHome GateShell GateGroupName GateGroupGid GateExpectedHome
  GatePasswd="$(getent passwd "$GateUser")"
  GateGroup="$(getent group "$GateUser")"
  GateExpectedHome="$(dirname "$CandidateRoot")"
  IFS=: read -r GateName _ GateUid GatePrimaryGid _ GateHome GateShell <<< "$GatePasswd"
  IFS=: read -r GateGroupName _ GateGroupGid _ <<< "$GateGroup"
  test "$GateName" = "$GateUser"
  test "$GateUid" -gt 0
  test "$GateUid" -lt 1000
  test "$GateGroupName" = "$GateUser"
  test "$GatePrimaryGid" = "$GateGroupGid"
  test "$GateHome" = "$GateExpectedHome"
  test "$GateShell" = "/usr/sbin/nologin"
  test "$(id -nG "$GateUser")" = "$GateUser"
  test "$(passwd -S "$GateUser" | awk '{print $2}')" = "L"
}

assert_canonical_candidate() {
  local CandidateRootReal ExpectedRelease ExpectedCandidate
  test -d "$CandidateRoot"
  test ! -L "$CandidateRoot"
  test -d "$ReleaseRoot"
  test ! -L "$ReleaseRoot"
  test -d "$CandidateDir"
  test ! -L "$CandidateDir"
  CandidateRootReal="$(realpath -e "$CandidateRoot")"
  ExpectedRelease="$CandidateRootReal/$(basename "$ReleaseRoot")"
  ExpectedCandidate="$ExpectedRelease/$(basename "$CandidateDir")"
  test "$(realpath -e "$ReleaseRoot")" = "$ExpectedRelease"
  test "$(realpath -e "$CandidateDir")" = "$ExpectedCandidate"
}

kill_gate_processes() {
  local Stage="$1"
  pkill -KILL -u "$GateUser" 2>/dev/null || true
  for _attempt in $(seq 1 20); do
    if ! pgrep -u "$GateUser" >/dev/null; then
      printf 'GATE_USER_PROCESSES_CLEARED=%s\n' "$Stage"
      return 0
    fi
    sleep 0.2
  done
  echo "Gate user processes survived $Stage" >&2
  return 1
}

command -v realpath >/dev/null
command -v pkill >/dev/null
command -v pgrep >/dev/null
kill_gate_processes "candidate preflight"
assert_canonical_candidate
test -f "$CandidateDir/server/scripts/bootstrap_production_runtime.sh"
bash -n "$CandidateDir/server/scripts/bootstrap_production_runtime.sh"
test -f "$ProductionBackupDb"
test -f "$ProductionLiveDb"
test -f "$LockDir/upload.sha256"
chown root:root "$ProductionBackupDb"
chmod 0600 "$ProductionBackupDb"
runuser -u "$GateUser" -- test ! -r "$ProductionBackupDb"
runuser -u "$GateUser" -- test ! -r "$ProductionLiveDb"

rm -rf "$TestRoot"
mkdir -p "$TestRoot/home" "$TestRoot/uploads" "$TestRoot/tmp" "$TestRoot/nginx-prefix"
ROOT_SCHEMA_FINGERPRINT="$(
  cd "$LiveDir/server"
  TM_PRODUCTION_SCHEMA_DB="$ProductionBackupDb" \
  TM_SANITIZED_SCHEMA_DB="$SchemaDb" \
  node <<'TM_BUILD_SANITIZED_SCHEMA_DB'
const crypto = require('node:crypto');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const sourcePath = process.env.TM_PRODUCTION_SCHEMA_DB;
const targetPath = process.env.TM_SANITIZED_SCHEMA_DB;
const sentinels = Object.freeze({
  admin: '__tm_gate_admin__',
  session: '__tm_gate_session__',
  customer: '__tm_gate_customer__',
  influencer: '__tm_gate_influencer__',
  knowledge: '__tm_gate_knowledge__',
  conversation: '__tm_gate_conversation__',
  message: '__tm_gate_message__'
});
const ids = Object.freeze({
  user: 900000001,
  session: 900000002,
  customer: 900000003,
  influencer: 900000004,
  knowledge: 900000005,
  conversation: 900000006,
  message: 900000007
});

function fingerprint(database) {
  const schema = database.prepare(`
    SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name
  `).all();
  const userVersion = database.pragma('user_version', { simple: true });
  return crypto.createHash('sha256').update(JSON.stringify({ userVersion, schema })).digest('hex');
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
let target;
try {
  const sourceFingerprint = fingerprint(source);
  const sourceUserVersion = source.pragma('user_version', { simple: true });
  const sourceRows = source.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
  `).all();
  const virtualTables = sourceRows.filter((row) => row.type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql));
  const shadowTables = new Set();
  for (const virtualTable of virtualTables) {
    for (const row of sourceRows) {
      if (row.type === 'table' && row.name.startsWith(`${virtualTable.name}_`)) shadowTables.add(row.name);
    }
  }
  const requiredTables = ['users', 'sessions', 'customers', 'influencers', 'knowledge_entries', 'ai_conversations', 'ai_messages'];
  for (const table of requiredTables) {
    if (!sourceRows.some((row) => row.type === 'table' && row.name === table)) {
      throw new Error(`Production schema is missing required table: ${table}`);
    }
  }

  fs.rmSync(targetPath, { force: true });
  target = new Database(targetPath);
  target.pragma('journal_mode = DELETE');
  target.pragma('foreign_keys = OFF');
  const typeOrder = { table: 0, view: 1, index: 2, trigger: 3 };
  const executableRows = sourceRows
    .filter((row) => Object.prototype.hasOwnProperty.call(typeOrder, row.type))
    .filter((row) => !shadowTables.has(row.name))
    .sort((left, right) => {
      const typeDifference = typeOrder[left.type] - typeOrder[right.type];
      if (typeDifference) return typeDifference;
      const leftVirtual = /^CREATE\s+VIRTUAL\s+TABLE/i.test(left.sql) ? 1 : 0;
      const rightVirtual = /^CREATE\s+VIRTUAL\s+TABLE/i.test(right.sql) ? 1 : 0;
      if (leftVirtual !== rightVirtual) return leftVirtual - rightVirtual;
      return left.name.localeCompare(right.name);
    });
  for (const row of executableRows) target.exec(row.sql);
  target.pragma(`user_version = ${Number(sourceUserVersion) || 0}`);

  const rebuiltFingerprint = fingerprint(target);
  if (rebuiltFingerprint !== sourceFingerprint) {
    throw new Error(`Sanitized schema fingerprint mismatch: ${rebuiltFingerprint} != ${sourceFingerprint}`);
  }

  target.transaction(() => {
    target.prepare(`
      INSERT INTO users (id, username, password_hash, display_name, role, email, department, api_quota, is_active)
      VALUES (?, ?, ?, ?, 'admin', 'gate-admin@example.invalid', 'deployment-gate', 1, 1)
    `).run(ids.user, sentinels.admin, 'synthetic-not-a-real-password-hash', 'Synthetic deployment gate admin');
    target.prepare(`
      INSERT INTO sessions (id, user_id, token, ip_address, expires_at)
      VALUES (?, ?, ?, NULL, '2099-01-01T00:00:00.000Z')
    `).run(ids.session, ids.user, sentinels.session);
    target.prepare(`
      INSERT INTO customers (id, brand_name, company_name, source, notes, created_by, assigned_to)
      VALUES (?, ?, 'Synthetic Gate Company', 'deployment_sentinel', 'Synthetic data only', ?, ?)
    `).run(ids.customer, sentinels.customer, ids.user, ids.user);
    target.prepare(`
      INSERT INTO influencers (id, platform, kol_handle, profile_link, data_source)
      VALUES (?, 'SyntheticGate', ?, 'https://example.invalid/deployment-gate', 'deployment_sentinel')
    `).run(ids.influencer, sentinels.influencer);
    target.prepare(`
      INSERT INTO knowledge_entries (id, entry_type, source_type, source_id, key_terms, content, created_by, is_public)
      VALUES (?, 'deployment_sentinel', 'deployment_sentinel', ?, ?, 'Synthetic knowledge only', ?, 0)
    `).run(ids.knowledge, ids.customer, sentinels.knowledge, ids.user);
    target.prepare(`
      INSERT INTO ai_conversations (id, user_id, title, visibility, source_module)
      VALUES (?, ?, ?, 'private', 'deployment_sentinel')
    `).run(ids.conversation, ids.user, sentinels.conversation);
    target.prepare(`
      INSERT INTO ai_messages (id, conversation_id, user_id, role, content, model, total_tokens)
      VALUES (?, ?, ?, 'user', ?, 'deployment_sentinel', 1)
    `).run(ids.message, ids.conversation, ids.user, sentinels.message);
  })();

  const expectedCounts = new Map([
    ['users', 1],
    ['sessions', 1],
    ['customers', 1],
    ['influencers', 1],
    ['knowledge_entries', 1],
    ['ai_conversations', 1],
    ['ai_messages', 1]
  ]);
  for (const row of sourceRows.filter((entry) => entry.type === 'table' && !shadowTables.has(entry.name))) {
    const count = target.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(row.name)}`).get().count;
    const expected = expectedCounts.get(row.name) || 0;
    if (count !== expected) throw new Error(`Sanitized table ${row.name} has ${count} rows; expected ${expected}`);
  }
  const exactChecks = [
    ['users', 'username', sentinels.admin],
    ['sessions', 'token', sentinels.session],
    ['customers', 'brand_name', sentinels.customer],
    ['influencers', 'kol_handle', sentinels.influencer],
    ['knowledge_entries', 'key_terms', sentinels.knowledge],
    ['ai_conversations', 'title', sentinels.conversation],
    ['ai_messages', 'content', sentinels.message]
  ];
  for (const [table, column, value] of exactChecks) {
    const row = target.prepare(`SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)}`).get();
    if (!row || row.value !== value) throw new Error(`Synthetic sentinel mismatch in ${table}.${column}`);
  }
  const quickCheck = target.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`Sanitized schema quick_check failed: ${quickCheck}`);
  if (fingerprint(target) !== sourceFingerprint) throw new Error('Synthetic rows changed the rebuilt schema fingerprint');
  process.stdout.write(sourceFingerprint);
} finally {
  if (target) target.close();
  source.close();
}
TM_BUILD_SANITIZED_SCHEMA_DB
)"
test "${#ROOT_SCHEMA_FINGERPRINT}" = "64"
printf 'ROOT_SCHEMA_FINGERPRINT=%s\n' "$ROOT_SCHEMA_FINGERPRINT"
printf '%s\n' "SANITIZED_SCHEMA_REBUILD_OK"
test -s "$SchemaDb"
chown root:root "$SchemaDb"
chmod 0600 "$SchemaDb"
runuser -u "$GateUser" -- test ! -r "$SchemaDb"
chown -R "$GateUser:$GateUser" "$ReleaseRoot"
validate_gate_identity
assert_canonical_candidate
runuser -u "$GateUser" -- test ! -r "$ProductionBackupDb"
runuser -u "$GateUser" -- test ! -r "$ProductionLiveDb"
command -v unshare >/dev/null
command -v ip >/dev/null

set +e
timeout --signal=KILL 20m runuser -u "$GateUser" -- env -i \
  HOME="$TestRoot/home" \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  PLAYWRIGHT_BROWSERS_PATH="$BrowserCache" \
  npm_config_cache="$TestRoot/npm-cache" \
  CANDIDATE_DIR="$CandidateDir" \
  bash --noprofile --norc -s <<'TM_DEPENDENCY_STAGE'
set -euo pipefail
cd "$CANDIDATE_DIR"
npm ci --ignore-scripts
node node_modules/playwright-deploy/cli.js install-deps --dry-run chromium
node node_modules/playwright-deploy/cli.js install chromium
cd server
npm ci --ignore-scripts
npm rebuild better-sqlite3
printf '%s\n' "DEPENDENCY_STAGE_OK"
TM_DEPENDENCY_STAGE
DependencyStatus=$?
set -e
kill_gate_processes "dependency staging"
assert_canonical_candidate
if [ "$DependencyStatus" != "0" ]; then
  exit "$DependencyStatus"
fi
validate_gate_identity
runuser -u "$GateUser" -- test ! -r "$ProductionBackupDb"
runuser -u "$GateUser" -- test ! -r "$ProductionLiveDb"

NginxGateDir=""
cleanup_nginx_gate_dir() {
  if [ -n "$NginxGateDir" ]; then
    rm -rf -- "$NginxGateDir"
  fi
}
trap cleanup_nginx_gate_dir EXIT
NginxGateDir="$(mktemp -d /tmp/tm-nginx-gate.XXXXXX)"
case "$NginxGateDir" in
  /tmp/tm-nginx-gate.*) ;;
  *) echo "Unexpected Nginx gate path" >&2; exit 1 ;;
esac
chown "$GateUser:$GateUser" "$NginxGateDir"

set +e
timeout --signal=KILL 30m env \
  TM_GATE_USER="$GateUser" \
  TM_GATE_HOME="$TestRoot/home" \
  TM_GATE_DB_PATH="$TestDb" \
  TM_GATE_SCHEMA_DB="$SchemaDb" \
  TM_GATE_UPLOAD_DIR="$TestRoot/uploads" \
  TM_GATE_TMP_DIR="$TestRoot/tmp" \
  TM_GATE_BROWSER_CACHE="$BrowserCache" \
  TM_GATE_CANDIDATE_DIR="$CandidateDir" \
  TM_GATE_RELEASE_ROOT="$ReleaseRoot" \
  TM_GATE_TEST_ROOT="$TestRoot" \
  TM_GATE_NGINX_DIR="$NginxGateDir" \
  TM_GATE_EXPECTED_SCHEMA_FINGERPRINT="$ROOT_SCHEMA_FINGERPRINT" \
  TM_GATE_APP_QUERY="__APP_QUERY__" \
  TM_GATE_APP_BUILD="__APP_BUILD__" \
  TM_GATE_PPT_QUERY="__PPT_QUERY__" \
  TM_GATE_PPT_BUILD="__PPT_BUILD__" \
  TM_GATE_PPT_SHA256="__PPT_SHA256__" \
  unshare --net --fork bash --noprofile --norc -c '
set -euo pipefail
ip link set lo up
test -z "$(ip route show default)"
test "$(ip -o link show | wc -l)" = "1"
printf "%s\n" "OFFLINE_NETWORK_NAMESPACE_OK"
exec runuser -u "$TM_GATE_USER" -- env -i \
  HOME="$TM_GATE_HOME" \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  NODE_ENV="test" \
  TM_DISABLE_DOTENV="1" \
  TM_ENV_FILE="$TM_GATE_TEST_ROOT/no-production.env" \
  DB_PATH="$TM_GATE_DB_PATH" \
  UPLOAD_DIR="$TM_GATE_UPLOAD_DIR" \
  TMP_DIR="$TM_GATE_TMP_DIR" \
  PLAYWRIGHT_BROWSERS_PATH="$TM_GATE_BROWSER_CACHE" \
  CANDIDATE_DIR="$TM_GATE_CANDIDATE_DIR" \
  RELEASE_ROOT="$TM_GATE_RELEASE_ROOT" \
  TEST_ROOT="$TM_GATE_TEST_ROOT" \
  SCHEMA_DB="$TM_GATE_SCHEMA_DB" \
  NGINX_GATE_DIR="$TM_GATE_NGINX_DIR" \
  EXPECTED_SCHEMA_FINGERPRINT="$TM_GATE_EXPECTED_SCHEMA_FINGERPRINT" \
  APP_QUERY="$TM_GATE_APP_QUERY" \
  APP_BUILD="$TM_GATE_APP_BUILD" \
  PPT_QUERY="$TM_GATE_PPT_QUERY" \
  PPT_BUILD="$TM_GATE_PPT_BUILD" \
  PPT_SHA256="$TM_GATE_PPT_SHA256" \
  bash --noprofile --norc -s
' <<'TM_UNPRIVILEGED_GATE'
set -euo pipefail
cd "$CANDIDATE_DIR"
node --check app.js
node --check ppt.js
node --check client/shared/build_info.js
node --check client/core/navigation.js
node --check client/core/accessibility.js
node --check client/core/shell.js
node --check server/server.js
grep -Fq "$APP_QUERY" index.html
grep -Fq "$APP_BUILD" client/shared/build_info.js
grep -Fq "$PPT_QUERY" index.html
grep -Fq "$PPT_BUILD" ppt.js
echo "$PPT_SHA256  ppt.js" | sha256sum --check --status

cd server

fingerprint_db() {
  DB_FINGERPRINT_PATH="$1" node <<'NODE'
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const database = new Database(process.env.DB_FINGERPRINT_PATH, { readonly: true, fileMustExist: true });
const schema = database.prepare(`
  SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
  FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%'
  ORDER BY type, name, tbl_name
`).all();
const userVersion = database.pragma('user_version', { simple: true });
database.close();
process.stdout.write(crypto.createHash('sha256').update(JSON.stringify({ userVersion, schema })).digest('hex'));
NODE
}

NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH="$SCHEMA_DB" node <<'NODE'
const database = require('./db');
const expected = [
  ['users', 'username', '__tm_gate_admin__'],
  ['sessions', 'token', '__tm_gate_session__'],
  ['customers', 'brand_name', '__tm_gate_customer__'],
  ['influencers', 'kol_handle', '__tm_gate_influencer__'],
  ['knowledge_entries', 'key_terms', '__tm_gate_knowledge__'],
  ['ai_conversations', 'title', '__tm_gate_conversation__'],
  ['ai_messages', 'content', '__tm_gate_message__']
];
function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
try {
  for (const [table, column, value] of expected) {
    const count = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
    if (count !== 1) throw new Error(`Candidate migration changed synthetic row count in ${table}: ${count}`);
    const row = database.prepare(`SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)}`).get();
    if (!row || row.value !== value) throw new Error(`Candidate migration changed synthetic sentinel in ${table}.${column}`);
  }
  const result = database.pragma('quick_check', { simple: true });
  if (result !== 'ok') throw new Error(`Candidate DB quick_check failed: ${result}`);
  console.log('TM_SYNTHETIC_SENTINELS_OK');
} finally {
  database.close();
}
NODE
CANDIDATE_SCHEMA_FINGERPRINT="$(fingerprint_db "$SCHEMA_DB")"
printf 'CANDIDATE_SCHEMA_FINGERPRINT=%s\n' "$CANDIDATE_SCHEMA_FINGERPRINT"
[ "$CANDIDATE_SCHEMA_FINGERPRINT" = "$EXPECTED_SCHEMA_FINGERPRINT" ]
printf '%s\n' "TM_SCHEMA_COMPATIBILITY_OK"

NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH="$DB_PATH" UPLOAD_DIR="$TEST_ROOT/uploads" TMP_DIR="$TEST_ROOT/tmp" \
  node --test --test-concurrency=1 tests/*.test.js
cd ..
TM_DEPLOYMENT_SMOKE_PORT=43188 node node_modules/playwright-deploy/cli.js test -c server/tests/deployment-browser-smoke.config.js

NGINX_TEST_SOCKET="$NGINX_GATE_DIR/listen.sock"
python3 - "$CANDIDATE_DIR/nginx/turingmarket.conf" "$TEST_ROOT/turingmarket-gate.conf" "$NGINX_TEST_SOCKET" <<'PY'
import re
import sys
from pathlib import Path

source_path, target_path, socket_path = sys.argv[1:]
source = Path(source_path).read_text(encoding='utf-8')
pattern = re.compile(r'(?m)^(\s*listen\s+)80(\s*;\s*(?:#.*)?)$')
rendered, replacement_count = pattern.subn(
    lambda match: f'{match.group(1)}unix:{socket_path}{match.group(2)}',
    source,
)
if replacement_count != 1:
    raise SystemExit(f'expected one privileged Nginx listener, found {replacement_count}')
Path(target_path).write_text(rendered, encoding='utf-8')
PY

mkdir -p "$TEST_ROOT/nginx-client" "$TEST_ROOT/nginx-proxy" "$TEST_ROOT/nginx-fastcgi" "$TEST_ROOT/nginx-uwsgi" "$TEST_ROOT/nginx-scgi"
cat > "$TEST_ROOT/nginx-test.conf" <<TM_NGINX_TEST
error_log $TEST_ROOT/nginx-error.log notice;
pid $TEST_ROOT/nginx.pid;
events {}
http {
  access_log off;
  client_body_temp_path $TEST_ROOT/nginx-client;
  proxy_temp_path $TEST_ROOT/nginx-proxy;
  fastcgi_temp_path $TEST_ROOT/nginx-fastcgi;
  uwsgi_temp_path $TEST_ROOT/nginx-uwsgi;
  scgi_temp_path $TEST_ROOT/nginx-scgi;
  include /etc/nginx/mime.types;
  include $TEST_ROOT/turingmarket-gate.conf;
}
TM_NGINX_TEST
nginx -t -p "$TEST_ROOT/nginx-prefix/" -c "$TEST_ROOT/nginx-test.conf"
printf '%s\n' "UNPRIVILEGED_GATE_OK"
TM_UNPRIVILEGED_GATE
GateStatus=$?
set -e

kill_gate_processes "offline candidate validation"
assert_canonical_candidate
cleanup_nginx_gate_dir
trap - EXIT
[ "$GateStatus" = "0" ] || exit "$GateStatus"

cd "$ReleaseRoot"
sha256sum --check --status "$LockDir/upload.sha256"
rm -rf "$TestRoot" "$ReleaseRoot/.superpowers"

rm -rf "$CandidateDir/.env" "$CandidateDir/server/db" "$CandidateDir/uploads" "$CandidateDir/tmp"
ln -s /etc/turingmarket/turingmarket.env "$CandidateDir/.env"
ln -s /var/lib/turingmarket/db "$CandidateDir/server/db"
ln -s /var/lib/turingmarket/uploads "$CandidateDir/uploads"
ln -s /var/lib/turingmarket/tmp "$CandidateDir/tmp"

setfacl -Rb "$ReleaseRoot"
chown -hR root:root "$CandidateDir"
chown -hR root:root "$ReleaseRoot"
chmod -R go-w "$ReleaseRoot"
assert_canonical_candidate
if find "$CandidateDir" -xdev \( -type b -o -type c -o -type p -o -type s \) -print -quit | grep -q .; then
  echo "Candidate contains a special file" >&2
  exit 1
fi
if find "$CandidateDir" -xdev -type f -perm /6000 -print -quit | grep -q .; then
  echo "Candidate contains a setuid or setgid file" >&2
  exit 1
fi
if [ -n "$(getcap -r "$CandidateDir" 2>/dev/null)" ]; then
  echo "Candidate contains a file capability" >&2
  exit 1
fi

python3 - "$CandidateDir" <<'PY'
import os
import sys

root = os.path.abspath(sys.argv[1])
allowed = {
    '.env': '/etc/turingmarket/turingmarket.env',
    'server/db': '/var/lib/turingmarket/db',
    'uploads': '/var/lib/turingmarket/uploads',
    'tmp': '/var/lib/turingmarket/tmp',
}
seen = set()
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    for name in dirnames + filenames:
        path = os.path.join(dirpath, name)
        if not os.path.islink(path):
            continue
        relative = os.path.relpath(path, root).replace(os.sep, '/')
        target = os.readlink(path)
        if relative in allowed:
            if target != allowed[relative]:
                raise SystemExit(f'Unexpected runtime link: {relative}')
            seen.add(relative)
            continue
        resolved = os.path.realpath(path)
        if os.path.commonpath([root, resolved]) != root:
            raise SystemExit(f'Candidate symlink escapes release: {relative}')
if seen != set(allowed):
    raise SystemExit(f'Missing runtime links: {sorted(set(allowed) - seen)}')
PY

test -d "$LiveDir"
test ! -L "$LiveDir"
CandidateDevice="$(stat -c %d "$CandidateDir")"
LiveDevice="$(stat -c %d "$LiveDir")"
test "$CandidateDevice" = "$LiveDevice"
python3 - "$CandidateRoot" <<'PY'
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

cat > "$LockDir/candidate_digest.py" <<'PY'
import hashlib
import os
import stat
import sys

root = os.path.abspath(sys.argv[1])
digest = hashlib.sha256()

def emit(value):
    data = value if isinstance(value, bytes) else value.encode('utf-8', 'surrogateescape')
    digest.update(len(data).to_bytes(8, 'big'))
    digest.update(data)

def visit(path, relative):
    metadata = os.lstat(path)
    emit(relative)
    emit(f'{stat.S_IFMT(metadata.st_mode)}:{stat.S_IMODE(metadata.st_mode)}:{metadata.st_uid}:{metadata.st_gid}')
    if stat.S_ISLNK(metadata.st_mode):
        emit(os.fsencode(os.readlink(path)))
    elif stat.S_ISREG(metadata.st_mode):
        file_hash = hashlib.sha256()
        with open(path, 'rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                file_hash.update(chunk)
        emit(file_hash.hexdigest())
    elif stat.S_ISDIR(metadata.st_mode):
        for name in sorted(os.listdir(path), key=os.fsencode):
            visit(os.path.join(path, name), f'{relative}/{name}' if relative else name)
    else:
        raise SystemExit(f'Unsupported candidate entry: {relative}')

visit(root, '')
print(digest.hexdigest())
PY
chmod 0600 "$LockDir/candidate_digest.py"
assert_canonical_candidate
CANDIDATE_TREE_SHA256="$(python3 "$LockDir/candidate_digest.py" "$CandidateDir")"
printf '%s\n' "$CANDIDATE_TREE_SHA256" > "$LockDir/candidate-tree.sha256"
chmod 0600 "$LockDir/candidate-tree.sha256"
printf 'CANDIDATE_TREE_SHA256=%s\n' "$CANDIDATE_TREE_SHA256"
echo "CANDIDATE_OK"
'@
    $candidateGate = $candidateGate.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    $candidateGate = $candidateGate.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $candidateGate = $candidateGate.Replace('__RELEASE_ROOT__', $remoteReleaseRoot)
    $candidateGate = $candidateGate.Replace('__CANDIDATE_DIR__', $remoteCandidateDir)
    $candidateGate = $candidateGate.Replace('__CANDIDATE_ROOT__', $CANDIDATE_ROOT)
    $candidateGate = $candidateGate.Replace('__GATE_USER__', $GATE_USER)
    $candidateGate = $candidateGate.Replace('__BACKUP_PATH__', $backupDir)
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

assert_canonical_candidate() {
  local CandidateParentReal ExpectedRelease ExpectedCandidate
  test -d "$ReleaseRoot"
  test ! -L "$ReleaseRoot"
  test -d "$CandidateDir"
  test ! -L "$CandidateDir"
  CandidateParentReal="$(realpath -e "$(dirname "$ReleaseRoot")")"
  ExpectedRelease="$CandidateParentReal/$(basename "$ReleaseRoot")"
  ExpectedCandidate="$ExpectedRelease/$(basename "$CandidateDir")"
  test "$(realpath -e "$ReleaseRoot")" = "$ExpectedRelease"
  test "$(realpath -e "$CandidateDir")" = "$ExpectedCandidate"
  test "$(stat -c '%U:%G' "$ReleaseRoot")" = "root:root"
  test "$(stat -c '%U:%G' "$CandidateDir")" = "root:root"
}

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

assert_canonical_candidate
ExpectedCandidateDigest="$(cat "$LockDir/candidate-tree.sha256")"
CurrentCandidateDigest="$(python3 "$LockDir/candidate_digest.py" "$CandidateDir")"
if [ "$CurrentCandidateDigest" != "$ExpectedCandidateDigest" ]; then
  echo "Candidate tree changed after validation" >&2
  exit 1
fi
echo "CANDIDATE_TREE_RECHECK_OK"
assert_canonical_candidate

assert_runtime_link() {
  link="$1"
  target="$2"
  test -L "$link"
  test "$(readlink "$link")" = "$target"
}
assert_runtime_link "$LiveDir/.env" /etc/turingmarket/turingmarket.env
assert_runtime_link "$LiveDir/server/db" /var/lib/turingmarket/db
assert_runtime_link "$LiveDir/uploads" /var/lib/turingmarket/uploads
assert_runtime_link "$LiveDir/tmp" /var/lib/turingmarket/tmp
assert_runtime_link "$CandidateDir/.env" /etc/turingmarket/turingmarket.env
assert_runtime_link "$CandidateDir/server/db" /var/lib/turingmarket/db
assert_runtime_link "$CandidateDir/uploads" /var/lib/turingmarket/uploads
assert_runtime_link "$CandidateDir/tmp" /var/lib/turingmarket/tmp
assert_canonical_candidate

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
assert_runtime_link "$LiveDir/.env" /etc/turingmarket/turingmarket.env
assert_runtime_link "$LiveDir/server/db" /var/lib/turingmarket/db
assert_runtime_link "$LiveDir/uploads" /var/lib/turingmarket/uploads
assert_runtime_link "$LiveDir/tmp" /var/lib/turingmarket/tmp
assert_canonical_candidate

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
expect_status 200 /client/core/accessibility.js
expect_status 200 /client/core/shell.js
expect_status 200 /client/styles/tokens.css
expect_status 200 /client/styles/components.css
expect_status 200 /client/styles/layout.css
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
