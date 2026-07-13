const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const platformRoot = path.join(__dirname, '..', '..');
const indexPath = path.join(platformRoot, 'index.html');
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

test('index loads public build metadata before app.js and keeps approved PPT asset unchanged', () => {
  const sources = scriptSources(read(indexPath));

  assert.deepEqual(
    sources.slice(-3),
    [
      'client/shared/build_info.js',
      `app.js?v=${EXPECTED_APP_QUERY}`,
      `ppt.js?v=${EXPECTED_PPT_QUERY}`
    ]
  );
  assert.equal(
    sources.indexOf('client/shared/build_info.js') < sources.indexOf(`app.js?v=${EXPECTED_APP_QUERY}`),
    true,
    'build_info.js must load before app.js'
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

test('Express public asset gate allows only the exact build-info client asset', () => {
  assert.equal(publicAssets.isPrivateRequestPath('/client/shared/build_info.js'), false);
  assert.equal(publicAssets.isPrivateRequestPath('/client/shared/build_info.js?cache=1'), false);

  [
    '/client/',
    '/client/core/',
    '/client/shared/',
    '/client/unknown.js',
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

test('Nginx config exposes only the exact build-info client asset and rejects every other client path', () => {
  const config = read(nginxConfigPath);

  assert.match(config, /location = \/client\/shared\/build_info\.js\s*\{/);
  assert.match(config, /\$request_uri\s*!~\s*\^\/client\/shared\/build_info\\\.js\(\?:\\\?\|\$\)/);
  assert.match(config, /location \^~ \/client\/\s*\{\s*return 404;\s*\}/);
  assert.doesNotMatch(config, /alias\s+.*client/i);
});

test('guarded deploy uploads, checks, verifies, and backs up public build metadata', () => {
  const deploy = read(deployScriptPath);

  assert.match(deploy, /\$EXPECTED_APP_BUILD\s*=\s*"20260713-v030-baseline-consolidation"/);
  assert.match(deploy, /\$EXPECTED_APP_QUERY\s*=\s*"20260713v030baselineconsolidation"/);
  assert.match(deploy, /"client\\shared\\build_info\.js"/);
  assert.match(deploy, /mkdir -p server\/scripts server\/services server\/tests client\/shared/);
  assert.match(deploy, /mkdir -p \$backupDir\/nginx \$backupDir\/server\/scripts \$backupDir\/server\/services \$backupDir\/server\/tests \$backupDir\/client\/shared/);
  assert.match(deploy, /if \[ -f client\/shared\/build_info\.js \]; then\s*cp client\/shared\/build_info\.js \$backupDir\/client\/shared\/build_info\.js;\s*fi/);
  assert.match(deploy, /node --check client\/shared\/build_info\.js/);
  assert.match(deploy, /grep -q "\$EXPECTED_APP_QUERY" index\.html/);
  assert.match(deploy, /grep -q "\$EXPECTED_APP_BUILD" client\/shared\/build_info\.js/);
  assert.match(deploy, /grep -q "\$EXPECTED_PPT_QUERY" index\.html/);
  assert.match(deploy, /grep -q "\$EXPECTED_PPT_BUILD" ppt\.js/);
});
