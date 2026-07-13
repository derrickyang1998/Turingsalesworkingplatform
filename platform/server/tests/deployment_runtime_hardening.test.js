'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function shellPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
  if (!match) return filePath.replaceAll('\\', '/');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function runBash(source) {
  return spawnSync('bash', ['--noprofile', '--norc', '-s'], {
    encoding: 'utf8',
    input: source,
    timeout: 20_000
  });
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

test('all production and deployment browser launches use the native sandboxed runtime', () => {
  const directLaunchFiles = [
    'platform/server/tests/ppt_bridge_browser_contract.test.js',
    'platform/server/tests/production_browser_evidence_tools.test.js',
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
  const ecosystem = read('platform/ecosystem.config.js');

  assert.match(runtimeConfig, /environment\.TM_ENV_FILE/);
  assert.match(server, /process\.env\.UPLOAD_DIR/);
  assert.match(server, /process\.env\.TMP_DIR/);
  for (const marker of [
    'TM_ENV_FILE: "/etc/turingmarket/turingmarket.env"',
    'DB_PATH: "/var/lib/turingmarket/db/turingmarket.db"',
    'UPLOAD_DIR: "/var/lib/turingmarket/uploads"',
    'TMP_DIR: "/var/lib/turingmarket/tmp"'
  ]) {
    assert.ok(ecosystem.includes(marker), marker);
  }
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
  assert.doesNotMatch(source, /PLAYWRIGHT_HOST_PLATFORM_OVERRIDE/);
  assert.doesNotMatch(source, /(?:tvly|sk)-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
});

test('runtime bootstrap journals before stopping and snapshots only after the process is stopped', () => {
  const source = fs.readFileSync(bootstrapPath, 'utf8');
  const beginIndex = source.lastIndexOf('begin_migration_journal');
  const stopIndex = source.lastIndexOf('\nstop_current_release\n');
  const snapshotIndex = source.lastIndexOf('snapshot_runtime_state');
  const preparedIndex = source.lastIndexOf('set_migration_phase prepared');

  assert.ok(beginIndex > 0, 'persistent migration journal must start before downtime');
  assert.ok(stopIndex > beginIndex, 'PM2 must stop after the journal is durable');
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

test('interrupted prepared migration restores its durable snapshot and validates DB before restart', () => {
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
restart_current_release() { printf 'restart\n' >> "$root/order"; }
recover_interrupted_migration

test "$(cat "$root/live/.env")" = original-env
test "$(cat "$root/live/server/db/turingmarket.db")" = good-db
test "$(cat "$root/live/uploads/item.txt")" = original-upload
test ! -e "$ENV_FILE"
test ! -e "$DB_DIR"
test ! -e "$JOURNAL_DIR"
test "$(sed -n '1p' "$root/order")" = "quickcheck:$root/live/server/db/turingmarket.db"
test "$(sed -n '2p' "$root/order")" = restart
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

mkdir -p "$root/live/server/db" "$root/live/uploads" "$root/live/tmp" "$JOURNAL_DIR"
printf 'untouched' > "$root/live/server/db/turingmarket.db"
printf '%s\n' snapshotting > "$JOURNAL_DIR/phase"
printf '%s\n' "$root/remote/backups/v030-runtime-bootstrap-test" > "$JOURNAL_DIR/backup-dir"
database_quick_check() { return 88; }
stop_current_release() { :; }
restart_current_release() { : > "$root/restarted"; }
recover_interrupted_migration
test "$(cat "$root/live/server/db/turingmarket.db")" = untouched
test -f "$root/restarted"
test ! -e "$JOURNAL_DIR"
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
    'TM_SCHEMA_FINGERPRINT_BEFORE',
    'TM_SCHEMA_FINGERPRINT_AFTER',
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

test('unprivileged gate uses only variables explicitly passed through env -i', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const match = deploy.match(/<<'TM_UNPRIVILEGED_GATE'\r?\n([\s\S]*?)\r?\nTM_UNPRIVILEGED_GATE/);
  assert.ok(match, 'unprivileged gate heredoc must exist');
  const gate = match[1];
  const envBoundary = deploy.slice(deploy.lastIndexOf('timeout --signal=KILL', match.index), match.index);

  assert.match(envBoundary, /DB_PATH="\$TestDb"/);
  assert.doesNotMatch(gate, /\$TestDb\b/, 'parent-shell TestDb is unavailable after env -i');
  assert.match(gate, /DB_PATH="\$DB_PATH"/);
});

test('unprivileged nginx gate derives a socket listener while root validates the original config', () => {
  const deploy = read('platform/deploy_v8.ps1');
  const match = deploy.match(/<<'TM_UNPRIVILEGED_GATE'\r?\n([\s\S]*?)\r?\nTM_UNPRIVILEGED_GATE/);
  assert.ok(match, 'unprivileged gate heredoc must exist');
  const gate = match[1];
  const gateSetup = deploy.slice(deploy.lastIndexOf('validate_gate_identity', match.index), match.index);
  const envBoundary = deploy.slice(deploy.lastIndexOf('set +e', match.index), match.index);
  const afterGate = deploy.slice(match.index + match[0].length);

  assert.match(gateSetup, /NginxGateDir="\$\(mktemp -d \/tmp\/tm-nginx-gate\.XXXXXX\)"/);
  assert.match(gateSetup, /trap cleanup_nginx_gate_dir EXIT/);
  assert.match(gateSetup, /chown "\$GateUser:\$GateUser" "\$NginxGateDir"/);
  assert.match(envBoundary, /NGINX_GATE_DIR="\$NginxGateDir"/);
  assert.doesNotMatch(gate, /mktemp -d \/tmp\/tm-nginx-gate/);
  assert.match(gate, /turingmarket-gate\.conf/);
  assert.ok(gate.includes("pattern = re.compile(r'(?m)^(\\s*listen\\s+)80(\\s*;\\s*(?:#.*)?)$')"));
  assert.match(gate, /unix:\{socket_path\}/, 'the derived config must replace the privileged listener with a Unix socket');
  assert.match(gate, /replacement_count.*!= 1/, 'the listener rewrite must reject zero or multiple replacements');
  assert.match(gate, /python3 - "\$CANDIDATE_DIR\/nginx\/turingmarket\.conf" "\$TEST_ROOT\/turingmarket-gate\.conf"/);
  assert.match(gate, /include \$TEST_ROOT\/turingmarket-gate\.conf;/);
  assert.doesNotMatch(gate, /include \$CANDIDATE_DIR\/nginx\/turingmarket\.conf;/);

  assert.match(afterGate, /pkill -KILL -u "\$GateUser"[\s\S]*?cleanup_nginx_gate_dir[\s\S]*?trap - EXIT[\s\S]*?\[ "\$GateStatus" = "0" \]/);
  assert.match(afterGate, /\[ "\$GateStatus" = "0" \][\s\S]*?sha256sum --check --status "\$LockDir\/upload\.sha256"/);
  assert.match(
    afterGate,
    /install -m 0644 "\$LiveDir\/nginx\/turingmarket\.conf" \/etc\/nginx\/sites-available\/turingmarket[\s\S]*?nginx -t\s*\r?\n\s*systemctl reload nginx/
  );
});
