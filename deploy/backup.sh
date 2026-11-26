#!/bin/sh
# Infall daily backup: consistent SQLite copy -> gzip -> age encryption ->
# dated local file -> prune old -> optional rclone copy off the machine.
# Configuration comes from the environment (see infall.env.example).
set -eu
umask 077

# A variable still set under its name from before the rename (QOOP_DB for INFALL_DB) is
# read when the new one is not set, with one warning (docs/specs/api.md, "Names before the
# rename").
for name in DB BACKUP_DIR BACKUP_KEEP_DAYS BACKUP_AGE_RECIPIENT BACKUP_REMOTE; do
	eval "new=\${INFALL_$name:-} old=\${QOOP_$name:-}"
	if [ -z "$new" ] && [ -n "$old" ]; then
		echo "infall-backup: QOOP_$name is read as INFALL_$name, its name since the rename: rename it" >&2
		eval "INFALL_$name=\$old"
	fi
done

DB="${INFALL_DB:-/var/lib/infall/infall.db}"
DIR="${INFALL_BACKUP_DIR:-/var/backups/infall}"
KEEP_DAYS="${INFALL_BACKUP_KEEP_DAYS:-14}"
RECIPIENT="${INFALL_BACKUP_AGE_RECIPIENT:-}"
REMOTE="${INFALL_BACKUP_REMOTE:-}"

die() {
	echo "infall-backup: $*" >&2
	exit 1
}

for tool in sqlite3 gzip age find; do
	command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
if [ -n "$REMOTE" ] && ! command -v rclone >/dev/null 2>&1; then
	die "INFALL_BACKUP_REMOTE is set but rclone is not installed"
fi

case "$RECIPIENT" in
age1*) ;;
*) die "INFALL_BACKUP_AGE_RECIPIENT must be an age public key (starts with age1)" ;;
esac
case "$KEEP_DAYS" in
'' | *[!0-9]*) die "INFALL_BACKUP_KEEP_DAYS must be a whole number" ;;
esac
[ -f "$DB" ] || die "database not found: $DB"
[ -d "$DIR" ] || die "backup directory does not exist: $DIR"

# Temp files live next to the output (same filesystem, private directory).
TMPDIR_PATH="$(mktemp -d "$DIR/.tmp.XXXXXX")"
cleanup() {
	rm -rf "$TMPDIR_PATH"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$TMPDIR_PATH/infall.db"
OUT="$DIR/infall-$STAMP.db.gz.age"

# .backup is SQLite's online backup: safe while the server is running.
sqlite3 "$DB" ".backup '$TMP'"

# Refuse to ship a broken copy.
CHECK="$(sqlite3 "$TMP" 'PRAGMA integrity_check;')"
[ "$CHECK" = "ok" ] || die "integrity check failed on the copy: $CHECK"

gzip -9 "$TMP"
age -r "$RECIPIENT" -o "$TMPDIR_PATH/out.age" "$TMP.gz"
mv "$TMPDIR_PATH/out.age" "$OUT"
echo "infall-backup: wrote $OUT"

# Prune old local copies (only files matching our own naming).
find "$DIR" -maxdepth 1 -type f -name 'infall-*.db.gz.age' -mtime "+$KEEP_DAYS" -delete

if [ -n "$REMOTE" ]; then
	rclone copy "$OUT" "$REMOTE"
	echo "infall-backup: copied to $REMOTE"
fi
