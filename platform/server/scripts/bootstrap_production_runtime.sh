#!/bin/bash -p

if [[ "${BASH_SOURCE[0]}" = "$0" && "$-" != *p* ]]; then
  builtin exec /bin/bash -p "$0" "$@"
fi

if [[ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" && "${BASH_SOURCE[0]}" = "$0" ]]; then
  printf '%s\n' "TM_BOOTSTRAP_LIBRARY_ONLY=1 is valid only when sourced" >&2
  exit 64
fi

if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
fi

set -Eeuo pipefail

umask 077

LIVE_DIR="${TM_LIVE_DIR:-/root/turingmarket/platform}"
REMOTE_ROOT="${TM_REMOTE_ROOT:-/root/turingmarket}"
BACKUP_ROOT="$REMOTE_ROOT/backups"
STATE_ROOT="${TM_STATE_ROOT:-/var/lib/turingmarket}"
GATE_ROOT="${TM_GATE_ROOT:-/var/lib/turingmarket-gate}"
GATE_USER="turingmarket-gate"
ENV_DIR="${TM_ENV_DIR:-/etc/turingmarket}"
ENV_FILE="$ENV_DIR/turingmarket.env"
DB_DIR="$STATE_ROOT/db"
UPLOAD_DIR="$STATE_ROOT/uploads"
TMP_DIR="$STATE_ROOT/tmp"
APPARMOR_PROFILE="${TM_APPARMOR_PROFILE:-/etc/apparmor.d/turingmarket-gate-chromium}"
JOURNAL_ROOT="${TM_JOURNAL_ROOT:-/var/lib/turingmarket-bootstrap}"
JOURNAL_DIR="$JOURNAL_ROOT/active"
SANITIZER_JOURNAL_ROOT="${TM_SANITIZER_JOURNAL_ROOT:-/var/lib/turingmarket/migration-gate}"
SANITIZER_RUN_ROOT="${TM_SANITIZER_RUN_ROOT:-/run/turingmarket-gate}"
SANITIZER_LIFECYCLE_FENCE="${TM_SANITIZER_LIFECYCLE_FENCE:-/run/turingmarket-sanitizer-bootstrap.lock}"
EXTERNAL_LAYOUT_MARKER="$REMOTE_ROOT/.external-runtime-layout-v1"
OPERATION_FENCE="$REMOTE_ROOT/.deploy-v030.operation.lock"
LIFECYCLE_DIR="$REMOTE_ROOT/.deploy-v030.lock"
WRITER_DIR="$REMOTE_ROOT/.deploy-v030.writer"
BOOTSTRAP_OWNER_TOKEN="${TM_BOOTSTRAP_OWNER_TOKEN:-}"
BOOTSTRAP_FENCES_HELD=0
BOOTSTRAP_CONTROL_LOCKS_HELD=0
BOOTSTRAP_OPERATION_LOCK_PARENT=""
BOOTSTRAP_OPERATION_LOCK_PARENT_IDENTITY=""
BOOTSTRAP_SANITIZER_LOCK_PARENT=""
BOOTSTRAP_SANITIZER_LOCK_PARENT_IDENTITY=""
BOOTSTRAP_CLEANUP_ARMED=0
BOOTSTRAP_PROCESS_PID=""
BOOTSTRAP_PROCESS_BOOT_ID=""
BOOTSTRAP_PROCESS_STARTTIME=""
BOOTSTRAP_PROCESS_EXECUTABLE=""
BOOTSTRAP_RUN_TOKEN=""
BOOTSTRAP_VALIDATED_OWNER=""
BOOTSTRAP_VALIDATED_RUN_TOKEN=""
BOOTSTRAP_VALIDATED_PID=""
BOOTSTRAP_VALIDATED_BOOT_ID=""
BOOTSTRAP_VALIDATED_STARTTIME=""
BOOTSTRAP_VALIDATED_EXECUTABLE=""
BOOTSTRAP_VALIDATED_GENERATION=""
BOOTSTRAP_VALIDATED_PHASE=""
BOOTSTRAP_FENCE_SCHEMA_VERSION=2
JOURNAL_OWNER_TOKEN=""
JOURNAL_DIR_IDENTITY=""
JOURNAL_ENTRY_NAME="active"
JOURNAL_LEGACY_TEST=0
JOURNAL_PRESENT=0
JOURNAL_ROOT_TOKEN=""
JOURNAL_RESERVATION_MODE=""
JOURNAL_CAPACITY_RESERVED=0
JOURNAL_HEAD_DIGEST=""
JOURNAL_TERMINAL_STATE=""
JOURNAL_TERMINAL_ID=""
JOURNAL_MARKER_PROOF=""
EXTERNAL_LAYOUT_ROOT_TOKEN=""
EXTERNAL_LAYOUT_MARKER_PROOF=""
JOURNAL_PROVENANCE_VALIDATED=0
BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=""
SYSTEMD_UNIT_DIR="${TM_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
LOCAL_SBIN_DIR="${TM_LOCAL_SBIN_DIR:-/usr/local/sbin}"
NFT_BIN="${TM_NFT_BIN:-/usr/sbin/nft}"
FIREWALL_TABLE="turingmarket_loopback"
FIREWALL_UNIT="turingmarket-loopback-firewall.service"
FIREWALL_RULE_FILE="$ENV_DIR/turingmarket-loopback-firewall.nft"
FIREWALL_HELPER="$LOCAL_SBIN_DIR/turingmarket-loopback-firewall"
FIREWALL_SERVICE_FILE="$SYSTEMD_UNIT_DIR/$FIREWALL_UNIT"
PM2_FIREWALL_DROPIN_DIR="$SYSTEMD_UNIT_DIR/pm2-root.service.d"
PM2_FIREWALL_DROPIN_FILE="$PM2_FIREWALL_DROPIN_DIR/turingmarket-loopback-firewall.conf"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-$STAMP"
STATE_BACKUP="$BACKUP_DIR/state"
PROCESS_STOPPED=0
ABORTING=0

BROWSER_PACKAGES=(
  acl
  at-spi2-common
  fontconfig
  fonts-freefont-ttf
  fonts-ipafont-gothic
  fonts-liberation
  fonts-noto-color-emoji
  fonts-tlwg-loma-otf
  fonts-unifont
  fonts-wqy-zenhei
  libasound2-data
  libasound2t64
  libatk-bridge2.0-0t64
  libatk1.0-0t64
  libatspi2.0-0t64
  libavahi-client3
  libavahi-common-data
  libavahi-common3
  libcairo2
  libcups2t64
  libdatrie1
  libfontenc1
  libgraphite2-3
  libharfbuzz0b
  libpango-1.0-0
  libpixman-1-0
  libthai-data
  libthai0
  libxaw7
  libxcb-render0
  libxcomposite1
  libxdamage1
  libxfixes3
  libxfont2
  libxi6
  libxkbfile1
  libxmu6
  libxpm4
  libxrandr2
  libxres1
  libxt6t64
  nftables
  x11-xkb-utils
  xfonts-cyrillic
  xfonts-encodings
  xfonts-scalable
  xfonts-utils
  xserver-common
  xvfb
)

die() {
  printf '%s\n' "$1" >&2
  return 1
}

bootstrap_trusted_flock() {
  builtin command /usr/bin/flock "$@"
}

bootstrap_trusted_bash() {
  builtin command /bin/bash -p "$@"
}

bootstrap_trusted_id() {
  builtin command /usr/bin/id "$@"
}

bootstrap_trusted_readlink() {
  builtin command /usr/bin/readlink "$@"
}

bootstrap_trusted_realpath() {
  builtin command /usr/bin/realpath "$@"
}

bootstrap_trusted_stat() {
  builtin command /usr/bin/stat "$@"
}

path_entry_present_no_follow() {
  [ -e "$1" ] || [ -L "$1" ]
}

real_directory_no_follow() {
  [ -d "$1" ] && [ ! -L "$1" ]
}

migration_journal_directory_identity() {
  bootstrap_journal_dirfd_helper bind "$JOURNAL_ENTRY_NAME" "${JOURNAL_DIR_IDENTITY:-}"
}

validate_active_migration_journal_directory() {
  local actual_identity
  [ -n "$JOURNAL_DIR_IDENTITY" ] || {
    printf '%s\n' "Migration journal directory is not identity-bound" >&2
    return 1
  }
  actual_identity="$(bootstrap_journal_dirfd_helper authorize "$JOURNAL_ENTRY_NAME" "$JOURNAL_DIR_IDENTITY")" || {
    printf '%s\n' "Migration journal directory identity is unreadable" >&2
    return 1
  }
  if [ "$actual_identity" != "$JOURNAL_DIR_IDENTITY" ]; then
    printf '%s\n' "Migration journal directory identity changed" >&2
    return 1
  fi
}

bind_active_migration_journal_directory() {
  local actual_identity
  actual_identity="$(bootstrap_journal_dirfd_helper bind "$JOURNAL_ENTRY_NAME" "${JOURNAL_DIR_IDENTITY:-}")" || return 1
  if [ -n "$JOURNAL_DIR_IDENTITY" ] && [ "$actual_identity" != "$JOURNAL_DIR_IDENTITY" ]; then
    printf '%s\n' "Migration journal directory identity changed before binding" >&2
    return 1
  fi
  JOURNAL_DIR_IDENTITY="$actual_identity"
}

run_persistent_runtime_command() {
  "$@" 5>&- 6>&- 7>&- 8>&- 9>&-
}

assert_retained_lock_fd() {
  local fd="$1" lock_path="$2" label="$3" expected_identity="${4:-}"
  local fd_path="/proc/$BASHPID/fd/$1" resolved fd_identity path_identity
  [ -e "$fd_path" ] || { die "$label descriptor is not retained by bootstrap"; return 1; }
  resolved="$(bootstrap_trusted_readlink -f -- "$fd_path")" || return 1
  [ "$resolved" = "$lock_path" ] \
    || { die "$label descriptor path mismatch"; return 1; }
  fd_identity="$(bootstrap_trusted_stat -Lc '%u:%g:%a:%h:%d:%i' -- "$fd_path")" || return 1
  path_identity="$(bootstrap_trusted_stat -Lc '%u:%g:%a:%h:%d:%i' -- "$lock_path")" || return 1
  [ "$fd_identity" = "$path_identity" ] \
    || { die "$label descriptor identity mismatch"; return 1; }
  if [ -n "$expected_identity" ] && [ "$fd_identity" != "$expected_identity" ]; then
    die "$label identity changed before lock acquisition"
    return 1
  fi
}

assert_retained_lock_parent_fd() {
  local fd="$1" parent_path="$2" label="$3" expected_identity="$4"
  local fd_path="/proc/$BASHPID/fd/$1" resolved fd_identity path_identity
  [ -e "$fd_path" ] || { die "$label parent descriptor is not retained by bootstrap"; return 1; }
  resolved="$(bootstrap_trusted_readlink -f -- "$fd_path")" || return 1
  [ "$resolved" = "$parent_path" ] \
    || { die "$label parent descriptor path mismatch"; return 1; }
  fd_identity="$(bootstrap_trusted_stat -Lc '%u:%g:%a:%d:%i' -- "$fd_path")" || return 1
  path_identity="$(bootstrap_validate_trusted_lock_parent \
    "$parent_path" "$label" "$expected_identity")" || return 1
  [ "$fd_identity" = "$path_identity" ] \
    || { die "$label parent descriptor identity mismatch"; return 1; }
  [ "$fd_identity" = "$expected_identity" ] \
    || { die "$label parent identity changed before lock acquisition"; return 1; }
}

bootstrap_close_control_lock_fds() {
  exec 5>&- 6>&- 8>&- 9>&-
  BOOTSTRAP_CONTROL_LOCKS_HELD=0
  BOOTSTRAP_OPERATION_LOCK_PARENT=""
  BOOTSTRAP_OPERATION_LOCK_PARENT_IDENTITY=""
  BOOTSTRAP_SANITIZER_LOCK_PARENT=""
  BOOTSTRAP_SANITIZER_LOCK_PARENT_IDENTITY=""
}

expected_bootstrap_owner() {
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    printf '%s:%s\n' "$(bootstrap_trusted_id -un)" "$(bootstrap_trusted_id -gn)"
  else
    printf '%s\n' "root:root"
  fi
}

bootstrap_findmnt() {
  local trusted_path=/usr/bin/findmnt resolved path metadata
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    builtin type -t findmnt >/dev/null 2>&1 || return 127
    findmnt "$@"
    return $?
  fi
  ! builtin declare -F findmnt >/dev/null 2>&1 || return 1
  resolved="$(builtin type -P -- findmnt 2>/dev/null)" || return 1
  [ "$resolved" = "$trusted_path" ] || return 1
  for path in /usr /usr/bin; do
    [ -d "$path" ] && [ ! -L "$path" ] || return 1
    [ "$(bootstrap_trusted_realpath -e -- "$path")" = "$path" ] || return 1
    [ "$(bootstrap_trusted_stat -c '%u:%g:%a' -- "$path")" = "0:0:755" ] || return 1
  done
  [ -f "$trusted_path" ] && [ ! -L "$trusted_path" ] && [ -x "$trusted_path" ] || return 1
  [ "$(bootstrap_trusted_realpath -e -- "$trusted_path")" = "$trusted_path" ] || return 1
  metadata="$(bootstrap_trusted_stat -c '%u:%g:%a:%h' -- "$trusted_path")" || return 1
  [ "$metadata" = "0:0:755:1" ] || return 1
  builtin command "$trusted_path" "$@"
}

validate_bootstrap_token() {
  [[ "${1:-}" =~ ^[0-9a-f]{32}$ ]]
}

bootstrap_test_sigkill() {
  local point="$1"
  bootstrap_reject_production_test_hooks || return 1
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ] && [ "${TM_BOOTSTRAP_TEST_SIGKILL_AT:-}" = "$point" ]; then
    kill -KILL "$BASHPID"
  fi
}

bootstrap_test_hooks_enabled() {
  [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]
}

bootstrap_reject_production_test_hooks() {
  local name
  bootstrap_test_hooks_enabled && return 0
  while IFS= read -r name; do
    case "$name" in
      TM_TEST_*|TM_BOOTSTRAP_TEST_*)
        printf '%s\n' "Bootstrap test hook is forbidden in production mode: $name" >&2
        return 1
        ;;
    esac
  done < <(compgen -v)
}

bootstrap_initialize_process_identity() {
  local identity process_pid
  process_pid="$BASHPID"
  validate_bootstrap_token "$BOOTSTRAP_OWNER_TOKEN" || {
    die "Bootstrap owner token is invalid"
    return 1
  }
  identity="$(python3 - "$process_pid" <<'PY'
import os
import re
import sys

pid = int(sys.argv[1])
with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as handle:
    boot_id = handle.read().strip().lower()
if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', boot_id):
    raise SystemExit('Invalid Linux boot identity')
with open(f'/proc/{pid}/stat', encoding='ascii') as handle:
    stat_line = handle.read().strip()
closing = stat_line.rfind(')')
if closing < 0:
    raise SystemExit('Invalid Linux process stat')
fields = stat_line[closing + 2:].split()
if len(fields) < 20 or not fields[19].isdigit() or int(fields[19]) <= 0:
    raise SystemExit('Invalid Linux process start time')
executable = os.path.realpath(f'/proc/{pid}/exe')
if not os.path.isabs(executable) or any(character in executable for character in ('\0', '\n', '\r', '\t')):
    raise SystemExit('Invalid Linux process executable')
print('\t'.join((str(pid), boot_id, fields[19], executable)))
PY
  )" || return 1
  IFS=$'\t' read -r BOOTSTRAP_PROCESS_PID BOOTSTRAP_PROCESS_BOOT_ID BOOTSTRAP_PROCESS_STARTTIME BOOTSTRAP_PROCESS_EXECUTABLE <<< "$identity"
  [ "$BOOTSTRAP_PROCESS_PID" = "$process_pid" ] || return 1
  BOOTSTRAP_RUN_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
}

bootstrap_ensure_process_identity() {
  if [ "$BOOTSTRAP_PROCESS_PID" != "$BASHPID" ] || [ "$BOOTSTRAP_RUN_TOKEN" != "$BOOTSTRAP_OWNER_TOKEN" ]; then
    bootstrap_initialize_process_identity
  fi
}

bootstrap_write_generation() {
  local directory="$1"
  local kind="$2"
  local phase="$3"
  bootstrap_ensure_process_identity || return 1
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  [ "$(bootstrap_trusted_stat -c '%U:%G:%a' "$directory")" = "$(expected_bootstrap_owner):700" ] || return 1
  if ! python3 - "$directory/run.json" "$BOOTSTRAP_FENCE_SCHEMA_VERSION" "$kind" "$BOOTSTRAP_OWNER_TOKEN" "$BOOTSTRAP_RUN_TOKEN" "$BOOTSTRAP_PROCESS_PID" "$BOOTSTRAP_PROCESS_BOOT_ID" "$BOOTSTRAP_PROCESS_STARTTIME" "$BOOTSTRAP_PROCESS_EXECUTABLE" <<'PY'
import json
import os
import sys

(
    target,
    schema_version,
    kind,
    owner_token,
    run_token,
    pid,
    boot_id,
    start_time,
    executable,
) = sys.argv[1:]
payload = {
    'schemaVersion': int(schema_version),
    'operation': 'bootstrap',
    'kind': kind,
    'ownerToken': owner_token,
    'runToken': run_token,
    'pid': int(pid),
    'bootId': boot_id,
    'startTimeTicks': start_time,
    'executable': executable,
    'recoveryGeneration': 0,
}
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  then
    return 1
  fi
  printf '%s\n' "$BOOTSTRAP_OWNER_TOKEN" > "$directory/owner" || return 1
  printf '%s\n' "$phase" > "$directory/phase" || return 1
  chmod 0600 "$directory/run.json" "$directory/owner" "$directory/phase" || return 1
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    chown root:root "$directory/run.json" "$directory/owner" "$directory/phase" || return 1
  fi
  sync -f "$directory/run.json" || return 1
  sync -f "$directory/owner" || return 1
  sync -f "$directory/phase" || return 1
  sync_directory "$directory" || return 1
}

bootstrap_validate_generation() {
  local directory="$1"
  local expected_kind="$2"
  local expected_token="${3:-}"
  local validation expected_uid
  expected_uid="$(bootstrap_trusted_id -u)"
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    expected_uid=0
  fi
  validation="$(python3 - "$directory" "$expected_kind" "$expected_token" "$expected_uid" <<'PY'
import json
import os
import re
import signal
import stat
import sys

directory, expected_kind, expected_token, expected_uid_raw = sys.argv[1:]
expected_uid = int(expected_uid_raw)
token_pattern = re.compile(r'[0-9a-f]{32}')
boot_pattern = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
allowed_phases = {
    'lifecycle': {'bootstrap-setup', 'bootstrap-releasing'},
    'writer': {'bootstrap-setup', 'bootstrap-releasing'},
    'artifact-repair': {
        'repair-created', 'repair-stopped', 'repair-apparmor',
        'repair-firewall', 'repair-restarted', 'repair-validated',
    },
}
if expected_kind not in allowed_phases:
    raise SystemExit('Unknown bootstrap generation kind')
status = os.lstat(directory)
if stat.S_ISLNK(status.st_mode) or not stat.S_ISDIR(status.st_mode):
    raise SystemExit('Bootstrap generation is not a directory')
if status.st_uid != expected_uid or stat.S_IMODE(status.st_mode) != 0o700:
    raise SystemExit('Bootstrap generation owner or mode drift')
if os.path.realpath(directory) != os.path.abspath(directory):
    raise SystemExit('Bootstrap generation path is not canonical')
entries = {entry.name: entry for entry in os.scandir(directory)}
required_entries = {'run.json', 'owner', 'phase'}
if expected_kind == 'artifact-repair':
    if set(entries) not in (required_entries, required_entries | {'work'}):
        raise SystemExit('Artifact repair entries differ from schema')
else:
    if set(entries) != required_entries:
        raise SystemExit('Bootstrap fence entries differ from schema')
for name in required_entries:
    entry = entries[name]
    child_status = entry.stat(follow_symlinks=False)
    if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
        raise SystemExit('Bootstrap generation file is unsafe')
    if child_status.st_uid != expected_uid or stat.S_IMODE(child_status.st_mode) != 0o600 or child_status.st_nlink != 1:
        raise SystemExit('Bootstrap generation file metadata drift')
if 'work' in entries:
    work = entries['work']
    work_status = work.stat(follow_symlinks=False)
    if work.is_symlink() or not work.is_dir(follow_symlinks=False) or work_status.st_uid != expected_uid:
        raise SystemExit('Artifact repair work directory is unsafe')
    for root, directories, files in os.walk(work.path, topdown=True, followlinks=False):
        root_status = os.lstat(root)
        if not stat.S_ISDIR(root_status.st_mode) or root_status.st_uid != expected_uid:
            raise SystemExit('Artifact repair work tree is unsafe')
        for name in directories + files:
            child = os.path.join(root, name)
            child_status = os.lstat(child)
            if stat.S_ISLNK(child_status.st_mode) or child_status.st_uid != expected_uid:
                raise SystemExit('Artifact repair work entry is unsafe')
            if not (stat.S_ISDIR(child_status.st_mode) or stat.S_ISREG(child_status.st_mode)):
                raise SystemExit('Artifact repair work entry type is unsafe')
            if stat.S_ISREG(child_status.st_mode) and child_status.st_nlink != 1:
                raise SystemExit('Artifact repair work file has extra links')
with open(entries['run.json'].path, encoding='utf-8') as handle:
    metadata = json.load(handle)
required_fields = {
    'schemaVersion', 'operation', 'kind', 'ownerToken', 'runToken', 'pid',
    'bootId', 'startTimeTicks', 'executable', 'recoveryGeneration',
}
if set(metadata) != required_fields:
    raise SystemExit('Bootstrap generation metadata fields differ from schema')
if metadata['schemaVersion'] != 2 or metadata['operation'] != 'bootstrap' or metadata['kind'] != expected_kind:
    raise SystemExit('Bootstrap generation schema, operation, or kind is invalid')
if not isinstance(metadata['ownerToken'], str) or not token_pattern.fullmatch(metadata['ownerToken']):
    raise SystemExit('Bootstrap generation owner token is invalid')
if expected_token and metadata['ownerToken'] != expected_token:
    raise SystemExit('Bootstrap generation suffix owner does not match metadata')
if not isinstance(metadata['runToken'], str) or not token_pattern.fullmatch(metadata['runToken']):
    raise SystemExit('Bootstrap generation run token is invalid')
if not isinstance(metadata['pid'], int) or isinstance(metadata['pid'], bool) or metadata['pid'] <= 1:
    raise SystemExit('Bootstrap generation PID is invalid')
if not isinstance(metadata['bootId'], str) or not boot_pattern.fullmatch(metadata['bootId']):
    raise SystemExit('Bootstrap generation boot identity is invalid')
if not isinstance(metadata['startTimeTicks'], str) or not re.fullmatch(r'[1-9][0-9]*', metadata['startTimeTicks']):
    raise SystemExit('Bootstrap generation start time is invalid')
if (
    not isinstance(metadata['executable'], str)
    or not os.path.isabs(metadata['executable'])
    or os.path.normpath(metadata['executable']) != metadata['executable']
    or any(character in metadata['executable'] for character in ('\0', '\n', '\r', '\t'))
):
    raise SystemExit('Bootstrap generation executable is invalid')
if (
    not isinstance(metadata['recoveryGeneration'], int)
    or isinstance(metadata['recoveryGeneration'], bool)
    or metadata['recoveryGeneration'] < 0
):
    raise SystemExit('Bootstrap recovery generation is invalid')
with open(entries['owner'].path, encoding='ascii') as handle:
    owner = handle.read()
with open(entries['phase'].path, encoding='ascii') as handle:
    phase = handle.read()
if owner != metadata['ownerToken'] + '\n':
    raise SystemExit('Bootstrap generation owner CAS fields differ')
phase = phase.removesuffix('\n')
if '\n' in phase or phase not in allowed_phases[expected_kind]:
    raise SystemExit('Bootstrap generation phase is invalid')
print('\t'.join((
    metadata['ownerToken'],
    metadata['runToken'],
    str(metadata['pid']),
    metadata['bootId'],
    metadata['startTimeTicks'],
    metadata['executable'],
    str(metadata['recoveryGeneration']),
    phase,
)))
PY
  )" || return 1
  IFS=$'\t' read -r BOOTSTRAP_VALIDATED_OWNER BOOTSTRAP_VALIDATED_RUN_TOKEN BOOTSTRAP_VALIDATED_PID BOOTSTRAP_VALIDATED_BOOT_ID BOOTSTRAP_VALIDATED_STARTTIME BOOTSTRAP_VALIDATED_EXECUTABLE BOOTSTRAP_VALIDATED_GENERATION BOOTSTRAP_VALIDATED_PHASE <<< "$validation"
}

bootstrap_generation_owner_state() {
  python3 - "$BOOTSTRAP_VALIDATED_PID" "$BOOTSTRAP_VALIDATED_BOOT_ID" "$BOOTSTRAP_VALIDATED_STARTTIME" "$BOOTSTRAP_VALIDATED_EXECUTABLE" "$BOOTSTRAP_VALIDATED_RUN_TOKEN" <<'PY'
import os
import sys

pid_raw, expected_boot, expected_start, expected_executable, expected_run_token = sys.argv[1:]
pid = int(pid_raw)
try:
    with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as handle:
        current_boot = handle.read().strip().lower()
except OSError:
    print('unknown')
    raise SystemExit
if current_boot != expected_boot:
    print('stale')
    raise SystemExit
try:
    with open(f'/proc/{pid}/stat', encoding='ascii') as handle:
        stat_line = handle.read().strip()
    closing = stat_line.rfind(')')
    fields = stat_line[closing + 2:].split()
    current_start = fields[19]
    current_executable = os.path.realpath(f'/proc/{pid}/exe')
except (FileNotFoundError, ProcessLookupError):
    print('stale')
    raise SystemExit
except (OSError, IndexError):
    print('unknown')
    raise SystemExit
if current_start != expected_start or current_executable != expected_executable:
    print('stale')
    raise SystemExit
try:
    with open(f'/proc/{pid}/environ', 'rb') as handle:
        environment = handle.read().split(b'\0')
except (FileNotFoundError, ProcessLookupError):
    print('stale')
    raise SystemExit
except OSError:
    print('unknown')
    raise SystemExit
needle = f'TM_BOOTSTRAP_OWNER_TOKEN={expected_run_token}'.encode('ascii')
print('live' if needle in environment else 'foreign')
PY
}

bootstrap_generation_phase_transition_allowed() {
  local kind="$1" current="$2" target="$3"
  case "$kind:$current:$target" in
    lifecycle:bootstrap-setup:bootstrap-setup|lifecycle:bootstrap-setup:bootstrap-releasing|lifecycle:bootstrap-releasing:bootstrap-releasing) ;;
    writer:bootstrap-setup:bootstrap-setup|writer:bootstrap-setup:bootstrap-releasing|writer:bootstrap-releasing:bootstrap-releasing) ;;
    artifact-repair:repair-created:repair-created|artifact-repair:repair-created:repair-stopped) ;;
    artifact-repair:repair-stopped:repair-stopped|artifact-repair:repair-stopped:repair-apparmor) ;;
    artifact-repair:repair-apparmor:repair-apparmor|artifact-repair:repair-apparmor:repair-firewall) ;;
    artifact-repair:repair-firewall:repair-firewall|artifact-repair:repair-firewall:repair-restarted) ;;
    artifact-repair:repair-restarted:repair-restarted|artifact-repair:repair-restarted:repair-validated) ;;
    artifact-repair:repair-validated:repair-validated) ;;
    *) return 1 ;;
  esac
}

bootstrap_generation_phase_stage_path() {
  local directory="$1" kind="$2" owner="$3" generation="$4" current="$5" target="$6"
  local parent directory_identity binding_digest
  validate_bootstrap_token "$owner" || return 1
  [[ "$generation" =~ ^[0-9]+$ ]] || return 1
  bootstrap_generation_phase_transition_allowed "$kind" "$current" "$target" || return 1
  parent="$(dirname -- "$directory")" || return 1
  directory_identity="$(bootstrap_trusted_stat -c '%d:%i' -- "$directory")" || return 1
  binding_digest="$(
    {
      builtin printf 'bootstrap-generation-phase-v2\0'
      builtin printf '%s\0' "$directory" "$directory_identity" "$kind" "$owner" "$generation" "$current" "$target"
    } | sha256sum | awk '{print $1}'
  )" || return 1
  [[ "$binding_digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  builtin printf '%s/.bootstrap-phase-next-v2.%s.%s.%s.%s\n' \
    "$parent" "$kind" "$owner" "$generation" "$binding_digest"
}

bootstrap_generation_phase_stage_state() {
  local temporary="$1" parent="$2" expected_uid="$3" expected_gid="$4"
  local payload_size="$5" payload_digest="$6" empty_digest="$7"
  local metadata actual_size actual_digest parent_device temporary_device canonical
  [ -f "$temporary" ] && [ ! -L "$temporary" ] || return 1
  canonical="$(bootstrap_trusted_realpath -e -- "$temporary")" || return 1
  [ "$canonical" = "$temporary" ] || return 1
  metadata="$(bootstrap_trusted_stat -c '%u:%g:%a:%h' -- "$temporary")" || return 1
  [ "$metadata" = "$expected_uid:$expected_gid:600:1" ] || return 1
  parent_device="$(bootstrap_trusted_stat -c '%d' -- "$parent")" || return 1
  temporary_device="$(bootstrap_trusted_stat -c '%d' -- "$temporary")" || return 1
  [ "$temporary_device" = "$parent_device" ] || return 1
  actual_size="$(bootstrap_trusted_stat -c '%s' -- "$temporary")" || return 1
  actual_digest="$(sha256sum -- "$temporary" | awk '{print $1}')" || return 1
  if [ "$actual_size" = 0 ] && [ "$actual_digest" = "$empty_digest" ]; then
    printf '%s\n' empty
  elif [ "$actual_size" = "$payload_size" ] && [ "$actual_digest" = "$payload_digest" ]; then
    printf '%s\n' complete
  else
    return 1
  fi
}

bootstrap_set_generation_phase() {
  local directory="$1" kind="$2" phase="$3"
  local parent canonical parent_canonical
  local expected_uid expected_gid expected_owner current generation temporary legacy_temporary
  local candidate stage_state payload_size payload_digest empty_digest
  local -a phase_stages=()

  validate_bootstrap_token "$BOOTSTRAP_OWNER_TOKEN" || return 1
  bootstrap_validate_generation "$directory" "$kind" "$BOOTSTRAP_OWNER_TOKEN" || return 1
  expected_owner="$BOOTSTRAP_VALIDATED_OWNER"
  current="$BOOTSTRAP_VALIDATED_PHASE"
  generation="$BOOTSTRAP_VALIDATED_GENERATION"
  [ "$expected_owner" = "$BOOTSTRAP_OWNER_TOKEN" ] || return 1
  [[ "$generation" =~ ^[0-9]+$ ]] || return 1
  bootstrap_generation_phase_transition_allowed "$kind" "$current" "$phase" || return 1

  canonical="$(bootstrap_trusted_realpath -e -- "$directory")" || return 1
  [ "$canonical" = "$directory" ] || return 1
  parent="$(dirname -- "$directory")" || return 1
  parent_canonical="$(bootstrap_trusted_realpath -e -- "$parent")" || return 1
  [ "$parent_canonical" = "$parent" ] || return 1
  expected_uid="$(bootstrap_trusted_id -u)" || return 1
  expected_gid="$(bootstrap_trusted_id -g)" || return 1
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    expected_uid=0
    expected_gid=0
  fi
  [ "$(bootstrap_trusted_stat -c '%u:%g:%a' -- "$directory")" = "$expected_uid:$expected_gid:700" ] || return 1
  for candidate in "$directory/run.json" "$directory/owner" "$directory/phase"; do
    [ "$(bootstrap_trusted_stat -c '%u:%g:%a:%h' -- "$candidate")" = "$expected_uid:$expected_gid:600:1" ] || return 1
  done
  temporary="$(bootstrap_generation_phase_stage_path \
    "$directory" "$kind" "$BOOTSTRAP_OWNER_TOKEN" "$generation" "$current" "$phase")" || return 1
  legacy_temporary="$parent/.bootstrap-phase-next.$kind.$BOOTSTRAP_OWNER_TOKEN"
  payload_size=$((${#phase} + 1))
  payload_digest="$(builtin printf '%s\n' "$phase" | sha256sum | awk '{print $1}')" || return 1
  empty_digest="$(builtin printf '' | sha256sum | awk '{print $1}')" || return 1

  shopt -s nullglob
  phase_stages=("$parent"/.bootstrap-phase-next*)
  shopt -u nullglob
  for candidate in "${phase_stages[@]}"; do
    if [ "$candidate" != "$temporary" ] && [ "$candidate" != "$legacy_temporary" ]; then
      return 1
    fi
  done
  if path_entry_present_no_follow "$temporary" && path_entry_present_no_follow "$legacy_temporary"; then
    return 1
  fi
  if path_entry_present_no_follow "$legacy_temporary"; then
    stage_state="$(bootstrap_generation_phase_stage_state \
      "$legacy_temporary" "$parent" "$expected_uid" "$expected_gid" \
      "$payload_size" "$payload_digest" "$empty_digest")" || return 1
    [ "$stage_state" = complete ] || return 1
    temporary="$legacy_temporary"
  elif path_entry_present_no_follow "$temporary"; then
    stage_state="$(bootstrap_generation_phase_stage_state \
      "$temporary" "$parent" "$expected_uid" "$expected_gid" \
      "$payload_size" "$payload_digest" "$empty_digest")" || return 1
  else
    if [ "$current" = "$phase" ]; then
      sync -f "$directory/phase" || return 1
      sync_directory "$directory" || return 1
      sync_directory "$parent" || return 1
      return 0
    fi
    (set -C; umask 077; : > "$temporary") || return 1
    stage_state=empty
  fi

  bootstrap_test_sigkill generation-phase-stage-created || return $?
  if [ "$stage_state" = empty ]; then
    printf '%s\n' "$phase" > "$temporary" || return 1
  fi
  stage_state="$(bootstrap_generation_phase_stage_state \
    "$temporary" "$parent" "$expected_uid" "$expected_gid" \
    "$payload_size" "$payload_digest" "$empty_digest")" || return 1
  [ "$stage_state" = complete ] || return 1
  bootstrap_test_sigkill generation-phase-stage-written || return $?
  chmod 0600 "$temporary" || return 1
  bootstrap_test_sigkill generation-phase-stage-chmod || return $?
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    chown root:root "$temporary" || return 1
  fi
  bootstrap_test_sigkill generation-phase-stage-chown || return $?
  sync -f "$temporary" || return 1
  bootstrap_test_sigkill generation-phase-stage-file-fsync || return $?

  bootstrap_validate_generation "$directory" "$kind" "$BOOTSTRAP_OWNER_TOKEN" || return 1
  [ "$BOOTSTRAP_VALIDATED_OWNER" = "$expected_owner" ] || return 1
  [ "$BOOTSTRAP_VALIDATED_GENERATION" = "$generation" ] || return 1
  [ "$BOOTSTRAP_VALIDATED_PHASE" = "$current" ] || return 1
  stage_state="$(bootstrap_generation_phase_stage_state \
    "$temporary" "$parent" "$expected_uid" "$expected_gid" \
    "$payload_size" "$payload_digest" "$empty_digest")" || return 1
  [ "$stage_state" = complete ] || return 1
  bootstrap_test_sigkill generation-phase-before-rename || return $?
  stage_state="$(bootstrap_generation_phase_stage_state \
    "$temporary" "$parent" "$expected_uid" "$expected_gid" \
    "$payload_size" "$payload_digest" "$empty_digest")" || return 1
  [ "$stage_state" = complete ] || return 1
  mv -f -- "$temporary" "$directory/phase" || return 1
  sync -f "$directory/phase" || return 1
  sync_directory "$directory" || return 1
  sync_directory "$parent" || return 1
  bootstrap_validate_generation "$directory" "$kind" "$BOOTSTRAP_OWNER_TOKEN" || return 1
  [ "$BOOTSTRAP_VALIDATED_OWNER" = "$expected_owner" ] || return 1
  [ "$BOOTSTRAP_VALIDATED_GENERATION" = "$generation" ] || return 1
  [ "$BOOTSTRAP_VALIDATED_PHASE" = "$phase" ] || return 1
}

bootstrap_reconcile_stale_generation_phase_stage() {
  local directory="$1" kind="$2" expected_owner="$3" generation="$4" current="$5"
  local target expected_stage
  case "$kind:$current" in
    lifecycle:bootstrap-setup|writer:bootstrap-setup) target=bootstrap-releasing ;;
    lifecycle:bootstrap-releasing|writer:bootstrap-releasing) target=bootstrap-releasing ;;
    *) return 1 ;;
  esac
  expected_stage="$(bootstrap_generation_phase_stage_path \
    "$directory" "$kind" "$expected_owner" "$generation" "$current" "$target")" || return 1
  path_entry_present_no_follow "$expected_stage" || return 0
  (
    BOOTSTRAP_OWNER_TOKEN="$expected_owner"
    bootstrap_set_generation_phase "$directory" "$kind" "$target"
  )
}

bootstrap_require_no_generation_phase_stages_in_parent() {
  local parent="$1" context="$2" stage
  local -a stages=()
  [ -d "$parent" ] && [ ! -L "$parent" ] || return 0
  shopt -s nullglob
  stages=("$parent"/.bootstrap-phase-next*)
  shopt -u nullglob
  for stage in "${stages[@]}"; do
    printf '%s\n' "$context: $stage" >&2
    return 1
  done
}

bootstrap_require_no_generation_phase_stages() {
  bootstrap_require_no_generation_phase_stages_in_parent \
    "$REMOTE_ROOT" "Unresolved bootstrap generation phase stage" || return 1
  bootstrap_require_no_generation_phase_stages_in_parent \
    "$JOURNAL_ROOT" "Unresolved artifact generation phase stage"
}

bootstrap_generation_delete_helper() {
  local action="$1"
  local parent="$2"
  local directory="${3:-}"
  local kind="${4:-}"
  local expected_token="${5:-}"
  local expected_uid
  bootstrap_reject_production_test_hooks || return 1
  expected_uid="$(bootstrap_trusted_id -u)"
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    expected_uid=0
  fi
  python3 - "$action" "$parent" "$directory" "$kind" "$expected_token" "$expected_uid" "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" <<'PY'
import hashlib
import json
import os
import re
import signal
import stat
import sys

action, parent, directory, requested_kind, requested_token, expected_uid_raw, library_only = sys.argv[1:]
expected_uid = int(expected_uid_raw)
token_pattern = re.compile(r'[0-9a-f]{32}')
tombstone_prefix = '.bootstrap-delete-v1.'
build_prefix = '.bootstrap-delete-build-v1.'
read_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
directory_flags = read_flags | os.O_DIRECTORY


def reject(message):
    raise SystemExit(message)


if not hasattr(os, 'O_PATH'):
    reject('Bootstrap deletion requires Linux O_PATH mount identity support')
identity_flags = os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW


def mount_id_for_fd(descriptor):
    try:
        with open(f'/proc/self/fdinfo/{descriptor}', encoding='ascii') as handle:
            matches = [
                match.group(1)
                for line in handle.read().splitlines()
                if (match := re.fullmatch(r'mnt_id:\s*([1-9][0-9]*)', line))
            ]
    except OSError:
        reject('Bootstrap deletion cannot read kernel mount identity')
    if len(matches) != 1:
        reject('Bootstrap deletion kernel mount identity is unavailable')
    return int(matches[0])


def ensure_mount_identity(descriptor, expected_mount_id, label):
    if mount_id_for_fd(descriptor) != expected_mount_id:
        reject(f'{label} mount identity drift')


def open_identity(parent_fd, name):
    descriptor = os.open(name, identity_flags, dir_fd=parent_fd)
    try:
        return descriptor, os.fstat(descriptor), mount_id_for_fd(descriptor)
    except BaseException:
        os.close(descriptor)
        raise


def durable_boundary(point):
    if library_only != '1':
        return
    if os.environ.get('TM_BOOTSTRAP_TEST_DELETE_IOERROR_AT') == point:
        raise OSError(5, f'simulated I/O failure at {point}')
    if os.environ.get('TM_BOOTSTRAP_TEST_DELETE_SIGKILL_AT') == point:
        parent_pid = os.getppid()
        os.kill(parent_pid, signal.SIGKILL)
        os.kill(os.getpid(), signal.SIGKILL)


def validate_parent(path):
    if not os.path.isabs(path) or os.path.normpath(path) != path or os.path.realpath(path) != path:
        reject('Bootstrap deletion parent is not canonical')
    path_status = os.lstat(path)
    if not stat.S_ISDIR(path_status.st_mode) or stat.S_ISLNK(path_status.st_mode):
        reject('Bootstrap deletion parent is not a directory')
    if path_status.st_uid != expected_uid or stat.S_IMODE(path_status.st_mode) & 0o022:
        reject('Bootstrap deletion parent ownership or mode drift')
    descriptor = os.open(path, directory_flags)
    descriptor_status = os.fstat(descriptor)
    if (descriptor_status.st_dev, descriptor_status.st_ino) != (path_status.st_dev, path_status.st_ino):
        os.close(descriptor)
        reject('Bootstrap deletion parent changed while opening')
    return descriptor, descriptor_status, mount_id_for_fd(descriptor)


def validate_target_name(name, kind):
    token = r'[0-9a-f]{32}'
    if kind == 'lifecycle':
        patterns = (
            r'\.deploy-v030\.lock',
            rf'\.deploy-v030\.lock\.(?:next|released)\.{token}',
            rf'\.deploy-v030\.bootstrap-quarantine\.lifecycle-[A-Za-z0-9.-]+\.{token}\.{token}',
        )
    elif kind == 'writer':
        patterns = (
            r'\.deploy-v030\.writer',
            rf'\.deploy-v030\.writer\.(?:next|released)\.{token}',
            rf'\.deploy-v030\.bootstrap-quarantine\.writer-[A-Za-z0-9.-]+\.{token}\.{token}',
        )
    elif kind == 'artifact-repair':
        patterns = (rf'artifact-repair-{token}(?:\.released\.{token})?',)
    else:
        reject('Unknown bootstrap deletion kind')
    if not any(re.fullmatch(pattern, name) for pattern in patterns):
        reject('Bootstrap deletion target name is outside the schema')


def relative_name_is_safe(name):
    return bool(name) and name not in ('.', '..') and not any(character in name for character in ('/', '\0', '\n', '\r', '\t'))


def open_regular(parent_fd, name, expected_status=None, expected_mount_id=None):
    descriptor = os.open(name, read_flags, dir_fd=parent_fd)
    descriptor_status = os.fstat(descriptor)
    if not stat.S_ISREG(descriptor_status.st_mode):
        os.close(descriptor)
        reject('Bootstrap deletion encountered a non-regular file')
    if expected_status is not None and (
        descriptor_status.st_dev,
        descriptor_status.st_ino,
    ) != (expected_status.st_dev, expected_status.st_ino):
        os.close(descriptor)
        reject('Bootstrap deletion file changed while opening')
    descriptor_mount_id = mount_id_for_fd(descriptor)
    if expected_mount_id is not None and descriptor_mount_id != expected_mount_id:
        os.close(descriptor)
        reject('Bootstrap deletion file crosses a mount boundary')
    return descriptor, descriptor_status, descriptor_mount_id


def read_descriptor(descriptor, maximum=16 * 1024 * 1024):
    chunks = []
    total = 0
    while True:
        chunk = os.read(descriptor, 65536)
        if not chunk:
            break
        total += len(chunk)
        if total > maximum:
            reject('Bootstrap deletion metadata is too large')
        chunks.append(chunk)
    return b''.join(chunks)


def file_digest(parent_fd, name, expected_status, root_mount_id):
    descriptor, descriptor_status, _ = open_regular(
        parent_fd, name, expected_status, root_mount_id,
    )
    try:
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
        return digest.hexdigest(), size, descriptor_status
    finally:
        os.close(descriptor)


def status_record(parent_fd, name, relative_path, root_device, root_mount_id):
    if not relative_name_is_safe(name):
        reject('Bootstrap deletion entry name is unsafe')
    identity_fd, entry_status, entry_mount_id = open_identity(parent_fd, name)
    try:
        if (
            entry_status.st_dev != root_device
            or entry_mount_id != root_mount_id
            or entry_status.st_uid != expected_uid
        ):
            reject('Bootstrap deletion entry owner or mount identity drift')
        mode = stat.S_IMODE(entry_status.st_mode)
        if stat.S_ISDIR(entry_status.st_mode):
            if mode & 0o022:
                reject('Bootstrap deletion directory mode drift')
            return {
                'path': relative_path,
                'type': 'directory',
                'device': entry_status.st_dev,
                'inode': entry_status.st_ino,
                'uid': entry_status.st_uid,
                'mode': mode,
            }
        if not stat.S_ISREG(entry_status.st_mode) or entry_status.st_nlink != 1 or mode & 0o022:
            reject('Bootstrap deletion file metadata drift')
        digest, size, descriptor_status = file_digest(
            parent_fd, name, entry_status, root_mount_id,
        )
        return {
            'path': relative_path,
            'type': 'file',
            'device': descriptor_status.st_dev,
            'inode': descriptor_status.st_ino,
            'uid': descriptor_status.st_uid,
            'mode': mode,
            'links': descriptor_status.st_nlink,
            'size': size,
            'sha256': digest,
        }
    finally:
        os.close(identity_fd)


def scan_tree(directory_fd, prefix, root_device, root_mount_id):
    ensure_mount_identity(directory_fd, root_mount_id, 'Bootstrap deletion recursive directory')
    records = []
    for name in sorted(os.listdir(directory_fd)):
        relative_path = f'{prefix}/{name}' if prefix else name
        record = status_record(directory_fd, name, relative_path, root_device, root_mount_id)
        records.append(record)
        if record['type'] == 'directory':
            child_fd = os.open(name, directory_flags, dir_fd=directory_fd)
            try:
                opened = os.fstat(child_fd)
                if (opened.st_dev, opened.st_ino) != (record['device'], record['inode']):
                    reject('Bootstrap deletion directory changed while opening')
                ensure_mount_identity(
                    child_fd, root_mount_id, 'Bootstrap deletion recursive directory',
                )
                records.extend(scan_tree(child_fd, relative_path, root_device, root_mount_id))
            finally:
                os.close(child_fd)
    return records


def read_relative_file(directory_fd, name, root_mount_id):
    entry_status = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    descriptor, descriptor_status, _ = open_regular(
        directory_fd, name, entry_status, root_mount_id,
    )
    try:
        if descriptor_status.st_uid != expected_uid or stat.S_IMODE(descriptor_status.st_mode) != 0o600 or descriptor_status.st_nlink != 1:
            reject('Bootstrap generation control file metadata drift')
        return read_descriptor(descriptor, 65536)
    finally:
        os.close(descriptor)


def validate_generation_controls(target_fd, kind, expected_token, root_mount_id):
    ensure_mount_identity(target_fd, root_mount_id, 'Bootstrap deletion target')
    root_entries = set(os.listdir(target_fd))
    controls = {'run.json', 'owner', 'phase'}
    if kind == 'artifact-repair':
        if root_entries not in (controls, controls | {'work'}):
            reject('Artifact repair entries differ from schema')
    elif root_entries != controls:
        reject('Bootstrap fence entries differ from schema')
    try:
        metadata = json.loads(read_relative_file(target_fd, 'run.json', root_mount_id).decode('utf-8'))
        owner = read_relative_file(target_fd, 'owner', root_mount_id).decode('ascii')
        phase = read_relative_file(target_fd, 'phase', root_mount_id).decode('ascii').removesuffix('\n')
    except (UnicodeDecodeError, json.JSONDecodeError):
        reject('Bootstrap generation control file is malformed')
    required_fields = {
        'schemaVersion', 'operation', 'kind', 'ownerToken', 'runToken', 'pid',
        'bootId', 'startTimeTicks', 'executable', 'recoveryGeneration',
    }
    allowed_phases = {
        'lifecycle': {'bootstrap-setup', 'bootstrap-releasing'},
        'writer': {'bootstrap-setup', 'bootstrap-releasing'},
        'artifact-repair': {
            'repair-created', 'repair-stopped', 'repair-apparmor', 'repair-firewall',
            'repair-restarted', 'repair-validated',
        },
    }
    if not isinstance(metadata, dict) or set(metadata) != required_fields:
        reject('Bootstrap generation metadata fields differ from schema')
    if metadata['schemaVersion'] != 2 or metadata['operation'] != 'bootstrap' or metadata['kind'] != kind:
        reject('Bootstrap generation schema, operation, or kind is invalid')
    if metadata['ownerToken'] != expected_token or not token_pattern.fullmatch(expected_token):
        reject('Bootstrap generation owner CAS fields differ')
    if owner != expected_token + '\n':
        reject('Bootstrap generation owner CAS fields differ')
    if not isinstance(metadata['runToken'], str) or not token_pattern.fullmatch(metadata['runToken']):
        reject('Bootstrap generation run token is invalid')
    if not isinstance(metadata['pid'], int) or isinstance(metadata['pid'], bool) or metadata['pid'] <= 1:
        reject('Bootstrap generation PID is invalid')
    if not isinstance(metadata['bootId'], str) or not re.fullmatch(
        r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
        metadata['bootId'],
    ):
        reject('Bootstrap generation boot identity is invalid')
    if not isinstance(metadata['startTimeTicks'], str) or not re.fullmatch(r'[1-9][0-9]*', metadata['startTimeTicks']):
        reject('Bootstrap generation start time is invalid')
    executable = metadata['executable']
    if (
        not isinstance(executable, str)
        or not os.path.isabs(executable)
        or os.path.normpath(executable) != executable
        or any(character in executable for character in ('\0', '\n', '\r', '\t'))
    ):
        reject('Bootstrap generation executable is invalid')
    generation = metadata['recoveryGeneration']
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
        reject('Bootstrap recovery generation is invalid')
    if '\n' in phase or phase not in allowed_phases[kind]:
        reject('Bootstrap generation phase is invalid')


def validate_fresh_target(
    parent_fd, parent_status, parent_mount_id, target_name, kind, expected_token,
):
    target_status = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(target_status.st_mode) or target_status.st_uid != expected_uid or stat.S_IMODE(target_status.st_mode) != 0o700:
        reject('Bootstrap deletion target ownership or mode drift')
    if target_status.st_dev != parent_status.st_dev:
        reject('Bootstrap deletion target crosses a mount boundary')
    target_fd = os.open(target_name, directory_flags, dir_fd=parent_fd)
    opened = os.fstat(target_fd)
    if (opened.st_dev, opened.st_ino) != (target_status.st_dev, target_status.st_ino):
        os.close(target_fd)
        reject('Bootstrap deletion target changed while opening')
    ensure_mount_identity(target_fd, parent_mount_id, 'Bootstrap deletion target')
    validate_generation_controls(target_fd, kind, expected_token, parent_mount_id)
    manifest = scan_tree(target_fd, '', parent_status.st_dev, parent_mount_id)
    return target_fd, target_status, manifest


def tombstone_names(target_name):
    suffix = hashlib.sha256(target_name.encode('utf-8')).hexdigest()
    return tombstone_prefix + suffix, build_prefix + suffix


def write_tombstone(
    parent_fd, parent_status, parent_mount_id, target_name, kind,
    expected_token, target_status, manifest,
):
    tombstone_name, build_name = tombstone_names(target_name)
    payload = {
        'schemaVersion': 1,
        'operation': 'bootstrap-generation-delete',
        'targetName': target_name,
        'kind': kind,
        'ownerToken': expected_token,
        'parentDevice': parent_status.st_dev,
        'parentInode': parent_status.st_ino,
        'targetDevice': target_status.st_dev,
        'targetInode': target_status.st_ino,
        'targetUid': target_status.st_uid,
        'targetMode': stat.S_IMODE(target_status.st_mode),
        'manifest': manifest,
    }
    encoded = (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    try:
        build_identity_fd, build_status, build_mount_id = open_identity(parent_fd, build_name)
    except FileNotFoundError:
        pass
    else:
        try:
            if (
                not stat.S_ISREG(build_status.st_mode)
                or build_status.st_uid != expected_uid
                or stat.S_IMODE(build_status.st_mode) != 0o600
                or build_status.st_nlink != 1
                or build_mount_id != parent_mount_id
            ):
                reject('Bootstrap deletion staging tombstone is unsafe')
            ensure_mount_identity(parent_fd, parent_mount_id, 'Bootstrap deletion parent')
            os.unlink(build_name, dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            os.close(build_identity_fd)
    descriptor = os.open(build_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
    try:
        ensure_mount_identity(descriptor, parent_mount_id, 'Bootstrap deletion staging tombstone')
        offset = 0
        while offset < len(encoded):
            offset += os.write(descriptor, encoded[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.fsync(parent_fd)
    os.rename(build_name, tombstone_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    os.fsync(parent_fd)
    durable_boundary('delete-tombstone-published')
    return tombstone_name, payload


def validate_manifest(manifest):
    if not isinstance(manifest, list):
        reject('Bootstrap deletion tombstone manifest is invalid')
    result = {}
    for record in manifest:
        if not isinstance(record, dict) or record.get('type') not in ('file', 'directory'):
            reject('Bootstrap deletion tombstone manifest entry is invalid')
        expected_keys = {'path', 'type', 'device', 'inode', 'uid', 'mode'}
        if record['type'] == 'file':
            expected_keys |= {'links', 'size', 'sha256'}
        if set(record) != expected_keys:
            reject('Bootstrap deletion tombstone manifest fields differ')
        path = record['path']
        if not isinstance(path, str) or path.startswith('/') or any(not relative_name_is_safe(part) for part in path.split('/')):
            reject('Bootstrap deletion tombstone manifest path is unsafe')
        if path in result:
            reject('Bootstrap deletion tombstone manifest path is duplicated')
        for field in ('device', 'inode', 'uid', 'mode'):
            if not isinstance(record[field], int) or isinstance(record[field], bool) or record[field] < 0:
                reject('Bootstrap deletion tombstone manifest number is invalid')
        if record['type'] == 'file':
            if record['links'] != 1 or not isinstance(record['size'], int) or record['size'] < 0:
                reject('Bootstrap deletion tombstone file metadata is invalid')
            if not isinstance(record['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', record['sha256']):
                reject('Bootstrap deletion tombstone file digest is invalid')
        result[path] = record
    return result


def read_tombstone(parent_fd, parent_status, parent_mount_id, tombstone_name):
    tombstone_status = os.stat(tombstone_name, dir_fd=parent_fd, follow_symlinks=False)
    descriptor, opened, opened_mount_id = open_regular(
        parent_fd, tombstone_name, tombstone_status, parent_mount_id,
    )
    try:
        if opened.st_uid != expected_uid or stat.S_IMODE(opened.st_mode) != 0o600 or opened.st_nlink != 1 or opened.st_dev != parent_status.st_dev:
            reject('Bootstrap deletion tombstone metadata drift')
        try:
            payload = json.loads(read_descriptor(descriptor).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            reject('Bootstrap deletion tombstone is malformed')
    finally:
        os.close(descriptor)
    required = {
        'schemaVersion', 'operation', 'targetName', 'kind', 'ownerToken',
        'parentDevice', 'parentInode', 'targetDevice', 'targetInode',
        'targetUid', 'targetMode', 'manifest',
    }
    if not isinstance(payload, dict) or set(payload) != required:
        reject('Bootstrap deletion tombstone fields differ from schema')
    if payload['schemaVersion'] != 1 or payload['operation'] != 'bootstrap-generation-delete':
        reject('Bootstrap deletion tombstone schema is invalid')
    if payload['parentDevice'] != parent_status.st_dev or payload['parentInode'] != parent_status.st_ino:
        reject('Bootstrap deletion tombstone parent identity drift')
    target_name = payload['targetName']
    kind = payload['kind']
    owner_token = payload['ownerToken']
    if not isinstance(target_name, str) or not relative_name_is_safe(target_name):
        reject('Bootstrap deletion tombstone target is unsafe')
    if not isinstance(owner_token, str) or not token_pattern.fullmatch(owner_token):
        reject('Bootstrap deletion tombstone owner is invalid')
    validate_target_name(target_name, kind)
    expected_tombstone, _ = tombstone_names(target_name)
    if tombstone_name != expected_tombstone:
        reject('Bootstrap deletion tombstone name does not match target')
    for field in ('targetDevice', 'targetInode', 'targetUid', 'targetMode'):
        if not isinstance(payload[field], int) or isinstance(payload[field], bool) or payload[field] < 0:
            reject('Bootstrap deletion tombstone target identity is invalid')
    manifest = validate_manifest(payload['manifest'])
    identity = (
        opened.st_dev,
        opened.st_ino,
        opened.st_uid,
        stat.S_IMODE(opened.st_mode),
        opened.st_nlink,
        opened_mount_id,
    )
    return payload, manifest, identity


def compare_record(actual, expected):
    if actual != expected:
        reject('Bootstrap deletion remaining entry differs from tombstone')


def validate_partial_target(target_fd, manifest, root_device, root_mount_id):
    current = scan_tree(target_fd, '', root_device, root_mount_id)
    for record in current:
        expected = manifest.get(record['path'])
        if expected is None:
            reject('Bootstrap deletion found an entry absent from tombstone')
        compare_record(record, expected)


def revalidate_record_identity(parent_fd, name, record, root_mount_id, label):
    descriptor, current, current_mount_id = open_identity(parent_fd, name)
    expected_type = stat.S_ISDIR if record['type'] == 'directory' else stat.S_ISREG
    actual_identity = (
        current.st_dev,
        current.st_ino,
        current.st_uid,
        stat.S_IMODE(current.st_mode),
        current_mount_id,
    )
    expected_identity = (
        record['device'], record['inode'], record['uid'], record['mode'], root_mount_id,
    )
    if not expected_type(current.st_mode) or actual_identity != expected_identity:
        os.close(descriptor)
        reject(f'{label} identity or mount changed before removal')
    if record['type'] == 'file' and current.st_nlink != record['links']:
        os.close(descriptor)
        reject(f'{label} link count changed before removal')
    return descriptor


def remove_entry(parent_fd, name, relative_path, manifest, root_device, root_mount_id):
    try:
        actual = status_record(parent_fd, name, relative_path, root_device, root_mount_id)
    except FileNotFoundError:
        return
    expected = manifest.get(relative_path)
    if expected is None:
        reject('Bootstrap deletion found an unexpected entry')
    compare_record(actual, expected)
    if actual['type'] == 'directory':
        child_fd = os.open(name, directory_flags, dir_fd=parent_fd)
        try:
            opened = os.fstat(child_fd)
            if (opened.st_dev, opened.st_ino) != (actual['device'], actual['inode']):
                reject('Bootstrap deletion directory changed before removal')
            ensure_mount_identity(
                child_fd, root_mount_id, 'Bootstrap deletion recursive directory',
            )
            for child_name in sorted(os.listdir(child_fd)):
                child_path = f'{relative_path}/{child_name}'
                remove_entry(
                    child_fd, child_name, child_path, manifest, root_device, root_mount_id,
                )
            os.fsync(child_fd)
        finally:
            os.close(child_fd)
        identity_fd = revalidate_record_identity(
            parent_fd, name, actual, root_mount_id, 'Bootstrap deletion directory',
        )
        try:
            ensure_mount_identity(parent_fd, root_mount_id, 'Bootstrap deletion parent')
            os.rmdir(name, dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            os.close(identity_fd)
        durable_boundary(f'delete-rmdir-{relative_path}')
        return
    latest = status_record(parent_fd, name, relative_path, root_device, root_mount_id)
    compare_record(latest, expected)
    identity_fd = revalidate_record_identity(
        parent_fd, name, latest, root_mount_id, 'Bootstrap deletion file',
    )
    try:
        ensure_mount_identity(parent_fd, root_mount_id, 'Bootstrap deletion parent')
        os.unlink(name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(identity_fd)
    durable_boundary(f'delete-unlink-{relative_path}')


def resume_tombstone(
    parent_fd, parent_status, parent_mount_id, tombstone_name,
    expected_kind='', expected_token='',
):
    payload, manifest, tombstone_identity = read_tombstone(
        parent_fd, parent_status, parent_mount_id, tombstone_name,
    )
    if expected_kind and payload['kind'] != expected_kind:
        reject('Bootstrap deletion tombstone kind CAS rejected')
    if expected_token and payload['ownerToken'] != expected_token:
        reject('Bootstrap deletion tombstone owner CAS rejected')
    target_name = payload['targetName']
    try:
        target_status = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        target_status = None
    if target_status is not None:
        expected_identity = (
            payload['targetDevice'], payload['targetInode'], payload['targetUid'], payload['targetMode'],
        )
        actual_identity = (
            target_status.st_dev, target_status.st_ino, target_status.st_uid, stat.S_IMODE(target_status.st_mode),
        )
        if not stat.S_ISDIR(target_status.st_mode) or actual_identity != expected_identity or target_status.st_dev != parent_status.st_dev:
            reject('Bootstrap deletion target identity differs from tombstone')
        target_fd = os.open(target_name, directory_flags, dir_fd=parent_fd)
        try:
            opened = os.fstat(target_fd)
            if (opened.st_dev, opened.st_ino) != (target_status.st_dev, target_status.st_ino):
                reject('Bootstrap deletion target changed while resuming')
            ensure_mount_identity(target_fd, parent_mount_id, 'Bootstrap deletion target')
            validate_partial_target(
                target_fd, manifest, parent_status.st_dev, parent_mount_id,
            )
            if payload['kind'] == 'artifact-repair':
                remove_entry(
                    target_fd, 'work', 'work', manifest,
                    parent_status.st_dev, parent_mount_id,
                )
            for control in ('run.json', 'owner', 'phase'):
                remove_entry(
                    target_fd, control, control, manifest,
                    parent_status.st_dev, parent_mount_id,
                )
            if os.listdir(target_fd):
                reject('Bootstrap deletion target retained unexpected entries')
            os.fsync(target_fd)
        finally:
            os.close(target_fd)
        target_record = {
            'type': 'directory',
            'device': payload['targetDevice'],
            'inode': payload['targetInode'],
            'uid': payload['targetUid'],
            'mode': payload['targetMode'],
        }
        identity_fd = revalidate_record_identity(
            parent_fd, target_name, target_record,
            parent_mount_id, 'Bootstrap deletion target',
        )
        try:
            ensure_mount_identity(parent_fd, parent_mount_id, 'Bootstrap deletion parent')
            os.rmdir(target_name, dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            os.close(identity_fd)
        durable_boundary('delete-rmdir-generation')
    tombstone_fd, tombstone_status, tombstone_mount_id = open_identity(parent_fd, tombstone_name)
    try:
        current_tombstone_identity = (
            tombstone_status.st_dev,
            tombstone_status.st_ino,
            tombstone_status.st_uid,
            stat.S_IMODE(tombstone_status.st_mode),
            tombstone_status.st_nlink,
            tombstone_mount_id,
        )
        if not stat.S_ISREG(tombstone_status.st_mode) or current_tombstone_identity != tombstone_identity:
            reject('Bootstrap deletion tombstone changed before unlink')
        ensure_mount_identity(parent_fd, parent_mount_id, 'Bootstrap deletion parent')
        os.unlink(tombstone_name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(tombstone_fd)
    durable_boundary('delete-unlink-tombstone')


parent_fd, parent_status, parent_mount_id = validate_parent(parent)
try:
    if action == 'resume':
        tombstones = sorted(name for name in os.listdir(parent_fd) if name.startswith(tombstone_prefix))
        for tombstone_name in tombstones:
            if not re.fullmatch(r'\.bootstrap-delete-v1\.[0-9a-f]{64}', tombstone_name):
                reject('Unknown bootstrap deletion tombstone')
            resume_tombstone(parent_fd, parent_status, parent_mount_id, tombstone_name)
    elif action == 'delete':
        if not token_pattern.fullmatch(requested_token):
            reject('Bootstrap deletion owner token is invalid')
        if not os.path.isabs(directory) or os.path.normpath(directory) != directory or os.path.dirname(directory) != parent:
            reject('Bootstrap deletion target path is not anchored')
        target_name = os.path.basename(directory)
        validate_target_name(target_name, requested_kind)
        tombstone_name, _ = tombstone_names(target_name)
        try:
            os.stat(tombstone_name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            target_fd, target_status, manifest = validate_fresh_target(
                parent_fd, parent_status, parent_mount_id,
                target_name, requested_kind, requested_token,
            )
            try:
                tombstone_name, _ = write_tombstone(
                    parent_fd, parent_status, parent_mount_id, target_name, requested_kind,
                    requested_token, target_status, manifest,
                )
            finally:
                os.close(target_fd)
        resume_tombstone(
            parent_fd, parent_status, parent_mount_id, tombstone_name,
            requested_kind, requested_token,
        )
    else:
        reject('Unknown bootstrap deletion action')
finally:
    os.close(parent_fd)
PY
}

bootstrap_resume_generation_deletions() {
  local parent="$1"
  [ -d "$parent" ] && [ ! -L "$parent" ] || return 0
  bootstrap_generation_delete_helper resume "$parent"
}

bootstrap_delete_fence_generation() {
  local directory="$1"
  local kind="$2"
  local expected_token="$3"
  bootstrap_generation_delete_helper delete "$(dirname "$directory")" "$directory" "$kind" "$expected_token"
}

bootstrap_delete_artifact_generation() {
  local directory="$1"
  local expected_token="$2"
  bootstrap_generation_delete_helper delete "$(dirname "$directory")" "$directory" artifact-repair "$expected_token"
}

bootstrap_set_stale_artifact_repair_phase() {
  local directory="$1"
  local expected_owner="$2"
  local phase="$3"
  (
    BOOTSTRAP_OWNER_TOKEN="$expected_owner"
    bootstrap_set_generation_phase "$directory" artifact-repair "$phase"
  )
}

bootstrap_validate_stale_artifact_repair_step() {
  local path="$1"
  local expected_owner="$2"
  local expected_run_token="$3"
  local expected_phase="$4"
  local state relative
  bootstrap_validate_generation "$path" artifact-repair "$expected_owner" || return 1
  [ "$BOOTSTRAP_VALIDATED_OWNER" = "$expected_owner" ] || return 1
  [ "$BOOTSTRAP_VALIDATED_RUN_TOKEN" = "$expected_run_token" ] || return 1
  [ "$BOOTSTRAP_VALIDATED_PHASE" = "$expected_phase" ] || return 1
  state="$(bootstrap_generation_owner_state)" || return 1
  [ "$state" = stale ] || {
    printf '%s\n' "Artifact repair generation owner changed during recovery: $path" >&2
    return 1
  }
  relative="${path##*/}/work"
  bootstrap_validate_anchored_path "$JOURNAL_ROOT" "$relative" 0700 0 || {
    printf '%s\n' "Artifact repair work tree is unsafe during recovery: $path/work" >&2
    return 1
  }
}

bootstrap_complete_stale_artifact_repair() {
  local path="$1"
  local expected_owner="$2"
  local expected_run_token="$3"
  local phase="$4"
  while true; do
    bootstrap_validate_stale_artifact_repair_step \
      "$path" "$expected_owner" "$expected_run_token" "$phase" || return 1
    case "$phase" in
      repair-created)
        stop_current_release || return 1
        PROCESS_STOPPED=1
        bootstrap_test_sigkill repair-recovery-stop-complete
        bootstrap_set_stale_artifact_repair_phase "$path" "$expected_owner" repair-stopped || return 1
        phase=repair-stopped
        ;;
      repair-stopped)
        BACKUP_DIR="$path/work" install_apparmor_profile || return 1
        bootstrap_set_stale_artifact_repair_phase "$path" "$expected_owner" repair-apparmor || return 1
        phase=repair-apparmor
        ;;
      repair-apparmor)
        BACKUP_DIR="$path/work" install_loopback_firewall || return 1
        bootstrap_set_stale_artifact_repair_phase "$path" "$expected_owner" repair-firewall || return 1
        phase=repair-firewall
        ;;
      repair-firewall)
        restart_current_release || return 1
        PROCESS_STOPPED=0
        bootstrap_set_stale_artifact_repair_phase "$path" "$expected_owner" repair-restarted || return 1
        phase=repair-restarted
        ;;
      repair-restarted)
        validate_loopback_firewall || return 1
        validate_current_release_health || return 1
        bootstrap_set_stale_artifact_repair_phase "$path" "$expected_owner" repair-validated || return 1
        bootstrap_validate_stale_artifact_repair_step \
          "$path" "$expected_owner" "$expected_run_token" repair-validated
        return $?
        ;;
      repair-validated)
        validate_loopback_firewall || return 1
        validate_current_release_health || return 1
        return 0
        ;;
      *) return 1 ;;
    esac
  done
}

bootstrap_recover_stale_artifact_repairs() {
  local path name expected_token state retired
  local -a paths=() owners=() run_tokens=() phases=() released=()
  local index
  [ -d "$JOURNAL_ROOT" ] || return 0
  [ ! -L "$JOURNAL_ROOT" ] || return 1
  bootstrap_resume_generation_deletions "$JOURNAL_ROOT" || return 1
  shopt -s nullglob
  for path in "$JOURNAL_ROOT"/artifact-repair-*; do
    paths+=("$path")
  done
  shopt -u nullglob
  [ "${#paths[@]}" -gt 0 ] || return 0
  for path in "${paths[@]}"; do
    name="${path##*/}"
    if [[ "$name" =~ ^artifact-repair-([0-9a-f]{32})$ ]]; then
      expected_token="${BASH_REMATCH[1]}"
      released+=(0)
    elif [[ "$name" =~ ^artifact-repair-([0-9a-f]{32})\.released\.([0-9a-f]{32})$ ]]; then
      expected_token="${BASH_REMATCH[1]}"
      released+=(1)
    else
      printf '%s\n' "Unknown artifact repair generation: $path" >&2
      return 1
    fi
    bootstrap_validate_generation "$path" artifact-repair "$expected_token" || {
      printf '%s\n' "Malformed or foreign artifact repair generation: $path" >&2
      return 1
    }
    state="$(bootstrap_generation_owner_state)" || return 1
    case "$state" in
      stale) ;;
      live)
        printf '%s\n' "Artifact repair generation still has a live owner: $path" >&2
        return 1
        ;;
      foreign)
        printf '%s\n' "Artifact repair generation PID belongs to a foreign process: $path" >&2
        return 1
        ;;
      *) return 1 ;;
    esac
    if [ "${released[-1]}" = 1 ] && [ "$BOOTSTRAP_VALIDATED_PHASE" != repair-validated ]; then
      printf '%s\n' "Released artifact repair generation is not validated: $path" >&2
      return 1
    fi
    owners+=("$BOOTSTRAP_VALIDATED_OWNER")
    run_tokens+=("$BOOTSTRAP_VALIDATED_RUN_TOKEN")
    phases+=("$BOOTSTRAP_VALIDATED_PHASE")
  done
  for ((index = 0; index < ${#paths[@]}; index++)); do
    path="${paths[$index]}"
    bootstrap_complete_stale_artifact_repair \
      "$path" "${owners[$index]}" "${run_tokens[$index]}" "${phases[$index]}" || return 1
    bootstrap_validate_generation "$path" artifact-repair "${owners[$index]}" || return 1
    [ "$BOOTSTRAP_VALIDATED_RUN_TOKEN" = "${run_tokens[$index]}" ] || return 1
    [ "$BOOTSTRAP_VALIDATED_PHASE" = repair-validated ] || return 1
    if [ "${released[$index]}" = "0" ]; then
      retired="$path.released.$BOOTSTRAP_OWNER_TOKEN"
      [ ! -e "$retired" ] && [ ! -L "$retired" ] || return 1
      [ "$(cat "$path/owner")" = "${owners[$index]}" ] || return 1
      mv "$path" "$retired" || return 1
      sync_directory "$JOURNAL_ROOT" || return 1
      path="$retired"
      bootstrap_test_sigkill repair-recovery-quarantined
    fi
    bootstrap_delete_artifact_generation "$path" "${owners[$index]}" || return 1
    sync_directory "$JOURNAL_ROOT" || return 1
  done
}

bootstrap_recover_stale_artifacts_before_reservation() {
  local path name evidence_present=0 control_evidence_present=0
  local -a build_paths=() control_paths=()
  shopt -s nullglob
  for path in \
    "$LIFECYCLE_DIR" "$WRITER_DIR" \
    "$LIFECYCLE_DIR".next.* "$WRITER_DIR".next.* \
    "$LIFECYCLE_DIR".released.* "$WRITER_DIR".released.* \
    "$REMOTE_ROOT"/.deploy-v030.bootstrap-build.* \
    "$REMOTE_ROOT"/.deploy-v030.bootstrap-quarantine.* \
    "$REMOTE_ROOT"/.bootstrap-phase-next*; do
    if path_entry_present_no_follow "$path"; then
      control_paths+=("$path")
      control_evidence_present=1
    fi
  done
  shopt -u nullglob
  if ! path_entry_present_no_follow "$JOURNAL_ROOT"; then
    if [ "$control_evidence_present" = 1 ]; then
      printf '%s\n' "Bootstrap journal root is missing during control generation recovery" >&2
      return 1
    fi
    return 0
  fi
  real_directory_no_follow "$JOURNAL_ROOT" || {
    printf '%s\n' "Bootstrap journal root is unsafe before artifact recovery" >&2
    return 1
  }
  shopt -s nullglob
  for path in "$JOURNAL_ROOT"/.artifact-repair-build-*; do
    build_paths+=("$path")
  done
  shopt -u nullglob
  for path in "${build_paths[@]}"; do
    name="${path##*/}"
    if [[ "$name" =~ ^\.artifact-repair-build-[0-9a-f]{32}$ ]]; then
      printf '%s\n' "Unresolved artifact repair build evidence requires offline root maintenance: $path" >&2
    else
      printf '%s\n' "Unknown artifact repair build evidence requires offline root maintenance: $path" >&2
    fi
    return 1
  done
  shopt -s nullglob
  for path in "$JOURNAL_ROOT"/artifact-repair-* "$JOURNAL_ROOT"/.bootstrap-delete-v1.*; do
    evidence_present=1
    break
  done
  shopt -u nullglob
  if [ "$evidence_present" != 1 ] && [ "$control_evidence_present" != 1 ]; then
    return 0
  fi

  bootstrap_prepare_journal_run_identity || return 1
  bootstrap_prepare_control_plane || return 1
  validate_sanitizer_gate_idle_state || return 1
  bootstrap_recover_stale_control_state
}

external_layout_marker_payload() {
  printf '%s\n' \
    'turingmarket-external-layout-v1' \
    'runtime-owner=platform/deploy_v8.ps1' \
    'bootstrap-mode=setup-only'
}

validate_external_layout_marker_proof_value() {
  [[ "${1:-}" =~ ^m2:[0-9a-f]{64}:[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{64}$ ]]
}

external_layout_marker_proof_matches() {
  local expected="$1" observed="$2" legacy_device legacy_inode legacy_digest
  [ "$expected" = "$observed" ] && return 0
  if [[ "$expected" =~ ^m1:([1-9][0-9]*):([1-9][0-9]*):[1-9][0-9]*:([0-9a-f]{64})$ ]]; then
    legacy_device="${BASH_REMATCH[1]}"
    legacy_inode="${BASH_REMATCH[2]}"
    legacy_digest="${BASH_REMATCH[3]}"
    if [[ "$observed" =~ ^m2:[0-9a-f]{64}:([1-9][0-9]*):([1-9][0-9]*):([0-9a-f]{64})$ ]]; then
      [ "$legacy_device" = "${BASH_REMATCH[1]}" ] && \
        [ "$legacy_inode" = "${BASH_REMATCH[2]}" ] && \
        [ "$legacy_digest" = "${BASH_REMATCH[3]}" ]
      return $?
    fi
  fi
  return 1
}

validate_external_layout_marker() {
  local result
  local -a values
  if [ -z "$EXTERNAL_LAYOUT_ROOT_TOKEN" ]; then
    bind_external_layout_root || return 1
  fi
  result="$(bootstrap_external_layout_marker_helper validate "$EXTERNAL_LAYOUT_ROOT_TOKEN")" || return 1
  mapfile -t values <<< "$result"
  [ "${#values[@]}" = 2 ] && [ "${values[0]}" = valid ] || return 1
  validate_external_layout_marker_proof_value "${values[1]}" || return 1
  EXTERNAL_LAYOUT_MARKER_PROOF="${values[1]}"
}

commit_external_layout_marker() {
  local result
  local -a values
  validate_bootstrap_token "$BOOTSTRAP_OWNER_TOKEN" || {
    die "Bootstrap owner token is invalid"
    return 1
  }
  if [ -z "$EXTERNAL_LAYOUT_ROOT_TOKEN" ]; then
    bind_external_layout_root || return 1
  fi
  result="$(bootstrap_external_layout_marker_helper publish "$EXTERNAL_LAYOUT_ROOT_TOKEN")" || return 1
  mapfile -t values <<< "$result"
  [ "${#values[@]}" = 2 ] && [ "${values[0]}" = valid ] || return 1
  validate_external_layout_marker_proof_value "${values[1]}" || return 1
  EXTERNAL_LAYOUT_MARKER_PROOF="${values[1]}"
  validate_external_layout_marker
}

bind_external_layout_root() {
  EXTERNAL_LAYOUT_ROOT_TOKEN="$(bootstrap_external_layout_marker_helper bind-root "")" || return 1
  [[ "$EXTERNAL_LAYOUT_ROOT_TOKEN" =~ ^r1:[0-9a-f]{64}$ ]]
}

external_layout_marker_state() {
  local result
  local -a values
  if [ -z "$EXTERNAL_LAYOUT_ROOT_TOKEN" ]; then
    bind_external_layout_root || return 1
  fi
  result="$(bootstrap_external_layout_marker_helper state "$EXTERNAL_LAYOUT_ROOT_TOKEN")" || return 1
  mapfile -t values <<< "$result"
  if [ "${#values[@]}" = 1 ] && [ "${values[0]}" = absent ]; then
    EXTERNAL_LAYOUT_MARKER_PROOF=""
    printf '%s\n' absent
  elif [ "${#values[@]}" = 2 ] && [ "${values[0]}" = valid ] && \
      validate_external_layout_marker_proof_value "${values[1]}"; then
    EXTERNAL_LAYOUT_MARKER_PROOF="${values[1]}"
    printf '%s\n' valid
  else
    return 1
  fi
}

bootstrap_external_layout_marker_helper() {
  local action="$1" expected_root_token="${2:-}" expected_uid expected_gid
  bootstrap_reject_production_test_hooks || return 1
  expected_uid="$(bootstrap_trusted_id -u)" || return 1
  expected_gid="$(bootstrap_trusted_id -g)" || return 1
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    expected_uid=0
    expected_gid=0
  fi
  python3 - "$action" "$REMOTE_ROOT" "$expected_root_token" "$expected_uid" "$expected_gid" \
    "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" <<'PY'
import ctypes
import errno
import hashlib
import os
import re
import signal
import stat
import sys

action, remote_root, expected_token, expected_uid_raw, expected_gid_raw, library_only = sys.argv[1:]
expected_uid = int(expected_uid_raw)
expected_gid = int(expected_gid_raw)
marker_name = '.external-runtime-layout-v1'
stale_pattern = re.compile(r'\.external-runtime-layout-v1\.stage\.[0-9a-f]{32}')
max_stale_stages = 8
payload = (
    b'turingmarket-external-layout-v1\n'
    b'runtime-owner=platform/deploy_v8.ps1\n'
    b'bootstrap-mode=setup-only\n'
)


def reject(message):
    raise SystemExit(message)


if sys.platform != 'linux':
    reject('External layout marker publication requires Linux')
for required in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_CLOEXEC', 'O_TMPFILE'):
    if not hasattr(os, required):
        reject(f'External layout marker publication requires {required}')

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
read_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
libc = ctypes.CDLL(None, use_errno=True)
linkat = getattr(libc, 'linkat', None)
AT_EMPTY_PATH = 0x1000
if linkat is None:
    reject('External layout marker publication requires linkat')
linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
linkat.restype = ctypes.c_int


def mount_id(descriptor):
    try:
        with open(f'/proc/self/fdinfo/{descriptor}', encoding='ascii') as handle:
            values = [
                match.group(1)
                for line in handle.read().splitlines()
                if (match := re.fullmatch(r'mnt_id:\s*([1-9][0-9]*)', line))
            ]
    except OSError:
        reject('External layout marker mount identity is unavailable')
    if len(values) != 1:
        reject('External layout marker mount identity is ambiguous')
    value = int(values[0])
    if library_only == '1':
        offset_raw = os.environ.get('TM_BOOTSTRAP_TEST_MOUNT_ID_OFFSET', '0')
        if not re.fullmatch(r'[0-9]+', offset_raw):
            reject('External layout marker test mount offset is invalid')
        value += int(offset_raw)
    if value <= 0:
        reject('External layout marker mount identity is invalid')
    return value


def read_boot_id():
    if library_only == '1' and os.environ.get('TM_BOOTSTRAP_TEST_BOOT_ID'):
        value = os.environ['TM_BOOTSTRAP_TEST_BOOT_ID'].strip().lower()
    else:
        try:
            with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as handle:
                value = handle.read().strip().lower()
        except OSError:
            reject('External layout marker boot identity is unavailable')
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value):
        reject('External layout marker boot identity is invalid')
    return value


def identity(status):
    return status.st_dev, status.st_ino


def open_trusted_root(path):
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        reject('External layout root is not canonical')
    components = [component for component in path.split('/') if component]
    descriptor = os.open('/', directory_flags)
    chain = []
    try:
        root_status = os.fstat(descriptor)
        chain.append((root_status.st_dev, root_status.st_ino, mount_id(descriptor)))
        for component in components:
            before = os.stat(component, dir_fd=descriptor, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
                reject('External layout root traversal encountered a non-directory')
            child = os.open(component, directory_flags, dir_fd=descriptor)
            opened = os.fstat(child)
            if identity(before) != identity(opened):
                os.close(child)
                reject('External layout root changed during traversal')
            if library_only != '1' and (
                opened.st_uid != 0
                or opened.st_gid != 0
                or stat.S_IMODE(opened.st_mode) & 0o022
            ):
                os.close(child)
                reject('External layout root traversal ownership or mode drift')
            os.close(descriptor)
            descriptor = child
            chain.append((opened.st_dev, opened.st_ino, mount_id(descriptor)))
        opened = os.fstat(descriptor)
        if opened.st_uid != expected_uid or opened.st_gid != expected_gid:
            reject('External layout root ownership drift')
        encoded = path + '|' + '|'.join(f'{dev}.{ino}' for dev, ino, _mnt in chain)
        token = 'r1:' + hashlib.sha256(encoded.encode('ascii')).hexdigest()
        if expected_token and token != expected_token:
            reject('External layout root identity changed')
        bind_current_boot_mount_guard(
            descriptor, opened, mount_id(descriptor), token, chain,
        )
        return descriptor, opened, mount_id(descriptor), token
    except BaseException:
        os.close(descriptor)
        raise


def status_at(parent_fd, name):
    return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)


def present(parent_fd, name):
    try:
        status_at(parent_fd, name)
        return True
    except FileNotFoundError:
        return False


def read_exact(descriptor):
    os.lseek(descriptor, 0, os.SEEK_SET)
    chunks = []
    total = 0
    while True:
        chunk = os.read(descriptor, 4097 - total)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > 4096:
            reject('External layout marker is too large')
    return b''.join(chunks)


def validate_named_file(
    root_fd, root_status, root_mount_id, name, expected_payload=None, root_token=None,
):
    path_status = status_at(root_fd, name)
    if (
        not stat.S_ISREG(path_status.st_mode)
        or stat.S_ISLNK(path_status.st_mode)
        or path_status.st_dev != root_status.st_dev
        or path_status.st_uid != expected_uid
        or path_status.st_gid != expected_gid
        or stat.S_IMODE(path_status.st_mode) != 0o600
        or path_status.st_nlink != 1
    ):
        reject(f'External layout marker entry is unsafe: {name}')
    descriptor = os.open(name, read_flags, dir_fd=root_fd)
    try:
        opened = os.fstat(descriptor)
        if identity(opened) != identity(path_status) or mount_id(descriptor) != root_mount_id:
            reject(f'External layout marker entry changed while opening: {name}')
        observed = read_exact(descriptor)
        current = status_at(root_fd, name)
        if identity(current) != identity(opened):
            reject(f'External layout marker entry changed while reading: {name}')
        if expected_payload is not None and observed != expected_payload:
            reject('External layout marker payload is invalid')
        if root_token is None or not re.fullmatch(r'r1:[0-9a-f]{64}', root_token):
            reject('External layout durable root token is missing')
        proof = (
            f'm2:{root_token[3:]}:{opened.st_dev}:{opened.st_ino}:'
            f'{hashlib.sha256(observed).hexdigest()}'
        )
        return identity(opened), proof
    finally:
        os.close(descriptor)


def publish_exact_file(root_fd, root_status, root_mount_id, name, exact_payload, root_token):
    descriptor = os.open(
        '.', os.O_RDWR | os.O_TMPFILE | os.O_CLOEXEC, 0o600, dir_fd=root_fd,
    )
    try:
        opened = os.fstat(descriptor)
        if opened.st_dev != root_status.st_dev or mount_id(descriptor) != root_mount_id:
            reject('External layout exact publication mount drift')
        offset = 0
        while offset < len(exact_payload):
            written = os.write(descriptor, exact_payload[offset:])
            if written <= 0:
                raise OSError(errno.EIO, 'External layout exact publication made no progress')
            offset += written
        os.fchmod(descriptor, 0o600)
        if library_only != '1':
            os.fchown(descriptor, expected_uid, expected_gid)
        os.fsync(descriptor)
        result = linkat(descriptor, b'', root_fd, os.fsencode(name), AT_EMPTY_PATH)
        if result != 0 and ctypes.get_errno() != errno.EEXIST:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number), name)
        os.fsync(root_fd)
        observed_identity, _observed_proof = validate_named_file(
            root_fd, root_status, root_mount_id, name, exact_payload, root_token,
        )
        if result == 0 and observed_identity != identity(opened):
            reject('External layout exact publication identity changed')
        return observed_identity
    finally:
        os.close(descriptor)


def bind_current_boot_mount_guard(root_fd, root_status, root_mount_id, root_token, chain):
    boot_id = read_boot_id()
    guard_name = f'.external-runtime-root-mount-guard-v1.{boot_id}'
    guard_payload = (
        'external-runtime-root-mount-guard-v1\n'
        f'boot-id={boot_id}\n'
        f'root-token={root_token}\n'
        f'mount-chain={".".join(str(mount) for _dev, _ino, mount in chain)}\n'
    ).encode('ascii')
    if present(root_fd, guard_name):
        validate_named_file(
            root_fd, root_status, root_mount_id, guard_name, guard_payload, root_token,
        )
    else:
        publish_exact_file(
            root_fd, root_status, root_mount_id, guard_name, guard_payload, root_token,
        )


def inspect_stale_stages(root_fd, root_status, root_mount_id):
    stages = sorted(name for name in os.listdir(root_fd) if stale_pattern.fullmatch(name))
    if len(stages) > max_stale_stages:
        reject('External layout marker stale-stage capacity reached; offline root maintenance is required')
    for name in stages:
        validate_named_file(root_fd, root_status, root_mount_id, name, root_token=root_token)


def boundary(point):
    if library_only != '1':
        return
    if os.environ.get('TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_IOERROR_AT') == point:
        raise OSError(errno.EIO, f'simulated external marker I/O failure at {point}')
    if os.environ.get('TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_SIGKILL_AT') == point:
        os.kill(os.getppid(), signal.SIGKILL)
        os.kill(os.getpid(), signal.SIGKILL)


def inject_external_marker_replacement(root_fd, root_mount_id, point):
    if (
        library_only != '1'
        or os.environ.get('TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_REPLACE_AT') != point
    ):
        return
    descriptor = os.open(
        marker_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
        dir_fd=root_fd,
    )
    try:
        if mount_id(descriptor) != root_mount_id:
            reject('External layout marker replacement mount drift')
        os.write(descriptor, b'foreign-marker-must-survive\n')
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.fsync(root_fd)


root_fd, root_status, root_mount_id, root_token = open_trusted_root(remote_root)
try:
    if action == 'bind-root':
        if expected_token:
            reject('External layout root bind arguments are invalid')
        print(root_token)
        raise SystemExit(0)
    if not expected_token:
        reject('External layout root token is required')
    inspect_stale_stages(root_fd, root_status, root_mount_id)
    if action == 'state':
        if not present(root_fd, marker_name):
            print('absent')
        else:
            _marker_identity, marker_proof = validate_named_file(
                root_fd, root_status, root_mount_id, marker_name, payload, root_token,
            )
            print('valid')
            print(marker_proof)
        raise SystemExit(0)
    if action == 'validate':
        _marker_identity, marker_proof = validate_named_file(
            root_fd, root_status, root_mount_id, marker_name, payload, root_token,
        )
        print('valid')
        print(marker_proof)
        raise SystemExit(0)
    if action != 'publish':
        reject('Unknown external layout marker action')
    if present(root_fd, marker_name):
        _marker_identity, marker_proof = validate_named_file(
            root_fd, root_status, root_mount_id, marker_name, payload, root_token,
        )
        print('valid')
        print(marker_proof)
        raise SystemExit(0)
    descriptor = os.open(
        '.', os.O_RDWR | os.O_TMPFILE | os.O_CLOEXEC, 0o600, dir_fd=root_fd,
    )
    try:
        opened = os.fstat(descriptor)
        if opened.st_dev != root_status.st_dev or mount_id(descriptor) != root_mount_id:
            reject('External layout marker anonymous stage mount drift')
        boundary('external-marker-opened')
        split = max(1, len(payload) // 2)
        offset = 0
        while offset < split:
            written = os.write(descriptor, payload[offset:split])
            if written <= 0:
                raise OSError(errno.EIO, 'External layout marker write made no progress')
            offset += written
        boundary('external-marker-partial')
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise OSError(errno.EIO, 'External layout marker write made no progress')
            offset += written
        os.fchmod(descriptor, 0o600)
        if library_only != '1':
            os.fchown(descriptor, expected_uid, expected_gid)
        os.fsync(descriptor)
        boundary('external-marker-file-fsync')
        boundary('external-marker-before-publish')
        inject_external_marker_replacement(
            root_fd, root_mount_id, 'external-marker-before-publish',
        )
        result = linkat(descriptor, b'', root_fd, os.fsencode(marker_name), AT_EMPTY_PATH)
        if result != 0:
            error_number = ctypes.get_errno()
            if error_number == errno.EEXIST:
                _marker_identity, marker_proof = validate_named_file(
                    root_fd, root_status, root_mount_id, marker_name, payload, root_token,
                )
                print('valid')
                print(marker_proof)
                raise SystemExit(0)
            raise OSError(error_number, os.strerror(error_number), marker_name)
        boundary('external-marker-published')
        os.fsync(root_fd)
        boundary('external-marker-publish-dir-fsync')
        final_identity, marker_proof = validate_named_file(
            root_fd, root_status, root_mount_id, marker_name, payload, root_token,
        )
        if final_identity != identity(opened):
            reject('External layout marker publication identity changed')
    finally:
        os.close(descriptor)
    print('valid')
    print(marker_proof)
finally:
    os.close(root_fd)
PY
}

validate_sanitizer_gate_root() {
  local root="$1" required_mode="$2" expected observed
  if [ ! -e "$root" ] && [ ! -L "$root" ]; then
    return 0
  fi
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    expected="$(bootstrap_trusted_id -u):$(bootstrap_trusted_id -g)" || return 1
  else
    expected="0:0"
  fi
  [ -d "$root" ] && [ ! -L "$root" ] || {
    printf '%s\n' "Sanitizer gate root is unsafe: $root" >&2
    return 1
  }
  [ "$(bootstrap_trusted_realpath -e "$root")" = "$root" ] || {
    printf '%s\n' "Sanitizer gate root is not canonical: $root" >&2
    return 1
  }
  observed="$(bootstrap_trusted_stat -c '%u:%g:%a' "$root")" || return 1
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    [ "$observed" = "$expected:$required_mode" ] || [ "$observed" = "$expected:700" ] \
      || [ "$observed" = "$expected:755" ] || {
      printf '%s\n' "Sanitizer gate root ownership or mode drift: $root" >&2
      return 1
    }
  elif [ "$observed" != "$expected:$required_mode" ]; then
    printf '%s\n' "Sanitizer gate root ownership or mode drift: $root" >&2
    return 1
  fi
  if command -v mountpoint >/dev/null 2>&1 && mountpoint -q -- "$root"; then
    printf '%s\n' "Sanitizer gate root is unexpectedly mounted: $root" >&2
    return 1
  fi
}

validate_sanitizer_gate_idle_state() {
  local entry name expected_file users processes mounts target source
  bootstrap_reject_production_test_hooks || return 1
  validate_sanitizer_gate_root "$SANITIZER_JOURNAL_ROOT" 700 || return 1
  validate_sanitizer_gate_root "$SANITIZER_RUN_ROOT" 711 || return 1

  if [ -d "$SANITIZER_JOURNAL_ROOT" ]; then
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      name="${entry##*/}"
      [[ "$name" =~ ^[0-9a-f]{32}\.run\.json(\.tmp-[1-9][0-9]*(-[0-9a-f]{16})?)?$ ]] || {
        printf '%s\n' "Unknown sanitizer journal artifact: $entry" >&2
        return 1
      }
      [ -f "$entry" ] && [ ! -L "$entry" ] || {
        printf '%s\n' "Unsafe sanitizer journal artifact: $entry" >&2
        return 1
      }
      if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
        expected_file="$(bootstrap_trusted_id -u):$(bootstrap_trusted_id -g):600:1" || return 1
      else
        expected_file="0:0:600:1"
      fi
      [ "$(bootstrap_trusted_stat -c '%u:%g:%a:%h' "$entry")" = "$expected_file" ] || {
        printf '%s\n' "Sanitizer journal identity drift: $entry" >&2
        return 1
      }
      printf '%s\n' "Sanitizer journal is active or unresolved: $entry" >&2
      return 1
    done < <(find "$SANITIZER_JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -xdev -print | LC_ALL=C sort)
  fi

  if [ -d "$SANITIZER_RUN_ROOT" ]; then
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      name="${entry##*/}"
      [[ "$name" =~ ^[0-9a-f]{32}$ ]] || {
        printf '%s\n' "Unknown sanitizer run resource: $entry" >&2
        return 1
      }
      [ -d "$entry" ] && [ ! -L "$entry" ] || {
        printf '%s\n' "Unsafe sanitizer run resource: $entry" >&2
        return 1
      }
      printf '%s\n' "Sanitizer run resource is active or unresolved: $entry" >&2
      return 1
    done < <(find "$SANITIZER_RUN_ROOT" -mindepth 1 -maxdepth 1 -xdev -print | LC_ALL=C sort)
  fi

  if bootstrap_test_hooks_enabled && [ "${TM_TEST_SANITIZER_USERS+x}" = "x" ]; then
    users="$TM_TEST_SANITIZER_USERS"
  elif [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    users=""
  else
    users="$(getent passwd | awk -F: '$1 ~ /^tm-gate-[0-9a-f]{12}$/ {print $1 ":" $3 ":" $4}')" || return 1
  fi
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    [[ "$entry" =~ ^tm-gate-[0-9a-f]{12}:[1-9][0-9]*:[1-9][0-9]*$ ]] || {
      printf '%s\n' "Malformed sanitizer ephemeral identity: $entry" >&2
      return 1
    }
    printf '%s\n' "Sanitizer ephemeral identity is active or unresolved: $entry" >&2
    return 1
  done <<< "$users"

  if bootstrap_test_hooks_enabled && [ "${TM_TEST_SANITIZER_PROCESSES+x}" = "x" ]; then
    processes="$TM_TEST_SANITIZER_PROCESSES"
  elif [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    processes=""
  else
    processes="$(ps -eo pid=,user=,args= | awk '
      $2 ~ /^tm-gate-[0-9a-f]{12}$/ || ($0 ~ /sanitize_production_shape\.js/ && $0 ~ /--worker/ && $0 ~ /--run-id/) {print}
    ')" || return 1
  fi
  if [ -n "$processes" ]; then
    printf '%s\n' "Sanitizer process is active or unresolved: $processes" >&2
    return 1
  fi

  if bootstrap_test_hooks_enabled && [ "${TM_TEST_SANITIZER_MOUNTS+x}" = "x" ]; then
    mounts="$TM_TEST_SANITIZER_MOUNTS"
  elif [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    mounts=""
  else
    if ! mounts="$(bootstrap_findmnt -rn -o TARGET,SOURCE 2>/dev/null)"; then
      printf '%s\n' "Sanitizer mount verification failed: findmnt returned nonzero" >&2
      return 1
    fi
  fi
  while read -r target source; do
    [ -n "${target:-}" ] || continue
    case "$target" in
      "$SANITIZER_RUN_ROOT"|"$SANITIZER_RUN_ROOT"/*)
        printf '%s\n' "Sanitizer mount is active or unresolved: $target" >&2
        return 1
        ;;
    esac
    case "${source:-}" in
      "$SANITIZER_RUN_ROOT"|"$SANITIZER_RUN_ROOT"/*)
        printf '%s\n' "Sanitizer mount source is active or unresolved: $source" >&2
        return 1
        ;;
    esac
  done <<< "$mounts"
}

validate_candidate_gate_mounts() {
  local conflict mounts
  bootstrap_reject_production_test_hooks || return 1
  if bootstrap_test_hooks_enabled && [ "${TM_TEST_GATE_MOUNTS+x}" = "x" ]; then
    mounts="$TM_TEST_GATE_MOUNTS"
  else
    if ! mounts="$(bootstrap_findmnt -rn -o TARGET 2>/dev/null)"; then
      printf '%s\n' "Candidate mount verification failed: findmnt returned nonzero" >&2
      return 1
    fi
  fi
  while IFS= read -r conflict; do
    [ -n "$conflict" ] || continue
    case "$conflict" in
      "$GATE_ROOT"|"$GATE_ROOT"/*)
        printf '%s\n' "Candidate gate mount is still active: $conflict" >&2
        return 1
        ;;
    esac
  done <<< "$mounts"
}

validate_phase4_idle_state() {
  local journal_policy="${1:-none}" conflict processes step
  case "$journal_policy" in
    none|owned-committed) ;;
    *) return 1 ;;
  esac
  bootstrap_reject_production_test_hooks || return 1
  validate_sanitizer_gate_idle_state || return 1
  if path_entry_present_no_follow "$JOURNAL_DIR" && ! real_directory_no_follow "$JOURNAL_DIR"; then
    printf '%s\n' "Bootstrap migration journal active entry is unsafe" >&2
    return 1
  fi
  for conflict in \
    "$LIFECYCLE_DIR" "$WRITER_DIR" \
    "$LIFECYCLE_DIR".next.* "$LIFECYCLE_DIR".released.* \
    "$WRITER_DIR".next.* "$WRITER_DIR".released.* \
    "$REMOTE_ROOT"/.deploy-v030.bootstrap-build.* \
    "$REMOTE_ROOT"/.bootstrap-phase-next* \
    "$JOURNAL_ROOT"/.bootstrap-phase-next*; do
    if [ -e "$conflict" ] || [ -L "$conflict" ]; then
      printf '%s\n' "Phase 4 deployment fence is active: $conflict" >&2
      return 1
    fi
  done

  for conflict in \
    "$REMOTE_ROOT"/.sanitizer-journal* \
    "$REMOTE_ROOT"/.sanitize-* \
    "$GATE_ROOT"/.sanitizer-journal* \
    "$GATE_ROOT"/.sanitize-* \
    "$GATE_ROOT"/migration-rehearsal*; do
    if [ -e "$conflict" ] || [ -L "$conflict" ]; then
      printf '%s\n' "Unresolved sanitizer or rehearsal state: $conflict" >&2
      return 1
    fi
  done

  for conflict in \
    "$GATE_ROOT"/.bootstrap-stage-* \
    "$GATE_ROOT"/.candidate-stage-* \
    "$GATE_ROOT"/releases/*/tmp/deploy-v*-gate-* \
    "$GATE_ROOT"/releases/*/migration-rehearsal \
    "$JOURNAL_ROOT"/artifact-repair-*; do
    if [ -e "$conflict" ] || [ -L "$conflict" ]; then
      printf '%s\n' "Unresolved candidate gate staging path: $conflict" >&2
      return 1
    fi
  done

  for conflict in \
    "$ENV_DIR"/.turingmarket.env.new.* \
    "$STATE_ROOT"/.db.new.* \
    "$STATE_ROOT"/.uploads.new.* \
    "$STATE_ROOT"/.tmp.new.*; do
    if { [ -e "$conflict" ] || [ -L "$conflict" ]; } && ! real_directory_no_follow "$JOURNAL_DIR"; then
      printf '%s\n' "Unresolved runtime migration staging path: $conflict" >&2
      return 1
    fi
  done

  if [ -d "$BACKUP_ROOT" ]; then
    [ ! -L "$BACKUP_ROOT" ] || { printf '%s\n' "Backup root is unsafe" >&2; return 1; }
    [ "$(bootstrap_trusted_realpath -e "$BACKUP_ROOT")" = "$BACKUP_ROOT" ] || { printf '%s\n' "Backup root is not canonical" >&2; return 1; }
    while IFS= read -r step; do
      [ -f "$step" ] && [ ! -L "$step" ] || {
        printf '%s\n' "Unsafe restore journal: $step" >&2
        return 1
      }
      [ "$(bootstrap_trusted_stat -c '%U:%G:%a:%h' "$step")" = "$(expected_bootstrap_owner):600:1" ] || {
        printf '%s\n' "Restore journal ownership or mode drift: $step" >&2
        return 1
      }
      if [ "$(cat "$step")" != "health-verified" ]; then
        printf '%s\n' "Unresolved restore journal: $step" >&2
        return 1
      fi
    done < <(find "$BACKUP_ROOT" -xdev -type f -name restore-step -print)
  fi

  if bootstrap_test_hooks_enabled && [ "${TM_TEST_GATE_PROCESSES+x}" = "x" ]; then
    processes="$TM_TEST_GATE_PROCESSES"
  elif getent passwd "$GATE_USER" >/dev/null 2>&1; then
    processes="$(pgrep -u "$GATE_USER" 2>/dev/null || true)"
  else
    processes=""
  fi
  if [ -n "$processes" ]; then
    printf '%s\n' "Candidate gate processes are still active: $processes" >&2
    return 1
  fi

  validate_candidate_gate_mounts || return 1

  if [ -e "$EXTERNAL_LAYOUT_MARKER" ] || [ -L "$EXTERNAL_LAYOUT_MARKER" ]; then
    validate_external_layout_marker || {
      printf '%s\n' "External layout marker is unsafe or corrupt" >&2
      return 1
    }
    if path_entry_present_no_follow "$JOURNAL_DIR"; then
      if [ "$journal_policy" != owned-committed ]; then
        printf '%s\n' "External layout marker forbids unresolved bootstrap journal" >&2
        return 1
      fi
      validate_active_migration_journal_directory || return 1
      read_journal || return 1
      if [ "$JOURNAL_TERMINAL_STATE" != live ] || [ "$JOURNAL_PHASE" != committed ] || \
          [ "$JOURNAL_OWNER_TOKEN" != "$BOOTSTRAP_OWNER_TOKEN" ]; then
        printf '%s\n' "Post-marker bootstrap journal is not the owned committed generation" >&2
        return 1
      fi
    fi
  fi
}

bootstrap_publish_directory_noreplace() {
  local source_path="$1"
  local final_path="$2"
  local source_name final_name
  [ "$(dirname -- "$source_path")" = "$REMOTE_ROOT" ] || {
    printf '%s\n' "Bootstrap publication source is outside the remote root" >&2
    return 1
  }
  [ "$(dirname -- "$final_path")" = "$REMOTE_ROOT" ] || {
    printf '%s\n' "Bootstrap publication target is outside the remote root" >&2
    return 1
  }
  source_name="${source_path##*/}"
  final_name="${final_path##*/}"
  [ -n "$source_name" ] && [ -n "$final_name" ] || return 1
  if ! python3 - "$REMOTE_ROOT" "$source_name" "$final_name" <<'PY'
import ctypes
import errno
import os
import stat
import sys

root, source_name, final_name = sys.argv[1:]
if not sys.platform.startswith('linux'):
    raise SystemExit('Bootstrap atomic no-replace publication requires native Linux')
if any(
    not name
    or name in ('.', '..')
    or '/' in name
    or '\0' in name
    or '\n' in name
    or '\r' in name
    or '\t' in name
    for name in (source_name, final_name)
):
    raise SystemExit('Bootstrap publication name is invalid')
if os.path.realpath(root) != os.path.abspath(root):
    raise SystemExit('Bootstrap publication root is not canonical')

open_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
if hasattr(os, 'O_NOFOLLOW'):
    open_flags |= os.O_NOFOLLOW
root_fd = os.open(root, open_flags)
try:
    root_status = os.fstat(root_fd)
    if not stat.S_ISDIR(root_status.st_mode):
        raise SystemExit('Bootstrap publication root is not a directory')
    source_status = os.stat(source_name, dir_fd=root_fd, follow_symlinks=False)
    if not stat.S_ISDIR(source_status.st_mode) or stat.S_ISLNK(source_status.st_mode):
        raise SystemExit('Bootstrap publication source is not a real directory')
    try:
        os.stat(final_name, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise SystemExit('Bootstrap publication target already exists')

    libc = ctypes.CDLL(None, use_errno=True)
    try:
        renameat2 = libc.renameat2
    except AttributeError:
        raise SystemExit('Bootstrap atomic no-replace publication is unsupported')
    renameat2.argtypes = (
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    )
    renameat2.restype = ctypes.c_int
    rename_noreplace = 1
    result = renameat2(
        root_fd,
        os.fsencode(source_name),
        root_fd,
        os.fsencode(final_name),
        rename_noreplace,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        if error_number in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            raise SystemExit('Bootstrap atomic no-replace publication is unsupported')
        raise OSError(error_number, os.strerror(error_number), final_name)
    os.fsync(root_fd)
    final_status = os.stat(final_name, dir_fd=root_fd, follow_symlinks=False)
    if (
        not stat.S_ISDIR(final_status.st_mode)
        or final_status.st_dev != source_status.st_dev
        or final_status.st_ino != source_status.st_ino
    ):
        raise SystemExit('Bootstrap publication identity changed')
    try:
        os.stat(source_name, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise SystemExit('Bootstrap publication source still exists')
finally:
    os.close(root_fd)
PY
  then
    return 1
  fi
}

bootstrap_generation_publication_barrier() {
  return 0
}

bootstrap_publish_generation() {
  local kind="$1"
  local final_path="$2"
  local stage_path build_path
  stage_path="$final_path.next.$BOOTSTRAP_OWNER_TOKEN"
  build_path="$REMOTE_ROOT/.deploy-v030.bootstrap-build.$kind.$BOOTSTRAP_OWNER_TOKEN"
  [ ! -e "$build_path" ] && [ ! -L "$build_path" ] || return 1
  [ ! -e "$stage_path" ] && [ ! -L "$stage_path" ] || return 1
  [ ! -e "$final_path" ] && [ ! -L "$final_path" ] || return 1
  mkdir -m 0700 "$build_path" || return 1
  bootstrap_test_sigkill "$kind-build-created" || return $?
  bootstrap_write_generation "$build_path" "$kind" bootstrap-setup || return 1
  bootstrap_test_sigkill "$kind-build-written" || return $?
  bootstrap_validate_generation "$build_path" "$kind" "$BOOTSTRAP_OWNER_TOKEN" || return 1
  bootstrap_test_sigkill "$kind-build-validated" || return $?
  mv "$build_path" "$stage_path" || return 1
  sync_directory "$REMOTE_ROOT" || return 1
  bootstrap_test_sigkill "$kind-next" || return $?
  bootstrap_validate_generation "$stage_path" "$kind" "$BOOTSTRAP_OWNER_TOKEN" || return 1
  [ ! -e "$final_path" ] && [ ! -L "$final_path" ] || return 1
  bootstrap_generation_publication_barrier || return $?
  bootstrap_publish_directory_noreplace "$stage_path" "$final_path" || return $?
  sync_directory "$REMOTE_ROOT" || return 1
  bootstrap_test_sigkill "$kind-published" || return $?
  bootstrap_validate_generation "$final_path" "$kind" "$BOOTSTRAP_OWNER_TOKEN" || return 1
}

bootstrap_acquire_shared_fences() {
  validate_bootstrap_token "$BOOTSTRAP_OWNER_TOKEN" || {
    die "Bootstrap owner token is invalid"
    return 1
  }
  bootstrap_ensure_process_identity || return 1
  [ ! -e "$LIFECYCLE_DIR" ] && [ ! -L "$LIFECYCLE_DIR" ] || {
    die "Deployment lifecycle fence is active"
    return 1
  }
  [ ! -e "$WRITER_DIR" ] && [ ! -L "$WRITER_DIR" ] || {
    die "Production writer fence is active"
    return 1
  }
  BOOTSTRAP_FENCES_HELD=1
  bootstrap_publish_generation lifecycle "$LIFECYCLE_DIR" || return 1
  bootstrap_publish_generation writer "$WRITER_DIR" || return 1
  validate_owned_bootstrap_fences
}

validate_owned_bootstrap_fences() {
  local lifecycle_run_token
  bootstrap_validate_generation "$LIFECYCLE_DIR" lifecycle "$BOOTSTRAP_OWNER_TOKEN" || return 1
  [ "$BOOTSTRAP_VALIDATED_PHASE" = "bootstrap-setup" ] || return 1
  lifecycle_run_token="$BOOTSTRAP_VALIDATED_RUN_TOKEN"
  bootstrap_validate_generation "$WRITER_DIR" writer "$BOOTSTRAP_OWNER_TOKEN" || return 1
  [ "$BOOTSTRAP_VALIDATED_PHASE" = "bootstrap-setup" ] || return 1
  [ "$BOOTSTRAP_VALIDATED_RUN_TOKEN" = "$lifecycle_run_token" ] || return 1
  [ "$lifecycle_run_token" = "$BOOTSTRAP_RUN_TOKEN" ]
}

bootstrap_recovery_candidate_details() {
  local path="$1"
  local name="${path##*/}"
  BOOTSTRAP_RECOVERY_KIND=""
  BOOTSTRAP_RECOVERY_TOKEN=""
  BOOTSTRAP_RECOVERY_LABEL=""
  case "$name" in
    .deploy-v030.lock)
      BOOTSTRAP_RECOVERY_KIND=lifecycle
      BOOTSTRAP_RECOVERY_LABEL=lifecycle-active
      ;;
    .deploy-v030.writer)
      BOOTSTRAP_RECOVERY_KIND=writer
      BOOTSTRAP_RECOVERY_LABEL=writer-active
      ;;
    .deploy-v030.lock.next.*)
      BOOTSTRAP_RECOVERY_TOKEN="${name#.deploy-v030.lock.next.}"
      validate_bootstrap_token "$BOOTSTRAP_RECOVERY_TOKEN" || return 1
      BOOTSTRAP_RECOVERY_KIND=lifecycle
      BOOTSTRAP_RECOVERY_LABEL=lifecycle-next
      ;;
    .deploy-v030.writer.next.*)
      BOOTSTRAP_RECOVERY_TOKEN="${name#.deploy-v030.writer.next.}"
      validate_bootstrap_token "$BOOTSTRAP_RECOVERY_TOKEN" || return 1
      BOOTSTRAP_RECOVERY_KIND=writer
      BOOTSTRAP_RECOVERY_LABEL=writer-next
      ;;
    .deploy-v030.lock.released.*)
      BOOTSTRAP_RECOVERY_TOKEN="${name#.deploy-v030.lock.released.}"
      validate_bootstrap_token "$BOOTSTRAP_RECOVERY_TOKEN" || return 1
      BOOTSTRAP_RECOVERY_KIND=lifecycle
      BOOTSTRAP_RECOVERY_LABEL=lifecycle-released
      ;;
    .deploy-v030.writer.released.*)
      BOOTSTRAP_RECOVERY_TOKEN="${name#.deploy-v030.writer.released.}"
      validate_bootstrap_token "$BOOTSTRAP_RECOVERY_TOKEN" || return 1
      BOOTSTRAP_RECOVERY_KIND=writer
      BOOTSTRAP_RECOVERY_LABEL=writer-released
      ;;
    .deploy-v030.bootstrap-build.lifecycle.*)
      BOOTSTRAP_RECOVERY_TOKEN="${name#.deploy-v030.bootstrap-build.lifecycle.}"
      validate_bootstrap_token "$BOOTSTRAP_RECOVERY_TOKEN" || return 1
      BOOTSTRAP_RECOVERY_KIND=lifecycle
      BOOTSTRAP_RECOVERY_LABEL=lifecycle-build
      ;;
    .deploy-v030.bootstrap-build.writer.*)
      BOOTSTRAP_RECOVERY_TOKEN="${name#.deploy-v030.bootstrap-build.writer.}"
      validate_bootstrap_token "$BOOTSTRAP_RECOVERY_TOKEN" || return 1
      BOOTSTRAP_RECOVERY_KIND=writer
      BOOTSTRAP_RECOVERY_LABEL=writer-build
      ;;
    .deploy-v030.bootstrap-quarantine.lifecycle-*.*.*)
      BOOTSTRAP_RECOVERY_KIND=lifecycle
      BOOTSTRAP_RECOVERY_LABEL=quarantine-lifecycle
      ;;
    .deploy-v030.bootstrap-quarantine.writer-*.*.*)
      BOOTSTRAP_RECOVERY_KIND=writer
      BOOTSTRAP_RECOVERY_LABEL=quarantine-writer
      ;;
    *) return 1 ;;
  esac
}

bootstrap_recover_stale_control_state() {
  local path state quarantine expected_token common_run_token="" index
  local -a paths=() kinds=() tokens=() labels=() owners=() run_tokens=() generations=() phases=()
  validate_sanitizer_gate_idle_state || return 1
  bootstrap_ensure_process_identity || return 1
  bootstrap_recover_stale_artifact_repairs || return 1
  for path in "$LIFECYCLE_DIR" "$WRITER_DIR"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      paths+=("$path")
    fi
  done
  shopt -s nullglob
  for path in \
    "$LIFECYCLE_DIR".next.* "$WRITER_DIR".next.* \
    "$LIFECYCLE_DIR".released.* "$WRITER_DIR".released.* \
    "$REMOTE_ROOT"/.deploy-v030.bootstrap-build.* \
    "$REMOTE_ROOT"/.deploy-v030.bootstrap-quarantine.*; do
    paths+=("$path")
  done
  shopt -u nullglob
  if [ "${#paths[@]}" -eq 0 ]; then
    bootstrap_require_no_generation_phase_stages_in_parent \
      "$REMOTE_ROOT" "Orphan bootstrap generation phase stage" || return 1
    bootstrap_resume_generation_deletions "$REMOTE_ROOT" || return 1
    return 0
  fi

  for path in "${paths[@]}"; do
    bootstrap_recovery_candidate_details "$path" || {
      printf '%s\n' "Unknown bootstrap control generation: $path" >&2
      return 1
    }
    expected_token="$BOOTSTRAP_RECOVERY_TOKEN"
    bootstrap_validate_generation "$path" "$BOOTSTRAP_RECOVERY_KIND" "$expected_token" || {
      printf '%s\n' "Malformed or foreign bootstrap control generation: $path" >&2
      return 1
    }
    state="$(bootstrap_generation_owner_state)" || return 1
    case "$state" in
      stale) ;;
      live)
        printf '%s\n' "Bootstrap control generation still has a live owner: $path" >&2
        return 1
        ;;
      foreign)
        printf '%s\n' "Bootstrap control generation PID belongs to a foreign process: $path" >&2
        return 1
        ;;
      *)
        printf '%s\n' "Bootstrap control generation owner state is unknown: $path" >&2
        return 1
        ;;
    esac
    if [[ "$BOOTSTRAP_RECOVERY_LABEL" != quarantine-* ]]; then
      if [ -z "$common_run_token" ]; then
        common_run_token="$BOOTSTRAP_VALIDATED_RUN_TOKEN"
      elif [ "$common_run_token" != "$BOOTSTRAP_VALIDATED_RUN_TOKEN" ]; then
        printf '%s\n' "Bootstrap control generations belong to different runs" >&2
        return 1
      fi
    fi
    kinds+=("$BOOTSTRAP_RECOVERY_KIND")
    tokens+=("$expected_token")
    labels+=("$BOOTSTRAP_RECOVERY_LABEL")
    owners+=("$BOOTSTRAP_VALIDATED_OWNER")
    run_tokens+=("$BOOTSTRAP_VALIDATED_RUN_TOKEN")
    generations+=("$BOOTSTRAP_VALIDATED_GENERATION")
    phases+=("$BOOTSTRAP_VALIDATED_PHASE")
  done

  for ((index = 0; index < ${#paths[@]}; index++)); do
    [[ "${labels[$index]}" != quarantine-* ]] || continue
    bootstrap_reconcile_stale_generation_phase_stage \
      "${paths[$index]}" "${kinds[$index]}" "${owners[$index]}" \
      "${generations[$index]}" "${phases[$index]}" || return 1
  done
  bootstrap_require_no_generation_phase_stages_in_parent \
    "$REMOTE_ROOT" "Unknown or ambiguous bootstrap generation phase stage" || return 1
  bootstrap_resume_generation_deletions "$REMOTE_ROOT" || return 1

  for ((index = 0; index < ${#paths[@]}; index++)); do
    path="${paths[$index]}"
    bootstrap_validate_generation "$path" "${kinds[$index]}" "${tokens[$index]}" || return 1
    [ "$BOOTSTRAP_VALIDATED_OWNER" = "${owners[$index]}" ] || {
      printf '%s\n' "Bootstrap generation owner CAS rejected: $path" >&2
      return 1
    }
    [ "$BOOTSTRAP_VALIDATED_RUN_TOKEN" = "${run_tokens[$index]}" ] || return 1
    if [[ "${labels[$index]}" == quarantine-* ]]; then
      bootstrap_delete_fence_generation "$path" "${kinds[$index]}" "${owners[$index]}" || return 1
      sync_directory "$REMOTE_ROOT" || return 1
      continue
    fi
    quarantine="$REMOTE_ROOT/.deploy-v030.bootstrap-quarantine.${labels[$index]}.${owners[$index]}.$BOOTSTRAP_OWNER_TOKEN"
    [ ! -e "$quarantine" ] && [ ! -L "$quarantine" ] || return 1
    [ "$(cat "$path/owner")" = "${owners[$index]}" ] || {
      printf '%s\n' "Bootstrap generation owner CAS rejected before quarantine: $path" >&2
      return 1
    }
    mv "$path" "$quarantine" || return 1
    sync_directory "$REMOTE_ROOT" || return 1
    bootstrap_test_sigkill "recovery-${labels[$index]}-quarantined"
    bootstrap_delete_fence_generation "$quarantine" "${kinds[$index]}" "${owners[$index]}" || return 1
    sync_directory "$REMOTE_ROOT" || return 1
  done
  BOOTSTRAP_FENCES_HELD=0
}

bootstrap_cleanup_owned_fence_state() {
  local path kind expected_token quarantine label
  local -a paths=()
  for path in "$LIFECYCLE_DIR" "$WRITER_DIR"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      paths+=("$path")
    fi
  done
  shopt -s nullglob
  for path in \
    "$LIFECYCLE_DIR.next.$BOOTSTRAP_OWNER_TOKEN" \
    "$WRITER_DIR.next.$BOOTSTRAP_OWNER_TOKEN" \
    "$LIFECYCLE_DIR.released.$BOOTSTRAP_OWNER_TOKEN" \
    "$WRITER_DIR.released.$BOOTSTRAP_OWNER_TOKEN" \
    "$REMOTE_ROOT/.deploy-v030.bootstrap-build.lifecycle.$BOOTSTRAP_OWNER_TOKEN" \
    "$REMOTE_ROOT/.deploy-v030.bootstrap-build.writer.$BOOTSTRAP_OWNER_TOKEN"; do
    if path_entry_present_no_follow "$path"; then
      paths+=("$path")
    fi
  done
  shopt -u nullglob
  for path in "${paths[@]}"; do
    case "${path##*/}" in
      .deploy-v030.lock|.deploy-v030.lock.next.*|.deploy-v030.lock.released.*)
        kind=lifecycle
        ;;
      .deploy-v030.writer|.deploy-v030.writer.next.*|.deploy-v030.writer.released.*)
        kind=writer
        ;;
      .deploy-v030.bootstrap-build.lifecycle.*)
        kind=lifecycle
        ;;
      .deploy-v030.bootstrap-build.writer.*)
        kind=writer
        ;;
      *) return 1 ;;
    esac
    expected_token="$BOOTSTRAP_OWNER_TOKEN"
    bootstrap_validate_generation "$path" "$kind" "$expected_token" || return 1
    label="${path##*/}"
    label="${label//./-}"
    quarantine="$REMOTE_ROOT/.deploy-v030.bootstrap-quarantine.$kind-cleanup-$label.$BOOTSTRAP_OWNER_TOKEN.$BOOTSTRAP_OWNER_TOKEN"
    [ ! -e "$quarantine" ] && [ ! -L "$quarantine" ] || return 1
    [ "$(cat "$path/owner")" = "$BOOTSTRAP_OWNER_TOKEN" ] || return 1
    mv "$path" "$quarantine" || return 1
    sync_directory "$REMOTE_ROOT" || return 1
    bootstrap_delete_fence_generation "$quarantine" "$kind" "$BOOTSTRAP_OWNER_TOKEN" || return 1
    sync_directory "$REMOTE_ROOT" || return 1
  done
  BOOTSTRAP_FENCES_HELD=0
}

bootstrap_release_shared_fences() {
  local retired_lifecycle retired_writer
  [ "$BOOTSTRAP_FENCES_HELD" = "1" ] || return 0
  validate_owned_bootstrap_fences || return 1
  retired_lifecycle="$LIFECYCLE_DIR.released.$BOOTSTRAP_OWNER_TOKEN"
  retired_writer="$WRITER_DIR.released.$BOOTSTRAP_OWNER_TOKEN"
  [ ! -e "$retired_lifecycle" ] && [ ! -L "$retired_lifecycle" ] || return 1
  [ ! -e "$retired_writer" ] && [ ! -L "$retired_writer" ] || return 1
  bootstrap_set_generation_phase "$WRITER_DIR" writer bootstrap-releasing || return 1
  bootstrap_set_generation_phase "$LIFECYCLE_DIR" lifecycle bootstrap-releasing || return 1
  bootstrap_test_sigkill release-armed
  mv "$WRITER_DIR" "$retired_writer" || return 1
  sync_directory "$REMOTE_ROOT" || return 1
  bootstrap_test_sigkill writer-released
  mv "$LIFECYCLE_DIR" "$retired_lifecycle" || return 1
  sync_directory "$REMOTE_ROOT" || return 1
  BOOTSTRAP_FENCES_HELD=0
  bootstrap_test_sigkill lifecycle-released
  bootstrap_delete_fence_generation "$retired_writer" writer "$BOOTSTRAP_OWNER_TOKEN" || return 1
  bootstrap_delete_fence_generation "$retired_lifecycle" lifecycle "$BOOTSTRAP_OWNER_TOKEN" || return 1
  sync_directory "$REMOTE_ROOT"
}

bootstrap_arm_cleanup_recovery() {
  BOOTSTRAP_CLEANUP_ARMED=1
  trap 'bootstrap_release_on_exit $?' EXIT || return 1
  trap 'bootstrap_abort $?' ERR || return 1
  trap 'bootstrap_abort 130' INT || return 1
  trap 'bootstrap_abort 143' TERM || return 1
  trap 'bootstrap_abort 129' HUP || return 1
}

require_root() {
  [ "$(bootstrap_trusted_id -u)" = "0" ] || {
    die "This bootstrap must run as root"
    return 1
  }
}

require_exact_host() {
  # shellcheck disable=SC1091
  . /etc/os-release || return 1
  [ "$ID" = "ubuntu" ] || { die "Expected Ubuntu"; return 1; }
  [ "$VERSION_ID" = "26.04" ] || { die "Expected Ubuntu 26.04"; return 1; }
  [ "$(dpkg --print-architecture)" = "amd64" ] || { die "Expected amd64 packages"; return 1; }
  [ "$(uname -m)" = "x86_64" ] || { die "Expected x86_64 kernel"; return 1; }
  [ -d "$LIVE_DIR" ] && [ ! -L "$LIVE_DIR" ] || { die "Live platform directory is invalid"; return 1; }
  command -v node >/dev/null || { die "node is required"; return 1; }
  command -v pm2 >/dev/null || { die "pm2 is required"; return 1; }
  command -v apparmor_parser >/dev/null || { die "apparmor_parser is required"; return 1; }
  bootstrap_trusted_flock --version >/dev/null 2>&1 || { die "trusted flock is required"; return 1; }
  bootstrap_findmnt --version >/dev/null 2>&1 || { die "trusted findmnt is required"; return 1; }
  command -v passwd >/dev/null || { die "passwd is required"; return 1; }
  command -v pgrep >/dev/null || { die "pgrep is required"; return 1; }
  command -v python3 >/dev/null || { die "python3 is required"; return 1; }
  command -v ss >/dev/null || { die "ss is required"; return 1; }
  command -v systemctl >/dev/null || { die "systemctl is required"; return 1; }
}

install_apparmor_profile() {
  local candidate="$BACKUP_DIR/turingmarket-gate-chromium.profile"
  local previous="$BACKUP_DIR/turingmarket-gate-chromium.previous"
  local previous_present=0

  cat > "$candidate" <<'APPARMOR' || return 1
abi <abi/4.0>,
#include <tunables/global>

profile turingmarket-gate-chromium /var/lib/turingmarket-gate/releases/*/tmp/deploy-v*-gate-*/browser-cache/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
  userns,
}
APPARMOR
  chmod 0600 "$candidate" || return 1
  if ! apparmor_parser -Q "$candidate"; then
    printf '%s\n' "AppArmor profile validation failed" >&2
    return 1
  fi

  if [ -e "$APPARMOR_PROFILE" ] || [ -L "$APPARMOR_PROFILE" ]; then
    if [ ! -f "$APPARMOR_PROFILE" ] || [ -L "$APPARMOR_PROFILE" ]; then
      printf '%s\n' "AppArmor profile path is unsafe" >&2
      return 1
    fi
    if ! cp -a -- "$APPARMOR_PROFILE" "$previous"; then
      printf '%s\n' "AppArmor profile backup failed" >&2
      return 1
    fi
    previous_present=1
  fi

  if ! install -o root -g root -m 0644 "$candidate" "$APPARMOR_PROFILE"; then
    if [ "$previous_present" = "1" ]; then
      install -o root -g root -m 0644 "$previous" "$APPARMOR_PROFILE" || true
    else
      rm -f -- "$APPARMOR_PROFILE" || true
    fi
    printf '%s\n' "AppArmor profile install failed" >&2
    return 1
  fi
  if ! apparmor_parser -r "$APPARMOR_PROFILE"; then
    if [ "$previous_present" = "1" ]; then
      if ! install -o root -g root -m 0644 "$previous" "$APPARMOR_PROFILE"; then
        printf '%s\n' "AppArmor profile restore failed" >&2
        return 1
      fi
      if ! apparmor_parser -r "$APPARMOR_PROFILE"; then
        printf '%s\n' "Previous AppArmor profile reload failed" >&2
        return 1
      fi
    else
      if ! rm -f -- "$APPARMOR_PROFILE"; then
        printf '%s\n' "Rejected AppArmor profile cleanup failed" >&2
        return 1
      fi
    fi
    printf '%s\n' "AppArmor profile reload failed" >&2
    return 1
  fi
}

safe_pm2_snapshot() {
  node <<'NODE'
const { execFileSync } = require('node:child_process');
const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }));
const safe = processes.map((entry) => ({
  name: entry.name,
  pid: entry.pid,
  status: entry.pm2_env && entry.pm2_env.status,
  cwd: entry.pm2_env && entry.pm2_env.pm_cwd,
  script: entry.pm2_env && entry.pm2_env.pm_exec_path
}));
process.stdout.write(JSON.stringify(safe, null, 2) + '\n');
NODE
}

snapshot_runtime_health() {
  local destination="$1"
  local allow_stopped="${2:-0}"
  local temporary="$destination.new.$$"
  local listeners
  case "$allow_stopped" in 0|1) ;; *) return 1 ;; esac
  rm -f -- "$temporary" "$destination" || return 1
  if curl -fsS http://127.0.0.1:3002/api/health > "$temporary"; then
    mv "$temporary" "$destination" || return 1
    return 0
  fi
  rm -f -- "$temporary" || return 1
  [ "$allow_stopped" = "1" ] || return 1
  listeners="$(ss -H -ltn 'sport = :3002')" || return 1
  [ -z "$listeners" ] || return 1
  printf '%s\n' '{"status":"stopped","isolation":"no-port-3002-listener"}' > "$temporary" || return 1
  mv "$temporary" "$destination" || return 1
}

snapshot_host() {
  local phase="$1"
  local allow_stopped=0
  if [ "$phase" = "before" ]; then allow_stopped=1; fi
  mkdir -p "$BACKUP_DIR/$phase" || return 1
  dpkg-query -W -f='${binary:Package}\t${Version}\n' | LC_ALL=C sort > "$BACKUP_DIR/$phase/dpkg-query.txt" || return 1
  apt-mark showmanual | LC_ALL=C sort > "$BACKUP_DIR/$phase/apt-mark-manual.txt" || return 1
  apt-mark showhold | LC_ALL=C sort > "$BACKUP_DIR/$phase/apt-mark-hold.txt" || return 1
  cp -a /etc/apt/sources.list.d "$BACKUP_DIR/$phase/sources.list.d" || return 1
  if [ -f /etc/apt/sources.list ]; then
    cp -a /etc/apt/sources.list "$BACKUP_DIR/$phase/sources.list" || return 1
  fi
  safe_pm2_snapshot > "$BACKUP_DIR/$phase/pm2.json" || return 1
  snapshot_runtime_health "$BACKUP_DIR/$phase/health.json" "$allow_stopped" || return 1
  df -PT "$LIVE_DIR" "$STATE_ROOT" > "$BACKUP_DIR/$phase/disk.txt" 2>&1 || true
  systemctl --failed --no-legend > "$BACKUP_DIR/$phase/systemd-failed.txt" 2>&1 || true
}

copy_existing_path() {
  local source="$1"
  local destination="$2"
  if [ -e "$source" ] || [ -L "$source" ]; then
    cp -a -- "$source" "$destination" || return 1
    : > "$destination.present" || return 1
  else
    : > "$destination.absent" || return 1
  fi
}

bootstrap_anchored_path_helper() {
  local action="$1"
  local target_root="$2"
  local target_relative="$3"
  local target_root_modes="$4"
  local allow_leaf_symlink="$5"
  local source_root="${6:-}"
  local source_relative="${7:-}"
  local source_root_modes="${8:-0700}"
  local source_exact_modes="${9:-0}"
  local fixed_members="${10:-}"
  local expected_uid
  bootstrap_reject_production_test_hooks || return 1
  expected_uid="$(bootstrap_trusted_id -u)"
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    expected_uid=0
  fi
  python3 - "$action" "$target_root" "$target_relative" "$target_root_modes" "$allow_leaf_symlink" "$source_root" "$source_relative" "$source_root_modes" "$expected_uid" "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" "$source_exact_modes" "$fixed_members" <<'PY'
import os
import re
import signal
import stat
import sys

(
    action,
    target_root,
    target_relative,
    target_root_modes_raw,
    allow_leaf_symlink_raw,
    source_root,
    source_relative,
    source_root_modes_raw,
    expected_uid_raw,
    library_only,
    source_exact_modes_raw,
    fixed_members_raw,
) = sys.argv[1:]
expected_uid = int(expected_uid_raw)
allow_leaf_symlink = allow_leaf_symlink_raw == '1'
source_exact_modes = source_exact_modes_raw == '1'
read_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
directory_flags = read_flags | os.O_DIRECTORY


def reject(message):
    raise SystemExit(message)


if not hasattr(os, 'O_PATH'):
    reject('Anchored path operations require Linux O_PATH mount identity support')
identity_flags = os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW


def mount_id_for_fd(descriptor):
    try:
        with open(f'/proc/self/fdinfo/{descriptor}', encoding='ascii') as handle:
            matches = [
                match.group(1)
                for line in handle.read().splitlines()
                if (match := re.fullmatch(r'mnt_id:\s*([1-9][0-9]*)', line))
            ]
    except OSError:
        reject('Anchored path cannot read kernel mount identity')
    if len(matches) != 1:
        reject('Anchored path kernel mount identity is unavailable')
    return int(matches[0])


def ensure_mount_identity(descriptor, expected_mount_id, label):
    if mount_id_for_fd(descriptor) != expected_mount_id:
        reject(f'{label} mount identity drift')


def open_identity(parent_fd, name):
    descriptor = os.open(name, identity_flags, dir_fd=parent_fd)
    try:
        return descriptor, os.fstat(descriptor), mount_id_for_fd(descriptor)
    except BaseException:
        os.close(descriptor)
        raise


def durable_boundary(point):
    if library_only != '1':
        return
    if os.environ.get('TM_BOOTSTRAP_TEST_RESTORE_IOERROR_AT') == point:
        raise OSError(5, f'simulated restore I/O failure at {point}')
    if os.environ.get('TM_BOOTSTRAP_TEST_RESTORE_SIGKILL_AT') == point:
        parent_pid = os.getppid()
        os.kill(parent_pid, signal.SIGKILL)
        os.kill(os.getpid(), signal.SIGKILL)


def parse_modes(raw):
    try:
        modes = {int(value, 8) for value in raw.split(',') if value}
    except ValueError:
        reject('Anchored path root mode policy is invalid')
    if not modes or any(mode < 0 or mode > 0o7777 or mode & 0o022 for mode in modes):
        reject('Anchored path root mode policy is unsafe')
    return modes


def safe_component(component):
    return bool(component) and component not in ('.', '..') and not any(
        character in component for character in ('/', '\0', '\n', '\r', '\t')
    )


def split_relative(relative):
    if not isinstance(relative, str) or not relative or relative.startswith('/'):
        reject('Anchored path relative target is invalid')
    components = relative.split('/')
    if any(not safe_component(component) for component in components):
        reject('Anchored path contains an unsafe component')
    return components


def fixed_member_policy(raw, root_relative):
    if not raw:
        reject('Anchored fixed-member removal requires a closed member policy')
    members = raw.split(',')
    if len(set(members)) != len(members):
        reject('Anchored fixed-member policy contains duplicates')
    for member in members:
        split_relative(member)
        if member != root_relative and not member.startswith(root_relative + '/'):
            reject('Anchored fixed-member policy escapes the target tree')
    if root_relative not in members:
        reject('Anchored fixed-member policy omits the target root')
    return set(members)


def open_root(path, modes_raw, label):
    modes = parse_modes(modes_raw)
    if not os.path.isabs(path) or os.path.normpath(path) != path or os.path.realpath(path) != path:
        reject(f'{label} root is not canonical')
    path_status = os.lstat(path)
    if not stat.S_ISDIR(path_status.st_mode) or stat.S_ISLNK(path_status.st_mode):
        reject(f'{label} root is not a directory')
    if path_status.st_uid != expected_uid or stat.S_IMODE(path_status.st_mode) not in modes:
        reject(f'{label} root ownership or mode drift')
    descriptor = os.open(path, directory_flags)
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != (path_status.st_dev, path_status.st_ino):
        os.close(descriptor)
        reject(f'{label} root changed while opening')
    return descriptor, opened, mount_id_for_fd(descriptor)


def status_at(parent_fd, name):
    return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)


def safe_directory_status(status, mount_id, root_device, root_mount_id, label):
    if not stat.S_ISDIR(status.st_mode) or stat.S_ISLNK(status.st_mode):
        reject(f'{label} component is not a no-follow directory')
    if status.st_dev != root_device or mount_id != root_mount_id:
        reject(f'{label} component crosses a mount boundary')
    if status.st_uid != expected_uid or stat.S_IMODE(status.st_mode) & 0o022:
        reject(f'{label} directory ownership or mode drift')


def walk_parent(root_fd, root_status, root_mount_id, relative, label):
    components = split_relative(relative)
    current_fd = os.dup(root_fd)
    walked = []
    try:
        ensure_mount_identity(current_fd, root_mount_id, f'{label} root')
        for component in components[:-1]:
            walked.append(component)
            walked_relative = '/'.join(walked)
            if (
                library_only == '1'
                and os.environ.get('TM_BOOTSTRAP_TEST_FORCE_XDEV_RELATIVE') == walked_relative
            ):
                reject(f'{label} component crosses a mount boundary')
            component_status = status_at(current_fd, component)
            next_fd = os.open(component, directory_flags, dir_fd=current_fd)
            opened = os.fstat(next_fd)
            if (opened.st_dev, opened.st_ino) != (component_status.st_dev, component_status.st_ino):
                os.close(next_fd)
                reject(f'{label} component changed while opening')
            safe_directory_status(
                opened,
                mount_id_for_fd(next_fd),
                root_status.st_dev,
                root_mount_id,
                label,
            )
            os.close(current_fd)
            current_fd = next_fd
        return current_fd, components[-1]
    except BaseException:
        os.close(current_fd)
        raise


def regular_record(
    parent_fd, name, relative, status, root_device, root_mount_id, exact_snapshot_modes,
):
    mode = stat.S_IMODE(status.st_mode)
    if status.st_dev != root_device or status.st_uid != expected_uid:
        reject('Anchored file owner or mount identity drift')
    if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
        reject('Anchored path contains a link, hardlink, or special file')
    if (exact_snapshot_modes and mode != 0o600) or (not exact_snapshot_modes and mode & 0o022):
        reject('Anchored file mode drift')
    descriptor = os.open(name, read_flags, dir_fd=parent_fd)
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != (status.st_dev, status.st_ino):
        os.close(descriptor)
        reject('Anchored file changed while opening')
    ensure_mount_identity(descriptor, root_mount_id, 'Anchored file')
    os.close(descriptor)
    return {
        'path': relative,
        'type': 'file',
        'device': status.st_dev,
        'inode': status.st_ino,
        'uid': status.st_uid,
        'mode': mode,
        'links': status.st_nlink,
    }


def scan_node(
    parent_fd, name, relative, root_device, root_mount_id,
    exact_snapshot_modes=False, leaf_symlink=False,
):
    if not safe_component(name):
        reject('Anchored entry name is unsafe')
    identity_fd, status, entry_mount_id = open_identity(parent_fd, name)
    try:
        if status.st_dev != root_device or entry_mount_id != root_mount_id:
            reject('Anchored entry crosses a mount boundary')
        if stat.S_ISLNK(status.st_mode):
            if not leaf_symlink or status.st_uid != expected_uid:
                reject('Anchored path contains a symlink')
            return [{
                'path': relative,
                'type': 'symlink',
                'device': status.st_dev,
                'inode': status.st_ino,
                'uid': status.st_uid,
                'mode': stat.S_IMODE(status.st_mode),
            }]
        if stat.S_ISREG(status.st_mode):
            return [regular_record(
                parent_fd, name, relative, status, root_device,
                root_mount_id, exact_snapshot_modes,
            )]
        if not stat.S_ISDIR(status.st_mode):
            reject('Anchored path contains a special file')
        mode = stat.S_IMODE(status.st_mode)
        if status.st_uid != expected_uid:
            reject('Anchored directory ownership drift')
        if (exact_snapshot_modes and mode != 0o700) or (not exact_snapshot_modes and mode & 0o022):
            reject('Anchored directory mode drift')
        record = {
            'path': relative,
            'type': 'directory',
            'device': status.st_dev,
            'inode': status.st_ino,
            'uid': status.st_uid,
            'mode': mode,
        }
        child_fd = os.open(name, directory_flags, dir_fd=parent_fd)
        try:
            opened = os.fstat(child_fd)
            if (opened.st_dev, opened.st_ino) != (status.st_dev, status.st_ino):
                reject('Anchored directory changed while opening')
            ensure_mount_identity(child_fd, root_mount_id, 'Anchored recursive directory')
            records = [record]
            for child_name in sorted(os.listdir(child_fd)):
                child_relative = f'{relative}/{child_name}'
                records.extend(scan_node(
                    child_fd,
                    child_name,
                    child_relative,
                    root_device,
                    root_mount_id,
                    exact_snapshot_modes=exact_snapshot_modes,
                ))
            return records
        finally:
            os.close(child_fd)
    finally:
        os.close(identity_fd)


def compare_record(actual, expected):
    if actual != expected:
        reject('Anchored path identity changed after validation')


def record_type_matches(mode, record_type):
    return {
        'directory': stat.S_ISDIR,
        'file': stat.S_ISREG,
        'symlink': stat.S_ISLNK,
    }[record_type](mode)


def revalidate_record_identity(parent_fd, name, record, root_mount_id, label):
    descriptor, current, current_mount_id = open_identity(parent_fd, name)
    actual_identity = (
        current.st_dev,
        current.st_ino,
        current.st_uid,
        stat.S_IMODE(current.st_mode),
        current_mount_id,
    )
    expected_identity = (
        record['device'], record['inode'], record['uid'], record['mode'], root_mount_id,
    )
    if not record_type_matches(current.st_mode, record['type']) or actual_identity != expected_identity:
        os.close(descriptor)
        reject(f'{label} identity or mount changed before removal')
    if record['type'] == 'file' and current.st_nlink != record['links']:
        os.close(descriptor)
        reject(f'{label} link count changed before removal')
    return descriptor


def remove_node(
    parent_fd, name, relative, manifest, root_device, root_mount_id,
    leaf_symlink=False,
):
    try:
        current_records = scan_node(
            parent_fd, name, relative, root_device, root_mount_id,
            leaf_symlink=leaf_symlink,
        )
    except FileNotFoundError:
        return
    expected_records = {record['path']: record for record in manifest}
    for actual in current_records:
        expected = expected_records.get(actual['path'])
        if expected is None:
            reject('Anchored path gained an entry after validation')
        compare_record(actual, expected)
    root_record = current_records[0]
    if root_record['type'] == 'directory':
        child_fd = os.open(name, directory_flags, dir_fd=parent_fd)
        try:
            opened = os.fstat(child_fd)
            if (opened.st_dev, opened.st_ino) != (root_record['device'], root_record['inode']):
                reject('Anchored directory changed before removal')
            ensure_mount_identity(child_fd, root_mount_id, 'Anchored recursive directory')
            for child_name in sorted(os.listdir(child_fd)):
                child_relative = f'{relative}/{child_name}'
                child_manifest = [
                    record for record in current_records
                    if record['path'] == child_relative or record['path'].startswith(child_relative + '/')
                ]
                remove_node(
                    child_fd, child_name, child_relative, child_manifest,
                    root_device, root_mount_id,
                )
            os.fsync(child_fd)
        finally:
            os.close(child_fd)
        identity_fd = revalidate_record_identity(
            parent_fd, name, root_record, root_mount_id, 'Anchored directory',
        )
        try:
            ensure_mount_identity(parent_fd, root_mount_id, 'Anchored parent directory')
            os.rmdir(name, dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            os.close(identity_fd)
        durable_boundary(f'restore-rmdir-{relative}')
        return
    identity_fd = revalidate_record_identity(
        parent_fd, name, root_record, root_mount_id, 'Anchored leaf',
    )
    try:
        ensure_mount_identity(parent_fd, root_mount_id, 'Anchored parent directory')
        os.unlink(name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(identity_fd)
    durable_boundary(f'restore-unlink-{relative}')


def open_source_file(parent_fd, name, record, root_mount_id):
    status = status_at(parent_fd, name)
    if (status.st_dev, status.st_ino) != (record['device'], record['inode']):
        reject('Anchored source changed before copy')
    descriptor = os.open(name, read_flags, dir_fd=parent_fd)
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != (record['device'], record['inode']):
        os.close(descriptor)
        reject('Anchored source changed while opening for copy')
    ensure_mount_identity(descriptor, root_mount_id, 'Anchored source file')
    return descriptor


def copy_node(
    source_parent_fd, source_name, destination_parent_fd, destination_name,
    relative, manifest, source_root_mount_id, destination_root_mount_id,
):
    ensure_mount_identity(source_parent_fd, source_root_mount_id, 'Anchored source parent')
    ensure_mount_identity(
        destination_parent_fd, destination_root_mount_id, 'Anchored destination parent',
    )
    records = {record['path']: record for record in manifest}
    record = records[relative]
    if record['type'] == 'file':
        source_fd = open_source_file(
            source_parent_fd, source_name, record, source_root_mount_id,
        )
        destination_fd = os.open(
            destination_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            record['mode'],
            dir_fd=destination_parent_fd,
        )
        try:
            ensure_mount_identity(
                destination_fd, destination_root_mount_id, 'Anchored destination file',
            )
            while True:
                chunk = os.read(source_fd, 1024 * 1024)
                if not chunk:
                    break
                offset = 0
                while offset < len(chunk):
                    offset += os.write(destination_fd, chunk[offset:])
            os.fchmod(destination_fd, record['mode'])
            os.fsync(destination_fd)
        finally:
            os.close(source_fd)
            os.close(destination_fd)
        os.fsync(destination_parent_fd)
        durable_boundary(f'restore-copy-file-{relative}')
        return
    if record['type'] != 'directory':
        reject('Anchored source type cannot be copied')
    source_status = status_at(source_parent_fd, source_name)
    if (source_status.st_dev, source_status.st_ino) != (record['device'], record['inode']):
        reject('Anchored source directory changed before copy')
    source_fd = os.open(source_name, directory_flags, dir_fd=source_parent_fd)
    os.mkdir(destination_name, record['mode'], dir_fd=destination_parent_fd)
    destination_fd = os.open(destination_name, directory_flags, dir_fd=destination_parent_fd)
    try:
        opened = os.fstat(source_fd)
        if (opened.st_dev, opened.st_ino) != (record['device'], record['inode']):
            reject('Anchored source directory changed while opening for copy')
        ensure_mount_identity(source_fd, source_root_mount_id, 'Anchored source directory')
        ensure_mount_identity(
            destination_fd, destination_root_mount_id, 'Anchored destination directory',
        )
        for child_name in sorted(os.listdir(source_fd)):
            child_relative = f'{relative}/{child_name}'
            child_manifest = [
                child for child in manifest
                if child['path'] == child_relative or child['path'].startswith(child_relative + '/')
            ]
            if not child_manifest:
                reject('Anchored source gained an entry after validation')
            copy_node(
                source_fd, child_name, destination_fd, child_name,
                child_relative, child_manifest,
                source_root_mount_id, destination_root_mount_id,
            )
        os.fchmod(destination_fd, record['mode'])
        os.fsync(destination_fd)
    finally:
        os.close(source_fd)
        os.close(destination_fd)
    os.fsync(destination_parent_fd)
    durable_boundary(f'restore-copy-directory-{relative}')


def path_exists(parent_fd, name, root_mount_id):
    try:
        descriptor, _, entry_mount_id = open_identity(parent_fd, name)
    except FileNotFoundError:
        return False
    try:
        if entry_mount_id != root_mount_id:
            reject('Anchored leaf crosses a mount boundary')
        return True
    finally:
        os.close(descriptor)


if action == 'restore-absent-target-root':
    source_root_fd, source_root_status, source_root_mount_id = open_root(
        source_root, source_root_modes_raw, 'Anchored source',
    )
    try:
        source_parent_fd, source_leaf = walk_parent(
            source_root_fd, source_root_status, source_root_mount_id,
            source_relative, 'Anchored source',
        )
        try:
            present_name = source_leaf + '.present'
            absent_name = source_leaf + '.absent'
            if (
                path_exists(source_parent_fd, present_name, source_root_mount_id)
                or not path_exists(source_parent_fd, absent_name, source_root_mount_id)
            ):
                reject('Missing target root is allowed only for an absent restore payload')
            marker_records = scan_node(
                source_parent_fd,
                absent_name,
                source_relative + '.absent',
                source_root_status.st_dev,
                source_root_mount_id,
                exact_snapshot_modes=True,
            )
            if len(marker_records) != 1 or marker_records[0]['type'] != 'file':
                reject('Restore snapshot absent marker is unsafe')
            if path_exists(source_parent_fd, source_leaf, source_root_mount_id):
                reject('Restore snapshot absent payload unexpectedly exists')
        finally:
            os.close(source_parent_fd)
    finally:
        os.close(source_root_fd)
    raise SystemExit(0)


target_root_fd, target_root_status, target_root_mount_id = open_root(
    target_root, target_root_modes_raw, 'Anchored target',
)
try:
    target_parent_fd, target_leaf = walk_parent(
        target_root_fd, target_root_status, target_root_mount_id,
        target_relative, 'Anchored target',
    )
    try:
        target_manifest = []
        if path_exists(target_parent_fd, target_leaf, target_root_mount_id):
            target_manifest = scan_node(
                target_parent_fd,
                target_leaf,
                target_relative,
                target_root_status.st_dev,
                target_root_mount_id,
                leaf_symlink=allow_leaf_symlink,
            )
        if action == 'validate':
            if not target_manifest:
                reject('Anchored target is missing')
        elif action in ('remove', 'remove-fixed'):
            if target_manifest:
                if action == 'remove-fixed':
                    allowed_members = fixed_member_policy(fixed_members_raw, target_relative)
                    observed_members = {record['path'] for record in target_manifest}
                    if not observed_members <= allowed_members:
                        reject('Anchored fixed-member tree contains an unknown entry')
                remove_node(
                    target_parent_fd,
                    target_leaf,
                    target_relative,
                    target_manifest,
                    target_root_status.st_dev,
                    target_root_mount_id,
                    leaf_symlink=allow_leaf_symlink,
                )
        elif action in ('restore', 'copy'):
            source_root_fd, source_root_status, source_root_mount_id = open_root(
                source_root, source_root_modes_raw, 'Anchored source',
            )
            try:
                source_parent_fd, source_leaf = walk_parent(
                    source_root_fd, source_root_status, source_root_mount_id,
                    source_relative, 'Anchored source',
                )
                try:
                    source_manifest = []
                    source_present = False
                    if action == 'restore':
                        present_name = source_leaf + '.present'
                        absent_name = source_leaf + '.absent'
                        present = path_exists(
                            source_parent_fd, present_name, source_root_mount_id,
                        )
                        absent = path_exists(
                            source_parent_fd, absent_name, source_root_mount_id,
                        )
                        if present == absent:
                            reject('Restore snapshot presence markers differ from schema')
                        marker_name = present_name if present else absent_name
                        marker_records = scan_node(
                            source_parent_fd,
                            marker_name,
                            source_relative + ('.present' if present else '.absent'),
                            source_root_status.st_dev,
                            source_root_mount_id,
                            exact_snapshot_modes=True,
                        )
                        if len(marker_records) != 1 or marker_records[0]['type'] != 'file':
                            reject('Restore snapshot marker is unsafe')
                        source_present = present
                        if source_present:
                            if not path_exists(
                                source_parent_fd, source_leaf, source_root_mount_id,
                            ):
                                reject('Restore snapshot payload is missing')
                            source_manifest = scan_node(
                                source_parent_fd,
                                source_leaf,
                                source_relative,
                                source_root_status.st_dev,
                                source_root_mount_id,
                                exact_snapshot_modes=source_exact_modes,
                            )
                        elif path_exists(
                            source_parent_fd, source_leaf, source_root_mount_id,
                        ):
                            reject('Restore snapshot absent payload unexpectedly exists')
                    else:
                        if not path_exists(
                            source_parent_fd, source_leaf, source_root_mount_id,
                        ):
                            reject('Anchored copy source is missing')
                        source_present = True
                        source_manifest = scan_node(
                            source_parent_fd,
                            source_leaf,
                            source_relative,
                            source_root_status.st_dev,
                            source_root_mount_id,
                        )
                    if target_manifest:
                        remove_node(
                            target_parent_fd,
                            target_leaf,
                            target_relative,
                            target_manifest,
                            target_root_status.st_dev,
                            target_root_mount_id,
                            leaf_symlink=allow_leaf_symlink,
                        )
                    if source_present:
                        copy_node(
                            source_parent_fd,
                            source_leaf,
                            target_parent_fd,
                            target_leaf,
                            source_relative,
                            source_manifest,
                            source_root_mount_id,
                            target_root_mount_id,
                        )
                finally:
                    os.close(source_parent_fd)
            finally:
                os.close(source_root_fd)
        else:
            reject('Unknown anchored path action')
    finally:
        os.close(target_parent_fd)
finally:
    os.close(target_root_fd)
PY
}

bootstrap_journal_dirfd_helper() {
  local action="$1"
  local entry_name="${2:-active}"
  local expected_identity="${3:-}"
  local argument_one="${4:-}"
  local argument_two="${5:-}"
  local argument_three="${6:-}"
  local expected_uid expected_gid
  bootstrap_reject_production_test_hooks || return 1
  expected_uid="$(bootstrap_trusted_id -u)" || return 1
  expected_gid="$(bootstrap_trusted_id -g)" || return 1
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    expected_uid=0
    expected_gid=0
  fi
  python3 - "$action" "$JOURNAL_ROOT" "$entry_name" "$expected_identity" \
    "$expected_uid" "$expected_gid" "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" \
    "$argument_one" "$argument_two" "$argument_three" "${JOURNAL_ROOT_TOKEN:-}" <<'PY'
import ctypes
import errno
import hashlib
import json
import os
import re
import signal
import stat
import sys

try:
    import fcntl
except ImportError:
    fcntl = None

(
    action,
    journal_root,
    entry_name,
    expected_identity_raw,
    expected_uid_raw,
    expected_gid_raw,
    library_only,
    argument_one,
    argument_two,
    argument_three,
    expected_root_token,
) = sys.argv[1:]
expected_uid = int(expected_uid_raw)
expected_gid = int(expected_gid_raw)


def reject(message):
    raise SystemExit(message)


if sys.platform != 'linux':
    reject('Migration journal dirfd operations require Linux')
for required_flag in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_CLOEXEC', 'O_PATH', 'O_TMPFILE'):
    if not hasattr(os, required_flag):
        reject(f'Migration journal dirfd operations require {required_flag}')

read_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
directory_flags = read_flags | os.O_DIRECTORY
identity_flags = os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW
protocol_lock_name = '.journal-protocol.lock'
journal_format_name = 'journal-format'
journal_format_value = 'journal-format-v4'
generation_pattern = re.compile(r'generation-([0-9]{8})')
initializing_pattern = re.compile(r'\.active\.initializing\.([0-9a-f]{32})')
consumed_pattern = re.compile(r'\.terminal-consumed\.([0-9a-f]{64})')
legacy_claim_pattern = re.compile(r'\.active\.retired\.[1-9][0-9]*\.[0-9]+')
run_id_pattern = re.compile(r'[0-9a-f]{32}')
terminal_id_pattern = re.compile(r't1:[0-9a-f]{64}')
root_token_pattern = re.compile(r'r2:[0-9a-f]{64}')
marker_proof_pattern = re.compile(r'm2:[0-9a-f]{64}:[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{64}')
legacy_marker_proof_pattern = re.compile(r'm1:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{64}')
phase_values = {'stopping', 'snapshotting', 'prepared', 'installing', 'linked', 'committed'}
phase_successors = {
    'stopping': 'snapshotting',
    'snapshotting': 'prepared',
    'prepared': 'installing',
    'installing': 'linked',
    'linked': 'committed',
    'committed': None,
}
initial_phase_values = {'stopping', 'committed'}
legacy_field_names = {'schema-version', 'owner-token', 'backup-dir', 'phase'}
legacy_minimal_names = {'backup-dir', 'phase'}
legacy_explicit_ack_name = 'terminal-explicit-ack-v1'
legacy_terminal_evidence_names = {
    'retire-intent',
    'retire-complete',
    'retire-acknowledged',
    'terminal-consumed',
    '.retire-intent.staging',
    '.retire-complete.staging',
    '.retire-acknowledged.staging',
}
legacy_terminal_names = {*legacy_terminal_evidence_names, legacy_explicit_ack_name}
max_journal_directories = 32
bound_root_token = None
bound_root_mount_id = None
generation_hook_used = False


def phase_transition_allowed(current, target):
    return target == current or phase_successors.get(current) == target


libc = ctypes.CDLL(None, use_errno=True)
linkat = getattr(libc, 'linkat', None)
renameat2 = getattr(libc, 'renameat2', None)
AT_EMPTY_PATH = 0x1000
RENAME_NOREPLACE = 1
if linkat is None or renameat2 is None:
    reject('Migration journal requires linkat and renameat2')
linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
linkat.restype = ctypes.c_int
renameat2.argtypes = [
    ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint,
]
renameat2.restype = ctypes.c_int


def mount_id_for_fd(descriptor):
    try:
        with open(f'/proc/self/fdinfo/{descriptor}', encoding='ascii') as handle:
            values = [
                match.group(1)
                for line in handle.read().splitlines()
                if (match := re.fullmatch(r'mnt_id:\s*([1-9][0-9]*)', line))
            ]
    except OSError:
        reject('Migration journal kernel mount identity is unavailable')
    if len(values) != 1:
        reject('Migration journal kernel mount identity is ambiguous')
    value = int(values[0])
    if library_only == '1':
        offset_raw = os.environ.get('TM_BOOTSTRAP_TEST_MOUNT_ID_OFFSET', '0')
        if not re.fullmatch(r'[0-9]+', offset_raw):
            reject('Migration journal test mount offset is invalid')
        value += int(offset_raw)
    if value <= 0:
        reject('Migration journal kernel mount identity is invalid')
    return value


def read_boot_id():
    if library_only == '1' and os.environ.get('TM_BOOTSTRAP_TEST_BOOT_ID'):
        value = os.environ['TM_BOOTSTRAP_TEST_BOOT_ID'].strip().lower()
    else:
        try:
            with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as handle:
                value = handle.read().strip().lower()
        except OSError:
            reject('Migration journal boot identity is unavailable')
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value):
        reject('Migration journal boot identity is invalid')
    return value


def marker_proof_is_valid(value):
    return bool(
        marker_proof_pattern.fullmatch(value if isinstance(value, str) else '')
        or legacy_marker_proof_pattern.fullmatch(value if isinstance(value, str) else '')
    )


def identity(status):
    return status.st_dev, status.st_ino


def status_at(parent_fd, name):
    return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)


def present(parent_fd, name):
    try:
        status_at(parent_fd, name)
        return True
    except FileNotFoundError:
        return False


def canonical_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')


def write_all(descriptor, payload):
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            raise OSError(errno.EIO, 'Migration journal write made no progress')
        offset += written


def read_all(descriptor, limit=65536):
    os.lseek(descriptor, 0, os.SEEK_SET)
    chunks = []
    size = 0
    while True:
        chunk = os.read(descriptor, min(4096, limit + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if size > limit:
            reject('Migration journal record is too large')
    return b''.join(chunks)


def rename_noreplace(source_fd, source_name, destination_fd, destination_name):
    result = renameat2(
        source_fd,
        os.fsencode(source_name),
        destination_fd,
        os.fsencode(destination_name),
        RENAME_NOREPLACE,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), destination_name)


def link_anonymous(descriptor, parent_fd, name):
    result = linkat(descriptor, b'', parent_fd, os.fsencode(name), AT_EMPTY_PATH)
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), name)


def trusted_chain_to(path):
    components = [component for component in path.split('/') if component]
    descriptor = os.open('/', directory_flags)
    chain = []
    try:
        opened = os.fstat(descriptor)
        chain.append((opened.st_dev, opened.st_ino, mount_id_for_fd(descriptor)))
        for component in components:
            before = status_at(descriptor, component)
            if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
                reject('Migration journal trusted traversal encountered a non-directory')
            child = os.open(component, directory_flags, dir_fd=descriptor)
            child_status = os.fstat(child)
            if identity(before) != identity(child_status):
                os.close(child)
                reject('Migration journal trusted traversal changed while opening')
            if library_only != '1' and (
                child_status.st_uid != 0
                or child_status.st_gid != 0
                or stat.S_IMODE(child_status.st_mode) & 0o022
            ):
                os.close(child)
                reject('Migration journal trusted traversal ownership or mode drift')
            os.close(descriptor)
            descriptor = child
            chain.append((
                child_status.st_dev,
                child_status.st_ino,
                mount_id_for_fd(descriptor),
            ))
        return descriptor, chain
    except BaseException:
        os.close(descriptor)
        raise


def validate_named_record(parent_fd, parent_status, parent_mount_id, name, expected_payload=None):
    before = status_at(parent_fd, name)
    if (
        not stat.S_ISREG(before.st_mode)
        or stat.S_ISLNK(before.st_mode)
        or before.st_dev != parent_status.st_dev
        or before.st_uid != expected_uid
        or before.st_gid != expected_gid
        or stat.S_IMODE(before.st_mode) != 0o600
        or before.st_nlink != 1
    ):
        reject(f'Migration journal record metadata is unsafe: {name}')
    descriptor = os.open(name, read_flags, dir_fd=parent_fd)
    try:
        opened = os.fstat(descriptor)
        if identity(opened) != identity(before) or mount_id_for_fd(descriptor) != parent_mount_id:
            reject(f'Migration journal record changed while opening: {name}')
        payload = read_all(descriptor)
        after = status_at(parent_fd, name)
        if identity(after) != identity(opened):
            reject(f'Migration journal record changed while reading: {name}')
        if expected_payload is not None and payload != expected_payload:
            reject(f'Migration journal record payload is invalid: {name}')
        return payload, identity(opened)
    finally:
        os.close(descriptor)


def publish_anchor(parent_fd, parent_status, parent_mount_id, name, payload):
    descriptor = os.open(
        '.', os.O_RDWR | os.O_TMPFILE | os.O_CLOEXEC, 0o600, dir_fd=parent_fd,
    )
    try:
        opened = os.fstat(descriptor)
        if opened.st_dev != parent_status.st_dev or mount_id_for_fd(descriptor) != parent_mount_id:
            reject('Migration journal root anchor stage mount drift')
        write_all(descriptor, payload)
        os.fchmod(descriptor, 0o600)
        if library_only != '1':
            os.fchown(descriptor, expected_uid, expected_gid)
        os.fsync(descriptor)
        try:
            link_anonymous(descriptor, parent_fd, name)
        except OSError as error:
            if error.errno != errno.EEXIST:
                raise
        os.fsync(parent_fd)
        observed, observed_identity = validate_named_record(
            parent_fd, parent_status, parent_mount_id, name, payload,
        )
        if observed != payload:
            reject('Migration journal root anchor publication changed')
        if observed_identity != identity(opened):
            current, _current_identity = validate_named_record(
                parent_fd, parent_status, parent_mount_id, name, payload,
            )
            if current != payload:
                reject('Migration journal root anchor no-replace conflict')
    finally:
        os.close(descriptor)


def validate_legacy_root_anchor(payload, parent_path, root_status):
    try:
        value = json.loads(payload.decode('ascii'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        reject('Migration journal legacy root anchor is invalid')
    if not isinstance(value, dict) or set(value) != {
        'bootId', 'journalPath', 'parentAnchor', 'rootDevice',
        'rootInode', 'rootMount', 'schemaVersion',
    }:
        reject('Migration journal legacy root anchor schema is invalid')
    if (
        value['schemaVersion'] != 1
        or value['journalPath'] != journal_root
        or value['rootDevice'] != root_status.st_dev
        or value['rootInode'] != root_status.st_ino
        or not isinstance(value['rootMount'], int)
        or isinstance(value['rootMount'], bool)
        or value['rootMount'] <= 0
        or not re.fullmatch(r'[0-9a-f]{64}', value['parentAnchor'] if isinstance(value['parentAnchor'], str) else '')
        or not re.fullmatch(
            r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
            value['bootId'] if isinstance(value['bootId'], str) else '',
        )
        or payload != canonical_bytes(value)
    ):
        reject('Migration journal legacy root anchor provenance is invalid')


def bind_current_boot_root_mount_guard(
    parent_fd, parent_status, parent_mount_id, base_name,
    root_token, parent_chain, root_mount_id, guard_label, publish_if_missing=True,
):
    boot_id = read_boot_id()
    guard_name = f'.{base_name}.{guard_label}.{boot_id}'
    guard_value = {
        'bootId': boot_id,
        'parentMounts': [mount for _device, _inode, mount in parent_chain],
        'rootMount': root_mount_id,
        'rootToken': root_token,
        'schemaVersion': 1,
    }
    guard_payload = canonical_bytes(guard_value)
    if not present(parent_fd, guard_name):
        if not publish_if_missing:
            return
        publish_anchor(
            parent_fd, parent_status, parent_mount_id, guard_name, guard_payload,
        )
    validate_named_record(
        parent_fd, parent_status, parent_mount_id, guard_name, guard_payload,
    )


def open_root():
    if not os.path.isabs(journal_root) or os.path.normpath(journal_root) != journal_root:
        reject('Migration journal root is not canonical')
    parent_path = os.path.dirname(journal_root)
    base_name = os.path.basename(journal_root)
    if not re.fullmatch(r'[A-Za-z0-9._-]+', base_name):
        reject('Migration journal root basename is unsafe')
    parent_fd, parent_chain = trusted_chain_to(parent_path)
    try:
        parent_status = os.fstat(parent_fd)
        parent_mount_id = mount_id_for_fd(parent_fd)
        before = status_at(parent_fd, base_name)
        if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
            reject('Migration journal root is not a no-follow directory')
        root_fd = os.open(base_name, directory_flags, dir_fd=parent_fd)
        root_status = os.fstat(root_fd)
        if identity(before) != identity(root_status):
            os.close(root_fd)
            reject('Migration journal root changed while opening')
        root_mount_id = mount_id_for_fd(root_fd)
        if (
            root_status.st_uid != expected_uid
            or root_status.st_gid != expected_gid
            or stat.S_IMODE(root_status.st_mode) != 0o700
        ):
            os.close(root_fd)
            reject('Migration journal root ownership or mode drift')
        parent_digest = hashlib.sha256(
            (parent_path + '|' + '|'.join(
                f'{device}.{inode}' for device, inode, _mount in parent_chain
            )).encode('ascii')
        ).hexdigest()
        anchor_value = {
            'journalPath': journal_root,
            'parentAnchor': parent_digest,
            'rootDevice': root_status.st_dev,
            'rootInode': root_status.st_ino,
            'schemaVersion': 2,
        }
        anchor_payload = canonical_bytes(anchor_value)
        anchor_name = f'.{base_name}.root-anchor-v2'
        legacy_anchor_name = f'.{base_name}.root-anchor-v1'
        if not present(parent_fd, anchor_name):
            if action != 'bind-root':
                os.close(root_fd)
                reject('Migration journal root anchor is missing; offline root maintenance is required')
            if present(parent_fd, legacy_anchor_name):
                legacy_payload, _legacy_identity = validate_named_record(
                    parent_fd, parent_status, parent_mount_id, legacy_anchor_name,
                )
                validate_legacy_root_anchor(legacy_payload, parent_path, root_status)
            else:
                existing = set(os.listdir(root_fd))
                if existing:
                    os.close(root_fd)
                    reject('Migration journal root cannot be anchored after use; offline root maintenance is required')
            publish_anchor(
                parent_fd, parent_status, parent_mount_id, anchor_name, anchor_payload,
            )
        observed, _anchor_identity = validate_named_record(
            parent_fd, parent_status, parent_mount_id, anchor_name, anchor_payload,
        )
        token = 'r2:' + hashlib.sha256(observed).hexdigest()
        if expected_root_token and token != expected_root_token:
            os.close(root_fd)
            reject('Migration journal root identity changed')
        bind_current_boot_root_mount_guard(
            parent_fd,
            parent_status,
            parent_mount_id,
            base_name,
            token,
            parent_chain,
            root_mount_id,
            'root-mount-guard-v1',
            action != 'peek-terminal',
        )
        return root_fd, root_status, root_mount_id, token
    finally:
        os.close(parent_fd)


def identity_text(status, descriptor):
    if bound_root_token is None:
        reject('Migration journal root token is not bound')
    return (
        f'j2:{bound_root_token[3:]}:{status.st_dev}:{status.st_ino}:'
        f'{mount_id_for_fd(descriptor)}'
    )


def parse_identity(raw):
    if not raw:
        return None
    match = re.fullmatch(
        r'j2:([0-9a-f]{64}):([1-9][0-9]*):([1-9][0-9]*):([1-9][0-9]*)',
        raw,
    )
    if match:
        return match.group(1), int(match.group(2)), int(match.group(3)), int(match.group(4))
    legacy = re.fullmatch(
        r'j1:([0-9a-f]{64}):([1-9][0-9]*):([1-9][0-9]*):([1-9][0-9]*)',
        raw,
    )
    if legacy and library_only == '1':
        return legacy.group(1), int(legacy.group(2)), int(legacy.group(3)), int(legacy.group(4))
    legacy_pair = re.fullmatch(r'([0-9]+):([0-9]+)', raw)
    if legacy_pair and library_only == '1':
        return 'legacy', int(legacy_pair.group(1)), int(legacy_pair.group(2)), None
    reject('Migration journal expected identity is invalid')


def safe_entry_name(name):
    return (
        name == 'active'
        or bool(initializing_pattern.fullmatch(name))
        or bool(consumed_pattern.fullmatch(name))
        or bool(legacy_claim_pattern.fullmatch(name))
    )


def open_entry(root_fd, root_status, root_mount_id, name, expected_identity):
    if not safe_entry_name(name):
        reject('Migration journal entry name is unsafe')
    before = status_at(root_fd, name)
    if (
        not stat.S_ISDIR(before.st_mode)
        or stat.S_ISLNK(before.st_mode)
        or before.st_dev != root_status.st_dev
        or before.st_uid != expected_uid
        or before.st_gid != expected_gid
        or stat.S_IMODE(before.st_mode) != 0o700
    ):
        reject('Migration journal entry metadata is unsafe')
    descriptor = os.open(name, directory_flags, dir_fd=root_fd)
    opened = os.fstat(descriptor)
    if identity(opened) != identity(before) or mount_id_for_fd(descriptor) != root_mount_id:
        os.close(descriptor)
        reject('Migration journal entry changed while opening')
    if expected_identity is not None:
        expected_hash, expected_device, expected_inode, expected_mount = expected_identity
        if (
            identity(opened) != (expected_device, expected_inode)
            or (expected_hash not in ('legacy', bound_root_token[3:]))
            or (expected_mount is not None and expected_mount != root_mount_id)
        ):
            os.close(descriptor)
            reject('Migration journal directory identity changed')
    return descriptor, opened


def assert_entry_matches(root_fd, root_status, root_mount_id, name, descriptor, expected_identity):
    opened = os.fstat(descriptor)
    check_fd = None
    try:
        before = status_at(root_fd, name)
        check_fd = os.open(name, identity_flags, dir_fd=root_fd)
        current = os.fstat(check_fd)
        if (
            identity(before) != identity(opened)
            or identity(current) != identity(opened)
            or mount_id_for_fd(check_fd) != root_mount_id
        ):
            reject('Migration journal canonical entry changed')
        if expected_identity is not None:
            _hash, device, inode, mount = expected_identity
            if identity(opened) != (device, inode) or (mount is not None and mount != root_mount_id):
                reject('Migration journal canonical identity changed')
    finally:
        if check_fd is not None:
            os.close(check_fd)


def boundary(point):
    if library_only != '1':
        return
    if os.environ.get('TM_BOOTSTRAP_TEST_JOURNAL_IOERROR_AT') == point:
        raise OSError(errno.EIO, f'simulated migration journal I/O failure at {point}')
    if os.environ.get('TM_BOOTSTRAP_TEST_JOURNAL_SIGKILL_AT') == point:
        os.kill(os.getppid(), signal.SIGKILL)
        os.kill(os.getpid(), signal.SIGKILL)


def publish_anonymous_record(parent_fd, parent_status, parent_mount_id, name, payload, prefix):
    descriptor = os.open(
        '.', os.O_RDWR | os.O_TMPFILE | os.O_CLOEXEC, 0o600, dir_fd=parent_fd,
    )
    try:
        opened = os.fstat(descriptor)
        if opened.st_dev != parent_status.st_dev or mount_id_for_fd(descriptor) != parent_mount_id:
            reject('Migration journal anonymous stage mount drift')
        boundary(f'{prefix}-stage-opened')
        split = max(1, len(payload) // 2)
        write_all(descriptor, payload[:split])
        boundary(f'{prefix}-stage-partial')
        write_all(descriptor, payload[split:])
        os.fchmod(descriptor, 0o600)
        if library_only != '1':
            os.fchown(descriptor, expected_uid, expected_gid)
        os.fsync(descriptor)
        boundary(f'{prefix}-stage-file-fsync')
        link_anonymous(descriptor, parent_fd, name)
        boundary(f'{prefix}-published')
        os.fsync(parent_fd)
        boundary(f'{prefix}-publish-dir-fsync')
        _observed, final_identity = validate_named_record(
            parent_fd, parent_status, parent_mount_id, name, payload,
        )
        if final_identity != identity(opened):
            reject('Migration journal anonymous publication identity changed')
        return final_identity
    finally:
        os.close(descriptor)


def directory_snapshot(status):
    return (
        status.st_dev,
        status.st_ino,
        status.st_nlink,
        status.st_mtime_ns,
        status.st_ctime_ns,
    )


def terminal_id_for(record):
    basis = {
        'headDigest': record['terminal']['headDigest'],
        'markerProof': record['terminal']['markerProof'],
        'operation': record['operation'],
        'phase': record['phase'],
        'rootAnchor': record['rootAnchor'],
        'runId': record['runId'],
    }
    return 't1:' + hashlib.sha256(canonical_bytes(basis)).hexdigest()


def validate_operation(value):
    if not isinstance(value, dict) or set(value) != {'backupDir', 'kind'}:
        reject('Migration journal operation schema is invalid')
    if value['kind'] != 'runtime-migration':
        reject('Migration journal operation kind is invalid')
    backup = value['backupDir']
    if (
        not isinstance(backup, str)
        or not backup.startswith('/')
        or any(character in backup for character in ('\0', '\n', '\r', '\t'))
    ):
        reject('Migration journal operation backup path is invalid')


def parse_v4_generation(raw, sequence, previous_digest, previous_record, last_live_digest):
    try:
        value = json.loads(raw.decode('ascii'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        reject('Migration journal generation payload is invalid')
    if not isinstance(value, dict) or set(value) != {
        'operation',
        'phase',
        'previousDigest',
        'rootAnchor',
        'runId',
        'schemaVersion',
        'sequence',
        'state',
        'terminal',
    }:
        reject('Migration journal generation fields are invalid')
    if (
        value['schemaVersion'] != 4
        or value['sequence'] != sequence
        or value['previousDigest'] != previous_digest
        or not run_id_pattern.fullmatch(value['runId'] if isinstance(value['runId'], str) else '')
        or value['rootAnchor'] != bound_root_token
        or value['phase'] not in phase_values
    ):
        reject('Migration journal generation identity is invalid')
    validate_operation(value['operation'])
    if raw != canonical_bytes(value):
        reject('Migration journal generation encoding is not canonical')
    state = value['state']
    if state not in ('live', 'terminal-pending', 'terminal-consumed'):
        reject('Migration journal durable state is invalid')
    if sequence == 0:
        if (
            state != 'live'
            or value['terminal'] is not None
            or previous_record is not None
            or value['phase'] not in initial_phase_values
        ):
            reject('Migration journal generation zero is invalid')
    elif previous_record is None:
        reject('Migration journal generation predecessor is missing')
    elif not phase_transition_allowed(previous_record['phase'], value['phase']):
        reject('Migration journal phase transition is invalid')
    if state == 'live':
        if value['terminal'] is not None or (
            previous_record is not None and previous_record['state'] != 'live'
        ):
            reject('Migration journal live transition is invalid')
    else:
        terminal = value['terminal']
        if not isinstance(terminal, dict) or set(terminal) != {
            'headDigest', 'id', 'markerProof',
        }:
            reject('Migration journal terminal proof is invalid')
        if not terminal_id_pattern.fullmatch(terminal['id'] if isinstance(terminal['id'], str) else ''):
            reject('Migration journal terminal id is invalid')
        if not re.fullmatch(r'[0-9a-f]{64}', terminal['headDigest'] if isinstance(terminal['headDigest'], str) else ''):
            reject('Migration journal terminal head is invalid')
        if terminal['markerProof'] != 'absent' and not marker_proof_is_valid(
            terminal['markerProof']
        ):
            reject('Migration journal terminal marker proof is invalid')
        if terminal['headDigest'] != last_live_digest or terminal['id'] != terminal_id_for(value):
            reject('Migration journal terminal provenance is invalid')
        if state == 'terminal-pending':
            if previous_record['state'] != 'live':
                reject('Migration journal pending transition is invalid')
        elif (
            previous_record['state'] != 'terminal-pending'
            or previous_record['terminal'] != terminal
            or previous_record['operation'] != value['operation']
            or previous_record['phase'] != value['phase']
            or previous_record['runId'] != value['runId']
        ):
            reject('Migration journal consumed transition is invalid')
    return value


def read_bound_record(journal_fd, journal_status, root_mount_id, name):
    return validate_named_record(
        journal_fd, journal_status, root_mount_id, name,
    )


def inject_generation_leaf_replacement(journal_fd, root_mount_id, point, generation_name):
    global generation_hook_used
    if (
        generation_hook_used
        or library_only != '1'
        or os.environ.get('TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT') != point
    ):
        return
    generation_hook_used = True
    original_name = f'.{generation_name}.test-original.{os.getpid()}'
    replacement_name = generation_name
    os.rename(generation_name, original_name, src_dir_fd=journal_fd, dst_dir_fd=journal_fd)
    replacement = os.open(
        replacement_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
        dir_fd=journal_fd,
    )
    try:
        write_all(replacement, b'replacement-generation-must-survive\n')
        os.fsync(replacement)
    finally:
        os.close(replacement)
    if point == 'read-mixed-generation-aba':
        evidence_name = f'.{generation_name}.test-replacement.{os.getpid()}'
        os.rename(replacement_name, evidence_name, src_dir_fd=journal_fd, dst_dir_fd=journal_fd)
        os.rename(original_name, generation_name, src_dir_fd=journal_fd, dst_dir_fd=journal_fd)
    os.fsync(journal_fd)


def read_generation_snapshot(journal_fd, journal_status, root_mount_id):
    before_status = os.fstat(journal_fd)
    names_before = set(os.listdir(journal_fd))
    generation_names = sorted(name for name in names_before if generation_pattern.fullmatch(name))
    if names_before == legacy_field_names or names_before == legacy_minimal_names:
        values = {}
        identities = {}
        for name in sorted(names_before):
            raw, file_identity = read_bound_record(
                journal_fd, journal_status, root_mount_id, name,
            )
            if not raw.endswith(b'\n') or b'\n' in raw[:-1] or b'\0' in raw:
                reject(f'Migration journal legacy field framing is invalid: {name}')
            try:
                values[name] = raw[:-1].decode('ascii')
            except UnicodeDecodeError:
                reject(f'Migration journal legacy field is invalid: {name}')
            identities[name] = file_identity
        if names_before == legacy_field_names and (
            values['schema-version'] != '1'
            or not run_id_pattern.fullmatch(values['owner-token'])
        ):
            reject('Migration journal legacy identity is invalid')
        if values['phase'] not in phase_values or not values['backup-dir'].startswith('/'):
            reject('Migration journal legacy values are invalid')
        record = {
            'operation': {'backupDir': values['backup-dir'], 'kind': 'runtime-migration'},
            'phase': values['phase'],
            'runId': values.get('owner-token', ''),
            'state': 'live',
            'terminal': None,
        }
        head_digest = hashlib.sha256(
            b''.join(name.encode('ascii') + b'\0' + values[name].encode('ascii')
                     for name in sorted(values))
        ).hexdigest()
        legacy = True
    else:
        allowed = {journal_format_name, *generation_names}
        legacy_markers = names_before - allowed
        if legacy_markers and not legacy_markers <= legacy_terminal_names:
            reject('Migration journal immutable generation schema is invalid')
        if journal_format_name not in names_before or not generation_names:
            reject('Migration journal immutable format is missing')
        expected_names = [f'generation-{index:08d}' for index in range(len(generation_names))]
        if generation_names != expected_names:
            reject('Migration journal generation sequence is not contiguous')
        format_raw, format_identity = read_bound_record(
            journal_fd, journal_status, root_mount_id, journal_format_name,
        )
        identities = {journal_format_name: format_identity}
        previous_digest = None
        previous_record = None
        last_live_digest = None
        if format_raw == b'journal-format-v4\n':
            for sequence, name in enumerate(generation_names):
                raw, record_identity = read_bound_record(
                    journal_fd, journal_status, root_mount_id, name,
                )
                record = parse_v4_generation(
                    raw, sequence, previous_digest, previous_record, last_live_digest,
                )
                digest = hashlib.sha256(raw).hexdigest()
                if record['state'] == 'live':
                    last_live_digest = digest
                previous_digest = digest
                previous_record = record
                identities[name] = record_identity
            if legacy_markers:
                reject('Migration journal v4 contains legacy terminal markers')
            head_digest = previous_digest
            legacy = False
        elif format_raw == b'journal-format-v3\n':
            previous_digest = None
            previous_phase = None
            for sequence, name in enumerate(generation_names):
                raw, record_identity = read_bound_record(
                    journal_fd, journal_status, root_mount_id, name,
                )
                try:
                    old = json.loads(raw.decode('ascii'))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    reject('Migration journal v3 generation is invalid')
                if not isinstance(old, dict) or set(old) != {
                    'backupDir', 'generation', 'ownerToken', 'phase', 'previous', 'schemaVersion'
                }:
                    reject('Migration journal v3 generation schema is invalid')
                if (
                    old['schemaVersion'] != 3
                    or old['generation'] != sequence
                    or old['previous'] != previous_digest
                    or not run_id_pattern.fullmatch(old['ownerToken'])
                    or old['phase'] not in phase_values
                    or not isinstance(old['backupDir'], str)
                    or not old['backupDir'].startswith('/')
                    or raw != canonical_bytes(old)
                ):
                    reject('Migration journal v3 generation values are invalid')
                if sequence == 0:
                    if old['phase'] not in initial_phase_values:
                        reject('Migration journal v3 generation zero phase is invalid')
                elif not phase_transition_allowed(previous_phase, old['phase']):
                    reject('Migration journal v3 phase transition is invalid')
                previous_phase = old['phase']
                previous_digest = hashlib.sha256(raw).hexdigest()
                identities[name] = record_identity
                record = {
                    'operation': {'backupDir': old['backupDir'], 'kind': 'runtime-migration'},
                    'phase': old['phase'],
                    'runId': old['ownerToken'],
                    'state': 'live',
                    'terminal': None,
                }
            marker_payloads = {}
            for name in sorted(legacy_markers):
                raw, marker_identity = read_bound_record(
                    journal_fd, journal_status, root_mount_id, name,
                )
                marker_payloads[name] = raw
                identities[name] = marker_identity
            head_digest = previous_digest
            evidence_names = legacy_markers & legacy_terminal_evidence_names
            if legacy_explicit_ack_name in legacy_markers and not evidence_names:
                reject('Migration journal legacy acknowledgement lacks retained terminal evidence')
            if evidence_names:
                marker_digest = hashlib.sha256()
                for name in sorted(evidence_names):
                    marker_digest.update(name.encode('ascii') + b'\0' + marker_payloads[name])
                terminal_id = 't1:' + hashlib.sha256(
                    b'legacy-terminal\0' + head_digest.encode('ascii') + marker_digest.digest()
                ).hexdigest()
                marker_proof = 'absent'
                terminal_state = 'terminal-pending'
                if legacy_explicit_ack_name in legacy_markers:
                    try:
                        acknowledgement = json.loads(
                            marker_payloads[legacy_explicit_ack_name].decode('ascii')
                        )
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        reject('Migration journal legacy acknowledgement payload is invalid')
                    if not isinstance(acknowledgement, dict):
                        reject('Migration journal legacy acknowledgement schema is invalid')
                    expected_acknowledgement = {
                        'headDigest': head_digest,
                        'markerProof': acknowledgement.get('markerProof'),
                        'operation': record['operation'],
                        'phase': record['phase'],
                        'rootAnchor': bound_root_token,
                        'runId': record['runId'],
                        'schemaVersion': 1,
                        'state': 'terminal-consumed',
                        'terminalId': terminal_id,
                    }
                    marker_proof = acknowledgement.get('markerProof')
                    if (
                        acknowledgement != expected_acknowledgement
                        or marker_payloads[legacy_explicit_ack_name] != canonical_bytes(acknowledgement)
                        or (
                            marker_proof != 'absent'
                            and not marker_proof_is_valid(marker_proof)
                        )
                        or (record['phase'] == 'committed') != (marker_proof != 'absent')
                    ):
                        reject('Migration journal legacy acknowledgement provenance is invalid')
                    terminal_state = 'terminal-consumed'
                record = {
                    **record,
                    'state': terminal_state,
                    'terminal': {
                        'headDigest': head_digest,
                        'id': terminal_id,
                        'markerProof': marker_proof,
                    },
                }
            legacy = True
        else:
            reject('Migration journal immutable format is invalid')
    if generation_names:
        inject_generation_leaf_replacement(
            journal_fd, root_mount_id, 'read-mixed-generation-aba', generation_names[-1],
        )
    names_after = set(os.listdir(journal_fd))
    after_status = os.fstat(journal_fd)
    if names_after != names_before or directory_snapshot(after_status) != directory_snapshot(before_status):
        reject('Migration journal collective generation changed while reading')
    for name, expected_file_identity in identities.items():
        _payload, current_identity = read_bound_record(
            journal_fd, journal_status, root_mount_id, name,
        )
        if current_identity != expected_file_identity:
            reject('Migration journal generation identity changed while reading')
    return legacy, record, names_before, identities, head_digest


def make_generation(sequence, previous_digest, run_id, backup_dir, phase, state, terminal):
    return {
        'operation': {'backupDir': backup_dir, 'kind': 'runtime-migration'},
        'phase': phase,
        'previousDigest': previous_digest,
        'rootAnchor': bound_root_token,
        'runId': run_id,
        'schemaVersion': 4,
        'sequence': sequence,
        'state': state,
        'terminal': terminal,
    }


def append_generation(
    journal_fd,
    journal_status,
    root_mount_id,
    expected_head,
    run_id,
    backup_dir,
    phase,
    state,
    terminal,
    prefix,
):
    legacy, current, names, identities, head_digest = read_generation_snapshot(
        journal_fd, journal_status, root_mount_id,
    )
    if legacy:
        reject('Legacy migration journal cannot append v4 generations')
    if expected_head != head_digest:
        reject('Migration journal expected-head CAS failed')
    generation_count = len([name for name in names if generation_pattern.fullmatch(name)])
    inject_generation_leaf_replacement(
        journal_fd,
        root_mount_id,
        'generation-leaf-before-publish',
        f'generation-{generation_count - 1:08d}',
    )
    _legacy_again, current_again, names_again, identities_again, head_again = read_generation_snapshot(
        journal_fd, journal_status, root_mount_id,
    )
    if (
        current_again != current
        or names_again != names
        or identities_again != identities
        or head_again != head_digest
    ):
        reject('Migration journal collective generation changed before publication')
    record = make_generation(
        generation_count,
        head_digest,
        run_id,
        backup_dir,
        phase,
        state,
        terminal,
    )
    payload = canonical_bytes(record)
    name = f'generation-{generation_count:08d}'
    publish_anonymous_record(
        journal_fd, journal_status, root_mount_id, name, payload, prefix,
    )
    _legacy_after, after, _names_after, _identities_after, after_digest = read_generation_snapshot(
        journal_fd, journal_status, root_mount_id,
    )
    if after != record or after_digest != hashlib.sha256(payload).hexdigest():
        reject('Migration journal generation publication was not coherent')
    return after, after_digest


def verify_reservation(root_fd, root_status, root_mount_id):
    if fcntl is None:
        reject('Migration journal reservation requires fcntl')
    try:
        descriptor_status = os.fstat(7)
    except OSError:
        reject('Migration journal reservation descriptor is missing')
    lock_payload, lock_identity = validate_named_record(
        root_fd, root_status, root_mount_id, protocol_lock_name, b'journal-protocol-lock-v1\n',
    )
    if lock_payload != b'journal-protocol-lock-v1\n' or identity(descriptor_status) != lock_identity:
        reject('Migration journal reservation descriptor identity changed')
    try:
        fcntl.flock(7, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        reject('Migration journal reservation is not held')
    return f'{descriptor_status.st_dev}:{descriptor_status.st_ino}:{root_mount_id}'


def require_reservation(root_fd, root_status, root_mount_id):
    verify_reservation(root_fd, root_status, root_mount_id)


def inspect_root_entries(root_fd, root_status, root_mount_id):
    directories = []
    for name in sorted(os.listdir(root_fd)):
        if name == protocol_lock_name:
            validate_named_record(
                root_fd, root_status, root_mount_id, name, b'journal-protocol-lock-v1\n',
            )
            continue
        if not safe_entry_name(name):
            reject(f'Migration journal root contains an unknown entry: {name}')
        descriptor, opened = open_entry(
            root_fd, root_status, root_mount_id, name, None,
        )
        os.close(descriptor)
        directories.append((name, opened))
    if len(directories) > max_journal_directories:
        reject('Migration journal capacity exceeded; offline root maintenance is required')
    return directories


def classify_initializing_stage(root_fd, root_status, root_mount_id, name):
    descriptor, opened = open_entry(root_fd, root_status, root_mount_id, name, None)
    try:
        before_status = os.fstat(descriptor)
        names_before = set(os.listdir(descriptor))
        if not names_before:
            classification = 'incomplete'
        elif names_before == {journal_format_name}:
            validate_named_record(
                descriptor,
                opened,
                root_mount_id,
                journal_format_name,
                (journal_format_value + '\n').encode('ascii'),
            )
            classification = 'incomplete'
        elif names_before == {journal_format_name, 'generation-00000000'}:
            legacy, record, _names, _identities, _head = read_generation_snapshot(
                descriptor, opened, root_mount_id,
            )
            if legacy or record['state'] != 'live' or record['sequence'] != 0:
                reject('Migration journal private generation zero is invalid')
            classification = 'complete'
        else:
            reject('Migration journal private staging schema is invalid')
        if (
            set(os.listdir(descriptor)) != names_before
            or directory_snapshot(os.fstat(descriptor)) != directory_snapshot(before_status)
        ):
            reject('Migration journal private staging changed during classification')
        return classification
    finally:
        os.close(descriptor)


def promote_complete_initializing(root_fd, root_status, root_mount_id, directories):
    initializing = [name for name, _status in directories if initializing_pattern.fullmatch(name)]
    complete = [
        name for name in initializing
        if classify_initializing_stage(root_fd, root_status, root_mount_id, name) == 'complete'
    ]
    if not complete:
        return directories
    if len(complete) != 1 or any(name == 'active' for name, _status in directories):
        reject('Migration journal private publication is ambiguous')
    descriptor, opened = open_entry(
        root_fd, root_status, root_mount_id, complete[0], None,
    )
    try:
        legacy, record, _names, _identities, _head = read_generation_snapshot(
            descriptor, opened, root_mount_id,
        )
        if legacy or record['state'] != 'live' or record['sequence'] != 0:
            reject('Migration journal promoted generation zero is invalid')
        assert_entry_matches(
            root_fd, root_status, root_mount_id, complete[0], descriptor, None,
        )
        rename_noreplace(root_fd, complete[0], root_fd, 'active')
        assert_entry_matches(
            root_fd, root_status, root_mount_id, 'active', descriptor, None,
        )
        os.fsync(root_fd)
    finally:
        os.close(descriptor)
    return inspect_root_entries(root_fd, root_status, root_mount_id)


def discover_state(root_fd, root_status, root_mount_id):
    directories = promote_complete_initializing(
        root_fd,
        root_status,
        root_mount_id,
        inspect_root_entries(root_fd, root_status, root_mount_id),
    )
    active = [name for name, _status in directories if name == 'active']
    retained = [
        name for name, _status in directories
        if legacy_claim_pattern.fullmatch(name)
    ]
    unconsumed = []
    active_result = None
    for name in active + retained:
        descriptor, opened = open_entry(root_fd, root_status, root_mount_id, name, None)
        try:
            legacy, record, _names, _identities, head_digest = read_generation_snapshot(
                descriptor, opened, root_mount_id,
            )
            result = (name, opened, legacy, record, head_digest)
            if name == 'active':
                active_result = result
            if record['state'] in ('live', 'terminal-pending'):
                unconsumed.append(result)
            assert_entry_matches(
                root_fd, root_status, root_mount_id, name, descriptor, None,
            )
        finally:
            os.close(descriptor)
    if len(unconsumed) > 1:
        reject('Migration journal has multiple unconsumed records')
    if active_result is not None:
        if unconsumed and unconsumed[0][0] != 'active':
            reject('Migration journal active canonical entry conflicts with retained unconsumed evidence')
        return active_result
    if unconsumed:
        return unconsumed[0]
    return None


def discover_state_read_only(root_fd, root_status, root_mount_id):
    names_before = sorted(os.listdir(root_fd))
    candidate_names = [
        name for name in names_before
        if name == 'active' or legacy_claim_pattern.fullmatch(name)
    ]
    unconsumed = []
    active_result = None
    for name in candidate_names:
        descriptor, opened = open_entry(root_fd, root_status, root_mount_id, name, None)
        try:
            legacy, record, _names, _identities, head_digest = read_generation_snapshot(
                descriptor, opened, root_mount_id,
            )
            result = (name, opened, legacy, record, head_digest)
            if name == 'active':
                active_result = result
            if record['state'] in ('live', 'terminal-pending'):
                unconsumed.append(result)
            assert_entry_matches(
                root_fd, root_status, root_mount_id, name, descriptor, None,
            )
        finally:
            os.close(descriptor)
    if sorted(os.listdir(root_fd)) != names_before:
        reject('Migration journal root changed during terminal preflight')
    if len(unconsumed) > 1:
        reject('Migration journal has multiple unconsumed records')
    if active_result is not None:
        if unconsumed and unconsumed[0][0] != 'active':
            reject('Migration journal active canonical entry conflicts with retained unconsumed evidence')
        return active_result
    if unconsumed:
        return unconsumed[0]
    return None


def discover_terminal_state(root_fd, root_status, root_mount_id, terminal_id):
    if not terminal_id_pattern.fullmatch(terminal_id):
        reject('Migration journal terminal lookup id is invalid')
    directories = promote_complete_initializing(
        root_fd,
        root_status,
        root_mount_id,
        inspect_root_entries(root_fd, root_status, root_mount_id),
    )
    matches = []
    for name, _status in directories:
        if not (
            name == 'active'
            or legacy_claim_pattern.fullmatch(name)
            or consumed_pattern.fullmatch(name)
        ):
            continue
        descriptor, opened = open_entry(root_fd, root_status, root_mount_id, name, None)
        try:
            legacy, record, _names, _identities, head_digest = read_generation_snapshot(
                descriptor, opened, root_mount_id,
            )
            if (
                record['state'] in ('terminal-pending', 'terminal-consumed')
                and record['terminal']['id'] == terminal_id
            ):
                matches.append((name, opened, legacy, record, head_digest))
        finally:
            os.close(descriptor)
    if len(matches) > 1:
        reject('Migration journal terminal acknowledgement is ambiguous')
    return matches[0] if matches else None


root_fd, root_status, root_mount_id, root_token = open_root()
bound_root_token = root_token
bound_root_mount_id = root_mount_id
expected_identity = parse_identity(expected_identity_raw)
try:
    if action == 'bind-root':
        if expected_identity_raw:
            reject('Migration journal bind-root arguments are invalid')
        print(root_token)
        raise SystemExit(0)
    if action == 'peek-terminal':
        if expected_identity_raw or argument_one or argument_two or argument_three:
            reject('Migration journal terminal preflight arguments are invalid')
        discovered = discover_state_read_only(root_fd, root_status, root_mount_id)
        if discovered is None or discovered[3]['state'] != 'terminal-pending':
            print('continue')
            raise SystemExit(0)
        name, opened, legacy, record, head_digest = discovered
        descriptor, current = open_entry(root_fd, root_status, root_mount_id, name, None)
        try:
            if identity(current) != identity(opened):
                reject('Migration journal terminal preflight identity changed')
            entry_identity = identity_text(current, descriptor)
        finally:
            os.close(descriptor)
        terminal = record['terminal']
        print(record['state'])
        print(root_token)
        print(name)
        print(entry_identity)
        print('1' if legacy else '0')
        print(record['runId'] or '-')
        print(record['phase'])
        print(record['operation']['backupDir'])
        print(head_digest)
        print(terminal['id'])
        print(terminal['markerProof'])
        raise SystemExit(0)
    if not expected_root_token or not root_token_pattern.fullmatch(expected_root_token):
        reject('Migration journal root token is required')
    if action == 'ensure-lock':
        if not present(root_fd, protocol_lock_name):
            descriptor = os.open(
                protocol_lock_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                0o600,
                dir_fd=root_fd,
            )
            try:
                write_all(descriptor, b'journal-protocol-lock-v1\n')
                os.fchmod(descriptor, 0o600)
                if library_only != '1':
                    os.fchown(descriptor, expected_uid, expected_gid)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            os.fsync(root_fd)
        _payload, lock_identity = validate_named_record(
            root_fd, root_status, root_mount_id, protocol_lock_name, b'journal-protocol-lock-v1\n',
        )
        print(f'{lock_identity[0]}:{lock_identity[1]}:{root_mount_id}')
        raise SystemExit(0)
    if action == 'verify-reservation':
        print(verify_reservation(root_fd, root_status, root_mount_id))
        raise SystemExit(0)
    require_reservation(root_fd, root_status, root_mount_id)
    if action == 'reserve-capacity':
        directories = inspect_root_entries(root_fd, root_status, root_mount_id)
        if argument_one:
            if discover_terminal_state(
                root_fd, root_status, root_mount_id, argument_one,
            ) is None:
                reject('Migration journal terminal acknowledgement target is absent')
            print('terminal-only')
            raise SystemExit(0)
        discovered = discover_state(root_fd, root_status, root_mount_id)
        count = len(directories)
        if discovered is not None and discovered[3]['state'] == 'terminal-pending':
            print('terminal-only')
        elif discovered is not None and discovered[3]['state'] == 'live' and count >= max_journal_directories:
            print('existing-live')
        elif count >= max_journal_directories:
            print('full')
        else:
            print('general')
        raise SystemExit(0)
    if action == 'discover':
        discovered = discover_state(root_fd, root_status, root_mount_id)
        if discovered is None:
            print('absent')
            raise SystemExit(0)
        name, opened, legacy, record, head_digest = discovered
        descriptor, current = open_entry(root_fd, root_status, root_mount_id, name, None)
        try:
            if identity(current) != identity(opened):
                reject('Migration journal discovery identity changed')
            entry_identity = identity_text(current, descriptor)
        finally:
            os.close(descriptor)
        print(record['state'])
        print(name)
        print(entry_identity)
        if record['state'] in ('terminal-pending', 'terminal-consumed'):
            print(record['terminal']['id'])
        raise SystemExit(0)
    if action == 'discover-terminal':
        discovered = discover_terminal_state(
            root_fd, root_status, root_mount_id, argument_one,
        )
        if discovered is None:
            print('absent')
            raise SystemExit(0)
        name, opened, legacy, record, head_digest = discovered
        descriptor, current = open_entry(root_fd, root_status, root_mount_id, name, None)
        try:
            if identity(current) != identity(opened):
                reject('Migration journal terminal discovery identity changed')
            entry_identity = identity_text(current, descriptor)
        finally:
            os.close(descriptor)
        print(record['state'])
        print(name)
        print(entry_identity)
        print(record['terminal']['id'])
        raise SystemExit(0)
    if action == 'begin':
        if not run_id_pattern.fullmatch(argument_one):
            reject('Migration journal run id is invalid')
        if (
            not argument_two.startswith('/')
            or argument_three not in initial_phase_values
            or entry_name != 'active'
            or expected_identity is not None
        ):
            reject('Migration journal begin arguments are invalid')
        directories = inspect_root_entries(root_fd, root_status, root_mount_id)
        if len(directories) >= max_journal_directories:
            reject('Migration journal capacity reached; offline root maintenance is required')
        if present(root_fd, 'active'):
            descriptor, opened = open_entry(root_fd, root_status, root_mount_id, 'active', None)
            try:
                legacy, record, _names, _identities, _head = read_generation_snapshot(
                    descriptor, opened, root_mount_id,
                )
                if legacy or record['state'] != 'terminal-consumed':
                    reject('A live or unacknowledged migration journal already exists')
                consumed_name = f".terminal-consumed.{record['terminal']['id'][3:]}"
                assert_entry_matches(
                    root_fd, root_status, root_mount_id, 'active', descriptor, None,
                )
                rename_noreplace(root_fd, 'active', root_fd, consumed_name)
                assert_entry_matches(
                    root_fd, root_status, root_mount_id, consumed_name, descriptor, None,
                )
                os.fsync(root_fd)
            finally:
                os.close(descriptor)
        private_name = f'.active.initializing.{argument_one}'
        os.mkdir(private_name, 0o700, dir_fd=root_fd)
        private_fd, private_status = open_entry(
            root_fd, root_status, root_mount_id, private_name, None,
        )
        try:
            publish_anonymous_record(
                private_fd,
                private_status,
                root_mount_id,
                journal_format_name,
                (journal_format_value + '\n').encode('ascii'),
                'begin-format',
            )
            generation_zero = make_generation(
                0, None, argument_one, argument_two, argument_three, 'live', None,
            )
            publish_anonymous_record(
                private_fd,
                private_status,
                root_mount_id,
                'generation-00000000',
                canonical_bytes(generation_zero),
                'begin-generation',
            )
            legacy, record, _names, _identities, head_digest = read_generation_snapshot(
                private_fd, private_status, root_mount_id,
            )
            if legacy or record != generation_zero:
                reject('Migration journal generation zero is incomplete')
            os.fsync(private_fd)
            boundary('begin-private-dir-fsync')
            assert_entry_matches(
                root_fd, root_status, root_mount_id, private_name, private_fd, None,
            )
            rename_noreplace(root_fd, private_name, root_fd, 'active')
            assert_entry_matches(
                root_fd, root_status, root_mount_id, 'active', private_fd, None,
            )
            boundary('begin-published')
            os.fsync(root_fd)
            boundary('begin-publish-dir-fsync')
            print(identity_text(private_status, private_fd))
            print(head_digest)
        finally:
            os.close(private_fd)
        raise SystemExit(0)
    journal_fd, journal_status = open_entry(
        root_fd, root_status, root_mount_id, entry_name, expected_identity,
    )
    try:
        if action in ('bind', 'authorize', 'claim'):
            assert_entry_matches(
                root_fd, root_status, root_mount_id, entry_name, journal_fd, expected_identity,
            )
            print(identity_text(journal_status, journal_fd))
        elif action == 'read':
            legacy, record, _names, _identities, head_digest = read_generation_snapshot(
                journal_fd, journal_status, root_mount_id,
            )
            assert_entry_matches(
                root_fd, root_status, root_mount_id, entry_name, journal_fd, expected_identity,
            )
            terminal = record['terminal']
            print(identity_text(journal_status, journal_fd))
            print('1' if legacy else '0')
            print(record['runId'] or '-')
            print(record['phase'])
            print(record['operation']['backupDir'])
            print(head_digest)
            print(record['state'])
            print(terminal['id'] if terminal else '-')
            print(terminal['markerProof'] if terminal else '-')
        elif action == 'write-phase':
            legacy, current, _names, _identities, head_digest = read_generation_snapshot(
                journal_fd, journal_status, root_mount_id,
            )
            if legacy or current['state'] != 'live':
                reject('Only a live v4 migration journal can advance phase')
            if argument_one not in phase_values or argument_two != head_digest:
                reject('Migration journal phase expected-head CAS failed')
            if argument_three and argument_three != current['runId']:
                reject('Migration journal run id changed before phase publication')
            if not phase_transition_allowed(current['phase'], argument_one):
                reject('Migration journal phase successor is invalid')
            if argument_one == current['phase']:
                print(identity_text(journal_status, journal_fd))
                print(head_digest)
                raise SystemExit(0)
            after, after_digest = append_generation(
                journal_fd,
                journal_status,
                root_mount_id,
                head_digest,
                current['runId'],
                current['operation']['backupDir'],
                argument_one,
                'live',
                None,
                'phase-generation',
            )
            print(identity_text(journal_status, journal_fd))
            print(after_digest)
        elif action == 'adopt':
            legacy, current, _names, _identities, head_digest = read_generation_snapshot(
                journal_fd, journal_status, root_mount_id,
            )
            if (
                not legacy
                and current['state'] == 'live'
                and current['runId'] == argument_two
                and argument_one == argument_two
                and argument_three == head_digest
            ):
                print(identity_text(journal_status, journal_fd))
                print(head_digest)
                raise SystemExit(0)
            if (
                legacy
                or current['state'] != 'live'
                or current['runId'] != argument_one
                or not run_id_pattern.fullmatch(argument_two)
                or argument_three != head_digest
            ):
                reject('Migration journal adoption expected-head CAS failed')
            _after, after_digest = append_generation(
                journal_fd,
                journal_status,
                root_mount_id,
                head_digest,
                argument_two,
                current['operation']['backupDir'],
                current['phase'],
                'live',
                None,
                'adopt-generation',
            )
            print(identity_text(journal_status, journal_fd))
            print(after_digest)
        elif action == 'publish-terminal':
            legacy, current, _names, _identities, head_digest = read_generation_snapshot(
                journal_fd, journal_status, root_mount_id,
            )
            if legacy:
                reject('Legacy journal terminalization requires offline compatibility handling')
            if current['state'] == 'terminal-pending':
                print(identity_text(journal_status, journal_fd))
                print(head_digest)
                print(current['terminal']['id'])
                raise SystemExit(0)
            if current['state'] != 'live' or argument_two != head_digest:
                reject('Migration journal terminal expected-head CAS failed')
            marker_proof = argument_one
            if current['phase'] == 'committed':
                if not marker_proof_pattern.fullmatch(marker_proof):
                    reject('Committed terminal journal lacks exact marker proof')
            elif marker_proof != 'absent':
                reject('Pre-commit terminal journal requires marker absence')
            terminal = {
                'headDigest': head_digest,
                'id': '',
                'markerProof': marker_proof,
            }
            candidate = make_generation(
                current['sequence'] + 1,
                head_digest,
                current['runId'],
                current['operation']['backupDir'],
                current['phase'],
                'terminal-pending',
                terminal,
            )
            terminal['id'] = terminal_id_for(candidate)
            _after, after_digest = append_generation(
                journal_fd,
                journal_status,
                root_mount_id,
                head_digest,
                current['runId'],
                current['operation']['backupDir'],
                current['phase'],
                'terminal-pending',
                terminal,
                'terminal-pending',
            )
            print(identity_text(journal_status, journal_fd))
            print(after_digest)
            print(terminal['id'])
        elif action == 'ack-terminal':
            legacy, current, _names, _identities, head_digest = read_generation_snapshot(
                journal_fd, journal_status, root_mount_id,
            )
            if current['state'] not in ('terminal-pending', 'terminal-consumed'):
                reject('Migration journal is not awaiting explicit acknowledgement')
            if argument_one != current['terminal']['id']:
                if legacy:
                    reject('Migration journal legacy acknowledgement id is stale or invalid')
                reject('Migration journal terminal acknowledgement id is stale or invalid')
            if current['state'] == 'terminal-consumed':
                print(identity_text(journal_status, journal_fd))
                print(head_digest)
                print(current['terminal']['id'])
                raise SystemExit(0)
            if argument_two != head_digest:
                reject('Migration journal acknowledgement expected-head CAS failed')
            if legacy:
                if current['phase'] == 'committed':
                    if not marker_proof_pattern.fullmatch(argument_three):
                        reject('Migration journal legacy committed acknowledgement lacks marker proof')
                elif argument_three != 'absent':
                    reject('Migration journal legacy pre-commit acknowledgement requires marker absence')
                acknowledgement = {
                    'headDigest': head_digest,
                    'markerProof': argument_three,
                    'operation': current['operation'],
                    'phase': current['phase'],
                    'rootAnchor': bound_root_token,
                    'runId': current['runId'],
                    'schemaVersion': 1,
                    'state': 'terminal-consumed',
                    'terminalId': current['terminal']['id'],
                }
                publish_anonymous_record(
                    journal_fd,
                    journal_status,
                    root_mount_id,
                    legacy_explicit_ack_name,
                    canonical_bytes(acknowledgement),
                    'terminal-consumed',
                )
                legacy_after, after, _after_names, _after_identities, after_digest = (
                    read_generation_snapshot(journal_fd, journal_status, root_mount_id)
                )
                if (
                    not legacy_after
                    or after['state'] != 'terminal-consumed'
                    or after['terminal']['id'] != argument_one
                    or after_digest != head_digest
                ):
                    reject('Migration journal legacy acknowledgement publication was not coherent')
                print(identity_text(journal_status, journal_fd))
                print(after_digest)
                print(after['terminal']['id'])
                raise SystemExit(0)
            if argument_three != current['terminal']['markerProof']:
                reject('Migration journal acknowledgement marker proof changed')
            _after, after_digest = append_generation(
                journal_fd,
                journal_status,
                root_mount_id,
                head_digest,
                current['runId'],
                current['operation']['backupDir'],
                current['phase'],
                'terminal-consumed',
                current['terminal'],
                'terminal-consumed',
            )
            print(identity_text(journal_status, journal_fd))
            print(after_digest)
            print(current['terminal']['id'])
        elif action in ('retire', 'consume-terminal'):
            reject('Migration journal legacy terminal mutation is forbidden')
        else:
            reject('Unknown migration journal dirfd action')
    finally:
        os.close(journal_fd)
finally:
    os.close(root_fd)
PY
}

restore_copy() {
  local backup="$1"
  local target="$2"
  local trusted_root="$3"
  local target_relative="$4"
  local trusted_root_modes="$5"
  local allow_leaf_symlink="$6"
  local source_exact_modes="${7:-1}"
  [ "$target" = "$trusted_root/$target_relative" ] || return 1
  if [ ! -e "$trusted_root" ] && [ ! -L "$trusted_root" ]; then
    bootstrap_anchored_path_helper restore-absent-target-root "$trusted_root" "$target_relative" "$trusted_root_modes" "$allow_leaf_symlink" "$(dirname "$backup")" "$(basename "$backup")" 0700 "$source_exact_modes"
    return
  fi
  bootstrap_anchored_path_helper restore "$trusted_root" "$target_relative" "$trusted_root_modes" "$allow_leaf_symlink" "$(dirname "$backup")" "$(basename "$backup")" 0700 "$source_exact_modes"
}

bootstrap_remove_anchored_path() {
  local trusted_root="$1"
  local target_relative="$2"
  local trusted_root_modes="$3"
  local allow_leaf_symlink="${4:-0}"
  bootstrap_anchored_path_helper remove "$trusted_root" "$target_relative" "$trusted_root_modes" "$allow_leaf_symlink"
}

bootstrap_remove_anchored_fixed_tree() {
  local target_root="$1"
  local target_relative="$2"
  local target_root_modes="$3"
  local fixed_members="$4"
  bootstrap_anchored_path_helper remove-fixed "$target_root" "$target_relative" \
    "$target_root_modes" 0 "" "" 0700 0 "$fixed_members"
}

bootstrap_validate_anchored_path() {
  local trusted_root="$1"
  local target_relative="$2"
  local trusted_root_modes="$3"
  local allow_leaf_symlink="${4:-0}"
  bootstrap_anchored_path_helper validate "$trusted_root" "$target_relative" "$trusted_root_modes" "$allow_leaf_symlink"
}

bootstrap_copy_anchored_path() {
  local source_root="$1"
  local source_relative="$2"
  local source_root_modes="$3"
  local target_root="$4"
  local target_relative="$5"
  local target_root_modes="$6"
  bootstrap_anchored_path_helper copy "$target_root" "$target_relative" "$target_root_modes" 0 "$source_root" "$source_relative" "$source_root_modes"
}

validate_loopback_firewall_json() {
  NFT_RULESET_JSON="$1" python3 - <<'PYTHON'
import json
import os
import sys

try:
    document = json.loads(os.environ.get("NFT_RULESET_JSON", ""))
except (TypeError, ValueError):
    sys.exit(1)

if not isinstance(document, dict) or not isinstance(document.get("nftables"), list):
    sys.exit(1)
entries = [entry for entry in document["nftables"] if "metainfo" not in entry]
if len(entries) != 3:
    sys.exit(1)
tables = [entry["table"] for entry in entries if "table" in entry]
chains = [entry["chain"] for entry in entries if "chain" in entry]
rules = [entry["rule"] for entry in entries if "rule" in entry]
if len(tables) != 1 or len(chains) != 1 or len(rules) != 1:
    sys.exit(1)

def without_handle(value):
    result = dict(value)
    result.pop("handle", None)
    return result

expected_table = {"family": "inet", "name": "turingmarket_loopback"}
expected_chain = {
    "family": "inet",
    "table": "turingmarket_loopback",
    "name": "input",
    "type": "filter",
    "hook": "input",
    "prio": -10,
    "policy": "accept",
}
expected_rule = {
    "family": "inet",
    "table": "turingmarket_loopback",
    "chain": "input",
    "expr": [
        {"match": {"op": "!=", "left": {"meta": {"key": "iifname"}}, "right": "lo"}},
        {"match": {"op": "==", "left": {"payload": {"protocol": "tcp", "field": "dport"}}, "right": 3002}},
        {"reject": {"type": "tcp reset"}},
    ],
    "comment": "turingmarket-loopback-only-3002",
}
if without_handle(tables[0]) != expected_table:
    sys.exit(1)
if without_handle(chains[0]) != expected_chain:
    sys.exit(1)
if without_handle(rules[0]) != expected_rule:
    sys.exit(1)
PYTHON
}

validate_loopback_firewall() {
  local ruleset
  ruleset="$("$NFT_BIN" -j list table inet "$FIREWALL_TABLE")" || return 1
  validate_loopback_firewall_json "$ruleset"
}

validate_pm2_release_process() {
  local expected_script="$LIVE_DIR/server/server.js" snapshot expected_cwd_b64 expected_script_b64
  [ -d "$LIVE_DIR" ] && [ ! -L "$LIVE_DIR" ] || return 1
  [ "$(bootstrap_trusted_realpath -e -- "$LIVE_DIR")" = "$LIVE_DIR" ] || return 1
  [ -f "$expected_script" ] && [ ! -L "$expected_script" ] || return 1
  [ "$(bootstrap_trusted_realpath -e -- "$expected_script")" = "$expected_script" ] || return 1
  snapshot="$(run_persistent_runtime_command pm2 jlist)" || return 1
  expected_cwd_b64="$(builtin printf '%s' "$LIVE_DIR" | base64 | tr -d '\n')" || return 1
  expected_script_b64="$(builtin printf '%s' "$expected_script" | base64 | tr -d '\n')" || return 1
  PM2_RELEASE_SNAPSHOT="$snapshot" \
  PM2_EXPECTED_CWD_B64="$expected_cwd_b64" \
  PM2_EXPECTED_SCRIPT_B64="$expected_script_b64" \
  node <<'NODE'
const expectedCwd = Buffer.from(process.env.PM2_EXPECTED_CWD_B64, 'base64').toString('utf8');
const expectedScript = Buffer.from(process.env.PM2_EXPECTED_SCRIPT_B64, 'base64').toString('utf8');
let processes;
try {
  processes = JSON.parse(process.env.PM2_RELEASE_SNAPSHOT);
} catch {
  process.exit(1);
}
if (!Array.isArray(processes)) process.exit(1);
const matches = processes.filter((entry) => (
  entry !== null
  && typeof entry === 'object'
  && !Array.isArray(entry)
  && entry.name === 'turingmarket'
));
if (matches.length !== 1) process.exit(1);
const entry = matches[0];
const environment = entry.pm2_env;
if (
  !Number.isInteger(entry.pid)
  || entry.pid <= 0
  || environment === null
  || typeof environment !== 'object'
  || Array.isArray(environment)
  || environment.status !== 'online'
  || environment.pm_cwd !== expectedCwd
  || environment.pm_exec_path !== expectedScript
) process.exit(1);
process.stdout.write(String(entry.pid) + '\n');
NODE
}

validate_loopback_listener_output() {
  local output="$1"
  local expected_pid="${2:-}" line state recv_q send_q endpoint peer process_info
  local process_pattern='^users:\(\("[^"]+",pid=([1-9][0-9]*),fd=[0-9]+\)\)$'
  local count=0

  [[ "$expected_pid" =~ ^[1-9][0-9]*$ ]] || return 1

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    state=""; recv_q=""; send_q=""; endpoint=""; peer=""; process_info=""
    read -r state recv_q send_q endpoint peer process_info <<< "$line" || return 1
    [ "$state" = "LISTEN" ] || return 1
    [ "$endpoint" = "127.0.0.1:3002" ] || return 1
    [ "$peer" = "0.0.0.0:*" ] || return 1
    [[ "$process_info" =~ $process_pattern ]] || return 1
    [ "${BASH_REMATCH[1]}" = "$expected_pid" ] || return 1
    count=$((count + 1))
  done <<< "$output"

  [ "$count" = "1" ]
}

validate_loopback_listener() {
  local expected_pid="$1" listeners
  listeners="$(ss -H -ltnp 'sport = :3002')" || return 1
  validate_loopback_listener_output "$listeners" "$expected_pid"
}

write_loopback_firewall_candidates() {
  local candidate_dir="$1"
  local rules="$candidate_dir/rules.nft"
  local helper="$candidate_dir/helper"
  local service="$candidate_dir/service"
  local dropin="$candidate_dir/pm2-dropin"

  bootstrap_remove_anchored_fixed_tree \
    "$(dirname "$candidate_dir")" "${candidate_dir##*/}" 0700 \
    'candidate,candidate/rules.nft,candidate/helper,candidate/service,candidate/pm2-dropin' || return 1
  mkdir -m 0700 "$candidate_dir" || return 1
  cat > "$rules" <<'NFT_RULES' || return 1
destroy table inet turingmarket_loopback
table inet turingmarket_loopback {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname != "lo" tcp dport 3002 reject with tcp reset comment "turingmarket-loopback-only-3002"
  }
}
NFT_RULES
  {
    printf '%s\n' '#!/bin/bash -p' 'set -Eeuo pipefail' 'umask 077'
    printf 'NFT_BIN=%q\n' "$NFT_BIN"
    printf 'RULE_FILE=%q\n' "$FIREWALL_RULE_FILE"
    printf 'TABLE_NAME=%q\n' "$FIREWALL_TABLE"
    cat <<'FIREWALL_HELPER_BODY'
case "${1:-}" in
  apply)
    "$NFT_BIN" --check -f "$RULE_FILE"
    "$NFT_BIN" -f "$RULE_FILE"
    ;;
  remove)
    if "$NFT_BIN" list table inet "$TABLE_NAME" >/dev/null 2>&1; then
      "$NFT_BIN" delete table inet "$TABLE_NAME"
    fi
    ;;
  *)
    printf '%s\n' "Usage: $0 {apply|remove}" >&2
    exit 64
    ;;
esac
FIREWALL_HELPER_BODY
  } > "$helper" || return 1
  cat > "$service" <<EOF || return 1
[Unit]
Description=TuringMarket loopback-only backend firewall
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target
Before=pm2-root.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$FIREWALL_HELPER apply
ExecReload=$FIREWALL_HELPER apply
ExecStop=$FIREWALL_HELPER remove

[Install]
WantedBy=multi-user.target
EOF
  cat > "$dropin" <<EOF || return 1
[Unit]
Requires=$FIREWALL_UNIT
After=$FIREWALL_UNIT
EOF
  chmod 0600 "$rules" || return 1
  chmod 0700 "$helper" || return 1
  chmod 0644 "$service" "$dropin" || return 1
  bootstrap_trusted_bash -n "$helper" || return 1
  "$NFT_BIN" --check -f "$rules" || return 1
}

validate_loopback_firewall_artifacts() {
  local candidate_dir="$1"
  local expected_owner="root:root"
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    expected_owner="$(bootstrap_trusted_id -un):$(bootstrap_trusted_id -gn)"
  fi
  for path in "$FIREWALL_RULE_FILE" "$FIREWALL_HELPER" "$FIREWALL_SERVICE_FILE" "$PM2_FIREWALL_DROPIN_FILE"; do
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    [ "$(bootstrap_trusted_stat -c '%U:%G' "$path")" = "$expected_owner" ] || return 1
  done
  [ "$(bootstrap_trusted_stat -c '%a' "$FIREWALL_RULE_FILE")" = "600" ] || return 1
  [ "$(bootstrap_trusted_stat -c '%a' "$FIREWALL_HELPER")" = "700" ] || return 1
  [ "$(bootstrap_trusted_stat -c '%a' "$FIREWALL_SERVICE_FILE")" = "644" ] || return 1
  [ "$(bootstrap_trusted_stat -c '%a' "$PM2_FIREWALL_DROPIN_FILE")" = "644" ] || return 1
  cmp -s "$candidate_dir/rules.nft" "$FIREWALL_RULE_FILE" || return 1
  cmp -s "$candidate_dir/helper" "$FIREWALL_HELPER" || return 1
  cmp -s "$candidate_dir/service" "$FIREWALL_SERVICE_FILE" || return 1
  cmp -s "$candidate_dir/pm2-dropin" "$PM2_FIREWALL_DROPIN_FILE" || return 1
}

loopback_firewall_installation_is_exact() {
  local candidate_dir="$1"
  validate_loopback_firewall_artifacts "$candidate_dir" || return 1
  systemctl is-enabled --quiet "$FIREWALL_UNIT" || return 1
  systemctl is-active --quiet "$FIREWALL_UNIT" || return 1
  validate_loopback_firewall
}

snapshot_loopback_firewall_installation() {
  local backup="$1"
  mkdir -m 0700 "$backup" || return 1
  copy_existing_path "$FIREWALL_RULE_FILE" "$backup/rules" || return 1
  copy_existing_path "$FIREWALL_HELPER" "$backup/helper" || return 1
  copy_existing_path "$FIREWALL_SERVICE_FILE" "$backup/service" || return 1
  copy_existing_path "$PM2_FIREWALL_DROPIN_FILE" "$backup/pm2-dropin" || return 1
  if systemctl is-enabled --quiet "$FIREWALL_UNIT"; then : > "$backup/unit.enabled" || return 1; else : > "$backup/unit.disabled" || return 1; fi
  if systemctl is-active --quiet "$FIREWALL_UNIT"; then : > "$backup/unit.active" || return 1; else : > "$backup/unit.inactive" || return 1; fi
  if "$NFT_BIN" -j list table inet "$FIREWALL_TABLE" > "$backup/table.json" 2>/dev/null; then
    validate_loopback_firewall_json "$(cat "$backup/table.json")" || return 1
    : > "$backup/table.present" || return 1
  else
    rm -f "$backup/table.json" || return 1
    if "$NFT_BIN" list table inet "$FIREWALL_TABLE" >/dev/null 2>&1; then
      return 1
    fi
    : > "$backup/table.absent" || return 1
  fi
}

restore_loopback_firewall_installation() {
  local backup="$1"
  local failed=0
  systemctl stop "$FIREWALL_UNIT" >/dev/null 2>&1 || true
  systemctl disable "$FIREWALL_UNIT" >/dev/null 2>&1 || true
  if [ -f "$backup/table.absent" ] && "$NFT_BIN" list table inet "$FIREWALL_TABLE" >/dev/null 2>&1; then
    "$NFT_BIN" delete table inet "$FIREWALL_TABLE" || failed=1
  fi
  restore_copy "$backup/rules" "$FIREWALL_RULE_FILE" "$ENV_DIR" "${FIREWALL_RULE_FILE##*/}" 0700 0 0 || failed=1
  restore_copy "$backup/helper" "$FIREWALL_HELPER" "$LOCAL_SBIN_DIR" "${FIREWALL_HELPER##*/}" 0755 0 0 || failed=1
  restore_copy "$backup/service" "$FIREWALL_SERVICE_FILE" "$SYSTEMD_UNIT_DIR" "${FIREWALL_SERVICE_FILE##*/}" 0755 0 0 || failed=1
  restore_copy "$backup/pm2-dropin" "$PM2_FIREWALL_DROPIN_FILE" "$SYSTEMD_UNIT_DIR" "${PM2_FIREWALL_DROPIN_DIR##*/}/${PM2_FIREWALL_DROPIN_FILE##*/}" 0755 0 0 || failed=1
  systemctl daemon-reload || failed=1
  if [ -f "$backup/unit.enabled" ]; then
    systemctl enable "$FIREWALL_UNIT" || failed=1
  else
    systemctl disable "$FIREWALL_UNIT" >/dev/null 2>&1 || true
  fi
  if [ -f "$backup/unit.active" ]; then
    systemctl start "$FIREWALL_UNIT" || failed=1
  else
    systemctl stop "$FIREWALL_UNIT" >/dev/null 2>&1 || true
  fi
  if [ -f "$backup/table.present" ]; then
    validate_loopback_firewall || failed=1
  elif "$NFT_BIN" list table inet "$FIREWALL_TABLE" >/dev/null 2>&1; then
    failed=1
  fi
  [ "$failed" = "0" ]
}

commit_loopback_firewall_installation() {
  local candidate_dir="$1"
  install -d -m 0700 "$ENV_DIR" || return 1
  install -d -m 0755 "$LOCAL_SBIN_DIR" "$SYSTEMD_UNIT_DIR" "$PM2_FIREWALL_DROPIN_DIR" || return 1
  install -m 0600 "$candidate_dir/rules.nft" "$FIREWALL_RULE_FILE" || return 1
  install -m 0700 "$candidate_dir/helper" "$FIREWALL_HELPER" || return 1
  install -m 0644 "$candidate_dir/service" "$FIREWALL_SERVICE_FILE" || return 1
  install -m 0644 "$candidate_dir/pm2-dropin" "$PM2_FIREWALL_DROPIN_FILE" || return 1
  systemctl daemon-reload || return 1
  "$FIREWALL_HELPER" apply || return 1
  validate_loopback_firewall || return 1
  systemctl enable "$FIREWALL_UNIT" || return 1
  systemctl start "$FIREWALL_UNIT" || return 1
  loopback_firewall_installation_is_exact "$candidate_dir"
}

install_loopback_firewall() {
  local transaction="$BACKUP_DIR/loopback-firewall-install"
  local candidate_dir="$transaction/candidate"
  local prior="$transaction/prior"
  [ -x "$NFT_BIN" ] || { printf '%s\n' "nft executable is unavailable: $NFT_BIN" >&2; return 1; }
  command -v python3 >/dev/null || return 1
  command -v systemctl >/dev/null || return 1
  command -v ss >/dev/null || return 1
  for path in "$FIREWALL_RULE_FILE" "$FIREWALL_HELPER" "$FIREWALL_SERVICE_FILE" "$PM2_FIREWALL_DROPIN_FILE"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      [ -f "$path" ] && [ ! -L "$path" ] || { printf '%s\n' "Unsafe firewall artifact path: $path" >&2; return 1; }
    fi
  done
  bootstrap_remove_anchored_fixed_tree \
    "$BACKUP_DIR" "${transaction##*/}" 0700 \
    'loopback-firewall-install,loopback-firewall-install/candidate,loopback-firewall-install/candidate/rules.nft,loopback-firewall-install/candidate/helper,loopback-firewall-install/candidate/service,loopback-firewall-install/candidate/pm2-dropin,loopback-firewall-install/prior,loopback-firewall-install/prior/rules,loopback-firewall-install/prior/rules.present,loopback-firewall-install/prior/rules.absent,loopback-firewall-install/prior/helper,loopback-firewall-install/prior/helper.present,loopback-firewall-install/prior/helper.absent,loopback-firewall-install/prior/service,loopback-firewall-install/prior/service.present,loopback-firewall-install/prior/service.absent,loopback-firewall-install/prior/pm2-dropin,loopback-firewall-install/prior/pm2-dropin.present,loopback-firewall-install/prior/pm2-dropin.absent,loopback-firewall-install/prior/unit.enabled,loopback-firewall-install/prior/unit.disabled,loopback-firewall-install/prior/unit.active,loopback-firewall-install/prior/unit.inactive,loopback-firewall-install/prior/table.json,loopback-firewall-install/prior/table.present,loopback-firewall-install/prior/table.absent' || return 1
  mkdir -m 0700 "$transaction" || return 1
  write_loopback_firewall_candidates "$candidate_dir" || return 1
  if loopback_firewall_installation_is_exact "$candidate_dir"; then
    printf '%s\n' "LOOPBACK_FIREWALL_ALREADY_APPLIED"
    return 0
  fi
  snapshot_loopback_firewall_installation "$prior" || return 1
  if commit_loopback_firewall_installation "$candidate_dir"; then
    printf '%s\n' "LOOPBACK_FIREWALL_OK"
    return 0
  fi
  printf '%s\n' "Loopback firewall installation failed; restoring prior state" >&2
  if ! restore_loopback_firewall_installation "$prior"; then
    printf '%s\n' "Loopback firewall rollback failed; application must remain stopped" >&2
  fi
  return 1
}

install_loopback_firewall_for_recovery() {
  local migration_backup="$1"
  local recovery_backup="$BACKUP_ROOT/v030-runtime-firewall-recovery-$STAMP"
  local status
  case "$migration_backup" in
    "$BACKUP_ROOT"/v030-runtime-bootstrap-*) ;;
    *) printf '%s\n' "Firewall recovery source backup path is invalid" >&2; return 1 ;;
  esac
  mkdir -p "$recovery_backup" || return 1
  if (
    BACKUP_DIR="$recovery_backup"
    install_loopback_firewall
  ); then
    status=0
  else
    status=$?
  fi
  (cd "$recovery_backup" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS) || return 1
  chmod -R go-rwx "$recovery_backup" || return 1
  return "$status"
}

stop_current_release() {
  validate_sanitizer_gate_idle_state || return 1
  run_persistent_runtime_command pm2 stop turingmarket
}

restart_current_release() {
  validate_sanitizer_gate_idle_state || return 1
  if ! validate_loopback_firewall; then
    run_persistent_runtime_command pm2 stop turingmarket >/dev/null 2>&1 || true
    printf '%s\n' "Loopback firewall invariant failed; refusing to start TuringMarket" >&2
    return 1
  fi
  cd "$LIVE_DIR" || return 1
  if ! run_persistent_runtime_command pm2 restart ecosystem.config.js --only turingmarket --update-env; then
    run_persistent_runtime_command pm2 start ecosystem.config.js --only turingmarket --update-env || return 1
  fi
  for _attempt in $(seq 1 30); do
    if validate_current_release_health; then
      return 0
    fi
    sleep 1
  done
  run_persistent_runtime_command pm2 stop turingmarket >/dev/null 2>&1 || true
  printf '%s\n' "Managed backend identity, listener ownership, or health validation failed; process stopped" >&2
  return 1
}

validate_current_release_health() {
  local managed_pid confirmed_pid
  managed_pid="$(validate_pm2_release_process)" || return 1
  validate_loopback_listener "$managed_pid" || return 1
  curl -fsS http://127.0.0.1:3002/api/health >/dev/null || return 1
  confirmed_pid="$(validate_pm2_release_process)" || return 1
  [ "$confirmed_pid" = "$managed_pid" ] || return 1
  validate_loopback_listener "$managed_pid"
}

database_backup() {
  local source="$1"
  local destination="$2"
  cd "$LIVE_DIR/server" || return 1
  DB_BACKUP_SOURCE="$source" DB_BACKUP_DESTINATION="$destination" node <<'NODE' || return 1
const Database = require('better-sqlite3');
const source = new Database(process.env.DB_BACKUP_SOURCE, { readonly: true, fileMustExist: true });
source.backup(process.env.DB_BACKUP_DESTINATION)
  .then(() => source.close())
  .catch((error) => {
    source.close();
    console.error(error.message);
    process.exitCode = 1;
  });
NODE
}

database_quick_check() {
  cd "$LIVE_DIR/server" || return 1
  DB_QUICK_CHECK_PATH="$1" node <<'NODE' || return 1
const Database = require('better-sqlite3');
const database = new Database(process.env.DB_QUICK_CHECK_PATH, { readonly: true, fileMustExist: true });
const result = database.pragma('quick_check', { simple: true });
database.close();
if (result !== 'ok') throw new Error(`SQLite quick_check failed: ${result}`);
console.log('DB_QUICK_CHECK=ok');
NODE
}

validate_exact_link() {
  local link="$1"
  local target="$2"
  [ -L "$link" ] && [ "$(bootstrap_trusted_readlink "$link")" = "$target" ]
}

validate_external_runtime() {
  local expected_owner
  expected_owner="$(expected_bootstrap_owner)" || return 1
  [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || return 1
  [ -f "$DB_DIR/turingmarket.db" ] && [ ! -L "$DB_DIR/turingmarket.db" ] || return 1
  [ "$(bootstrap_trusted_realpath -e "$ENV_FILE")" = "$ENV_FILE" ] || return 1
  [ "$(bootstrap_trusted_realpath -e "$DB_DIR/turingmarket.db")" = "$DB_DIR/turingmarket.db" ] || return 1
  [ "$(bootstrap_trusted_stat -c '%U:%G:%a:%h' "$ENV_FILE")" = "$expected_owner:600:1" ] || return 1
  [ "$(bootstrap_trusted_stat -c '%U:%G:%a:%h' "$DB_DIR/turingmarket.db")" = "$expected_owner:600:1" ] || return 1
  for directory in "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR"; do
    [ -d "$directory" ] || return 1
    [ ! -L "$directory" ] || return 1
    [ "$(bootstrap_trusted_realpath -e "$directory")" = "$directory" ] || return 1
    [ "$(bootstrap_trusted_stat -c '%U:%G:%a' "$directory")" = "$expected_owner:700" ] || return 1
  done
}

validate_gate_identity_values() {
  local passwd_line="$1"
  local group_line="$2"
  local group_names="$3"
  local password_status="$4"
  local name _password uid gid _gecos home shell
  local group_name _group_password group_gid _members

  IFS=: read -r name _password uid gid _gecos home shell <<< "$passwd_line"
  IFS=: read -r group_name _group_password group_gid _members <<< "$group_line"
  if [ "$name" != "$GATE_USER" ]; then printf '%s\n' "Gate username drift" >&2; return 1; fi
  if ! [[ "$uid" =~ ^[0-9]+$ ]] || [ "$uid" -eq 0 ] || [ "$uid" -ge 1000 ]; then printf '%s\n' "Gate UID is not an unprivileged system UID" >&2; return 1; fi
  if ! [[ "$gid" =~ ^[0-9]+$ ]] || [ "$group_name" != "$GATE_USER" ] || [ "$gid" != "$group_gid" ]; then printf '%s\n' "Gate primary group drift" >&2; return 1; fi
  if [ "$home" != "$GATE_ROOT" ]; then printf '%s\n' "Gate home drift" >&2; return 1; fi
  if [ "$shell" != "/usr/sbin/nologin" ]; then printf '%s\n' "Gate shell is not nologin" >&2; return 1; fi
  if [ "$group_names" != "$GATE_USER" ]; then printf '%s\n' "Gate supplementary group drift" >&2; return 1; fi
  if [ "$password_status" != "L" ]; then printf '%s\n' "Gate credentials are not locked" >&2; return 1; fi
}

validate_gate_identity() {
  local passwd_line group_line group_names password_status
  passwd_line="$(getent passwd "$GATE_USER")" || return 1
  group_line="$(getent group "$GATE_USER")" || return 1
  group_names="$(bootstrap_trusted_id -nG "$GATE_USER")" || return 1
  password_status="$(passwd -S "$GATE_USER" | awk '{print $2}')" || return 1
  validate_gate_identity_values "$passwd_line" "$group_line" "$group_names" "$password_status"
}

sync_directory() {
  sync -f "$1" || return 1
}

bind_migration_journal_root() {
  JOURNAL_ROOT_TOKEN="$(bootstrap_journal_dirfd_helper bind-root active "")" || return 1
  [[ "$JOURNAL_ROOT_TOKEN" =~ ^r2:[0-9a-f]{64}$ ]]
}

reserve_migration_journal_capacity() {
  local terminal_id="${1:-}" lock_identity fd_identity result
  bootstrap_require_no_generation_phase_stages || return 1
  if [ "$JOURNAL_CAPACITY_RESERVED" = "1" ]; then
    result="$(bootstrap_journal_dirfd_helper reserve-capacity active "" "$terminal_id")" || return 1
    case "$result" in
      general|terminal-only|existing-live)
        JOURNAL_RESERVATION_MODE="$result"
        return 0
        ;;
      full)
        printf '%s\n' "Migration journal capacity is full; offline root maintenance is required" >&2
        release_migration_journal_capacity_reservation || true
        return 1
        ;;
      *)
        release_migration_journal_capacity_reservation || true
        return 1
        ;;
    esac
  fi
  path_entry_present_no_follow "$JOURNAL_ROOT" || {
    printf '%s\n' "Migration journal root must be provisioned before bootstrap" >&2
    return 1
  }
  real_directory_no_follow "$JOURNAL_ROOT" || return 1
  [ "$(bootstrap_trusted_realpath -e "$JOURNAL_ROOT")" = "$JOURNAL_ROOT" ] || return 1
  [ "$(bootstrap_trusted_stat -c '%U:%G:%a' "$JOURNAL_ROOT")" = "$(expected_bootstrap_owner):700" ] || return 1
  bind_migration_journal_root || return 1
  lock_identity="$(bootstrap_journal_dirfd_helper ensure-lock active "")" || return 1
  exec 7<"$JOURNAL_ROOT/.journal-protocol.lock" || return 1
  fd_identity="$(bootstrap_trusted_stat -Lc '%d:%i' "/proc/$BASHPID/fd/7")" || { exec 7>&-; return 1; }
  [ "$fd_identity" = "${lock_identity%:*}" ] || { exec 7>&-; return 1; }
  bootstrap_trusted_flock -n 7 || {
    printf '%s\n' "Another migration journal protocol owner is active" >&2
    exec 7>&-
    return 1
  }
  JOURNAL_CAPACITY_RESERVED=1
  [ "$(bootstrap_journal_dirfd_helper verify-reservation active "")" = "$lock_identity" ] || {
    release_migration_journal_capacity_reservation || true
    return 1
  }
  result="$(bootstrap_journal_dirfd_helper reserve-capacity active "" "$terminal_id")" || {
    release_migration_journal_capacity_reservation || true
    return 1
  }
  case "$result" in
    general|terminal-only|existing-live) ;;
    full)
      printf '%s\n' "Migration journal capacity is full; offline root maintenance is required" >&2
      release_migration_journal_capacity_reservation || true
      return 1
      ;;
    *)
      release_migration_journal_capacity_reservation || true
      return 1
      ;;
  esac
  JOURNAL_RESERVATION_MODE="$result"
}

release_migration_journal_capacity_reservation() {
  if [ "$JOURNAL_CAPACITY_RESERVED" = "1" ]; then
    bootstrap_trusted_flock -u 7 || return 1
    exec 7>&-
  fi
  JOURNAL_CAPACITY_RESERVED=0
  JOURNAL_RESERVATION_MODE=""
  JOURNAL_ROOT_TOKEN=""
}

migration_phase_transition_allowed() {
  local current="$1" target="$2"
  if [ "$current" = "$target" ]; then
    return 0
  fi
  case "$current:$target" in
    stopping:snapshotting|snapshotting:prepared|prepared:installing|installing:linked|linked:committed) ;;
    *) return 1 ;;
  esac
}

set_migration_phase() {
  local phase="$1"
  local result
  local -a values
  case "$phase" in
    stopping|snapshotting|prepared|installing|linked|committed) ;;
    *) die "Invalid migration phase: $phase"; return 1 ;;
  esac
  [ -n "$JOURNAL_DIR_IDENTITY" ] || { die "Migration journal directory is not identity-bound"; return 1; }
  if [ -z "$JOURNAL_HEAD_DIGEST" ] || [ -z "${JOURNAL_PHASE:-}" ]; then
    read_journal || return 1
  fi
  migration_phase_transition_allowed "$JOURNAL_PHASE" "$phase" || {
    printf '%s\n' "Invalid migration phase transition: $JOURNAL_PHASE -> $phase" >&2
    return 1
  }
  result="$(bootstrap_journal_dirfd_helper write-phase \
    "$JOURNAL_ENTRY_NAME" "$JOURNAL_DIR_IDENTITY" \
    "$phase" "$JOURNAL_HEAD_DIGEST" "$JOURNAL_OWNER_TOKEN")" || return 1
  mapfile -t values <<< "$result"
  [ "${#values[@]}" = 2 ] && [ "${values[0]}" = "$JOURNAL_DIR_IDENTITY" ] || return 1
  [[ "${values[1]}" =~ ^[0-9a-f]{64}$ ]] || return 1
  JOURNAL_HEAD_DIGEST="${values[1]}"
  JOURNAL_PHASE="$phase"
}

begin_migration_journal() {
  local initial_phase="${1:-stopping}" result
  local -a values
  reserve_migration_journal_capacity || return 1
  case "$initial_phase" in
    stopping|committed) ;;
    *) return 1 ;;
  esac
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=""
  JOURNAL_LEGACY_TEST=0
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_TERMINAL_ID=""
  JOURNAL_HEAD_DIGEST=""
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=""
  result="$(bootstrap_journal_dirfd_helper begin active "" \
    "$BOOTSTRAP_OWNER_TOKEN" "$BACKUP_DIR" "$initial_phase")" \
    || { die "Unable to create and bind the active migration journal"; return 1; }
  mapfile -t values <<< "$result"
  [ "${#values[@]}" = 2 ] || return 1
  JOURNAL_DIR_IDENTITY="${values[0]}"
  JOURNAL_HEAD_DIGEST="${values[1]}"
  [[ "$JOURNAL_DIR_IDENTITY" =~ ^j2:[0-9a-f]{64}:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$ ]] || return 1
  [[ "$JOURNAL_HEAD_DIGEST" =~ ^[0-9a-f]{64}$ ]] || return 1
  JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
  JOURNAL_PHASE="$initial_phase"
  JOURNAL_BACKUP_DIR="$BACKUP_DIR"
  JOURNAL_PRESENT=1
}

clear_migration_journal() {
  local terminal_output="${1:-emit}" marker_state marker_proof result observed_proof
  local -a values
  case "$terminal_output" in emit|quiet) ;; *) return 1 ;; esac
  [ -n "$JOURNAL_DIR_IDENTITY" ] || {
    printf '%s\n' "Migration journal cleanup lacks a bound directory identity" >&2
    return 1
  }
  read_journal || return 1
  if [ "$JOURNAL_TERMINAL_STATE" = terminal-pending ]; then
    BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=terminal-pending
    if [ "$terminal_output" = emit ]; then
      printf 'BOOTSTRAP_TERMINAL_ID=%s\n' "$JOURNAL_TERMINAL_ID"
    fi
    return 0
  fi
  [ "$JOURNAL_TERMINAL_STATE" = live ] || return 1
  if [ "$JOURNAL_PHASE" = committed ]; then
    commit_external_layout_marker || return 1
    validate_external_layout_marker || return 1
    marker_proof="$EXTERNAL_LAYOUT_MARKER_PROOF"
  else
    marker_state="$(external_layout_marker_state)" || return 1
    [ "$marker_state" = absent ] || {
      printf '%s\n' "Pre-commit migration journal conflicts with a permanent layout marker" >&2
      return 1
    }
    marker_proof=absent
  fi
  result="$(bootstrap_journal_dirfd_helper publish-terminal \
    "$JOURNAL_ENTRY_NAME" "$JOURNAL_DIR_IDENTITY" \
    "$marker_proof" "$JOURNAL_HEAD_DIGEST" terminal)" || return 1
  mapfile -t values <<< "$result"
  [ "${#values[@]}" = 3 ] && [ "${values[0]}" = "$JOURNAL_DIR_IDENTITY" ] || return 1
  [[ "${values[1]}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${values[2]}" =~ ^t1:[0-9a-f]{64}$ ]] || return 1
  if [ "$JOURNAL_PHASE" = committed ]; then
    validate_external_layout_marker || return 1
    observed_proof="$EXTERNAL_LAYOUT_MARKER_PROOF"
    [ "$observed_proof" = "$marker_proof" ] || return 1
  else
    marker_state="$(external_layout_marker_state)" || return 1
    [ "$marker_state" = absent ] || return 1
  fi
  JOURNAL_HEAD_DIGEST="${values[1]}"
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID="${values[2]}"
  JOURNAL_MARKER_PROOF="$marker_proof"
  JOURNAL_PROVENANCE_VALIDATED=1
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=terminal-pending
  if [ "$terminal_output" = emit ]; then
    printf 'BOOTSTRAP_TERMINAL_ID=%s\n' "$JOURNAL_TERMINAL_ID"
  fi
}

read_journal() {
  local expected_owner journal_output actual_identity
  local -a journal_values
  expected_owner="$(expected_bootstrap_owner):700"
  journal_output="$(bootstrap_journal_dirfd_helper read \
    "$JOURNAL_ENTRY_NAME" "${JOURNAL_DIR_IDENTITY:-}")" || return 1
  mapfile -t journal_values <<< "$journal_output"
  [ "${#journal_values[@]}" = "9" ] || {
    printf '%s\n' "Migration journal helper returned an invalid field set" >&2
    return 1
  }
  actual_identity="${journal_values[0]}"
  if [ -n "$JOURNAL_DIR_IDENTITY" ] && [ "$actual_identity" != "$JOURNAL_DIR_IDENTITY" ]; then
    printf '%s\n' "Migration journal identity changed while reading" >&2
    return 1
  fi
  JOURNAL_DIR_IDENTITY="$actual_identity"
  JOURNAL_LEGACY_TEST="${journal_values[1]}"
  JOURNAL_OWNER_TOKEN="${journal_values[2]}"
  JOURNAL_PHASE="${journal_values[3]}"
  JOURNAL_BACKUP_DIR="${journal_values[4]}"
  JOURNAL_HEAD_DIGEST="${journal_values[5]}"
  JOURNAL_TERMINAL_STATE="${journal_values[6]}"
  JOURNAL_TERMINAL_ID="${journal_values[7]}"
  JOURNAL_MARKER_PROOF="${journal_values[8]}"
  [ "$JOURNAL_OWNER_TOKEN" != - ] || JOURNAL_OWNER_TOKEN=""
  [ "$JOURNAL_TERMINAL_ID" != - ] || JOURNAL_TERMINAL_ID=""
  [ "$JOURNAL_MARKER_PROOF" != - ] || JOURNAL_MARKER_PROOF=""
  [[ "$JOURNAL_HEAD_DIGEST" =~ ^[0-9a-f]{64}$ ]] || return 1
  case "$JOURNAL_TERMINAL_STATE" in
    live) [ -z "$JOURNAL_TERMINAL_ID" ] && [ -z "$JOURNAL_MARKER_PROOF" ] || return 1 ;;
    terminal-pending|terminal-consumed)
      [[ "$JOURNAL_TERMINAL_ID" =~ ^t1:[0-9a-f]{64}$ ]] || return 1
      ;;
    *) return 1 ;;
  esac
  JOURNAL_PRESENT=1
  case "$JOURNAL_BACKUP_DIR" in
    "$BACKUP_ROOT"/v030-runtime-bootstrap-*) ;;
    *) printf '%s\n' "Migration journal backup path is invalid" >&2; return 1 ;;
  esac
  if { [ "$JOURNAL_PHASE" = "stopping" ] || [ "$JOURNAL_PHASE" = "snapshotting" ]; } \
      && ! path_entry_present_no_follow "$JOURNAL_BACKUP_DIR"; then
    return 0
  fi
  [ -d "$JOURNAL_BACKUP_DIR" ] && [ ! -L "$JOURNAL_BACKUP_DIR" ] || { printf '%s\n' "Migration journal backup is missing or unsafe" >&2; return 1; }
  [ "$(bootstrap_trusted_realpath -e "$JOURNAL_BACKUP_DIR")" = "$JOURNAL_BACKUP_DIR" ] || { printf '%s\n' "Migration journal backup path is not canonical" >&2; return 1; }
  [ "$(bootstrap_trusted_stat -c '%U:%G:%a' "$JOURNAL_BACKUP_DIR")" = "$expected_owner" ] || { printf '%s\n' "Migration journal backup ownership or mode drift" >&2; return 1; }
}

adopt_migration_journal() {
  local result
  local -a values
  [ -n "$JOURNAL_DIR_IDENTITY" ] || return 1
  if [ "$JOURNAL_LEGACY_TEST" = "1" ] && [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    return 0
  fi
  [[ "$BOOTSTRAP_OWNER_TOKEN" =~ ^[0-9a-f]{32}$ ]] || return 1
  [[ "$JOURNAL_OWNER_TOKEN" =~ ^[0-9a-f]{32}$ ]] || return 1
  [ -n "$JOURNAL_HEAD_DIGEST" ] || read_journal || return 1
  result="$(bootstrap_journal_dirfd_helper adopt \
    "$JOURNAL_ENTRY_NAME" "$JOURNAL_DIR_IDENTITY" \
    "$JOURNAL_OWNER_TOKEN" "$BOOTSTRAP_OWNER_TOKEN" "$JOURNAL_HEAD_DIGEST")" || return 1
  mapfile -t values <<< "$result"
  [ "${#values[@]}" = 2 ] && [ "${values[0]}" = "$JOURNAL_DIR_IDENTITY" ] || return 1
  [[ "${values[1]}" =~ ^[0-9a-f]{64}$ ]] || return 1
  JOURNAL_HEAD_DIGEST="${values[1]}"
  JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
}

discover_migration_journal() {
  local terminal_id="${1:-}" discovery action=discover
  local -a values
  JOURNAL_PROVENANCE_VALIDATED=0
  JOURNAL_TERMINAL_STATE=""
  JOURNAL_TERMINAL_ID=""
  JOURNAL_HEAD_DIGEST=""
  if [ -n "$terminal_id" ]; then
    [[ "$terminal_id" =~ ^t1:[0-9a-f]{64}$ ]] || return 1
    action=discover-terminal
  fi
  discovery="$(bootstrap_journal_dirfd_helper "$action" active "" "$terminal_id")" || return 1
  mapfile -t values <<< "$discovery"
  if [ "${#values[@]}" = "1" ] && [ "${values[0]}" = absent ]; then
    JOURNAL_ENTRY_NAME=active
    JOURNAL_DIR_IDENTITY=""
    JOURNAL_LEGACY_TEST=0
    JOURNAL_PRESENT=0
    JOURNAL_TERMINAL_STATE=""
    JOURNAL_TERMINAL_ID=""
    return 0
  fi
  if { [ "${#values[@]}" = 3 ] && [ "${values[0]}" = live ]; } ||
      { [ "${#values[@]}" = 4 ] && {
          [ "${values[0]}" = terminal-pending ] || [ "${values[0]}" = terminal-consumed ];
        }; }; then
    JOURNAL_ENTRY_NAME="${values[1]}"
    JOURNAL_DIR_IDENTITY="${values[2]}"
    JOURNAL_TERMINAL_STATE="${values[0]}"
    JOURNAL_TERMINAL_ID="${values[3]:-}"
  else
    return 1
  fi
  JOURNAL_LEGACY_TEST=0
  JOURNAL_PRESENT=1
}

bootstrap_terminal_journal_preflight() {
  local path discovery expected_owner root_digest
  local -a candidates=() values
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=journal-terminal-uncertain
  JOURNAL_PROVENANCE_VALIDATED=0
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=""
  JOURNAL_TERMINAL_ID=""
  JOURNAL_HEAD_DIGEST=""
  JOURNAL_MARKER_PROOF=""
  if ! path_entry_present_no_follow "$JOURNAL_ROOT"; then
    BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=""
    return 0
  fi
  real_directory_no_follow "$JOURNAL_ROOT" || return 1
  if path_entry_present_no_follow "$JOURNAL_ROOT/active"; then
    candidates+=("$JOURNAL_ROOT/active")
  fi
  shopt -s nullglob
  for path in "$JOURNAL_ROOT"/.active.retired.*.*; do
    candidates+=("$path")
  done
  shopt -u nullglob
  if [ "${#candidates[@]}" = 0 ]; then
    BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=""
    return 0
  fi

  discovery="$(bootstrap_journal_dirfd_helper peek-terminal active "")" || return 1
  mapfile -t values <<< "$discovery"
  if [ "${#values[@]}" = 1 ] && [ "${values[0]}" = continue ]; then
    BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=""
    return 0
  fi
  [ "${#values[@]}" = 11 ] && [ "${values[0]}" = terminal-pending ] || return 1
  [[ "${values[1]}" =~ ^r2:[0-9a-f]{64}$ ]] || return 1
  case "${values[2]}" in
    active) ;;
    .active.retired.*.*)
      [[ "${values[2]}" =~ ^\.active\.retired\.[1-9][0-9]*\.[0-9]+$ ]] || return 1
      ;;
    *) return 1 ;;
  esac
  [[ "${values[3]}" =~ ^j2:([0-9a-f]{64}):[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$ ]] || return 1
  root_digest="${BASH_REMATCH[1]}"
  [ "$root_digest" = "${values[1]#r2:}" ] || return 1
  case "${values[4]}" in 0|1) ;; *) return 1 ;; esac
  if [ "${values[5]}" != - ]; then
    validate_bootstrap_token "${values[5]}" || return 1
  fi
  case "${values[6]}" in
    stopping|snapshotting|prepared|installing|linked|committed) ;;
    *) return 1 ;;
  esac
  case "${values[7]}" in
    "$BACKUP_ROOT"/v030-runtime-bootstrap-*) ;;
    *) printf '%s\n' "Migration journal backup path is invalid" >&2; return 1 ;;
  esac
  [[ "${values[8]}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${values[9]}" =~ ^t1:[0-9a-f]{64}$ ]] || return 1
  if [ "${values[10]}" != absent ] && \
     ! validate_external_layout_marker_proof_value "${values[10]}" && \
     ! [[ "${values[10]}" =~ ^m1:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{64}$ ]]; then
    return 1
  fi
  if ! { { [ "${values[6]}" = stopping ] || [ "${values[6]}" = snapshotting ]; } && \
         ! path_entry_present_no_follow "${values[7]}"; }; then
    expected_owner="$(expected_bootstrap_owner):700" || return 1
    [ -d "${values[7]}" ] && [ ! -L "${values[7]}" ] || return 1
    [ "$(bootstrap_trusted_realpath -e "${values[7]}")" = "${values[7]}" ] || return 1
    [ "$(bootstrap_trusted_stat -c '%U:%G:%a' "${values[7]}")" = "$expected_owner" ] || return 1
  fi

  JOURNAL_ROOT_TOKEN="${values[1]}"
  JOURNAL_ENTRY_NAME="${values[2]}"
  JOURNAL_DIR_IDENTITY="${values[3]}"
  JOURNAL_LEGACY_TEST="${values[4]}"
  JOURNAL_OWNER_TOKEN="${values[5]}"
  [ "$JOURNAL_OWNER_TOKEN" != - ] || JOURNAL_OWNER_TOKEN=""
  JOURNAL_PHASE="${values[6]}"
  JOURNAL_BACKUP_DIR="${values[7]}"
  JOURNAL_HEAD_DIGEST="${values[8]}"
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID="${values[9]}"
  JOURNAL_MARKER_PROOF="${values[10]}"
  JOURNAL_PRESENT=1
  validate_terminal_journal_marker_provenance observe preloaded || return 1
  [ "$JOURNAL_PROVENANCE_VALIDATED" = 1 ] || return 1
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=terminal-pending
  printf 'BOOTSTRAP_TERMINAL_ID=%s\n' "$JOURNAL_TERMINAL_ID"
}

preflight_migration_journal_capacity() {
  reserve_migration_journal_capacity
}

claim_migration_journal() {
  local actual_identity
  [ "$JOURNAL_PRESENT" = "1" ] && [ -n "$JOURNAL_DIR_IDENTITY" ] || return 1
  [ "$JOURNAL_TERMINAL_STATE" = live ] || return 1
  actual_identity="$(bootstrap_journal_dirfd_helper claim \
    "$JOURNAL_ENTRY_NAME" "$JOURNAL_DIR_IDENTITY")" || return 1
  [ "$actual_identity" = "$JOURNAL_DIR_IDENTITY" ] || return 1
  validate_active_migration_journal_directory
}

claim_live_journal_before_host_mutation() {
  [ "$JOURNAL_PRESENT" = 1 ] && [ "$JOURNAL_TERMINAL_STATE" = live ] || return 1
  if [ -z "$JOURNAL_OWNER_TOKEN" ]; then
    read_journal || return 1
  fi
  if [ "$JOURNAL_OWNER_TOKEN" != "$BOOTSTRAP_OWNER_TOKEN" ]; then
    adopt_migration_journal || return 1
  fi
  claim_migration_journal
}

cleanup_stages() {
  local path name
  shopt -s nullglob
  for path in "$ENV_DIR"/.turingmarket.env.new.*; do
    name="${path##*/}"
    [[ "$name" =~ ^\.turingmarket\.env\.new\.[0-9]+$ ]] || { shopt -u nullglob; return 1; }
    bootstrap_remove_anchored_path "$ENV_DIR" "$name" 0700 0 || { shopt -u nullglob; return 1; }
  done
  for path in "$STATE_ROOT"/.db.new.* "$STATE_ROOT"/.uploads.new.* "$STATE_ROOT"/.tmp.new.*; do
    name="${path##*/}"
    [[ "$name" =~ ^\.(db|uploads|tmp)\.new\.[0-9]+$ ]] || { shopt -u nullglob; return 1; }
    bootstrap_remove_anchored_path "$STATE_ROOT" "$name" 0700 0 || { shopt -u nullglob; return 1; }
  done
  shopt -u nullglob
}

snapshot_database_directory() {
  local source="$1"
  local destination="$2"
  mkdir -m 0700 "$destination" || return 1
  database_backup "$source/turingmarket.db" "$destination/turingmarket.db" || return 1
  database_quick_check "$destination/turingmarket.db" || return 1
  : > "$destination.present" || return 1
}

snapshot_runtime_state() {
  copy_existing_path "$LIVE_DIR/.env" "$STATE_BACKUP/live-env" || return 1
  snapshot_database_directory "$LIVE_DIR/server/db" "$STATE_BACKUP/live-db" || return 1
  copy_existing_path "$LIVE_DIR/uploads" "$STATE_BACKUP/live-uploads" || return 1
  copy_existing_path "$LIVE_DIR/tmp" "$STATE_BACKUP/live-tmp" || return 1
  copy_existing_path "$ENV_FILE" "$STATE_BACKUP/external-env" || return 1
  copy_existing_path "$DB_DIR" "$STATE_BACKUP/external-db" || return 1
  copy_existing_path "$UPLOAD_DIR" "$STATE_BACKUP/external-uploads" || return 1
  copy_existing_path "$TMP_DIR" "$STATE_BACKUP/external-tmp" || return 1
  if find "$STATE_BACKUP" -xdev \( -type l -o -type b -o -type c -o -type p -o -type s \) -print -quit | grep -q .; then
    printf '%s\n' "Runtime snapshot contains a link or special file" >&2
    return 1
  fi
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    chown -R root:root "$STATE_BACKUP" || return 1
  fi
  find "$STATE_BACKUP" -xdev -type d -exec chmod 0700 {} + || return 1
  find "$STATE_BACKUP" -xdev -type f -exec chmod 0600 {} + || return 1
  validate_runtime_snapshot "$BACKUP_DIR" || return 1
}

validate_runtime_snapshot() {
  local backup_dir="$1"
  local state_backup="$backup_dir/state"
  local expected_owner path marker present absent mounts
  bootstrap_reject_production_test_hooks || return 1
  expected_owner="$(expected_bootstrap_owner)" || return 1
  [ -d "$state_backup" ] && [ ! -L "$state_backup" ] || return 1
  [ "$(bootstrap_trusted_realpath -e "$state_backup")" = "$state_backup" ] || return 1
  [ "$(bootstrap_trusted_stat -c '%U:%G:%a' "$state_backup")" = "$expected_owner:700" ] || return 1
  if find "$state_backup" -xdev \( -type l -o -type b -o -type c -o -type p -o -type s \) -print -quit | grep -q .; then
    return 1
  fi
  while IFS= read -r path; do
    [ "$(bootstrap_trusted_stat -c '%U:%G:%a' "$path")" = "$expected_owner:700" ] || return 1
  done < <(find "$state_backup" -xdev -type d -print)
  while IFS= read -r path; do
    [ "$(bootstrap_trusted_stat -c '%U:%G:%a:%h' "$path")" = "$expected_owner:600:1" ] || return 1
  done < <(find "$state_backup" -xdev -type f -print)

  for marker in live-env live-db live-uploads live-tmp; do
    [ -f "$state_backup/$marker.present" ] && [ ! -e "$state_backup/$marker.absent" ] || return 1
    [ -e "$state_backup/$marker" ] && [ ! -L "$state_backup/$marker" ] || return 1
  done
  for marker in external-env external-db external-uploads external-tmp; do
    present="$state_backup/$marker.present"
    absent="$state_backup/$marker.absent"
    if [ -f "$present" ] && [ ! -e "$absent" ]; then
      [ -e "$state_backup/$marker" ] && [ ! -L "$state_backup/$marker" ] || return 1
    elif [ -f "$absent" ] && [ ! -e "$present" ]; then
      [ ! -e "$state_backup/$marker" ] && [ ! -L "$state_backup/$marker" ] || return 1
    else
      return 1
    fi
  done
  [ -f "$state_backup/live-env" ] || return 1
  [ -f "$state_backup/live-db/turingmarket.db" ] || return 1
  [ -d "$state_backup/live-uploads" ] || return 1
  [ -d "$state_backup/live-tmp" ] || return 1

  if bootstrap_test_hooks_enabled && [ "${TM_TEST_GATE_MOUNTS+x}" = "x" ]; then
    mounts="$TM_TEST_GATE_MOUNTS"
  else
    if ! mounts="$(bootstrap_findmnt -rn -o TARGET 2>/dev/null)"; then
      printf '%s\n' "Runtime snapshot mount verification failed: findmnt returned nonzero" >&2
      return 1
    fi
  fi
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    case "$path" in
      "$state_backup"|"$state_backup"/*) return 1 ;;
    esac
  done <<< "$mounts"
}

restore_runtime_snapshot() {
  local backup_dir="$1"
  local state_backup="$backup_dir/state"
  validate_sanitizer_gate_idle_state || return 1
  validate_runtime_snapshot "$backup_dir" || return 1
  if [ ! -f "$state_backup/live-env.present" ]; then printf '%s\n' "Rollback environment snapshot is missing" >&2; return 1; fi
  if [ ! -f "$state_backup/live-db.present" ]; then printf '%s\n' "Rollback database snapshot is missing" >&2; return 1; fi
  if [ ! -f "$state_backup/live-uploads.present" ]; then printf '%s\n' "Rollback uploads snapshot is missing" >&2; return 1; fi
  if [ ! -f "$state_backup/live-tmp.present" ]; then printf '%s\n' "Rollback temp snapshot is missing" >&2; return 1; fi

  stop_current_release >/dev/null 2>&1 || return 1
  restore_copy "$state_backup/live-env" "$LIVE_DIR/.env" "$LIVE_DIR" .env 0700,0755 1 || return 1
  restore_copy "$state_backup/live-db" "$LIVE_DIR/server/db" "$LIVE_DIR" server/db 0700,0755 1 || return 1
  restore_copy "$state_backup/live-uploads" "$LIVE_DIR/uploads" "$LIVE_DIR" uploads 0700,0755 1 || return 1
  restore_copy "$state_backup/live-tmp" "$LIVE_DIR/tmp" "$LIVE_DIR" tmp 0700,0755 1 || return 1
  restore_copy "$state_backup/external-env" "$ENV_FILE" "$ENV_DIR" turingmarket.env 0700 0 || return 1
  restore_copy "$state_backup/external-db" "$DB_DIR" "$STATE_ROOT" db 0700 0 || return 1
  restore_copy "$state_backup/external-uploads" "$UPLOAD_DIR" "$STATE_ROOT" uploads 0700 0 || return 1
  restore_copy "$state_backup/external-tmp" "$TMP_DIR" "$STATE_ROOT" tmp 0700 0 || return 1
  cleanup_stages || return 1
  database_quick_check "$LIVE_DIR/server/db/turingmarket.db" || return 1
  install_loopback_firewall_for_recovery "$backup_dir" || return 1
  restart_current_release || return 1
  printf '%s\n' "BOOTSTRAP_ROLLBACK_OK"
}

validate_committed_runtime_layout_provenance() {
  validate_exact_link "$LIVE_DIR/.env" "$ENV_FILE" || return 1
  validate_exact_link "$LIVE_DIR/server/db" "$DB_DIR" || return 1
  validate_exact_link "$LIVE_DIR/uploads" "$UPLOAD_DIR" || return 1
  validate_exact_link "$LIVE_DIR/tmp" "$TMP_DIR" || return 1
  validate_external_runtime || return 1
  database_quick_check "$DB_DIR/turingmarket.db"
}

bootstrap_attest_existing_layout_phase_chain() {
  local operation_backup="${1:-$BACKUP_DIR}"
  while true; do
    case "$JOURNAL_PHASE" in
      stopping)
        validate_committed_runtime_layout_provenance || return 1
        stop_current_release || return 1
        PROCESS_STOPPED=1
        bootstrap_test_sigkill existing-layout-stopping || return $?
        validate_committed_runtime_layout_provenance || return 1
        set_migration_phase snapshotting || return 1
        bootstrap_test_sigkill existing-layout-snapshotting || return $?
        ;;
      snapshotting)
        validate_committed_runtime_layout_provenance || return 1
        set_migration_phase prepared || return 1
        bootstrap_test_sigkill existing-layout-prepared || return $?
        ;;
      prepared)
        validate_committed_runtime_layout_provenance || return 1
        BACKUP_DIR="$operation_backup" install_loopback_firewall || return 1
        validate_committed_runtime_layout_provenance || return 1
        set_migration_phase installing || return 1
        bootstrap_test_sigkill existing-layout-installing || return $?
        ;;
      installing)
        validate_committed_runtime_layout_provenance || return 1
        set_migration_phase linked || return 1
        bootstrap_test_sigkill existing-layout-linked || return $?
        ;;
      linked)
        validate_committed_runtime_layout_provenance || return 1
        restart_current_release || return 1
        PROCESS_STOPPED=0
        validate_committed_runtime_layout_provenance || return 1
        set_migration_phase committed || return 1
        bootstrap_test_sigkill existing-layout-committed || return $?
        ;;
      committed)
        validate_committed_runtime_layout_provenance
        return $?
        ;;
      *) return 1 ;;
    esac
  done
}

validate_terminal_journal_marker_provenance() {
  local purpose="${1:-observe}" source="${2:-reload}" marker_state expected_proof
  case "$purpose" in
    observe|ack) ;;
    *) return 1 ;;
  esac
  case "$source" in
    reload) read_journal || return 1 ;;
    preloaded)
      [ "$JOURNAL_PRESENT" = 1 ] && \
        [ "$JOURNAL_TERMINAL_STATE" = terminal-pending ] && \
        [[ "$JOURNAL_TERMINAL_ID" =~ ^t1:[0-9a-f]{64}$ ]] && \
        [[ "$JOURNAL_HEAD_DIGEST" =~ ^[0-9a-f]{64}$ ]] || return 1
      ;;
    *) return 1 ;;
  esac
  if [ "$JOURNAL_PHASE" = committed ]; then
    if [ "$JOURNAL_LEGACY_TEST" = 1 ] && [ "$JOURNAL_TERMINAL_STATE" = terminal-pending ]; then
      if [ "$purpose" = ack ]; then
        validate_committed_runtime_layout_provenance || {
          printf '%s\n' "Legacy committed journal cannot prove the external runtime layout" >&2
          return 1
        }
      fi
      marker_state="$(external_layout_marker_state)" || return 1
      if [ "$marker_state" = absent ]; then
        if [ "$purpose" = observe ]; then
          JOURNAL_PROVENANCE_VALIDATED=1
          return 0
        fi
        commit_external_layout_marker || return 1
      fi
    fi
    validate_external_layout_marker || return 1
    if [ "$JOURNAL_TERMINAL_STATE" != live ]; then
      if [ "$JOURNAL_LEGACY_TEST" = 1 ] && [ "$JOURNAL_TERMINAL_STATE" = terminal-pending ]; then
        JOURNAL_MARKER_PROOF="$EXTERNAL_LAYOUT_MARKER_PROOF"
      else
        expected_proof="$JOURNAL_MARKER_PROOF"
        [ -n "$expected_proof" ] && \
          external_layout_marker_proof_matches "$expected_proof" "$EXTERNAL_LAYOUT_MARKER_PROOF" || {
          printf '%s\n' "Committed terminal marker provenance changed" >&2
          return 1
        }
      fi
    fi
    JOURNAL_PROVENANCE_VALIDATED=1
    return 0
  fi
  marker_state="$(external_layout_marker_state)" || return 1
  [ "$marker_state" = absent ] || {
    printf '%s\n' "Pre-commit migration journal conflicts with a permanent layout marker" >&2
    return 1
  }
  if [ "$JOURNAL_TERMINAL_STATE" != live ] && [ "$JOURNAL_MARKER_PROOF" != absent ]; then
    printf '%s\n' "Pre-commit terminal marker provenance is invalid" >&2
    return 1
  fi
  if [ "$JOURNAL_LEGACY_TEST" = 1 ] && [ "$JOURNAL_TERMINAL_STATE" = terminal-pending ]; then
    JOURNAL_MARKER_PROOF=absent
  fi
  JOURNAL_PROVENANCE_VALIDATED=1
}

bootstrap_terminal_journal_gate() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=journal-terminal-uncertain
  discover_migration_journal || return 1
  if [ "$JOURNAL_PRESENT" != "1" ]; then
    BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=""
    return 0
  fi
  if [ "$JOURNAL_TERMINAL_STATE" = terminal-pending ]; then
    validate_terminal_journal_marker_provenance || return 1
    BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=terminal-pending
    printf 'BOOTSTRAP_TERMINAL_ID=%s\n' "$JOURNAL_TERMINAL_ID"
    return 0
  fi
  if [ "$JOURNAL_TERMINAL_STATE" = terminal-consumed ]; then
    validate_terminal_journal_marker_provenance || return 1
    BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=""
    return 0
  fi
  [ "$JOURNAL_TERMINAL_STATE" = live ] || return 1
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=""
}

bootstrap_ack_terminal_generation() {
  local terminal_id="$1" result
  local -a values
  result="$(bootstrap_journal_dirfd_helper ack-terminal \
    "$JOURNAL_ENTRY_NAME" "$JOURNAL_DIR_IDENTITY" \
    "$terminal_id" "$JOURNAL_HEAD_DIGEST" "$JOURNAL_MARKER_PROOF")" || return 1
  mapfile -t values <<< "$result"
  [ "${#values[@]}" = 3 ] && [ "${values[0]}" = "$JOURNAL_DIR_IDENTITY" ] || return 1
  [[ "${values[1]}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [ "${values[2]}" = "$terminal_id" ] || return 1
  JOURNAL_HEAD_DIGEST="${values[1]}"
  JOURNAL_TERMINAL_STATE=terminal-consumed
}

bootstrap_ack_terminal_command() {
  local terminal_id="${1:-}"
  [[ "$terminal_id" =~ ^t1:[0-9a-f]{64}$ ]] || {
    printf '%s\n' "Terminal acknowledgement id is invalid" >&2
    return 64
  }
  bootstrap_reject_production_test_hooks || return $?
  require_root || return $?
  require_exact_host || return $?
  validate_candidate_gate_mounts || return $?
  bootstrap_acquire_preprovisioned_control_locks || return $?
  validate_candidate_gate_mounts || return $?
  reserve_migration_journal_capacity "$terminal_id" || return $?
  discover_migration_journal "$terminal_id" || return $?
  [ "$JOURNAL_PRESENT" = 1 ] || return 1
  case "$JOURNAL_TERMINAL_STATE" in
    terminal-pending|terminal-consumed) ;;
    *) return 1 ;;
  esac
  [ "$JOURNAL_TERMINAL_ID" = "$terminal_id" ] || {
    printf '%s\n' "Terminal acknowledgement id is stale" >&2
    return 1
  }
  validate_terminal_journal_marker_provenance ack || return $?
  [ -n "$JOURNAL_HEAD_DIGEST" ] || read_journal || return $?
  bootstrap_ack_terminal_generation "$terminal_id" || return $?
  printf 'BOOTSTRAP_TERMINAL_ACKNOWLEDGED=%s\n' "$terminal_id"
}

recover_interrupted_migration() {
  local phase backup_dir
  validate_sanitizer_gate_idle_state || return 1
  discover_migration_journal || return 1
  [ "$JOURNAL_PRESENT" = "1" ] || return 0
  if [ -e "$EXTERNAL_LAYOUT_MARKER" ] || [ -L "$EXTERNAL_LAYOUT_MARKER" ]; then
    printf '%s\n' "External layout marker forbids bootstrap recovery" >&2
    return 1
  fi
  read_journal || return 1
  adopt_migration_journal || return 1
  phase="$JOURNAL_PHASE"
  backup_dir="$JOURNAL_BACKUP_DIR"
  claim_migration_journal || return 1
  validate_active_migration_journal_directory || return 1

  if validate_committed_runtime_layout_provenance; then
    bootstrap_attest_existing_layout_phase_chain "$backup_dir" || return 1
    [ "$JOURNAL_PHASE" = committed ] || return 1
    commit_external_layout_marker || return 1
    validate_external_layout_marker || return 1
    bootstrap_test_sigkill marker-durable
    clear_migration_journal || return 1
    BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=committed-recovered
    printf '%s\n' "BOOTSTRAP_RECOVERY_COMMIT_OK"
    return 0
  fi

  if [ "$phase" = "stopping" ] || [ "$phase" = "snapshotting" ]; then
    cleanup_stages || return 1
    install_loopback_firewall_for_recovery "$backup_dir" || return 1
    restart_current_release || return 1
  else
    restore_runtime_snapshot "$backup_dir" || return 1
  fi
  clear_migration_journal || return 1
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=rollback-recovered
  printf '%s\n' "BOOTSTRAP_RECOVERY_OK"
}

commit_external_layout_and_retire_journal() {
  validate_active_migration_journal_directory || return 1
  read_journal || return 1
  [ "$JOURNAL_PHASE" = "committed" ] || {
    printf '%s\n' "External layout marker requires a committed bootstrap journal" >&2
    return 1
  }
  [ "$JOURNAL_OWNER_TOKEN" = "$BOOTSTRAP_OWNER_TOKEN" ] || {
    printf '%s\n' "Bootstrap journal owner changed before marker publication" >&2
    return 1
  }
  validate_exact_link "$LIVE_DIR/.env" "$ENV_FILE" || return 1
  validate_exact_link "$LIVE_DIR/server/db" "$DB_DIR" || return 1
  validate_exact_link "$LIVE_DIR/uploads" "$UPLOAD_DIR" || return 1
  validate_exact_link "$LIVE_DIR/tmp" "$TMP_DIR" || return 1
  validate_external_runtime || return 1
  claim_migration_journal || return 1
  validate_active_migration_journal_directory || return 1
  commit_external_layout_marker || return 1
  validate_external_layout_marker || return 1
  bootstrap_test_sigkill marker-durable
  clear_migration_journal quiet || return 1
}

finalize_post_marker_bootstrap_journal() {
  discover_migration_journal || return 1
  [ "$JOURNAL_PRESENT" = "1" ] || return 0
  validate_external_layout_marker || return 1
  read_journal || return 1
  [ "$JOURNAL_PHASE" = "committed" ] || {
    printf '%s\n' "Post-marker bootstrap journal is not a committed layout" >&2
    return 1
  }
  validate_exact_link "$LIVE_DIR/.env" "$ENV_FILE" || return 1
  validate_exact_link "$LIVE_DIR/server/db" "$DB_DIR" || return 1
  validate_exact_link "$LIVE_DIR/uploads" "$UPLOAD_DIR" || return 1
  validate_exact_link "$LIVE_DIR/tmp" "$TMP_DIR" || return 1
  validate_external_runtime || return 1
  adopt_migration_journal || return 1
  claim_migration_journal || return 1
  validate_active_migration_journal_directory || return 1
  validate_external_layout_marker || return 1
  clear_migration_journal || return 1
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=post-marker-retired
  printf '%s\n' "BOOTSTRAP_POST_MARKER_JOURNAL_RETIRED"
}

bootstrap_return_after_terminal_journal_outcome() {
  [ -n "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME" ] || return 1
  printf 'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=%s\n' "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME"
  return 0
}

bootstrap_emit_normal_success_contract() {
  [ "$JOURNAL_PRESENT" = 1 ] && \
    [ "$JOURNAL_TERMINAL_STATE" = terminal-pending ] && \
    [[ "$JOURNAL_TERMINAL_ID" =~ ^t1:[0-9a-f]{64}$ ]] && \
    [ "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME" = terminal-pending ] || {
    printf '%s\n' "Bootstrap success lacks an unambiguous terminal-pending journal" >&2
    return 1
  }
  printf '%s\n' "BOOTSTRAP_OK"
  printf 'BOOTSTRAP_TERMINAL_ID=%s\n' "$JOURNAL_TERMINAL_ID"
  printf '%s\n' "BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending"
}

run_committed_layout_validation() {
  local artifact_transaction="$JOURNAL_ROOT/artifact-repair-$BOOTSTRAP_OWNER_TOKEN"
  local artifact_build="$JOURNAL_ROOT/.artifact-repair-build-$BOOTSTRAP_OWNER_TOKEN"
  local retired_transaction="$artifact_transaction.released.$BOOTSTRAP_OWNER_TOKEN"
  local original_backup_dir="$BACKUP_DIR"
  validate_sanitizer_gate_idle_state || return 1
  validate_external_layout_marker || return 1
  validate_exact_link "$LIVE_DIR/.env" "$ENV_FILE" || return 1
  validate_exact_link "$LIVE_DIR/server/db" "$DB_DIR" || return 1
  validate_exact_link "$LIVE_DIR/uploads" "$UPLOAD_DIR" || return 1
  validate_exact_link "$LIVE_DIR/tmp" "$TMP_DIR" || return 1
  validate_external_runtime || return 1
  database_quick_check "$DB_DIR/turingmarket.db" || return 1
  bootstrap_ensure_process_identity || return 1
  [ -d "$JOURNAL_ROOT" ] && [ ! -L "$JOURNAL_ROOT" ] || return 1
  [ ! -e "$artifact_transaction" ] && [ ! -L "$artifact_transaction" ] || return 1
  [ ! -e "$artifact_build" ] && [ ! -L "$artifact_build" ] || return 1
  [ ! -e "$retired_transaction" ] && [ ! -L "$retired_transaction" ] || return 1
  mkdir -m 0700 "$artifact_build" || return 1
  bootstrap_test_sigkill repair-build-created
  bootstrap_write_generation "$artifact_build" artifact-repair repair-created || return 1
  bootstrap_test_sigkill repair-build-controls
  mkdir -m 0700 "$artifact_build/work" || return 1
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    chown root:root "$artifact_build/work" || return 1
  fi
  sync_directory "$artifact_build/work" || return 1
  sync_directory "$artifact_build" || return 1
  bootstrap_validate_generation "$artifact_build" artifact-repair "$BOOTSTRAP_OWNER_TOKEN" || return 1
  bootstrap_test_sigkill repair-build-ready
  mv "$artifact_build" "$artifact_transaction" || return 1
  sync_directory "$JOURNAL_ROOT" || return 1
  bootstrap_test_sigkill repair-published
  BACKUP_DIR="$artifact_transaction/work"
  stop_current_release || return 1
  PROCESS_STOPPED=1
  bootstrap_test_sigkill repair-stop-complete
  bootstrap_set_generation_phase "$artifact_transaction" artifact-repair repair-stopped || return 1
  bootstrap_test_sigkill repair-stopped
  install_apparmor_profile || return 1
  bootstrap_set_generation_phase "$artifact_transaction" artifact-repair repair-apparmor || return 1
  bootstrap_test_sigkill repair-apparmor
  install_loopback_firewall || return 1
  bootstrap_set_generation_phase "$artifact_transaction" artifact-repair repair-firewall || return 1
  bootstrap_test_sigkill repair-firewall
  restart_current_release || return 1
  PROCESS_STOPPED=0
  bootstrap_set_generation_phase "$artifact_transaction" artifact-repair repair-restarted || return 1
  bootstrap_test_sigkill repair-restarted
  validate_loopback_firewall || return 1
  validate_current_release_health || return 1
  bootstrap_set_generation_phase "$artifact_transaction" artifact-repair repair-validated || return 1
  bootstrap_test_sigkill repair-validated
  mv "$artifact_transaction" "$retired_transaction" || return 1
  sync_directory "$JOURNAL_ROOT" || return 1
  bootstrap_test_sigkill repair-released
  bootstrap_delete_artifact_generation "$retired_transaction" "$BOOTSTRAP_OWNER_TOKEN" || return 1
  sync_directory "$JOURNAL_ROOT" || return 1
  BACKUP_DIR="$original_backup_dir"
  printf '%s\n' "BOOTSTRAP_EXTERNAL_LAYOUT_ALREADY_APPLIED"
}

bootstrap_abort() {
  local status="$1"
  if [ "$ABORTING" = "1" ]; then
    exit "$status"
  fi
  ABORTING=1
  trap - ERR INT TERM HUP
  if ! discover_migration_journal; then
    printf '%s\n' "BOOTSTRAP_RECOVERY_FAILED: journal state is unreadable under $JOURNAL_ROOT" >&2
    exit 1
  fi
  if [ "$JOURNAL_PRESENT" = "1" ]; then
    if ! recover_interrupted_migration; then
      printf '%s\n' "BOOTSTRAP_RECOVERY_FAILED: journal retained under $JOURNAL_ROOT" >&2
      exit 1
    fi
  elif [ "$PROCESS_STOPPED" = "1" ]; then
    restart_current_release || true
  fi
  exit "$status"
}

bootstrap_release_on_exit() {
  local status="$1"
  trap - EXIT
  if [ "$BOOTSTRAP_FENCES_HELD" = "1" ]; then
    if ! bootstrap_release_shared_fences; then
      if ! bootstrap_cleanup_owned_fence_state; then
        printf '%s\n' "BOOTSTRAP_FENCE_RELEASE_FAILED" >&2
        status=1
      fi
    fi
  fi
  if [ "$JOURNAL_CAPACITY_RESERVED" = "1" ]; then
    if ! release_migration_journal_capacity_reservation; then
      printf '%s\n' "BOOTSTRAP_JOURNAL_RESERVATION_RELEASE_FAILED" >&2
      status=1
    fi
  fi
  exit "$status"
}

bootstrap_prepare_control_plane() {
  bootstrap_acquire_preprovisioned_control_locks || return 1
  bootstrap_prepare_journal_run_identity || return 1
  bind_migration_journal_root || { die "Bootstrap journal root identity changed after control-plane preparation"; return 1; }
}

bootstrap_expected_lock_owner_ids() {
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    printf '%s:%s\n' "$EUID" "$(bootstrap_trusted_id -g)"
  else
    printf '%s\n' 0:0
  fi
}

bootstrap_validate_trusted_lock_parent() {
  local directory="$1" label="$2" expected_identity="${3:-}"
  local expected_owner metadata uid gid mode device inode canonical
  case "$directory" in
    /*) ;;
    *) die "$label parent path is not absolute"; return 1 ;;
  esac
  [ -d "$directory" ] && [ ! -L "$directory" ] || { die "$label parent is unsafe"; return 1; }
  canonical="$(bootstrap_trusted_realpath -e -- "$directory")" || return 1
  [ "$canonical" = "$directory" ] || { die "$label parent is not canonical"; return 1; }
  metadata="$(bootstrap_trusted_stat -c '%u:%g:%a:%d:%i' -- "$directory")" || return 1
  IFS=: read -r uid gid mode device inode <<< "$metadata"
  expected_owner="$(bootstrap_expected_lock_owner_ids)" || return 1
  [ "$uid:$gid" = "$expected_owner" ] || { die "$label parent ownership drift"; return 1; }
  [[ "$mode" =~ ^[0-7]{3}$ ]] || { die "$label parent mode is invalid"; return 1; }
  if (( (8#$mode & 8#700) != 8#700 || (8#$mode & 8#22) != 0 )); then
    die "$label parent mode permits unsafe mutation"
    return 1
  fi
  if [ -n "$expected_identity" ] && [ "$metadata" != "$expected_identity" ]; then
    die "$label parent identity changed"
    return 1
  fi
  printf '%s\n' "$metadata"
}

bootstrap_preprovisioned_lock_identity() {
  local lock_path="$1" label="$2" expected_parent_identity="${3:-}"
  local parent expected_owner metadata uid gid mode links device inode canonical
  case "$lock_path" in
    /*/*)
      parent="${lock_path%/*}"
      [ -n "$parent" ] || parent=/
      ;;
    *) die "$label path is not absolute"; return 1 ;;
  esac
  bootstrap_validate_trusted_lock_parent \
    "$parent" "$label" "$expected_parent_identity" >/dev/null || return 1
  path_entry_present_no_follow "$lock_path" || { die "$label must be pre-provisioned"; return 1; }
  [ -f "$lock_path" ] && [ ! -L "$lock_path" ] || { die "$label is unsafe"; return 1; }
  canonical="$(bootstrap_trusted_realpath -e -- "$lock_path")" || return 1
  [ "$canonical" = "$lock_path" ] || { die "$label is not canonical"; return 1; }
  metadata="$(bootstrap_trusted_stat -c '%u:%g:%a:%h:%d:%i' -- "$lock_path")" || return 1
  IFS=: read -r uid gid mode links device inode <<< "$metadata"
  expected_owner="$(bootstrap_expected_lock_owner_ids)" || return 1
  [ "$uid:$gid" = "$expected_owner" ] && [ "$mode" = 600 ] && [ "$links" = 1 ] || {
    die "$label ownership, mode, or link count drift"
    return 1
  }
  printf '%s\n' "$metadata"
}

bootstrap_test_control_lock_race() {
  local point="$1" race="${TM_BOOTSTRAP_TEST_CONTROL_LOCK_RACE:-}" retired_parent
  bootstrap_reject_production_test_hooks || return 1
  bootstrap_test_hooks_enabled || return 0
  case "$race:$point" in
    unlink-operation:before-operation-open)
      rm -f -- "$OPERATION_FENCE"
      ;;
    unlink-sanitizer:before-sanitizer-open)
      rm -f -- "$SANITIZER_LIFECYCLE_FENCE"
      ;;
    replace-operation:before-operation-open)
      rm -f -- "$OPERATION_FENCE" || return 1
      printf '%s\n' foreign-operation-lock > "$OPERATION_FENCE" || return 1
      chmod 0600 "$OPERATION_FENCE" || return 1
      ;;
    replace-operation-after-open:after-operation-open)
      rm -f -- "$OPERATION_FENCE" || return 1
      printf '%s\n' foreign-operation-lock > "$OPERATION_FENCE" || return 1
      chmod 0600 "$OPERATION_FENCE" || return 1
      ;;
    replace-sanitizer-after-open:after-sanitizer-open)
      rm -f -- "$SANITIZER_LIFECYCLE_FENCE" || return 1
      printf '%s\n' foreign-sanitizer-lock > "$SANITIZER_LIFECYCLE_FENCE" || return 1
      chmod 0600 "$SANITIZER_LIFECYCLE_FENCE" || return 1
      ;;
    replace-operation-parent:before-operation-open)
      retired_parent="$REMOTE_ROOT.lock-parent-retired"
      [ ! -e "$retired_parent" ] && [ ! -L "$retired_parent" ] || return 1
      mv "$REMOTE_ROOT" "$retired_parent" || return 1
      mkdir -m 0700 "$REMOTE_ROOT" || return 1
      mv "$retired_parent/${OPERATION_FENCE##*/}" "$OPERATION_FENCE" || return 1
      ;;
  esac
}

bootstrap_acquire_preprovisioned_control_locks() {
  local operation_identity sanitizer_identity
  local operation_parent operation_parent_identity operation_name
  local sanitizer_parent sanitizer_parent_identity sanitizer_name
  case "$BOOTSTRAP_CONTROL_LOCKS_HELD" in
    1)
      assert_retained_lock_parent_fd 5 \
        "$BOOTSTRAP_OPERATION_LOCK_PARENT" "Deployment operation fence" \
        "$BOOTSTRAP_OPERATION_LOCK_PARENT_IDENTITY" || return 1
      assert_retained_lock_parent_fd 6 \
        "$BOOTSTRAP_SANITIZER_LOCK_PARENT" "Sanitizer lifecycle fence" \
        "$BOOTSTRAP_SANITIZER_LOCK_PARENT_IDENTITY" || return 1
      assert_retained_lock_fd 8 "$OPERATION_FENCE" "Deployment operation fence" || return 1
      assert_retained_lock_fd 9 "$SANITIZER_LIFECYCLE_FENCE" "Sanitizer lifecycle fence" || return 1
      return 0
      ;;
    library)
      [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]
      return $?
      ;;
  esac
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ] && \
     ! path_entry_present_no_follow "$OPERATION_FENCE" && \
     ! path_entry_present_no_follow "$SANITIZER_LIFECYCLE_FENCE"; then
    BOOTSTRAP_CONTROL_LOCKS_HELD=library
    return 0
  fi

  operation_parent="${OPERATION_FENCE%/*}"
  operation_name="${OPERATION_FENCE##*/}"
  sanitizer_parent="${SANITIZER_LIFECYCLE_FENCE%/*}"
  sanitizer_name="${SANITIZER_LIFECYCLE_FENCE##*/}"
  [ -n "$operation_parent" ] && [ -n "$operation_name" ] \
    || { die "Deployment operation fence path is invalid"; return 1; }
  [ -n "$sanitizer_parent" ] && [ -n "$sanitizer_name" ] \
    || { die "Sanitizer lifecycle fence path is invalid"; return 1; }
  operation_parent_identity="$(bootstrap_validate_trusted_lock_parent \
    "$operation_parent" "Deployment operation fence")" || return 1
  sanitizer_parent_identity="$(bootstrap_validate_trusted_lock_parent \
    "$sanitizer_parent" "Sanitizer lifecycle fence")" || return 1
  operation_identity="$(bootstrap_preprovisioned_lock_identity \
    "$OPERATION_FENCE" "Deployment operation fence" \
    "$operation_parent_identity")" || return 1
  sanitizer_identity="$(bootstrap_preprovisioned_lock_identity \
    "$SANITIZER_LIFECYCLE_FENCE" "Sanitizer lifecycle fence" \
    "$sanitizer_parent_identity")" || return 1

  exec 5<"$operation_parent" || return 1
  assert_retained_lock_parent_fd 5 "$operation_parent" \
    "Deployment operation fence" "$operation_parent_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  exec 6<"$sanitizer_parent" || { bootstrap_close_control_lock_fds; return 1; }
  assert_retained_lock_parent_fd 6 "$sanitizer_parent" \
    "Sanitizer lifecycle fence" "$sanitizer_parent_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }

  bootstrap_test_control_lock_race before-operation-open || {
    bootstrap_close_control_lock_fds
    return 1
  }
  exec 8<"/proc/$BASHPID/fd/5/$operation_name" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  bootstrap_test_control_lock_race after-operation-open || {
    bootstrap_close_control_lock_fds
    return 1
  }
  assert_retained_lock_parent_fd 5 "$operation_parent" \
    "Deployment operation fence" "$operation_parent_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  assert_retained_lock_fd 8 "$OPERATION_FENCE" "Deployment operation fence" "$operation_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  bootstrap_test_control_lock_race before-sanitizer-open || {
    bootstrap_close_control_lock_fds
    return 1
  }
  exec 9<"/proc/$BASHPID/fd/6/$sanitizer_name" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  bootstrap_test_control_lock_race after-sanitizer-open || {
    bootstrap_close_control_lock_fds
    return 1
  }
  assert_retained_lock_parent_fd 6 "$sanitizer_parent" \
    "Sanitizer lifecycle fence" "$sanitizer_parent_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  assert_retained_lock_fd 9 "$SANITIZER_LIFECYCLE_FENCE" "Sanitizer lifecycle fence" "$sanitizer_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  bootstrap_trusted_flock -n 8 || {
    bootstrap_close_control_lock_fds
    die "Another deployment operation is active"
    return 1
  }
  assert_retained_lock_parent_fd 5 "$operation_parent" \
    "Deployment operation fence" "$operation_parent_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  assert_retained_lock_fd 8 "$OPERATION_FENCE" "Deployment operation fence" "$operation_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  bootstrap_trusted_flock -n 9 || {
    bootstrap_close_control_lock_fds
    die "Another deploy, sanitizer, rollback, or runtime bootstrap operation is active"
    return 1
  }
  assert_retained_lock_parent_fd 5 "$operation_parent" \
    "Deployment operation fence" "$operation_parent_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  assert_retained_lock_parent_fd 6 "$sanitizer_parent" \
    "Sanitizer lifecycle fence" "$sanitizer_parent_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  assert_retained_lock_fd 8 "$OPERATION_FENCE" "Deployment operation fence" "$operation_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  assert_retained_lock_fd 9 "$SANITIZER_LIFECYCLE_FENCE" "Sanitizer lifecycle fence" "$sanitizer_identity" || {
    bootstrap_close_control_lock_fds
    return 1
  }
  BOOTSTRAP_OPERATION_LOCK_PARENT="$operation_parent"
  BOOTSTRAP_OPERATION_LOCK_PARENT_IDENTITY="$operation_parent_identity"
  BOOTSTRAP_SANITIZER_LOCK_PARENT="$sanitizer_parent"
  BOOTSTRAP_SANITIZER_LOCK_PARENT_IDENTITY="$sanitizer_parent_identity"
  BOOTSTRAP_CONTROL_LOCKS_HELD=1
}

bootstrap_prepare_journal_run_identity() {
  if ! validate_bootstrap_token "$BOOTSTRAP_OWNER_TOKEN"; then
    BOOTSTRAP_OWNER_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(16))')" || return 1
  fi
  validate_bootstrap_token "$BOOTSTRAP_OWNER_TOKEN" || { die "Bootstrap owner token is invalid"; return 1; }
  bootstrap_initialize_process_identity || return 1
}

bootstrap_run_new_migration() {
mkdir -p "$BACKUP_DIR" "$STATE_BACKUP" || return 1
chmod 0700 "$BACKUP_DIR" "$STATE_BACKUP" || return 1
snapshot_host before || return $?

apt-get update || return $?
apt-get install -s --no-install-recommends --no-upgrade "${BROWSER_PACKAGES[@]}" > "$BACKUP_DIR/apt-install-plan.txt" || return $?
if grep -Eq '^Remv |^Inst [^ ]+ \[[^]]+\]' "$BACKUP_DIR/apt-install-plan.txt"; then
  die "Browser dependency plan would remove or upgrade an installed package"
  return 1
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-upgrade "${BROWSER_PACKAGES[@]}" || return $?

if ! getent passwd "$GATE_USER" >/dev/null; then
  useradd --system --user-group --home-dir "$GATE_ROOT" --create-home --shell /usr/sbin/nologin "$GATE_USER" || return $?
fi
validate_gate_identity || { die "Gate identity validation failed"; return 1; }
install -d -o root -g root -m 0755 "$GATE_ROOT" "$GATE_ROOT/releases" || return 1
install -d -o root -g root -m 0700 "$ENV_DIR" "$STATE_ROOT" || return 1
install_apparmor_profile || return $?

  if validate_exact_link "$LIVE_DIR/.env" "$ENV_FILE" && \
     validate_exact_link "$LIVE_DIR/server/db" "$DB_DIR" && \
     validate_exact_link "$LIVE_DIR/uploads" "$UPLOAD_DIR" && \
     validate_exact_link "$LIVE_DIR/tmp" "$TMP_DIR"; then
    validate_external_runtime || { die "External runtime state is incomplete or has unsafe permissions"; return 1; }
    database_quick_check "$DB_DIR/turingmarket.db" || return $?
    bootstrap_attest_existing_layout_phase_chain "$BACKUP_DIR" || return $?
    snapshot_host after || return $?
  (cd "$BACKUP_DIR" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS) || return $?
  chmod -R go-rwx "$BACKUP_DIR" || return $?
  commit_external_layout_and_retire_journal || return $?
  printf '%s\n' "BOOTSTRAP_EXTERNAL_LAYOUT_ALREADY_APPLIED"
  return 0
fi

bootstrap_validate_anchored_path "$LIVE_DIR" .env 0700,0755 0 || { die "Required runtime environment path is unsafe"; return 1; }
bootstrap_validate_anchored_path "$LIVE_DIR" server/db/turingmarket.db 0700,0755 0 || { die "Required runtime database path is unsafe"; return 1; }
bootstrap_validate_anchored_path "$LIVE_DIR" uploads 0700,0755 0 || { die "Required runtime uploads path is unsafe"; return 1; }
bootstrap_validate_anchored_path "$LIVE_DIR" tmp 0700,0755 0 || { die "Required runtime temp path is unsafe"; return 1; }

trap 'bootstrap_abort $?' ERR
trap 'bootstrap_abort 130' INT
trap 'bootstrap_abort 143' TERM
trap 'bootstrap_abort 129' HUP

stop_current_release || return $?
PROCESS_STOPPED=1
set_migration_phase snapshotting || return $?
snapshot_runtime_state || return $?
set_migration_phase prepared || return $?
install_loopback_firewall || return $?

ENV_STAGE="$ENV_DIR/.turingmarket.env.new.$$"
DB_STAGE="$STATE_ROOT/.db.new.$$"
UPLOAD_STAGE="$STATE_ROOT/.uploads.new.$$"
TMP_STAGE="$STATE_ROOT/.tmp.new.$$"
bootstrap_copy_anchored_path "$LIVE_DIR" .env 0700,0755 "$ENV_DIR" "${ENV_STAGE##*/}" 0700 || return $?
bootstrap_remove_anchored_path "$STATE_ROOT" "${DB_STAGE##*/}" 0700 0 || return $?
install -d -m 0700 "$DB_STAGE" || return $?
bootstrap_copy_anchored_path "$LIVE_DIR" uploads 0700,0755 "$STATE_ROOT" "${UPLOAD_STAGE##*/}" 0700 || return $?
bootstrap_copy_anchored_path "$LIVE_DIR" tmp 0700,0755 "$STATE_ROOT" "${TMP_STAGE##*/}" 0700 || return $?
bootstrap_validate_anchored_path "$LIVE_DIR" server/db/turingmarket.db 0700,0755 0 || return $?
database_backup "$LIVE_DIR/server/db/turingmarket.db" "$DB_STAGE/turingmarket.db" || return $?
database_quick_check "$DB_STAGE/turingmarket.db" || return $?

validate_sanitizer_gate_idle_state || return $?
set_migration_phase installing || return $?
bootstrap_remove_anchored_path "$ENV_DIR" turingmarket.env 0700 0 || return $?
bootstrap_remove_anchored_path "$STATE_ROOT" db 0700 0 || return $?
bootstrap_remove_anchored_path "$STATE_ROOT" uploads 0700 0 || return $?
bootstrap_remove_anchored_path "$STATE_ROOT" tmp 0700 0 || return $?
mv "$ENV_STAGE" "$ENV_FILE" || return $?
mv "$DB_STAGE" "$DB_DIR" || return $?
mv "$UPLOAD_STAGE" "$UPLOAD_DIR" || return $?
mv "$TMP_STAGE" "$TMP_DIR" || return $?
chown -R root:root "$ENV_FILE" "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" || return $?
chmod 0600 "$ENV_FILE" || return $?
chmod 0700 "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" || return $?
find "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" -type d -exec chmod 0700 {} + || return $?
find "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" -type f -exec chmod 0600 {} + || return $?

bootstrap_remove_anchored_path "$LIVE_DIR" .env 0700,0755 1 || return $?
bootstrap_remove_anchored_path "$LIVE_DIR" server/db 0700,0755 1 || return $?
bootstrap_remove_anchored_path "$LIVE_DIR" uploads 0700,0755 1 || return $?
bootstrap_remove_anchored_path "$LIVE_DIR" tmp 0700,0755 1 || return $?
ln -s /etc/turingmarket/turingmarket.env "$LIVE_DIR/.env" || return $?
ln -s /var/lib/turingmarket/db "$LIVE_DIR/server/db" || return $?
ln -s /var/lib/turingmarket/uploads "$LIVE_DIR/uploads" || return $?
ln -s /var/lib/turingmarket/tmp "$LIVE_DIR/tmp" || return $?
set_migration_phase linked || return $?

validate_external_runtime || return $?
database_quick_check "$DB_DIR/turingmarket.db" || return $?
restart_current_release || return $?
PROCESS_STOPPED=0
database_quick_check "$DB_DIR/turingmarket.db" || return $?
set_migration_phase committed || return $?
snapshot_host after || return $?
(cd "$BACKUP_DIR" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS) || return $?
chmod -R go-rwx "$BACKUP_DIR" || return $?
  commit_external_layout_and_retire_journal || return $?
  trap - ERR INT TERM HUP
}

bootstrap_production_main() {
  local marker_state initial_phase journal_started=0 allow_top_level_mutation=1
  local phase4_journal_policy=none
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=""
  bootstrap_reject_production_test_hooks || return $?
  require_root || return $?
  require_exact_host || return $?
  validate_candidate_gate_mounts || return $?
  bootstrap_acquire_preprovisioned_control_locks || return $?
  validate_candidate_gate_mounts || return $?
  bootstrap_terminal_journal_preflight || return $?
  if bootstrap_return_after_terminal_journal_outcome; then
    return 0
  fi
  bootstrap_arm_cleanup_recovery || return $?
  bootstrap_recover_stale_artifacts_before_reservation || return $?
  reserve_migration_journal_capacity || return $?
  bootstrap_terminal_journal_gate || return $?
  if bootstrap_return_after_terminal_journal_outcome; then
    return 0
  fi
  case "$JOURNAL_RESERVATION_MODE" in
    general) ;;
    existing-live)
      allow_top_level_mutation=0
      ;;
    *)
      printf '%s\n' "Migration journal capacity is reserved for terminal recovery only" >&2
      return 1
      ;;
  esac
  marker_state="$(external_layout_marker_state)" || return $?
  if [ "$JOURNAL_PRESENT" != 1 ] || [ "$JOURNAL_TERMINAL_STATE" = terminal-consumed ]; then
    if [ "$allow_top_level_mutation" != 1 ]; then
      printf '%s\n' "Migration journal capacity is full; no existing live recovery generation is available" >&2
      return 1
    fi
    bootstrap_prepare_journal_run_identity || return $?
    if [ "$marker_state" = valid ]; then
      initial_phase=committed
    else
      initial_phase=stopping
    fi
    begin_migration_journal "$initial_phase" || return $?
    journal_started=1
  else
    [ "$JOURNAL_TERMINAL_STATE" = live ] || return 1
    bootstrap_prepare_journal_run_identity || return $?
  fi
  claim_live_journal_before_host_mutation || return $?
  bootstrap_prepare_control_plane || return $?
  validate_sanitizer_gate_idle_state || return $?
  bootstrap_recover_stale_control_state || return $?
  if [ "$marker_state" = valid ]; then
    if [ "$journal_started" = 0 ]; then
      finalize_post_marker_bootstrap_journal || return $?
      if bootstrap_return_after_terminal_journal_outcome; then
        return 0
      fi
    fi
  else
    if [ "$journal_started" = 0 ]; then
      recover_interrupted_migration || return $?
      if bootstrap_return_after_terminal_journal_outcome; then
        return 0
      fi
    fi
  fi
  if [ "$allow_top_level_mutation" != 1 ]; then
    printf '%s\n' "Migration journal capacity is full; recovered live generation did not reach a terminal state" >&2
    return 1
  fi
  if [ "$marker_state" = valid ] && [ "$journal_started" = 1 ]; then
    phase4_journal_policy=owned-committed
  fi
  validate_phase4_idle_state "$phase4_journal_policy" || return $?
  bootstrap_acquire_shared_fences || return $?

  marker_state="$(external_layout_marker_state)" || return $?
  if [ "$marker_state" = valid ]; then
    trap 'bootstrap_abort $?' ERR
    trap 'bootstrap_abort 130' INT
    trap 'bootstrap_abort 143' TERM
    trap 'bootstrap_abort 129' HUP
    run_committed_layout_validation || return $?
    clear_migration_journal || return $?
    trap - ERR INT TERM HUP
    bootstrap_return_after_terminal_journal_outcome
    return $?
  fi

  bootstrap_run_new_migration || return $?
  bootstrap_emit_normal_success_contract
}

if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
  return 0
fi

if [ "$#" = 0 ]; then
  bootstrap_production_main
elif [ "$#" = 2 ] && [ "$1" = --ack-terminal ]; then
  bootstrap_ack_terminal_command "$2"
else
  printf '%s\n' "Usage: $0 [--ack-terminal t1:<sha256>]" >&2
  exit 64
fi
