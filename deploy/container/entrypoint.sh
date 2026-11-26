#!/bin/bash
# The entrypoint of the Infall server image (installed as /usr/local/bin/infall).
#
#   infall serve                 run the server (the default): copies the database first when
#                                this image's server differs from the one that last used it,
#                                and reads or makes the secret key
#   infall health                exit 0 when this container's server answers /api/health
#   infall backup                a Workspace file (infall-<time>.infall.gz) into $INFALL_BACKUP_DIR,
#                                made by `infall-server export-workspace` (safe while it runs)
#   infall backup-database       a copy of the whole database (infall-<time>.db.gz), sign-ins
#                                and all, into $INFALL_BACKUP_DIR
#   infall backup-daemon         a Workspace file now if none is younger than a day, then one
#                                every day at $INFALL_BACKUP_TIME (UTC), and a database copy
#                                with it when $INFALL_BACKUP_DATABASE=yes; keeps the newest
#                                $INFALL_BACKUP_KEEP of each kind
#   infall backup-health         exit 0 when the newest Workspace file is younger than 26 hours
#   infall list-backups          both kinds, newest first
#   infall restore <file>|-      put a database copy back as the database (the server must be
#                                stopped); "-" reads it from standard input (docker compose run -T).
#                                Refuses a Workspace file: that goes onto an empty server with
#                                import-workspace
#   infall import-workspace <file>|- --admin-email <e>
#                                infall-server import-workspace; a bare name is looked up in
#                                $INFALL_BACKUP_DIR, "-" reads the file from standard input
#   anything else                passed to infall-server (create-admin, reset-password,
#                                export-workspace, gen-secret-key, …), after the same
#                                pre-upgrade copy
#
# Database copies (backup-database, and the copy before an upgrade) are made with SQLite's
# online backup and checked with PRAGMA integrity_check before they are kept, as
# deploy/backup.sh does on the systemd route. Workspace files are checked the same way.
set -euo pipefail
umask 077

# A variable still set under its name from before the rename (QOOP_DB for INFALL_DB) is
# read when the new one is not set, with one warning, here and in the server it starts
# (docs/specs/api.md, "Names before the rename").
for name in DB BACKUP_DIR BACKUP_KEEP BACKUP_TIME BACKUP_DATABASE UPGRADE_KEEP SECRET_KEY \
    SECRET_KEY_FILE ADDR PUBLIC_ORIGIN MAX_IMPORT_MB MAX_PDF_MB WEB_DIR; do
    new="INFALL_$name" old="QOOP_$name"
    if [ -z "${!new:-}" ] && [ -n "${!old:-}" ]; then
        echo "infall: $old is read as $new, its name since the rename: rename it" >&2
        export "$new=${!old}"
    fi
done
unset name new old

DB="${INFALL_DB:-/data/infall.db}"
DATA_DIR="$(dirname "$DB")"
BACKUP_DIR="${INFALL_BACKUP_DIR:-/backups}"
BACKUP_KEEP="${INFALL_BACKUP_KEEP:-14}"
BACKUP_TIME="${INFALL_BACKUP_TIME:-03:30}"
BACKUP_DATABASE="${INFALL_BACKUP_DATABASE:-no}"
UPGRADE_DIR="$DATA_DIR/pre-upgrade"
UPGRADE_KEEP="${INFALL_UPGRADE_KEEP:-3}"
MARKER="$DATA_DIR/.infall-server"
SECRET_FILE="$DATA_DIR/secret-key"
SERVER_BIN=/usr/local/bin/infall-server
# PRAGMA application_id of a Workspace file ("Infa"; crates/server/src/local/port.rs).
WORKSPACE_FILE_ID=1231971937

say() { echo "infall: $*" >&2; }
die() {
    say "$*"
    exit 1
}
stamp() { date -u +%Y%m%dT%H%M%SZ; }
whole_number() { case "$1" in '' | *[!0-9]*) return 1 ;; esac }

# A consistent copy of the database into $2, checked before it counts.
copy_db() { # <db> <dest>
    local db="$1" dest="$2" check
    sqlite3 "$db" ".backup '$dest'" || return 1
    check="$(sqlite3 "$dest" 'PRAGMA integrity_check;')" || return 1
    if [ "$check" != "ok" ]; then
        say "integrity check failed on the copy: $check"
        rm -f "$dest"
        return 1
    fi
}

# Keeps the newest $2 files matching $3 in $1 (names carry the time, so they sort by it).
prune() { # <dir> <keep> <glob>
    local dir="$1" keep="$2" glob="$3"
    find "$dir" -maxdepth 1 -type f -name "$glob" -printf '%f\n' | sort -r |
        tail -n +"$((keep + 1))" | while read -r old; do
        rm -f -- "$dir/$old"
        say "removed old copy $dir/$old"
    done
}

check_data_dir() {
    [ -d "$DATA_DIR" ] || die "the data folder $DATA_DIR does not exist; mount a volume there"
    [ -w "$DATA_DIR" ] || die "the data folder $DATA_DIR is not writable by user $(id -u); with a bind mount, run: chown -R $(id -u):$(id -g) <host folder>"
}

# Before a different server binary opens an existing database (it may migrate it, and a
# migrated file is not for older versions), keep a copy; refuse to start if that fails.
guard_upgrade() {
    check_data_dir
    local now before uv dest
    now="$(sha256sum "$SERVER_BIN" | cut -d' ' -f1) ${INFALL_VERSION:-dev}"
    if [ ! -f "$DB" ]; then
        printf '%s\n' "$now" >"$MARKER"
        return 0
    fi
    before="$(cat "$MARKER" 2>/dev/null || echo "unrecorded unrecorded")"
    [ "$before" = "$now" ] && return 0
    uv="$(sqlite3 "$DB" 'PRAGMA user_version;' 2>/dev/null || echo '?')"
    mkdir -p "$UPGRADE_DIR"
    dest="$UPGRADE_DIR/infall-$(stamp)-from-${before#* }-schema$uv.db"
    say "a different server (${now#* }) than last time (${before#* }): copying the database to $dest first"
    copy_db "$DB" "$dest" || die "could not copy the database before the upgrade; not starting (nothing was changed)"
    whole_number "$UPGRADE_KEEP" || die "INFALL_UPGRADE_KEEP must be a whole number"
    prune "$UPGRADE_DIR" "$UPGRADE_KEEP" 'infall-*.db'
    printf '%s\n' "$now" >"$MARKER"
}

load_secret_key() {
    if [ -n "${INFALL_SECRET_KEY:-}" ]; then
        return 0
    fi
    if [ -n "${INFALL_SECRET_KEY_FILE:-}" ]; then
        [ -r "$INFALL_SECRET_KEY_FILE" ] || die "INFALL_SECRET_KEY_FILE $INFALL_SECRET_KEY_FILE cannot be read"
        INFALL_SECRET_KEY="$(cat "$INFALL_SECRET_KEY_FILE")"
    else
        if [ ! -s "$SECRET_FILE" ]; then
            "$SERVER_BIN" gen-secret-key >"$SECRET_FILE.tmp"
            mv "$SECRET_FILE.tmp" "$SECRET_FILE"
            say "made a new secret key in $SECRET_FILE (it seals Members' OpenRouter keys; backups leave it out, so keep a copy of it: deploy/README.md)"
        fi
        INFALL_SECRET_KEY="$(cat "$SECRET_FILE")"
    fi
    export INFALL_SECRET_KEY
}

# GET /api/health over plain TCP (bash's /dev/tcp): no curl in the image.
health() { # [host] [port]
    local host="${1:-127.0.0.1}" port="${2:-${INFALL_ADDR##*:}}" reply
    exec 3<>"/dev/tcp/$host/$port" || return 1
    printf 'GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
    reply="$(timeout 4 cat <&3)" || true
    exec 3>&-
    case "$reply" in
    "HTTP/1.1 200"*'"ok":true'*) return 0 ;;
    *) return 1 ;;
    esac
}

check_backup_dir() {
    [ -f "$DB" ] || die "no database at $DB yet (create the first Admin, or start the server once)"
    [ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] || die "the backup folder $BACKUP_DIR is missing or not writable"
    whole_number "$BACKUP_KEEP" && [ "$BACKUP_KEEP" -ge 1 ] || die "INFALL_BACKUP_KEEP must be a whole number, 1 or more"
}

# A Workspace file of the Workspace: what an Admin's Export Workspace file… gives, made by
# the server's own export from a consistent snapshot, so it is safe while the server runs.
# It holds the work and the Members as names; no sign-ins (README.md, "Back up and restore").
backup() {
    check_backup_dir
    local tmp out check
    tmp="$(mktemp -d "$BACKUP_DIR/.tmp.XXXXXX")"
    out="$BACKUP_DIR/infall-$(stamp).infall.gz"
    if ! "$SERVER_BIN" export-workspace "$tmp/w.infall" >/dev/null; then
        rm -rf "$tmp"
        die "backup failed (infall-server export-workspace); nothing was written"
    fi
    check="$(sqlite3 "$tmp/w.infall" 'PRAGMA integrity_check;' 2>&1)" || check="not a database"
    if [ "$check" != "ok" ]; then
        rm -rf "$tmp"
        die "integrity check failed on the Workspace file ($check); nothing was written"
    fi
    gzip -9 "$tmp/w.infall"
    mv "$tmp/w.infall.gz" "$out"
    rm -rf "$tmp"
    say "wrote the Workspace file $out ($(du -h "$out" | cut -f1))"
    prune "$BACKUP_DIR" "$BACKUP_KEEP" 'infall-*.infall.gz'
}

# A copy of the whole database, for putting this server back as it was (restore): sign-ins,
# invites, access tokens and sealed AI keys included. Read by this version or a newer one.
backup_database() {
    check_backup_dir
    local tmp out
    tmp="$(mktemp -d "$BACKUP_DIR/.tmp.XXXXXX")"
    out="$BACKUP_DIR/infall-$(stamp).db.gz"
    if ! copy_db "$DB" "$tmp/infall.db"; then
        rm -rf "$tmp"
        die "database copy failed; nothing was written"
    fi
    gzip -9 "$tmp/infall.db"
    mv "$tmp/infall.db.gz" "$out"
    rm -rf "$tmp"
    say "wrote the database copy $out ($(du -h "$out" | cut -f1))"
    prune "$BACKUP_DIR" "$BACKUP_KEEP" 'infall-*.db.gz'
}

daily_backup() {
    (backup) || say "the Workspace file failed; will try again at the next scheduled time"
    if [ "$BACKUP_DATABASE" = "yes" ]; then
        (backup_database) || say "the database copy failed; will try again at the next scheduled time"
    fi
}

backup_daemon() {
    case "$BACKUP_TIME" in
    [0-2][0-9]:[0-5][0-9]) ;;
    *) die "INFALL_BACKUP_TIME must be HH:MM (UTC), e.g. 03:30" ;;
    esac
    case "$BACKUP_DATABASE" in
    yes | no) ;;
    *) die "INFALL_BACKUP_DATABASE must be yes or no" ;;
    esac
    whole_number "$BACKUP_KEEP" && [ "$BACKUP_KEEP" -ge 1 ] || die "INFALL_BACKUP_KEEP must be a whole number, 1 or more"
    trap 'say "backup job stopping"; exit 0' TERM INT
    local extra=""
    [ "$BACKUP_DATABASE" = "yes" ] && extra=" and a database copy"
    say "a Workspace file$extra every day at $BACKUP_TIME UTC into $BACKUP_DIR, keeping the newest $BACKUP_KEEP of each"
    if ! find "$BACKUP_DIR" -maxdepth 1 -name 'infall-*.infall.gz' -mmin -1380 | grep -q .; then
        daily_backup
    fi
    local now next
    while true; do
        now="$(date -u +%s)"
        next="$(date -u -d "today $BACKUP_TIME" +%s)"
        [ "$next" -gt "$now" ] || next="$(date -u -d "tomorrow $BACKUP_TIME" +%s)"
        sleep "$((next - now))" &
        wait $!
        daily_backup
    done
}

backup_health() {
    find "$BACKUP_DIR" -maxdepth 1 -name 'infall-*.infall.gz' -mmin -1560 | grep -q .
}

list_backups() {
    find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'infall-*.infall.gz' -o -name 'infall-*.db.gz' \) \
        -printf '%f  %s bytes\n' | sort -r | while read -r name rest; do
        case "$name" in
        *.infall.gz) echo "$name  $rest  Workspace file (import-workspace onto an empty server)" ;;
        *) echo "$name  $rest  database copy (restore)" ;;
        esac
    done
}

# infall-server import-workspace, taking a bare name from the backups folder, "-" from
# standard input (so a file from outside Docker needs no mount), and a gzip-compressed
# Workspace file (the backup job's .infall.gz) as well as a plain one.
import_workspace() { # <file>|- [options]
    local file="${1:-}" tmp="" status=0
    [ -n "$file" ] || die "usage: infall import-workspace <Workspace file, a name in $BACKUP_DIR, or -> --admin-email <email>"
    shift
    guard_upgrade
    if [ "$file" != "-" ] && [ ! -e "$file" ] && [ -f "$BACKUP_DIR/$file" ]; then
        file="$BACKUP_DIR/$file"
    fi
    say "bringing in $([ "$file" = "-" ] && echo "the Workspace file from standard input" || echo "$file")"
    if [ "$file" = "-" ] || gzip -t "$file" 2>/dev/null; then
        tmp="$(mktemp "$DATA_DIR/.import.XXXXXX")"
        if [ "$file" = "-" ]; then cat >"$tmp.in"; else cp "$file" "$tmp.in"; fi
        if gzip -t "$tmp.in" 2>/dev/null; then gunzip -c "$tmp.in" >"$tmp"; else mv "$tmp.in" "$tmp"; fi
        rm -f "$tmp.in"
        file="$tmp"
    fi
    "$SERVER_BIN" import-workspace "$file" "$@" || status=$?
    [ -z "$tmp" ] || rm -f "$tmp"
    return "$status"
}

restore() { # <file>
    local file="${1:-}" host="${INFALL_SERVER_HOST:-server}" tmp
    [ -n "$file" ] || die "usage: infall restore <backup file in $BACKUP_DIR, or - to read it from standard input>   (infall list-backups shows them)"
    if [ "$file" != "-" ]; then
        case "$file" in /*) ;; *) [ -f "$file" ] || file="$BACKUP_DIR/$file" ;; esac
        [ -f "$file" ] || die "no such backup: $file"
    fi
    check_data_dir
    if (health "$host" 8787) 2>/dev/null; then
        die "the server is still running; stop it first: docker compose stop server"
    fi
    tmp="$(mktemp "$DATA_DIR/.restore.XXXXXX")"
    if [ "$file" = "-" ]; then
        cat >"$tmp.in"
        file="(standard input)"
    else
        cp "$file" "$tmp.in"
    fi
    # A backup is gzip-compressed; a plain database file is taken as it is.
    if gzip -t "$tmp.in" 2>/dev/null; then
        gunzip -c "$tmp.in" >"$tmp"
    else
        mv "$tmp.in" "$tmp"
    fi
    rm -f "$tmp.in"
    local check
    check="$(sqlite3 "$tmp" 'PRAGMA integrity_check;' 2>&1)" || check="not a database"
    if [ "$check" != "ok" ]; then
        rm -f "$tmp"
        die "$file is not a sound database ($check); nothing was changed"
    fi
    # A Workspace file put in place as the database would leave nobody able to sign in.
    if [ "$(sqlite3 "$tmp" 'PRAGMA application_id;' 2>/dev/null)" = "$WORKSPACE_FILE_ID" ]; then
        rm -f "$tmp"
        die "$file is a Workspace file, not a database copy; nothing was changed. A Workspace file goes onto an empty server: import-workspace (deploy/README.md, \"Back up and restore\")"
    fi
    if [ -f "$DB" ]; then
        local keep
        keep="$DB.before-restore-$(stamp)"
        mv "$DB" "$keep"
        say "kept the database it replaces as $keep (delete it once you are sure)"
    fi
    # Stale WAL companions of the old file would not match the restored one.
    rm -f "$DB-wal" "$DB-shm"
    chmod 600 "$tmp"
    mv "$tmp" "$DB"
    say "restored $file as $DB; start the server: docker compose up -d"
}

command="${1:-serve}"
[ $# -gt 0 ] && shift
case "$command" in
serve)
    guard_upgrade
    load_secret_key
    exec "$SERVER_BIN" serve "$@"
    ;;
health) health "$@" ;;
backup) backup ;;
backup-database) backup_database ;;
backup-daemon) backup_daemon ;;
backup-health) backup_health ;;
list-backups) list_backups ;;
restore) restore "$@" ;;
import-workspace) import_workspace "$@" ;;
gen-secret-key | help | --help | -h | --version | -V) exec "$SERVER_BIN" "$command" "$@" ;;
*)
    guard_upgrade
    exec "$SERVER_BIN" "$command" "$@"
    ;;
esac
