'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const platformRoot = path.resolve(__dirname, '..', '..');
const bootstrapPath = path.join(platformRoot, 'server', 'scripts', 'bootstrap_production_runtime.sh');
const bootstrap = fs.readFileSync(bootstrapPath, 'utf8');
const gitBash = process.env.GIT_BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe';
const hasGitBash = process.platform !== 'win32' || fs.existsSync(gitBash);
const nativeLinuxOnly = process.platform === 'linux'
  ? false
  : 'native Linux filesystem/process proof is pending';

function shellPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
  if (!match) return filePath.replaceAll('\\', '/');
  return `/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function runBash(source, timeout = 20_000) {
  const command = process.platform === 'win32' ? gitBash : 'bash';
  return spawnSync(command, ['--noprofile', '--norc', '-s'], {
    input: source,
    encoding: 'utf8',
    timeout
  });
}

function runPrivilegedBash(source, timeout = 30_000) {
  const command = process.platform === 'win32' ? 'wsl.exe' : 'bash';
  const args = process.platform === 'win32'
    ? ['-u', 'root', '-e', 'bash', '--noprofile', '--norc', '-s']
    : ['--noprofile', '--norc', '-s'];
  const input = process.platform === 'win32'
    ? source.replaceAll(bootstrapShellPath, `/mnt/${bootstrapPath[0].toLowerCase()}${bootstrapPath.slice(2).replaceAll('\\', '/')}`)
    : source;
  return spawnSync(command, args, {
    input,
    encoding: 'utf8',
    timeout
  });
}

function privilegedLinuxAvailable(t) {
  if (process.platform === 'linux') {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      t.skip('live bind-mount fixture requires Linux root');
      return false;
    }
    return true;
  }
  if (process.platform !== 'win32') {
    t.skip('live bind-mount fixture requires Linux or WSL');
    return false;
  }
  if (process.env.TM_RUN_WSL_BOOTSTRAP_TESTS !== '1') {
    t.skip('native Linux/root proof pending; WSL execution is not opted in');
    return false;
  }
  const probe = spawnSync('wsl.exe', ['-u', 'root', '-e', 'true'], {
    encoding: 'utf8',
    timeout: 5_000
  });
  if (probe.status !== 0 || probe.error) {
    t.skip('opted-in WSL root capability is unavailable');
    return false;
  }
  return true;
}

function assertPrivilegedFixture(t, result) {
  const diagnostics = [
    result.error && result.error.stack,
    result.signal && `signal=${result.signal}`,
    result.stdout,
    result.stderr
  ].filter(Boolean).join('\n').replaceAll('\u0000', '');
  if (result.status === 77) {
    t.skip('live bind mounts are unavailable in this privileged Linux environment');
    return false;
  }
  if (
    process.platform === 'win32'
    && result.status !== 0
    && (result.error?.code === 'ENOENT' || /Wsl\/Service\/CreateInstance\/E_ACCESSDENIED/i.test(diagnostics))
  ) {
    t.skip('privileged WSL fixture execution is unavailable');
    return false;
  }
  assert.equal(result.error, undefined, diagnostics);
  assert.equal(result.signal, null, diagnostics);
  assert.equal(result.status, 0, diagnostics);
  return true;
}

const bootstrapShellPath = shellPath(bootstrapPath);

function libraryHarness(body) {
  return `
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export TM_REMOTE_ROOT="$root/remote"
export TM_LIVE_DIR="$root/live"
export TM_STATE_ROOT="$root/state"
export TM_GATE_ROOT="$root/gate"
export TM_ENV_DIR="$root/etc"
export TM_JOURNAL_ROOT="$root/bootstrap-journal"
export TM_SYSTEMD_UNIT_DIR="$root/systemd"
export TM_LOCAL_SBIN_DIR="$root/sbin"
export TM_APPARMOR_PROFILE="$root/apparmor/profile"
export TM_BOOTSTRAP_LIBRARY_ONLY=1
export TM_TEST_GATE_MOUNTS=
export TM_BOOTSTRAP_UNDER_TEST=${shellQuote(bootstrapShellPath)}
mkdir -p "$TM_REMOTE_ROOT" "$TM_LIVE_DIR/server" "$TM_GATE_ROOT/releases"
source "$TM_BOOTSTRAP_UNDER_TEST"
${body}
`;
}

test('bootstrap declares the shared Phase 4 ownership boundary and never owns post-marker restore', () => {
  for (const marker of [
    'EXTERNAL_LAYOUT_MARKER="$REMOTE_ROOT/.external-runtime-layout-v1"',
    'OPERATION_FENCE="$REMOTE_ROOT/.deploy-v030.operation.lock"',
    'LIFECYCLE_DIR="$REMOTE_ROOT/.deploy-v030.lock"',
    'WRITER_DIR="$REMOTE_ROOT/.deploy-v030.writer"',
    'bootstrap_acquire_shared_fences()',
    'validate_owned_bootstrap_fences()',
    'bootstrap_release_shared_fences()',
    'bootstrap_recover_stale_control_state()',
    'bootstrap_initialize_process_identity()',
    'bootstrap_arm_cleanup_recovery()',
    'bootstrap_findmnt()',
    'bootstrap_acquire_preprovisioned_control_locks()',
    'adopt_migration_journal()',
    'validate_runtime_snapshot()',
    'validate_phase4_idle_state()',
    'validate_external_layout_marker()',
    'run_committed_layout_validation()',
    'BOOTSTRAP_EXTERNAL_LAYOUT_ALREADY_APPLIED'
  ]) {
    assert.ok(bootstrap.includes(marker), marker);
  }

  assert.match(bootstrap, /exec 5<"\$operation_parent"/);
  assert.match(bootstrap, /exec 6<"\$sanitizer_parent"/);
  assert.match(bootstrap, /exec 8<"\/proc\/\$BASHPID\/fd\/5\/\$operation_name"/);
  assert.match(bootstrap, /exec 9<"\/proc\/\$BASHPID\/fd\/6\/\$sanitizer_name"/);
  assert.doesNotMatch(bootstrap, /exec [5-9]<>/);
  assert.match(bootstrap, /bootstrap_trusted_flock -n 8/);
  assert.doesNotMatch(bootstrap, /flock -n -o "\$OPERATION_FENCE"/);
  assert.match(bootstrap, /command -v pgrep >\/dev\/null/);
  assert.doesNotMatch(bootstrap, /command -v findmnt/);
  assert.match(bootstrap, /External layout marker forbids bootstrap recovery/);
  assert.match(bootstrap, /recover_interrupted_migration\(\)[\s\S]*External layout marker forbids bootstrap recovery/);
});

test('main locks before terminal preflight and still recovers artifacts before capacity', () => {
  const mainStart = bootstrap.indexOf('bootstrap_production_main() {');
  assert.ok(mainStart > 0);
  const mainEnd = bootstrap.indexOf('\n}\n\nif [ "${TM_BOOTSTRAP_LIBRARY_ONLY', mainStart);
  assert.ok(mainEnd > mainStart);
  const main = bootstrap.slice(mainStart, mainEnd);
  const pendingPreflight = main.indexOf('bootstrap_terminal_journal_preflight');
  const pendingReturn = main.indexOf('bootstrap_return_after_terminal_journal_outcome');
  const initialMountInspection = main.indexOf('validate_candidate_gate_mounts');
  const controlLocks = main.indexOf('bootstrap_acquire_preprovisioned_control_locks');
  const fencedMountInspection = main.indexOf(
    'validate_candidate_gate_mounts',
    initialMountInspection + 1
  );
  const artifactRecovery = main.indexOf('bootstrap_recover_stale_artifacts_before_reservation');
  const reservation = main.indexOf('reserve_migration_journal_capacity');
  const gate = main.indexOf('bootstrap_terminal_journal_gate');
  const postReservationTerminal = main.indexOf(
    'bootstrap_return_after_terminal_journal_outcome',
    pendingReturn + 1
  );
  const generationZero = main.indexOf('begin_migration_journal');
  const claim = main.indexOf('claim_live_journal_before_host_mutation');
  const prepare = main.indexOf('bootstrap_prepare_control_plane');
  const arm = main.indexOf('bootstrap_arm_cleanup_recovery');
  const recover = main.indexOf('bootstrap_recover_stale_control_state');
  const idle = main.indexOf('validate_phase4_idle_state');
  const acquire = main.indexOf('bootstrap_acquire_shared_fences');
  assert.ok(initialMountInspection >= 0 && initialMountInspection < controlLocks);
  assert.ok(controlLocks < fencedMountInspection && fencedMountInspection < pendingPreflight);
  assert.ok(pendingPreflight < pendingReturn);
  assert.ok(pendingReturn < arm && arm < artifactRecovery && artifactRecovery < reservation);
  assert.ok(reservation < gate);
  assert.ok(gate < postReservationTerminal && postReservationTerminal < generationZero);
  assert.ok(generationZero < claim && claim < prepare);
  assert.ok(prepare < recover);
  assert.ok(recover < idle);
  assert.ok(idle < acquire);
  assert.match(main, /bootstrap_run_new_migration/);
  assert.match(main, /bootstrap_run_new_migration[\s\S]*bootstrap_emit_normal_success_contract/);
});

test('external-layout marker is exact and permanently disables the bootstrap restore path', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
expected_owner="$(id -un):$(id -gn)"
  install -d -m 0700 "$STATE_ROOT" "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" "$ENV_DIR" "$JOURNAL_ROOT"
  reserve_migration_journal_capacity
  BOOTSTRAP_OWNER_TOKEN=0123456789abcdef0123456789abcdef
printf 'env\n' > "$ENV_FILE"
printf 'db\n' > "$DB_DIR/turingmarket.db"
chmod 0600 "$ENV_FILE" "$DB_DIR/turingmarket.db"
ln -s "$ENV_FILE" "$LIVE_DIR/.env"
ln -s "$DB_DIR" "$LIVE_DIR/server/db"
ln -s "$UPLOAD_DIR" "$LIVE_DIR/uploads"
ln -s "$TMP_DIR" "$LIVE_DIR/tmp"

commit_external_layout_marker
validate_external_layout_marker
test "$(stat -c '%U:%G:%a:%h' "$EXTERNAL_LAYOUT_MARKER")" = "$expected_owner:600:1"

mkdir -m 0700 "$JOURNAL_DIR"
printf '1\n' > "$JOURNAL_DIR/schema-version"
printf 'prepared\n' > "$JOURNAL_DIR/phase"
printf '%s\n' "$BACKUP_ROOT/v030-runtime-bootstrap-20260729-010101" > "$JOURNAL_DIR/backup-dir"
printf '%s\n' "0123456789abcdef0123456789abcdef" > "$JOURNAL_DIR/owner-token"
chmod 0600 "$JOURNAL_DIR"/*
if recover_interrupted_migration 2>"$root/error"; then exit 91; fi
grep -Fq 'External layout marker forbids bootstrap recovery' "$root/error"
test -d "$JOURNAL_DIR"

printf 'tampered\n' > "$EXTERNAL_LAYOUT_MARKER"
if validate_external_layout_marker; then exit 92; fi
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('shared lifecycle and writer fences use CAS ownership and reject concurrent controllers', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$REMOTE_ROOT"
BOOTSTRAP_OWNER_TOKEN=0123456789abcdef0123456789abcdef
bootstrap_acquire_shared_fences
test "$(cat "$LIFECYCLE_DIR/owner")" = "$BOOTSTRAP_OWNER_TOKEN"
test "$(cat "$WRITER_DIR/owner")" = "$BOOTSTRAP_OWNER_TOKEN"
cp "$LIFECYCLE_DIR/run.json" "$root/original-lifecycle-run.json"

(
  BOOTSTRAP_OWNER_TOKEN=fedcba9876543210fedcba9876543210
  if bootstrap_acquire_shared_fences; then exit 90; fi
)

printf '%s\n' fedcba9876543210fedcba9876543210 > "$LIFECYCLE_DIR/owner"
if bootstrap_release_shared_fences; then exit 91; fi
test -d "$LIFECYCLE_DIR"
test -d "$WRITER_DIR"
printf '%s\n' "$BOOTSTRAP_OWNER_TOKEN" > "$LIFECYCLE_DIR/owner"
printf '{"schemaVersion":1,"operation":"bootstrap","ownerToken":"fedcba9876543210fedcba9876543210"}\n' > "$LIFECYCLE_DIR/run.json"
if bootstrap_release_shared_fences; then exit 93; fi
test -d "$LIFECYCLE_DIR"
test -d "$WRITER_DIR"
cp "$root/original-lifecycle-run.json" "$LIFECYCLE_DIR/run.json"
bootstrap_release_shared_fences
test ! -e "$LIFECYCLE_DIR"
test ! -e "$WRITER_DIR"

touch "$OPERATION_FENCE"
flock "$OPERATION_FENCE" -c 'sleep 2' &
locker=$!
sleep 0.2
if flock -n -o "$OPERATION_FENCE" true; then kill "$locker"; exit 92; fi
wait "$locker"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('barrier-synchronized fence contenders publish with atomic no-replace semantics', {
  skip: !hasGitBash ? 'requires Bash concurrency support' : false
}, () => {
  const result = runBash(libraryHarness(`
barrier="$root/publication-barrier"
mkdir -m 0700 "$barrier"
sync_directory() { :; }
bootstrap_test_sigkill() { :; }
bootstrap_write_generation() {
  printf '%s\n' "$BOOTSTRAP_OWNER_TOKEN" > "$1/owner"
  printf '%s\n' "$2" > "$1/kind"
  chmod 0600 "$1/owner" "$1/kind"
}
bootstrap_validate_generation() {
  test -d "$1"
  test ! -L "$1"
  test "$(cat "$1/owner")" = "$3"
  test "$(cat "$1/kind")" = "$2"
}
publication_barrier() {
  local attempt=0
  : > "$barrier/$BOOTSTRAP_OWNER_TOKEN.ready"
  while [ ! -e "$barrier/release" ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 1000 ]; then
      printf 'publication barrier timed out for %s\n' "$BOOTSTRAP_OWNER_TOKEN" >&2
      return 75
    fi
    sleep 0.01
  done
}
bootstrap_generation_publication_barrier() { publication_barrier; }
mv() {
  if [ "$#" -eq 2 ] && [[ "$1" == "$LIFECYCLE_DIR.next."* ]] && [ "$2" = "$LIFECYCLE_DIR" ]; then
    publication_barrier || return $?
  fi
  command mv "$@"
}
run_contender() {
  local token="$1" slot="$2"
  (
    BOOTSTRAP_OWNER_TOKEN="$token"
    status=0
    bootstrap_publish_generation lifecycle "$LIFECYCLE_DIR" \
      > "$root/contender-$slot.out" 2> "$root/contender-$slot.err" || status=$?
    printf '%s\n' "$status" > "$root/contender-$slot.status"
  ) &
  contender_pid=$!
}

token_one=11111111111111111111111111111111
token_two=22222222222222222222222222222222
run_contender "$token_one" one
pid_one=$contender_pid
run_contender "$token_two" two
pid_two=$contender_pid
attempt=0
while true; do
  ready_count="$(find "$barrier" -mindepth 1 -maxdepth 1 -type f -name '*.ready' | wc -l | tr -d ' ')"
  [ "$ready_count" -eq 2 ] && break
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 1000 ]; then
    printf 'contenders did not reach publication barrier\n' >&2
    exit 76
  fi
  sleep 0.01
done
: > "$barrier/release"
wait "$pid_one"
wait "$pid_two"
status_one="$(cat "$root/contender-one.status")"
status_two="$(cat "$root/contender-two.status")"

if [ "$(uname -s)" = Linux ]; then
  successes=0
  [ "$status_one" -eq 0 ] && successes=$((successes + 1))
  [ "$status_two" -eq 0 ] && successes=$((successes + 1))
  test "$successes" -eq 1 || {
    printf 'atomic publication expected one winner, got statuses %s and %s\n' "$status_one" "$status_two" >&2
    exit 77
  }
  test -d "$LIFECYCLE_DIR"
  if find "$LIFECYCLE_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .; then
    printf 'losing stage was nested inside the winning fence\n' >&2
    exit 78
  fi
  next_count="$(find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.deploy-v030.lock.next.*' | wc -l | tr -d ' ')"
  test "$next_count" -eq 1
else
  if [ "$status_one" -eq 0 ] || [ "$status_two" -eq 0 ]; then
    printf 'unsupported platform must fail closed, got statuses %s and %s\n' "$status_one" "$status_two" >&2
    exit 79
  fi
  test ! -e "$LIFECYCLE_DIR" && test ! -L "$LIFECYCLE_DIR"
  test -d "$LIFECYCLE_DIR.next.$token_one"
  test -d "$LIFECYCLE_DIR.next.$token_two"
  grep -Fq 'atomic no-replace publication requires native Linux' "$root/contender-one.err"
  grep -Fq 'atomic no-replace publication requires native Linux' "$root/contender-two.err"
fi
`), 30_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('bootstrap build stages expose durable fault boundaries and block idle admission when unresolved', {
  skip: !hasGitBash ? 'requires Bash fault-injection support' : false
}, async (t) => {
  await t.test('the real publisher exposes create, write, and validation boundaries', () => {
    const result = runBash(libraryHarness(`
events="$root/build-boundaries"
BOOTSTRAP_OWNER_TOKEN=33333333333333333333333333333333
bootstrap_write_generation() { printf 'generation\n' > "$1/generation"; }
bootstrap_validate_generation() { test -d "$1" && test ! -L "$1"; }
sync_directory() { :; }
bootstrap_test_sigkill() { printf '%s\n' "$1" >> "$events"; }
bootstrap_generation_publication_barrier() { :; }
bootstrap_publish_directory_noreplace() { command mv "$1" "$2"; }

bootstrap_publish_generation lifecycle "$LIFECYCLE_DIR"
test "$(cat "$events")" = "lifecycle-build-created
lifecycle-build-written
lifecycle-build-validated
lifecycle-next
lifecycle-published"
`));

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  await t.test('the real idle gate retains and rejects hidden bootstrap-build evidence', () => {
    const result = runBash(libraryHarness(`
owner=44444444444444444444444444444444
build="$REMOTE_ROOT/.deploy-v030.bootstrap-build.lifecycle.$owner"
mkdir -m 0700 "$build"
printf 'unsafe-evidence-must-survive\n' > "$build/evidence"
chmod 0600 "$build/evidence"
validate_sanitizer_gate_idle_state() { :; }
export TM_TEST_GATE_PROCESSES=
export TM_TEST_GATE_MOUNTS=

status=0
validate_phase4_idle_state 2> "$root/build-idle.err" || status=$?
test "$status" -ne 0 || {
  printf 'hidden bootstrap-build evidence was omitted from the idle gate\n' >&2
  exit 80
}
test "$(cat "$build/evidence")" = unsafe-evidence-must-survive
`));

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('durable generation and phase publishers propagate command faults under conditional invocation', {
  skip: !hasGitBash ? 'requires Bash fault-injection support' : false
}, async (t) => {
  const writerFaults = [
    { label: 'python3 partial write', command: 'python3', at: 1, owner: false, phase: false },
    { label: 'owner printf', command: 'printf', at: 1, owner: true, phase: false },
    { label: 'phase printf', command: 'printf', at: 2, owner: true, phase: true },
    { label: 'chmod', command: 'chmod', at: 1, owner: true, phase: true },
    { label: 'chown', command: 'chown', at: 1, owner: true, phase: true },
    { label: 'run file sync', command: 'sync', at: 1, owner: true, phase: true },
    { label: 'owner file sync', command: 'sync', at: 2, owner: true, phase: true },
    { label: 'phase file sync', command: 'sync', at: 3, owner: true, phase: true },
    { label: 'generation directory sync', command: 'sync', at: 4, owner: true, phase: true }
  ];

  for (const fixture of writerFaults) {
    await t.test(`writer rejects ${fixture.label}`, () => {
      const result = runBash(libraryHarness(`
generation="$REMOTE_ROOT/.deploy-v030.bootstrap-build.lifecycle.11111111111111111111111111111111"
mkdir -m 0700 "$generation"
BOOTSTRAP_OWNER_TOKEN=11111111111111111111111111111111
BOOTSTRAP_RUN_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
TM_BOOTSTRAP_LIBRARY_ONLY=0
fault_command=${shellQuote(fixture.command)}
fault_at=${fixture.at}
printf_calls=0
chmod_calls=0
chown_calls=0
sync_calls=0

bootstrap_ensure_process_identity() { :; }
expected_bootstrap_owner() { builtin printf '%s\n' root:root; }
bootstrap_trusted_stat() {
  if [ "$1" = -c ] && [ "$2" = %U:%G:%a ] && [ "$3" = "$generation" ]; then
    builtin printf '%s\n' root:root:700
    return 0
  fi
  command stat "$@"
}
python3() {
  if [ "$fault_command" = python3 ]; then
    builtin printf '%s' '{"partial":' > "$2"
    return 71
  fi
  builtin printf '%s\n' '{}' > "$2"
}
printf() {
  printf_calls=$((printf_calls + 1))
  if [ "$fault_command" = printf ] && [ "$printf_calls" -eq "$fault_at" ]; then return 72; fi
  builtin printf "$@"
}
chmod() {
  chmod_calls=$((chmod_calls + 1))
  if [ "$fault_command" = chmod ] && [ "$chmod_calls" -eq "$fault_at" ]; then return 73; fi
  command chmod "$@"
}
chown() {
  chown_calls=$((chown_calls + 1))
  if [ "$fault_command" = chown ] && [ "$chown_calls" -eq "$fault_at" ]; then return 74; fi
  return 0
}
sync() {
  sync_calls=$((sync_calls + 1))
  if [ "$fault_command" = sync ] && [ "$sync_calls" -eq "$fault_at" ]; then return 75; fi
  return 0
}

status=0
success_output=
if bootstrap_write_generation "$generation" lifecycle bootstrap-setup; then
  success_output=BOOTSTRAP_OK
else
  status=$?
fi
test "$status" -eq 1
test -z "$success_output"
test -f "$generation/run.json"
${fixture.owner ? 'test -e "$generation/owner"' : 'test ! -e "$generation/owner" && test ! -L "$generation/owner"'}
${fixture.phase ? 'test -e "$generation/phase"' : 'test ! -e "$generation/phase" && test ! -L "$generation/phase"'}
`));

      assert.equal(result.status, 0, `${fixture.label}: ${result.stdout}\n${result.stderr}`);
    });
  }

  const phaseFaults = [
    { label: 'phase printf', command: 'printf', at: 1, expectedPhase: 'bootstrap-setup' },
    { label: 'phase chmod', command: 'chmod', at: 1, expectedPhase: 'bootstrap-setup' },
    { label: 'phase chown', command: 'chown', at: 1, expectedPhase: 'bootstrap-setup' },
    { label: 'temporary file sync', command: 'sync', at: 1, expectedPhase: 'bootstrap-setup' },
    { label: 'phase mv', command: 'mv', at: 1, expectedPhase: 'bootstrap-setup' },
    { label: 'published phase file sync', command: 'sync', at: 2, expectedPhase: 'bootstrap-releasing' },
    { label: 'generation directory sync', command: 'sync', at: 3, expectedPhase: 'bootstrap-releasing' },
    { label: 'parent directory sync', command: 'sync', at: 4, expectedPhase: 'bootstrap-releasing' },
    { label: 'wrong allowed final phase', command: 'final-phase', at: 1, expectedPhase: 'bootstrap-releasing' }
  ];

  for (const fixture of phaseFaults) {
    await t.test(`phase publisher rejects ${fixture.label}`, () => {
      const result = runBash(libraryHarness(`
generation="$REMOTE_ROOT/phase-generation"
mkdir -m 0700 "$generation"
builtin printf '%s\n' '{}' > "$generation/run.json"
builtin printf '%s\n' 22222222222222222222222222222222 > "$generation/owner"
builtin printf '%s\n' bootstrap-setup > "$generation/phase"
command chmod 0600 "$generation/run.json" "$generation/owner" "$generation/phase"
BOOTSTRAP_OWNER_TOKEN=22222222222222222222222222222222
TM_BOOTSTRAP_LIBRARY_ONLY=${fixture.command === 'chown' ? '0' : '1'}
fault_command=${shellQuote(fixture.command)}
fault_at=${fixture.at}
validation_calls=0
printf_calls=0
chmod_calls=0
chown_calls=0
sync_calls=0
mv_calls=0

bootstrap_validate_generation() {
  validation_calls=$((validation_calls + 1))
  BOOTSTRAP_VALIDATED_OWNER="$BOOTSTRAP_OWNER_TOKEN"
  BOOTSTRAP_VALIDATED_GENERATION=0
  BOOTSTRAP_VALIDATED_PHASE="$(command cat "$1/phase")"
  if [ "$fault_command" = final-phase ] && [ "$validation_calls" -gt 2 ]; then
    BOOTSTRAP_VALIDATED_PHASE=bootstrap-setup
  fi
  return 0
}
bootstrap_trusted_stat() {
  if [ "$TM_BOOTSTRAP_LIBRARY_ONLY" = 0 ] && [ "\${1:-}" = -c ]; then
    case "\${2:-}" in
      '%u:%g:%a') builtin printf '0:0:%s\n' "$(command stat -c '%a' -- "\${@: -1}")"; return 0 ;;
      '%u:%g:%a:%h') builtin printf '0:0:%s:%s\n' \
        "$(command stat -c '%a' -- "\${@: -1}")" "$(command stat -c '%h' -- "\${@: -1}")"; return 0 ;;
    esac
  fi
  command stat "$@"
}
printf() {
  printf_calls=$((printf_calls + 1))
  if [ "$fault_command" = printf ] && [ "$printf_calls" -eq "$fault_at" ]; then return 76; fi
  builtin printf "$@"
}
chmod() {
  chmod_calls=$((chmod_calls + 1))
  if [ "$fault_command" = chmod ] && [ "$chmod_calls" -eq "$fault_at" ]; then return 77; fi
  command chmod "$@"
}
chown() {
  chown_calls=$((chown_calls + 1))
  if [ "$fault_command" = chown ] && [ "$chown_calls" -eq "$fault_at" ]; then return 78; fi
  return 0
}
sync() {
  sync_calls=$((sync_calls + 1))
  if [ "$fault_command" = sync ] && [ "$sync_calls" -eq "$fault_at" ]; then return 79; fi
  return 0
}
mv() {
  mv_calls=$((mv_calls + 1))
  if [ "$fault_command" = mv ] && [ "$mv_calls" -eq "$fault_at" ]; then return 80; fi
  command mv "$@"
}

status=0
success_output=
if bootstrap_set_generation_phase "$generation" lifecycle bootstrap-releasing; then
  success_output=BOOTSTRAP_OK
else
  status=$?
fi
test "$status" -eq 1
test -z "$success_output"
test "$(command cat "$generation/phase")" = ${shellQuote(fixture.expectedPhase)}
mapfile -t stages < <(find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.bootstrap-phase-next*' -print)
${fixture.expectedPhase === 'bootstrap-setup'
    ? 'test "${#stages[@]}" -eq 1\ntest -f "${stages[0]}" && test ! -L "${stages[0]}"'
    : 'test "${#stages[@]}" -eq 0'}
`));

      assert.equal(result.status, 0, `${fixture.label}: ${result.stdout}\n${result.stderr}`);
    });
  }
});

test('generation phase publication reconciles every pre-rename crash and preserves substituted or stale-owner evidence', {
  skip: !hasGitBash ? 'requires Bash fault-injection support' : false
}, async (t) => {
  const owner = '33333333333333333333333333333333';
  const staleOwner = '44444444444444444444444444444444';
  const crashPoints = [
    'generation-phase-stage-created',
    'generation-phase-stage-written',
    'generation-phase-stage-chmod',
    'generation-phase-stage-chown',
    'generation-phase-stage-file-fsync',
    'generation-phase-before-rename'
  ];

  function phaseFixture(body) {
    return libraryHarness(`
generation="$REMOTE_ROOT/phase-generation"
mkdir -m 0700 "$generation"
builtin printf '%s\n' '{}' > "$generation/run.json"
builtin printf '%s\n' ${owner} > "$generation/owner"
builtin printf '%s\n' bootstrap-setup > "$generation/phase"
command chmod 0600 "$generation/run.json" "$generation/owner" "$generation/phase"
BOOTSTRAP_OWNER_TOKEN=${owner}
sync() { :; }
sync_directory() { :; }
bootstrap_validate_generation() {
  test "$1" = "$TM_REMOTE_ROOT/phase-generation"
  test "$2" = lifecycle
  test "$3" = "$BOOTSTRAP_OWNER_TOKEN"
  BOOTSTRAP_VALIDATED_OWNER="$BOOTSTRAP_OWNER_TOKEN"
  BOOTSTRAP_VALIDATED_GENERATION=0
  BOOTSTRAP_VALIDATED_PHASE="$(command cat "$1/phase")"
}
${body}
`);
  }

  for (const point of crashPoints) {
    await t.test(`${point} survives and two retries converge`, () => {
      const result = runBash(phaseFixture(`
set +e
(export TM_BOOTSTRAP_TEST_SIGKILL_AT=${shellQuote(point)}; bootstrap_set_generation_phase "$generation" lifecycle bootstrap-releasing; exit 90)
crash_status=$?
set -e
test "$crash_status" -eq 137
test "$(command cat "$generation/phase")" = bootstrap-setup
mapfile -t stages < <(find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -type f -name '.bootstrap-phase-next*' -print)
test "\${#stages[@]}" -eq 1
stage="\${stages[0]}"
stage_identity="$(command stat -c '%d:%i' "$stage")"
test "$(command stat -c '%u:%g:%a:%h' "$stage")" = "$(id -u):$(id -g):600:1"

unset TM_BOOTSTRAP_TEST_SIGKILL_AT
bootstrap_set_generation_phase "$generation" lifecycle bootstrap-releasing
test "$(command cat "$generation/phase")" = bootstrap-releasing
test ! -e "$stage" && test ! -L "$stage"
bootstrap_set_generation_phase "$generation" lifecycle bootstrap-releasing
test "$(command cat "$generation/phase")" = bootstrap-releasing
test ! -e "$stage" && test ! -L "$stage"
test -n "$stage_identity"
`));

      assert.equal(result.status, 0, `${point}: ${result.stdout}\n${result.stderr}`);
    });
  }

  await t.test('a substituted stage and the original inode both survive retry', () => {
    const result = runBash(phaseFixture(`
set +e
(export TM_BOOTSTRAP_TEST_SIGKILL_AT=generation-phase-before-rename; bootstrap_set_generation_phase "$generation" lifecycle bootstrap-releasing; exit 90)
crash_status=$?
set -e
test "$crash_status" -eq 137
stage="$(find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -type f -name '.bootstrap-phase-next*' -print -quit)"
test -n "$stage"
original="$stage.original"
command mv -- "$stage" "$original"
builtin printf '%s\n' foreign-substitution-must-survive > "$stage"
command chmod 0600 "$stage"

status=0
if bootstrap_set_generation_phase "$generation" lifecycle bootstrap-releasing; then
  exit 91
else
  status=$?
fi
test "$status" -ne 0
test "$(command cat "$generation/phase")" = bootstrap-setup
test "$(command cat "$stage")" = foreign-substitution-must-survive
test "$(command cat "$original")" = bootstrap-releasing
`));

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  await t.test('stale-owner stage is retained and blocks a new owner', () => {
    const result = runBash(phaseFixture(`
foreign="$REMOTE_ROOT/.bootstrap-phase-next-v2.lifecycle.${staleOwner}.0.${'5'.repeat(64)}"
builtin printf '%s\n' bootstrap-releasing > "$foreign"
command chmod 0600 "$foreign"

status=0
if bootstrap_set_generation_phase "$generation" lifecycle bootstrap-releasing; then
  exit 92
else
  status=$?
fi
test "$status" -ne 0
test "$(command cat "$generation/phase")" = bootstrap-setup
test "$(command cat "$foreign")" = bootstrap-releasing
`));

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('stale generation recovery reconciles identity-bound phase stages before replacing the old owner', {
  skip: nativeLinuxOnly
}, async (t) => {
  const oldOwner = '51515151515151515151515151515151';
  const newOwner = '62626262626262626262626262626262';
  const crashPoints = [
    'generation-phase-stage-created',
    'generation-phase-stage-written',
    'generation-phase-stage-chmod',
    'generation-phase-stage-chown',
    'generation-phase-stage-file-fsync',
    'generation-phase-before-rename'
  ];

  function staleGenerationFixture(point, body) {
    return libraryHarness(`
old_owner=${oldOwner}
new_owner=${newOwner}
set +e
(
  BOOTSTRAP_OWNER_TOKEN="$old_owner"
  export BOOTSTRAP_OWNER_TOKEN
  bootstrap_initialize_process_identity
  mkdir -m 0700 "$LIFECYCLE_DIR"
  bootstrap_write_generation "$LIFECYCLE_DIR" lifecycle bootstrap-setup
  export TM_BOOTSTRAP_TEST_SIGKILL_AT=${shellQuote(point)}
  bootstrap_set_generation_phase "$LIFECYCLE_DIR" lifecycle bootstrap-releasing
  exit 90
) &
old_pid=$!
wait "$old_pid"
crash_status=$?
set -e
test "$crash_status" -eq 137
test -d "$LIFECYCLE_DIR" && test ! -L "$LIFECYCLE_DIR"
test "$(command cat "$LIFECYCLE_DIR/phase")" = bootstrap-setup
mapfile -t phase_stages < <(find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.bootstrap-phase-next*' -print)
test "\${#phase_stages[@]}" -eq 1
stage="\${phase_stages[0]}"
${body}
`);
  }

  for (const point of crashPoints) {
    await t.test(`${point} converges through a real stale-owner recovery and two retries`, () => {
      const result = runBash(staleGenerationFixture(point, `
BOOTSTRAP_OWNER_TOKEN="$new_owner"
export BOOTSTRAP_OWNER_TOKEN
bootstrap_initialize_process_identity
bootstrap_recover_stale_control_state
bootstrap_recover_stale_control_state
test ! -e "$stage" && test ! -L "$stage"
test ! -e "$LIFECYCLE_DIR" && test ! -L "$LIFECYCLE_DIR"

bootstrap_acquire_shared_fences
validate_owned_bootstrap_fences
test "$(command cat "$LIFECYCLE_DIR/owner")" = "$new_owner"
test "$(command cat "$WRITER_DIR/owner")" = "$new_owner"
bootstrap_release_shared_fences
test ! -e "$LIFECYCLE_DIR" && test ! -L "$LIFECYCLE_DIR"
test ! -e "$WRITER_DIR" && test ! -L "$WRITER_DIR"
`), 60_000);

      assert.equal(result.status, 0, `${point}: ${result.stdout}\n${result.stderr}`);
    });
  }

  await t.test('substituted stage and its original inode are preserved and block stale recovery', () => {
    const result = runBash(staleGenerationFixture('generation-phase-before-rename', `
original="$stage.original"
command mv -- "$stage" "$original"
builtin printf '%s\n' bootstrap-releasing > "$stage"
command chmod 0600 "$stage"

BOOTSTRAP_OWNER_TOKEN="$new_owner"
export BOOTSTRAP_OWNER_TOKEN
bootstrap_initialize_process_identity
status=0
bootstrap_recover_stale_control_state || status=$?
test "$status" -ne 0
test -d "$LIFECYCLE_DIR" && test ! -L "$LIFECYCLE_DIR"
test "$(command cat "$LIFECYCLE_DIR/phase")" = bootstrap-setup
test "$(command cat "$stage")" = bootstrap-releasing
test "$(command cat "$original")" = bootstrap-releasing
`), 60_000);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  await t.test('orphan or unknown phase-stage evidence is retained and blocks recovery', () => {
    const result = runBash(libraryHarness(`
unknown="$REMOTE_ROOT/.bootstrap-phase-next-v2.unknown"
builtin printf '%s\n' unknown-evidence-must-survive > "$unknown"
command chmod 0600 "$unknown"
BOOTSTRAP_OWNER_TOKEN=${newOwner}
export BOOTSTRAP_OWNER_TOKEN
bootstrap_initialize_process_identity

status=0
bootstrap_recover_stale_control_state || status=$?
test "$status" -ne 0
test "$(command cat "$unknown")" = unknown-evidence-must-survive
`), 60_000);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  await t.test('phase-stage evidence is visible to both capacity and idle admission gates', () => {
    const result = runBash(libraryHarness(`
stage="$REMOTE_ROOT/.bootstrap-phase-next-v2.unknown"
builtin printf '%s\n' gate-evidence-must-survive > "$stage"
command chmod 0600 "$stage"
install -d -m 0700 "$JOURNAL_ROOT"

status=0
reserve_migration_journal_capacity || status=$?
if [ "$status" -eq 0 ]; then
  release_migration_journal_capacity_reservation
  exit 91
fi
test "$(command cat "$stage")" = gate-evidence-must-survive

validate_sanitizer_gate_idle_state() { :; }
export TM_TEST_GATE_PROCESSES=
export TM_TEST_GATE_MOUNTS=
status=0
validate_phase4_idle_state || status=$?
test "$status" -ne 0
test "$(command cat "$stage")" = gate-evidence-must-survive
`), 60_000);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('migration phase ordering follows the production successor chain and rejects skips and regressions', {
  skip: !hasGitBash ? 'requires Bash transition support' : false
}, () => {
  const result = runBash(libraryHarness(`
JOURNAL_DIR_IDENTITY='j2:${'1'.repeat(64)}:1:1:1'
JOURNAL_ENTRY_NAME=active
JOURNAL_HEAD_DIGEST=${'2'.repeat(64)}
JOURNAL_OWNER_TOKEN=${'3'.repeat(32)}
JOURNAL_PHASE=stopping
calls="$root/phase-helper-calls"
: > "$calls"
bootstrap_journal_dirfd_helper() {
  test "$1" = write-phase
  test "$2" = active
  test "$3" = "$JOURNAL_DIR_IDENTITY"
  test "$5" = "$JOURNAL_HEAD_DIGEST"
  test "$6" = "$JOURNAL_OWNER_TOKEN"
  builtin printf 'call\n' >> "$calls"
  builtin printf '%s\n%s\n' "$JOURNAL_DIR_IDENTITY" ${'4'.repeat(64)}
}

for phase in snapshotting prepared installing linked committed; do
  set_migration_phase "$phase"
  test "$JOURNAL_PHASE" = "$phase"
  set_migration_phase "$phase"
  test "$JOURNAL_PHASE" = "$phase"
done
test "$(wc -l < "$calls")" -eq 10

for transition in 'stopping prepared' 'prepared stopping' 'committed linked'; do
  read -r current target <<< "$transition"
  JOURNAL_PHASE="$current"
  calls_before="$(wc -l < "$calls")"
  status=0
  if set_migration_phase "$target"; then
    exit 91
  else
    status=$?
  fi
  test "$status" -ne 0
  test "$JOURNAL_PHASE" = "$current"
  test "$(wc -l < "$calls")" -eq "$calls_before"
done

JOURNAL_PHASE=committed
set_migration_phase committed
test "$JOURNAL_PHASE" = committed
test "$(wc -l < "$calls")" -eq 11
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('native bootstrap-build crash windows retain incomplete evidence and recover validated stale stages', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
counter=0
for point in lifecycle-build-created lifecycle-build-written lifecycle-build-validated; do
  counter=$((counter + 1))
  old_owner="$(printf '%032x' "$((counter + 700))")"
  new_owner="$(printf '%032x' "$((counter + 800))")"
  build="$REMOTE_ROOT/.deploy-v030.bootstrap-build.lifecycle.$old_owner"
  set +e
  (
    BOOTSTRAP_OWNER_TOKEN="$old_owner"
    export TM_BOOTSTRAP_OWNER_TOKEN="$old_owner"
    export TM_BOOTSTRAP_TEST_SIGKILL_AT="$point"
    bootstrap_initialize_process_identity
    bootstrap_publish_generation lifecycle "$LIFECYCLE_DIR"
    exit 90
  )
  killed_status=$?
  set -e
  test "$killed_status" -eq 137
  test -d "$build"
  unset TM_BOOTSTRAP_TEST_SIGKILL_AT

  BOOTSTRAP_OWNER_TOKEN="$new_owner"
  export TM_BOOTSTRAP_OWNER_TOKEN="$new_owner"
  bootstrap_initialize_process_identity
  if [ "$point" = lifecycle-build-created ]; then
    printf 'incomplete-build-evidence\n' > "$build/evidence"
    chmod 0600 "$build/evidence"
    status=0
    bootstrap_recover_stale_control_state 2> "$root/$point.err" || status=$?
    test "$status" -ne 0
    test "$(cat "$build/evidence")" = incomplete-build-evidence
    rm -f -- "$build/evidence"
    rmdir -- "$build"
  else
    bootstrap_recover_stale_control_state
    test ! -e "$build" && test ! -L "$build"
    if find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.deploy-v030.bootstrap-quarantine.*' -print -quit | grep -q .; then
      exit 81
    fi
  fi
done
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('a SIGKILLed bootstrap owner is CAS-recovered before a new controller reacquires both fences', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
old_owner=0123456789abcdef0123456789abcdef
new_owner=fedcba9876543210fedcba9876543210

set +e
(
  export TM_BOOTSTRAP_OWNER_TOKEN="$old_owner"
  export TM_BOOTSTRAP_TEST_SIGKILL_AT=writer-published
  BOOTSTRAP_OWNER_TOKEN="$old_owner"
  bootstrap_initialize_process_identity
  bootstrap_arm_cleanup_recovery
  bootstrap_acquire_shared_fences
  exit 90
)
killed_status=$?
set -e
test "$killed_status" -eq 137
test -d "$LIFECYCLE_DIR"
test -d "$WRITER_DIR"

BOOTSTRAP_OWNER_TOKEN="$new_owner"
export TM_BOOTSTRAP_OWNER_TOKEN="$new_owner"
unset TM_BOOTSTRAP_TEST_SIGKILL_AT
bootstrap_initialize_process_identity
bootstrap_arm_cleanup_recovery
bootstrap_recover_stale_control_state
test ! -e "$LIFECYCLE_DIR"
test ! -e "$WRITER_DIR"

bootstrap_acquire_shared_fences
bootstrap_release_shared_fences
test ! -e "$LIFECYCLE_DIR"
test ! -e "$WRITER_DIR"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('every fence publication and release SIGKILL window is recoverable and idempotent', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
counter=0
for point in lifecycle-next lifecycle-published writer-next writer-published release-armed writer-released lifecycle-released; do
  counter=$((counter + 1))
  old_owner="$(printf '%032x' "$counter")"
  new_owner="$(printf '%032x' "$((counter + 100))")"
  set +e
  TM_BOOTSTRAP_OWNER_TOKEN="$old_owner" TM_BOOTSTRAP_TEST_SIGKILL_AT="$point" \
    bash --noprofile --norc -c '
      set -Eeuo pipefail
      source "$TM_BOOTSTRAP_UNDER_TEST"
      BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
      bootstrap_initialize_process_identity
      bootstrap_arm_cleanup_recovery
      bootstrap_acquire_shared_fences
      bootstrap_release_shared_fences
      exit 90
    '
  killed_status=$?
  set -e
  test "$killed_status" -eq 137

  BOOTSTRAP_OWNER_TOKEN="$new_owner"
  export TM_BOOTSTRAP_OWNER_TOKEN="$new_owner"
  unset TM_BOOTSTRAP_TEST_SIGKILL_AT
  bootstrap_initialize_process_identity
  bootstrap_arm_cleanup_recovery
  bootstrap_recover_stale_control_state
  bootstrap_recover_stale_control_state
  if find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.deploy-v030*' -print -quit | grep -q .; then
    exit 91
  fi
done
`), 60_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('a SIGKILL during recovery quarantine is resumed by the next CAS controller', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
old_owner=88888888888888888888888888888888
recovery_owner=99999999999999999999999999999999
final_owner=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
set +e
TM_BOOTSTRAP_OWNER_TOKEN="$old_owner" TM_BOOTSTRAP_TEST_SIGKILL_AT=writer-published \
  bash --noprofile --norc -c '
    set -Eeuo pipefail
    source "$TM_BOOTSTRAP_UNDER_TEST"
    BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
    bootstrap_initialize_process_identity
    bootstrap_arm_cleanup_recovery
    bootstrap_acquire_shared_fences
  '
test "$?" -eq 137

(
  BOOTSTRAP_OWNER_TOKEN="$recovery_owner"
  export TM_BOOTSTRAP_OWNER_TOKEN="$recovery_owner"
  export TM_BOOTSTRAP_TEST_SIGKILL_AT=recovery-lifecycle-active-quarantined
  bootstrap_initialize_process_identity
  bootstrap_recover_stale_control_state
)
recovery_status=$?
set -e
test "$recovery_status" -eq 137
test -d "$WRITER_DIR"
find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.deploy-v030.bootstrap-quarantine.lifecycle-*' -print -quit | grep -q .

BOOTSTRAP_OWNER_TOKEN="$final_owner"
export TM_BOOTSTRAP_OWNER_TOKEN="$final_owner"
unset TM_BOOTSTRAP_TEST_SIGKILL_AT
bootstrap_initialize_process_identity
bootstrap_recover_stale_control_state
bootstrap_recover_stale_control_state
if find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.deploy-v030*' -print -quit | grep -q .; then exit 91; fi
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('every fence tombstone unlink and rmdir boundary is resumable after SIGKILL', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
counter=0
for kind in lifecycle writer; do
  case "$kind" in
    lifecycle) target="$LIFECYCLE_DIR" ;;
    writer) target="$WRITER_DIR" ;;
  esac
  for point in \
    delete-tombstone-published \
    delete-unlink-run.json \
    delete-unlink-owner \
    delete-unlink-phase \
    delete-rmdir-generation \
    delete-unlink-tombstone; do
    counter=$((counter + 1))
    old_owner="$(printf '%032x' "$((counter + 400))")"
    recovery_owner="$(printf '%032x' "$((counter + 500))")"
    final_owner="$(printf '%032x' "$((counter + 600))")"

    set +e
    TM_BOOTSTRAP_OWNER_TOKEN="$old_owner" \
    TM_BOOTSTRAP_TEST_SIGKILL_AT="$kind-published" \
    TM_BOOTSTRAP_TEST_FENCE_KIND="$kind" \
    TM_BOOTSTRAP_TEST_FENCE_TARGET="$target" \
      bash --noprofile --norc -c '
        set -Eeuo pipefail
        source "$TM_BOOTSTRAP_UNDER_TEST"
        BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
        bootstrap_initialize_process_identity
        bootstrap_arm_cleanup_recovery
        bootstrap_publish_generation "$TM_BOOTSTRAP_TEST_FENCE_KIND" "$TM_BOOTSTRAP_TEST_FENCE_TARGET"
      '
    test "$?" -eq 137

    TM_BOOTSTRAP_OWNER_TOKEN="$recovery_owner" \
    TM_BOOTSTRAP_TEST_DELETE_SIGKILL_AT="$point" \
      bash --noprofile --norc -c '
        set -Eeuo pipefail
        source "$TM_BOOTSTRAP_UNDER_TEST"
        BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
        bootstrap_initialize_process_identity
        bootstrap_arm_cleanup_recovery
        bootstrap_recover_stale_control_state
      '
    recovery_status=$?
    set -e
    test "$recovery_status" -eq 137

    BOOTSTRAP_OWNER_TOKEN="$final_owner"
    export TM_BOOTSTRAP_OWNER_TOKEN="$final_owner"
    bootstrap_initialize_process_identity
    bootstrap_arm_cleanup_recovery
    bootstrap_recover_stale_control_state
    bootstrap_recover_stale_control_state
    if find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.deploy-v030*' -print -quit | grep -q .; then exit 91; fi
    if find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.bootstrap-delete-v1.*' -print -quit | grep -q .; then exit 92; fi
  done
done
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('every artifact-repair tombstone unlink and rmdir boundary is resumable after SIGKILL', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
counter=0
for point in \
  delete-tombstone-published \
  delete-unlink-work/nested/item \
  delete-rmdir-work/nested \
  delete-rmdir-work \
  delete-unlink-run.json \
  delete-unlink-owner \
  delete-unlink-phase \
  delete-rmdir-generation \
  delete-unlink-tombstone; do
  counter=$((counter + 1))
  old_owner="$(printf '%032x' "$((counter + 700))")"
  final_owner="$(printf '%032x' "$((counter + 800))")"
  repair="$JOURNAL_ROOT/artifact-repair-$old_owner"

  set +e
  TM_BOOTSTRAP_OWNER_TOKEN="$old_owner" \
  TM_BOOTSTRAP_TEST_DELETE_SIGKILL_AT="$point" \
  TM_BOOTSTRAP_TEST_REPAIR_PATH="$repair" \
    bash --noprofile --norc -c '
      set -Eeuo pipefail
      source "$TM_BOOTSTRAP_UNDER_TEST"
      BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
      bootstrap_initialize_process_identity
      bootstrap_arm_cleanup_recovery
      install -d -m 0700 "$JOURNAL_ROOT" "$TM_BOOTSTRAP_TEST_REPAIR_PATH"
      bootstrap_write_generation "$TM_BOOTSTRAP_TEST_REPAIR_PATH" artifact-repair repair-created
      mkdir -m 0700 "$TM_BOOTSTRAP_TEST_REPAIR_PATH/work" "$TM_BOOTSTRAP_TEST_REPAIR_PATH/work/nested"
      printf "%s\n" repair > "$TM_BOOTSTRAP_TEST_REPAIR_PATH/work/nested/item"
      chmod 0600 "$TM_BOOTSTRAP_TEST_REPAIR_PATH/work/nested/item"
      bootstrap_delete_artifact_generation "$TM_BOOTSTRAP_TEST_REPAIR_PATH" "$TM_BOOTSTRAP_OWNER_TOKEN"
    '
  killed_status=$?
  set -e
  test "$killed_status" -eq 137

  BOOTSTRAP_OWNER_TOKEN="$final_owner"
  export TM_BOOTSTRAP_OWNER_TOKEN="$final_owner"
  bootstrap_initialize_process_identity
  bootstrap_arm_cleanup_recovery
  bootstrap_recover_stale_control_state
  bootstrap_recover_stale_control_state
  test ! -e "$repair"
  if find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -name '.bootstrap-delete-v1.*' -print -quit | grep -q .; then exit 91; fi
done
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('simulated deletion I/O failures retain durable fence and artifact tombstones for rerun', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
old_fence=00000000000000000000000000000901
io_owner=00000000000000000000000000000902
old_repair=00000000000000000000000000000903
final_owner=00000000000000000000000000000904

set +e
TM_BOOTSTRAP_OWNER_TOKEN="$old_fence" TM_BOOTSTRAP_TEST_SIGKILL_AT=lifecycle-published \
  bash --noprofile --norc -c '
    set -Eeuo pipefail
    source "$TM_BOOTSTRAP_UNDER_TEST"
    BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
    bootstrap_initialize_process_identity
    bootstrap_arm_cleanup_recovery
    bootstrap_publish_generation lifecycle "$LIFECYCLE_DIR"
  '
test "$?" -eq 137

TM_BOOTSTRAP_OWNER_TOKEN="$io_owner" TM_BOOTSTRAP_TEST_DELETE_IOERROR_AT=delete-unlink-owner \
  bash --noprofile --norc -c '
    set -Eeuo pipefail
    source "$TM_BOOTSTRAP_UNDER_TEST"
    BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
    bootstrap_initialize_process_identity
    bootstrap_arm_cleanup_recovery
    bootstrap_recover_stale_control_state
  '
test "$?" -ne 0
set -e
find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.bootstrap-delete-v1.*' -print -quit | grep -q .

repair="$JOURNAL_ROOT/artifact-repair-$old_repair"
set +e
TM_BOOTSTRAP_OWNER_TOKEN="$old_repair" TM_BOOTSTRAP_TEST_DELETE_IOERROR_AT=delete-rmdir-work \
TM_BOOTSTRAP_TEST_REPAIR_PATH="$repair" \
  bash --noprofile --norc -c '
    set -Eeuo pipefail
    source "$TM_BOOTSTRAP_UNDER_TEST"
    BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
    bootstrap_initialize_process_identity
    bootstrap_arm_cleanup_recovery
    install -d -m 0700 "$JOURNAL_ROOT" "$TM_BOOTSTRAP_TEST_REPAIR_PATH"
    bootstrap_write_generation "$TM_BOOTSTRAP_TEST_REPAIR_PATH" artifact-repair repair-created
    mkdir -m 0700 "$TM_BOOTSTRAP_TEST_REPAIR_PATH/work"
    bootstrap_delete_artifact_generation "$TM_BOOTSTRAP_TEST_REPAIR_PATH" "$TM_BOOTSTRAP_OWNER_TOKEN"
  '
test "$?" -ne 0
set -e
find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -name '.bootstrap-delete-v1.*' -print -quit | grep -q .

BOOTSTRAP_OWNER_TOKEN="$final_owner"
export TM_BOOTSTRAP_OWNER_TOKEN="$final_owner"
bootstrap_initialize_process_identity
bootstrap_arm_cleanup_recovery
bootstrap_recover_stale_control_state
bootstrap_recover_stale_control_state
if find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.deploy-v030*' -print -quit | grep -q .; then exit 91; fi
if find "$REMOTE_ROOT" "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -name '.bootstrap-delete-v1.*' -print -quit | grep -q .; then exit 92; fi
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('recovery rejects a complete live-owner generation without signalling its PID', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
old_owner=11111111111111111111111111111111
new_owner=22222222222222222222222222222222
ready="$root/live-owner-ready"

TM_BOOTSTRAP_OWNER_TOKEN="$old_owner" TM_BOOTSTRAP_READY="$ready" \
  bash --noprofile --norc -c '
    set -Eeuo pipefail
    source "$TM_BOOTSTRAP_UNDER_TEST"
    BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
    bootstrap_initialize_process_identity
    bootstrap_arm_cleanup_recovery
    bootstrap_acquire_shared_fences
    : > "$TM_BOOTSTRAP_READY"
    while :; do read -r -t 1 _ || true; done
  ' &
live_pid=$!
for _attempt in $(seq 1 100); do
  [ -f "$ready" ] && break
  sleep 0.05
done
test -f "$ready"

BOOTSTRAP_OWNER_TOKEN="$new_owner"
export TM_BOOTSTRAP_OWNER_TOKEN="$new_owner"
bootstrap_initialize_process_identity
if bootstrap_recover_stale_control_state >"$root/live.out" 2>"$root/live.err"; then
  kill -KILL "$live_pid"
  exit 91
fi
grep -Fq 'still has a live owner' "$root/live.err"
kill -0 "$live_pid"
test -d "$LIFECYCLE_DIR"
test -d "$WRITER_DIR"

kill -KILL "$live_pid"
set +e
wait "$live_pid"
killed_status=$?
set -e
test "$killed_status" -eq 137
bootstrap_recover_stale_control_state
test ! -e "$LIFECYCLE_DIR"
test ! -e "$WRITER_DIR"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('recovery fails closed on malformed schema, foreign operation, and owner divergence', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
old_owner=33333333333333333333333333333333
new_owner=44444444444444444444444444444444
set +e
TM_BOOTSTRAP_OWNER_TOKEN="$old_owner" TM_BOOTSTRAP_TEST_SIGKILL_AT=writer-published \
  bash --noprofile --norc -c '
    set -Eeuo pipefail
    source "$TM_BOOTSTRAP_UNDER_TEST"
    BOOTSTRAP_OWNER_TOKEN="$TM_BOOTSTRAP_OWNER_TOKEN"
    bootstrap_initialize_process_identity
    bootstrap_arm_cleanup_recovery
    bootstrap_acquire_shared_fences
  '
killed_status=$?
set -e
test "$killed_status" -eq 137
cp "$LIFECYCLE_DIR/run.json" "$root/lifecycle-run.json"

BOOTSTRAP_OWNER_TOKEN="$new_owner"
export TM_BOOTSTRAP_OWNER_TOKEN="$new_owner"
bootstrap_initialize_process_identity

python3 - "$LIFECYCLE_DIR/run.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding='utf-8') as handle:
    payload = json.load(handle)
payload['operation'] = 'deploy'
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, sort_keys=True, separators=(',', ':'))
    handle.write('\\n')
PY
if bootstrap_recover_stale_control_state >"$root/foreign.out" 2>"$root/foreign.err"; then exit 91; fi
grep -Fq 'Malformed or foreign bootstrap control generation' "$root/foreign.err"
test -d "$LIFECYCLE_DIR"
test -d "$WRITER_DIR"

cp "$root/lifecycle-run.json" "$LIFECYCLE_DIR/run.json"
printf '%s\n' 55555555555555555555555555555555 > "$LIFECYCLE_DIR/owner"
if bootstrap_recover_stale_control_state >"$root/owner.out" 2>"$root/owner.err"; then exit 92; fi
grep -Fq 'Malformed or foreign bootstrap control generation' "$root/owner.err"
test -d "$LIFECYCLE_DIR"
test -d "$WRITER_DIR"

printf '%s\n' "$old_owner" > "$LIFECYCLE_DIR/owner"
bootstrap_recover_stale_control_state
test ! -e "$LIFECYCLE_DIR"
test ! -e "$WRITER_DIR"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('bootstrap fails closed on unresolved deployment, sanitizer, process, mount, and staging state', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$REMOTE_ROOT" "$GATE_ROOT"

assert_rejected() {
  local label="$1"
  shift
  rm -rf -- "$LIFECYCLE_DIR" "$WRITER_DIR" "$LIFECYCLE_DIR".next.* "$WRITER_DIR".released.* \
    "$REMOTE_ROOT/.sanitizer-journal" "$GATE_ROOT/.bootstrap-stage-test" "$STATE_ROOT/.db.new.test" "$BACKUP_ROOT"
  TM_TEST_GATE_PROCESSES="" TM_TEST_GATE_MOUNTS="" "$@"
  if validate_phase4_idle_state >"$root/$label.out" 2>"$root/$label.err"; then return 1; fi
}

make_lifecycle() { mkdir "$LIFECYCLE_DIR"; }
make_writer() { mkdir "$WRITER_DIR"; }
make_sanitizer() { mkdir "$REMOTE_ROOT/.sanitizer-journal"; }
make_staging() { mkdir "$GATE_ROOT/.bootstrap-stage-test"; }
make_process() { export TM_TEST_GATE_PROCESSES=4242; }
make_mount() { export TM_TEST_GATE_MOUNTS="$GATE_ROOT/releases/mounted"; }
make_lifecycle_stage() { mkdir "$LIFECYCLE_DIR.next.0123456789abcdef0123456789abcdef"; }
make_writer_retired() { mkdir "$WRITER_DIR.released.0123456789abcdef0123456789abcdef"; }
make_runtime_stage() { mkdir -p "$STATE_ROOT/.db.new.test"; }
make_restore() { mkdir -p "$BACKUP_ROOT/v050-test/rollback"; printf 'database-restored\n' > "$BACKUP_ROOT/v050-test/rollback/restore-step"; }

assert_rejected lifecycle make_lifecycle
assert_rejected writer make_writer
assert_rejected sanitizer make_sanitizer
assert_rejected staging make_staging
assert_rejected process make_process
assert_rejected mount make_mount
assert_rejected lifecycle-stage make_lifecycle_stage
assert_rejected writer-retired make_writer_retired
assert_rejected runtime-stage make_runtime_stage
assert_rejected restore make_restore

rm -rf -- "$BACKUP_ROOT"
TM_TEST_GATE_PROCESSES="" TM_TEST_GATE_MOUNTS="" validate_phase4_idle_state
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('candidate mount inspection fails closed on findmnt errors while preserving injected mount fixtures', {
  skip: !hasGitBash
}, () => {
  const result = runBash(libraryHarness(`
findmnt_calls="$root/findmnt-calls"
findmnt() {
  printf 'called\n' >> "$findmnt_calls"
  printf '%s\n' 'sensitive-findmnt-stdout-must-not-leak'
  printf '%s\n' 'sensitive-findmnt-stderr-must-not-leak' >&2
  return 73
}
export TM_TEST_GATE_PROCESSES=

export TM_TEST_GATE_MOUNTS=
validate_phase4_idle_state
test ! -e "$findmnt_calls"

export TM_TEST_GATE_MOUNTS="$GATE_ROOT/releases/injected"
set +e
validate_phase4_idle_state > "$root/injected.out" 2> "$root/injected.err"
injected_status=$?
set -e
test "$injected_status" -ne 0
grep -Fq 'Candidate gate mount is still active' "$root/injected.err"
test ! -e "$findmnt_calls"

unset TM_TEST_GATE_MOUNTS
set +e
validate_phase4_idle_state > "$root/failed.out" 2> "$root/failed.err"
failed_status=$?
set -e
test "$failed_status" -eq 1
test ! -s "$root/failed.out"
test "$(cat "$root/failed.err")" = 'Candidate mount verification failed: findmnt returned nonzero'
if grep -Fq 'sensitive-findmnt' "$root/failed.out" "$root/failed.err"; then exit 91; fi
test "$(cat "$findmnt_calls")" = called
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('trusted findmnt rejects imported functions and PATH impostors while preserving library fixtures', {
  skip: !hasGitBash
}, () => {
  const result = runBash(libraryHarness(`
findmnt() {
  printf 'function-called\n' > "$root/function-called"
  printf '%s\n' sensitive-function-output
}
export -f findmnt
set +e
TM_BOOTSTRAP_LIBRARY_ONLY=1 bash --noprofile --norc -c '
  set -euo pipefail
  source "$TM_BOOTSTRAP_UNDER_TEST"
  export TM_BOOTSTRAP_LIBRARY_ONLY=0
  set +e
  bootstrap_findmnt -rn -o TARGET > "$TM_REMOTE_ROOT/function.out" 2> "$TM_REMOTE_ROOT/function.err"
  status=$?
  set -e
  test "$status" -ne 0
'
function_probe_status=$?
set -e
test "$function_probe_status" -eq 0
test ! -e "$root/function-called"
if grep -Fq sensitive-function-output "$TM_REMOTE_ROOT/function.out" "$TM_REMOTE_ROOT/function.err"; then exit 91; fi
unset -f findmnt

mkdir -m 0700 "$root/impostor"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "path-called\\n" > "$TM_REMOTE_ROOT/path-called"' \
  'printf "%s\\n" sensitive-path-output' \
  > "$root/impostor/findmnt"
chmod 0700 "$root/impostor/findmnt"
set +e
PATH="$root/impostor:$PATH" TM_BOOTSTRAP_LIBRARY_ONLY=1 bash --noprofile --norc -c '
  set -euo pipefail
  source "$TM_BOOTSTRAP_UNDER_TEST"
  export TM_BOOTSTRAP_LIBRARY_ONLY=0
  set +e
  bootstrap_findmnt -rn -o TARGET > "$TM_REMOTE_ROOT/path.out" 2> "$TM_REMOTE_ROOT/path.err"
  status=$?
  set -e
  test "$status" -ne 0
'
path_probe_status=$?
set -e
test "$path_probe_status" -eq 0
test ! -e "$root/path-called"
if grep -Fq sensitive-path-output "$TM_REMOTE_ROOT/path.out" "$TM_REMOTE_ROOT/path.err"; then exit 92; fi

export TM_BOOTSTRAP_LIBRARY_ONLY=1
findmnt() {
  printf 'library-called\n' > "$root/library-called"
  printf '%s\n' "$GATE_ROOT/releases/library-fixture"
}
library_mounts="$(bootstrap_findmnt -rn -o TARGET)"
test "$library_mounts" = "$GATE_ROOT/releases/library-fixture"
test "$(cat "$root/library-called")" = library-called
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('a new fenced controller adopts the exact versioned pre-marker journal with owner CAS', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260729-010101"
STATE_BACKUP="$BACKUP_DIR/state"
mkdir -m 0700 "$BACKUP_DIR" "$STATE_BACKUP"
  BOOTSTRAP_OWNER_TOKEN=0123456789abcdef0123456789abcdef
  begin_migration_journal
  read_journal
  test "$JOURNAL_OWNER_TOKEN" = "$BOOTSTRAP_OWNER_TOKEN"
  first_head="$JOURNAL_HEAD_DIGEST"

  BOOTSTRAP_OWNER_TOKEN=fedcba9876543210fedcba9876543210
  read_journal
  adopt_migration_journal
  read_journal
  test "$JOURNAL_OWNER_TOKEN" = "$BOOTSTRAP_OWNER_TOKEN"
  test "$JOURNAL_HEAD_DIGEST" != "$first_head"

  JOURNAL_OWNER_TOKEN=0123456789abcdef0123456789abcdef
  if adopt_migration_journal; then exit 94; fi
  read_journal
  test "$JOURNAL_OWNER_TOKEN" = "$BOOTSTRAP_OWNER_TOKEN"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('pre-marker recovery rejects snapshot link, mode, and hardlink substitution', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260729-010101"
STATE_BACKUP="$BACKUP_DIR/state"
mkdir -m 0700 "$BACKUP_DIR" "$STATE_BACKUP" "$STATE_BACKUP/live-db" "$STATE_BACKUP/live-uploads" "$STATE_BACKUP/live-tmp"
printf 'env\n' > "$STATE_BACKUP/live-env"
printf 'db\n' > "$STATE_BACKUP/live-db/turingmarket.db"
printf 'upload\n' > "$STATE_BACKUP/live-uploads/item"
printf 'tmp\n' > "$STATE_BACKUP/live-tmp/item"
for name in live-env live-db live-uploads live-tmp; do : > "$STATE_BACKUP/$name.present"; done
for name in external-env external-db external-uploads external-tmp; do : > "$STATE_BACKUP/$name.absent"; done
chmod -R u=rwX,go= "$STATE_BACKUP"
find "$STATE_BACKUP" -type d -exec chmod 0700 {} +
find "$STATE_BACKUP" -type f -exec chmod 0600 {} +
validate_runtime_snapshot "$BACKUP_DIR"

mv "$STATE_BACKUP/live-env" "$STATE_BACKUP/live-env.real"
ln -s "$STATE_BACKUP/live-env.real" "$STATE_BACKUP/live-env"
if validate_runtime_snapshot "$BACKUP_DIR"; then exit 95; fi
rm "$STATE_BACKUP/live-env"
mv "$STATE_BACKUP/live-env.real" "$STATE_BACKUP/live-env"

chmod 0644 "$STATE_BACKUP/live-env"
if validate_runtime_snapshot "$BACKUP_DIR"; then exit 96; fi
chmod 0600 "$STATE_BACKUP/live-env"

ln "$STATE_BACKUP/live-env" "$STATE_BACKUP/live-env-hardlink"
if validate_runtime_snapshot "$BACKUP_DIR"; then exit 97; fi
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('restore rejects a symlinked target ancestor before outside-tree deletion', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
chmod 0700 "$LIVE_DIR"
backup="$root/absent-live-db"
outside="$root/outside"
mkdir -m 0700 "$outside" "$outside/db"
printf 'outside-must-survive\n' > "$outside/db/sentinel"
chmod 0600 "$outside/db/sentinel"
: > "$backup.absent"
chmod 0600 "$backup.absent"
rmdir "$LIVE_DIR/server"
ln -s "$outside" "$LIVE_DIR/server"

if restore_copy "$backup" "$LIVE_DIR/server/db" "$LIVE_DIR" server/db 0700 1 2>"$root/restore.err"; then
  exit 90
fi
test -f "$outside/db/sentinel"
test -L "$LIVE_DIR/server"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('restore rejects a simulated cross-device target component before mutation', () => {
  const result = runBash(libraryHarness(`
chmod 0700 "$LIVE_DIR" "$LIVE_DIR/server"
mkdir -m 0700 "$LIVE_DIR/server/db"
printf 'live-must-survive\n' > "$LIVE_DIR/server/db/sentinel"
chmod 0600 "$LIVE_DIR/server/db/sentinel"
backup="$root/absent-live-db"
: > "$backup.absent"
chmod 0600 "$backup.absent"

export TM_BOOTSTRAP_TEST_FORCE_XDEV_RELATIVE=server
if restore_copy "$backup" "$LIVE_DIR/server/db" "$LIVE_DIR" server/db 0700 1 2>"$root/restore.err"; then
  exit 90
fi
test -f "$LIVE_DIR/server/db/sentinel"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('restore rejects a live same-filesystem bind-mounted target ancestor before outside deletion', (t) => {
  if (!privilegedLinuxAvailable(t)) return;
  const result = runPrivilegedBash(libraryHarness(`
chmod 0700 "$LIVE_DIR" "$LIVE_DIR/server"
outside="$root/outside"
mounted_target="$LIVE_DIR/server"
mounted=0
cleanup_bind_mount() {
  if [ "$mounted" -eq 1 ]; then umount -- "$mounted_target" || true; fi
  rm -rf -- "$root"
}
trap cleanup_bind_mount EXIT

mkdir -m 0700 "$outside" "$outside/db"
printf 'outside-must-survive\n' > "$outside/db/sentinel"
chmod 0600 "$outside/db/sentinel"
backup="$root/absent-live-db"
: > "$backup.absent"
chmod 0600 "$backup.absent"
test "$(stat -c %d "$outside")" = "$(stat -c %d "$mounted_target")"
if ! mount --bind "$outside" "$mounted_target"; then exit 77; fi
mounted=1
test "$(stat -c %d "$outside")" = "$(stat -c %d "$mounted_target")"

if restore_copy "$backup" "$LIVE_DIR/server/db" "$LIVE_DIR" server/db 0700 1 2>"$root/restore-bind.err"; then
  exit 90
fi
test -f "$outside/db/sentinel"
test "$(cat "$outside/db/sentinel")" = outside-must-survive
`), 45_000);

  assertPrivilegedFixture(t, result);
});

test('artifact repair rejects a live same-filesystem bind-mounted work tree before outside deletion', (t) => {
  if (!privilegedLinuxAvailable(t)) return;
  const result = runPrivilegedBash(libraryHarness(`
owner=abcdefabcdefabcdefabcdefabcdefab
BOOTSTRAP_OWNER_TOKEN="$owner"
export TM_BOOTSTRAP_OWNER_TOKEN="$owner"
bootstrap_initialize_process_identity
repair="$JOURNAL_ROOT/artifact-repair-$owner"
outside="$root/outside-artifact"
mounted_target="$repair/work"
mounted=0
cleanup_bind_mount() {
  if [ "$mounted" -eq 1 ]; then umount -- "$mounted_target" || true; fi
  rm -rf -- "$root"
}
trap cleanup_bind_mount EXIT

install -d -m 0700 "$JOURNAL_ROOT" "$repair" "$outside" "$outside/nested"
bootstrap_write_generation "$repair" artifact-repair repair-created
mkdir -m 0700 "$mounted_target"
printf 'artifact-outside-must-survive\n' > "$outside/nested/sentinel"
chmod 0600 "$outside/nested/sentinel"
test "$(stat -c %d "$outside")" = "$(stat -c %d "$mounted_target")"
if ! mount --bind "$outside" "$mounted_target"; then exit 77; fi
mounted=1
test "$(stat -c %d "$outside")" = "$(stat -c %d "$mounted_target")"

set +e
bootstrap_delete_artifact_generation "$repair" "$owner" 2>"$root/artifact-bind.err"
delete_status=$?
set -e
test "$delete_status" -ne 0
test -f "$outside/nested/sentinel" || exit 91
test "$(cat "$outside/nested/sentinel")" = artifact-outside-must-survive || exit 92
`), 45_000);

  assertPrivilegedFixture(t, result);
});

test('an exact pre-marker journal recovers once but the same journal is rejected after marker commit', {
  skip: 'superseded by the v4 three-state native protocol matrix below'
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260729-010101"
STATE_BACKUP="$BACKUP_DIR/state"
mkdir -m 0700 "$BACKUP_DIR" "$STATE_BACKUP"
BOOTSTRAP_OWNER_TOKEN=0123456789abcdef0123456789abcdef
begin_migration_journal
set_migration_phase snapshotting
set_migration_phase prepared

actions="$root/actions"
restore_runtime_snapshot() { printf 'restore\n' >> "$actions"; }
install_loopback_firewall_for_recovery() { printf 'firewall\n' >> "$actions"; }
restart_current_release() { printf 'restart\n' >> "$actions"; }
recover_interrupted_migration
test "$(cat "$actions")" = restore
test ! -e "$JOURNAL_DIR"

begin_migration_journal
set_migration_phase snapshotting
set_migration_phase prepared
set_migration_phase installing
commit_external_layout_marker
if recover_interrupted_migration 2>"$root/error"; then exit 93; fi
grep -Fq 'External layout marker forbids bootstrap recovery' "$root/error"
test -d "$JOURNAL_DIR"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('exact marker durability precedes journal retirement and post-marker cleanup never restores', {
  skip: 'superseded by the v4 three-state native protocol matrix below'
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT" "$STATE_ROOT" "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" "$ENV_DIR"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260729-020202"
STATE_BACKUP="$BACKUP_DIR/state"
mkdir -m 0700 "$BACKUP_DIR" "$STATE_BACKUP"
printf 'env\n' > "$ENV_FILE"
printf 'db\n' > "$DB_DIR/turingmarket.db"
chmod 0600 "$ENV_FILE" "$DB_DIR/turingmarket.db"
ln -s "$ENV_FILE" "$LIVE_DIR/.env"
ln -s "$DB_DIR" "$LIVE_DIR/server/db"
ln -s "$UPLOAD_DIR" "$LIVE_DIR/uploads"
ln -s "$TMP_DIR" "$LIVE_DIR/tmp"

old_owner=66666666666666666666666666666666
new_owner=77777777777777777777777777777777
BOOTSTRAP_OWNER_TOKEN="$old_owner"
export TM_BOOTSTRAP_OWNER_TOKEN="$old_owner"
begin_migration_journal committed
set_migration_phase committed

set +e
(
  export TM_BOOTSTRAP_TEST_SIGKILL_AT=marker-durable
  commit_external_layout_and_retire_journal
  exit 90
)
killed_status=$?
set -e
test "$killed_status" -eq 137
validate_external_layout_marker
test ! -e "$JOURNAL_DIR" && test ! -L "$JOURNAL_DIR"
discover_migration_journal
test "$JOURNAL_PRESENT" = 1
case "$JOURNAL_ENTRY_NAME" in .active.retired.*) ;; *) exit 91 ;; esac
read_journal
test "$JOURNAL_PHASE" = committed

actions="$root/post-marker-actions"
restore_runtime_snapshot() { printf 'RESTORE-MUST-NOT-RUN\n' >> "$actions"; return 98; }
BOOTSTRAP_OWNER_TOKEN="$new_owner"
export TM_BOOTSTRAP_OWNER_TOKEN="$new_owner"
finalize_post_marker_bootstrap_journal
finalize_post_marker_bootstrap_journal
validate_external_layout_marker
test ! -e "$JOURNAL_DIR"
completed="$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.active.retired.*' -print -quit)"
test -n "$completed"
test -f "$completed/retire-intent"
test -f "$completed/retire-complete"
discover_migration_journal
test "$JOURNAL_PRESENT" = 0
test ! -e "$actions"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('existing-layout bootstrap uses the real successor chain and converges at every durable phase', {
  skip: nativeLinuxOnly
}, async (t) => {
  function existingLayoutFixture(body) {
    return libraryHarness(`
BACKUP_ROOT="$root/backups"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260803-010101"
STATE_BACKUP="$BACKUP_DIR/state"
actions="$root/existing-layout-actions"
record_action() { builtin printf '%s\n' "$1" >> "$actions"; }

install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT" "$ENV_DIR" "$STATE_ROOT"
install -d -m 0700 "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR"
install -d -m 0755 "$LIVE_DIR" "$LIVE_DIR/server" "$GATE_ROOT" "$GATE_ROOT/releases"
builtin printf '%s\n' runtime-env > "$ENV_FILE"
builtin printf '%s\n' sqlite-fixture > "$DB_DIR/turingmarket.db"
command chmod 0600 "$ENV_FILE" "$DB_DIR/turingmarket.db"
ln -s "$ENV_FILE" "$LIVE_DIR/.env"
ln -s "$DB_DIR" "$LIVE_DIR/server/db"
ln -s "$UPLOAD_DIR" "$LIVE_DIR/uploads"
ln -s "$TMP_DIR" "$LIVE_DIR/tmp"

snapshot_host() { record_action "snapshot-$1"; }
apt-get() { :; }
getent() { :; }
validate_gate_identity() { :; }
install_apparmor_profile() { record_action apparmor; }
database_quick_check() {
  test "$1" = "$DB_DIR/turingmarket.db"
  record_action database
}
validate_sanitizer_gate_idle_state() { :; }
stop_current_release() { record_action stop; }
install_loopback_firewall() { record_action firewall; }
restart_current_release() { record_action restart; }
restore_runtime_snapshot() { record_action RESTORE-MUST-NOT-RUN; return 98; }
install_loopback_firewall_for_recovery() { record_action RECOVERY-FIREWALL-MUST-NOT-RUN; return 97; }

BOOTSTRAP_OWNER_TOKEN=71717171717171717171717171717171
export BOOTSTRAP_OWNER_TOKEN
bootstrap_initialize_process_identity
begin_migration_journal stopping
${body}
`);
  }

  await t.test('first run reaches committed only through every real successor and retires after marker durability', () => {
    const result = runBash(existingLayoutFixture(`
bootstrap_run_new_migration
validate_external_layout_marker
discover_migration_journal
test "$JOURNAL_PRESENT" = 1
test "$JOURNAL_TERMINAL_STATE" = terminal-pending
test "$JOURNAL_PHASE" = committed
test ! -e "$JOURNAL_ROOT/active" && test ! -L "$JOURNAL_ROOT/active"
if grep -Eq 'RESTORE-MUST-NOT-RUN|RECOVERY-FIREWALL-MUST-NOT-RUN' "$actions"; then exit 91; fi
`), 60_000);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  const phaseCrashes = [
    ['existing-layout-stopping', 'stopping'],
    ['existing-layout-snapshotting', 'snapshotting'],
    ['existing-layout-prepared', 'prepared'],
    ['existing-layout-installing', 'installing'],
    ['existing-layout-linked', 'linked'],
    ['existing-layout-committed', 'committed']
  ];

  for (const [point, phase] of phaseCrashes) {
    await t.test(`${point} retries from durable ${phase} without rollback`, () => {
      const result = runBash(existingLayoutFixture(`
set +e
(
  export TM_BOOTSTRAP_TEST_SIGKILL_AT=${shellQuote(point)}
  bootstrap_run_new_migration > "$root/crash.out"
  exit 90
)
crash_status=$?
set -e
test "$crash_status" -eq 137
unset TM_BOOTSTRAP_TEST_SIGKILL_AT
discover_migration_journal
read_journal
test "$JOURNAL_TERMINAL_STATE" = live
test "$JOURNAL_PHASE" = ${shellQuote(phase)}
test "$(external_layout_marker_state)" = absent

recover_interrupted_migration
test "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME" = committed-recovered
validate_external_layout_marker
discover_migration_journal
test "$JOURNAL_PRESENT" = 1
test "$JOURNAL_TERMINAL_STATE" = terminal-pending
test "$JOURNAL_PHASE" = committed
if grep -Eq 'RESTORE-MUST-NOT-RUN|RECOVERY-FIREWALL-MUST-NOT-RUN' "$actions"; then exit 92; fi

bootstrap_terminal_journal_gate
test "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME" = terminal-pending
`), 60_000);

      assert.equal(result.status, 0, `${point}: ${result.stdout}\n${result.stderr}`);
    });
  }

  await t.test('marker publication crash leaves committed live evidence and retry performs retirement only', () => {
    const result = runBash(existingLayoutFixture(`
set +e
(
  export TM_BOOTSTRAP_TEST_SIGKILL_AT=marker-durable
  bootstrap_run_new_migration > "$root/marker-crash.out"
  exit 90
)
crash_status=$?
set -e
test "$crash_status" -eq 137
unset TM_BOOTSTRAP_TEST_SIGKILL_AT
validate_external_layout_marker
discover_migration_journal
read_journal
test "$JOURNAL_TERMINAL_STATE" = live
test "$JOURNAL_PHASE" = committed

: > "$actions"
finalize_post_marker_bootstrap_journal
test "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME" = post-marker-retired
discover_migration_journal
test "$JOURNAL_PRESENT" = 1
test "$JOURNAL_TERMINAL_STATE" = terminal-pending
test ! -e "$JOURNAL_ROOT/active" && test ! -L "$JOURNAL_ROOT/active"
test ! -s "$actions"
`), 60_000);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('committed recovery crash after permanent marker durability resumes only journal retirement', {
  skip: 'superseded by the v4 three-state native protocol matrix below'
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-020202"
mkdir -m 0700 "$BACKUP_DIR"
BOOTSTRAP_OWNER_TOKEN=23232323232323232323232323232323
begin_migration_journal committed
set_migration_phase committed
validate_exact_link() { :; }
validate_external_runtime() { :; }
database_quick_check() { :; }
actions="$root/actions"
restore_runtime_snapshot() { printf 'RESTORE-MUST-NOT-RUN\n' >> "$actions"; return 98; }

set +e
(
  export TM_BOOTSTRAP_TEST_SIGKILL_AT=marker-durable
  recover_interrupted_migration
  exit 90
)
killed_status=$?
set -e
test "$killed_status" -eq 137
unset TM_BOOTSTRAP_TEST_SIGKILL_AT
validate_external_layout_marker
discover_migration_journal
test "$JOURNAL_PRESENT" = 1

finalize_post_marker_bootstrap_journal
finalize_post_marker_bootstrap_journal
discover_migration_journal
test "$JOURNAL_PRESENT" = 0
test ! -e "$actions"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('journal retirement never removes a final-boundary replacement directory', {
  skip: 'superseded by immutable append-only terminal generations'
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260731-110101"
mkdir -m 0700 "$BACKUP_DIR"
BOOTSTRAP_OWNER_TOKEN=11111111111111111111111111111111
begin_migration_journal

export TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT=retire-final-boundary
set +e
clear_migration_journal
retire_status=$?
set -e
unset TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT
test "$retire_status" -ne 0
replacement="$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.active.retired.*' -print -quit)"
original="$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.active.test-original.*' -print -quit)"
test -n "$replacement" && test -n "$original"
test -f "$replacement/replacement"
test "$(cat "$replacement/replacement")" = replacement-must-survive
test -f "$original/retire-intent"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('every staged retirement marker durability boundary resumes twice without restore', {
  skip: 'superseded by the v4 three-state native protocol matrix below'
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT" "$STATE_ROOT" "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" "$ENV_DIR"
printf 'env\n' > "$ENV_FILE"
printf 'db\n' > "$DB_DIR/turingmarket.db"
chmod 0600 "$ENV_FILE" "$DB_DIR/turingmarket.db"
ln -s "$ENV_FILE" "$LIVE_DIR/.env"
ln -s "$DB_DIR" "$LIVE_DIR/server/db"
ln -s "$UPLOAD_DIR" "$LIVE_DIR/uploads"
ln -s "$TMP_DIR" "$LIVE_DIR/tmp"
commit_external_layout_marker

actions="$root/retire-actions"
restore_runtime_snapshot() { printf 'RESTORE-MUST-NOT-RUN\n' >> "$actions"; return 98; }
points=(
  retire-intent-stage-opened
  retire-intent-stage-partial
  retire-intent-stage-file-fsync
  retire-intent-stage-dir-fsync
  retire-intent-published
  retire-intent-publish-dir-fsync
  retire-active-renamed
  retire-complete-stage-opened
  retire-complete-stage-partial
  retire-complete-stage-file-fsync
  retire-complete-stage-dir-fsync
  retire-complete-published
  retire-complete-publish-dir-fsync
)
counter=0
for point in "\${points[@]}"; do
  counter=$((counter + 1))
  BOOTSTRAP_OWNER_TOKEN="$(printf '%032x' "$counter")"
  BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260731-12$(printf '%04d' "$counter")"
  mkdir -m 0700 "$BACKUP_DIR"
  begin_migration_journal committed
  set_migration_phase committed
  set +e
  (
    export TM_BOOTSTRAP_TEST_JOURNAL_SIGKILL_AT="$point"
    clear_migration_journal
    exit 90
  )
  killed_status=$?
  set -e
  test "$killed_status" -eq 137
  unset TM_BOOTSTRAP_TEST_JOURNAL_SIGKILL_AT
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=""
  JOURNAL_PRESENT=0
  finalize_post_marker_bootstrap_journal
  finalize_post_marker_bootstrap_journal
  discover_migration_journal
  test "$JOURNAL_PRESENT" = 0
done
test ! -e "$actions"
completed="$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.active.retired.*' | wc -l)"
test "$completed" -eq "\${#points[@]}"
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('partial retirement marker I/O failures retain recoverable staging evidence', {
  skip: 'superseded by anonymous-fd generation publication'
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT" "$REMOTE_ROOT"
: > "$EXTERNAL_LAYOUT_MARKER"
actions="$root/io-actions"
restore_runtime_snapshot() { printf 'RESTORE-MUST-NOT-RUN\n' >> "$actions"; return 98; }
counter=0
for point in retire-intent-stage-partial retire-complete-stage-partial; do
  counter=$((counter + 1))
  BOOTSTRAP_OWNER_TOKEN="$(printf '%032x' "$((counter + 400))")"
  BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-03$(printf '%04d' "$counter")"
  mkdir -m 0700 "$BACKUP_DIR"
  begin_migration_journal
  set +e
  export TM_BOOTSTRAP_TEST_JOURNAL_IOERROR_AT="$point"
  clear_migration_journal
  failure_status=$?
  unset TM_BOOTSTRAP_TEST_JOURNAL_IOERROR_AT
  set -e
  test "$failure_status" -ne 0
  finalize_post_marker_bootstrap_journal
  finalize_post_marker_bootstrap_journal
  discover_migration_journal
  test "$JOURNAL_PRESENT" = 0
done
test ! -e "$actions"
`), 60_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('journal retirement never unlinks a substituted retained leaf', {
  skip: 'superseded by immutable append-only terminal generations'
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-010101"
mkdir -m 0700 "$BACKUP_DIR"
BOOTSTRAP_OWNER_TOKEN=12121212121212121212121212121212
begin_migration_journal

export TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT=retire-phase-leaf-after-intent
set +e
clear_migration_journal
retire_status=$?
set -e
unset TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT
test "$retire_status" -ne 0
retired="$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.active.retired.*' -print -quit)"
test -n "$retired"
test -f "$retired/phase"
test "$(cat "$retired/phase")" = replacement-phase-must-survive
original="$(find "$retired" -mindepth 1 -maxdepth 1 -type f -name '.phase.test-original.*' -print -quit)"
test -n "$original"
test "$(cat "$original")" = stopping
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('journal capacity gates top-level, begin, claim, and active retire but permits retiring completion', {
  skip: 'superseded by the v4 atomic capacity reservation matrix below'
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
for counter in $(seq 1 31); do
  BOOTSTRAP_OWNER_TOKEN="$(printf '%032x' "$counter")"
  BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260731-13$(printf '%04d' "$counter")"
  mkdir -m 0700 "$BACKUP_DIR"
  begin_migration_journal
  clear_migration_journal
done
preflight_migration_journal_capacity

BOOTSTRAP_OWNER_TOKEN=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260731-139998"
mkdir -m 0700 "$BACKUP_DIR"
begin_migration_journal
clear_migration_journal
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.active.retired.*' | wc -l)" -eq 32

set +e
preflight_migration_journal_capacity 2>"$root/preflight.err"
preflight_status=$?
set -e
test "$preflight_status" -ne 0
grep -Fq 'offline root maintenance is required' "$root/preflight.err"

BOOTSTRAP_OWNER_TOKEN=ffffffffffffffffffffffffffffffff
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260731-139999"
mkdir -m 0700 "$BACKUP_DIR"
set +e
begin_migration_journal
capacity_status=$?
set -e
test "$capacity_status" -ne 0
test ! -e "$JOURNAL_DIR" && test ! -L "$JOURNAL_DIR"
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.active.retired.*' | wc -l)" -eq 32

mkdir -m 0700 "$JOURNAL_DIR"
printf '1\n' > "$JOURNAL_DIR/schema-version"
printf '%s\n' "$BOOTSTRAP_OWNER_TOKEN" > "$JOURNAL_DIR/owner-token"
printf '%s\n' "$BACKUP_DIR" > "$JOURNAL_DIR/backup-dir"
printf 'stopping\n' > "$JOURNAL_DIR/phase"
chmod 0600 "$JOURNAL_DIR"/*
discover_migration_journal
set +e
claim_migration_journal
claim_status=$?
set -e
test "$claim_status" -ne 0
test -d "$JOURNAL_DIR"
set +e
clear_migration_journal
active_retire_status=$?
set -e
test "$active_retire_status" -ne 0
test -d "$JOURNAL_DIR"
rm -rf -- "$JOURNAL_DIR"

retired="$JOURNAL_ROOT/.active.retired.99999.1"
mkdir -m 0700 "$retired"
printf '1\n' > "$retired/schema-version"
printf '%s\n' "$BOOTSTRAP_OWNER_TOKEN" > "$retired/owner-token"
printf '%s\n' "$BACKUP_DIR" > "$retired/backup-dir"
printf 'stopping\n' > "$retired/phase"
chmod 0600 "$retired"/*
directory_identity="$(stat -c '%d:%i' "$retired")"
intent="2:${directory_identity}:schema-version=$(stat -c '%d.%i' "$retired/schema-version"),owner-token=$(stat -c '%d.%i' "$retired/owner-token"),backup-dir=$(stat -c '%d.%i' "$retired/backup-dir"),phase=$(stat -c '%d.%i' "$retired/phase")"
printf '%s\n' "$intent" > "$retired/retire-intent"
chmod 0600 "$retired/retire-intent"
sync -f "$retired/retire-intent"
sync_directory "$retired"
sync_directory "$JOURNAL_ROOT"
discover_migration_journal
test "$JOURNAL_RETIRING" = 1
preflight_migration_journal_capacity
clear_migration_journal
discover_migration_journal
test "$JOURNAL_PRESENT" = 0
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.active.retired.*' | wc -l)" -eq 33
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('v4 terminal pending and explicit acknowledgement survive every anonymous publication boundary', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
actions="$root/prohibited-actions"
restore_runtime_snapshot() { printf 'restore\n' >> "$actions"; return 98; }
cleanup_stages() { printf 'cleanup\n' >> "$actions"; return 98; }
install_loopback_firewall_for_recovery() { printf 'firewall\n' >> "$actions"; return 98; }
restart_current_release() { printf 'restart\n' >> "$actions"; return 98; }

counter=0
for failure_mode in ioerror sigkill; do
  for suffix in stage-opened stage-partial stage-file-fsync published publish-dir-fsync; do
    counter=$((counter + 1))
    BOOTSTRAP_OWNER_TOKEN="$(printf '%032x' "$counter")"
    BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-06$(printf '%04d' "$counter")"
    mkdir -m 0700 "$BACKUP_DIR"
    begin_migration_journal
    set_migration_phase snapshotting
    set_migration_phase prepared

    pending_point="terminal-pending-$suffix"
    set +e
    if [ "$failure_mode" = sigkill ]; then
      (export TM_BOOTSTRAP_TEST_JOURNAL_SIGKILL_AT="$pending_point"; clear_migration_journal; exit 90)
      pending_status=$?
      test "$pending_status" -eq 137
    else
      (export TM_BOOTSTRAP_TEST_JOURNAL_IOERROR_AT="$pending_point"; clear_migration_journal; exit 90)
      pending_status=$?
      test "$pending_status" -ne 0
    fi
    set -e

    JOURNAL_DIR_IDENTITY=
    JOURNAL_HEAD_DIGEST=
    discover_migration_journal
    read_journal
    if [ "$JOURNAL_TERMINAL_STATE" = live ]; then clear_migration_journal; fi
    test "$JOURNAL_TERMINAL_STATE" = terminal-pending
    terminal_id="$JOURNAL_TERMINAL_ID"
    first_gate="$(bootstrap_terminal_journal_gate)"
    second_gate="$(bootstrap_terminal_journal_gate)"
    test "$first_gate" = "BOOTSTRAP_TERMINAL_ID=$terminal_id"
    test "$second_gate" = "$first_gate"

    consumed_point="terminal-consumed-$suffix"
    set +e
    if [ "$failure_mode" = sigkill ]; then
      (export TM_BOOTSTRAP_TEST_JOURNAL_SIGKILL_AT="$consumed_point"; bootstrap_ack_terminal_generation "$terminal_id"; exit 90)
      consumed_status=$?
      test "$consumed_status" -eq 137
    else
      (export TM_BOOTSTRAP_TEST_JOURNAL_IOERROR_AT="$consumed_point"; bootstrap_ack_terminal_generation "$terminal_id"; exit 90)
      consumed_status=$?
      test "$consumed_status" -ne 0
    fi
    set -e

    JOURNAL_DIR_IDENTITY=
    JOURNAL_HEAD_DIGEST=
    discover_migration_journal "$terminal_id"
    read_journal
    if [ "$JOURNAL_TERMINAL_STATE" = terminal-pending ]; then
      bootstrap_ack_terminal_generation "$terminal_id"
    fi
    discover_migration_journal "$terminal_id"
    read_journal
    test "$JOURNAL_TERMINAL_STATE" = terminal-consumed
    bootstrap_ack_terminal_generation "$terminal_id"
    bootstrap_terminal_journal_gate
    test -z "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME"
  done
done
test ! -e "$actions"
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 10
`), 120_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('v4 gen0 publication retains incomplete private staging and promotes only a complete generation', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
reserve_migration_journal_capacity
points=(
  begin-format-stage-opened
  begin-format-stage-partial
  begin-format-stage-file-fsync
  begin-format-published
  begin-format-publish-dir-fsync
  begin-generation-stage-opened
  begin-generation-stage-partial
  begin-generation-stage-file-fsync
  begin-generation-published
  begin-generation-publish-dir-fsync
  begin-private-dir-fsync
  begin-published
  begin-publish-dir-fsync
)
counter=100
for failure_mode in ioerror sigkill; do
  for point in "\${points[@]}"; do
    counter=$((counter + 1))
    BOOTSTRAP_OWNER_TOKEN="$(printf '%032x' "$counter")"
    BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-07$(printf '%04d' "$counter")"
    mkdir -m 0700 "$BACKUP_DIR"
    set +e
    if [ "$failure_mode" = sigkill ]; then
      (export TM_BOOTSTRAP_TEST_JOURNAL_SIGKILL_AT="$point"; begin_migration_journal; exit 90)
      begin_status=$?
      test "$begin_status" -eq 137
    else
      (export TM_BOOTSTRAP_TEST_JOURNAL_IOERROR_AT="$point"; begin_migration_journal; exit 90)
      begin_status=$?
      test "$begin_status" -ne 0
    fi
    set -e

    JOURNAL_DIR_IDENTITY=
    JOURNAL_HEAD_DIGEST=
    discover_migration_journal
    if [ "$JOURNAL_PRESENT" = 1 ]; then
      read_journal
      test "$JOURNAL_TERMINAL_STATE" = live
      test "$JOURNAL_OWNER_TOKEN" = "$BOOTSTRAP_OWNER_TOKEN"
      clear_migration_journal
      bootstrap_ack_terminal_generation "$JOURNAL_TERMINAL_ID"
    else
      test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.active.initializing.*' | wc -l)" -ge 1
    fi
  done
done
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 26
if find "$JOURNAL_ROOT" -mindepth 2 -maxdepth 2 -type f -name 'generation-*' -size 0 | grep -q .; then
  exit 91
fi
`), 150_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('v4 phase and adoption generations remain coherent across every publication boundary', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT"
suffixes=(stage-opened stage-partial stage-file-fsync published publish-dir-fsync)
counter=200
for failure_mode in ioerror sigkill; do
  for suffix in "\${suffixes[@]}"; do
    counter=$((counter + 1))
    JOURNAL_ROOT="$root/journal-$counter"
    JOURNAL_DIR="$JOURNAL_ROOT/active"
    JOURNAL_ROOT_TOKEN=
    JOURNAL_CAPACITY_RESERVED=0
    JOURNAL_RESERVATION_MODE=
    JOURNAL_DIR_IDENTITY=
    JOURNAL_HEAD_DIGEST=
    JOURNAL_PRESENT=0
    install -d -m 0700 "$JOURNAL_ROOT"
    BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-08$(printf '%04d' "$counter")"
    mkdir -m 0700 "$BACKUP_DIR"
    BOOTSTRAP_OWNER_TOKEN="$(printf '%032x' "$counter")"
    begin_migration_journal

    set +e
    set_migration_phase prepared
    skip_status=$?
    set -e
    test "$skip_status" -ne 0
    read_journal
    test "$JOURNAL_PHASE" = stopping

    target_phase=snapshotting
    point="phase-generation-$suffix"
    set +e
    if [ "$failure_mode" = sigkill ]; then
      (export TM_BOOTSTRAP_TEST_JOURNAL_SIGKILL_AT="$point"; set_migration_phase "$target_phase"; exit 90)
      transition_status=$?
      test "$transition_status" -eq 137
    else
      (export TM_BOOTSTRAP_TEST_JOURNAL_IOERROR_AT="$point"; set_migration_phase "$target_phase"; exit 90)
      transition_status=$?
      test "$transition_status" -ne 0
    fi
    set -e
    JOURNAL_DIR_IDENTITY=
    discover_migration_journal
    read_journal
    set_migration_phase "$target_phase"
    read_journal
    test "$JOURNAL_PHASE" = "$target_phase"
    generation_count_before="$(find "$JOURNAL_DIR" -mindepth 1 -maxdepth 1 -type f -name 'generation-*' | wc -l)"
    set_migration_phase "$target_phase"
    generation_count_after="$(find "$JOURNAL_DIR" -mindepth 1 -maxdepth 1 -type f -name 'generation-*' | wc -l)"
    test "$generation_count_after" -eq "$generation_count_before"

    set +e
    set_migration_phase stopping
    regression_status=$?
    set -e
    test "$regression_status" -ne 0
    read_journal
    test "$JOURNAL_PHASE" = snapshotting

    counter=$((counter + 1))
    prior_owner="$JOURNAL_OWNER_TOKEN"
    BOOTSTRAP_OWNER_TOKEN="$(printf '%032x' "$counter")"
    point="adopt-generation-$suffix"
    set +e
    if [ "$failure_mode" = sigkill ]; then
      (export TM_BOOTSTRAP_TEST_JOURNAL_SIGKILL_AT="$point"; adopt_migration_journal; exit 90)
      adoption_status=$?
      test "$adoption_status" -eq 137
    else
      (export TM_BOOTSTRAP_TEST_JOURNAL_IOERROR_AT="$point"; adopt_migration_journal; exit 90)
      adoption_status=$?
      test "$adoption_status" -ne 0
    fi
    set -e
    JOURNAL_DIR_IDENTITY=
    discover_migration_journal
    read_journal
    if [ "$JOURNAL_OWNER_TOKEN" = "$prior_owner" ]; then adopt_migration_journal; fi
    read_journal
    test "$JOURNAL_OWNER_TOKEN" = "$BOOTSTRAP_OWNER_TOKEN"
    generation_count="$(find "$JOURNAL_DIR" -mindepth 1 -maxdepth 1 -type f -name 'generation-*' | wc -l)"
    test "$generation_count" -ge 3
    release_migration_journal_capacity_reservation
  done
done
`), 150_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('v4 generation substitution and mixed-generation ABA retain evidence and fail closed', {
  skip: nativeLinuxOnly
}, async (t) => {
  await t.test('publication leaf substitution', () => {
    const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-080201"
mkdir -m 0700 "$BACKUP_DIR"
BOOTSTRAP_OWNER_TOKEN=11111111111111111111111111111111
begin_migration_journal
export TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT=generation-leaf-before-publish
set +e
set_migration_phase snapshotting
phase_status=$?
set -e
test "$phase_status" -ne 0
test "$(cat "$JOURNAL_DIR/generation-00000000")" = replacement-generation-must-survive
original="$(find "$JOURNAL_DIR" -mindepth 1 -maxdepth 1 -type f -name '.generation-00000000.test-original.*' -print -quit)"
test -n "$original"
`));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  await t.test('coherent-read ABA', () => {
    const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-080202"
mkdir -m 0700 "$BACKUP_DIR"
BOOTSTRAP_OWNER_TOKEN=22222222222222222222222222222222
begin_migration_journal
export TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT=read-mixed-generation-aba
set +e
read_journal
read_status=$?
set -e
test "$read_status" -ne 0
replacement="$(find "$JOURNAL_DIR" -mindepth 1 -maxdepth 1 -type f -name '.generation-*.test-replacement.*' -print -quit)"
test -n "$replacement"
test "$(cat "$replacement")" = replacement-generation-must-survive
unset TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT
if read_journal; then exit 91; fi
`));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('permanent marker anonymous publication is no-replace and crash recoverable at every boundary', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
BOOTSTRAP_OWNER_TOKEN=33333333333333333333333333333333
points=(
  external-marker-opened
  external-marker-partial
  external-marker-file-fsync
  external-marker-before-publish
  external-marker-published
  external-marker-publish-dir-fsync
)
counter=0
for failure_mode in ioerror sigkill; do
  for point in "\${points[@]}"; do
    counter=$((counter + 1))
    REMOTE_ROOT="$root/marker-$counter"
    EXTERNAL_LAYOUT_MARKER="$REMOTE_ROOT/.external-runtime-layout-v1"
    EXTERNAL_LAYOUT_ROOT_TOKEN=
    mkdir -m 0700 "$REMOTE_ROOT"
    set +e
    if [ "$failure_mode" = sigkill ]; then
      (export TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_SIGKILL_AT="$point"; commit_external_layout_marker; exit 90)
      marker_status=$?
      test "$marker_status" -eq 137
    else
      (export TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_IOERROR_AT="$point"; commit_external_layout_marker; exit 90)
      marker_status=$?
      test "$marker_status" -ne 0
    fi
    set -e
    if [ -e "$EXTERNAL_LAYOUT_MARKER" ]; then validate_external_layout_marker; else commit_external_layout_marker; fi
    validate_external_layout_marker
    if find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -name '.external-runtime-layout-v1.stage.*' -print -quit | grep -q .; then
      exit 91
    fi
  done
done

REMOTE_ROOT="$root/replacement-root"
EXTERNAL_LAYOUT_MARKER="$REMOTE_ROOT/.external-runtime-layout-v1"
EXTERNAL_LAYOUT_ROOT_TOKEN=
mkdir -m 0700 "$REMOTE_ROOT"
export TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_REPLACE_AT=external-marker-before-publish
set +e
commit_external_layout_marker
replacement_status=$?
set -e
unset TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_REPLACE_AT
test "$replacement_status" -ne 0
test "$(cat "$EXTERNAL_LAYOUT_MARKER")" = foreign-marker-must-survive

REMOTE_ROOT="$root/stale-root"
EXTERNAL_LAYOUT_MARKER="$REMOTE_ROOT/.external-runtime-layout-v1"
EXTERNAL_LAYOUT_ROOT_TOKEN=
mkdir -m 0700 "$REMOTE_ROOT"
for counter in $(seq 1 9); do
  printf 'stale-%s\n' "$counter" > "$REMOTE_ROOT/.external-runtime-layout-v1.stage.$(printf '%032x' "$counter")"
done
chmod 0600 "$REMOTE_ROOT"/.external-runtime-layout-v1.stage.*
set +e
external_layout_marker_state
stale_status=$?
set -e
test "$stale_status" -ne 0
test "$(find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -type f -name '.external-runtime-layout-v1.stage.*' | wc -l)" -eq 9
`), 120_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('terminal phase provenance binds committed marker identity and precommit marker absence', {
  skip: nativeLinuxOnly
}, async (t) => {
  await t.test('committed proof precedes pending and a missing bound marker blocks acknowledgement', () => {
    const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-090101"
mkdir -m 0700 "$BACKUP_DIR"
BOOTSTRAP_OWNER_TOKEN=44444444444444444444444444444444
begin_migration_journal committed
clear_migration_journal
terminal_id="$JOURNAL_TERMINAL_ID"
test "$JOURNAL_TERMINAL_STATE" = terminal-pending
validate_external_layout_marker
bound_proof="$EXTERNAL_LAYOUT_MARKER_PROOF"
test "$JOURNAL_MARKER_PROOF" = "$bound_proof"
rm -- "$EXTERNAL_LAYOUT_MARKER"
sync_directory "$REMOTE_ROOT"
require_root() { :; }
require_exact_host() { :; }
set +e
bootstrap_ack_terminal_command "$terminal_id"
ack_status=$?
set -e
test "$ack_status" -ne 0
discover_migration_journal "$terminal_id"
read_journal
test "$JOURNAL_TERMINAL_STATE" = terminal-pending
test "$JOURNAL_MARKER_PROOF" = "$bound_proof"
`));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  await t.test('precommit pending refuses present or corrupt permanent evidence', () => {
    const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
BOOTSTRAP_OWNER_TOKEN=55555555555555555555555555555555
commit_external_layout_marker
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-090102"
mkdir -m 0700 "$BACKUP_DIR"
begin_migration_journal
set_migration_phase snapshotting
set +e
clear_migration_journal
present_status=$?
set -e
test "$present_status" -ne 0
read_journal
test "$JOURNAL_TERMINAL_STATE" = live
printf 'corrupt\n' > "$EXTERNAL_LAYOUT_MARKER"
set +e
clear_migration_journal
corrupt_status=$?
set -e
test "$corrupt_status" -ne 0
read_journal
test "$JOURNAL_TERMINAL_STATE" = live
`));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('legacy acknowledged evidence maps to pending until an explicit id-bound acknowledgement', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
reserve_migration_journal_capacity
legacy_owner=66666666666666666666666666666666
legacy_backup="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-090103"
mkdir -m 0700 "$legacy_backup" "$JOURNAL_DIR"
printf 'journal-format-v3\n' > "$JOURNAL_DIR/journal-format"
python3 - "$JOURNAL_DIR/generation-00000000" "$legacy_owner" "$legacy_backup" <<'PY'
import json
import os
import sys

target, owner, backup = sys.argv[1:]
record = {
    'backupDir': backup,
    'generation': 0,
    'ownerToken': owner,
    'phase': 'committed',
    'previous': None,
    'schemaVersion': 3,
}
payload = (json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, payload)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
printf 'legacy-observed-evidence\n' > "$JOURNAL_DIR/retire-acknowledged"
chmod 0600 "$JOURNAL_DIR"/*
sync_directory "$JOURNAL_DIR"
sync_directory "$JOURNAL_ROOT"

install -d -m 0700 "$STATE_ROOT" "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" "$ENV_DIR"
printf 'runtime-env\n' > "$ENV_FILE"
chmod 0600 "$ENV_FILE"
server_source="$(dirname "$(dirname "$TM_BOOTSTRAP_UNDER_TEST")")"
ln -s "$server_source/node_modules" "$LIVE_DIR/server/node_modules"
DB_QUICK_CHECK_PATH="$DB_DIR/turingmarket.db" node <<'NODE'
const Database = require('better-sqlite3');
const database = new Database(process.env.DB_QUICK_CHECK_PATH);
database.exec('CREATE TABLE provenance_check (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
database.prepare('INSERT INTO provenance_check (value) VALUES (?)').run('durable');
database.close();
NODE
chmod 0600 "$DB_DIR/turingmarket.db"
ln -s "$DB_DIR" "$LIVE_DIR/server/db"
ln -s "$UPLOAD_DIR" "$LIVE_DIR/uploads"
ln -s "$TMP_DIR" "$LIVE_DIR/tmp"

discover_migration_journal
test "$JOURNAL_TERMINAL_STATE" = terminal-pending
terminal_id="$JOURNAL_TERMINAL_ID"
first="$(bootstrap_terminal_journal_gate)"
second="$(bootstrap_terminal_journal_gate)"
test "$first" = "BOOTSTRAP_TERMINAL_ID=$terminal_id"
test "$second" = "$first"
test "$(external_layout_marker_state)" = absent
require_root() { :; }
require_exact_host() { :; }
set +e
bootstrap_ack_terminal_command "$terminal_id"
unproven_status=$?
set -e
test "$unproven_status" -ne 0
test "$(external_layout_marker_state)" = absent
discover_migration_journal "$terminal_id"
read_journal
test "$JOURNAL_TERMINAL_STATE" = terminal-pending

ln -s "$ENV_FILE" "$LIVE_DIR/.env"
bootstrap_ack_terminal_command "$terminal_id"
validate_external_layout_marker
test -n "$EXTERNAL_LAYOUT_MARKER_PROOF"
discover_migration_journal "$terminal_id"
read_journal
test "$JOURNAL_TERMINAL_STATE" = terminal-consumed
test -f "$JOURNAL_DIR/terminal-explicit-ack-v1"
bootstrap_ack_terminal_generation "$terminal_id"
bootstrap_terminal_journal_gate
test -z "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME"
`), 60_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('journal root anchor rejects rename-recreate rebinding while retaining both roots', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$JOURNAL_ROOT"
reserve_migration_journal_capacity
anchor_token="$JOURNAL_ROOT_TOKEN"
release_migration_journal_capacity_reservation
mv -- "$JOURNAL_ROOT" "$JOURNAL_ROOT.original"
mkdir -m 0700 "$JOURNAL_ROOT"
set +e
bind_migration_journal_root
bind_status=$?
set -e
test "$bind_status" -ne 0
test -d "$JOURNAL_ROOT"
test -d "$JOURNAL_ROOT.original"
test -f "$JOURNAL_ROOT.original/.journal-protocol.lock"
test -f "$(dirname "$JOURNAL_ROOT")/.$(basename "$JOURNAL_ROOT").root-anchor-v2"
test -n "$anchor_token"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('journal root anchor rejects a same-inode bind-mount rebind', (t) => {
  if (!privilegedLinuxAvailable(t)) return;
  const result = runPrivilegedBash(libraryHarness(`
install -d -m 0700 "$JOURNAL_ROOT"
reserve_migration_journal_capacity
release_migration_journal_capacity_reservation
mounted=0
cleanup_root_mount() {
  if [ "$mounted" -eq 1 ]; then umount -- "$JOURNAL_ROOT" || true; fi
  rm -rf -- "$root"
}
trap cleanup_root_mount EXIT
before_inode="$(stat -c '%d:%i' "$JOURNAL_ROOT")"
if ! mount --bind "$JOURNAL_ROOT" "$JOURNAL_ROOT"; then exit 77; fi
mounted=1
test "$(stat -c '%d:%i' "$JOURNAL_ROOT")" = "$before_inode"
set +e
bind_migration_journal_root
bind_status=$?
set -e
test "$bind_status" -ne 0
`), 45_000);

  assertPrivilegedFixture(t, result);
});

test('v4 capacity reservation serializes slot 32 and permits only in-place terminal append at full', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
for counter in $(seq 1 31); do
  BOOTSTRAP_OWNER_TOKEN="$(printf '%032x' "$counter")"
  BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-10$(printf '%04d' "$counter")"
  mkdir -m 0700 "$BACKUP_DIR"
  begin_migration_journal
  clear_migration_journal
  bootstrap_ack_terminal_generation "$JOURNAL_TERMINAL_ID"
done
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 31

set +e
bash --noprofile --norc -c 'source "$TM_BOOTSTRAP_UNDER_TEST"; reserve_migration_journal_capacity' 7>&-
contender_status=$?
set -e
test "$contender_status" -ne 0
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 31

BOOTSTRAP_OWNER_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-109999"
mkdir -m 0700 "$BACKUP_DIR"
begin_migration_journal
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 32
release_migration_journal_capacity_reservation
reserve_migration_journal_capacity
test "$JOURNAL_RESERVATION_MODE" = existing-live
discover_migration_journal
read_journal
clear_migration_journal
terminal_id="$JOURNAL_TERMINAL_ID"
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 32

release_migration_journal_capacity_reservation
reserve_migration_journal_capacity "$terminal_id"
test "$JOURNAL_RESERVATION_MODE" = terminal-only
discover_migration_journal "$terminal_id"
read_journal
bootstrap_ack_terminal_generation "$terminal_id"
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 32
release_migration_journal_capacity_reservation

BOOTSTRAP_OWNER_TOKEN=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-110000"
mkdir -m 0700 "$BACKUP_DIR"
set +e
begin_migration_journal
overflow_status=$?
set -e
test "$overflow_status" -ne 0
if { : >&7; } 2>/dev/null; then exit 91; fi
test "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 32
`), 180_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('normal bootstrap success emits one unambiguous ordered terminal-pending contract', () => {
  const result = runBash(libraryHarness(`
terminal_id='t1:${'9'.repeat(64)}'
require_root() { :; }
require_exact_host() { :; }
bootstrap_recover_stale_artifacts_before_reservation() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=general; }
bootstrap_terminal_journal_gate() {
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
}
external_layout_marker_state() { printf 'absent\n'; }
bootstrap_prepare_journal_run_identity() { :; }
begin_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
}
claim_live_journal_before_host_mutation() { :; }
bootstrap_prepare_control_plane() { :; }
bootstrap_arm_cleanup_recovery() { :; }
validate_sanitizer_gate_idle_state() { :; }
bootstrap_recover_stale_control_state() { :; }
validate_phase4_idle_state() { :; }
bootstrap_acquire_shared_fences() { :; }
bootstrap_run_new_migration() {
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID="$terminal_id"
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=terminal-pending
}

output="$(bootstrap_production_main)"
test "$output" = "BOOTSTRAP_OK
BOOTSTRAP_TERMINAL_ID=$terminal_id
BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending"
test "$(printf '%s\n' "$output" | grep -c '^BOOTSTRAP_OK$')" -eq 1
test "$(printf '%s\n' "$output" | grep -c '^BOOTSTRAP_TERMINAL_ID=')" -eq 1
test "$(printf '%s\n' "$output" | grep -c '^BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=')" -eq 1
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('terminal-pending entrypoint reruns return the same id before artifact or host mutation', () => {
  const result = runBash(libraryHarness(`
prohibited="$root/prohibited"
terminal_id='t1:${'a'.repeat(64)}'
terminal_owner='${'b'.repeat(32)}'
terminal_root='r2:${'c'.repeat(64)}'
terminal_entry='j2:${'c'.repeat(64)}:1:2:3'
terminal_head='${'e'.repeat(64)}'
terminal_proof=absent
terminal_backup="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-150000"
mkdir -m 0700 -p "$JOURNAL_ROOT/active"
hidden_build="$JOURNAL_ROOT/.artifact-repair-build-${'1'.repeat(32)}"
mkdir -m 0700 "$hidden_build"
printf 'pending-rerun-must-preserve-build\n' > "$hidden_build/evidence"
require_root() { :; }
require_exact_host() { :; }
bootstrap_journal_dirfd_helper() {
  if [ "$1" != peek-terminal ]; then
    printf 'journal-helper:%s\n' "$1" >> "$prohibited"
    return 88
  fi
  printf 'peek\n' >> "$root/observed"
  printf '%s\n' \
    terminal-pending "$terminal_root" active "$terminal_entry" 0 \
    "$terminal_owner" stopping "$terminal_backup" "$terminal_head" \
    "$terminal_id" "$terminal_proof"
}
validate_terminal_journal_marker_provenance() { JOURNAL_PROVENANCE_VALIDATED=1; }
bootstrap_recover_stale_artifacts_before_reservation() { printf 'artifact\n' >> "$prohibited"; return 81; }
reserve_migration_journal_capacity() { printf 'reserve\n' >> "$prohibited"; return 82; }
bootstrap_terminal_journal_gate() { printf 'terminal-gate\n' >> "$prohibited"; return 83; }
bootstrap_prepare_control_plane() { printf 'control\n' >> "$prohibited"; }
bootstrap_arm_cleanup_recovery() { printf 'arm\n' >> "$prohibited"; }
validate_sanitizer_gate_idle_state() { printf 'sanitizer\n' >> "$prohibited"; }
bootstrap_recover_stale_control_state() { printf 'stale\n' >> "$prohibited"; }
validate_phase4_idle_state() { printf 'phase4\n' >> "$prohibited"; }
bootstrap_acquire_shared_fences() { printf 'fences\n' >> "$prohibited"; }
run_committed_layout_validation() { printf 'committed\n' >> "$prohibited"; }
bootstrap_run_new_migration() { printf 'migration\n' >> "$prohibited"; }

set +e
first="$(bootstrap_production_main)"
first_status=$?
second="$(bootstrap_production_main)"
second_status=$?
set -e
test "$first_status" -eq 0
test "$second_status" -eq 0
test "$first" = "BOOTSTRAP_TERMINAL_ID=$terminal_id
BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending"
test "$second" = "$first"
test ! -e "$prohibited"
test "$(cat "$hidden_build/evidence")" = pending-rerun-must-preserve-build
test "$(cat "$root/observed")" = "peek
peek"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('terminal-pending preflight cannot publish before both control locks are held', () => {
  const result = runBash(libraryHarness(`
events="$root/events"
premature_publication="$root/premature-publication"
terminal_id='t1:${'d'.repeat(64)}'
require_root() { :; }
require_exact_host() { :; }
validate_candidate_gate_mounts() { printf '%s\n' mount-check >> "$events"; }
bootstrap_acquire_preprovisioned_control_locks() {
  BOOTSTRAP_CONTROL_LOCKS_HELD=1
  printf '%s\n' control-locks >> "$events"
}
bootstrap_terminal_journal_preflight() {
  printf '%s\n' terminal-preflight >> "$events"
  if [ "$BOOTSTRAP_CONTROL_LOCKS_HELD" != 1 ]; then
    printf '%s\n' externally-visible-root-guard > "$premature_publication"
    return 90
  fi
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID="$terminal_id"
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=terminal-pending
  printf 'BOOTSTRAP_TERMINAL_ID=%s\n' "$terminal_id"
}
bootstrap_arm_cleanup_recovery() { printf '%s\n' forbidden-arm >> "$events"; return 91; }

set +e
output="$(bootstrap_production_main)"
status=$?
set -e
if [ -e "$premature_publication" ]; then
  printf '%s\n' 'terminal preflight published before control locks' >&2
  exit 92
fi
test "$status" -eq 0
test "$output" = "BOOTSTRAP_TERMINAL_ID=$terminal_id
BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending"
test "$(cat "$events")" = "mount-check
control-locks
mount-check
terminal-preflight"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('terminal ACK cannot publish an external guard or journal mutation before both control locks', () => {
  const terminalId = `t1:${'9'.repeat(64)}`;
  const result = runBash(libraryHarness(`
events="$root/ack-events"
premature_publication="$root/premature-ack-publication"
assert_locked_before_write() {
  if [ "$BOOTSTRAP_CONTROL_LOCKS_HELD" != 1 ]; then
    printf '%s\n' "$1" > "$premature_publication"
    return 90
  fi
}
require_root() { :; }
require_exact_host() { :; }
validate_candidate_gate_mounts() {
  if [ "$BOOTSTRAP_CONTROL_LOCKS_HELD" = 1 ]; then
    printf '%s\n' locked-mount-check >> "$events"
  else
    printf '%s\n' initial-mount-check >> "$events"
  fi
}
bootstrap_acquire_preprovisioned_control_locks() {
  BOOTSTRAP_CONTROL_LOCKS_HELD=1
  printf '%s\n' control-locks >> "$events"
}
reserve_migration_journal_capacity() {
  assert_locked_before_write reserve || return $?
  printf '%s\n' reserve >> "$events"
  JOURNAL_RESERVATION_MODE=terminal-only
}
discover_migration_journal() {
  assert_locked_before_write discover || return $?
  printf '%s\n' discover >> "$events"
  JOURNAL_PRESENT=1
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY='j2:${'8'.repeat(64)}:31:41:51'
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='${terminalId}'
  JOURNAL_HEAD_DIGEST='${'7'.repeat(64)}'
  JOURNAL_MARKER_PROOF=absent
}
validate_terminal_journal_marker_provenance() {
  assert_locked_before_write provenance || return $?
  printf '%s\n' provenance >> "$events"
}
bootstrap_ack_terminal_generation() {
  assert_locked_before_write ack || return $?
  printf '%s\n' ack >> "$events"
  JOURNAL_TERMINAL_STATE=terminal-consumed
}

output="$(bootstrap_ack_terminal_command '${terminalId}')"
test ! -e "$premature_publication"
test "$output" = 'BOOTSTRAP_TERMINAL_ACKNOWLEDGED=${terminalId}'
test "$(cat "$events")" = "initial-mount-check
control-locks
locked-mount-check
reserve
discover
provenance
ack"
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('every post-marker repair SIGKILL phase is quarantined without entering restore logic', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
mkdir -m 0700 "$JOURNAL_ROOT"
actions="$root/repair-actions"
validate_external_layout_marker() { printf 'marker\n' >> "$actions"; }
validate_exact_link() { return 0; }
validate_external_runtime() { printf 'layout\n' >> "$actions"; }
database_quick_check() { printf 'database\n' >> "$actions"; }
stop_current_release() { printf 'stop\n' >> "$actions"; }
install_apparmor_profile() { printf 'apparmor\n' >> "$actions"; }
install_loopback_firewall() { printf 'firewall\n' >> "$actions"; }
restart_current_release() { printf 'restart\n' >> "$actions"; }
validate_loopback_firewall() { printf 'firewall-validate\n' >> "$actions"; }
curl() { printf 'health\n' >> "$actions"; }
validate_loopback_listener() { printf 'listener\n' >> "$actions"; }
restore_runtime_snapshot() { printf 'RESTORE-MUST-NOT-RUN\n' >> "$actions"; return 97; }

counter=0
for point in repair-published repair-stopped repair-apparmor repair-firewall repair-restarted repair-validated repair-released; do
  counter=$((counter + 1))
  old_owner="$(printf '%032x' "$((counter + 200))")"
  new_owner="$(printf '%032x' "$((counter + 300))")"
  set +e
  (
    export TM_BOOTSTRAP_OWNER_TOKEN="$old_owner"
    export TM_BOOTSTRAP_TEST_SIGKILL_AT="$point"
    BOOTSTRAP_OWNER_TOKEN="$old_owner"
    bootstrap_initialize_process_identity
    bootstrap_arm_cleanup_recovery
    run_committed_layout_validation
    exit 90
  )
  killed_status=$?
  set -e
  test "$killed_status" -eq 137

  BOOTSTRAP_OWNER_TOKEN="$new_owner"
  export TM_BOOTSTRAP_OWNER_TOKEN="$new_owner"
  unset TM_BOOTSTRAP_TEST_SIGKILL_AT
  bootstrap_initialize_process_identity
  bootstrap_recover_stale_control_state
  bootstrap_recover_stale_control_state
  if find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -name 'artifact-repair-*' -print -quit | grep -q .; then
    exit 91
  fi
done
if grep -Fq 'RESTORE-MUST-NOT-RUN' "$actions"; then exit 92; fi
`), 60_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('real entry restores service after SIGKILL between stop and phase publication', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
mkdir -m 0700 "$JOURNAL_ROOT"
actions="$root/post-stop-recovery-actions"
validate_external_layout_marker() { :; }
validate_exact_link() { :; }
validate_external_runtime() { :; }
database_quick_check() { :; }
validate_sanitizer_gate_idle_state() { :; }
stop_current_release() { printf 'stop\n' >> "$actions"; }
install_apparmor_profile() { printf 'apparmor\n' >> "$actions"; }
install_loopback_firewall() { printf 'firewall\n' >> "$actions"; }
restart_current_release() { printf 'restart\n' >> "$actions"; }
validate_loopback_firewall() { printf 'firewall-check\n' >> "$actions"; }
curl() { printf 'health\n' >> "$actions"; }
validate_loopback_listener() { printf 'listener\n' >> "$actions"; }
restore_runtime_snapshot() { printf 'RESTORE-MUST-NOT-RUN\n' >> "$actions"; return 97; }

old_owner=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
set +e
(
  BOOTSTRAP_OWNER_TOKEN="$old_owner"
  export TM_BOOTSTRAP_OWNER_TOKEN="$old_owner"
  export TM_BOOTSTRAP_TEST_SIGKILL_AT=repair-stop-complete
  bootstrap_initialize_process_identity
  run_committed_layout_validation
  exit 90
)
killed_status=$?
set -e
test "$killed_status" -eq 137
repair="$JOURNAL_ROOT/artifact-repair-$old_owner"
test -d "$repair"
test "$(cat "$repair/phase")" = repair-created

printf 'recovery-start\n' >> "$actions"
new_owner=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
BOOTSTRAP_OWNER_TOKEN="$new_owner"
export TM_BOOTSTRAP_OWNER_TOKEN="$new_owner"
unset TM_BOOTSTRAP_TEST_SIGKILL_AT
require_root() { :; }
require_exact_host() { :; }
bootstrap_prepare_control_plane() { :; }
reserve_migration_journal_capacity() { printf 'reserve\n' >> "$actions"; return 86; }
set +e
bootstrap_production_main
recovery_status=$?
set -e
test "$recovery_status" -eq 86
test "$(sed -n '/^recovery-start$/,$p' "$actions")" = "recovery-start
stop
apparmor
firewall
restart
firewall-check
health
listener
reserve"
test ! -e "$repair"
if find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -name 'artifact-repair-*' -print -quit | grep -q .; then exit 91; fi
if grep -Fq 'RESTORE-MUST-NOT-RUN' "$actions"; then exit 92; fi
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('actual artifact build crash evidence blocks the real entry before reservation', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
mkdir -m 0700 "$JOURNAL_ROOT"
validate_external_layout_marker() { :; }
validate_exact_link() { :; }
validate_external_runtime() { :; }
database_quick_check() { :; }
validate_sanitizer_gate_idle_state() { :; }
stop_current_release() { :; }
install_apparmor_profile() { :; }
install_loopback_firewall() { :; }
restart_current_release() { :; }
validate_loopback_firewall() { :; }
validate_loopback_listener() { :; }

counter=0
for point in repair-build-created repair-build-controls repair-build-ready; do
  counter=$((counter + 1))
  owner="$(printf '%032x' "$((counter + 500))")"
  stage="$JOURNAL_ROOT/.artifact-repair-build-$owner"
  set +e
  (
    BOOTSTRAP_OWNER_TOKEN="$owner"
    export TM_BOOTSTRAP_OWNER_TOKEN="$owner"
    export TM_BOOTSTRAP_TEST_SIGKILL_AT="$point"
    bootstrap_initialize_process_identity
    run_committed_layout_validation
    exit 90
  )
  killed_status=$?
  set -e
  test "$killed_status" -eq 137
  test -d "$stage"
  unset TM_BOOTSTRAP_TEST_SIGKILL_AT
  actions="$root/build-$counter-actions"
  require_root() { :; }
  require_exact_host() { :; }
  reserve_migration_journal_capacity() { printf 'FORBIDDEN-RESERVE\n' >> "$actions"; return 82; }
  set +e
  bootstrap_production_main 2> "$root/build-$counter.err"
  blocked_status=$?
  set -e
  test "$blocked_status" -ne 0
  test "$blocked_status" -ne 82
  test ! -e "$actions"
  test -d "$stage"
  rm -rf -- "$stage"
done
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('hidden artifact build members and link substitutions remain untouched on startup', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
mkdir -m 0700 "$JOURNAL_ROOT"
validate_external_layout_marker() { :; }
validate_exact_link() { :; }
validate_external_runtime() { :; }
database_quick_check() { :; }
validate_sanitizer_gate_idle_state() { :; }
stop_current_release() { :; }
install_apparmor_profile() { :; }
install_loopback_firewall() { :; }
restart_current_release() { :; }
validate_loopback_firewall() { :; }
validate_loopback_listener() { :; }

counter=0
for mode in legal unknown-member symlink hardlink; do
  counter=$((counter + 1))
  owner="$(printf '%032x' "$((counter + 600))")"
  stage="$JOURNAL_ROOT/.artifact-repair-build-$owner"
  outside="$root/outside-$mode"
  mkdir -m 0700 "$outside"
  printf '%s-sentinel\n' "$mode" > "$outside/sentinel"
  chmod 0600 "$outside/sentinel"
  set +e
  (
    BOOTSTRAP_OWNER_TOKEN="$owner"
    export TM_BOOTSTRAP_OWNER_TOKEN="$owner"
    export TM_BOOTSTRAP_TEST_SIGKILL_AT=repair-build-ready
    bootstrap_initialize_process_identity
    run_committed_layout_validation
    exit 90
  )
  killed_status=$?
  set -e
  test "$killed_status" -eq 137
  test -d "$stage/work"
  unset TM_BOOTSTRAP_TEST_SIGKILL_AT
  case "$mode" in
    legal) ;;
    unknown-member)
      printf 'unknown\n' > "$stage/unknown"
      chmod 0600 "$stage/unknown"
      ;;
    symlink)
      rmdir "$stage/work"
      ln -s "$outside" "$stage/work"
      ;;
    hardlink)
      ln "$outside/sentinel" "$stage/work/linked-sentinel"
      ;;
  esac
  actions="$root/substitution-$mode-actions"
  require_root() { :; }
  require_exact_host() { :; }
  reserve_migration_journal_capacity() { printf 'FORBIDDEN-RESERVE\n' >> "$actions"; return 82; }
  set +e
  bootstrap_production_main 2> "$root/substitution-$mode.err"
  blocked_status=$?
  set -e
  test "$blocked_status" -ne 0
  test "$blocked_status" -ne 82
  test ! -e "$actions"
  test -f "$outside/sentinel"
  if [ "$mode" = hardlink ]; then test "$(stat -c %h "$outside/sentinel")" -eq 2; fi
  if [ "$mode" = symlink ]; then test -L "$stage/work"; else test -d "$stage"; fi
  rm -rf -- "$stage" "$outside"
done
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('hidden artifact build bind mount blocks startup without touching mounted content', (t) => {
  if (!privilegedLinuxAvailable(t)) return;
  const result = runPrivilegedBash(libraryHarness(`
mkdir -m 0700 "$JOURNAL_ROOT"
validate_external_layout_marker() { :; }
validate_exact_link() { :; }
validate_external_runtime() { :; }
database_quick_check() { :; }
validate_sanitizer_gate_idle_state() { :; }
stop_current_release() { :; }
install_apparmor_profile() { :; }
install_loopback_firewall() { :; }
restart_current_release() { :; }
validate_loopback_firewall() { :; }
validate_loopback_listener() { :; }
owner=cccccccccccccccccccccccccccccccc
stage="$JOURNAL_ROOT/.artifact-repair-build-$owner"
outside="$root/outside-build-mount"
mkdir -m 0700 "$outside"
printf 'mounted-build-must-survive\n' > "$outside/sentinel"
chmod 0600 "$outside/sentinel"
set +e
(
  BOOTSTRAP_OWNER_TOKEN="$owner"
  export TM_BOOTSTRAP_OWNER_TOKEN="$owner"
  export TM_BOOTSTRAP_TEST_SIGKILL_AT=repair-build-ready
  bootstrap_initialize_process_identity
  run_committed_layout_validation
  exit 90
)
killed_status=$?
set -e
test "$killed_status" -eq 137
unset TM_BOOTSTRAP_TEST_SIGKILL_AT
mounted=0
cleanup_mount() {
  if [ "$mounted" -eq 1 ]; then umount -- "$stage/work" || true; fi
}
trap cleanup_mount EXIT
if ! mount --bind "$outside" "$stage/work"; then exit 77; fi
mounted=1
actions="$root/build-mount-actions"
require_root() { :; }
require_exact_host() { :; }
reserve_migration_journal_capacity() { printf 'FORBIDDEN-RESERVE\n' >> "$actions"; return 82; }
set +e
bootstrap_production_main 2> "$root/build-mount.err"
blocked_status=$?
set -e
test "$blocked_status" -ne 0
test "$blocked_status" -ne 82
test ! -e "$actions"
test -f "$outside/sentinel"
test "$(cat "$outside/sentinel")" = mounted-build-must-survive
`), 90_000);

  assertPrivilegedFixture(t, result);
});

test('durable journal root and terminal proof survive reboot while same-boot mount substitution is rejected', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$BACKUP_ROOT" "$JOURNAL_ROOT"
export TM_BOOTSTRAP_TEST_BOOT_ID=11111111-1111-4111-8111-111111111111
export TM_BOOTSTRAP_TEST_MOUNT_ID_OFFSET=0
reserve_migration_journal_capacity
durable_root_token="$JOURNAL_ROOT_TOKEN"
BOOTSTRAP_OWNER_TOKEN=77777777777777777777777777777777
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-130001"
mkdir -m 0700 "$BACKUP_DIR"
begin_migration_journal committed
clear_migration_journal
terminal_id="$JOURNAL_TERMINAL_ID"
terminal_proof="$JOURNAL_MARKER_PROOF"
[[ "$terminal_proof" =~ ^m2: ]]
release_migration_journal_capacity_reservation

JOURNAL_ROOT_TOKEN=
EXTERNAL_LAYOUT_ROOT_TOKEN=
export TM_BOOTSTRAP_TEST_MOUNT_ID_OFFSET=4096
set +e
bootstrap_terminal_journal_preflight > "$root/same-boot-preflight.out"
same_boot_preflight_status=$?
bind_migration_journal_root
same_boot_status=$?
set -e
test "$same_boot_preflight_status" -ne 0
test "$same_boot_status" -ne 0

JOURNAL_ROOT_TOKEN=
EXTERNAL_LAYOUT_ROOT_TOKEN=
export TM_BOOTSTRAP_TEST_BOOT_ID=22222222-2222-4222-8222-222222222222
preflight="$(bootstrap_terminal_journal_preflight)"
test "$preflight" = "BOOTSTRAP_TERMINAL_ID=$terminal_id"
test "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME" = terminal-pending
test "$JOURNAL_CAPACITY_RESERVED" = 0

JOURNAL_ROOT_TOKEN=
EXTERNAL_LAYOUT_ROOT_TOKEN=
bind_migration_journal_root
test "$JOURNAL_ROOT_TOKEN" = "$durable_root_token"
validate_external_layout_marker
test "$EXTERNAL_LAYOUT_MARKER_PROOF" = "$terminal_proof"

JOURNAL_ROOT_TOKEN=
EXTERNAL_LAYOUT_ROOT_TOKEN=
require_root() { :; }
require_exact_host() { :; }
bootstrap_ack_terminal_command "$terminal_id"
discover_migration_journal "$terminal_id"
read_journal
test "$JOURNAL_TERMINAL_STATE" = terminal-consumed
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('production entrypoint recovers a validated stale artifact before capacity and rejects unknown artifact evidence', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
install -d -m 0700 "$JOURNAL_ROOT"
old_owner=88888888888888888888888888888888
new_owner=99999999999999999999999999999999
repair="$JOURNAL_ROOT/artifact-repair-$old_owner"
(
  BOOTSTRAP_OWNER_TOKEN="$old_owner"
  export TM_BOOTSTRAP_OWNER_TOKEN="$old_owner"
  bootstrap_initialize_process_identity
  mkdir -m 0700 "$repair"
  bootstrap_write_generation "$repair" artifact-repair repair-created
)
test -d "$repair"

actions="$root/artifact-main-actions"
require_root() { :; }
require_exact_host() { :; }
bootstrap_prepare_journal_run_identity() {
  BOOTSTRAP_OWNER_TOKEN="$new_owner"
  export TM_BOOTSTRAP_OWNER_TOKEN="$new_owner"
  bootstrap_initialize_process_identity
}
bootstrap_prepare_control_plane() { :; }
validate_sanitizer_gate_idle_state() { :; }
reserve_migration_journal_capacity() {
  printf 'reserve\n' >> "$actions"
  if find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -name 'artifact-repair-*' -print -quit | grep -q .; then
    return 73
  fi
  JOURNAL_RESERVATION_MODE=general
}
bootstrap_terminal_journal_gate() {
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
}
external_layout_marker_state() { printf 'absent\n'; }
begin_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
}
claim_live_journal_before_host_mutation() { :; }
bootstrap_arm_cleanup_recovery() { return 79; }

set +e
bootstrap_production_main
recovered_status=$?
set -e
test "$recovered_status" -eq 79
test "$(cat "$actions")" = reserve
if find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -name 'artifact-repair-*' -print -quit | grep -q .; then exit 91; fi

: > "$actions"
mkdir -m 0700 "$JOURNAL_ROOT/artifact-repair-unknown"
set +e
bootstrap_production_main 2> "$root/unknown.err"
unknown_status=$?
set -e
test "$unknown_status" -ne 0
test ! -s "$actions"
test -d "$JOURNAL_ROOT/artifact-repair-unknown"
grep -Fq 'Unknown artifact repair generation' "$root/unknown.err"
`), 90_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('firewall cleanup rejects bind-mounted fixed members without deleting mounted contents', (t) => {
  if (!privilegedLinuxAvailable(t)) return;
  const result = runPrivilegedBash(libraryHarness(`
candidate_mounted=0
prior_mounted=0
cleanup_firewall_mounts() {
  if [ "$prior_mounted" -eq 1 ]; then umount -- "$root/backup/loopback-firewall-install/prior" || true; fi
  if [ "$candidate_mounted" -eq 1 ]; then umount -- "$root/write-transaction/candidate" || true; fi
  rm -rf -- "$root"
}
trap cleanup_firewall_mounts EXIT

mkdir -m 0700 "$root/write-transaction" "$root/write-transaction/candidate" "$root/outside-candidate"
printf 'candidate-sentinel\n' > "$root/outside-candidate/sentinel"
if ! mount --bind "$root/outside-candidate" "$root/write-transaction/candidate"; then exit 77; fi
candidate_mounted=1
set +e
write_loopback_firewall_candidates "$root/write-transaction/candidate"
candidate_status=$?
set -e
test "$candidate_status" -ne 0
test -f "$root/outside-candidate/sentinel"
umount -- "$root/write-transaction/candidate"
candidate_mounted=0

BACKUP_DIR="$root/backup"
transaction="$BACKUP_DIR/loopback-firewall-install"
mkdir -m 0700 "$BACKUP_DIR" "$transaction" "$transaction/prior" "$root/outside-prior"
printf 'prior-sentinel\n' > "$root/outside-prior/sentinel"
if ! mount --bind "$root/outside-prior" "$transaction/prior"; then exit 77; fi
prior_mounted=1
NFT_BIN="$root/nft"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$NFT_BIN"
chmod 0700 "$NFT_BIN"
systemctl() { :; }
ss() { :; }
set +e
install_loopback_firewall
transaction_status=$?
set -e
test "$transaction_status" -ne 0
test -f "$root/outside-prior/sentinel"
`), 60_000);

  assertPrivilegedFixture(t, result);
});

test('critical lock metadata commands bypass ordinary and slash-named function shadows', {
  skip: !hasGitBash
}, () => {
  const result = runBash(libraryHarness(`
shadow_log="$root/shadow-log"
probe="$root/retained.lock"
: > "$probe"
chmod 0600 "$probe"
exec 8<"$probe"
stat() { printf '%s\n' stat >> "$shadow_log"; builtin command /usr/bin/stat "$@"; }
readlink() { printf '%s\n' readlink >> "$shadow_log"; builtin command /usr/bin/readlink "$@"; }
function /usr/bin/stat { printf '%s\n' slash-stat >> "$shadow_log"; builtin command /usr/bin/stat "$@"; }
function /usr/bin/readlink { printf '%s\n' slash-readlink >> "$shadow_log"; builtin command /usr/bin/readlink "$@"; }
assert_retained_lock_fd 8 "$probe" retained-probe
if [ -e "$shadow_log" ]; then
  printf '%s\n' 'retained-lock identity used a shadowed metadata command' >&2
  exit 93
fi
exec 8>&-

mkdir -m 0700 "$root/real-run"
mkdir -m 0700 "$root/real-run/locks"
ln -s "$root/real-run" "$root/run-alias"
: > "$OPERATION_FENCE"
SANITIZER_LIFECYCLE_FENCE="$root/run-alias/locks/sanitizer.lock"
: > "$SANITIZER_LIFECYCLE_FENCE"
chmod 0600 "$OPERATION_FENCE" "$SANITIZER_LIFECYCLE_FENCE"
stat() {
  printf '%s\n' stat >> "$shadow_log"
  case "$*" in
    *%U:%G:%a:%h*) printf '%s\n' root:root:600:1 ;;
    *%U:%G*) printf '%s\n' root:root ;;
    *%d:%i*) printf '%s\n' 1:1 ;;
    *) builtin command /usr/bin/stat "$@" ;;
  esac
}
realpath() { printf '%s\n' realpath >> "$shadow_log"; printf '%s\n' "\${!#}"; }
readlink() {
  printf '%s\n' readlink >> "$shadow_log"
  case "\${!#}" in
    */fd/8) printf '%s\n' "$OPERATION_FENCE" ;;
    */fd/9) printf '%s\n' "$SANITIZER_LIFECYCLE_FENCE" ;;
    *) return 1 ;;
  esac
}
flock() { printf '%s\n' flock >> "$shadow_log"; }
function /usr/bin/realpath { printf '%s\n' slash-realpath >> "$shadow_log"; printf '%s\n' "\${!#}"; }
function /usr/bin/flock { printf '%s\n' slash-flock >> "$shadow_log"; }

set +e
bootstrap_acquire_preprovisioned_control_locks
lock_status=$?
set -e
test "$lock_status" -ne 0
if [ -e "$shadow_log" ]; then
  printf '%s\n' 'control-lock validation used a shadowed critical command' >&2
  exit 94
fi
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('production runtime validation bypasses critical function and PATH shadows', {
  skip: !hasGitBash
}, () => {
  const result = runBash(libraryHarness(`
shadow_log="$root/critical-shadow-log"
shadow_bin="$root/shadow-bin"
mkdir -p -m 0700 "$shadow_bin" "$ENV_DIR" "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR"
printf '%s\n' env > "$ENV_FILE"
printf '%s\n' database > "$DB_DIR/turingmarket.db"
chmod 0600 "$ENV_FILE" "$DB_DIR/turingmarket.db"

expected_bootstrap_owner() { bootstrap_trusted_stat -c '%U:%G' -- "$ENV_FILE"; }
exercise_reachable_validation_paths() {
  validate_external_runtime
  exec 8<"$ENV_FILE"
  assert_retained_lock_fd 8 "$ENV_FILE" runtime-file
  exec 8>&-
}

export TM_SHADOW_LOG="$shadow_log"
for name in stat realpath readlink; do
  cat > "$shadow_bin/$name" <<'SHADOW'
#!/bin/bash -p
name="\${0##*/}"
printf 'path:%s\n' "$name" >> "$TM_SHADOW_LOG"
builtin exec "/usr/bin/$name" "$@"
SHADOW
  chmod 0700 "$shadow_bin/$name"
done
PATH="$shadow_bin:$PATH" exercise_reachable_validation_paths

stat() { builtin printf '%s\n' function:stat >> "$shadow_log"; builtin command /usr/bin/stat "$@"; }
realpath() { builtin printf '%s\n' function:realpath >> "$shadow_log"; builtin command /usr/bin/realpath "$@"; }
readlink() { builtin printf '%s\n' function:readlink >> "$shadow_log"; builtin command /usr/bin/readlink "$@"; }
exercise_reachable_validation_paths

if [ -e "$shadow_log" ]; then
  builtin printf '%s\n' 'production-reachable validation used shadowed critical commands' >&2
  builtin command /usr/bin/sed 's/^/shadow: /' "$shadow_log" >&2
  exit 101
fi
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('journal lock and unlock bypass flock function and PATH shadows', {
  skip: process.platform !== 'linux'
}, () => {
  const result = runBash(libraryHarness(`
shadow_log="$root/flock-shadow-log"
shadow_bin="$root/flock-shadow-bin"
mkdir -p -m 0700 "$shadow_bin" "$JOURNAL_ROOT"
: > "$JOURNAL_ROOT/.journal-protocol.lock"
chmod 0600 "$JOURNAL_ROOT/.journal-protocol.lock"
fixture_lock_identity="$(bootstrap_trusted_stat -c '%d:%i' -- "$JOURNAL_ROOT/.journal-protocol.lock")"
bootstrap_require_no_generation_phase_stages() { :; }
bind_migration_journal_root() { JOURNAL_ROOT_TOKEN='r2:${'6'.repeat(64)}'; }
bootstrap_journal_dirfd_helper() {
  case "$1" in
    ensure-lock|verify-reservation) printf '%s:fixture\n' "$fixture_lock_identity" ;;
    reserve-capacity) printf '%s\n' general ;;
    *) return 91 ;;
  esac
}
exercise_journal_lock() {
  reserve_migration_journal_capacity
  release_migration_journal_capacity_reservation
}

cat > "$shadow_bin/flock" <<'SHADOW'
#!/bin/bash -p
printf '%s\n' path:flock >> "$TM_SHADOW_LOG"
builtin exec /usr/bin/flock "$@"
SHADOW
chmod 0700 "$shadow_bin/flock"
export TM_SHADOW_LOG="$shadow_log"
PATH="$shadow_bin:$PATH" exercise_journal_lock

flock() { builtin printf '%s\n' function:flock >> "$shadow_log"; builtin command /usr/bin/flock "$@"; }
function /usr/bin/flock { builtin printf '%s\n' slash-flock >> "$shadow_log"; builtin command /usr/bin/flock "$@"; }
exercise_journal_lock

if [ -e "$shadow_log" ]; then
  builtin printf '%s\n' 'journal locking used a shadowed flock command' >&2
  exit 103
fi
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('direct startup pins Bash before consulting PATH', { skip: !hasGitBash }, () => {
  const result = runBash(`
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
cp ${shellQuote(bootstrapShellPath)} "$root/bootstrap"
chmod 0700 "$root/bootstrap"
mkdir -p "$root/shadow-bin"
cat > "$root/shadow-bin/bash" <<'SHADOW'
#!/bin/sh
printf '%s\n' shadowed-interpreter > "$TM_INTERPRETER_SHADOW_MARKER"
exit 0
SHADOW
chmod 0700 "$root/shadow-bin/bash"
set +e
PATH="$root/shadow-bin:$PATH" \
  TM_BOOTSTRAP_LIBRARY_ONLY=1 \
  TM_INTERPRETER_SHADOW_MARKER="$root/shadow-called" \
  "$root/bootstrap" > "$root/stdout" 2> "$root/stderr"
status=$?
set -e
if [ -e "$root/shadow-called" ]; then
  printf '%s\n' 'PATH-shadowed Bash executed bootstrap' >&2
  exit 95
fi
if [ "$status" -ne 64 ]; then
  printf 'direct library-only bootstrap exited %s instead of 64\n' "$status" >&2
  exit 96
fi
test ! -s "$root/stdout"
grep -Fq 'TM_BOOTSTRAP_LIBRARY_ONLY=1 is valid only when sourced' "$root/stderr"
`);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('direct library-only execution fails closed under the trusted interpreter', {
  skip: !hasGitBash
}, () => {
  const result = runBash(`
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
cp ${shellQuote(bootstrapShellPath)} "$root/bootstrap"
chmod 0700 "$root/bootstrap"
set +e
TM_BOOTSTRAP_LIBRARY_ONLY=1 /bin/bash -p "$root/bootstrap" > "$root/stdout" 2> "$root/stderr"
status=$?
set -e
if [ "$status" -ne 64 ]; then
  printf 'direct library-only bootstrap exited %s instead of 64\n' "$status" >&2
  exit 97
fi
test ! -s "$root/stdout"
grep -Fq 'TM_BOOTSTRAP_LIBRARY_ONLY=1 is valid only when sourced' "$root/stderr"
`);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('library-only mode returns successfully only when sourced and preserves caller control', {
  skip: !hasGitBash
}, () => {
  const result = runBash(`
set -euo pipefail
export TM_BOOTSTRAP_LIBRARY_ONLY=1
source ${shellQuote(bootstrapShellPath)}
printf '%s\n' caller-retained-control
`);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, 'caller-retained-control\n');
  assert.equal(result.stderr, '');
});

test('explicit Bash invocation re-enters privileged mode before imported functions run', {
  skip: !hasGitBash
}, () => {
  const result = runBash(`
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
cp ${shellQuote(bootstrapShellPath)} "$root/bootstrap"
chmod 0700 "$root/bootstrap"
printf() {
  builtin printf '%s\n' imported-printf > "$TM_IMPORTED_FUNCTION_MARKER"
  exit 0
}
export -f printf
set +e
TM_BOOTSTRAP_LIBRARY_ONLY=1 \
  TM_IMPORTED_FUNCTION_MARKER="$root/imported-function-called" \
  /bin/bash "$root/bootstrap" > "$root/stdout" 2> "$root/stderr"
status=$?
set -e
if [ -e "$root/imported-function-called" ]; then
  builtin printf '%s\n' 'imported function intercepted direct bootstrap startup' >&2
  exit 98
fi
if [ "$status" -ne 64 ]; then
  builtin printf 'explicit Bash bootstrap exited %s instead of 64\n' "$status" >&2
  exit 99
fi
test ! -s "$root/stdout"
grep -Fq 'TM_BOOTSTRAP_LIBRARY_ONLY=1 is valid only when sourced' "$root/stderr"
`);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('generated privileged firewall helper pins Bash before consulting PATH', {
  skip: !hasGitBash
}, () => {
  const result = runBash(libraryHarness(`
candidate="$root/firewall-candidate"
bootstrap_remove_anchored_fixed_tree() { rm -rf -- "$1/$2"; }
NFT_BIN=/usr/bin/true
FIREWALL_RULE_FILE="$candidate/rules.nft"
FIREWALL_HELPER="$candidate/installed-helper"
FIREWALL_SERVICE_FILE="$candidate/installed-service"
PM2_FIREWALL_DROPIN_FILE="$candidate/installed-dropin"
write_loopback_firewall_candidates "$candidate"
mkdir -p "$root/shadow-bin"
cat > "$root/shadow-bin/bash" <<'SHADOW'
#!/bin/sh
printf '%s\n' shadowed-helper-interpreter > "$TM_INTERPRETER_SHADOW_MARKER"
exit 0
SHADOW
chmod 0700 "$root/shadow-bin/bash"
set +e
PATH="$root/shadow-bin:$PATH" \
  TM_INTERPRETER_SHADOW_MARKER="$root/helper-shadow-called" \
  "$candidate/helper" apply
status=$?
set -e
if [ -e "$root/helper-shadow-called" ]; then
  printf '%s\n' 'PATH-shadowed Bash executed privileged firewall helper' >&2
  exit 100
fi
test "$status" -eq 0
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('firewall helper syntax validation cannot invoke a shadowed Bash function', {
  skip: !hasGitBash
}, () => {
  const result = runBash(libraryHarness(`
candidate="$root/firewall-syntax-candidate"
shadow_log="$root/bash-shadow-log"
bootstrap_remove_anchored_fixed_tree() { rm -rf -- "$1/$2"; }
NFT_BIN=/usr/bin/true
FIREWALL_RULE_FILE="$candidate/installed-rules"
FIREWALL_HELPER="$candidate/installed-helper"
FIREWALL_SERVICE_FILE="$candidate/installed-service"
PM2_FIREWALL_DROPIN_FILE="$candidate/installed-dropin"
bash() { builtin printf '%s\n' bash >> "$shadow_log"; return 0; }
function /bin/bash { builtin printf '%s\n' slash-bash >> "$shadow_log"; return 0; }
write_loopback_firewall_candidates "$candidate"
if [ -e "$shadow_log" ]; then
  builtin printf '%s\n' 'firewall syntax validation used a shadowed interpreter' >&2
  exit 102
fi
`));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('marker mount guard first publication returns the identity it re-read', { skip: !hasGitBash }, () => {
  const markerPython = [...bootstrap.matchAll(/<<'PY'\r?\n([\s\S]*?)\r?\nPY/g)]
    .map((match) => match[1])
    .find((source) => source.includes('def publish_exact_file('));
  assert.ok(markerPython, 'external marker Python helper must be present');

  const driver = `
import ast
import errno
import sys
import types

tree = ast.parse(sys.stdin.read())
function = next(
    node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name == 'publish_exact_file'
)
namespace = {}
exec(compile(ast.Module(body=[function], type_ignores=[]), '<publish-exact-file>', 'exec'), namespace)

opened = types.SimpleNamespace(st_dev=17, st_ino=23)
writes = []
fake_os = types.SimpleNamespace(
    O_RDWR=1,
    O_TMPFILE=2,
    O_CLOEXEC=4,
    open=lambda *args, **kwargs: 41,
    fstat=lambda descriptor: opened,
    write=lambda descriptor, payload: writes.append(bytes(payload)) or len(payload),
    fchmod=lambda *args: None,
    fchown=lambda *args: None,
    fsync=lambda *args: None,
    fsencode=lambda value: value.encode('ascii'),
    close=lambda *args: None,
)
namespace.update({
    'os': fake_os,
    'errno': errno,
    'ctypes': types.SimpleNamespace(get_errno=lambda: 0),
    'linkat': lambda *args: 0,
    'AT_EMPTY_PATH': 0x1000,
    'library_only': '1',
    'expected_uid': 1000,
    'expected_gid': 1000,
    'mount_id': lambda descriptor: 31,
    'identity': lambda status: (status.st_dev, status.st_ino),
    'validate_named_file': lambda *args: ((17, 23), 'm2:proof'),
    'reject': lambda message: (_ for _ in ()).throw(RuntimeError(message)),
})
payload = b'first-publication-payload'
result = namespace['publish_exact_file'](
    7,
    types.SimpleNamespace(st_dev=17),
    31,
    '.mount-guard',
    payload,
    'r1:' + 'a' * 64,
)
assert result == (17, 23), result
assert b''.join(writes) == payload
`;
  const result = spawnSync(process.platform === 'win32' ? gitBash : 'bash', [
    '--noprofile', '--norc', '-c', `python3 -c ${shellQuote(driver)}`
  ], {
    input: markerPython,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('external marker mount guard survives its real first publication', {
  skip: nativeLinuxOnly
}, () => {
  const result = runBash(libraryHarness(`
chmod 0700 "$REMOTE_ROOT"
test "$(external_layout_marker_state)" = absent
test "$(find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -type f -name '.external-runtime-root-mount-guard-v1.*' | wc -l)" -eq 1
EXTERNAL_LAYOUT_ROOT_TOKEN=
test "$(external_layout_marker_state)" = absent
test "$(find "$REMOTE_ROOT" -mindepth 1 -maxdepth 1 -type f -name '.external-runtime-root-mount-guard-v1.*' | wc -l)" -eq 1
`), 60_000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('every embedded Python block in the bootstrap compiles', { skip: !hasGitBash }, () => {
  const blocks = [];
  const heredoc = /<<'(PY|PYTHON)'\r?\n([\s\S]*?)\r?\n\1/g;
  for (const match of bootstrap.matchAll(heredoc)) {
    blocks.push({ tag: match[1], source: match[2] });
  }
  assert.equal(blocks.length, 10, 'all bootstrap Python heredocs must remain compile-gated');
  for (const [index, block] of blocks.entries()) {
    const command = `python3 -c ${shellQuote(`import sys; compile(sys.stdin.read(), "<bootstrap-${block.tag}-${index + 1}>", "exec")`)}`;
    const result = spawnSync(process.platform === 'win32' ? gitBash : 'bash', [
      '--noprofile', '--norc', '-c', command
    ], {
      input: block.source,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, `embedded Python ${index + 1}: ${result.stderr || result.stdout}`);
  }
});

test('bootstrap script remains valid Bash', () => {
  const result = spawnSync(process.platform === 'win32' ? gitBash : 'bash', ['-n', bootstrapShellPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
