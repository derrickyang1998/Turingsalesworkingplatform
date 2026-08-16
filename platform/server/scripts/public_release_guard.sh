#!/usr/bin/env bash
set -eEuo pipefail

umask 077

MODE="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi

StateFile=""
MaintenanceSource=""
MaintenanceConfig=""
RecoveryLink=""
SiteLink=""
GuardUnit=""
ControllerPid=""
ControllerStartTicks=""
DeadlineEpoch=""
DropIn=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state-file) StateFile="${2:-}"; shift 2 ;;
    --maintenance-source) MaintenanceSource="${2:-}"; shift 2 ;;
    --maintenance-config) MaintenanceConfig="${2:-}"; shift 2 ;;
    --recovery-link) RecoveryLink="${2:-}"; shift 2 ;;
    --site-link) SiteLink="${2:-}"; shift 2 ;;
    --unit) GuardUnit="${2:-}"; shift 2 ;;
    --controller-pid) ControllerPid="${2:-}"; shift 2 ;;
    --controller-start-ticks) ControllerStartTicks="${2:-}"; shift 2 ;;
    --deadline-epoch) DeadlineEpoch="${2:-}"; shift 2 ;;
    --drop-in) DropIn="${2:-}"; shift 2 ;;
    *) echo "Unknown public release guard argument: $1" >&2; exit 64 ;;
  esac
done

TEST_MODE="${TM_PUBLIC_GUARD_TEST_MODE:-0}"
if [ "$TEST_MODE" = "1" ]; then
  TestRoot="$(realpath -m -- "${TM_PUBLIC_GUARD_TEST_ROOT:?test root is required}")"
  TestBin="$(realpath -e -- "${TM_PUBLIC_GUARD_TEST_BIN:?test command root is required}")"
  case "$TestRoot" in /tmp/tm-public-guard-test-*|/[a-zA-Z]/Users/*/AppData/Local/Temp/tm-public-guard-test-*) ;;
    *) echo "Unsafe public guard test root" >&2; exit 64 ;;
  esac
  NGINX="$TestBin/nginx"
  SYSTEMCTL="$TestBin/systemctl"
  SYSTEMD_RUN="$TestBin/systemd-run"
  CURL="$TestBin/curl"
  SS="$TestBin/ss"
  SYNC="$TestBin/sync"
  LN="$TestBin/ln"
  INSTALL="$(command -v install)"
  RM="$(command -v rm)"
  MV="$(command -v mv)"
  CHMOD="$(command -v chmod)"
  MKDIR="$(command -v mkdir)"
  RMDIR="$(command -v rmdir)"
  DATE="$(command -v date)"
  SLEEP="$(command -v sleep)"
  STAT="$(command -v stat)"
  PYTHON3="$(realpath -e -- "${TM_PUBLIC_GUARD_TEST_PYTHON:?test Python is required}")"
else
  test "$(id -u)" = "0"
  TestRoot=""
  NGINX=/usr/sbin/nginx
  SYSTEMCTL=/usr/bin/systemctl
  SYSTEMD_RUN=/usr/bin/systemd-run
  CURL=/usr/bin/curl
  SS=/usr/bin/ss
  SYNC=/usr/bin/sync
  LN=/usr/bin/ln
  INSTALL=/usr/bin/install
  RM=/usr/bin/rm
  MV=/usr/bin/mv
  CHMOD=/usr/bin/chmod
  MKDIR=/usr/bin/mkdir
  RMDIR=/usr/bin/rmdir
  DATE=/usr/bin/date
  SLEEP=/usr/bin/sleep
  STAT=/usr/bin/stat
  PYTHON3=/usr/bin/python3
fi

for command_path in "$NGINX" "$SYSTEMCTL" "$CURL" "$SS" "$SYNC" "$LN" \
  "$INSTALL" "$RM" "$MV" "$CHMOD" "$MKDIR" "$RMDIR" "$DATE" "$SLEEP" "$STAT" "$PYTHON3"; do
  test -x "$command_path"
done

inside_test_root() {
  local Candidate
  Candidate="$(realpath -m -- "$1")"
  case "$Candidate" in "$TestRoot"/*) return 0 ;; *) return 1 ;; esac
}

validate_paths() {
  test -n "$StateFile"
  if [ "$TEST_MODE" = "1" ]; then
    inside_test_root "$StateFile"
    [ -z "$MaintenanceSource" ] || inside_test_root "$MaintenanceSource"
    [ -z "$MaintenanceConfig" ] || inside_test_root "$MaintenanceConfig"
    [ -z "$RecoveryLink" ] || inside_test_root "$RecoveryLink"
    [ -z "$SiteLink" ] || inside_test_root "$SiteLink"
    [ -z "$DropIn" ] || inside_test_root "$DropIn"
    return 0
  fi

  test "$StateFile" = "/root/turingmarket/.deploy-v030.lock/public-gate-guard"
  if [ -n "$MaintenanceSource" ]; then
    case "$MaintenanceSource" in
      /root/turingmarket/.deploy-v030.lock/nginx-api-gate.conf|/root/turingmarket/.deploy-v030.lock/nginx-restore-maintenance.conf.next|/root/turingmarket/.deploy-v030.lock/nginx-resume-maintenance.conf.next) ;;
      *) echo "Unexpected maintenance source" >&2; return 1 ;;
    esac
  fi
  [ -z "$MaintenanceConfig" ] || test "$MaintenanceConfig" = "/etc/nginx/sites-available/turingmarket-maintenance"
  [ -z "$RecoveryLink" ] || test "$RecoveryLink" = "/root/turingmarket/.deploy-v030.lock/nginx-public-guard.link"
  [ -z "$SiteLink" ] || test "$SiteLink" = "/etc/nginx/sites-enabled/turingmarket"
  [ -z "$DropIn" ] || test "$DropIn" = "/etc/systemd/system/nginx.service.d/90-turingmarket-public-guard.conf"
}

run_state_transaction() {
  local Action RequestedPayload BoundArmedPayload TestExpectedMode TestExpectedResidueMode TestExpectedUid TestExpectedGid
  Action="$1"
  RequestedPayload="${2:-}"
  BoundArmedPayload="${3:-}"
  TestExpectedMode="${TM_PUBLIC_GUARD_TEST_EXPECT_MODE:-600}"
  TestExpectedResidueMode="${TM_PUBLIC_GUARD_TEST_EXPECT_RESIDUE_MODE:-$TestExpectedMode}"
  TestExpectedUid="${TM_PUBLIC_GUARD_TEST_EXPECT_UID:-}"
  TestExpectedGid="${TM_PUBLIC_GUARD_TEST_EXPECT_GID:-}"
  "$PYTHON3" - "$Action" "$StateFile" "$RequestedPayload" "$BoundArmedPayload" "$TEST_MODE" "$STAT" \
    "$TestExpectedMode" "$TestExpectedResidueMode" "$TestExpectedUid" "$TestExpectedGid" <<'TM_PUBLIC_GUARD_STATE_TRANSACTION'
import errno
import os
import re
import stat
import subprocess
import sys
import time

try:
    import fcntl
except ImportError:
    fcntl = None
try:
    import msvcrt
except ImportError:
    msvcrt = None

(
    action, state_path, requested_text, bound_text, test_mode_text, stat_path,
    test_expected_mode_text, test_expected_residue_mode_text,
    test_expected_uid_text, test_expected_gid_text,
) = sys.argv[1:]
test_mode = test_mode_text == "1"
parent_path = os.path.dirname(state_path)
state_name = os.path.basename(state_path)
next_name = state_name + ".next"
lock_name = state_name + ".transaction-lock"
crash_point = os.environ.get("TM_PUBLIC_GUARD_TEST_CRASH_POINT", "")
crash_after_bytes_text = os.environ.get("TM_PUBLIC_GUARD_TEST_CRASH_AFTER_BYTES", "")
force_fsync_failure = os.environ.get("TM_PUBLIC_GUARD_TEST_STATE_FSYNC_FAIL", "") == "1"
pause_action = os.environ.get("TM_PUBLIC_GUARD_TEST_PAUSE_AFTER_STATE_READ_ACTION", "")
pause_ready_path = os.environ.get("TM_PUBLIC_GUARD_TEST_PAUSE_READY", "")
pause_release_path = os.environ.get("TM_PUBLIC_GUARD_TEST_PAUSE_RELEASE", "")
allowed_crash_points = {
    "", "after-create-write", "after-file-fsync", "before-rename",
    "after-rename-before-directory-fsync",
}


class StateError(Exception):
    pass


def fail(message):
    raise StateError(message)


if action not in {"validate", "read", "reconcile", "write"}:
    fail("Invalid public guard state transaction action")
if crash_point not in allowed_crash_points:
    fail("Invalid public guard test crash point")
if crash_after_bytes_text and not re.fullmatch(r"[1-9][0-9]*", crash_after_bytes_text):
    fail("Invalid public guard test byte crash point")
crash_after_bytes = int(crash_after_bytes_text) if crash_after_bytes_text else None
if crash_point and crash_after_bytes is not None:
    fail("Public guard test crash points are mutually exclusive")
if (crash_point or crash_after_bytes is not None) and not test_mode:
    fail("Public guard crash injection is test-only")
if force_fsync_failure and not test_mode:
    fail("Public guard fsync failure injection is test-only")
if pause_action not in {"", "write", "reconcile"}:
    fail("Invalid public guard test pause action")
if bool(pause_ready_path) != bool(pause_release_path) or bool(pause_action) != bool(pause_ready_path):
    fail("Incomplete public guard test pause configuration")
if pause_action and not test_mode:
    fail("Public guard state pause is test-only")
if not state_name or state_name in {".", ".."} or "/" in state_name:
    fail("Unsafe public guard state path")

has_secure_open = (
    getattr(os, "O_NOFOLLOW", None) is not None
    and getattr(os, "O_DIRECTORY", None) is not None
    and os.open in getattr(os, "supports_dir_fd", set())
)
if not test_mode and not has_secure_open:
    fail("Secure no-follow state operations are unavailable")

directory_fd = None
if has_secure_open:
    try:
        directory_fd = os.open(
            parent_path,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
        )
    except OSError as error:
        fail(f"Unsafe public guard state parent: {error.strerror}")
    directory_stat = os.fstat(directory_fd)
else:
    try:
        parent_lstat = os.lstat(parent_path)
        if not stat.S_ISDIR(parent_lstat.st_mode):
            fail("Unsafe public guard state parent: not a directory")
        directory_stat = os.stat(parent_path)
        if (parent_lstat.st_dev, parent_lstat.st_ino) != (directory_stat.st_dev, directory_stat.st_ino):
            fail("Unsafe public guard state parent: substituted directory")
    except OSError as error:
        fail(f"Unsafe public guard state parent: {error.strerror}")

def full_path(name):
    return os.path.join(parent_path, name)


def external_stat_path(path, label):
    try:
        output = subprocess.check_output(
            [stat_path, "-c", "%F|%u|%g|%a|%h|%d|%i|%s", path],
            text=True,
            stderr=subprocess.PIPE,
        ).rstrip("\r\n")
        fields = output.split("|")
        if len(fields) != 8:
            fail(f"Unsafe public guard state {label}: invalid stat output")
        return (
            fields[0], int(fields[1]), int(fields[2]), fields[3], int(fields[4]),
            int(fields[5]), int(fields[6]), int(fields[7]),
        )
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        fail(f"Unsafe public guard state {label}: cannot inspect metadata: {error}")


fallback_parent_stat = external_stat_path(parent_path, "parent") if test_mode and not has_secure_open else None
expected_uid = 0 if not test_mode else (
    int(test_expected_uid_text) if test_expected_uid_text else (
        fallback_parent_stat[1] if fallback_parent_stat is not None else directory_stat.st_uid
    )
)
expected_gid = 0 if not test_mode else (
    int(test_expected_gid_text) if test_expected_gid_text else (
        fallback_parent_stat[2] if fallback_parent_stat is not None else directory_stat.st_gid
    )
)
if not re.fullmatch(r"[0-7]{3,4}", test_expected_mode_text):
    fail("Invalid public guard test mode policy")
if not re.fullmatch(r"[0-7]{3,4}", test_expected_residue_mode_text):
    fail("Invalid public guard test residue mode policy")
expected_mode = int(test_expected_mode_text, 8) if test_mode else 0o600
expected_mode_text = format(expected_mode, "o")
expected_residue_mode = int(test_expected_residue_mode_text, 8) if test_mode else 0o600
expected_residue_mode_text = format(expected_residue_mode, "o")


def stat_name(name):
    try:
        if directory_fd is not None:
            return os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        return os.lstat(full_path(name))
    except FileNotFoundError:
        return None


def fingerprint(file_stat):
    return (
        file_stat.st_dev, file_stat.st_ino, file_stat.st_mode, file_stat.st_uid,
        file_stat.st_gid, file_stat.st_nlink, file_stat.st_size,
    )


def validate_metadata(file_stat, label, external=None):
    required_mode = expected_residue_mode if label == "residue" else expected_mode
    required_mode_text = expected_residue_mode_text if label == "residue" else expected_mode_text
    if external is not None:
        file_type, uid, gid, mode, link_count = external[:5]
        if file_type not in {"regular file", "regular empty file"}:
            fail(f"Unsafe public guard state {label}: not a regular file")
        if mode != required_mode_text:
            fail(f"Unsafe public guard state {label}: mode must be {required_mode_text}")
        if uid != expected_uid or gid != expected_gid:
            fail(f"Unsafe public guard state {label}: unexpected owner")
        if link_count != 1:
            fail(f"Unsafe public guard state {label}: link count must be one")
        return
    if not stat.S_ISREG(file_stat.st_mode):
        fail(f"Unsafe public guard state {label}: not a regular file")
    if stat.S_IMODE(file_stat.st_mode) != required_mode:
        fail(f"Unsafe public guard state {label}: mode must be {required_mode_text}")
    if file_stat.st_uid != expected_uid or file_stat.st_gid != expected_gid:
        fail(f"Unsafe public guard state {label}: unexpected owner")
    if file_stat.st_nlink != 1:
        fail(f"Unsafe public guard state {label}: link count must be one")


def open_validated(name, label, allow_absent=False):
    before = stat_name(name)
    if before is None:
        if allow_absent:
            return None
        fail(f"Unsafe public guard state {label}: missing")
    before_external = external_stat_path(full_path(name), label) if test_mode and not has_secure_open else None
    validate_metadata(before, label, before_external)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_BINARY", 0)
    if has_secure_open:
        flags |= os.O_NOFOLLOW
    try:
        if directory_fd is not None:
            file_fd = os.open(name, flags, dir_fd=directory_fd)
        else:
            file_fd = os.open(full_path(name), flags)
    except OSError as error:
        fail(f"Unsafe public guard state {label}: {error.strerror}")
    try:
        opened = os.fstat(file_fd)
        opened_external = external_stat_path(full_path(name), label) if before_external is not None else None
        validate_metadata(opened, label, opened_external)
        if fingerprint(before) != fingerprint(opened):
            fail(f"Unsafe public guard state {label}: identity changed before read")
        if before_external is not None and before_external != opened_external:
            fail(f"Unsafe public guard state {label}: identity changed before read")
        if opened.st_size > 512:
            fail(f"Unsafe public guard state {label}: payload too large")
        if hasattr(os, "listxattr"):
            try:
                attributes = os.listxattr(file_fd)
            except (OSError, TypeError) as error:
                fail(f"Unsafe public guard state {label}: cannot verify xattrs: {error}")
            if attributes:
                fail(f"Unsafe public guard state {label}: xattrs are forbidden")
        elif not test_mode:
            fail(f"Unsafe public guard state {label}: xattr verification unavailable")
        chunks = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(file_fd, remaining)
            if not chunk:
                fail(f"Unsafe public guard state {label}: short read")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(file_fd)
        if fingerprint(opened) != fingerprint(after):
            fail(f"Unsafe public guard state {label}: identity changed during read")
        after_external = external_stat_path(full_path(name), label) if before_external is not None else None
        if opened_external is not None and opened_external != after_external:
            fail(f"Unsafe public guard state {label}: identity changed during read")
        return b"".join(chunks), (fingerprint(after), after_external)
    finally:
        os.close(file_fd)


armed_pattern = re.compile(
    rb"armed\|turingmarket-(?:cutover|restore|resume|finalize)-public-guard-[0-9a-f]{32}\.service"
    rb"\|[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\n"
)


def parse_record(payload, label, allow_legacy=False):
    if payload == b"closed\n":
        return {"kind": "closed", "payload": payload, "text": "closed"}
    if payload == b"verified\n":
        return {"kind": "verified", "payload": payload, "text": "verified"}
    if armed_pattern.fullmatch(payload):
        return {"kind": "armed", "payload": payload, "text": payload[:-1].decode("ascii")}
    if allow_legacy and payload == b"armed\n":
        return {"kind": "legacy-armed", "payload": payload, "text": "armed"}
    fail(f"Unsafe public guard state {label}: non-canonical payload")


def is_armed_record_prefix(payload):
    stems = [
        b"armed|turingmarket-cutover-public-guard-",
        b"armed|turingmarket-restore-public-guard-",
        b"armed|turingmarket-resume-public-guard-",
        b"armed|turingmarket-finalize-public-guard-",
    ]
    for stem in stems:
        if len(payload) < len(stem) and stem.startswith(payload):
            return True
        if not payload.startswith(stem):
            continue
        remainder = payload[len(stem):]
        hex_length = min(len(remainder), 32)
        if not re.fullmatch(rb"[0-9a-f]*", remainder[:hex_length]):
            continue
        if len(remainder) <= 32:
            return True
        remainder = remainder[32:]
        service_separator = b".service|"
        if len(remainder) < len(service_separator) and service_separator.startswith(remainder):
            return True
        if not remainder.startswith(service_separator):
            continue
        remainder = remainder[len(service_separator):]
        valid = True
        for delimiter in (b"|", b"|", b"\n"):
            if not remainder:
                return True
            if remainder[0] not in b"123456789":
                valid = False
                break
            digit_count = 1
            while digit_count < len(remainder) and remainder[digit_count] in b"0123456789":
                digit_count += 1
            if digit_count == len(remainder):
                return True
            if remainder[digit_count:digit_count + 1] != delimiter:
                valid = False
                break
            remainder = remainder[digit_count + 1:]
        if valid and not remainder:
            # The complete record is handled by parse_record; reaching here means
            # the final newline is still missing.
            return True
    return False


def canonical_partial_kinds(payload):
    kinds = set()
    for kind, canonical in (("closed", b"closed\n"), ("verified", b"verified\n")):
        if len(payload) < len(canonical) and canonical.startswith(payload):
            kinds.add(kind)
    if is_armed_record_prefix(payload):
        kinds.add("armed")
    return kinds


def load_record(name, label, allow_absent=False, allow_legacy=False):
    loaded = open_validated(name, label, allow_absent)
    if loaded is None:
        return None
    payload, file_fingerprint = loaded
    record = parse_record(payload, label, allow_legacy)
    record["fingerprint"] = file_fingerprint
    return record


def load_transition_residue(requested):
    loaded = open_validated(next_name, "residue", allow_absent=True)
    if loaded is None:
        return None
    payload, file_fingerprint = loaded
    try:
        record = parse_record(payload, "residue")
    except StateError:
        possible_kinds = canonical_partial_kinds(payload)
        if possible_kinds:
            return {
                "kind": "partial", "payload": payload, "text": "",
                "fingerprint": file_fingerprint,
                "possible_kinds": possible_kinds,
                "matches_request": requested["payload"].startswith(payload),
            }
        raise
    record["fingerprint"] = file_fingerprint
    return record


def parse_requested(text, label):
    try:
        payload = text.encode("ascii") + b"\n"
    except UnicodeEncodeError:
        fail(f"Invalid public guard state {label}")
    return parse_record(payload, label)


def revalidate_name(name, expected_fingerprint, label):
    current = stat_name(name)
    current_external = external_stat_path(full_path(name), label) if test_mode and not has_secure_open and current is not None else None
    current_fingerprint = (fingerprint(current), current_external) if current is not None else None
    if current is None or current_fingerprint != expected_fingerprint:
        fail(f"Unsafe public guard state {label}: identity changed before mutation")
    validate_metadata(current, label, current_external)


def fsync_directory():
    if directory_fd is not None:
        try:
            os.fsync(directory_fd)
        except OSError as error:
            fail(f"Unable to sync public guard state directory: {error.strerror}")


def validate_lock_fd(lock_fd, expected_fingerprint=None):
    opened = os.fstat(lock_fd)
    opened_external = (
        external_stat_path(full_path(lock_name), "lock")
        if test_mode and not has_secure_open else None
    )
    validate_metadata(opened, "lock", opened_external)
    if opened.st_size != 0:
        fail("Unsafe public guard state lock: unexpected payload")
    if hasattr(os, "listxattr"):
        try:
            attributes = os.listxattr(lock_fd)
        except (OSError, TypeError) as error:
            fail(f"Unsafe public guard state lock: cannot verify xattrs: {error}")
        if attributes:
            fail("Unsafe public guard state lock: xattrs are forbidden")
    elif not test_mode:
        fail("Unsafe public guard state lock: xattr verification unavailable")
    current_fingerprint = (fingerprint(opened), opened_external)
    if expected_fingerprint is not None and current_fingerprint != expected_fingerprint:
        fail("Unsafe public guard state lock: identity changed")
    return current_fingerprint


def acquire_transaction_lock():
    before = stat_name(lock_name)
    before_fingerprint = None
    if before is not None:
        before_external = (
            external_stat_path(full_path(lock_name), "lock")
            if test_mode and not has_secure_open else None
        )
        validate_metadata(before, "lock", before_external)
        before_fingerprint = (fingerprint(before), before_external)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_BINARY", 0)
    if has_secure_open:
        flags |= os.O_NOFOLLOW
    try:
        lock_fd = (
            os.open(lock_name, flags, 0o600, dir_fd=directory_fd)
            if directory_fd is not None
            else os.open(full_path(lock_name), flags, 0o600)
        )
    except OSError as error:
        fail(f"Unsafe public guard state lock: {error.strerror}")
    try:
        lock_fingerprint = validate_lock_fd(lock_fd, before_fingerprint)
        if fcntl is not None:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
        elif test_mode and msvcrt is not None:
            deadline = time.monotonic() + 30
            while True:
                try:
                    os.lseek(lock_fd, 0, os.SEEK_SET)
                    msvcrt.locking(lock_fd, msvcrt.LK_NBLCK, 1)
                    break
                except OSError as error:
                    if time.monotonic() >= deadline:
                        fail(f"Unable to acquire public guard state lock: {error}")
                    time.sleep(0.01)
        else:
            fail("Secure public guard state locking is unavailable")
        validate_lock_fd(lock_fd, lock_fingerprint)
        revalidate_name(lock_name, lock_fingerprint, "lock")
        return lock_fd
    except Exception:
        os.close(lock_fd)
        raise


def fsync_residue(residue):
    revalidate_name(next_name, residue["fingerprint"], "residue")
    flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_BINARY", 0)
    if has_secure_open:
        flags |= os.O_NOFOLLOW
    try:
        residue_fd = (
            os.open(next_name, flags, dir_fd=directory_fd)
            if directory_fd is not None
            else os.open(full_path(next_name), flags)
        )
    except OSError as error:
        fail(f"Unsafe public guard state residue: {error.strerror}")
    try:
        opened = os.fstat(residue_fd)
        opened_external = (
            external_stat_path(full_path(next_name), "residue")
            if test_mode and not has_secure_open else None
        )
        validate_metadata(opened, "residue", opened_external)
        if (fingerprint(opened), opened_external) != residue["fingerprint"]:
            fail("Unsafe public guard state residue: identity changed before sync")
        if hasattr(os, "listxattr"):
            try:
                attributes = os.listxattr(residue_fd)
            except (OSError, TypeError) as error:
                fail(f"Unsafe public guard state residue: cannot verify xattrs: {error}")
            if attributes:
                fail("Unsafe public guard state residue: xattrs are forbidden")
        elif not test_mode:
            fail("Unsafe public guard state residue: xattr verification unavailable")
        if force_fsync_failure:
            fail("Injected public guard state fsync failure")
        os.fsync(residue_fd)
        after = os.fstat(residue_fd)
        after_external = (
            external_stat_path(full_path(next_name), "residue")
            if opened_external is not None else None
        )
        if (fingerprint(after), after_external) != residue["fingerprint"]:
            fail("Unsafe public guard state residue: identity changed during sync")
    finally:
        os.close(residue_fd)
    revalidate_name(next_name, residue["fingerprint"], "residue")


def remove_residue(residue):
    revalidate_name(next_name, residue["fingerprint"], "residue")
    if directory_fd is not None:
        os.unlink(next_name, dir_fd=directory_fd)
    else:
        os.unlink(full_path(next_name))
    fsync_directory()


def publish_residue(residue):
    # A complete residue may have survived a crash before its original fsync.
    fsync_residue(residue)
    revalidate_name(next_name, residue["fingerprint"], "residue")
    if directory_fd is not None:
        os.replace(next_name, state_name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
    else:
        os.replace(full_path(next_name), full_path(state_name))
    if crash_point == "after-rename-before-directory-fsync":
        os._exit(86)
    fsync_directory()


def transition_allowed(current, requested, bound):
    if requested["kind"] == "closed":
        return True
    if requested["kind"] == "armed":
        return current is not None and (
            current["kind"] in {"closed", "verified"}
            or current["payload"] == requested["payload"]
        )
    if requested["kind"] == "verified":
        return current is not None and (
            current["kind"] == "verified"
            or (bound is not None and current["payload"] == bound["payload"])
        )
    return False


transaction_lock_fd = None
try:
    transaction_lock_fd = acquire_transaction_lock()
    current = load_record(state_name, "file", allow_absent=True, allow_legacy=True)
    if action == "validate":
        if current is None:
            fail("Unsafe public guard state file: missing")
        sys.exit(0)

    if action == "read":
        residue = load_record(next_name, "residue", allow_absent=True)
        if residue is not None:
            fail("Unsafe public guard state residue: pending transition requires recovery")
        if current is None:
            fail("Unsafe public guard state file: missing")
        print(current["text"])
        sys.exit(0)

    requested = parse_requested(requested_text, "request")
    bound = parse_requested(bound_text, "bound identity") if bound_text else None
    if requested["kind"] == "verified" and (bound is None or bound["kind"] != "armed"):
        fail("Invalid public guard state transition: verified requires a bound armed identity")
    if crash_after_bytes is not None and crash_after_bytes >= len(requested["payload"]):
        fail("Public guard byte crash point must truncate the requested payload")
    if pause_action == action:
        try:
            pause_fd = os.open(pause_ready_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(pause_fd)
        except OSError as error:
            fail(f"Unable to publish public guard test pause marker: {error}")
        pause_deadline = time.monotonic() + 20
        while not os.path.exists(pause_release_path):
            if time.monotonic() >= pause_deadline:
                fail("Timed out waiting for public guard test pause release")
            time.sleep(0.01)

    residue = load_transition_residue(requested)
    if residue is not None:
        if residue["kind"] == "partial":
            safe_partial_recovery = (
                residue["matches_request"]
                or requested["kind"] == "closed"
                or (
                    requested["kind"] == "armed"
                    and current is not None
                    and current["kind"] in {"closed", "verified"}
                )
            )
            if not safe_partial_recovery:
                fail("Invalid public guard state transition: torn residue cannot follow durable state")
            remove_residue(residue)
            residue = None
        elif residue["payload"] == requested["payload"]:
            if not transition_allowed(current, requested, bound):
                fail("Invalid public guard state transition: residue cannot follow durable state")
            publish_residue(residue)
            current = load_record(state_name, "file", allow_legacy=True)
            residue = None
        elif current is not None and residue["payload"] == current["payload"]:
            remove_residue(residue)
            residue = None
        elif requested["kind"] == "closed":
            remove_residue(residue)
            residue = None
        else:
            fail("Invalid public guard state transition: residue does not match request or durable state")

    if not transition_allowed(current, requested, bound):
        fail("Invalid public guard state transition")

    if action == "reconcile":
        print(current["text"])
        sys.exit(0)

    if current is not None and current["payload"] == requested["payload"]:
        validated = open_validated(state_name, "file")
        file_fd = None
        try:
            flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_BINARY", 0)
            if has_secure_open:
                flags |= os.O_NOFOLLOW
            file_fd = os.open(state_name, flags, dir_fd=directory_fd) if directory_fd is not None else os.open(state_path, flags)
            if force_fsync_failure:
                fail("Injected public guard state fsync failure")
            os.fsync(file_fd)
        finally:
            if file_fd is not None:
                os.close(file_fd)
        fsync_directory()
        sys.exit(0)

    create_flags = (
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_BINARY", 0)
    )
    if has_secure_open:
        create_flags |= os.O_NOFOLLOW
    try:
        if directory_fd is not None:
            next_fd = os.open(next_name, create_flags, 0o600, dir_fd=directory_fd)
        else:
            if os.path.lexists(full_path(next_name)):
                fail("Unsafe public guard state residue: appeared before create")
            next_fd = os.open(full_path(next_name), create_flags, 0o600)
    except FileExistsError:
        fail("Unsafe public guard state residue: appeared before create")
    except OSError as error:
        fail(f"Unsafe public guard state residue: {error.strerror}")

    try:
        if hasattr(os, "fchmod"):
            os.fchmod(next_fd, 0o600)
        elif not test_mode:
            fail("Unable to enforce public guard state residue mode")
        if not test_mode:
            os.fchown(next_fd, 0, 0)
        elif has_secure_open:
            created = os.fstat(next_fd)
            if created.st_uid != expected_uid or created.st_gid != expected_gid:
                fail("Unsafe public guard state residue: unexpected created owner")
        remaining = requested["payload"]
        written_total = 0
        while remaining:
            write_chunk = remaining
            if crash_after_bytes is not None:
                write_chunk = remaining[:crash_after_bytes - written_total]
            written = os.write(next_fd, write_chunk)
            if written <= 0:
                fail("Unable to write public guard state residue")
            remaining = remaining[written:]
            written_total += written
            if crash_after_bytes is not None and written_total == crash_after_bytes:
                os._exit(86)
        if crash_point == "after-create-write":
            os._exit(86)
        if force_fsync_failure:
            fail("Injected public guard state fsync failure")
        os.fsync(next_fd)
        if crash_point == "after-file-fsync":
            os._exit(86)
    finally:
        os.close(next_fd)

    residue = load_record(next_name, "residue")
    if residue["payload"] != requested["payload"]:
        fail("Unsafe public guard state residue: payload changed before rename")
    if crash_point == "before-rename":
        os._exit(86)
    publish_residue(residue)
    final = load_record(state_name, "file", allow_legacy=True)
    if final["payload"] != requested["payload"]:
        fail("Unsafe public guard state file: transition did not converge")
except StateError as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
finally:
    if transaction_lock_fd is not None:
        os.close(transaction_lock_fd)
    if directory_fd is not None:
        os.close(directory_fd)
TM_PUBLIC_GUARD_STATE_TRANSACTION
}

validate_state_file() {
  run_state_transaction validate >/dev/null
}

validate_maintenance_source() {
  test -f "$MaintenanceSource" || return 1
  test ! -L "$MaintenanceSource" || return 1
  if [ "$TEST_MODE" != "1" ]; then
    test "$(stat -c '%U:%G:%a:%h' "$MaintenanceSource")" = "root:root:600:1" || return 1
  fi
}

write_guard_state() {
  local GuardState GuardPayload BoundArmedPayload
  GuardState="$1"
  case "$GuardState" in
    armed)
      validate_unit_name || return 1
      [[ "$ControllerPid" =~ ^[1-9][0-9]*$ ]] || return 1
      [[ "$ControllerStartTicks" =~ ^[1-9][0-9]*$ ]] || return 1
      [[ "$DeadlineEpoch" =~ ^[1-9][0-9]*$ ]] || return 1
      GuardPayload="armed|$GuardUnit|$ControllerPid|$ControllerStartTicks|$DeadlineEpoch"
      ;;
    closed|verified) GuardPayload="$GuardState" ;;
    *) echo "Invalid public guard state" >&2; return 1 ;;
  esac
  BoundArmedPayload=""
  if [ "$GuardState" = "verified" ]; then
    validate_unit_name || return 1
    BoundArmedPayload="armed|$GuardUnit|$ControllerPid|$ControllerStartTicks|$DeadlineEpoch"
  fi
  run_state_transaction write "$GuardPayload" "$BoundArmedPayload" || return $?
  validate_state_file || return 1
  test "$(run_state_transaction read)" = "$GuardPayload" || return 1
}

read_guard_state_record() {
  run_state_transaction read
}

read_guard_state() {
  local GuardRecord
  GuardRecord="$(read_guard_state_record)" || return 1
  printf '%s\n' "${GuardRecord%%|*}" || return 1
}

install_maintenance_gate() {
  validate_maintenance_source || return 1
  if [ "$TEST_MODE" = "1" ]; then
    "$INSTALL" -m 0644 "$MaintenanceSource" "$MaintenanceConfig" || return 1
  else
    "$INSTALL" -o root -g root -m 0644 "$MaintenanceSource" "$MaintenanceConfig" || return 1
  fi
  "$SYNC" -f "$MaintenanceConfig" || return 1
  "$SYNC" -f "$(dirname "$MaintenanceConfig")" || return 1
  "$RM" -f -- "$RecoveryLink" || return 1
  "$LN" -s "$MaintenanceConfig" "$RecoveryLink" || return 1
  "$MV" -Tf "$RecoveryLink" "$SiteLink" || return 1
  "$SYNC" -f "$(dirname "$RecoveryLink")" || return 1
  "$SYNC" -f "$(dirname "$SiteLink")" || return 1
  "$NGINX" -t || return 1
  "$SYSTEMCTL" reload nginx || return 1
  test "$("$CURL" -sS -o /dev/null -w '%{http_code}' http://localhost/api/health)" = "503" || return 1
  test "$("$CURL" -sS -o /dev/null -w '%{http_code}' http://localhost/m0)" = "503" || return 1
}

read_port_80_listeners() {
  "$SS" -H -ltn '( sport = :80 )'
}

force_stop_public_listener() {
  local ListenerOutput ListenerStatus
  "$SYSTEMCTL" stop nginx >/dev/null 2>&1 || true
  "$SYSTEMCTL" kill --kill-who=all --signal=KILL nginx >/dev/null 2>&1 || true
  for _attempt in $(seq 1 50); do
    set +e
    ListenerOutput="$(read_port_80_listeners 2>/dev/null)"
    ListenerStatus=$?
    set -e
    if [ "$ListenerStatus" != "0" ]; then
      echo "Unable to verify port 80 listener state" >&2
      return 1
    fi
    if [ -z "$ListenerOutput" ]; then return 0; fi
    "$SLEEP" 0.1
  done
  echo "Port 80 remained open after Nginx stop" >&2
  return 1
}

close_public_gate() {
  set +e
  install_maintenance_gate
  local MaintenanceStatus=$?
  set -e
  if [ "$MaintenanceStatus" != "0" ]; then
    force_stop_public_listener || return 1
  fi
  write_guard_state closed || return $?
  printf '%s\n' 'PUBLIC_RELEASE_GUARD_CLOSED' || return 1
}

controller_start_ticks() {
  local Pid StatTail
  Pid="$1"
  test -r "/proc/$Pid/stat" || return 1
  StatTail="$(cat "/proc/$Pid/stat")" || return 1
  StatTail="${StatTail##*) }"
  set -- $StatTail
  test "$#" -ge 20 || return 1
  printf '%s\n' "${20}" || return 1
}

watchdog_signal_close() {
  local Status="$1"
  trap - HUP INT TERM
  close_public_gate || exit 125
  exit "$Status"
}

watch_public_gate() {
  validate_unit_name
  [[ "$ControllerPid" =~ ^[1-9][0-9]*$ ]]
  [[ "$ControllerStartTicks" =~ ^[1-9][0-9]*$ ]]
  [[ "$DeadlineEpoch" =~ ^[1-9][0-9]*$ ]]
  trap 'watchdog_signal_close 129' HUP
  trap 'watchdog_signal_close 130' INT
  trap 'watchdog_signal_close 143' TERM
  while true; do
    local GuardRecord GuardState ExpectedRecord CurrentStart CurrentEpoch
    if ! GuardRecord="$(read_guard_state_record)"; then
      close_public_gate
      return 0
    fi
    GuardState="${GuardRecord%%|*}"
    case "$GuardState" in
      verified|closed) return 0 ;;
      armed)
        ExpectedRecord="armed|$GuardUnit|$ControllerPid|$ControllerStartTicks|$DeadlineEpoch"
        if [ "$GuardRecord" != "$ExpectedRecord" ]; then
          close_public_gate
          return 0
        fi
        ;;
      *) close_public_gate; return 0 ;;
    esac
    CurrentStart="$(controller_start_ticks "$ControllerPid" 2>/dev/null || true)"
    CurrentEpoch="$("$DATE" +%s)"
    if [ "$CurrentStart" != "$ControllerStartTicks" ] || [ "$CurrentEpoch" -ge "$DeadlineEpoch" ]; then
      close_public_gate
      return 0
    fi
    "$SLEEP" "${TM_PUBLIC_GUARD_TEST_INTERVAL:-1}"
  done
}

validate_unit_name() {
  [[ "$GuardUnit" =~ ^turingmarket-(cutover|restore|resume|finalize)-public-guard-[0-9a-f]{32}\.service$ ]]
}

show_unit_property() {
  local Property Value
  Property="$1"
  Value="$("$SYSTEMCTL" show "$GuardUnit" --property="$Property" --value)" || return 1
  printf '%s\n' "$Value" || return 1
}

verify_armed_guard() {
  local ExpectedRecord CurrentEpoch
  validate_unit_name || return 1
  [[ "$ControllerPid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$ControllerStartTicks" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$DeadlineEpoch" =~ ^[1-9][0-9]*$ ]] || return 1
  ExpectedRecord="armed|$GuardUnit|$ControllerPid|$ControllerStartTicks|$DeadlineEpoch"
  test "$(read_guard_state_record)" = "$ExpectedRecord" || return 1
  CurrentEpoch="$("$DATE" +%s)" || return 1
  test "$CurrentEpoch" -lt "$DeadlineEpoch" || return 1
  test "$(show_unit_property Id)" = "$GuardUnit" || return 1
  test "$(show_unit_property Names)" = "$GuardUnit" || return 1
  test "$(show_unit_property LoadState)" = loaded || return 1
  test "$(show_unit_property ActiveState)" = active || return 1
  test "$(show_unit_property SubState)" = running || return 1
  test "$(show_unit_property FragmentPath)" = "/run/systemd/transient/$GuardUnit" || return 1
  test "$(show_unit_property RuntimeMaxUSec)" = infinity || return 1
}

install_start_barrier() {
  local DropInDir DropInNext SelfPath
  DropInDir="$(dirname "$DropIn")"
  DropInNext="$DropIn.next.$$"
  SelfPath="$(realpath -e -- "$0")"
  if [ "$TEST_MODE" != "1" ]; then
    test -f "$SelfPath"
    test ! -L "$SelfPath"
    test "$(stat -c '%U:%G:%a:%h' "$SelfPath")" = "root:root:444:1"
  fi
  "$INSTALL" -d -m 0755 "$DropInDir"
  cat > "$DropInNext" <<TM_NGINX_PUBLIC_GUARD_DROP_IN
[Service]
ExecStartPre=/bin/bash --noprofile --norc $SelfPath assert-start-allowed --state-file $StateFile --maintenance-config $MaintenanceConfig --site-link $SiteLink
TM_NGINX_PUBLIC_GUARD_DROP_IN
  "$CHMOD" 0644 "$DropInNext"
  if [ "$TEST_MODE" != "1" ]; then chown root:root "$DropInNext"; fi
  "$SYNC" -f "$DropInNext"
  "$MV" -f "$DropInNext" "$DropIn"
  "$SYNC" -f "$DropIn"
  "$SYNC" -f "$DropInDir"
  "$SYSTEMCTL" daemon-reload
  grep -Fqx "ExecStartPre=/bin/bash --noprofile --norc $SelfPath assert-start-allowed --state-file $StateFile --maintenance-config $MaintenanceConfig --site-link $SiteLink" "$DropIn"
}

arm_public_guard() {
  test -x "$SYSTEMD_RUN"
  validate_unit_name
  [[ "$ControllerPid" =~ ^[1-9][0-9]*$ ]]
  [[ "$ControllerStartTicks" =~ ^[1-9][0-9]*$ ]]
  [[ "$DeadlineEpoch" =~ ^[1-9][0-9]*$ ]]
  write_guard_state armed
  install_start_barrier
  local SelfPath
  SelfPath="$(realpath -e -- "$0")"
  "$SYSTEMD_RUN" --quiet --unit="$GuardUnit" --service-type=exec \
    --property="User=root" \
    --property="Restart=on-failure" \
    --property="RestartSec=1s" \
    --property="KillMode=control-group" \
    --property="TimeoutStopSec=15s" \
    --property="TasksMax=32" \
    --property="MemoryMax=128M" \
    --property="NoNewPrivileges=yes" \
    --property="PrivateTmp=yes" \
    --property="PrivateDevices=yes" \
    --property="PrivateIPC=yes" \
    --property="ProtectHome=read-only" \
    --property="ProtectSystem=strict" \
    --property="ProtectKernelTunables=yes" \
    --property="ProtectKernelModules=yes" \
    --property="ProtectKernelLogs=yes" \
    --property="ProtectControlGroups=yes" \
    --property="RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
    --property="ReadWritePaths=$(dirname "$StateFile") /etc/nginx/sites-available /etc/nginx/sites-enabled" \
    -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
      /bin/bash --noprofile --norc "$SelfPath" watch \
      --state-file "$StateFile" \
      --maintenance-source "$MaintenanceSource" \
      --maintenance-config "$MaintenanceConfig" \
      --recovery-link "$RecoveryLink" \
      --site-link "$SiteLink" \
      --unit "$GuardUnit" \
      --controller-pid "$ControllerPid" \
      --controller-start-ticks "$ControllerStartTicks" \
      --deadline-epoch "$DeadlineEpoch"
  verify_armed_guard
  printf '%s\n' 'PUBLIC_RELEASE_GUARD_ARMED'
}

disarm_public_guard() {
  local BoundArmedPayload ReconciledRecord PostWatchdogState
  validate_unit_name || return 1
  [[ "$ControllerPid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$ControllerStartTicks" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$DeadlineEpoch" =~ ^[1-9][0-9]*$ ]] || return 1
  BoundArmedPayload="armed|$GuardUnit|$ControllerPid|$ControllerStartTicks|$DeadlineEpoch"
  ReconciledRecord="$(run_state_transaction reconcile verified "$BoundArmedPayload")" || return 1
  case "$ReconciledRecord" in
    verified) ;;
    "$BoundArmedPayload") verify_armed_guard || return 1 ;;
    *) echo "Invalid public guard state transition" >&2; return 1 ;;
  esac
  write_guard_state verified
  for _attempt in $(seq 1 100); do
    if ! "$SYSTEMCTL" is-active --quiet "$GuardUnit"; then break; fi
    "$SLEEP" 0.1
  done
  if "$SYSTEMCTL" is-active --quiet "$GuardUnit"; then
    echo "Public release watchdog did not stop after verification" >&2
    return 1
  fi
  PostWatchdogState="$(read_guard_state)" || return 1
  if ! test "$PostWatchdogState" = verified; then
    echo "Public guard state changed after watchdog exit" >&2
    return 1
  fi
  "$SYSTEMCTL" reset-failed "$GuardUnit" >/dev/null 2>&1 || true
  "$RM" -f -- "$DropIn"
  "$SYNC" -f "$(dirname "$DropIn")"
  "$SYSTEMCTL" daemon-reload
  test ! -e "$DropIn"
  printf '%s\n' 'PUBLIC_RELEASE_GUARD_VERIFIED'
}

validate_paths
case "$MODE" in
  close)
    close_public_gate
    ;;
  watch)
    watch_public_gate
    ;;
  read-record)
    read_guard_state_record
    ;;
  assert-start-allowed)
    StartState="$(read_guard_state)"
    if [ "$StartState" = "verified" ]; then exit 0; fi
    test "$StartState" = "closed"
    test -n "$MaintenanceConfig"
    test -n "$SiteLink"
    test -f "$MaintenanceConfig"
    test ! -L "$MaintenanceConfig"
    test -L "$SiteLink"
    test "$(readlink "$SiteLink")" = "$MaintenanceConfig"
    if [ "$TEST_MODE" != "1" ]; then
      test "$(stat -c '%U:%G:%a:%h' "$MaintenanceConfig")" = "root:root:644:1"
    fi
    ;;
  arm)
    test -n "$MaintenanceSource"
    test -n "$MaintenanceConfig"
    test -n "$RecoveryLink"
    test -n "$SiteLink"
    test -n "$GuardUnit"
    test -n "$DropIn"
    arm_public_guard
    ;;
  verify-armed)
    test -n "$GuardUnit"
    verify_armed_guard
    printf '%s\n' 'PUBLIC_RELEASE_GUARD_ACTIVE'
    ;;
  disarm)
    test -n "$GuardUnit"
    test -n "$DropIn"
    disarm_public_guard
    ;;
  *)
    echo "Usage: public_release_guard.sh {close|watch|read-record|assert-start-allowed|arm|verify-armed|disarm} ..." >&2
    exit 64
    ;;
esac
