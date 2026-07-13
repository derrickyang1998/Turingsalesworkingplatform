#!/usr/bin/env bash
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

require_root() {
  [ "$(id -u)" = "0" ] || die "This bootstrap must run as root"
}

require_exact_host() {
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "$ID" = "ubuntu" ] || die "Expected Ubuntu"
  [ "$VERSION_ID" = "26.04" ] || die "Expected Ubuntu 26.04"
  [ "$(dpkg --print-architecture)" = "amd64" ] || die "Expected amd64 packages"
  [ "$(uname -m)" = "x86_64" ] || die "Expected x86_64 kernel"
  [ -d "$LIVE_DIR" ] && [ ! -L "$LIVE_DIR" ] || die "Live platform directory is invalid"
  command -v node >/dev/null
  command -v pm2 >/dev/null
  command -v apparmor_parser >/dev/null
  command -v flock >/dev/null
  command -v passwd >/dev/null
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

snapshot_host() {
  local phase="$1"
  mkdir -p "$BACKUP_DIR/$phase"
  dpkg-query -W -f='${binary:Package}\t${Version}\n' | LC_ALL=C sort > "$BACKUP_DIR/$phase/dpkg-query.txt"
  apt-mark showmanual | LC_ALL=C sort > "$BACKUP_DIR/$phase/apt-mark-manual.txt"
  apt-mark showhold | LC_ALL=C sort > "$BACKUP_DIR/$phase/apt-mark-hold.txt"
  cp -a /etc/apt/sources.list.d "$BACKUP_DIR/$phase/sources.list.d"
  if [ -f /etc/apt/sources.list ]; then
    cp -a /etc/apt/sources.list "$BACKUP_DIR/$phase/sources.list"
  fi
  safe_pm2_snapshot > "$BACKUP_DIR/$phase/pm2.json"
  curl -fsS http://127.0.0.1:3002/api/health > "$BACKUP_DIR/$phase/health.json"
  df -PT "$LIVE_DIR" "$STATE_ROOT" > "$BACKUP_DIR/$phase/disk.txt" 2>&1 || true
  systemctl --failed --no-legend > "$BACKUP_DIR/$phase/systemd-failed.txt" 2>&1 || true
}

copy_existing_path() {
  local source="$1"
  local destination="$2"
  if [ -e "$source" ] || [ -L "$source" ]; then
    cp -a -- "$source" "$destination"
    : > "$destination.present"
  else
    : > "$destination.absent"
  fi
}

restore_copy() {
  local backup="$1"
  local target="$2"
  rm -rf -- "$target" || return 1
  if [ -f "$backup.present" ]; then
    mkdir -p "$(dirname "$target")" || return 1
    cp -a -- "$backup" "$target" || return 1
  fi
}

stop_current_release() {
  pm2 stop turingmarket
}

restart_current_release() {
  cd "$LIVE_DIR"
  pm2 restart ecosystem.config.js --only turingmarket --update-env || \
    pm2 start ecosystem.config.js --only turingmarket --update-env
  for _attempt in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3002/api/health >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

database_backup() {
  local source="$1"
  local destination="$2"
  cd "$LIVE_DIR/server"
  DB_BACKUP_SOURCE="$source" DB_BACKUP_DESTINATION="$destination" node <<'NODE'
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
  cd "$LIVE_DIR/server"
  DB_QUICK_CHECK_PATH="$1" node <<'NODE'
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
  [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]
}

validate_external_runtime() {
  [ -f "$ENV_FILE" ] || return 1
  [ -f "$DB_DIR/turingmarket.db" ] || return 1
  [ "$(stat -c '%U:%G:%a' "$ENV_FILE")" = "root:root:600" ] || return 1
  for directory in "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR"; do
    [ -d "$directory" ] || return 1
    [ ! -L "$directory" ] || return 1
    [ "$(stat -c '%U:%G:%a' "$directory")" = "root:root:700" ] || return 1
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
  group_names="$(id -nG "$GATE_USER")" || return 1
  password_status="$(passwd -S "$GATE_USER" | awk '{print $2}')" || return 1
  validate_gate_identity_values "$passwd_line" "$group_line" "$group_names" "$password_status"
}

sync_directory() {
  sync -f "$1"
}

set_migration_phase() {
  local phase="$1"
  local temporary="$JOURNAL_DIR/.phase.$$"
  case "$phase" in
    stopping|snapshotting|prepared|installing|linked|committed) ;;
    *) die "Invalid migration phase: $phase" ;;
  esac
  [ -d "$JOURNAL_DIR" ] || die "Migration journal is missing"
  printf '%s\n' "$phase" > "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$JOURNAL_DIR/phase"
  sync_directory "$JOURNAL_DIR"
}

begin_migration_journal() {
  local temporary="$JOURNAL_ROOT/.active.$$"
  [ ! -e "$JOURNAL_DIR" ] || die "An active migration journal already exists"
  rm -rf -- "$temporary"
  mkdir -m 0700 "$temporary"
  printf '%s\n' "$BACKUP_DIR" > "$temporary/backup-dir"
  printf '%s\n' stopping > "$temporary/phase"
  chmod 0600 "$temporary/backup-dir" "$temporary/phase"
  sync_directory "$temporary"
  mv "$temporary" "$JOURNAL_DIR"
  sync_directory "$JOURNAL_ROOT"
}

clear_migration_journal() {
  rm -rf -- "$JOURNAL_DIR" || return 1
  sync_directory "$JOURNAL_ROOT" || return 1
}

read_journal() {
  local expected_owner="root:root:700"
  [ -d "$JOURNAL_DIR" ] || return 1
  if [ -L "$JOURNAL_DIR" ]; then printf '%s\n' "Migration journal must not be a symlink" >&2; return 1; fi
  if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
    expected_owner="$(id -un):$(id -gn):700"
  fi
  if [ "$(stat -c '%U:%G:%a' "$JOURNAL_DIR")" != "$expected_owner" ]; then printf '%s\n' "Migration journal ownership or mode drift" >&2; return 1; fi
  if [ ! -f "$JOURNAL_DIR/phase" ] || [ ! -f "$JOURNAL_DIR/backup-dir" ]; then printf '%s\n' "Migration journal is incomplete" >&2; return 1; fi
  JOURNAL_PHASE="$(cat "$JOURNAL_DIR/phase")"
  JOURNAL_BACKUP_DIR="$(cat "$JOURNAL_DIR/backup-dir")"
  case "$JOURNAL_PHASE" in
    stopping|snapshotting|prepared|installing|linked|committed) ;;
    *) printf '%s\n' "Migration journal phase is invalid" >&2; return 1 ;;
  esac
  case "$JOURNAL_BACKUP_DIR" in
    "$BACKUP_ROOT"/v030-runtime-bootstrap-*) ;;
    *) printf '%s\n' "Migration journal backup path is invalid" >&2; return 1 ;;
  esac
}

cleanup_stages() {
  rm -rf -- "$ENV_DIR"/.turingmarket.env.new.* "$STATE_ROOT"/.db.new.* "$STATE_ROOT"/.uploads.new.* "$STATE_ROOT"/.tmp.new.*
}

snapshot_database_directory() {
  local source="$1"
  local destination="$2"
  mkdir -m 0700 "$destination"
  database_backup "$source/turingmarket.db" "$destination/turingmarket.db"
  database_quick_check "$destination/turingmarket.db"
  : > "$destination.present"
}

snapshot_runtime_state() {
  copy_existing_path "$LIVE_DIR/.env" "$STATE_BACKUP/live-env"
  snapshot_database_directory "$LIVE_DIR/server/db" "$STATE_BACKUP/live-db"
  copy_existing_path "$LIVE_DIR/uploads" "$STATE_BACKUP/live-uploads"
  copy_existing_path "$LIVE_DIR/tmp" "$STATE_BACKUP/live-tmp"
  copy_existing_path "$ENV_FILE" "$STATE_BACKUP/external-env"
  copy_existing_path "$DB_DIR" "$STATE_BACKUP/external-db"
  copy_existing_path "$UPLOAD_DIR" "$STATE_BACKUP/external-uploads"
  copy_existing_path "$TMP_DIR" "$STATE_BACKUP/external-tmp"
}

restore_runtime_snapshot() {
  local backup_dir="$1"
  local state_backup="$backup_dir/state"
  if [ ! -f "$state_backup/live-env.present" ]; then printf '%s\n' "Rollback environment snapshot is missing" >&2; return 1; fi
  if [ ! -f "$state_backup/live-db.present" ]; then printf '%s\n' "Rollback database snapshot is missing" >&2; return 1; fi
  if [ ! -f "$state_backup/live-uploads.present" ]; then printf '%s\n' "Rollback uploads snapshot is missing" >&2; return 1; fi
  if [ ! -f "$state_backup/live-tmp.present" ]; then printf '%s\n' "Rollback temp snapshot is missing" >&2; return 1; fi

  stop_current_release >/dev/null 2>&1 || true
  restore_copy "$state_backup/live-env" "$LIVE_DIR/.env" || return 1
  restore_copy "$state_backup/live-db" "$LIVE_DIR/server/db" || return 1
  restore_copy "$state_backup/live-uploads" "$LIVE_DIR/uploads" || return 1
  restore_copy "$state_backup/live-tmp" "$LIVE_DIR/tmp" || return 1
  restore_copy "$state_backup/external-env" "$ENV_FILE" || return 1
  restore_copy "$state_backup/external-db" "$DB_DIR" || return 1
  restore_copy "$state_backup/external-uploads" "$UPLOAD_DIR" || return 1
  restore_copy "$state_backup/external-tmp" "$TMP_DIR" || return 1
  cleanup_stages || return 1
  database_quick_check "$LIVE_DIR/server/db/turingmarket.db" || return 1
  restart_current_release || return 1
  printf '%s\n' "BOOTSTRAP_ROLLBACK_OK"
}

recover_interrupted_migration() {
  local phase backup_dir
  if [ ! -d "$JOURNAL_DIR" ]; then
    return 0
  fi
  read_journal || return 1
  phase="$JOURNAL_PHASE"
  backup_dir="$JOURNAL_BACKUP_DIR"

  if [ "$phase" = "committed" ] && \
     validate_exact_link "$LIVE_DIR/.env" "$ENV_FILE" && \
     validate_exact_link "$LIVE_DIR/server/db" "$DB_DIR" && \
     validate_exact_link "$LIVE_DIR/uploads" "$UPLOAD_DIR" && \
     validate_exact_link "$LIVE_DIR/tmp" "$TMP_DIR" && \
     validate_external_runtime && \
     database_quick_check "$DB_DIR/turingmarket.db" && \
     restart_current_release; then
    clear_migration_journal || return 1
    printf '%s\n' "BOOTSTRAP_RECOVERY_COMMIT_OK"
    return 0
  fi

  if [ "$phase" = "stopping" ] || [ "$phase" = "snapshotting" ]; then
    cleanup_stages || return 1
    restart_current_release || return 1
  else
    restore_runtime_snapshot "$backup_dir" || return 1
  fi
  clear_migration_journal || return 1
  printf '%s\n' "BOOTSTRAP_RECOVERY_OK"
}

bootstrap_abort() {
  local status="$1"
  if [ "$ABORTING" = "1" ]; then
    exit "$status"
  fi
  ABORTING=1
  trap - ERR INT TERM HUP
  if [ -d "$JOURNAL_DIR" ]; then
    if ! recover_interrupted_migration; then
      printf '%s\n' "BOOTSTRAP_RECOVERY_FAILED: journal retained at $JOURNAL_DIR" >&2
      exit 1
    fi
  elif [ "$PROCESS_STOPPED" = "1" ]; then
    restart_current_release || true
  fi
  exit "$status"
}

if [ "${TM_BOOTSTRAP_LIBRARY_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

require_root
require_exact_host
install -d -o root -g root -m 0700 "$JOURNAL_ROOT"
exec 9>"$JOURNAL_ROOT/bootstrap.lock"
flock -n 9 || die "Another runtime bootstrap is active"
recover_interrupted_migration

mkdir -p "$BACKUP_DIR" "$STATE_BACKUP"
snapshot_host before

apt-get update
apt-get install -s --no-install-recommends --no-upgrade "${BROWSER_PACKAGES[@]}" > "$BACKUP_DIR/apt-install-plan.txt"
if grep -Eq '^Remv |^Inst [^ ]+ \[[^]]+\]' "$BACKUP_DIR/apt-install-plan.txt"; then
  die "Browser dependency plan would remove or upgrade an installed package"
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-upgrade "${BROWSER_PACKAGES[@]}"

if ! getent passwd "$GATE_USER" >/dev/null; then
  useradd --system --user-group --home-dir "$GATE_ROOT" --create-home --shell /usr/sbin/nologin "$GATE_USER"
fi
validate_gate_identity || die "Gate identity validation failed"
install -d -o root -g root -m 0755 "$GATE_ROOT" "$GATE_ROOT/releases"
install -d -o root -g root -m 0700 "$ENV_DIR" "$STATE_ROOT"

cat > "$APPARMOR_PROFILE" <<'APPARMOR'
abi <abi/4.0>,
#include <tunables/global>

profile turingmarket-gate-chromium /var/lib/turingmarket-gate/releases/*/tmp/deploy-v030-gate-*/browser-cache/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
  userns,
}
APPARMOR
chmod 0644 "$APPARMOR_PROFILE"
apparmor_parser -r "$APPARMOR_PROFILE"

if validate_exact_link "$LIVE_DIR/.env" "$ENV_FILE" && \
   validate_exact_link "$LIVE_DIR/server/db" "$DB_DIR" && \
   validate_exact_link "$LIVE_DIR/uploads" "$UPLOAD_DIR" && \
   validate_exact_link "$LIVE_DIR/tmp" "$TMP_DIR"; then
  validate_external_runtime || die "External runtime state is incomplete or has unsafe permissions"
  database_quick_check "$DB_DIR/turingmarket.db"
  snapshot_host after
  (cd "$BACKUP_DIR" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS)
  chmod -R go-rwx "$BACKUP_DIR"
  printf '%s\n' "BOOTSTRAP_ALREADY_APPLIED"
  exit 0
fi

for required in "$LIVE_DIR/.env" "$LIVE_DIR/server/db/turingmarket.db" "$LIVE_DIR/uploads" "$LIVE_DIR/tmp"; do
  [ -e "$required" ] || die "Required runtime path is missing: $required"
  [ ! -L "$required" ] || die "Mixed runtime layout requires journaled recovery: $required"
done

begin_migration_journal
trap 'bootstrap_abort $?' ERR
trap 'bootstrap_abort 130' INT
trap 'bootstrap_abort 143' TERM
trap 'bootstrap_abort 129' HUP

stop_current_release
PROCESS_STOPPED=1
set_migration_phase snapshotting
snapshot_runtime_state
set_migration_phase prepared

ENV_STAGE="$ENV_DIR/.turingmarket.env.new.$$"
DB_STAGE="$STATE_ROOT/.db.new.$$"
UPLOAD_STAGE="$STATE_ROOT/.uploads.new.$$"
TMP_STAGE="$STATE_ROOT/.tmp.new.$$"
rm -rf -- "$ENV_STAGE" "$DB_STAGE" "$UPLOAD_STAGE" "$TMP_STAGE"
install -m 0600 "$LIVE_DIR/.env" "$ENV_STAGE"
install -d -m 0700 "$DB_STAGE" "$UPLOAD_STAGE" "$TMP_STAGE"
database_backup "$LIVE_DIR/server/db/turingmarket.db" "$DB_STAGE/turingmarket.db"
cp -a "$LIVE_DIR/uploads/." "$UPLOAD_STAGE/"
cp -a "$LIVE_DIR/tmp/." "$TMP_STAGE/"
database_quick_check "$DB_STAGE/turingmarket.db"

set_migration_phase installing
rm -rf -- "$ENV_FILE" "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR"
mv "$ENV_STAGE" "$ENV_FILE"
mv "$DB_STAGE" "$DB_DIR"
mv "$UPLOAD_STAGE" "$UPLOAD_DIR"
mv "$TMP_STAGE" "$TMP_DIR"
chown -R root:root "$ENV_FILE" "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR"
chmod 0600 "$ENV_FILE"
chmod 0700 "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR"
find "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" -type d -exec chmod 0700 {} +
find "$DB_DIR" "$UPLOAD_DIR" "$TMP_DIR" -type f -exec chmod 0600 {} +

rm -rf -- "$LIVE_DIR/.env" "$LIVE_DIR/server/db" "$LIVE_DIR/uploads" "$LIVE_DIR/tmp"
ln -s /etc/turingmarket/turingmarket.env "$LIVE_DIR/.env"
ln -s /var/lib/turingmarket/db "$LIVE_DIR/server/db"
ln -s /var/lib/turingmarket/uploads "$LIVE_DIR/uploads"
ln -s /var/lib/turingmarket/tmp "$LIVE_DIR/tmp"
set_migration_phase linked

validate_external_runtime
database_quick_check "$DB_DIR/turingmarket.db"
restart_current_release
PROCESS_STOPPED=0
database_quick_check "$DB_DIR/turingmarket.db"
set_migration_phase committed
snapshot_host after
(cd "$BACKUP_DIR" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS)
chmod -R go-rwx "$BACKUP_DIR"
clear_migration_journal
trap - ERR INT TERM HUP
printf '%s\n' "BOOTSTRAP_OK"
