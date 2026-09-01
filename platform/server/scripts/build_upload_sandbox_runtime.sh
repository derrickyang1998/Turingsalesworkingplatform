#!/usr/bin/env bash
set -Eeuo pipefail

# BEGIN UNPRIVILEGED BUILD WORKER
unprivileged_build_worker() {
  [[ "$(id -u)" -ne 0 ]] || {
    printf '%s\n' 'parser build worker must not run as root' >&2
    return 69
  }
  [[ "$#" -eq 0 ]] || return 64

  local SOURCE_ROOT=/build-input
  local OUTPUT_ROOT=/build-work/runtime
  local PYTHON_SITE PIP_BUNDLED_CA APP_ROOT NPM_CACHE NPM_GLOBAL_CONFIG resolved library scan_target candidate
  [[ -d "$SOURCE_ROOT" && -d /dependency-cache && -d /build-work ]] || return 66
  [[ ! -e "$OUTPUT_ROOT" && ! -L "$OUTPUT_ROOT" ]] || return 66
  for attempt in $(seq 1 1200); do
    if [[ -f /build-work/.controller-release ]]; then break; fi
    [[ "$attempt" -lt 1200 ]] || return 69
    sleep 0.1
  done
  rm -f -- /build-work/.controller-release

  install -d -m 0700 "$OUTPUT_ROOT"
  SYSTEMD_ROOT_DIRECTORY_MOUNTPOINTS=(dev etc input output proc root run runtime scratch sys var)
  for mountpoint in "${SYSTEMD_ROOT_DIRECTORY_MOUNTPOINTS[@]}"; do
    install -d -m 0755 "$OUTPUT_ROOT/$mountpoint"
  done
  install -m 0644 /dev/null "$OUTPUT_ROOT/input/input.bin"
  install -m 0644 /dev/null "$OUTPUT_ROOT/runtime/request.json"

  copy_file() {
    local source="$1" target="$2" mode="${3:-0555}"
    [[ -f "$source" && ! -L "$source" ]] || {
      printf '%s\n' 'runtime dependency missing' >&2
      return 1
    }
    install -D -m "$mode" "$(realpath -e -- "$source")" "$OUTPUT_ROOT$target"
  }

  declare -A COPIED=()
  declare -A EXECUTABLE_CLOSURE=()
  list_binary_libraries() {
    local first second third remainder
    while read -r first second third remainder; do
      if [[ "$second" = '=>' && "$third" = /* ]]; then
        printf '%s\n' "$third"
      elif [[ "$first" = /* ]]; then
        printf '%s\n' "$first"
      fi
    done
  }
  copy_binary_closure() {
    local source="$1" target="$2"
    resolved="$(realpath -e -- "$source")"
    copy_file "$resolved" "$target" 0555
    EXECUTABLE_CLOSURE["$target"]=1
    scan_target="$source"
    if [[ "$source" != "$OUTPUT_ROOT"/* ]]; then
      scan_target="$resolved"
    fi
    while IFS= read -r library; do
      [[ -n "$library" ]] || continue
      resolved="$(realpath -e -- "$library")"
      if [[ -z "${COPIED[$library]:-}" ]]; then
        COPIED[$library]=1
        copy_file "$resolved" "$library" 0555
        EXECUTABLE_CLOSURE["$library"]=1
      fi
    done < <(ldd "$scan_target" 2>/dev/null | list_binary_libraries || true)
  }

  copy_binary_closure /bin/bash /bin/bash
  copy_binary_closure /usr/bin/env /usr/bin/env
  copy_binary_closure /usr/bin/node /usr/bin/node
  copy_binary_closure /usr/bin/python3 /usr/bin/python3

  PYTHON_STDLIB="$(/usr/bin/python3 -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')"
  [[ "$PYTHON_STDLIB" = /usr/lib/python3.14 && -d "$PYTHON_STDLIB" && ! -L "$PYTHON_STDLIB" ]] || {
    printf '%s\n' 'unexpected Python standard library' >&2
    return 65
  }
  install -d -m 0755 "$OUTPUT_ROOT/usr/lib/python3.14"
  rsync -rt --copy-links --delete-excluded \
    --exclude='__pycache__/' --exclude='*.pyc' --exclude='site-packages/' --exclude='dist-packages/' \
    --exclude='sitecustomize.py' \
    "$PYTHON_STDLIB/" "$OUTPUT_ROOT/usr/lib/python3.14/"
  copy_file "$SOURCE_ROOT/parser-runtime/sitecustomize.py" /usr/lib/python3.14/sitecustomize.py 0444

  PYTHON_SITE="$OUTPUT_ROOT/usr/local/lib/python3.14/dist-packages"
  PIP_BUNDLED_CA="$SOURCE_ROOT/parser-runtime/pip-cacert.crt"
  [[ -f "$PIP_BUNDLED_CA" && ! -L "$PIP_BUNDLED_CA" ]] || return 66
  install -d -m 0755 "$PYTHON_SITE"
  /usr/bin/python3 - "$PYTHON_SITE" "$PIP_BUNDLED_CA" "$SOURCE_ROOT/parser-runtime/requirements.lock" <<'PY' >/dev/null
import sys

target, ca_bundle, requirements = sys.argv[1:]
from pip._vendor.certifi import core as certifi_core
certifi_core.DEBIAN_CA_CERTS_PATH = ca_bundle
from pip._internal.cli.main import main as pip_main

raise SystemExit(pip_main([
    'install',
    '--disable-pip-version-check',
    '--require-hashes',
    '--only-binary=:all:',
    '--no-compile',
    '--no-deps',
    '--no-index',
    '--find-links', '/dependency-cache/python',
    '--target', target,
    '-r', requirements,
]))
PY

  APP_ROOT="$OUTPUT_ROOT/opt/turingmarket-parser/app"
  install -d -m 0755 \
    "$APP_ROOT/services" \
    "$APP_ROOT/scripts" \
    "$APP_ROOT/parser-runtime" \
    "$OUTPUT_ROOT/usr/local/libexec/turingmarket"
  copy_file "$SOURCE_ROOT/parser-runtime/package.json" /opt/turingmarket-parser/app/package.json 0444
  copy_file "$SOURCE_ROOT/parser-runtime/package-lock.json" /opt/turingmarket-parser/app/package-lock.json 0444
  copy_file "$SOURCE_ROOT/parser-runtime/requirements.lock" /opt/turingmarket-parser/app/parser-runtime/requirements.lock 0444
  copy_file "$SOURCE_ROOT/extract_document_text.py" /opt/turingmarket-parser/app/extract_document_text.py 0444
  copy_file "$SOURCE_ROOT/extract_xlsx_text.py" /opt/turingmarket-parser/app/extract_xlsx_text.py 0444
  copy_file "$SOURCE_ROOT/ocr_document_text.py" /opt/turingmarket-parser/app/ocr_document_text.py 0444
  copy_file "$SOURCE_ROOT/services/file_ingest_service.js" /opt/turingmarket-parser/app/services/file_ingest_service.js 0444
  copy_file "$SOURCE_ROOT/services/upload_sandbox_service.js" /opt/turingmarket-parser/app/services/upload_sandbox_service.js 0444
  copy_file "$SOURCE_ROOT/scripts/parse_upload_sandbox.sh" /usr/local/libexec/turingmarket/parse_upload_sandbox.sh 0555

  NPM_CACHE=/build-work/npm-cache
  NPM_GLOBAL_CONFIG=/build-work/npm-global.npmrc
  install -m 0600 /dev/null "$NPM_GLOBAL_CONFIG"
  install -d -m 0700 "$NPM_CACHE"
  cp -R --no-preserve=ownership,mode,timestamps /dependency-cache/npm/. "$NPM_CACHE/"
  (
    cd "$APP_ROOT"
    HOME=/build-work/home npm_config_cache="$NPM_CACHE" npm_config_globalconfig="$NPM_GLOBAL_CONFIG" \
      npm ci --offline --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
  )
  rm -rf -- "$APP_ROOT/node_modules/.bin" "$NPM_CACHE" "$NPM_GLOBAL_CONFIG"

  for _pass in 1 2 3; do
    mapfile -d '' ELF_CANDIDATES < <(find "$OUTPUT_ROOT" -xdev -type f -print0)
    for candidate in "${ELF_CANDIDATES[@]}"; do
      if file -b "$candidate" | grep -q '^ELF '; then
        while IFS= read -r library; do
          [[ -n "$library" ]] || continue
          case "$library" in "$OUTPUT_ROOT"/*) continue ;; esac
          if [[ -z "${COPIED[$library]:-}" ]]; then
            COPIED[$library]=1
            copy_file "$(realpath -e -- "$library")" "$library" 0555
            EXECUTABLE_CLOSURE["$library"]=1
          fi
        done < <(ldd "$candidate" 2>/dev/null | list_binary_libraries || true)
      fi
    done
  done

  OCR_ENGINE_PROBE="$(
    PYTHONPATH="$PYTHON_SITE" /usr/bin/python3 - <<'PY'
from rapidocr import RapidOCR
RapidOCR()
print('PARSER_OCR_ENGINE_INIT_OK')
PY
  )"
  [[ "$OCR_ENGINE_PROBE" = *PARSER_OCR_ENGINE_INIT_OK* ]] || {
    printf '%s\n' 'parser OCR engine initialization failed' >&2
    return 68
  }

  find "$OUTPUT_ROOT" -xdev -type d -exec chmod 0555 {} +
  find "$OUTPUT_ROOT" -xdev -type f -exec chmod 0444 {} +
  for executable in "${!EXECUTABLE_CLOSURE[@]}"; do
    chmod 0555 "$OUTPUT_ROOT$executable"
  done
  chmod 0555 "$OUTPUT_ROOT/usr/local/libexec/turingmarket/parse_upload_sandbox.sh"
  if [[ -L "$OUTPUT_ROOT/lib" && "$(readlink -- "$OUTPUT_ROOT/lib")" = usr/lib ]]; then
    rm -- "$OUTPUT_ROOT/lib"
    mkdir -p -- "$OUTPUT_ROOT/lib"
    cp -a --reflink=auto "$OUTPUT_ROOT/usr/lib/." "$OUTPUT_ROOT/lib/"
    find "$OUTPUT_ROOT/lib" -xdev -type d -exec chmod 0555 {} +
    find "$OUTPUT_ROOT/lib" -xdev -type f -exec chmod 0444 {} +
  fi
  # Keep systemd from creating bind and tmpfs mountpoints after the tree is sealed.
  chmod 0755 "$OUTPUT_ROOT"/{input,output,runtime,scratch}
  chmod 0644 "$OUTPUT_ROOT/input/input.bin" "$OUTPUT_ROOT/runtime/request.json"
  if find "$OUTPUT_ROOT" -xdev -type l -print -quit | grep -q .; then
    printf '%s\n' 'runtime tree contains a symbolic link' >&2
    return 66
  fi
  if find "$OUTPUT_ROOT" -xdev ! -type d ! -type f -print -quit | grep -q .; then
    printf '%s\n' 'runtime tree contains an unsupported entry' >&2
    return 66
  fi
}
# END UNPRIVILEGED BUILD WORKER

usage() {
  printf '%s\n' 'usage: build_upload_sandbox_runtime.sh --source-root ABS --output-root ABS --dependency-cache-root ABS --trusted-verifier ABS --expected-verifier-sha256 HEX --expected-manifest-sha256 HEX [--expected-sha256 HEX] [--json]' >&2
  exit 64
}

if [[ "${1:-}" = --unprivileged-build-worker ]]; then
  shift
  unprivileged_build_worker "$@"
  exit
fi

SOURCE_ROOT=''
OUTPUT_ROOT=''
DEPENDENCY_CACHE_ROOT=''
TRUSTED_VERIFIER=''
EXPECTED_VERIFIER_SHA256=''
EXPECTED_MANIFEST_SHA256=''
EXPECTED_SHA256=''
JSON_OUTPUT=0
declare -A SEEN_ARGUMENTS=()

while (($#)); do
  argument="$1"
  [[ -z "${SEEN_ARGUMENTS[$argument]+x}" ]] || usage
  SEEN_ARGUMENTS["$argument"]=1
  case "$argument" in
    --source-root) (($# >= 2)) || usage; SOURCE_ROOT="$2"; shift 2 ;;
    --output-root) (($# >= 2)) || usage; OUTPUT_ROOT="$2"; shift 2 ;;
    --dependency-cache-root) (($# >= 2)) || usage; DEPENDENCY_CACHE_ROOT="$2"; shift 2 ;;
    --trusted-verifier) (($# >= 2)) || usage; TRUSTED_VERIFIER="$2"; shift 2 ;;
    --expected-verifier-sha256) (($# >= 2)) || usage; EXPECTED_VERIFIER_SHA256="$2"; shift 2 ;;
    --expected-manifest-sha256) (($# >= 2)) || usage; EXPECTED_MANIFEST_SHA256="$2"; shift 2 ;;
    --expected-sha256) (($# >= 2)) || usage; EXPECTED_SHA256="$2"; shift 2 ;;
    --json) JSON_OUTPUT=1; shift ;;
    *) usage ;;
  esac
done

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

[[ -n "$SOURCE_ROOT" && -n "$OUTPUT_ROOT" && -n "$DEPENDENCY_CACHE_ROOT" ]] || usage
[[ -n "$TRUSTED_VERIFIER" && -n "$EXPECTED_VERIFIER_SHA256" && -n "$EXPECTED_MANIFEST_SHA256" ]] || usage
[[ "$SOURCE_ROOT" = /* && "$OUTPUT_ROOT" = /* && "$DEPENDENCY_CACHE_ROOT" = /* ]] || usage
[[ "$TRUSTED_VERIFIER" = /* ]] || usage
[[ "$EXPECTED_VERIFIER_SHA256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$EXPECTED_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ -z "$EXPECTED_SHA256" || "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$SOURCE_ROOT" != / && "$SOURCE_ROOT" != */ ]] || usage
assert_trusted_verifier_location || usage

[[ "$(uname -s)" = Linux && "$(uname -m)" = x86_64 ]] || {
  printf '%s\n' 'unsupported parser build platform' >&2
  exit 65
}
[[ "$(id -u)" -eq 0 ]] || {
  printf '%s\n' 'parser build controller must run as root' >&2
  exit 77
}
[[ "$(/usr/bin/node --version)" = v20.20.2 ]] || {
  printf '%s\n' 'unexpected Node version' >&2
  exit 65
}
[[ "$(/usr/bin/python3 -c 'import platform; print(platform.python_version())')" = 3.14.4 ]] || {
  printf '%s\n' 'unexpected Python version' >&2
  exit 65
}

SOURCE_ROOT="$(realpath -e -- "$SOURCE_ROOT")"
DEPENDENCY_CACHE_ROOT="$(realpath -e -- "$DEPENDENCY_CACHE_ROOT")"
TRUSTED_VERIFIER="$(realpath -e -- "$TRUSTED_VERIFIER")"
TRUSTED_MANIFEST="$SOURCE_ROOT/systemd/turingmarket-parser.manifest.json"
SELF_PATH="$(realpath -e -- "$0")"
[[ -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] || usage
[[ -d "$DEPENDENCY_CACHE_ROOT" && ! -L "$DEPENDENCY_CACHE_ROOT" ]] || usage
[[ -f "$TRUSTED_VERIFIER" && ! -L "$TRUSTED_VERIFIER" ]] || usage
[[ -f "$TRUSTED_MANIFEST" && ! -L "$TRUSTED_MANIFEST" ]] || usage
assert_trusted_verifier_location || usage
case "$OUTPUT_ROOT" in /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var) usage ;; esac
[[ ! -e "$OUTPUT_ROOT" && ! -L "$OUTPUT_ROOT" ]] || {
  printf '%s\n' 'parser output root must be absent' >&2
  exit 66
}
OUTPUT_PARENT="$(dirname -- "$OUTPUT_ROOT")"
[[ -d "$OUTPUT_PARENT" && ! -L "$OUTPUT_PARENT" ]] || usage
OUTPUT_PARENT="$(realpath -e -- "$OUTPUT_PARENT")"
OUTPUT_ROOT="$OUTPUT_PARENT/$(basename -- "$OUTPUT_ROOT")"

BUILD_USER=turingmarket-gate
BUILD_GROUP=turingmarket-gate
BUILD_UNIT=''
BUILD_PARENT=''
BUILD_INPUT=''
BUILD_WORK=''
BUILD_RUNTIME=''
ROOT_STAGE=''
BUILD_SYSTEMD_RUN_PID=''
EVIDENCE_ROOT=''
BUILD_BOUNDARY_OBSERVATION=''

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$BUILD_SYSTEMD_RUN_PID" ]]; then
    kill "$BUILD_SYSTEMD_RUN_PID" >/dev/null 2>&1 || true
    wait "$BUILD_SYSTEMD_RUN_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$BUILD_UNIT" ]]; then
    systemctl kill --kill-who=all --signal=KILL "$BUILD_UNIT" >/dev/null 2>&1 || true
    systemctl stop "$BUILD_UNIT" >/dev/null 2>&1 || true
    systemctl reset-failed "$BUILD_UNIT" >/dev/null 2>&1 || true
  fi
  if [[ -n "$ROOT_STAGE" && ( -e "$ROOT_STAGE" || -L "$ROOT_STAGE" ) ]]; then
    rm -rf --one-file-system -- "$ROOT_STAGE"
  fi
  if [[ -n "$BUILD_PARENT" && ( -e "$BUILD_PARENT" || -L "$BUILD_PARENT" ) ]]; then
    rm -rf --one-file-system -- "$BUILD_PARENT"
  fi
  if [[ -n "$EVIDENCE_ROOT" && ( -e "$EVIDENCE_ROOT" || -L "$EVIDENCE_ROOT" ) ]]; then
    rm -rf --one-file-system -- "$EVIDENCE_ROOT"
  fi
  if ((status != 0)) && [[ -e "$OUTPUT_ROOT" || -L "$OUTPUT_ROOT" ]]; then
    rm -rf --one-file-system -- "$OUTPUT_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

verify_trusted_verifier() {
  local metadata uid gid mode links observed parent parent_metadata parent_uid parent_gid parent_mode
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

assert_dependency_cache() {
  local top_level metadata uid gid mode links entry
  [[ -d "$DEPENDENCY_CACHE_ROOT/npm/_cacache" && ! -L "$DEPENDENCY_CACHE_ROOT/npm/_cacache" ]] || return 66
  [[ -d "$DEPENDENCY_CACHE_ROOT/python" && ! -L "$DEPENDENCY_CACHE_ROOT/python" ]] || return 66
  top_level="$(find "$DEPENDENCY_CACHE_ROOT" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
  [[ "$top_level" = $'npm\npython' ]] || return 66
  [[ -z "$(find "$DEPENDENCY_CACHE_ROOT/npm" -mindepth 1 -maxdepth 1 ! -name _cacache -print -quit)" ]] || return 66
  find "$DEPENDENCY_CACHE_ROOT/python" -maxdepth 1 -type f -name '*.whl' -print -quit | grep -q . || return 66
  [[ -z "$(find "$DEPENDENCY_CACHE_ROOT/python" -mindepth 1 ! -type f -print -quit)" ]] || return 66
  [[ -z "$(find "$DEPENDENCY_CACHE_ROOT/python" -maxdepth 1 -type f ! -name '*.whl' -print -quit)" ]] || return 66
  if find "$DEPENDENCY_CACHE_ROOT" -xdev -type l -o ! -type d ! -type f | grep -q .; then return 66; fi
  if find "$DEPENDENCY_CACHE_ROOT" -xdev \( ! -uid 0 -o ! -gid 0 -o -perm /022 \) -print -quit | grep -q .; then return 66; fi
  while IFS= read -r -d '' entry; do
    metadata="$(stat -Lc '%u:%g:%a:%h' -- "$entry")"
    IFS=: read -r uid gid mode links <<<"$metadata"
    [[ "$uid" = 0 && "$gid" = 0 && "$links" = 1 ]] || return 66
    (( (8#$mode & 0022) == 0 )) || return 66
  done < <(find "$DEPENDENCY_CACHE_ROOT" -xdev -type f -print0)
}

copy_build_input() {
  local relative="$1" source target
  source="$SOURCE_ROOT/$relative"
  target="$BUILD_INPUT/$relative"
  [[ -f "$source" && ! -L "$source" && "$(realpath -e -- "$source")" = "$source" ]] || {
    printf '%s\n' 'parser source artifact missing' >&2
    return 66
  }
  [[ "$(stat -Lc '%h' -- "$source")" = 1 ]] || return 66
  install -D -o root -g root -m 0444 "$source" "$target"
}

assert_unprivileged_runtime() {
  local build_uid build_gid entry metadata uid gid mode links root_device device
  build_uid="$(id -u "$BUILD_USER")"
  build_gid="$(id -g "$BUILD_USER")"
  [[ -d "$BUILD_RUNTIME" && ! -L "$BUILD_RUNTIME" ]] || return 66
  root_device="$(stat -Lc '%d' -- "$BUILD_RUNTIME")"
  if find "$BUILD_RUNTIME" -xdev -type l -o ! -type d ! -type f | grep -q .; then return 66; fi
  if find "$BUILD_RUNTIME" -xdev -perm /022 -print -quit | grep -q .; then return 66; fi
  while IFS= read -r -d '' entry; do
    metadata="$(stat -Lc '%u:%g:%a:%h:%d' -- "$entry")"
    IFS=: read -r uid gid mode links device <<<"$metadata"
    [[ "$uid" = "$build_uid" && "$gid" = "$build_gid" && "$device" = "$root_device" ]] || return 66
    if [[ -f "$entry" ]]; then [[ "$links" = 1 ]] || return 66; fi
  done < <(find "$BUILD_RUNTIME" -xdev -print0)
}

verify_trusted_verifier
assert_dependency_cache

build_passwd="$(getent passwd "$BUILD_USER")"
build_group="$(getent group "$BUILD_GROUP")"
[[ -n "$build_passwd" && -n "$build_group" ]] || {
  printf '%s\n' 'parser build identity is missing' >&2
  exit 69
}
IFS=: read -r passwd_name _ build_uid build_gid _ build_home build_shell <<<"$build_passwd"
IFS=: read -r group_name _ group_gid group_members <<<"$build_group"
[[ "$passwd_name" = "$BUILD_USER" && "$group_name" = "$BUILD_GROUP" ]] || exit 69
[[ "$build_uid" =~ ^[0-9]+$ && "$build_gid" =~ ^[0-9]+$ && "$group_gid" = "$build_gid" ]] || exit 69
[[ "$build_uid" -ne 0 && "$build_gid" -ne 0 && -z "$group_members" ]] || exit 69
[[ "$build_shell" = /usr/sbin/nologin || "$build_shell" = /sbin/nologin ]] || exit 69
[[ "$(id -nG "$BUILD_USER")" = "$BUILD_GROUP" ]] || exit 69

for required in \
  parser-runtime/package.json \
  parser-runtime/package-lock.json \
  parser-runtime/requirements.lock \
  parser-runtime/pip-cacert.crt \
  parser-runtime/sitecustomize.py \
  extract_document_text.py \
  extract_xlsx_text.py \
  ocr_document_text.py \
  services/file_ingest_service.js \
  services/upload_sandbox_service.js \
  scripts/parse_upload_sandbox.sh \
  systemd/turingmarket-parser@.service \
  systemd/turingmarket-parser.slice; do
  [[ -f "$SOURCE_ROOT/$required" && ! -L "$SOURCE_ROOT/$required" ]] || {
    printf '%s\n' 'parser source artifact missing' >&2
    exit 66
  }
done

command -v systemctl >/dev/null
command -v runuser >/dev/null
BUILD_PARENT="$(mktemp -d /var/lib/turingmarket-parser-build.XXXXXXXXXXXX)"
chmod 0700 "$BUILD_PARENT"
chown root:root "$BUILD_PARENT"
runuser -u "$BUILD_USER" -- test ! -r "$BUILD_PARENT"
runuser -u "$BUILD_USER" -- test ! -x "$BUILD_PARENT"
BUILD_INPUT="$BUILD_PARENT/input"
BUILD_WORK="$BUILD_PARENT/work"
BUILD_RUNTIME="$BUILD_WORK/runtime"
install -d -o root -g root -m 0555 "$BUILD_INPUT"
install -d -o "$BUILD_USER" -g "$BUILD_GROUP" -m 0700 "$BUILD_WORK" "$BUILD_WORK/home"

for required in \
  parser-runtime/package.json \
  parser-runtime/package-lock.json \
  parser-runtime/requirements.lock \
  parser-runtime/pip-cacert.crt \
  parser-runtime/sitecustomize.py \
  extract_document_text.py \
  extract_xlsx_text.py \
  ocr_document_text.py \
  services/file_ingest_service.js \
  services/upload_sandbox_service.js \
  scripts/parse_upload_sandbox.sh \
  systemd/turingmarket-parser@.service \
  systemd/turingmarket-parser.slice; do
  copy_build_input "$required"
done
install -o root -g root -m 0444 "$SELF_PATH" "$BUILD_INPUT/.trusted-builder"
find "$BUILD_INPUT" -xdev -type d -exec chmod 0555 {} +

EVIDENCE_ROOT="$(mktemp -d /run/turingmarket-parser-build-evidence.XXXXXXXXXXXX)"
chmod 0700 "$EVIDENCE_ROOT"
chown root:root "$EVIDENCE_ROOT"
BUILD_BOUNDARY_OBSERVATION="$EVIDENCE_ROOT/boundary-observation.json"
BUILD_UNIT="turingmarket-parser-build.service"
# BEGIN DISPOSABLE BUILD UNIT
systemd-run --quiet --wait --collect \
  --unit="$BUILD_UNIT" \
  --service-type=exec \
  --property="User=turingmarket-gate" \
  --property="Group=turingmarket-gate" \
  --property="SupplementaryGroups=" \
  --property="UMask=0077" \
  --property="WorkingDirectory=/build-work" \
  --property="PrivateNetwork=yes" \
  --property="IPAddressDeny=any" \
  --property="RestrictAddressFamilies=AF_UNIX" \
  --property="PrivateMounts=yes" \
  --property="PrivateTmp=yes" \
  --property="PrivateUsers=yes" \
  --property="PrivateDevices=yes" \
  --property="DevicePolicy=closed" \
  --property="PrivateIPC=yes" \
  --property="PrivatePIDs=yes" \
  --property="ProtectSystem=strict" \
  --property="ProtectHome=yes" \
  --property="ProtectProc=invisible" \
  --property="ProcSubset=pid" \
  --property="ProtectKernelTunables=yes" \
  --property="ProtectKernelModules=yes" \
  --property="ProtectKernelLogs=yes" \
  --property="ProtectControlGroups=yes" \
  --property="ProtectClock=yes" \
  --property="ProtectHostname=yes" \
  --property="NoNewPrivileges=yes" \
  --property="CapabilityBoundingSet=" \
  --property="AmbientCapabilities=" \
  --property="RestrictNamespaces=yes" \
  --property="RestrictSUIDSGID=yes" \
  --property="LockPersonality=yes" \
  --property="SystemCallArchitectures=native" \
  --property="SystemCallFilter=@system-service" \
  --property="SystemCallFilter=~@mount @privileged @raw-io @reboot @swap @resources @obsolete @debug @clock accept accept4 bind connect getpeername getsockname getsockopt listen recv recvfrom recvmmsg recvmmsg_time64 recvmsg send sendmmsg sendmsg sendto setsockopt socket socketcall io_uring_setup io_uring_enter io_uring_register" \
  --property="SystemCallErrorNumber=EPERM" \
  --property="KeyringMode=private" \
  --property="TemporaryFileSystem=/root:ro" \
  --property="TemporaryFileSystem=/home:ro" \
  --property="TemporaryFileSystem=/etc:ro" \
  --property="TemporaryFileSystem=/opt:ro" \
  --property="TemporaryFileSystem=/srv:ro" \
  --property="TemporaryFileSystem=/tmp:ro" \
  --property="TemporaryFileSystem=/var:ro" \
  --property="TemporaryFileSystem=/run:ro" \
  --property="TemporaryFileSystem=/data:ro" \
  --property="TemporaryFileSystem=/mnt:ro" \
  --property="TemporaryFileSystem=/media:ro" \
  --property="InaccessiblePaths=-/etc/turingmarket -/etc/credstore -/etc/credstore.encrypted -/run/credentials -/run/secrets" \
  --property="InaccessiblePaths=-/root/turingmarket -/var/lib/turingmarket-gate -/var/lib/turingmarket-parser -/opt/turingmarket -/srv/turingmarket" \
  --property="BindReadOnlyPaths=$BUILD_INPUT:/build-input" \
  --property="BindReadOnlyPaths=$DEPENDENCY_CACHE_ROOT:/dependency-cache" \
  --property="BindPaths=$BUILD_WORK:/build-work" \
  --property="ReadWritePaths=/build-work" \
  --property="MemoryMax=3G" \
  --property="TasksMax=256" \
  --property="LimitNOFILE=1024" \
  --property="LimitCORE=0" \
  --property="TimeoutStartSec=20min" \
  --property="TimeoutStopSec=5" \
  --property="StandardInput=null" \
  --property="StandardOutput=journal" \
  --property="StandardError=journal" \
  /usr/bin/env -i \
    HOME=/build-work/home \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC \
    PYTHONNOUSERSITE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_CONFIG_FILE=/dev/null \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    npm_config_userconfig=/dev/null \
    npm_config_globalconfig=/build-work/npm-global.npmrc \
    npm_config_update_notifier=false \
    npm_config_audit=false \
    npm_config_fund=false \
    /bin/bash --noprofile --norc /build-input/.trusted-builder --unprivileged-build-worker &
BUILD_SYSTEMD_RUN_PID=$!
# END DISPOSABLE BUILD UNIT

for attempt in $(seq 1 200); do
  BUILD_ACTIVE_STATE="$(systemctl show "$BUILD_UNIT" --property=ActiveState --value 2>/dev/null || true)"
  if [[ "$BUILD_ACTIVE_STATE" = active ]]; then break; fi
  [[ "$attempt" -lt 200 ]] || {
    printf '%s\n' 'parser build unit did not become observable' >&2
    exit 69
  }
  sleep 0.05
done

verify_trusted_verifier
install -o root -g root -m 0600 /dev/null "$BUILD_BOUNDARY_OBSERVATION.next"
/usr/bin/node "$TRUSTED_VERIFIER" observe-build-boundary \
  --manifest "$TRUSTED_MANIFEST" \
  --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --expected-verifier-sha256 "$EXPECTED_VERIFIER_SHA256" \
  --source-root "$BUILD_INPUT" \
  --unit "$BUILD_UNIT" \
  --build-parent "$BUILD_PARENT" \
  --dependency-cache-root "$DEPENDENCY_CACHE_ROOT" \
  --build-work "$BUILD_WORK" > "$BUILD_BOUNDARY_OBSERVATION.next"
verify_trusted_verifier
chmod 0600 "$BUILD_BOUNDARY_OBSERVATION.next"
mv -T -- "$BUILD_BOUNDARY_OBSERVATION.next" "$BUILD_BOUNDARY_OBSERVATION"
install -o "$BUILD_USER" -g "$BUILD_GROUP" -m 0400 /dev/null "$BUILD_WORK/.controller-release"

set +e
wait "$BUILD_SYSTEMD_RUN_PID"
BUILD_STATUS=$?
set -e
BUILD_SYSTEMD_RUN_PID=''
if ((BUILD_STATUS != 0)); then
  printf '%s\n' 'non-root parser build unit failed' >&2
  exit 69
fi
for attempt in $(seq 1 200); do
  BUILD_LOAD_STATE="$(systemctl show "$BUILD_UNIT" --property=LoadState --value 2>/dev/null || true)"
  if [[ "$BUILD_LOAD_STATE" = not-found ]]; then break; fi
  [[ "$attempt" -lt 200 ]] || {
    printf '%s\n' 'parser build unit was not collected' >&2
    exit 69
  }
  sleep 0.05
done
if systemctl is-active --quiet "$BUILD_UNIT"; then
  printf '%s\n' 'parser build unit remained active after collection' >&2
  exit 69
fi
assert_unprivileged_runtime
verify_trusted_verifier
UNPRIVILEGED_OBSERVED="$(/usr/bin/node "$TRUSTED_VERIFIER" measure-runtime --root "$BUILD_RUNTIME" --require-root-ownership false)"
if [[ "${TM_UPLOAD_SANDBOX_PROVISION_DIAGNOSTIC:-0}" = "1" ]]; then
  printf 'parser candidate runtime identity: %s\n' "$UNPRIVILEGED_OBSERVED" >&2
fi
verify_trusted_verifier
BUILD_EVIDENCE="$(/usr/bin/node "$TRUSTED_VERIFIER" finalize-build-boundary \
  --manifest "$TRUSTED_MANIFEST" \
  --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --expected-verifier-sha256 "$EXPECTED_VERIFIER_SHA256" \
  --observation "$BUILD_BOUNDARY_OBSERVATION" \
  --runtime-root "$BUILD_RUNTIME" \
  --unit "$BUILD_UNIT" \
  --build-parent "$BUILD_PARENT")"
verify_trusted_verifier
TM_PARSER_BUILD_EVIDENCE="$BUILD_EVIDENCE" TM_RUNTIME_OBSERVED="$UNPRIVILEGED_OBSERVED" \
  /usr/bin/python3 - <<'PY'
import json
import os

evidence = json.loads(os.environ['TM_PARSER_BUILD_EVIDENCE'])
observed = json.loads(os.environ['TM_RUNTIME_OBSERVED'])
expected_top = {'format', 'manifest_sha256', 'verifier_sha256', 'runtime_tree', 'build_boundary'}
expected_boundary = {
    'format', 'source_artifacts_sha256', 'build_unit', 'build_unit_properties',
    'build_unit_properties_sha256',
    'build_unit_stopped', 'build_unit_collected', 'network_isolation', 'mount_isolation',
    'credential_isolation', 'build_parent_inaccessible'
}
if (set(evidence) != expected_top or evidence.get('format') != 'tm-parser-runtime-build-evidence-v2' or
        set(evidence.get('build_boundary', {})) != expected_boundary or
        evidence.get('runtime_tree') != observed):
    raise SystemExit('trusted parser build evidence is invalid')
for name in (
    'build_unit_stopped', 'build_unit_collected', 'network_isolation', 'mount_isolation',
    'credential_isolation', 'build_parent_inaccessible'
):
    if evidence['build_boundary'].get(name) is not True:
        raise SystemExit('trusted parser build boundary is incomplete')
PY

ROOT_STAGE="$(mktemp -d "$OUTPUT_PARENT/.turingmarket-parser-runtime.XXXXXXXXXXXX")"
chmod 0700 "$ROOT_STAGE"
cp -R --reflink=auto --no-preserve=ownership,timestamps "$BUILD_RUNTIME/." "$ROOT_STAGE/"
find "$ROOT_STAGE" -xdev -type d -exec chmod 0555 {} +
find "$ROOT_STAGE" -xdev -type f -perm /0111 -exec chmod 0555 {} +
find "$ROOT_STAGE" -xdev -type f ! -perm /0111 -exec chmod 0444 {} +
chown -R 0:0 "$ROOT_STAGE"
chmod 0755 "$ROOT_STAGE"/{input,output,runtime,scratch}
chmod 0644 "$ROOT_STAGE/input/input.bin" "$ROOT_STAGE/runtime/request.json"
if find "$ROOT_STAGE" -xdev -type l -print -quit | grep -q .; then exit 66; fi
if find "$ROOT_STAGE" -xdev ! -type d ! -type f -print -quit | grep -q .; then exit 66; fi
verify_trusted_verifier
OBSERVED="$(/usr/bin/node "$TRUSTED_VERIFIER" measure-runtime --root "$ROOT_STAGE" --require-root-ownership true)"
verify_trusted_verifier
[[ "$OBSERVED" = "$UNPRIVILEGED_OBSERVED" ]] || {
  printf '%s\n' 'parser runtime identity changed while sealing' >&2
  exit 67
}
SHA256="$(printf '%s' "$OBSERVED" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["sha256"])')"
if [[ -n "$EXPECTED_SHA256" && "$SHA256" != "$EXPECTED_SHA256" ]]; then
  printf '%s\n' 'parser runtime digest mismatch' >&2
  exit 67
fi

mv -T -- "$ROOT_STAGE" "$OUTPUT_ROOT"
ROOT_STAGE=''
rm -rf --one-file-system -- "$BUILD_PARENT"
BUILD_PARENT=''
rm -rf --one-file-system -- "$EVIDENCE_ROOT"
EVIDENCE_ROOT=''
BUILD_UNIT=''
trap - EXIT INT TERM
if ((JSON_OUTPUT)); then printf '%s\n' "$BUILD_EVIDENCE"; else printf '%s\n' "$SHA256"; fi
