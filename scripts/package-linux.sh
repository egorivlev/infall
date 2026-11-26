#!/usr/bin/env bash
# Builds dist/infall_<version>_<arch>.deb: the desktop app as something to install on Ubuntu
# (docs/specs/release.md, section 5; desktop/README.md, "The Ubuntu package"), and checks it.
#
#   scripts/package-linux.sh                 the amd64 package (most Ubuntu laptops)
#   scripts/package-linux.sh arm64           the arm64 package
#   scripts/package-linux.sh amd64 arm64     both
#   scripts/package-linux.sh --no-verify …   build only, check nothing
#   scripts/package-linux.sh --clean         remove what this script keeps in Docker
#
# Needs Docker and nothing else: everything happens in containers, so a Mac and a Linux
# machine give the same package. No tauri-cli. Not signed, no repository, no auto-update.
#
# What it does:
#   - builds an image with Ubuntu 22.04, Rust, Node.js and the libraries the app is built
#     against (WebKitGTK 4.1, GTK 3). The image is of this computer's kind; for the other kind
#     of processor it cross-compiles (Ubuntu multiarch), which is much faster than emulating;
#   - copies what the app is built from into a container (the checkout is mounted read-only and
#     nothing is written to it): desktop/, crates/ (the Infall server, which the app compiles
#     into itself), web/ without node_modules and dist, and the root Cargo.toml and Cargo.lock;
#   - builds the web UI there (`npm ci`, `npm run build`; the web UI is the same files for every
#     architecture) and stops unless web/dist/index.html exists: the app embeds web/dist when it
#     is compiled and serves it from its own server for Local Workspaces (docs/specs/local.md);
#   - runs `cargo build --release --locked --features custom-protocol`. The server's C parts
#     (SQLite, and AWS-LC under the TLS library) are compiled by the image's gcc, or by
#     crossbuild-essential's gcc for the other architecture; no cmake or nasm is needed. Then
#     checks that the program holds the web UI that was just built;
#   - puts the package together by hand with dpkg-deb: /usr/bin/infall, a .desktop entry,
#     the icon in the usual sizes. `Depends` is what dpkg-shlibdeps finds the program
#     linked against. No maintainer scripts;
#   - checks the package in a clean Ubuntu 22.04 and a clean Ubuntu 24.04 container of the
#     package's architecture, in two steps:
#       1. with the network: installs it with apt over a stand-in for the package from before
#          the rename (qoop), which apt must remove (`Conflicts`/`Replaces: qoop`), and the
#          virtual display and xdotool the check needs; checks the files and that every shared
#          library resolves;
#       2. from a snapshot of that container, WITH NO NETWORK AT ALL (`--network none`: only the
#          loopback interface exists) and a fresh home folder (no saved server, no Workspaces):
#          starts the program under a virtual display and checks that it shows its window,
#          stays up, and has not panicked. Then it presses keys in the start screen to create a
#          Tutorial Workspace (open_keys, open_tutorial below) and checks that the program now listens
#          on 127.0.0.1 and nowhere else, that /api/health answers there, that
#          /api/local/enter refuses a missing and a wrong key, that the Workspace's database
#          and the unpacked web UI are in the app's data folder, and that a window is still
#          shown. Last, it removes the package.
#     This is what the M11 package lacked: it only asked for a server address.
#     Not checked: what the start screen and the web UI look like, the Tutorial's steps, and
#     everything after the Workspace opened (no click is made in the page).
#     For the other kind of processor these containers are emulated; if this Docker cannot
#     emulate, the checks are skipped and the script says so;
#   - prints the SHA-256.
#
# What it creates in Docker, all named infall-package-linux…, and nothing else is touched:
#   images      infall-package-linux:22.04-<arch>   (one per package architecture)
#               infall-package-linux-verify:<arch>-<release>   (the snapshot of step 1;
#               removed when the script ends)
#   volume      infall-package-linux-cargo          (downloaded crates, npm's cache, build output)
#   containers  infall-package-linux-build-<arch>, infall-package-linux-verify-<arch>-<release>,
#               infall-package-linux-offline-<arch>-<release>   (removed when the script ends)
# It pulls ubuntu:22.04 and ubuntu:24.04 if this Docker does not have them and leaves them.
#
# Environment: INFALL_PACKAGE_RUST (Rust version in the image, default 1.96.0),
# INFALL_PACKAGE_NODE (Node.js version in the image, default 22.23.5),
# INFALL_PACKAGE_MAINTAINER (the control file's Maintainer field),
# INFALL_PACKAGE_CACHE (a folder on this computer to keep downloaded crates, npm's cache and the
# build output in, instead of the volume: what the continuous build caches between runs, and a
# way to keep a few GB out of a Docker machine whose own disk is small. The build runs as root,
# so what it writes there belongs to root on Linux).
#
# The updater (docs/specs/release.md, section 11): when INFALL_UPDATE_PUBKEY (the public key
# from `tauri signer generate`) and INFALL_UPDATE_URL (the address of the feed's latest.json)
# are both set, the app is built with the `updater` feature and checks that feed; otherwise it
# has no updater at all, as before. Signing what is built for the feed is the release
# workflow's step (.github/workflows/package.yml), not this script's.
#   With the updater, the program is marked as installed from a .deb (as Tauri's own bundler
#   marks it), so that the updater installs the next .deb with dpkg instead of treating the
#   program as an AppImage.
set -euo pipefail

# A variable still set under its name from before the rename (QOOP_PACKAGE_RUST for
# INFALL_PACKAGE_RUST) is read when the new one is not set, with one warning.
for name in PACKAGE_RUST PACKAGE_NODE PACKAGE_MAINTAINER PACKAGE_CACHE; do
    new="INFALL_$name" old="QOOP_$name"
    if [ -z "${!new:-}" ] && [ -n "${!old:-}" ]; then
        echo "package-linux: $old is read as $new, its name since the rename: rename it" >&2
        export "$new=${!old}"
    fi
done
unset name new old

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_src="$root/desktop/src-tauri"
conf="$app_src/tauri.conf.json"
icon_src="$app_src/icons/icon-1024.png"
dist="$root/dist"

prefix="infall-package-linux"
volume="$prefix-cargo"
base_release="22.04"
verify_releases="22.04 24.04"
rust="${INFALL_PACKAGE_RUST:-1.96.0}"
node="${INFALL_PACKAGE_NODE:-22.23.5}"
maintainer="${INFALL_PACKAGE_MAINTAINER:-Infall <nobody@example.invalid>}"
# How long the started program must stay up, in seconds.
stay_up=10
# The keys that create a Tutorial Workspace on a fresh start screen, for xdotool (see
# open_tutorial in the check below). With no Workspaces yet, the start screen puts the focus on
# its first tile, Tutorial (desktop/ui/setup.js, focusStart), and Return presses it.
open_keys="Return"

say() { printf '==> %s\n' "$*"; }
die() { printf 'package-linux: %s\n' "$*" >&2; exit 1; }

# --- Arguments --------------------------------------------------------------------------------
archs=()
verify=1
clean=0
for arg in "$@"; do
    case "$arg" in
        amd64 | arm64) archs+=("$arg") ;;
        --no-verify) verify=0 ;;
        --clean) clean=1 ;;
        -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown argument '$arg' (amd64, arm64, --no-verify, --clean)" ;;
    esac
done
[ "${#archs[@]}" -gt 0 ] || archs=(amd64)

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running"

if [ "$clean" = 1 ]; then
    # Only what this script made, each by its own name.
    for arch in amd64 arm64; do
        docker rm -f "$prefix-build-$arch" >/dev/null 2>&1 || true
        for release in $verify_releases; do
            docker rm -f "$prefix-verify-$arch-$release" "$prefix-offline-$arch-$release" >/dev/null 2>&1 || true
            docker image rm "$prefix-verify:$arch-$release" >/dev/null 2>&1 || true
        done
        docker image rm "$prefix:$base_release-$arch" >/dev/null 2>&1 || true
    done
    docker volume rm "$volume" >/dev/null 2>&1 || true
    say "Removed the $prefix images, containers and volume"
    exit 0
fi

[ -f "$icon_src" ] || die "the icon source $icon_src is missing"
[ -f "$root/web/package-lock.json" ] || die "web/package-lock.json is missing"

# --- What is being packaged -------------------------------------------------------------------
# The version is the one in Cargo.toml ([package]); tauri.conf.json must say the same, because
# that is the version the running app reports.
cargo_value() {
    awk -v key="$1" '
        /^\[/ { in_package = ($0 == "[package]") }
        in_package && $0 ~ "^" key "[[:space:]]*=" {
            sub(/^[^=]*=[[:space:]]*"/, "", $0); sub(/".*$/, "", $0); print; exit
        }
    ' "$app_src/Cargo.toml"
}
# A string at the top level of tauri.conf.json (two spaces in, one per line).
conf_value() {
    sed -n 's/^  "'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$conf" | head -n 1
}
version="$(cargo_value version)"
crate="$(cargo_value name)"
name="$(conf_value productName)"
identifier="$(conf_value identifier)"
conf_version="$(conf_value version)"
[ -n "$version" ] || die "no version found in $app_src/Cargo.toml"
[ -n "$crate" ] || die "no package name found in $app_src/Cargo.toml"
[ -n "$name" ] || die "no productName found in $conf"
[ -n "$identifier" ] || die "no identifier found in $conf"
[ "$conf_version" = "$version" ] \
    || die "Cargo.toml says version $version, tauri.conf.json says $conf_version; make them agree"
# The package, the program and the icon are all called by the product's name in lower case.
package="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
case "$package" in
    *[!a-z0-9+.-]* | "" | [!a-z0-9]*) die "'$package' cannot be a Debian package name" ;;
esac
case "$version" in
    [0-9]*) ;;
    *) die "'$version' cannot be a Debian package version" ;;
esac

case "$(docker info --format '{{.Architecture}}')" in
    aarch64 | arm64) native=arm64 ;;
    x86_64 | amd64) native=amd64 ;;
    *) die "this Docker runs on a processor this script does not know" ;;
esac

# A full Docker disk does not say so: apt in the image build reports "At least one invalid
# signature was encountered" for every source instead. So look first. The image takes about
# 3 GB, each check's snapshot about 1 GB; the volume, unless INFALL_PACKAGE_CACHE moves it out,
# grows to about 4 GB per architecture.
need_gb=2
for arch in "${archs[@]}"; do
    docker image inspect "$prefix:$base_release-$arch" >/dev/null 2>&1 || need_gb=$((need_gb + 3))
done
if [ -z "${INFALL_PACKAGE_CACHE:-}" ] && ! docker volume inspect "$volume" >/dev/null 2>&1; then
    need_gb=$((need_gb + 4 * ${#archs[@]}))
fi
free_kb="$(docker run --rm --quiet --platform "linux/$native" "ubuntu:$base_release" df -Pk / 2>/dev/null |
    awk 'NR == 2 { print $4 }')"
if [ -n "$free_kb" ] && [ "$free_kb" -lt $((need_gb * 1024 * 1024)) ]; then
    die "Docker's own disk has $((free_kb / 1024 / 1024)) GB free and this needs about $need_gb GB (docker system df shows what uses it; INFALL_PACKAGE_CACHE keeps the build output outside it)"
fi

triple_of() {
    case "$1" in
        amd64) echo x86_64-unknown-linux-gnu ;;
        arm64) echo aarch64-unknown-linux-gnu ;;
    esac
}

started_at=$SECONDS
containers=()
images=()
finish() {
    trap - EXIT
    for c in ${containers[@]+"${containers[@]}"}; do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
    for i in ${images[@]+"${images[@]}"}; do
        docker image rm "$i" >/dev/null 2>&1 || true
    done
}
trap finish EXIT
trap 'exit 130' INT TERM

mkdir -p "$dist"
# What is mounted at /cargo in the build container: the volume, or the folder named by
# INFALL_PACKAGE_CACHE.
if [ -n "${INFALL_PACKAGE_CACHE:-}" ]; then
    mkdir -p "$INFALL_PACKAGE_CACHE" || die "INFALL_PACKAGE_CACHE: cannot make $INFALL_PACKAGE_CACHE"
    cache="$(cd "$INFALL_PACKAGE_CACHE" && pwd)"
else
    cache="$volume"
    docker volume create "$volume" >/dev/null
fi

# --- The image: Ubuntu 22.04, Rust, and the libraries of the package's architecture ---------------
# The image is always of this computer's kind. For the other architecture, Ubuntu's multiarch
# gives the libraries to link against and a cross compiler. amd64 packages come from
# archive.ubuntu.com, arm64 packages from ports.ubuntu.com, so every source names its architecture.
build_image() { # <arch>
    local arch="$1"
    say "Image $prefix:$base_release-$arch (Ubuntu $base_release, Rust $rust, Node.js $node, libraries for $arch)"
    local log="$dist/.image-$arch.log"
    # Docker keeps the finished steps, so this takes minutes only the first time.
    if ! docker build --platform "linux/$native" \
        --build-arg "TARGET_ARCH=$arch" --build-arg "RUST=$rust" --build-arg "NODE=$node" \
        -t "$prefix:$base_release-$arch" - >"$log" 2>&1 <<'DOCKERFILE'; then
FROM ubuntu:22.04
ARG RUST
ENV DEBIAN_FRONTEND=noninteractive
ENV RUSTUP_HOME=/opt/rustup PATH=/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# What both architectures' images share (Docker keeps this step once): the tools, a compiler
# for the other architecture, and Rust for both.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) other=arm64 ;; \
        arm64) other=amd64 ;; \
    esac; \
    { \
        for suite in jammy jammy-updates jammy-security; do \
            echo "deb [arch=amd64] http://archive.ubuntu.com/ubuntu $suite main universe"; \
            echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports $suite main universe"; \
        done; \
    } > /etc/apt/sources.list; \
    dpkg --add-architecture "$other"; \
    apt-get update -qq; \
    apt-get install -y -qq --no-install-recommends \
        ca-certificates curl build-essential "crossbuild-essential-$other" pkg-config dpkg-dev \
        file imagemagick desktop-file-utils >/dev/null; \
    rm -rf /var/lib/apt/lists/*; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
        CARGO_HOME=/opt/cargo sh -s -- -y -q --profile minimal --default-toolchain "$RUST" \
            --target x86_64-unknown-linux-gnu --target aarch64-unknown-linux-gnu --no-modify-path; \
    rustc --version
# Node.js for the web UI build, of this computer's kind (its output is the same everywhere),
# from nodejs.org, checked against the SHA-256 that nodejs.org publishes next to it.
ARG NODE
ENV PATH=/opt/node/bin:$PATH
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) node_arch=x64 ;; \
        arm64) node_arch=arm64 ;; \
    esac; \
    file="node-v$NODE-linux-$node_arch.tar.gz"; \
    cd /tmp; \
    curl --proto '=https' --tlsv1.2 -sSfO "https://nodejs.org/dist/v$NODE/$file"; \
    curl --proto '=https' --tlsv1.2 -sSfO "https://nodejs.org/dist/v$NODE/SHASUMS256.txt"; \
    grep " $file\$" SHASUMS256.txt | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xzf "$file" -C /opt/node --strip-components=1; \
    rm -f "$file" SHASUMS256.txt; \
    node --version; npm --version
# The libraries the app is built against, of the package's architecture.
ARG TARGET_ARCH
RUN set -eu; \
    apt-get update -qq; \
    apt-get install -y -qq --no-install-recommends \
        "libwebkit2gtk-4.1-dev:$TARGET_ARCH" "libjavascriptcoregtk-4.1-dev:$TARGET_ARCH" \
        "libsoup-3.0-dev:$TARGET_ARCH" "libgtk-3-dev:$TARGET_ARCH" "libdbus-1-dev:$TARGET_ARCH" \
        >/dev/null; \
    rm -rf /var/lib/apt/lists/*
DOCKERFILE
        tail -n 40 "$log" >&2
        rm -f "$log"
        die "the image could not be built"
    fi
    rm -f "$log"
}

# --- Build and assemble, inside the container ----------------------------------------------------
build_package() { # <arch>
    local arch="$1" triple builder deb
    triple="$(triple_of "$arch")"
    builder="$prefix-build-$arch"
    deb="${package}_${version}_${arch}.deb"
    say "Building $deb (release, custom-protocol, $triple$([ "$arch" = "$native" ] || echo ', cross-compiled'))"
    docker rm -f "$builder" >/dev/null 2>&1 || true
    containers+=("$builder")
    docker run -i --quiet --name "$builder" --platform "linux/$native" \
        -v "$cache":/cargo -v "$root":/src:ro \
        -e ARCH="$arch" -e TRIPLE="$triple" -e CRATE="$crate" -e PACKAGE="$package" \
        -e NAME="$name" -e VERSION="$version" -e MAINTAINER="$maintainer" -e DEB="$deb" \
        -e INFALL_UPDATE_PUBKEY -e INFALL_UPDATE_URL \
        "$prefix:$base_release-$arch" bash -s <<'BUILD'
set -euo pipefail
export CARGO_HOME=/cargo/home CARGO_TARGET_DIR=/cargo/target CARGO_INCREMENTAL=0
export CARGO_TERM_COLOR=never

# The checkout is read-only here, and the build writes next to the sources (Tauri's generated
# schemas, the web UI's dist/): work on a copy of what the app is built from, laid out as in the
# checkout. File times are kept, so cargo rebuilds only what changed.
mkdir -p /build
for part in Cargo.toml Cargo.lock crates desktop web; do
    [ -e "/src/$part" ] || { echo "the checkout has no $part" >&2; exit 1; }
done
tar -C /src --exclude=desktop/src-tauri/target --exclude=desktop/src-tauri/gen \
    --exclude=web/node_modules --exclude=web/dist --exclude=.DS_Store \
    -cf - Cargo.toml Cargo.lock crates desktop web |
    tar -C /build -xf -

# --- The web UI ---
# The same files for every architecture. npm's downloads are kept in the volume.
(
    cd /build/web
    rm -rf dist
    npm ci --no-audit --no-fund --loglevel=error --cache /cargo/npm
    npm run build
)
[ -f /build/web/dist/index.html ] || { echo "the web UI build did not produce web/dist/index.html" >&2; exit 1; }
web_marker="$(sed -n 's/.*src="\/\(assets\/[^"]*\.js\)".*/\1/p' /build/web/dist/index.html | head -n 1)"
[ -n "$web_marker" ] || { echo "web/dist/index.html names no script under assets/; this script is out of date" >&2; exit 1; }

cd /build/desktop/src-tauri

if [ "$(dpkg --print-architecture)" != "$ARCH" ]; then
    gnu="$(dpkg-architecture -a "$ARCH" -q DEB_HOST_GNU_TYPE 2>/dev/null)"
    var="$(printf '%s' "$TRIPLE" | tr 'a-z-' 'A-Z_')"
    export "CARGO_TARGET_${var}_LINKER=$gnu-gcc"
    export "CC_$(printf '%s' "$TRIPLE" | tr '-' '_')=$gnu-gcc"
    export "AR_$(printf '%s' "$TRIPLE" | tr '-' '_')=$gnu-ar"
    # Only the package architecture's libraries, never this container's own.
    export PKG_CONFIG_ALLOW_CROSS=1
    export "PKG_CONFIG_LIBDIR_$(printf '%s' "$TRIPLE" | tr '-' '_')=/usr/lib/$gnu/pkgconfig:/usr/share/pkgconfig"
fi

# custom-protocol: the app's own files (desktop/ui) are served from inside the binary.
# No `devtools` feature anywhere, so there is no web inspector (see Cargo.toml).
features="custom-protocol"
updater=0
if [ -n "${INFALL_UPDATE_PUBKEY:-}" ] && [ -n "${INFALL_UPDATE_URL:-}" ]; then
    features="$features,updater"
    updater=1
fi
cargo build --release --locked -p "$CRATE" --features "$features" --target "$TRIPLE"
built="/cargo/target/$TRIPLE/release/$CRATE"
[ -x "$built" ] || { echo "the build did not produce $built" >&2; exit 1; }
if [ "$updater" = 1 ]; then
    # Tauri's bundler marks the program with how it was packaged; this script is that
    # bundler for the .deb. The marker is a string of the same length, so nothing else moves.
    markers="$(LC_ALL=C grep -a -o '__TAURI_BUNDLE_TYPE_VAR_UNK' "$built" | wc -l | tr -d ' ')"
    [ "$markers" = 1 ] \
        || { echo "the program has no single bundle-type marker; this script is out of date" >&2; exit 1; }
    perl -pi -e 's/__TAURI_BUNDLE_TYPE_VAR_UNK/__TAURI_BUNDLE_TYPE_VAR_DEB/' "$built"
    echo "the program is marked as installed from a .deb (for the updater)"
fi
LC_ALL=C grep -qaF "$web_marker" "$built" \
    || { echo "the program does not hold the web UI that was just built (no $web_marker inside it)" >&2; exit 1; }
echo "the program holds the web UI ($web_marker)"

# --- The package's files ---
stage=/build/stage
rm -rf "$stage" /build/out
mkdir -p "$stage/DEBIAN" "$stage/usr/bin" "$stage/usr/share/applications" /build/out
install -m 755 "$built" "$stage/usr/bin/$PACKAGE"

for size in 16 24 32 48 64 128 256 512; do
    dir="$stage/usr/share/icons/hicolor/${size}x${size}/apps"
    mkdir -p "$dir"
    convert icons/icon-1024.png -resize "${size}x${size}" -strip "$dir/$PACKAGE.png"
done

# StartupWMClass: GTK names the window after the program's file name, and that is how a
# desktop finds this entry (and its icon) for the running window.
cat > "$stage/usr/share/applications/$PACKAGE.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$NAME
Comment=The $NAME desktop app
Exec=$PACKAGE
Icon=$PACKAGE
Terminal=false
Categories=Office;
StartupWMClass=$PACKAGE
DESKTOP
desktop-file-validate "$stage/usr/share/applications/$PACKAGE.desktop"

# --- Depends: exactly the shared libraries the program links ---
mkdir -p /build/shlibs/debian
: > /build/shlibs/debian/control
depends="$(
    cd /build/shlibs
    eval "$(dpkg-architecture -a "$ARCH" -s 2>/dev/null)"
    export DEB_HOST_ARCH DEB_HOST_MULTIARCH DEB_HOST_GNU_TYPE
    dpkg-shlibdeps -O -e "$stage/usr/bin/$PACKAGE" 2>/build/shlibs/warnings | sed -n 's/^shlibs:Depends=//p'
)"
case "$depends" in
    *libwebkit2gtk-4.1-0*libgtk-3-0* | *libgtk-3-0*libwebkit2gtk-4.1-0*) ;;
    *)
        cat /build/shlibs/warnings >&2
        echo "dpkg-shlibdeps did not find WebKitGTK 4.1 and GTK 3 among: $depends" >&2
        exit 1
        ;;
esac

find "$stage" -type d -exec chmod 755 {} +
find "$stage/usr/share" -type f -exec chmod 644 {} +
installed_kb="$(du -sk "$stage/usr" | cut -f1)"
# Python is a Recommends: Infall works without it and only Runs need it. xdg-utils opens
# links in the system browser; procps is the `ps` the Runner monitor reads.
# Until 0.9.0 the package was called qoop (/usr/bin/qoop, qoop.desktop): this one takes its
# place, so that apt removes the old one instead of leaving two apps, of which the old one
# would start again under the old identifier (docs/specs/desktop.md, "Names before the rename").
cat > "$stage/DEBIAN/control" <<CONTROL
Package: $PACKAGE
Version: $VERSION
Architecture: $ARCH
Maintainer: $MAINTAINER
Installed-Size: $installed_kb
Depends: $depends
Recommends: python3, xdg-utils, procps
Conflicts: qoop
Replaces: qoop
Section: misc
Priority: optional
Description: $NAME desktop app
 Workspaces on this computer, with no server needed, or a Team Workspace on
 your team's $NAME server. It can run the AI sidebar on your own Claude Code
 and execute Runs with your own Python.
CONTROL

# xz: every dpkg reads it (Ubuntu's own default, zstd, is not understood by Debian 11).
# Every time stamp in the package is the program's own, so building the same program again
# gives the same file, byte for byte.
SOURCE_DATE_EPOCH="$(stat -c %Y "$built")"
export SOURCE_DATE_EPOCH
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --root-owner-group -Zxz --build "$stage" "/build/out/$DEB" >/dev/null
echo "Depends: $depends"
dpkg-deb --contents "/build/out/$DEB" | awk '$1 !~ /^d/ { print "    " $1, $3, $6 }'
BUILD
    rm -f "$dist/$deb"
    docker cp "$builder:/build/out/$deb" "$dist/$deb" >/dev/null
    docker rm -f "$builder" >/dev/null
    [ -s "$dist/$deb" ] || die "the build did not produce $dist/$deb"
}

# --- Check the package in a clean Ubuntu ---------------------------------------------------------
results=()
can_run() { # <arch>: can this Docker run containers of that architecture?
    local machine
    machine="$(triple_of "$1")"
    [ "$(docker run --rm --quiet --platform "linux/$1" "ubuntu:$base_release" uname -m 2>/dev/null)" = \
        "${machine%%-*}" ]
}

verify_package() { # <arch> <release>
    local arch="$1" release="$2" checker offline snapshot deb how
    deb="${package}_${version}_${arch}.deb"
    checker="$prefix-verify-$arch-$release"
    offline="$prefix-offline-$arch-$release"
    snapshot="$prefix-verify:$arch-$release"
    how="natively"
    [ "$arch" = "$native" ] || how="emulated"
    say "Checking $deb in a clean Ubuntu $release ($arch, $how)"
    docker rm -f "$checker" "$offline" >/dev/null 2>&1 || true
    containers+=("$checker" "$offline")
    images+=("$snapshot")

    # Step 1, with the network: install it the way a Member does, and what the check needs.
    if ! docker run -i --quiet --name "$checker" --platform "linux/$arch" \
        -v "$dist":/pkg:ro -e DEB="$deb" -e PACKAGE="$package" \
        "ubuntu:$release" bash -s <<'INSTALL'; then
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
fail() { echo "FAILED: $*" >&2; exit 1; }

# A name lookup that fails now and then (seen in M16 with a Docker machine on a Mac on
# battery) should not fail the check: apt tries each download again.
echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries
# Without the archive's lists apt says only "held broken packages", which is about the network,
# not the package: say so.
apt-get update -qq --error-on=any || fail "apt could not read Ubuntu's archive (the network, not the package)"
# A package from before the rename is installed (a stand-in with the old name and program):
# installing this one must remove it.
mkdir -p /tmp/old/DEBIAN /tmp/old/usr/bin
printf '#!/bin/sh\n' > /tmp/old/usr/bin/qoop
chmod 755 /tmp/old/usr/bin/qoop
printf 'Package: qoop\nVersion: 0.8.0\nArchitecture: all\nMaintainer: nobody <nobody@example.invalid>\nDescription: stand-in for the package before the rename\n' > /tmp/old/DEBIAN/control
dpkg-deb --root-owner-group --build /tmp/old /tmp/qoop.deb >/dev/null && dpkg -i /tmp/qoop.deb >/dev/null \
    || fail "could not install the stand-in for the old qoop package"
# The way a Member installs it, recommended packages included.
apt-get install -y -qq "/pkg/$DEB" >/tmp/apt.log 2>&1 || { tail -n 30 /tmp/apt.log >&2; fail "apt could not install the package"; }
[ "$(dpkg-query -W -f '${Status}' "$PACKAGE")" = "install ok installed" ] || fail "the package is not installed"
echo "    installed with apt: $(dpkg-query -W -f '${Package} ${Version} ${Architecture}' "$PACKAGE")"
if [ "$PACKAGE" != qoop ]; then
    dpkg-query -W -f '${Status}' qoop 2>/dev/null | grep -q "ok installed" && fail "the old qoop package is still installed beside it"
    [ ! -e /usr/bin/qoop ] || fail "/usr/bin/qoop of the old package is still there"
    echo "    it replaced the package from before the rename (qoop): removed by apt"
fi
[ -x "/usr/bin/$PACKAGE" ] || fail "/usr/bin/$PACKAGE is missing"
[ -f "/usr/share/applications/$PACKAGE.desktop" ] || fail "the .desktop entry is missing"
[ -f "/usr/share/icons/hicolor/256x256/apps/$PACKAGE.png" ] || fail "the icon is missing"
[ -z "$(dpkg-query -W -f '${Conffiles}' "$PACKAGE")" ] || fail "the package has conffiles"
ls /var/lib/dpkg/info/"$PACKAGE".{preinst,postinst,prerm,postrm} >/dev/null 2>&1 && fail "the package has maintainer scripts"

missing="$(ldd "/usr/bin/$PACKAGE" | grep 'not found' || true)"
[ -z "$missing" ] || fail "shared libraries do not resolve: $missing"
echo "    every shared library resolves ($(ldd "/usr/bin/$PACKAGE" | wc -l) of them)"

# For step 2: a display that exists only here, a way to press keys in it, an ordinary user.
apt-get install -y -qq --no-install-recommends xvfb x11-utils xdotool >/tmp/apt-x.log 2>&1 || { tail -n 30 /tmp/apt-x.log >&2; fail "could not install the virtual display"; }
useradd -m member
# The snapshot of this container should not carry apt's downloads.
apt-get clean
rm -rf /var/lib/apt/lists/*
INSTALL
        results+=("FAILED   Ubuntu $release, $arch, $how: installing")
        failed=1
        docker rm -f "$checker" >/dev/null 2>&1 || true
        return
    fi
    docker commit "$checker" "$snapshot" >/dev/null
    docker rm -f "$checker" >/dev/null

    # Step 2, with no network at all: start it with nothing configured and open a Local Workspace.
    if docker run -i --quiet --name "$offline" --platform "linux/$arch" --network none \
        -e PACKAGE="$package" -e NAME="$name" -e IDENTIFIER="$identifier" -e STAY_UP="$stay_up" \
        -e OPEN_KEYS="$open_keys" "$snapshot" bash -s <<'OFFLINE'; then
set -euo pipefail
fail() { echo "FAILED: $*" >&2; exit 1; }
show_log() { [ -s /tmp/app.log ] && tail -n 40 /tmp/app.log >&2; return 0; }

nets="$(ls /sys/class/net | tr '\n' ' ')"
[ "$nets" = "lo " ] || fail "this container was meant to have no network, but has: $nets"
echo "    no network: the only interface is lo"
home=/home/member
[ -z "$(ls -A "$home/.config" "$home/.local" 2>/dev/null)" ] || fail "the home folder is not fresh"

# Start it as an ordinary person would, on a display that exists only here.
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for _ in $(seq 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.2; done
[ -e /tmp/.X11-unix/X99 ] || fail "the virtual display did not start"
export DISPLAY=:99

runuser -u member -- env DISPLAY=:99 HOME="$home" XDG_RUNTIME_DIR=/tmp "$PACKAGE" >/tmp/app.log 2>&1 &
launcher=$!
# The program's windows: GTK names the window class after the program's file name.
windows() { xwininfo -root -tree 2>/dev/null | grep -F "(\"$PACKAGE\" " | grep -F "\"$NAME" || true; }
window=""
for _ in $(seq 120); do
    kill -0 "$launcher" 2>/dev/null || { show_log; fail "the program ended by itself"; }
    window="$(windows | head -n 1)"
    [ -n "$window" ] && break
    sleep 1
done
[ -n "$window" ] || { show_log; fail "the program showed no window within two minutes"; }
start_id="$(printf '%s' "$window" | awk '{ print $1 }')"
echo "    window: $(printf '%s' "$window" | sed 's/^ *//')"
sleep "$STAY_UP"
kill -0 "$launcher" 2>/dev/null || { show_log; fail "the program did not stay up for $STAY_UP seconds"; }
pgrep -f WebKitWebProcess >/dev/null || { show_log; fail "the page's own process (WebKitWebProcess) is not running"; }
grep -qi 'panicked' /tmp/app.log && { show_log; fail "the program panicked"; }
app="$(pgrep -u member -x "$PACKAGE" | head -n 1)"
[ -n "$app" ] || fail "no process named $PACKAGE runs as member"
echo "    started with no network and a fresh home, showed its window, stayed up $STAY_UP s; its page process runs"

# The program's listening TCP sockets, as "address:port" in the kernel's hexadecimal notation.
# Its open files are read as member, its owner: root in a container lacks CAP_SYS_PTRACE and
# may not read another user's /proc/<pid>/fd (until M16 this found nothing, and the check
# failed with "no Workspace server started" although the Workspace had opened).
listening() {
    local inodes
    inodes=" $(runuser -u member -- find "/proc/$app/fd" -lname 'socket:*' -printf '%l\n' 2>/dev/null | tr -dc '0-9\n' | tr '\n' ' ') "
    awk 'FNR > 1 && $4 == "0A" { print $2, $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null |
        while read -r address inode; do
            case "$inodes" in *" $inode "*) echo "$address" ;; esac
        done
}
[ -z "$(listening)" ] || fail "the program listens before any Workspace is open: $(listening)"

# open_tutorial: create a Tutorial Workspace on the start screen. Nothing can click in the page
# from here, so this presses keys the way a person using only the keyboard would ($OPEN_KEYS,
# set at the top of the script).
xdotool windowfocus --sync "$start_id" 2>/dev/null || xdotool windowfocus "$start_id"
sleep 1
# shellcheck disable=SC2086
xdotool key --clearmodifiers $OPEN_KEYS

# The embedded server: one listening socket, on 127.0.0.1.
port=""
for _ in $(seq 90); do
    kill -0 "$launcher" 2>/dev/null || { show_log; fail "the program ended after the start screen was used"; }
    sockets="$(listening)"
    if [ -n "$sockets" ]; then
        for s in $sockets; do
            case "$s" in
                0100007F:*) port="$((16#${s#*:}))" ;;
                *) fail "the program listens on something else than 127.0.0.1: $s" ;;
            esac
        done
        [ -n "$port" ] && break
    fi
    sleep 1
done
[ -n "$port" ] || { show_log; fail "no Workspace server started within 90 seconds of pressing $OPEN_KEYS on the start screen"; }
echo "    created a Tutorial Workspace from the start screen; its server listens on 127.0.0.1:$port only"

# A request over loopback with nothing but bash: the status line and the body.
get() { # <path>
    exec 3<>"/dev/tcp/127.0.0.1/$port"
    printf 'GET %s HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nConnection: close\r\n\r\n' "$1" "$port" >&3
    timeout 10 cat <&3 || true
    exec 3<&-
}
health="$(get /api/health)"
case "$health" in
    "HTTP/1.1 200"*'"ok":true'*) echo "    /api/health answers {\"ok\":true}" ;;
    *) fail "/api/health did not answer as expected: $(printf '%s' "$health" | head -c 300)" ;;
esac
for path in /api/local/enter "/api/local/enter?key=0000000000000000000000000000000000000000000000000000000000000000"; do
    case "$(get "$path" | head -n 1)" in
        "HTTP/1.1 404"*) ;;
        *) fail "$path did not answer 404: nothing may sign in without the key" ;;
    esac
done
echo "    /api/local/enter refuses a missing and a wrong key (404)"

# One directory per Local Workspace in the app's data folder, its database in it
# (desktop/src-tauri/src/workspaces.rs), and the unpacked web UI beside them (src/webui.rs).
data="$home/.local/share/$IDENTIFIER"
db="$(find "$data/workspaces" -name workspace.sqlite -size +0 2>/dev/null | head -n 1)"
[ -n "$db" ] || fail "no Workspace database in $data/workspaces"
[ -f "$data/web/index.html" ] || fail "the web UI was not unpacked to $data/web"
echo "    the Workspace's database is ${db#"$home"/}; the web UI was unpacked to ${data#"$home"/}/web"
sleep 3
kill -0 "$launcher" 2>/dev/null || { show_log; fail "the program ended after opening the Workspace"; }
[ -n "$(windows)" ] || { show_log; fail "after the Workspace opened, the program shows no window"; }
grep -qi 'panicked' /tmp/app.log && { show_log; fail "the program panicked"; }
echo "    a window is shown, still no panic"
if [ -s /tmp/app.log ]; then
    echo "    what it printed ($(wc -l < /tmp/app.log) lines), first lines:"
    head -n 5 /tmp/app.log | sed 's/^/      /'
fi

# Quit takes the page process and the Workspace's server with it.
kill "$launcher" 2>/dev/null || true
for _ in $(seq 50); do kill -0 "$launcher" 2>/dev/null || break; sleep 0.1; done
kill -0 "$launcher" 2>/dev/null && fail "the program did not end when asked to"

# And it goes away again completely (apt needs no network to remove).
apt-get remove -y -qq "$PACKAGE" >/dev/null 2>&1 || fail "apt could not remove the package"
[ ! -e "/usr/bin/$PACKAGE" ] && [ ! -e "/usr/share/applications/$PACKAGE.desktop" ] || fail "files were left after removal"
echo "    removed with apt, nothing left in /usr"
OFFLINE
        results+=("ok       Ubuntu $release, $arch, $how: installs with apt, libraries resolve; with no network starts, stays up, opens a Tutorial Workspace on 127.0.0.1; removes")
    else
        results+=("FAILED   Ubuntu $release, $arch, $how")
        failed=1
    fi
    docker rm -f "$offline" >/dev/null 2>&1 || true
    docker image rm "$snapshot" >/dev/null 2>&1 || true
}

# --- Run ------------------------------------------------------------------------------------------
say "$name $version ($identifier) for Ubuntu: ${archs[*]}; this Docker is $native"
failed=0
debs=()
for arch in "${archs[@]}"; do
    build_image "$arch"
    build_package "$arch"
    debs+=("${package}_${version}_${arch}.deb")
    if [ "$verify" = 0 ]; then
        results+=("SKIPPED  $arch: every check (--no-verify)")
    elif can_run "$arch"; then
        for release in $verify_releases; do
            verify_package "$arch" "$release"
        done
    else
        results+=("SKIPPED  $arch: installing with apt, the shared libraries, starting under a virtual display, on Ubuntu $verify_releases: this Docker cannot run $arch containers (no emulation)")
    fi
done

echo
say "Checks"
for line in "${results[@]}"; do printf '    %s\n' "$line"; done
echo
for deb in "${debs[@]}"; do
    say "Done: $dist/$deb ($(du -h "$dist/$deb" | cut -f1 | tr -d ' '))"
    if command -v sha256sum >/dev/null 2>&1; then
        sum="$(sha256sum "$dist/$deb" | cut -d' ' -f1)"
    else
        sum="$(shasum -a 256 "$dist/$deb" | cut -d' ' -f1)"
    fi
    printf 'SHA-256  %s  %s\n' "$sum" "$deb"
done
say "Took $(((SECONDS - started_at) / 60)) min $(((SECONDS - started_at) % 60)) s"
[ "$failed" = 0 ] || die "a check failed: do not hand this package out"
