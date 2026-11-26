#!/bin/sh
# Runs infall-server for local development on 127.0.0.1:8787, allowing the Vite dev UI on :5173.
set -eu
cd "$(dirname "$0")/.."
sh scripts/dev-seed.sh
# Optional local settings for development (git-ignored), e.g. INFALL_SECRET_KEY to try the OpenRouter path.
if [ -f .dev/server.env ]; then set -a; . ./.dev/server.env; set +a; fi
INFALL_DB=".dev/infall.db" INFALL_ADDR="127.0.0.1:8787" INFALL_PUBLIC_ORIGIN="http://localhost:8787" \
INFALL_DEV_ORIGIN="http://localhost:5173" INFALL_WEB_DIR="web/dist" exec cargo run -q -p infall-server -- serve
