#!/usr/bin/env bash
# Signs the update bundles of one release and writes the updater's feed beside them
# (docs/specs/release.md, section 11): what the release workflows run once the packages are
# in one folder.
#
#   scripts/sign-updates.sh <folder> <feed-version> <base-url> [notes]
#
# <folder> holds the files the package jobs built with the updater (scripts/update-feed.py
# lists them). Each gets a `.sig` beside it, made with Tauri's signer from the private key in
# TAURI_SIGNING_PRIVATE_KEY (the key file's content) and TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
# then <folder>/latest.json is written, with <base-url> as where the files are downloaded
# from. <feed-version> is a version, or a version and a build number (0.9.1+202611281846).
#
# Needs Node.js (npx) and python3. The key is read from the environment only: it is never
# written to a file or printed.
set -euo pipefail

# The signer: Tauri's own command line, at one version.
signer="@tauri-apps/cli@2.12.6"

[ $# -ge 3 ] || { sed -n '2,15p' "$0" >&2; exit 2; }
folder="$1" version="$2" base="$3" notes="${4:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -d "$folder" ] || { echo "sign-updates: no folder $folder" >&2; exit 1; }
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] \
    || { echo "sign-updates: TAURI_SIGNING_PRIVATE_KEY is not set" >&2; exit 1; }

files="${version%%+*}"
signed=0
for file in \
    "$folder/Infall-$files-arm64.app.tar.gz" "$folder/Infall-$files-x64.app.tar.gz" \
    "$folder/Infall-$files-x64-setup.exe" \
    "$folder/infall_${files}_amd64.deb" "$folder/infall_${files}_arm64.deb"; do
    if [ ! -f "$file" ]; then
        echo "sign-updates: no $(basename "$file"); that system gets no update" >&2
        continue
    fi
    rm -f "$file.sig"
    npx --yes "$signer" signer sign "$file" >/dev/null
    [ -s "$file.sig" ] || { echo "sign-updates: $(basename "$file") was not signed" >&2; exit 1; }
    signed=$((signed + 1))
done
[ "$signed" -gt 0 ] || { echo "sign-updates: nothing to sign in $folder" >&2; exit 1; }

if [ -n "$notes" ]; then
    python3 "$root/scripts/update-feed.py" "$folder" "$version" "$base" "$notes" > "$folder/latest.json"
else
    python3 "$root/scripts/update-feed.py" "$folder" "$version" "$base" > "$folder/latest.json"
fi
echo "sign-updates: $signed files signed; $folder/latest.json says $version"
