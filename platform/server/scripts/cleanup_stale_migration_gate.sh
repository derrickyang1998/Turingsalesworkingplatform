#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077

JOURNAL_ROOT="${TM_GATE_JOURNAL_ROOT:-/var/lib/turingmarket/migration-gate}"
DEFAULT_ALLOWED_ROOTS=$'/run/turingmarket-gate\n/var/lib/turingmarket/migration-gate\n/var/lib/turingmarket/gate\n/mnt/turingmarket-gate'
ALLOWED_ROOTS="${TM_GATE_ALLOWED_ROOTS:-$DEFAULT_ALLOWED_ROOTS}"
TEST_MODE="${TM_GATE_TEST_MODE:-0}"
PROC_ROOT="/proc"
TERM_WAIT_STEPS=20
KILL_WAIT_STEPS=20
WAIT_INTERVAL_SECONDS=0.05
JOURNAL_TMP_RECOVERY_LIMIT="${TM_GATE_JOURNAL_TMP_RECOVERY_LIMIT:-64}"
JOURNAL_TMP_STALE_SECONDS="${TM_GATE_JOURNAL_TMP_STALE_SECONDS:-300}"

[[ "$JOURNAL_TMP_RECOVERY_LIMIT" =~ ^[1-9][0-9]*$ && "$JOURNAL_TMP_RECOVERY_LIMIT" -le 256 ]] \
  || { printf 'migration gate cleanup failed: invalid journal tmp recovery limit\n' >&2; exit 1; }
[[ "$JOURNAL_TMP_STALE_SECONDS" =~ ^[1-9][0-9]*$ && "$JOURNAL_TMP_STALE_SECONDS" -le 86400 ]] \
  || { printf 'migration gate cleanup failed: invalid journal tmp stale threshold\n' >&2; exit 1; }

fail() {
  printf 'migration gate cleanup failed: %s\n' "$1" >&2
  exit 1
}

expected_owner() {
  if [[ "$TEST_MODE" == "1" ]]; then id -u; else printf '0\n'; fi
}

fsync_directory() {
  local directory="$1"
  node - "$directory" <<'NODE'
const fs = require('node:fs');
if (process.platform !== 'win32') {
  const fd = fs.openSync(process.argv[2], 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
NODE
}

validate_journal_file() {
  local journal="$1"
  node - "$JOURNAL_ROOT" "$journal" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const target = path.resolve(process.argv[3]);
if (path.dirname(target) !== root) throw new Error('journal escapes journal root');
let cursor = path.parse(root).root;
for (const segment of root.slice(cursor.length).split(path.sep).filter(Boolean)) {
  cursor = path.join(cursor, segment);
  const stat = fs.lstatSync(cursor);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('journal root component is unsafe');
}
const rootStat = fs.lstatSync(root);
const targetStat = fs.lstatSync(target);
if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) throw new Error('journal is not a regular single-link file');
if (targetStat.dev !== rootStat.dev) throw new Error('journal crosses devices');
NODE
  local links mode owner root_mode root_owner wanted
  links="$(stat -c '%h' -- "$journal")"
  mode="$(stat -c '%a' -- "$journal")"
  owner="$(stat -c '%u' -- "$journal")"
  root_mode="$(stat -c '%a' -- "$JOURNAL_ROOT")"
  root_owner="$(stat -c '%u' -- "$JOURNAL_ROOT")"
  wanted="$(expected_owner)"
  [[ "$links" == "1" && "$mode" == "600" && "$owner" == "$wanted" ]] || fail "journal owner/mode/link mismatch"
  [[ "$root_mode" == "700" && "$root_owner" == "$wanted" ]] || fail "journal root owner/mode mismatch"
  if command -v mountpoint >/dev/null 2>&1; then
    if mountpoint -q -- "$journal"; then fail "journal file is a mountpoint"; fi
  fi
}

parse_journal() {
  local journal="$1"
  node - "$journal" "$ALLOWED_ROOTS" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [journalPath, rootsText] = process.argv.slice(2);
const roots = rootsText.split('\n').filter(Boolean).map((entry) => path.resolve(entry));
const lstatNoFollowIfPresent = (target, options) => {
  try { return fs.lstatSync(target, options); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};
const containsPath = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const pathsOverlap = (left, right) => containsPath(left, right) || containsPath(right, left);
let data;
try { data = JSON.parse(fs.readFileSync(journalPath, 'utf8')); }
catch (_error) { throw new Error('malformed journal JSON'); }
if (!data || ![
  'tm-sanitizer-run-journal-v1', 'tm-sanitizer-run-journal-v2',
  'tm-sanitizer-run-journal-v3', 'tm-sanitizer-run-journal-v4'
].includes(data.format)) {
  throw new Error('unknown journal format');
}
if (!/^[0-9a-f]{32}$/.test(data.runId || '')) throw new Error('invalid journal runId');
const allowedState = new Set([
  'journaled', 'prescrub-copy-intent', 'prescrub-staged', 'unprivileged-stage-ready',
  'worker-launch-intent', 'worker-group-recorded', 'worker-timeout-termination-requested',
  'worker-abort-termination-requested', 'worker-output-termination-requested',
  'worker-identity-termination-requested', 'worker-group-observation-termination-requested',
  'logical-sanitization-complete', 'compact-scan-complete', 'complete'
]);
if (!allowedState.has(data.state)) throw new Error('unknown journal state');
if (!data.paths || typeof data.paths !== 'object' || Array.isArray(data.paths)
    || !data.paths.source || !data.paths.output) throw new Error('missing journal paths');
for (const [name, record] of Object.entries(data.paths)) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.path !== 'string' || /[\0\r\n\t]/.test(record.path)) {
    throw new Error(`invalid journal path record ${name}`);
  }
  if (typeof record.cleanup !== 'boolean') throw new Error(`journal path ${name} cleanup must be an exact Boolean`);
}
if (data.paths.source.cleanup !== false || data.paths.output.cleanup !== false) {
  throw new Error('source and output journal paths must be explicitly non-cleanup');
}
const sourcePath = path.resolve(data.paths.source.path);
const outputPath = path.resolve(data.paths.output.path);
if (pathsOverlap(sourcePath, outputPath)) throw new Error('source and output journal paths overlap');
const cleanups = [];
for (const [name, record] of Object.entries(data.paths)) {
  const resolved = path.resolve(record.path);
  if (name === 'source' || name === 'output') continue;
  if (record.cleanup !== true) throw new Error('unrecognized non-cleanup path');
  const root = roots.find((candidate) => resolved === candidate || resolved.startsWith(candidate + path.sep));
  if (!root || resolved === root) throw new Error('cleanup path outside bounded roots');
  const pathIdentity = record.identity ?? null;
  if (pathIdentity !== null && (
    !/^\d+$/.test(pathIdentity.device || '') || !/^\d+$/.test(pathIdentity.inode || '')
  )) throw new Error('invalid cleanup path identity');
  if (name === 'publishedOutput') {
    if (resolved !== outputPath || pathIdentity === null) {
      throw new Error('publishedOutput must exactly match the identity-bound non-cleanup output path');
    }
  } else if (pathsOverlap(resolved, sourcePath) || pathsOverlap(resolved, outputPath)) {
    throw new Error(`cleanup path ${name} overlaps a non-cleanup source or output path`);
  }
  const existing = lstatNoFollowIfPresent(resolved, { bigint: true });
  if (existing !== null && existing.isSymbolicLink()) throw new Error(`cleanup path ${name} is a symlink`);
  if (existing !== null && pathIdentity === null) throw new Error('existing cleanup path lacks an exact identity');
  if (existing !== null && (
    existing.dev.toString() !== pathIdentity.device || existing.ino.toString() !== pathIdentity.inode
  )) throw new Error(`cleanup path ${name} identity does not match its journal binding`);
  cleanups.push([name, resolved, pathIdentity?.device || '', pathIdentity?.inode || '']);
}
cleanups.sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
const scalar = (value, label) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[\0\r\n\t]/.test(text)) throw new Error(`invalid ${label}`);
  return text;
};
const identity = (value, label, allowNull) => {
  if (value === null && allowNull) return null;
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error(`invalid ${label} pid`);
  if (!(value.uid === null || (Number.isSafeInteger(value.uid) && value.uid >= 0))) throw new Error(`invalid ${label} uid`);
  if (!(value.startTimeTicks === null || /^\d+$/.test(value.startTimeTicks || ''))) throw new Error(`invalid ${label} start time`);
  if (!(value.exe === null || (typeof value.exe === 'string' && path.isAbsolute(value.exe) && !/[\0\r\n\t]/.test(value.exe)))) {
    throw new Error(`invalid ${label} executable`);
  }
  return value;
};
let coordinator;
let worker;
let processGroup = null;
if (data.format === 'tm-sanitizer-run-journal-v1') {
  coordinator = identity({ pid: data.pid, uid: data.uid, startTimeTicks: null, exe: null }, 'legacy coordinator', false);
  worker = null;
} else {
  const allowedTop = new Set([
    'format', 'runId', 'createdAt', 'updatedAt', 'state', 'coordinator', 'worker',
    'processGroup', 'unit', 'mount', 'ephemeralUser', 'paths'
  ]);
  if (Object.keys(data).some((key) => !allowedTop.has(key))) throw new Error('unknown journal field');
  coordinator = identity(data.coordinator, 'coordinator', false);
  worker = identity(data.worker, 'worker', true);
  if (data.format === 'tm-sanitizer-run-journal-v3' || data.format === 'tm-sanitizer-run-journal-v4') {
    if (!Number.isSafeInteger(coordinator.uid) || coordinator.uid < 0
        || !/^\d+$/.test(coordinator.startTimeTicks || '')
        || typeof coordinator.exe !== 'string' || !path.isAbsolute(coordinator.exe)
        || !Number.isSafeInteger(coordinator.pgid) || coordinator.pgid < 1) {
      throw new Error('invalid exact coordinator identity including PGID');
    }
    processGroup = identity(data.processGroup, 'process group', true);
    if (processGroup !== null && (
      !Number.isSafeInteger(processGroup.uid) || processGroup.uid < 0
      || !/^\d+$/.test(processGroup.startTimeTicks || '')
      || typeof processGroup.exe !== 'string' || !path.isAbsolute(processGroup.exe)
      || !Number.isSafeInteger(processGroup.pgid) || processGroup.pgid !== processGroup.pid
    )) {
      throw new Error('invalid exact process group identity');
    }
    const requiresGroup = new Set([
      'worker-launch-intent', 'worker-group-recorded', 'worker-timeout-termination-requested',
      'worker-abort-termination-requested', 'worker-output-termination-requested',
      'worker-identity-termination-requested', 'worker-group-observation-termination-requested',
      'logical-sanitization-complete', 'compact-scan-complete', 'complete'
    ]);
    if (requiresGroup.has(data.state) && data.state !== 'worker-launch-intent' && processGroup === null) {
      throw new Error('missing recorded process group identity');
    }
  }
}
const unitName = scalar(data.unit?.name, 'unit name');
if (unitName && !/^turingmarket-gate-[0-9a-f]{32}\.service$/.test(unitName)) throw new Error('invalid recorded systemd unit');
const userName = scalar(data.ephemeralUser?.name, 'ephemeral user');
const userUid = data.ephemeralUser?.uid ?? data.uid ?? null;
const userGid = data.ephemeralUser?.gid ?? null;
if (userName && !/^tm-gate-[0-9a-f]{12}$/.test(userName)) throw new Error('invalid ephemeral user name');
for (const value of [userUid, userGid]) {
  if (!(value === null || (Number.isSafeInteger(value) && value > 0))) throw new Error('invalid ephemeral user identity');
}
console.log(['meta', data.runId, data.state, data.format].join('\t'));
if (processGroup) {
  console.log([
    'group', processGroup.pid, processGroup.uid ?? '', processGroup.startTimeTicks ?? '',
    scalar(processGroup.exe, 'process group executable'), processGroup.pgid
  ].join('\t'));
}
for (const [role, record] of [['worker', worker], ['coordinator', coordinator]]) {
  if (!record) continue;
  const pgid = role === 'coordinator' && (
    data.format === 'tm-sanitizer-run-journal-v3' || data.format === 'tm-sanitizer-run-journal-v4'
  ) ? record.pgid : '';
  console.log([
    'process', role, record.pid, record.uid ?? '', record.startTimeTicks ?? '',
    scalar(record.exe, 'process executable'), pgid
  ].join('\t'));
}
console.log(['unit', unitName, data.unit?.active ? '1' : '0'].join('\t'));
console.log(['mount', scalar(data.mount?.path, 'mount path'), scalar(data.mount?.source, 'mount source'), data.mount?.mounted ? '1' : '0'].join('\t'));
console.log(['user', userName, userUid ?? '', userGid ?? ''].join('\t'));
for (const [name, target, device, inode] of cleanups) {
  console.log(['path', name, target, device, inode].join('\t'));
}
NODE
}

process_matches() {
  local role="$1" pid="$2" uid="$3" start_ticks="$4" executable="$5" run_id="$6" expected_pgid="$7"
  [[ -d "$PROC_ROOT/$pid" ]] || return 1
  local actual_uid actual_start actual_pgid actual_exe observed
  actual_uid="$(awk '/^Uid:/ {print $2; exit}' "$PROC_ROOT/$pid/status" 2>/dev/null || true)"
  [[ -n "$uid" && "$actual_uid" == "$uid" ]] || return 1
  if [[ -n "$start_ticks" || -n "$expected_pgid" ]]; then
    observed="$(node - "$PROC_ROOT" "$pid" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const text = fs.readFileSync(path.join(process.argv[2], process.argv[3], 'stat'), 'utf8');
const end = text.lastIndexOf(') ');
if (end < 0) process.exit(1);
const fields = text.slice(end + 2).trim().split(/\s+/);
process.stdout.write(`${fields[19]}\t${fields[2]}`);
NODE
)" || return 1
    IFS=$'\t' read -r actual_start actual_pgid <<< "$observed"
  fi
  if [[ -n "$start_ticks" ]]; then
    [[ "$actual_start" == "$start_ticks" ]] || return 1
  fi
  if [[ -n "$expected_pgid" ]]; then
    [[ "$actual_pgid" == "$expected_pgid" ]] || return 1
  fi
  if [[ -n "$executable" ]]; then
    actual_exe="$(readlink -f -- "$PROC_ROOT/$pid/exe" 2>/dev/null || true)"
    [[ "$actual_exe" == "$(readlink -f -- "$executable" 2>/dev/null || printf '%s' "$executable")" ]] || return 1
  fi
  node - "$PROC_ROOT" "$pid" "$role" "$run_id" <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const [procRoot, pid, role, runId] = process.argv.slice(2);
const argv = fs.readFileSync(path.join(procRoot, pid, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
const adjacent = (flag, value) => argv.some((entry, index) => entry === flag && argv[index + 1] === value);
const valued = (flag) => argv.some((entry, index) => entry === flag && typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--'));
let matches = false;
if (role === 'worker') {
  matches = argv.includes('--worker') && !argv.includes('--production') && adjacent('--run-id', runId);
} else if (role === 'coordinator') {
  const runFlags = argv.reduce((count, entry) => count + (entry === '--run-id' ? 1 : 0), 0);
  matches = argv.includes('--production') && !argv.includes('--worker') && valued('--source') && valued('--output')
    && (runFlags === 0 || (runFlags === 1 && adjacent('--run-id', runId)));
}
if (!matches) process.exit(1);
NODE
  return 0
}

process_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 1
  node - "$PROC_ROOT" "$pid" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
try {
  const text = fs.readFileSync(path.join(process.argv[2], process.argv[3], 'stat'), 'utf8');
  const end = text.lastIndexOf(') ');
  if (end < 0) process.exit(2);
  process.exit(text.slice(end + 2).trim().split(/\s+/)[0] === 'Z' ? 1 : 0);
} catch (error) {
  process.exit(['ENOENT', 'ESRCH'].includes(error.code) ? 1 : 2);
}
NODE
  local status=$?
  [[ "$status" == "0" || "$status" == "2" ]]
}

terminate_recorded_process() {
  local role="$1" pid="$2" uid="$3" start_ticks="$4" executable="$5" run_id="$6" expected_pgid="$7"
  if ! process_alive "$pid"; then return 0; fi
  process_matches "$role" "$pid" "$uid" "$start_ticks" "$executable" "$run_id" "$expected_pgid" \
    || fail "$role process identity is uncertain"
  kill -TERM "$pid" 2>/dev/null || {
    process_alive "$pid" && fail "$role TERM signal failed"
    return 0
  }
  local step
  for ((step = 0; step < TERM_WAIT_STEPS; step += 1)); do
    if ! process_alive "$pid"; then return 0; fi
    process_matches "$role" "$pid" "$uid" "$start_ticks" "$executable" "$run_id" "$expected_pgid" \
      || fail "$role process identity changed during TERM observation"
    sleep "$WAIT_INTERVAL_SECONDS"
  done
  if ! process_alive "$pid"; then return 0; fi
  process_matches "$role" "$pid" "$uid" "$start_ticks" "$executable" "$run_id" "$expected_pgid" \
    || fail "$role process identity changed before KILL"
  kill -KILL "$pid" 2>/dev/null || {
    process_alive "$pid" && fail "$role KILL signal failed"
    return 0
  }
  for ((step = 0; step < KILL_WAIT_STEPS; step += 1)); do
    if ! process_alive "$pid"; then return 0; fi
    process_matches "$role" "$pid" "$uid" "$start_ticks" "$executable" "$run_id" "$expected_pgid" \
      || fail "$role process identity changed during KILL observation"
    sleep "$WAIT_INTERVAL_SECONDS"
  done
  fail "$role process remained alive after the KILL observation deadline"
}

process_group_alive() {
  local pgid="$1"
  kill -0 -- "-$pgid" 2>/dev/null || return 1
  node - "$pgid" <<'NODE'
const fs = require('node:fs');
const pgid = process.argv[2];
let uncertain = false;
for (const entry of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  try {
    const text = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
    const end = text.lastIndexOf(') ');
    if (end < 0) { uncertain = true; continue; }
    const fields = text.slice(end + 2).trim().split(/\s+/);
    if (fields[2] === pgid && fields[0] !== 'Z') process.exit(0);
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) uncertain = true;
  }
}
process.exit(uncertain ? 2 : 1);
NODE
  local status=$?
  [[ "$status" == "0" || "$status" == "2" ]]
}

process_group_matches() {
  local pid="$1" uid="$2" start_ticks="$3" executable="$4" pgid="$5"
  process_group_alive "$pgid" || return 1
  [[ "$pid" == "$pgid" && -d "/proc/$pid" ]] || return 2
  local actual_uid actual_start actual_pgid actual_exe observed
  actual_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$pid/status" 2>/dev/null || true)"
  [[ -n "$uid" && "$actual_uid" == "$uid" ]] || return 2
  observed="$(node - "$pid" <<'NODE'
const fs = require('node:fs');
const text = fs.readFileSync(`/proc/${process.argv[2]}/stat`, 'utf8');
const end = text.lastIndexOf(') ');
if (end < 0) process.exit(1);
const fields = text.slice(end + 2).trim().split(/\s+/);
process.stdout.write(`${fields[19]}\t${fields[2]}`);
NODE
)" || return 2
  IFS=$'\t' read -r actual_start actual_pgid <<< "$observed"
  [[ "$actual_start" == "$start_ticks" && "$actual_pgid" == "$pgid" ]] || return 2
  actual_exe="$(readlink -f -- "/proc/$pid/exe" 2>/dev/null || true)"
  [[ -n "$executable" && "$actual_exe" == "$executable" ]] || return 2
  return 0
}

terminate_recorded_process_group() {
  local pid="$1" uid="$2" start_ticks="$3" executable="$4" pgid="$5"
  local status
  if process_group_matches "$pid" "$uid" "$start_ticks" "$executable" "$pgid"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" == "1" ]]; then return 0; fi
  [[ "$status" == "0" ]] || fail "recorded process group identity is uncertain"

  kill -TERM -- "-$pgid" 2>/dev/null || {
    if process_group_matches "$pid" "$uid" "$start_ticks" "$executable" "$pgid"; then
      fail "process group TERM signal failed after exact identity revalidation"
    else
      status=$?
    fi
    [[ "$status" == "1" ]] && return 0
    fail "recorded process group identity became uncertain after TERM failure"
  }
  local step
  for ((step = 0; step < TERM_WAIT_STEPS; step += 1)); do
    if process_group_matches "$pid" "$uid" "$start_ticks" "$executable" "$pgid"; then
      status=0
    else
      status=$?
    fi
    [[ "$status" == "1" ]] && return 0
    [[ "$status" == "0" ]] || fail "recorded process group identity changed during TERM observation"
    sleep "$WAIT_INTERVAL_SECONDS"
  done
  if process_group_matches "$pid" "$uid" "$start_ticks" "$executable" "$pgid"; then
    status=0
  else
    status=$?
  fi
  [[ "$status" == "1" ]] && return 0
  [[ "$status" == "0" ]] || fail "recorded process group identity changed before KILL"
  kill -KILL -- "-$pgid" 2>/dev/null || {
    if process_group_matches "$pid" "$uid" "$start_ticks" "$executable" "$pgid"; then
      fail "process group KILL signal failed after exact identity revalidation"
    else
      status=$?
    fi
    [[ "$status" == "1" ]] && return 0
    fail "recorded process group identity became uncertain after KILL failure"
  }
  for ((step = 0; step < KILL_WAIT_STEPS; step += 1)); do
    if process_group_matches "$pid" "$uid" "$start_ticks" "$executable" "$pgid"; then
      status=0
    else
      status=$?
    fi
    [[ "$status" == "1" ]] && return 0
    [[ "$status" == "0" ]] || fail "recorded process group identity changed during KILL observation"
    sleep "$WAIT_INTERVAL_SECONDS"
  done
  fail "process group remained alive after the KILL observation deadline"
}

assert_cleanup_path() {
  local target="$1"
  node - "$target" "$ALLOWED_ROOTS" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(process.argv[2]);
const roots = process.argv[3].split('\n').filter(Boolean).map((entry) => path.resolve(entry));
const lstatNoFollowIfPresent = (candidate, options) => {
  try { return fs.lstatSync(candidate, options); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};
const root = roots.find((candidate) => target.startsWith(candidate + path.sep));
if (!root) throw new Error('cleanup target escaped allowed roots');
let cursor = root;
const rootStat = fs.lstatSync(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('cleanup root is unsafe');
for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
  cursor = path.join(cursor, segment);
  const stat = lstatNoFollowIfPresent(cursor);
  if (stat === null) break;
  if (stat.isSymbolicLink()) throw new Error('cleanup component is a symlink');
  if (stat.dev !== rootStat.dev) throw new Error('cleanup component crosses devices');
}
NODE
}

safe_remove_tree() {
  local target="$1" user_uid="$2" expected_device="$3" expected_inode="$4"
  local allowed_uids
  if [[ "$TEST_MODE" == "1" ]]; then allowed_uids='*'; else allowed_uids="0${user_uid:+,$user_uid}"; fi
  node - "$target" "$ALLOWED_ROOTS" "$allowed_uids" "$expected_device" "$expected_inode" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [targetText, rootsText, uidText, expectedDevice, expectedInode] = process.argv.slice(2);
const target = path.resolve(targetText);
const lstatNoFollowIfPresent = (candidate, options) => {
  try { return fs.lstatSync(candidate, options); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};
const targetStat = lstatNoFollowIfPresent(target, { bigint: true });
if (targetStat === null) process.exit(0);
const roots = rootsText.split('\n').filter(Boolean).map((entry) => path.resolve(entry));
const root = roots.find((candidate) => target.startsWith(candidate + path.sep));
if (!root) throw new Error('cleanup target escaped allowed roots');
const rootStat = fs.lstatSync(root, { bigint: true });
if ((expectedDevice || expectedInode) && (
  targetStat.dev.toString() !== expectedDevice || targetStat.ino.toString() !== expectedInode
)) throw new Error('cleanup target identity does not match its journal binding');
const allowAnyUid = uidText === '*';
const allowedUids = allowAnyUid ? new Set() : new Set(uidText.split(',').filter(Boolean).map(BigInt));
const mountpoints = new Set();
if (process.platform === 'linux') {
  for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')) {
    const fields = line.split(' ');
    if (fields[4]) mountpoints.add(path.resolve(fields[4].replace(/\\040/g, ' ')));
  }
}
let cursor = root;
for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
  cursor = path.join(cursor, segment);
  const stat = fs.lstatSync(cursor, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error('cleanup component is a symlink');
  if (stat.dev !== rootStat.dev) throw new Error('cleanup component crosses devices');
  if (mountpoints.has(path.resolve(cursor))) throw new Error('cleanup component is a mountpoint');
}
const snapshots = [];
function inspect(current) {
  const stat = fs.lstatSync(current, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error('cleanup tree contains a symlink');
  if (stat.dev !== rootStat.dev) throw new Error('cleanup tree crosses devices');
  if (!allowAnyUid && !allowedUids.has(stat.uid)) throw new Error('cleanup tree has an unexpected owner');
  if (mountpoints.has(path.resolve(current))) throw new Error('cleanup tree contains a mountpoint');
  let childDirectories = 0;
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(current).sort()) {
      const child = path.join(current, name);
      if (fs.lstatSync(child).isDirectory()) childDirectories += 1;
      inspect(child);
    }
  } else {
    if (!stat.isFile()) throw new Error('cleanup tree contains a special node');
    if (stat.nlink !== 1n) throw new Error('cleanup tree contains a hardlinked file');
  }
  snapshots.push({ current, dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, uid: stat.uid, directory: stat.isDirectory(), childDirectories });
}
inspect(target);
for (const expected of snapshots) {
  const stat = fs.lstatSync(expected.current, { bigint: true });
  for (const key of ['dev', 'ino', 'mode', 'uid']) {
    if (stat[key] !== expected[key]) throw new Error('cleanup tree changed during validation');
  }
  if (expected.directory) {
    if (fs.readdirSync(expected.current).length !== 0) {
      throw new Error('cleanup directory changed or remained nonempty during validation');
    }
    fs.rmdirSync(expected.current);
  } else {
    if (stat.nlink !== expected.nlink) throw new Error('cleanup tree link count changed during validation');
    fs.unlinkSync(expected.current);
  }
  if (process.platform !== 'win32') {
    const parent = path.dirname(expected.current);
    const fd = fs.openSync(parent, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
NODE
}

recover_publication_hardlink_pair() {
  local journal="$1" user_uid="$2" allowed_uids
  if [[ "$TEST_MODE" == "1" ]]; then allowed_uids='*'; else allowed_uids="0${user_uid:+,$user_uid}"; fi
  node - "$journal" "$ALLOWED_ROOTS" "$allowed_uids" "$TEST_MODE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [journalPath, rootsText, uidText, testMode] = process.argv.slice(2);
const lstatNoFollowIfPresent = (target, options) => {
  try { return fs.lstatSync(target, options); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};
const data = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const expectedRole = data.format === 'tm-sanitizer-run-journal-v1'
  ? 'publish'
  : (['tm-sanitizer-run-journal-v3', 'tm-sanitizer-run-journal-v4'].includes(data.format)
      ? 'publicationStage' : null);
if (!expectedRole) process.exit(0);
const stageRecord = data.paths?.[expectedRole];
if (!stageRecord || stageRecord.cleanup !== true || typeof stageRecord.path !== 'string') process.exit(0);
const stagePath = path.resolve(stageRecord.path);
const initialStage = lstatNoFollowIfPresent(stagePath, { bigint: true });
if (initialStage === null) process.exit(0);
if (!initialStage.isFile() || initialStage.isSymbolicLink()) {
  throw new Error('publication staging path is not a regular file');
}
if (initialStage.nlink === 1n) process.exit(0);
if (initialStage.nlink !== 2n) throw new Error('publication staging file has an unsafe link count');

const roots = rootsText.split('\n').filter(Boolean).map((entry) => path.resolve(entry))
  .sort((left, right) => right.length - left.length);
const mountpoints = new Set();
if (process.platform === 'linux') {
  for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')) {
    const fields = line.split(' ');
    if (fields[4]) mountpoints.add(path.resolve(fields[4].replace(/\\040/g, ' ')));
  }
}
const validateBoundedPath = (target, label) => {
  const root = roots.find((candidate) => target.startsWith(candidate + path.sep));
  if (!root) throw new Error(`${label} escaped allowed roots`);
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${label} root is unsafe`);
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = lstatNoFollowIfPresent(cursor, { bigint: true });
    if (stat === null) throw new Error(`${label} is absent`);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
    if (stat.dev !== rootStat.dev) throw new Error(`${label} crosses devices`);
    if (mountpoints.has(path.resolve(cursor))) throw new Error(`${label} contains a mountpoint`);
  }
};
const outputRecord = data.paths?.output;
if (!outputRecord || outputRecord.cleanup !== false || typeof outputRecord.path !== 'string') {
  throw new Error('publication recovery requires the non-cleanup journal output path');
}
const outputPath = path.resolve(outputRecord.path);
if (stagePath === outputPath) throw new Error('publication stage and output paths must differ');
validateBoundedPath(stagePath, 'publication staging path');
validateBoundedPath(outputPath, 'publication output path');

const stageIdentity = stageRecord.identity;
if (!stageIdentity || !/^\d+$/.test(stageIdentity.device || '') || !/^\d+$/.test(stageIdentity.inode || '')) {
  throw new Error('publication staging file lacks an exact journal identity');
}
const outputStat = fs.lstatSync(outputPath, { bigint: true });
const safeFile = (stat, label) => {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  const mode = Number(stat.mode & 0o777n);
  if (testMode === '1' && process.platform === 'win32') {
    if (mode !== 0o666) throw new Error(`${label} has an unexpected Windows test-mode projection`);
  } else if (mode !== 0o600) {
    throw new Error(`${label} mode is unsafe`);
  }
};
safeFile(initialStage, 'publication staging file');
safeFile(outputStat, 'publication output');
if (initialStage.dev.toString() !== stageIdentity.device || initialStage.ino.toString() !== stageIdentity.inode) {
  throw new Error('publication staging identity does not match its journal binding');
}
if (outputStat.nlink !== 2n || outputStat.dev !== initialStage.dev || outputStat.ino !== initialStage.ino) {
  throw new Error('publication output does not form the exact two-link staging pair');
}
if (testMode === '1') {
  if (outputStat.uid !== initialStage.uid) throw new Error('publication pair owner mismatch');
} else {
  const allowedUids = new Set(uidText.split(',').filter(Boolean).map(BigInt));
  if (!allowedUids.has(initialStage.uid) || !allowedUids.has(outputStat.uid)) {
    throw new Error('publication pair has an unexpected owner');
  }
}

const publishedRecord = data.paths?.publishedOutput;
if (publishedRecord !== undefined) {
  if (!publishedRecord || publishedRecord.cleanup !== true
      || path.resolve(publishedRecord.path || '') !== outputPath
      || !publishedRecord.identity
      || publishedRecord.identity.device !== outputStat.dev.toString()
      || publishedRecord.identity.inode !== outputStat.ino.toString()) {
    throw new Error('publishedOutput journal binding does not match the publication pair');
  }
}
for (const [role, record] of Object.entries(data.paths || {})) {
  if (!record?.cleanup || role === expectedRole || role === 'publishedOutput') continue;
  const candidate = path.resolve(record.path || '');
  if (candidate === stagePath || candidate === outputPath) {
    throw new Error('unexpected cleanup role aliases the publication pair');
  }
}

const sameSnapshot = (target, expected, links, label) => {
  validateBoundedPath(target, label);
  const current = fs.lstatSync(target, { bigint: true });
  safeFile(current, label);
  for (const key of ['dev', 'ino', 'mode', 'uid']) {
    if (current[key] !== expected[key]) throw new Error(`${label} identity changed during recovery`);
  }
  if (current.nlink !== links) throw new Error(`${label} link count changed during recovery`);
  return current;
};
const fsyncParent = (target) => {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
sameSnapshot(stagePath, initialStage, 2n, 'publication staging file');
sameSnapshot(outputPath, outputStat, 2n, 'publication output');
fs.unlinkSync(outputPath);
fsyncParent(outputPath);
sameSnapshot(stagePath, initialStage, 1n, 'publication staging file');
fs.unlinkSync(stagePath);
fsyncParent(stagePath);
NODE
}

cleanup_one() {
  local journal="$1"
  validate_journal_file "$journal"
  local parsed meta run_id journal_state journal_format unit_name unit_active mount_path mount_source mounted user_name user_uid user_gid
  local group_pid group_uid group_start group_executable group_pgid
  parsed="$(parse_journal "$journal")" || fail "journal validation rejected"
  meta="$(printf '%s\n' "$parsed" | awk -F '\t' '$1=="meta" {print; exit}')"
  IFS=$'\t' read -r _ run_id journal_state journal_format <<< "$meta"
  IFS=$'\t' read -r _ unit_name unit_active <<< "$(printf '%s\n' "$parsed" | awk -F '\t' '$1=="unit" {print; exit}')"
  IFS=$'\t' read -r _ mount_path mount_source mounted <<< "$(printf '%s\n' "$parsed" | awk -F '\t' '$1=="mount" {print; exit}')"
  IFS=$'\t' read -r _ user_name user_uid user_gid <<< "$(printf '%s\n' "$parsed" | awk -F '\t' '$1=="user" {print; exit}')"
  IFS=$'\t' read -r _ group_pid group_uid group_start group_executable group_pgid \
    <<< "$(printf '%s\n' "$parsed" | awk -F '\t' '$1=="group" {print; exit}')"

  if [[ "$unit_active" == "1" && -n "$unit_name" ]]; then
    systemctl stop -- "$unit_name"
  fi

  if [[ ("$journal_format" == "tm-sanitizer-run-journal-v3" || "$journal_format" == "tm-sanitizer-run-journal-v4") \
      && "$journal_state" == "worker-launch-intent" && -z "$group_pid" ]]; then
    fail "worker launch identity is uncertain; retaining journal"
  fi
  if [[ -n "$group_pid" ]]; then
    terminate_recorded_process_group "$group_pid" "$group_uid" "$group_start" "$group_executable" "$group_pgid"
  fi

  while IFS=$'\t' read -r kind role pid uid start_ticks executable process_pgid; do
    [[ "$kind" == "process" ]] || continue
    if [[ "$role" == "worker" ]]; then
      if [[ "$journal_format" != "tm-sanitizer-run-journal-v3" && "$journal_format" != "tm-sanitizer-run-journal-v4" ]]; then
        if process_alive "$pid"; then fail "legacy worker lacks a verified process-group identity"; fi
      fi
      continue
    fi
    if [[ "$journal_format" == "tm-sanitizer-run-journal-v1" ]] && process_alive "$pid"; then
      fail "legacy coordinator lacks an exact start-time/executable identity"
    fi
    terminate_recorded_process "$role" "$pid" "$uid" "$start_ticks" "$executable" "$run_id" "$process_pgid"
  done <<< "$parsed"

  if [[ "$mounted" == "1" && -n "$mount_path" ]]; then
    assert_cleanup_path "$mount_path"
    if mountpoint -q -- "$mount_path"; then
      local actual_source
      actual_source="$(findmnt -n -o SOURCE --target "$mount_path")"
      [[ -n "$mount_source" && "$actual_source" == "$mount_source" ]] || fail "recorded mount source mismatch"
      umount -- "$mount_path"
    fi
  fi

  recover_publication_hardlink_pair "$journal" "$user_uid" \
    || fail "publication hardlink recovery failed; retaining journal"

  while IFS=$'\t' read -r kind _ target expected_device expected_inode; do
    [[ "$kind" == "path" ]] || continue
    assert_cleanup_path "$target"
    safe_remove_tree "$target" "$user_uid" "$expected_device" "$expected_inode"
  done <<< "$parsed"

  if [[ -n "$user_name" && -n "$user_uid" ]]; then
    if getent passwd "$user_name" >/dev/null; then
      [[ "$(id -u "$user_name")" == "$user_uid" && "$(id -g "$user_name")" == "$user_gid" ]] || fail "ephemeral user identity mismatch"
      userdel --force -- "$user_name"
    fi
  fi

  unlink -- "$journal"
  fsync_directory "$JOURNAL_ROOT"
}

recover_journal_temp() {
  local temporary="$1" result status final
  if result="$(node - "$JOURNAL_ROOT" "$temporary" "$(expected_owner)" "$JOURNAL_TMP_STALE_SECONDS" "$TEST_MODE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, temporaryInput, ownerInput, staleInput, testMode] = process.argv.slice(2);
const root = path.resolve(rootInput);
const temporary = path.resolve(temporaryInput);
const owner = Number(ownerInput);
const staleMs = Number(staleInput) * 1000;
if (path.dirname(temporary) !== root) throw new Error('journal temp escapes journal root');
const match = path.basename(temporary).match(/^([0-9a-f]{32}\.run\.json)\.tmp-([1-9][0-9]*)(?:-([0-9a-f]{16}))?$/);
if (!match) throw new Error('invalid journal temp filename');
const rootStat = fs.lstatSync(root, { bigint: true });
const initial = fs.lstatSync(temporary, { bigint: true });
const final = path.join(root, match[1]);
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const safeMetadata = (entry) => entry.dev === rootStat.dev && (testMode === '1'
  || (Number(entry.uid) === owner && Number(entry.mode & 0o777n) === 0o600));
if (!initial.isFile() || initial.isSymbolicLink() || (initial.nlink !== 1n && initial.nlink !== 2n)) {
  throw new Error('unsafe journal temp type');
}
if (!safeMetadata(initial)) {
  throw new Error('journal temp owner, mode, or device mismatch');
}
const validateInterruptedPair = () => {
  let canonical;
  try {
    canonical = fs.lstatSync(final, { bigint: true });
  } catch (error) {
    throw new Error(`interrupted journal hardlink is missing its canonical final: ${error.code || error.message}`);
  }
  if (!canonical.isFile() || canonical.isSymbolicLink() || canonical.nlink !== 2n
      || !same(canonical, initial) || !safeMetadata(canonical)) {
    throw new Error('interrupted journal hardlink pair is unsafe');
  }
};
if (initial.nlink === 2n) validateInterruptedPair();
if (initial.nlink === 1n && Date.now() - Number(initial.mtimeMs) < staleMs) {
  process.stdout.write('fresh');
  process.exit(0);
}
if (initial.size <= 0n || initial.size > 1024n * 1024n) throw new Error('journal temp size is invalid');
const data = JSON.parse(fs.readFileSync(temporary, 'utf8'));
if (!data || !['tm-sanitizer-run-journal-v3', 'tm-sanitizer-run-journal-v4'].includes(data.format)) {
  throw new Error('journal temp has an unsupported format');
}
if (`${data.runId}.run.json` !== match[1]) throw new Error('journal temp run id mismatch');
const unlinkBoundTemp = () => {
  const current = fs.lstatSync(temporary, { bigint: true });
  if (!same(current, initial)) throw new Error('journal temp identity changed before cleanup');
  fs.unlinkSync(temporary);
};
const fsyncRoot = () => {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(root, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
if (initial.nlink === 2n) {
  validateInterruptedPair();
  unlinkBoundTemp();
  fsyncRoot();
  process.stdout.write(`recovered\t${final}`);
  process.exit(0);
}
try {
  fs.linkSync(temporary, final);
  if (testMode === '1' && process.env.TM_GATE_TEST_FAIL_AFTER_JOURNAL_LINK === '1') {
    throw new Error('injected failure immediately after journal hardlink publication');
  }
  const linked = fs.lstatSync(final, { bigint: true });
  if (!same(linked, initial)) throw new Error('recovered journal identity mismatch');
  unlinkBoundTemp();
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const existing = fs.lstatSync(final, { bigint: true });
  const sameRecoveredInode = same(existing, initial);
  if (!existing.isFile() || existing.isSymbolicLink()
      || (sameRecoveredInode ? existing.nlink !== 2n : existing.nlink !== 1n)
      || !safeMetadata(existing)) {
    throw new Error('existing recovered journal is unsafe');
  }
  if (!sameRecoveredInode) {
    throw new Error('different-inode final/temp journal conflict; retaining both for fail-closed reconciliation');
  }
  unlinkBoundTemp();
}
fsyncRoot();
process.stdout.write(`recovered\t${final}`);
NODE
)"; then
    status=0
  else
    status=$?
  fi
  [[ "$status" == "0" ]] || fail "journal temp recovery failed for $temporary"
  [[ "$result" == "fresh" ]] && return 0
  IFS=$'\t' read -r status final <<< "$result"
  [[ "$status" == "recovered" && -n "$final" ]] || fail "journal temp recovery returned invalid output"
  cleanup_one "$final"
}

case "${1:---all}" in
  --journal)
    [[ $# == 2 ]] || fail "--journal requires one path"
    cleanup_one "$2"
    ;;
  --all)
    [[ $# == 1 ]] || fail "--all accepts no extra arguments"
    [[ -d "$JOURNAL_ROOT" && ! -L "$JOURNAL_ROOT" ]] || fail "journal root is invalid"
    shopt -s nullglob
    journal_temps=("$JOURNAL_ROOT"/*.run.json.tmp-*)
    [[ "${#journal_temps[@]}" -le "$JOURNAL_TMP_RECOVERY_LIMIT" ]] \
      || fail "journal temp recovery limit exceeded"
    for temporary in "${journal_temps[@]}"; do recover_journal_temp "$temporary"; done
    journals=("$JOURNAL_ROOT"/*.run.json)
    for journal in "${journals[@]}"; do cleanup_one "$journal"; done
    ;;
  *) fail "unknown cleanup argument" ;;
esac

printf 'MIGRATION_GATE_CLEANUP_OK\n'
