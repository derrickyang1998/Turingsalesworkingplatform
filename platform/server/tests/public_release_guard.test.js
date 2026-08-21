'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const guardPath = path.resolve(__dirname, '..', 'scripts', 'public_release_guard.sh');
const deployPath = path.resolve(__dirname, '..', '..', 'deploy_v8.ps1');
const watchUnit = 'turingmarket-restore-public-guard-0123456789abcdef0123456789abcdef.service';
const gitBash = process.env.GIT_BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' ? gitBash : 'bash';
const hasBash = process.platform !== 'win32' || fs.existsSync(gitBash);
const bundledPython = path.join(
  os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime',
  'dependencies', 'python', 'python.exe'
);
const python = process.env.PYTHON3_PATH
  || (process.platform === 'win32' ? bundledPython : 'python3');
const hasPython = spawnSync(python, ['--version'], { encoding: 'utf8' }).status === 0;

function supportsNativeSymlinks() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-public-guard-symlink-probe-'));
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  try {
    fs.writeFileSync(target, 'probe');
    fs.symlinkSync(target, link);
    return fs.lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function supportsUserXattrs() {
  if (!hasPython) return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-public-guard-xattr-probe-'));
  const target = path.join(root, 'target');
  fs.writeFileSync(target, 'probe');
  const result = spawnSync(python, ['-c', [
    'import os, sys',
    "os.setxattr(sys.argv[1], b'user.tm_probe', b'1', follow_symlinks=False)",
    "assert b'user.tm_probe' in os.listxattr(sys.argv[1], follow_symlinks=False)",
  ].join(';'), target], { encoding: 'utf8' });
  fs.rmSync(root, { recursive: true, force: true });
  return result.status === 0;
}

const hasNativeSymlinks = supportsNativeSymlinks();
const hasUserXattrs = supportsUserXattrs();
const canChangeOwner = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;

function nativeRootPythonAvailable() {
  const command = process.platform === 'win32'
    ? ['wsl.exe', ['-u', 'root', '-e', 'bash', '-lc', 'test "$(id -u)" = 0 && command -v python3 >/dev/null']]
    : ['bash', ['-lc', 'test "$(id -u)" = 0 && command -v python3 >/dev/null']];
  return spawnSync(command[0], command[1], { encoding: 'utf8', timeout: 10_000 }).status === 0;
}

function nativeGuardPath() {
  if (process.platform !== 'win32') return guardPath;
  return `/mnt/${guardPath[0].toLowerCase()}${guardPath.slice(2).replaceAll('\\', '/')}`;
}

function runRootLinuxScript(script) {
  return process.platform === 'win32'
    ? spawnSync('wsl.exe', ['-u', 'root', '-e', 'bash', '-s'], {
      encoding: 'utf8', input: script, timeout: 60_000,
    })
    : spawnSync('bash', ['-s'], { encoding: 'utf8', input: script, timeout: 60_000 });
}

const hasNativeRootPython = nativeRootPythonAvailable();

function bashPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  return `/${filePath[0].toLowerCase()}${filePath.slice(2).replaceAll('\\', '/')}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-public-guard-test-'));
  const lockDir = path.join(root, 'lock');
  const availableDir = path.join(root, 'etc', 'nginx', 'sites-available');
  const enabledDir = path.join(root, 'etc', 'nginx', 'sites-enabled');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.mkdirSync(availableDir, { recursive: true });
  fs.mkdirSync(enabledDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const paths = {
    root,
    lockDir,
    state: path.join(lockDir, 'public-gate-guard'),
    stateNext: path.join(lockDir, 'public-gate-guard.next'),
    stateLock: path.join(lockDir, 'public-gate-guard.transaction-lock'),
    source: path.join(lockDir, 'nginx-api-gate.conf'),
    maintenance: path.join(availableDir, 'turingmarket-maintenance'),
    recovery: path.join(lockDir, 'nginx-public-guard.link'),
    site: path.join(enabledDir, 'turingmarket'),
    log: path.join(root, 'commands.log'),
    binDir,
  };
  fs.writeFileSync(paths.state, 'armed\n', { mode: 0o600 });
  fs.chmodSync(paths.state, 0o600);
  fs.writeFileSync(paths.source, 'CLOSED_API_GATE\n');
  fs.writeFileSync(paths.site, 'PUBLIC_RELEASE\n');

  writeExecutable(path.join(binDir, 'nginx'), `#!/usr/bin/env bash
printf 'nginx:%s\\n' "$*" >> "$TM_PUBLIC_GUARD_TEST_LOG"
test "\${TM_PUBLIC_GUARD_MOCK_NGINX_FAIL:-0}" != 1
`);
  writeExecutable(path.join(binDir, 'systemctl'), `#!/usr/bin/env bash
printf 'systemctl:%s\\n' "$*" >> "$TM_PUBLIC_GUARD_TEST_LOG"
  case "$1:$2" in
  reload:nginx)
    test "\${TM_PUBLIC_GUARD_MOCK_RELOAD_FAIL:-0}" != 1
    ;;
  stop:nginx|kill:--kill-who=all)
    : > "$TM_PUBLIC_GUARD_TEST_ROOT/nginx-stopped"
    ;;
  show:*)
    unit="$2"
    property=''
    for argument in "$@"; do case "$argument" in --property=*) property="\${argument#--property=}" ;; esac; done
    test "$unit" = "$(cat "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.unit")"
    case "$property" in
      Id|Names) printf '%s\\n' "$unit" ;;
      LoadState) printf '%s\\n' loaded ;;
      ActiveState) printf '%s\\n' active ;;
      SubState) printf '%s\\n' running ;;
      FragmentPath) printf '/run/systemd/transient/%s\\n' "$unit" ;;
      RuntimeMaxUSec) printf '%s\\n' infinity ;;
      *) exit 64 ;;
    esac
    ;;
  is-active:*)
    if test "\${TM_PUBLIC_GUARD_MOCK_DISARM_CLOSE_RACE:-0}" = 1 &&
       test "$(cat "$TM_PUBLIC_GUARD_TEST_ROOT/lock/public-gate-guard")" = verified; then
      : > "$TM_PUBLIC_GUARD_TEST_ROOT/disarm-is-active.ready"
      for _attempt in $(seq 1 500); do
        test "$(cat "$TM_PUBLIC_GUARD_TEST_ROOT/lock/public-gate-guard")" = closed && break
        sleep 0.01
      done
    fi
    grep -q '^armed|' "$TM_PUBLIC_GUARD_TEST_ROOT/lock/public-gate-guard" 2>/dev/null
    ;;
  daemon-reload:|reset-failed:*)
    exit 0
    ;;
esac
`);
  writeExecutable(path.join(binDir, 'curl'), `#!/usr/bin/env bash
printf 'curl:%s\\n' "$*" >> "$TM_PUBLIC_GUARD_TEST_LOG"
printf '%s' "\${TM_PUBLIC_GUARD_MOCK_HTTP_STATUS:-503}"
`);
  writeExecutable(path.join(binDir, 'ss'), `#!/usr/bin/env bash
printf 'ss:%s\\n' "$*" >> "$TM_PUBLIC_GUARD_TEST_LOG"
if test "\${TM_PUBLIC_GUARD_MOCK_SS_FAIL:-0}" = 1; then exit 42; fi
if test "\${TM_PUBLIC_GUARD_MOCK_LISTENER:-1}" = 1 && test ! -e "$TM_PUBLIC_GUARD_TEST_ROOT/nginx-stopped"; then
  printf 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:*\\n'
fi
`);
  writeExecutable(path.join(binDir, 'sync'), `#!/usr/bin/env bash
printf 'sync:%s\\n' "$*" >> "$TM_PUBLIC_GUARD_TEST_LOG"
if test "\${TM_PUBLIC_GUARD_MOCK_SYNC_FAIL:-0}" = 1; then exit 43; fi
`);
  writeExecutable(path.join(binDir, 'systemd-run'), `#!/usr/bin/env bash
printf 'systemd-run:%s\\n' "$*" >> "$TM_PUBLIC_GUARD_TEST_LOG"
for argument in "$@"; do
  case "$argument" in --unit=*) printf '%s\\n' "\${argument#--unit=}" > "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.unit" ;; esac
done
`);
  writeExecutable(path.join(binDir, 'ln'), `#!/usr/bin/env bash
target="\${@: -2:1}"
link="\${@: -1}"
printf '%s\\n' "$target" > "$link"
`);

  const env = {
    ...process.env,
    TM_PUBLIC_GUARD_TEST_MODE: '1',
    TM_PUBLIC_GUARD_TEST_ROOT: bashPath(root),
    TM_PUBLIC_GUARD_TEST_BIN: bashPath(binDir),
    TM_PUBLIC_GUARD_TEST_LOG: bashPath(paths.log),
    TM_PUBLIC_GUARD_MOCK_HTTP_STATUS: '503',
    TM_PUBLIC_GUARD_MOCK_LISTENER: '1',
    TM_PUBLIC_GUARD_TEST_PYTHON: bashPath(python),
    TM_PUBLIC_GUARD_TEST_EXPECT_MODE: process.platform === 'win32' ? '644' : '600',
  };
  const commonArgs = [
    '--state-file', bashPath(paths.state),
    '--maintenance-source', bashPath(paths.source),
    '--maintenance-config', bashPath(paths.maintenance),
    '--recovery-link', bashPath(paths.recovery),
    '--site-link', bashPath(paths.site),
  ];
  return { paths, env, commonArgs };
}

function writeGuardRecord(filePath, record, mode = 0o600) {
  fs.writeFileSync(filePath, `${record}\n`, { mode });
  fs.chmodSync(filePath, mode);
}

function guardIdentityArgs(unit, deadline) {
  return [
    '--unit', unit,
    '--controller-pid', '123',
    '--controller-start-ticks', '456',
    '--deadline-epoch', String(deadline),
  ];
}

function guardArmArgs(harness, unit, deadline) {
  const dropIn = path.join(
    harness.paths.root, 'etc', 'systemd', 'nginx.service.d',
    '90-turingmarket-public-guard.conf'
  );
  return [...guardIdentityArgs(unit, deadline), '--drop-in', bashPath(dropIn)];
}

function createLiveWatchdogHarness() {
  const harness = createHarness();
  writeExecutable(path.join(harness.paths.binDir, 'systemd-run'), `#!/usr/bin/env bash
set -euo pipefail
printf 'systemd-run:%s\\n' "$*" >> "$TM_PUBLIC_GUARD_TEST_LOG"
unit=''
runtime=''
while test "$#" -gt 0; do
  case "$1" in
    --unit=*) unit="\${1#--unit=}"; shift ;;
    --property=RuntimeMaxSec=*) runtime="\${1#--property=RuntimeMaxSec=}"; shift ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
test -n "$unit"
while test "$#" -gt 0 && test "$1" != /bin/bash; do shift; done
test "\${1:-}" = /bin/bash
"$@" > "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.out" 2>&1 &
watchdog=$!
printf '%s\\n' "$watchdog" > "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.pid"
printf '%s\\n' "$unit" > "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.unit"
printf '%s\\n' "$runtime" > "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.runtime"
if test "$runtime" = 5m; then
  (sleep "\${TM_PUBLIC_GUARD_TEST_OLD_CAP_SECONDS:-1}"; kill -TERM "$watchdog" 2>/dev/null || true) >/dev/null 2>&1 &
fi
`);
  writeExecutable(path.join(harness.paths.binDir, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl:%s\\n' "$*" >> "$TM_PUBLIC_GUARD_TEST_LOG"
active_state() {
  test -f "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.pid" || return 1
  pid="$(cat "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.pid")"
  kill -0 "$pid" 2>/dev/null
}
case "$1" in
  daemon-reload|reset-failed) exit 0 ;;
  is-active)
    active_state
    ;;
  show)
    unit="$2"
    property=''
    for argument in "$@"; do case "$argument" in --property=*) property="\${argument#--property=}" ;; esac; done
    expected_unit="$(cat "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.unit")"
    test "$unit" = "$expected_unit"
    case "$property" in
      Id|Names) printf '%s\\n' "$expected_unit" ;;
      LoadState) printf '%s\\n' loaded ;;
      ActiveState) if active_state; then printf '%s\\n' active; else printf '%s\\n' inactive; fi ;;
      SubState) if active_state; then printf '%s\\n' running; else printf '%s\\n' dead; fi ;;
      FragmentPath) printf '/run/systemd/transient/%s\\n' "$expected_unit" ;;
      RuntimeMaxUSec)
        runtime="$(cat "$TM_PUBLIC_GUARD_TEST_ROOT/watchdog.runtime")"
        if test -n "$runtime"; then printf '%s\\n' 5min; else printf '%s\\n' infinity; fi
        ;;
      *) exit 64 ;;
    esac
    ;;
  reload)
    test "$2" = nginx
    ;;
  stop)
    test "$2" = nginx
    : > "$TM_PUBLIC_GUARD_TEST_ROOT/nginx-stopped"
    ;;
  kill)
    : > "$TM_PUBLIC_GUARD_TEST_ROOT/nginx-stopped"
    ;;
  *) exit 64 ;;
esac
`);
  return harness;
}

function runGuard(mode, harness, extraArgs = [], env = {}) {
  return spawnSync(bash, [bashPath(guardPath), mode, ...harness.commonArgs, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...harness.env, ...env },
  });
}

function runGuardAsync(mode, harness, extraArgs = [], env = {}) {
  const child = spawn(bash, [bashPath(guardPath), mode, ...harness.commonArgs, ...extraArgs], {
    env: { ...harness.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completion };
}

async function waitForPath(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('trusted public release guard exists and exposes the fail-closed command contract', () => {
  assert.equal(fs.existsSync(guardPath), true, 'trusted public release guard script must exist');
  const source = fs.readFileSync(guardPath, 'utf8');
  assert.match(source, /^set -eEuo pipefail$/m);
  assert.match(source, /close\|watch\|read-record\|assert-start-allowed/);
  assert.match(source, /"\$SYSTEMCTL" stop nginx/);
  assert.match(source, /"\$SYSTEMCTL" kill --kill-who=all --signal=KILL nginx/);
  assert.match(source, /"\$SS" -H -ltn/);
  assert.match(source, /force_stop_public_listener \|\| return 1/);
  assert.match(source, /write_guard_state closed \|\| return \$\?/);
  assert.match(source, /validate_state_file\(\) \{[\s\S]*?run_state_transaction validate/);
  assert.match(source, /validate_maintenance_source\(\) \{[\s\S]*?test -f "\$MaintenanceSource" \|\| return 1/);
  assert.match(source, /os\.O_NOFOLLOW/);
  assert.match(source, /os\.listxattr\(file_fd\)/);
  assert.match(source, /os\.replace\(next_name, state_name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd\)/);
  assert.match(source, /os\.fsync\(directory_fd\)/);
  assert.match(source, /lock_name = state_name \+ "\.transaction-lock"/);
  assert.match(source, /fcntl\.flock\(lock_fd, fcntl\.LOCK_EX\)/);
  assert.match(source, /transaction_lock_fd = acquire_transaction_lock\(\)/);
  assert.match(source, /write_guard_state closed/);
  assert.match(source, /trap ['"]watchdog_signal_close 129['"] HUP/);
  assert.match(source, /trap ['"]watchdog_signal_close 143['"] TERM/);
  assert.match(source, /--property="ProtectHome=read-only"/);
  assert.match(source, /--property="ReadWritePaths=\$\(dirname "\$StateFile"\) \/etc\/nginx\/sites-available \/etc\/nginx\/sites-enabled"/);
});

test('read-record returns only a canonical no-follow transaction-locked state record', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
}, () => {
  const harness = createHarness();
  const deadline = Math.floor(Date.now() / 1000) + 60;
  const record = `armed|${watchUnit}|123|456|${deadline}`;
  writeGuardRecord(harness.paths.state, record);
  const accepted = runGuard('read-record', harness);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.deepEqual(accepted.stdout.split(/\r?\n/).filter(Boolean), [record]);

  if (hasNativeSymlinks) {
    const target = path.join(harness.paths.root, 'attacker-state');
    writeGuardRecord(target, 'closed');
    fs.rmSync(harness.paths.state);
    fs.symlinkSync(target, harness.paths.state);
    const rejected = runGuard('read-record', harness);
    assert.notEqual(rejected.status, 0, 'read-record must reject a symlink state inode');
  }
});

test('reload failure stops Nginx, verifies port 80 closed, and persists closed state', {
  skip: !hasBash ? 'requires Bash' : false,
}, () => {
  const harness = createHarness();
  const result = runGuard('close', harness, [], { TM_PUBLIC_GUARD_MOCK_RELOAD_FAIL: '1' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), 'closed\n');
  const log = fs.readFileSync(harness.paths.log, 'utf8');
  assert.match(log, /^systemctl:reload nginx$/m);
  assert.match(log, /^systemctl:stop nginx$/m);
  assert.match(log, /^systemctl:kill --kill-who=all --signal=KILL nginx$/m);
  assert.match(log, /^ss:-H -ltn/m);
});

test('listener inspection failure never persists a closed public state', {
  skip: !hasBash ? 'requires Bash' : false,
}, () => {
  const harness = createHarness();
  const result = runGuard('close', harness, [], {
    TM_PUBLIC_GUARD_MOCK_RELOAD_FAIL: '1',
    TM_PUBLIC_GUARD_MOCK_SS_FAIL: '1',
  });
  assert.notEqual(result.status, 0, 'an unavailable listener probe must fail closed');
  assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), 'armed\n');
  const log = fs.readFileSync(harness.paths.log, 'utf8');
  assert.match(log, /^systemctl:stop nginx$/m);
  assert.match(log, /^ss:-H -ltn/m);
});

test('watchdog closes an armed public gate after HUP, TERM, KILL, or persisted-owner loss', {
  skip: !hasBash ? 'requires Bash process signals' : false,
}, () => {
  for (const signal of ['HUP', 'TERM', 'KILL']) {
    const harness = createHarness();
    const script = `
set -euo pipefail
sleep 30 &
controller=$!
start_ticks="$(awk '{print $22}' "/proc/$controller/stat")"
deadline="$(( $(date +%s) + 30 ))"
printf 'armed|%s|%s|%s|%s\\n' ${shellQuote(watchUnit)} "$controller" "$start_ticks" "$deadline" > ${shellQuote(bashPath(harness.paths.state))}
${shellQuote(bashPath(guardPath))} watch ${harness.commonArgs.map(shellQuote).join(' ')} \\
  --unit ${shellQuote(watchUnit)} --controller-pid "$controller" --controller-start-ticks "$start_ticks" \\
  --deadline-epoch "$deadline" &
watchdog=$!
sleep 0.2
kill -${signal} "$controller" 2>/dev/null || true
wait "$watchdog"
test "$(cat ${shellQuote(bashPath(harness.paths.state))})" = closed
`;
    const result = spawnSync(bash, ['-c', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: harness.env,
    });
    assert.equal(result.status, 0, `${signal}: ${result.stderr || result.stdout}`);
  }

  const persisted = createHarness();
  const persistedDeadline = Math.floor(Date.now() / 1000) + 30;
  fs.writeFileSync(persisted.paths.state, `armed|${watchUnit}|999999|1|${persistedDeadline}\n`);
  const result = runGuard('watch', persisted, [
    '--unit', watchUnit,
    '--controller-pid', '999999',
    '--controller-start-ticks', '1',
    '--deadline-epoch', String(persistedDeadline),
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(persisted.paths.state, 'utf8'), 'closed\n');
});

test('watchdog signal traps close the public gate before returning the signal status', {
  skip: !hasBash ? 'requires Bash process signals' : false,
}, () => {
  for (const [signal, expectedStatus] of [['HUP', 129], ['TERM', 143]]) {
    const harness = createHarness();
    const script = `
set -euo pipefail
sleep 30 &
controller=$!
start_ticks="$(awk '{print $22}' "/proc/$controller/stat")"
deadline="$(( $(date +%s) + 30 ))"
printf 'armed|%s|%s|%s|%s\\n' ${shellQuote(watchUnit)} "$controller" "$start_ticks" "$deadline" > ${shellQuote(bashPath(harness.paths.state))}
${shellQuote(bashPath(guardPath))} watch ${harness.commonArgs.map(shellQuote).join(' ')} --unit ${shellQuote(watchUnit)} --controller-pid "$controller" --controller-start-ticks "$start_ticks" --deadline-epoch "$deadline" &
watchdog=$!
sleep 3
kill -${signal} "$watchdog"
set +e
wait "$watchdog"
status=$?
set -e
kill -KILL "$controller" 2>/dev/null || true
wait "$controller" 2>/dev/null || true
test "$status" = "${expectedStatus}"
test "$(cat ${shellQuote(bashPath(harness.paths.state))})" = closed
`;
    const result = spawnSync(bash, ['-c', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: harness.env,
    });
    assert.equal(result.status, 0, `${signal}: ${result.stderr || result.stdout}`);
  }
});

test('watchdog signal close failure retains armed state and returns the guard failure status', {
  skip: !hasBash ? 'requires Bash process signals' : false,
}, () => {
  for (const signal of ['HUP', 'TERM']) {
    const harness = createHarness();
    const script = `
set -euo pipefail
sleep 30 &
controller=$!
start_ticks="$(awk '{print $22}' "/proc/$controller/stat")"
deadline="$(( $(date +%s) + 30 ))"
printf 'armed|%s|%s|%s|%s\\n' ${shellQuote(watchUnit)} "$controller" "$start_ticks" "$deadline" > ${shellQuote(bashPath(harness.paths.state))}
${shellQuote(bashPath(guardPath))} watch ${harness.commonArgs.map(shellQuote).join(' ')} --unit ${shellQuote(watchUnit)} --controller-pid "$controller" --controller-start-ticks "$start_ticks" --deadline-epoch "$deadline" &
watchdog=$!
sleep 3
kill -${signal} "$watchdog"
set +e
wait "$watchdog"
status=$?
set -e
kill -KILL "$controller" 2>/dev/null || true
wait "$controller" 2>/dev/null || true
test "$status" = "125"
test "$(cat ${shellQuote(bashPath(harness.paths.state))})" = "armed|${watchUnit}|$controller|$start_ticks|$deadline"
`;
    const result = spawnSync(bash, ['-c', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...harness.env,
        TM_PUBLIC_GUARD_MOCK_RELOAD_FAIL: '1',
        TM_PUBLIC_GUARD_MOCK_SS_FAIL: '1',
      },
    });
    assert.equal(result.status, 0, `${signal}: ${result.stderr || result.stdout}`);
  }
});

test('watchdog state persistence failure cannot publish closed from a conditional trap path', {
  skip: !hasBash ? 'requires Bash process signals' : false,
}, () => {
  for (const signal of ['HUP', 'TERM']) {
    const harness = createHarness();
    const script = `
set -euo pipefail
sleep 30 &
controller=$!
start_ticks="$(awk '{print $22}' "/proc/$controller/stat")"
deadline="$(( $(date +%s) + 30 ))"
printf 'armed|%s|%s|%s|%s\\n' ${shellQuote(watchUnit)} "$controller" "$start_ticks" "$deadline" > ${shellQuote(bashPath(harness.paths.state))}
${shellQuote(bashPath(guardPath))} watch ${harness.commonArgs.map(shellQuote).join(' ')} --unit ${shellQuote(watchUnit)} --controller-pid "$controller" --controller-start-ticks "$start_ticks" --deadline-epoch "$deadline" &
watchdog=$!
sleep 3
kill -${signal} "$watchdog"
set +e
wait "$watchdog"
status=$?
set -e
kill -KILL "$controller" 2>/dev/null || true
wait "$controller" 2>/dev/null || true
test "$status" = "125"
test "$(cat ${shellQuote(bashPath(harness.paths.state))})" = "armed|${watchUnit}|$controller|$start_ticks|$deadline"
`;
    const result = spawnSync(bash, ['-c', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...harness.env,
        TM_PUBLIC_GUARD_TEST_STATE_FSYNC_FAIL: '1',
      },
    });
    assert.equal(result.status, 0, `${signal}: ${result.stderr || result.stdout}`);
  }
});

test('arming installs the persistent Nginx barrier and restartable systemd watchdog', {
  skip: !hasBash ? 'requires Bash' : false,
}, () => {
  const harness = createHarness();
  const dropIn = path.join(harness.paths.root, 'etc', 'systemd', 'nginx.service.d', '90-turingmarket-public-guard.conf');
  const unit = 'turingmarket-cutover-public-guard-0123456789abcdef0123456789abcdef.service';
  const deadline = Math.floor(Date.now() / 1000) + 30;
  writeGuardRecord(harness.paths.state, 'closed');
  const result = runGuard('arm', harness, [
    '--unit', unit,
    '--controller-pid', '123',
    '--controller-start-ticks', '456',
    '--deadline-epoch', String(deadline),
    '--drop-in', bashPath(dropIn),
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.readFileSync(harness.paths.state, 'utf8'),
    `armed|${unit}|123|456|${deadline}\n`,
    'armed state must bind the exact transient identity and deadline'
  );
  const dropInSource = fs.readFileSync(dropIn, 'utf8');
  assert.match(dropInSource, /^ExecStartPre=.*assert-start-allowed.*--state-file.*--maintenance-config.*--site-link/m);
  const log = fs.readFileSync(harness.paths.log, 'utf8');
  assert.match(log, new RegExp(`^systemd-run:.*--unit=${unit.replaceAll('.', '\\.')}`, 'm'));
  assert.match(log, /--property=Restart=on-failure/);
  assert.doesNotMatch(log, /--property=RuntimeMaxSec=/);
  assert.match(log, /--property=ProtectHome=read-only/);
  assert.match(log, /public_release_guard\.sh watch/);
});

test('watchdog survives the former runtime cap and restores maintenance after controller hard death during public activation', {
  skip: !hasBash ? 'requires Bash process control' : false,
}, () => {
  const harness = createLiveWatchdogHarness();
  const dropIn = path.join(harness.paths.root, 'etc', 'systemd', 'nginx.service.d', '90-turingmarket-public-guard.conf');
  const unit = 'turingmarket-restore-public-guard-0123456789abcdef0123456789abcdef.service';
  writeGuardRecord(harness.paths.state, 'closed');
  const script = `
set -euo pipefail
sleep 30 &
controller=$!
cleanup() {
  kill -KILL "$controller" 2>/dev/null || true
  if test -f ${shellQuote(bashPath(path.join(harness.paths.root, 'watchdog.pid')))}; then
    kill -KILL "$(cat ${shellQuote(bashPath(path.join(harness.paths.root, 'watchdog.pid')))})" 2>/dev/null || true
  fi
}
trap cleanup EXIT
start_ticks="$(awk '{print $22}' "/proc/$controller/stat")"
deadline="$(( $(date +%s) + 20 ))"
${shellQuote(bashPath(guardPath))} arm ${harness.commonArgs.map(shellQuote).join(' ')} \\
  --unit ${shellQuote(unit)} --controller-pid "$controller" --controller-start-ticks "$start_ticks" \\
  --deadline-epoch "$deadline" --drop-in ${shellQuote(bashPath(dropIn))}
sleep 1.5
${shellQuote(bashPath(guardPath))} verify-armed ${harness.commonArgs.map(shellQuote).join(' ')} \\
  --unit ${shellQuote(unit)} --controller-pid "$controller" --controller-start-ticks "$start_ticks" \\
  --deadline-epoch "$deadline" --drop-in ${shellQuote(bashPath(dropIn))}
printf '%s\\n' PUBLIC_RELEASE > ${shellQuote(bashPath(harness.paths.site))}
kill -KILL "$controller"
wait "$controller" 2>/dev/null || true
for _attempt in $(seq 1 100); do
  if test "$(cat ${shellQuote(bashPath(harness.paths.state))})" = closed && \\
     test "$(cat ${shellQuote(bashPath(harness.paths.site))})" = ${shellQuote(bashPath(harness.paths.maintenance))}; then
    exit 0
  fi
  sleep 0.05
done
exit 1
`;
  const result = spawnSync(bash, ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...harness.env,
      TM_PUBLIC_GUARD_TEST_INTERVAL: '0.05',
      TM_PUBLIC_GUARD_TEST_OLD_CAP_SECONDS: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), 'closed\n');
});

test('watchdog closes immediately when durable armed identity does not match its transient unit', {
  skip: !hasBash ? 'requires Bash process control' : false,
}, () => {
  const harness = createHarness();
  const expectedUnit = 'turingmarket-restore-public-guard-0123456789abcdef0123456789abcdef.service';
  const wrongUnit = 'turingmarket-resume-public-guard-fedcba9876543210fedcba9876543210.service';
  const script = `
set -euo pipefail
sleep 30 &
controller=$!
watchdog=''
cleanup() {
  test -z "$watchdog" || kill -KILL "$watchdog" 2>/dev/null || true
  kill -KILL "$controller" 2>/dev/null || true
}
trap cleanup EXIT
start_ticks="$(awk '{print $22}' "/proc/$controller/stat")"
deadline="$(( $(date +%s) + 30 ))"
printf 'armed|%s|%s|%s|%s\\n' ${shellQuote(wrongUnit)} "$controller" "$start_ticks" "$deadline" > ${shellQuote(bashPath(harness.paths.state))}
${shellQuote(bashPath(guardPath))} watch ${harness.commonArgs.map(shellQuote).join(' ')} \\
  --unit ${shellQuote(expectedUnit)} --controller-pid "$controller" --controller-start-ticks "$start_ticks" \\
  --deadline-epoch "$deadline" &
watchdog=$!
for _attempt in $(seq 1 100); do
  if ! kill -0 "$watchdog" 2>/dev/null; then break; fi
  sleep 0.1
done
if kill -0 "$watchdog" 2>/dev/null; then exit 1; fi
wait "$watchdog"
test "$(cat ${shellQuote(bashPath(harness.paths.state))})" = closed
`;
  const result = spawnSync(bash, ['-c', script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...harness.env, TM_PUBLIC_GUARD_TEST_INTERVAL: '0.05' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Nginx start barrier permits only a durably verified public gate', {
  skip: !hasBash ? 'requires Bash' : false,
}, () => {
  const harness = createHarness();
  const armed = runGuard('assert-start-allowed', harness);
  assert.notEqual(armed.status, 0, 'armed public state must block Nginx start');
  fs.writeFileSync(harness.paths.state, 'verified\n');
  const verified = runGuard('assert-start-allowed', harness);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
});

test('closed Nginx start barrier permits only the exact maintenance link', {
  skip: !hasBash || !hasNativeSymlinks ? 'requires Bash and native symlinks' : false,
}, () => {
  const harness = createHarness();
  const publicConfig = path.join(harness.paths.root, 'public.conf');
  fs.writeFileSync(harness.paths.maintenance, 'MAINTENANCE\n');
  fs.writeFileSync(publicConfig, 'PUBLIC\n');
  writeGuardRecord(harness.paths.state, 'closed');
  fs.rmSync(harness.paths.site);
  fs.symlinkSync(harness.paths.maintenance, harness.paths.site);

  const maintenance = runGuard('assert-start-allowed', harness);
  assert.equal(maintenance.status, 0, maintenance.stderr || maintenance.stdout);

  fs.rmSync(harness.paths.site);
  fs.symlinkSync(publicConfig, harness.paths.site);
  const publicRelease = runGuard('assert-start-allowed', harness);
  assert.notEqual(publicRelease.status, 0, 'closed state must reject a non-maintenance Nginx link');
});

test('a concurrent verified transition cannot overwrite a committed closed state', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
  timeout: 30_000,
}, () => {
  const harness = createHarness();
  const deadline = Math.floor(Date.now() / 1000) + 60;
  const unit = 'turingmarket-finalize-public-guard-0123456789abcdef0123456789abcdef.service';
  const identityArgs = guardArmArgs(harness, unit, deadline);
  writeGuardRecord(harness.paths.state, `armed|${unit}|123|456|${deadline}`);
  fs.writeFileSync(path.join(harness.paths.root, 'watchdog.unit'), `${unit}\n`);

  const ready = path.join(harness.paths.root, 'close-state-read.ready');
  const release = path.join(harness.paths.root, 'close-state-read.release');
  const closeStatus = path.join(harness.paths.root, 'close.status');
  const disarmStatus = path.join(harness.paths.root, 'concurrent-disarm.status');
  const disarmError = path.join(harness.paths.root, 'concurrent-disarm.err');
  const closeCommand = [bashPath(guardPath), 'close', ...harness.commonArgs].map(shellQuote).join(' ');
  const disarmCommand = [bashPath(guardPath), 'disarm', ...harness.commonArgs, ...identityArgs]
    .map(shellQuote).join(' ');
  const result = spawnSync(bash, ['-c', `
set -euo pipefail
(
  export TM_PUBLIC_GUARD_TEST_PAUSE_AFTER_STATE_READ_ACTION=write
  export TM_PUBLIC_GUARD_TEST_PAUSE_READY=${shellQuote(bashPath(ready))}
  export TM_PUBLIC_GUARD_TEST_PAUSE_RELEASE=${shellQuote(bashPath(release))}
  ${closeCommand}
) > /dev/null &
close_pid=$!
disarm_pid=''
cleanup() {
  kill -KILL "$close_pid" 2>/dev/null || true
  test -z "$disarm_pid" || kill -KILL "$disarm_pid" 2>/dev/null || true
}
trap cleanup EXIT
for _attempt in $(seq 1 500); do
  test -e ${shellQuote(bashPath(ready))} && break
  sleep 0.01
done
test -e ${shellQuote(bashPath(ready))}
${disarmCommand} > /dev/null 2> ${shellQuote(bashPath(disarmError))} &
disarm_pid=$!
sleep 0.25
kill -0 "$disarm_pid"
printf 'release\n' > ${shellQuote(bashPath(release))}
set +e
wait "$close_pid"; close_status=$?
wait "$disarm_pid"; disarm_status=$?
set -e
printf '%s\n' "$close_status" > ${shellQuote(bashPath(closeStatus))}
printf '%s\n' "$disarm_status" > ${shellQuote(bashPath(disarmStatus))}
trap - EXIT
`], { encoding: 'utf8', timeout: 30_000, env: harness.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(closeStatus, 'utf8').trim(), '0');
  assert.notEqual(fs.readFileSync(disarmStatus, 'utf8').trim(), '0',
    'verified must be rejected after closed commits');
  assert.match(fs.readFileSync(disarmError, 'utf8'), /Invalid public guard state transition/);
  assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), 'closed\n');
});

test('accepted finalization stays armed after 120 seconds through verification and disarm', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
}, () => {
  const deploy = fs.readFileSync(deployPath, 'utf8');
  const parserTimeout = Number(deploy.match(/\$PARSER_STARTUP_TIMEOUT_SECONDS\s*=\s*(\d+)/)?.[1]);
  const legacyGuardTimeout = Number(deploy.match(/\$PUBLIC_GUARD_TIMEOUT_SECONDS\s*=\s*(\d+)/)?.[1]);
  const finalizeTimeout = Number(
    deploy.match(/\$ACCEPTED_FINALIZE_PUBLIC_GUARD_TIMEOUT_SECONDS\s*=\s*(\d+)/)?.[1]
  );
  assert.ok(Number.isInteger(parserTimeout) && parserTimeout > 120);
  assert.ok(Number.isInteger(legacyGuardTimeout) && legacyGuardTimeout === 120);
  assert.ok(Number.isInteger(finalizeTimeout), 'accepted finalization needs a dedicated watchdog timeout');
  assert.equal(finalizeTimeout, 7200, 'accepted finalization must retain the documented two-hour bound');
  assert.ok(
    finalizeTimeout > parserTimeout + legacyGuardTimeout,
    'accepted finalization must cover the full parser startup window and final verification budget'
  );

  const finalizer = deploy.match(
    /function Invoke-RemoteAcceptedFinalize \{[\s\S]*?\$remoteScript\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/
  );
  assert.ok(finalizer, 'accepted finalizer Bash must exist');
  assert.match(
    finalizer[1],
    /FinalizeGuardDeadline="\$\(\( \$\(date \+%s\) \+ __ACCEPTED_FINALIZE_PUBLIC_GUARD_TIMEOUT_SECONDS__ \)\)"/
  );
  assert.match(
    deploy,
    /Replace\('__ACCEPTED_FINALIZE_PUBLIC_GUARD_TIMEOUT_SECONDS__', \$ACCEPTED_FINALIZE_PUBLIC_GUARD_TIMEOUT_SECONDS\.ToString\(\)\)/
  );
  const expandedFinalizer = finalizer[1].replaceAll(
    '__ACCEPTED_FINALIZE_PUBLIC_GUARD_TIMEOUT_SECONDS__',
    String(finalizeTimeout)
  );
  assert.doesNotMatch(expandedFinalizer, /__ACCEPTED_FINALIZE_PUBLIC_GUARD_TIMEOUT_SECONDS__/);
  assert.match(expandedFinalizer, /FinalizeGuardDeadline="\$\(\( \$\(date \+%s\) \+ 7200 \)\)"/);

  const healthyElapsed = legacyGuardTimeout + 30;
  const verificationElapsed = healthyElapsed + legacyGuardTimeout;
  assert.ok(healthyElapsed < parserTimeout, 'mocked health must arrive inside the supported startup window');
  assert.ok(verificationElapsed < finalizeTimeout, 'final verification must remain inside the dedicated deadline');

  const verificationEpoch = Math.floor(Date.now() / 1000);
  const startEpoch = verificationEpoch - verificationElapsed;
  const harness = createHarness();
  const unit = 'turingmarket-finalize-public-guard-0123456789abcdef0123456789abcdef.service';
  const deadline = startEpoch + finalizeTimeout;
  const identityArgs = guardArmArgs(harness, unit, deadline);
  const dropIn = path.join(
    harness.paths.root, 'etc', 'systemd', 'nginx.service.d',
    '90-turingmarket-public-guard.conf'
  );
  fs.mkdirSync(path.dirname(dropIn), { recursive: true });
  fs.writeFileSync(dropIn, 'START_BARRIER\n');
  writeGuardRecord(harness.paths.state, `armed|${unit}|123|456|${deadline}`);
  fs.writeFileSync(path.join(harness.paths.root, 'watchdog.unit'), `${unit}\n`);
  const verified = runGuard('verify-armed', harness, identityArgs);
  assert.equal(verified.status, 0, JSON.stringify({
    stdout: verified.stdout,
    stderr: verified.stderr,
    error: verified.error?.message,
  }));
  assert.equal(
    fs.readFileSync(harness.paths.state, 'utf8'),
    `armed|${unit}|123|456|${deadline}\n`,
    'guard must remain armed after the legacy 120-second window'
  );

  const disarmed = runGuard('disarm', harness, identityArgs);
  assert.equal(disarmed.status, 0, JSON.stringify({
    stdout: disarmed.stdout,
    stderr: disarmed.stderr,
    error: disarmed.error?.message,
  }));
  assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), 'verified\n');
  assert.equal(fs.existsSync(dropIn), false, 'successful disarm removes the start barrier');
});

test('disarm retains the Nginx start barrier when watchdog close wins after verified is durable', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
  timeout: 30_000,
}, () => {
  const harness = createHarness();
  const deadline = Math.floor(Date.now() / 1000) + 60;
  const unit = 'turingmarket-finalize-public-guard-0123456789abcdef0123456789abcdef.service';
  const identityArgs = guardArmArgs(harness, unit, deadline);
  const dropIn = path.join(
    harness.paths.root, 'etc', 'systemd', 'nginx.service.d',
    '90-turingmarket-public-guard.conf'
  );
  fs.mkdirSync(path.dirname(dropIn), { recursive: true });
  fs.writeFileSync(dropIn, 'START_BARRIER\n');
  writeGuardRecord(harness.paths.state, `armed|${unit}|123|456|${deadline}`);
  fs.writeFileSync(path.join(harness.paths.root, 'watchdog.unit'), `${unit}\n`);

  const ready = path.join(harness.paths.root, 'disarm-is-active.ready');
  const disarmStatus = path.join(harness.paths.root, 'disarm.status');
  const disarmError = path.join(harness.paths.root, 'disarm.err');
  const guardCommand = [bashPath(guardPath), 'disarm', ...harness.commonArgs, ...identityArgs]
    .map(shellQuote).join(' ');
  const closeCommand = [bashPath(guardPath), 'close', ...harness.commonArgs]
    .map(shellQuote).join(' ');
  const result = spawnSync(bash, ['-c', `
set -euo pipefail
${guardCommand} > /dev/null 2> ${shellQuote(bashPath(disarmError))} &
disarm_pid=$!
cleanup() { kill -KILL "$disarm_pid" 2>/dev/null || true; }
trap cleanup EXIT
for _attempt in $(seq 1 500); do
  test -e ${shellQuote(bashPath(ready))} && break
  sleep 0.01
done
test -e ${shellQuote(bashPath(ready))}
test "$(cat ${shellQuote(bashPath(harness.paths.state))})" = verified
${closeCommand} > /dev/null
set +e
wait "$disarm_pid"
status=$?
set -e
printf '%s\n' "$status" > ${shellQuote(bashPath(disarmStatus))}
trap - EXIT
`], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...harness.env, TM_PUBLIC_GUARD_MOCK_DISARM_CLOSE_RACE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.notEqual(fs.readFileSync(disarmStatus, 'utf8').trim(), '0',
    'closed must invalidate the pending disarm');
  assert.match(fs.readFileSync(disarmError, 'utf8'), /Public guard state changed after watchdog exit/);
  assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), 'closed\n');
  assert.equal(fs.existsSync(dropIn), true, 'closed state must retain the Nginx start barrier');
});

test('state transaction retries converge after every durable crash window for closed, bound armed, and verified', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
}, () => {
  const crashPoints = [
    'after-create-write',
    'after-file-fsync',
    'before-rename',
    'after-rename-before-directory-fsync',
  ];

  for (const crashPoint of crashPoints) {
    const closedHarness = createHarness();
    const closedCrash = runGuard('close', closedHarness, [], {
      TM_PUBLIC_GUARD_TEST_CRASH_POINT: crashPoint,
    });
    assert.equal(closedCrash.status, 86, `closed/${crashPoint}: ${closedCrash.stderr || closedCrash.stdout}`);
    const closedRetry = runGuard('close', closedHarness);
    assert.equal(closedRetry.status, 0, `closed retry/${crashPoint}: ${closedRetry.stderr || closedRetry.stdout}`);
    assert.equal(fs.readFileSync(closedHarness.paths.state, 'utf8'), 'closed\n');
    assert.equal(fs.existsSync(closedHarness.paths.stateNext), false);

    const armedHarness = createHarness();
    assert.equal(runGuard('close', armedHarness).status, 0);
    const armedUnit = 'turingmarket-resume-public-guard-0123456789abcdef0123456789abcdef.service';
    const armedDeadline = Math.floor(Date.now() / 1000) + 60;
    const armedArgs = guardArmArgs(armedHarness, armedUnit, armedDeadline);
    const armedCrash = runGuard('arm', armedHarness, armedArgs, {
      TM_PUBLIC_GUARD_TEST_CRASH_POINT: crashPoint,
    });
    assert.equal(armedCrash.status, 86, `armed/${crashPoint}: ${armedCrash.stderr || armedCrash.stdout}`);
    const armedRetry = runGuard('arm', armedHarness, armedArgs);
    assert.equal(armedRetry.status, 0, `armed retry/${crashPoint}: ${armedRetry.stderr || armedRetry.stdout}`);
    assert.equal(
      fs.readFileSync(armedHarness.paths.state, 'utf8'),
      `armed|${armedUnit}|123|456|${armedDeadline}\n`
    );
    assert.equal(fs.existsSync(armedHarness.paths.stateNext), false);

    const verifiedHarness = createHarness();
    assert.equal(runGuard('close', verifiedHarness).status, 0);
    const verifiedUnit = 'turingmarket-finalize-public-guard-0123456789abcdef0123456789abcdef.service';
    const verifiedDeadline = Math.floor(Date.now() / 1000) + 60;
    const verifiedArgs = guardArmArgs(verifiedHarness, verifiedUnit, verifiedDeadline);
    assert.equal(runGuard('arm', verifiedHarness, verifiedArgs).status, 0);
    const verifiedCrash = runGuard('disarm', verifiedHarness, verifiedArgs, {
      TM_PUBLIC_GUARD_TEST_CRASH_POINT: crashPoint,
    });
    assert.equal(verifiedCrash.status, 86, `verified/${crashPoint}: ${verifiedCrash.stderr || verifiedCrash.stdout}`);
    const verifiedRetry = runGuard('disarm', verifiedHarness, verifiedArgs);
    assert.equal(verifiedRetry.status, 0, `verified retry/${crashPoint}: ${verifiedRetry.stderr || verifiedRetry.stdout}`);
    assert.equal(fs.readFileSync(verifiedHarness.paths.state, 'utf8'), 'verified\n');
    assert.equal(fs.existsSync(verifiedHarness.paths.stateNext), false);
  }
});

test('rollback, resume, finalize, and initial cutover discard only provably represented residues', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
}, () => {
  const deadline = Math.floor(Date.now() / 1000) + 60;
  const unit = 'turingmarket-restore-public-guard-0123456789abcdef0123456789abcdef.service';
  const armedRecord = `armed|${unit}|123|456|${deadline}`;

  const partial = createHarness();
  fs.writeFileSync(partial.paths.stateNext, 'clo', { mode: 0o600 });
  fs.chmodSync(partial.paths.stateNext, 0o600);
  const partialResult = runGuard('close', partial);
  assert.equal(partialResult.status, 0, partialResult.stderr || partialResult.stdout);
  assert.equal(fs.readFileSync(partial.paths.state, 'utf8'), 'closed\n');
  assert.equal(fs.existsSync(partial.paths.stateNext), false);

  const rollback = createHarness();
  writeGuardRecord(rollback.paths.state, armedRecord);
  writeGuardRecord(rollback.paths.stateNext, armedRecord);
  const rollbackResult = runGuard('close', rollback);
  assert.equal(rollbackResult.status, 0, rollbackResult.stderr || rollbackResult.stdout);
  assert.equal(fs.readFileSync(rollback.paths.state, 'utf8'), 'closed\n');
  assert.equal(fs.existsSync(rollback.paths.stateNext), false);

  for (const lifecycle of ['resume', 'initial-cutover']) {
    const harness = createHarness();
    writeGuardRecord(harness.paths.state, 'closed');
    writeGuardRecord(harness.paths.stateNext, 'closed');
    const args = guardArmArgs(harness, unit, deadline);
    const result = runGuard('arm', harness, args);
    assert.equal(result.status, 0, `${lifecycle}: ${result.stderr || result.stdout}`);
    assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), `${armedRecord}\n`);
    assert.equal(fs.existsSync(harness.paths.stateNext), false);
  }

  const finalize = createHarness();
  writeGuardRecord(finalize.paths.state, armedRecord);
  writeGuardRecord(finalize.paths.stateNext, armedRecord);
  const finalizeResult = runGuard('disarm', finalize, guardArmArgs(finalize, unit, deadline));
  assert.equal(finalizeResult.status, 0, finalizeResult.stderr || finalizeResult.stdout);
  assert.equal(fs.readFileSync(finalize.paths.state, 'utf8'), 'verified\n');
  assert.equal(fs.existsSync(finalize.paths.stateNext), false);
});

test('a complete recovered residue is fsynced before it can be published', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
}, () => {
  const harness = createHarness();
  const deadline = Math.floor(Date.now() / 1000) + 60;
  const unit = 'turingmarket-resume-public-guard-0123456789abcdef0123456789abcdef.service';
  const armedRecord = `armed|${unit}|123|456|${deadline}`;
  writeGuardRecord(harness.paths.state, 'closed');
  writeGuardRecord(harness.paths.stateNext, armedRecord);

  const failed = runGuard('arm', harness, guardArmArgs(harness, unit, deadline), {
    TM_PUBLIC_GUARD_TEST_STATE_FSYNC_FAIL: '1',
  });
  assert.notEqual(failed.status, 0, 'recovery must not publish an unsynced residue');
  assert.match(failed.stderr, /Injected public guard state fsync failure/);
  assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), 'closed\n');
  assert.equal(fs.readFileSync(harness.paths.stateNext, 'utf8'), `${armedRecord}\n`);

  const retry = runGuard('arm', harness, guardArmArgs(harness, unit, deadline));
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), `${armedRecord}\n`);
  assert.equal(fs.existsSync(harness.paths.stateNext), false);
});

test('rollback and a replacement controller recover a trusted torn armed residue', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
}, () => {
  const deadline = Math.floor(Date.now() / 1000) + 60;
  const oldUnit = 'turingmarket-restore-public-guard-00000000000000000000000000000000.service';
  const newUnit = 'turingmarket-resume-public-guard-11111111111111111111111111111111.service';
  const crashEnv = { TM_PUBLIC_GUARD_TEST_CRASH_AFTER_BYTES: '57' };

  const rollback = createHarness();
  writeGuardRecord(rollback.paths.state, 'closed');
  const rollbackCrash = runGuard('arm', rollback, guardArmArgs(rollback, oldUnit, deadline), crashEnv);
  assert.equal(rollbackCrash.status, 86, rollbackCrash.stderr || rollbackCrash.stdout);
  const tornPayload = fs.readFileSync(rollback.paths.stateNext);
  assert.equal(tornPayload.length, 57);
  assert.notEqual(tornPayload.at(-1), 0x0a, 'fixture must retain a truly torn record');
  const rollbackRetry = runGuard('close', rollback);
  assert.equal(rollbackRetry.status, 0, rollbackRetry.stderr || rollbackRetry.stdout);
  assert.equal(fs.readFileSync(rollback.paths.state, 'utf8'), 'closed\n');
  assert.equal(fs.existsSync(rollback.paths.stateNext), false);

  const replacement = createHarness();
  writeGuardRecord(replacement.paths.state, 'closed');
  const replacementCrash = runGuard(
    'arm', replacement, guardArmArgs(replacement, oldUnit, deadline), crashEnv
  );
  assert.equal(replacementCrash.status, 86, replacementCrash.stderr || replacementCrash.stdout);
  const replacementRetry = runGuard(
    'arm', replacement, guardArmArgs(replacement, newUnit, deadline)
  );
  assert.equal(replacementRetry.status, 0, replacementRetry.stderr || replacementRetry.stdout);
  assert.equal(
    fs.readFileSync(replacement.paths.state, 'utf8'),
    `armed|${newUnit}|123|456|${deadline}\n`
  );
  assert.equal(fs.existsSync(replacement.paths.stateNext), false);
});

test('state transaction rejects untrusted or transition-invalid next residues without deleting them', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
}, () => {
  const deadline = Math.floor(Date.now() / 1000) + 60;
  const unit = 'turingmarket-cutover-public-guard-0123456789abcdef0123456789abcdef.service';
  const cases = [
    {
      name: 'symlink',
      available: hasNativeSymlinks,
      prepare(harness) {
        const target = path.join(harness.paths.lockDir, 'attacker-state');
        writeGuardRecord(target, 'closed');
        fs.symlinkSync(target, harness.paths.stateNext);
      },
    },
    {
      name: 'hardlink',
      prepare(harness) {
        const target = path.join(harness.paths.lockDir, 'attacker-state');
        writeGuardRecord(target, 'closed');
        fs.linkSync(target, harness.paths.stateNext);
      },
    },
    {
      name: 'wrong-mode',
      env: process.platform === 'win32' ? { TM_PUBLIC_GUARD_TEST_EXPECT_RESIDUE_MODE: '600' } : {},
      prepare: harness => writeGuardRecord(harness.paths.stateNext, 'closed', 0o644),
    },
    { name: 'invalid-payload', prepare: harness => writeGuardRecord(harness.paths.stateNext, 'attacker') },
    {
      name: 'extra-newline',
      prepare(harness) {
        fs.writeFileSync(harness.paths.stateNext, 'closed\n\n', { mode: 0o600 });
        fs.chmodSync(harness.paths.stateNext, 0o600);
      },
    },
    {
      name: 'wrong-bound-target',
      prepare(harness) {
        writeGuardRecord(
          harness.paths.stateNext,
          `armed|turingmarket-cutover-public-guard-fedcba9876543210fedcba9876543210.service|123|456|${deadline}`
        );
      },
    },
    {
      name: 'xattr',
      available: hasUserXattrs,
      prepare(harness) {
        writeGuardRecord(harness.paths.stateNext, 'closed');
        const result = spawnSync(python, [
          '-c',
          "import os,sys; os.setxattr(sys.argv[1], b'user.tm_guard_attack', b'1', follow_symlinks=False)",
          harness.paths.stateNext,
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
      },
    },
    {
      name: 'wrong-owner',
      available: canChangeOwner,
      prepare(harness) {
        writeGuardRecord(harness.paths.stateNext, 'closed');
        fs.chownSync(harness.paths.stateNext, 1, 1);
      },
    },
  ];

  for (const fixture of cases.filter(item => item.available !== false)) {
    const harness = createHarness();
    writeGuardRecord(harness.paths.state, 'closed');
    fixture.prepare(harness);
    const args = guardArmArgs(harness, unit, deadline);
    const result = runGuard('arm', harness, args, fixture.env || {});
    assert.notEqual(result.status, 0, `${fixture.name} residue must fail closed`);
    assert.match(result.stderr, /Unsafe public guard state residue|Invalid public guard state transition/);
    assert.doesNotThrow(
      () => fs.lstatSync(harness.paths.stateNext),
      `${fixture.name} residue must not be loosely deleted`
    );
    assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), 'closed\n');
  }

  const illegal = createHarness();
  writeGuardRecord(illegal.paths.state, 'closed');
  writeGuardRecord(illegal.paths.stateNext, 'verified');
  const illegalResult = runGuard('disarm', illegal, guardArmArgs(illegal, unit, deadline));
  assert.notEqual(illegalResult.status, 0);
  assert.match(illegalResult.stderr, /Invalid public guard state transition/);
  assert.equal(fs.existsSync(illegal.paths.stateNext), true);
});

test('state transaction rejects an untrusted lock inode without changing durable state', {
  skip: !hasBash || !hasPython ? 'requires Bash and Python' : false,
}, () => {
  const cases = [
    {
      name: 'symlink',
      available: hasNativeSymlinks,
      prepare(harness) {
        const target = path.join(harness.paths.lockDir, 'attacker-lock');
        fs.writeFileSync(target, '', { mode: 0o600 });
        fs.symlinkSync(target, harness.paths.stateLock);
      },
    },
    {
      name: 'hardlink',
      prepare(harness) {
        const target = path.join(harness.paths.lockDir, 'attacker-lock');
        fs.writeFileSync(target, '', { mode: 0o600 });
        fs.linkSync(target, harness.paths.stateLock);
      },
    },
    {
      name: 'wrong-mode',
      env: process.platform === 'win32' ? { TM_PUBLIC_GUARD_TEST_EXPECT_MODE: '600' } : {},
      prepare(harness) {
        fs.writeFileSync(harness.paths.stateLock, '', { mode: 0o644 });
        fs.chmodSync(harness.paths.stateLock, 0o644);
      },
    },
    {
      name: 'payload',
      prepare: harness => fs.writeFileSync(harness.paths.stateLock, 'not-empty', { mode: 0o600 }),
    },
    {
      name: 'xattr',
      available: hasUserXattrs,
      prepare(harness) {
        fs.writeFileSync(harness.paths.stateLock, '', { mode: 0o600 });
        const result = spawnSync(python, [
          '-c',
          "import os,sys; os.setxattr(sys.argv[1], b'user.tm_guard_attack', b'1', follow_symlinks=False)",
          harness.paths.stateLock,
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
      },
    },
    {
      name: 'wrong-owner',
      available: canChangeOwner,
      prepare(harness) {
        fs.writeFileSync(harness.paths.stateLock, '', { mode: 0o600 });
        fs.chownSync(harness.paths.stateLock, 1, 1);
      },
    },
  ];

  for (const fixture of cases.filter(item => item.available !== false)) {
    const harness = createHarness();
    writeGuardRecord(harness.paths.state, 'closed');
    fixture.prepare(harness);
    const result = runGuard('close', harness, [], fixture.env || {});
    assert.notEqual(result.status, 0, `${fixture.name} lock must fail closed`);
    assert.match(result.stderr, /Unsafe public guard state lock/);
    assert.equal(fs.readFileSync(harness.paths.state, 'utf8'), 'closed\n');
  }
});

test('native root fixture rejects hostile state residue and transaction-lock inodes', {
  skip: !hasNativeRootPython ? 'requires native root Linux and Python' : false,
}, () => {
  const result = runRootLinuxScript(`
set -euo pipefail
Root="/tmp/tm-public-guard-test-native-$$"
Bin="$Root/bin"
State="$Root/lock/public-gate-guard"
Next="$State.next"
Lock="$State.transaction-lock"
Source="$Root/lock/nginx-api-gate.conf"
Maintenance="$Root/etc/nginx/sites-available/turingmarket-maintenance"
Recovery="$Root/lock/nginx-public-guard.link"
Site="$Root/etc/nginx/sites-enabled/turingmarket"
DropIn="$Root/etc/systemd/nginx.service.d/90-turingmarket-public-guard.conf"
Unit='turingmarket-cutover-public-guard-0123456789abcdef0123456789abcdef.service'
cleanup() { rm -rf -- "$Root"; }
trap cleanup EXIT
mkdir -p "$Bin" "$Root/lock" "$(dirname "$Maintenance")" "$(dirname "$Site")"
printf 'CLOSED_API_GATE\n' > "$Source"
printf 'PUBLIC_RELEASE\n' > "$Site"
chmod 0600 "$Source" "$Site"
for command in nginx systemctl systemd-run sync; do
  cat > "$Bin/$command" <<'TM_PUBLIC_GUARD_NATIVE_MOCK'
#!/usr/bin/env bash
exit 0
TM_PUBLIC_GUARD_NATIVE_MOCK
done
cat > "$Bin/curl" <<'TM_PUBLIC_GUARD_NATIVE_CURL'
#!/usr/bin/env bash
printf 503
TM_PUBLIC_GUARD_NATIVE_CURL
cat > "$Bin/ss" <<'TM_PUBLIC_GUARD_NATIVE_SS'
#!/usr/bin/env bash
exit 0
TM_PUBLIC_GUARD_NATIVE_SS
cat > "$Bin/ln" <<'TM_PUBLIC_GUARD_NATIVE_LN'
#!/usr/bin/env bash
/usr/bin/ln "$@"
TM_PUBLIC_GUARD_NATIVE_LN
chmod 0755 "$Bin"/*

reset_state() {
  rm -f -- "$Next" "$Lock" "$Root/attacker"
  printf 'closed\n' > "$State"
  chmod 0600 "$State"
  chown 0:0 "$State"
}
expect_lock_reject() {
  label="$1"
  set +e
  TM_PUBLIC_GUARD_TEST_MODE=1 \
  TM_PUBLIC_GUARD_TEST_ROOT="$Root" \
  TM_PUBLIC_GUARD_TEST_BIN="$Bin" \
  TM_PUBLIC_GUARD_TEST_LOG="$Root/commands.log" \
  TM_PUBLIC_GUARD_TEST_PYTHON=/usr/bin/python3 \
  /bin/bash ${shellQuote(nativeGuardPath())} close \
    --state-file "$State" --maintenance-source "$Source" --maintenance-config "$Maintenance" \
    --recovery-link "$Recovery" --site-link "$Site" \
    >"$Root/$label.out" 2>"$Root/$label.err"
  status=$?
  set -e
  test "$status" != 0
  grep -Fq 'Unsafe public guard state lock' "$Root/$label.err"
  test -e "$Lock" || test -L "$Lock"
  test "$(cat "$State")" = closed
}
expect_reject() {
  label="$1"
  set +e
  TM_PUBLIC_GUARD_TEST_MODE=1 \
  TM_PUBLIC_GUARD_TEST_ROOT="$Root" \
  TM_PUBLIC_GUARD_TEST_BIN="$Bin" \
  TM_PUBLIC_GUARD_TEST_LOG="$Root/commands.log" \
  TM_PUBLIC_GUARD_TEST_PYTHON=/usr/bin/python3 \
  /bin/bash ${shellQuote(nativeGuardPath())} arm \
    --state-file "$State" --maintenance-source "$Source" --maintenance-config "$Maintenance" \
    --recovery-link "$Recovery" --site-link "$Site" --drop-in "$DropIn" \
    --unit "$Unit" --controller-pid 123 --controller-start-ticks 456 --deadline-epoch 9999999999 \
    >"$Root/$label.out" 2>"$Root/$label.err"
  status=$?
  set -e
  test "$status" != 0
  grep -Eq 'Unsafe public guard state residue|Invalid public guard state transition' "$Root/$label.err"
  test -e "$Next" || test -L "$Next"
  test "$(cat "$State")" = closed
}

reset_state
printf 'closed\n' > "$Root/attacker"
chmod 0600 "$Root/attacker"
ln -s "$Root/attacker" "$Next"
expect_reject symlink

reset_state
printf 'closed\n' > "$Root/attacker"
chmod 0600 "$Root/attacker"
ln "$Root/attacker" "$Next"
expect_reject hardlink

reset_state
printf 'closed\n' > "$Next"
chmod 0644 "$Next"
expect_reject mode

reset_state
printf 'closed\n' > "$Next"
chmod 0600 "$Next"
chown 1:1 "$Next"
expect_reject owner

reset_state
printf 'closed\n' > "$Next"
chmod 0600 "$Next"
python3 -c "import os; os.setxattr('$Next', b'user.tm_guard_attack', b'1', follow_symlinks=False)"
expect_reject xattr

reset_state
printf 'closed\n\n' > "$Next"
chmod 0600 "$Next"
expect_reject extra-newline

reset_state
printf 'armed|turingmarket-cutover-public-guard-fedcba9876543210fedcba9876543210.service|123|456|9999999999\n' > "$Next"
chmod 0600 "$Next"
expect_reject wrong-bound-target

reset_state
: > "$Root/attacker"
chmod 0600 "$Root/attacker"
ln -s "$Root/attacker" "$Lock"
expect_lock_reject lock-symlink

reset_state
: > "$Root/attacker"
chmod 0600 "$Root/attacker"
ln "$Root/attacker" "$Lock"
expect_lock_reject lock-hardlink

reset_state
: > "$Lock"
chmod 0644 "$Lock"
expect_lock_reject lock-mode

reset_state
: > "$Lock"
chmod 0600 "$Lock"
chown 1:1 "$Lock"
expect_lock_reject lock-owner

reset_state
: > "$Lock"
chmod 0600 "$Lock"
python3 -c "import os; os.setxattr('$Lock', b'user.tm_guard_attack', b'1', follow_symlinks=False)"
expect_lock_reject lock-xattr

reset_state
printf attack > "$Lock"
chmod 0600 "$Lock"
expect_lock_reject lock-payload

printf '%s\n' NATIVE_PUBLIC_GUARD_SECURITY_FIXTURE_OK
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /NATIVE_PUBLIC_GUARD_SECURITY_FIXTURE_OK/);
});
