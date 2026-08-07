# TuringMarket v0.5.0 guarded production deploy and rollback.

param(
    [switch]$PreserveSessions,
    [string]$RollbackBackup,
    [switch]$RestoreDatabase,
    [switch]$ConfirmDataLoss,
    [ValidateRange(15, 300)][int]$MaintenanceTimeoutSeconds = 60,
    [switch]$ValidateLocalOnly,
    [switch]$RecoverInterruptedDeployment
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
$EXPECTED_BRANCH = "codex/v0.5.0-campaign-business-spine"
$EXPECTED_APP_BUILD = "20260714-v040-product-shell-design-system"
$EXPECTED_APP_QUERY = "20260714v040productshelldesignsystem"
$EXPECTED_PPT_BUILD = "20260702-v916-kb-bridge-client-cn"
$EXPECTED_PPT_QUERY = "20260702v916kbbridge"
$EXPECTED_PPT_SHA256 = "f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e"
$TRUSTED_SOURCE_GATE_RELATIVE_PATH = "server\scripts\trusted_production_source_gate.js"
$TRUSTED_SOURCE_MANIFEST_RELATIVE_PATH = "server\scripts\trusted_production_source_manifest.json"
$EXPECTED_TRUSTED_SOURCE_GATE_SHA256 = "4428922015dc20add3bf733ffecd40cc97904042e8229cc7b54defb6272a1749"
$EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256 = "761b594fc924450b209a40e782b2c9969a348d23229da2366416ef3ed8e25770"
$EXPECTED_TRUSTED_MIGRATION_VERIFIER_SHA256 = "23df91c4b07879f02b1848f745f9a852b1d2326766f13edfdb7e3e0b61df6227"
$TRUSTED_SOURCE_INSTALL_ROOT = "/usr/local/libexec/turingmarket/production-source-trust/$EXPECTED_TRUSTED_SOURCE_GATE_SHA256/$EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256"
$TRUSTED_SOURCE_GATE_REMOTE_PATH = "$TRUSTED_SOURCE_INSTALL_ROOT/trusted_production_source_gate.js"
$TRUSTED_SOURCE_MANIFEST_REMOTE_PATH = "$TRUSTED_SOURCE_INSTALL_ROOT/trusted_production_source_manifest.json"
$TRUSTED_SOURCE_BUNDLE_REMOTE_PATH = "$TRUSTED_SOURCE_INSTALL_ROOT/bundles/$EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256"
$TRUSTED_SOURCE_RUNTIME_REMOTE_PATH = "$TRUSTED_SOURCE_INSTALL_ROOT/runtime/$EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256"
$CANDIDATE_GATE_TIMEOUT_SECONDS = 7200
New-Variable -Scope Script -Name EXPECTED_REQUIRED_PUBLIC_ASSETS_IDENTITY -Option Constant -Value "9:ab5966490f4c000ddca07dfcb9e1c8304e5b474248a295f7d2d81439dcc8bda2"
$deploymentLockToken = $null
$deploymentWriterToken = $null
$deploymentRunId = $null
$deploymentBackupPath = $null
$deploymentReleaseRoot = $null
$deploymentCandidatePath = $null
$deploymentSourceIdentity = $null
$deploymentSourceSha256 = $null
$deploymentActionPlan = $null
$deploymentOperation = "deploy"

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
    "client\core\csp_compat.js",
    "client\features\ppt_preview_runtime.js",
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
    "server\contracts\campaign_contract.js",
    "server\db.js",
    "server\middleware\phase4_request_pipeline.js",
    "server\migrations\001_legacy_compat_columns.js",
    "server\migrations\002_campaign_business_spine.js",
    "server\migrations\003_campaign_workflow_dispatch_evidence.js",
    "server\migrations\004_knowledge_capacity_observability.js",
    "server\migrations\005_knowledge_custody_projection.js",
    "server\migrations\baselines\legacy_v1.js",
    "server\migrations\engines\v1.js",
    "server\migrations\vendor\bcryptjs_v3_0_3.js",
    "server\migrations\vendor\bcryptjs_v3_0_3.LICENSE",
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
    "server\routes_campaigns.js",
    "server\routes_customers.js",
    "server\routes_feishu.js",
    "server\routes_feishu_v2.js",
    "server\routes_workflow.js",
    "server\server.js",
    "server\workflow_engine.js",
    "server\services\ai_service.js",
    "server\services\business_knowledge_service.js",
    "server\services\campaign_access_service.js",
    "server\services\campaign_collaboration_service.js",
    "server\services\campaign_link_service.js",
    "server\services\campaign_ppt_service.js",
    "server\services\campaign_service.js",
    "server\services\campaign_workflow_service.js",
    "server\services\credential_rotation_service.js",
    "server\services\crm_access_service.js",
    "server\services\file_ingest_service.js",
    "server\services\idempotency_service.js",
    "server\services\influencer_workflow_service.js",
    "server\services\knowledge_service.js",
    "server\services\latest_ui_compat_service.js",
    "server\services\llm_service.js",
    "server\services\migration_service.js",
    "server\services\obsidian_ingest_service.js",
    "server\services\organization_access_service.js",
    "server\services\path_policy_service.js",
    "server\services\performance_content_import_service.js",
    "server\services\performance_metrics_service.js",
    "server\services\ppt_artifact_store.js",
    "server\services\public_assets_service.js",
    "server\services\publication_identity_service.js",
    "server\services\rag_service.js",
    "server\services\sqlite_digest_service.js",
    "server\services\upload_sandbox_service.js",
    "server\services\vault_export_service.js",
    "server\services\web_search_service.js",
    "server\scripts\bootstrap_production_browser_state.js",
    "server\scripts\bootstrap_production_runtime.sh",
    "server\scripts\capture_production_browser_baseline.js",
    "server\scripts\cleanup_stale_migration_gate.sh",
    "server\scripts\compare_ui_baseline_runs.js",
    "server\scripts\generate_ui_baseline_manifest.js",
    "server\scripts\generate_phase3_visual_evidence_manifest.js",
    "server\scripts\lib\production_browser_evidence.js",
    "server\scripts\parse_upload_sandbox.sh",
    "server\scripts\rotate_user_credentials.js",
    "server\scripts\update_ui_baseline.js",
    "server\scripts\release_replay_gate.js",
    "server\scripts\sanitization_manifest.json",
    "server\scripts\sanitize_production_shape.js",
    "server\scripts\trusted_production_source_gate.js",
    "server\scripts\trusted_production_source_manifest.json",
    "server\scripts\verify_phase4_one_request_replay.js",
    "server\scripts\verify_phase4_one_request_replay_probe.js",
    "server\scripts\verify_campaign_migration_gate.js",
    "server\systemd\turingmarket-gate-cleanup.service",
    "server\systemd\turingmarket-parser.manifest.json",
    "server\systemd\turingmarket-parser.slice",
    "server\systemd\turingmarket-parser@.service",
    "server\tests\ai_knowledge_foundation.test.js",
    "server\tests\accessibility_shell.test.js",
    "server\tests\ai_conversation_read_audit.test.js",
    "server\tests\brand_workspace_ui.test.js",
    "server\tests\bootstrap_phase4_boundary.test.js",
    "server\tests\browser_baseline_tools.test.js",
    "server\tests\campaign_api.test.js",
    "server\tests\campaign_ai_rag.test.js",
    "server\tests\campaign_collaboration_security.test.js",
    "server\tests\campaign_collaboration_trigger_migration.test.js",
    "server\tests\campaign_concurrency.test.js",
    "server\tests\campaign_knowledge_multipart.test.js",
    "server\tests\campaign_migration.test.js",
    "server\tests\campaign_ppt_service.test.js",
    "server\tests\campaign_ppt_singleflight.test.js",
    "server\tests\campaign_record_collection_access.test.js",
    "server\tests\campaign_record_integration.test.js",
    "server\tests\campaign_schema_behavior.test.js",
    "server\tests\campaign_workflow_dispatch.test.js",
    "server\tests\campaign_workflow_initialization.test.js",
    "server\tests\campaign_workflow_reassignment_and_reads.test.js",
    "server\tests\campaign_workflow_reconciliation.test.js",
    "server\tests\campaign_workflow_task_controls.test.js",
    "server\tests\credential_rotation.test.js",
    "server\tests\customer_workspace_ui.test.js",
    "server\tests\deployment_source_contract.test.js",
    "server\tests\deployment_source_trust.test.js",
    "server\tests\deployment_runtime_hardening.test.js",
    "server\tests\deployment_lifecycle_takeover.test.js",
    "server\tests\file_ingest_service.test.js",
    "server\tests\frontend_architecture_inventory.test.js",
    "server\tests\frontend_event_binding_contract.test.js",
    "server\tests\frontend_navigation_contract.test.js",
    "server\tests\frontend_public_assets.test.js",
    "server\tests\influencer_workflow.test.js",
    "server\tests\jwt_secret_startup.test.js",
    "server\tests\knowledge_archive_contract.test.js",
    "server\tests\knowledge_capacity_observability.test.js",
    "server\tests\knowledge_digest_compat.test.js",
    "server\tests\migration_gate_exactness.test.js",
    "server\tests\migration_service.test.js",
    "server\tests\obsidian_and_business_knowledge.test.js",
    "server\tests\organization_campaign_access.test.js",
    "server\tests\parser_admission_ledger.test.js",
    "server\tests\performance_content_import_service.test.js",
    "server\tests\performance_metrics_service.test.js",
    "server\tests\phase4_nginx_ingress.test.js",
    "server\tests\phase4_request_pipeline.test.js",
    "server\tests\phase4_server_integration.test.js",
    "server\tests\ppt_artifact_store.test.js",
    "server\tests\ppt_bridge_browser_contract.test.js",
    "server\tests\production_browser_evidence_tools.test.js",
    "server\tests\product_shell_contract.test.js",
    "server\tests\public_static_security.test.js",
    "server\tests\publication_identity_service.test.js",
    "server\tests\release_replay_gate.test.js",
    "server\tests\sanitized_migration_gate.test.js",
    "server\tests\sanitizer_structural_policy.test.js",
    "server\tests\security_and_crm_access.test.js",
    "server\tests\sqlite_digest_service.test.js",
    "server\tests\upload_sandbox.test.js",
    "server\tests\verify_campaign_migration_gate.test.js",
    "server\tests\verify_phase4_one_request_replay.test.js",
    "server\tests\browser-baseline.config.js",
    "server\tests\browser-baseline.spec.js",
    "server\tests\deployment-browser-smoke.config.js",
    "server\tests\deployment-browser-smoke.spec.js",
    "server\tests\fixtures\browser-baseline-data.json",
    "server\tests\fixtures\bad_import_probe.js",
    "server\tests\fixtures\bare_import_probe_migration.js",
    "server\tests\fixtures\builtin_import_probe_migration.js",
    "server\tests\fixtures\canonical_hash_vectors.js",
    "server\tests\fixtures\declared_dependency.js",
    "server\tests\fixtures\digest_v1_fixture.js",
    "server\tests\fixtures\failing_probe_migration.js",
    "server\tests\fixtures\final_verification_probe_migration.js",
    "server\tests\fixtures\fake\engines\v1.js",
    "server\tests\fixtures\fake_engine_suffix_migration.js",
    "server\tests\fixtures\frontend-active-definitions.json",
    "server\tests\fixtures\gap_probe_migration.js",
    "server\tests\fixtures\campaign_schema_contract.js",
    "server\tests\fixtures\legacy_populated_fixture.js",
    "server\tests\fixtures\source_exec_probe_migration.js",
    "server\tests\fixtures\test_probe_migration.js",
    "server\tests\fixtures\task-9-upload-header-contract.json",
    "server\tests\fixtures\transitive_dependency_migration.js",
    "server\tests\fixtures\undeclared_transitive_dependency.js",
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

function Get-ExactDeploymentInventoryIdentity {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Entries,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $snapshot = New-Object 'string[]' $Entries.Count
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = 0; $index -lt $Entries.Count; $index++) {
        $entry = $Entries[$index]
        if ($entry -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$entry)) {
            throw "$Label contains a non-string or empty entry."
        }
        $snapshot[$index] = [string]$entry
        if (-not $seen.Add($snapshot[$index])) {
            throw "Duplicate $Label entry: $($snapshot[$index])"
        }
    }

    [Array]::Sort($snapshot, [StringComparer]::Ordinal)
    $identityBuilder = New-Object Text.StringBuilder
    foreach ($entry in $snapshot) {
        $byteLength = [Text.Encoding]::UTF8.GetByteCount($entry)
        [void]$identityBuilder.Append($byteLength).Append(':').Append($entry).Append("`n")
    }
    $identityBytes = [Text.Encoding]::UTF8.GetBytes($identityBuilder.ToString())
    $identityHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $identitySha256 = ([BitConverter]::ToString($identityHasher.ComputeHash($identityBytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $identityHasher.Dispose()
    }
    return "$($snapshot.Count):$identitySha256"
}

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
    if ($BackupPath -notmatch '^backups/v050-campaign-business-spine-\d{8}-\d{6}$') {
        throw "Rollback backup must match backups/v050-campaign-business-spine-YYYYMMDD-HHMMSS"
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
        [ValidateRange(1, 14400)][int]$TimeoutSeconds = 7200,
        [switch]$CaptureOutput
    )

    $inputPath = Join-Path $env:TEMP ("tm-native-stdin-{0}.tmp" -f ([Guid]::NewGuid().ToString('N')))
    $outputPath = Join-Path $env:TEMP ("tm-native-stdout-{0}.tmp" -f ([Guid]::NewGuid().ToString('N')))
    $errorPath = Join-Path $env:TEMP ("tm-native-stderr-{0}.tmp" -f ([Guid]::NewGuid().ToString('N')))
    $normalizedInput = $InputText -replace "`r`n?", "`n"
    [IO.File]::WriteAllText($inputPath, $normalizedInput, (New-Object Text.UTF8Encoding($false)))
    $detachedArgumentList = $ArgumentList.Clone()
    $nativeArgumentParts = @(
        foreach ($nativeArgument in $detachedArgumentList) {
            Convert-ToNativeArgument $nativeArgument
        }
    )
    $nativeArguments = $nativeArgumentParts -join ' '
    $process = $null
    $exitCode = $null
    $capturedOutput = $null
    try {
        $startArguments = @{
            FilePath = $FileName
            ArgumentList = $nativeArguments
            RedirectStandardInput = $inputPath
            NoNewWindow = $true
            PassThru = $true
        }
        if ($CaptureOutput) {
            $startArguments.RedirectStandardOutput = $outputPath
            $startArguments.RedirectStandardError = $errorPath
        }
        $process = Start-Process @startArguments
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            [void]$process.WaitForExit(5000)
            throw "$FailureMessage timed out after $TimeoutSeconds second(s)."
        }
        # Ensure redirected streams have completed after the process handle signals exit.
        $process.WaitForExit()
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
        [ValidateRange(1, 14400)][int]$TimeoutSeconds = 7200,
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
test -f "$LockDir/run.json"
test ! -L "$LockDir/run.json"
test "$(stat -c '%U:%G:%a:%h' "$LockDir/run.json")" = "root:root:600:1"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["ownerToken"])' "$LockDir/run.json")" = "__LOCK_TOKEN__"
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
        $protectedBody = ($guards -join "`n") + "`n" + $Script
        $fence = @'
set -euo pipefail
OperationFence="__REMOTE_ROOT__/.deploy-v030.operation.lock"
command -v flock >/dev/null
umask 077
touch "$OperationFence"
chown root:root "$OperationFence"
chmod 0600 "$OperationFence"
flock -n -o "$OperationFence" bash -se <<'TM_OPERATION_FENCE'
__PROTECTED_BODY__
TM_OPERATION_FENCE
'@
        $fence = $fence.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
        $Script = $fence.Replace('__PROTECTED_BODY__', $protectedBody)
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
    $result = Invoke-NativeWithUtf8Input -FileName 'ssh.exe' -ArgumentList $arguments -InputText $Script -FailureMessage $FailureMessage -TimeoutSeconds $TimeoutSeconds -CaptureOutput:$CaptureOutput
    if ($CaptureOutput) {
        return $result
    }
}

function Install-RemoteTrustedProductionSourceGate {
    param([Parameter(Mandatory = $true)][object]$DeploymentPlan)

    Initialize-PinnedDeploymentTypes
    if ($DeploymentPlan -isnot [ImmutableDeploymentActionPlan]) {
        throw 'Trusted production source installation requires the immutable deployment action plan.'
    }
    $trustedGateRecord = $DeploymentPlan.GetByRemoteRelativePath(
        "platform/$(Convert-ToRemotePath $TRUSTED_SOURCE_GATE_RELATIVE_PATH)"
    )
    $trustedManifestRecord = $DeploymentPlan.GetByRemoteRelativePath(
        "platform/$(Convert-ToRemotePath $TRUSTED_SOURCE_MANIFEST_RELATIVE_PATH)"
    )
    if ($trustedGateRecord.ExpectedSha256 -cne $EXPECTED_TRUSTED_SOURCE_GATE_SHA256) {
        throw 'Pinned trusted production source gate SHA-256 does not match the deploy contract.'
    }
    if ($trustedManifestRecord.ExpectedSha256 -cne $EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256) {
        throw 'Pinned trusted production source manifest SHA-256 does not match the deploy contract.'
    }
    $trustedGateBase64 = $trustedGateRecord.ToBase64()
    $trustedManifestBase64 = $trustedManifestRecord.ToBase64()
    $installScript = @'
set -euo pipefail
InstallRoot="__TRUSTED_INSTALL_ROOT__"
TrustedGate="$InstallRoot/trusted_production_source_gate.js"
TrustedManifest="$InstallRoot/trusted_production_source_manifest.json"
TrustedBase="/usr/local/libexec/turingmarket/production-source-trust"
TrustedParent="$(dirname "$InstallRoot")"
ExpectedGateSha256="__TRUSTED_GATE_SHA256__"
ExpectedManifestSha256="__TRUSTED_MANIFEST_SHA256__"
GateBase64='__TRUSTED_GATE_BASE64__'
ManifestBase64='__TRUSTED_MANIFEST_BASE64__'

assert_root_owned_nonreplaceable_chain() {
  local Current Mode
  Current="$1"
  case "$Current" in /*) ;; *) echo "Trusted source ancestor path is not absolute" >&2; return 1 ;; esac
  while true; do
    test -d "$Current"
    test ! -L "$Current"
    test "$(stat -c '%u:%g' "$Current")" = "0:0"
    Mode="$(stat -c '%a' "$Current")"
    if (( (8#$Mode & 0022) != 0 )); then
      echo "Trusted source ancestor is writable outside root: $Current" >&2
      return 1
    fi
    if [ "$Current" = "/" ]; then
      break
    fi
    Current="$(dirname "$Current")"
  done
}

case "$InstallRoot" in
  "$TrustedBase"/*) ;;
  *) echo "Trusted source install path escaped its fixed root" >&2; exit 1 ;;
esac
command -v base64 >/dev/null
command -v sha256sum >/dev/null
ExistingAncestor="$TrustedParent"
while [ ! -e "$ExistingAncestor" ] && [ ! -L "$ExistingAncestor" ]; do
  ExistingAncestor="$(dirname "$ExistingAncestor")"
done
assert_root_owned_nonreplaceable_chain "$ExistingAncestor"
install -d -o root -g root -m 0755 "$TrustedBase" "$TrustedParent"
test "$(stat -c '%U:%G:%a' "$TrustedBase")" = "root:root:755"
test ! -L "$TrustedParent"
test "$(stat -c '%U:%G:%a' "$TrustedParent")" = "root:root:755"
assert_root_owned_nonreplaceable_chain "$TrustedParent"

if [ ! -e "$InstallRoot" ] && [ ! -L "$InstallRoot" ]; then
  NextRoot="$TrustedParent/.next-${ExpectedGateSha256}-${ExpectedManifestSha256}-$$"
  test ! -e "$NextRoot"
  cleanup_trusted_source_install() {
    rm -rf -- "$NextRoot"
  }
  trap cleanup_trusted_source_install EXIT
  install -d -o root -g root -m 0755 "$NextRoot" "$NextRoot/bundles" "$NextRoot/runtime"
  printf '%s' "$GateBase64" | base64 --decode > "$NextRoot/trusted_production_source_gate.js"
  printf '%s' "$ManifestBase64" | base64 --decode > "$NextRoot/trusted_production_source_manifest.json"
  chown root:root "$NextRoot/trusted_production_source_gate.js" "$NextRoot/trusted_production_source_manifest.json"
  chmod 0444 "$NextRoot/trusted_production_source_gate.js" "$NextRoot/trusted_production_source_manifest.json"
  echo "$ExpectedGateSha256  $NextRoot/trusted_production_source_gate.js" | sha256sum --check --status
  echo "$ExpectedManifestSha256  $NextRoot/trusted_production_source_manifest.json" | sha256sum --check --status
  mv -T "$NextRoot" "$InstallRoot"
  trap - EXIT
fi

test -d "$InstallRoot"
test ! -L "$InstallRoot"
test "$(stat -c '%U:%G:%a' "$InstallRoot")" = "root:root:755"
for directory in "$InstallRoot/bundles" "$InstallRoot/runtime"; do
  test -d "$directory"
  test ! -L "$directory"
  test "$(stat -c '%U:%G:%a' "$directory")" = "root:root:755"
done
for specification in \
  "$TrustedGate:$ExpectedGateSha256" \
  "$TrustedManifest:$ExpectedManifestSha256"; do
  TrustedFile="${specification%%:*}"
  ExpectedSha256="${specification##*:}"
  test -f "$TrustedFile"
  test ! -L "$TrustedFile"
  test "$(stat -c '%U:%G:%a:%h' "$TrustedFile")" = "root:root:444:1"
  echo "$ExpectedSha256  $TrustedFile" | sha256sum --check --status
done
assert_root_owned_nonreplaceable_chain "$InstallRoot/bundles"
printf '%s\n' 'TRUSTED_PRODUCTION_SOURCE_GATE_INSTALLED'
'@
    $installScript = $installScript.Replace('__TRUSTED_INSTALL_ROOT__', $TRUSTED_SOURCE_INSTALL_ROOT)
    $installScript = $installScript.Replace('__TRUSTED_GATE_SHA256__', $EXPECTED_TRUSTED_SOURCE_GATE_SHA256)
    $installScript = $installScript.Replace('__TRUSTED_MANIFEST_SHA256__', $EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256)
    $installScript = $installScript.Replace('__TRUSTED_GATE_BASE64__', $trustedGateBase64)
    $installScript = $installScript.Replace('__TRUSTED_MANIFEST_BASE64__', $trustedManifestBase64)
    Invoke-RemoteBash -Script $installScript -FailureMessage "Trusted production source gate installation failed" -RequireDeploymentLock
}

function Invoke-RemoteTrustedSourceInputSweep {
    $sweepScript = @'
set -euo pipefail
TrustedSourceInputBase="/run/turingmarket-production-source-trust"
GateUser="__GATE_USER__"

command -v pgrep >/dev/null
command -v python3 >/dev/null
command -v sync >/dev/null
test -d /run
test ! -L /run
test "$(stat -c '%u:%g' /run)" = "0:0"
RunMode="$(stat -c '%a' /run)"
(( (8#$RunMode & 0022) == 0 ))
GateGroupGid="$(id -g "$GateUser")"
[[ "$GateGroupGid" =~ ^[0-9]+$ ]]
if pgrep -u "$GateUser" >/dev/null; then
  echo "Trusted source copies cannot be swept while gate-user processes exist" >&2
  exit 1
fi

python3 - "$TrustedSourceInputBase" 0 "$GateGroupGid" 0710 0700,0510 0440 <<'TM_TRUSTED_SOURCE_SWEEP'
import os
import re
import stat
import sys

root, expected_uid_raw, expected_gid_raw, base_mode_raw, run_modes_raw, source_mode_raw = sys.argv[1:]
expected_uid = int(expected_uid_raw, 10)
expected_gid = int(expected_gid_raw, 10)
expected_base_mode = int(base_mode_raw, 8)
expected_run_modes = {int(value, 8) for value in run_modes_raw.split(',')}
expected_source_mode = int(source_mode_raw, 8)
deployment_name = re.compile(r'deployment-[0-9]{8}-[0-9]{6}')

def fail(message):
    raise RuntimeError(message)

def exact_directory(path, expected_modes, label):
    metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        fail(f'{label} is not a real directory')
    if metadata.st_uid != expected_uid or metadata.st_gid != expected_gid:
        fail(f'{label} owner is invalid')
    if stat.S_IMODE(metadata.st_mode) not in expected_modes:
        fail(f'{label} mode is invalid')
    return metadata

if not os.path.lexists(root):
    print('TRUSTED_SOURCE_STALE_SWEEP_REMOVED=0')
    raise SystemExit(0)

exact_directory(root, {expected_base_mode}, 'trusted source input base')
removals = []
for name in sorted(os.listdir(root)):
    if deployment_name.fullmatch(name) is None:
        fail('trusted source input base contains an unexpected entry')
    deployment_root = os.path.join(root, name)
    exact_directory(deployment_root, expected_run_modes, 'trusted source deployment root')
    inventory = sorted(os.listdir(deployment_root))
    if not inventory:
        removals.append((deployment_root, None))
        continue
    if inventory != ['source.db']:
        fail('trusted source deployment root inventory is invalid')
    source_path = os.path.join(deployment_root, 'source.db')
    source_metadata = os.lstat(source_path)
    if stat.S_ISLNK(source_metadata.st_mode) or not stat.S_ISREG(source_metadata.st_mode):
        fail('trusted source copy is not a regular file')
    if source_metadata.st_uid != expected_uid or source_metadata.st_gid != expected_gid:
        fail('trusted source copy owner is invalid')
    if stat.S_IMODE(source_metadata.st_mode) != expected_source_mode or source_metadata.st_nlink != 1:
        fail('trusted source copy mode or link count is invalid')
    removals.append((deployment_root, source_path))

# Validation is intentionally complete before the first unlink/rmdir.
for deployment_root, source_path in removals:
    if source_path is not None:
        os.unlink(source_path)
    os.rmdir(deployment_root)

print(f'TRUSTED_SOURCE_STALE_SWEEP_REMOVED={len(removals)}')
TM_TRUSTED_SOURCE_SWEEP
if [ -d "$TrustedSourceInputBase" ] && [ ! -L "$TrustedSourceInputBase" ]; then
  sync -f "$TrustedSourceInputBase"
fi
'@
    $sweepScript = $sweepScript.Replace('__GATE_USER__', $GATE_USER)
    Invoke-RemoteBash -Script $sweepScript -FailureMessage "Trusted production source stale-copy sweep failed" -TimeoutSeconds 60 -RequireDeploymentLock
}

function Assert-RemoteExternalRuntimeBoundary {
    $remoteScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
Marker="$RemoteRoot/.external-runtime-layout-v1"
JournalActive="/var/lib/turingmarket-bootstrap/active"
WriterDir="$RemoteRoot/.deploy-v030.writer"

test -d "$RemoteRoot"
test ! -L "$RemoteRoot"
test "$(realpath -e "$RemoteRoot")" = "$RemoteRoot"
test -f "$Marker"
test ! -L "$Marker"
test "$(realpath -e "$Marker")" = "$Marker"
test "$(stat -c '%U:%G:%a:%h' "$Marker")" = "root:root:600:1"
printf '%s\n' \
  'turingmarket-external-layout-v1' \
  'runtime-owner=platform/deploy_v8.ps1' \
  'bootstrap-mode=setup-only' |
  cmp -s - "$Marker"

if [ -e "$JournalActive" ] || [ -L "$JournalActive" ]; then
  echo "An active bootstrap journal remains after external-layout ownership transfer" >&2
  exit 1
fi
if [ -e "$WriterDir" ] || [ -L "$WriterDir" ]; then
  echo "A bootstrap or production writer fence remains active" >&2
  exit 1
fi
for conflict in \
  "$RemoteRoot"/.deploy-v030.lock.next.* \
  "$RemoteRoot"/.deploy-v030.lock.released.* \
  "$RemoteRoot"/.deploy-v030.writer.next.* \
  "$RemoteRoot"/.deploy-v030.writer.released.*; do
  if [ -e "$conflict" ] || [ -L "$conflict" ]; then
    echo "A stale bootstrap-owned deployment generation requires bootstrap recovery: $conflict" >&2
    exit 1
  fi
done
printf '%s\n' 'EXTERNAL_RUNTIME_BOUNDARY_OK'
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "External runtime ownership boundary preflight failed" -RequireDeploymentLock
}

function Assert-RemoteLoopbackIsolationPreflight {
    $remoteScript = @'
set -euo pipefail
LiveDir="__REMOTE_DIR__"
FirewallTable="turingmarket_loopback"
FirewallUnit="turingmarket-loopback-firewall.service"
RuleFile="/etc/turingmarket/turingmarket-loopback-firewall.nft"
HelperFile="/usr/local/sbin/turingmarket-loopback-firewall"
ServiceFile="/etc/systemd/system/turingmarket-loopback-firewall.service"
DropInFile="/etc/systemd/system/pm2-root.service.d/turingmarket-loopback-firewall.conf"
NftBin="/usr/sbin/nft"
command -v node >/dev/null
command -v pm2 >/dev/null
command -v python3 >/dev/null
command -v ss >/dev/null
command -v systemctl >/dev/null
test -x "$NftBin"

cd "$LiveDir"
node <<'NODE'
const configuration = require('./ecosystem.config.js');
if (!configuration || !Array.isArray(configuration.apps)) throw new Error('PM2 configuration is invalid');
const applications = configuration.apps.filter((entry) => entry && entry.name === 'turingmarket');
if (applications.length !== 1 || !applications[0].env || applications[0].env.SERVER_HOST !== '127.0.0.1') {
  throw new Error('PM2 configuration must export SERVER_HOST=127.0.0.1');
}
NODE
TM_PM2_JLIST="$(pm2 jlist)" node <<'NODE'
const processes = JSON.parse(process.env.TM_PM2_JLIST || '[]');
const matches = processes.filter((entry) => entry && entry.name === 'turingmarket');
if (matches.length !== 1) throw new Error('Exactly one PM2 turingmarket process definition is required');
const environment = matches[0].pm2_env || {};
if (environment.SERVER_HOST !== '127.0.0.1') {
  throw new Error('PM2 runtime must export SERVER_HOST=127.0.0.1');
}
if (!['online', 'stopped'].includes(environment.status)) {
  throw new Error(`Unexpected PM2 state: ${environment.status || 'missing'}`);
}
NODE

ExpectedDir="$(mktemp -d)"
trap 'rm -rf "$ExpectedDir"' EXIT
cat > "$ExpectedDir/rules.nft" <<'NFT_RULES'
destroy table inet turingmarket_loopback
table inet turingmarket_loopback {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname != "lo" tcp dport 3002 reject with tcp reset comment "turingmarket-loopback-only-3002"
  }
}
NFT_RULES
cat > "$ExpectedDir/helper" <<'FIREWALL_HELPER'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
NFT_BIN=/usr/sbin/nft
RULE_FILE=/etc/turingmarket/turingmarket-loopback-firewall.nft
TABLE_NAME=turingmarket_loopback
case "${1:-}" in
  apply)
    "$NFT_BIN" --check -f "$RULE_FILE"
    "$NFT_BIN" -f "$RULE_FILE"
    ;;
  remove)
    if "$NFT_BIN" list table inet "$TABLE_NAME" >/dev/null 2>&1; then
      "$NFT_BIN" delete table inet "$TABLE_NAME"
    fi
    ;;
  *)
    printf '%s\n' "Usage: $0 {apply|remove}" >&2
    exit 64
    ;;
esac
FIREWALL_HELPER
cat > "$ExpectedDir/service" <<'FIREWALL_SERVICE'
[Unit]
Description=TuringMarket loopback-only backend firewall
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target
Before=pm2-root.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/turingmarket-loopback-firewall apply
ExecReload=/usr/local/sbin/turingmarket-loopback-firewall apply
ExecStop=/usr/local/sbin/turingmarket-loopback-firewall remove

[Install]
WantedBy=multi-user.target
FIREWALL_SERVICE
cat > "$ExpectedDir/dropin" <<'PM2_FIREWALL_DROPIN'
[Unit]
Requires=turingmarket-loopback-firewall.service
After=turingmarket-loopback-firewall.service
PM2_FIREWALL_DROPIN

for specification in \
  "$RuleFile:$ExpectedDir/rules.nft:600" \
  "$HelperFile:$ExpectedDir/helper:700" \
  "$ServiceFile:$ExpectedDir/service:644" \
  "$DropInFile:$ExpectedDir/dropin:644"; do
  Installed="${specification%%:*}"
  Remainder="${specification#*:}"
  Expected="${Remainder%:*}"
  Mode="${specification##*:}"
  test -f "$Installed"
  test ! -L "$Installed"
  test "$(stat -c '%U:%G:%a:%h' "$Installed")" = "root:root:$Mode:1"
  cmp -s "$Expected" "$Installed"
done
systemctl is-enabled --quiet "$FirewallUnit"
systemctl is-active --quiet "$FirewallUnit"

NFT_RULESET_JSON="$($NftBin -j list table inet "$FirewallTable")" python3 - <<'PY'
import json
import os

document = json.loads(os.environ['NFT_RULESET_JSON'])
entries = [entry for entry in document.get('nftables', []) if 'metainfo' not in entry]
if len(entries) != 3:
    raise SystemExit('Unexpected nftables object count')

def one(name):
    values = [dict(entry[name]) for entry in entries if name in entry]
    if len(values) != 1:
        raise SystemExit(f'Unexpected nftables {name} count')
    values[0].pop('handle', None)
    return values[0]

if one('table') != {'family': 'inet', 'name': 'turingmarket_loopback'}:
    raise SystemExit('Unexpected nftables table')
if one('chain') != {
    'family': 'inet', 'table': 'turingmarket_loopback', 'name': 'input',
    'type': 'filter', 'hook': 'input', 'prio': -10, 'policy': 'accept'
}:
    raise SystemExit('Unexpected nftables chain')
if one('rule') != {
    'family': 'inet', 'table': 'turingmarket_loopback', 'chain': 'input',
    'expr': [
        {'match': {'op': '!=', 'left': {'meta': {'key': 'iifname'}}, 'right': 'lo'}},
        {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'dport'}}, 'right': 3002}},
        {'reject': {'type': 'tcp reset'}},
    ],
    'comment': 'turingmarket-loopback-only-3002'
}:
    raise SystemExit('Unexpected nftables rule')
PY

TM_LISTENERS="$(ss -H -ltn 'sport = :3002')" \
TM_CONNECTIONS="$(ss -H -tn '( sport = :3002 or dport = :3002 )')" \
python3 - <<'PY'
import ipaddress
import os

def endpoint_host(value):
    value = value.strip()
    if value.startswith('['):
        return value[1:value.rfind(']')]
    return value.rsplit(':', 1)[0]

listeners = [line.split() for line in os.environ.get('TM_LISTENERS', '').splitlines() if line.strip()]
if len(listeners) > 1:
    raise SystemExit('More than one listener exists on port 3002')
for fields in listeners:
    if len(fields) < 5 or fields[0] != 'LISTEN' or endpoint_host(fields[3]) != '127.0.0.1':
        raise SystemExit('A non-loopback listener exists on port 3002')

for fields in (line.split() for line in os.environ.get('TM_CONNECTIONS', '').splitlines() if line.strip()):
    if len(fields) < 5:
        raise SystemExit('Unparseable port 3002 connection')
    for endpoint in fields[3:5]:
        host = endpoint_host(endpoint)
        try:
            if not ipaddress.ip_address(host).is_loopback:
                raise SystemExit('A non-loopback connection exists on port 3002')
        except ValueError as error:
            raise SystemExit('Unparseable port 3002 endpoint') from error
PY
printf '%s\n' 'LOOPBACK_ISOLATION_PREFLIGHT_OK'
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Remote loopback isolation preflight failed"
}

function Install-RemoteMigrationGateCleanup {
    param([Parameter(Mandatory = $true)][object]$DeploymentPlan)

    Initialize-PinnedDeploymentTypes
    if ($DeploymentPlan -isnot [ImmutableDeploymentActionPlan]) {
        throw 'Migration gate cleanup installation requires the immutable deployment action plan.'
    }
    $cleanupRecord = $DeploymentPlan.GetByRemoteRelativePath('platform/server/scripts/cleanup_stale_migration_gate.sh')
    $unitRecord = $DeploymentPlan.GetByRemoteRelativePath('platform/server/systemd/turingmarket-gate-cleanup.service')
    $cleanupBase64 = $cleanupRecord.ToBase64()
    $unitBase64 = $unitRecord.ToBase64()
    $cleanupSha256 = $cleanupRecord.ExpectedSha256
    $unitSha256 = $unitRecord.ExpectedSha256

    $remoteScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
RunId="__RUN_ID__"
Stage="$RemoteRoot/.migration-gate-cleanup-stage-$RunId"
Helper="/usr/local/libexec/turingmarket/cleanup_stale_migration_gate.sh"
HelperRoot="$(dirname "$Helper")"
Unit="/etc/systemd/system/turingmarket-gate-cleanup.service"
JournalRoot="/var/lib/turingmarket/migration-gate"
test ! -e "$Stage"
install -d -o root -g root -m 0700 "$Stage"
printf '%s' '__CLEANUP_BASE64__' | base64 --decode > "$Stage/cleanup.sh"
printf '%s' '__UNIT_BASE64__' | base64 --decode > "$Stage/cleanup.service"
chown root:root "$Stage/cleanup.sh" "$Stage/cleanup.service"
chmod 0500 "$Stage/cleanup.sh" "$Stage/cleanup.service"
test "$(sha256sum "$Stage/cleanup.sh" | awk '{print $1}')" = "__CLEANUP_SHA256__"
test "$(sha256sum "$Stage/cleanup.service" | awk '{print $1}')" = "__UNIT_SHA256__"
sync -f "$Stage/cleanup.sh"
sync -f "$Stage/cleanup.service"
sync -f "$Stage"

install -d -o root -g root -m 0755 "$HelperRoot"
install -d -o root -g root -m 0700 "$JournalRoot"
test ! -L "$Helper"
test ! -L "$Unit"
HelperNext="$HelperRoot/.cleanup_stale_migration_gate.sh.next.$RunId"
UnitNext="/etc/systemd/system/.turingmarket-gate-cleanup.service.next.$RunId"
test ! -e "$HelperNext"
test ! -e "$UnitNext"
install -o root -g root -m 0555 "$Stage/cleanup.sh" "$HelperNext"
install -o root -g root -m 0444 "$Stage/cleanup.service" "$UnitNext"
sync -f "$HelperNext"
sync -f "$UnitNext"
mv -f "$HelperNext" "$Helper"
mv -f "$UnitNext" "$Unit"
sync -f "$Helper"
sync -f "$Unit"
sync -f "$HelperRoot"
sync -f /etc/systemd/system
test "$(stat -c '%U:%G:%a:%h' "$Helper")" = "root:root:555:1"
test "$(stat -c '%U:%G:%a:%h' "$Unit")" = "root:root:444:1"
test "$(sha256sum "$Helper" | awk '{print $1}')" = "__CLEANUP_SHA256__"
test "$(sha256sum "$Unit" | awk '{print $1}')" = "__UNIT_SHA256__"

systemctl daemon-reload
systemctl enable turingmarket-gate-cleanup.service >/dev/null
systemctl start turingmarket-gate-cleanup.service
test "$(systemctl is-enabled turingmarket-gate-cleanup.service)" = "enabled"
test "$(systemctl show turingmarket-gate-cleanup.service --property=ConditionResult --value)" = "yes"
test "$(systemctl show turingmarket-gate-cleanup.service --property=Result --value)" = "success"
test "$(systemctl show turingmarket-gate-cleanup.service --property=ExecMainStatus --value)" = "0"
if find "$JournalRoot" -mindepth 1 -maxdepth 1 -name '*.run.json' -print -quit | grep -q .; then
  echo "Migration gate cleanup left a journal" >&2
  exit 1
fi
if systemctl list-units --type=service --state=running --no-legend 'turingmarket-migration-gate-*.service' | grep -q .; then
  echo "A stale migration gate unit remains active" >&2
  exit 1
fi
rm -f -- "$Stage/cleanup.sh" "$Stage/cleanup.service"
rmdir "$Stage"
sync -f "$RemoteRoot"
printf '%s\n' 'MIGRATION_GATE_SANITIZER_PREFLIGHT_OK'
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__RUN_ID__', $deploymentRunId)
    $remoteScript = $remoteScript.Replace('__CLEANUP_BASE64__', $cleanupBase64)
    $remoteScript = $remoteScript.Replace('__UNIT_BASE64__', $unitBase64)
    $remoteScript = $remoteScript.Replace('__CLEANUP_SHA256__', $cleanupSha256)
    $remoteScript = $remoteScript.Replace('__UNIT_SHA256__', $unitSha256)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Migration gate sanitizer installation or preflight failed" -RequireDeploymentLock
}

function Enter-RemoteDeploymentLock {
    foreach ($value in @(
        $deploymentLockToken,
        $deploymentRunId,
        $deploymentBackupPath,
        $deploymentReleaseRoot,
        $deploymentSourceIdentity,
        $deploymentSourceSha256
    )) {
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "Deployment run metadata must be initialized before acquiring the lifecycle lock."
        }
    }
    if ($deploymentSourceSha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Deployment source SHA-256 is invalid."
    }

    $remoteScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
FinalLockDir="$RemoteRoot/.deploy-v030.lock"
OperationFence="$RemoteRoot/.deploy-v030.operation.lock"
LockDir="$RemoteRoot/.deploy-v030.lock.next.__LOCK_TOKEN__"
command -v flock >/dev/null
umask 077
touch "$OperationFence"
chown root:root "$OperationFence"
chmod 0600 "$OperationFence"
flock -n -o "$OperationFence" bash -se <<'TM_LIFECYCLE_CREATE'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
FinalLockDir="$RemoteRoot/.deploy-v030.lock"
LockDir="$RemoteRoot/.deploy-v030.lock.next.__LOCK_TOKEN__"
python3 - "$RemoteRoot" "0" <<'TM_INCOMPLETE_LOCK_CLEANUP'
import json
import os
import re
import stat
import sys

root, expectedUidRaw = sys.argv[1:]
expectedUid = int(expectedUidRaw)
root = os.path.abspath(root)
rootStatus = os.lstat(root)
if os.path.islink(root) or not stat.S_ISDIR(rootStatus.st_mode) or rootStatus.st_uid != expectedUid:
    raise SystemExit('Unsafe deployment root for incomplete lifecycle cleanup')
prefix = '.deploy-v030.lock.next.'
pattern = re.compile(r'^\.deploy-v030\.lock\.next\.([0-9a-f]{32})$')
allowedSets = {
    frozenset(),
    frozenset({'run.json.next'}),
    frozenset({'run.json'}),
    frozenset({'run.json', 'owner'}),
    frozenset({'run.json', 'owner', 'phase'}),
}
candidates = []
for entry in os.scandir(root):
    if not entry.name.startswith(prefix):
        continue
    match = pattern.fullmatch(entry.name)
    if not match:
        raise SystemExit(f'Unexpected incomplete lifecycle entry: {entry.name}')
    metadata = entry.stat(follow_symlinks=False)
    if (entry.is_symlink() or not entry.is_dir(follow_symlinks=False) or metadata.st_uid != expectedUid or
            (os.name != 'nt' and stat.S_IMODE(metadata.st_mode) != 0o700)):
        raise SystemExit(f'Unsafe incomplete lifecycle directory: {entry.name}')
    children = list(os.scandir(entry.path))
    names = frozenset(child.name for child in children)
    if names not in allowedSets:
        raise SystemExit(f'Unexpected incomplete lifecycle entry set: {entry.name}')
    for child in children:
        childStatus = child.stat(follow_symlinks=False)
        if child.is_symlink() or not child.is_file(follow_symlinks=False):
            raise SystemExit(f'Unsafe incomplete lifecycle child: {child.path}')
        if (childStatus.st_uid != expectedUid or
                (os.name != 'nt' and (childStatus.st_nlink != 1 or stat.S_IMODE(childStatus.st_mode) != 0o600))):
            raise SystemExit(f'Unsafe incomplete lifecycle child metadata: {child.path}')
    for metadataName in ('run.json', 'run.json.next'):
        metadataPath = os.path.join(entry.path, metadataName)
        if not os.path.exists(metadataPath):
            continue
        try:
            with open(metadataPath, encoding='utf-8') as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            continue
        if payload.get('operation') == 'bootstrap':
            raise SystemExit(f'Bootstrap-owned lifecycle generation requires bootstrap recovery: {entry.name}')
    phasePath = os.path.join(entry.path, 'phase')
    if os.path.exists(phasePath):
        with open(phasePath, encoding='utf-8') as handle:
            if handle.read().strip() == 'bootstrap-setup':
                raise SystemExit(f'Bootstrap-owned lifecycle generation requires bootstrap recovery: {entry.name}')
    candidates.append((entry.path, match.group(1)))

def fsyncDirectory(directory):
    if os.name == 'nt':
        return
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

for source, token in candidates:
    quarantine = os.path.join(root, f'.deploy-v030.incomplete-quarantine.{token}')
    if os.path.lexists(quarantine):
        raise SystemExit(f'Incomplete lifecycle quarantine already exists: {quarantine}')
    os.replace(source, quarantine)
    fsyncDirectory(root)
    for child in os.scandir(quarantine):
        if child.is_symlink() or not child.is_file(follow_symlinks=False):
            raise SystemExit(f'Quarantined lifecycle child changed: {child.path}')
        os.unlink(child.path)
    fsyncDirectory(quarantine)
    os.rmdir(quarantine)
    fsyncDirectory(root)
print('INCOMPLETE_LIFECYCLE_CLEANUP_OK')
TM_INCOMPLETE_LOCK_CLEANUP
if [ -e "$FinalLockDir" ] || [ -L "$FinalLockDir" ]; then
  echo "Another deployment or rollback holds the production lock" >&2
  exit 1
fi
test ! -e "$LockDir"
mkdir "$LockDir"
python3 - \
  "$LockDir/run.json.next" \
  "__RUN_ID__" \
  "__LOCK_TOKEN__" \
  "__BACKUP_PATH__" \
  "__RELEASE_ROOT__" \
  "__CANDIDATE_PATH__" \
  "__SOURCE_IDENTITY__" \
  "__SOURCE_SHA256__" \
  "__CREATED_AT__" \
  "__OPERATION__" <<'PY'
import json
import os
import re
import sys

target, runId, ownerToken, backupPath, releaseRoot, candidatePath, sourceIdentity, sourceSha256, createdAt, operation = sys.argv[1:]
if not re.fullmatch(r'[0-9a-f]{32}', runId):
    raise SystemExit('Invalid deployment run id')
if not re.fullmatch(r'[0-9a-f]{32}', ownerToken):
    raise SystemExit('Invalid deployment owner token')
if not re.fullmatch(r'backups/v050-campaign-business-spine-[0-9]{8}-[0-9]{6}', backupPath):
    raise SystemExit('Invalid deployment backup path')
if not re.fullmatch(r'[0-9a-f]{64}', sourceSha256):
    raise SystemExit('Invalid deployment source SHA-256')
if operation == 'deploy':
    if not re.fullmatch(r'/var/lib/turingmarket-gate/releases/v050-campaign-business-spine-[0-9]{8}-[0-9]{6}', releaseRoot):
        raise SystemExit('Invalid deployment release root')
    if candidatePath != releaseRoot + '/platform':
        raise SystemExit('Invalid deployment candidate path')
elif operation == 'rollback':
    if releaseRoot != '/root/turingmarket/platform' or candidatePath:
        raise SystemExit('Invalid rollback run paths')
else:
    raise SystemExit('Invalid deployment operation')

payload = {
    'schemaVersion': 1,
    'operation': operation,
    'runId': runId,
    'ownerToken': ownerToken,
    'backupPath': backupPath,
    'releaseRoot': releaseRoot,
    'candidatePath': candidatePath,
    'sourceIdentity': sourceIdentity,
    'sourceSha256': sourceSha256,
    'createdAt': createdAt,
    'backupReady': False,
    'backupManifestSha256': None,
    'recoveryGeneration': 0,
    'quarantinePath': None,
}
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
mv "$LockDir/run.json.next" "$LockDir/run.json"
printf '%s\n' "__LOCK_TOKEN__" > "$LockDir/owner"
printf '%s\n' "locked" > "$LockDir/phase"
chown root:root "$LockDir/run.json" "$LockDir/owner" "$LockDir/phase"
chmod 0600 "$LockDir/run.json" "$LockDir/owner" "$LockDir/phase"
sync -f "$LockDir/run.json"
sync -f "$LockDir/owner"
sync -f "$LockDir/phase"
sync -f "$LockDir"
mv "$LockDir" "$FinalLockDir"
sync -f "$FinalLockDir"
sync -f "$RemoteRoot"
TM_LIFECYCLE_CREATE
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__LOCK_TOKEN__', $deploymentLockToken)
    $remoteScript = $remoteScript.Replace('__RUN_ID__', $deploymentRunId)
    $remoteScript = $remoteScript.Replace('__BACKUP_PATH__', $deploymentBackupPath)
    $remoteScript = $remoteScript.Replace('__RELEASE_ROOT__', $deploymentReleaseRoot)
    $remoteScript = $remoteScript.Replace('__CANDIDATE_PATH__', $deploymentCandidatePath)
    $remoteScript = $remoteScript.Replace('__SOURCE_IDENTITY__', $deploymentSourceIdentity)
    $remoteScript = $remoteScript.Replace('__SOURCE_SHA256__', $deploymentSourceSha256)
    $remoteScript = $remoteScript.Replace('__CREATED_AT__', (Get-Date).ToUniversalTime().ToString('o'))
    $remoteScript = $remoteScript.Replace('__OPERATION__', $deploymentOperation)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Unable to acquire the remote deployment lock"
}

function Exit-RemoteDeploymentLock {
    param([switch]$ReleaseWriterLock)

    if ($ReleaseWriterLock -and [string]::IsNullOrWhiteSpace($deploymentWriterToken)) {
        throw "A deployment writer token is required to release the writer and deployment locks."
    }

    $remoteScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
OperationFence="$RemoteRoot/.deploy-v030.operation.lock"
command -v flock >/dev/null
flock -n -o "$OperationFence" bash -se <<'TM_LIFECYCLE_RELEASE'
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
Phase="$(cat "$LockDir/phase")"
if [ "$Phase" = "accepted" ] || [ "$Phase" = "cutover-complete" ]; then
  RunId="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["runId"])' "$LockDir/run.json")"
  Evidence="__REMOTE_ROOT__/deployment-evidence/accepted-$RunId.json"
  test -f "$Evidence"
  test ! -L "$Evidence"
  test "$(stat -c '%U:%G:%a:%h' "$Evidence")" = "root:root:600:1"
fi
mv "$LockDir" "$RetiredDir"
rm -rf "$RetiredDir"
if [ "__RELEASE_WRITER__" = "1" ]; then
  mv "$WriterDir" "$RetiredWriterDir"
  rm -rf "$RetiredWriterDir"
fi
sync -f "__REMOTE_ROOT__"
TM_LIFECYCLE_RELEASE
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

function Get-RemoteInterruptedDeploymentObservation {
    $remoteScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
LockDir="$RemoteRoot/.deploy-v030.lock"
OperationFence="$RemoteRoot/.deploy-v030.operation.lock"
command -v flock >/dev/null
test -f "$OperationFence"
test ! -L "$OperationFence"
flock -n -o "$OperationFence" bash -se <<'TM_LIFECYCLE_OBSERVE'
set -euo pipefail
LockDir="__REMOTE_ROOT__/.deploy-v030.lock"
test -d "$LockDir"
test ! -L "$LockDir"
test "$(stat -c '%U:%G:%a' "$LockDir")" = "root:root:700"
for file in run.json owner phase; do
  test -f "$LockDir/$file"
  test ! -L "$LockDir/$file"
  test "$(stat -c '%U:%G:%a:%h' "$LockDir/$file")" = "root:root:600:1"
done
python3 - "$LockDir/run.json" "$LockDir/owner" "$LockDir/phase" <<'PY'
import json
import re
import sys

runPath, ownerPath, phasePath = sys.argv[1:]
with open(runPath, encoding='utf-8') as handle:
    metadata = json.load(handle)
with open(ownerPath, encoding='ascii') as handle:
    owner = handle.read().strip()
with open(phasePath, encoding='ascii') as handle:
    phase = handle.read().strip()
if metadata.get('schemaVersion') != 1 or metadata.get('operation') != 'deploy':
    raise SystemExit('Interrupted lifecycle metadata is not a deploy run')
if not re.fullmatch(r'[0-9a-f]{32}', metadata.get('runId', '')):
    raise SystemExit('Invalid interrupted deployment run id')
if not re.fullmatch(r'[0-9a-f]{32}', metadata.get('ownerToken', '')):
    raise SystemExit('Invalid interrupted deployment owner token')
if not re.fullmatch(r'[0-9a-f]{32}', owner):
    raise SystemExit('Invalid lifecycle owner mirror')
allowed = {'locked', 'candidate-ready', 'mutation-intent', 'maintenance-entered', 'writers-stopped', 'snapshot-ready', 'prior-marker-archived', 'nginx-candidate-staged', 'mutation-started', 'accepted', 'accepted-public-enabled', 'cutover-complete'}
if phase not in allowed:
    raise SystemExit('Unknown interrupted deployment phase')
print(json.dumps({'runId': metadata['runId'], 'ownerToken': metadata['ownerToken'], 'phase': phase}, separators=(',', ':')))
PY
TM_LIFECYCLE_OBSERVE
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    return Invoke-RemoteBash -Script $remoteScript -FailureMessage "Unable to observe the interrupted deployment" -CaptureOutput
}

function Enter-RemoteInterruptedDeploymentRecovery {
    $observationJson = Get-RemoteInterruptedDeploymentObservation
    try {
        $observation = $observationJson | ConvertFrom-Json
    }
    catch {
        throw "Interrupted deployment observation is not valid JSON."
    }
    if ($null -eq $observation -or $observation.ownerToken -notmatch '^[0-9a-f]{32}$') {
        throw "Interrupted deployment observation is missing its owner generation."
    }
    $expectedOwner = [string]$observation.ownerToken
    $newOwner = [Guid]::NewGuid().ToString('N')

    $remoteScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
CandidateRoot="__CANDIDATE_ROOT__"
LockDir="$RemoteRoot/.deploy-v030.lock"
OperationFence="$RemoteRoot/.deploy-v030.operation.lock"
ExpectedOwner="__EXPECTED_OWNER__"
NewOwner="__NEW_LOCK_TOKEN__"
RootUid="__ROOT_UID__"
command -v flock >/dev/null
test -f "$OperationFence"
test ! -L "$OperationFence"
flock -n -o "$OperationFence" bash -se <<'TM_LIFECYCLE_TAKEOVER'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
CandidateRoot="__CANDIDATE_ROOT__"
LockDir="$RemoteRoot/.deploy-v030.lock"
ExpectedOwner="__EXPECTED_OWNER__"
NewOwner="__NEW_LOCK_TOKEN__"
RootUid="__ROOT_UID__"
test -d "$LockDir"
test ! -L "$LockDir"
test "$(stat -c '%u:%a' "$LockDir")" = "$RootUid:700"
for file in run.json owner phase; do
  test -f "$LockDir/$file"
  test ! -L "$LockDir/$file"
  test "$(stat -c '%u:%a:%h' "$LockDir/$file")" = "$RootUid:600:1"
done
Phase="$(cat "$LockDir/phase")"
case "$Phase" in
  locked|candidate-ready) ;;
  mutation-intent|maintenance-entered|writers-stopped|snapshot-ready|prior-marker-archived|nginx-candidate-staged) ;;
  mutation-started|release-replay-complete|accepted|accepted-public-enabled|cutover-complete) ;;
  *) echo "Unknown interrupted deployment phase" >&2; exit 1 ;;
esac

LifecycleResidue="$(python3 - "$LockDir" "$RootUid" <<'PY'
import grp
import os
import stat
import sys

root, expectedUidRaw = sys.argv[1:]
expectedUid = int(expectedUidRaw)
allowedFiles = {
    'run.json', 'owner', 'phase', 'upload.sha256', 'candidate_digest.py',
    'candidate-tree.sha256', 'accepted', 'nginx-maintenance.conf.next',
    'nginx-candidate-public.conf', 'nginx-candidate-public.sha256',
    'nginx-api-gate.conf', 'nginx-release-replay.conf',
    'release-replay-server.js', 'release-replay-evidence.json',
    'release-replay-claim', 'release-replay.stdout.log',
    'release-replay.stderr.log', 'release-replay-probe.json',
    'release-replay-request.json', 'release-replay-request.headers',
    'release-replay-retry.body', 'release-replay-retry.headers'
}
allowedDirectories = {'migration-rehearsal', 'restore-v050'}
allowedLinks = {
    'nginx-maintenance.link': '/etc/nginx/sites-available/turingmarket-maintenance',
    'nginx-public.link': '/etc/nginx/sites-available/turingmarket',
    'nginx-resume-old.link': '/etc/nginx/sites-available/turingmarket',
    'nginx-finalize-new.link': '/etc/nginx/sites-available/turingmarket',
}
rehearsal = False
for entry in os.scandir(root):
    metadata = entry.stat(follow_symlinks=False)
    if entry.is_symlink():
        if entry.name not in allowedLinks or os.readlink(entry.path) != allowedLinks[entry.name]:
            raise SystemExit(f'Unknown lifecycle lock entry: {entry.name}')
        continue
    if metadata.st_uid != expectedUid:
        raise SystemExit(f'Unexpected lifecycle lock owner: {entry.name}')
    if entry.is_file(follow_symlinks=False):
        if entry.name not in allowedFiles and not entry.name.endswith('.next'):
            raise SystemExit(f'Unknown lifecycle lock entry: {entry.name}')
        if entry.name == 'nginx-release-replay.conf':
            expectedGid = grp.getgrnam('www-data').gr_gid
            if metadata.st_gid != expectedGid or stat.S_IMODE(metadata.st_mode) != 0o640 or metadata.st_nlink != 1:
                raise SystemExit(f'Unsafe lifecycle lock file: {entry.name}')
        elif stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1:
            raise SystemExit(f'Unsafe lifecycle lock file: {entry.name}')
        continue
    if entry.is_dir(follow_symlinks=False):
        if entry.name not in allowedDirectories or stat.S_IMODE(metadata.st_mode) != 0o700:
            raise SystemExit(f'Unknown lifecycle lock entry: {entry.name}')
        if entry.name == 'migration-rehearsal':
            rehearsal = True
            children = list(os.scandir(entry.path))
            if {child.name for child in children} != {'stdout.log', 'stderr.log'}:
                raise SystemExit('Unexpected migration-rehearsal journal entries')
            for child in children:
                childStatus = child.stat(follow_symlinks=False)
                if child.is_symlink() or not child.is_file(follow_symlinks=False):
                    raise SystemExit('Unsafe migration-rehearsal journal entry')
                if childStatus.st_uid != expectedUid or stat.S_IMODE(childStatus.st_mode) != 0o600 or childStatus.st_nlink != 1:
                    raise SystemExit('Unsafe migration-rehearsal journal metadata')
        continue
    raise SystemExit(f'Unknown lifecycle lock entry: {entry.name}')
print('migration-rehearsal' if rehearsal else 'clean')
PY
)"

if [ "$LifecycleResidue" = "migration-rehearsal" ]; then
  RunStamp="$(basename "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["releaseRoot"])' "$LockDir/run.json")")"
  RunStamp="${RunStamp##v050-campaign-business-spine-}"
  CandidatePathForUnit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["candidatePath"])' "$LockDir/run.json")"
  MigrationUnit="turingmarket-migration-gate-$RunStamp.service"
  UnitLoadState="$(systemctl show "$MigrationUnit" --property=LoadState --value 2>/dev/null || printf not-found)"
  if [ "$UnitLoadState" != "not-found" ]; then
    test "$(systemctl show "$MigrationUnit" --property=User --value)" = "turingmarket-gate"
    test "$(systemctl show "$MigrationUnit" --property=WorkingDirectory --value)" = "$CandidatePathForUnit/server"
    MigrationControlGroup="$(systemctl show "$MigrationUnit" --property=ControlGroup --value)"
    case "$MigrationControlGroup" in
      /system.slice/turingmarket-migration-gate-*.service) ;;
      *) echo "Unexpected migration rehearsal ControlGroup" >&2; exit 1 ;;
    esac
    systemctl kill --kill-who=all --signal=KILL "$MigrationUnit"
    systemctl stop "$MigrationUnit" >/dev/null 2>&1 || true
    if [ -f "/sys/fs/cgroup$MigrationControlGroup/cgroup.procs" ]; then
      for _attempt in $(seq 1 50); do
        [ ! -s "/sys/fs/cgroup$MigrationControlGroup/cgroup.procs" ] && break
        sleep 0.1
      done
      test ! -s "/sys/fs/cgroup$MigrationControlGroup/cgroup.procs"
    fi
    test "$(systemctl show "$MigrationUnit" --property=MainPID --value 2>/dev/null || printf 0)" = "0"
    systemctl reset-failed "$MigrationUnit" >/dev/null 2>&1 || true
  fi
  RehearsalQuarantine="$LockDir/migration-rehearsal.quarantine.$NewOwner"
  test ! -e "$RehearsalQuarantine"
  mv "$LockDir/migration-rehearsal" "$RehearsalQuarantine"
  for log in stdout.log stderr.log; do
    test -f "$RehearsalQuarantine/$log"
    test ! -L "$RehearsalQuarantine/$log"
    rm -f -- "$RehearsalQuarantine/$log"
  done
  rmdir "$RehearsalQuarantine"
  sync -f "$LockDir"
fi

for link in nginx-maintenance.link nginx-public.link nginx-resume-old.link nginx-finalize-new.link; do
  if [ -L "$LockDir/$link" ]; then rm -f -- "$LockDir/$link"; fi
done

Validation="$(python3 - \
  "$LockDir/run.json" \
  "$ExpectedOwner" \
  "$RemoteRoot" \
  "$CandidateRoot" \
  "$Phase" \
  "$RootUid" <<'PY'
import json
import os
import re
import sys

runPath, expectedOwner, remoteRoot, candidateRoot, phase, rootUidRaw = sys.argv[1:]
rootUid = int(rootUidRaw)
with open(runPath, encoding='utf-8') as handle:
    metadata = json.load(handle)
required = {
    'schemaVersion', 'operation', 'runId', 'ownerToken', 'backupPath', 'releaseRoot',
    'candidatePath', 'sourceIdentity', 'sourceSha256', 'createdAt', 'backupReady',
    'backupManifestSha256', 'recoveryGeneration', 'quarantinePath'
}
if set(metadata) != required:
    raise SystemExit('Interrupted deployment metadata fields differ from schema')
if metadata['schemaVersion'] != 1 or metadata['operation'] != 'deploy':
    raise SystemExit('Interrupted lifecycle is not a deployment')
if metadata['ownerToken'] != expectedOwner:
    raise SystemExit('Deployment owner CAS rejected')
if not re.fullmatch(r'[0-9a-f]{32}', metadata['runId']) or not re.fullmatch(r'[0-9a-f]{32}', expectedOwner):
    raise SystemExit('Invalid interrupted deployment identity')
if not re.fullmatch(r'[0-9a-f]{64}', metadata['sourceSha256']) or not isinstance(metadata['sourceIdentity'], str) or not metadata['sourceIdentity']:
    raise SystemExit('Invalid deployment source identity')
if not re.fullmatch(r'backups/v050-campaign-business-spine-[0-9]{8}-[0-9]{6}', metadata['backupPath']):
    raise SystemExit('Invalid interrupted backup path')
backupAbsolute = os.path.abspath(os.path.join(remoteRoot, metadata['backupPath']))
if os.path.commonpath([os.path.abspath(remoteRoot), backupAbsolute]) != os.path.abspath(remoteRoot):
    raise SystemExit('Interrupted backup escaped the remote root')
releasePattern = re.compile(re.escape(os.path.abspath(candidateRoot)) + r'/v050-campaign-business-spine-[0-9]{8}-[0-9]{6}')
if not releasePattern.fullmatch(metadata['releaseRoot']) or metadata['candidatePath'] != metadata['releaseRoot'] + '/platform':
    raise SystemExit('Invalid interrupted candidate paths')
if os.path.dirname(metadata['releaseRoot']) != os.path.abspath(candidateRoot):
    raise SystemExit('Interrupted release escaped the candidate root')
if not isinstance(metadata['backupReady'], bool) or not isinstance(metadata['recoveryGeneration'], int) or metadata['recoveryGeneration'] < 0:
    raise SystemExit('Invalid interrupted deployment state')
quarantinePath = metadata['quarantinePath']
if quarantinePath is not None:
    quarantinePattern = re.compile(re.escape(os.path.abspath(candidateRoot)) + r'/\.quarantine-[0-9a-f]{32}-[1-9][0-9]*')
    if not isinstance(quarantinePath, str) or not quarantinePattern.fullmatch(quarantinePath):
        raise SystemExit('Invalid interrupted candidate quarantine path')
    quarantineStatus = os.lstat(quarantinePath)
    if not os.path.isdir(quarantinePath) or os.path.islink(quarantinePath) or quarantineStatus.st_uid != rootUid:
        raise SystemExit('Unsafe interrupted candidate quarantine')
if phase not in {'locked', 'candidate-ready'} and not metadata['backupReady']:
    raise SystemExit('Recovery phase requires a completed backup')
if metadata['backupReady']:
    if not re.fullmatch(r'[0-9a-f]{64}', metadata['backupManifestSha256'] or ''):
        raise SystemExit('Invalid backup manifest identity')
    status = os.lstat(backupAbsolute)
    if not os.path.isdir(backupAbsolute) or os.path.islink(backupAbsolute) or status.st_uid != rootUid:
        raise SystemExit('Unsafe interrupted backup root')
    manifest = os.path.join(backupAbsolute, 'SHA256SUMS')
    manifestStatus = os.lstat(manifest)
    if not os.path.isfile(manifest) or os.path.islink(manifest) or manifestStatus.st_uid != rootUid:
        raise SystemExit('Unsafe interrupted backup manifest')
else:
    if metadata['backupManifestSha256'] is not None:
        raise SystemExit('Incomplete backup cannot have a manifest identity')
print('\t'.join([
    metadata['runId'], metadata['backupPath'], metadata['releaseRoot'], metadata['candidatePath'],
    str(metadata['recoveryGeneration']), '1' if metadata['backupReady'] else '0',
    metadata['backupManifestSha256'] or '-', metadata['quarantinePath'] or '-', metadata['sourceSha256']
]))
PY
)"
IFS=$'\t' read -r RunId BackupPath ReleaseRoot CandidatePath RecoveryGeneration BackupReady ManifestSha ExistingQuarantine SourceSha <<< "$Validation"
BackupAbsolute="$RemoteRoot/$BackupPath"
if [ "$BackupReady" = "1" ]; then
  test "$(sha256sum "$BackupAbsolute/SHA256SUMS" | awk '{print $1}')" = "$ManifestSha"
  (cd "$BackupAbsolute" && sha256sum --check --status SHA256SUMS)
fi

NextGeneration=$((RecoveryGeneration + 1))
QuarantinePath=""
case "$Phase" in
  locked|candidate-ready|mutation-intent|maintenance-entered|writers-stopped|snapshot-ready|prior-marker-archived|nginx-candidate-staged)
    test ! -L "$CandidateRoot"
    if [ "$ExistingQuarantine" != "-" ]; then
      QuarantinePath="$ExistingQuarantine"
    else
      QuarantinePath="$CandidateRoot/.quarantine-$RunId-$NextGeneration"
      if [ -e "$ReleaseRoot" ]; then
        test ! -e "$QuarantinePath"
        test -d "$ReleaseRoot"
        test ! -L "$ReleaseRoot"
        test "$(realpath -e "$(dirname "$ReleaseRoot")")" = "$(realpath -e "$CandidateRoot")"
        mv "$ReleaseRoot" "$QuarantinePath"
        sync -f "$CandidateRoot"
      elif [ -d "$QuarantinePath" ] && [ ! -L "$QuarantinePath" ]; then
        : # Adopt a quarantine published before a prior recovery controller was killed.
      else
        QuarantinePath=""
      fi
    fi
    ;;
  mutation-started|release-replay-complete|accepted|accepted-public-enabled|cutover-complete)
    QuarantinePath=""
    ;;
esac

python3 - \
  "$LockDir/run.json" \
  "$ExpectedOwner" \
  "$NewOwner" \
  "$NextGeneration" \
  "$QuarantinePath" <<'PY'
import json
import os
import sys

target, expectedOwner, newOwner, generationRaw, quarantinePath = sys.argv[1:]
with open(target, encoding='utf-8') as handle:
    metadata = json.load(handle)
if metadata.get('ownerToken') != expectedOwner:
    raise SystemExit('Deployment owner CAS rejected')
metadata['ownerToken'] = newOwner
metadata['recoveryGeneration'] = int(generationRaw)
metadata['quarantinePath'] = quarantinePath or None
temporary = target + '.next.' + newOwner
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(metadata, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.replace(temporary, target)
directory = os.open(os.path.dirname(target), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
printf '%s\n' "$NewOwner" > "$LockDir/owner.next"
chown "$RootUid" "$LockDir/owner.next"
chmod 0600 "$LockDir/owner.next"
sync -f "$LockDir/owner.next"
mv -f "$LockDir/owner.next" "$LockDir/owner"
sync -f "$LockDir/owner"
sync -f "$LockDir"

# A replay gate from the old owner can no longer proxy after the CAS above.
ReplayStamp="${ReleaseRoot##*/}"
ReplayStamp="${ReplayStamp##v050-campaign-business-spine-}"
ReplayUnit="turingmarket-release-replay-gate-$ReplayStamp.service"
ReplayRuntime="/run/turingmarket-release-replay-$RunId"
ReplaySocket="$ReplayRuntime/replay.sock"
ReplayHelper="$RemoteRoot/platform/server/scripts/release_replay_gate.js"
ReplayNginx="$LockDir/nginx-release-replay.conf"
ReplayProbe="$LockDir/release-replay-probe.json"
ReplayRequestBody="$LockDir/release-replay-request.json"
ReplayRequestHeaders="$LockDir/release-replay-request.headers"
ReplayRetryBody="$LockDir/release-replay-retry.body"
ReplayRetryHeaders="$LockDir/release-replay-retry.headers"
ReplayLoadState="$(systemctl show "$ReplayUnit" --property=LoadState --value 2>/dev/null || printf not-found)"
if [ "$ReplayLoadState" != "not-found" ]; then
  test "$(systemctl show "$ReplayUnit" --property=User --value)" = "root"
  test "$(systemctl show "$ReplayUnit" --property=WorkingDirectory --value)" = "$RemoteRoot/platform/server"
  ReplayControlGroup="$(systemctl show "$ReplayUnit" --property=ControlGroup --value)"
  case "$ReplayControlGroup" in
    /system.slice/turingmarket-release-replay-gate-*.service) ;;
    *) echo "Unexpected release replay ControlGroup" >&2; exit 1 ;;
  esac
  systemctl stop "$ReplayUnit"
  if [ "$(systemctl show "$ReplayUnit" --property=MainPID --value 2>/dev/null || printf 0)" != "0" ]; then
    systemctl kill --kill-who=all --signal=KILL "$ReplayUnit"
  fi
  if [ -f "/sys/fs/cgroup$ReplayControlGroup/cgroup.procs" ]; then
    for _attempt in $(seq 1 50); do
      [ ! -s "/sys/fs/cgroup$ReplayControlGroup/cgroup.procs" ] && break
      sleep 0.1
    done
    test ! -s "/sys/fs/cgroup$ReplayControlGroup/cgroup.procs"
  fi
  test "$(systemctl show "$ReplayUnit" --property=MainPID --value 2>/dev/null || printf 0)" = "0"
  systemctl reset-failed "$ReplayUnit" >/dev/null 2>&1 || true
fi

ReplayLifecyclePresent=0
for artifact in "$ReplayRuntime" "$ReplayNginx" "$ReplayProbe" "$ReplayRequestBody" "$ReplayRequestHeaders" "$ReplayRetryBody" "$ReplayRetryHeaders"; do
  if [ -e "$artifact" ] || [ -L "$artifact" ]; then ReplayLifecyclePresent=1; fi
done
if [ "$ReplayLifecyclePresent" = "1" ]; then
  case "$Phase" in
    mutation-started|release-replay-complete) ;;
    *) echo "Release replay state exists outside its monotonic phase" >&2; exit 1 ;;
  esac
  ApiGateConfig="$LockDir/nginx-api-gate.conf"
  MaintenanceConfig="/etc/nginx/sites-available/turingmarket-maintenance"
  test -f "$ApiGateConfig"
  test ! -L "$ApiGateConfig"
  test "$(stat -c '%u:%g:%a:%h' "$ApiGateConfig")" = "$RootUid:$RootUid:600:1"
  install -o root -g root -m 0644 "$ApiGateConfig" "$MaintenanceConfig"
  nginx -t
  systemctl reload nginx
  test "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost/api/health)" = "503"
fi

if [ -e "$ReplayProbe" ] || [ -L "$ReplayProbe" ]; then
  test -f "$ReplayProbe"
  test ! -L "$ReplayProbe"
  test "$(stat -c '%u:%g:%a:%h' "$ReplayProbe")" = "$RootUid:$RootUid:600:1"
  cd "$RemoteRoot/platform/server"
  TM_REPLAY_RECOVERY_DB="/var/lib/turingmarket/db/turingmarket.db" \
  TM_REPLAY_RECOVERY_PROBE="$ReplayProbe" \
  TM_REPLAY_RECOVERY_RUN_ID="$RunId" \
  node <<'NODE'
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const probe = JSON.parse(fs.readFileSync(process.env.TM_REPLAY_RECOVERY_PROBE, 'utf8'));
if (!probe || probe.schemaVersion !== 1 || probe.runId !== process.env.TM_REPLAY_RECOVERY_RUN_ID ||
    !Number.isSafeInteger(probe.userId)) {
  throw new Error('Interrupted production replay probe is invalid');
}
if (Object.prototype.hasOwnProperty.call(probe, 'sessionToken')) {
  const digest = crypto.createHash('sha256').update(String(probe.sessionToken)).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(probe.sessionTokenSha256 || '') || digest !== probe.sessionTokenSha256) {
    throw new Error('Interrupted production replay session identity is invalid');
  }
  const database = new Database(process.env.TM_REPLAY_RECOVERY_DB, { fileMustExist: true });
  try {
    const removed = database.prepare('DELETE FROM sessions WHERE user_id=? AND token=?')
      .run(probe.userId, probe.sessionToken);
    if (removed.changes > 1) throw new Error('Interrupted production replay session cardinality is invalid');
  } finally {
    database.close();
  }
} else if (probe.state !== 'verified-session-removed') {
  throw new Error('Interrupted production replay lacks removable session evidence');
}
NODE
fi

if [ -e "$ReplayRuntime" ] || [ -L "$ReplayRuntime" ]; then
  test -d "$ReplayRuntime"
  test ! -L "$ReplayRuntime"
  ReplayWwwGid="$(getent group www-data | cut -d: -f3)"
  case "$ReplayWwwGid" in
    ''|*[!0-9]*) echo "Invalid www-data group identity" >&2; exit 1 ;;
  esac
  test "$(stat -c '%u:%g:%a' "$ReplayRuntime")" = "$RootUid:$ReplayWwwGid:710"
  test -f "$ReplayHelper"
  test ! -L "$ReplayHelper"
  test "$(stat -c '%u:%g:%h' "$ReplayHelper")" = "$RootUid:$RootUid:1"

  ReplayExpectedHeader="$ReplayRuntime/expected-header"
  if [ -e "$ReplayExpectedHeader" ] || [ -L "$ReplayExpectedHeader" ]; then
    test -f "$ReplayExpectedHeader"
    test ! -L "$ReplayExpectedHeader"
    test "$(stat -c '%u:%g:%a:%h' "$ReplayExpectedHeader")" = "$RootUid:$RootUid:600:1"
    ReplayHeaderSha="$(sha256sum "$ReplayExpectedHeader" | awk '{print $1}')"
  else
    ReplayHeaderSha="$(printf '%064d' 0)"
  fi
  NodeBin="$(command -v node)"
  test -x "$NodeBin"
  env -i \
    TM_REPLAY_MODE=cleanup \
    TM_REPLAY_ROOT="$ReplayRuntime" \
    TM_REPLAY_METHOD=POST \
    TM_REPLAY_PATH=/api/workflow/templates \
    TM_REPLAY_HEADER_NAME=x-tm-replay-claim \
    TM_REPLAY_HEADER_SHA256="$ReplayHeaderSha" \
    TM_REPLAY_SOURCE_SHA256="$SourceSha" \
    TM_REPLAY_RUN_ID="$RunId" \
    TM_REPLAY_CANDIDATE_PORT=3002 \
    TM_REPLAY_WWW_DATA_GID="$ReplayWwwGid" \
    TM_REPLAY_MAX_BODY_BYTES=65536 \
    TM_REPLAY_MAX_HEADER_BYTES=4096 \
    TM_REPLAY_MAX_RESPONSE_BYTES=1048576 \
    TM_REPLAY_TIMEOUT_MS=10000 \
    TM_REPLAY_NGINX_BYPASS_PATH="$ReplayNginx" \
    "$NodeBin" "$ReplayHelper" >/dev/null

  python3 - "$ReplayRuntime" "$RootUid" <<'PY'
import os
import stat
import sys

root, uid_raw = sys.argv[1:]
uid = int(uid_raw)
allowed = {'probe.claimed', 'probe.result'}
for entry in os.scandir(root):
    if entry.name not in allowed or entry.is_symlink() or not entry.is_file(follow_symlinks=False):
        raise SystemExit(f'Unexpected release replay cleanup residue: {entry.name}')
    status = entry.stat(follow_symlinks=False)
    if status.st_uid != uid or status.st_gid != uid or stat.S_IMODE(status.st_mode) != 0o600 or status.st_nlink != 1:
        raise SystemExit(f'Unsafe release replay cleanup residue: {entry.name}')
    os.unlink(entry.path)
descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  rmdir "$ReplayRuntime"
  sync -f /run
  test ! -e "$ReplayRuntime"
  test ! -e "$ReplaySocket"
fi
if [ -e "$ReplayNginx" ] || [ -L "$ReplayNginx" ]; then
  test -f "$ReplayNginx"
  test ! -L "$ReplayNginx"
  test "$(stat -c '%u:%g:%a:%h' "$ReplayNginx")" = "$RootUid:$(getent group www-data | cut -d: -f3):640:1"
  rm -f -- "$ReplayNginx"
  sync -f "$LockDir"
fi
for artifact in "$ReplayProbe" "$ReplayRequestBody" "$ReplayRequestHeaders" "$ReplayRetryBody" "$ReplayRetryHeaders"; do
  if [ -e "$artifact" ] || [ -L "$artifact" ]; then
    test -f "$artifact"
    test ! -L "$artifact"
    test "$(stat -c '%u:%g:%a:%h' "$artifact")" = "$RootUid:$RootUid:600:1"
    rm -f -- "$artifact"
  fi
done
sync -f "$LockDir"
printf '%s\n' 'INTERRUPTED_DEPLOYMENT_TAKEOVER_OK'
TM_LIFECYCLE_TAKEOVER
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__CANDIDATE_ROOT__', $CANDIDATE_ROOT)
    $remoteScript = $remoteScript.Replace('__EXPECTED_OWNER__', $expectedOwner)
    $remoteScript = $remoteScript.Replace('__NEW_LOCK_TOKEN__', $newOwner)
    $remoteScript = $remoteScript.Replace('__ROOT_UID__', '0')
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Interrupted deployment takeover failed"
    $script:deploymentLockToken = $newOwner
}

function Get-RemoteDeploymentRunMetadata {
    $remoteScript = @'
set -euo pipefail
LockDir="__REMOTE_ROOT__/.deploy-v030.lock"
test -f "$LockDir/run.json"
test ! -L "$LockDir/run.json"
test "$(stat -c '%U:%G:%a:%h' "$LockDir/run.json")" = "root:root:600:1"
cat "$LockDir/run.json"
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $json = Invoke-RemoteBash -Script $remoteScript -FailureMessage "Unable to read deployment run metadata" -RequireDeploymentLock -CaptureOutput
    try {
        $metadata = $json | ConvertFrom-Json
    }
    catch {
        throw "Remote deployment run metadata is not valid JSON."
    }
    if ($null -eq $metadata -or $metadata.schemaVersion -ne 1 -or $metadata.operation -ne 'deploy') {
        throw "Remote deployment run metadata is invalid."
    }
    return $metadata
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
    $allowed = @(
        'locked',
        'candidate-ready',
        'mutation-intent',
        'maintenance-entered',
        'writers-stopped',
        'snapshot-ready',
        'prior-marker-archived',
        'nginx-candidate-staged',
        'mutation-started',
        'release-replay-complete',
        'accepted',
        'accepted-public-enabled',
        'cutover-complete'
    )
    if ($allowed -notcontains $phase) {
        throw "Remote deployment phase is missing or invalid."
    }
    return $phase
}

$requiredPublicAssets = @(
    "client/shared/build_info.js",
    "client/core/navigation.js",
    "client/core/accessibility.js",
    "client/core/shell.js",
    "client/styles/tokens.css",
    "client/styles/components.css",
    "client/styles/layout.css",
    "client/core/csp_compat.js",
    "client/features/ppt_preview_runtime.js"
)

function Invoke-RemoteBackup {
    param(
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][object]$DeploymentPlan
    )

    Assert-RollbackBackupPath -BackupPath $BackupPath
    Initialize-PinnedDeploymentTypes
    if ($DeploymentPlan -isnot [ImmutableDeploymentActionPlan]) {
        throw 'Remote backup requires the immutable deployment action plan.'
    }
    $platformManifestBuilder = New-Object Text.StringBuilder
    $rootManifestBuilder = New-Object Text.StringBuilder
    foreach ($record in $DeploymentPlan.Records) {
        if ($record.InventoryKind -ceq 'Platform' -and $record.IncludedInBackup) {
            $platformPath = $record.RemoteRelativePath.Substring('platform/'.Length)
            [void]$platformManifestBuilder.Append($platformPath).Append("`n")
            if ($record.RequiredPublicAsset -and -not $platformPath.StartsWith('client/', [StringComparison]::Ordinal)) {
                throw "Backup plan contains an invalid required public asset: $platformPath"
            }
        }
        elseif ($record.InventoryKind -ceq 'RootRelative' -and $record.IncludedInBackup) {
            [void]$rootManifestBuilder.Append($record.RemoteRelativePath).Append("`n")
        }
    }
    $platformManifest = $platformManifestBuilder.ToString()
    $rootManifest = $rootManifestBuilder.ToString()
    if ([string]::IsNullOrWhiteSpace($platformManifest) -or [string]::IsNullOrWhiteSpace($rootManifest)) {
        throw 'Remote backup manifests are incomplete for the immutable deployment action plan.'
    }

    $remoteScript = @'
set -euo pipefail
LiveDir="__REMOTE_DIR__"
RemoteRoot="__REMOTE_ROOT__"
BackupPath="__BACKUP_PATH__"
BackupAbsolute="$RemoteRoot/$BackupPath"
PptCacheDir="/var/lib/turingmarket/ppt-cache"
MarkerRoot="$RemoteRoot/deployment-evidence"
CurrentMarker="$MarkerRoot/current-accepted.json"
LastGoodMarker="$MarkerRoot/last-good.json"
umask 077
test -d "$LiveDir"
test ! -L "$LiveDir"
test ! -e "$BackupAbsolute"
test -d "$PptCacheDir"
test ! -L "$PptCacheDir"
test "$(stat -c '%U:%G:%a' "$PptCacheDir")" = "root:root:700"
if find "$PptCacheDir" -xdev ! -type d ! -type f -print -quit | grep -q .; then
  echo "PPT cache contains a non-regular entry" >&2
  exit 1
fi
while IFS= read -r -d '' directory; do
  test "$(stat -c '%U:%G:%a' "$directory")" = "root:root:700"
done < <(find "$PptCacheDir" -xdev -type d -print0)
while IFS= read -r -d '' artifact; do
  test "$(stat -c '%U:%G:%a:%h' "$artifact")" = "root:root:600:1"
done < <(find "$PptCacheDir" -xdev -type f -print0)
install -d -m 0700 "$BackupAbsolute/platform" "$BackupAbsolute/nginx" "$BackupAbsolute/database" "$BackupAbsolute/repository" "$BackupAbsolute/ppt-cache" "$BackupAbsolute/accepted-marker"
if [ -e "$CurrentMarker" ]; then
  test -f "$CurrentMarker"
  test ! -L "$CurrentMarker"
  test "$(stat -c '%U:%G:%a:%h' "$CurrentMarker")" = "root:root:600:1"
  install -o root -g root -m 0600 "$CurrentMarker" "$BackupAbsolute/accepted-marker/prior-current.json"
else
  : > "$BackupAbsolute/accepted-marker/prior-current.absent"
fi
if [ -e "$LastGoodMarker" ]; then
  test -f "$LastGoodMarker"
  test ! -L "$LastGoodMarker"
  test "$(stat -c '%U:%G:%a:%h' "$LastGoodMarker")" = "root:root:600:1"
  install -o root -g root -m 0600 "$LastGoodMarker" "$BackupAbsolute/accepted-marker/last-good.json"
fi
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
database.backup(destination).then(() => {
  database.close();
  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = backup.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') throw new Error(`Backup quick_check failed: ${quickCheck}`);
    const foreignKeys = backup.pragma('foreign_key_check');
    if (foreignKeys.length !== 0) throw new Error(`Backup foreign_key_check failed: ${foreignKeys.length}`);
  } finally {
    backup.close();
  }
}).catch((error) => {
    if (database.open) {
    database.close();
    }
  console.error(error.message);
  process.exitCode = 1;
});
NODE
test ! -e "$BackupAbsolute/database/turingmarket.db-journal"
test ! -e "$BackupAbsolute/database/turingmarket.db-wal"
test ! -e "$BackupAbsolute/database/turingmarket.db-shm"
chown root:root "$BackupAbsolute/database/turingmarket.db"
chmod 0600 "$BackupAbsolute/database/turingmarket.db"
cp -a -- "$PptCacheDir/." "$BackupAbsolute/ppt-cache/"
cd "$BackupAbsolute"
sha256sum database/turingmarket.db > database.sha256
sha256sum --check --status database.sha256
find "$BackupAbsolute/ppt-cache" -xdev -type f -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' artifact; do
  relative="${artifact#"$BackupAbsolute/"}"
  sha256sum "$relative"
done > ppt-cache.sha256
if [ -s ppt-cache.sha256 ]; then
  sha256sum --check --status ppt-cache.sha256
fi
find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum --check --status SHA256SUMS
ManifestSha="$(sha256sum SHA256SUMS | awk '{print $1}')"
python3 - "$RemoteRoot/.deploy-v030.lock/run.json" "__LOCK_TOKEN__" "$ManifestSha" <<'PY'
import json
import os
import sys

target, expectedOwner, manifestSha = sys.argv[1:]
with open(target, encoding='utf-8') as handle:
    metadata = json.load(handle)
if metadata.get('ownerToken') != expectedOwner or metadata.get('backupReady') is not False:
    raise SystemExit('Deployment metadata changed before backup commit')
metadata['backupReady'] = True
metadata['backupManifestSha256'] = manifestSha
temporary = target + '.backup-ready.next'
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(metadata, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.replace(temporary, target)
directory = os.open(os.path.dirname(target), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__BACKUP_PATH__', $BackupPath)
    $remoteScript = $remoteScript.Replace('__LOCK_TOKEN__', $deploymentLockToken)
    $remoteScript = $remoteScript.Replace('__PLATFORM_MANIFEST__', $platformManifest.TrimEnd())
    $remoteScript = $remoteScript.Replace('__ROOT_MANIFEST__', $rootManifest.TrimEnd())

    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Remote backup failed" -RequireDeploymentLock
}

function Invoke-RemoteRestore {
    param(
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [switch]$RestoreDatabase
    )

    Assert-RollbackBackupPath -BackupPath $BackupPath
    if (-not $RestoreDatabase) {
        throw "Phase 4 rollback cannot restore code without its database and PPT cache."
    }
    $remoteScript = @'
set -euo pipefail
LiveDir="__REMOTE_DIR__"
RemoteRoot="__REMOTE_ROOT__"
BackupPath="__BACKUP_PATH__"
BackupAbsolute="$RemoteRoot/$BackupPath"
RestoreUnit="$BackupAbsolute/cutover-snapshot"
LockDir="$RemoteRoot/.deploy-v030.lock"
RestoreStateDir="$LockDir/restore-v050"
RestoreIdentity="$RestoreStateDir/identity"
RestoreStep="$RestoreStateDir/step"
DatabaseDir="/var/lib/turingmarket/db"
DatabasePath="$DatabaseDir/turingmarket.db"
PptCacheDir="/var/lib/turingmarket/ppt-cache"
PptCacheParent="$(dirname "$PptCacheDir")"
DatabaseStage="$DatabaseDir/.turingmarket.db.restore.__RESTORE_TOKEN__"
PptCacheStage="$PptCacheParent/.ppt-cache.restore.__RESTORE_TOKEN__"
RestoreStateStage="$LockDir/.restore-v050.__RESTORE_TOKEN__"
MarkerRoot="$RemoteRoot/deployment-evidence"
CurrentMarker="$MarkerRoot/current-accepted.json"
umask 077
test -f "$BackupAbsolute/SHA256SUMS"
test -d "$RestoreUnit"
test ! -L "$RestoreUnit"
test "$(realpath -e "$RestoreUnit")" = "$(realpath -e "$BackupAbsolute")/cutover-snapshot"
test "$(stat -c '%U:%G:%a' "$RestoreUnit")" = "root:root:700"
test -d "$RestoreUnit/database"
test ! -L "$RestoreUnit/database"
test "$(stat -c '%U:%G:%a' "$RestoreUnit/database")" = "root:root:700"
test -d "$RestoreUnit/ppt-cache"
test ! -L "$RestoreUnit/ppt-cache"
test "$(stat -c '%U:%G:%a' "$RestoreUnit/ppt-cache")" = "root:root:700"
for artifact in \
  "$RestoreUnit/SHA256SUMS" \
  "$RestoreUnit/database.sha256" \
  "$RestoreUnit/security-overlay.json" \
  "$RestoreUnit/security-overlay.sha256" \
  "$RestoreUnit/ppt-ledger.json" \
  "$RestoreUnit/ppt-ledger.sha256" \
  "$RestoreUnit/verify-ppt-ledger.js" \
  "$RestoreUnit/ppt-cache.sha256" \
  "$RestoreUnit/database/turingmarket.db"; do
  test -f "$artifact"
  test ! -L "$artifact"
  test "$(stat -c '%U:%G:%a:%h' "$artifact")" = "root:root:600:1"
done
test -d "$DatabaseDir"
test ! -L "$DatabaseDir"
test -d "$PptCacheDir"
test ! -L "$PptCacheDir"
test "$DatabasePath" = "/var/lib/turingmarket/db/turingmarket.db"
test "$PptCacheDir" = "/var/lib/turingmarket/ppt-cache"
cd "$BackupAbsolute"
sha256sum --check --status SHA256SUMS
cd "$RestoreUnit"
sha256sum --check --status SHA256SUMS
sha256sum --check --status database.sha256
sha256sum --check --status security-overlay.sha256
sha256sum --check --status ppt-ledger.sha256
if [ -s ppt-cache.sha256 ]; then
  sha256sum --check --status ppt-cache.sha256
fi

ExpectedRestoreIdentity="$(
  printf '%s\n%s\n' \
    "$BackupPath" \
    "$(sha256sum "$RestoreUnit/SHA256SUMS" | awk '{print $1}')" |
    sha256sum | awk '{print $1}'
)"
test "${#ExpectedRestoreIdentity}" = "64"
if [ ! -e "$RestoreStateDir" ]; then
  test ! -e "$RestoreStateStage"
  install -d -o root -g root -m 0700 "$RestoreStateStage"
  printf '%s\n' "$ExpectedRestoreIdentity" > "$RestoreStateStage/identity"
  printf '%s\n' 'initialized' > "$RestoreStateStage/step"
  chmod 0600 "$RestoreStateStage/identity" "$RestoreStateStage/step"
  sync -f "$RestoreStateStage/identity"
  sync -f "$RestoreStateStage/step"
  sync -f "$RestoreStateStage"
  mv "$RestoreStateStage" "$RestoreStateDir"
  sync -f "$RestoreStateDir"
  sync -f "$LockDir"
fi
test -d "$RestoreStateDir"
test ! -L "$RestoreStateDir"
test "$(stat -c '%U:%G:%a' "$RestoreStateDir")" = "root:root:700"
for journal_file in "$RestoreIdentity" "$RestoreStep"; do
  test -f "$journal_file"
  test ! -L "$journal_file"
  test "$(stat -c '%U:%G:%a:%h' "$journal_file")" = "root:root:600:1"
done
test "$(cat "$RestoreIdentity")" = "$ExpectedRestoreIdentity"

record_restore_step() {
  local step="$1"
  local next="$RestoreStep.next.__RESTORE_TOKEN__"
  case "$step" in
    preflight-verified|service-stopped|code-restored|data-staged|database-restored|cache-restored|security-reapplied|sessions-invalidated|marker-restored|nginx-restored|process-restored|health-verified) ;;
    *) echo "Unknown restore journal step: $step" >&2; exit 1 ;;
  esac
  test ! -e "$next"
  printf '%s\n' "$step" > "$next"
  chmod 0600 "$next"
  sync -f "$next"
  mv -f "$next" "$RestoreStep"
  sync -f "$RestoreStep"
  sync -f "$RestoreStateDir"
  if [ "${TM_RESTORE_FAIL_AFTER_STEP:-}" = "$step" ]; then
    echo "Injected restore failure after $step" >&2
    exit 86
  fi
}

cleanup_restore_stages() {
  rm -f -- "$DatabaseStage"
  rm -rf -- "$PptCacheStage" "$RestoreStateStage"
}
trap cleanup_restore_stages EXIT
record_restore_step preflight-verified

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
record_restore_step service-stopped

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
sync
record_restore_step code-restored

# RESTORE_DATABASE_AND_PPT_CACHE
test ! -e "$DatabaseStage"
test ! -e "$PptCacheStage"
install -o root -g root -m 0600 "$RestoreUnit/database/turingmarket.db" "$DatabaseStage"
install -d -o root -g root -m 0700 "$PptCacheStage"
cp -a -- "$RestoreUnit/ppt-cache/." "$PptCacheStage/"
find "$PptCacheStage" -type d -exec chown root:root {} + -exec chmod 0700 {} +
find "$PptCacheStage" -type f -exec chown root:root {} + -exec chmod 0600 {} +

ExpectedDatabaseSha256="$(awk 'NR == 1 { print $1 }' "$RestoreUnit/database.sha256")"
test "${#ExpectedDatabaseSha256}" = "64"
printf '%s  %s\n' "$ExpectedDatabaseSha256" "$DatabaseStage" | sha256sum --check --status
cd "$LiveDir/server"
TM_RESTORE_DB="$DatabaseStage" node <<'NODE'
const Database = require('better-sqlite3');
const database = new Database(process.env.TM_RESTORE_DB, { readonly: true, fileMustExist: true });
try {
  const quickCheck = database.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`Restore staging quick_check failed: ${quickCheck}`);
  const foreignKeys = database.pragma('foreign_key_check');
  if (foreignKeys.length !== 0) throw new Error(`Restore staging foreign_key_check failed: ${foreignKeys.length}`);
} finally {
  database.close();
}
NODE
TM_CACHE_ROOT="$PptCacheStage" TM_CACHE_MANIFEST="$RestoreUnit/ppt-cache.sha256" node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(process.env.TM_CACHE_ROOT);
const manifest = fs.readFileSync(process.env.TM_CACHE_MANIFEST, 'utf8').trim();
const expected = new Set();
for (const line of manifest ? manifest.split('\n') : []) {
  const match = /^([0-9a-f]{64})  ppt-cache\/(.+)$/.exec(line);
  if (!match) throw new Error('Invalid PPT cache checksum manifest');
  const relative = match[2];
  const target = path.resolve(root, relative);
  if (path.relative(root, target).split(path.sep)[0] === '..') throw new Error('PPT cache manifest escaped its root');
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`Unsafe staged PPT artifact: ${relative}`);
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (actual !== match[1]) throw new Error(`PPT cache checksum mismatch: ${relative}`);
  expected.add(relative.split(path.sep).join('/'));
}
const actual = [];
function walk(directory, prefix = '') {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`Unsafe staged PPT cache directory: ${prefix || '.'}`);
  }
  for (const name of fs.readdirSync(directory).sort()) {
    const target = path.join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const entry = fs.lstatSync(target);
    if (entry.isDirectory() && !entry.isSymbolicLink()) walk(target, relative);
    else if (entry.isFile() && !entry.isSymbolicLink()) actual.push(relative);
    else throw new Error(`Unsupported staged PPT cache entry: ${relative}`);
  }
}
walk(root);
if (actual.length !== expected.size || actual.some((entry) => !expected.has(entry))) {
  throw new Error('PPT cache manifest does not cover the staged tree');
}
NODE
PptLedgerVerification="$(
  NODE_PATH="$LiveDir/server/node_modules" \
  TM_PPT_LEDGER_MODE=verify \
  TM_PPT_LEDGER_DB="$DatabaseStage" \
  TM_PPT_CACHE_ROOT="$PptCacheStage" \
  TM_PPT_LEDGER_PATH="$RestoreUnit/ppt-ledger.json" \
  node "$RestoreUnit/verify-ppt-ledger.js"
)"
test "$PptLedgerVerification" = "PPT_LEDGER_VERIFY_OK"
printf '%s\n' 'PPT_LEDGER_VERIFY_OK'

sync -f "$DatabaseStage"
sync -f "$PptCacheStage"
record_restore_step data-staged
rm -f -- "$DatabasePath-journal" "$DatabasePath-wal" "$DatabasePath-shm"
mv -f "$DatabaseStage" "$DatabasePath"
sync -f "$DatabasePath"
sync -f "$DatabaseDir"
record_restore_step database-restored
python3 - "$PptCacheDir" "$PptCacheStage" <<'PY'
import ctypes
import os
import sys

live, staged = sys.argv[1:3]
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
if renameat2(-100, os.fsencode(live), -100, os.fsencode(staged), 2) != 0:
    raise OSError(ctypes.get_errno(), 'atomic PPT cache exchange failed')
PY
sync -f "$DatabasePath"
sync -f "$DatabaseDir"
sync -f "$PptCacheDir"
sync -f "$PptCacheParent"
record_restore_step cache-restored
rm -f -- "$DatabasePath-journal" "$DatabasePath-wal" "$DatabasePath-shm"

# REAPPLY_CUTOVER_SECURITY
TM_RESTORE_DB="$DatabasePath" \
TM_SECURITY_OVERLAY="$RestoreUnit/security-overlay.json" \
node <<'TM_APPLY_SECURITY_OVERLAY'
const fs = require('node:fs');
const Database = require('better-sqlite3');

const overlay = JSON.parse(fs.readFileSync(process.env.TM_SECURITY_OVERLAY, 'utf8'));
if (
  !overlay ||
  overlay.schemaVersion !== 1 ||
  !Array.isArray(overlay.match) ||
  overlay.match.length !== 2 ||
  overlay.match[0] !== 'id' ||
  overlay.match[1] !== 'username' ||
  !Array.isArray(overlay.users)
) {
  throw new Error('Unsupported security overlay schema');
}

const expectedIds = new Set();
const expectedUsernames = new Set();
for (const user of overlay.users) {
  const valid =
    user &&
    Number.isSafeInteger(user.id) && user.id > 0 &&
    typeof user.username === 'string' && user.username.length > 0 &&
    typeof user.password_hash === 'string' && user.password_hash.length > 0 &&
    (user.is_active === 0 || user.is_active === 1) &&
    typeof user.role === 'string' && user.role.length > 0 &&
    (user.department === null || typeof user.department === 'string') &&
    Number.isSafeInteger(user.api_quota) && user.api_quota >= 0;
  if (!valid) throw new Error('Invalid security overlay user');
  if (expectedIds.has(user.id) || expectedUsernames.has(user.username)) {
    throw new Error('Duplicate security overlay identity');
  }
  expectedIds.add(user.id);
  expectedUsernames.add(user.username);
}

const database = new Database(process.env.TM_RESTORE_DB, { fileMustExist: true });
try {
  const readUser = database.prepare(`
    SELECT id,username,password_hash,is_active,role,department,api_quota
    FROM users
    WHERE id = ? AND username = ?
  `);
  const updateUser = database.prepare(`
    UPDATE users
    SET password_hash = ?, is_active = ?, role = ?, department = ?, api_quota = ?
    WHERE id = ? AND username = ?
  `);
  const disableUser = database.prepare(`
    UPDATE users
    SET is_active = 0, role = 'user', department = 'rollback-disabled', api_quota = 0
    WHERE id = ? AND username = ?
  `);
  let applied = 0;
  let disabled = 0;
  database.transaction(() => {
    const restoredUsers = database.prepare('SELECT id,username FROM users ORDER BY id').all();
    for (const expected of overlay.users) {
      if (!readUser.get(expected.id, expected.username)) {
        throw new Error(`Security overlay identity mismatch: ${expected.id}`);
      }
      const result = updateUser.run(
        expected.password_hash,
        expected.is_active,
        expected.role,
        expected.department,
        expected.api_quota,
        expected.id,
        expected.username
      );
      if (result.changes !== 1) throw new Error(`Security overlay update failed: ${expected.id}`);
      applied += 1;
    }
    for (const restored of restoredUsers) {
      if (expectedIds.has(restored.id)) continue;
      const result = disableUser.run(restored.id, restored.username);
      if (result.changes !== 1) throw new Error(`Security overlay disable failed: ${restored.id}`);
      disabled += 1;
    }
    for (const expected of overlay.users) {
      const actual = readUser.get(expected.id, expected.username);
      for (const field of ['password_hash', 'is_active', 'role', 'department', 'api_quota']) {
        if (actual[field] !== expected[field]) {
          throw new Error(`Security overlay verification failed: ${expected.id}:${field}`);
        }
      }
    }
    const unsafe = database.prepare(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE id NOT IN (${overlay.users.length ? overlay.users.map(() => '?').join(',') : 'NULL'})
        AND (is_active != 0 OR role != 'user' OR department != 'rollback-disabled' OR api_quota != 0)
    `).get(...overlay.users.map((user) => user.id)).count;
    if (unsafe !== 0) throw new Error('Security overlay left unmatched users privileged');
  })();
  const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)');
  if (checkpoint.some((row) => Number(row.busy) !== 0)) throw new Error('Security overlay WAL checkpoint remained busy');
  const quickCheck = database.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`Security overlay quick_check failed: ${quickCheck}`);
  if (database.pragma('foreign_key_check').length !== 0) throw new Error('Security overlay foreign_key_check failed');
  console.log(`SECURITY_OVERLAY_APPLIED=${applied}`);
  console.log(`SECURITY_OVERLAY_DISABLED=${disabled}`);
} finally {
  database.close();
}
TM_APPLY_SECURITY_OVERLAY
sync -f "$DatabasePath"
sync -f "$DatabaseDir"
test ! -s "$DatabasePath-wal"
record_restore_step security-reapplied

# INVALIDATE_SESSIONS
TM_RESTORE_DB="$DatabasePath" node <<'NODE'
const Database = require('better-sqlite3');
const database = new Database(process.env.TM_RESTORE_DB);
try {
  const removed = database.transaction(() => database.prepare('DELETE FROM sessions').run())();
  const remaining = database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
  if (remaining !== 0) throw new Error('Session invalidation verification failed');
  const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)');
  if (checkpoint.some((row) => Number(row.busy) !== 0)) throw new Error('Session invalidation WAL checkpoint remained busy');
  const quickCheck = database.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`Restored database quick_check failed: ${quickCheck}`);
  const foreignKeys = database.pragma('foreign_key_check');
  if (foreignKeys.length !== 0) throw new Error(`Restored database foreign_key_check failed: ${foreignKeys.length}`);
  console.log(`SESSIONS_INVALIDATED=${removed.changes}`);
  console.log('SESSIONS_REMAINING=0');
} finally {
  database.close();
}
NODE
test ! -e "$DatabasePath-journal"
test ! -e "$DatabasePath-wal"
test ! -e "$DatabasePath-shm"
rm -rf -- "$PptCacheStage"
sync -f "$DatabasePath"
sync -f "$DatabaseDir"
sync -f "$PptCacheParent"
record_restore_step sessions-invalidated

# RESTORE_AUTHORITATIVE_MARKER
install -d -o root -g root -m 0700 "$MarkerRoot"
python3 - \
  "$BackupAbsolute/accepted-marker" \
  "$CurrentMarker" <<'PY'
import os
import shutil
import sys

archive, current = sys.argv[1:]
prior = os.path.join(archive, 'prior-current.json')
absent = os.path.join(archive, 'prior-current.absent')
if os.path.isfile(prior) == os.path.isfile(absent):
    raise SystemExit('Backup accepted-marker state is ambiguous')
if os.path.isfile(prior):
    temporary = current + '.restore.next'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with open(prior, 'rb') as source:
            shutil.copyfileobj(source, os.fdopen(os.dup(descriptor), 'wb', closefd=True))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, current)
elif os.path.lexists(current):
    if os.path.islink(current) or not os.path.isfile(current):
        raise SystemExit('Unsafe current marker during prior-absent restore')
    os.unlink(current)
directory = os.open(os.path.dirname(current), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
if [ -e "$CurrentMarker" ]; then
  test "$(stat -c '%U:%G:%a:%h' "$CurrentMarker")" = "root:root:600:1"
fi
record_restore_step marker-restored

# RESTORE_NGINX
test -f "$BackupAbsolute/nginx/turingmarket.conf"
install -m 0644 "$BackupAbsolute/nginx/turingmarket.conf" /etc/nginx/sites-available/turingmarket
rm -f /etc/nginx/sites-enabled/turingmarket
ln -s /etc/nginx/sites-available/turingmarket /etc/nginx/sites-enabled/turingmarket
nginx -t
systemctl reload nginx
record_restore_step nginx-restored

# RESTORE_PROCESS
cd "$LiveDir"
export SERVER_HOST=127.0.0.1
pm2 restart ecosystem.config.js --only turingmarket --update-env || pm2 start ecosystem.config.js --only turingmarket --update-env
record_restore_step process-restored

# RESTORE_HEALTH
for attempt in $(seq 1 __MAINTENANCE_TIMEOUT_SECONDS__); do
  if curl -fsS http://localhost:3002/api/health >/dev/null; then
    record_restore_step health-verified
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
    $remoteScript = $remoteScript.Replace('__RESTORE_TOKEN__', ([Guid]::NewGuid().ToString('N')))
    $remoteScript = $remoteScript.Replace('__MAINTENANCE_TIMEOUT_SECONDS__', $MaintenanceTimeoutSeconds.ToString())

    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Remote rollback failed" -RequireDeploymentLock -RequireWriterLock
}

function Invoke-RemotePreMutationResume {
    param([Parameter(Mandatory = $true)][string]$BackupPath)

    Assert-RollbackBackupPath -BackupPath $BackupPath
    $remoteScript = @'
set -euo pipefail
LiveDir="__REMOTE_DIR__"
RemoteRoot="__REMOTE_ROOT__"
BackupAbsolute="$RemoteRoot/__BACKUP_PATH__"
LockDir="$RemoteRoot/.deploy-v030.lock"
MaintenanceConfig="/etc/nginx/sites-available/turingmarket-maintenance"
MarkerRoot="$RemoteRoot/deployment-evidence"
CurrentMarker="$MarkerRoot/current-accepted.json"
Phase="$(cat "$LockDir/phase")"
case "$Phase" in
  mutation-intent|maintenance-entered|writers-stopped|snapshot-ready|prior-marker-archived|nginx-candidate-staged) ;;
  *) echo "Pre-mutation resume rejected phase: $Phase" >&2; exit 1 ;;
esac
test ! -e "$LockDir/accepted"
test -f "$BackupAbsolute/SHA256SUMS"
test -f "$BackupAbsolute/nginx/turingmarket.conf"
cd "$BackupAbsolute"
sha256sum --check --status SHA256SUMS

# Keep public maintenance in place until the previous process is healthy.
cd "$LiveDir"
export SERVER_HOST=127.0.0.1
pm2 restart ecosystem.config.js --only turingmarket --update-env || pm2 start ecosystem.config.js --only turingmarket --update-env
for attempt in $(seq 1 __MAINTENANCE_TIMEOUT_SECONDS__); do
  if curl -fsS http://localhost:3002/api/health >/dev/null; then break; fi
  if [ "$attempt" = "__MAINTENANCE_TIMEOUT_SECONDS__" ]; then
    echo "Previous release did not recover on loopback" >&2
    exit 1
  fi
  sleep 1
done

install -d -o root -g root -m 0700 "$MarkerRoot"
python3 - "$BackupAbsolute/accepted-marker" "$CurrentMarker" <<'PY'
import os
import sys

archive, current = sys.argv[1:]
prior = os.path.join(archive, 'prior-current.json')
absent = os.path.join(archive, 'prior-current.absent')
if os.path.isfile(prior) == os.path.isfile(absent):
    raise SystemExit('Backup accepted-marker state is ambiguous')
if os.path.isfile(prior):
    temporary = current + '.resume.next'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with open(prior, 'rb') as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                os.write(descriptor, chunk)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, current)
elif os.path.lexists(current):
    if os.path.islink(current) or not os.path.isfile(current):
        raise SystemExit('Unsafe current marker during pre-mutation resume')
    os.unlink(current)
directory = os.open(os.path.dirname(current), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
if [ -e "$CurrentMarker" ]; then
  test "$(stat -c '%U:%G:%a:%h' "$CurrentMarker")" = "root:root:600:1"
fi
install -m 0644 "$BackupAbsolute/nginx/turingmarket.conf" /etc/nginx/sites-available/turingmarket
ln -s /etc/nginx/sites-available/turingmarket "$LockDir/nginx-resume-old.link"
mv -Tf "$LockDir/nginx-resume-old.link" /etc/nginx/sites-enabled/turingmarket
nginx -t
systemctl reload nginx
for attempt in $(seq 1 __MAINTENANCE_TIMEOUT_SECONDS__); do
  if curl -fsS http://localhost/api/health >/dev/null; then break; fi
  if [ "$attempt" = "__MAINTENANCE_TIMEOUT_SECONDS__" ]; then
    echo "Previous release did not recover through Nginx" >&2
    exit 1
  fi
  sleep 1
done
rm -f -- "$MaintenanceConfig"
printf '%s\n' 'PRE_MUTATION_RESUME_OK'
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__BACKUP_PATH__', $BackupPath)
    $remoteScript = $remoteScript.Replace('__MAINTENANCE_TIMEOUT_SECONDS__', $MaintenanceTimeoutSeconds.ToString())
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Pre-mutation production resume failed" -RequireDeploymentLock -RequireWriterLock
}

function Get-RemoteDeploymentAcceptanceState {
    $remoteScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
LockDir="$RemoteRoot/.deploy-v030.lock"
CurrentMarker="$RemoteRoot/deployment-evidence/current-accepted.json"
python3 - "$LockDir/run.json" "$LockDir/accepted" "$CurrentMarker" "$RemoteRoot" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

runPath, acceptedPath, currentPath, remoteRoot = sys.argv[1:]
with open(runPath, encoding='utf-8') as handle:
    run = json.load(handle)
backupPath = run.get('backupPath')
runId = run.get('runId')
if not isinstance(backupPath, str) or not re.fullmatch(r'backups/v050-campaign-business-spine-[0-9]{8}-[0-9]{6}', backupPath):
    raise SystemExit('Acceptance state rejected invalid backup path')
if not isinstance(runId, str) or not re.fullmatch(r'[0-9a-f]{32}', runId):
    raise SystemExit('Acceptance state rejected invalid run id')
backupAbsolute = os.path.abspath(os.path.join(remoteRoot, backupPath))
if os.path.dirname(backupAbsolute) != os.path.abspath(os.path.join(remoteRoot, 'backups')):
    raise SystemExit('Acceptance state backup escaped the backup root')
priorPath = os.path.join(backupAbsolute, 'accepted-marker', 'prior-current.json')
priorAbsent = os.path.join(backupAbsolute, 'accepted-marker', 'prior-current.absent')

def strictFile(path):
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(f'Acceptance state rejected non-regular file: {path}')
    if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1:
        raise SystemExit(f'Acceptance state rejected file metadata: {path}')
    return metadata

if os.path.lexists(currentPath):
    strictFile(currentPath)
    with open(currentPath, encoding='utf-8') as handle:
        marker = json.load(handle)
    required = {
        'schemaVersion', 'runId', 'backupPath', 'sourceIdentity', 'sourceSha256',
        'candidateSha256', 'nginxSha256', 'acceptedAt'
    }
    if set(marker) != required or marker.get('schemaVersion') != 1:
        raise SystemExit('Current accepted marker schema is invalid')
    if not run.get('backupReady'):
        if marker.get('runId') == runId:
            raise SystemExit('Unbacked lifecycle unexpectedly owns the current marker')
        print('current-marker-prior')
        raise SystemExit(0)
    if (marker.get('runId') == runId and marker.get('backupPath') == backupPath and
            marker.get('sourceIdentity') == run.get('sourceIdentity') and
            marker.get('sourceSha256') == run.get('sourceSha256')):
        strictFile(acceptedPath)
        with open(acceptedPath, encoding='utf-8') as handle:
            acceptedDigest = handle.read().strip()
        if not re.fullmatch(r'[0-9a-f]{64}', acceptedDigest) or marker.get('candidateSha256') != acceptedDigest:
            raise SystemExit('Current accepted marker candidate digest is invalid')
        if not re.fullmatch(r'[0-9a-f]{64}', str(marker.get('nginxSha256', ''))):
            raise SystemExit('Current accepted marker Nginx digest is invalid')
        print('current-marker-new')
        raise SystemExit(0)
    if os.path.isfile(priorPath):
        strictFile(priorPath)
        with open(currentPath, 'rb') as current, open(priorPath, 'rb') as prior:
            if hashlib.sha256(current.read()).digest() == hashlib.sha256(prior.read()).digest():
                print('current-marker-prior')
                raise SystemExit(0)
    raise SystemExit('Current accepted marker belongs to neither current nor prior generation')

if not run.get('backupReady'):
    print('current-marker-absent')
    raise SystemExit(0)
if os.path.isfile(priorPath) and os.path.isfile(priorAbsent):
    raise SystemExit('Backup accepted marker state is ambiguous')
if os.path.isfile(priorPath):
    strictFile(priorPath)
elif not os.path.isfile(priorAbsent):
    raise SystemExit('Backup accepted marker state is missing')
print('current-marker-absent')
PY
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $result = Invoke-RemoteBash -Script $remoteScript -FailureMessage "Authoritative accepted marker validation failed" -RequireDeploymentLock -RequireWriterLock -CaptureOutput
    return (($result | Select-Object -Last 1).Trim())
}

function Get-ExactPublicNginxBehaviorVerifier {
    return @'
// TM_EXACT_PUBLIC_NGINX_BEHAVIOR_V1_BEGIN
'use strict';

const http = require('node:http');

const socketPath = process.argv[2];
const port = Number.parseInt(process.argv[3], 10);
if (!socketPath || (socketPath === '-' && (!Number.isInteger(port) || port < 1 || port > 65535))) {
  throw new Error('Usage: verify-exact-public-nginx.js <socket-path|-> <port>');
}

const assets = [
  ['/client/shared/build_info.js', 'javascript'],
  ['/client/core/navigation.js', 'javascript'],
  ['/client/core/accessibility.js', 'javascript'],
  ['/client/core/shell.js', 'javascript'],
  ['/client/core/csp_compat.js', 'javascript'],
  ['/client/features/ppt_preview_runtime.js', 'javascript'],
  ['/client/styles/tokens.css', 'css'],
  ['/client/styles/components.css', 'css'],
  ['/client/styles/layout.css', 'css'],
];
const pages = ['/m0', '/m0-detail', '/m4', '/admin'];
const denied = [
  '/client/unknown.js',
  '/server/server.js',
  '/uploads/private',
  '/tmp/private',
  '/backups/private',
  '/node_modules/private',
  '/docs/private',
  '/nginx/private',
  '/.env',
  '/deploy_v8.ps1',
];

function requestRoute(requestPath) {
  return new Promise((resolve, reject) => {
    const target = socketPath === '-'
      ? { host: '127.0.0.1', port, path: requestPath }
      : { socketPath, path: requestPath };
    const request = http.request({
      ...target,
      method: 'GET',
      headers: { Host: 'localhost', Connection: 'close' },
      timeout: 5000,
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) {
          request.destroy(new Error(`${requestPath} response exceeded the verifier limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('timeout', () => request.destroy(new Error(`${requestPath} timed out`)));
    request.on('error', reject);
    request.end();
  });
}

function contentType(response) {
  return String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
}

function assertNginx(response, requestPath) {
  const server = String(response.headers.server || '');
  if (!/^nginx(?:\/|$)/i.test(server)) {
    throw new Error(`${requestPath} did not traverse the Nginx public boundary (Server: ${server || '<missing>'})`);
  }
}

function assertStatus(response, requestPath, expected) {
  assertNginx(response, requestPath);
  if (response.status !== expected) {
    throw new Error(`${requestPath} returned ${response.status}; expected ${expected}`);
  }
}

async function verify() {
  for (const [requestPath, type] of assets) {
    const response = await requestRoute(requestPath);
    assertStatus(response, requestPath, 200);
    const actualType = contentType(response);
    const accepted = type === 'javascript'
      ? new Set(['application/javascript', 'text/javascript'])
      : new Set(['text/css']);
    if (!accepted.has(actualType)) {
      throw new Error(`${requestPath} returned Content-Type '${actualType || '<missing>'}'; expected ${type === 'javascript' ? 'JavaScript' : 'CSS'}`);
    }
  }

  const health = await requestRoute('/api/health');
  assertStatus(health, '/api/health', 200);
  if (contentType(health) !== 'application/json') {
    throw new Error(`/api/health returned Content-Type '${contentType(health) || '<missing>'}'; expected JSON`);
  }
  let healthPayload;
  try {
    healthPayload = JSON.parse(health.body);
  } catch {
    throw new Error('/api/health did not return the proxied JSON health payload');
  }
  if (healthPayload.status !== 'ok') {
    throw new Error('/api/health did not return status ok from the application upstream');
  }

  for (const requestPath of pages) {
    const response = await requestRoute(requestPath);
    assertStatus(response, requestPath, 200);
    if (contentType(response) !== 'text/html') {
      throw new Error(`${requestPath} returned Content-Type '${contentType(response) || '<missing>'}'; expected HTML`);
    }
  }

  for (const requestPath of denied) {
    const response = await requestRoute(requestPath);
    assertStatus(response, requestPath, 404);
  }
}

verify().then(
  () => process.stdout.write('EXACT_PUBLIC_NGINX_BEHAVIOR_OK\n'),
  (error) => {
    process.stderr.write(`EXACT_PUBLIC_NGINX_BEHAVIOR_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
);
// TM_EXACT_PUBLIC_NGINX_BEHAVIOR_V1_END
'@
}

function Invoke-RemoteAcceptedFinalize {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

    $exactPublicNginxVerifier = Get-ExactPublicNginxBehaviorVerifier
    $remoteScript = @'
set -eEuo pipefail
LiveDir="__REMOTE_DIR__"
RemoteRoot="__REMOTE_ROOT__"
ReleaseRoot="__RELEASE_ROOT__"
LockDir="$RemoteRoot/.deploy-v030.lock"
AcceptedMarker="$LockDir/accepted"
MaintenanceConfig="/etc/nginx/sites-available/turingmarket-maintenance"
PublicNginxConfig="/etc/nginx/sites-available/turingmarket"
CurrentMarker="$RemoteRoot/deployment-evidence/current-accepted.json"
StagedPublicNginx="$LockDir/nginx-candidate-public.conf"
StagedPublicNginxSha="$LockDir/nginx-candidate-public.sha256"
ApiGateConfig="$LockDir/nginx-api-gate.conf"
run_exact_public_nginx_gate() {
  local socket_path="$1"
  local port="$2"
  node - "$socket_path" "$port" <<'TM_EXACT_PUBLIC_NGINX_VERIFIER'
__EXACT_PUBLIC_NGINX_VERIFIER__
TM_EXACT_PUBLIC_NGINX_VERIFIER
}
recover_accepted_finalize_public_failure() {
  local FinalizeStatus=$?
  local ClosedGateNext="$PublicNginxConfig.api-gate-$RunId.next"
  trap - ERR EXIT
  rm -f -- "$ClosedGateNext"
  install -o root -g root -m 0644 "$ApiGateConfig" "$ClosedGateNext"
  mv -Tf "$ClosedGateNext" "$PublicNginxConfig"
  nginx -t
  systemctl reload nginx
  exit "$FinalizeStatus"
}
case "$(cat "$LockDir/phase")" in
  mutation-started|release-replay-complete|accepted|accepted-public-enabled) ;;
  *) echo "Accepted finalization rejected lifecycle phase" >&2; exit 1 ;;
esac
RunId="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["runId"])' "$LockDir/run.json")"
AcceptedEvidence="$RemoteRoot/deployment-evidence/accepted-$RunId.json"
test -f "$AcceptedEvidence"
test ! -L "$AcceptedEvidence"
test "$(stat -c '%U:%G:%a:%h' "$AcceptedEvidence")" = "root:root:600:1"
test -f "$AcceptedMarker"
test ! -L "$AcceptedMarker"
test "$(stat -c '%U:%G:%a:%h' "$AcceptedMarker")" = "root:root:600:1"
ExpectedDigest="$(cat "$AcceptedMarker")"
test "${#ExpectedDigest}" = "64"
test -f "$CurrentMarker"
test ! -L "$CurrentMarker"
test "$(stat -c '%U:%G:%a:%h' "$CurrentMarker")" = "root:root:600:1"
test -f "$StagedPublicNginx"
test -f "$StagedPublicNginxSha"
test ! -L "$StagedPublicNginx"
test ! -L "$StagedPublicNginxSha"
test "$(sha256sum "$StagedPublicNginx" | awk '{print $1}')" = "$(awk 'NR == 1 {print $1}' "$StagedPublicNginxSha")"
python3 - "$CurrentMarker" "$RunId" "$ExpectedDigest" "$(awk 'NR == 1 {print $1}' "$StagedPublicNginxSha")" <<'PY'
import json
import sys
markerPath, runId, candidateSha256, nginxSha256 = sys.argv[1:]
with open(markerPath, encoding='utf-8') as handle:
    marker = json.load(handle)
if marker.get('runId') != runId or marker.get('candidateSha256') != candidateSha256 or marker.get('nginxSha256') != nginxSha256:
    raise SystemExit('Current accepted marker does not authorize finalization')
PY
test -f "$LockDir/candidate_digest.py"
test "$(python3 "$LockDir/candidate_digest.py" "$LiveDir")" = "$ExpectedDigest"
case "$ReleaseRoot" in
  /var/lib/turingmarket-gate/releases/v050-campaign-business-spine-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) echo "Accepted cleanup path is invalid" >&2; exit 1 ;;
esac

# A post-marker recovery must first close every public route, then roll forward.
test -f "$ApiGateConfig"
test ! -L "$ApiGateConfig"
install -o root -g root -m 0644 "$ApiGateConfig" "$MaintenanceConfig"
nginx -t
systemctl reload nginx
test "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost/api/health)" = "503"

cd "$LiveDir"
export SERVER_HOST=127.0.0.1
pm2 restart ecosystem.config.js --only turingmarket --update-env || pm2 start ecosystem.config.js --only turingmarket --update-env
for attempt in $(seq 1 __MAINTENANCE_TIMEOUT_SECONDS__); do
  if curl -fsS http://localhost:3002/api/health >/dev/null; then break; fi
  if [ "$attempt" = "__MAINTENANCE_TIMEOUT_SECONDS__" ]; then
    echo "Accepted release did not recover on loopback" >&2
    exit 1
  fi
  sleep 1
done

trap recover_accepted_finalize_public_failure ERR EXIT
install -m 0644 "$StagedPublicNginx" "$PublicNginxConfig"
ln -s "$PublicNginxConfig" "$LockDir/nginx-finalize-new.link"
mv -Tf "$LockDir/nginx-finalize-new.link" /etc/nginx/sites-enabled/turingmarket
nginx -t
systemctl reload nginx
run_exact_public_nginx_gate - 80
trap - ERR EXIT
rm -f -- "$MaintenanceConfig"
rm -rf -- "$ReleaseRoot"
printf '%s\n' 'ACCEPTED_RELEASE_FINALIZED'
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__RELEASE_ROOT__', $ReleaseRoot)
    $remoteScript = $remoteScript.Replace('__MAINTENANCE_TIMEOUT_SECONDS__', $MaintenanceTimeoutSeconds.ToString())
    $remoteScript = $remoteScript.Replace('__EXACT_PUBLIC_NGINX_VERIFIER__', $exactPublicNginxVerifier)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Accepted release finalization failed" -RequireDeploymentLock -RequireWriterLock
}

function Invoke-RemoteCandidateCleanup {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

    $remoteScript = @'
set -euo pipefail
ReleaseRoot="__RELEASE_ROOT__"
CandidateRoot="__CANDIDATE_ROOT__"
case "$ReleaseRoot" in
  "$CandidateRoot"/v050-campaign-business-spine-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  "$CandidateRoot"/.quarantine-*)
    python3 - "$(basename "$ReleaseRoot")" <<'PY'
import re
import sys
if not re.fullmatch(r'\.quarantine-[0-9a-f]{32}-[1-9][0-9]*', sys.argv[1]):
    raise SystemExit('Candidate quarantine path is invalid')
PY
    ;;
  *) echo "Candidate cleanup path is invalid" >&2; exit 1 ;;
esac
if [ -e "$ReleaseRoot" ]; then
  test -d "$ReleaseRoot"
  test ! -L "$ReleaseRoot"
  test "$(realpath -e "$(dirname "$ReleaseRoot")")" = "$CandidateRoot"
  test "$(realpath -e "$ReleaseRoot")" = "$CandidateRoot/$(basename "$ReleaseRoot")"
  rm -rf -- "$ReleaseRoot"
  sync -f "$CandidateRoot"
fi
'@
    $remoteScript = $remoteScript.Replace('__RELEASE_ROOT__', $ReleaseRoot)
    $remoteScript = $remoteScript.Replace('__CANDIDATE_ROOT__', $CANDIDATE_ROOT)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Deployment recovery candidate cleanup failed" -RequireDeploymentLock -RequireWriterLock
}

function Invoke-RemoteRetentionCleanup {
    param(
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot
    )

    Assert-RollbackBackupPath -BackupPath $BackupPath
    $remoteScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
BackupRoot="$RemoteRoot/backups"
CandidateRoot="__CANDIDATE_ROOT__"
CurrentBackup="$RemoteRoot/__BACKUP_PATH__"
ActiveRelease="__RELEASE_ROOT__"
MarkerRoot="$RemoteRoot/deployment-evidence"
LockDir="$RemoteRoot/.deploy-v030.lock"
test -d "$BackupRoot"
test ! -L "$BackupRoot"
test -d "$CandidateRoot"
test ! -L "$CandidateRoot"
test -d "$CurrentBackup"
test ! -L "$CurrentBackup"
GateUid="$(id -u __GATE_USER__)"
python3 - \
  "$BackupRoot" \
  "$CandidateRoot" \
  "$CurrentBackup" \
  "$ActiveRelease" \
  "0" \
  "$GateUid" \
  "$MarkerRoot" \
  "$LockDir" <<'TM_RETENTION_CLEANUP'
import json
import os
import re
import stat
import sys
import time

backupRoot, candidateRoot, currentBackup, activeRelease, rootUidRaw, gateUidRaw = sys.argv[1:7]
markerRoot = sys.argv[7] if len(sys.argv) > 7 else None
lockDir = sys.argv[8] if len(sys.argv) > 8 else None
rootUid = int(rootUidRaw)
gateUid = int(gateUidRaw)
backupKeepCount = 10
backupMaxAgeSeconds = 30 * 24 * 60 * 60
candidateMaxAgeSeconds = 24 * 60 * 60
backupName = re.compile(r'^v050-campaign-business-spine-[0-9]{8}-[0-9]{6}$')
candidateName = re.compile(r'^v050-campaign-business-spine-[0-9]{8}-[0-9]{6}$')
quarantineCandidateName = re.compile(r'^\.quarantine-[0-9a-f]{32}-[1-9][0-9]*$')
now = time.time()

def fsyncDirectory(directory):
    if os.name == 'nt':
        return
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def canonicalRoot(value, expectedOwner):
    if not os.path.isabs(value) or os.path.islink(value) or not os.path.isdir(value):
        raise RuntimeError(f'Unsafe retention root: {value}')
    resolved = os.path.realpath(value)
    metadata = os.lstat(resolved)
    if metadata.st_uid != expectedOwner:
        raise RuntimeError(f'Unexpected retention root owner: {resolved}')
    return resolved, metadata.st_dev

def strictRegular(path, expectedOwner):
    metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f'Unsafe retention metadata file: {path}')
    if metadata.st_uid != expectedOwner or metadata.st_nlink != 1:
        raise RuntimeError(f'Unexpected retention metadata ownership: {path}')
    if os.name != 'nt' and stat.S_IMODE(metadata.st_mode) != 0o600:
        raise RuntimeError(f'Unexpected retention metadata mode: {path}')
    return metadata

def readStrictJson(path, expectedOwner):
    strictRegular(path, expectedOwner)
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)

def atomicJson(path, payload):
    parent = os.path.dirname(path)
    prefix = os.path.basename(path) + '.next.'
    for entry in os.scandir(parent):
        if not entry.name.startswith(prefix):
            continue
        if not re.fullmatch(re.escape(prefix) + r'[0-9]+', entry.name):
            raise RuntimeError(f'Unknown retention journal temporary: {entry.path}')
        strictRegular(entry.path, rootUid)
        os.unlink(entry.path)
        fsyncDirectory(parent)
    temporary = f'{path}.next.{os.getpid()}'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        body = (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
        os.write(descriptor, body)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    fsyncDirectory(parent)

def matchingDirectories(root, expression, allowedOwners):
    result = []
    for entry in os.scandir(root):
        if not expression.fullmatch(entry.name):
            continue
        if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
            raise RuntimeError(f'Unsafe retention candidate: {entry.path}')
        metadata = entry.stat(follow_symlinks=False)
        if metadata.st_uid not in allowedOwners:
            raise RuntimeError(f'Unexpected retention candidate owner: {entry.path}')
        result.append((os.path.abspath(entry.path), metadata))
    return result

def validateTree(target, expectedDevice, allowedOwners):
    metadata = os.lstat(target)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode) or os.path.ismount(target):
        raise RuntimeError(f'Unsafe retention deletion target: {target}')
    if (os.name != 'nt' and metadata.st_dev != expectedDevice) or metadata.st_uid not in allowedOwners:
        raise RuntimeError(f'Unsafe retention deletion root: {target}')
    for entry in os.scandir(target):
        child = entry.path
        childMetadata = entry.stat(follow_symlinks=False)
        if stat.S_ISLNK(childMetadata.st_mode) or (os.name != 'nt' and childMetadata.st_dev != expectedDevice):
            raise RuntimeError(f'Unsafe retention tree entry: {child}')
        if childMetadata.st_uid not in allowedOwners:
            raise RuntimeError(f'Unexpected retention tree owner: {child}')
        if stat.S_ISDIR(childMetadata.st_mode):
            if os.path.ismount(child):
                raise RuntimeError(f'Retention tree crosses a mount: {child}')
            validateTree(child, expectedDevice, allowedOwners)
        elif not stat.S_ISREG(childMetadata.st_mode):
            raise RuntimeError(f'Unsupported retention tree entry: {child}')

def noFollowDelete(target, expectedDevice, allowedOwners):
    validateTree(target, expectedDevice, allowedOwners)
    for entry in list(os.scandir(target)):
        childMetadata = entry.stat(follow_symlinks=False)
        if stat.S_ISDIR(childMetadata.st_mode):
            noFollowDelete(entry.path, expectedDevice, allowedOwners)
        else:
            os.unlink(entry.path)
            fsyncDirectory(target)
    parent = os.path.dirname(target)
    os.rmdir(target)
    fsyncDirectory(parent)

backupRoot, backupDevice = canonicalRoot(backupRoot, rootUid)
candidateRoot, candidateDevice = canonicalRoot(candidateRoot, rootUid)
currentBackup = os.path.abspath(currentBackup)
if os.path.dirname(currentBackup) != backupRoot or not backupName.fullmatch(os.path.basename(currentBackup)):
    raise RuntimeError('Current backup is outside the retention root')
validateTree(currentBackup, backupDevice, {rootUid})
activeRelease = os.path.abspath(activeRelease)
if os.path.dirname(activeRelease) != candidateRoot or not candidateName.fullmatch(os.path.basename(activeRelease)):
    raise RuntimeError('Active release path is invalid')

protectedBackups = {currentBackup}
protectedCandidates = {activeRelease}

def protectBackupReference(relativePath, source):
    if not isinstance(relativePath, str) or not re.fullmatch(r'backups/' + backupName.pattern[1:-1], relativePath):
        raise RuntimeError(f'Invalid protected backup reference from {source}')
    absolute = os.path.abspath(os.path.join(os.path.dirname(backupRoot), relativePath))
    if os.path.dirname(absolute) != backupRoot or not os.path.isdir(absolute) or os.path.islink(absolute):
        raise RuntimeError(f'Missing or unsafe protected backup from {source}')
    validateTree(absolute, backupDevice, {rootUid})
    protectedBackups.add(absolute)

def protectCandidateReference(value, source):
    if value is None:
        return
    if not isinstance(value, str):
        raise RuntimeError(f'Invalid protected candidate reference from {source}')
    absolute = os.path.abspath(value)
    name = os.path.basename(absolute)
    if os.path.dirname(absolute) != candidateRoot or not (candidateName.fullmatch(name) or quarantineCandidateName.fullmatch(name)):
        raise RuntimeError(f'Protected candidate escaped the candidate root from {source}')
    if os.path.lexists(absolute):
        if os.path.islink(absolute) or not os.path.isdir(absolute):
            raise RuntimeError(f'Unsafe protected candidate from {source}')
        ownerSet = {rootUid, gateUid}
        validateTree(absolute, candidateDevice, ownerSet)
    protectedCandidates.add(absolute)

if markerRoot:
    markerRoot, _markerDevice = canonicalRoot(markerRoot, rootUid)
    for markerName in ('current-accepted.json', 'last-good.json'):
        markerPath = os.path.join(markerRoot, markerName)
        if os.path.lexists(markerPath):
            marker = readStrictJson(markerPath, rootUid)
            protectBackupReference(marker.get('backupPath'), markerName)

if lockDir and os.path.lexists(lockDir):
    lockDir, _lockDevice = canonicalRoot(lockDir, rootUid)
    runPath = os.path.join(lockDir, 'run.json')
    run = readStrictJson(runPath, rootUid)
    protectBackupReference(run.get('backupPath'), 'live journal')
    protectCandidateReference(run.get('releaseRoot'), 'live journal')
    protectCandidateReference(run.get('quarantinePath'), 'live journal')
    restorePath = os.path.join(lockDir, 'restore-v050')
    if os.path.lexists(restorePath):
        restoreStatus = os.lstat(restorePath)
        if stat.S_ISLNK(restoreStatus.st_mode) or not stat.S_ISDIR(restoreStatus.st_mode) or restoreStatus.st_uid != rootUid:
            raise RuntimeError('Unsafe unresolved restore journal')
        if os.name != 'nt' and stat.S_IMODE(restoreStatus.st_mode) != 0o700:
            raise RuntimeError('Unexpected unresolved restore journal mode')
        protectBackupReference(run.get('backupPath'), 'unresolved restore')

backups = matchingDirectories(backupRoot, backupName, {rootUid})
backups.sort(key=lambda item: (item[1].st_mtime_ns, os.path.basename(item[0])), reverse=True)
retainedBackups = {path for path, _metadata in backups[:backupKeepCount]} | protectedBackups
for path, metadata in backups:
    if now - metadata.st_mtime <= backupMaxAgeSeconds:
        retainedBackups.add(path)
removedBackups = [path for path, _metadata in backups if path not in retainedBackups]

candidates = matchingDirectories(candidateRoot, candidateName, {rootUid, gateUid})
removedCandidates = [
    path for path, metadata in candidates
    if path not in protectedCandidates and now - metadata.st_mtime > candidateMaxAgeSeconds
]

# Validate the complete set before the first atomic rename.
for target in removedBackups:
    validateTree(target, backupDevice, {rootUid})
for target in removedCandidates:
    validateTree(target, candidateDevice, {rootUid, gateUid})

backupQuarantine = os.path.join(backupRoot, '.retention-quarantine')
candidateQuarantine = os.path.join(candidateRoot, '.retention-quarantine')
for quarantineRoot, parent in ((backupQuarantine, backupRoot), (candidateQuarantine, candidateRoot)):
    if not os.path.lexists(quarantineRoot):
        os.mkdir(quarantineRoot, 0o700)
        fsyncDirectory(parent)
    status = os.lstat(quarantineRoot)
    if stat.S_ISLNK(status.st_mode) or not stat.S_ISDIR(status.st_mode) or status.st_uid != rootUid:
        raise RuntimeError(f'Unsafe retention quarantine root: {quarantineRoot}')
    if os.name != 'nt' and stat.S_IMODE(status.st_mode) != 0o700:
        raise RuntimeError(f'Unexpected retention quarantine mode: {quarantineRoot}')

journalPath = os.path.join(currentBackup, 'retention-journal.json')
resumedQuarantines = []
if os.path.lexists(journalPath):
    journal = readStrictJson(journalPath, rootUid)
    if journal.get('schemaVersion') != 1 or not isinstance(journal.get('operations'), list):
        raise RuntimeError('Retention journal schema is invalid')
    incomplete = any(operation.get('state') != 'complete' for operation in journal['operations'])
else:
    journal = None
    incomplete = False

def makeOperation(kind, source):
    name = os.path.basename(source)
    quarantineRoot = backupQuarantine if kind == 'backup' else candidateQuarantine
    return {
        'kind': kind,
        'name': name,
        'source': source,
        'quarantine': os.path.join(quarantineRoot, f'{kind}--{name}'),
        'state': 'planned'
    }

if journal is None or not incomplete:
    journal = {
        'schemaVersion': 1,
        'createdAtEpoch': int(now),
        'operations': [makeOperation('backup', path) for path in removedBackups] +
                      [makeOperation('candidate', path) for path in removedCandidates]
    }
    atomicJson(journalPath, journal)

expectedQuarantines = set()
for operation in journal['operations']:
    if set(operation) != {'kind', 'name', 'source', 'quarantine', 'state'}:
        raise RuntimeError('Retention journal operation schema is invalid')
    kind = operation['kind']
    expression = backupName if kind == 'backup' else candidateName if kind == 'candidate' else None
    root = backupRoot if kind == 'backup' else candidateRoot
    quarantineRoot = backupQuarantine if kind == 'backup' else candidateQuarantine
    if expression is None or not expression.fullmatch(operation['name']):
        raise RuntimeError('Retention journal artifact name is invalid')
    expectedSource = os.path.join(root, operation['name'])
    expectedQuarantine = os.path.join(quarantineRoot, f'{kind}--{operation["name"]}')
    if operation['source'] != expectedSource or operation['quarantine'] != expectedQuarantine:
        raise RuntimeError('Retention journal path escaped its root')
    if operation['state'] not in {'planned', 'quarantined', 'complete'}:
        raise RuntimeError('Retention journal state is invalid')
    expectedQuarantines.add(expectedQuarantine)

for quarantineRoot in (backupQuarantine, candidateQuarantine):
    for entry in os.scandir(quarantineRoot):
        if os.path.abspath(entry.path) not in expectedQuarantines:
            raise RuntimeError(f'Unknown retention quarantine entry: {entry.path}')

failAfter = int(os.environ.get('TM_RETENTION_FAIL_AFTER_QUARANTINE', '0') or '0')
quarantineCount = 0
for operation in journal['operations']:
    kind = operation['kind']
    source = operation['source']
    quarantine = operation['quarantine']
    device = backupDevice if kind == 'backup' else candidateDevice
    owners = {rootUid} if kind == 'backup' else {rootUid, gateUid}
    sourceExists = os.path.lexists(source)
    quarantineExists = os.path.lexists(quarantine)
    if operation['state'] == 'planned':
        if sourceExists and not quarantineExists:
            validateTree(source, device, owners)
            os.replace(source, quarantine)
            fsyncDirectory(os.path.dirname(source))
            fsyncDirectory(os.path.dirname(quarantine))
            quarantineCount += 1
            if failAfter and quarantineCount == failAfter:
                raise RuntimeError('Injected retention failure after quarantine')
        elif not sourceExists and quarantineExists:
            resumedQuarantines.append(operation['name'])
        else:
            raise RuntimeError('Retention planned operation has ambiguous paths')
        operation['state'] = 'quarantined'
        atomicJson(journalPath, journal)
    if operation['state'] == 'quarantined':
        if os.path.lexists(source) or not os.path.lexists(quarantine):
            raise RuntimeError('Retention quarantined operation has ambiguous paths')
        noFollowDelete(quarantine, device, owners)
        operation['state'] = 'complete'
        atomicJson(journalPath, journal)
    if operation['state'] == 'complete' and (os.path.lexists(source) or os.path.lexists(quarantine)):
        raise RuntimeError('Retention completed operation still has artifacts')

report = {
    'schemaVersion': 1,
    'policy': {
        'backupKeepCount': backupKeepCount,
        'backupMaxAgeSeconds': backupMaxAgeSeconds,
        'candidateMaxAgeSeconds': candidateMaxAgeSeconds,
    },
    'currentBackup': os.path.basename(currentBackup),
    'protectedBackups': sorted(os.path.basename(path) for path in protectedBackups),
    'protectedCandidates': sorted(os.path.basename(path) for path in protectedCandidates),
    'removedBackups': sorted(operation['name'] for operation in journal['operations'] if operation['kind'] == 'backup'),
    'removedCandidates': sorted(operation['name'] for operation in journal['operations'] if operation['kind'] == 'candidate'),
    'resumedQuarantines': sorted(set(resumedQuarantines)),
}
reportPath = os.path.join(currentBackup, 'retention-report.json')
if os.path.lexists(reportPath) and os.path.islink(reportPath):
    raise RuntimeError('Retention report path is unsafe')
atomicJson(reportPath, report)
print('RETENTION_CLEANUP_OK')
TM_RETENTION_CLEANUP
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $remoteScript = $remoteScript.Replace('__CANDIDATE_ROOT__', $CANDIDATE_ROOT)
    $remoteScript = $remoteScript.Replace('__BACKUP_PATH__', $BackupPath)
    $remoteScript = $remoteScript.Replace('__RELEASE_ROOT__', $ReleaseRoot)
    $remoteScript = $remoteScript.Replace('__GATE_USER__', $GATE_USER)
    Invoke-RemoteBash -Script $remoteScript -FailureMessage "Remote retention cleanup failed" -RequireDeploymentLock
}

function Invoke-DeploymentFailureRecovery {
    param(
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][bool]$BackupCreated
    )

    Invoke-RemoteTrustedSourceInputSweep
    $script:deploymentWriterToken = [Guid]::NewGuid().ToString('N')
    Enter-RemoteWriterLock

    $phase = Get-RemoteDeploymentPhase
    $acceptanceProbe = Get-Command Get-RemoteDeploymentAcceptanceState -ErrorAction SilentlyContinue
    if ($null -ne $acceptanceProbe) {
        $acceptanceState = Get-RemoteDeploymentAcceptanceState
    }
    elseif ($phase -in @('accepted', 'accepted-public-enabled', 'cutover-complete')) {
        # Compatibility for isolated legacy function harnesses; production always defines the probe.
        $acceptanceState = 'current-marker-new'
    }
    else {
        $acceptanceState = 'current-marker-absent'
    }
    if ($acceptanceState -eq 'current-marker-new') {
        if ($phase -ne 'cutover-complete') {
            # The durable current marker wins if its journal mirror was torn.
            $phase = 'accepted'
        }
    }
    elseif ($phase -in @('accepted', 'accepted-public-enabled', 'cutover-complete')) {
        throw "The lifecycle journal claims acceptance without the authoritative current marker."
    }
    switch ($phase) {
        { $_ -in @('mutation-started', 'release-replay-complete') } {
            if (-not $BackupCreated) {
                throw "Production mutation started without a completed rollback backup."
            }
            for ($restoreAttempt = 1; $restoreAttempt -le 3; $restoreAttempt += 1) {
                try {
                    Invoke-RemoteRestore -BackupPath $BackupPath -RestoreDatabase
                    break
                }
                catch {
                    if ($restoreAttempt -eq 3) {
                        throw
                    }
                    Write-Warning "Rollback replay attempt $restoreAttempt failed; retrying from the durable restore journal."
                    Start-Sleep -Seconds (2 * $restoreAttempt)
                }
            }
            Invoke-RemoteCandidateCleanup -ReleaseRoot $ReleaseRoot
        }
        { $_ -in @('mutation-intent', 'maintenance-entered', 'writers-stopped', 'snapshot-ready', 'prior-marker-archived', 'nginx-candidate-staged') } {
            if (-not $BackupCreated) {
                throw "Pre-mutation recovery requires the completed deployment backup."
            }
            Invoke-RemotePreMutationResume -BackupPath $BackupPath
            Invoke-RemoteCandidateCleanup -ReleaseRoot $ReleaseRoot
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
            Invoke-RemoteRetentionCleanup -BackupPath $BackupPath -ReleaseRoot $ReleaseRoot
            Invoke-RemoteCandidateCleanup -ReleaseRoot $ReleaseRoot
        }
        'accepted' {
            Write-Warning "The candidate was durably accepted; finalize it without rolling back user-visible state."
            Invoke-RemoteAcceptedFinalize -ReleaseRoot $ReleaseRoot
            Invoke-RemoteRetentionCleanup -BackupPath $BackupPath -ReleaseRoot $ReleaseRoot
        }
        'accepted-public-enabled' {
            Write-Warning "The authoritative marker is public; finalize the accepted release without rollback."
            Invoke-RemoteAcceptedFinalize -ReleaseRoot $ReleaseRoot
            Invoke-RemoteRetentionCleanup -BackupPath $BackupPath -ReleaseRoot $ReleaseRoot
        }
        default {
            throw "Remote deployment phase is not safe for automatic recovery."
        }
    }

    Exit-RemoteDeploymentLock -ReleaseWriterLock
}

function Invoke-InterruptedDeploymentRecovery {
    $script:SERVER = Get-RemoteServer
    $script:deploymentWriterToken = $null
    Enter-RemoteInterruptedDeploymentRecovery
    $metadata = Get-RemoteDeploymentRunMetadata
    $cleanupPath = [string]$metadata.releaseRoot
    if ($null -ne $metadata.quarantinePath -and -not [string]::IsNullOrWhiteSpace([string]$metadata.quarantinePath)) {
        $cleanupPath = [string]$metadata.quarantinePath
    }
    Invoke-DeploymentFailureRecovery `
        -BackupPath ([string]$metadata.backupPath) `
        -ReleaseRoot $cleanupPath `
        -BackupCreated ([bool]$metadata.backupReady)
}

function Invoke-ManualRollback {
    param(
        [Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][string]$BackupPath,
        [switch]$RestoreDatabase,
        [switch]$ConfirmDataLoss
    )

    Assert-RollbackBackupPath -BackupPath $BackupPath
    if (-not $RestoreDatabase) {
        throw "RollbackBackup requires -RestoreDatabase for Phase 4."
    }
    if (-not $ConfirmDataLoss) {
        throw "RestoreDatabase requires -ConfirmDataLoss."
    }
    $script:SERVER = Get-RemoteServer
    $script:deploymentLockToken = [Guid]::NewGuid().ToString('N')
    $script:deploymentWriterToken = [Guid]::NewGuid().ToString('N')
    $script:deploymentRunId = [Guid]::NewGuid().ToString('N')
    $script:deploymentBackupPath = $BackupPath
    $script:deploymentReleaseRoot = $REMOTE_DIR
    $script:deploymentCandidatePath = ''
    $script:deploymentSourceIdentity = "manual-rollback:$BackupPath"
    $sourceBytes = [Text.Encoding]::UTF8.GetBytes($script:deploymentSourceIdentity)
    $sourceHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $script:deploymentSourceSha256 = ([BitConverter]::ToString($sourceHasher.ComputeHash($sourceBytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sourceHasher.Dispose()
    }
    $script:deploymentOperation = 'rollback'
    $manualLockAcquired = $false
    try {
        Enter-RemoteDeploymentLock
        $manualLockAcquired = $true
        Assert-RemoteExternalRuntimeBoundary
        Assert-RemoteLoopbackIsolationPreflight
        Enter-RemoteWriterLock
        Invoke-RemoteRestore -BackupPath $BackupPath -RestoreDatabase
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

function Get-CanonicalLocalUploadFile {
    param(
        [Parameter(Mandatory = $true)][string]$CheckoutRoot,
        [Parameter(Mandatory = $true)][string]$InventoryRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    if (
        [string]::IsNullOrWhiteSpace($RelativePath) -or
        [IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath.Contains(':')
    ) {
        throw "Local upload path is not a canonical relative path: $RelativePath"
    }
    $relativeSegments = @($RelativePath -split '[\\/]')
    if (
        $relativeSegments.Count -eq 0 -or
        @($relativeSegments | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -in @('.', '..') }).Count -ne 0
    ) {
        throw "Local upload path is not a canonical relative path: $RelativePath"
    }

    $separator = [IO.Path]::DirectorySeparatorChar
    $trimSeparators = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $checkoutPath = [IO.Path]::GetFullPath($CheckoutRoot).TrimEnd($trimSeparators)
    $inventoryPath = [IO.Path]::GetFullPath($InventoryRoot).TrimEnd($trimSeparators)
    $checkoutPrefix = $checkoutPath + $separator
    $inventoryPrefix = $inventoryPath + $separator
    if (
        -not $inventoryPath.Equals($checkoutPath, [StringComparison]::OrdinalIgnoreCase) -and
        -not $inventoryPath.StartsWith($checkoutPrefix, [StringComparison]::OrdinalIgnoreCase)
    ) {
        throw "Local upload inventory root escapes the canonical checkout: $InventoryRoot"
    }

    $candidatePath = [IO.Path]::GetFullPath((Join-Path $inventoryPath $RelativePath))
    if (-not $candidatePath.StartsWith($inventoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Local upload path escapes its canonical inventory root: $RelativePath"
    }
    if (-not $candidatePath.StartsWith($checkoutPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Local upload path escapes the canonical checkout: $RelativePath"
    }

    if (-not (Test-Path -LiteralPath $checkoutPath -PathType Container)) {
        throw "Canonical checkout root is missing: $checkoutPath"
    }
    $checkoutItem = Get-Item -LiteralPath $checkoutPath -Force
    if (($checkoutItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Canonical checkout root must not be a reparse point: $checkoutPath"
    }

    $relativeFromCheckout = $candidatePath.Substring($checkoutPrefix.Length)
    $walkSegments = @($relativeFromCheckout -split '[\\/]')
    $currentPath = $checkoutPath
    for ($index = 0; $index -lt $walkSegments.Count; $index++) {
        $currentPath = Join-Path $currentPath $walkSegments[$index]
        if (-not (Test-Path -LiteralPath $currentPath)) {
            throw "Local upload file is missing: $RelativePath"
        }
        $currentItem = Get-Item -LiteralPath $currentPath -Force
        if (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Local upload path contains a reparse point: $RelativePath"
        }
        if ($index -lt ($walkSegments.Count - 1) -and -not $currentItem.PSIsContainer) {
            throw "Local upload parent is not a directory: $RelativePath"
        }
        if (
            $index -eq ($walkSegments.Count - 1) -and
            ($currentItem.PSIsContainer -or $currentItem -isnot [IO.FileInfo])
        ) {
            throw "Local upload entry is not a regular file: $RelativePath"
        }
    }

    $resolvedPath = [IO.Path]::GetFullPath($currentItem.FullName)
    if (-not $resolvedPath.Equals($candidatePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Local upload path did not resolve to its canonical checkout identity: $RelativePath"
    }
    return $resolvedPath
}

function Initialize-PinnedDeploymentTypes {
    if ($null -ne ('PinnedDeploymentActionRecord' -as [type])) {
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class PinnedDeploymentActionRecord
{
    private readonly byte[] bytes;

    public string InventoryKind { get; private set; }
    public string SourceRelativePath { get; private set; }
    public string SourcePath { get; private set; }
    public string RemoteRelativePath { get; private set; }
    public string ExpectedSha256 { get; private set; }
    public bool RequiredPublicAsset { get; private set; }
    public bool IncludedInBackup { get; private set; }
    public long ByteLength { get { return bytes.LongLength; } }

    public PinnedDeploymentActionRecord(
        string inventoryKind,
        string sourceRelativePath,
        string sourcePath,
        string remoteRelativePath,
        string expectedSha256,
        bool requiredPublicAsset,
        bool includedInBackup,
        byte[] sourceBytes)
    {
        if (sourceBytes == null) throw new ArgumentNullException("sourceBytes");
        InventoryKind = inventoryKind;
        SourceRelativePath = sourceRelativePath;
        SourcePath = sourcePath;
        RemoteRelativePath = remoteRelativePath;
        ExpectedSha256 = expectedSha256;
        RequiredPublicAsset = requiredPublicAsset;
        IncludedInBackup = includedInBackup;
        bytes = (byte[])sourceBytes.Clone();
    }

    public void CopyTo(Stream destination)
    {
        if (destination == null) throw new ArgumentNullException("destination");
        destination.Write(bytes, 0, bytes.Length);
        destination.Flush();
    }

    public byte[] GetBytesCopy()
    {
        return (byte[])bytes.Clone();
    }

    public string ReadUtf8Text()
    {
        return new UTF8Encoding(false, true).GetString(bytes);
    }

    public string ToBase64()
    {
        return Convert.ToBase64String(bytes);
    }
}

public sealed class ImmutableDeploymentActionPlan
{
    private readonly ReadOnlyCollection<PinnedDeploymentActionRecord> records;
    private readonly Dictionary<string, PinnedDeploymentActionRecord> byRemotePath;

    public ReadOnlyCollection<PinnedDeploymentActionRecord> Records { get { return records; } }
    public string Identity { get; private set; }

    public ImmutableDeploymentActionPlan(PinnedDeploymentActionRecord[] actionRecords, string identity)
    {
        if (actionRecords == null) throw new ArgumentNullException("actionRecords");
        PinnedDeploymentActionRecord[] recordCopy = (PinnedDeploymentActionRecord[])actionRecords.Clone();
        records = Array.AsReadOnly(recordCopy);
        byRemotePath = new Dictionary<string, PinnedDeploymentActionRecord>(StringComparer.Ordinal);
        foreach (PinnedDeploymentActionRecord record in recordCopy)
        {
            if (record == null) throw new ArgumentException("Action plan contains a null record.", "actionRecords");
            if (byRemotePath.ContainsKey(record.RemoteRelativePath))
                throw new ArgumentException("Action plan contains a duplicate remote path.", "actionRecords");
            byRemotePath.Add(record.RemoteRelativePath, record);
        }
        Identity = identity;
    }

    public PinnedDeploymentActionRecord GetByRemoteRelativePath(string remoteRelativePath)
    {
        PinnedDeploymentActionRecord record;
        if (!byRemotePath.TryGetValue(remoteRelativePath, out record))
            throw new InvalidOperationException("Pinned deployment action is missing: " + remoteRelativePath);
        return record;
    }
}

public static class PinnedDeploymentFileIdentity
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle handle,
        StringBuilder path,
        uint pathLength,
        uint flags);

    public static string GetFinalPath(FileStream stream)
    {
        if (stream == null) throw new ArgumentNullException("stream");
        StringBuilder path = new StringBuilder(512);
        uint length = GetFinalPathNameByHandle(stream.SafeFileHandle, path, (uint)path.Capacity, 0);
        if (length == 0)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        if (length >= path.Capacity)
        {
            path = new StringBuilder((int)length + 1);
            length = GetFinalPathNameByHandle(stream.SafeFileHandle, path, (uint)path.Capacity, 0);
            if (length == 0 || length >= path.Capacity)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        return path.ToString();
    }

    public static string Sha256(byte[] bytes)
    {
        using (SHA256 hasher = SHA256.Create())
        {
            byte[] digest = hasher.ComputeHash(bytes);
            StringBuilder result = new StringBuilder(digest.Length * 2);
            foreach (byte value in digest) result.Append(value.ToString("x2"));
            return result.ToString();
        }
    }
}
'@
}

function New-ImmutableDeploymentActionPlan {
    param(
        [Parameter(Mandatory = $true)][string]$CheckoutRoot,
        [Parameter(Mandatory = $true)][string]$PlatformRoot,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$PlatformEntries,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$RequiredPublicAssetEntries,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$RootRelativeEntries,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$CandidateOnlyEntries
    )

    Initialize-PinnedDeploymentTypes
    $requiredPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($requiredEntry in $RequiredPublicAssetEntries) {
        if ($requiredEntry -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$requiredEntry)) {
            throw 'Required public asset inventory contains a non-string or empty entry.'
        }
        $requiredPath = ([string]$requiredEntry) -replace '\\', '/'
        if (-not $requiredPaths.Add($requiredPath)) {
            throw "Duplicate required public asset inventory entry: $requiredPath"
        }
    }

    $recordSpecs = New-Object 'Collections.Generic.List[object]'
    foreach ($entry in $PlatformEntries) {
        $relativePath = [string]$entry
        $remoteRelativePath = "platform/$(Convert-ToRemotePath $relativePath)"
        $recordSpecs.Add([pscustomobject]@{
            Kind = 'Platform'
            InventoryRoot = $PlatformRoot
            RelativePath = $relativePath
            RemoteRelativePath = $remoteRelativePath
            RequiredPublicAsset = $requiredPaths.Contains((Convert-ToRemotePath $relativePath))
            IncludedInBackup = $true
        })
    }
    foreach ($entry in $RootRelativeEntries) {
        $relativePath = [string]$entry
        $recordSpecs.Add([pscustomobject]@{
            Kind = 'RootRelative'
            InventoryRoot = $CheckoutRoot
            RelativePath = $relativePath
            RemoteRelativePath = Convert-ToRemotePath $relativePath
            RequiredPublicAsset = $false
            IncludedInBackup = $true
        })
    }
    foreach ($entry in $CandidateOnlyEntries) {
        $relativePath = [string]$entry
        $recordSpecs.Add([pscustomobject]@{
            Kind = 'CandidateOnly'
            InventoryRoot = $CheckoutRoot
            RelativePath = $relativePath
            RemoteRelativePath = Convert-ToRemotePath $relativePath
            RequiredPublicAsset = $false
            IncludedInBackup = $false
        })
    }

    $seenRemotePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $seenSourcePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $seenRequiredPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $records = New-Object 'Collections.Generic.List[PinnedDeploymentActionRecord]'
    $identityEntries = New-Object 'Collections.Generic.List[string]'
    foreach ($spec in $recordSpecs) {
        if (-not $seenRemotePaths.Add([string]$spec.RemoteRelativePath)) {
            throw "Duplicate deployment action remote path: $($spec.RemoteRelativePath)"
        }
        $canonicalPath = Get-CanonicalLocalUploadFile `
            -CheckoutRoot $CheckoutRoot `
            -InventoryRoot ([string]$spec.InventoryRoot) `
            -RelativePath ([string]$spec.RelativePath)
        if (-not $seenSourcePaths.Add($canonicalPath)) {
            throw "Duplicate deployment action source path: $canonicalPath"
        }

        $sourceStream = [IO.FileStream]::new(
            $canonicalPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read,
            65536,
            [IO.FileOptions]::SequentialScan
        )
        try {
            $openedPath = [PinnedDeploymentFileIdentity]::GetFinalPath($sourceStream)
            if ($openedPath.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
                $openedPath = '\\' + $openedPath.Substring(8)
            }
            elseif ($openedPath.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
                $openedPath = $openedPath.Substring(4)
            }
            $openedPath = [IO.Path]::GetFullPath($openedPath)
            if (-not $openedPath.Equals($canonicalPath, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Opened deployment source escaped its canonical checkout identity: $($spec.RelativePath)"
            }
            $snapshot = [IO.MemoryStream]::new()
            try {
                $sourceStream.CopyTo($snapshot)
                $sourceBytes = $snapshot.ToArray()
            }
            finally {
                $snapshot.Dispose()
            }
        }
        finally {
            $sourceStream.Dispose()
        }

        $sha256 = [PinnedDeploymentFileIdentity]::Sha256($sourceBytes)
        $record = [PinnedDeploymentActionRecord]::new(
            [string]$spec.Kind,
            [string]$spec.RelativePath,
            $canonicalPath,
            [string]$spec.RemoteRelativePath,
            $sha256,
            [bool]$spec.RequiredPublicAsset,
            [bool]$spec.IncludedInBackup,
            $sourceBytes
        )
        $records.Add($record)
        if ($record.RequiredPublicAsset) {
            [void]$seenRequiredPaths.Add((Convert-ToRemotePath $record.SourceRelativePath))
        }
        $identityEntries.Add((
            '{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f
                $record.InventoryKind,
                $record.SourceRelativePath,
                $record.RemoteRelativePath,
                ([int]$record.RequiredPublicAsset),
                ([int]$record.IncludedInBackup),
                $record.ExpectedSha256,
                $record.ByteLength
        ))
    }

    foreach ($requiredPath in $requiredPaths) {
        if (-not $seenRequiredPaths.Contains($requiredPath)) {
            throw "Required public asset is absent from the platform action plan: $requiredPath"
        }
    }
    $identity = Get-ExactDeploymentInventoryIdentity -Entries $identityEntries.ToArray() -Label 'deployment action plan'
    return [ImmutableDeploymentActionPlan]::new($records.ToArray(), $identity)
}

function Invoke-NativeWithPinnedInput {
    param(
        [Parameter(Mandatory = $true)][object]$Record,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [ValidateRange(1, 14400)][int]$TimeoutSeconds = 7200
    )

    Initialize-PinnedDeploymentTypes
    if ($Record -isnot [PinnedDeploymentActionRecord]) {
        throw "$FailureMessage did not receive a pinned deployment action record."
    }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FileName
    $detachedArgumentList = $ArgumentList.Clone()
    $nativeArgumentParts = @(
        foreach ($nativeArgument in $detachedArgumentList) {
            Convert-ToNativeArgument $nativeArgument
        }
    )
    $startInfo.Arguments = $nativeArgumentParts -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "$FailureMessage could not start the native process."
        }
        try {
            $Record.CopyTo($process.StandardInput.BaseStream)
        }
        finally {
            $process.StandardInput.Close()
        }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            [void]$process.WaitForExit(5000)
            throw "$FailureMessage timed out after $TimeoutSeconds second(s)."
        }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "$FailureMessage (exit code $($process.ExitCode))."
        }
    }
    finally {
        $process.Dispose()
    }
}

function Assert-ImmutableDeploymentActionPlan {
    param([Parameter(Mandatory = $true)][object]$DeploymentPlan)

    Initialize-PinnedDeploymentTypes
    if (
        $DeploymentPlan -isnot [ImmutableDeploymentActionPlan] -or
        [string]::IsNullOrWhiteSpace([string]$DeploymentPlan.Identity) -or
        $DeploymentPlan.Identity -notmatch '^\d+:[0-9a-f]{64}$'
    ) {
        throw 'Deployment action requires one valid immutable source plan identity.'
    }
}

function Get-DeploymentPlanChecksumManifest {
    param([Parameter(Mandatory = $true)][object]$DeploymentPlan)

    Assert-ImmutableDeploymentActionPlan -DeploymentPlan $DeploymentPlan
    $manifest = New-Object Text.StringBuilder
    foreach ($record in $DeploymentPlan.Records) {
        [void]$manifest.Append($record.ExpectedSha256).Append('  ').Append($record.RemoteRelativePath).Append("`n")
    }
    return $manifest.ToString().TrimEnd("`r", "`n")
}

function Get-DeploymentPlanRemotePathManifest {
    param([Parameter(Mandatory = $true)][object]$DeploymentPlan)

    Assert-ImmutableDeploymentActionPlan -DeploymentPlan $DeploymentPlan
    $manifest = New-Object Text.StringBuilder
    foreach ($record in $DeploymentPlan.Records) {
        [void]$manifest.Append($record.RemoteRelativePath).Append("`n")
    }
    return $manifest.ToString().TrimEnd("`r", "`n")
}

function Convert-ToBashSingleQuotedLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains("'") -or $Value.Contains("`0") -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw 'Remote upload path contains a forbidden control character.'
    }
    return "'" + $Value + "'"
}

function Invoke-PinnedDeploymentUpload {
    param(
        [Parameter(Mandatory = $true)][object]$Record,
        [Parameter(Mandatory = $true)][string]$RemoteRoot
    )

    Initialize-PinnedDeploymentTypes
    if ($Record -isnot [PinnedDeploymentActionRecord]) {
        throw 'Candidate upload requires a pinned deployment action record.'
    }
    if ($Record.RemoteRelativePath -notmatch '^[A-Za-z0-9._/-]+$' -or $Record.RemoteRelativePath -match '(^|/)\.\.?(/|$)') {
        throw "Candidate upload record has an invalid remote path: $($Record.RemoteRelativePath)"
    }
    if ($Record.ExpectedSha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Candidate upload record has an invalid pinned SHA-256: $($Record.RemoteRelativePath)"
    }
    $remotePath = "$($RemoteRoot.TrimEnd('/'))/$($Record.RemoteRelativePath)"
    $temporaryPath = "$remotePath.uploading-$deploymentRunId"
    $remotePathLiteral = Convert-ToBashSingleQuotedLiteral $remotePath
    $temporaryPathLiteral = Convert-ToBashSingleQuotedLiteral $temporaryPath
    $expectedSha256Literal = Convert-ToBashSingleQuotedLiteral $Record.ExpectedSha256
    $remoteCommand = @"
set -euo pipefail
Target=$remotePathLiteral
Temporary=$temporaryPathLiteral
ExpectedSha256=$expectedSha256Literal
test ! -e "`$Temporary"
test -d "`$(dirname "`$Target")"
cat > "`$Temporary"
chmod 0600 "`$Temporary"
test "`$(sha256sum "`$Temporary" | awk '{print `$1}')" = "`$ExpectedSha256"
mv -f "`$Temporary" "`$Target"
"@
    Invoke-NativeWithPinnedInput `
        -Record $Record `
        -FileName 'ssh' `
        -ArgumentList @(
            '-i', $SSH_KEY,
            '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes',
            "root@${SERVER}",
            $remoteCommand
        ) `
        -FailureMessage "Candidate pinned upload failed: $($Record.RemoteRelativePath)"
}

function Assert-TrustedProductionSourceArtifacts {
    param([Parameter(Mandatory = $true)][object]$DeploymentPlan)

    Assert-ImmutableDeploymentActionPlan -DeploymentPlan $DeploymentPlan
    $trustedGateRemotePath = "platform/$(Convert-ToRemotePath $TRUSTED_SOURCE_GATE_RELATIVE_PATH)"
    $trustedManifestRemotePath = "platform/$(Convert-ToRemotePath $TRUSTED_SOURCE_MANIFEST_RELATIVE_PATH)"
    $trustedGateRecord = $DeploymentPlan.GetByRemoteRelativePath($trustedGateRemotePath)
    $trustedManifestRecord = $DeploymentPlan.GetByRemoteRelativePath($trustedManifestRemotePath)
    if ($trustedGateRecord.ExpectedSha256 -cne $EXPECTED_TRUSTED_SOURCE_GATE_SHA256) {
        throw 'Trusted production source gate SHA-256 does not match the deploy-pinned contract.'
    }
    if ($trustedManifestRecord.ExpectedSha256 -cne $EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256) {
        throw 'Trusted production source manifest SHA-256 does not match the deploy-pinned contract.'
    }

    try {
        $trustedManifest = $trustedManifestRecord.ReadUtf8Text() | ConvertFrom-Json
    }
    catch {
        throw "Trusted production source manifest is not valid JSON."
    }
    if (
        [string]$trustedManifest.entrypoints.sanitizer -ne 'server/scripts/sanitize_production_shape.js' -or
        [string]$trustedManifest.entrypoints.sanitizationManifest -ne 'server/scripts/sanitization_manifest.json' -or
        [string]$trustedManifest.entrypoints.verifier -ne 'server/scripts/verify_campaign_migration_gate.js'
    ) {
        throw "Trusted production source entrypoints do not match the deploy contract."
    }
    $trustedManifestPaths = @{}
    foreach ($entry in @($trustedManifest.files)) {
        $relativePath = [string]$entry.path
        $expectedSha256 = [string]$entry.sha256
        if (
            [string]::IsNullOrWhiteSpace($relativePath) -or
            $relativePath -notmatch '^server/[A-Za-z0-9._/-]+$' -or
            $relativePath -match '(^|/)\.\.?(/|$)' -or
            $trustedManifestPaths.ContainsKey($relativePath) -or
            $expectedSha256 -notmatch '^[0-9a-f]{64}$' -or
            $entry.PSObject.Properties.Name -contains 'sourcePath'
        ) {
            throw "Trusted production source manifest contains an invalid file entry."
        }
        $trustedManifestPaths[$relativePath] = $true
        try {
            $localPinnedRecord = $DeploymentPlan.GetByRemoteRelativePath("platform/$relativePath")
        }
        catch {
            throw "Trusted production source input is missing: $relativePath"
        }
        if ($localPinnedRecord.ExpectedSha256 -cne $expectedSha256) {
            throw "Trusted production source input SHA-256 mismatch: $relativePath"
        }
    }
    $verifierEntries = @($trustedManifest.files | Where-Object {
        $_.path -eq 'server/scripts/verify_campaign_migration_gate.js'
    })
    if ($verifierEntries.Count -ne 1 -or [string]$verifierEntries[0].sha256 -ne $EXPECTED_TRUSTED_MIGRATION_VERIFIER_SHA256) {
        throw "Trusted migration verifier SHA-256 does not match the deploy-pinned contract."
    }
}

function Assert-LocalReleaseSource {
    Add-FrozenScreenshotFiles
    Assert-Utf8StandardInputTransport
    $requiredAssetsIdentity = Get-ExactDeploymentInventoryIdentity `
        -Entries ([object[]]$requiredPublicAssets.Clone()) `
        -Label 'required public asset inventory'
    if ($requiredAssetsIdentity -cne $script:EXPECTED_REQUIRED_PUBLIC_ASSETS_IDENTITY) {
        throw 'Unexpected required public asset inventory entry or missing canonical entry.'
    }
    $deploymentPlan = New-ImmutableDeploymentActionPlan `
        -CheckoutRoot $REPO_DIR `
        -PlatformRoot $LOCAL_DIR `
        -PlatformEntries ([object[]]$FILES.Clone()) `
        -RequiredPublicAssetEntries ([object[]]$requiredPublicAssets.Clone()) `
        -RootRelativeEntries ([object[]]$ROOT_RELATIVE_FILES.Clone()) `
        -CandidateOnlyEntries ([object[]]$CANDIDATE_ONLY_FILES.Clone())
    Assert-ImmutableDeploymentActionPlan -DeploymentPlan $deploymentPlan
    Set-Variable -Scope Script -Name FILES -Option ReadOnly -Value ([Array]::AsReadOnly([string[]]$FILES.Clone()))
    Set-Variable -Scope Script -Name requiredPublicAssets -Option ReadOnly -Value ([Array]::AsReadOnly([string[]]$requiredPublicAssets.Clone()))
    Set-Variable -Scope Script -Name ROOT_RELATIVE_FILES -Option ReadOnly -Value ([Array]::AsReadOnly([string[]]$ROOT_RELATIVE_FILES.Clone()))
    Set-Variable -Scope Script -Name CANDIDATE_ONLY_FILES -Option ReadOnly -Value ([Array]::AsReadOnly([string[]]$CANDIDATE_ONLY_FILES.Clone()))
    Assert-TrustedProductionSourceArtifacts -DeploymentPlan $deploymentPlan

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

    foreach ($record in $deploymentPlan.Records) {
        $trackedPath = $record.RemoteRelativePath
        $trackedResult = & git -C $REPO_DIR ls-files --error-unmatch -- $trackedPath 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Release inventory file is not tracked by Git: $trackedPath"
        }
    }

    $buildInfoRecord = $deploymentPlan.GetByRemoteRelativePath('platform/client/shared/build_info.js')
    $navigationRecord = $deploymentPlan.GetByRemoteRelativePath('platform/client/core/navigation.js')
    $accessibilityRecord = $deploymentPlan.GetByRemoteRelativePath('platform/client/core/accessibility.js')
    $shellRecord = $deploymentPlan.GetByRemoteRelativePath('platform/client/core/shell.js')
    $cspCompatRecord = $deploymentPlan.GetByRemoteRelativePath('platform/client/core/csp_compat.js')
    $pptPreviewRuntimeRecord = $deploymentPlan.GetByRemoteRelativePath('platform/client/features/ppt_preview_runtime.js')
    $indexRecord = $deploymentPlan.GetByRemoteRelativePath('platform/index.html')
    $pptRecord = $deploymentPlan.GetByRemoteRelativePath('platform/ppt.js')
    $buildInfoContractCheck = @'
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(0, 'utf8');
const expected = { app: process.argv[1], ppt: process.argv[2] };
const window = {};
window.window = window;
vm.runInNewContext(source, { window }, { filename: 'client/shared/build_info.js' });
if (JSON.stringify(window.TMBuild) !== JSON.stringify(expected)) {
  throw new Error(`TMBuild contract mismatch: ${JSON.stringify(window.TMBuild)}`);
}
if (window.tmAppBuild !== expected.app) {
  throw new Error(`tmAppBuild compatibility marker mismatch: ${window.tmAppBuild}`);
}
'@
    Invoke-NativeWithPinnedInput -Record $buildInfoRecord -FileName 'node' `
        -ArgumentList @('-e', $buildInfoContractCheck, $EXPECTED_APP_BUILD, $EXPECTED_PPT_BUILD) `
        -FailureMessage 'Local build metadata contract failed'
    foreach ($syntaxCheck in @(
        @{ Record = $navigationRecord; Label = 'navigation' },
        @{ Record = $accessibilityRecord; Label = 'accessibility' },
        @{ Record = $shellRecord; Label = 'shell' },
        @{ Record = $cspCompatRecord; Label = 'CSP compatibility' },
        @{ Record = $pptPreviewRuntimeRecord; Label = 'PPT preview runtime' }
    )) {
        Invoke-NativeWithPinnedInput -Record $syntaxCheck.Record -FileName 'node' `
            -ArgumentList @('--check', '-') `
            -FailureMessage "Local $($syntaxCheck.Label) syntax check failed"
    }
    $indexText = $indexRecord.ReadUtf8Text()
    $pptText = $pptRecord.ReadUtf8Text()
    if ($indexText.IndexOf($EXPECTED_APP_QUERY, [StringComparison]::Ordinal) -lt 0) {
        throw "index.html does not contain the locked app cache key."
    }
    if ($pptText.IndexOf($EXPECTED_PPT_BUILD, [StringComparison]::Ordinal) -lt 0) {
        throw "ppt.js does not contain the locked PPT build marker."
    }
    if ($indexText.IndexOf($EXPECTED_PPT_QUERY, [StringComparison]::Ordinal) -lt 0) {
        throw "index.html does not contain the locked PPT cache key."
    }
    if ($pptRecord.ExpectedSha256 -cne $EXPECTED_PPT_SHA256) {
        throw "ppt.js SHA-256 does not match the frozen release contract."
    }
    return $deploymentPlan
}

$rollbackRequested = $PSBoundParameters.ContainsKey('RollbackBackup')
if ($rollbackRequested) {
    Assert-RollbackBackupPath -BackupPath $RollbackBackup
}
if ($ValidateLocalOnly -and ($rollbackRequested -or $RestoreDatabase -or $ConfirmDataLoss -or $PreserveSessions -or $RecoverInterruptedDeployment)) {
    throw "ValidateLocalOnly cannot be combined with rollback or restore controls."
}
if ($RecoverInterruptedDeployment -and ($rollbackRequested -or $RestoreDatabase -or $ConfirmDataLoss -or $PreserveSessions)) {
    throw "RecoverInterruptedDeployment cannot be combined with deploy or rollback controls."
}
if ($PreserveSessions) {
    throw "Phase 4 deployment rejects session preservation."
}
if ($RestoreDatabase -and -not $rollbackRequested) {
    throw "RestoreDatabase requires -RollbackBackup."
}
if ($ConfirmDataLoss -and -not $RestoreDatabase) {
    throw "ConfirmDataLoss requires -RestoreDatabase."
}
if ($rollbackRequested -and -not $RestoreDatabase) {
    throw "RollbackBackup requires -RestoreDatabase for Phase 4."
}
if ($RestoreDatabase -and -not $ConfirmDataLoss) {
    throw "RestoreDatabase requires -ConfirmDataLoss."
}

if (-not $RecoverInterruptedDeployment -and -not $rollbackRequested) {
    $deploymentActionPlan = Assert-LocalReleaseSource
}

if ($ValidateLocalOnly) {
    Write-Host "LOCAL_DEPLOY_PREFLIGHT_OK" -ForegroundColor Cyan
    exit 0
}

if ($RecoverInterruptedDeployment) {
    Invoke-InterruptedDeploymentRecovery
    exit 0
}

Assert-AuthoritativeCheckout

if ($rollbackRequested) {
    Invoke-ManualRollback -BackupPath $RollbackBackup -RestoreDatabase -ConfirmDataLoss
    exit 0
}

$SERVER = Get-RemoteServer
$deploymentLockToken = [Guid]::NewGuid().ToString('N')

$uploadChecksums = Get-DeploymentPlanChecksumManifest -DeploymentPlan $deploymentActionPlan
$remotePathManifest = Get-DeploymentPlanRemotePathManifest -DeploymentPlan $deploymentActionPlan

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = "backups/v050-campaign-business-spine-$stamp"
$releaseDir = "v050-campaign-business-spine-$stamp"
$remoteReleaseRoot = "$CANDIDATE_ROOT/$releaseDir"
$remoteCandidateDir = "$remoteReleaseRoot/platform"
$deploymentRunId = [Guid]::NewGuid().ToString('N')
$deploymentBackupPath = $backupDir
$deploymentReleaseRoot = $remoteReleaseRoot
$deploymentCandidatePath = $remoteCandidateDir
$deploymentSourceIdentity = "$EXPECTED_BRANCH@$EXPECTED_APP_BUILD+$EXPECTED_PPT_BUILD"
$deploymentSourceSha256 = ($deploymentActionPlan.Identity -split ':', 2)[1]
$deploymentOperation = 'deploy'
$backupCreated = $false
$deploymentLockAcquired = $false

Write-Host "TuringMarket guarded deploy starting" -ForegroundColor Cyan
try {
    Enter-RemoteDeploymentLock
    $deploymentLockAcquired = $true
    Invoke-RemoteTrustedSourceInputSweep
    Install-RemoteTrustedProductionSourceGate -DeploymentPlan $deploymentActionPlan
    Assert-RemoteExternalRuntimeBoundary
    Assert-RemoteLoopbackIsolationPreflight
    Invoke-RemoteBackup -BackupPath $backupDir -DeploymentPlan $deploymentActionPlan
    $backupCreated = $true
    Install-RemoteMigrationGateCleanup -DeploymentPlan $deploymentActionPlan

    $prepareScript = @'
set -euo pipefail
RemoteRoot="__REMOTE_ROOT__"
ReleaseRoot="__RELEASE_ROOT__"
CandidateDir="__CANDIDATE_DIR__"
CandidateRoot="__CANDIDATE_ROOT__"
GateUser="__GATE_USER__"
validate_gate_identity() {
  local GatePasswd GateGroup GateName GateUid GatePrimaryGid GateHome GateShell GateGroupName GateGroupGid GateGroupMembers GatePrimaryUsers GateExpectedHome
  GatePasswd="$(getent passwd "$GateUser")"
  GateGroup="$(getent group "$GateUser")"
  GateExpectedHome="$(dirname "$CandidateRoot")"
  IFS=: read -r GateName _ GateUid GatePrimaryGid _ GateHome GateShell <<< "$GatePasswd"
  IFS=: read -r GateGroupName _ GateGroupGid GateGroupMembers <<< "$GateGroup"
  test "$GateName" = "$GateUser"
  test "$GateUid" -gt 0
  test "$GateUid" -lt 1000
  test "$GateGroupName" = "$GateUser"
  test "$GatePrimaryGid" = "$GateGroupGid"
  test -z "$GateGroupMembers"
  GatePrimaryUsers="$(getent passwd | awk -F: -v gid="$GateGroupGid" '$4 == gid { print $1 }')"
  test "$GatePrimaryUsers" = "$GateUser"
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

    foreach ($record in $deploymentActionPlan.Records) {
        Invoke-PinnedDeploymentUpload -Record $record -RemoteRoot $remoteReleaseRoot
    }

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
TrustedSourceGate="__TRUSTED_SOURCE_GATE__"
TrustedSourceManifest="__TRUSTED_SOURCE_MANIFEST__"
TrustedSourceBundle="__TRUSTED_SOURCE_BUNDLE__"
TrustedSourceRuntime="__TRUSTED_SOURCE_RUNTIME__"
TrustedDependencyRoot="$TrustedSourceRuntime/server/node_modules"
ExpectedTrustedSourceGateSha256="__TRUSTED_SOURCE_GATE_SHA256__"
ExpectedTrustedSourceManifestSha256="__TRUSTED_SOURCE_MANIFEST_SHA256__"
ExpectedTrustedMigrationVerifierSha256="__TRUSTED_MIGRATION_VERIFIER_SHA256__"

assert_trusted_source_gate() {
  local TrustedSourceGateReal TrustedSourceManifestReal
  test -f "$TrustedSourceGate"
  test ! -L "$TrustedSourceGate"
  test "$(stat -c '%U:%G:%a:%h' "$TrustedSourceGate")" = "root:root:444:1"
  test "$(sha256sum "$TrustedSourceGate" | awk '{print $1}')" = "$ExpectedTrustedSourceGateSha256"
  test -f "$TrustedSourceManifest"
  test ! -L "$TrustedSourceManifest"
  test "$(stat -c '%U:%G:%a:%h' "$TrustedSourceManifest")" = "root:root:444:1"
  test "$(sha256sum "$TrustedSourceManifest" | awk '{print $1}')" = "$ExpectedTrustedSourceManifestSha256"
  TrustedSourceGateReal="$(realpath -e "$TrustedSourceGate")"
  TrustedSourceManifestReal="$(realpath -e "$TrustedSourceManifest")"
  case "$TrustedSourceGateReal" in "$CandidateDir"/*) return 1 ;; esac
  case "$TrustedSourceManifestReal" in "$CandidateDir"/*) return 1 ;; esac
}

validate_gate_identity() {
  local GatePasswd GateGroup GateName GateUid GatePrimaryGid GateHome GateShell GateGroupName GateGroupGid GateGroupMembers GatePrimaryUsers GateExpectedHome
  GatePasswd="$(getent passwd "$GateUser")"
  GateGroup="$(getent group "$GateUser")"
  GateExpectedHome="$(dirname "$CandidateRoot")"
  IFS=: read -r GateName _ GateUid GatePrimaryGid _ GateHome GateShell <<< "$GatePasswd"
  IFS=: read -r GateGroupName _ GateGroupGid GateGroupMembers <<< "$GateGroup"
  test "$GateName" = "$GateUser"
  test "$GateUid" -gt 0
  test "$GateUid" -lt 1000
  test "$GateGroupName" = "$GateUser"
  test "$GatePrimaryGid" = "$GateGroupGid"
  test -z "$GateGroupMembers"
  GatePrimaryUsers="$(getent passwd | awk -F: -v gid="$GateGroupGid" '$4 == gid { print $1 }')"
  test "$GatePrimaryUsers" = "$GateUser"
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
assert_trusted_source_gate
test -f "$CandidateDir/server/scripts/bootstrap_production_runtime.sh"
bash -n "$CandidateDir/server/scripts/bootstrap_production_runtime.sh"
test -f "$ProductionBackupDb"
test -f "$ProductionLiveDb"
test -f "$LockDir/upload.sha256"
chown root:root "$ProductionBackupDb"
chmod 0600 "$ProductionBackupDb"
runuser -u "$GateUser" -- test ! -r "$ProductionBackupDb"
runuser -u "$GateUser" -- test ! -r "$ProductionLiveDb"

/usr/bin/node "$TrustedSourceGate" stage \
  --candidate-root "$CandidateDir" \
  --bundle-root "$TrustedSourceBundle" \
  --manifest "$TrustedSourceManifest" \
  --expected-self-sha256 "$ExpectedTrustedSourceGateSha256" \
  --expected-manifest-sha256 "$ExpectedTrustedSourceManifestSha256" \
  --expected-verifier-sha256 "$ExpectedTrustedMigrationVerifierSha256" >/dev/null
/usr/bin/node "$TrustedSourceGate" prepare-runtime \
  --candidate-root "$CandidateDir" \
  --bundle-root "$TrustedSourceBundle" \
  --manifest "$TrustedSourceManifest" \
  --runtime-root "$TrustedSourceRuntime" \
  --expected-self-sha256 "$ExpectedTrustedSourceGateSha256" \
  --expected-manifest-sha256 "$ExpectedTrustedSourceManifestSha256" \
  --expected-verifier-sha256 "$ExpectedTrustedMigrationVerifierSha256" >/dev/null
test -d "$TrustedDependencyRoot"

rm -rf "$TestRoot"
install -d -o "$GateUser" -g "$GateUser" -m 0700 \
  "$TestRoot" "$TestRoot/home" "$TestRoot/uploads" "$TestRoot/tmp" "$TestRoot/nginx-prefix"
SOURCE_BACKUP_SHA256_BEFORE="$(sha256sum "$ProductionBackupDb" | awk '{print $1}')"
PPT_MANIFEST_SHA256_BEFORE="$(sha256sum "$BackupAbsolute/ppt-cache.sha256" | awk '{print $1}')"
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
ExpectedTrustedSourceGid="$(id -g "$GateUser")"
[[ "$ExpectedTrustedSourceGid" =~ ^[0-9]+$ ]]
runuser -u "$GateUser" -- test ! -r "$ProductionBackupDb"
runuser -u "$GateUser" -- test ! -r "$ProductionLiveDb"

command -v systemd-run >/dev/null
command -v systemctl >/dev/null
TrustedSourceInputBase="/run/turingmarket-production-source-trust"
TrustedSourceInputRoot="$TrustedSourceInputBase/deployment-__STAMP__"
TrustedSourceCopy="$TrustedSourceInputRoot/source.db"

MigrationRehearsalRoot="$LockDir/migration-rehearsal"
MigrationWork="$TestRoot/migration-rehearsal"
RehearsalStdout="$MigrationRehearsalRoot/stdout.log"
RehearsalStderr="$MigrationRehearsalRoot/stderr.log"
MigrationUnit="turingmarket-migration-gate-__STAMP__"

cleanup_migration_rehearsal() {
  case "$MigrationRehearsalRoot" in
    "$LockDir"/migration-rehearsal) ;;
    *) echo "Invalid migration rehearsal cleanup path" >&2; return 1 ;;
  esac
  case "$MigrationWork" in
    "$TestRoot"/migration-rehearsal) ;;
    *) echo "Invalid migration work cleanup path" >&2; return 1 ;;
  esac
  case "$TrustedSourceInputRoot" in
    "$TrustedSourceInputBase"/deployment-*) ;;
    *) echo "Invalid trusted source cleanup path" >&2; return 1 ;;
  esac
  systemctl kill --kill-who=all --signal=KILL "$MigrationUnit.service" >/dev/null 2>&1 || true
  systemctl stop "$MigrationUnit.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$MigrationUnit.service" >/dev/null 2>&1 || true
  rm -rf -- "$MigrationRehearsalRoot" "$MigrationWork" "$TrustedSourceInputRoot"
  sync -f "$LockDir"
}

trap cleanup_migration_rehearsal EXIT
test ! -e "$TrustedSourceInputRoot"
test ! -e "$MigrationRehearsalRoot"
test ! -e "$MigrationWork"
test ! -e "$SchemaDb"
install -d -o root -g root -m 0700 "$MigrationRehearsalRoot"
install -d -o "$GateUser" -g "$GateUser" -m 0700 "$MigrationWork"
install -o root -g root -m 0600 /dev/null "$RehearsalStdout"
install -o root -g root -m 0600 /dev/null "$RehearsalStderr"
test -d /run
test ! -L /run
test "$(stat -c '%u:%g' /run)" = "0:0"
RunMode="$(stat -c '%a' /run)"
(( (8#$RunMode & 0022) == 0 ))
test ! -L "$TrustedSourceInputBase"
install -d -o root -g "$GateUser" -m 0710 "$TrustedSourceInputBase"
test ! -L "$TrustedSourceInputBase"
test "$(stat -c '%U:%G:%a' "$TrustedSourceInputBase")" = "root:$GateUser:710"
install -d -o root -g "$GateUser" -m 0700 "$TrustedSourceInputRoot"
install -o root -g "$GateUser" -m 0440 "$ProductionBackupDb" "$TrustedSourceCopy"
chmod 0510 "$TrustedSourceInputRoot"
test "$(stat -c '%U:%G:%a' "$TrustedSourceInputRoot")" = "root:$GateUser:510"
test -f "$TrustedSourceCopy"
test ! -L "$TrustedSourceCopy"
test "$(stat -c '%U:%G:%a:%h' "$TrustedSourceCopy")" = "root:$GateUser:440:1"
TRUSTED_SOURCE_SHA256_BEFORE="$(sha256sum "$TrustedSourceCopy" | awk '{print $1}')"
TRUSTED_SOURCE_DEV_INO_BEFORE="$(stat -c '%d:%i' "$TrustedSourceCopy")"
TRUSTED_SOURCE_METADATA_BEFORE="$(stat -c '%u:%g:%a:%h' "$TrustedSourceCopy")"
test "$TRUSTED_SOURCE_METADATA_BEFORE" = "0:$ExpectedTrustedSourceGid:440:1"
test "$TRUSTED_SOURCE_SHA256_BEFORE" = "$SOURCE_BACKUP_SHA256_BEFORE"
test "$(sha256sum "$ProductionBackupDb" | awk '{print $1}')" = "$SOURCE_BACKUP_SHA256_BEFORE"
validate_gate_identity
runuser -u "$GateUser" -- test -x "$TrustedSourceInputBase"
runuser -u "$GateUser" -- test ! -r "$TrustedSourceInputBase"
runuser -u "$GateUser" -- test -x "$TrustedSourceInputRoot"
runuser -u "$GateUser" -- test ! -r "$TrustedSourceInputRoot"
runuser -u "$GateUser" -- test -r "$TrustedSourceCopy"
runuser -u "$GateUser" -- test ! -w "$TrustedSourceCopy"
runuser -u "$GateUser" -- test ! -r "$ProductionBackupDb"
runuser -u "$GateUser" -- test ! -r "$ProductionLiveDb"

assert_trusted_source_gate
set +e
timeout --signal=KILL 41m systemd-run --quiet --wait --unit="$MigrationUnit" \
  --uid="$GateUser" --gid="$GateUser" --service-type=exec \
  --property="WorkingDirectory=$TrustedSourceBundle/server" \
  --property="PrivateNetwork=yes" \
  --property="PrivatePIDs=yes" \
  --property="PrivateMounts=yes" \
  --property="PrivateTmp=yes" \
  --property="PrivateDevices=yes" \
  --property="ProtectHome=yes" \
  --property="ProtectSystem=strict" \
  --property="ProtectKernelTunables=yes" \
  --property="ProtectKernelModules=yes" \
  --property="ProtectKernelLogs=yes" \
  --property="ProtectControlGroups=yes" \
  --property="ProtectClock=yes" \
  --property="NoNewPrivileges=yes" \
  --property="CapabilityBoundingSet=" \
  --property="RestrictSUIDSGID=yes" \
  --property="RestrictRealtime=yes" \
  --property="RestrictNamespaces=yes" \
  --property="LockPersonality=yes" \
  --property="RestrictAddressFamilies=AF_UNIX" \
  --property="KillMode=control-group" \
  --property="TimeoutStopSec=5s" \
  --property="RuntimeMaxSec=40m" \
  --property="TasksMax=256" \
  --property="MemoryMax=2G" \
  --property="LimitFSIZE=268435456" \
  --property="UMask=0077" \
  --property="ReadOnlyPaths=$CandidateDir $TrustedSourceInputRoot $TrustedSourceBundle $TrustedSourceRuntime $TrustedSourceGate $TrustedSourceManifest" \
  --property="ReadWritePaths=$TestRoot" \
  --property="InaccessiblePaths=/root /etc/turingmarket /var/lib/turingmarket/db /var/lib/turingmarket/ppt-cache /var/lib/turingmarket/uploads /var/lib/turingmarket/tmp $LockDir $BackupAbsolute" \
  --property="StandardOutput=file:$RehearsalStdout" \
  --property="StandardError=file:$RehearsalStderr" \
  -- /usr/bin/env -i \
    HOME="$TestRoot/home" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    NODE_ENV="test" \
    TM_DISABLE_DOTENV="1" \
    NODE_PATH="$TrustedDependencyRoot" \
    /usr/bin/node "$TrustedSourceGate" sanitize-and-verify \
      --candidate-root "$CandidateDir" \
      --bundle-root "$TrustedSourceBundle" \
      --manifest "$TrustedSourceManifest" \
       --dependency-root "$TrustedDependencyRoot" \
       --source "$TrustedSourceCopy" \
       --expected-source-gid "$ExpectedTrustedSourceGid" \
       --sanitized-source "$SchemaDb" \
      --work-dir "$MigrationWork" \
      --expected-self-sha256 "$ExpectedTrustedSourceGateSha256" \
      --expected-manifest-sha256 "$ExpectedTrustedSourceManifestSha256" \
      --expected-verifier-sha256 "$ExpectedTrustedMigrationVerifierSha256"
RehearsalStatus=$?
set -e

MigrationControlGroup="$(systemctl show "$MigrationUnit.service" --property=ControlGroup --value 2>/dev/null || true)"
systemctl kill --kill-who=all --signal=KILL "$MigrationUnit.service" >/dev/null 2>&1 || true
systemctl stop "$MigrationUnit.service" >/dev/null 2>&1 || true
if [ -n "$MigrationControlGroup" ] && [ -f "/sys/fs/cgroup$MigrationControlGroup/cgroup.procs" ]; then
  for _attempt in $(seq 1 50); do
    if [ ! -s "/sys/fs/cgroup$MigrationControlGroup/cgroup.procs" ]; then
      break
    fi
    sleep 0.1
  done
  test ! -s "/sys/fs/cgroup$MigrationControlGroup/cgroup.procs"
fi
test "$(systemctl show "$MigrationUnit.service" --property=MainPID --value 2>/dev/null || printf 0)" = "0"
systemctl reset-failed "$MigrationUnit.service" >/dev/null 2>&1 || true
kill_gate_processes "migration rehearsal"

if [ "$RehearsalStatus" != "0" ]; then
  echo "Trusted sanitization or migration rehearsal failed; inspect the root-only gate logs" >&2
  exit "$RehearsalStatus"
fi
test "$(wc -l < "$RehearsalStdout")" = "1"
grep -F '"format":"tm-trusted-production-source-verdict-v1"' "$RehearsalStdout" >/dev/null
test ! -s "$RehearsalStderr"
test -s "$SchemaDb"
test ! -L "$SchemaDb"
test "$(stat -c '%U:%G:%a:%h' "$SchemaDb")" = "$GateUser:$GateUser:444:1"
SANITIZED_SOURCE_SHA256_BEFORE="$(sha256sum "$SchemaDb" | awk '{print $1}')"
chown root:root "$SchemaDb"
test "$(stat -c '%U:%G:%a:%h' "$SchemaDb")" = "root:root:444:1"
if find "$MigrationWork" -maxdepth 1 -type f -size +268435456c -print -quit | grep -q .; then
  echo "Trusted source verification exceeded its database size bound" >&2
  exit 1
fi
TRUSTED_SOURCE_SHA256_AFTER="$(sha256sum "$TrustedSourceCopy" | awk '{print $1}')"
TRUSTED_SOURCE_DEV_INO_AFTER="$(stat -c '%d:%i' "$TrustedSourceCopy")"
TRUSTED_SOURCE_METADATA_AFTER="$(stat -c '%u:%g:%a:%h' "$TrustedSourceCopy")"
test "$TRUSTED_SOURCE_SHA256_BEFORE" = "$TRUSTED_SOURCE_SHA256_AFTER"
test "$TRUSTED_SOURCE_DEV_INO_BEFORE" = "$TRUSTED_SOURCE_DEV_INO_AFTER"
test "$TRUSTED_SOURCE_METADATA_BEFORE" = "$TRUSTED_SOURCE_METADATA_AFTER"
printf '%s\n' 'TRUSTED_SANITIZATION_AND_MIGRATION_REHEARSAL_OK'


SOURCE_BACKUP_SHA256_AFTER="$(sha256sum "$ProductionBackupDb" | awk '{print $1}')"
SANITIZED_SOURCE_SHA256_AFTER="$(sha256sum "$SchemaDb" | awk '{print $1}')"
PPT_MANIFEST_SHA256_AFTER="$(sha256sum "$BackupAbsolute/ppt-cache.sha256" | awk '{print $1}')"
printf 'SOURCE_BACKUP_SHA256_AFTER=%s\n' "$SOURCE_BACKUP_SHA256_AFTER"
test "$SOURCE_BACKUP_SHA256_BEFORE" = "$SOURCE_BACKUP_SHA256_AFTER"
test "$SANITIZED_SOURCE_SHA256_BEFORE" = "$SANITIZED_SOURCE_SHA256_AFTER"
test "$PPT_MANIFEST_SHA256_BEFORE" = "$PPT_MANIFEST_SHA256_AFTER"
cleanup_migration_rehearsal
trap - EXIT
test ! -e "$TrustedSourceInputRoot"
runuser -u "$GateUser" -- test -r "$SchemaDb"
runuser -u "$GateUser" -- test ! -r "$ProductionBackupDb"

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
node --check client/core/csp_compat.js
node --check client/features/ppt_preview_runtime.js
node --check server/server.js
grep -Fq "$APP_QUERY" index.html
grep -Fq "$APP_BUILD" client/shared/build_info.js
grep -Fq "$PPT_QUERY" index.html
grep -Fq "$PPT_BUILD" ppt.js
echo "$PPT_SHA256  ppt.js" | sha256sum --check --status

cd server

NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH="$SCHEMA_DB" node <<'NODE'
const database = require('./db');
try {
  if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Candidate DB integrity_check failed');
  if (database.pragma('foreign_key_check').length !== 0) throw new Error('Candidate DB foreign_key_check failed');
  const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
  if (Number(version) !== 5) throw new Error('Candidate migration target version mismatch');
  console.log('TM_SANITIZED_MIGRATION_COMPATIBILITY_OK');
} finally {
  database.close();
}
NODE
printf '%s\n' "TM_SCHEMA_COMPATIBILITY_OK"

cd "$CandidateDir"
NODE_ENV=test TM_DISABLE_DOTENV=1 node server/scripts/verify_phase4_one_request_replay.js
NODE_ENV=test TM_DISABLE_DOTENV=1 node --test server/tests/verify_phase4_one_request_replay.test.js
node --test server/tests/release_replay_gate.test.js
node --test server/tests/sanitized_migration_gate.test.js
cd "$CandidateDir/server"
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

assert_trusted_source_gate
/usr/bin/node "$TrustedSourceGate" stage \
  --candidate-root "$CandidateDir" \
  --bundle-root "$TrustedSourceBundle" \
  --manifest "$TrustedSourceManifest" \
  --expected-self-sha256 "$ExpectedTrustedSourceGateSha256" \
  --expected-manifest-sha256 "$ExpectedTrustedSourceManifestSha256" \
  --expected-verifier-sha256 "$ExpectedTrustedMigrationVerifierSha256" >/dev/null
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
PhaseNext="$LockDir/phase."next
printf '%s\n' 'candidate-ready' > "$PhaseNext"
sync -f "$PhaseNext"
mv -f "$PhaseNext" "$LockDir/phase"
sync -f "$LockDir/phase"
sync -f "$LockDir"
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
    $candidateGate = $candidateGate.Replace('__TRUSTED_SOURCE_GATE__', $TRUSTED_SOURCE_GATE_REMOTE_PATH)
    $candidateGate = $candidateGate.Replace('__TRUSTED_SOURCE_MANIFEST__', $TRUSTED_SOURCE_MANIFEST_REMOTE_PATH)
    $candidateGate = $candidateGate.Replace('__TRUSTED_SOURCE_BUNDLE__', $TRUSTED_SOURCE_BUNDLE_REMOTE_PATH)
    $candidateGate = $candidateGate.Replace('__TRUSTED_SOURCE_RUNTIME__', $TRUSTED_SOURCE_RUNTIME_REMOTE_PATH)
    $candidateGate = $candidateGate.Replace('__TRUSTED_SOURCE_GATE_SHA256__', $EXPECTED_TRUSTED_SOURCE_GATE_SHA256)
    $candidateGate = $candidateGate.Replace('__TRUSTED_SOURCE_MANIFEST_SHA256__', $EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256)
    $candidateGate = $candidateGate.Replace('__TRUSTED_MIGRATION_VERIFIER_SHA256__', $EXPECTED_TRUSTED_MIGRATION_VERIFIER_SHA256)
    $candidateGate = $candidateGate.Replace('__STAMP__', $stamp)
    Invoke-RemoteBash -Script $candidateGate -FailureMessage "Remote candidate validation failed" -TimeoutSeconds $CANDIDATE_GATE_TIMEOUT_SECONDS -RequireDeploymentLock

    $deploymentWriterToken = [Guid]::NewGuid().ToString('N')
    $exactPublicNginxVerifier = Get-ExactPublicNginxBehaviorVerifier
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
DatabasePath="/var/lib/turingmarket/db/turingmarket.db"
DatabaseDir="$(dirname "$DatabasePath")"
PptCacheDir="/var/lib/turingmarket/ppt-cache"
CutoverSnapshot="$BackupAbsolute/cutover-snapshot"
AcceptedMarker="$LockDir/accepted"
AcceptedEvidenceRoot="$RemoteRoot/deployment-evidence"
AcceptedEvidence="$AcceptedEvidenceRoot/accepted-__RUN_ID__.json"
CurrentAcceptedMarker="$AcceptedEvidenceRoot/current-accepted.json"
LastGoodMarker="$AcceptedEvidenceRoot/last-good.json"
StagedPublicNginx="$LockDir/nginx-candidate-public.conf"
StagedPublicNginxSha="$LockDir/nginx-candidate-public.sha256"
ApiGateConfig="$LockDir/nginx-api-gate.conf"
MaintenanceConfig="/etc/nginx/sites-available/turingmarket-maintenance"
ReplayRuntime="/run/turingmarket-release-replay-__RUN_ID__"
ReplaySocket="$ReplayRuntime/replay.sock"
ReplayHelper="$LiveDir/server/scripts/release_replay_gate.js"
ReplayEvidence="$AcceptedEvidenceRoot/replay-__RUN_ID__.json"
ReplayExpectedHeader="$ReplayRuntime/expected-header"
ReplayPending="$ReplayRuntime/probe.pending"
ReplayClaimed="$ReplayRuntime/probe.claimed"
ReplayResult="$ReplayRuntime/probe.result"
ReplayNginx="$LockDir/nginx-release-replay.conf"
ReplayProbe="$LockDir/release-replay-probe.json"
ReplayRequestBody="$LockDir/release-replay-request.json"
ReplayRequestHeaders="$LockDir/release-replay-request.headers"
ReplayRetryBody="$LockDir/release-replay-retry.body"
ReplayRetryHeaders="$LockDir/release-replay-retry.headers"
ReplayUnit="turingmarket-release-replay-gate-__STAMP__.service"

run_exact_public_nginx_gate() {
  local socket_path="$1"
  local port="$2"
  node - "$socket_path" "$port" <<'TM_EXACT_PUBLIC_NGINX_VERIFIER'
__EXACT_PUBLIC_NGINX_VERIFIER__
TM_EXACT_PUBLIC_NGINX_VERIFIER
}

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
  sync -f "$LockDir/phase.next"
  mv -f "$LockDir/phase.next" "$LockDir/phase"
  sync -f "$LockDir/phase"
  sync -f "$LockDir"
}

enter_all_traffic_maintenance() {
  cat > "$LockDir/nginx-maintenance.conf.next" <<'TM_MAINTENANCE_NGINX'
server {
    listen 80;
    server_name _;
    default_type application/json;
    add_header Retry-After 60 always;
    location / {
        return 503 '{"error":"MAINTENANCE","message":"Deployment in progress"}';
    }
}
TM_MAINTENANCE_NGINX
  install -o root -g root -m 0644 "$LockDir/nginx-maintenance.conf.next" "$MaintenanceConfig"
  ln -s "$MaintenanceConfig" "$LockDir/nginx-maintenance.link"
  mv -Tf "$LockDir/nginx-maintenance.link" /etc/nginx/sites-enabled/turingmarket
  nginx -t
  systemctl reload nginx

  expect_maintenance() {
    expected="$1"
    request_path="$2"
    actual=$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost$request_path")
    test "$actual" = "$expected"
  }
  expect_maintenance 503 /api/health
  expect_maintenance 503 /api/auth/login
  expect_maintenance 503 /m0
  printf '%s\n' 'ALL_TRAFFIC_MAINTENANCE_OK'
}

stop_and_quiesce_writers() {
  pm2 stop turingmarket
  TM_LIVE_DIR="$LiveDir" node <<'NODE'
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }));
const application = processes.find((entry) => entry && entry.name === 'turingmarket');
const status = application && application.pm2_env && application.pm2_env.status;
if (application && status !== 'stopped') throw new Error(`PM2 writer did not stop: ${status || 'unknown'}`);
const liveDir = path.resolve(process.env.TM_LIVE_DIR);
function insideLiveDir(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const relative = path.relative(liveDir, path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
for (const process of processes) {
  const environment = process && process.pm2_env;
  if (!environment || environment.status === 'stopped') continue;
  if (insideLiveDir(environment.pm_exec_path) || insideLiveDir(environment.pm_cwd)) {
    throw new Error(`A live-release PM2 writer survived shutdown: ${process.name || 'unnamed'}`);
  }
}
NODE
  command -v ss >/dev/null
  if ss -H -ltnp | awk '$4 ~ /:3002$/ { found=1 } END { exit(found ? 0 : 1) }'; then
    echo "A listener survived on production port 3002" >&2
    exit 1
  fi
  cd "$LiveDir/server"
  TM_QUIESCE_DB="$DatabasePath" node <<'NODE'
const Database = require('better-sqlite3');
const database = new Database(process.env.TM_QUIESCE_DB, { fileMustExist: true });
try {
  const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)');
  if (!Array.isArray(checkpoint) || checkpoint.some((row) => Number(row.busy) !== 0)) {
    throw new Error('SQLite WAL checkpoint remained busy');
  }
  database.exec('BEGIN EXCLUSIVE; COMMIT;');
  const quickCheck = database.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`Quiesced database quick_check failed: ${quickCheck}`);
  if (database.pragma('foreign_key_check').length !== 0) throw new Error('Quiesced database foreign_key_check failed');
} finally {
  database.close();
}
NODE
  test ! -s "$DatabasePath-wal"
  printf '%s\n' 'PM2_WRITERS_STOPPED'
}

create_cutover_snapshot() {
  SnapshotStage="$BackupAbsolute/.cutover-snapshot.__WRITER_TOKEN__"
  test ! -e "$CutoverSnapshot"
  test ! -e "$SnapshotStage"
  install -d -o root -g root -m 0700 \
    "$SnapshotStage" "$SnapshotStage/database" "$SnapshotStage/ppt-cache"

  DatabaseSourceShaBefore="$(sha256sum "$DatabasePath" | awk '{print $1}')"
  cache_manifest() {
    local root="$1"
    find "$root" -xdev -type f -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' artifact; do
      relative="${artifact#"$root/"}"
      printf '%s  %s\n' "$(sha256sum "$artifact" | awk '{print $1}')" "$relative"
    done
  }
  CacheSourceManifestBefore="$(cache_manifest "$PptCacheDir")"

  cd "$LiveDir/server"
  TM_SNAPSHOT_SOURCE_DB="$DatabasePath" \
  TM_SNAPSHOT_TARGET_DB="$SnapshotStage/database/turingmarket.db" \
  TM_SECURITY_OVERLAY="$SnapshotStage/security-overlay.json" \
  node <<'NODE'
const fs = require('node:fs');
const Database = require('better-sqlite3');
const sourcePath = process.env.TM_SNAPSHOT_SOURCE_DB;
const targetPath = process.env.TM_SNAPSHOT_TARGET_DB;
const overlayPath = process.env.TM_SECURITY_OVERLAY;
const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
async function main() {
  const users = database.prepare(`
    SELECT id,username,password_hash,is_active,role,department,api_quota
    FROM users
    ORDER BY id
  `).all();
  const overlay = JSON.stringify({ schemaVersion: 1, match: ['id', 'username'], users });
  const descriptor = fs.openSync(overlayPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, overlay, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  await database.backup(targetPath);
}
main().then(() => database.close()).catch((error) => {
  if (database.open) database.close();
  console.error(error.message);
  process.exitCode = 1;
});
NODE
  cp -a -- "$PptCacheDir/." "$SnapshotStage/ppt-cache/"

  cat > "$SnapshotStage/verify-ppt-ledger.js" <<'TM_PPT_LEDGER_TOOL'
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const mode = process.env.TM_PPT_LEDGER_MODE;
const databasePath = process.env.TM_PPT_LEDGER_DB;
const cacheRoot = fs.realpathSync(process.env.TM_PPT_CACHE_ROOT);
const ledgerPath = process.env.TM_PPT_LEDGER_PATH;
if (!['build', 'verify'].includes(mode)) throw new Error('Invalid PPT ledger mode');
if (!path.isAbsolute(databasePath) || !path.isAbsolute(cacheRoot) || !path.isAbsolute(ledgerPath)) {
  throw new Error('PPT ledger paths must be absolute');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function artifactFile(cacheKey) {
  return `${cacheKey}.pptx`;
}

function buildLedger() {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let rows;
  try {
    if (database.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new Error('PPT ledger database quick_check failed');
    }
    if (database.pragma('foreign_key_check').length !== 0) {
      throw new Error('PPT ledger database foreign_key_check failed');
    }
    rows = database.prepare(`
      SELECT
        id,state,response_cache_key,response_sha256,response_bytes,
        response_content_type,response_filename
      FROM request_idempotency
      WHERE state IN ('completed','expiring') AND response_kind='binary'
      ORDER BY response_cache_key,id
    `).all();
  } finally {
    database.close();
  }

  const artifacts = new Map();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.id) || row.id <= 0 ||
      !/^[0-9a-f]{64}$/.test(row.response_cache_key || '') ||
      !/^[0-9a-f]{64}$/.test(row.response_sha256 || '') ||
      !Number.isSafeInteger(row.response_bytes) || row.response_bytes < 0 ||
      row.response_content_type !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      typeof row.response_filename !== 'string' || row.response_filename.length === 0
    ) {
      throw new Error(`Invalid binary ledger row: ${row.id}`);
    }
    const fileName = artifactFile(row.response_cache_key);
    const target = path.join(cacheRoot, fileName);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Unsafe PPT cache artifact: ${fileName}`);
    }
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
      throw new Error(`PPT cache artifact mode is not 0600: ${fileName}`);
    }
    const actualSha256 = sha256(target);
    if (actualSha256 !== row.response_sha256 || stat.size !== row.response_bytes) {
      throw new Error(`PPT cache artifact does not match SQLite: ${fileName}`);
    }
    let artifact = artifacts.get(row.response_cache_key);
    if (!artifact) {
      artifact = {
        cacheKey: row.response_cache_key,
        fileName,
        sha256: row.response_sha256,
        bytes: row.response_bytes,
        contentType: row.response_content_type,
        references: []
      };
      artifacts.set(row.response_cache_key, artifact);
    } else if (
      artifact.sha256 !== row.response_sha256 ||
      artifact.bytes !== row.response_bytes ||
      artifact.contentType !== row.response_content_type
    ) {
      throw new Error(`Conflicting SQLite references for PPT cache artifact: ${fileName}`);
    }
    artifact.references.push({
      ledgerId: row.id,
      filename: row.response_filename,
      state: row.state
    });
  }

  const expectedFiles = new Set(Array.from(artifacts.values(), (artifact) => artifact.fileName));
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !expectedFiles.has(entry.name)) {
      throw new Error(`PPT cache file is not represented by SQLite: ${entry.name}`);
    }
  }
  if (fs.readdirSync(cacheRoot).length !== expectedFiles.size) {
    throw new Error('PPT cache tree does not have one file per SQLite artifact');
  }
  return {
    schemaVersion: 1,
    naming: '<response_cache_key>.pptx',
    artifacts: Array.from(artifacts.values())
  };
}

const actual = buildLedger();
if (mode === 'build') {
  const descriptor = fs.openSync(ledgerPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  console.log('PPT_LEDGER_BUILD_OK');
} else {
  const expected = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('PPT cache ledger differs from the restored DB/cache unit');
  }
  console.log('PPT_LEDGER_VERIFY_OK');
}
TM_PPT_LEDGER_TOOL
  chmod 0600 "$SnapshotStage/verify-ppt-ledger.js"
  NODE_PATH="$LiveDir/server/node_modules" \
  TM_PPT_LEDGER_MODE=build \
  TM_PPT_LEDGER_DB="$SnapshotStage/database/turingmarket.db" \
  TM_PPT_CACHE_ROOT="$SnapshotStage/ppt-cache" \
  TM_PPT_LEDGER_PATH="$SnapshotStage/ppt-ledger.json" \
  node "$SnapshotStage/verify-ppt-ledger.js"

  DatabaseSourceShaAfter="$(sha256sum "$DatabasePath" | awk '{print $1}')"
  CacheSourceManifestAfter="$(cache_manifest "$PptCacheDir")"
  test "$DatabaseSourceShaBefore" = "$DatabaseSourceShaAfter"
  test "$CacheSourceManifestBefore" = "$CacheSourceManifestAfter"

  cd "$SnapshotStage"
  sha256sum database/turingmarket.db > database.sha256
  sha256sum security-overlay.json > security-overlay.sha256
  sha256sum ppt-ledger.json > ppt-ledger.sha256
  cache_manifest "$SnapshotStage/ppt-cache" | sed 's#  #  ppt-cache/#' > ppt-cache.sha256
  sha256sum --check --status database.sha256
  sha256sum --check --status security-overlay.sha256
  sha256sum --check --status ppt-ledger.sha256
  if [ -s ppt-cache.sha256 ]; then sha256sum --check --status ppt-cache.sha256; fi
  find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum --check --status SHA256SUMS

  NODE_PATH="$LiveDir/server/node_modules" \
  TM_SNAPSHOT_DB="$SnapshotStage/database/turingmarket.db" \
  node <<'NODE'
const Database = require('better-sqlite3');
const database = new Database(process.env.TM_SNAPSHOT_DB, { readonly: true, fileMustExist: true });
try {
  if (database.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Cutover snapshot quick_check failed');
  if (database.pragma('foreign_key_check').length !== 0) throw new Error('Cutover snapshot foreign_key_check failed');
} finally {
  database.close();
}
NODE
  find "$SnapshotStage" -type f -exec chown root:root {} + -exec chmod 0600 {} +
  find "$SnapshotStage" -type d -exec chown root:root {} + -exec chmod 0700 {} +
  while IFS= read -r -d '' artifact; do sync -f "$artifact"; done < <(find "$SnapshotStage" -type f -print0)
  sync -f "$SnapshotStage"
  mv "$SnapshotStage" "$CutoverSnapshot"
  sync -f "$CutoverSnapshot"
  sync -f "$BackupAbsolute"
  printf '%s\n' 'CUTOVER_SNAPSHOT_OK'
}

archive_prior_current_marker() {
  install -d -o root -g root -m 0700 "$AcceptedEvidenceRoot"
  PriorSnapshot="$BackupAbsolute/accepted-marker/prior-current.json"
  PriorAbsent="$BackupAbsolute/accepted-marker/prior-current.absent"
  PriorArchive="$BackupAbsolute/accepted-marker/prior-current.archived.json"
  if [ -f "$PriorSnapshot" ]; then
    test ! -L "$PriorSnapshot"
    test -f "$CurrentAcceptedMarker"
    test ! -L "$CurrentAcceptedMarker"
    test "$(stat -c '%U:%G:%a:%h' "$CurrentAcceptedMarker")" = "root:root:600:1"
    cmp -s "$PriorSnapshot" "$CurrentAcceptedMarker"
    test ! -e "$PriorArchive"
    mv "$CurrentAcceptedMarker" "$PriorArchive"
    sync -f "$PriorArchive"
    sync -f "$AcceptedEvidenceRoot"
    test "$(sha256sum "$PriorSnapshot" | awk '{print $1}')" = "$(sha256sum "$PriorArchive" | awk '{print $1}')"
    LastGoodNext="$LastGoodMarker.next.__RUN_ID__"
    install -o root -g root -m 0600 "$PriorArchive" "$LastGoodNext"
    sync -f "$LastGoodNext"
    mv -f "$LastGoodNext" "$LastGoodMarker"
    sync -f "$LastGoodMarker"
    sync -f "$AcceptedEvidenceRoot"
  else
    test -f "$PriorAbsent"
    test ! -e "$CurrentAcceptedMarker"
  fi
  printf '%s\n' 'PRIOR_CURRENT_MARKER_ARCHIVED'
}

stage_nginx_candidate() {
  test ! -e "$StagedPublicNginx"
  install -o root -g root -m 0600 "$CandidateDir/nginx/turingmarket.conf" "$StagedPublicNginx"
  sha256sum "$StagedPublicNginx" > "$StagedPublicNginxSha"
  chmod 0600 "$StagedPublicNginxSha"
  cat > "$ApiGateConfig" <<'TM_NGINX_API_GATE'
server {
    listen 80;
    server_name _;
    default_type application/json;
    add_header Retry-After 60 always;
    location /api/ {
        return 503 '{"error":"ACCEPTANCE_GATE_CLOSED","message":"Candidate acceptance pending"}';
    }
    location / {
        return 503 '{"error":"MAINTENANCE","message":"Deployment in progress"}';
    }
}
TM_NGINX_API_GATE
  chmod 0600 "$ApiGateConfig"
  install -o root -g root -m 0644 "$ApiGateConfig" "$MaintenanceConfig"
  nginx -t
  systemctl reload nginx
  test "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost/api/health)" = "503"
  test ! -e "$CurrentAcceptedMarker"
  sync -f "$StagedPublicNginx"
  sync -f "$StagedPublicNginxSha"
  sync -f "$ApiGateConfig"
  sync -f "$LockDir"
  printf '%s\n' 'NGINX_CANDIDATE_STAGED_API_GATE_CLOSED'
}

assert_staged_nginx_candidate_behavior() (
  set -euo pipefail
  GateDir="$(mktemp -d /tmp/tm-nginx-public-gate.XXXXXX)"
  GateSocket="$GateDir/candidate.sock"
  GateSite="$GateDir/candidate-site.conf"
  GateConfig="$GateDir/nginx.conf"
  GatePid=''

  cleanup_staged_nginx_candidate() {
    candidate_status=$?
    trap - EXIT
    set +e
    if [ -n "$GatePid" ] && kill -0 "$GatePid" 2>/dev/null; then
      kill -TERM "$GatePid" 2>/dev/null
      wait "$GatePid" 2>/dev/null
    fi
    rm -rf -- "$GateDir"
    exit "$candidate_status"
  }
  trap cleanup_staged_nginx_candidate EXIT

  python3 - "$StagedPublicNginx" "$GateSite" "$GateSocket" <<'PY'
import os
import sys

sourcePath, targetPath, socketPath = sys.argv[1:]
with open(sourcePath, encoding='utf-8') as handle:
    source = handle.read()
needle = '    listen 80;'
if source.count(needle) != 1:
    raise SystemExit('Staged Nginx candidate must contain exactly one public listen directive')
rendered = source.replace(needle, f'    listen unix:{socketPath};')
descriptor = os.open(targetPath, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, rendered.encode('utf-8'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY

  cat > "$GateConfig" <<TM_NGINX_ISOLATED_CONFIG
worker_processes 1;
pid $GateDir/nginx.pid;
error_log $GateDir/error.log notice;
events { worker_connections 64; }
http {
    include /etc/nginx/mime.types;
    access_log off;
    include $GateSite;
}
TM_NGINX_ISOLATED_CONFIG
  chmod 0600 "$GateConfig"
  nginx -t -p "$GateDir/" -c "$GateConfig"
  nginx -p "$GateDir/" -c "$GateConfig" -g 'daemon off;' >"$GateDir/stdout.log" 2>"$GateDir/stderr.log" &
  GatePid=$!
  for attempt in $(seq 1 50); do
    if [ -S "$GateSocket" ]; then break; fi
    if ! kill -0 "$GatePid" 2>/dev/null; then
      cat "$GateDir/stderr.log" >&2
      exit 1
    fi
    sleep 0.1
  done
  if [ ! -S "$GateSocket" ]; then
    cat "$GateDir/stderr.log" >&2
    echo 'Isolated staged Nginx candidate did not create its socket' >&2
    exit 1
  fi
  run_exact_public_nginx_gate "$GateSocket" 0
  printf '%s\n' 'STAGED_EXACT_PUBLIC_NGINX_BEHAVIOR_OK'
)

arm_one_request_release_replay() {
  test "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost/api/health)" = "503"
  test ! -e "$CurrentAcceptedMarker"
  test ! -e "$ReplayRuntime"
  test ! -e "$ReplayEvidence"
  for artifact in "$ReplayProbe" "$ReplayRequestBody" "$ReplayRequestHeaders" "$ReplayRetryBody" "$ReplayRetryHeaders"; do
    test ! -e "$artifact"
    test ! -L "$artifact"
  done
  test -f "$ReplayHelper"
  test ! -L "$ReplayHelper"

  ReplayWwwGid="$(getent group www-data | cut -d: -f3)"
  case "$ReplayWwwGid" in
    ''|*[!0-9]*) echo "Invalid www-data group identity" >&2; exit 1 ;;
  esac
  NodeBin="$(command -v node)"
  test -x "$NodeBin"

  cd "$LiveDir/server"
  env -i \
    TM_REPLAY_DB="$DatabasePath" \
    TM_REPLAY_ENV="$LiveDir/.env" \
    TM_REPLAY_PROBE="$ReplayProbe" \
    TM_REPLAY_REQUEST_BODY="$ReplayRequestBody" \
    TM_REPLAY_REQUEST_HEADERS="$ReplayRequestHeaders" \
    TM_REPLAY_RUN_ID="__RUN_ID__" \
    "$NodeBin" <<'NODE'
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const runId = process.env.TM_REPLAY_RUN_ID;
if (!/^[0-9a-f]{32}$/.test(runId || '')) throw new Error('Invalid production replay run identity');
const environmentPath = fs.realpathSync(process.env.TM_REPLAY_ENV);
if (environmentPath !== '/etc/turingmarket/turingmarket.env') {
  throw new Error('Production replay environment is not authoritative');
}
const loaded = require('dotenv').config({ path: environmentPath, override: true });
if (loaded.error) throw loaded.error;
const { validateNetworkRuntimeConfig } = require('./config/runtime_config');
const { jwtSecret } = validateNetworkRuntimeConfig(process.env);

const probePath = process.env.TM_REPLAY_PROBE;
const bodyPath = process.env.TM_REPLAY_REQUEST_BODY;
const headersPath = process.env.TM_REPLAY_REQUEST_HEADERS;
const templateName = `Phase 4 production replay ${runId}`;
const idempotencyKey = `phase4.production.replay.${runId}`;
const requestId = `phase4-production-replay-${runId}`;
const scope = 'workflow.campaign-template.create';

function fsyncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeExclusive(target, bytes) {
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(target));
}

function replaceJson(target, value) {
  const temporary = `${target}.next`;
  writeExclusive(temporary, `${JSON.stringify(value)}\n`);
  fs.renameSync(temporary, target);
  fsyncDirectory(path.dirname(target));
}

function request(headers, body) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port: 3002,
      method: 'POST',
      path: '/api/workflow/templates',
      agent: false,
      timeout: 10_000,
      headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('aborted', () => reject(new Error('Direct production replay response aborted')));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    outgoing.once('timeout', () => outgoing.destroy(new Error('Direct production replay timed out')));
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

function proofCounts(database) {
  return {
    templates: database.prepare(`
      SELECT COUNT(*) AS count FROM workflow_templates
      WHERE name=? AND module='campaign'
    `).get(templateName).count,
    ledgers: database.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE scope=? AND idempotency_key=?
    `).get(scope, idempotencyKey).count
  };
}

async function main() {
  const database = new Database(process.env.TM_REPLAY_DB, { fileMustExist: true });
  database.pragma('busy_timeout = 5000');
  let token = null;
  let userId = null;
  let sessionInserted = false;
  try {
    const identity = database.prepare(`
      SELECT users.id AS user_id, organization_memberships.org_id, team_memberships.team_id
      FROM users
      JOIN organization_memberships
        ON organization_memberships.user_id=users.id
       AND organization_memberships.status='active'
      JOIN team_memberships
        ON team_memberships.user_id=users.id
       AND team_memberships.org_id=organization_memberships.org_id
       AND team_memberships.status='active'
      WHERE users.is_active=1 AND users.role='admin'
      ORDER BY users.id, organization_memberships.org_id, team_memberships.team_id
      LIMIT 1
    `).get();
    if (!identity || !Number.isSafeInteger(identity.user_id)) {
      throw new Error('No active production admin projection is available');
    }
    userId = identity.user_id;
    const baseline = proofCounts(database);
    if (baseline.templates !== 0 || baseline.ledgers !== 0) {
      throw new Error('Production replay fixture identity already exists');
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    token = jwt.sign({
      userId,
      role: 'admin',
      purpose: 'phase4-production-release-replay',
      runId,
      jti: crypto.randomUUID()
    }, jwtSecret, { algorithm: 'HS256', expiresIn: '15m' });
    const tokenSha256 = crypto.createHash('sha256').update(token).digest('hex');
    const body = Buffer.from(JSON.stringify({
      name: templateName,
      description: 'Deterministic Phase 4 production release replay fixture',
      module: 'campaign',
      category: 'approval',
      nodes: [],
      edges: []
    }), 'utf8');
    const requestBodySha256 = crypto.createHash('sha256').update(body).digest('hex');
    const requestHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      'X-Request-Id': requestId,
      'Idempotency-Key': idempotencyKey,
      Connection: 'close'
    };

    writeExclusive(probePath, `${JSON.stringify({
      schemaVersion: 1,
      state: 'session-prepared',
      runId,
      userId,
      organizationId: identity.org_id,
      teamId: identity.team_id,
      sessionToken: token,
      sessionTokenSha256: tokenSha256,
      expiresAt,
      templateName,
      idempotencyKey,
      requestId,
      scope,
      requestBodySha256,
      baseline
    })}\n`);
    writeExclusive(bodyPath, body);
    writeExclusive(headersPath, `${JSON.stringify(requestHeaders)}\n`);

    database.prepare(`
      INSERT INTO sessions (user_id,token,ip_address,expires_at)
      VALUES (?,?,'127.0.0.1',?)
    `).run(userId, token, expiresAt);
    sessionInserted = true;

    const first = await request(requestHeaders, body);
    if (first.statusCode !== 200) {
      throw new Error(`Direct production replay returned HTTP ${first.statusCode}`);
    }
    const counts = proofCounts(database);
    if (counts.templates !== 1 || counts.ledgers !== 1) {
      throw new Error(`Production replay mutation count is not one (${counts.templates}/${counts.ledgers})`);
    }
    const ledger = database.prepare(`
      SELECT state,status_code,response_kind,response_json
      FROM request_idempotency
      WHERE scope=? AND idempotency_key=?
    `).get(scope, idempotencyKey);
    if (!ledger || ledger.state !== 'completed' || ledger.status_code !== 200 ||
        ledger.response_kind !== 'json' || ledger.response_json !== first.body.toString('utf8')) {
      throw new Error('Direct production replay ledger evidence is invalid');
    }
    replaceJson(probePath, {
      schemaVersion: 1,
      state: 'direct-complete',
      runId,
      userId,
      organizationId: identity.org_id,
      teamId: identity.team_id,
      sessionToken: token,
      sessionTokenSha256: tokenSha256,
      expiresAt,
      templateName,
      idempotencyKey,
      requestId,
      scope,
      requestBodySha256,
      baseline,
      firstResponse: {
        statusCode: first.statusCode,
        contentType: String(first.headers['content-type'] || ''),
        contentLength: String(first.headers['content-length'] || ''),
        requestId: String(first.headers['x-request-id'] || ''),
        bodyBase64: first.body.toString('base64')
      },
      mutationCount: counts
    });
  } catch (error) {
    if (sessionInserted) {
      database.prepare('DELETE FROM sessions WHERE user_id=? AND token=?').run(userId, token);
    }
    throw error;
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
NODE
  for artifact in "$ReplayProbe" "$ReplayRequestBody" "$ReplayRequestHeaders"; do
    test -f "$artifact"
    test ! -L "$artifact"
    test "$(stat -c '%U:%G:%a:%h' "$artifact")" = "root:root:600:1"
    sync -f "$artifact"
  done
  sync -f "$LockDir"

  install -d -o root -g www-data -m 0710 "$ReplayRuntime"

  ClaimValue="$(openssl rand -hex 32)"
  test "${#ClaimValue}" = "64"
  printf '%s' "$ClaimValue" > "$ReplayExpectedHeader"
  chown root:root "$ReplayExpectedHeader"
  chmod 0600 "$ReplayExpectedHeader"
  sync -f "$ReplayExpectedHeader"
  ReplayHeaderSha="$(sha256sum "$ReplayExpectedHeader" | awk '{print $1}')"
  ReplayRunDigest="$(printf '%s' '__RUN_ID__' | sha256sum | awk '{print $1}')"

  python3 - "$ReplayPending" "__SOURCE_SHA256__" "$ReplayRunDigest" <<'PY'
import json
import os
import sys

target, source_digest, run_digest = sys.argv[1:]
payload = {
    'schema_version': 1,
    'source_digest': source_digest,
    'run_digest': run_digest,
}
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
directory = os.open(os.path.dirname(target), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY

  cat > "$ReplayNginx" <<TM_RELEASE_REPLAY_NGINX
server {
    listen 80;
    server_name _;
    default_type application/json;
    location = /api/workflow/templates {
        allow 127.0.0.1;
        deny all;
        proxy_http_version 1.1;
        proxy_set_header Connection close;
        proxy_set_header X-TM-Replay-Claim \$http_x_tm_replay_claim;
        proxy_set_header Content-Length \$http_content_length;
        proxy_pass http://unix:$ReplaySocket:/api/workflow/templates;
    }
    location / {
        return 503 '{"error":"MAINTENANCE","message":"Release replay in progress"}';
    }
}
TM_RELEASE_REPLAY_NGINX
  chown root:www-data "$ReplayNginx"
  chmod 0640 "$ReplayNginx"
  sync -f "$ReplayNginx"
  sync -f "$LockDir"
  test "$(stat -c '%U:%G:%a:%h' "$ReplayNginx")" = "root:www-data:640:1"

  replay_helper() {
    local mode="$1"
    env -i \
      TM_REPLAY_MODE="$mode" \
      TM_REPLAY_ROOT="$ReplayRuntime" \
      TM_REPLAY_METHOD=POST \
      TM_REPLAY_PATH=/api/workflow/templates \
      TM_REPLAY_HEADER_NAME=x-tm-replay-claim \
      TM_REPLAY_HEADER_SHA256="$ReplayHeaderSha" \
      TM_REPLAY_SOURCE_SHA256="__SOURCE_SHA256__" \
      TM_REPLAY_RUN_ID="__RUN_ID__" \
      TM_REPLAY_CANDIDATE_PORT=3002 \
      TM_REPLAY_WWW_DATA_GID="$ReplayWwwGid" \
      TM_REPLAY_MAX_BODY_BYTES=65536 \
      TM_REPLAY_MAX_HEADER_BYTES=4096 \
      TM_REPLAY_MAX_RESPONSE_BYTES=1048576 \
      TM_REPLAY_TIMEOUT_MS=10000 \
      TM_REPLAY_NGINX_BYPASS_PATH="$ReplayNginx" \
      "$NodeBin" "$ReplayHelper"
  }

  install -o root -g root -m 0600 /dev/null "$LockDir/release-replay.stdout.log"
  install -o root -g root -m 0600 /dev/null "$LockDir/release-replay.stderr.log"
  systemd-run --quiet --unit="$ReplayUnit" --service-type=exec \
    --uid=root --gid=root --property="WorkingDirectory=$LiveDir/server" \
    --property=KillMode=control-group \
    --property="StandardOutput=append:$LockDir/release-replay.stdout.log" \
    --property="StandardError=append:$LockDir/release-replay.stderr.log" \
    /usr/bin/env -i \
      TM_REPLAY_MODE=serve \
      TM_REPLAY_ROOT="$ReplayRuntime" \
      TM_REPLAY_METHOD=POST \
      TM_REPLAY_PATH=/api/workflow/templates \
      TM_REPLAY_HEADER_NAME=x-tm-replay-claim \
      TM_REPLAY_HEADER_SHA256="$ReplayHeaderSha" \
      TM_REPLAY_SOURCE_SHA256="__SOURCE_SHA256__" \
      TM_REPLAY_RUN_ID="__RUN_ID__" \
      TM_REPLAY_CANDIDATE_PORT=3002 \
      TM_REPLAY_WWW_DATA_GID="$ReplayWwwGid" \
      TM_REPLAY_MAX_BODY_BYTES=65536 \
      TM_REPLAY_MAX_HEADER_BYTES=4096 \
      TM_REPLAY_MAX_RESPONSE_BYTES=1048576 \
      TM_REPLAY_TIMEOUT_MS=10000 \
      TM_REPLAY_NGINX_BYPASS_PATH="$ReplayNginx" \
      "$NodeBin" "$ReplayHelper"

  for _attempt in $(seq 1 100); do
    [ -S "$ReplaySocket" ] && break
    sleep 0.1
  done
  test -S "$ReplaySocket"
  test ! -L "$ReplaySocket"
  test "$(stat -c '%U:%G:%a:%h' "$ReplaySocket")" = "root:www-data:660:1"
  ReplayVerify="$(replay_helper verify-state)"
  TM_REPLAY_VERIFY="$ReplayVerify" python3 - "__SOURCE_SHA256__" "$ReplayRunDigest" <<'PY'
import json
import os
import sys

evidence = json.loads(os.environ['TM_REPLAY_VERIFY'])
if evidence != {
    'ok': True,
    'mode': 'verify-state',
    'state': 'armed',
    'socket_present': True,
    'source_digest': sys.argv[1],
    'run_digest': sys.argv[2],
}:
    raise SystemExit('Release replay armed-state evidence is invalid')
PY

  install -o root -g root -m 0644 "$ReplayNginx" "$MaintenanceConfig"
  nginx -t
  systemctl reload nginx
  test "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost/not-the-replay-route)" = "503"
  cd "$LiveDir/server"
  TM_REPLAY_EXPECTED_HEADER="$ReplayExpectedHeader" \
  TM_REPLAY_REQUEST_BODY="$ReplayRequestBody" \
  TM_REPLAY_REQUEST_HEADERS="$ReplayRequestHeaders" \
  TM_REPLAY_RETRY_BODY="$ReplayRetryBody" \
  TM_REPLAY_RETRY_HEADERS="$ReplayRetryHeaders" \
  "$NodeBin" <<'NODE'
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function fsyncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeExclusive(target, bytes) {
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(target));
}

const body = fs.readFileSync(process.env.TM_REPLAY_REQUEST_BODY);
const headers = JSON.parse(fs.readFileSync(process.env.TM_REPLAY_REQUEST_HEADERS, 'utf8'));
const firstRequestId = String(headers['X-Request-Id'] || '');
const authorization = String(headers.Authorization || '');
const idempotencyKey = String(headers['Idempotency-Key'] || '');
if (!firstRequestId || !authorization || !idempotencyKey) {
  throw new Error('Persisted production replay headers are incomplete');
}
const retryRequestId = `phase4-production-retry-${crypto.randomBytes(16).toString('hex')}`;
if (retryRequestId === firstRequestId) {
  throw new Error('Production replay request IDs must differ');
}
headers['X-Request-Id'] = retryRequestId;
headers['X-TM-Replay-Claim'] = fs.readFileSync(process.env.TM_REPLAY_EXPECTED_HEADER, 'utf8');
const request = http.request({
  host: '127.0.0.1',
  port: 80,
  method: 'POST',
  path: '/api/workflow/templates',
  agent: false,
  timeout: 10_000,
  headers
}, (response) => {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.once('aborted', () => { throw new Error('Nginx production replay response aborted'); });
  response.once('end', () => {
    const responseBody = Buffer.concat(chunks);
    const responseRequestId = String(response.headers['x-request-id'] || '');
    if (responseRequestId !== retryRequestId) {
      throw new Error('Nginx production replay did not retain the distinct retry request ID');
    }
    writeExclusive(process.env.TM_REPLAY_RETRY_BODY, responseBody);
    writeExclusive(process.env.TM_REPLAY_RETRY_HEADERS, `${JSON.stringify({
      schemaVersion: 1,
      statusCode: response.statusCode,
      stableHeaders: {
        contentType: String(response.headers['content-type'] || ''),
        contentLength: String(response.headers['content-length'] || '')
      },
      firstRequestIdSha256: crypto.createHash('sha256').update(firstRequestId).digest('hex'),
      retryRequestIdSha256: crypto.createHash('sha256').update(retryRequestId).digest('hex'),
      responseRequestIdSha256: crypto.createHash('sha256').update(responseRequestId).digest('hex'),
      authorizationSha256: crypto.createHash('sha256').update(authorization).digest('hex'),
      idempotencyKeySha256: crypto.createHash('sha256').update(idempotencyKey).digest('hex'),
      requestBodySha256: crypto.createHash('sha256').update(body).digest('hex'),
      requestIdsDistinct: true
    })}\n`);
    if (response.statusCode !== 200) process.exitCode = 1;
  });
});
request.once('timeout', () => request.destroy(new Error('Nginx production replay timed out')));
request.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
request.end(body);
NODE
  for artifact in "$ReplayRetryBody" "$ReplayRetryHeaders"; do
    test -f "$artifact"
    test ! -L "$artifact"
    test "$(stat -c '%U:%G:%a:%h' "$artifact")" = "root:root:600:1"
  done

  for _attempt in $(seq 1 100); do
    [ -f "$ReplayClaimed" ] && [ -f "$ReplayResult" ] && break
    sleep 0.1
  done
  test -f "$ReplayClaimed"
  test ! -L "$ReplayClaimed"
  test "$(stat -c '%U:%G:%a:%h' "$ReplayClaimed")" = "root:root:600:1"
  test -f "$ReplayResult"
  test ! -L "$ReplayResult"
  test "$(stat -c '%U:%G:%a:%h' "$ReplayResult")" = "root:root:600:1"
  test ! -e "$ReplayPending"
  python3 - "$ReplayClaimed" "$ReplayResult" "__SOURCE_SHA256__" "$ReplayRunDigest" "$ReplayHeaderSha" <<'PY'
import json
import re
import sys

claim_path, result_path, source_digest, run_digest, header_digest = sys.argv[1:]
with open(claim_path, encoding='utf-8') as handle:
    claim = json.load(handle)
with open(result_path, encoding='utf-8') as handle:
    result = json.load(handle)
for evidence in (claim, result):
    if evidence.get('schema_version') != 1:
        raise SystemExit('Release replay evidence schema is invalid')
    if evidence.get('source_digest') != source_digest or evidence.get('run_digest') != run_digest:
        raise SystemExit('Release replay evidence identity is invalid')
if claim.get('expected_claim_digest') != header_digest:
    raise SystemExit('Release replay claim digest is invalid')
if result.get('outcome') != 'forwarded' or result.get('status_code') != 200:
    raise SystemExit('Release replay forwarding result is invalid')
if result.get('request_digest') != claim.get('request_digest'):
    raise SystemExit('Release replay request evidence does not match')
for field in ('request_digest', 'response_digest'):
    if not re.fullmatch(r'[0-9a-f]{64}', str(result.get(field, ''))):
        raise SystemExit('Release replay digest evidence is invalid')
PY

  cd "$LiveDir/server"
  TM_REPLAY_DB="$DatabasePath" \
  TM_REPLAY_PROBE="$ReplayProbe" \
  TM_REPLAY_RETRY_BODY="$ReplayRetryBody" \
  TM_REPLAY_RETRY_HEADERS="$ReplayRetryHeaders" \
  TM_REPLAY_RUN_ID="__RUN_ID__" \
  "$NodeBin" <<'NODE'
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const probePath = process.env.TM_REPLAY_PROBE;
const probe = JSON.parse(fs.readFileSync(probePath, 'utf8'));
const retryBody = fs.readFileSync(process.env.TM_REPLAY_RETRY_BODY);
const retry = JSON.parse(fs.readFileSync(process.env.TM_REPLAY_RETRY_HEADERS, 'utf8'));
const database = new Database(process.env.TM_REPLAY_DB, { fileMustExist: true });

function fsyncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function replaceJson(target, value) {
  const temporary = `${target}.next`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
  fsyncDirectory(path.dirname(target));
}

try {
  if (probe.schemaVersion !== 1 || probe.state !== 'direct-complete' ||
      probe.runId !== process.env.TM_REPLAY_RUN_ID ||
      crypto.createHash('sha256').update(probe.sessionToken).digest('hex') !== probe.sessionTokenSha256) {
    throw new Error('Production replay probe identity is invalid');
  }
  const firstBody = Buffer.from(probe.firstResponse.bodyBase64, 'base64');
  const stableFirst = {
    statusCode: probe.firstResponse.statusCode,
    contentType: probe.firstResponse.contentType,
    contentLength: probe.firstResponse.contentLength
  };
  const stableRetry = {
    statusCode: retry.statusCode,
    contentType: String(retry.stableHeaders && retry.stableHeaders.contentType || ''),
    contentLength: String(retry.stableHeaders && retry.stableHeaders.contentLength || '')
  };
  const firstRequestIdSha256 = crypto.createHash('sha256').update(probe.requestId).digest('hex');
  const expectedAuthorizationSha256 = crypto.createHash('sha256')
    .update(`Bearer ${probe.sessionToken}`).digest('hex');
  const expectedIdempotencyKeySha256 = crypto.createHash('sha256')
    .update(probe.idempotencyKey).digest('hex');
  if (retry.schemaVersion !== 1 || retry.requestIdsDistinct !== true ||
      retry.firstRequestIdSha256 !== firstRequestIdSha256 ||
      retry.retryRequestIdSha256 === firstRequestIdSha256 ||
      retry.responseRequestIdSha256 !== retry.retryRequestIdSha256 ||
      retry.authorizationSha256 !== expectedAuthorizationSha256 ||
      retry.idempotencyKeySha256 !== expectedIdempotencyKeySha256 ||
      retry.requestBodySha256 !== probe.requestBodySha256) {
    throw new Error('Production replay request identity or retained request bytes are invalid');
  }
  if (JSON.stringify(stableFirst) !== JSON.stringify(stableRetry) || !firstBody.equals(retryBody)) {
    throw new Error('Production replay stable status/content-type/content-length/body mismatch');
  }
  if (Number(stableRetry.contentLength) !== retryBody.length) {
    throw new Error('Production replay content-length does not match response bytes');
  }
  const template = database.prepare(`
    SELECT id,name,module,category,created_by
    FROM workflow_templates WHERE name=? AND module='campaign'
  `).all(probe.templateName);
  const ledgers = database.prepare(`
    SELECT scope,idempotency_key,state,status_code,response_kind,response_json,user_id
    FROM request_idempotency WHERE scope=? AND idempotency_key=?
  `).all(probe.scope, probe.idempotencyKey);
  if (template.length !== 1 || ledgers.length !== 1) {
    throw new Error(`Production replay mutation count changed (${template.length}/${ledgers.length})`);
  }
  if (template[0].created_by !== probe.userId || ledgers[0].user_id !== probe.userId ||
      ledgers[0].scope !== probe.scope || ledgers[0].idempotency_key !== probe.idempotencyKey ||
      ledgers[0].state !== 'completed' || ledgers[0].status_code !== 200 ||
      ledgers[0].response_kind !== 'json' || ledgers[0].response_json !== retryBody.toString('utf8')) {
    throw new Error('Production replay retained mutation evidence is invalid');
  }
  const removed = database.prepare('DELETE FROM sessions WHERE user_id=? AND token=?')
    .run(probe.userId, probe.sessionToken);
  if (removed.changes !== 1) throw new Error('Production replay session removal failed');
  replaceJson(probePath, {
    schemaVersion: 1,
    state: 'verified-session-removed',
    runId: probe.runId,
    userId: probe.userId,
    organizationId: probe.organizationId,
    teamId: probe.teamId,
    sessionTokenSha256: probe.sessionTokenSha256,
    templateName: probe.templateName,
    templateId: template[0].id,
    idempotencyKey: probe.idempotencyKey,
    scope: probe.scope,
    mutationCount: { workflowTemplates: 1, requestIdempotency: 1 },
    stableResponse: stableRetry,
    responseSha256: crypto.createHash('sha256').update(retryBody).digest('hex'),
    firstRequestIdSha256,
    retryRequestIdSha256: retry.retryRequestIdSha256,
    requestIdsDistinct: true,
    requestIdExcludedFromStableComparison: true,
    sessionRemoved: true
  });
} finally {
  if (probe && probe.sessionToken && Number.isSafeInteger(probe.userId)) {
    database.prepare('DELETE FROM sessions WHERE user_id=? AND token=?').run(probe.userId, probe.sessionToken);
  }
  database.close();
}
NODE
  test "$(stat -c '%U:%G:%a:%h' "$ReplayProbe")" = "root:root:600:1"

  # Close the public-facing bypass before stopping or cleaning the one-use helper.
  install -o root -g root -m 0644 "$ApiGateConfig" "$MaintenanceConfig"
  nginx -t
  systemctl reload nginx
  test "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost/api/health)" = "503"
  test ! -e "$CurrentAcceptedMarker"

  test "$(systemctl show "$ReplayUnit" --property=User --value)" = "root"
  test "$(systemctl show "$ReplayUnit" --property=WorkingDirectory --value)" = "$LiveDir/server"
  systemctl stop "$ReplayUnit"
  for _attempt in $(seq 1 50); do
    [ "$(systemctl show "$ReplayUnit" --property=MainPID --value 2>/dev/null || printf 0)" = "0" ] && break
    sleep 0.1
  done
  test "$(systemctl show "$ReplayUnit" --property=MainPID --value 2>/dev/null || printf 0)" = "0"
  replay_helper cleanup >/dev/null
  systemctl reset-failed "$ReplayUnit" >/dev/null 2>&1 || true
  test ! -e "$ReplaySocket"
  test ! -e "$ReplayExpectedHeader"
  test ! -e "$ReplayPending"
  test ! -e "$ReplayNginx"
  test ! -e "$ReplayRuntime/probe.pid"
  test -f "$ReplayClaimed"
  test -f "$ReplayResult"
  ReplayAuditEntries="$(find "$ReplayRuntime" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
  test "$ReplayAuditEntries" = "$(printf '%s\n' probe.claimed probe.result)"

  install -d -o root -g root -m 0700 "$AcceptedEvidenceRoot"
  python3 - "$ReplayClaimed" "$ReplayResult" "$ReplayProbe" "$ReplayEvidence.next" "$ReplayEvidence" "__RUN_ID__" "__SOURCE_SHA256__" <<'PY'
import datetime
import json
import os
import sys

claim_path, result_path, projection_path, temporary, target, run_id, source_digest = sys.argv[1:]
with open(claim_path, encoding='utf-8') as handle:
    claim = json.load(handle)
with open(result_path, encoding='utf-8') as handle:
    result = json.load(handle)
with open(projection_path, encoding='utf-8') as handle:
    production_projection = json.load(handle)
if production_projection.get('state') != 'verified-session-removed' or production_projection.get('runId') != run_id:
    raise SystemExit('Production projection audit evidence is invalid')
payload = {
    'schemaVersion': 1,
    'runId': run_id,
    'sourceSha256': source_digest,
    'claim': claim,
    'result': result,
    'productionProjection': production_projection,
    'archivedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.link(temporary, target)
directory = os.open(os.path.dirname(target), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
os.unlink(temporary)
directory = os.open(os.path.dirname(target), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  chown root:root "$ReplayEvidence"
  chmod 0600 "$ReplayEvidence"
  sync -f "$ReplayEvidence"
  sync -f "$AcceptedEvidenceRoot"
  test "$(stat -c '%U:%G:%a:%h' "$ReplayEvidence")" = "root:root:600:1"
  ReplayEvidenceSha="$(sha256sum "$ReplayEvidence" | awk '{print $1}')"
  rm -f -- "$ReplayClaimed" "$ReplayResult" "$ReplayProbe" "$ReplayRequestBody" \
    "$ReplayRequestHeaders" "$ReplayRetryBody" "$ReplayRetryHeaders"
  sync -f "$ReplayRuntime"
  sync -f "$LockDir"
  rmdir "$ReplayRuntime"
  sync -f /run

  test ! -e "$ReplayRuntime"
  test ! -e "$ReplaySocket"
  test ! -e "$ReplayExpectedHeader"
  test ! -e "$ReplayPending"
  test ! -e "$ReplayNginx"
  test "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost/api/health)" = "503"
  test "$(systemctl show "$ReplayUnit" --property=MainPID --value 2>/dev/null || printf 0)" = "0"
  printf '%s\n' 'RELEASE_REPLAY_EXACTLY_ONE_OK'
}

install_current_accepted_marker() {
  NginxSha="$(awk 'NR == 1 {print $1}' "$StagedPublicNginxSha")"
  test "$(sha256sum "$StagedPublicNginx" | awk '{print $1}')" = "$NginxSha"
  test ! -e "$CurrentAcceptedMarker"
  CurrentNext="$AcceptedEvidenceRoot/.current-accepted.__RUN_ID__.next"
  test ! -e "$CurrentNext"
  python3 - \
    "$CurrentNext" \
    "$CurrentAcceptedMarker" \
    "__RUN_ID__" \
    "__BACKUP_PATH__" \
    "__SOURCE_IDENTITY__" \
    "__SOURCE_SHA256__" \
    "$ExpectedCandidateDigest" \
    "$NginxSha" <<'PY'
import datetime
import json
import os
import sys

temporary, current, runId, backupPath, sourceIdentity, sourceSha256, candidateSha256, nginxSha256 = sys.argv[1:]
payload = {
    'schemaVersion': 1,
    'runId': runId,
    'backupPath': backupPath,
    'sourceIdentity': sourceIdentity,
    'sourceSha256': sourceSha256,
    'candidateSha256': candidateSha256,
    'nginxSha256': nginxSha256,
    'acceptedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
# Hard-link publication is atomic and no-replace; unlinking the staging name restores nlink=1.
os.link(temporary, current)
os.unlink(temporary)
directory = os.open(os.path.dirname(current), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  chown root:root "$CurrentAcceptedMarker"
  chmod 0600 "$CurrentAcceptedMarker"
  sync -f "$CurrentAcceptedMarker"
  sync -f "$AcceptedEvidenceRoot"
  test "$(stat -c '%U:%G:%a:%h' "$CurrentAcceptedMarker")" = "root:root:600:1"
  printf '%s\n' 'CURRENT_MARKER_DURABLE'
}

activate_public_candidate() {
  test -f "$CurrentAcceptedMarker"
  test ! -L "$CurrentAcceptedMarker"
  test "$(stat -c '%U:%G:%a:%h' "$CurrentAcceptedMarker")" = "root:root:600:1"
  python3 - "$CurrentAcceptedMarker" "__RUN_ID__" "$ExpectedCandidateDigest" <<'PY'
import json
import sys
markerPath, runId, candidateSha256 = sys.argv[1:]
with open(markerPath, encoding='utf-8') as handle:
    marker = json.load(handle)
if marker.get('runId') != runId or marker.get('candidateSha256') != candidateSha256:
    raise SystemExit('Current accepted marker does not authorize this release')
PY
  test "$(sha256sum "$StagedPublicNginx" | awk '{print $1}')" = "$(awk 'NR == 1 {print $1}' "$StagedPublicNginxSha")"
  cmp -s "$StagedPublicNginx" "$LiveDir/nginx/turingmarket.conf"
  install -m 0644 "$LiveDir/nginx/turingmarket.conf" /etc/nginx/sites-available/turingmarket
  ln -s /etc/nginx/sites-available/turingmarket "$LockDir/nginx-public.link"
  mv -Tf "$LockDir/nginx-public.link" /etc/nginx/sites-enabled/turingmarket
  nginx -t
  systemctl reload nginx
  printf '%s\n' 'PUBLIC_TRAFFIC_RESTORED'
}

record_phase mutation-intent
enter_all_traffic_maintenance
record_phase maintenance-entered
stop_and_quiesce_writers
record_phase writers-stopped
create_cutover_snapshot
record_phase snapshot-ready
archive_prior_current_marker
record_phase prior-marker-archived
stage_nginx_candidate
record_phase nginx-candidate-staged
record_phase mutation-started

cd "$RemoteRoot"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  mkdir -p "$(dirname "$file")"
  cp -- "$ReleaseRoot/$file" "$file"
done < "$BackupAbsolute/root-files.requested"

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

# INVALIDATE_SESSIONS
cd "$LiveDir/server"
node <<'NODE'
const Database = require('better-sqlite3');
const database = new Database('db/turingmarket.db');
try {
  const removed = database.transaction(() => database.prepare('DELETE FROM sessions').run())();
  const remaining = database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
  if (remaining !== 0) throw new Error('Session invalidation verification failed');
  console.log(`SESSIONS_INVALIDATED=${removed.changes}`);
  console.log('SESSIONS_REMAINING=0');
} finally {
  database.close();
}
NODE

cd "$LiveDir"
export SERVER_HOST=127.0.0.1
pm2 restart ecosystem.config.js --only turingmarket --update-env || pm2 start ecosystem.config.js --only turingmarket --update-env

for attempt in $(seq 1 __MAINTENANCE_TIMEOUT_SECONDS__); do
  if curl -fsS http://localhost:3002/api/health >/dev/null; then
    break
  fi
  if [ "$attempt" = "__MAINTENANCE_TIMEOUT_SECONDS__" ]; then
    echo "Health check failed after process restart" >&2
    exit 1
  fi
  sleep 1
done
printf '%s\n' 'LOOPBACK_CANDIDATE_HEALTH_OK'

expect_loopback_status() {
  expected="$1"
  request_path="$2"
  actual=$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:3002$request_path")
  if [ "$actual" != "$expected" ]; then
    echo "Loopback $request_path returned $actual; expected $expected" >&2
    exit 1
  fi
}
expect_loopback_javascript() {
  request_path="$1"
  response=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "http://localhost:3002$request_path")
  actual="${response%% *}"
  content_type="${response#* }"
  if [ "$actual" != "200" ]; then
    echo "Loopback $request_path returned $actual; expected 200" >&2
    exit 1
  fi
  case "$content_type" in
    application/javascript|application/javascript\;*|text/javascript|text/javascript\;*) ;;
    *)
      echo "Loopback $request_path returned Content-Type '$content_type'; expected JavaScript" >&2
      exit 1
      ;;
  esac
}
expect_loopback_stylesheet() {
  request_path="$1"
  response=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "http://localhost:3002$request_path")
  actual="${response%% *}"
  content_type="${response#* }"
  if [ "$actual" != "200" ]; then
    echo "Loopback $request_path returned $actual; expected 200" >&2
    exit 1
  fi
  case "$content_type" in
    text/css|text/css\;*) ;;
    *)
      echo "Loopback $request_path returned Content-Type '$content_type'; expected CSS" >&2
      exit 1
      ;;
  esac
}
expect_loopback_status 200 /api/health
expect_loopback_status 200 /m0
expect_loopback_status 200 /m0-detail
expect_loopback_status 200 /m4
expect_loopback_status 200 /admin
expect_loopback_javascript /client/shared/build_info.js
expect_loopback_javascript /client/core/navigation.js
expect_loopback_javascript /client/core/accessibility.js
expect_loopback_javascript /client/core/shell.js
expect_loopback_javascript /client/core/csp_compat.js
expect_loopback_javascript /client/features/ppt_preview_runtime.js
expect_loopback_stylesheet /client/styles/tokens.css
expect_loopback_stylesheet /client/styles/components.css
expect_loopback_stylesheet /client/styles/layout.css
expect_loopback_status 404 /client/unknown.js
expect_loopback_status 404 /server/server.js
assert_staged_nginx_candidate_behavior

arm_one_request_release_replay
record_phase release-replay-complete

install -d -o root -g root -m 0700 "$AcceptedEvidenceRoot"
test ! -e "$AcceptedEvidence"
python3 - \
  "$AcceptedEvidence.next" \
  "__RUN_ID__" \
  "__SOURCE_IDENTITY__" \
  "__SOURCE_SHA256__" \
  "$ExpectedCandidateDigest" \
  "$ReplayEvidenceSha" <<'PY'
import datetime
import json
import os
import sys

target, runId, sourceIdentity, sourceSha256, candidateSha256, replayEvidenceSha256 = sys.argv[1:]
payload = {
    'schemaVersion': 1,
    'runId': runId,
    'sourceIdentity': sourceIdentity,
    'sourceSha256': sourceSha256,
    'candidateSha256': candidateSha256,
    'replayEvidenceSha256': replayEvidenceSha256,
    'acceptedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
chown root:root "$AcceptedEvidence.next"
chmod 0600 "$AcceptedEvidence.next"
mv "$AcceptedEvidence.next" "$AcceptedEvidence"
sync -f "$AcceptedEvidence"
sync -f "$AcceptedEvidenceRoot"
test "$(stat -c '%U:%G:%a:%h' "$AcceptedEvidence")" = "root:root:600:1"
printf '%s\n' 'ACCEPTED_EVIDENCE_DURABLE'

printf '%s\n' "$ExpectedCandidateDigest" > "$LockDir/accepted.next"
sync -f "$LockDir/accepted.next"
mv -f "$LockDir/accepted.next" "$AcceptedMarker"
sync -f "$AcceptedMarker"
install_current_accepted_marker
record_phase accepted
printf '%s\n' 'CURRENT_ACCEPTED_MARKER_DURABLE'
sync -f "$LockDir"
printf '%s\n' 'ACCEPTED_MARKER_DURABLE'
activate_public_candidate
record_phase accepted-public-enabled
expect_status() {
  expected="$1"
  request_path="$2"
  actual=$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost$request_path")
  if [ "$actual" != "$expected" ]; then
    echo "$request_path returned $actual; expected $expected" >&2
    exit 1
  fi
}
expect_javascript() {
  request_path="$1"
  response=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "http://localhost$request_path")
  actual="${response%% *}"
  content_type="${response#* }"
  if [ "$actual" != "200" ]; then
    echo "$request_path returned $actual; expected 200" >&2
    exit 1
  fi
  case "$content_type" in
    application/javascript|application/javascript\;*|text/javascript|text/javascript\;*) ;;
    *)
      echo "$request_path returned Content-Type '$content_type'; expected JavaScript" >&2
      exit 1
      ;;
  esac
}
expect_stylesheet() {
  request_path="$1"
  response=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "http://localhost$request_path")
  actual="${response%% *}"
  content_type="${response#* }"
  if [ "$actual" != "200" ]; then
    echo "$request_path returned $actual; expected 200" >&2
    exit 1
  fi
  case "$content_type" in
    text/css|text/css\;*) ;;
    *)
      echo "$request_path returned Content-Type '$content_type'; expected CSS" >&2
      exit 1
      ;;
  esac
}
expect_status 200 /api/health
expect_status 200 /m0
expect_status 200 /m0-detail
expect_status 200 /m4
expect_status 200 /admin
expect_javascript /client/shared/build_info.js
expect_javascript /client/core/navigation.js
expect_javascript /client/core/accessibility.js
expect_javascript /client/core/shell.js
expect_javascript /client/core/csp_compat.js
expect_javascript /client/features/ppt_preview_runtime.js
expect_stylesheet /client/styles/tokens.css
expect_stylesheet /client/styles/components.css
expect_stylesheet /client/styles/layout.css
expect_status 404 /client/unknown.js
expect_status 404 /server/server.js
run_exact_public_nginx_gate - 80

rm -f -- "$MaintenanceConfig"

rm -rf "$ReleaseRoot"

record_phase cutover-complete
release_writer
echo "DEPLOY_OK"
'@
    $cutoverGate = $cutoverGate.Replace('__REMOTE_DIR__', $REMOTE_DIR)
    $cutoverGate = $cutoverGate.Replace('__REMOTE_ROOT__', $REMOTE_ROOT)
    $cutoverGate = $cutoverGate.Replace('__RELEASE_ROOT__', $remoteReleaseRoot)
    $cutoverGate = $cutoverGate.Replace('__CANDIDATE_DIR__', $remoteCandidateDir)
    $cutoverGate = $cutoverGate.Replace('__BACKUP_PATH__', $backupDir)
    $cutoverGate = $cutoverGate.Replace('__MAINTENANCE_TIMEOUT_SECONDS__', $MaintenanceTimeoutSeconds.ToString())
    $cutoverGate = $cutoverGate.Replace('__LOCK_TOKEN__', $deploymentLockToken)
    $cutoverGate = $cutoverGate.Replace('__WRITER_TOKEN__', $deploymentWriterToken)
    $cutoverGate = $cutoverGate.Replace('__RUN_ID__', $deploymentRunId)
    $cutoverGate = $cutoverGate.Replace('__SOURCE_IDENTITY__', $deploymentSourceIdentity)
    $cutoverGate = $cutoverGate.Replace('__SOURCE_SHA256__', $deploymentSourceSha256)
    $cutoverGate = $cutoverGate.Replace('__EXACT_PUBLIC_NGINX_VERIFIER__', $exactPublicNginxVerifier)
    Invoke-RemoteBash -Script $cutoverGate -FailureMessage "Remote atomic release failed" -RequireDeploymentLock
    Invoke-RemoteRetentionCleanup -BackupPath $backupDir -ReleaseRoot $remoteReleaseRoot

    Exit-RemoteDeploymentLock
    $deploymentLockAcquired = $false
}
catch {
    $deployError = $_
    if (-not $deploymentLockAcquired) {
        throw $deployError
    }

    try {
        $recoveryMetadata = Get-RemoteDeploymentRunMetadata
        if (
            [string]$recoveryMetadata.backupPath -ne $backupDir -or
            [string]$recoveryMetadata.releaseRoot -ne $remoteReleaseRoot -or
            -not [string]::IsNullOrWhiteSpace([string]$recoveryMetadata.quarantinePath)
        ) {
            throw "Remote recovery metadata no longer matches this deployment generation."
        }
        $backupCreated = [bool]$recoveryMetadata.backupReady
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
