#!/bin/sh
# Infall daily backup: a Workspace file made by the server's own `export-workspace` (a
# consistent snapshot, safe while the server runs, PDFs included) -> integrity check -> gzip
# -> age encryption -> dated local file -> prune old -> optional rclone copy off the machine.
# With INFALL_BACKUP_DATABASE=yes, also an encrypted copy of the whole database (sign-ins and
# all) the same way. Configuration comes from the environment (see infall.env.example).
set -eu
umask 077

# A variable still set under its name from before the rename (QOOP_DB for INFALL_DB) is
# read when the new one is not set, with one warning (docs/specs/api.md, "Names before the
# rename").
for name in DB BACKUP_DIR BACKUP_KEEP_DAYS BACKUP_AGE_RECIPIENT BACKUP_REMOTE BACKUP_DATABASE SERVER_BIN; do
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
DATABASE="${INFALL_BACKUP_DATABASE:-no}"
SERVER_BIN="${INFALL_SERVER_BIN:-/opt/infall/infall-server}"
# export-workspace reads the database from INFALL_DB.
INFALL_DB="$DB"
export INFALL_DB

die() {
	echo "infall-backup: $*" >&2
	exit 1
}

for tool in sqlite3 gzip age find; do
	command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
[ -x "$SERVER_BIN" ] || die "the server program is not at $SERVER_BIN (set INFALL_SERVER_BIN)"
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
case "$DATABASE" in
yes | no) ;;
*) die "INFALL_BACKUP_DATABASE must be yes or no" ;;
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

# Refuses to ship a broken copy: $1 must pass SQLite's integrity check.
check_copy() { # <file> <what>
	CHECK="$(sqlite3 "$1" 'PRAGMA integrity_check;' 2>&1)" || CHECK="not a database"
	[ "$CHECK" = "ok" ] || die "integrity check failed on the $2: $CHECK; nothing was written"
}

# gzip, encrypt to the recipient, and put it in place as $2; echoes the result.
seal() { # <file> <out>
	gzip -9 "$1"
	age -r "$RECIPIENT" -o "$TMPDIR_PATH/out.age" "$1.gz"
	rm -f "$1.gz"
	mv "$TMPDIR_PATH/out.age" "$2"
	echo "infall-backup: wrote $2"
}

# The Workspace file: every Branch, the history, To-dos, Comments and the PDFs, the Members
# as names only, nothing secret. Goes back with `import-workspace` onto an empty server.
FILE="$TMPDIR_PATH/infall.infall"
"$SERVER_BIN" export-workspace "$FILE" >/dev/null ||
	die "infall-server export-workspace failed; nothing was written"
check_copy "$FILE" "Workspace file"
OUT="$DIR/infall-$STAMP.infall.gz.age"
seal "$FILE" "$OUT"
WROTE="$OUT"

# The whole database, if asked for: this server as it was, sign-ins and sealed AI keys
# included. .backup is SQLite's online backup: safe while the server is running.
if [ "$DATABASE" = yes ]; then
	COPY="$TMPDIR_PATH/infall.db"
	sqlite3 "$DB" ".backup '$COPY'"
	check_copy "$COPY" "database copy"
	DB_OUT="$DIR/infall-$STAMP.db.gz.age"
	seal "$COPY" "$DB_OUT"
	WROTE="$WROTE $DB_OUT"
fi

# Prune old local copies (only files matching our own naming): Workspace files, database
# copies, and the database copies this script made before it made Workspace files.
find "$DIR" -maxdepth 1 -type f \( -name 'infall-*.infall.gz.age' -o -name 'infall-*.db.gz.age' \) \
	-mtime "+$KEEP_DAYS" -delete

if [ -n "$REMOTE" ]; then
	for f in $WROTE; do
		rclone copy "$f" "$REMOTE"
		echo "infall-backup: copied $(basename "$f") to $REMOTE"
	done
fi
