#!/bin/sh
# Creates a local development database with one Admin. Safe to re-run: it does nothing if the database exists.
# The generated password is written to .dev/admin-password (git-ignored), never printed.
set -eu
cd "$(dirname "$0")/.."
mkdir -p .dev
DB=".dev/infall.db"
if [ -f "$DB" ]; then
  echo "dev database already exists at $DB"
  exit 0
fi
umask 077
PW="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
printf '%s' "$PW" > .dev/admin-password
INFALL_DB="$DB" INFALL_ADMIN_PASSWORD="$PW" cargo run -q -p infall-server -- create-admin --email admin@infall.test --name "Dev Admin"
echo "created $DB with admin@infall.test; password is in .dev/admin-password"
