'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const gitBash = process.env.GIT_BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe';
const nativeLinuxOnly = process.platform === 'linux'
  ? false
  : 'requires native Linux filesystem and syscall semantics';

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function shellPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
  if (!match) return filePath.replaceAll('\\', '/');
  return `/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function runBash(source) {
  const command = process.platform === 'win32' ? gitBash : 'bash';
  const args = ['--noprofile', '--norc'];
  if (process.env.TM_DEBUG_TEST_BASH === '1') args.push('-x');
  args.push('-s');
  const configuredPython = process.env.PYTHON3 || process.env.PYTHON_BIN;
  const prelude = process.platform === 'win32'
    ? [
      'PATH=/usr/bin:/bin:$PATH',
      'export PATH',
      configuredPython
        ? `python3() { ${shellQuote(shellPath(configuredPython))} "$@"; }`
        : ''
    ].filter(Boolean).join('\n') + '\n'
    : '';
  return spawnSync(command, args, {
    encoding: 'utf8',
    input: prelude + source,
    timeout: 20_000
  });
}

function fencedBlockAfter(source, heading, language = 'bash') {
  const headingIndex = source.indexOf(heading);
  assert.notEqual(headingIndex, -1, `missing runbook heading: ${heading}`);
  const fence = '```' + language;
  const fenceIndex = source.indexOf(fence, headingIndex + heading.length);
  assert.notEqual(fenceIndex, -1, `missing ${language} block after: ${heading}`);
  const contentStart = source.indexOf('\n', fenceIndex) + 1;
  const contentEnd = source.indexOf('\n```', contentStart);
  assert.ok(contentStart > 0 && contentEnd > contentStart, `unterminated block after: ${heading}`);
  return source.slice(contentStart, contentEnd).replaceAll('\r\n', '\n');
}

function runRunbookOperatorBlock(t, block, fixture, extraEnvironment = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-terminal-docs-'));
  const callLog = path.join(tempRoot, 'bootstrap-calls.log');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const assignments = Object.entries(extraEnvironment)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join('\n');
  const harness = `
BOOTSTRAP_CALL_LOG=${shellQuote(shellPath(callLog))}
BOOTSTRAP_FIXTURE=${shellQuote(fixture)}
${assignments}
bash() {
  printf '%s\n' call >> "$BOOTSTRAP_CALL_LOG"
  printf '%s\n' "$BOOTSTRAP_FIXTURE"
}
${block}
`;
  const result = runBash(harness);
  const calls = fs.existsSync(callLog)
    ? fs.readFileSync(callLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
    : 0;
  return { calls, result };
}

const bootstrapPath = path.join(platformRoot, 'server', 'scripts', 'bootstrap_production_runtime.sh');
const bootstrapShellPath = shellPath(bootstrapPath);

test('deployment browser stays separate from the frozen Playwright baseline', () => {
  const packageJson = JSON.parse(read('platform/package.json'));
  const lock = JSON.parse(read('platform/package-lock.json'));

  assert.equal(packageJson.dependencies.playwright, '1.60.0');
  assert.equal(packageJson.dependencies['playwright-deploy'], 'npm:playwright@1.61.1');
  assert.equal(lock.packages[''].dependencies.playwright, '1.60.0');
  assert.equal(lock.packages[''].dependencies['playwright-deploy'], 'npm:playwright@1.61.1');
  assert.equal(lock.packages['node_modules/playwright'].version, '1.60.0');
  assert.equal(lock.packages['node_modules/playwright-deploy'].version, '1.61.1');
});

test('deployment browser smoke keeps candidate code read-only and writes only Playwright artifacts', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const config = read('platform/server/tests/deployment-browser-smoke.config.js');
  const gateMatch = deploy.match(/<<'TM_UNPRIVILEGED_GATE'\r?\n([\s\S]*?)\r?\nTM_UNPRIVILEGED_GATE/);
  assert.ok(gateMatch, 'offline unprivileged gate must exist');
  const gate = gateMatch[1];

  assert.match(
    gate,
    /TM_DEPLOYMENT_SMOKE_ROOT="\$TEST_ROOT\/browser-smoke"[\s\\\r\n]*TM_DEPLOYMENT_SMOKE_PORT=43188/,
    'the release smoke must place writable state under the only writable candidate test root'
  );
  assert.match(config, /process\.env\.TM_DEPLOYMENT_SMOKE_ROOT/);
  assert.match(config, /outputDir:\s*path\.join\(smokeRoot,\s*'playwright-artifacts'\)/);
  assert.doesNotMatch(config, /outputDir:\s*path\.join\(repoRoot,\s*'\.superpowers'/);
  assert.match(
    config,
    /command:\s*'node server\/tests\/fixtures\/start_deployment_browser_smoke_server\.js'/
  );
  assert.doesNotMatch(config, /start_browser_fixture_server|TM_BROWSER_FIXTURE_ROOT/);

  const smokeServer = read('platform/server/tests/fixtures/start_deployment_browser_smoke_server.js');
  assert.match(smokeServer, /publicAssets\.registerPublicAssets\(app, express, platformRoot\)/);
  assert.match(smokeServer, /app\.get\('\/api\/health'/);
  assert.match(smokeServer, /app\.listen\(port,\s*'127\.0\.0\.1'/);
  assert.match(smokeServer, /!\['GET',\s*'HEAD'\]\.includes\(req\.method\)/);
  assert.doesNotMatch(smokeServer, /app\.get\('\*'/);
  assert.doesNotMatch(smokeServer, /DB_PATH|PPT_CACHE_DIR|UPLOAD_SANDBOX|child_process|node:fs/);
  assert.match(deploy, /"server\\tests\\fixtures\\start_deployment_browser_smoke_server\.js"/);
});

test('all production and deployment browser launches use the native sandboxed runtime', () => {
  const expectedTopLevelTestLaunchers = [
    'platform/server/tests/accessibility_shell.test.js',
    'platform/server/tests/ppt_bridge_browser_contract.test.js',
    'platform/server/tests/product_shell_contract.test.js',
    'platform/server/tests/production_browser_evidence_tools.test.js',
  ];
  const testsRoot = path.join(platformRoot, 'server', 'tests');
  const directLaunchMarker = ['chromium', 'launch('].join('.');
  const discoveredTopLevelTestLaunchers = fs.readdirSync(testsRoot)
    .filter((name) => name.endsWith('.test.js'))
    .filter((name) => fs.readFileSync(path.join(testsRoot, name), 'utf8').includes(directLaunchMarker))
    .map((name) => `platform/server/tests/${name}`)
    .sort();
  assert.deepEqual(discoveredTopLevelTestLaunchers, expectedTopLevelTestLaunchers);

  const directLaunchFiles = [
    ...expectedTopLevelTestLaunchers,
    'platform/server/scripts/capture_production_browser_baseline.js'
  ];
  for (const relativePath of directLaunchFiles) {
    const source = read(relativePath);
    assert.match(source, /require\(['"]playwright-deploy['"]\)/, relativePath);
    assert.match(source, /chromiumSandbox:\s*true/, relativePath);
  }

  const config = read('platform/server/tests/deployment-browser-smoke.config.js');
  assert.match(config, /require\(['"]playwright-deploy\/test['"]\)/);
  assert.match(config, /launchOptions:\s*\{\s*chromiumSandbox:\s*true\s*\}/);
});

test('runtime configuration supports release-external environment, database, upload, and temp paths', () => {
  const runtimeConfig = read('platform/server/config/runtime_config.js');
  const server = read('platform/server/server.js');
  const bootstrap = read('platform/server/scripts/bootstrap_production_runtime.sh');
  const ecosystem = read('platform/ecosystem.config.js');

  assert.match(runtimeConfig, /environment\.TM_ENV_FILE/);
  assert.match(server, /process\.env\.TMP_DIR/);
  assert.match(bootstrap, /UPLOAD_DIR="\$STATE_ROOT\/uploads"/);
  assert.match(bootstrap, /validate_exact_link "\$LIVE_DIR\/uploads" "\$UPLOAD_DIR"/);
  for (const marker of [
    'TM_ENV_FILE: "/etc/turingmarket/turingmarket.env"',
    'DB_PATH: "/var/lib/turingmarket/db/turingmarket.db"',
    'UPLOAD_DIR: "/var/lib/turingmarket/uploads"',
    'TMP_DIR: "/var/lib/turingmarket/tmp"',
    'PPT_CACHE_DIR: "/var/lib/turingmarket/ppt-cache"'
  ]) {
    assert.ok(ecosystem.includes(marker), marker);
  }
});

test('deployment runbook documents the explicit bootstrap terminal acknowledgement lifecycle', () => {
  const runbook = read('platform/DEPLOY.md');

  for (const marker of [
    'Bootstrap Terminal Acknowledgement / 引导终态确认',
    'BOOTSTRAP_OK',
    'BOOTSTRAP_TERMINAL_ID=t1:<sha256>',
    'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending',
    'bash /root/turingmarket/bootstrap_production_runtime.sh --ack-terminal "$TERMINAL_ID"',
    'BOOTSTRAP_TERMINAL_ACKNOWLEDGED=<id>',
    '普通 bootstrap 成功',
    '同一 ID 重复 ACK 为幂等，错误或过期 ID 均失败关闭',
    'pending 重跑不输出第二个 `BOOTSTRAP_OK`',
    '离线维护或回滚'
  ]) {
    assert.ok(runbook.includes(marker), marker);
  }

  assert.match(runbook, /journal is not cleared automatically/i);
  assert.match(runbook, /journal 不会自动清除/);
  assert.doesNotMatch(runbook, /journal is cleared only after/i);
  assert.match(runbook, /first-run output is captured exactly once/i);
  assert.match(runbook, /terminal-pending rerun returns the same terminal ID and terminal-pending outcome before the checked-in prohibited-mutation boundary/i);
  assert.match(runbook, /it does not emit BOOTSTRAP_OK/i);
  assert.doesNotMatch(runbook, /without business or host mutation|不执行任何业务或主机 mutation/i);
  assert.match(runbook, /verify runtime, exact links, SQLite, and marker evidence before ACK/i);
  assert.match(runbook, /if \(health\.status !== ['"]ok['"]\) process\.exit\(1\)/);
  assert.match(runbook, /repeating ACK with the same ID is idempotent; a wrong or stale ID fails closed/i);
  assert.match(runbook, /full capacity still allows the matching pending ACK in place/i);
  assert.match(runbook, /existing-live[\s\S]{0,400}recover[\s\S]{0,400}must not start a new generation/i);
  assert.match(runbook, /unknown, uncertain, or repair evidence[\s\S]{0,400}must not delete the journal[\s\S]{0,400}offline maintenance or rollback/i);

  const extraction = fencedBlockAfter(
    runbook,
    '#### Safe terminal ID extraction / 安全提取终态 ID'
  );
  assert.match(extraction, /BOOTSTRAP_OK_COUNT/);
  assert.match(extraction, /BOOTSTRAP_OUTCOME_COUNT/);
  assert.match(extraction, /BOOTSTRAP_ID_COUNT/);
  assert.ok(extraction.includes('^BOOTSTRAP_TERMINAL_ID=t1:[0-9a-f]{64}$'));
  assert.doesNotMatch(extraction, /\beval\b|\btee\b|\blogger\b|set -x/);
  assert.match(runbook, /do not write credentials to logs/i);
});

test('deployment runbook discloses bounded mount-guard housekeeping during marker evidence validation', () => {
  const runbook = read('platform/DEPLOY.md');
  const heading = '#### Evidence gate / 证据门禁';
  const sectionStart = runbook.indexOf(heading);
  const sectionEnd = runbook.indexOf(
    '#### Pending rerun verification / pending 重跑核验',
    sectionStart
  );

  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, 'evidence section is missing');
  const evidenceSection = runbook.slice(sectionStart, sectionEnd);
  assert.doesNotMatch(evidenceSection, /\bread-only gate\b|以下只读门禁/i);
  assert.match(
    evidenceSection,
    /bounded[\s\S]{0,120}root-owned[\s\S]{0,160}\/root\/turingmarket\/\.external-runtime-root-mount-guard-v1\.<boot-id>/i
  );
  assert.match(
    evidenceSection,
    /current Linux boot[\s\S]{0,240}does not mutate business data or the runtime layout/i
  );
  assert.match(
    evidenceSection,
    /有界[\s\S]{0,120}root 所有[\s\S]{0,160}\/root\/turingmarket\/\.external-runtime-root-mount-guard-v1\.<boot-id>/
  );
  assert.match(
    evidenceSection,
    /当前 Linux 启动[\s\S]{0,240}不会修改业务数据或运行时布局/
  );
  assert.match(
    evidenceSection,
    /`validate_external_layout_marker`[\s\S]{0,240}`bind_external_layout_root`/
  );

  const evidenceBlock = fencedBlockAfter(runbook, heading);
  assert.match(evidenceBlock, /^validate_current_release_health$/m);
  assert.match(evidenceBlock, /^validate_loopback_firewall$/m);
  assert.match(evidenceBlock, /reserve_migration_journal_capacity "\$TERMINAL_ID"/);
  assert.match(evidenceBlock, /discover_migration_journal "\$TERMINAL_ID"/);
  assert.match(evidenceBlock, /\[ "\$JOURNAL_TERMINAL_STATE" = terminal-pending \]/);
  assert.match(evidenceBlock, /\[ "\$JOURNAL_TERMINAL_ID" = "\$TERMINAL_ID" \]/);
  assert.match(evidenceBlock, /^validate_terminal_journal_marker_provenance$/m);
  assert.match(evidenceBlock, /^release_migration_journal_capacity_reservation$/m);
  assert.match(evidenceBlock, /^validate_external_layout_marker$/m);
});

test('deployment runbook captures the first bootstrap once and makes every parser fail closed', () => {
  const runbook = read('platform/DEPLOY.md');
  const ackHeading = '### Bootstrap Terminal Acknowledgement / 引导终态确认';
  const ackIndex = runbook.indexOf(ackHeading);
  assert.notEqual(ackIndex, -1);
  const transferStart = runbook.lastIndexOf('```powershell', ackIndex);
  assert.notEqual(transferStart, -1);
  const transfer = runbook.slice(transferStart, ackIndex);
  assert.match(transfer, /\bscp\b/);
  assert.doesNotMatch(
    transfer,
    /\bssh\b[^\n]*bash \/root\/turingmarket\/bootstrap_production_runtime\.sh/
  );

  const firstRun = fencedBlockAfter(
    runbook,
    '#### Safe terminal ID extraction / 安全提取终态 ID'
  );
  const evidence = fencedBlockAfter(
    runbook,
    '#### Evidence gate / 证据门禁'
  );
  const pendingRerun = fencedBlockAfter(
    runbook,
    '#### Pending rerun verification / pending 重跑核验'
  );
  const explicitAck = fencedBlockAfter(
    runbook,
    '#### Explicit ACK / 显式 ACK'
  );
  for (const block of [firstRun, evidence, pendingRerun, explicitAck]) {
    assert.match(block, /^set -euo pipefail\n/);
  }

  assert.equal((firstRun.match(/bash "\$BOOTSTRAP_SCRIPT"/g) || []).length, 1);
  assert.equal((pendingRerun.match(/bash "\$BOOTSTRAP_SCRIPT"/g) || []).length, 1);
  assert.match(explicitAck, /--ack-terminal "\$TERMINAL_ID"/);

  const ackSectionEnd = runbook.indexOf('The resulting mutable paths', ackIndex);
  const ackSection = runbook.slice(ackIndex, ackSectionEnd);
  const parserBlocks = [...ackSection.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)]
    .map((match) => match[1].replaceAll('\r\n', '\n'))
    .filter((block) => /\b(?:grep|sed|awk|mapfile)\b|while IFS=/.test(block));
  assert.ok(parserBlocks.length >= 2, 'first-run and pending-rerun parsers must be present');
  for (const block of parserBlocks) {
    assert.match(block, /^set -euo pipefail\n/, 'parser or grep runs without fail-closed shell mode');
  }

  const parseIndex = firstRun.indexOf(
    'TERMINAL_ID="${BOOTSTRAP_ID_RECORD#BOOTSTRAP_TERMINAL_ID=}"'
  );
  assert.ok(parseIndex > 0, 'terminal ID parsing must be explicit');
  for (const guard of [
    'if [ "$BOOTSTRAP_OUTCOME_COUNT" -ne 1 ]',
    'if [ "$BOOTSTRAP_ID_COUNT" -ne 1 ]'
  ]) {
    const guardIndex = firstRun.indexOf(guard);
    assert.ok(guardIndex >= 0 && guardIndex < parseIndex, `missing pre-parse guard: ${guard}`);
  }
  const protocolIndex = firstRun.indexOf('BOOTSTRAP_PROTOCOL=');
  assert.ok(protocolIndex >= 0 && protocolIndex < parseIndex, 'success protocol must be selected before ID parsing');
  assert.match(firstRun, /BOOTSTRAP_PROTOCOL=normal/);
  assert.match(firstRun, /BOOTSTRAP_PROTOCOL=committed-recovery/);
});

test('deployment runbook first-run validator rejects every incomplete or ambiguous terminal record set', async (t) => {
  const runbook = read('platform/DEPLOY.md');
  const block = fencedBlockAfter(
    runbook,
    '#### Safe terminal ID extraction / 安全提取终态 ID'
  );
  const terminalId = `t1:${'a'.repeat(64)}`;
  const ok = 'BOOTSTRAP_OK';
  const id = `BOOTSTRAP_TERMINAL_ID=${terminalId}`;
  const outcome = 'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending';
  const valid = [ok, id, outcome].join('\n');
  const validRun = runRunbookOperatorBlock(t, block, valid);

  assert.equal(validRun.result.status, 0, `${validRun.result.stdout}\n${validRun.result.stderr}`);
  assert.equal(validRun.calls, 1);
  assert.match(validRun.result.stdout, new RegExp(`^TERMINAL_ID=${terminalId}$`, 'm'));

  const recoveryOk = 'BOOTSTRAP_RECOVERY_COMMIT_OK';
  const recoveryOutcome = 'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=committed-recovered';
  const recoveryValid = [id, recoveryOk, recoveryOutcome].join('\n');
  const recoveryRun = runRunbookOperatorBlock(t, block, recoveryValid);
  assert.equal(
    recoveryRun.result.status,
    0,
    `${recoveryRun.result.stdout}\n${recoveryRun.result.stderr}`
  );
  assert.equal(recoveryRun.calls, 1);
  assert.match(recoveryRun.result.stdout, new RegExp(`^TERMINAL_ID=${terminalId}$`, 'm'));

  const invalidCases = [
    ['missing BOOTSTRAP_OK', [id, outcome]],
    ['duplicate BOOTSTRAP_OK', [ok, ok, id, outcome]],
    ['malformed BOOTSTRAP_OK', ['BOOTSTRAP_OK=yes', id, outcome]],
    ['missing terminal outcome', [ok, id]],
    ['duplicate terminal outcome', [ok, id, outcome, outcome]],
    ['malformed terminal outcome', [ok, id, 'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=commit-complete']],
    ['missing terminal ID', [ok, outcome]],
    ['duplicate terminal ID', [ok, id, id, outcome]],
    ['malformed terminal ID', [ok, `BOOTSTRAP_TERMINAL_ID=t1:${'g'.repeat(64)}`, outcome]]
  ];
  for (const [name, lines] of invalidCases) {
    await t.test(name, (subtest) => {
      const execution = runRunbookOperatorBlock(subtest, block, lines.join('\n'));
      assert.notEqual(
        execution.result.status,
        0,
        `${name} was accepted\n${execution.result.stdout}\n${execution.result.stderr}`
      );
      assert.equal(execution.calls, 1, `${name} invoked bootstrap more than once`);
      assert.doesNotMatch(execution.result.stdout, /^TERMINAL_ID=/m);
    });
  }

  const invalidRecoveryCases = [
    ['recovery missing recovery record', [id, recoveryOutcome]],
    ['recovery mixed with normal outcome', [recoveryOk, id, outcome]],
    ['recovery mixed with BOOTSTRAP_OK', [ok, recoveryOk, id, recoveryOutcome]],
    ['duplicate recovery record', [recoveryOk, recoveryOk, id, recoveryOutcome]]
  ];
  for (const [name, lines] of invalidRecoveryCases) {
    await t.test(name, (subtest) => {
      const execution = runRunbookOperatorBlock(subtest, block, lines.join('\n'));
      assert.notEqual(
        execution.result.status,
        0,
        `${name} was accepted\n${execution.result.stdout}\n${execution.result.stderr}`
      );
      assert.equal(execution.calls, 1, `${name} invoked bootstrap more than once`);
      assert.doesNotMatch(execution.result.stdout, /^TERMINAL_ID=/m);
    });
  }
});

test('deployment runbook pending rerun requires the same pending ID and rejects BOOTSTRAP_OK', async (t) => {
  const runbook = read('platform/DEPLOY.md');
  const block = fencedBlockAfter(
    runbook,
    '#### Pending rerun verification / pending 重跑核验'
  );
  const terminalId = `t1:${'b'.repeat(64)}`;
  const id = `BOOTSTRAP_TERMINAL_ID=${terminalId}`;
  const outcome = 'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending';
  const environment = {
    BOOTSTRAP_SCRIPT: '/root/turingmarket/bootstrap_production_runtime.sh',
    TERMINAL_ID: terminalId
  };
  const validRun = runRunbookOperatorBlock(t, block, [id, outcome].join('\n'), environment);

  assert.equal(validRun.result.status, 0, `${validRun.result.stdout}\n${validRun.result.stderr}`);
  assert.equal(validRun.calls, 1);
  assert.doesNotMatch(validRun.result.stdout, /^BOOTSTRAP_OK$/m);

  const invalidCases = [
    ['unexpected BOOTSTRAP_OK', ['BOOTSTRAP_OK', id, outcome]],
    ['unexpected recovery success', ['BOOTSTRAP_RECOVERY_COMMIT_OK', id, outcome]],
    ['missing terminal ID', [outcome]],
    ['different terminal ID', [`BOOTSTRAP_TERMINAL_ID=t1:${'c'.repeat(64)}`, outcome]],
    ['duplicate terminal ID', [id, id, outcome]],
    ['missing terminal outcome', [id]],
    ['duplicate terminal outcome', [id, outcome, outcome]],
    ['malformed terminal outcome', [id, 'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=commit-complete']]
  ];
  for (const [name, lines] of invalidCases) {
    await t.test(name, (subtest) => {
      const execution = runRunbookOperatorBlock(
        subtest,
        block,
        lines.join('\n'),
        environment
      );
      assert.notEqual(
        execution.result.status,
        0,
        `${name} was accepted\n${execution.result.stdout}\n${execution.result.stderr}`
      );
      assert.equal(execution.calls, 1);
    });
  }
});

test('PM2 production runtime binds the application listener to IPv4 loopback', () => {
  const ecosystemPath = path.join(platformRoot, 'ecosystem.config.js');
  delete require.cache[require.resolve(ecosystemPath)];
  const ecosystem = require(ecosystemPath);

  assert.equal(ecosystem.apps.length, 1);
  assert.equal(ecosystem.apps[0].name, 'turingmarket');
  assert.equal(ecosystem.apps[0].env.PORT, '3002');
  assert.equal(ecosystem.apps[0].env.SERVER_HOST, '127.0.0.1');
});

test('loopback firewall installation is persistent, exact, and a no-op on rerun', { skip: nativeLinuxOnly }, () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_REMOTE_ROOT="$root/remote"
export TM_ENV_DIR="$root/etc-turingmarket"
export TM_SYSTEMD_UNIT_DIR="$root/systemd"
export TM_LOCAL_SBIN_DIR="$root/sbin"
export TM_NFT_BIN="$root/bin/nft"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
export FAKE_NFT_STATE="$root/nft-state.json"
export FAKE_NFT_LOG="$root/nft.log"
mkdir -p "$root/bin"
cat > "$TM_NFT_BIN" <<'NFT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_NFT_LOG"
if [ "$1" = "--check" ] && [ "$2" = "-f" ]; then
  grep -Fxq 'destroy table inet turingmarket_loopback' "$3"
  test "$(grep -c 'tcp dport 3002' "$3")" = 1
  exit 0
fi
if [ "$1" = "-f" ]; then
  cat > "$FAKE_NFT_STATE" <<'JSON'
{"nftables":[{"metainfo":{"json_schema_version":1}},{"table":{"family":"inet","name":"turingmarket_loopback","handle":7}},{"chain":{"family":"inet","table":"turingmarket_loopback","name":"input","handle":8,"type":"filter","hook":"input","prio":-10,"policy":"accept"}},{"rule":{"family":"inet","table":"turingmarket_loopback","chain":"input","handle":9,"expr":[{"match":{"op":"!=","left":{"meta":{"key":"iifname"}},"right":"lo"}},{"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":3002}},{"reject":{"type":"tcp reset"}}],"comment":"turingmarket-loopback-only-3002"}}]}
JSON
  exit 0
fi
if [ "$1" = "-j" ] && [ "$2" = "list" ]; then
  test -f "$FAKE_NFT_STATE"
  cat "$FAKE_NFT_STATE"
  exit 0
fi
if [ "$1" = "list" ]; then
  test -f "$FAKE_NFT_STATE"
  exit 0
fi
if [ "$1" = "delete" ]; then
  rm -f "$FAKE_NFT_STATE"
  exit 0
fi
exit 64
NFT
chmod 0755 "$TM_NFT_BIN"

export TM_LIVE_DIR="$root/live"
mkdir -p "$TM_LIVE_DIR"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

systemctl() {
  printf '%s\n' "$*" >> "$root/systemctl.log"
  case "$1" in
    daemon-reload) return 0 ;;
    is-enabled) test -f "$root/enabled" ;;
    is-active) test -f "$root/active" ;;
    enable) : > "$root/enabled" ;;
    disable) rm -f "$root/enabled" ;;
    start|restart) : > "$root/active" ;;
    stop) rm -f "$root/active" ;;
    *) return 65 ;;
  esac
}

ss() { :; }

BACKUP_DIR="$root/backup-one"
mkdir -p "$BACKUP_DIR"
install_loopback_firewall
validate_loopback_firewall
cp "$FAKE_NFT_STATE" "$root/valid-nft-state.json"
sed -i 's/"right":"lo"/"right":"eth0"/' "$FAKE_NFT_STATE"
if validate_loopback_firewall; then exit 91; fi
cp "$root/valid-nft-state.json" "$FAKE_NFT_STATE"
sed -i 's/"right":3002/"right":3003/' "$FAKE_NFT_STATE"
if validate_loopback_firewall; then exit 92; fi
cp "$root/valid-nft-state.json" "$FAKE_NFT_STATE"
test -f "$root/enabled"
test -f "$root/active"
test "$(stat -c '%a' "$FIREWALL_RULE_FILE")" = 600
test "$(stat -c '%a' "$FIREWALL_HELPER")" = 700
test "$(stat -c '%a' "$FIREWALL_SERVICE_FILE")" = 644
test "$(stat -c '%a' "$PM2_FIREWALL_DROPIN_FILE")" = 644
grep -Fxq 'destroy table inet turingmarket_loopback' "$FIREWALL_RULE_FILE"
test "$(grep -c 'tcp dport 3002' "$FIREWALL_RULE_FILE")" = 1
grep -Fxq "ExecStart=$FIREWALL_HELPER apply" "$FIREWALL_SERVICE_FILE"
grep -Fxq 'Before=pm2-root.service' "$FIREWALL_SERVICE_FILE"
grep -Fxq 'Requires=turingmarket-loopback-firewall.service' "$PM2_FIREWALL_DROPIN_FILE"
grep -Fxq 'After=turingmarket-loopback-firewall.service' "$PM2_FIREWALL_DROPIN_FILE"
first_digest="$(sha256sum "$FIREWALL_RULE_FILE" "$FIREWALL_HELPER" "$FIREWALL_SERVICE_FILE" "$PM2_FIREWALL_DROPIN_FILE")"
first_apply_count="$(grep -c '^-f ' "$FAKE_NFT_LOG")"

BACKUP_DIR="$root/backup-two"
mkdir -p "$BACKUP_DIR"
install_loopback_firewall
validate_loopback_firewall
second_digest="$(sha256sum "$FIREWALL_RULE_FILE" "$FIREWALL_HELPER" "$FIREWALL_SERVICE_FILE" "$PM2_FIREWALL_DROPIN_FILE")"
second_apply_count="$(grep -c '^-f ' "$FAKE_NFT_LOG")"
test "$first_digest" = "$second_digest"
test "$first_apply_count" = 1
test "$second_apply_count" = 1
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('failed loopback firewall installation restores every prior artifact and rule state', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_REMOTE_ROOT="$root/remote"
export TM_ENV_DIR="$root/etc-turingmarket"
export TM_SYSTEMD_UNIT_DIR="$root/systemd"
export TM_LOCAL_SBIN_DIR="$root/sbin"
export TM_NFT_BIN="$root/bin/nft"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
export FAKE_NFT_STATE="$root/nft-state.json"
mkdir -p "$root/bin"
cat > "$TM_NFT_BIN" <<'NFT'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--check" ]; then exit 0; fi
if [ "$1" = "-f" ]; then printf 'managed\n' > "$FAKE_NFT_STATE"; exit 0; fi
if [ "$1" = "-j" ]; then test -f "$FAKE_NFT_STATE"; printf '{malformed'; exit 0; fi
if [ "$1" = "list" ]; then test -f "$FAKE_NFT_STATE"; exit 0; fi
if [ "$1" = "delete" ]; then rm -f "$FAKE_NFT_STATE"; exit 0; fi
exit 64
NFT
chmod 0755 "$TM_NFT_BIN"
export TM_LIVE_DIR="$root/live"
mkdir -p "$TM_LIVE_DIR"
source ${shellQuote(bootstrapShellPath)}

mkdir -p "$(dirname "$FIREWALL_RULE_FILE")" "$(dirname "$FIREWALL_HELPER")" "$(dirname "$FIREWALL_SERVICE_FILE")" "$(dirname "$PM2_FIREWALL_DROPIN_FILE")"
printf 'legacy-rule\n' > "$FIREWALL_RULE_FILE"
printf 'legacy-helper\n' > "$FIREWALL_HELPER"
printf 'legacy-service\n' > "$FIREWALL_SERVICE_FILE"
printf 'legacy-dropin\n' > "$PM2_FIREWALL_DROPIN_FILE"

systemctl() {
  case "$1" in
    daemon-reload|disable|stop) return 0 ;;
    is-enabled|is-active) return 1 ;;
    enable) return 0 ;;
    start) return 73 ;;
    *) return 65 ;;
  esac
}

BACKUP_DIR="$root/backup"
mkdir -p "$BACKUP_DIR"
if install_loopback_firewall; then exit 90; fi
test "$(cat "$FIREWALL_RULE_FILE")" = legacy-rule
test "$(cat "$FIREWALL_HELPER")" = legacy-helper
test "$(cat "$FIREWALL_SERVICE_FILE")" = legacy-service
test "$(cat "$PM2_FIREWALL_DROPIN_FILE")" = legacy-dropin
test ! -e "$FAKE_NFT_STATE"
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('firewall installation aborts before mutation when the prior-state snapshot cannot be copied', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

NFT_BIN=/bin/false
copy_existing_path() { printf 'copy\n' >> "$root/calls"; return 55; }
systemctl() {
  case "$1" in
    is-enabled|is-active) return 1 ;;
    *) return 0 ;;
  esac
}

if snapshot_loopback_firewall_installation "$root/prior"; then exit 90; fi
test "$(wc -l < "$root/calls")" = 1
test ! -e "$root/prior/unit.enabled"
test ! -e "$root/prior/unit.disabled"
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('listener validation accepts exactly one IPv4 loopback socket and rejects every broader binding', () => {
  const source = `
set -euo pipefail
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}
listener=$'LISTEN 0 511 127.0.0.1:3002 0.0.0.0:* users:(("node",pid=4321,fd=20))'
listener_with_spaced_process=$'LISTEN 0 511 127.0.0.1:3002 0.0.0.0:* users:(("node /root/turi",pid=4321,fd=20))'
duplicate_listeners="$listener"$'\n'"$listener"
validate_loopback_listener_output "$listener" 4321
validate_loopback_listener_output "$listener_with_spaced_process" 4321
! validate_loopback_listener_output '' 4321
! validate_loopback_listener_output $'LISTEN 0 511 0.0.0.0:3002 0.0.0.0:* users:(("node",pid=4321,fd=20))' 4321
! validate_loopback_listener_output $'LISTEN 0 511 [::1]:3002 [::]:* users:(("node",pid=4321,fd=20))' 4321
! validate_loopback_listener_output "$listener" 9876
! validate_loopback_listener_output $'LISTEN 0 511 127.0.0.1:3002 0.0.0.0:*' 4321
! validate_loopback_listener_output $'LISTEN 0 511 127.0.0.1:3002 0.0.0.0:* users:(("node /root/turi",pid=4321,fd=20)) EXTRA' 4321
! validate_loopback_listener_output "$duplicate_listeners" 4321
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('runtime restart fails closed before start on firewall drift and stops a broad listener', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_LIVE_DIR="$root/live"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
mkdir -p "$TM_LIVE_DIR"
source ${shellQuote(bootstrapShellPath)}

pm2() { printf '%s\n' "$*" >> "$root/pm2.log"; return 0; }
curl() { return 0; }
sleep() { :; }
validate_loopback_firewall() { return 1; }
if restart_current_release; then exit 90; fi
test "$(cat "$root/pm2.log")" = 'stop turingmarket'

: > "$root/pm2.log"
validate_loopback_firewall() { return 0; }
validate_loopback_listener() { return 1; }
if restart_current_release; then exit 91; fi
grep -Fxq 'restart ecosystem.config.js --only turingmarket --update-env' "$root/pm2.log"
test "$(tail -n 1 "$root/pm2.log")" = 'stop turingmarket'
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('runtime health snapshots admit only a healthy app or a fully stopped port 3002', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

mode=healthy
curl() {
  if [ "$mode" = healthy ]; then printf '{"ok":true}\n'; return 0; fi
  return 22
}
ss() {
  case "$mode" in
    stopped) return 0 ;;
    broad) printf 'LISTEN 0 511 0.0.0.0:3002 0.0.0.0:*\n' ;;
    *) return 70 ;;
  esac
}

snapshot_runtime_health "$root/healthy.json" 0
test "$(cat "$root/healthy.json")" = '{"ok":true}'
mode=stopped
snapshot_runtime_health "$root/stopped.json" 1
test "$(cat "$root/stopped.json")" = '{"status":"stopped","isolation":"no-port-3002-listener"}'
if snapshot_runtime_health "$root/stopped-after.json" 0; then exit 91; fi
test ! -e "$root/stopped-after.json"
mode=broad
if snapshot_runtime_health "$root/broad.json" 1; then exit 90; fi
test ! -e "$root/broad.json"
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('firewall recovery retries in a separate audit directory without mutating the migration backup', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_REMOTE_ROOT="$root/remote"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

migration_backup="$BACKUP_ROOT/v030-runtime-bootstrap-source"
mkdir -p "$migration_backup"
printf 'sealed\n' > "$migration_backup/SHA256SUMS"
original_backup="$root/original-backup"
BACKUP_DIR="$original_backup"
install_loopback_firewall() { printf '%s\n' "$BACKUP_DIR" > "$root/recovery-path"; }
install_loopback_firewall_for_recovery "$migration_backup"

test "$BACKUP_DIR" = "$original_backup"
test "$(cat "$migration_backup/SHA256SUMS")" = sealed
test "$(cat "$root/recovery-path")" = "$BACKUP_ROOT/v030-runtime-firewall-recovery-$STAMP"
test ! -e "$migration_backup/loopback-firewall-recovery-$STAMP"
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('bootstrap installs isolation while PM2 is stopped and validates it before every restart', () => {
  const source = fs.readFileSync(bootstrapPath, 'utf8');
  const migrationStart = source.indexOf('\nbootstrap_run_new_migration() {');
  const mainStart = source.indexOf('\nbootstrap_production_main() {');
  assert.ok(migrationStart !== -1 && mainStart > migrationStart, 'migration function must precede main');
  const migration = source.slice(migrationStart, mainStart);

  assert.match(source, /BROWSER_PACKAGES=\([\s\S]*?\bnftables\b[\s\S]*?\)/);
  assert.match(migration, /apt-get install[\s\S]*?"\$\{BROWSER_PACKAGES\[@\]\}"/);
  assert.match(migration, /stop_current_release[\s\S]*?install_loopback_firewall[\s\S]*?restart_current_release/);
  assert.match(source, /snapshot_host\(\)[\s\S]*?snapshot_runtime_health/);
  assert.match(source, /restart_current_release\(\)[\s\S]*?validate_loopback_firewall[\s\S]*?pm2 (?:restart|start)/);
  assert.match(source, /restart_current_release\(\)[\s\S]*?validate_current_release_health[\s\S]*?pm2 stop turingmarket/);
  assert.match(source, /validate_current_release_health\(\)[\s\S]*?validate_loopback_listener/);
});

test('runtime bootstrap is audited, reversible, and keeps mutable state outside releases', () => {
  assert.equal(fs.existsSync(bootstrapPath), true);
  const source = fs.readFileSync(bootstrapPath, 'utf8');

  for (const marker of [
    'turingmarket-gate',
    '/usr/sbin/nologin',
    'apt-get install -s',
    '--no-install-recommends',
    '/etc/turingmarket/turingmarket.env',
    '/var/lib/turingmarket/db',
    '/var/lib/turingmarket/uploads',
    '/var/lib/turingmarket/tmp',
    'server/db',
    'userns,',
    'pm2 stop turingmarket',
    'BOOTSTRAP_ROLLBACK_OK',
    'DB_QUICK_CHECK=ok'
  ]) {
    assert.ok(source.includes(marker), marker);
  }
  assert.match(source, /ID[^\n]+ubuntu[\s\S]*VERSION_ID[^\n]+26\.04/);
  assert.match(source, /dpkg-query[\s\S]*apt-mark[\s\S]*SHA256SUMS/);
  assert.match(source, /ln -s[^\n]+\/etc\/turingmarket\/turingmarket\.env[^\n]+\.env/);
  assert.match(source, /ln -s[^\n]+\/var\/lib\/turingmarket\/db[^\n]+server\/db/);
  assert.match(source, /deploy-v\*-gate-\*\/browser-cache\/chromium_headless_shell-\*/);
  assert.doesNotMatch(source, /deploy-v030-gate-/);
  assert.match(source, /apparmor_parser -Q "\$candidate"/);
  assert.match(source, /install -o root -g root -m 0644 "\$candidate" "\$APPARMOR_PROFILE"/);
  assert.doesNotMatch(source, /PLAYWRIGHT_HOST_PLATFORM_OVERRIDE/);
  assert.doesNotMatch(source, /(?:tvly|sk)-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
});

test('AppArmor profile installation validates, backs up, and reruns idempotently', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_REMOTE_ROOT="$root/remote"
export TM_APPARMOR_PROFILE="$root/etc/turingmarket-gate-chromium"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

install() {
  local source="\${@: -2:1}"
  local target="\${@: -1}"
  cp -- "$source" "$target"
  chmod 0644 "$target"
}
apparmor_parser() {
  printf '%s\n' "$*" >> "$root/parser.log"
  if [ "$1" = "-Q" ]; then grep -Fq 'deploy-v*-gate-*' "$2"; fi
}

mkdir -p "$(dirname "$APPARMOR_PROFILE")"
printf 'legacy-profile\n' > "$APPARMOR_PROFILE"
BACKUP_DIR="$root/backup-one"
mkdir -p "$BACKUP_DIR"
install_apparmor_profile
grep -Fq 'deploy-v*-gate-*' "$APPARMOR_PROFILE"
test "$(cat "$BACKUP_DIR/turingmarket-gate-chromium.previous")" = legacy-profile
first_hash="$(sha256sum "$APPARMOR_PROFILE" | awk '{print $1}')"

BACKUP_DIR="$root/backup-two"
mkdir -p "$BACKUP_DIR"
install_apparmor_profile
second_hash="$(sha256sum "$APPARMOR_PROFILE" | awk '{print $1}')"
test "$first_hash" = "$second_hash"
test "$(grep -c '^-Q ' "$root/parser.log")" = 2
test "$(grep -c '^-r ' "$root/parser.log")" = 2
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('AppArmor reload failure restores an existing profile and removes a first install', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_REMOTE_ROOT="$root/remote"
export TM_APPARMOR_PROFILE="$root/etc/turingmarket-gate-chromium"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

install() {
  local source="\${@: -2:1}"
  local target="\${@: -1}"
  cp -- "$source" "$target"
  chmod 0644 "$target"
}
reload_count=0
apparmor_parser() {
  if [ "$1" = "-Q" ]; then return 0; fi
  reload_count=$((reload_count + 1))
  if [ "$reload_count" = 1 ]; then return 1; fi
}

mkdir -p "$(dirname "$APPARMOR_PROFILE")"
printf 'legacy-profile\n' > "$APPARMOR_PROFILE"
BACKUP_DIR="$root/backup-existing"
mkdir -p "$BACKUP_DIR"
if install_apparmor_profile; then exit 90; fi
test "$(cat "$APPARMOR_PROFILE")" = legacy-profile
test "$reload_count" = 2

rm -f "$APPARMOR_PROFILE"
reload_count=0
BACKUP_DIR="$root/backup-first"
mkdir -p "$BACKUP_DIR"
if install_apparmor_profile; then exit 91; fi
test ! -e "$APPARMOR_PROFILE"
test "$reload_count" = 1
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('AppArmor syntax failure leaves existing state unchanged', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_REMOTE_ROOT="$root/remote"
export TM_APPARMOR_PROFILE="$root/etc/turingmarket-gate-chromium"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

install() {
  local source="\${@: -2:1}"
  local target="\${@: -1}"
  cp -- "$source" "$target"
  chmod 0644 "$target"
}
syntax_failure=1
apparmor_parser() {
  if [ "$1" = "-Q" ] && [ "$syntax_failure" = 1 ]; then return 1; fi
}

mkdir -p "$(dirname "$APPARMOR_PROFILE")"
printf 'legacy-profile\n' > "$APPARMOR_PROFILE"
BACKUP_DIR="$root/backup-syntax"
mkdir -p "$BACKUP_DIR"
if install_apparmor_profile; then exit 92; fi
test "$(cat "$APPARMOR_PROFILE")" = legacy-profile
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('AppArmor rejects an unsafe profile symlink without mutating its target', { skip: nativeLinuxOnly }, () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_REMOTE_ROOT="$root/remote"
export TM_APPARMOR_PROFILE="$root/etc/turingmarket-gate-chromium"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

install() {
  local source="\${@: -2:1}"
  local target="\${@: -1}"
  cp -- "$source" "$target"
  chmod 0644 "$target"
}
apparmor_parser() { :; }

mkdir -p "$(dirname "$APPARMOR_PROFILE")"
printf 'real-profile\n' > "$root/real-profile"
ln -s "$root/real-profile" "$APPARMOR_PROFILE"
BACKUP_DIR="$root/backup-symlink"
mkdir -p "$BACKUP_DIR"
if install_apparmor_profile; then exit 93; fi
test -L "$APPARMOR_PROFILE"
test "$(cat "$root/real-profile")" = real-profile
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('runtime bootstrap journals before stopping and snapshots only after the process is stopped', () => {
  const source = fs.readFileSync(bootstrapPath, 'utf8');
  const migrationStart = source.indexOf('\nbootstrap_run_new_migration() {');
  const mainStart = source.indexOf('\nbootstrap_production_main() {');
  const launchStart = source.indexOf('\nif [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then', mainStart);
  assert.ok(
    migrationStart !== -1 && mainStart > migrationStart && launchStart > mainStart,
    'bootstrap migration and main function boundaries must exist'
  );
  const migration = source.slice(migrationStart, mainStart);
  const main = source.slice(mainStart, launchStart);
  const beginIndex = main.indexOf('begin_migration_journal');
  const runMigrationIndex = main.indexOf('bootstrap_run_new_migration');
  const stopIndex = migration.indexOf('\nstop_current_release');
  const snapshotIndex = migration.indexOf('snapshot_runtime_state');
  const preparedIndex = migration.indexOf('set_migration_phase prepared');

  assert.ok(beginIndex > 0, 'persistent migration journal must start before downtime');
  assert.ok(runMigrationIndex > beginIndex, 'new migration must run only after the journal is durable');
  assert.ok(stopIndex > 0, 'new migration must stop PM2 before snapshotting');
  assert.ok(snapshotIndex > stopIndex, 'rollback snapshot must be captured after writers stop');
  assert.ok(preparedIndex > snapshotIndex, 'state mutation must wait for a complete snapshot');
  assert.match(source, /trap ['"]bootstrap_abort 130['"] INT/);
  assert.match(source, /trap ['"]bootstrap_abort 143['"] TERM/);
  assert.match(source, /trap ['"]bootstrap_abort 129['"] HUP/);
});

test('gate identity validation rejects root, group drift, supplementary groups, and unlocked credentials', () => {
  const source = [
    'set -u',
    'export TM_BOOTSTRAP_LIBRARY_ONLY=1',
    `source ${shellQuote(bootstrapShellPath)}`,
    "validate_gate_identity_values 'turingmarket-gate:x:998:998::/var/lib/turingmarket-gate:/usr/sbin/nologin' 'turingmarket-gate:x:998:' 'turingmarket-gate' 'L'",
    "! validate_gate_identity_values 'turingmarket-gate:x:0:998::/var/lib/turingmarket-gate:/usr/sbin/nologin' 'turingmarket-gate:x:998:' 'turingmarket-gate' 'L'",
    "! validate_gate_identity_values 'turingmarket-gate:x:998:999::/var/lib/turingmarket-gate:/usr/sbin/nologin' 'turingmarket-gate:x:998:' 'turingmarket-gate' 'L'",
    "! validate_gate_identity_values 'turingmarket-gate:x:998:998::/var/lib/turingmarket-gate:/usr/sbin/nologin' 'turingmarket-gate:x:998:' 'turingmarket-gate sudo' 'L'",
    "! validate_gate_identity_values 'turingmarket-gate:x:998:998::/var/lib/turingmarket-gate:/usr/sbin/nologin' 'turingmarket-gate:x:998:' 'turingmarket-gate' 'P'"
  ].join('\n');
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('interrupted prepared migration restores its durable snapshot and validates DB before restart', { skip: nativeLinuxOnly }, () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_LIVE_DIR="$root/live"
export TM_REMOTE_ROOT="$root/remote"
export TM_STATE_ROOT="$root/external"
export TM_GATE_ROOT="$root/gate"
export TM_ENV_DIR="$root/etc"
export TM_JOURNAL_ROOT="$root/journal"
export TM_APPARMOR_PROFILE="$root/apparmor-profile"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

backup="$root/remote/backups/v030-runtime-bootstrap-test"
stateBackup="$backup/state"
validate_sanitizer_gate_idle_state() { :; }
discover_migration_journal() { JOURNAL_PRESENT=1; }
read_journal() {
  JOURNAL_PHASE=prepared
  JOURNAL_BACKUP_DIR="$backup"
  JOURNAL_OWNER_TOKEN=11111111111111111111111111111111
}
adopt_migration_journal() { :; }
claim_migration_journal() { :; }
validate_active_migration_journal_directory() { :; }
validate_committed_runtime_layout_provenance() { return 1; }
clear_migration_journal() { rm -rf -- "$JOURNAL_DIR"; }
mkdir -p "$root/live/server" "$stateBackup/live-db" "$stateBackup/live-uploads" "$stateBackup/live-tmp" "$JOURNAL_DIR"
printf 'original-env' > "$stateBackup/live-env"
: > "$stateBackup/live-env.present"
printf 'good-db' > "$stateBackup/live-db/turingmarket.db"
: > "$stateBackup/live-db.present"
printf 'original-upload' > "$stateBackup/live-uploads/item.txt"
: > "$stateBackup/live-uploads.present"
printf 'original-tmp' > "$stateBackup/live-tmp/item.txt"
: > "$stateBackup/live-tmp.present"
for name in external-env external-db external-uploads external-tmp; do : > "$stateBackup/$name.absent"; done

mkdir -p "$root/live/server/db" "$root/live/uploads" "$root/live/tmp" "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR"
printf 'broken-env' > "$root/live/.env"
printf 'broken-db' > "$root/live/server/db/turingmarket.db"
printf 'new-db' > "$DB_DIR/turingmarket.db"
printf '%s\n' prepared > "$JOURNAL_DIR/phase"
printf '%s\n' "$backup" > "$JOURNAL_DIR/backup-dir"

database_quick_check() { printf 'quickcheck:%s\n' "$1" >> "$root/order"; test "$(cat "$1")" = good-db; }
stop_current_release() { :; }
install_loopback_firewall_for_recovery() { printf 'firewall\n' >> "$root/order"; }
restart_current_release() { printf 'restart\n' >> "$root/order"; }
recover_interrupted_migration

test "$(cat "$root/live/.env")" = original-env
test "$(cat "$root/live/server/db/turingmarket.db")" = good-db
test "$(cat "$root/live/uploads/item.txt")" = original-upload
test ! -e "$ENV_FILE"
test ! -e "$DB_DIR"
test ! -e "$JOURNAL_DIR"
test "$(sed -n '1p' "$root/order")" = "quickcheck:$root/live/server/db/turingmarket.db"
test "$(sed -n '2p' "$root/order")" = firewall
test "$(sed -n '3p' "$root/order")" = restart
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BOOTSTRAP_RECOVERY_OK/);
});

test('interruption before mutation restarts the untouched release without applying an incomplete snapshot', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_LIVE_DIR="$root/live"
export TM_REMOTE_ROOT="$root/remote"
export TM_STATE_ROOT="$root/external"
export TM_GATE_ROOT="$root/gate"
export TM_ENV_DIR="$root/etc"
export TM_JOURNAL_ROOT="$root/journal"
export TM_APPARMOR_PROFILE="$root/apparmor-profile"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

validate_sanitizer_gate_idle_state() { :; }
discover_migration_journal() { JOURNAL_PRESENT=1; }
read_journal() {
  JOURNAL_PHASE=snapshotting
  JOURNAL_BACKUP_DIR="$root/remote/backups/v030-runtime-bootstrap-test"
  JOURNAL_OWNER_TOKEN=11111111111111111111111111111111
}
adopt_migration_journal() { :; }
claim_migration_journal() { :; }
validate_active_migration_journal_directory() { :; }
validate_committed_runtime_layout_provenance() { return 1; }
cleanup_stages() { :; }
clear_migration_journal() { rm -rf -- "$JOURNAL_DIR"; }
mkdir -p "$root/live/server/db" "$root/live/uploads" "$root/live/tmp" "$JOURNAL_DIR"
printf 'untouched' > "$root/live/server/db/turingmarket.db"
printf '%s\n' snapshotting > "$JOURNAL_DIR/phase"
printf '%s\n' "$root/remote/backups/v030-runtime-bootstrap-test" > "$JOURNAL_DIR/backup-dir"
database_quick_check() { return 88; }
stop_current_release() { :; }
install_loopback_firewall_for_recovery() { printf 'firewall\n' >> "$root/order"; }
restart_current_release() { printf 'restart\n' >> "$root/order"; : > "$root/restarted"; }
recover_interrupted_migration
test "$(cat "$root/live/server/db/turingmarket.db")" = untouched
test -f "$root/restarted"
test ! -e "$JOURNAL_DIR"
test "$(sed -n '1p' "$root/order")" = firewall
test "$(sed -n '2p' "$root/order")" = restart
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BOOTSTRAP_RECOVERY_OK/);
});

test('failed rollback validation retains the journal and never restarts invalid state', () => {
  const source = `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_LIVE_DIR="$root/live"
export TM_REMOTE_ROOT="$root/remote"
export TM_STATE_ROOT="$root/external"
export TM_GATE_ROOT="$root/gate"
export TM_ENV_DIR="$root/etc"
export TM_JOURNAL_ROOT="$root/journal"
export TM_APPARMOR_PROFILE="$root/apparmor-profile"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}

backup="$root/remote/backups/v030-runtime-bootstrap-test"
stateBackup="$backup/state"
mkdir -p "$root/live/server" "$stateBackup/live-db" "$stateBackup/live-uploads" "$stateBackup/live-tmp" "$JOURNAL_DIR"
printf 'original-env' > "$stateBackup/live-env"
: > "$stateBackup/live-env.present"
printf 'invalid-db' > "$stateBackup/live-db/turingmarket.db"
: > "$stateBackup/live-db.present"
: > "$stateBackup/live-uploads.present"
: > "$stateBackup/live-tmp.present"
for name in external-env external-db external-uploads external-tmp; do : > "$stateBackup/$name.absent"; done
mkdir -p "$root/live/server/db" "$root/live/uploads" "$root/live/tmp"
printf 'current-db' > "$root/live/server/db/turingmarket.db"
printf '%s\n' prepared > "$JOURNAL_DIR/phase"
printf '%s\n' "$backup" > "$JOURNAL_DIR/backup-dir"
stop_current_release() { :; }
database_quick_check() { return 42; }
restart_current_release() { : > "$root/restarted"; }

if recover_interrupted_migration; then exit 90; fi
test -d "$JOURNAL_DIR"
test ! -e "$root/restarted"
`;
  const result = runBash(source);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('guarded deploy runs the full gate unprivileged and seals only external-state candidates', () => {
  const deploy = read('platform/deploy_v8.ps1');

  for (const marker of [
    '$CANDIDATE_ROOT = "/var/lib/turingmarket-gate/releases"',
    '$GATE_USER = "turingmarket-gate"',
    'server\\scripts\\bootstrap_production_runtime.sh',
    'server\\tests\\deployment_runtime_hardening.test.js',
    'node_modules/playwright-deploy/cli.js install-deps --dry-run chromium',
    'node_modules/playwright-deploy/cli.js install chromium',
    'node_modules/playwright-deploy/cli.js test -c server/tests/deployment-browser-smoke.config.js',
    'TRUSTED_PRODUCTION_SOURCE_GATE_INSTALLED',
    'TM_SANITIZED_MIGRATION_COMPATIBILITY_OK',
    'systemd-run --quiet --wait --pipe --unit="$OfflineGateUnit"',
    '--property="PrivateNetwork=yes"',
    'CANDIDATE_TREE_SHA256',
    'CANDIDATE_TREE_RECHECK_OK',
    'GateUid" -gt 0',
    'GateUid" -lt 1000',
    'GatePrimaryGid',
    'GateGroupGid',
    'id -nG "$GateUser"',
    'passwd -S "$GateUser"',
    '/etc/turingmarket/turingmarket.env',
    '/var/lib/turingmarket/db',
    '/var/lib/turingmarket/uploads',
    '/var/lib/turingmarket/tmp'
  ]) {
    assert.ok(deploy.includes(marker), marker);
  }

  assert.match(deploy, /runuser\s+-u\s+"?\$GateUser"?/);
  assert.ok(deploy.split('validate_gate_identity').length >= 4, 'identity must be revalidated during preparation and immediately before runuser');
  assert.match(deploy, /GateExpectedHome="\$\(dirname "\$CandidateRoot"\)"/);
  assert.match(deploy, /test "\$GateHome" = "\$GateExpectedHome"/);
  assert.doesNotMatch(deploy, /test "\$GateHome" = "\$CandidateRoot"/);
  assert.match(deploy, /pkill\s+-KILL\s+-u\s+"?\$GateUser"?/);
  assert.match(deploy, /sha256sum[^\n]+upload\.sha256/);
  assert.match(deploy, /stat -c %d[^\n]+CandidateDir[\s\S]*stat -c %d[^\n]+LiveDir/);
  assert.match(deploy, /chown\s+-hR\s+root:root[^\n]+CandidateDir/);
  assert.doesNotMatch(deploy, /npx\s+playwright/);
  assert.doesNotMatch(deploy, /for path in \.env server\/db uploads tmp/);
});

test('guarded deploy restores a pinned Playwright cache before dependency staging', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const traversalIndex = deploy.indexOf('chmod 0711 "$ReleaseRoot"');
  const restoreIndex = deploy.indexOf('\nrestore_playwright_cache\n');
  const dependencyIndex = deploy.indexOf('node node_modules/playwright-deploy/cli.js install chromium');

  assert.match(deploy, /\$PLAYWRIGHT_CACHE_BUNDLE_REMOTE_PATH = "\/var\/cache\/turingmarket-playwright\/chromium-1228-linux-x64-v1\.tgz"/);
  assert.match(deploy, /\$EXPECTED_PLAYWRIGHT_CACHE_BUNDLE_SHA256 = "aa86503de3215642b6956f78b2be18a05b6246c09b2cd5dffcc8bab12a12dcd2"/);
  assert.match(deploy, /\$EXPECTED_PLAYWRIGHT_CACHE_BUNDLE_BYTES = 281725422/);
  assert.match(deploy, /\$EXPECTED_PLAYWRIGHT_CACHE_FILES = 599/);
  assert.match(deploy, /\$EXPECTED_PLAYWRIGHT_CACHE_DIRECTORIES = 20/);
  assert.match(deploy, /\$EXPECTED_PLAYWRIGHT_CACHE_TREE_BYTES = 674450733/);
  assert.match(deploy, /stat -c '%U:%G:%a:%h' "\$PlaywrightCacheBundle"[\s\S]*root:root:444:1/);
  assert.match(deploy, /for directory in \('\/var', '\/var\/cache', '\/var\/cache\/turingmarket-playwright'\)/);
  assert.match(deploy, /install -o root -g root -m 0444 -- "\$PlaywrightCacheBundle" "\$CacheSnapshot"/);
  assert.match(deploy, /sha256sum "\$CacheSnapshot"[\s\S]*ExpectedPlaywrightCacheSha256/);
  assert.match(deploy, /tarfile\.open\(archive, mode='r:gz'\)[\s\S]*member\.isdir\(\)[\s\S]*member\.isreg\(\)/);
  assert.match(deploy, /runuser -u "\$GateUser" -- tar[\s\S]*--file "\$CacheSnapshot" --directory "\$CacheExtractRoot"/);
  assert.match(deploy, /mode=0711,uid=0,gid=0[\s\S]*root:root:711/);
  assert.doesNotMatch(deploy, /tar[^\n]*"\$PlaywrightCacheBundle"/);
  assert.match(deploy, /PLAYWRIGHT_DOWNLOAD_HOST=https:\/\/127\.0\.0\.1:9/);
  assert.ok(traversalIndex >= 0 && traversalIndex < restoreIndex);
  assert.ok(restoreIndex >= 0 && restoreIndex < dependencyIndex);
});

test('candidate verification cannot read production data and runs candidate code without external networking', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const trustedGate = read('platform/server/scripts/trusted_production_source_gate.js');
  const trustedVerifier = read('platform/server/scripts/verify_campaign_migration_gate.js');
  const gateMatch = deploy.match(/<<'TM_UNPRIVILEGED_GATE'\r?\n([\s\S]*?)\r?\nTM_UNPRIVILEGED_GATE/);
  const dependencyMatch = deploy.match(/<<'TM_DEPENDENCY_STAGE'\r?\n([\s\S]*?)\r?\nTM_DEPENDENCY_STAGE/);
  const dependencyBuildMatch = deploy.match(/<<'TM_DEPENDENCY_BUILD'\r?\n([\s\S]*?)\r?\nTM_DEPENDENCY_BUILD/);
  const candidateMatch = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(gateMatch, 'offline unprivileged gate must exist');
  assert.ok(dependencyMatch, 'network-enabled dependency staging must be separate');
  assert.ok(dependencyBuildMatch, 'native dependency lifecycle must have a separate offline unit');
  assert.ok(candidateMatch, 'candidate-only gate must exist');
  const gate = gateMatch[1];
  const dependencyStage = dependencyMatch[1];
  const dependencyBuild = dependencyBuildMatch[1];
  const candidateGate = candidateMatch[1];

  assert.match(deploy, /ProductionBackupDb="\$BackupAbsolute\/database\/turingmarket\.db"/);
  assert.match(deploy, /ProductionLiveDb="\/var\/lib\/turingmarket\/db\/turingmarket\.db"/);
  assert.match(deploy, /chown root:root "\$ProductionBackupDb"[\s\S]*?chmod 0600 "\$ProductionBackupDb"/);
  assert.match(deploy, /runuser -u "\$GateUser" -- test ! -r "\$ProductionBackupDb"/);
  assert.match(deploy, /runuser -u "\$GateUser" -- test ! -r "\$ProductionLiveDb"/);
  assert.doesNotMatch(deploy, /cp "\$BackupAbsolute\/database\/turingmarket\.db" "\$SchemaDb"/);
  assert.doesNotMatch(deploy, /node "\$CandidateDir\/server\/scripts\/sanitize_production_shape\.js"/);
  assert.match(deploy, /\/usr\/bin\/node "\$TrustedSourceGate" sanitize-and-verify[\s\S]*?--source "\$TrustedSourceCopy"[\s\S]*?--sanitized-source "\$SchemaDb"/);
  assert.match(deploy, /--manifest "\$TrustedSourceManifest"/);
  assert.match(trustedGate, /sanitization\.format !== sanitizer\.REPORT_VERSION/);
  assert.match(trustedGate, /format:\s*VERDICT_FORMAT/);
  assert.doesNotMatch(deploy, /TM_BUILD_SANITIZED_SCHEMA_DB/);
  assert.doesNotMatch(gate, /BackupAbsolute|ProductionBackupDb|\/var\/lib\/turingmarket\/db|\/root\/turingmarket/);
  assert.doesNotMatch(gate, /business_counts|TM_ROW_COUNTS/);
  assert.match(trustedGate, /verifier:\s*'server\/scripts\/verify_campaign_migration_gate\.js'/);
  assert.match(trustedVerifier, /REGISTERED_MIGRATIONS\.at\(-1\)/);
  assert.match(trustedVerifier, /verifyDeterministicFtsCanaries/);
  assert.match(gate, /TM_SANITIZED_MIGRATION_COMPATIBILITY_OK/);
  assert.match(gate, /SCHEMA_RUNTIME_DIR="\$TEST_ROOT\/schema-runtime"/);
  assert.match(gate, /install -m 0600 "\$SCHEMA_DB" "\$SCHEMA_RUNTIME_DB"/);
  assert.match(gate, /DB_PATH="\$SCHEMA_RUNTIME_DB" node <<'NODE'/);
  assert.match(gate, /const database = require\('\.\/db'\);/, 'the writable copy must exercise the real candidate startup migration');
  assert.match(gate, /trap cleanup_schema_runtime EXIT/);
  assert.doesNotMatch(gate, /readonly: true/, 'the sealed source is copied before the write-capable migration path');
  assert.doesNotMatch(gate, /TM_SYNTHETIC_SENTINELS_OK|EXPECTED_SCHEMA_FINGERPRINT/);

  assert.match(dependencyStage, /npm ci --ignore-scripts[\s\S]*?install chromium[\s\S]*?npm ci --ignore-scripts/);
  assert.doesNotMatch(dependencyStage, /npm rebuild|preinstall|postinstall/);
  assert.match(deploy, /npm_config_offline=true[\s\S]*?TM_DEPENDENCY_BUILD/);
  assert.match(dependencyBuild, /npm rebuild better-sqlite3/);
  assert.doesNotMatch(dependencyStage, /node --test|deployment-browser-smoke|SCHEMA_DB|EXPECTED_SCHEMA_FINGERPRINT/);
  assert.doesNotMatch(dependencyBuild, /node --test|deployment-browser-smoke|SCHEMA_DB|EXPECTED_SCHEMA_FINGERPRINT/);
  assert.ok(candidateGate.indexOf('TM_DEPENDENCY_STAGE') < candidateGate.indexOf('/usr/bin/node "$TrustedSourceGate" sanitize-and-verify'));
  assert.ok(deploy.indexOf('systemd-run --quiet --wait --pipe --unit="$DependencyUnit"') < deploy.indexOf("TM_DEPENDENCY_STAGE"));
  assert.ok(deploy.indexOf('systemd-run --quiet --wait --pipe --unit="$DependencyBuildUnit"') < deploy.indexOf("TM_DEPENDENCY_BUILD"));
  assert.ok(deploy.indexOf("TM_DEPENDENCY_STAGE") < deploy.indexOf('systemd-run --quiet --wait --pipe --unit="$DependencyBuildUnit"'));
  assert.ok(deploy.indexOf('systemd-run --quiet --wait --pipe --unit="$OfflineGateUnit"') < deploy.indexOf("TM_UNPRIVILEGED_GATE"));
  assert.ok(deploy.indexOf("TM_DEPENDENCY_BUILD") < deploy.indexOf('systemd-run --quiet --wait --pipe --unit="$OfflineGateUnit"'));
  assert.ok(deploy.indexOf('systemd-run --quiet --wait --pipe --unit="$OfflineGateUnit"') < deploy.indexOf('node server/scripts/verify_phase4_one_request_replay.js'));
  assert.doesNotMatch(deploy, /unshare --net --fork/);
  assert.doesNotMatch(gate, /\bip\s+(?:route|(?:-o\s+)?link)\b/, 'offline verification must not require AF_NETLINK');
  assert.match(gate, /Path\('\/sys\/class\/net'\)/);
  assert.match(gate, /Path\('\/proc\/net\/route'\)/);
  assert.doesNotMatch(gate, /Path\('\/proc\/net\/ipv6_route'\)/, 'the isolated kernel reject route is not an outbound route');
  assert.match(deploy, /printf "%s\\n" "OFFLINE_NETWORK_NAMESPACE_OK"/);
  assert.doesNotMatch(deploy, /printf '%s\\n' "OFFLINE_NETWORK_NAMESPACE_OK"/);
});

test('networked npm dependency stages use the reachable integrity-locked registry mirror', () => {
  const deploy = read('platform/deploy_v8.ps1');
  assert.equal(
    (deploy.match(/npm_config_registry=https:\/\/registry\.npmmirror\.com/g) || []).length,
    2,
    'parser and candidate dependency fetch units must use the same reachable registry mirror'
  );
  assert.equal(
    (deploy.match(/npm_config_replace_registry_host=always/g) || []).length,
    2,
    'lockfile-resolved npmjs hosts must be replaced while npm ci still enforces package integrity hashes'
  );
  assert.match(
    deploy,
    /npm_config_registry=https:\/\/registry\.npmmirror\.com[\s\S]*?npm ci --ignore-scripts --cache \/parser-cache\/npm/
  );
  assert.match(
    deploy,
    /--unit="\$DependencyUnit"[\s\S]*?npm_config_registry=https:\/\/registry\.npmmirror\.com[\s\S]*?TM_DEPENDENCY_STAGE/
  );
});

test('unprivileged candidate validation runs bounded release proofs instead of developer regression suites', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const gateMatch = deploy.match(/<<'TM_UNPRIVILEGED_GATE'\r?\n([\s\S]*?)\r?\nTM_UNPRIVILEGED_GATE/);
  assert.ok(gateMatch, 'offline unprivileged gate must exist');
  const gate = gateMatch[1];

  const releaseProofs = [
    'node server/scripts/verify_phase4_one_request_replay.js',
    'node --test server/tests/verify_phase4_one_request_replay.test.js',
    'node --test server/tests/release_replay_gate.test.js',
    'node node_modules/playwright-deploy/cli.js test -c server/tests/deployment-browser-smoke.config.js'
  ];
  let cursor = -1;
  for (const proof of releaseProofs) {
    const position = gate.indexOf(proof);
    assert.ok(position > cursor, `${proof} must execute once in release-proof order`);
    assert.equal(gate.indexOf(proof, position + 1), -1, `${proof} must not be duplicated`);
    cursor = position;
  }
  assert.doesNotMatch(gate, /tests\/\*\.test\.js|CandidateTestFiles|sanitized_migration_gate|bootstrap_phase4_boundary|browser_baseline_tools/);
  assert.match(
    deploy,
    /\/usr\/bin\/node "\$TrustedSourceGate" sanitize-and-verify[\s\S]*?TRUSTED_SANITIZATION_AND_MIGRATION_REHEARSAL_OK/,
    'the real trusted migration rehearsal must remain the production gate'
  );
});

test('candidate dependency and offline gates are filesystem-confined transient services', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const dependencyMatch = deploy.match(/set \+e\r?\ntimeout --signal=KILL 20m systemd-run --quiet --wait --pipe --unit="\$DependencyUnit"([\s\S]*?)<<'TM_DEPENDENCY_STAGE'/);
  const dependencyBuildMatch = deploy.match(/set \+e\r?\ntimeout --signal=KILL 20m systemd-run --quiet --wait --pipe --unit="\$DependencyBuildUnit"([\s\S]*?)<<'TM_DEPENDENCY_BUILD'/);
  const offlineMatch = deploy.match(/set \+e\r?\ntimeout --signal=KILL 30m systemd-run --quiet --wait --pipe --unit="\$OfflineGateUnit"([\s\S]*?)<<'TM_UNPRIVILEGED_GATE'/);
  assert.ok(dependencyMatch, 'dependency installation must execute inside its transient service');
  assert.ok(dependencyBuildMatch, 'dependency lifecycle must execute inside its offline transient service');
  assert.ok(offlineMatch, 'offline verification must execute inside its transient service');

  const dependency = dependencyMatch[1];
  const dependencyBuild = dependencyBuildMatch[1];
  const offline = offlineMatch[1];
  const productionPaths = [
    '\\$RemoteRoot',
    '/etc/turingmarket',
    '/var/lib/turingmarket',
  ];

  for (const unit of [dependency, dependencyBuild, offline]) {
    assert.match(unit, /--uid="\$GateUser" --gid="\$GateUser" --service-type=exec/);
    assert.match(unit, /--property="PrivatePIDs=yes"/);
    assert.match(unit, /--property="PrivateMounts=yes"/);
    assert.match(unit, /--property="PrivateTmp=yes"/);
    assert.match(unit, /--property="PrivateDevices=yes"/);
    assert.match(unit, /--property="PrivateIPC=yes"/);
    assert.match(unit, /--property="ProtectHome=yes"/);
    assert.match(unit, /--property="ProtectSystem=strict"/);
    assert.match(unit, /--property="ProtectProc=invisible"/);
    assert.match(unit, /--property="NoNewPrivileges=yes"/);
    assert.match(unit, /--property="CapabilityBoundingSet="/);
    assert.match(unit, /--property="SystemCallArchitectures=native"/);
    assert.match(unit, /--property="InaccessiblePaths=\$RemoteRoot \/etc\/turingmarket \/var\/lib\/turingmarket"/);
    for (const productionPath of productionPaths) {
      assert.match(unit, new RegExp(productionPath.replaceAll('/', '\\/')));
    }
  }

  assert.doesNotMatch(dependency, /PrivateNetwork=yes/, 'dependency installation needs outbound package access');
  assert.match(dependency, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(dependency, /IPAddressDeny=[^"\r\n]*169\.254\.0\.0\/16/);
  assert.match(dependency, /IPAddressDeny=[^"\r\n]*10\.0\.0\.0\/8/);
  assert.match(dependency, /IPAddressDeny=[^"\r\n]*172\.16\.0\.0\/12/);
  assert.match(dependency, /IPAddressDeny=[^"\r\n]*192\.168\.0\.0\/16/);
  assert.match(dependency, /IPAddressDeny=[^"\r\n]*fc00::\/7/);
  assert.match(dependency, /IPAddressAllow=127\.0\.0\.53\/32 127\.0\.0\.54\/32/);
  assert.match(dependency, /--property="ReadWritePaths=\$TestRoot"/);
  assert.doesNotMatch(dependency, /ReadWritePaths=\$ReleaseRoot|WorkingDirectory=\$CandidateDir/);
  assert.match(dependencyBuild, /--property="PrivateNetwork=yes"/);
  assert.match(dependencyBuild, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(dependencyBuild, /--property="ReadWritePaths=\$TestRoot"/);
  assert.doesNotMatch(dependencyBuild, /ReadWritePaths=\$ReleaseRoot|WorkingDirectory=\$CandidateDir/);
  assert.match(offline, /--property="PrivateNetwork=yes"/);
  assert.match(offline, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(offline, /--property="ReadOnlyPaths=\$CandidateDir"/);
  assert.match(offline, /--property="ReadWritePaths=\$TestRoot"/);
  assert.doesNotMatch(offline, /ReadWritePaths=\$ReleaseRoot/);
  assert.doesNotMatch(dependency, /runuser|unshare/);
  assert.doesNotMatch(dependencyBuild, /runuser|unshare/);
  assert.doesNotMatch(offline, /runuser|unshare/);
  assert.match(deploy, /DependencyStatus=\$\?[\s\S]*?drain_gate_unit "\$DependencyUnit"[\s\S]*?kill_gate_processes "dependency staging"/);
  assert.match(deploy, /DependencyBuildStatus=\$\?[\s\S]*?drain_gate_unit "\$DependencyBuildUnit"[\s\S]*?kill_gate_processes "dependency build"/);
  assert.match(deploy, /GateStatus=\$\?[\s\S]*?drain_gate_unit "\$OfflineGateUnit"[\s\S]*?kill_gate_processes "offline candidate validation"/);
  assert.match(deploy, /CANDIDATE_VALIDATION_SHA256_BEFORE[\s\S]*?CANDIDATE_VALIDATION_SHA256_AFTER[\s\S]*?CANDIDATE_READONLY_RECHECK_OK/);
});

test('unprivileged gate uses only variables explicitly passed through env -i', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const match = deploy.match(/<<'TM_UNPRIVILEGED_GATE'\r?\n([\s\S]*?)\r?\nTM_UNPRIVILEGED_GATE/);
  assert.ok(match, 'unprivileged gate heredoc must exist');
  const gate = match[1];
  const envBoundary = deploy.slice(deploy.lastIndexOf('timeout --signal=KILL', match.index), match.index);

  assert.doesNotMatch(envBoundary, /DB_PATH=/, 'the bounded release proofs do not receive a generic database path');
  assert.doesNotMatch(gate, /\$(?:TestDb|DB_PATH)\b/);
  const referencedVariables = [...new Set(
    [...gate.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((entry) => entry[1])
  )].sort();
  assert.deepEqual(referencedVariables, [
    'APP_BUILD',
    'APP_QUERY',
    'CANDIDATE_DIR',
    'NGINX_TEST_SOCKET',
    'PPT_BUILD',
    'PPT_QUERY',
    'PPT_SHA256',
    'SCHEMA_DB',
    'SCHEMA_RUNTIME_DB',
    'SCHEMA_RUNTIME_DIR',
    'TEST_ROOT'
  ]);
});

test('candidate lifecycle rejects directory substitution and clears network-stage processes before offline validation', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const candidateMatch = deploy.match(/\$candidateGate = @'\r?\n([\s\S]*?)\r?\n'@/);
  const cutoverMatch = deploy.match(/\$cutoverGate = @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate gate here-string must exist');
  assert.ok(cutoverMatch, 'cutover gate here-string must exist');
  const candidateGate = candidateMatch[1];
  const cutoverGate = cutoverMatch[1];

  assert.match(candidateGate, /assert_canonical_candidate\(\)[\s\S]*?test ! -L "\$ReleaseRoot"[\s\S]*?test ! -L "\$CandidateDir"[\s\S]*?realpath -e "\$CandidateDir"/);
  assert.ok((candidateGate.match(/assert_canonical_candidate/g) || []).length >= 5, 'candidate canonical path must be rechecked across trust transitions');
  assert.match(cutoverGate, /assert_canonical_candidate\(\)[\s\S]*?test ! -L "\$ReleaseRoot"[\s\S]*?test ! -L "\$CandidateDir"[\s\S]*?realpath -e "\$CandidateDir"/);
  assert.ok((cutoverGate.match(/assert_canonical_candidate/g) || []).length >= 4, 'cutover must recheck canonical candidate before digest and exchange');

  assert.match(candidateGate, /kill_gate_processes\(\)[\s\S]*?pkill -KILL -u "\$GateUser"[\s\S]*?pgrep -u "\$GateUser"/);
  assert.match(candidateGate, /DependencyStatus=\$\?[\s\S]*?kill_gate_processes "dependency staging"[\s\S]*?\[ "\$DependencyStatus" != "0" \]/);
  assert.match(candidateGate, /DependencyBuildStatus=\$\?[\s\S]*?kill_gate_processes "dependency build"[\s\S]*?\[ "\$DependencyBuildStatus" != "0" \]/);
  assert.ok(candidateGate.indexOf('kill_gate_processes "dependency build"') < candidateGate.indexOf('systemd-run --quiet --wait --pipe --unit="$OfflineGateUnit"'));
  assert.match(candidateGate, /GateStatus=\$\?[\s\S]*?kill_gate_processes "offline candidate validation"/);
});

test('unprivileged nginx gate derives a socket listener while root validates the original config', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const match = deploy.match(/<<'TM_UNPRIVILEGED_GATE'\r?\n([\s\S]*?)\r?\nTM_UNPRIVILEGED_GATE/);
  assert.ok(match, 'unprivileged gate heredoc must exist');
  const gate = match[1];
  const gateSetup = deploy.slice(deploy.lastIndexOf('validate_gate_identity', match.index), match.index);
  const envBoundary = deploy.slice(deploy.lastIndexOf('set +e', match.index), match.index);
  const afterGate = deploy.slice(match.index + match[0].length);

  assert.match(gateSetup, /NginxGateDir="\$TestRoot\/nginx-gate"/);
  assert.match(gateSetup, /install -d -o "\$GateUser" -g "\$GateUser" -m 0700 "\$NginxGateDir"/);
  assert.match(deploy, /trap 'cleanup_candidate_gate \$\?' EXIT/);
  assert.match(deploy, /cleanup_test_root\(\)[\s\S]*?declare -F cleanup_nginx_gate_dir[\s\S]*?cleanup_nginx_gate_dir/);
  assert.doesNotMatch(envBoundary, /NGINX_GATE_DIR=/);
  assert.doesNotMatch(gate, /mktemp -d \/tmp\/tm-nginx-gate/);
  assert.match(gate, /turingmarket-gate\.conf/);
  assert.ok(gate.includes("pattern = re.compile(r'(?m)^(\\s*listen\\s+)80(\\s*;\\s*(?:#.*)?)$')"));
  assert.match(gate, /unix:\{socket_path\}/, 'the derived config must replace the privileged listener with a Unix socket');
  assert.match(gate, /replacement_count.*!= 1/, 'the listener rewrite must reject zero or multiple replacements');
  assert.match(gate, /python3 - "\$CANDIDATE_DIR\/nginx\/turingmarket\.conf" "\$TEST_ROOT\/turingmarket-gate\.conf"/);
  assert.match(gate, /include \$TEST_ROOT\/turingmarket-gate\.conf;/);
  assert.doesNotMatch(gate, /include \$CANDIDATE_DIR\/nginx\/turingmarket\.conf;/);
  assert.match(gate, /NGINX_TEST_SOCKET="nginx-gate\/listen\.sock"/);
  assert.doesNotMatch(gate, /NGINX_TEST_SOCKET="\$NGINX_GATE_DIR\/listen\.sock"/);
  assert.match(
    gate,
    /\(\s*cd "\$TEST_ROOT"\s*nginx -t -p "\$TEST_ROOT\/nginx-prefix\/" -c "\$TEST_ROOT\/nginx-test\.conf"\s*\)/,
    'the short relative socket must resolve from the writable test root'
  );

  assert.match(afterGate, /kill_gate_processes "offline candidate validation"[\s\S]*?cleanup_nginx_gate_dir[\s\S]*?\[ "\$GateStatus" = "0" \]/);
  assert.match(afterGate, /\[ "\$GateStatus" = "0" \][\s\S]*?sha256sum --check --status "\$LockDir\/upload\.sha256"/);
  assert.match(afterGate, /sha256sum --check --status "\$LockDir\/upload\.sha256"[\s\S]*?cleanup_test_root[\s\S]*?trap - EXIT HUP INT TERM/);
  assert.match(
    afterGate,
    /install -m 0644 "\$LiveDir\/nginx\/turingmarket\.conf" \/etc\/nginx\/sites-available\/turingmarket[\s\S]*?nginx -t\s*\r?\n\s*systemctl reload nginx/
  );
});
