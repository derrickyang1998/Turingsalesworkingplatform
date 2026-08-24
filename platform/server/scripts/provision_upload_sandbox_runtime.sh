#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' 'usage: provision_upload_sandbox_runtime.sh snapshot|install|verify|rollback [options]' >&2
  exit 64
}

[[ $# -ge 1 ]] || usage
ACTION="$1"
shift
SNAPSHOT_ROOT=''
STAGED_RUNTIME=''
SOURCE_ROOT=''
TRUSTED_VERIFIER=''
EXPECTED_VERIFIER_SHA256=''
EXPECTED_MANIFEST_SHA256=''
EXPECTED_SHA256=''
BUILD_EVIDENCE=''
RUNTIME_ROOT='/var/lib/turingmarket-parser/runtime-root'
SERVICE_UNIT_TARGET='/etc/systemd/system/turingmarket-parser@.service'
SLICE_UNIT_TARGET='/etc/systemd/system/turingmarket-parser.slice'
SELF_TEST_TARGET='/usr/local/libexec/turingmarket/upload_sandbox_self_test'
LOCK_PATH='/run/lock/turingmarket-parser-provision.lock'
STATE_ROOT='/var/lib/turingmarket-parser'
SPOOL_ROOT='/var/lib/turingmarket-parser/jobs'
RUNTIME_TRANSACTION_ROOT=''
RUNTIME_TRANSACTION_STAGE=''
RUNTIME_TRANSACTION_PREVIOUS=''
RUNTIME_TRANSACTION_JOURNAL=''
RUNTIME_TRANSACTION_JOURNAL_NEW=''
RUNTIME_TRANSACTION_RECOVERY=''
SELF_PATH="$(realpath -e -- "$0")"
while (($#)); do
  case "$1" in
    --snapshot-root) (($# >= 2)) || usage; SNAPSHOT_ROOT="$2"; shift 2 ;;
    --staged-runtime) (($# >= 2)) || usage; STAGED_RUNTIME="$2"; shift 2 ;;
    --source-root) (($# >= 2)) || usage; SOURCE_ROOT="$2"; shift 2 ;;
    --trusted-verifier) (($# >= 2)) || usage; TRUSTED_VERIFIER="$2"; shift 2 ;;
    --expected-verifier-sha256) (($# >= 2)) || usage; EXPECTED_VERIFIER_SHA256="$2"; shift 2 ;;
    --expected-manifest-sha256) (($# >= 2)) || usage; EXPECTED_MANIFEST_SHA256="$2"; shift 2 ;;
    --expected-sha256) (($# >= 2)) || usage; EXPECTED_SHA256="$2"; shift 2 ;;
    --build-evidence) (($# >= 2)) || usage; BUILD_EVIDENCE="$2"; shift 2 ;;
    --runtime-root) (($# >= 2)) || usage; RUNTIME_ROOT="$2"; shift 2 ;;
    --service-unit-target) (($# >= 2)) || usage; SERVICE_UNIT_TARGET="$2"; shift 2 ;;
    --slice-unit-target) (($# >= 2)) || usage; SLICE_UNIT_TARGET="$2"; shift 2 ;;
    --self-test-target) (($# >= 2)) || usage; SELF_TEST_TARGET="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$ACTION" =~ ^(snapshot|install|verify|rollback)$ ]] || usage
[[ "$RUNTIME_ROOT" = /var/lib/turingmarket-parser/runtime-root ]] || usage
[[ "$SERVICE_UNIT_TARGET" = /etc/systemd/system/turingmarket-parser@.service ]] || usage
[[ "$SLICE_UNIT_TARGET" = /etc/systemd/system/turingmarket-parser.slice ]] || usage
[[ "$SELF_TEST_TARGET" = /usr/local/libexec/turingmarket/upload_sandbox_self_test ]] || usage
valid_single_release_child() {
  local target="$1" base="$2" leaf="$3" relative release
  [[ "$target" = "$base/"*"/$leaf" ]] || return 1
  relative="${target#"$base/"}"
  release="${relative%"/$leaf"}"
  [[ "$release" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]
}
valid_parser_runtime_stage() {
  [[ "$1" = /root/turingmarket/.deploy-v030.lock/parser-appliance/runtime.stage ]]
}
valid_parser_build_evidence() {
  [[ "$1" = /root/turingmarket/.deploy-v030.lock/parser-appliance/runtime.evidence.json ]]
}
assert_trusted_verifier_location() {
  local trusted_bundle_pattern
  case "$TRUSTED_VERIFIER" in
    "$SOURCE_ROOT"|"$SOURCE_ROOT"/*) return 1 ;;
    /var/lib/turingmarket-gate/releases|/var/lib/turingmarket-gate/releases/*) return 1 ;;
    /root/turingmarket/.deploy-v030.lock/parser-appliance/source|/root/turingmarket/.deploy-v030.lock/parser-appliance/source/*) return 1 ;;
  esac
  trusted_bundle_pattern='^/usr/local/libexec/turingmarket/production-source-trust/([0-9a-f]{64})/([0-9a-f]{64})/bundles/([0-9a-f]{64})/server/scripts/trusted_parser_runtime_verifier\.js$'
  [[ "$TRUSTED_VERIFIER" =~ $trusted_bundle_pattern ]] || return 1
  [[ "${BASH_REMATCH[2]}" = "${BASH_REMATCH[3]}" ]] || return 1
}
valid_backup_parser_snapshot() {
  local target="$1" relative release
  [[ "$target" = /root/turingmarket/backups/*/parser-appliance ]] || return 1
  relative="${target#/root/turingmarket/backups/}"
  release="${relative%/parser-appliance}"
  [[ "$release" =~ ^v060-crm-sales-workspace-[0-9]{8}-[0-9]{6}$ && "$release" != */* ]]
}
valid_cutover_parser_snapshot_stage() {
  local target="$1" relative release stage
  [[ "$target" = /root/turingmarket/backups/*/.cutover-snapshot.*/parser-appliance ]] || return 1
  relative="${target#/root/turingmarket/backups/}"
  release="${relative%%/*}"
  stage="${relative#*/}"
  stage="${stage%/parser-appliance}"
  [[ "$release" =~ ^v060-crm-sales-workspace-[0-9]{8}-[0-9]{6}$ &&
     "$stage" =~ ^\.cutover-snapshot\.[0-9a-f]{32}$ &&
     "$relative" = "$release/$stage/parser-appliance" ]]
}
valid_final_cutover_parser_snapshot() {
  local target="$1" relative release
  [[ "$target" = /root/turingmarket/backups/*/cutover-snapshot/parser-appliance ]] || return 1
  relative="${target#/root/turingmarket/backups/}"
  release="${relative%%/*}"
  [[ "$release" =~ ^v060-crm-sales-workspace-[0-9]{8}-[0-9]{6}$ &&
     "$relative" = "$release/cutover-snapshot/parser-appliance" ]]
}
valid_candidate_server_source() {
  local target="$1" relative release
  [[ "$target" = /var/lib/turingmarket-gate/releases/*/server ]] || return 1
  relative="${target#/var/lib/turingmarket-gate/releases/}"
  release="${relative%/server}"
  [[ "$release" =~ ^v060-crm-sales-workspace-[0-9]{8}-[0-9]{6}$ && "$release" != */* ]]
}
if [[ "$ACTION" = verify ]]; then
  [[ -z "$SNAPSHOT_ROOT" ]] || usage
else
  if [[ "$SNAPSHOT_ROOT" != /var/lib/turingmarket-gate/releases/.v060-parser-snapshot ]] &&
     ! valid_single_release_child "$SNAPSHOT_ROOT" /var/lib/turingmarket-gate/snapshots parser-appliance &&
     ! valid_backup_parser_snapshot "$SNAPSHOT_ROOT" &&
     ! valid_cutover_parser_snapshot_stage "$SNAPSHOT_ROOT" &&
     ! { [[ "$ACTION" != snapshot ]] && valid_final_cutover_parser_snapshot "$SNAPSHOT_ROOT"; }; then
    usage
  fi
fi
if [[ "$ACTION" != verify ]]; then [[ "$SNAPSHOT_ROOT" = /* ]] || usage; fi
for target in "$RUNTIME_ROOT" "$SERVICE_UNIT_TARGET" "$SLICE_UNIT_TARGET" "$SELF_TEST_TARGET"; do
  [[ "$target" = /* ]] || usage
done
[[ -z "$STAGED_RUNTIME" || "$STAGED_RUNTIME" = /* ]] || usage
[[ -z "$SOURCE_ROOT" || "$SOURCE_ROOT" = /* ]] || usage
[[ -z "$TRUSTED_VERIFIER" || "$TRUSTED_VERIFIER" = /* ]] || usage
[[ -z "$EXPECTED_VERIFIER_SHA256" || "$EXPECTED_VERIFIER_SHA256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ -z "$EXPECTED_MANIFEST_SHA256" || "$EXPECTED_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ -z "$BUILD_EVIDENCE" || "$BUILD_EVIDENCE" = /* ]] || usage
if [[ "$ACTION" = install || "$ACTION" = verify ]]; then
  if [[ "$ACTION" = install ]]; then valid_parser_runtime_stage "$STAGED_RUNTIME" || usage; fi
  valid_parser_build_evidence "$BUILD_EVIDENCE" || usage
  [[ "$SOURCE_ROOT" = /root/turingmarket/.deploy-v030.lock/parser-appliance/source ]] || usage
  [[ -n "$TRUSTED_VERIFIER" && -n "$EXPECTED_VERIFIER_SHA256" && -n "$EXPECTED_MANIFEST_SHA256" ]] || usage
  assert_trusted_verifier_location || usage
  [[ -n "$EXPECTED_SHA256" ]] || usage
fi
[[ -z "$EXPECTED_SHA256" || "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$(uname -s)" = Linux && "$(id -u)" = 0 ]] || { printf '%s\n' 'parser provisioning requires Linux root' >&2; exit 65; }
command -v flock >/dev/null
command -v sha256sum >/dev/null
install -d -o root -g root -m 0755 "$(dirname "$LOCK_PATH")"
exec 9>"$LOCK_PATH"
flock -x 9
if [[ -n "$SOURCE_ROOT" ]]; then
  SOURCE_ROOT="$(realpath -e -- "$SOURCE_ROOT")"
  [[ "$SOURCE_ROOT" = /root/turingmarket/.deploy-v030.lock/parser-appliance/source ]] || usage
fi
if [[ -n "$TRUSTED_VERIFIER" ]]; then
  TRUSTED_VERIFIER="$(realpath -e -- "$TRUSTED_VERIFIER")"
  assert_trusted_verifier_location || usage
fi
if [[ -n "$BUILD_EVIDENCE" ]]; then
  BUILD_EVIDENCE="$(realpath -e -- "$BUILD_EVIDENCE")"
  valid_parser_build_evidence "$BUILD_EVIDENCE" || usage
fi

verify_trusted_verifier() {
  local metadata uid gid mode links observed parent parent_metadata parent_uid parent_gid parent_mode
  assert_trusted_verifier_location || return 66
  [[ -f "$TRUSTED_VERIFIER" && ! -L "$TRUSTED_VERIFIER" ]] || return 66
  metadata="$(stat -Lc '%u:%g:%a:%h' -- "$TRUSTED_VERIFIER")"
  IFS=: read -r uid gid mode links <<<"$metadata"
  [[ "$uid" = 0 && "$gid" = 0 && "$links" = 1 ]] || return 66
  (( (8#$mode & 0022) == 0 )) || return 66
  parent="$(dirname -- "$TRUSTED_VERIFIER")"
  while [[ "$parent" != / ]]; do
    parent_metadata="$(stat -Lc '%u:%g:%a' -- "$parent")"
    IFS=: read -r parent_uid parent_gid parent_mode <<<"$parent_metadata"
    [[ "$parent_uid" = 0 && "$parent_gid" = 0 ]] || return 66
    (( (8#$parent_mode & 0022) == 0 )) || return 66
    parent="$(dirname -- "$parent")"
  done
  observed="$(sha256sum -- "$TRUSTED_VERIFIER" | awk '{print $1}')"
  [[ "$observed" = "$EXPECTED_VERIFIER_SHA256" ]] || {
    printf '%s\n' 'trusted parser verifier SHA-256 mismatch' >&2
    return 67
  }
}

stop_parser_units() {
  systemctl kill --kill-who=all --signal=KILL 'turingmarket-parser@*.service' >/dev/null 2>&1 || true
  systemctl stop 'turingmarket-parser@*.service' >/dev/null 2>&1 || true
  systemctl reset-failed 'turingmarket-parser@*.service' >/dev/null 2>&1 || true
}

record_path() {
  local source="$1" name="$2" mode
  if [[ -e "$source" || -L "$source" ]]; then
    [[ ! -L "$source" ]] || { printf '%s\n' 'unsafe parser snapshot source' >&2; return 1; }
    if [[ -d "$source" ]]; then
      if [[ "$name" = parser-runtime ]]; then
        /usr/bin/python3 - "$source" "$SNAPSHOT_ROOT/parser-runtime.measurement" <<'PY'
import os
import stat
import sys

root, target = sys.argv[1:]
total_bytes = 0
total_inodes = 1
for current, directories, files in os.walk(root, topdown=True, followlinks=False):
    for name in directories + files:
        path = os.path.join(current, name)
        metadata = os.lstat(path)
        if stat.S_ISDIR(metadata.st_mode):
            total_inodes += 1
        elif stat.S_ISREG(metadata.st_mode):
            total_bytes += metadata.st_size
            total_inodes += 1
        else:
            raise SystemExit('parser runtime snapshot contains an unsupported entry')
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, f'{total_bytes}:{total_inodes}\n'.encode('ascii'))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
      fi
      tar --xattrs --acls --numeric-owner -C / -czf "$SNAPSHOT_ROOT/$name.tgz" "${source#/}"
      printf '%s\n' directory > "$SNAPSHOT_ROOT/$name.state"
    else
      mode="$(stat -c '%a' "$source")"
      install -D -o root -g root -m 0600 "$source" "$SNAPSHOT_ROOT/$name.file"
      printf '%s\n' "$mode" > "$SNAPSHOT_ROOT/$name.mode"
      printf '%s\n' file > "$SNAPSHOT_ROOT/$name.state"
    fi
  else
    if [[ "$name" = parser-runtime ]]; then
      printf '%s\n' '0:0' > "$SNAPSHOT_ROOT/parser-runtime.measurement"
    fi
    printf '%s\n' absent > "$SNAPSHOT_ROOT/$name.state"
  fi
}

snapshot_state() {
  [[ ! -e "$SNAPSHOT_ROOT" && ! -L "$SNAPSHOT_ROOT" ]] || { printf '%s\n' 'parser snapshot root must be absent' >&2; exit 66; }
  install -d -o root -g root -m 0700 "$SNAPSHOT_ROOT"
  if [[ -e "$STATE_ROOT" || -L "$STATE_ROOT" ]]; then
    [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || { printf '%s\n' 'unsafe parser state root' >&2; exit 66; }
    if find "$STATE_ROOT" -mindepth 1 -maxdepth 1 ! -name runtime-root ! -name jobs -print -quit | grep -q .; then
      printf '%s\n' 'unexpected parser state entry' >&2
      exit 66
    fi
    stat -c '%a:%u:%g' "$STATE_ROOT" > "$SNAPSHOT_ROOT/state-root.metadata"
    printf '%s\n' directory > "$SNAPSHOT_ROOT/state-root.state"
  else
    printf '%s\n' absent > "$SNAPSHOT_ROOT/state-root.state"
  fi
  record_path "$RUNTIME_ROOT" parser-runtime
  if [[ -e "$SPOOL_ROOT" || -L "$SPOOL_ROOT" ]]; then
    [[ -d "$SPOOL_ROOT" && ! -L "$SPOOL_ROOT" ]] || { printf '%s\n' 'unsafe parser spool root' >&2; exit 66; }
    stat -c '%a:%u:%g' "$SPOOL_ROOT" > "$SNAPSHOT_ROOT/spool.metadata"
    printf '%s\n' directory > "$SNAPSHOT_ROOT/spool.state"
  else
    printf '%s\n' absent > "$SNAPSHOT_ROOT/spool.state"
  fi
  record_path "$SERVICE_UNIT_TARGET" service-unit
  record_path "$SLICE_UNIT_TARGET" slice-unit
  record_path "$SELF_TEST_TARGET" self-test
  test -f "$SELF_PATH"
  test ! -L "$SELF_PATH"
  test "$(stat -c '%U:%G:%h' "$SELF_PATH")" = "root:root:1"
  (( (8#$(stat -c '%a' "$SELF_PATH") & 0022) == 0 ))
  record_path "$SELF_PATH" provisioner
  if getent passwd turingmarket-parser >/dev/null; then
    getent group turingmarket-parser >/dev/null || { printf '%s\n' 'incomplete parser identity' >&2; exit 66; }
    getent passwd turingmarket-parser > "$SNAPSHOT_ROOT/identity.passwd"
    getent group turingmarket-parser > "$SNAPSHOT_ROOT/identity.group"
    passwd -S turingmarket-parser > "$SNAPSHOT_ROOT/identity.status"
    id -nG turingmarket-parser > "$SNAPSHOT_ROOT/identity.groups"
    printf '%s\n' present > "$SNAPSHOT_ROOT/identity.state"
  else
    if getent group turingmarket-parser >/dev/null; then
      printf '%s\n' 'orphan parser group' >&2
      exit 66
    fi
    printf '%s\n' absent > "$SNAPSHOT_ROOT/identity.state"
  fi
  (
    cd "$SNAPSHOT_ROOT"
    find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
  )
  chmod 0600 "$SNAPSHOT_ROOT"/*
  chmod "$(cat "$SNAPSHOT_ROOT/provisioner.mode")" "$SNAPSHOT_ROOT/provisioner.file"
}

validate_identity() {
  local passwd_record group_record status memberships
  passwd_record="$(getent passwd turingmarket-parser)"
  group_record="$(getent group turingmarket-parser)"
  IFS=: read -r name _ uid gid _ home shell <<< "$passwd_record"
  IFS=: read -r group_name _ group_gid group_members <<< "$group_record"
  [[ "$name" = turingmarket-parser && "$group_name" = turingmarket-parser ]]
  [[ "$uid" =~ ^[0-9]+$ && "$uid" -gt 0 && "$gid" = "$group_gid" ]]
  [[ "$home" = /nonexistent && "$shell" = /usr/sbin/nologin && -z "$group_members" ]]
  memberships="$(id -nG turingmarket-parser)"
  [[ "$memberships" = turingmarket-parser ]]
  status="$(passwd -S turingmarket-parser | awk '{print $2}')"
  [[ "$status" = L || "$status" = LK ]]
}

validate_snapshot_identity() {
  validate_identity
  cmp -s <(getent passwd turingmarket-parser) "$SNAPSHOT_ROOT/identity.passwd"
  cmp -s <(getent group turingmarket-parser) "$SNAPSHOT_ROOT/identity.group"
  cmp -s <(passwd -S turingmarket-parser) "$SNAPSHOT_ROOT/identity.status"
  cmp -s <(id -nG turingmarket-parser) "$SNAPSHOT_ROOT/identity.groups"
}

inspect_runtime() {
  local root="$1"
  verify_trusted_verifier
  /usr/bin/node "$TRUSTED_VERIFIER" measure-runtime --root "$root" --require-root-ownership true
  verify_trusted_verifier
}

run_trusted_parser_self_test() {
  local mode="${1:---json}"
  local diagnostic_environment=()
  [[ "$mode" = --json || "$mode" = --diagnose ]] || return 64
  if [[ "$mode" = --diagnose ]]; then
    diagnostic_environment=(TM_UPLOAD_SANDBOX_DIAGNOSTIC=1)
  fi
  [[ "$(stat -Lc '%u:%g:%a:%h' -- "$SELF_TEST_TARGET")" = 0:0:555:1 ]]
  cmp -s -- "$SOURCE_ROOT/scripts/upload_sandbox_self_test.js" "$SELF_TEST_TARGET"
  /usr/bin/env -i \
    HOME=/root \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TMPDIR=/tmp \
    PYTHONNOUSERSITE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TM_UPLOAD_SANDBOX_MANIFEST_PATH="$SOURCE_ROOT/systemd/turingmarket-parser.manifest.json" \
    TM_UPLOAD_SANDBOX_SERVER_ROOT="$RUNTIME_ROOT/opt/turingmarket-parser/app" \
    "${diagnostic_environment[@]}" \
    "$SELF_TEST_TARGET" "$mode"
}

bind_installed_parser_acceptance() {
  local raw_envelope="$1" raw_file binding
  raw_file="$(mktemp /run/turingmarket-parser-self-test-envelope.XXXXXXXXXXXX)"
  install -o root -g root -m 0600 /dev/null "$raw_file"
  printf '%s\n' "$raw_envelope" > "$raw_file"
  verify_trusted_verifier
  if ! binding="$(/usr/bin/node "$TRUSTED_VERIFIER" bind-acceptance \
    --manifest "$SOURCE_ROOT/systemd/turingmarket-parser.manifest.json" \
    --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
    --expected-verifier-sha256 "$EXPECTED_VERIFIER_SHA256" \
    --raw-observations "$raw_file" \
    --runtime-root "$RUNTIME_ROOT" \
    --build-evidence "$BUILD_EVIDENCE")"; then
    rm -f -- "$raw_file"
    return 1
  fi
  verify_trusted_verifier
  rm -f -- "$raw_file"
  printf '%s\n' "$binding"
}

validate_runtime_against_manifest() {
  local root="$1" observed
  observed="$(inspect_runtime "$root")"
  TM_EXPECTED_SHA256="$EXPECTED_SHA256" \
  TM_RUNTIME_OBSERVED="$observed" \
  TM_PROVISION_DIAGNOSTIC="${TM_UPLOAD_SANDBOX_PROVISION_DIAGNOSTIC:-0}" \
  /usr/bin/python3 - "$SOURCE_ROOT/systemd/turingmarket-parser.manifest.json" <<'PY'
import json, os, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    manifest = json.load(handle)
observed = json.loads(os.environ['TM_RUNTIME_OBSERVED'])
expected = manifest.get('runtime_tree', {})
projection = {key: expected.get(key) for key in ('format', 'sha256', 'files', 'directories', 'bytes')}
if projection.get('sha256') != os.environ['TM_EXPECTED_SHA256'] or observed != projection:
    if os.environ.get('TM_PROVISION_DIAGNOSTIC') == '1':
        details = {
            'expected': projection,
            'observed': observed,
            'provided_sha256': os.environ['TM_EXPECTED_SHA256'],
        }
        print(
            'parser runtime evidence details:' +
            json.dumps(details, sort_keys=True, separators=(',', ':')),
            file=sys.stderr,
        )
    raise SystemExit('parser runtime evidence mismatch')
PY
}

validate_snapshot() {
  [[ -d "$SNAPSHOT_ROOT" && ! -L "$SNAPSHOT_ROOT" && -f "$SNAPSHOT_ROOT/SHA256SUMS" ]] || {
    printf '%s\n' 'parser snapshot is required' >&2
    return 1
  }
  (cd "$SNAPSHOT_ROOT" && sha256sum --check --status SHA256SUMS)
  case "$(cat "$SNAPSHOT_ROOT/state-root.state")" in
    absent) [[ ! -e "$SNAPSHOT_ROOT/state-root.metadata" ]] ;;
    directory) [[ -f "$SNAPSHOT_ROOT/state-root.metadata" ]] && grep -Eq '^[0-7]{3,4}:[0-9]+:[0-9]+$' "$SNAPSHOT_ROOT/state-root.metadata" ;;
    *) return 1 ;;
  esac
  for name in parser-runtime; do
    case "$(cat "$SNAPSHOT_ROOT/$name.state")" in
      absent) [[ ! -e "$SNAPSHOT_ROOT/$name.tgz" ]] ;;
      directory) [[ -f "$SNAPSHOT_ROOT/$name.tgz" ]] ;;
      *) return 1 ;;
    esac
  done
  [[ -f "$SNAPSHOT_ROOT/parser-runtime.measurement" && ! -L "$SNAPSHOT_ROOT/parser-runtime.measurement" ]]
  grep -Eq '^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$' "$SNAPSHOT_ROOT/parser-runtime.measurement"
  if [[ "$(cat "$SNAPSHOT_ROOT/parser-runtime.state")" = directory ]]; then
    /usr/bin/python3 - "$SNAPSHOT_ROOT/parser-runtime.tgz" "$SNAPSHOT_ROOT/parser-runtime.measurement" <<'PY'
import pathlib
import re
import sys
import tarfile

archive_path, measurement_path = sys.argv[1:]
with open(measurement_path, encoding='ascii') as handle:
    match = re.fullmatch(r'(0|[1-9][0-9]*):(0|[1-9][0-9]*)\n?', handle.read())
if not match:
    raise SystemExit('invalid parser runtime snapshot measurement')
expected_bytes, expected_inodes = map(int, match.groups())
seen = set()
total_bytes = 0
total_inodes = 0
prefix = pathlib.PurePosixPath('var/lib/turingmarket-parser/runtime-root')
with tarfile.open(archive_path, mode='r:gz') as archive:
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or path in seen:
            raise SystemExit('unsafe parser runtime snapshot member path')
        seen.add(path)
        if path != prefix and prefix not in path.parents:
            raise SystemExit('parser runtime snapshot member escaped runtime root')
        if not (member.isdir() or member.isreg()):
            raise SystemExit('parser runtime snapshot contains an unsupported member')
        total_inodes += 1
        if member.isreg():
            total_bytes += member.size
if total_bytes != expected_bytes or total_inodes != expected_inodes:
    raise SystemExit('parser runtime snapshot measurement mismatch')
PY
  fi
  case "$(cat "$SNAPSHOT_ROOT/spool.state")" in
    absent) [[ ! -e "$SNAPSHOT_ROOT/spool.metadata" ]] ;;
    directory) [[ -f "$SNAPSHOT_ROOT/spool.metadata" ]] && grep -Eq '^[0-7]{3,4}:[0-9]+:[0-9]+$' "$SNAPSHOT_ROOT/spool.metadata" ;;
    *) return 1 ;;
  esac
  for name in service-unit slice-unit self-test provisioner; do
    case "$(cat "$SNAPSHOT_ROOT/$name.state")" in
      absent) [[ ! -e "$SNAPSHOT_ROOT/$name.file" && ! -e "$SNAPSHOT_ROOT/$name.mode" ]] ;;
      file) [[ -f "$SNAPSHOT_ROOT/$name.file" && -f "$SNAPSHOT_ROOT/$name.mode" ]] && grep -Eq '^[0-7]{3,4}$' "$SNAPSHOT_ROOT/$name.mode" ;;
      *) return 1 ;;
    esac
  done
  case "$(cat "$SNAPSHOT_ROOT/identity.state")" in
    absent) ;;
    present) [[ -f "$SNAPSHOT_ROOT/identity.passwd" && -f "$SNAPSHOT_ROOT/identity.group" && -f "$SNAPSHOT_ROOT/identity.status" && -f "$SNAPSHOT_ROOT/identity.groups" ]] ;;
    *) return 1 ;;
  esac
}

create_identity_if_absent() {
  if ! getent passwd turingmarket-parser >/dev/null; then
    getent group turingmarket-parser >/dev/null || groupadd --system turingmarket-parser
    useradd --system --gid turingmarket-parser --home-dir /nonexistent --shell /usr/sbin/nologin turingmarket-parser
    passwd -l turingmarket-parser >/dev/null
  fi
  validate_identity
}

# BEGIN PARSER RUNTIME TRANSACTION
runtime_transaction_paths() {
  RUNTIME_TRANSACTION_ROOT="$(dirname "$RUNTIME_ROOT")"
  RUNTIME_TRANSACTION_STAGE="$RUNTIME_TRANSACTION_ROOT/.runtime-root.install"
  RUNTIME_TRANSACTION_PREVIOUS="$RUNTIME_TRANSACTION_ROOT/.runtime-root.previous"
  RUNTIME_TRANSACTION_JOURNAL="$RUNTIME_TRANSACTION_ROOT/.runtime-root.transaction"
  RUNTIME_TRANSACTION_JOURNAL_NEW="$RUNTIME_TRANSACTION_ROOT/.runtime-root.transaction.new"
}

runtime_path_identity() {
  [[ -d "$1" && ! -L "$1" ]] || return 1
  stat -c '%d:%i' -- "$1"
}

safe_runtime_transaction_directory() {
  local metadata
  [[ -d "$1" && ! -L "$1" ]] || return 1
  metadata="$(stat -c '%u:%g:%a' -- "$1")"
  [[ "$metadata" =~ ^0:0:[0-7]{3,4}$ ]] || return 1
  (( (8#${metadata##*:} & 0022) == 0 ))
}

safe_runtime_transaction_file() {
  [[ -f "$1" && ! -L "$1" && "$(stat -c '%u:%g:%a:%h' -- "$1")" = 0:0:600:1 ]]
}

valid_runtime_transaction_journal() {
  local journal_path="$1" final_byte
  local -a entries=()
  [[ "$(stat -c '%s' -- "$journal_path")" -le 4096 ]] || return 1
  final_byte="$(tail -c 1 -- "$journal_path" | od -An -t u1 | tr -d '[:space:]')"
  [[ "$final_byte" = 10 ]] || return 1
  if LC_ALL=C grep -q '[^ -~]' "$journal_path"; then
    return 1
  fi
  mapfile -t entries < "$journal_path"
  [[ ${#entries[@]} -eq 7 &&
     "${entries[0]}" = format=tm-parser-runtime-transaction-v1 &&
     "${entries[1]}" = "runtime_root=$RUNTIME_ROOT" &&
     "${entries[2]}" = "snapshot_root=$SNAPSHOT_ROOT" &&
     "${entries[3]}" =~ ^snapshot_sums_sha256=([0-9a-f]{64})$ &&
     "${entries[4]}" =~ ^expected_sha256=([0-9a-f]{64})$ &&
     "${entries[5]}" =~ ^candidate_identity=([0-9]+:[0-9]+)$ &&
     "${entries[6]}" =~ ^previous_identity=(absent|[0-9]+:[0-9]+)$ ]]
}

exchange_runtime_paths() {
  python3 - "$1" "$2" <<'PY'
import ctypes, os, sys
left, right = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
fn = libc.renameat2
fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
fn.restype = ctypes.c_int
RENAME_EXCHANGE = 2
if fn(-100, os.fsencode(left), -100, os.fsencode(right), RENAME_EXCHANGE) != 0:
    raise OSError(ctypes.get_errno(), 'atomic parser runtime exchange failed')
PY
}

write_runtime_transaction_journal() {
  local candidate_identity previous_identity snapshot_sums_sha256
  runtime_transaction_paths
  safe_runtime_transaction_directory "$RUNTIME_TRANSACTION_ROOT"
  safe_runtime_transaction_directory "$RUNTIME_TRANSACTION_STAGE"
  candidate_identity="$(runtime_path_identity "$RUNTIME_TRANSACTION_STAGE")"
  if [[ -e "$RUNTIME_ROOT" || -L "$RUNTIME_ROOT" ]]; then
    safe_runtime_transaction_directory "$RUNTIME_ROOT"
    previous_identity="$(runtime_path_identity "$RUNTIME_ROOT")"
  else
    previous_identity=absent
  fi
  [[ -f "$SNAPSHOT_ROOT/SHA256SUMS" && ! -L "$SNAPSHOT_ROOT/SHA256SUMS" ]]
  snapshot_sums_sha256="$(sha256sum "$SNAPSHOT_ROOT/SHA256SUMS" | awk '{print $1}')"
  [[ ! -e "$RUNTIME_TRANSACTION_JOURNAL" && ! -L "$RUNTIME_TRANSACTION_JOURNAL" &&
     ! -e "$RUNTIME_TRANSACTION_JOURNAL_NEW" && ! -L "$RUNTIME_TRANSACTION_JOURNAL_NEW" ]]
  (
    umask 077
    printf '%s\n' \
      'format=tm-parser-runtime-transaction-v1' \
      "runtime_root=$RUNTIME_ROOT" \
      "snapshot_root=$SNAPSHOT_ROOT" \
      "snapshot_sums_sha256=$snapshot_sums_sha256" \
      "expected_sha256=$EXPECTED_SHA256" \
      "candidate_identity=$candidate_identity" \
      "previous_identity=$previous_identity" > "$RUNTIME_TRANSACTION_JOURNAL_NEW"
  )
  chown 0:0 "$RUNTIME_TRANSACTION_JOURNAL_NEW"
  chmod 0600 "$RUNTIME_TRANSACTION_JOURNAL_NEW"
  sync -f "$RUNTIME_TRANSACTION_JOURNAL_NEW"
  mv -T -- "$RUNTIME_TRANSACTION_JOURNAL_NEW" "$RUNTIME_TRANSACTION_JOURNAL"
  sync -f "$RUNTIME_TRANSACTION_ROOT"
}

recover_runtime_transaction() {
  local action="$1" candidate_identity previous_identity snapshot_sums_sha256
  local runtime_identity=absent stage_identity=absent previous_path_identity=absent state entry leaf
  local -a journal=()
  RUNTIME_TRANSACTION_RECOVERY=none
  runtime_transaction_paths
  safe_runtime_transaction_directory "$RUNTIME_TRANSACTION_ROOT" || {
    printf '%s\n' 'unsafe parser runtime transaction root; no changes made' >&2
    return 66
  }
  if [[ "$action" != install && "$action" != rollback ]]; then
    printf '%s\n' 'invalid parser runtime recovery action; no changes made' >&2
    return 66
  fi
  while IFS= read -r -d '' entry; do
    leaf="${entry##*/}"
    if [[ "$leaf" =~ ^\.runtime-root\.(install|previous)\.[0-9]+$ ]]; then
      printf '%s\n' 'legacy PID-suffixed parser runtime remnant requires manual reconciliation; no changes made' >&2
      return 66
    fi
  done < <(find "$RUNTIME_TRANSACTION_ROOT" -mindepth 1 -maxdepth 1 -print0)
  if [[ -e "$RUNTIME_TRANSACTION_JOURNAL_NEW" || -L "$RUNTIME_TRANSACTION_JOURNAL_NEW" ]]; then
    if [[ -e "$RUNTIME_TRANSACTION_JOURNAL" || -L "$RUNTIME_TRANSACTION_JOURNAL" ]]; then
      printf '%s\n' 'ambiguous parser runtime transaction journals; no changes made' >&2
      return 66
    fi
    safe_runtime_transaction_file "$RUNTIME_TRANSACTION_JOURNAL_NEW" || {
      printf '%s\n' 'unsafe parser runtime transaction journal staging file; no changes made' >&2
      return 66
    }
    valid_runtime_transaction_journal "$RUNTIME_TRANSACTION_JOURNAL_NEW" || {
      printf '%s\n' 'invalid parser runtime transaction journal staging file; no changes made' >&2
      return 66
    }
    mapfile -t journal < "$RUNTIME_TRANSACTION_JOURNAL_NEW"
    snapshot_sums_sha256="${journal[3]#snapshot_sums_sha256=}"
    candidate_identity="${journal[5]#candidate_identity=}"
    previous_identity="${journal[6]#previous_identity=}"
    if [[ ! -f "$SNAPSHOT_ROOT/SHA256SUMS" || -L "$SNAPSHOT_ROOT/SHA256SUMS" ]] ||
       [[ "$(sha256sum "$SNAPSHOT_ROOT/SHA256SUMS" | awk '{print $1}')" != "$snapshot_sums_sha256" ]]; then
      printf '%s\n' 'parser runtime transaction snapshot identity mismatch; no changes made' >&2
      return 66
    fi
    if [[ "$action" = install && "${journal[4]#expected_sha256=}" != "$EXPECTED_SHA256" ]]; then
      printf '%s\n' 'parser runtime transaction release identity mismatch; no changes made' >&2
      return 66
    fi
    for target in "$RUNTIME_ROOT" "$RUNTIME_TRANSACTION_STAGE" "$RUNTIME_TRANSACTION_PREVIOUS"; do
      if [[ -e "$target" || -L "$target" ]]; then
        safe_runtime_transaction_directory "$target" || {
          printf '%s\n' 'unsafe parser runtime transaction path; no changes made' >&2
          return 66
        }
      fi
    done
    runtime_identity=absent
    stage_identity=absent
    previous_path_identity=absent
    [[ ! -e "$RUNTIME_ROOT" ]] || runtime_identity="$(runtime_path_identity "$RUNTIME_ROOT")"
    [[ ! -e "$RUNTIME_TRANSACTION_STAGE" ]] || stage_identity="$(runtime_path_identity "$RUNTIME_TRANSACTION_STAGE")"
    [[ ! -e "$RUNTIME_TRANSACTION_PREVIOUS" ]] || previous_path_identity="$(runtime_path_identity "$RUNTIME_TRANSACTION_PREVIOUS")"
    if ! { [[ "$previous_identity" = absent && "$runtime_identity" = absent &&
              "$stage_identity" = "$candidate_identity" && "$previous_path_identity" = absent ]] ||
           [[ "$previous_identity" != absent && "$runtime_identity" = "$previous_identity" &&
              "$stage_identity" = "$candidate_identity" && "$previous_path_identity" = absent ]]; }; then
      printf '%s\n' 'parser runtime transaction state does not match its staging journal; no changes made' >&2
      return 66
    fi
    if [[ "$action" = install ]] && ! validate_runtime_against_manifest "$RUNTIME_TRANSACTION_STAGE"; then
      printf '%s\n' 'journaled parser runtime candidate failed verification; no changes made' >&2
      return 66
    fi
    sync -f "$RUNTIME_TRANSACTION_JOURNAL_NEW"
    mv -T -- "$RUNTIME_TRANSACTION_JOURNAL_NEW" "$RUNTIME_TRANSACTION_JOURNAL"
    sync -f "$RUNTIME_TRANSACTION_ROOT"
  fi
  if [[ ! -e "$RUNTIME_TRANSACTION_JOURNAL" && ! -L "$RUNTIME_TRANSACTION_JOURNAL" ]]; then
    if [[ -e "$RUNTIME_TRANSACTION_PREVIOUS" || -L "$RUNTIME_TRANSACTION_PREVIOUS" ]]; then
      printf '%s\n' 'unjournaled parser previous runtime requires manual reconciliation; no changes made' >&2
      return 66
    fi
    if [[ -e "$RUNTIME_TRANSACTION_STAGE" || -L "$RUNTIME_TRANSACTION_STAGE" ]]; then
      safe_runtime_transaction_directory "$RUNTIME_TRANSACTION_STAGE" || {
        printf '%s\n' 'unsafe unjournaled parser runtime stage; no changes made' >&2
        return 66
      }
      [[ "$action" = install ]] || {
        printf '%s\n' 'unjournaled parser runtime stage requires install verification; no changes made' >&2
        return 66
      }
      validate_runtime_against_manifest "$RUNTIME_TRANSACTION_STAGE" || {
        printf '%s\n' 'unjournaled parser runtime stage failed verification; no changes made' >&2
        return 66
      }
      if [[ -e "$RUNTIME_ROOT" || -L "$RUNTIME_ROOT" ]]; then
        safe_runtime_transaction_directory "$RUNTIME_ROOT" || {
          printf '%s\n' 'unsafe parser runtime transaction path; no changes made' >&2
          return 66
        }
        if validate_runtime_against_manifest "$RUNTIME_ROOT" >/dev/null 2>&1; then
          printf '%s\n' 'ambiguous unjournaled parser runtime stage; no changes made' >&2
          return 66
        fi
      fi
    fi
    [[ ! -e "$RUNTIME_TRANSACTION_STAGE" ]] || rm -rf --one-file-system -- "$RUNTIME_TRANSACTION_STAGE"
    if [[ "$RUNTIME_TRANSACTION_RECOVERY" = none ]] &&
       [[ ! -e "$RUNTIME_TRANSACTION_STAGE" && ! -e "$RUNTIME_TRANSACTION_PREVIOUS" ]]; then
      RUNTIME_TRANSACTION_RECOVERY=cleaned
    fi
    sync -f "$RUNTIME_TRANSACTION_ROOT"
    return 0
  fi
  safe_runtime_transaction_file "$RUNTIME_TRANSACTION_JOURNAL" || {
    printf '%s\n' 'unsafe parser runtime transaction journal; no changes made' >&2
    return 66
  }
  valid_runtime_transaction_journal "$RUNTIME_TRANSACTION_JOURNAL" || {
    printf '%s\n' 'invalid parser runtime transaction journal; no changes made' >&2
    return 66
  }
  mapfile -t journal < "$RUNTIME_TRANSACTION_JOURNAL"
  snapshot_sums_sha256="${journal[3]#snapshot_sums_sha256=}"
  candidate_identity="${journal[5]#candidate_identity=}"
  previous_identity="${journal[6]#previous_identity=}"
  [[ "$(sha256sum "$SNAPSHOT_ROOT/SHA256SUMS" | awk '{print $1}')" = "$snapshot_sums_sha256" ]] || {
    printf '%s\n' 'parser runtime transaction snapshot identity mismatch; no changes made' >&2
    return 66
  }
  if [[ "$action" = install && "${journal[4]#expected_sha256=}" != "$EXPECTED_SHA256" ]]; then
    printf '%s\n' 'parser runtime transaction release identity mismatch; no changes made' >&2
    return 66
  fi
  for target in "$RUNTIME_ROOT" "$RUNTIME_TRANSACTION_STAGE" "$RUNTIME_TRANSACTION_PREVIOUS"; do
    if [[ -e "$target" || -L "$target" ]]; then
      safe_runtime_transaction_directory "$target" || {
        printf '%s\n' 'unsafe parser runtime transaction path; no changes made' >&2
        return 66
      }
    fi
  done
  [[ ! -e "$RUNTIME_ROOT" ]] || runtime_identity="$(runtime_path_identity "$RUNTIME_ROOT")"
  [[ ! -e "$RUNTIME_TRANSACTION_STAGE" ]] || stage_identity="$(runtime_path_identity "$RUNTIME_TRANSACTION_STAGE")"
  [[ ! -e "$RUNTIME_TRANSACTION_PREVIOUS" ]] || previous_path_identity="$(runtime_path_identity "$RUNTIME_TRANSACTION_PREVIOUS")"
  if [[ "$previous_identity" = absent && "$runtime_identity" = absent && "$stage_identity" = "$candidate_identity" && "$previous_path_identity" = absent ]]; then
    state=pre-install
  elif [[ "$previous_identity" != absent && "$runtime_identity" = "$previous_identity" && "$stage_identity" = "$candidate_identity" && "$previous_path_identity" = absent ]]; then
    state=pre-exchange
  elif [[ "$previous_identity" != absent && "$runtime_identity" = "$candidate_identity" && "$stage_identity" = "$previous_identity" && "$previous_path_identity" = absent ]]; then
    state=post-exchange
  elif [[ "$previous_identity" != absent && "$runtime_identity" = "$candidate_identity" && "$stage_identity" = absent && "$previous_path_identity" = "$previous_identity" ]]; then
    state=previous-parked
  elif [[ "$runtime_identity" = "$candidate_identity" && "$stage_identity" = absent && "$previous_path_identity" = absent ]]; then
    state=previous-removed
  else
    printf '%s\n' 'parser runtime transaction state does not match its journal; no changes made' >&2
    return 66
  fi
  if [[ "$action" = install ]]; then
    validate_runtime_against_manifest "$([[ "$state" = pre-install || "$state" = pre-exchange ]] && printf '%s' "$RUNTIME_TRANSACTION_STAGE" || printf '%s' "$RUNTIME_ROOT")" || {
      printf '%s\n' 'journaled parser runtime candidate failed verification; no changes made' >&2
      return 66
    }
  elif [[ "$action" != rollback ]]; then
    printf '%s\n' 'invalid parser runtime recovery action; no changes made' >&2
    return 66
  fi
  case "$state" in
    pre-install) mv -T -- "$RUNTIME_TRANSACTION_STAGE" "$RUNTIME_ROOT" ;;
    pre-exchange) exchange_runtime_paths "$RUNTIME_ROOT" "$RUNTIME_TRANSACTION_STAGE" ;;
  esac
  sync -f "$RUNTIME_TRANSACTION_ROOT"
  if [[ "$state" = pre-exchange || "$state" = post-exchange ]]; then
    mv -T -- "$RUNTIME_TRANSACTION_STAGE" "$RUNTIME_TRANSACTION_PREVIOUS"
    sync -f "$RUNTIME_TRANSACTION_ROOT"
  fi
  if [[ "$previous_identity" != absent && "$state" != previous-removed ]]; then
    rm -rf --one-file-system -- "$RUNTIME_TRANSACTION_PREVIOUS"
    sync -f "$RUNTIME_TRANSACTION_ROOT"
  fi
  rm -f -- "$RUNTIME_TRANSACTION_JOURNAL"
  sync -f "$RUNTIME_TRANSACTION_ROOT"
  RUNTIME_TRANSACTION_RECOVERY=completed
}
# END PARSER RUNTIME TRANSACTION

atomic_runtime_install() {
  runtime_transaction_paths
  install -d -o root -g root -m 0700 "$RUNTIME_TRANSACTION_ROOT"
  recover_runtime_transaction install
  [[ "$RUNTIME_TRANSACTION_RECOVERY" != completed ]] || return 0
  [[ -d "$STAGED_RUNTIME" && ! -L "$STAGED_RUNTIME" &&
     ! -e "$RUNTIME_TRANSACTION_STAGE" && ! -e "$RUNTIME_TRANSACTION_PREVIOUS" &&
     ! -e "$RUNTIME_TRANSACTION_JOURNAL" && ! -e "$RUNTIME_TRANSACTION_JOURNAL_NEW" ]]
  cp -a --reflink=auto "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"
  chown -R 0:0 "$RUNTIME_TRANSACTION_STAGE"
  chmod -R go-w "$RUNTIME_TRANSACTION_STAGE"
  validate_runtime_against_manifest "$RUNTIME_TRANSACTION_STAGE"
  write_runtime_transaction_journal
  if [[ -e "$RUNTIME_ROOT" ]]; then
    exchange_runtime_paths "$RUNTIME_ROOT" "$RUNTIME_TRANSACTION_STAGE"
    sync -f "$RUNTIME_TRANSACTION_ROOT"
    mv -T -- "$RUNTIME_TRANSACTION_STAGE" "$RUNTIME_TRANSACTION_PREVIOUS"
    sync -f "$RUNTIME_TRANSACTION_ROOT"
    rm -rf --one-file-system -- "$RUNTIME_TRANSACTION_PREVIOUS"
  else
    mv -T -- "$RUNTIME_TRANSACTION_STAGE" "$RUNTIME_ROOT"
  fi
  sync -f "$RUNTIME_TRANSACTION_ROOT"
  rm -f -- "$RUNTIME_TRANSACTION_JOURNAL"
  sync -f "$RUNTIME_ROOT"
  sync -f "$RUNTIME_TRANSACTION_ROOT"
}

verify_installed_state() {
  local raw_envelope binding
  [[ -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] || usage
  [[ -f "$BUILD_EVIDENCE" && ! -L "$BUILD_EVIDENCE" ]] || usage
  [[ -f "$SELF_TEST_TARGET" && ! -L "$SELF_TEST_TARGET" ]] || usage
  verify_trusted_verifier
  validate_identity
  systemctl cat turingmarket-parser@.service >/dev/null
  systemctl cat turingmarket-parser.slice >/dev/null
  validate_runtime_against_manifest "$RUNTIME_ROOT"
  raw_envelope="$(run_trusted_parser_self_test --json)"
  binding="$(bind_installed_parser_acceptance "$raw_envelope")"
  [[ -n "$binding" ]] || {
    printf '%s\n' 'trusted installed parser acceptance binding is empty' >&2
    return 1
  }
  printf '%s\n' "$binding"
}

install_state() {
  [[ -d "$STAGED_RUNTIME" && ! -L "$STAGED_RUNTIME" && -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] || usage
  [[ -n "$EXPECTED_SHA256" ]] || usage
  verify_trusted_verifier
  validate_snapshot
  for required in \
    systemd/turingmarket-parser@.service \
    systemd/turingmarket-parser.slice \
    systemd/turingmarket-parser.manifest.json \
    scripts/upload_sandbox_self_test.js; do
    [[ -f "$SOURCE_ROOT/$required" && ! -L "$SOURCE_ROOT/$required" ]] || usage
  done
  if [[ -e "$SPOOL_ROOT" ]]; then
    [[ -d "$SPOOL_ROOT" && ! -L "$SPOOL_ROOT" && -z "$(find "$SPOOL_ROOT" -mindepth 1 -print -quit)" ]] || {
      printf '%s\n' 'parser spool must be empty before install' >&2
      exit 66
    }
  fi
  validate_runtime_against_manifest "$STAGED_RUNTIME"
  ROLLBACK_ARMED=1
  stop_parser_units
  create_identity_if_absent
  install -d -o root -g root -m 0700 /var/lib/turingmarket-parser /var/lib/turingmarket-parser/jobs
  atomic_runtime_install
  install -o root -g root -m 0644 "$SOURCE_ROOT/systemd/turingmarket-parser@.service" "$SERVICE_UNIT_TARGET"
  install -o root -g root -m 0644 "$SOURCE_ROOT/systemd/turingmarket-parser.slice" "$SLICE_UNIT_TARGET"
  install -D -o root -g root -m 0555 "$SOURCE_ROOT/scripts/upload_sandbox_self_test.js" "$SELF_TEST_TARGET"
  systemctl daemon-reload
  systemctl cat turingmarket-parser@.service >/dev/null
  systemctl cat turingmarket-parser.slice >/dev/null
  validate_runtime_against_manifest "$RUNTIME_ROOT"
  if [[ "${TM_UPLOAD_SANDBOX_PROVISION_DIAGNOSTIC:-0}" = 1 ]]; then
    run_trusted_parser_self_test --diagnose
  fi
  SelfTestBinding="$(verify_installed_state)"
  ROLLBACK_ARMED=0
}

restore_file() {
  local name="$1" target="$2" state
  state="$(cat "$SNAPSHOT_ROOT/$name.state")"
  case "$state" in
    absent) rm -f -- "$target" ;;
    file) install -D -o root -g root -m "$(cat "$SNAPSHOT_ROOT/$name.mode")" "$SNAPSHOT_ROOT/$name.file" "$target" ;;
    *) printf '%s\n' 'invalid parser snapshot state' >&2; return 1 ;;
  esac
}

rollback_from_snapshot() {
  validate_snapshot
  IdentityState="$(cat "$SNAPSHOT_ROOT/identity.state")"
  case "$IdentityState" in
    present) validate_snapshot_identity ;;
    absent) ;;
    *) printf '%s\n' 'invalid parser identity snapshot state' >&2; exit 66 ;;
  esac
  stop_parser_units
  install -d -o root -g root -m 0700 "$(dirname "$RUNTIME_ROOT")"
  recover_runtime_transaction rollback
  rm -rf --one-file-system -- "$RUNTIME_ROOT"
  rm -rf --one-file-system -- "$SPOOL_ROOT"
  case "$(cat "$SNAPSHOT_ROOT/parser-runtime.state")" in
    absent) ;;
    directory) tar --xattrs --acls --numeric-owner -C / -xzf "$SNAPSHOT_ROOT/parser-runtime.tgz" ;;
    *) printf '%s\n' 'invalid parser runtime snapshot state' >&2; exit 66 ;;
  esac
  case "$(cat "$SNAPSHOT_ROOT/spool.state")" in
    absent) ;;
    directory)
      IFS=: read -r spool_mode spool_uid spool_gid < "$SNAPSHOT_ROOT/spool.metadata"
      install -d -o "$spool_uid" -g "$spool_gid" -m "$spool_mode" "$SPOOL_ROOT"
      ;;
    *) printf '%s\n' 'invalid parser spool snapshot state' >&2; exit 66 ;;
  esac
  restore_file service-unit "$SERVICE_UNIT_TARGET"
  restore_file slice-unit "$SLICE_UNIT_TARGET"
  restore_file self-test "$SELF_TEST_TARGET"
  case "$IdentityState" in
    present) ;;
    absent)
      if getent passwd turingmarket-parser >/dev/null; then
        userdel turingmarket-parser
      fi
      if getent group turingmarket-parser >/dev/null; then
        groupdel turingmarket-parser
      fi
      ;;
    *) printf '%s\n' 'invalid parser identity snapshot state' >&2; exit 66 ;;
  esac
  case "$(cat "$SNAPSHOT_ROOT/state-root.state")" in
    absent)
      if [[ -d "$STATE_ROOT" && -z "$(find "$STATE_ROOT" -mindepth 1 -print -quit)" ]]; then rmdir "$STATE_ROOT"; fi
      ;;
    directory)
      IFS=: read -r state_mode state_uid state_gid < "$SNAPSHOT_ROOT/state-root.metadata"
      install -d -o "$state_uid" -g "$state_gid" -m "$state_mode" "$STATE_ROOT"
      ;;
    *) printf '%s\n' 'invalid parser state root snapshot' >&2; exit 66 ;;
  esac
  systemctl daemon-reload
}

ROLLBACK_ARMED=0
on_error() {
  local code=$? rollback_code=0
  trap - ERR
  if [[ "$ACTION" = install && "$ROLLBACK_ARMED" = 1 ]]; then
    flock -u 9 || true
    set +e
    "$SNAPSHOT_ROOT/provisioner.file" rollback \
      --snapshot-root "$SNAPSHOT_ROOT" \
      --runtime-root "$RUNTIME_ROOT" \
      --service-unit-target "$SERVICE_UNIT_TARGET" \
      --slice-unit-target "$SLICE_UNIT_TARGET" \
      --self-test-target "$SELF_TEST_TARGET"
    rollback_code=$?
    set -e
  fi
  if ((rollback_code != 0)); then
    printf '%s\n' 'parser provisioning and automatic rollback failed' >&2
    exit 70
  fi
  printf '%s\n' 'parser provisioning failed; prior state restored' >&2
  exit "$code"
}
trap on_error ERR
case "$ACTION" in
  snapshot) snapshot_state ;;
  install) install_state ;;
  verify) verify_installed_state ;;
  rollback) rollback_from_snapshot ;;
esac
