const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const platformRoot = path.join(__dirname, '..', '..');
const indexPath = path.join(platformRoot, 'index.html');
const appPath = path.join(platformRoot, 'app.js');
const navigationPath = path.join(platformRoot, 'client', 'core', 'navigation.js');
const accessibilityPath = path.join(platformRoot, 'client', 'core', 'accessibility.js');
const shellPath = path.join(platformRoot, 'client', 'core', 'shell.js');
const buildInfoPath = path.join(platformRoot, 'client', 'shared', 'build_info.js');
const deployScriptPath = path.join(platformRoot, 'deploy_v8.ps1');
const nginxConfigPath = path.join(platformRoot, 'nginx', 'turingmarket.conf');
const publicAssets = require('../services/public_assets_service');

const EXPECTED_APP_BUILD = '20260714-v040-product-shell-design-system';
const EXPECTED_APP_QUERY = '20260714v040productshelldesignsystem';
const EXPECTED_PPT_BUILD = '20260702-v916-kb-bridge-client-cn';
const EXPECTED_PPT_QUERY = '20260702v916kbbridge';
const APPROVED_PUBLIC_ASSETS = Object.freeze([
  'client/shared/build_info.js',
  'client/core/navigation.js',
  'client/core/accessibility.js',
  'client/core/shell.js',
  'client/styles/tokens.css',
  'client/styles/components.css',
  'client/styles/layout.css'
]);

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
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
  const arrayStart = source.slice(assignmentEnd).match(/^\s*@\(/);
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
$assignments = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
    $node.Left.VariablePath.UserPath -eq $TargetVariable
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

test('index loads public metadata, navigation, accessibility, and shell before app.js and keeps PPT unchanged', () => {
  const sources = scriptSources(read(indexPath));

  assert.deepEqual(
    sources.slice(-6),
    [
      'client/shared/build_info.js',
      'client/core/navigation.js',
      'client/core/accessibility.js',
      'client/core/shell.js',
      `app.js?v=${EXPECTED_APP_QUERY}`,
      `ppt.js?v=${EXPECTED_PPT_QUERY}`
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
      && sources.indexOf('client/core/shell.js') < sources.indexOf(`app.js?v=${EXPECTED_APP_QUERY}`),
    true,
    'shared browser modules must load in the approved order before app.js'
  );
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
  const approved = [
    '/client/shared/build_info.js',
    '/client/core/navigation.js',
    '/client/core/accessibility.js',
    '/client/core/shell.js',
    '/client/styles/tokens.css',
    '/client/styles/components.css',
    '/client/styles/layout.css'
  ];
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

test('Nginx config exposes only the seven exact approved client assets and rejects every other client path', () => {
  const config = read(nginxConfigPath);
  const activeConfig = config
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  for (const asset of [
    'shared/build_info.js',
    'core/navigation.js',
    'core/accessibility.js',
    'core/shell.js',
    'styles/tokens.css',
    'styles/components.css',
    'styles/layout.css'
  ]) {
    const requestPath = `/client/${asset}`;
    const locationBlock = exactNginxLocationBlock(activeConfig, requestPath);
    const guardedAsset = asset.replaceAll('.', '\\.');
    assert.ok(
      locationBlock.includes(`$request_uri !~ ^/client/${guardedAsset}(?:\\?|$)`),
      `Nginx raw URI guard for ${asset}`
    );
  }
  assert.match(activeConfig, /location \^~ \/client\/\s*\{\s*return 404;\s*\}/);
  assert.doesNotMatch(activeConfig, /alias\s+.*client/i);
});

test('guarded deploy uploads, checks, verifies, and backs up all seven client assets', () => {
  const deploy = read(deployScriptPath);

  assert.match(deploy, /\$EXPECTED_APP_BUILD\s*=\s*"20260714-v040-product-shell-design-system"/);
  assert.match(deploy, /\$EXPECTED_APP_QUERY\s*=\s*"20260714v040productshelldesignsystem"/);
  assert.deepEqual(powerShellArrayEntries(deploy, 'requiredPublicAssets'), APPROVED_PUBLIC_ASSETS);
  for (const asset of APPROVED_PUBLIC_ASSETS) {
    assert.ok(deploy.includes(`"${asset.replace(/\//g, '\\')}"`), `deploy manifest must include ${asset}`);
  }
  assert.match(deploy, /if \[ -f "\$file" \]; then[\s\S]*?cp -- "\$file" "\$BackupAbsolute\/platform\/\$file"/);
  assert.match(deploy, /sha256sum --check --status "\$LockDir\/upload\.sha256"/);
  assert.match(deploy, /node --check client\/shared\/build_info\.js/);
  assert.match(deploy, /node --check client\/core\/navigation\.js/);
  assert.match(deploy, /node --check client\/core\/accessibility\.js/);
  assert.match(deploy, /node --check client\/core\/shell\.js/);
  assert.match(deploy, /grep -Fq "\$APP_QUERY" index\.html/);
  assert.match(deploy, /grep -Fq "\$APP_BUILD" client\/shared\/build_info\.js/);
  assert.match(deploy, /grep -Fq "\$PPT_QUERY" index\.html/);
  assert.match(deploy, /grep -Fq "\$PPT_BUILD" ppt\.js/);
  assert.match(deploy, /\.Replace\('__APP_QUERY__', \$EXPECTED_APP_QUERY\)/);
  assert.match(deploy, /\.Replace\('__PPT_BUILD__', \$EXPECTED_PPT_BUILD\)/);
});

test('PowerShell AST contains one immutable exact required-public-assets assignment', {
  skip: process.platform !== 'win32'
}, () => {
  assert.deepEqual(powerShellAstArrayEntries(deployScriptPath, 'requiredPublicAssets'), APPROVED_PUBLIC_ASSETS);
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
  assert.match(deploy, /foreach \(\$file in \$FILES\)[\s\S]*?Get-FileHash -Algorithm SHA256 -LiteralPath \$localPath/);
  assert.match(deploy, /\$remoteRelative = "platform\/\$\(Convert-ToRemotePath \$file\)"/);
  assert.match(deploy, /sha256sum --check --status "\$LockDir\/upload\.sha256"/);
});

test('guarded deploy uploads and syntax-checks the baseline generator and architecture inventory test', () => {
  const deploy = read(deployScriptPath);

  assert.match(deploy, /"server\\scripts\\generate_ui_baseline_manifest\.js"/);
  assert.match(deploy, /"server\\tests\\fixtures\\frontend-active-definitions\.json"/);
  assert.doesNotMatch(deploy, /node --check server\/tests\/fixtures\/frontend-active-definitions\.json/);
  assert.match(deploy, /"server\\tests\\customer_workspace_ui\.test\.js"/);
  assert.match(deploy, /"server\\tests\\frontend_architecture_inventory\.test\.js"/);
  assert.match(deploy, /cd server\s*\r?\n+npm ci --ignore-scripts\s*\r?\n+npm rebuild better-sqlite3/);
  assert.match(deploy, /node --test --test-concurrency=1 tests\/\*\.test\.js/);
  assert.doesNotMatch(deploy, /npm test -- --test-concurrency=1/);
  assert.match(deploy, /node node_modules\/playwright-deploy\/cli\.js test -c server\/tests\/deployment-browser-smoke\.config\.js/);
});
