#!/usr/bin/env python3
"""Writes the updater's feed, latest.json, for one release (docs/specs/release.md, section 11).

    scripts/update-feed.py <folder> <version> <base-url> [notes] > latest.json

<version> is what the feed says: a version (0.9.1), or for a beta build a version and its
build number (0.9.1+202611281846); the files are named after the version alone.

<folder> holds what the package jobs built and signed: each update bundle next to its `.sig`
(made with `tauri signer sign`):

    Infall-<version>-arm64.app.tar.gz   darwin-aarch64
    Infall-<version>-x64.app.tar.gz     darwin-x86_64
    Infall-<version>-x64-setup.exe      windows-x86_64
    infall_<version>_amd64.deb          linux-x86_64-deb
    infall_<version>_arm64.deb          linux-aarch64-deb

<base-url> is where those files will be downloaded from (the release's download address);
each platform's `url` is <base-url>/<file name>. A bundle without its `.sig` is left out, and
the script fails when nothing is left. Standard library only.
"""

import datetime
import json
import os
import sys
import urllib.parse


def platforms_for(name, version):
    table = {
        f"Infall-{version}-arm64.app.tar.gz": ["darwin-aarch64"],
        f"Infall-{version}-x64.app.tar.gz": ["darwin-x86_64"],
        f"Infall-{version}-x64-setup.exe": ["windows-x86_64", "windows-x86_64-nsis"],
        f"infall_{version}_amd64.deb": ["linux-x86_64-deb"],
        f"infall_{version}_arm64.deb": ["linux-aarch64-deb"],
    }
    return table.get(name, [])


def main(argv):
    if len(argv) not in (4, 5):
        sys.exit(__doc__)
    folder, version, base = argv[1], argv[2].lstrip("v"), argv[3].rstrip("/")
    notes = argv[4] if len(argv) == 5 else f"Infall {version}"
    platforms = {}
    for name in sorted(os.listdir(folder)):
        keys = platforms_for(name, version.split("+")[0])
        sig = os.path.join(folder, name + ".sig")
        if not keys:
            continue
        if not os.path.isfile(sig):
            print(f"update-feed: {name} has no .sig; left out", file=sys.stderr)
            continue
        with open(sig, encoding="utf-8") as f:
            signature = f.read().strip()
        url = f"{base}/{urllib.parse.quote(name)}"
        for key in keys:
            platforms[key] = {"signature": signature, "url": url}
    if not platforms:
        sys.exit("update-feed: no signed update bundle was found")
    feed = {
        "version": version,
        "notes": notes,
        "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }
    json.dump(feed, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv)
