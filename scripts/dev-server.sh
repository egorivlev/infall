#!/bin/sh
# Runs qoop-server for local development on 127.0.0.1:8787, allowing the Vite dev UI on :5173.
set -eu
cd "$(dirname "$0")/.."
sh scripts/dev-seed.sh
# Optional local settings for development (git-ignored), e.g. QOOP_SECRET_KEY to try the OpenRouter path.
if [ -f .dev/server.env ]; then set -a; . ./.dev/server.env; set +a; fi
QOOP_DB=".dev/qoop.db" QOOP_ADDR="127.0.0.1:8787" QOOP_PUBLIC_ORIGIN="http://localhost:8787" \
QOOP_DEV_ORIGIN="http://localhost:5173" QOOP_WEB_DIR="web/dist" exec cargo run -q -p qoop-server -- serve
