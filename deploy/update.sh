#!/bin/sh
# Bring this Infall Team server up to date: the deploy files, then the image.
# Run it from anywhere; it works in the folder it is in (README.md, "Upgrade").
#
#   ./update.sh              update the deploy files (git pull), back up, pull, restart
#   ./update.sh --no-pull    the same without git pull (a copy of this folder made without git)
#
# What it does, in order:
#   1. git pull --ff-only, when this folder is a git checkout. It stops on local edits to
#      tracked files rather than merging them; .env is not tracked and is never touched.
#   2. A Workspace file now, made by the version that is running (before anything changes).
#   3. docker compose pull: the version .env names (INFALL_VERSION; "latest" is the newest).
#   4. docker compose up -d: only what changed is recreated. Before a different server opens
#      the database, the image itself copies it into /data/pre-upgrade/ first. Then it waits
#      until the server reports healthy.
# Going back to an earlier version: README.md, "Upgrade".
set -eu

main() {
    cd "$(dirname "$0")"
    [ -f .env ] || die "no .env here. Copy .env.example to .env and fill it in first (README.md, \"Steps\")."

    if docker compose version >/dev/null 2>&1; then
        compose() { docker compose "$@"; }
    elif command -v docker-compose >/dev/null 2>&1; then
        compose() { docker-compose "$@"; }
    else
        die "neither \"docker compose\" nor \"docker-compose\" works. Install Docker's Compose plugin."
    fi

    if [ "${1:-}" != "--no-pull" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        say "Getting the newest deploy files (git pull)…"
        before="$(git rev-parse HEAD)"
        git pull --ff-only || die "git pull did not go through (see above). Nothing else was done."
        if [ "$(git rev-parse HEAD)" != "$before" ] \
            && ! git diff --quiet "$before" HEAD -- update.sh; then
            say "update.sh itself changed; running the new one."
            exec ./update.sh --no-pull
        fi
    fi

    if [ -n "$(compose ps -q --status running backup 2>/dev/null)" ]; then
        say "Making a Workspace file with the version that is running now…"
        compose exec -T backup infall backup \
            || die "the backup did not work (see above). Nothing was updated."
    else
        say "The backup service is not running, so no Workspace file now (first start?)."
    fi

    say "Pulling the images .env names…"
    compose pull

    say "Starting what changed…"
    compose up -d

    # Only the server is waited for: the backup service checks itself once an hour.
    say "Waiting for the server to be healthy (up to 3 minutes)…"
    status=starting
    for _ in $(seq 1 36); do
        id="$(compose ps -q server)"
        status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)"
        [ "$status" = healthy ] && break
        [ "$status" = unhealthy ] && break
        sleep 5
    done
    if [ "$status" != healthy ]; then
        compose ps
        compose logs --tail 30 server
        die "the server is $status (log above). To go back: README.md, \"Upgrade\"."
    fi

    compose ps
    version="$(compose exec -T server printenv INFALL_VERSION 2>/dev/null || echo unknown)"
    say "Done. The server runs Infall $version."
}

say() { printf 'update: %s\n' "$*"; }
die() { printf 'update: %s\n' "$*" >&2; exit 1; }

# The whole script is read before main runs, so a git pull that changes this file
# cannot change it under the running shell.
main "$@"
