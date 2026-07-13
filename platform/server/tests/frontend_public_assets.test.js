const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const platformRoot = path.join(__dirname, '..', '..');
const indexPath = path.join(platformRoot, 'index.html');
const appPath = path.join(platformRoot, 'app.js');
const navigationPath = path.join(platformRoot, 'client', 'core', 'navigation.js');
const buildInfoPath = path.join(platformRoot, 'client', 'shared', 'build_info.js');
const deployScriptPath = path.join(platformRoot, 'deploy_v8.ps1');
const nginxConfigPath = path.join(platformRoot, 'nginx', 'turingmarket.conf');
const publicAssets = require('../services/public_assets_service');

const EXPECTED_APP_BUILD = '20260713-v030-baseline-consolidation';
const EXPECTED_APP_QUERY = '20260713v030baselineconsolidation';
const EXPECTED_PPT_BUILD = '20260702-v916-kb-bridge-client-cn';
const EXPECTED_PPT_QUERY = '20260702v916kbbridge';

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function scriptSources(indexHtml) {
  return Array.from(indexHtml.matchAll(/<script\s+src=["']([^"']+)["']\s*><\/script>/g))
    .map((match) => match[1]);
}

test('index loads public build metadata and navigation before app.js and keeps approved PPT asset unchanged', () => {
  const sources = scriptSources(read(indexPath));

  assert.deepEqual(
    sources.slice(-4),
    [
      'client/shared/build_info.js',
      'client/core/navigation.js',
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
      && sources.indexOf('client/core/navigation.js') < sources.indexOf(`app.js?v=${EXPECTED_APP_QUERY}`),
    true,
    'navigation.js must load after build_info.js and before app.js'
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
  assert.equal(publicAssets.isPrivateRequestPath('/client/shared/build_info.js'), false);
  assert.equal(publicAssets.isPrivateRequestPath('/client/shared/build_info.js?cache=1'), false);
  assert.equal(publicAssets.isPrivateRequestPath('/client/core/navigation.js'), false);
  assert.equal(publicAssets.isPrivateRequestPath('/client/core/navigation.js?cache=1'), false);

  [
    '/client/',
    '/client/core/',
    '/client/shared/',
    '/client/unknown.js',
    '/client/core/navigation.js/extra',
    '/client/core/%6eavigation.js',
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

test('Nginx config exposes only the exact approved client assets and rejects every other client path', () => {
  const config = read(nginxConfigPath);

  assert.match(config, /location = \/client\/shared\/build_info\.js\s*\{/);
  assert.match(config, /\$request_uri\s*!~\s*\^\/client\/shared\/build_info\\\.js\(\?:\\\?\|\$\)/);
  assert.match(config, /location = \/client\/core\/navigation\.js\s*\{/);
  assert.match(config, /\$request_uri\s*!~\s*\^\/client\/core\/navigation\\\.js\(\?:\\\?\|\$\)/);
  assert.match(config, /location \^~ \/client\/\s*\{\s*return 404;\s*\}/);
  assert.doesNotMatch(config, /alias\s+.*client/i);
});

test('guarded deploy uploads, checks, verifies, and backs up public build metadata and navigation', () => {
  const deploy = read(deployScriptPath);

  assert.match(deploy, /\$EXPECTED_APP_BUILD\s*=\s*"20260713-v030-baseline-consolidation"/);
  assert.match(deploy, /\$EXPECTED_APP_QUERY\s*=\s*"20260713v030baselineconsolidation"/);
  assert.match(deploy, /"client\\shared\\build_info\.js"/);
  assert.match(deploy, /"client\\core\\navigation\.js"/);
  assert.match(deploy, /\$requiredPublicAssets\s*=\s*@\("client\/shared\/build_info\.js", "client\/core\/navigation\.js"\)/);
  assert.match(deploy, /if \[ -f "\$file" \]; then[\s\S]*?cp -- "\$file" "\$BackupAbsolute\/platform\/\$file"/);
  assert.match(deploy, /sha256sum --check --status \.deploy-v030-sha256/);
  assert.match(deploy, /node --check client\/shared\/build_info\.js/);
  assert.match(deploy, /node --check client\/core\/navigation\.js/);
  assert.match(deploy, /grep -Fq "__APP_QUERY__" index\.html/);
  assert.match(deploy, /grep -Fq "__APP_BUILD__" client\/shared\/build_info\.js/);
  assert.match(deploy, /grep -Fq "__PPT_QUERY__" index\.html/);
  assert.match(deploy, /grep -Fq "__PPT_BUILD__" ppt\.js/);
  assert.match(deploy, /\.Replace\('__APP_QUERY__', \$EXPECTED_APP_QUERY\)/);
  assert.match(deploy, /\.Replace\('__PPT_BUILD__', \$EXPECTED_PPT_BUILD\)/);
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
  assert.match(deploy, /sha256sum --check --status \.deploy-v030-sha256/);
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
  assert.match(deploy, /npx playwright test -c server\/tests\/deployment-browser-smoke\.config\.js/);
});
