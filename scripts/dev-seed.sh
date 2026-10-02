#!/bin/sh
# Creates a local development database with one Admin. Safe to re-run: it does nothing if the database exists.
# The generated password is written to .dev/admin-password (git-ignored), never printed.
set -eu
cd "$(dirname "$0")/.."
mkdir -p .dev
DB=".dev/qoop.db"
if [ -f "$DB" ]; then
  echo "dev database already exists at $DB"
  exit 0
fi
umask 077
PW="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
printf '%s' "$PW" > .dev/admin-password
QOOP_DB="$DB" QOOP_ADMIN_PASSWORD="$PW" cargo run -q -p qoop-server -- create-admin --email admin@qoop.test --name "Dev Admin"
echo "created $DB with admin@qoop.test; password is in .dev/admin-password"
