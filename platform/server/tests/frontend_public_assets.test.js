const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');

const platformRoot = path.join(__dirname, '..', '..');
const indexPath = path.join(platformRoot, 'index.html');
const appPath = path.join(platformRoot, 'app.js');
const navigationPath = path.join(platformRoot, 'client', 'core', 'navigation.js');
const accessibilityPath = path.join(platformRoot, 'client', 'core', 'accessibility.js');
const shellPath = path.join(platformRoot, 'client', 'core', 'shell.js');
const cspCompatPath = path.join(platformRoot, 'client', 'core', 'csp_compat.js');
const pptPreviewRuntimePath = path.join(platformRoot, 'client', 'features', 'ppt_preview_runtime.js');
const buildInfoPath = path.join(platformRoot, 'client', 'shared', 'build_info.js');
const deployScriptPath = path.join(platformRoot, 'deploy_v8.ps1');
const nginxConfigPath = path.join(platformRoot, 'nginx', 'turingmarket.conf');
const publicAssetsServicePath = path.join(platformRoot, 'server', 'services', 'public_assets_service.js');
const publicAssets = require('../services/public_assets_service');
const gitBash = process.env.GIT_BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe';
const hasBash = process.platform !== 'win32' || fs.existsSync(gitBash);

const EXPECTED_APP_BUILD = '20260811-v060-crm-sales-workspace';
const EXPECTED_APP_QUERY = '20260811v060crmsalesworkspace';
const EXPECTED_PPT_BUILD = '20260702-v916-kb-bridge-client-cn';
const EXPECTED_PPT_QUERY = '20260702v916kbbridge';
const EXPECTED_SECURITY_QUERY = '20260714v050campaignbusinessspine';
const EXPECTED_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'";
const CANONICAL_CLIENT_ASSETS = Object.freeze([
  'client/shared/build_info.js',
  'client/core/navigation.js',
  'client/core/accessibility.js',
  'client/core/shell.js',
  'client/styles/tokens.css',
  'client/styles/components.css',
  'client/styles/layout.css',
  'client/core/csp_compat.js',
  'client/features/ppt_preview_runtime.js'
]);
const AST_FIXTURE_CLIENT_ASSETS = Object.freeze(CANONICAL_CLIENT_ASSETS.slice(-2));
const REQUIRED_PARSER_RUNTIME_ARTIFACTS = Object.freeze([
  'server/scripts/parse_upload_sandbox.sh',
  'server/systemd/turingmarket-parser.manifest.json',
  'server/systemd/turingmarket-parser.slice',
  'server/systemd/turingmarket-parser@.service'
]);

function assertRequiredParserRuntimeArtifacts(deployFiles) {
  const normalizedEntries = deployFiles.map((entry) => String(entry).replace(/\\/g, '/'));
  const packagedParserArtifacts = normalizedEntries
    .filter((entry) =>
      entry.startsWith('server/scripts/parse_upload_sandbox')
      || entry.startsWith('server/systemd/turingmarket-parser')
    );
  assert.deepEqual(
    [...packagedParserArtifacts].sort(),
    [...REQUIRED_PARSER_RUNTIME_ARTIFACTS].sort(),
    'FILES must package the exact required parser runtime artifacts'
  );
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function assertExactClientAssetInventory(actualEntries, inventoryName) {
  const normalizedEntries = actualEntries.map((entry) => String(entry)
    .replace(/^\/+/, '')
    .replace(/\\/g, '/'));
  assert.equal(
    new Set(normalizedEntries).size,
    normalizedEntries.length,
    `${inventoryName} must not contain duplicate client assets`
  );
  assert.deepEqual(
    [...normalizedEntries].sort(),
    [...CANONICAL_CLIENT_ASSETS].sort(),
    `${inventoryName} must equal the canonical nine client assets`
  );
}

function expressAllowedClientRoutes() {
  const setInitializers = [];
  class CapturingSet extends Set {
    constructor(entries = []) {
      const initializer = Array.from(entries);
      super(initializer);
      setInitializers.push(initializer);
    }
  }
  const moduleRecord = { exports: {} };
  vm.runInNewContext(
    read(publicAssetsServicePath),
    { module: moduleRecord, exports: moduleRecord.exports, require, Set: CapturingSet },
    { filename: publicAssetsServicePath }
  );
  const clientInitializers = setInitializers.filter((entries) =>
    entries.length > 0 && entries.every((entry) => String(entry).startsWith('/client/'))
  );
  assert.equal(clientInitializers.length, 1, 'Express must declare one client allowlist Set');
  return clientInitializers[0];
}

function scriptSources(indexHtml) {
  return Array.from(indexHtml.matchAll(/<script\s+src=["']([^"']+)["']\s*><\/script>/g))
    .map((match) => match[1]);
}

function exactNginxLocationBlock(config, requestPath) {
  const marker = `location = ${requestPath} {`;
  const start = config.indexOf(marker);
  assert.notEqual(start, -1, `Nginx exact location for ${requestPath}`);

  let depth = 0;
  for (let index = start; index < config.length; index += 1) {
    if (config[index] === '{') depth += 1;
    if (config[index] === '}') {
      depth -= 1;
      if (depth === 0) return config.slice(start, index + 1);
    }
  }
  assert.fail(`Nginx location block for ${requestPath} must close`);
}

function powerShellArrayEntries(source, variableName) {
  const assignments = Array.from(source.matchAll(
    new RegExp(`\\$${variableName}\\s*(?<operator>\\+=|-=|\\*=|/=|%=|=)`, 'gi')
  ));
  assert.equal(assignments.length, 1, `$${variableName} must have one assignment`);
  assert.equal(assignments[0].groups.operator, '=', `$${variableName} must not be appended or reassigned`);

  const assignmentEnd = assignments[0].index + assignments[0][0].length;
  const arrayStart = source.slice(assignmentEnd).match(
    /^\s*(?:\[Array\]::AsReadOnly\(\[string\[\]\]\s*)?@\(/i
  );
  assert.ok(arrayStart, `$${variableName} must use a static array expression`);
  const bodyStart = assignmentEnd + arrayStart[0].length;
  let depth = 1;
  let quote = null;
  let bodyEnd = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const previous = index > bodyStart ? source[index - 1] : '';
    if (quote) {
      if (character === quote && previous !== '`') quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = index;
        break;
      }
    }
  }
  assert.notEqual(bodyEnd, -1, `$${variableName} array must close`);
  const body = source.slice(bodyStart, bodyEnd);
  const entries = Array.from(body.matchAll(/["']([^"'\r\n]+)["']/g), (entry) => entry[1].replace(/\\/g, '/'));
  const residue = body.replace(/["'][^"'\r\n]+["']/g, '').replace(/[\s,]/g, '');
  assert.equal(residue, '', `$${variableName} must contain only static string entries`);
  return entries;
}

function powerShellSingleQuotedHereString(source, variableName) {
  const assignment = new RegExp(`\\$${variableName}\\s*=\\s*@'\\r?\\n`, 'i').exec(source);
  assert.ok(assignment, `$${variableName} must have a single-quoted here-string assignment`);
  const bodyStart = assignment.index + assignment[0].length;
  const closing = /\r?\n'@/.exec(source.slice(bodyStart));
  assert.ok(closing, `$${variableName} single-quoted here-string must close`);
  return source.slice(bodyStart, bodyStart + closing.index);
}

function exactPublicNginxVerifierSource() {
  const deploy = read(deployScriptPath);
  const beginMarker = '// TM_EXACT_PUBLIC_NGINX_BEHAVIOR_V1_BEGIN';
  const endMarker = '// TM_EXACT_PUBLIC_NGINX_BEHAVIOR_V1_END';
  const begin = deploy.indexOf(beginMarker);
  const end = deploy.indexOf(endMarker, begin + beginMarker.length);
  assert.ok(begin >= 0 && end > begin, 'exact public Nginx behavior verifier must be embedded once');
  return deploy.slice(begin, end + endMarker.length);
}

function acceptedFinalizeSource() {
  const deploy = read(deployScriptPath);
  const start = deploy.indexOf('function Invoke-RemoteAcceptedFinalize');
  const end = deploy.indexOf('function Invoke-RemoteCandidateCleanup', start);
  assert.ok(start >= 0 && end > start, 'accepted-finalize source must be present');
  return deploy.slice(start, end);
}

function bashPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  return `/${filePath[0].toLowerCase()}${filePath.slice(2).replaceAll('\\', '/')}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function runAcceptedFinalizeRecoveryHarness(mode) {
  const finalize = acceptedFinalizeSource();
  const recovery = finalize.match(
    /^recover_accepted_finalize_public_failure\(\)\s*\{\r?\n[\s\S]*?^\}/m
  );
  assert.ok(recovery, 'accepted-finalize must define its fail-closed public recovery handler');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-finalize-recovery-${mode}-`));
  const apiGate = path.join(root, 'nginx-api-gate.conf');
  const publicConfig = path.join(root, 'turingmarket.conf');
  const acceptedMarker = path.join(root, 'accepted-published');
  const finalizationMarker = path.join(root, 'finalization-published');
  const recoveryLog = path.join(root, 'recovery.log');
  const guardState = path.join(root, 'public-gate-guard');
  const recoveryLink = path.join(root, 'public-gate.link');
  fs.writeFileSync(apiGate, 'CLOSED_API_GATE\n', 'utf8');
  fs.writeFileSync(publicConfig, 'FAILING_PUBLIC_CONFIG\n', 'utf8');

  const command = process.platform === 'win32' ? gitBash : 'bash';
  const source = `
set -eEuo pipefail
ApiGateConfig=${shellQuote(bashPath(apiGate))}
MaintenanceConfig=${shellQuote(bashPath(publicConfig))}
PublicGuardState=${shellQuote(bashPath(guardState))}
PublicGuardRecoveryLink=${shellQuote(bashPath(recoveryLink))}
PublicNginxConfig=${shellQuote(bashPath(publicConfig))}
RunId=0123456789abcdef0123456789abcdef
RecoveryLog=${shellQuote(bashPath(recoveryLog))}
AcceptedPublication=${shellQuote(bashPath(acceptedMarker))}
FinalizationPublication=${shellQuote(bashPath(finalizationMarker))}
install() {
  local source_path="\${@: -2:1}"
  local target_path="\${@: -1}"
  command cp -- "$source_path" "$target_path"
}
nginx() { printf 'nginx:%s\\n' "$*" >> "$RecoveryLog"; }
systemctl() { printf 'systemctl:%s\\n' "$*" >> "$RecoveryLog"; }
public_release_guard() {
  local mode="$1"
  shift
  local source_path=""
  local target_path=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --maintenance-source) source_path="$2"; shift 2 ;;
      --maintenance-config) target_path="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf 'guard:%s\\n' "$mode" >> "$RecoveryLog"
  command cp -- "$source_path" "$target_path"
  nginx -t
  systemctl reload nginx
}
${recovery[0]}
finalize_public_gate_armed=1
trap 'recover_accepted_finalize_public_failure $?' ERR EXIT
false
trap - ERR EXIT HUP INT TERM
printf accepted > "$AcceptedPublication"
printf finalized > "$FinalizationPublication"
`;
  try {
    const result = spawnSync(command, ['--noprofile', '--norc', '-s'], {
      input: source,
      encoding: 'utf8',
      timeout: 10_000
    });
    return {
      result,
      publicConfig: fs.readFileSync(publicConfig, 'utf8'),
      recoveryLog: fs.existsSync(recoveryLog) ? fs.readFileSync(recoveryLog, 'utf8') : '',
      acceptedPublished: fs.existsSync(acceptedMarker),
      finalizationPublished: fs.existsSync(finalizationMarker)
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runExactVerifierAgainstSyntheticCandidate(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-nginx-verifier-'));
  const serverPath = path.join(root, 'candidate.js');
  const verifierPath = path.join(root, 'verify.js');
  const assets = JSON.stringify(CANONICAL_CLIENT_ASSETS);
  fs.writeFileSync(verifierPath, exactPublicNginxVerifierSource(), 'utf8');
  fs.writeFileSync(serverPath, `
const http = require('node:http');
const mode = process.argv[2];
const assets = new Set(${assets}.map((entry) => '/' + entry));
const server = http.createServer((request, response) => {
  response.setHeader('Server', 'nginx');
  if (request.url === '/server/server.js') {
    response.statusCode = mode === 'exposed-server' ? 200 : 404;
    response.setHeader('Content-Type', 'application/javascript');
    response.end('server');
    return;
  }
  if (assets.has(request.url)) {
    response.statusCode = 200;
    const wrongMime = mode === 'wrong-mime' && request.url === '/client/core/navigation.js';
    response.setHeader('Content-Type', wrongMime ? 'text/plain' : (request.url.endsWith('.css') ? 'text/css' : 'application/javascript'));
    response.end('asset');
    return;
  }
  if (['/api/health', '/m0', '/m0-detail', '/m4', '/admin'].includes(request.url)) {
    response.statusCode = 200;
    response.setHeader('Content-Type', request.url === '/api/health' ? 'application/json' : 'text/html');
    response.end(request.url === '/api/health' ? JSON.stringify({ status: 'ok' }) : '<!doctype html><title>candidate</title>');
    return;
  }
  response.statusCode = 404;
  response.setHeader('Content-Type', 'text/plain');
  response.end('denied');
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`, 'utf8');

  const child = spawn(process.execPath, [serverPath, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`synthetic candidate startup timed out: ${stderr}`)), 5000);
      child.once('error', reject);
      child.stdout.once('data', (chunk) => {
        clearTimeout(timer);
        resolve(chunk.toString('utf8').trim());
      });
      child.once('exit', (code) => reject(new Error(`synthetic candidate exited ${code}: ${stderr}`)));
    });
    return spawnSync(process.execPath, [verifierPath, '-', port], { encoding: 'utf8', timeout: 10_000 });
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function powerShellAstArrayEntries(scriptPath, variableName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-public-assets-ast-'));
  const harnessPath = path.join(root, 'inspect.ps1');
  const harness = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][string]$TargetVariable
)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($TargetPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw $errors[0].Message }

function Get-VariableLeafName {
  param([AllowNull()][string]$UserPath)
  if ([string]::IsNullOrWhiteSpace($UserPath)) { return $null }
  return ($UserPath.Trim().TrimStart([char]'$').TrimStart([char]'+') -split ':')[-1]
}

function Test-TargetVariablePath {
  param([AllowNull()][string]$UserPath)
  $leaf = Get-VariableLeafName $UserPath
  return $null -ne $leaf -and $leaf -ieq $TargetVariable
}

function Get-UnwrappedExpression {
  param([Parameter(Mandatory = $true)][Management.Automation.Language.Ast]$Node)
  $current = $Node
  while ($true) {
    if ($current -is [Management.Automation.Language.CommandExpressionAst]) {
      $current = $current.Expression
      continue
    }
    if ($current -is [Management.Automation.Language.ParenExpressionAst]) {
      $current = $current.Pipeline
      continue
    }
    if ($current -is [Management.Automation.Language.PipelineAst]) {
      if ($current.PipelineElements.Count -ne 1) { return $current }
      $current = $current.PipelineElements[0]
      continue
    }
    if ($current -is [Management.Automation.Language.ConvertExpressionAst]) {
      $current = $current.Child
      continue
    }
    if (
      $current -is [Management.Automation.Language.ArrayLiteralAst] -and
      $current.Elements.Count -eq 1
    ) {
      $current = $current.Elements[0]
      continue
    }
    return $current
  }
}

function Get-DirectVariableName {
  param([Parameter(Mandatory = $true)][Management.Automation.Language.Ast]$Node)
  $expression = Get-UnwrappedExpression $Node
  if ($expression -isnot [Management.Automation.Language.VariableExpressionAst]) { return $null }
  return Get-VariableLeafName $expression.VariablePath.UserPath
}

function Get-StaticAstValue {
  param([Parameter(Mandatory = $true)][Management.Automation.Language.Ast]$Node)
  $expression = Get-UnwrappedExpression $Node
  if ($expression -is [Management.Automation.Language.StringConstantExpressionAst]) {
    return [string]$expression.Value
  }
  if (
    $expression -is [Management.Automation.Language.ExpandableStringExpressionAst] -and
    $expression.NestedExpressions.Count -eq 0
  ) {
    return [string]$expression.Value
  }
  if ($expression -is [Management.Automation.Language.BinaryExpressionAst]) {
    $leftValue = Get-StaticAstValue $expression.Left
    if ($null -eq $leftValue) { return $null }
    if ($expression.Operator.ToString() -eq 'Plus') {
      $rightValue = Get-StaticAstValue $expression.Right
      if ($null -eq $rightValue) { return $null }
      return [string]$leftValue + [string]$rightValue
    }
    if ($expression.Operator.ToString() -eq 'Format') {
      $rightExpression = Get-UnwrappedExpression $expression.Right
      $argumentNodes = if ($rightExpression -is [Management.Automation.Language.ArrayLiteralAst]) {
        @($rightExpression.Elements)
      } else {
        @($expression.Right)
      }
      $formatArguments = @()
      foreach ($argumentNode in @($argumentNodes)) {
        $argumentValue = Get-StaticAstValue $argumentNode
        if ($null -eq $argumentValue) { return $null }
        $formatArguments += [string]$argumentValue
      }
      try {
        return [string]::Format(
          [Globalization.CultureInfo]::InvariantCulture,
          [string]$leftValue,
          [object[]]$formatArguments
        )
      } catch {
        return $null
      }
    }
  }
  return $null
}

function Get-CommandArgumentAst {
  param(
    [Parameter(Mandatory = $true)][Management.Automation.Language.CommandAst]$Command,
    [Parameter(Mandatory = $true)][string[]]$ParameterNames,
    [int]$Position = 0
  )
  $elements = @($Command.CommandElements)
  for ($index = 1; $index -lt $elements.Count; $index++) {
    $element = $elements[$index]
    if (
      $element -is [Management.Automation.Language.CommandParameterAst] -and
      $ParameterNames -contains $element.ParameterName.ToLowerInvariant()
    ) {
      if ($null -ne $element.Argument) { return $element.Argument }
      if ($index + 1 -lt $elements.Count) { return $elements[$index + 1] }
      return $null
    }
  }

  $positionals = @()
  for ($index = 1; $index -lt $elements.Count; $index++) {
    $element = $elements[$index]
    if ($element -is [Management.Automation.Language.CommandParameterAst]) {
      if ($null -eq $element.Argument -and $index + 1 -lt $elements.Count) { $index += 1 }
      continue
    }
    $positionals += $element
  }
  if ($Position -lt $positionals.Count) { return $positionals[$Position] }
  return $null
}

function Resolve-BuiltInCommandName {
  param([AllowNull()][string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
  $normalized = $Name.ToLowerInvariant()
  if ($normalized.Contains([string][char]92)) {
    $normalized = ($normalized -split '\\')[-1]
  }
  $aliasInfo = Get-Alias -Name $normalized -ErrorAction SilentlyContinue
  if ($null -ne $aliasInfo) { return $aliasInfo.Definition.ToLowerInvariant() }
  return $normalized
}

$assignments = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
    (Test-TargetVariablePath $node.Left.VariablePath.UserPath)
}, $true))
if ($assignments.Count -ne 1) { throw "Expected exactly one assignment to $TargetVariable" }
if ($assignments[0].Operator.ToString() -ne 'Equals') { throw "Expected a plain assignment to $TargetVariable" }
$dynamicNodes = @($assignments[0].Right.FindAll({
  param($node)
  $node -is [Management.Automation.Language.VariableExpressionAst] -or
    $node -is [Management.Automation.Language.CommandAst] -or
    $node -is [Management.Automation.Language.SubExpressionAst] -or
    $node -is [Management.Automation.Language.ScriptBlockExpressionAst]
}, $true))
if ($dynamicNodes.Count -ne 0) { throw "Expected static string entries in $TargetVariable" }

$initializationEnd = $assignments[0].Extent.EndOffset
$sourceCommandAliases = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$sourceCommandAliasFirstOffsets = [Collections.Generic.Dictionary[string,int]]::new([StringComparer]::OrdinalIgnoreCase)
$ambiguousCommandAliases = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$providerReadCommandNames = @('get-item', 'get-content', 'test-path', 'resolve-path', 'get-childitem')
$sourceFunctionNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$sourceFunctionDefinitions = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($functionDefinition in @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst]
}, $true))) {
  [void]$sourceFunctionNames.Add($functionDefinition.Name)
  if (-not $sourceFunctionDefinitions.ContainsKey($functionDefinition.Name)) {
    $sourceFunctionDefinitions.Add($functionDefinition.Name, $functionDefinition)
  }
}

function Get-SourceFunctionCommandTargetName {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $candidate = $Value.Trim()
  $providerMatch = [Regex]::Match(
    $candidate,
    '^function:[\\/]?(?:(?:global|script|local|private):)?(.+)$',
    'IgnoreCase'
  )
  if ($providerMatch.Success) { $candidate = $providerMatch.Groups[1].Value }
  if ($sourceFunctionNames.Contains($candidate)) { return $candidate }
  return $null
}

function Get-CommandTargetRootVariableName {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $null }
  $current = Get-UnwrappedExpression $Node
  while ($true) {
    if ($current -is [Management.Automation.Language.VariableExpressionAst]) {
      return Get-VariableLeafName $current.VariablePath.UserPath
    }
    if ($current -is [Management.Automation.Language.MemberExpressionAst]) {
      $current = Get-UnwrappedExpression $current.Expression
      continue
    }
    if ($current -is [Management.Automation.Language.IndexExpressionAst]) {
      $current = Get-UnwrappedExpression $current.Target
      continue
    }
    return $null
  }
}

$sourceFunctionCommandTargetVariables = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
function Test-AstMayNameSourceFunction {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $false }
  $staticTarget = Get-SourceFunctionCommandTargetName (Get-StaticAstValue $Node)
  if ($null -ne $staticTarget) { return $true }
  $sourceFunctionValue = $Node.Find({
    param($candidate)
    (
      $candidate -is [Management.Automation.Language.StringConstantExpressionAst] -or
      (
        $candidate -is [Management.Automation.Language.ExpandableStringExpressionAst] -and
        $candidate.NestedExpressions.Count -eq 0
      ) -or
      $candidate -is [Management.Automation.Language.BinaryExpressionAst]
    ) -and $null -ne (Get-SourceFunctionCommandTargetName (Get-StaticAstValue $candidate))
  }, $true)
  if ($null -ne $sourceFunctionValue) { return $true }
  return $null -ne $Node.Find({
    param($candidate)
    $candidate -is [Management.Automation.Language.VariableExpressionAst] -and
      $sourceFunctionCommandTargetVariables.Contains((Get-VariableLeafName $candidate.VariablePath.UserPath))
  }, $true)
}

$commandTargetAssignments = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst]
}, $true))
$commandTargetAliasesChanged = $true
while ($commandTargetAliasesChanged) {
  $commandTargetAliasesChanged = $false
  foreach ($assignment in $commandTargetAssignments) {
    if (-not (Test-AstMayNameSourceFunction $assignment.Right)) { continue }
    $targetRoot = Get-CommandTargetRootVariableName $assignment.Left
    if ($null -ne $targetRoot -and $sourceFunctionCommandTargetVariables.Add($targetRoot)) {
      $commandTargetAliasesChanged = $true
    }
  }
}

function Resolve-CommandName {
  param(
    [AllowNull()][string]$Name,
    [int]$AtOffset = [int]::MaxValue
  )
  if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
  $current = $Name.ToLowerInvariant()
  if ($current.StartsWith('function:', [StringComparison]::OrdinalIgnoreCase)) {
    $sourceFunctionTarget = Get-SourceFunctionCommandTargetName $Name
    if ($null -eq $sourceFunctionTarget) { return $null }
    $current = $sourceFunctionTarget.ToLowerInvariant()
  }
  $visited = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  while ($visited.Add($current)) {
    if ($ambiguousCommandAliases.Contains($current)) { return $null }
    if ($sourceCommandAliases.ContainsKey($current)) {
      if ($sourceCommandAliasFirstOffsets[$current] -gt $AtOffset) { return $null }
      $current = $sourceCommandAliases[$current].ToLowerInvariant()
      continue
    }
    $resolved = Resolve-BuiltInCommandName $current
    if ($sourceFunctionNames.Contains($current) -and $resolved -in $providerReadCommandNames) {
      return $null
    }
    if ($resolved -eq $current) { return $current }
    $current = $resolved
  }
  return $null
}

$allSourceCommands = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.CommandAst]
}, $true) | Sort-Object { $_.Extent.StartOffset })
foreach ($command in $allSourceCommands) {
  $definitionCommand = Resolve-CommandName ($command.GetCommandName()) $command.Extent.StartOffset
  if ($definitionCommand -notin @('set-alias', 'new-alias')) { continue }
  $aliasNameNode = Get-CommandArgumentAst $command @('name') 0
  $aliasValueNode = Get-CommandArgumentAst $command @('value') 1
  if ($null -eq $aliasNameNode) { continue }
  $aliasName = (Get-StaticAstValue $aliasNameNode)
  if ([string]::IsNullOrWhiteSpace($aliasName)) { continue }
  $aliasName = $aliasName.ToLowerInvariant()
  if (-not $sourceCommandAliasFirstOffsets.ContainsKey($aliasName)) {
    $sourceCommandAliasFirstOffsets[$aliasName] = $command.Extent.StartOffset
  }
  $aliasValue = if ($null -eq $aliasValueNode) { $null } else { Get-StaticAstValue $aliasValueNode }
  if ([string]::IsNullOrWhiteSpace($aliasValue)) {
    [void]$ambiguousCommandAliases.Add($aliasName)
    continue
  }
  if (
    $sourceCommandAliases.ContainsKey($aliasName) -and
    $sourceCommandAliases[$aliasName] -ine $aliasValue
  ) {
    [void]$ambiguousCommandAliases.Add($aliasName)
    continue
  }
  $sourceCommandAliases[$aliasName] = $aliasValue
}

$protectedScalarMemberNames = @(
  'count', 'length', 'longlength', 'rank',
  'isfixedsize', 'isreadonly', 'issynchronized', 'fullname'
)

function Test-DirectTargetReferenceProvenIndependent {
  param([Parameter(Mandatory = $true)][Management.Automation.Language.VariableExpressionAst]$Reference)
  $parent = $Reference.Parent
  if (
    $parent -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
    $parent.Expression -eq $Reference -and
    (Get-StaticAstValue $parent.Member) -ieq 'clone' -and
    @($parent.Arguments | Where-Object { $null -ne $_ }).Count -eq 0
  ) {
    return $true
  }
  if (
    $parent -is [Management.Automation.Language.MemberExpressionAst] -and
    $parent -isnot [Management.Automation.Language.InvokeMemberExpressionAst] -and
    $parent.Expression -eq $Reference
  ) {
    $memberName = Get-StaticAstValue $parent.Member
    return -not [string]::IsNullOrWhiteSpace($memberName) -and $memberName -in $protectedScalarMemberNames
  }
  return $false
}

function Test-SourceCommandDirectlyTargetsProtectedVariable {
  param([Parameter(Mandatory = $true)][Management.Automation.Language.CommandAst]$Command)
  $commandName = Resolve-CommandName ($Command.GetCommandName()) $Command.Extent.StartOffset
  if ($commandName -in @('set-variable', 'new-variable', 'clear-variable', 'remove-variable', 'get-variable')) {
    $nameNode = Get-CommandArgumentAst $Command @('name') 0
    if ($null -eq $nameNode) { return $true }
    $targetName = Get-StaticAstValue $nameNode
    return $null -eq $targetName -or (Test-TargetVariablePath $targetName)
  }
  if ($commandName -in @(
    'set-item', 'new-item', 'clear-item', 'remove-item',
    'set-content', 'add-content', 'clear-content', 'get-item', 'get-content'
  )) {
    $pathNode = Get-CommandArgumentAst $Command @('path', 'literalpath') 0
    if ($null -eq $pathNode) { return $true }
    $pathValue = Get-StaticAstValue $pathNode
    if ($null -eq $pathValue) { return $true }
    $providerMatch = [Regex]::Match(
      $pathValue.Trim(),
      '^variable:[\\/]?(?:(?:global|script|local|private):)?([^:]+)$',
      'IgnoreCase'
    )
    return $providerMatch.Success -and (Test-TargetVariablePath $providerMatch.Groups[1].Value)
  }
  return $false
}

function Test-SourceSessionStatePSVariableGetTargetsProtectedVariable {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if (
    $null -eq $Node -or
    $Node -isnot [Management.Automation.Language.InvokeMemberExpressionAst] -or
    $Node.Static -or
    (Get-StaticAstValue $Node.Member) -ine 'get'
  ) {
    return $false
  }
  $psVariableExpression = Get-UnwrappedExpression $Node.Expression
  if (
    $psVariableExpression -isnot [Management.Automation.Language.MemberExpressionAst] -or
    (Get-StaticAstValue $psVariableExpression.Member) -ine 'psvariable'
  ) {
    return $false
  }
  $sessionStateExpression = Get-UnwrappedExpression $psVariableExpression.Expression
  if (
    $sessionStateExpression -isnot [Management.Automation.Language.MemberExpressionAst] -or
    (Get-StaticAstValue $sessionStateExpression.Member) -ine 'sessionstate'
  ) {
    return $false
  }
  $executionContextExpression = Get-UnwrappedExpression $sessionStateExpression.Expression
  if (
    $executionContextExpression -isnot [Management.Automation.Language.VariableExpressionAst] -or
    (Get-VariableLeafName $executionContextExpression.VariablePath.UserPath) -ine 'executioncontext'
  ) {
    return $false
  }
  $arguments = @($Node.Arguments)
  if ($arguments.Count -eq 0) { return $true }
  $targetName = Get-StaticAstValue $arguments[0]
  return $null -eq $targetName -or (Test-TargetVariablePath $targetName)
}

$sourceFunctionsMayAccessProtectedReference = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::OrdinalIgnoreCase
)
foreach ($functionDefinition in $sourceFunctionDefinitions.Values) {
  $directProtectedReference = $functionDefinition.Body.Find({
    param($node)
    $node -is [Management.Automation.Language.VariableExpressionAst] -and
      (Test-TargetVariablePath $node.VariablePath.UserPath) -and
      -not (Test-DirectTargetReferenceProvenIndependent $node)
  }, $true)
  $directProtectedVariableCommand = $functionDefinition.Body.Find({
    param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
      (Test-SourceCommandDirectlyTargetsProtectedVariable $node)
  }, $true)
  $unresolvedSourceDispatch = $functionDefinition.Body.Find({
    param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
      $null -eq $node.GetCommandName() -and
      $node.InvocationOperator.ToString() -in @('Ampersand', 'Dot')
  }, $true)
  $sourceCapableMemberDispatch = $functionDefinition.Body.Find({
    param($node)
    $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
      (Get-StaticAstValue $node.Member) -in @(
        'Invoke', 'DynamicInvoke', 'InvokeScript', 'InvokeMember', 'Set'
      )
  }, $true)
  $protectedSessionStateRead = $functionDefinition.Body.Find({
    param($node)
    Test-SourceSessionStatePSVariableGetTargetsProtectedVariable $node
  }, $true)
  if (
    $null -ne $directProtectedReference -or
    $null -ne $directProtectedVariableCommand -or
    $null -ne $unresolvedSourceDispatch -or
    $null -ne $sourceCapableMemberDispatch -or
    $null -ne $protectedSessionStateRead
  ) {
    [void]$sourceFunctionsMayAccessProtectedReference.Add($functionDefinition.Name)
  }
}
$sourceFunctionExposureChanged = $true
while ($sourceFunctionExposureChanged) {
  $sourceFunctionExposureChanged = $false
  foreach ($functionDefinition in $sourceFunctionDefinitions.Values) {
    if ($sourceFunctionsMayAccessProtectedReference.Contains($functionDefinition.Name)) { continue }
    foreach ($command in @($functionDefinition.Body.FindAll({
      param($node)
      $node -is [Management.Automation.Language.CommandAst]
    }, $true))) {
      $resolvedName = Resolve-CommandName ($command.GetCommandName()) $command.Extent.StartOffset
      if (
        $null -ne $resolvedName -and
        $sourceFunctionsMayAccessProtectedReference.Contains($resolvedName)
      ) {
        [void]$sourceFunctionsMayAccessProtectedReference.Add($functionDefinition.Name)
        $sourceFunctionExposureChanged = $true
        break
      }
    }
  }
}

$sourceFunctionsMayReturnProtectedReference = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::OrdinalIgnoreCase
)
foreach ($functionDefinition in $sourceFunctionDefinitions.Values) {
  $protectedReferenceYield = $functionDefinition.Body.Find({
    param($node)
    $node -is [Management.Automation.Language.VariableExpressionAst] -and
      (Test-TargetVariablePath $node.VariablePath.UserPath) -and
      -not (Test-DirectTargetReferenceProvenIndependent $node)
  }, $true)
  $protectedProviderYield = $functionDefinition.Body.Find({
    param($node)
    if ($node -isnot [Management.Automation.Language.CommandAst]) { return $false }
    $resolvedName = Resolve-CommandName ($node.GetCommandName()) $node.Extent.StartOffset
    if ($resolvedName -ne 'get-variable') { return $false }
    $nameNode = Get-CommandArgumentAst $node @('name') 0
    if ($null -eq $nameNode) { return $true }
    $targetName = Get-StaticAstValue $nameNode
    return $null -eq $targetName -or (Test-TargetVariablePath $targetName)
  }, $true)
  $protectedSessionStateYield = $functionDefinition.Body.Find({
    param($node)
    Test-SourceSessionStatePSVariableGetTargetsProtectedVariable $node
  }, $true)
  if (
    $null -ne $protectedReferenceYield -or
    $null -ne $protectedProviderYield -or
    $null -ne $protectedSessionStateYield
  ) {
    [void]$sourceFunctionsMayReturnProtectedReference.Add($functionDefinition.Name)
  }
}
$sourceFunctionReturnChanged = $true
while ($sourceFunctionReturnChanged) {
  $sourceFunctionReturnChanged = $false
  foreach ($functionDefinition in $sourceFunctionDefinitions.Values) {
    if ($sourceFunctionsMayReturnProtectedReference.Contains($functionDefinition.Name)) { continue }
    foreach ($command in @($functionDefinition.Body.FindAll({
      param($node)
      $node -is [Management.Automation.Language.CommandAst]
    }, $true))) {
      $resolvedName = Resolve-CommandName ($command.GetCommandName()) $command.Extent.StartOffset
      if (
        $null -ne $resolvedName -and
        $sourceFunctionsMayReturnProtectedReference.Contains($resolvedName)
      ) {
        [void]$sourceFunctionsMayReturnProtectedReference.Add($functionDefinition.Name)
        $sourceFunctionReturnChanged = $true
        break
      }
    }
  }
}

function Test-SourceFunctionProvenSafe {
  param([AllowNull()][string]$Name)
  return (
    -not [string]::IsNullOrWhiteSpace($Name) -and
    $sourceFunctionDefinitions.ContainsKey($Name) -and
    -not $sourceFunctionsMayAccessProtectedReference.Contains($Name)
  )
}

function Get-EnclosingFunctionName {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $null }
  $current = $Node.Parent
  while ($null -ne $current) {
    if ($current -is [Management.Automation.Language.FunctionDefinitionAst]) {
      return $current.Name
    }
    $current = $current.Parent
  }
  return $null
}

function Get-SourceFunctionReferenceName {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $null }
  $staticTarget = Get-SourceFunctionCommandTargetName (Get-StaticAstValue $Node)
  if ($null -ne $staticTarget) { return $staticTarget }
  $expression = Get-UnwrappedExpression $Node
  if ($expression -is [Management.Automation.Language.VariableExpressionAst]) {
    return Get-SourceFunctionCommandTargetName $expression.VariablePath.UserPath
  }
  if (
    $expression -isnot [Management.Automation.Language.MemberExpressionAst] -or
    (Get-StaticAstValue $expression.Member) -ine 'scriptblock'
  ) {
    return $null
  }
  $recordExpression = Get-UnwrappedExpression $expression.Expression
  if ($recordExpression -isnot [Management.Automation.Language.CommandAst]) { return $null }
  $recordCommandName = Resolve-CommandName (
    $recordExpression.GetCommandName()
  ) $recordExpression.Extent.StartOffset
  if ($recordCommandName -notin @('get-item', 'get-command')) { return $null }
  $targetNode = Get-CommandArgumentAst $recordExpression @('name', 'path', 'literalpath') 0
  if ($null -eq $targetNode) { return $null }
  return Get-SourceFunctionCommandTargetName (Get-StaticAstValue $targetNode)
}

function Test-AstReferencesUnprovenSourceFunction {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $false }
  $directSourceFunction = Get-SourceFunctionReferenceName $Node
  if ($null -ne $directSourceFunction) {
    return -not (Test-SourceFunctionProvenSafe $directSourceFunction)
  }
  $unsafeReference = $Node.Find({
    param($candidate)
    $sourceFunctionName = Get-SourceFunctionReferenceName $candidate
    return (
      $null -ne $sourceFunctionName -and
      -not (Test-SourceFunctionProvenSafe $sourceFunctionName)
    )
  }, $true)
  if ($null -ne $unsafeReference) { return $true }
  return (Test-AstMayNameSourceFunction $Node)
}

function Test-UnresolvedInvocationTargetProvenSafe {
  param([Parameter(Mandatory = $true)][Management.Automation.Language.CommandAst]$Command)
  $elements = @($Command.CommandElements)
  if ($elements.Count -eq 0) { return $false }
  $directSourceFunction = Get-SourceFunctionReferenceName $elements[0]
  if ($null -ne $directSourceFunction) {
    return Test-SourceFunctionProvenSafe $directSourceFunction
  }

  $targetRoot = Get-CommandTargetRootVariableName $elements[0]
  $enclosingFunctionName = Get-EnclosingFunctionName $Command
  if (
    [string]::IsNullOrWhiteSpace($targetRoot) -or
    [string]::IsNullOrWhiteSpace($enclosingFunctionName) -or
    -not $sourceFunctionDefinitions.ContainsKey($enclosingFunctionName)
  ) {
    return $false
  }
  $definition = $sourceFunctionDefinitions[$enclosingFunctionName]
  if ($null -eq $definition.Body.ParamBlock) { return $false }
  $parameters = @($definition.Body.ParamBlock.Parameters)
  $parameterIndex = -1
  for ($index = 0; $index -lt $parameters.Count; $index++) {
    $parameterName = Get-VariableLeafName $parameters[$index].Name.VariablePath.UserPath
    if ($parameterName -ieq $targetRoot) {
      $parameterIndex = $index
      break
    }
  }
  if ($parameterIndex -lt 0) { return $false }

  $callSites = @($allSourceCommands | Where-Object {
    (Resolve-CommandName ($_.GetCommandName()) $_.Extent.StartOffset) -ieq $enclosingFunctionName
  })
  if ($callSites.Count -eq 0) { return $false }
  foreach ($callSite in $callSites) {
    $argumentNode = Get-CommandArgumentAst $callSite @($targetRoot.ToLowerInvariant()) $parameterIndex
    $boundSourceFunction = Get-SourceFunctionReferenceName $argumentNode
    if (-not (Test-SourceFunctionProvenSafe $boundSourceFunction)) { return $false }
  }
  return $true
}

function Test-InvokeTargetProvenSafe {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  $sourceFunctionName = Get-SourceFunctionReferenceName $Node
  return Test-SourceFunctionProvenSafe $sourceFunctionName
}

$topLevelPostInitializationCommands = @($allSourceCommands | Where-Object {
  $_.Extent.StartOffset -ge $initializationEnd -and
    $null -eq (Get-EnclosingFunctionName $_)
})
$reachableFunctionNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$reachableFunctionQueue = New-Object 'Collections.Generic.Queue[string]'
foreach ($command in $topLevelPostInitializationCommands) {
  $resolvedName = Resolve-CommandName ($command.GetCommandName()) $command.Extent.StartOffset
  if ($null -ne $resolvedName -and $sourceFunctionDefinitions.ContainsKey($resolvedName)) {
    if ($reachableFunctionNames.Add($resolvedName)) { $reachableFunctionQueue.Enqueue($resolvedName) }
  }
}
while ($reachableFunctionQueue.Count -gt 0) {
  $functionName = $reachableFunctionQueue.Dequeue()
  $definition = $sourceFunctionDefinitions[$functionName]
  foreach ($command in @($definition.Body.FindAll({
    param($node)
    $node -is [Management.Automation.Language.CommandAst]
  }, $true))) {
    $resolvedName = Resolve-CommandName ($command.GetCommandName()) $command.Extent.StartOffset
    if ($null -ne $resolvedName -and $sourceFunctionDefinitions.ContainsKey($resolvedName)) {
      if ($reachableFunctionNames.Add($resolvedName)) { $reachableFunctionQueue.Enqueue($resolvedName) }
    }
  }
}

function Test-NodeInProtectedExecutionScope {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $false }
  $functionName = Get-EnclosingFunctionName $Node
  if ($null -eq $functionName) { return $Node.Extent.StartOffset -ge $initializationEnd }
  return $reachableFunctionNames.Contains($functionName)
}

$postInitializationCommands = @($allSourceCommands | Where-Object {
  Test-NodeInProtectedExecutionScope $_
})

$protectedVariables = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[void]$protectedVariables.Add($TargetVariable)

function Test-ProtectedVariablePath {
  param([AllowNull()][string]$UserPath)
  $leaf = Get-VariableLeafName $UserPath
  return $null -ne $leaf -and $protectedVariables.Contains($leaf)
}

function Test-AstContainsProtectedVariable {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $false }
  return $null -ne $Node.Find({
    param($candidate)
    $candidate -is [Management.Automation.Language.VariableExpressionAst] -and
      (Test-ProtectedVariablePath $candidate.VariablePath.UserPath)
  }, $true)
}

function Get-InlineProtectedProviderValueClassification {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return 'Other' }
  $valueExpression = Get-UnwrappedExpression $Node
  if ($valueExpression -isnot [Management.Automation.Language.MemberExpressionAst]) { return 'Other' }
  if ((Get-StaticAstValue $valueExpression.Member) -ine 'value') { return 'Other' }
  $recordExpression = Get-UnwrappedExpression $valueExpression.Expression

  if ($recordExpression -is [Management.Automation.Language.CommandAst]) {
    $commandName = Resolve-CommandName ($recordExpression.GetCommandName()) $recordExpression.Extent.StartOffset
    if ($commandName -ne 'get-item') { return 'Other' }
    $pathNode = Get-CommandArgumentAst $recordExpression @('path', 'literalpath') 0
    if ($null -eq $pathNode) { return 'Unknown' }
    $pathValue = Get-StaticAstValue $pathNode
    if ($null -eq $pathValue) { return 'Unknown' }
    $match = [Regex]::Match(
      $pathValue.Trim(),
      '^variable:[\\/]?(?:(?:global|script|local|private):)?([^:]+)$',
      'IgnoreCase'
    )
    if (-not $match.Success) { return 'Other' }
    $targetName = Get-VariableLeafName $match.Groups[1].Value
    if ($null -ne $targetName -and $protectedVariables.Contains($targetName)) { return 'Protected' }
    return 'Other'
  }

  if (
    $recordExpression -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
    -not $recordExpression.Static -and
    (Get-StaticAstValue $recordExpression.Member) -ieq 'get'
  ) {
    $psVariableExpression = Get-UnwrappedExpression $recordExpression.Expression
    if ($psVariableExpression -isnot [Management.Automation.Language.MemberExpressionAst]) { return 'Other' }
    if ((Get-StaticAstValue $psVariableExpression.Member) -ine 'psvariable') { return 'Other' }
    $sessionStateExpression = Get-UnwrappedExpression $psVariableExpression.Expression
    if ($sessionStateExpression -isnot [Management.Automation.Language.MemberExpressionAst]) { return 'Other' }
    if ((Get-StaticAstValue $sessionStateExpression.Member) -ine 'sessionstate') { return 'Other' }
    $executionContextExpression = Get-UnwrappedExpression $sessionStateExpression.Expression
    if ($executionContextExpression -isnot [Management.Automation.Language.VariableExpressionAst]) { return 'Other' }
    if ((Get-VariableLeafName $executionContextExpression.VariablePath.UserPath) -ine 'executioncontext') { return 'Other' }
    $arguments = @($recordExpression.Arguments)
    if ($arguments.Count -eq 0) { return 'Unknown' }
    $targetName = Get-StaticAstValue $arguments[0]
    if ($null -eq $targetName) { return 'Unknown' }
    $targetName = Get-VariableLeafName $targetName
    if ($null -ne $targetName -and $protectedVariables.Contains($targetName)) { return 'Protected' }
    return 'Other'
  }

  return 'Other'
}

function Test-AstMayRetainProtectedReference {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $false }
  $protectedReturningCall = $Node.Find({
    param($candidate)
    if ($candidate -isnot [Management.Automation.Language.CommandAst]) { return $false }
    $resolvedName = Resolve-CommandName ($candidate.GetCommandName()) $candidate.Extent.StartOffset
    return (
      $null -ne $resolvedName -and
      $sourceFunctionsMayReturnProtectedReference.Contains($resolvedName)
    )
  }, $true)
  if ($null -ne $protectedReturningCall) { return $true }
  $scalarMemberNames = @(
    'count', 'length', 'longlength', 'rank',
    'isfixedsize', 'isreadonly', 'issynchronized', 'fullname'
  )
  $references = @($Node.FindAll({
    param($candidate)
    (
      $candidate -is [Management.Automation.Language.VariableExpressionAst] -and
      (Test-ProtectedVariablePath $candidate.VariablePath.UserPath)
    ) -or (Get-InlineProtectedProviderValueClassification $candidate) -ne 'Other'
  }, $true))
  foreach ($reference in $references) {
    $parent = $reference.Parent
    if (
      $parent -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
      $parent.Expression -eq $reference
    ) {
      $methodName = Get-StaticAstValue $parent.Member
      if (
        $methodName -ieq 'clone' -and
        @($parent.Arguments | Where-Object { $null -ne $_ }).Count -eq 0
      ) {
        continue
      }
    }
    if (
      $parent -is [Management.Automation.Language.MemberExpressionAst] -and
      $parent.Expression -eq $reference
    ) {
      $memberName = Get-StaticAstValue $parent.Member
      if (-not [string]::IsNullOrWhiteSpace($memberName) -and $memberName -in $scalarMemberNames) {
        continue
      }
    }
    return $true
  }
  return $false
}

function Get-VariableProviderTargetName {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $match = [Regex]::Match(
    $Value.Trim(),
    '^variable:[\\/]?(?:(?:global|script|local|private):)?([^:]+)$',
    'IgnoreCase'
  )
  if (-not $match.Success) { return $null }
  return $match.Groups[1].Value
}

function Get-AssignableRootVariableName {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $null }
  $current = Get-UnwrappedExpression $Node
  while ($true) {
    if ($current -is [Management.Automation.Language.VariableExpressionAst]) {
      return Get-VariableLeafName $current.VariablePath.UserPath
    }
    if ($current -is [Management.Automation.Language.MemberExpressionAst]) {
      $current = Get-UnwrappedExpression $current.Expression
      continue
    }
    if ($current -is [Management.Automation.Language.IndexExpressionAst]) {
      $current = Get-UnwrappedExpression $current.Target
      continue
    }
    return $null
  }
}

function Test-AstMayReturnProtectedProviderRecord {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $false }
  $expression = Get-UnwrappedExpression $Node
  if ($expression -isnot [Management.Automation.Language.CommandAst]) { return $false }
  $commandName = Resolve-CommandName ($expression.GetCommandName()) $expression.Extent.StartOffset
  if ($commandName -ne 'get-item') { return $false }
  $pathNode = Get-CommandArgumentAst $expression @('path', 'literalpath') 0
  if ($null -eq $pathNode) { return $true }
  $pathValue = Get-StaticAstValue $pathNode
  if ($null -eq $pathValue) { return $false }
  $providerTarget = Get-VariableProviderTargetName $pathValue
  if ($null -eq $providerTarget) { return $false }
  return $protectedVariables.Contains((Get-VariableLeafName $providerTarget))
}

$aliasDefinitionOffsets = [Collections.Generic.HashSet[int]]::new()
$candidateAliasAssignments = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    (Test-NodeInProtectedExecutionScope $node) -and
    $null -ne (Get-AssignableRootVariableName $node.Left)
}, $true) | Sort-Object { $_.Extent.StartOffset })
$aliasChanged = $true
while ($aliasChanged) {
  $aliasChanged = $false
  foreach ($assignment in $candidateAliasAssignments) {
    if (
      -not (Test-AstMayRetainProtectedReference $assignment.Right) -and
      -not (Test-AstMayReturnProtectedProviderRecord $assignment.Right)
    ) {
      continue
    }
    $aliasName = Get-AssignableRootVariableName $assignment.Left
    if ($aliasName -in @('null', 'true', 'false')) { continue }
    if (
      $assignment.Left -is [Management.Automation.Language.VariableExpressionAst] -or
      -not $protectedVariables.Contains($aliasName)
    ) {
      [void]$aliasDefinitionOffsets.Add($assignment.Extent.StartOffset)
    }
    if ($protectedVariables.Add($aliasName)) { $aliasChanged = $true }
  }
  foreach ($command in $postInitializationCommands) {
    $resolvedCommand = Resolve-CommandName ($command.GetCommandName()) $command.Extent.StartOffset
    $nameNode = $null
    $valueNode = Get-CommandArgumentAst $command @('value') 1
    if ($resolvedCommand -in @('set-variable', 'new-variable')) {
      $nameNode = Get-CommandArgumentAst $command @('name') 0
      $aliasName = if ($null -eq $nameNode) { $null } else { Get-StaticAstValue $nameNode }
    } elseif ($resolvedCommand -in @('set-item', 'new-item', 'set-content', 'add-content')) {
      $pathNode = Get-CommandArgumentAst $command @('path', 'literalpath') 0
      $pathValue = if ($null -eq $pathNode) { $null } else { Get-StaticAstValue $pathNode }
      $aliasName = Get-VariableProviderTargetName $pathValue
    } else {
      continue
    }
    if (
      [string]::IsNullOrWhiteSpace($aliasName) -or
      $null -eq $valueNode -or
      -not (Test-AstMayRetainProtectedReference $valueNode)
    ) {
      continue
    }
    $aliasName = Get-VariableLeafName $aliasName
    [void]$aliasDefinitionOffsets.Add($command.Extent.StartOffset)
    if ($protectedVariables.Add($aliasName)) { $aliasChanged = $true }
  }
}

function Test-StaticNameTargetsProtectedVariable {
  param([AllowNull()][string]$Value)
  $leaf = Get-VariableLeafName $Value
  return $null -ne $leaf -and $protectedVariables.Contains($leaf)
}

function Test-VariableProviderTargetsProtectedVariable {
  param([AllowNull()][string]$Value)
  $name = Get-VariableProviderTargetName $Value
  return $null -ne $name -and $protectedVariables.Contains($name)
}

$protectedProviderPathVariables = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$protectedVariableNameVariables = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$nameAliasChanged = $true
while ($nameAliasChanged) {
  $nameAliasChanged = $false
  foreach ($assignment in $candidateAliasAssignments) {
    if ($assignment.Left -isnot [Management.Automation.Language.VariableExpressionAst]) { continue }
    $aliasName = Get-VariableLeafName $assignment.Left.VariablePath.UserPath
    $staticValue = Get-StaticAstValue $assignment.Right
    $sourceName = Get-DirectVariableName $assignment.Right
    $targetsProtectedName =
      (Test-StaticNameTargetsProtectedVariable $staticValue) -or
      ($null -ne $sourceName -and $protectedVariableNameVariables.Contains($sourceName))
    if ($targetsProtectedName -and $protectedVariableNameVariables.Add($aliasName)) {
      $nameAliasChanged = $true
    }
  }
}
$pathAliasChanged = $true
while ($pathAliasChanged) {
  $pathAliasChanged = $false
  foreach ($assignment in $candidateAliasAssignments) {
    if ($assignment.Left -isnot [Management.Automation.Language.VariableExpressionAst]) { continue }
    $aliasName = Get-VariableLeafName $assignment.Left.VariablePath.UserPath
    $staticValue = Get-StaticAstValue $assignment.Right
    $sourceName = Get-DirectVariableName $assignment.Right
    $rightExpression = Get-UnwrappedExpression $assignment.Right
    $expandableTargetsProtectedProvider = $false
    if ($rightExpression -is [Management.Automation.Language.ExpandableStringExpressionAst]) {
      $extentText = $rightExpression.Extent.Text.Trim().TrimStart([char]'"')
      $nestedNames = @($rightExpression.NestedExpressions | ForEach-Object {
        Get-DirectVariableName $_
      } | Where-Object { $null -ne $_ })
      if (
        $extentText.StartsWith('Variable:', [StringComparison]::OrdinalIgnoreCase) -and
        $nestedNames.Count -gt 0 -and
        @($nestedNames | Where-Object { -not $protectedVariableNameVariables.Contains($_) }).Count -eq 0
      ) {
        $expandableTargetsProtectedProvider = $true
      }
    }
    $targetsProtectedProvider =
      (Test-VariableProviderTargetsProtectedVariable $staticValue) -or
      ($null -ne $sourceName -and $protectedProviderPathVariables.Contains($sourceName)) -or
      $expandableTargetsProtectedProvider
    if ($targetsProtectedProvider -and $protectedProviderPathVariables.Add($aliasName)) {
      $pathAliasChanged = $true
    }
  }
}

function Get-ProviderTargetClassification {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return 'Unknown' }
  $staticValue = Get-StaticAstValue $Node
  if ($null -ne $staticValue) {
    if (Test-VariableProviderTargetsProtectedVariable $staticValue) { return 'Protected' }
    return 'Other'
  }
  $variableName = Get-DirectVariableName $Node
  if ($null -ne $variableName -and $protectedProviderPathVariables.Contains($variableName)) {
    return 'Protected'
  }
  return 'Unknown'
}

function Get-VariableNameClassification {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return 'Unknown' }
  $staticValue = Get-StaticAstValue $Node
  if ($null -ne $staticValue) {
    if (Test-StaticNameTargetsProtectedVariable $staticValue) { return 'Protected' }
    return 'Other'
  }
  return 'Unknown'
}

function Test-CommandResolutionProviderPath {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $false }
  $staticValue = Get-StaticAstValue $Node
  return $null -ne $staticValue -and $staticValue -match '^(?:alias|function):'
}

function Test-SessionStatePSVariableExpression {
  param([AllowNull()][Management.Automation.Language.Ast]$Node)
  if ($null -eq $Node) { return $false }
  $psVariableExpression = Get-UnwrappedExpression $Node
  if ($psVariableExpression -isnot [Management.Automation.Language.MemberExpressionAst]) { return $false }
  if ((Get-StaticAstValue $psVariableExpression.Member) -ine 'psvariable') { return $false }
  $sessionStateExpression = Get-UnwrappedExpression $psVariableExpression.Expression
  if ($sessionStateExpression -isnot [Management.Automation.Language.MemberExpressionAst]) { return $false }
  if ((Get-StaticAstValue $sessionStateExpression.Member) -ine 'sessionstate') { return $false }
  $executionContextExpression = Get-UnwrappedExpression $sessionStateExpression.Expression
  if ($executionContextExpression -isnot [Management.Automation.Language.VariableExpressionAst]) { return $false }
  return (Get-VariableLeafName $executionContextExpression.VariablePath.UserPath) -ieq 'executioncontext'
}

function Test-ReadOnlyProtectedVariableSeal {
  param([Parameter(Mandatory = $true)][Management.Automation.Language.CommandAst]$Command)
  $nameNode = Get-CommandArgumentAst $Command @('name') 0
  $scopeNode = Get-CommandArgumentAst $Command @('scope') 999
  $optionNode = Get-CommandArgumentAst $Command @('option') 999
  $valueNode = Get-CommandArgumentAst $Command @('value') 1
  $targetName = if ($null -eq $nameNode) { $null } else { Get-StaticAstValue $nameNode }
  if (-not (Test-StaticNameTargetsProtectedVariable $targetName)) { return $false }
  if ($null -eq $scopeNode -or $null -eq $optionNode -or $null -eq $valueNode) { return $false }
  if ((Get-StaticAstValue $scopeNode) -ine 'script') { return $false }
  if ((Get-StaticAstValue $optionNode) -ine 'readonly') { return $false }
  $asReadOnly = Get-UnwrappedExpression $valueNode
  if (
    $asReadOnly -isnot [Management.Automation.Language.InvokeMemberExpressionAst] -or
    -not $asReadOnly.Static -or
    (Get-StaticAstValue $asReadOnly.Member) -ine 'asreadonly' -or
    $asReadOnly.Expression -isnot [Management.Automation.Language.TypeExpressionAst] -or
    $asReadOnly.Expression.TypeName.FullName -notin @('Array', 'System.Array')
  ) {
    return $false
  }
  $arguments = @($asReadOnly.Arguments)
  if ($arguments.Count -ne 1) { return $false }
  $cloneCall = Get-UnwrappedExpression $arguments[0]
  if (
    $cloneCall -isnot [Management.Automation.Language.InvokeMemberExpressionAst] -or
    $cloneCall.Static -or
    (Get-StaticAstValue $cloneCall.Member) -ine 'clone' -or
    @($cloneCall.Arguments | Where-Object { $null -ne $_ }).Count -ne 0
  ) {
    return $false
  }
  $sourceName = Get-DirectVariableName $cloneCall.Expression
  return $null -ne $sourceName -and $sourceName -ieq (Get-VariableLeafName $targetName)
}

function Test-CommandTargetsProtectedVariable {
  param([Parameter(Mandatory = $true)][Management.Automation.Language.CommandAst]$Command)
  $rawCommandName = $Command.GetCommandName()
  $commandName = Resolve-CommandName $rawCommandName $Command.Extent.StartOffset
  $elements = @($Command.CommandElements)
  if (
    $null -eq $rawCommandName -and
    $Command.InvocationOperator.ToString() -in @('Ampersand', 'Dot') -and
    -not (Test-UnresolvedInvocationTargetProvenSafe $Command)
  ) {
    return $true
  }
  $argumentsMayRetainProtected = $false
  foreach ($element in $elements | Select-Object -Skip 1) {
    if (
      $element -isnot [Management.Automation.Language.CommandParameterAst] -and
      (Test-AstMayRetainProtectedReference $element)
    ) {
      $argumentsMayRetainProtected = $true
      break
    }
  }
  $callbackNode = switch ($commandName) {
    'foreach-object' { Get-CommandArgumentAst $Command @('process') 0; break }
    'where-object' { Get-CommandArgumentAst $Command @('filterscript') 0; break }
    'measure-command' { Get-CommandArgumentAst $Command @('expression') 0; break }
    'invoke-command' { Get-CommandArgumentAst $Command @('scriptblock') 0; break }
    default { $null }
  }
  if (
    $null -ne $callbackNode -and
    (Test-AstReferencesUnprovenSourceFunction $callbackNode)
  ) {
    return $true
  }
  $writeParameters = @(
    'outvariable', 'ov', 'pipelinevariable', 'pv', 'errorvariable', 'ev',
    'warningvariable', 'wv', 'informationvariable', 'iv'
  )
  for ($index = 1; $index -lt $elements.Count; $index++) {
    $element = $elements[$index]
    if (
      $element -is [Management.Automation.Language.CommandParameterAst] -and
      $writeParameters -contains $element.ParameterName.ToLowerInvariant()
    ) {
      $writeTarget = if ($null -ne $element.Argument) {
        $element.Argument
      } elseif ($index + 1 -lt $elements.Count) {
        $elements[$index + 1]
      } else {
        $null
      }
      if ((Get-VariableNameClassification $writeTarget) -ne 'Other') { return $true }
    }
  }

  $rawCommandLeaf = if ([string]::IsNullOrWhiteSpace($rawCommandName)) {
    $null
  } else {
    ($rawCommandName.ToLowerInvariant() -split '\\')[-1]
  }
  if (
    $commandName -eq 'write-output' -and
    $rawCommandLeaf -eq 'write-output' -and
    -not $sourceFunctionNames.Contains('write-output')
  ) {
    return $false
  }

  if ($commandName -in @('set-alias', 'new-alias')) {
    $aliasNameNode = Get-CommandArgumentAst $Command @('name') 0
    $aliasValueNode = Get-CommandArgumentAst $Command @('value') 1
    $aliasName = if ($null -eq $aliasNameNode) { $null } else { Get-StaticAstValue $aliasNameNode }
    $aliasValue = if ($null -eq $aliasValueNode) { $null } else { Get-StaticAstValue $aliasValueNode }
    if (
      [string]::IsNullOrWhiteSpace($aliasName) -or
      [string]::IsNullOrWhiteSpace($aliasValue)
    ) {
      return $true
    }
    return $ambiguousCommandAliases.Contains($aliasName)
  }

  if ($commandName -eq 'invoke-expression') { return $true }

  if ($commandName -eq 'set-variable' -and (Test-ReadOnlyProtectedVariableSeal $Command)) {
    return $false
  }
  if ($commandName -in @('set-variable', 'clear-variable', 'remove-variable', 'new-variable')) {
    $nameNode = Get-CommandArgumentAst $Command @('name') 0
    return (Get-VariableNameClassification $nameNode) -ne 'Other'
  }
  if ($commandName -eq 'tee-object') {
    $nameNode = Get-CommandArgumentAst $Command @('variable') 0
    return (Get-VariableNameClassification $nameNode) -ne 'Other'
  }

  $explicitProtectedProvider = $false
  foreach ($element in $elements | Select-Object -Skip 1) {
    if ($element -is [Management.Automation.Language.CommandParameterAst]) { continue }
    if ((Get-ProviderTargetClassification $element) -eq 'Protected') {
      $explicitProtectedProvider = $true
      break
    }
  }
  if ($explicitProtectedProvider) {
    if ($commandName -in $providerReadCommandNames) { return $false }
    return $true
  }

  $providerMutationCommands = @(
    'set-item', 'clear-item', 'remove-item', 'rename-item', 'move-item', 'copy-item',
    'new-item', 'set-content', 'add-content', 'clear-content', 'out-file'
  )
  if ($commandName -in $providerMutationCommands) {
    $pathNode = Get-CommandArgumentAst $Command @('path', 'literalpath', 'filepath') 0
    if (Test-CommandResolutionProviderPath $pathNode) { return $true }
    if ((Get-ProviderTargetClassification $pathNode) -eq 'Protected') { return $true }
    if (Test-AstMayRetainProtectedReference $pathNode) { return $true }
    foreach ($parameterName in @('destination', 'newname')) {
      $destinationNode = Get-CommandArgumentAst $Command @($parameterName) 1
      if ($null -ne $destinationNode) {
        if (Test-CommandResolutionProviderPath $destinationNode) { return $true }
        if ((Get-ProviderTargetClassification $destinationNode) -eq 'Protected') { return $true }
        if (Test-AstMayRetainProtectedReference $destinationNode) { return $true }
      }
    }
    return $false
  }

  if ($null -eq $commandName) {
    $dynamicPathNode = Get-CommandArgumentAst $Command @('path', 'literalpath', 'filepath') 0
    if (
      $null -ne $dynamicPathNode -and
      (Get-ProviderTargetClassification $dynamicPathNode) -ne 'Other'
    ) {
      return $true
    }
    $dynamicNameNode = Get-CommandArgumentAst $Command @('name', 'variable') 0
    if (
      $null -ne $dynamicNameNode -and
      (Get-VariableNameClassification $dynamicNameNode) -ne 'Other'
    ) {
      return $true
    }
    foreach ($element in $elements | Select-Object -Skip 1) {
      if (
        $element -isnot [Management.Automation.Language.CommandParameterAst] -and
        (Test-AstMayRetainProtectedReference $element)
      ) {
        return $true
      }
    }
  }
  if ($argumentsMayRetainProtected) { return $true }
  return $false
}

$assignmentWrites = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    (Test-NodeInProtectedExecutionScope $node) -and
    -not $aliasDefinitionOffsets.Contains($node.Extent.StartOffset) -and
    (Test-AstMayRetainProtectedReference $node.Left)
}, $true))
$foreachWrites = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.ForEachStatementAst] -and
    (Test-NodeInProtectedExecutionScope $node) -and
    (Test-ProtectedVariablePath $node.Variable.VariablePath.UserPath)
}, $true))
$unaryWrites = @($ast.FindAll({
  param($node)
    $node -is [Management.Automation.Language.UnaryExpressionAst] -and
    (Test-NodeInProtectedExecutionScope $node) -and
    $node.TokenKind.ToString() -match 'PlusPlus|MinusMinus' -and
    (Test-AstContainsProtectedVariable $node.Child)
}, $true))
$commandWrites = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.CommandAst] -and
    (Test-NodeInProtectedExecutionScope $node) -and
    -not $aliasDefinitionOffsets.Contains($node.Extent.StartOffset) -and
    (Test-CommandTargetsProtectedVariable $node)
}, $true))
$mutatingMemberNames = @('setvalue', 'add', 'clear', 'insert', 'remove', 'removeat', 'reverse', 'sort', 'resize')
$memberWrites = @($ast.FindAll({
  param($node)
  if (
    $node -isnot [Management.Automation.Language.InvokeMemberExpressionAst] -or
    -not (Test-NodeInProtectedExecutionScope $node)
  ) {
    return $false
  }
  $memberName = Get-StaticAstValue $node.Member
  if ([string]::IsNullOrWhiteSpace($memberName)) {
    if (-not $node.Static -and (Test-AstMayRetainProtectedReference $node.Expression)) { return $true }
    foreach ($argument in @($node.Arguments)) {
      if (Test-AstMayRetainProtectedReference $argument) { return $true }
    }
    return $false
  }
  $memberName = $memberName.ToLowerInvariant()
  $argumentsMayRetainProtected = $false
  foreach ($argument in @($node.Arguments)) {
    if (Test-AstMayRetainProtectedReference $argument) {
      $argumentsMayRetainProtected = $true
      break
    }
  }
  if ($memberName -in @('invoke', 'dynamicinvoke')) {
    return (
      $argumentsMayRetainProtected -or
      (Test-AstMayRetainProtectedReference $node.Expression) -or
      -not (Test-InvokeTargetProvenSafe $node.Expression)
    )
  }
  if ($memberName -in @('invokescript', 'foreach', 'where')) {
    foreach ($argument in @($node.Arguments)) {
      if (Test-AstReferencesUnprovenSourceFunction $argument) { return $true }
    }
  }
  if ($memberName -eq 'invokemember') {
    return $argumentsMayRetainProtected -or (Test-AstMayRetainProtectedReference $node.Expression)
  }
  if (
    -not $node.Static -and
    $memberName -eq 'set' -and
    (Test-SessionStatePSVariableExpression $node.Expression)
  ) {
    $arguments = @($node.Arguments)
    if ($arguments.Count -eq 0) { return $true }
    return (Get-VariableNameClassification $arguments[0]) -ne 'Other'
  }
  if (-not $node.Static -and $memberName -eq 'copyto') {
    $arguments = @($node.Arguments)
    if ($arguments.Count -eq 0) { return $argumentsMayRetainProtected }
    return Test-AstMayRetainProtectedReference $arguments[0]
  }
  $isArrayType =
    $node.Static -and
    $node.Expression -is [Management.Automation.Language.TypeExpressionAst] -and
    $node.Expression.TypeName.FullName -in @('Array', 'System.Array')
  $isScriptBlockType =
    $node.Static -and
    $node.Expression -is [Management.Automation.Language.TypeExpressionAst] -and
    $node.Expression.TypeName.FullName -in @('ScriptBlock', 'System.Management.Automation.ScriptBlock')
  if ($isScriptBlockType -and $memberName -eq 'create') { return $true }
  if ($isArrayType -and $memberName -in @('copy', 'constrainedcopy')) {
    $arguments = @($node.Arguments)
    if ($memberName -eq 'copy' -and $arguments.Count -eq 3) {
      return Test-AstMayRetainProtectedReference $arguments[1]
    }
    if ($arguments.Count -eq 5) {
      return Test-AstMayRetainProtectedReference $arguments[2]
    }
    return $argumentsMayRetainProtected
  }
  if ($isArrayType -and $memberName -in @('indexof', 'lastindexof', 'binarysearch')) { return $false }
  $expressionMayRetainProtected =
    -not $node.Static -and (Test-AstMayRetainProtectedReference $node.Expression)
  if ($memberName -in @('clone', 'contains', 'getenumerator', 'getlength', 'getlonglength', 'getlowerbound', 'getupperbound')) {
    return $argumentsMayRetainProtected
  }
  if ($mutatingMemberNames -contains $memberName) {
    return $expressionMayRetainProtected -or $argumentsMayRetainProtected
  }
  return $expressionMayRetainProtected -or $argumentsMayRetainProtected
}, $true))
$mutationNodes = @($assignmentWrites) + @($foreachWrites) + @($unaryWrites) + @($commandWrites) + @($memberWrites)
if ($mutationNodes.Count -ne 0) {
  throw "$TargetVariable must remain immutable after initialization: $($mutationNodes[0].Extent.Text)"
}
@($assignments[0].Right.FindAll({
  param($node)
  $node -is [Management.Automation.Language.StringConstantExpressionAst]
}, $true) | ForEach-Object { $_.Value }) | ConvertTo-Json -Compress
`;
  fs.writeFileSync(harnessPath, harness, 'utf8');
  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      harnessPath,
      '-TargetPath',
      scriptPath,
      '-TargetVariable',
      variableName
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function powerShellAstArrayEntriesFromSource(source, variableName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-public-assets-target-'));
  const scriptPath = path.join(root, 'target.ps1');
  fs.writeFileSync(scriptPath, source, 'utf8');
  try {
    return powerShellAstArrayEntries(scriptPath, variableName);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertPowerShellSourceMutatesProtectedAssets(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-public-assets-runtime-mutant-'));
  const scriptPath = path.join(root, 'mutant.ps1');
  fs.writeFileSync(
    scriptPath,
    `${source}\n[Console]::Out.WriteLine('MUTATED=' + $requiredPublicAssets[0])\n`,
    'utf8'
  );
  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      /^MUTATED=client\/evil\.js$/m,
      'mutant must actually change the protected array under PowerShell 5'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runDeployPowerShellHarness(functionNames, body, args = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-deploy-function-harness-'));
  const harnessPath = path.join(root, 'harness.ps1');
  const harness = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$DeployPath,
  [string]$CheckoutRoot,
  [string]$InventoryRoot,
  [string]$RelativePath,
  [string]$OutsideRoot,
  [string]$OriginalParent,
  [string]$ConsumerPath,
  [string]$ConsumerOutput,
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($DeployPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw $errors[0].Message }
$requestedFunctions = @(${functionNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ')})
foreach ($requestedName in $requestedFunctions) {
  $matches = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ieq $requestedName
  }, $true))
  if ($matches.Count -ne 1) { throw "Expected one deploy function named $requestedName" }
  . ([scriptblock]::Create($matches[0].Extent.Text))
}
${body}
`;
  fs.writeFileSync(harnessPath, harness, 'utf8');
  try {
    return spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      harnessPath,
      '-DeployPath',
      deployScriptPath,
      ...args
    ], { encoding: 'utf8', timeout: 30_000 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertPowerShellHarnessSucceeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('index loads the Wave 1 security scripts after frozen PPT in the approved order', () => {
  const sources = scriptSources(read(indexPath));

  assert.deepEqual(
    sources.slice(-7),
    [
      'client/shared/build_info.js',
      'client/core/navigation.js',
      'client/core/accessibility.js',
      'client/core/shell.js',
      `app.js?v=${EXPECTED_APP_QUERY}`,
      `ppt.js?v=${EXPECTED_PPT_QUERY}`,
      `client/core/csp_compat.js?v=${EXPECTED_SECURITY_QUERY}`
    ]
  );
  assert.equal(
    sources.indexOf('client/shared/build_info.js') < sources.indexOf(`app.js?v=${EXPECTED_APP_QUERY}`),
    true,
    'build_info.js must load before app.js'
  );
  assert.equal(
    sources.indexOf('client/shared/build_info.js') < sources.indexOf('client/core/navigation.js')
      && sources.indexOf('client/core/navigation.js') < sources.indexOf('client/core/accessibility.js')
      && sources.indexOf('client/core/accessibility.js') < sources.indexOf('client/core/shell.js')
      && sources.indexOf('client/core/shell.js') < sources.indexOf(`app.js?v=${EXPECTED_APP_QUERY}`)
      && sources.indexOf(`app.js?v=${EXPECTED_APP_QUERY}`) < sources.indexOf(`ppt.js?v=${EXPECTED_PPT_QUERY}`)
      && sources.indexOf(`ppt.js?v=${EXPECTED_PPT_QUERY}`) < sources.indexOf(`client/core/csp_compat.js?v=${EXPECTED_SECURITY_QUERY}`),
    true,
    'Wave 1 browser modules must load in the approved dependency order'
  );
  assert.equal(sources.some((source) => /campaign_(?:context|workspace|ppt_bridge)\.js/.test(source)), false);
});

test('build_info.js publishes the exact frozen public build metadata and compatibility marker', () => {
  assert.equal(fs.existsSync(buildInfoPath), true, 'platform/client/shared/build_info.js must exist');
  const window = {};
  window.window = window;
  vm.runInNewContext(read(buildInfoPath), { window }, { filename: buildInfoPath });

  assert.equal(window.TMBuild.app, EXPECTED_APP_BUILD);
  assert.equal(window.TMBuild.ppt, EXPECTED_PPT_BUILD);
  assert.equal(Object.isFrozen(window.TMBuild), true);
  assert.equal(window.tmAppBuild, EXPECTED_APP_BUILD);

  window.tmAppBuild = '20260630-auth-upload-fix';
  assert.equal(
    window.tmAppBuild,
    EXPECTED_APP_BUILD,
    'app.js must not be able to overwrite the public compatibility marker'
  );
});

test('both new browser assets pass node --check as the actual release files', () => {
  for (const assetPath of [cspCompatPath, pptPreviewRuntimePath]) {
    const result = spawnSync(process.execPath, ['--check', assetPath], {
      encoding: 'utf8',
      timeout: 30_000
    });
    assert.equal(
      result.status,
      0,
      `${path.relative(platformRoot, assetPath)}: ${result.stderr || result.stdout}`
    );
  }
});

test('navigation registry is owned by navigation.js without legacy app anchors', () => {
  const appJs = read(appPath);
  const navigationJs = read(navigationPath);

  assert.doesNotMatch(appJs, /navigation-line-anchor-/);
  assert.doesNotMatch(appJs, /switchPage side-effect anchor/);
  assert.doesNotMatch(appJs, /Legacy test anchors/);
  assert.doesNotMatch(appJs, /function rebuildNav/);

  [
    ["m0", "客户看板"],
    ["m0-detail", "客户明细"],
    ["m4", "网红匹配 & 执行管理"],
    ["admin", "管理控制室"]
  ].forEach(([pageId, label]) => {
    assert.match(navigationJs, new RegExp(`id:\\s*'${pageId}'[\\s\\S]*?label:\\s*'${label}'`));
  });
});

test('Express public asset gate allows only the exact approved client assets', () => {
  const approved = CANONICAL_CLIENT_ASSETS.map((asset) => `/${asset}`);
  assertExactClientAssetInventory(expressAllowedClientRoutes(), 'Express allowed client routes');
  for (const requestPath of approved) {
    assert.equal(publicAssets.isPrivateRequestPath(requestPath), false, requestPath);
    assert.equal(publicAssets.isPrivateRequestPath(`${requestPath}?cache=1`), false, `${requestPath}?cache=1`);
  }

  [
    '/client/',
    '/client/core/',
    '/client/shared/',
    '/client/unknown.js',
    '/client/core/navigation.js/extra',
    '/client/core/%6eavigation.js',
    '/client/core/accessibility.js/extra',
    '/client/core/%61ccessibility.js',
    '/client/core/csp_compat.js/extra',
    '/client/core/%63sp_compat.js',
    '/client/features/ppt_preview_runtime.js/extra',
    '/client/features/%70pt_preview_runtime.js',
    '/client/features/campaign_context.js',
    '/client/features/campaign_workspace.js',
    '/client/features/campaign_ppt_bridge.js',
    '/client/styles/tokens.css/extra',
    '/client/styles/%74okens.css',
    '/client/../server/server.js',
    '/client/%2e%2e/server/server.js',
    '/client/%252e%252e/server/server.js',
    '/client/shared/%2e%2e/%2e%2e/server/server.js',
    '/client/shared%5c..%5c..%5cserver%5cserver.js',
    '/client/shared/build_info.js%5c..%5cunknown.js',
    '/client/shared/%62uild_info.js'
  ].forEach((requestPath) => {
    assert.equal(
      publicAssets.isPrivateRequestPath(requestPath),
      true,
      `${requestPath} must stay private`
    );
  });
});

test('registerPublicAssets binds exactly the canonical client routes to their exact file handlers', () => {
  const registrations = [];
  const app = {
    use() {},
    get(requestPath, handler) { registrations.push({ requestPath, handler }); }
  };
  const express = { static() { return function staticFiles() {}; } };
  publicAssets.registerPublicAssets(app, express, platformRoot);

  assertExactClientAssetInventory(
    registrations
      .map((registration) => registration.requestPath)
      .filter((requestPath) => requestPath.startsWith('/client/')),
    'Express registered client routes'
  );
  for (const asset of CANONICAL_CLIENT_ASSETS) {
    const requestPath = `/${asset}`;
    const matching = registrations.filter((registration) => registration.requestPath === requestPath);
    assert.equal(matching.length, 1, `${requestPath} must have one exact app.get registration`);
    assert.equal(typeof matching[0].handler, 'function', `${requestPath} must register a handler`);

    let sentFile = null;
    let sentOptions = null;
    matching[0].handler({}, {
      sendFile(filePath, options) {
        sentFile = filePath;
        sentOptions = options;
      }
    });
    assert.equal(sentFile, asset, `${requestPath} handler must send ${asset}`);
    assert.equal(sentOptions.root, platformRoot, `${requestPath} handler must constrain the public root`);
    assert.equal(sentOptions.dotfiles, 'deny', `${requestPath} handler must deny dotfiles`);
  }
});

test('Nginx config exposes only the nine exact Wave 1 client assets and rejects every other client path', () => {
  const config = read(nginxConfigPath);
  const activeConfig = config
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  const exactClientLocations = Array.from(
    activeConfig.matchAll(/^\s*location\s*=\s*(\/client\/[^\s{]+)\s*\{/gm),
    (match) => match[1]
  );
  assertExactClientAssetInventory(exactClientLocations, 'Nginx exact client locations');
  for (const asset of CANONICAL_CLIENT_ASSETS) {
    const requestPath = `/${asset}`;
    const locationBlock = exactNginxLocationBlock(activeConfig, requestPath);
    const guardedAsset = asset.slice('client/'.length).replaceAll('.', '\\.');
    assert.ok(
      locationBlock.includes(`$request_uri !~ ^/client/${guardedAsset}(?:\\?|$)`),
      `Nginx raw URI guard for ${asset}`
    );
  }
  assert.match(activeConfig, /location \^~ \/client\/\s*\{\s*return 404;\s*\}/);
  assert.doesNotMatch(activeConfig, /alias\s+.*client/i);
  for (const excluded of ['campaign_context.js', 'campaign_workspace.js', 'campaign_ppt_bridge.js']) {
    assert.doesNotMatch(activeConfig, new RegExp(`location\\s*=\\s*/client/features/${excluded.replace('.', '\\.')}\\s*\\{`));
  }
});

test('exact CSP candidate stays byte-equivalent but inactive until legacy execution blockers are migrated', () => {
  assert.equal(publicAssets.CONTENT_SECURITY_POLICY, EXPECTED_CSP);

  const middleware = [];
  const app = {
    use(...args) { middleware.push(args); },
    get() {}
  };
  const express = { static() { return function staticFiles() {}; } };
  publicAssets.registerPublicAssets(app, express, platformRoot);

  const headers = new Map();
  for (const registration of middleware) {
    if (typeof registration[0] !== 'function') continue;
    registration[0](
      { originalUrl: '/index.html', url: '/index.html' },
      { set(name, value) { headers.set(name, value); } },
      () => {}
    );
  }
  assert.equal(headers.has('Content-Security-Policy'), false, 'Express must not enforce CSP yet');

  const nginxConfig = read(nginxConfigPath);
  const parkedCandidates = Array.from(nginxConfig.matchAll(
    /^\s*#\s*add_header\s+Content-Security-Policy\s+"([^"]+)"\s+always;\s*$/gm
  ));
  assert.equal(parkedCandidates.length, 1, 'Nginx must retain one reviewable, inactive CSP candidate');
  assert.equal(parkedCandidates[0][1], EXPECTED_CSP);

  const activeConfig = nginxConfig
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(
    activeConfig,
    /^\s*add_header\s+Content-Security-Policy\b/m,
    'Nginx must not enforce CSP until the app and index migration is complete'
  );
  assert.match(activeConfig, /^\s*proxy_hide_header\s+Content-Security-Policy;\s*$/m);
});

test('guarded deploy uploads, checks, verifies, and backs up all nine Wave 1 client assets', () => {
  const deploy = read(deployScriptPath);

  assert.match(deploy, /\$EXPECTED_APP_BUILD\s*=\s*"20260811-v060-crm-sales-workspace"/);
  assert.match(deploy, /\$EXPECTED_APP_QUERY\s*=\s*"20260811v060crmsalesworkspace"/);
  assert.deepEqual(powerShellArrayEntries(deploy, 'requiredPublicAssets'), CANONICAL_CLIENT_ASSETS);
  for (const asset of CANONICAL_CLIENT_ASSETS) {
    assert.ok(deploy.includes(`"${asset.replace(/\//g, '\\')}"`), `deploy manifest must include ${asset}`);
  }
  assert.match(deploy, /if \[ -f "\$file" \]; then[\s\S]*?cp -- "\$file" "\$BackupAbsolute\/platform\/\$file"/);
  assert.match(deploy, /sha256sum --check --status "\$LockDir\/upload\.sha256"/);
  assert.match(deploy, /node --check client\/shared\/build_info\.js/);
  assert.match(deploy, /node --check client\/core\/navigation\.js/);
  assert.match(deploy, /node --check client\/core\/accessibility\.js/);
  assert.match(deploy, /node --check client\/core\/shell\.js/);
  assert.match(deploy, /node --check client\/core\/csp_compat\.js/);
  assert.match(deploy, /node --check client\/features\/ppt_preview_runtime\.js/);
  assert.match(deploy, /expect_javascript \/client\/core\/csp_compat\.js/);
  assert.match(deploy, /expect_javascript \/client\/features\/ppt_preview_runtime\.js/);
  assert.match(deploy, /grep -Fq "\$APP_QUERY" index\.html/);
  assert.match(deploy, /grep -Fq "\$APP_BUILD" client\/shared\/build_info\.js/);
  assert.match(deploy, /grep -Fq "\$PPT_QUERY" index\.html/);
  assert.match(deploy, /grep -Fq "\$PPT_BUILD" ppt\.js/);
  assert.match(deploy, /\.Replace\('__APP_QUERY__', \$EXPECTED_APP_QUERY\)/);
  assert.match(deploy, /\.Replace\('__PPT_BUILD__', \$EXPECTED_PPT_BUILD\)/);
});

test('$FILES client subset is exactly the canonical nine client assets', () => {
  const deployClientFiles = powerShellArrayEntries(read(deployScriptPath), 'FILES')
    .filter((entry) => /^(?:\.\/)*client\//i.test(entry.replace(/\\/g, '/')));
  assertExactClientAssetInventory(deployClientFiles, 'deploy $FILES client subset');
});

test('guarded deploy keeps distinct pinned-local and candidate-path syntax checks for both new assets', () => {
  const deploy = read(deployScriptPath);

  assert.match(deploy, /\$cspCompatRecord = \$deploymentPlan\.GetByRemoteRelativePath\('platform\/client\/core\/csp_compat\.js'\)/);
  assert.match(deploy, /\$pptPreviewRuntimeRecord = \$deploymentPlan\.GetByRemoteRelativePath\('platform\/client\/features\/ppt_preview_runtime\.js'\)/);
  assert.match(deploy, /@\{ Record = \$cspCompatRecord; Label = 'CSP compatibility' \}/);
  assert.match(deploy, /@\{ Record = \$pptPreviewRuntimeRecord; Label = 'PPT preview runtime' \}/);
  assert.equal((deploy.match(/Invoke-NativeWithPinnedInput -Record \$syntaxCheck\.Record -FileName 'node'/g) || []).length, 1);
  assert.equal((deploy.match(/^\s*node --check client\/core\/csp_compat\.js\s*$/gm) || []).length, 1);
  assert.equal((deploy.match(/^\s*node --check client\/features\/ppt_preview_runtime\.js\s*$/gm) || []).length, 1);
});

test('deployment smoke requires HTTP 200 and a JavaScript Content-Type for every public JS asset', () => {
  const deploy = read(deployScriptPath);
  const helperMatch = deploy.match(/^expect_javascript\(\)\s*\{\r?\n(?<body>[\s\S]*?)^\}/m);
  assert.ok(helperMatch, 'deploy smoke must define expect_javascript');
  const helperBody = helperMatch.groups.body;

  assert.match(helperBody, /curl[\s\S]*?-w '%\{http_code\} %\{content_type\}'/);
  assert.match(helperBody, /if \[ "\$actual" != "200" \]/);
  assert.match(helperBody, /case "\$content_type" in[\s\S]*?(?:application|text)\/javascript/);

  for (const asset of CANONICAL_CLIENT_ASSETS.filter((entry) => entry.endsWith('.js'))) {
    const escapedRoute = `/${asset}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal(
      (deploy.match(new RegExp(`^\\s*expect_javascript ${escapedRoute}\\s*$`, 'gm')) || []).length,
      1,
      `${asset} must have one JavaScript-aware smoke check`
    );
  }
});

test('candidate loopback verifies every exact JS and CSS asset MIME before durable acceptance', () => {
  const cutover = powerShellSingleQuotedHereString(read(deployScriptPath), 'cutoverGate');
  const acceptanceBoundary = cutover.indexOf('\narm_one_request_release_replay\n');
  assert.notEqual(acceptanceBoundary, -1, 'candidate acceptance boundary must exist');
  const preAcceptance = cutover.slice(0, acceptanceBoundary);

  const javascriptHelper = preAcceptance.match(
    /^expect_loopback_javascript\(\)\s*\{\r?\n(?<body>[\s\S]*?)^\}/m
  );
  const stylesheetHelper = preAcceptance.match(
    /^expect_loopback_stylesheet\(\)\s*\{\r?\n(?<body>[\s\S]*?)^\}/m
  );
  assert.ok(javascriptHelper, 'candidate gate must define a loopback JavaScript MIME helper');
  assert.ok(stylesheetHelper, 'candidate gate must define a loopback stylesheet MIME helper');
  assert.match(javascriptHelper.groups.body, /http:\/\/localhost:3002\$request_path/);
  assert.match(javascriptHelper.groups.body, /-w '%\{http_code\} %\{content_type\}'/);
  assert.match(javascriptHelper.groups.body, /application\/javascript\|application\/javascript\\;\*\|text\/javascript\|text\/javascript\\;\*/);
  assert.match(stylesheetHelper.groups.body, /http:\/\/localhost:3002\$request_path/);
  assert.match(stylesheetHelper.groups.body, /-w '%\{http_code\} %\{content_type\}'/);
  assert.match(stylesheetHelper.groups.body, /text\/css\|text\/css\\;\*/);

  for (const asset of CANONICAL_CLIENT_ASSETS) {
    const helper = asset.endsWith('.js') ? 'expect_loopback_javascript' : 'expect_loopback_stylesheet';
    const escapedRoute = `/${asset}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal(
      (preAcceptance.match(new RegExp(`^${helper} ${escapedRoute}$`, 'gm')) || []).length,
      1,
      `${asset} must have one candidate MIME check before acceptance`
    );
  }
});

test('exact public Nginx verifier rejects wrong MIME and exposed server routes', async () => {
  const valid = await runExactVerifierAgainstSyntheticCandidate('valid');
  assert.equal(valid.status, 0, `valid candidate must pass:\n${valid.stderr}`);

  const wrongMime = await runExactVerifierAgainstSyntheticCandidate('wrong-mime');
  assert.notEqual(wrongMime.status, 0, 'wrong JavaScript MIME must fail the exact verifier');
  assert.match(wrongMime.stderr, /Content-Type.*JavaScript/i);

  const exposedServer = await runExactVerifierAgainstSyntheticCandidate('exposed-server');
  assert.notEqual(exposedServer.status, 0, 'an exposed server route must fail the exact verifier');
  assert.match(exposedServer.stderr, /server\/server\.js.*expected 404/i);
});

test('accepted-finalize verifier failures restore the closed API gate before publishing finalization', {
  skip: !hasBash ? 'requires Bash trap execution' : false
}, async () => {
  for (const mode of ['wrong-mime', 'exposed-server']) {
    const verifier = await runExactVerifierAgainstSyntheticCandidate(mode);
    assert.notEqual(verifier.status, 0, `${mode} must reach the fail-closed recovery path`);

    const recovery = runAcceptedFinalizeRecoveryHarness(mode);
    assert.notEqual(recovery.result.status, 0, `${mode} finalization must remain failed`);
    assert.equal(recovery.publicConfig, 'CLOSED_API_GATE\n', `${mode} must atomically restore ApiGateConfig`);
    assert.match(recovery.recoveryLog, /^nginx:-t$/m, `${mode} must validate the restored gate`);
    assert.match(recovery.recoveryLog, /^systemctl:reload nginx$/m, `${mode} must reload Nginx`);
    assert.equal(recovery.acceptedPublished, false, `${mode} must not publish an accepted marker`);
    assert.equal(recovery.finalizationPublished, false, `${mode} must not publish finalization`);
  }

  const finalize = acceptedFinalizeSource();
  const arm = finalize.indexOf("trap 'recover_accepted_finalize_public_failure $?' ERR EXIT");
  const publicActivation = finalize.indexOf('install -m 0644 "$StagedPublicNginx" "$PublicNginxConfig"');
  const exactVerifier = finalize.indexOf('run_exact_public_nginx_gate - 80', publicActivation);
  const trustedDisarm = finalize.indexOf('public_release_guard disarm', exactVerifier);
  const disarm = finalize.indexOf('trap - ERR EXIT HUP INT TERM', trustedDisarm);
  assert.ok(arm >= 0 && arm < publicActivation, 'recovery must be armed before public activation');
  assert.ok(publicActivation < exactVerifier && exactVerifier < trustedDisarm && trustedDisarm < disarm, 'recovery must stay armed through exact verification');
});

test('review12 remediation captures the recovered deployment acceptance state', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runDeployPowerShellHarness(
    ['Get-RemoteDeploymentAcceptanceState'],
    String.raw`
$script:captureOutputObserved = $false
function Invoke-RemoteBash {
  param(
    [string]$Script,
    [string]$FailureMessage,
    [switch]$RequireDeploymentLock,
    [switch]$RequireWriterLock,
    [switch]$CaptureOutput
  )
  $script:captureOutputObserved = [bool]$CaptureOutput
  if (-not $CaptureOutput) { return $null }
  return @('remote diagnostic', 'current-marker-prior')
}
$REMOTE_ROOT = '/root/turingmarket'
$TRUSTED_SOURCE_BUNDLE_REMOTE_PATH = '/trusted/source/bundle'
$EXPECTED_TRUSTED_PARSER_VERIFIER_SHA256 = ('a' * 64)
$state = Get-RemoteDeploymentAcceptanceState
if (-not $script:captureOutputObserved) { throw 'ACCEPTANCE_CAPTURE_NOT_REQUESTED' }
if ($state -ne 'current-marker-prior') { throw "ACCEPTANCE_STATE_NOT_CAPTURED:$state" }
Write-Output "ACCEPTANCE_STATE_CAPTURED:$state"
`
  );

  assertPowerShellHarnessSucceeded(result);
  assert.match(result.stdout, /^ACCEPTANCE_STATE_CAPTURED:current-marker-prior$/m);
});

test('the exact staged Nginx gate precedes acceptance and is reused after publication and recovery', () => {
  const deploy = read(deployScriptPath);
  const cutover = powerShellSingleQuotedHereString(deploy, 'cutoverGate');
  const exactVerifier = exactPublicNginxVerifierSource();
  const isolatedDefinition = cutover.indexOf('assert_staged_nginx_candidate_behavior()');
  const isolatedCall = cutover.indexOf('\nassert_staged_nginx_candidate_behavior\n');
  const replayBoundary = cutover.indexOf('\narm_one_request_release_replay\n');
  const evidencePublication = cutover.indexOf('mv "$AcceptedEvidence.next" "$AcceptedEvidence"');
  assert.ok(isolatedDefinition >= 0 && isolatedCall > isolatedDefinition);
  assert.ok(isolatedCall < replayBoundary && isolatedCall < evidencePublication);

  const isolatedGate = cutover.slice(isolatedDefinition, cutover.indexOf('\narm_one_request_release_replay()'));
  assert.match(isolatedGate, /python3 - "\$StagedPublicNginx" "\$GateSite" "\$GateSocket"/);
  assert.match(isolatedGate, /nginx -t -p "\$GateDir\/" -c "\$GateConfig"/);
  assert.match(isolatedGate, /nginx -p "\$GateDir\/" -c "\$GateConfig" -g 'daemon off;'/);
  assert.match(isolatedGate, /run_exact_public_nginx_gate "\$GateSocket" 0/);

  const publicBoundary = cutover.indexOf('\nactivate_public_candidate\n');
  assert.ok(cutover.indexOf('\nrun_exact_public_nginx_gate - 80\n', publicBoundary) > publicBoundary);
  const finalizeStart = deploy.indexOf('function Invoke-RemoteAcceptedFinalize');
  const finalizeEnd = deploy.indexOf('function Invoke-RemoteCandidateCleanup', finalizeStart);
  const finalize = deploy.slice(finalizeStart, finalizeEnd);
  assert.match(finalize, /systemctl reload nginx\s+run_exact_public_nginx_gate - 80/);
  assert.equal(
    (deploy.match(/\.Replace\('__EXACT_PUBLIC_NGINX_VERIFIER__', \$exactPublicNginxVerifier\)/g) || []).length,
    3,
    'cutover, accepted finalization, and rollback recovery must receive the same verifier source'
  );
  for (const asset of CANONICAL_CLIENT_ASSETS) {
    assert.match(exactVerifier, new RegExp(`['"]/${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  }
  for (const denied of ['/client/unknown.js', '/server/server.js', '/uploads/private', '/docs/private', '/.env']) {
    assert.ok(exactVerifier.includes(`'${denied}'`), `${denied} must be denied by the shared verifier`);
  }
});

test('candidate exposure failures are fail-closed before any durable acceptance publication', () => {
  const cutover = powerShellSingleQuotedHereString(read(deployScriptPath), 'cutoverGate');
  const replayBoundary = cutover.indexOf('\narm_one_request_release_replay\n');
  const evidencePublication = cutover.indexOf('mv "$AcceptedEvidence.next" "$AcceptedEvidence"');
  const journalPublication = cutover.indexOf('mv -f "$LockDir/accepted.next" "$AcceptedMarker"');
  const markerPublication = cutover.indexOf('\ninstall_current_accepted_marker\n');
  for (const [label, offset] of [
    ['release replay', replayBoundary],
    ['accepted evidence', evidencePublication],
    ['accepted journal', journalPublication],
    ['current accepted marker', markerPublication]
  ]) {
    assert.notEqual(offset, -1, `${label} boundary must exist`);
  }

  const preAcceptance = cutover.slice(0, replayBoundary);
  assert.match(cutover, /^set -euo pipefail$/m, 'candidate gate must abort on a failed direct check');
  for (const directCheck of [
    'expect_loopback_status 404 /client/unknown.js',
    'expect_loopback_status 404 /server/server.js'
  ]) {
    const checkOffset = cutover.indexOf(`\n${directCheck}\n`);
    assert.ok(checkOffset > 0 && checkOffset < replayBoundary, `${directCheck} must precede acceptance`);
    assert.match(preAcceptance, new RegExp(`^${directCheck.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.ok(replayBoundary < evidencePublication, 'checks must fail before accepted evidence can become durable');
  assert.ok(replayBoundary < journalPublication, 'checks must fail before the acceptance journal can become durable');
  assert.ok(replayBoundary < markerPublication, 'checks must fail before the current marker can become durable');
});

test('post-public smoke retains exact JS and CSS MIME plus unknown-path checks as a secondary gate', () => {
  const cutover = powerShellSingleQuotedHereString(read(deployScriptPath), 'cutoverGate');
  const publicBoundary = cutover.indexOf('\nactivate_public_candidate\n');
  assert.notEqual(publicBoundary, -1);
  const postPublic = cutover.slice(publicBoundary);
  assert.match(postPublic, /^expect_javascript\(\)/m);
  assert.match(postPublic, /^expect_stylesheet\(\)/m);
  for (const asset of CANONICAL_CLIENT_ASSETS) {
    const helper = asset.endsWith('.js') ? 'expect_javascript' : 'expect_stylesheet';
    const escapedRoute = `/${asset}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal((postPublic.match(new RegExp(`^${helper} ${escapedRoute}$`, 'gm')) || []).length, 1);
  }
  assert.match(postPublic, /^expect_status 404 \/client\/unknown\.js$/m);
  assert.match(postPublic, /^expect_status 404 \/server\/server\.js$/m);
  assert.match(postPublic, /^run_exact_public_nginx_gate - 80$/m);
});

test('one immutable action-plan identity feeds backup, hash, preparation, and upload actions', () => {
  const deploy = read(deployScriptPath);
  const backupStart = deploy.indexOf('function Invoke-RemoteBackup');
  const backupEnd = deploy.indexOf('function ', backupStart + 20);
  const backup = deploy.slice(backupStart, backupEnd);
  assert.match(backup, /\[object\]\$DeploymentPlan/);
  assert.match(backup, /\$DeploymentPlan -isnot \[ImmutableDeploymentActionPlan\]/);
  assert.match(backup, /foreach \(\$record in \$DeploymentPlan\.Records\)/);

  const planOffset = deploy.indexOf('$deploymentActionPlan = Assert-LocalReleaseSource');
  assert.notEqual(planOffset, -1, 'one local attestation must return the deployment action plan');
  for (const action of [
    '$uploadChecksums = Get-DeploymentPlanChecksumManifest -DeploymentPlan $deploymentActionPlan',
    '$remotePathManifest = Get-DeploymentPlanRemotePathManifest -DeploymentPlan $deploymentActionPlan',
    'Invoke-RemoteBackup -BackupPath $backupDir -DeploymentPlan $deploymentActionPlan',
    'foreach ($record in $deploymentActionPlan.Records)',
    'Invoke-PinnedDeploymentUpload -Record $record -RemoteRoot $remoteReleaseRoot'
  ]) {
    assert.ok(deploy.indexOf(action) > planOffset, `${action} must consume the sealed plan`);
  }
  assert.match(deploy, /\$deploymentSourceSha256 = \(\$deploymentActionPlan\.Identity -split ':', 2\)\[1\]/);
});

test('every local source is opened once into pinned bytes before any action consumer', () => {
  const deploy = read(deployScriptPath);
  const start = deploy.indexOf('function New-ImmutableDeploymentActionPlan');
  const end = deploy.indexOf('function Invoke-NativeWithPinnedInput', start);
  const plan = deploy.slice(start, end);
  assert.equal((plan.match(/Get-CanonicalLocalUploadFile/g) || []).length, 1);
  assert.equal((plan.match(/\[IO\.FileStream\]::new\(/g) || []).length, 1);
  assert.match(plan, /\[IO\.FileAccess\]::Read,[\s\S]*?\[IO\.FileShare\]::Read/);
  assert.ok(plan.indexOf('GetFinalPath($sourceStream)') < plan.indexOf('$sourceStream.CopyTo($snapshot)'));
  assert.ok(plan.indexOf('$sourceStream.CopyTo($snapshot)') < plan.indexOf('Sha256($sourceBytes)'));
  assert.ok(plan.indexOf('Sha256($sourceBytes)') < plan.lastIndexOf('$sourceBytes'));
  assert.doesNotMatch(deploy, /\[IO\.File\]::ReadAllBytes\(/);
  assert.doesNotMatch(deploy, /Get-FileHash -Algorithm SHA256 -LiteralPath/);
});

test('PowerShell AST contains one immutable exact required-public-assets assignment', {
  skip: process.platform !== 'win32'
}, () => {
  assert.deepEqual(powerShellAstArrayEntries(deployScriptPath, 'requiredPublicAssets'), CANONICAL_CLIENT_ASSETS);
});

const REQUIRED_PUBLIC_ASSETS_AST_FIXTURE = String.raw`
$requiredPublicAssets = @(
  "client/core/csp_compat.js",
  "client/features/ppt_preview_runtime.js"
)
`;

for (const [mutationName, mutation] of [
  ['index assignment', '$requiredPublicAssets[0] = "client/evil.js"'],
  ['Set-Variable', 'Set-Variable -Name requiredPublicAssets -Value @("client/evil.js")'],
  ['variable-provider Set-Item', 'Set-Item -Path Variable:requiredPublicAssets -Value @("client/evil.js")'],
  ['instance SetValue', '$requiredPublicAssets.SetValue("client/evil.js", 0)'],
  ['static Array Reverse', '[Array]::Reverse($requiredPublicAssets)'],
  ['foreach loop-variable assignment', 'foreach ($requiredPublicAssets in @("client/evil.js")) { }'],
  [
    'MethodInfo Invoke of Array Reverse',
    '$reverseMethod = [Array].GetMethod("Reverse", [Type[]]@([Array]))\n'
      + '$null = $reverseMethod.Invoke($null, [object[]](,$requiredPublicAssets))'
  ],
  [
    'MethodInfo Invoke through an argument container',
    '$reverseMethod = [Array].GetMethod("Reverse", [Type[]]@([Array]))\n'
      + '$invokeArguments = [object[]]@(,$requiredPublicAssets)\n'
      + '$null = $reverseMethod.Invoke($null, $invokeArguments)'
  ],
  [
    'Array Copy destination',
    '$replacement = @("client/evil-a.js", "client/evil-b.js")\n'
      + '[Array]::Copy($replacement, $requiredPublicAssets, $replacement.Length)'
  ],
  [
    'Array ConstrainedCopy destination',
    '$replacement = @("client/evil-a.js", "client/evil-b.js")\n'
      + '[Array]::ConstrainedCopy($replacement, 0, $requiredPublicAssets, 0, $replacement.Length)'
  ],
  [
    'Array Copy destination through an object container',
    '$replacement = @("client/evil-a.js", "client/evil-b.js")\n'
      + '$holder = [pscustomobject]@{ Assets = $requiredPublicAssets }\n'
      + '[Array]::Copy($replacement, $holder.Assets, $replacement.Length)'
  ],
  [
    'instance CopyTo destination',
    '$replacement = @("client/evil-a.js", "client/evil-b.js")\n'
      + '$replacement.CopyTo($requiredPublicAssets, 0)'
  ],
  [
    'instance CopyTo inline Variable-provider destination',
    '$replacement = @("client/evil-a.js", "client/evil-b.js")\n'
      + '$replacement.CopyTo((Get-Item Variable:requiredPublicAssets).Value, 0)'
  ],
  [
    'object-container alias then indexed mutation',
    '$holder = [pscustomobject]@{ Assets = $null }\n'
      + '$holder.Assets = $requiredPublicAssets\n'
      + '$holder.Assets[0] = "client/evil.js"'
  ],
  [
    'Get-Item Variable record.Value indexed mutation',
    '$record = Get-Item Variable:requiredPublicAssets\n'
      + '$record.Value[0] = "client/evil.js"'
  ],
  [
    'inline Get-Item Variable record.Value indexed mutation',
    '(Get-Item Variable:requiredPublicAssets).Value[0] = "client/evil.js"'
  ],
  [
    'SessionState PSVariable.Get record.Value indexed mutation',
    '$ExecutionContext.SessionState.PSVariable.Get("requiredPublicAssets").Value[0] = "client/evil.js"'
  ],
  [
    'ArrayList retained protected reference mutation',
    '$references = [Collections.ArrayList]::new()\n'
      + '[void]$references.Add($requiredPublicAssets)\n'
      + '$references[0][0] = "client/evil.js"'
  ],
  [
    'source function mutation',
    'function Set-FirstAsset { param([object[]]$Target) $Target[0] = "client/evil.js" }\n'
      + 'Set-FirstAsset $requiredPublicAssets'
  ],
  [
    'alias to source function mutation',
    'function Set-FirstAsset { param([object[]]$Target) $Target[0] = "client/evil.js" }\n'
      + 'Set-Alias -Name overwriteAssets -Value Set-FirstAsset\n'
      + 'overwriteAssets $requiredPublicAssets'
  ],
  [
    'Type InvokeMember reflection',
    '[Array].InvokeMember("Reverse", [Reflection.BindingFlags]::InvokeMethod, '
      + '$null, $null, [object[]](,$requiredPublicAssets))'
  ],
  [
    'Invoke-Expression dynamic code',
    'Invoke-Expression \'$requiredPublicAssets[0] = "client/evil.js"\''
  ],
  [
    'unknown source command receiving a protected reference',
    'Invoke-UnknownAssetOperation $requiredPublicAssets'
  ],
  [
    'unknown instance member on a protected reference',
    '$requiredPublicAssets.MutateSomehow()'
  ],
  [
    'ExecutionContext SessionState PSVariable.Set replacement',
    '$ExecutionContext.SessionState.PSVariable.Set("requiredPublicAssets", @("client/evil.js"))'
  ],
  [
    'variable-provider Set-Content',
    'Set-Content -Path Variable:requiredPublicAssets -Value @("client/evil.js")'
  ],
  [
    'built-in Set-Content alias',
    'sc -Path Variable:requiredPublicAssets -Value @("client/evil.js")'
  ],
  [
    'source-defined command alias',
    'Set-Alias -Name overwriteAssets -Value Set-Content\n'
      + 'overwriteAssets -Path Variable:requiredPublicAssets -Value @("client/evil.js")'
  ],
  [
    'source-defined command alias rebound after mutation',
    'Set-Alias -Name overwriteAssets -Value Set-Content\n'
      + 'overwriteAssets -Path Variable:requiredPublicAssets -Value @("client/evil.js")\n'
      + 'Set-Alias -Name overwriteAssets -Value Get-Content'
  ],
  [
    'Alias provider shadows a built-in read alias',
    'Set-Item -Path Alias:gc -Value Set-Content -Force\n'
      + 'gc -Path Variable:requiredPublicAssets -Value @("client/evil.js")'
  ],
  [
    'function shadows a provider read command',
    'function Get-Content {\n'
      + '  param([string]$Path, [object]$Value)\n'
      + '  Microsoft.PowerShell.Management\\Set-Content -Path $Path -Value $Value\n'
      + '}\n'
      + 'Get-Content -Path Variable:script:requiredPublicAssets -Value @("client/evil.js")'
  ],
  [
    'ScriptBlock Create dynamic invocation',
    '& ([scriptblock]::Create(\'$requiredPublicAssets[0] = "client/evil.js"\'))'
  ],
  [
    'unresolved source-defined command alias and provider path',
    '$writer = "Set-Content"\nSet-Alias -Name overwriteAssets -Value $writer\n'
      + '$targetName = "requiredPublicAssets"\n$targetPath = "Variable:$targetName"\n'
      + 'overwriteAssets -Path $targetPath -Value @("client/evil.js")'
  ],
  [
    'variable alias indexed assignment',
    '$assetsAlias = $requiredPublicAssets\n$assetsAlias[0] = "client/evil.js"'
  ],
  [
    'chained variable alias indexed assignment',
    '$assetsAlias = $requiredPublicAssets\n$secondAlias = $assetsAlias\n'
      + '$secondAlias[0] = "client/evil.js"'
  ],
  [
    'Variable provider alias indexed assignment',
    'Set-Item -Path Variable:assetsAlias -Value $requiredPublicAssets\n'
      + '$assetsAlias[0] = "client/evil.js"'
  ],
  [
    'unresolved dynamic variable-provider path',
    '$targetName = "requiredPublicAssets"\n$targetPath = "Variable:$targetName"\n'
      + 'Set-Content -Path $targetPath -Value @("client/evil.js")'
  ],
  [
    'unresolved dynamic command targeting the variable provider',
    '$writer = "Set-Content"\n'
      + '& $writer -Path Variable:requiredPublicAssets -Value @("client/evil.js")'
  ]
]) {
  test(`PowerShell AST rejects requiredPublicAssets post-initialization ${mutationName}`, {
    skip: process.platform !== 'win32'
  }, () => {
    assert.throws(
      () => powerShellAstArrayEntriesFromSource(
        `${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\n${mutation}`,
        'requiredPublicAssets'
      ),
      /must remain immutable after initialization/
    );
  });
}

for (const [callPathName, functionSource, invocation] of [
  [
    'direct assignment',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }',
    'Invoke-PreInitMutation'
  ],
  [
    'Variable provider write',
    'function Invoke-PreInitMutation { Set-Content -Path Variable:script:requiredPublicAssets -Value @("client/evil.js") }',
    'Invoke-PreInitMutation'
  ],
  [
    'Array reflection',
    'function Invoke-PreInitMutation { [Array]::Reverse($script:requiredPublicAssets) }',
    'Invoke-PreInitMutation'
  ],
  [
    'dynamic code',
    'function Invoke-PreInitMutation { Invoke-Expression \'$script:requiredPublicAssets[0] = "client/evil.js"\' }',
    'Invoke-PreInitMutation'
  ],
  [
    'pre-bound source alias',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }\n'
      + 'Set-Alias -Name invokeAssetMutation -Value Invoke-PreInitMutation',
    'invokeAssetMutation'
  ],
  [
    'computed concatenated direct variable invocation without protected arguments',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }',
    '$fn = "Invoke-" + "PreInitMutation"\n& $fn'
  ],
  [
    'computed format-expression direct variable invocation without protected arguments',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }',
    '$fn = "Invoke-{0}" -f "PreInitMutation"\n& $fn'
  ],
  [
    'Function provider invocation without protected arguments',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }',
    '& Function:Invoke-PreInitMutation'
  ],
  [
    'computed concatenated indirection invocation without protected arguments',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }',
    '$fn = "Invoke-" + "PreInitMutation"\n$indirect = $fn\n& $indirect'
  ],
  [
    'computed formatted container invocation without protected arguments',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }',
    '$holder = [pscustomobject]@{ Command = "Invoke-{0}" -f "PreInitMutation" }\n'
      + '& $holder.Command'
  ],
  [
    'dynamic direct variable invocation without protected arguments',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }',
    '$fn = "Invoke-PreInitMutation"\n& $fn'
  ],
  [
    'dynamic indirection invocation without protected arguments',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }',
    '$fn = "Invoke-PreInitMutation"\n$indirect = $fn\n& $indirect'
  ],
  [
    'dynamic container invocation without protected arguments',
    'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }',
    '$fn = "Invoke-PreInitMutation"\n$holder = [pscustomobject]@{ Command = $fn }\n& $holder.Command'
  ]
]) {
  test(`PowerShell AST rejects reachable pre-initialization function ${callPathName}`, {
    skip: process.platform !== 'win32'
  }, () => {
    assert.throws(
      () => powerShellAstArrayEntriesFromSource(
        `${functionSource}\n${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\n${invocation}`,
        'requiredPublicAssets'
      ),
      /must remain immutable after initialization/
    );
  });
}

const REVIEW12_PRE_INIT_MUTATOR =
  'function Invoke-PreInitMutation { $script:requiredPublicAssets[0] = "client/evil.js" }';

for (const [dispatchName, invocation] of [
  [
    'expandable-string function name',
    '$suffix = "PreInitMutation"\n$commandName = "Invoke-${suffix}"\n& $commandName'
  ],
  [
    'braced Function provider scriptblock',
    '& ${Function:Invoke-PreInitMutation}'
  ],
  [
    'Get-Item Function ScriptBlock Invoke',
    '(Get-Item Function:Invoke-PreInitMutation).ScriptBlock.Invoke()'
  ],
  [
    'Get-Command pipeline indirect invocation',
    'Get-Command Invoke-PreInitMutation | ForEach-Object { & $_ }'
  ],
  [
    'method-populated command container',
    '$commands = [Collections.ArrayList]::new()\n'
      + '[void]$commands.Add((Get-Command Invoke-PreInitMutation))\n'
      + '& $commands[0]'
  ],
  [
    'indirect container invocation',
    '$holder = [pscustomobject]@{ Command = ${Function:Invoke-PreInitMutation} }\n'
      + '$indirect = $holder.Command\n'
      + '& $indirect'
  ]
]) {
  test(`review12 runtime-proven dispatch rejects ${dispatchName}`, {
    skip: process.platform !== 'win32'
  }, () => {
    const source = `${REVIEW12_PRE_INIT_MUTATOR}\n${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\n${invocation}`;
    assertPowerShellSourceMutatesProtectedAssets(source);
    assert.throws(
      () => powerShellAstArrayEntriesFromSource(source, 'requiredPublicAssets'),
      /must remain immutable after initialization/
    );
  });
}

const REVIEW12_SCOPED_SET_VARIABLE_MUTATOR =
  'function Invoke-ScopedMutation { '
    + 'Set-Variable -Scope Script -Name requiredPublicAssets -Value @("client/evil.js") '
    + '}';

for (const [dispatchName, invocation] of [
  ['Function scriptblock ampersand', '& ${Function:Invoke-ScopedMutation}'],
  ['Function scriptblock Invoke', '(${Function:Invoke-ScopedMutation}).Invoke()'],
  [
    'Get-Item Function ScriptBlock Invoke',
    '(Get-Item Function:Invoke-ScopedMutation).ScriptBlock.Invoke()'
  ],
  [
    'ForEach-Object Process callback',
    '1 | ForEach-Object -Process ${Function:Invoke-ScopedMutation}'
  ],
  [
    'ExecutionContext InvokeScript callback',
    '$ExecutionContext.InvokeCommand.InvokeScript('
      + '$false, ${Function:Invoke-ScopedMutation}, $null, $null)'
  ],
  [
    'Where-Object callback',
    '1 | Where-Object -FilterScript ${Function:Invoke-ScopedMutation}'
  ],
  [
    'Measure-Command callback',
    'Measure-Command -Expression ${Function:Invoke-ScopedMutation}'
  ],
  [
    'Invoke-Command callback',
    'Invoke-Command -ScriptBlock ${Function:Invoke-ScopedMutation}'
  ],
  [
    'collection ForEach callback',
    '@(1).ForEach(${Function:Invoke-ScopedMutation})'
  ]
]) {
  test(`review12 remediation runtime-mutating dispatch rejects ${dispatchName}`, {
    skip: process.platform !== 'win32'
  }, () => {
    const source = `${REVIEW12_SCOPED_SET_VARIABLE_MUTATOR}\n${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\n${invocation}`;
    assertPowerShellSourceMutatesProtectedAssets(source);
    assert.throws(
      () => powerShellAstArrayEntriesFromSource(source, 'requiredPublicAssets'),
      /must remain immutable after initialization/
    );
  });
}

const REVIEW12_PROTECTED_RETURN_FUNCTION =
  'function Get-RequiredPublicAssets { return ,$script:requiredPublicAssets }';

for (const [returnPathName, mutation] of [
  [
    'direct returned reference',
    '$assetsAlias = Get-RequiredPublicAssets\n$assetsAlias[0] = "client/evil.js"'
  ],
  [
    'indirect returned reference',
    'Set-Alias -Name readRequiredAssets -Value Get-RequiredPublicAssets\n'
      + '$assetsAlias = readRequiredAssets\n'
      + '$indirectAlias = $assetsAlias\n'
      + '$indirectAlias[0] = "client/evil.js"'
  ],
  [
    'container returned reference',
    '$holder = [pscustomobject]@{ Assets = (Get-RequiredPublicAssets) }\n'
      + '$holder.Assets[0] = "client/evil.js"'
  ]
]) {
  test(`review12 runtime-proven function return rejects ${returnPathName}`, {
    skip: process.platform !== 'win32'
  }, () => {
    const source = `${REVIEW12_PROTECTED_RETURN_FUNCTION}\n${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\n${mutation}`;
    assertPowerShellSourceMutatesProtectedAssets(source);
    assert.throws(
      () => powerShellAstArrayEntriesFromSource(source, 'requiredPublicAssets'),
      /must remain immutable after initialization/
    );
  });
}

for (const [returnPathName, functionSource, mutation] of [
  [
    'implicit bare reference return',
    'function Get-RequiredPublicAssets { ,$script:requiredPublicAssets }',
    '$assetsAlias = Get-RequiredPublicAssets\n$assetsAlias[0] = "client/evil.js"'
  ],
  [
    'implicit container return',
    'function Get-RequiredPublicAssets { '
      + '[pscustomobject]@{ Assets = $script:requiredPublicAssets } '
      + '}',
    '$holder = Get-RequiredPublicAssets\n$holder.Assets[0] = "client/evil.js"'
  ],
  [
    'module-qualified Write-Output NoEnumerate return',
    'function Get-RequiredPublicAssets { '
      + 'Microsoft.PowerShell.Utility\\Write-Output -NoEnumerate $script:requiredPublicAssets '
      + '}',
    '$assetsAlias = Get-RequiredPublicAssets\n$assetsAlias[0] = "client/evil.js"'
  ],
  [
    'Get-Variable record return',
    'function Get-RequiredPublicAssets { '
      + 'Get-Variable -Scope Script -Name requiredPublicAssets '
      + '}',
    '$record = Get-RequiredPublicAssets\n$record.Value[0] = "client/evil.js"'
  ],
  [
    'Get-Variable value return',
    'function Get-RequiredPublicAssets { '
      + ',((Get-Variable -Scope Script -Name requiredPublicAssets).Value) '
      + '}',
    '$assetsAlias = Get-RequiredPublicAssets\n$assetsAlias[0] = "client/evil.js"'
  ],
  [
    'ExecutionContext SessionState PSVariable value return',
    'function Get-RequiredPublicAssets { '
      + ',($ExecutionContext.SessionState.PSVariable.Get("requiredPublicAssets").Value) '
      + '}',
    '$assetsAlias = Get-RequiredPublicAssets\n$assetsAlias[0] = "client/evil.js"'
  ],
  [
    'transitive wrapper return',
    'function Get-RequiredPublicAssetsInner { ,$script:requiredPublicAssets }\n'
      + 'function Get-RequiredPublicAssets { ,(Get-RequiredPublicAssetsInner) }',
    '$assetsAlias = Get-RequiredPublicAssets\n$assetsAlias[0] = "client/evil.js"'
  ]
]) {
  test(`review12 remediation runtime-mutating return rejects ${returnPathName}`, {
    skip: process.platform !== 'win32'
  }, () => {
    const source = `${functionSource}\n${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\n${mutation}`;
    assertPowerShellSourceMutatesProtectedAssets(source);
    assert.throws(
      () => powerShellAstArrayEntriesFromSource(source, 'requiredPublicAssets'),
      /must remain immutable after initialization/
    );
  });
}

test('PowerShell AST accepts a read-only foreach over requiredPublicAssets', {
  skip: process.platform !== 'win32'
}, () => {
  assert.deepEqual(
    powerShellAstArrayEntriesFromSource(
      `${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\nforeach ($asset in $requiredPublicAssets) { Write-Output $asset }`,
      'requiredPublicAssets'
    ),
    AST_FIXTURE_CLIENT_ASSETS
  );
});

test('PowerShell AST accepts direct built-in Write-Output as a proven read-only sink', {
  skip: process.platform !== 'win32'
}, () => {
  assert.deepEqual(
    powerShellAstArrayEntriesFromSource(
      `${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\nWrite-Output $requiredPublicAssets`,
      'requiredPublicAssets'
    ),
    AST_FIXTURE_CLIENT_ASSETS
  );
});

test('PowerShell AST accepts mutation of a detached Clone without rejecting its source', {
  skip: process.platform !== 'win32'
}, () => {
  assert.deepEqual(
    powerShellAstArrayEntriesFromSource(
      `${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\n$copy = $requiredPublicAssets.Clone(); $copy[0] = "client/local-only.js"`,
      'requiredPublicAssets'
    ),
    AST_FIXTURE_CLIENT_ASSETS
  );
});

test('PowerShell AST accepts an ArrayList that retains only a detached Clone', {
  skip: process.platform !== 'win32'
}, () => {
  assert.deepEqual(
    powerShellAstArrayEntriesFromSource(
      `${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\n`
        + '$references = [Collections.ArrayList]::new()\n'
        + '[void]$references.Add($requiredPublicAssets.Clone())\n'
        + '$references[0][0] = "client/local-only.js"',
      'requiredPublicAssets'
    ),
    AST_FIXTURE_CLIENT_ASSETS
  );
});

for (const [readName, readOnlyUse] of [
  [
    'variable alias foreach',
    '$assetsAlias = $requiredPublicAssets\nforeach ($asset in $assetsAlias) { Write-Output $asset }'
  ],
  [
    'object-container alias foreach',
    '$holder = [pscustomobject]@{ Assets = $requiredPublicAssets }\n'
      + 'foreach ($asset in $holder.Assets) { Write-Output $asset }'
  ],
  [
    'Variable-provider alias foreach',
    'Set-Item -Path Variable:assetsAlias -Value $requiredPublicAssets\n'
      + 'foreach ($asset in $assetsAlias) { Write-Output $asset }'
  ],
  [
    'Array Copy source',
    '$copy = New-Object object[] $requiredPublicAssets.Length\n'
      + '[Array]::Copy($requiredPublicAssets, $copy, $requiredPublicAssets.Length)'
  ],
  [
    'read-only array APIs and variable-provider alias',
    '$index = [Array]::IndexOf($requiredPublicAssets, "client/core/csp_compat.js")\n'
      + '$currentAssets = gc Variable:requiredPublicAssets'
  ],
  [
    'source-defined read command alias',
    'Set-Alias -Name readAssets -Value Get-Content\n'
      + '$currentAssets = readAssets Variable:requiredPublicAssets'
  ]
]) {
  test(`PowerShell AST accepts requiredPublicAssets read-only ${readName}`, {
    skip: process.platform !== 'win32'
  }, () => {
    assert.deepEqual(
      powerShellAstArrayEntriesFromSource(
        `${REQUIRED_PUBLIC_ASSETS_AST_FIXTURE}\n${readOnlyUse}`,
        'requiredPublicAssets'
      ),
      AST_FIXTURE_CLIENT_ASSETS
    );
  });
}

test('PowerShell AST rejects FILES indexed mutation after initialization', {
  skip: process.platform !== 'win32'
}, () => {
  const actualEntries = powerShellAstArrayEntries(deployScriptPath, 'FILES');
  assertExactClientAssetInventory(
    actualEntries.filter((entry) => /^(?:\.\/)*client\//i.test(entry.replace(/\\/g, '/'))),
    'PowerShell AST deploy FILES client subset'
  );
  assert.throws(
    () => powerShellAstArrayEntriesFromSource(
      '$FILES = @("app.js", "client/shared/build_info.js")\n$FILES[0] = "client/evil.js"',
      'FILES'
    ),
    /must remain immutable after initialization/
  );
});

const PINNED_ACTION_PLAN_FUNCTIONS = [
  'Initialize-PinnedDeploymentTypes',
  'Get-ExactDeploymentInventoryIdentity',
  'Convert-ToRemotePath',
  'Get-CanonicalLocalUploadFile',
  'New-ImmutableDeploymentActionPlan',
  'Convert-ToNativeArgument',
  'Invoke-NativeWithPinnedInput'
];

test('deployment plan packages and copies every parser runtime artifact', {
  skip: process.platform !== 'win32'
}, () => {
  const deployFiles = powerShellAstArrayEntries(deployScriptPath, 'FILES')
    .map((entry) => entry.replace(/\\/g, '/'));
  assertRequiredParserRuntimeArtifacts(deployFiles);

  const parserEntries = REQUIRED_PARSER_RUNTIME_ARTIFACTS
    .map((entry) => `'${entry.replace(/'/g, "''")}'`)
    .join(', ');
  const result = runDeployPowerShellHarness(
    PINNED_ACTION_PLAN_FUNCTIONS,
    String.raw`
$parserEntries = @(${parserEntries})
$plan = New-ImmutableDeploymentActionPlan `
      + String.raw`-CheckoutRoot $CheckoutRoot -PlatformRoot $InventoryRoot `
      + String.raw`-PlatformEntries $parserEntries -RequiredPublicAssetEntries @() `
      + String.raw`-RootRelativeEntries @() -CandidateOnlyEntries @()
if ($plan.Records.Count -ne $parserEntries.Count) { throw 'PARSER_PLAN_RECORD_COUNT' }
foreach ($entry in $parserEntries) {
  $remotePath = 'platform/' + (Convert-ToRemotePath $entry)
  $matches = @($plan.Records | Where-Object {
    $_.InventoryKind -ceq 'Platform' -and $_.RemoteRelativePath -ceq $remotePath
  })
  if ($matches.Count -ne 1) { throw ('PARSER_PLAN_RECORD:' + $remotePath) }
  Write-Output ('PARSER_PLAN_OK:' + $remotePath)
}`,
    ['-CheckoutRoot', path.dirname(platformRoot), '-InventoryRoot', platformRoot]
  );
  assertPowerShellHarnessSucceeded(result);
  for (const artifact of REQUIRED_PARSER_RUNTIME_ARTIFACTS) {
    assert.match(result.stdout, new RegExp(`^PARSER_PLAN_OK:platform/${artifact}$`, 'm'));
  }

  assert.match(
    read(deployScriptPath),
    /foreach \(\$record in \$deploymentActionPlan\.Records\)\s*\{\s*Invoke-PinnedDeploymentUpload -Record \$record -RemoteRoot \$remoteReleaseRoot/s,
    'every immutable deployment-plan record must be copied to the remote release'
  );
});

test('review12 parser inventory rejects an unexpected parser-family artifact', () => {
  for (const unexpectedArtifact of [
    'server/scripts/parse_upload_sandbox-debug.sh',
    'server/systemd/turingmarket-parser-debug.service',
    'server/scripts/parse_upload_sandbox2.sh',
    'server/systemd/turingmarket-parser2.service'
  ]) {
    assert.throws(
      () => assertRequiredParserRuntimeArtifacts([
        ...REQUIRED_PARSER_RUNTIME_ARTIFACTS,
        unexpectedArtifact
      ]),
      /exact required parser runtime artifacts/
    );
  }
});

test('runtime action-plan types expose no public setters or mutable byte arrays', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runDeployPowerShellHarness(
    ['Initialize-PinnedDeploymentTypes'],
    String.raw`
Initialize-PinnedDeploymentTypes
foreach ($propertyName in @(
  'InventoryKind', 'SourceRelativePath', 'SourcePath', 'RemoteRelativePath',
  'ExpectedSha256', 'RequiredPublicAsset', 'IncludedInBackup', 'ByteLength'
)) {
  $property = [PinnedDeploymentActionRecord].GetProperty($propertyName)
  if ($null -eq $property -or $null -ne $property.GetSetMethod($false)) {
    throw "PUBLIC_RECORD_MUTATOR:$propertyName"
  }
}
$bytes = [PinnedDeploymentActionRecord].GetField('bytes', [Reflection.BindingFlags]'Instance,NonPublic')
if ($null -eq $bytes -or -not $bytes.IsInitOnly -or $bytes.IsPublic) { throw 'MUTABLE_RECORD_BYTES' }
$records = [ImmutableDeploymentActionPlan].GetProperty('Records')
$identity = [ImmutableDeploymentActionPlan].GetProperty('Identity')
if ($null -ne $records.GetSetMethod($false) -or $null -ne $identity.GetSetMethod($false)) {
  throw 'PUBLIC_PLAN_MUTATOR'
}
Write-Output 'IMMUTABLE_ACTION_TYPES_OK'`
  );
  assertPowerShellHarnessSucceeded(result);
  assert.match(result.stdout, /IMMUTABLE_ACTION_TYPES_OK/);
});

test('runtime action plan rejects duplicate required-public-asset identities', {
  skip: process.platform !== 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-action-plan-required-duplicate-'));
  const checkout = path.join(root, 'checkout');
  const inventory = path.join(checkout, 'platform');
  fs.mkdirSync(inventory, { recursive: true });
  fs.writeFileSync(path.join(inventory, 'app.js'), 'pinned', 'utf8');
  try {
    const result = runDeployPowerShellHarness(
      PINNED_ACTION_PLAN_FUNCTIONS,
      String.raw`
try {
  $null = New-ImmutableDeploymentActionPlan `
        + String.raw`-CheckoutRoot $CheckoutRoot -PlatformRoot $InventoryRoot `
        + String.raw`-PlatformEntries @('app.js') -RequiredPublicAssetEntries @('app.js', 'app.js') `
        + String.raw`-RootRelativeEntries @() -CandidateOnlyEntries @()
  throw 'DUPLICATE_REQUIRED_ACCEPTED'
} catch {
  if ($_.Exception.Message -eq 'DUPLICATE_REQUIRED_ACCEPTED') { throw }
  Write-Output ('DUPLICATE_REQUIRED_REJECTED:' + $_.Exception.Message)
}`,
      ['-CheckoutRoot', checkout, '-InventoryRoot', inventory]
    );
    assertPowerShellHarnessSucceeded(result);
    assert.match(result.stdout, /DUPLICATE_REQUIRED_REJECTED:.*duplicate required public asset/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime plan identity primitive accepts order-independent exact sets', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runDeployPowerShellHarness(
    ['Get-ExactDeploymentInventoryIdentity'],
    `$left = @('app.js', 'client\\shared\\build_info.js', 'client\\core\\navigation.js')
     $right = [string[]]$left.Clone()
     [Array]::Reverse($right)
     $leftIdentity = Get-ExactDeploymentInventoryIdentity -Entries $left -Label 'left inventory'
     $rightIdentity = Get-ExactDeploymentInventoryIdentity -Entries $right -Label 'right inventory'
     if ($leftIdentity -cne $rightIdentity) { throw 'Inventory identity depends on order' }
     Write-Output 'ORDER_INDEPENDENT_OK'`
  );
  assertPowerShellHarnessSucceeded(result);
  assert.match(result.stdout, /ORDER_INDEPENDENT_OK/);
});

test('backup, hashing, preparation, and every upload consume only the sealed action plan', () => {
  const deploy = read(deployScriptPath);
  assert.equal((deploy.match(/^\s*\$deploymentPlan = New-ImmutableDeploymentActionPlan\b/gm) || []).length, 1);
  for (const inventory of ['FILES', 'requiredPublicAssets', 'ROOT_RELATIVE_FILES', 'CANDIDATE_ONLY_FILES']) {
    assert.match(
      deploy,
      new RegExp(`Set-Variable -Scope Script -Name ${inventory} -Option ReadOnly`),
      `${inventory} must be sealed after the action plan is created`
    );
  }
  assert.match(deploy, /Invoke-RemoteBackup -BackupPath \$backupDir -DeploymentPlan \$deploymentActionPlan/);
  assert.match(deploy, /Get-DeploymentPlanChecksumManifest -DeploymentPlan \$deploymentActionPlan/);
  assert.match(deploy, /Get-DeploymentPlanRemotePathManifest -DeploymentPlan \$deploymentActionPlan/);
  assert.match(deploy, /foreach \(\$record in \$deploymentActionPlan\.Records\)\s*\{\s*Invoke-PinnedDeploymentUpload/s);
  assert.doesNotMatch(deploy, /\$uploadInventory\b|\$hashInventory\b|\$backupInventory\b/);
});

const LOCAL_UPLOAD_GUARD_FUNCTIONS = ['Get-CanonicalLocalUploadFile'];

function runLocalUploadGuard(checkoutRoot, inventoryRoot, relativePath) {
  return runDeployPowerShellHarness(
    LOCAL_UPLOAD_GUARD_FUNCTIONS,
    String.raw`
try {
  $resolved = Get-CanonicalLocalUploadFile `
    + String.raw`-CheckoutRoot $CheckoutRoot -InventoryRoot $InventoryRoot -RelativePath $RelativePath
  Write-Output ('ACCEPTED:' + $resolved)
} catch {
  Write-Output ('REJECTED:' + $_.Exception.Message)
}
`,
    ['-CheckoutRoot', checkoutRoot, '-InventoryRoot', inventoryRoot, '-RelativePath', relativePath]
  );
}

test('local upload guard accepts a safe regular file in the canonical checkout', {
  skip: process.platform !== 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-safe-'));
  const checkout = path.join(root, 'checkout');
  const inventory = path.join(checkout, 'platform');
  const target = path.join(inventory, 'client', 'safe.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'safe', 'utf8');
  try {
    const result = runLocalUploadGuard(checkout, inventory, 'client\\safe.js');
    assertPowerShellHarnessSucceeded(result);
    assert.match(result.stdout, /^ACCEPTED:/m);
    assert.match(result.stdout, /client[\\/]safe\.js/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local upload guard rejects lexical checkout escape mutants', {
  skip: process.platform !== 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-escape-'));
  const checkout = path.join(root, 'checkout');
  const inventory = path.join(checkout, 'platform');
  fs.mkdirSync(inventory, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'outside.js'), 'outside', 'utf8');
  try {
    const result = runLocalUploadGuard(checkout, inventory, '..\\outside.js');
    assertPowerShellHarnessSucceeded(result);
    assert.match(result.stdout, /^REJECTED:.*(?:canonical|escape|contain)/im);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local upload guard rejects a reparse-point directory that escapes the checkout', {
  skip: process.platform !== 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-reparse-'));
  const checkout = path.join(root, 'checkout');
  const inventory = path.join(checkout, 'platform');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(inventory, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'escape.js'), 'outside', 'utf8');
  fs.symlinkSync(outside, path.join(inventory, 'linked'), 'junction');
  try {
    const result = runLocalUploadGuard(checkout, inventory, 'linked\\escape.js');
    assertPowerShellHarnessSucceeded(result);
    assert.match(result.stdout, /^REJECTED:.*reparse/im);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pinned action upload streams the exact attested binary bytes after a parent junction swap', {
  skip: process.platform !== 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-pinned-upload-swap-'));
  const checkout = path.join(root, 'checkout');
  const inventory = path.join(checkout, 'platform');
  const sourceParent = path.join(inventory, 'client');
  const originalParent = path.join(root, 'attested-client');
  const outside = path.join(root, 'outside');
  const source = path.join(sourceParent, 'payload.bin');
  const consumer = path.join(root, 'consume-stdin.js');
  const output = path.join(root, 'consumed.bin');
  const originalBytes = Buffer.from([0x00, 0x01, 0x02, 0x0a, 0x0d, 0xff, 0x80, 0x41]);
  const escapingBytes = Buffer.from('ESCAPING-JUNCTION-BYTES', 'utf8');
  fs.mkdirSync(sourceParent, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(source, originalBytes);
  fs.writeFileSync(path.join(outside, 'payload.bin'), escapingBytes);
  fs.writeFileSync(
    consumer,
    "const fs=require('node:fs');const chunks=[];process.stdin.on('data',(c)=>chunks.push(c));process.stdin.on('end',()=>fs.writeFileSync(process.argv[2],Buffer.concat(chunks),{flag:'wx'}));",
    'utf8'
  );

  try {
    const result = runDeployPowerShellHarness(
      PINNED_ACTION_PLAN_FUNCTIONS,
      String.raw`
$plan = New-ImmutableDeploymentActionPlan `
        + String.raw`-CheckoutRoot $CheckoutRoot -PlatformRoot $InventoryRoot `
        + String.raw`-PlatformEntries @('client\payload.bin') `
        + String.raw`-RequiredPublicAssetEntries @() -RootRelativeEntries @() -CandidateOnlyEntries @()
$record = $plan.Records[0]
Move-Item -LiteralPath (Join-Path $InventoryRoot 'client') -Destination $OriginalParent
$null = New-Item -ItemType Junction -Path (Join-Path $InventoryRoot 'client') -Target $OutsideRoot
Invoke-NativeWithPinnedInput -Record $record -FileName $NodePath `
        + String.raw`-ArgumentList @($ConsumerPath, $ConsumerOutput) -FailureMessage 'Pinned consumer failed'
Write-Output ('PINNED:' + $record.ExpectedSha256 + ':' + $record.ByteLength)
`,
      [
        '-CheckoutRoot', checkout,
        '-InventoryRoot', inventory,
        '-OutsideRoot', outside,
        '-OriginalParent', originalParent,
        '-ConsumerPath', consumer,
        '-ConsumerOutput', output,
        '-NodePath', process.execPath
      ]
    );
    assertPowerShellHarnessSucceeded(result);
    assert.deepEqual(fs.readFileSync(output), originalBytes);
    assert.notDeepEqual(fs.readFileSync(output), escapingBytes);
    assert.match(
      result.stdout,
      new RegExp(`PINNED:${crypto.createHash('sha256').update(originalBytes).digest('hex')}:${originalBytes.length}`)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration cleanup installation consumes its pinned plan records after a parent junction swap', {
  skip: process.platform !== 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-pinned-cleanup-swap-'));
  const checkout = path.join(root, 'checkout');
  const inventory = path.join(checkout, 'platform');
  const serverParent = path.join(inventory, 'server');
  const originalParent = path.join(root, 'attested-server');
  const outside = path.join(root, 'outside-server');
  const cleanupRelative = path.join('server', 'scripts', 'cleanup_stale_migration_gate.sh');
  const unitRelative = path.join('server', 'systemd', 'turingmarket-gate-cleanup.service');
  const cleanupBytes = Buffer.from('#!/bin/sh\nprintf pinned-cleanup\\n\n', 'utf8');
  const unitBytes = Buffer.from('[Service]\nType=oneshot\nExecStart=/pinned\n', 'utf8');
  const escapingCleanup = Buffer.from('#!/bin/sh\nprintf escaped-cleanup\\n\n', 'utf8');
  const escapingUnit = Buffer.from('[Service]\nExecStart=/escaped\n', 'utf8');
  fs.mkdirSync(path.dirname(path.join(inventory, cleanupRelative)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(inventory, unitRelative)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(outside, 'scripts', 'cleanup_stale_migration_gate.sh')), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(outside, 'systemd', 'turingmarket-gate-cleanup.service')), { recursive: true });
  fs.writeFileSync(path.join(inventory, cleanupRelative), cleanupBytes);
  fs.writeFileSync(path.join(inventory, unitRelative), unitBytes);
  fs.writeFileSync(path.join(outside, 'scripts', 'cleanup_stale_migration_gate.sh'), escapingCleanup);
  fs.writeFileSync(path.join(outside, 'systemd', 'turingmarket-gate-cleanup.service'), escapingUnit);

  try {
    const result = runDeployPowerShellHarness(
      [...PINNED_ACTION_PLAN_FUNCTIONS, 'Install-RemoteMigrationGateCleanup'],
      String.raw`
$script:REMOTE_ROOT = '/root/turingmarket-test'
$script:LOCAL_DIR = $InventoryRoot
$script:deploymentRunId = '0123456789abcdef0123456789abcdef'
$plan = New-ImmutableDeploymentActionPlan `
        + String.raw`-CheckoutRoot $CheckoutRoot -PlatformRoot $InventoryRoot `
        + String.raw`-PlatformEntries @(
  'server\scripts\cleanup_stale_migration_gate.sh',
  'server\systemd\turingmarket-gate-cleanup.service'
) -RequiredPublicAssetEntries @() -RootRelativeEntries @() -CandidateOnlyEntries @()
Move-Item -LiteralPath (Join-Path $InventoryRoot 'server') -Destination $OriginalParent
$null = New-Item -ItemType Junction -Path (Join-Path $InventoryRoot 'server') -Target $OutsideRoot
function Invoke-RemoteBash {
  param([string]$Script, [string]$FailureMessage, [switch]$RequireDeploymentLock)
  Write-Output $Script
}
Install-RemoteMigrationGateCleanup -DeploymentPlan $plan
`,
      [
        '-CheckoutRoot', checkout,
        '-InventoryRoot', inventory,
        '-OutsideRoot', outside,
        '-OriginalParent', originalParent
      ]
    );
    assertPowerShellHarnessSucceeded(result);
    assert.match(result.stdout, new RegExp(cleanupBytes.toString('base64')));
    assert.match(result.stdout, new RegExp(unitBytes.toString('base64')));
    assert.match(result.stdout, new RegExp(crypto.createHash('sha256').update(cleanupBytes).digest('hex')));
    assert.match(result.stdout, new RegExp(crypto.createHash('sha256').update(unitBytes).digest('hex')));
    assert.doesNotMatch(result.stdout, new RegExp(escapingCleanup.toString('base64')));
    assert.doesNotMatch(result.stdout, new RegExp(escapingUnit.toString('base64')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one immutable action plan supplies backup, attestation, checksum, preparation, and every upload action', () => {
  const deploy = read(deployScriptPath);
  const backup = deploy.match(/^function Invoke-RemoteBackup\s*\{(?<body>[\s\S]*?)^\}/m);
  const trustedInstall = deploy.match(
    /^function Install-RemoteTrustedProductionSourceGate\s*\{(?<body>[\s\S]*?)^\}/m
  );
  const cleanupInstall = deploy.match(
    /^function Install-RemoteMigrationGateCleanup\s*\{(?<body>[\s\S]*?)^\}/m
  );
  assert.ok(backup && trustedInstall && cleanupInstall);

  assert.equal(
    (deploy.match(/^\s*\$deploymentPlan = New-ImmutableDeploymentActionPlan\b/gm) || []).length,
    1,
    'deploy must seal exactly one action plan before any remote mutation'
  );
  assert.match(backup.groups.body, /\$DeploymentPlan\.Records/);
  assert.match(trustedInstall.groups.body, /\$DeploymentPlan\.GetByRemoteRelativePath\(/);
  assert.match(cleanupInstall.groups.body, /\$DeploymentPlan\.GetByRemoteRelativePath\(/);
  assert.match(deploy, /Invoke-RemoteBackup -BackupPath \$backupDir -DeploymentPlan \$deploymentActionPlan/);
  assert.match(deploy, /Install-RemoteTrustedProductionSourceGate -DeploymentPlan \$deploymentActionPlan/);
  assert.match(deploy, /Install-RemoteMigrationGateCleanup -DeploymentPlan \$deploymentActionPlan/);
  assert.match(deploy, /\$uploadChecksums = Get-DeploymentPlanChecksumManifest -DeploymentPlan \$deploymentActionPlan/);
  assert.match(deploy, /\$remotePathManifest = Get-DeploymentPlanRemotePathManifest -DeploymentPlan \$deploymentActionPlan/);

  const uploadCalls = deploy.match(
    /Invoke-PinnedDeploymentUpload -Record \$record -RemoteRoot \$remoteReleaseRoot/g
  ) || [];
  assert.equal(uploadCalls.length, 1, 'every plan record must cross one pinned upload action boundary');
  const pinnedUploadStart = deploy.indexOf('function Invoke-PinnedDeploymentUpload');
  const pinnedUploadEnd = deploy.indexOf('function Assert-TrustedProductionSourceArtifacts', pinnedUploadStart);
  const pinnedUpload = deploy.slice(pinnedUploadStart, pinnedUploadEnd);
  assert.match(pinnedUpload, /ExpectedSha256=\$expectedSha256Literal/);
  assert.ok(
    pinnedUpload.indexOf('sha256sum "`$Temporary"') < pinnedUpload.indexOf('mv -f "`$Temporary" "`$Target"'),
    'the exact streamed bytes must match the pinned hash before the candidate target is replaced'
  );
  assert.doesNotMatch(deploy, /\bInvoke-SecureCopy\b/);
  assert.doesNotMatch(deploy, /\[IO\.File\]::ReadAllBytes\(/);
  assert.doesNotMatch(deploy, /Get-FileHash -Algorithm SHA256 -LiteralPath/);
});

test('mutating a detached action snapshot cannot change the sealed plan consumed by checksum actions', {
  skip: process.platform !== 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-action-plan-detached-'));
  const checkout = path.join(root, 'checkout');
  const inventory = path.join(checkout, 'platform');
  fs.mkdirSync(inventory, { recursive: true });
  fs.writeFileSync(path.join(inventory, 'app.js'), 'PINNED_ACTION_PLAN\n', 'utf8');
  try {
    const result = runDeployPowerShellHarness(
      [...PINNED_ACTION_PLAN_FUNCTIONS, 'Assert-ImmutableDeploymentActionPlan', 'Get-DeploymentPlanChecksumManifest'],
      String.raw`
$plan = New-ImmutableDeploymentActionPlan `
        + String.raw`-CheckoutRoot $CheckoutRoot -PlatformRoot $InventoryRoot `
        + String.raw`-PlatformEntries @('app.js') -RequiredPublicAssetEntries @() `
        + String.raw`-RootRelativeEntries @() -CandidateOnlyEntries @()
$detachedActionSnapshot = @($plan.Records | ForEach-Object { $_ })
$detachedActionSnapshot[0] = $null
$propertyMutationRejected = $false
try { $plan.Records[0].RemoteRelativePath = 'platform/evil.js' } catch { $propertyMutationRejected = $true }
if (-not $propertyMutationRejected) { throw 'PLAN_RECORD_MUTATION_ACCEPTED' }
$manifest = Get-DeploymentPlanChecksumManifest -DeploymentPlan $plan
if ($manifest -notmatch '  platform/app\.js$') { throw 'SEALED_PLAN_IDENTITY_CHANGED' }
Write-Output 'DETACHED_MUTATION_ISOLATED'
`,
      ['-CheckoutRoot', checkout, '-InventoryRoot', inventory]
    );
    assertPowerShellHarnessSucceeded(result);
    assert.match(result.stdout, /DETACHED_MUTATION_ISOLATED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('immutable action plan rejects duplicate remote identities across root and candidate-only inventories', {
  skip: process.platform !== 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-action-plan-duplicate-'));
  const checkout = path.join(root, 'checkout');
  const inventory = path.join(checkout, 'platform');
  fs.mkdirSync(inventory, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'shared.txt'), 'shared', 'utf8');
  try {
    const result = runDeployPowerShellHarness(
      PINNED_ACTION_PLAN_FUNCTIONS,
      String.raw`
try {
  $null = New-ImmutableDeploymentActionPlan `
        + String.raw`-CheckoutRoot $CheckoutRoot -PlatformRoot $InventoryRoot `
        + String.raw`-PlatformEntries @() -RequiredPublicAssetEntries @() `
        + String.raw`-RootRelativeEntries @('shared.txt') -CandidateOnlyEntries @('shared.txt')
  throw 'DUPLICATE_ACTION_ACCEPTED'
} catch {
  if ($_.Exception.Message -eq 'DUPLICATE_ACTION_ACCEPTED') { throw }
  Write-Output ('DUPLICATE_REJECTED:' + $_.Exception.Message)
}
`,
      ['-CheckoutRoot', checkout, '-InventoryRoot', inventory]
    );
    assertPowerShellHarnessSucceeded(result);
    assert.match(result.stdout, /DUPLICATE_REJECTED:.*duplicate.*remote path/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('portable PowerShell parser rejects scalar append and reassignment bypasses', () => {
  const base = '$requiredPublicAssets = @("client/shared/build_info.js")';
  assert.throws(
    () => powerShellArrayEntries(`${base}\n$requiredPublicAssets += "client/extra.js"`, 'requiredPublicAssets'),
    /must have one assignment/
  );
  assert.throws(
    () => powerShellArrayEntries(`${base}\n$requiredPublicAssets = "client/extra.js"`, 'requiredPublicAssets'),
    /must have one assignment/
  );
  assert.throws(
    () => powerShellArrayEntries('$requiredPublicAssets = "client/extra.js"', 'requiredPublicAssets'),
    /static array expression/
  );
});

test('guarded deploy verifies the full build-info contract and exact remote SHA-256', () => {
  const deploy = read(deployScriptPath);
  const fullObjectChecks = deploy.match(
    /JSON\.stringify\(window\.TMBuild\)\s*!==\s*JSON\.stringify\(expected\)/g
  ) || [];
  const compatibilityChecks = deploy.match(/window\.tmAppBuild\s*!==\s*expected\.app/g) || [];

  assert.equal(fullObjectChecks.length, 1, 'TMBuild must be validated before upload');
  assert.equal(compatibilityChecks.length, 1, 'tmAppBuild compatibility marker must be validated before upload');
  const checksumStart = deploy.indexOf('function Get-DeploymentPlanChecksumManifest');
  const checksumEnd = deploy.indexOf('function Get-DeploymentPlanRemotePathManifest', checksumStart);
  const checksumFunction = deploy.slice(checksumStart, checksumEnd);
  assert.match(checksumFunction, /Assert-ImmutableDeploymentActionPlan -DeploymentPlan \$DeploymentPlan/);
  assert.match(checksumFunction, /foreach \(\$record in \$DeploymentPlan\.Records\)/);
  assert.match(checksumFunction, /\$record\.ExpectedSha256/);
  assert.match(checksumFunction, /\$record\.RemoteRelativePath/);
  assert.match(deploy, /\$uploadChecksums = Get-DeploymentPlanChecksumManifest -DeploymentPlan \$deploymentActionPlan/);
  assert.match(deploy, /cat > "\$LockDir\/upload\.sha256" <<'TM_UPLOAD_SHA256'\s+__UPLOAD_CHECKSUMS__\s+TM_UPLOAD_SHA256/);
  assert.match(deploy, /\$verifyUploadScript = \$verifyUploadScript\.Replace\('__UPLOAD_CHECKSUMS__', \$uploadChecksums\)/);
  assert.match(deploy, /sha256sum --check --status "\$LockDir\/upload\.sha256"/);
});

test('guarded deploy uploads and syntax-checks the baseline generator and architecture inventory test', () => {
  const deploy = read(deployScriptPath);

  assert.match(deploy, /"server\\scripts\\generate_ui_baseline_manifest\.js"/);
  assert.match(deploy, /"server\\tests\\fixtures\\frontend-active-definitions\.json"/);
  assert.doesNotMatch(deploy, /node --check server\/tests\/fixtures\/frontend-active-definitions\.json/);
  assert.match(deploy, /"server\\tests\\customer_workspace_ui\.test\.js"/);
  assert.match(deploy, /"server\\tests\\frontend_architecture_inventory\.test\.js"/);
  assert.match(deploy, /<<'TM_DEPENDENCY_STAGE'[\s\S]*?cd "\$DEPENDENCY_SERVER_ROOT"[\s\S]*?npm ci --ignore-scripts[\s\S]*?TM_DEPENDENCY_STAGE/);
  assert.match(deploy, /npm_config_offline=true[\s\S]*?<<'TM_DEPENDENCY_BUILD'[\s\S]*?npm rebuild better-sqlite3[\s\S]*?TM_DEPENDENCY_BUILD/);
  assert.match(deploy, /node --test --test-concurrency=1 tests\/\*\.test\.js/);
  assert.doesNotMatch(deploy, /npm test -- --test-concurrency=1/);
  assert.match(deploy, /node node_modules\/playwright-deploy\/cli\.js test -c server\/tests\/deployment-browser-smoke\.config\.js/);
});
