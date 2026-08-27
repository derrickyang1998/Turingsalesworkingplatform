'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const releaseBranch = 'codex/v0.6.0-crm-sales-workspace';
const releaseSlug = 'v060-crm-sales-workspace';
const appBuild = '20260811-v060-crm-sales-workspace';
const appQuery = '20260811v060crmsalesworkspace';
const currentUiManifestPath = path.join(
  repoRoot, 'docs', 'baselines', 'v0.6.0', 'ui-runtime-manifest.json'
);
const frozenUiManifestPath = path.join(
  repoRoot, 'docs', 'baselines', 'v0.2.9', 'ui-ppt-manifest.json'
);

function read(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

function powerShellArrayEntries(source, variableName) {
  return new Set(powerShellArrayEntryList(source, variableName));
}

function powerShellArrayEntryList(source, variableName) {
  const match = source.match(new RegExp(`\\$${variableName}\\s*=\\s*@\\((?<body>[\\s\\S]*?)\\r?\\n\\)`));
  assert.ok(match, `$${variableName} array must exist`);
  return Array.from(
    match.groups.body.matchAll(/"([^"\r\n]+)"/g),
    (entry) => entry[1].replace(/\\/g, '/')
  );
}

function sourceBetween(source, startAnchor, endAnchor, label) {
  const start = source.indexOf(startAnchor);
  assert.notEqual(start, -1, `${label} start anchor must exist`);
  assert.equal(source.indexOf(startAnchor, start + startAnchor.length), -1, `${label} start anchor must be unique`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `${label} end anchor must follow its start anchor`);
  return source.slice(start, end);
}

function assertOrdered(source, anchors, label) {
  let cursor = -1;
  for (const anchor of anchors) {
    const position = source.indexOf(anchor, cursor + 1);
    assert.notEqual(position, -1, `${label} must contain ${anchor}`);
    assert.ok(position > cursor, `${label} must order ${anchor}`);
    cursor = position;
  }
}

function parserAdmissionProbeSource(deploy) {
  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  const drain = sourceBetween(
    cutover,
    'drain_parser_appliance() {',
    'install_parser_appliance() {',
    'parser drain function'
  );
  const match = drain.match(
    /TM_PARSER_DRAIN_DB="\$DatabasePath" node <<'NODE'\r?\n([\s\S]*?)\r?\nNODE/
  );
  assert.ok(match, 'parser admission Node probe must exist');
  return match[1];
}

function runParserAdmissionProbe(source, databasePath) {
  return spawnSync(process.execPath, ['-e', source], {
    cwd: path.join(platformRoot, 'server'),
    env: { ...process.env, TM_PARSER_DRAIN_DB: databasePath },
    encoding: 'utf8',
    timeout: 10_000
  });
}

test('v0.6 release locks branch, build identity, release slug, and frozen PPT identity', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const buildInfo = read('platform', 'client', 'shared', 'build_info.js');
  const index = read('platform', 'index.html');

  assert.ok(deploy.includes(`$EXPECTED_BRANCH = "${releaseBranch}"`));
  assert.ok(deploy.includes(`$EXPECTED_APP_BUILD = "${appBuild}"`));
  assert.ok(deploy.includes(`$EXPECTED_APP_QUERY = "${appQuery}"`));
  assert.ok(deploy.includes(`backups/${releaseSlug}-$stamp`));
  assert.ok(deploy.includes(`$releaseDir = "${releaseSlug}-$stamp"`));
  assert.match(deploy, /TestRoot="\$ReleaseRoot\/tmp\/deploy-v060-gate-__STAMP__"/);
  assert.doesNotMatch(deploy, /deploy-v0(?:40|50)-gate/);
  assert.match(buildInfo, new RegExp(`app:\\s*["']${appBuild}["']`));
  assert.match(index, new RegExp(`app\\.js\\?v=${appQuery}`));
  assert.match(index, new RegExp(`client/styles/tokens\\.css\\?v=${appQuery}`));
  assert.match(deploy, /20260702-v916-kb-bridge-client-cn/);
  assert.match(deploy, /20260702v916kbbridge/);
  assert.match(deploy, /f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e/);
  assert.match(deploy, /if \(Number\(version\) !== 7\) throw new Error\('Candidate migration target version mismatch'\)/);
  assert.doesNotMatch(deploy, /if \(Number\(version\) !== 6\) throw new Error\('Candidate migration target version mismatch'\)/);
});

test('v0.6 deploy inventory ships migration 006, CRM runtime, and every Phase 5 regression', () => {
  const files = powerShellArrayEntries(read('platform', 'deploy_v8.ps1'), 'FILES');
  for (const required of [
    'server/migrations/006_crm_sales_workspace.js',
    'server/services/crm_contract.js',
    'server/services/crm_customer_service.js',
    'server/services/crm_query_service.js',
    'server/services/crm_scope_service.js',
    'server/tests/crm_contract.test.js',
    'server/tests/crm_customer_service.test.js',
    'server/tests/crm_phase5_http.test.js',
    'server/tests/crm_phase5_migration.test.js',
    'server/tests/crm_s6_ui.test.js',
    'server/tests/crm_scope_query.test.js',
    'server/tests/customer_mutation_ui.test.js',
    'server/tests/organization_access_context.test.js',
    'server/tests/release_v060_contract.test.js'
  ]) {
    assert.equal(files.has(required), true, `${required} must ship in v0.6`);
  }
});

test('current trusted source and sanitization contracts are exact v1-to-v7', () => {
  const trustedManifest = JSON.parse(read(
    'platform', 'server', 'scripts', 'trusted_production_source_manifest.json'
  ));
  const sanitizationManifest = JSON.parse(read(
    'platform', 'server', 'scripts', 'sanitization_manifest.json'
  ));
  const trustedPaths = new Set(trustedManifest.files.map((entry) => entry.path));

  assert.deepEqual(trustedManifest.migrationContract, {
    sourceVersion: 1,
    targetVersion: 7,
    runs: 2,
    deterministicAppendTables: ['activity_log']
  });
  assert.deepEqual(
    sanitizationManifest.exactProfiles.map((profile) => profile.schemaVersion),
    [6, 7]
  );
  for (const required of [
    'server/migrations/006_crm_sales_workspace.js',
    'server/migrations/007_knowledge_governance.js',
    'server/services/crm_contract.js',
    'server/services/crm_customer_service.js',
    'server/services/crm_query_service.js',
    'server/services/crm_scope_service.js'
  ]) {
    assert.equal(trustedPaths.has(required), true, `${required} must be checksum-pinned`);
  }
});

test('v0.6 trusted bytes have exact LF rules and release records exist', () => {
  const attributes = new Set(read('.gitattributes').split(/\r?\n/).filter(Boolean));
  for (const required of [
    'platform/ppt.js',
    'platform/server/migrations/006_crm_sales_workspace.js',
    'platform/server/services/crm_contract.js',
    'platform/server/services/crm_customer_service.js',
    'platform/server/services/crm_query_service.js',
    'platform/server/services/crm_scope_service.js',
    'platform/server/scripts/check_cutover_capacity.py'
  ]) {
    assert.equal(attributes.has(`${required} text eol=lf`), true, `${required} must be LF-pinned`);
  }
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'docs', 'version-records', '2026-08-11-v0.6.0-crm-sales-workspace.md')),
    true
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'archive', 'versions', '2026-08-11-v0.6.0-crm-sales-workspace.md')),
    true
  );
  assert.match(read('CHANGELOG.md'), /v0\.6\.0-crm-sales-workspace/);
});

test('v0.6 release records match the trusted-source and parser self-test contracts', () => {
  const trustedManifest = JSON.parse(read(
    'platform', 'server', 'scripts', 'trusted_production_source_manifest.json'
  ));
  const parserManifest = JSON.parse(read(
    'platform', 'server', 'systemd', 'turingmarket-parser.manifest.json'
  ));
  const changelog = read('CHANGELOG.md').split(/\r?\n---\r?\n/, 1)[0];
  const versionRecord = read(
    'docs', 'version-records', '2026-08-11-v0.6.0-crm-sales-workspace.md'
  );
  const archiveRecord = read(
    'archive', 'versions', '2026-08-11-v0.6.0-crm-sales-workspace.md'
  );
  const runbook = read('platform', 'DEPLOY.md');

  assert.equal(trustedManifest.files.length, 50);
  assert.equal(parserManifest.required_self_tests.length, 21);
  assert.match(versionRecord, /Trusted source: 49 SHA-256-pinned files/);
  assert.match(archiveRecord, /trusted-source manifest now pins 49 files/i);
  for (const record of [changelog, runbook, versionRecord, archiveRecord]) {
    assert.match(record, /21[^\r\n]*(?:self-tests|自检)/i);
    assert.doesNotMatch(record, /(?:builder|构建器)[^\r\n]*chroot/i);
    assert.match(record, /(?:unprivileged build unit|非特权构建单元)/i);
  }
});

test('v0.6 current parent public-guard evidence retains 8 of 11 and keeps Linux root authority pending', () => {
  const records = [
    read('CHANGELOG.md').split(/\r?\n---\r?\n/, 1)[0],
    read('platform', 'DEPLOY.md'),
    read('docs', 'version-records', '2026-08-11-v0.6.0-crm-sales-workspace.md'),
    read('archive', 'versions', '2026-08-11-v0.6.0-crm-sales-workspace.md')
  ];
  for (const record of records) {
    assert.match(record, /current[^\r\n]*11 total[^\r\n]*8 pass(?:ed)?[^\r\n]*3 fail(?:ed)?[^\r\n]*0 skip(?:ped)?/i);
    assert.match(record, /Git Bash[^\r\n]*\/usr\/bin\/install -d[^\r\n]*(?:denial|denied)/i);
    assert.match(record, /(?:native Linux|Linux\/root)[^\r\n]*(?:authority|authoritative|pending)/i);
    for (const line of record.split(/\r?\n/).filter((entry) => /9\s*\/\s*9/.test(entry))) {
      assert.match(line, /historical|historic|此前|历史/i, '9/9 may appear only as explicitly historical evidence');
    }
  }
});

test('v0.6 production lockfile excludes the audited vulnerable transitive dependency ranges', () => {
  const lock = JSON.parse(read('platform', 'server', 'package-lock.json'));
  assert.equal(lock.packages['node_modules/body-parser'].version, '2.3.0');
  assert.equal(lock.packages['node_modules/ip-address'].version, '10.5.0');
});

test('v0.6 parser appliance has a dedicated reproducible dependency closure', () => {
  const manifestBytes = fs.readFileSync(path.join(
    platformRoot, 'server', 'systemd', 'turingmarket-parser.manifest.json'
  ));
  const manifest = JSON.parse(manifestBytes);
  const parserRoot = path.join(platformRoot, 'server', 'parser-runtime');

  assert.equal(manifest.version, 3);
  assert.deepEqual(manifest.build, {
    format: 'tm-parser-runtime-build-v1',
    architecture: 'x86_64',
    node_version: 'v20.20.2',
    python_version: '3.14.4'
  });
  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const serverSource = read('platform', 'server', 'server.js');
  assert.match(
    serverSource,
    new RegExp(`RELEASE_PINNED_UPLOAD_MANIFEST_SHA256\\s*=\\s*\\r?\\n\\s*'${manifestSha256}'`),
    'the production startup pin must match the exact checked-in parser manifest bytes'
  );
  for (const relativePath of [
    'package.json',
    'package-lock.json',
    'requirements.lock'
  ]) {
    const bytes = fs.readFileSync(path.join(parserRoot, relativePath));
    assert.equal(
      manifest.artifacts[`parser-runtime/${relativePath}`],
      crypto.createHash('sha256').update(bytes).digest('hex'),
      `${relativePath} must be checksum-pinned by the parser manifest`
    );
  }
  assert.equal(
    Object.hasOwn(manifest.artifacts, 'package-lock.json'),
    false,
    'the parser appliance must not inherit the HTTP server dependency closure'
  );
});

test('v0.6 runbook states the disposable unprivileged parser build boundary', () => {
  const deployGuide = read('platform', 'DEPLOY.md');
  assert.match(deployGuide, /Disposable Unprivileged Build/i);
  assert.match(deployGuide, /dependency acquisition[^.]*disposable[^.]*unprivileged systemd units/i);
  assert.match(deployGuide, /root[^.]*inaccessible lifecycle paths/i);
  assert.match(deployGuide, /root[^.]*independently verifies[^.]*seals[^.]*snapshots[^.]*installs[^.]*accepts[^.]*rolls back/i);
  assert.doesNotMatch(deployGuide, /Root-Only Build/i);
  assert.doesNotMatch(deployGuide, /builds the runtime there as root/i);
});

test('v0.6 deploy inventory contains the parser release and capacity gate artifacts', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const parserFiles = powerShellArrayEntryList(deploy, 'FILES').filter((entry) => (
    entry.startsWith('server/parser-runtime/') ||
    entry === 'server/scripts/build_upload_sandbox_runtime.sh' ||
    entry === 'server/scripts/check_cutover_capacity.py' ||
    entry === 'server/scripts/provision_upload_sandbox_runtime.sh' ||
    entry === 'server/scripts/upload_sandbox_self_test.js' ||
    entry.startsWith('server/systemd/turingmarket-parser')
  ));
  assert.deepEqual(parserFiles.sort(), [
    'server/parser-runtime/package.json',
    'server/parser-runtime/package-lock.json',
    'server/parser-runtime/pip-cacert.crt',
    'server/parser-runtime/requirements.lock',
    'server/parser-runtime/sitecustomize.py',
    'server/scripts/build_upload_sandbox_runtime.sh',
    'server/scripts/check_cutover_capacity.py',
    'server/scripts/provision_upload_sandbox_runtime.sh',
    'server/scripts/upload_sandbox_self_test.js',
    'server/systemd/turingmarket-parser.manifest.json',
    'server/systemd/turingmarket-parser.slice',
    'server/systemd/turingmarket-parser@.service'
  ].sort());
});

test('v0.6 capacity gate runs from the root-only appliance before mutation intent', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const preparation = sourceBetween(
    deploy,
    'function Invoke-RemoteParserCandidatePreparation {',
    'function Invoke-RemoteBackup {',
    'parser candidate preparation function'
  );
  assert.match(preparation, /copy_trusted_parser_source server\/scripts\/check_cutover_capacity\.py/);
  assert.match(preparation, /ParserCapacityPlanner="\$ParserApplianceRoot\/check-cutover-capacity"/);
  assert.match(preparation, /install -o root -g root -m 0500[^\r\n]+check_cutover_capacity\.py[^\r\n]+"\$ParserCapacityPlanner"/);

  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  assertOrdered(cutover, [
    'assert_parser_candidate',
    'assert_cutover_capacity',
    'CUTOVER_CAPACITY_OK',
    'record_phase mutation-intent'
  ], 'capacity preflight');
  assert.match(cutover, /"\$ParserCapacityPlanner"/);
  assert.match(cutover, /--backup-root "\$BackupAbsolute"/);
  assert.match(cutover, /--parser-state-root \/var\/lib\/turingmarket-parser/);
  assert.match(cutover, /--database-path "\$DatabasePath"/);
  assert.match(cutover, /--ppt-cache-root "\$PptCacheDir"/);
  assert.match(cutover, /--live-dir "\$LiveDir"/);
  assert.match(cutover, /--candidate-dir "\$CandidateDir"/);
  assert.match(cutover, /--parser-stage "\$ParserRuntimeStage"/);
  assert.match(cutover, /prepare_ppt_cache_for_cutover\(\)/);
  assert.match(cutover, /ppt-cache\.absent/);
  assert.match(cutover, /ppt-cache\.present/);
  const preparationCall = cutover.lastIndexOf('\nprepare_ppt_cache_for_cutover\n');
  assert.ok(preparationCall > cutover.indexOf('record_phase writers-stopped'));
  assert.ok(preparationCall < cutover.lastIndexOf('\ncreate_cutover_snapshot\n'));
});

test('v0.6 deploy seals the parser appliance under the root-only lifecycle before readiness or mutation', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const preparation = sourceBetween(
    deploy,
    'function Invoke-RemoteParserCandidatePreparation {',
    'function Invoke-RemoteBackup {',
    'parser candidate preparation function'
  );
  assertOrdered(preparation, [
    'TrustedSourceGate="__TRUSTED_SOURCE_GATE__"',
    'TrustedSourceBundle="__TRUSTED_SOURCE_BUNDLE__"',
    'ParserApplianceRoot="$LockDir/parser-appliance"',
    'ParserSourceRoot="$ParserApplianceRoot/source"',
    'ParserDependencyCache="$ParserApplianceRoot/dependency-cache"',
    'ParserRuntimeStage="$ParserApplianceRoot/runtime.stage"',
    'ParserEvidence="$ParserApplianceRoot/runtime.evidence.json"',
    'ParserChecksums="$ParserApplianceRoot/runtime.sha256"',
    'ParserProvisioner="$ParserApplianceRoot/provisioner"',
    'ParserBuild="$ParserApplianceRoot/build-runtime"',
    'ParserTrustedVerifier="$TrustedSourceBundle/server/scripts/trusted_parser_runtime_verifier.js"',
    'ParserTrustedManifest="$TrustedSourceBundle/server/systemd/turingmarket-parser.manifest.json"',
    'sha256sum --check --status "$LockDir/upload.sha256"',
    'candidate-tree.sha256',
    '"$TrustedSourceGate" stage',
    'copy_trusted_parser_source',
    'server/services/upload_sandbox_service.js',
    'server/scripts/build_upload_sandbox_runtime.sh',
    'server/scripts/provision_upload_sandbox_runtime.sh',
    'server/scripts/upload_sandbox_self_test.js',
    'server/systemd/turingmarket-parser.manifest.json',
    'find "$ParserSourceRoot" -xdev -type d -exec chmod 0555 {} +',
    'systemd-run --quiet --wait --collect',
    '"$ParserBuild"',
    '--source-root "$ParserSourceRoot"',
    '--output-root "$ParserRuntimeStage"',
    '--dependency-cache-root "$ParserDependencyCache"',
    '--trusted-verifier "$ParserTrustedVerifier"',
    '--expected-verifier-sha256 "$ExpectedTrustedParserVerifierSha256"',
    '--expected-manifest-sha256 "$ExpectedParserManifestSha256"',
    '--expected-sha256 "$ExpectedRuntimeSha256"',
    'printf \'%s\\n\' "$BuildEvidence" > "$ParserEvidence.next"',
    'find . -xdev -type f -print0',
    'chmod 0444',
    'PARSER_RUNTIME_CANDIDATE_READY'
  ], 'parser candidate preparation');
  assert.match(preparation, /640592018/);
  assert.match(preparation, /ParserRequiredBytes/);
  assert.match(preparation, /test -f "\$TrustedSource"/);
  assert.match(preparation, /test ! -L "\$TrustedSource"/);
  assert.match(preparation, /stat -c '%U:%G:%a:%h'/);
  assert.match(preparation, /root:root:[0-7]+:1/);
  assert.match(preparation, /\(8#\$TrustedMode & 0022\) == 0/);
  assert.match(preparation, /ExpectedSourceSha256=/);
  assert.match(preparation, /sha256sum "\$TrustedSource"/);
  assert.match(preparation, /sha256sum "\$TargetSource"/);
  assert.match(preparation, /assert_root_only_parser_appliance/);
  const cacheFetchMatch = preparation.match(/systemd-run --quiet --wait --collect \\\r?\n\s+--unit="\$ParserCacheUnit"([\s\S]*?)-- \/usr\/bin\/env -i/);
  assert.ok(cacheFetchMatch, 'parser dependency fetch must execute inside its transient service');
  const cacheFetch = cacheFetchMatch[1];
  assert.match(cacheFetch, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(cacheFetch, /IPAddressDeny=[^"\r\n]*169\.254\.0\.0\/16/);
  assert.match(cacheFetch, /IPAddressDeny=[^"\r\n]*10\.0\.0\.0\/8/);
  assert.match(cacheFetch, /IPAddressDeny=[^"\r\n]*172\.16\.0\.0\/12/);
  assert.match(cacheFetch, /IPAddressDeny=[^"\r\n]*192\.168\.0\.0\/16/);
  assert.match(cacheFetch, /IPAddressDeny=[^"\r\n]*fc00::\/7/);
  assert.match(cacheFetch, /IPAddressAllow=127\.0\.0\.53\/32 127\.0\.0\.54\/32/);
  assert.match(preparation, /npm_config_userconfig=\/dev\/null/);
  assert.match(preparation, /npm_config_globalconfig=\/tmp\/turingmarket-parser-global\.npmrc/);
  assert.match(preparation, /install -m 0600 \/dev\/null \/tmp\/turingmarket-parser-global\.npmrc/);
  assert.doesNotMatch(
    preparation,
    /npm_config_userconfig=([^\s]+)[\s\S]*?npm_config_globalconfig=\1(?:\s|$)/,
    'npm user and global configuration paths must remain distinct'
  );
  assert.match(preparation, /set \+e[\s\S]*?systemd-run --quiet --wait --collect[\s\S]*?ParserCacheStatus="\$\?"[\s\S]*?set -e/);
  assert.match(preparation, /if \[ "\$ParserCacheStatus" -ne 0 \]; then[\s\S]*?exit "\$ParserCacheStatus"/);
  assert.doesNotMatch(preparation, /\$ReleaseRoot\/parser-runtime/);
  assert.doesNotMatch(preparation, /TargetSource=.*\$ReleaseRoot/);
  assert.doesNotMatch(preparation, /"\$CandidateDir\/server\/scripts\/(?:build|provision)_upload_sandbox_runtime\.sh"\s+(?:--|snapshot|install|rollback)/);

  const orchestration = sourceBetween(
    deploy,
    'Write-Host "TuringMarket guarded deploy starting"',
    'Write-Host "Deploy complete"',
    'deployment orchestration'
  );
  assertOrdered(orchestration, [
    'Candidate upload checksum verification failed',
    'Invoke-RemoteBackup',
    'Invoke-RemoteBash -Script $candidateGate',
    'Invoke-RemoteParserCandidatePreparation',
    'Invoke-RemoteBash -Script $cutoverGate'
  ], 'deployment orchestration');
});

test('v0.6 parser dependency fetch uses the accelerated mirror and proves completion before sealing', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const preparation = sourceBetween(
    deploy,
    'function Invoke-RemoteParserCandidatePreparation {',
    'function Invoke-RemoteBackup {',
    'parser candidate preparation function'
  );

  assert.match(preparation, /PIP_INDEX_URL=https:\/\/mirrors\.aliyun\.com\/pypi\/simple\//);
  assert.match(
    preparation,
    /printf "%s\\n" "PARSER_DEPENDENCY_CACHE_READY" > \/parser-cache\/\.fetch-complete/
  );
  const transientFetchMatch = preparation.match(
    /systemd-run --quiet --wait --collect([\s\S]*?)\r?\n'\r?\nParserCacheStatus=/
  );
  assert.ok(transientFetchMatch, 'parser dependency fetch command must remain one transient unit');
  const transientFetch = transientFetchMatch[1];
  assert.match(transientFetch, /UMask=0077/);
  assert.match(transientFetch, /RuntimeMaxSec=30m/);
  assert.match(transientFetch, /PIP_INDEX_URL=https:\/\/mirrors\.aliyun\.com\/pypi\/simple\//);
  assert.match(transientFetch, /python3 -m pip download --require-hashes/);
  assert.match(transientFetch, /printf "%s\\n" "PARSER_DEPENDENCY_CACHE_READY" > \/parser-cache\/\.fetch-complete/);
  assertOrdered(preparation, [
    'python3 -m pip download --require-hashes',
    'printf "%s\\n" "PARSER_DEPENDENCY_CACHE_READY" > /parser-cache/.fetch-complete',
    'ParserCacheStatus="$?"',
    'test -f "$ParserCacheCompletionMarker"',
    'test -L "$ParserCacheCompletionMarker"',
    "test \"$(stat -c '%U:%G:%a:%h' \"$ParserCacheCompletionMarker\")\" = \"$GateUser:$GateUser:600:1\"",
    "test \"$(cat \"$ParserCacheCompletionMarker\")\" = 'PARSER_DEPENDENCY_CACHE_READY'",
    'rm -f -- "$ParserCacheCompletionMarker"',
    'chown -R root:root "$ParserDependencyCacheStage"'
  ], 'parser dependency fetch completion proof');
});

test('v0.6 root parser control plane uses only the independently pinned verifier', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const preparation = sourceBetween(
    deploy,
    'function Invoke-RemoteParserCandidatePreparation {',
    'function Invoke-RemoteBackup {',
    'parser candidate preparation function'
  );
  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  for (const rootControl of [preparation, cutover]) {
    assert.doesNotMatch(rootControl, /require\([^\r\n]*upload_sandbox_service\.js/);
    assert.doesNotMatch(rootControl, /TM_INSPECT_VERIFIER=.*upload_sandbox_service\.js/);
    assert.match(rootControl, /trusted_parser_runtime_verifier\.js|ParserTrustedVerifier/);
  }
  assert.match(preparation, /sha256sum --check --status "\$LockDir\/upload\.sha256"/);
  assert.match(preparation, /candidate-tree\.sha256/);
});

test('v0.6 candidate gate cannot own or mutate the root-only parser appliance', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const candidateGate = sourceBetween(
    deploy,
    '$candidateGate = @\'',
    '$candidateGate = $candidateGate.Replace(',
    'candidate gate'
  );
  assert.match(candidateGate, /ParserApplianceRoot="\$LockDir\/parser-appliance"/);
  assert.match(candidateGate, /test ! -e "\$ParserApplianceRoot"/);
  assert.doesNotMatch(candidateGate, /assert_root_only_parser_appliance/);
  assert.doesNotMatch(candidateGate, /runuser[^\r\n]+ParserApplianceRoot/);
  assert.doesNotMatch(candidateGate, /chown[^\r\n]*ParserApplianceRoot/);

  const takeover = sourceBetween(
    deploy,
    'function Enter-RemoteInterruptedDeploymentRecovery {',
    'function Get-RemoteDeploymentRunMetadata {',
    'deployment takeover function'
  );
  assert.match(takeover, /allowedDirectories = \{'migration-rehearsal', 'restore-v050', 'parser-appliance'\}/);
  assert.match(takeover, /def validateRootOnlyTree\(rootPath, expectedUid\):/);
  assert.match(takeover, /os\.walk\(rootPath, topdown=True, followlinks=False\)/);
  assert.match(takeover, /stat\.S_ISDIR/);
  assert.match(takeover, /stat\.S_ISREG/);
  assert.match(takeover, /status\.st_uid != expectedUid/);
  assert.match(takeover, /status\.st_nlink != 1/);
  assert.match(takeover, /stat\.S_IMODE\(status\.st_mode\) & 0o022/);
  assert.match(takeover, /validateRootOnlyTree\(entry\.path, expectedUid\)/);
});

test('v0.6 initial backup leaves the live parser untouched', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const backup = sourceBetween(
    deploy,
    'function Invoke-RemoteBackup {',
    'function Get-Pm2PersistenceVerifier {',
    'remote backup function'
  );
  assert.doesNotMatch(backup, /turingmarket-parser/);
  assert.doesNotMatch(backup, /parser-appliance/);
  assert.doesNotMatch(backup, /provision_upload_sandbox_runtime/);
});

test('v0.6 cutover snapshot couples parser appliance before aggregate checksums', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  const snapshot = sourceBetween(
    cutover,
    'create_cutover_snapshot() {',
    'archive_prior_current_marker() {',
    'cutover snapshot function'
  );
  assertOrdered(snapshot, [
    'SnapshotStage="$BackupAbsolute/.cutover-snapshot.__WRITER_TOKEN__"',
    '"$ParserLifecycleProvisioner" snapshot',
    '--snapshot-root "$SnapshotStage/parser-appliance"',
    'find . -type f ! -name SHA256SUMS',
    'mv "$SnapshotStage" "$CutoverSnapshot"'
  ], 'coupled cutover snapshot');
});

test('v0.6 parser snapshot manifest is relocatable to the final rollback path', () => {
  const provisioner = read(
    'platform', 'server', 'scripts', 'provision_upload_sandbox_runtime.sh'
  );
  assert.match(
    provisioner,
    /valid_cutover_parser_snapshot_stage[\s\S]*\/root\/turingmarket\/backups\/\*\/\.cutover-snapshot\.\*\/parser-appliance/
  );
  assert.match(
    provisioner,
    /valid_final_cutover_parser_snapshot[\s\S]*\/root\/turingmarket\/backups\/\*\/cutover-snapshot\/parser-appliance/
  );
  assert.match(
    provisioner,
    /\[\[ "\$ACTION" =~ \^\(snapshot\|install\|verify\|rollback\)\$ \]\]/
  );
  assert.match(
    provisioner,
    /\[\[ "\$ACTION" != snapshot \]\] && valid_final_cutover_parser_snapshot "\$SNAPSHOT_ROOT"/
  );
  assert.match(
    provisioner,
    /cd "\$SNAPSHOT_ROOT"[\s\S]*find \.[^\r\n]*! -name SHA256SUMS[^\r\n]*sha256sum > SHA256SUMS/
  );
  assertOrdered(provisioner, [
    'SELF_PATH="$(realpath -e -- "$0")"',
    'record_path "$SELF_PATH" provisioner',
    'find . -type f ! -name SHA256SUMS',
    'sha256sum > SHA256SUMS'
  ], 'durable snapshot provisioner');
  assert.match(provisioner, /record_path "\$SELF_PATH" provisioner/);
  assert.match(provisioner, /for name in service-unit slice-unit self-test provisioner; do/);
  assert.match(
    provisioner,
    /\(cd "\$SNAPSHOT_ROOT" && sha256sum --check --status SHA256SUMS\)/
  );
  assert.doesNotMatch(
    provisioner,
    /find "\$SNAPSHOT_ROOT"[^\r\n]*xargs[^\r\n]*sha256sum > "\$SNAPSHOT_ROOT\/SHA256SUMS"/
  );
  assert.match(provisioner, /verify_trusted_verifier/);
  assert.match(
    provisioner,
    /\/usr\/bin\/node "\$TRUSTED_VERIFIER" measure-runtime --root "\$root" --require-root-ownership true/
  );
  assert.doesNotMatch(provisioner, /require\([^\r\n]*upload_sandbox_service\.js/);
});

test('v0.6 cutover drains parser work, installs after code exchange, and accepts parser evidence', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  const lifecycle = sourceBetween(
    cutover,
    'record_phase mutation-intent',
    'cd "$RemoteRoot"',
    'cutover mutation lifecycle'
  );
  assert.equal(
    Array.from(lifecycle.matchAll(/^drain_parser_appliance$/gm)).length,
    2,
    'parser admissions must be drained before and after stopping application writers'
  );
  assertOrdered(lifecycle, [
    'enter_all_traffic_maintenance',
    'drain_parser_appliance',
    'stop_and_quiesce_writers',
    'drain_parser_appliance',
    'record_phase writers-stopped',
    'create_cutover_snapshot'
  ], 'race-free parser drain');
  assertOrdered(cutover, [
    'enter_all_traffic_maintenance',
    'drain_parser_appliance',
    'pm2 stop turingmarket',
    'create_cutover_snapshot',
    'record_phase mutation-started',
    'remove_quiesced_database_sidecars',
    'adopt_legacy_database_if_required',
    "'atomic release exchange failed'",
    'install_parser_appliance',
    'pm2 restart ecosystem.config.js',
    'record_parser_acceptance_evidence',
    'record_phase accepted'
  ], 'parser cutover lifecycle');
  const sidecarCleanup = sourceBetween(
    cutover,
    'remove_quiesced_database_sidecars() {',
    'create_cutover_snapshot() {',
    'quiesced database sidecar cleanup'
  );
  assert.match(sidecarCleanup, /for suffix in \('-journal', '-wal', '-shm'\)/);
  assert.match(sidecarCleanup, /os\.lstat\(candidate\)/);
  assert.match(sidecarCleanup, /stat\.S_ISREG/);
  assert.match(sidecarCleanup, /stat\.S_ISLNK/);
  assert.match(sidecarCleanup, /metadata\.st_nlink != 1/);
  assert.match(sidecarCleanup, /metadata\.st_uid != 0 or metadata\.st_gid != 0/);
  assert.match(sidecarCleanup, /stat\.S_IMODE\(metadata\.st_mode\) != 0o600/);
  assert.match(sidecarCleanup, /suffix in \('-journal', '-wal'\) and metadata\.st_size != 0/);
  assert.match(sidecarCleanup, /os\.unlink\(candidate\)/);
  assert.match(sidecarCleanup, /os\.fsync\(directory\)/);
  assert.match(sidecarCleanup, /QUIESCED_DATABASE_SIDECARS_REMOVED/);
  const install = sourceBetween(
    cutover,
    'install_parser_appliance() {',
    'record_parser_acceptance_evidence() {',
    'parser install function'
  );
  assertOrdered(install, [
    '"$ParserLifecycleProvisioner" install',
    '--snapshot-root "$ParserSnapshot"',
    '--staged-runtime "$ParserRuntimeStage"',
    '--source-root "$ParserSourceRoot"',
    '--expected-sha256 "$ExpectedParserRuntimeSha256"'
  ], 'parser install');
  const acceptance = sourceBetween(
    cutover,
    'record_parser_acceptance_evidence() {',
    'stop_and_quiesce_writers() {',
    'parser acceptance function'
  );
  assert.match(cutover, /ParserAcceptedEvidence="\$AcceptedEvidenceRoot\/parser-__RUN_ID__\.json"/);
  assert.match(cutover, /ParserSelfTest="\/usr\/local\/libexec\/turingmarket\/upload_sandbox_self_test"/);
  assertOrdered(acceptance, [
    'ParserRuntimeSha256="$(python3 - "$ParserSourceRoot/systemd/turingmarket-parser.manifest.json"',
    '"$ParserLifecycleProvisioner" verify',
    '--trusted-verifier "$ParserTrustedVerifier"',
    '--expected-verifier-sha256 "$ExpectedTrustedParserVerifierSha256"',
    '--expected-manifest-sha256 "$ExpectedParserManifestSha256"',
    '--build-evidence "$ParserRuntimeEvidence"',
    'ParserAcceptanceBinding="$(generate_installed_parser_acceptance_binding)"',
    'root:root:600:1',
    'assert_installed_parser_acceptance_binding',
    'PARSER_ACCEPTANCE_EVIDENCE_DURABLE'
  ], 'parser acceptance evidence');
  assert.doesNotMatch(acceptance, /"\$ParserSelfTest" --json|sorted\(result\) != sorted\(required\)/);
  assert.match(cutover, /turingmarket-parser@\*\.service/);
  assert.match(cutover, /systemctl show turingmarket-parser\.slice/);
  assert.match(cutover, /LoadState --value[^\r\n]*\|\| printf not-found/);
  assert.match(cutover, /if \[ "\$ParserSliceLoadState" != "not-found" \]/);
  assert.match(cutover, /find "\$ParserSpoolRoot" -mindepth 1 -print -quit/);
  assert.match(cutover, /verify_candidate_health\(\)/);
  assert.match(cutover, /health\.parser\.ready !== true/);
  assert.match(cutover, /health\.parser\.manifest_sha256 !== expectedManifestSha256/);
  assert.ok(
    cutover.lastIndexOf('\nverify_candidate_health\n') <
      cutover.lastIndexOf('\nrecord_parser_acceptance_evidence\n'),
    'parser-aware health must pass before parser acceptance is recorded'
  );
});

test('v0.6 process startup deadline exceeds the production parser self-test ceiling', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const server = read('platform', 'server', 'server.js');
  const startup = deploy.match(/\$PARSER_STARTUP_TIMEOUT_SECONDS\s*=\s*([0-9]+)/);
  const selfTests = sourceBetween(
    server,
    'async function runProductionUploadSandboxSelfTests() {',
    'function localUploadReadinessAdapters() {',
    'production parser self-test runner'
  );
  const selfTestTimeout = selfTests.match(/timeoutMs:\s*([0-9_]+)/);

  assert.ok(startup, 'deploy must define a dedicated parser-aware startup timeout');
  assert.ok(selfTestTimeout, 'server must expose the production parser self-test timeout');
  const startupMilliseconds = Number(startup[1]) * 1000;
  const selfTestMilliseconds = Number(selfTestTimeout[1].replaceAll('_', ''));
  assert.ok(
    startupMilliseconds >= selfTestMilliseconds + 30_000,
    'startup timeout must include at least 30 seconds beyond the parser self-test ceiling'
  );
  assert.equal(
    (deploy.match(/for attempt in \$\(seq 1 __PARSER_STARTUP_TIMEOUT_SECONDS__\); do/g) || []).length,
    4
  );
  assert.equal(
    (deploy.match(/\.Replace\('__PARSER_STARTUP_TIMEOUT_SECONDS__', \$PARSER_STARTUP_TIMEOUT_SECONDS\.ToString\(\)\)/g) || []).length,
    4
  );
});

test('v0.6 production startup performs one complete parser runtime scan', () => {
  const server = read('platform', 'server', 'server.js');
  const selfTests = sourceBetween(
    server,
    'async function runProductionUploadSandboxSelfTests() {',
    'function localUploadReadinessSnapshot() {',
    'production parser self-test runner'
  );
  const bootstrap = sourceBetween(
    server,
    'async function bootstrapServer() {',
    'bootstrapServer().catch((error) => {',
    'server bootstrap'
  );

  assert.match(selfTests, /env:\s*productionSelfTestEnvironment\(\)/);
  assert.match(
    bootstrap,
    /verifyInstalledArtifacts:\s*verifyInstalledControlArtifacts/
  );
  assert.match(
    server,
    /require\('\.\/services\/parser_startup_service'\)/
  );
});

test('v0.6 cutover drains admitted Node HTTP connections to stable zero before PM2 stop', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  const drain = sourceBetween(
    cutover,
    'drain_admitted_http_connections() {',
    'drain_parser_appliance() {',
    'admitted HTTP connection drain'
  );
  const lifecycle = sourceBetween(
    cutover,
    'record_phase mutation-intent',
    'cd "$RemoteRoot"',
    'cutover mutation lifecycle'
  );
  assertOrdered(lifecycle, [
    'enter_all_traffic_maintenance',
    'record_phase maintenance-entered',
    'drain_admitted_http_connections',
    'drain_parser_appliance',
    'stop_and_quiesce_writers'
  ], 'HTTP admission drain lifecycle');
  assert.match(drain, /command -v ss/);
  assert.match(drain, /ss -H -tn state established ['"]\( sport = :3002 \)['"]/);
  assert.match(drain, /DrainDeadline=\$\(\(SECONDS \+ __MAINTENANCE_TIMEOUT_SECONDS__\)\)/);
  assert.match(drain, /StableZeroSince/);
  assert.match(drain, /__HTTP_DRAIN_STABLE_SECONDS__/);
  assert.match(drain, /HTTP connection drain timed out; leaving Node running/);
  assert.match(drain, /HTTP_CONNECTIONS_DRAINED/);
  assert.match(deploy, /\.Replace\('__HTTP_DRAIN_STABLE_SECONDS__', \$HttpDrainStableSeconds\.ToString\(\)\)/);

  const resume = sourceBetween(
    deploy,
    'function Invoke-RemotePreMutationResume {',
    'function Get-RemoteDeploymentAcceptanceState {',
    'pre-mutation recovery function'
  );
  const processRecovery = sourceBetween(
    resume,
    '# Keep public maintenance in place until the previous process is healthy.',
    'install -d -o root -g root -m 0700 "$MarkerRoot"',
    'pre-mutation process recovery'
  );
  assert.match(processRecovery, /\$Phase" = mutation-intent/);
  assert.match(processRecovery, /\$Phase" = maintenance-entered/);
  assert.match(processRecovery, /Previous release is not healthy while admitted connections may remain/);
  assert.match(processRecovery, /else[\s\S]*pm2 restart ecosystem\.config\.js/);
});

test('v0.6 parser admission drain accepts an absent legacy ledger and rejects unexpected schema', (t) => {
  const probe = parserAdmissionProbeSource(read('platform', 'deploy_v8.ps1'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-v060-parser-drain-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const legacyPath = path.join(fixtureRoot, 'legacy.db');
  const legacy = new Database(legacyPath);
  legacy.exec('CREATE TABLE legacy_sentinel (id INTEGER PRIMARY KEY)');
  legacy.close();
  const legacyResult = runParserAdmissionProbe(probe, legacyPath);
  assert.equal(legacyResult.status, 0, legacyResult.stderr);
  assert.equal(legacyResult.stdout, '0');

  const columns = [
    'id', 'org_id', 'user_id', 'campaign_id', 'secondary_campaign_id', 'resource_claim',
    'scope', 'idempotency_key', 'reservation_nonce', 'request_hash', 'audit_fingerprint',
    'expected_event_count', 'state', 'lease_until', 'lease_token', 'status_code',
    'response_kind', 'response_json', 'response_headers_json', 'response_cache_key',
    'response_sha256', 'response_bytes', 'response_content_type', 'response_filename',
    'created_at', 'updated_at', 'operation_deadline', 'expires_at'
  ];
  const currentPath = path.join(fixtureRoot, 'current.db');
  const current = new Database(currentPath);
  current.exec(`CREATE TABLE request_idempotency (${columns.map((name) => `${name} TEXT`).join(',')})`);
  current.prepare('INSERT INTO request_idempotency (state,scope) VALUES (?,?)')
    .run('processing', 'parser.knowledge-upload.admission');
  current.prepare('INSERT INTO request_idempotency (state,scope) VALUES (?,?)')
    .run('completed', 'parser.demand-parse.admission');
  current.close();
  const currentResult = runParserAdmissionProbe(probe, currentPath);
  assert.equal(currentResult.status, 0, currentResult.stderr);
  assert.equal(currentResult.stdout, '1');

  const malformedPath = path.join(fixtureRoot, 'malformed.db');
  const malformed = new Database(malformedPath);
  malformed.exec('CREATE TABLE request_idempotency (state TEXT, scope TEXT)');
  malformed.close();
  const malformedResult = runParserAdmissionProbe(probe, malformedPath);
  assert.notEqual(malformedResult.status, 0);
  assert.match(malformedResult.stderr, /Parser admission ledger schema is invalid/);
});

test('v0.6 durable acceptance binds the parser self-test and installed runtime identities', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  const acceptance = sourceBetween(
    cutover,
    'record_parser_acceptance_evidence() {',
    'stop_and_quiesce_writers() {',
    'parser acceptance function'
  );
  assertOrdered(acceptance, [
    'ParserRuntimeSha256="$(python3 - "$ParserSourceRoot/systemd/turingmarket-parser.manifest.json"',
    '"$ParserLifecycleProvisioner" verify',
    'ParserAcceptanceBinding="$(generate_installed_parser_acceptance_binding)"',
    'mv "$ParserAcceptedEvidence.next" "$ParserAcceptedEvidence"',
    'ParserEvidenceSha256="$(sha256sum "$ParserAcceptedEvidence"',
    'assert_installed_parser_acceptance_binding'
  ], 'parser acceptance binding');
  for (const field of ['parserEvidenceSha256', 'parserRuntimeSha256']) {
    assert.match(cutover, new RegExp(`'${field}': ${field}`));
  }
  assert.match(cutover, /'schemaVersion': 3/);
  assert.match(cutover, /ParserAcceptedEvidence="\$AcceptedEvidenceRoot\/parser-__RUN_ID__\.json"/);
  assert.match(cutover, /ParserRuntimeRoot="\/var\/lib\/turingmarket-parser\/runtime-root"/);
  assert.match(cutover, /"\$ParserLifecycleProvisioner" verify/);
  assert.match(cutover, /--build-evidence "\$ParserRuntimeEvidence"/);
  assert.doesNotMatch(cutover, /inspectParserRuntimeTree|TM_INSPECT_VERIFIER/);

  const acceptanceState = sourceBetween(
    deploy,
    'function Get-RemoteDeploymentAcceptanceState {',
    'function Get-ExactPublicNginxBehaviorVerifier {',
    'acceptance-state function'
  );
  assert.match(acceptanceState, /schemaVersion'\) != 4/);
  assert.match(acceptanceState, /accepted-\{runId\}\.json/);
  assert.match(acceptanceState, /Accepted deployment evidence does not bind parser acceptance/);
  assert.match(acceptanceState, /Parser accepted evidence SHA-256 is invalid/);
  assert.match(acceptanceState, /Installed parser runtime SHA-256 is invalid/);
  assert.match(acceptanceState, /Legacy current marker cannot authorize this generation/);

  const finalize = sourceBetween(
    deploy,
    'function Invoke-RemoteAcceptedFinalize {',
    'function Invoke-RemoteCandidateCleanup {',
    'accepted finalizer'
  );
  assert.match(finalize, /ParserAcceptedEvidence="\$RemoteRoot\/deployment-evidence\/parser-\$RunId\.json"/);
  assert.match(finalize, /Accepted deployment evidence does not bind parser acceptance/);
  assert.match(finalize, /root:root:600:1/);
  assert.match(finalize, /sha256sum "\$ParserAcceptedEvidence"/);
  assert.match(finalize, /"\$ParserLifecycleProvisioner" verify/);
  assert.match(finalize, /--build-evidence "\$ParserRuntimeEvidence"/);
  assert.doesNotMatch(finalize, /inspectParserRuntimeTree|TM_INSPECT_VERIFIER/);
  assert.match(finalize, /Current accepted marker does not bind parser acceptance/);
});

test('v0.6 replay evidence is hash-bound through current, lifecycle, recovery, and finalization markers', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  const currentMarker = sourceBetween(
    cutover,
    'install_current_accepted_marker() {',
    'assert_final_acceptance_facts() {',
    'current marker publication'
  );
  assert.match(currentMarker, /replayEvidenceSha256/);
  assert.match(currentMarker, /"\$ReplayEvidenceSha"/);
  const lifecycleMarker = sourceBetween(
    cutover,
    'python3 - \\\n  "$LockDir\/accepted.next"',
    'install_current_accepted_marker',
    'lifecycle accepted marker publication'
  );
  assert.match(lifecycleMarker, /replayEvidenceSha256/);
  assert.match(lifecycleMarker, /"\$ReplayEvidenceSha"/);

  const acceptanceState = sourceBetween(
    deploy,
    'function Get-RemoteDeploymentAcceptanceState {',
    'function Get-ExactPublicNginxBehaviorVerifier {',
    'acceptance-state function'
  );
  assert.match(acceptanceState, /replay-\{runId\}\.json/);
  assert.match(acceptanceState, /hashlib\.sha256\(replayEvidenceBytes\)\.hexdigest\(\) != replayEvidenceSha256/);

  const finalize = sourceBetween(
    deploy,
    'function Invoke-RemoteAcceptedFinalize {',
    'function Invoke-RemoteCandidateCleanup {',
    'accepted finalizer'
  );
  assert.match(finalize, /ReplayEvidence="\$RemoteRoot\/deployment-evidence\/replay-\$RunId\.json"/);
  assert.match(finalize, /sha256sum "\$ReplayEvidence"/);
  assert.match(finalize, /replayEvidenceSha256/);
});

test('v0.6 acceptance facts are canonical, root-only, and hash-bound through every authorization path', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  const capacity = sourceBetween(
    cutover,
    'assert_cutover_capacity() {',
    'writer_acquired=0',
    'cutover capacity function'
  );
  const health = sourceBetween(
    cutover,
    'verify_candidate_health() {',
    'record_parser_acceptance_evidence() {',
    'candidate health function'
  );
  const snapshot = sourceBetween(
    cutover,
    'create_cutover_snapshot() {',
    'archive_prior_current_marker() {',
    'cutover snapshot function'
  );
  const facts = sourceBetween(
    cutover,
    'record_acceptance_facts() {',
    'install_current_accepted_marker() {',
    'acceptance facts function'
  );
  const pm2Projection = sourceBetween(
    cutover,
    'project_pm2_acceptance() {',
    'record_acceptance_facts() {',
    'PM2 acceptance projection'
  );
  const finalAssertion = sourceBetween(
    cutover,
    'assert_final_acceptance_facts() {',
    'activate_public_candidate() {',
    'normal final acceptance assertion'
  );

  assert.match(cutover, /AcceptanceFacts="\$AcceptedEvidenceRoot\/acceptance-facts-__RUN_ID__\.json"/);
  assertOrdered(capacity, [
    'CapacityReport="$(',
    'CutoverCapacityJson=',
    "'tm-cutover-capacity-v1'",
    "json.dumps(report, sort_keys=True, separators=(',', ':'))"
  ], 'canonical cutover capacity retention');
  assert.match(health, /CandidateHealthProjection=/);
  assert.match(health, /manifest_sha256/);
  assert.match(health, /JSON\.stringify\(projection\)/);
  assert.match(snapshot, /CutoverSnapshotSha256SumsSha256=/);
  assert.match(snapshot, /sha256sum "\$CutoverSnapshot\/SHA256SUMS"/);

  assertOrdered(facts, [
    'test ! -e "$AcceptanceFacts"',
    'TM_CUTOVER_CAPACITY_JSON="$CutoverCapacityJson"',
    'TM_CANDIDATE_HEALTH_PROJECTION="$CandidateHealthProjection"',
    'TM_PM2_FINAL_PROJECTION=',
    "'schemaVersion': 1",
    "'cutoverCapacity': capacity",
    "'candidateHealth': health",
    "'cutoverSnapshotSha256SumsSha256': snapshotSha256",
    "'pm2': {'expected': pm2Expected, 'final': pm2Final}",
    "'nginx': {'expected': nginxExpected, 'final': nginxFinal}",
    'mv "$AcceptanceFacts.next" "$AcceptanceFacts"',
    'root:root:600:1',
    'AcceptanceFactsSha256="$(sha256sum "$AcceptanceFacts"'
  ], 'immutable acceptance facts publication');
  assert.match(facts, /forbiddenFields = \{'pid', 'pm_uptime', 'uptime'\}/);
  assert.match(pm2Projection, /name: application\.name/);
  assert.match(pm2Projection, /status: 'online'/);
  assert.match(pm2Projection, /pmExecPath:/);
  assert.match(pm2Projection, /pmCwd:/);
  assert.match(pm2Projection, /execMode:/);
  assert.match(pm2Projection, /instances:/);
  assert.match(pm2Projection, /env:/);
  assert.doesNotMatch(pm2Projection, /process\.pid|runtime\.pm_uptime|process\.uptime\s*\(/);
  assert.doesNotMatch(facts, /['"](?:pid|pm_uptime|uptime)['"]\s*:/);

  for (const field of [
    'candidateSha256',
    'parserEvidenceSha256',
    'parserRuntimeSha256',
    'acceptanceFactsSha256'
  ]) {
    assert.match(cutover, new RegExp(`'${field}': ${field}`));
  }
  assertOrdered(cutover, [
    'assert_cutover_capacity',
    'create_cutover_snapshot',
    'verify_candidate_health',
    'assert_staged_nginx_candidate_behavior',
    'record_parser_acceptance_evidence',
    'record_acceptance_facts',
    "'schemaVersion': 4",
    'install_current_accepted_marker',
    'activate_public_candidate',
    'assert_final_acceptance_facts'
  ], 'schema-v4 replay-and-facts-bound acceptance lifecycle');
  assert.match(finalAssertion, /sha256sum "\$AcceptanceFacts"/);
  assert.match(finalAssertion, /Cutover snapshot SHA256SUMS digest changed after acceptance/);
  assert.match(finalAssertion, /Acceptance facts final projection mismatch/);

  const acceptanceState = sourceBetween(
    deploy,
    'function Get-RemoteDeploymentAcceptanceState {',
    'function Get-ExactPublicNginxBehaviorVerifier {',
    'acceptance-state function'
  );
  assert.match(acceptanceState, /marker\.get\('schemaVersion'\) == 1/);
  assert.match(acceptanceState, /marker\.get\('schemaVersion'\) == 2/);
  assert.match(acceptanceState, /marker\.get\('schemaVersion'\) == 3/);
  assert.match(acceptanceState, /marker\.get\('schemaVersion'\) == 4/);
  assert.match(acceptanceState, /marker\.get\('schemaVersion'\) != 4/);
  assert.match(acceptanceState, /acceptance-facts-\{runId\}\.json/);
  assert.match(acceptanceState, /Acceptance facts SHA-256 is invalid/);
  assert.match(acceptanceState, /Acceptance facts schema is invalid/);

  const finalize = sourceBetween(
    deploy,
    'function Invoke-RemoteAcceptedFinalize {',
    'function Invoke-RemoteCandidateCleanup {',
    'accepted finalizer'
  );
  assert.match(finalize, /AcceptanceFacts="\$RemoteRoot\/deployment-evidence\/acceptance-facts-\$RunId\.json"/);
  assert.match(finalize, /marker\.get\('schemaVersion'\) != 4/);
  assert.match(finalize, /Acceptance facts SHA-256 is invalid/);
  assert.match(finalize, /Acceptance facts final projection mismatch/);
});

test('v0.6 rollback restores parser before code and process, and fails closed', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const restore = sourceBetween(
    deploy,
    'function Invoke-RemoteRestore {',
    'function Invoke-RemotePreMutationResume {',
    'remote restore function'
  );
  assertOrdered(restore, [
    'LockDir="$RemoteRoot/.deploy-v030.lock"',
    'ParserRollbackFailure="$LockDir/parser-rollback.failed"'
  ], 'rollback path initialization');
  assert.match(restore, /ParserSnapshot="\$RestoreUnit\/parser-appliance"/);
  assert.match(restore, /ParserRollbackProvisioner="\$ParserSnapshot\/provisioner\.file"/);
  assertOrdered(restore, [
    '(cd "$ParserSnapshot" && sha256sum --check --status SHA256SUMS)',
    '"$ParserRollbackProvisioner" rollback',
    '--snapshot-root "$ParserSnapshot"',
    'record_restore_step parser-restored',
    '# RESTORE_CODE',
    'record_restore_step code-restored',
    '# RESTORE_PROCESS',
    'pm2 restart ecosystem.config.js'
  ], 'coupled rollback');
  assert.match(restore, /parser-rollback\.failed/);
  assert.match(restore, /PARSER_ROLLBACK_FAILED/);
  assert.doesNotMatch(restore, /\$LiveDir\/server\/scripts\/provision_upload_sandbox_runtime\.sh/);
  const codeRestore = sourceBetween(
    restore,
    '# RESTORE_CODE',
    '# RESTORE_DATABASE_AND_PPT_CACHE',
    'code restore phase'
  );
  assert.match(codeRestore, /record_restore_step code-restored\s*$/);
  assert.match(restore, /TM_RESTORE_FAIL_AFTER_STEP/);

  const recovery = sourceBetween(
    deploy,
    'function Invoke-DeploymentFailureRecovery {',
    'function Invoke-InterruptedDeploymentRecovery {',
    'deployment recovery function'
  );
  assert.match(recovery, /for \(\$restoreAttempt = 1; \$restoreAttempt -le 3;/);
  assert.match(recovery, /retrying from the durable restore journal/);

  const manualRollback = sourceBetween(
    deploy,
    'function Invoke-ManualRollback {',
    'function Assert-AuthoritativeCheckout {',
    'manual rollback function'
  );
  assert.match(manualRollback, /Invoke-RemoteRestore -BackupPath \$BackupPath -RestoreDatabase/);
  assert.match(manualRollback, /retain the lock for operator recovery/);
});

test('v0.6 parser rollback failure marker is retryable and takeover-compatible', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const restore = sourceBetween(
    deploy,
    'function Invoke-RemoteRestore {',
    'function Invoke-RemotePreMutationResume {',
    'remote restore function'
  );
  assert.doesNotMatch(restore, /test ! -e "\$ParserRollbackFailure"/);
  assert.match(restore, /ExpectedParserRollbackFailure="PARSER_ROLLBACK_FAILED backup=\$BackupPath restore=\$ExpectedRestoreIdentity"/);
  assert.match(restore, /stat -c '%U:%G:%a:%h' "\$marker"/);
  assert.match(restore, /root:root:600:1/);
  assert.match(restore, /cat "\$marker"/);
  assertOrdered(restore, [
    '"$ParserRollbackProvisioner" rollback',
    'rm -f -- "$ParserRollbackFailure"',
    'record_restore_step parser-restored'
  ], 'retryable parser rollback marker cleanup');

  const takeover = sourceBetween(
    deploy,
    'function Enter-RemoteInterruptedDeploymentRecovery {',
    'function Get-RemoteDeploymentRunMetadata {',
    'deployment takeover function'
  );
  assert.match(takeover, /'parser-rollback\.failed'/);
  assert.match(takeover, /ParserRollbackFailure="\$LockDir\/parser-rollback\.failed"/);
  assert.match(takeover, /\$RootUid:\$RootUid:600:1/);
  assert.match(takeover, /ExpectedParserRollbackFailure="PARSER_ROLLBACK_FAILED backup=\$BackupPath restore=\$ExpectedRestoreIdentity"/);
  assert.match(takeover, /cat "\$marker"/);
  assert.match(takeover, /mutation-started\|release-replay-complete/);
});

test('v0.6 pre-mutation candidate failure cleans only the controlled candidate release', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const cleanup = sourceBetween(
    deploy,
    'function Invoke-RemoteCandidateCleanup {',
    'function Invoke-RemoteRetentionCleanup {',
    'candidate cleanup function'
  );
  assert.match(cleanup, /\.Replace\('__CANDIDATE_ROOT__', \$CANDIDATE_ROOT\)/);
  assert.match(cleanup, /rm -rf --one-file-system -- "\$ReleaseRoot"/);
  assert.doesNotMatch(cleanup, /\/var\/lib\/turingmarket-parser/);

  const recovery = sourceBetween(
    deploy,
    'function Invoke-DeploymentFailureRecovery {',
    'function Invoke-InterruptedDeploymentRecovery {',
    'deployment failure recovery function'
  );
  assert.match(recovery, /Candidate validation or cutover transport failed before production mutation; candidate cleanup only/);
  assert.match(recovery, /Invoke-RemoteCandidateCleanup -ReleaseRoot \$ReleaseRoot/);
});

test('v0.6 candidate inventory ships both root-level release records', () => {
  const rootFiles = powerShellArrayEntries(read('platform', 'deploy_v8.ps1'), 'ROOT_RELATIVE_FILES');
  for (const required of [
    'docs/version-records/2026-08-11-v0.6.0-crm-sales-workspace.md',
    'archive/versions/2026-08-11-v0.6.0-crm-sales-workspace.md'
  ]) {
    assert.equal(rootFiles.has(required), true, `${required} must ship with the isolated v0.6 candidate`);
  }
});

test('v0.6 ships a current runtime UI manifest while the frozen v0.2.9 evidence remains referenced', () => {
  assert.equal(fs.existsSync(currentUiManifestPath), true, 'current v0.6 UI runtime manifest must exist');
  const manifest = JSON.parse(fs.readFileSync(currentUiManifestPath, 'utf8'));
  const frozenBytes = fs.readFileSync(frozenUiManifestPath);
  const files = powerShellArrayEntries(read('platform', 'deploy_v8.ps1'), 'CANDIDATE_ONLY_FILES');

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.release, 'v0.6.0-crm-sales-workspace');
  assert.equal(manifest.buildMarkers.app, appBuild);
  assert.equal(manifest.scriptCacheKeys.app, appQuery);
  assert.equal(manifest.routeCount, 123);
  assert.equal(manifest.activeDefinitions.esc.globalIndex, 317);
  assert.equal(
    manifest.frozenVisualBaseline.sha256,
    require('node:crypto').createHash('sha256').update(frozenBytes).digest('hex')
  );
  assert.equal(files.has('docs/baselines/v0.6.0/ui-runtime-manifest.json'), true);
});

test('every production parser authorization uses the content-addressed trusted verifier', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const assignments = deploy.match(
    /ParserTrustedVerifier="\$TrustedSourceBundle\/server\/scripts\/trusted_parser_runtime_verifier\.js"/g
  ) || [];

  assert.ok(assignments.length >= 3, 'candidate preparation, cutover, and finalization need trusted-bundle verifier paths');
  assert.doesNotMatch(
    deploy,
    /ParserTrustedVerifier="\$(?:ParserSourceRoot|LockDir)\/[^"\r\n]*trusted_parser_runtime_verifier\.js"/
  );
  assert.match(deploy, /\/usr\/local\/libexec\/turingmarket\/production-source-trust\//);
});

test('install, cutover, recovery, and finalization require a fresh trusted parser acceptance binding', () => {
  const deploy = read('platform', 'deploy_v8.ps1');
  const provision = read('platform', 'server', 'scripts', 'provision_upload_sandbox_runtime.sh');
  const cutover = sourceBetween(
    deploy,
    '$cutoverGate = @\'',
    '$cutoverGate = $cutoverGate.Replace(',
    'cutover gate'
  );
  const finalizer = sourceBetween(
    deploy,
    'function Invoke-RemoteAcceptedFinalize {',
    'function Invoke-RemoteCandidateCleanup {',
    'accepted finalizer'
  );

  assert.match(provision, /bind-acceptance/);
  assert.match(cutover, /generate_installed_parser_acceptance_binding\(\)[\s\S]*"\$ParserLifecycleProvisioner" verify/);
  assert.match(cutover, /assert_installed_parser_acceptance_binding\(\)[\s\S]*generate_installed_parser_acceptance_binding/);
  assert.match(cutover, /record_parser_acceptance_evidence\(\)[\s\S]*assert_installed_parser_acceptance_binding/);
  assert.match(cutover, /activate_public_candidate\(\)[\s\S]*assert_installed_parser_acceptance_binding/);
  assert.match(finalizer, /"\$ParserLifecycleProvisioner" verify/);
  for (const source of [provision, cutover, finalizer]) {
    assert.match(source, /--expected-verifier-sha256/);
    assert.match(source, /--expected-manifest-sha256/);
    assert.match(source, /--build-evidence/);
  }
});
