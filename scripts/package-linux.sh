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
#   - builds an image with Ubuntu 22.04, Rust and the libraries the app is built against
#     (WebKitGTK 4.1, GTK 3). The image is of this computer's kind; for the other kind of
#     processor it cross-compiles (Ubuntu multiarch), which is much faster than emulating;
#   - copies desktop/ into a container (the checkout is mounted read-only and nothing is
#     written to it) and runs `cargo build --release --locked --features custom-protocol`;
#   - puts the package together by hand with dpkg-deb: /usr/bin/infall, a .desktop entry,
#     the icon in the usual sizes. `Depends` is what dpkg-shlibdeps finds the program
#     linked against. No maintainer scripts;
#   - installs the package with apt in a clean Ubuntu 22.04 and a clean Ubuntu 24.04
#     container of the package's architecture, checks that every shared library resolves,
#     starts the program under a virtual display and checks that it shows its window and
#     stays up. For the other kind of processor these containers are emulated; if this
#     Docker cannot emulate, the checks are skipped and the script says so;
#   - prints the SHA-256.
#
# What it creates in Docker, all named qoop-package-linux…, and nothing else is touched:
#   images      qoop-package-linux:22.04-<arch>   (one per package architecture)
#   volume      qoop-package-linux-cargo          (downloaded crates and build output)
#   containers  qoop-package-linux-build-<arch>, qoop-package-linux-verify-<arch>-<release>
#               (removed when the script ends)
# It pulls ubuntu:22.04 and ubuntu:24.04 if this Docker does not have them and leaves them.
#
# Environment: QOOP_PACKAGE_RUST (Rust version in the image, default 1.96.0),
# QOOP_PACKAGE_MAINTAINER (the control file's Maintainer field).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_src="$root/desktop/src-tauri"
conf="$app_src/tauri.conf.json"
icon_src="$app_src/icons/icon-1024.png"
dist="$root/dist"

prefix="qoop-package-linux"
volume="$prefix-cargo"
base_release="22.04"
verify_releases="22.04 24.04"
rust="${QOOP_PACKAGE_RUST:-1.96.0}"
maintainer="${QOOP_PACKAGE_MAINTAINER:-Infall <nobody@example.invalid>}"
# How long the started program must stay up, in seconds.
stay_up=10

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
            docker rm -f "$prefix-verify-$arch-$release" >/dev/null 2>&1 || true
        done
        docker image rm "$prefix:$base_release-$arch" >/dev/null 2>&1 || true
    done
    docker volume rm "$volume" >/dev/null 2>&1 || true
    say "Removed the $prefix images, containers and volume"
    exit 0
fi

[ -f "$icon_src" ] || die "the icon source $icon_src is missing"

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

triple_of() {
    case "$1" in
        amd64) echo x86_64-unknown-linux-gnu ;;
        arm64) echo aarch64-unknown-linux-gnu ;;
    esac
}

started_at=$SECONDS
containers=()
finish() {
    trap - EXIT
    for c in ${containers[@]+"${containers[@]}"}; do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
}
trap finish EXIT
trap 'exit 130' INT TERM

mkdir -p "$dist"
docker volume create "$volume" >/dev/null

# --- The image: Ubuntu 22.04, Rust, and the libraries of the package's architecture ---------------
# The image is always of this computer's kind. For the other architecture, Ubuntu's multiarch
# gives the libraries to link against and a cross compiler. amd64 packages come from
# archive.ubuntu.com, arm64 packages from ports.ubuntu.com, so every source names its architecture.
build_image() { # <arch>
    local arch="$1"
    say "Image $prefix:$base_release-$arch (Ubuntu $base_release, Rust $rust, libraries for $arch)"
    local log="$dist/.image-$arch.log"
    # Docker keeps the finished steps, so this takes minutes only the first time.
    if ! docker build --platform "linux/$native" \
        --build-arg "TARGET_ARCH=$arch" --build-arg "RUST=$rust" \
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
        -v "$volume":/cargo -v "$root/desktop":/src/desktop:ro \
        -e ARCH="$arch" -e TRIPLE="$triple" -e CRATE="$crate" -e PACKAGE="$package" \
        -e NAME="$name" -e VERSION="$version" -e MAINTAINER="$maintainer" -e DEB="$deb" \
        "$prefix:$base_release-$arch" bash -s <<'BUILD'
set -euo pipefail
export CARGO_HOME=/cargo/home CARGO_TARGET_DIR=/cargo/target CARGO_INCREMENTAL=0
export CARGO_TERM_COLOR=never

# The checkout is read-only here, and the build writes next to the sources (Tauri's generated
# schemas): work on a copy. File times are kept, so cargo rebuilds only what changed.
mkdir -p /build/desktop
tar -C /src/desktop --exclude=./src-tauri/target --exclude=./src-tauri/gen --exclude=.DS_Store -cf - . |
    tar -C /build/desktop -xf -
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
cargo build --release --locked -p "$CRATE" --features custom-protocol --target "$TRIPLE"
built="/cargo/target/$TRIPLE/release/$CRATE"
[ -x "$built" ] || { echo "the build did not produce $built" >&2; exit 1; }

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
cat > "$stage/DEBIAN/control" <<CONTROL
Package: $PACKAGE
Version: $VERSION
Architecture: $ARCH
Maintainer: $MAINTAINER
Installed-Size: $installed_kb
Depends: $depends
Recommends: python3, xdg-utils, procps
Section: misc
Priority: optional
Description: $NAME desktop app
 A thin shell around the web UI of your team's $NAME server. It can run the AI
 sidebar on your own Claude Code and execute Runs with your own Python.
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
    local arch="$1" release="$2" checker deb how
    deb="${package}_${version}_${arch}.deb"
    checker="$prefix-verify-$arch-$release"
    how="natively"
    [ "$arch" = "$native" ] || how="emulated"
    say "Checking $deb in a clean Ubuntu $release ($arch, $how)"
    docker rm -f "$checker" >/dev/null 2>&1 || true
    containers+=("$checker")
    if docker run -i --quiet --name "$checker" --platform "linux/$arch" \
        -v "$dist":/pkg:ro -e DEB="$deb" -e PACKAGE="$package" -e NAME="$name" \
        -e IDENTIFIER="$identifier" -e STAY_UP="$stay_up" \
        "ubuntu:$release" bash -s <<'VERIFY'; then
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
fail() { echo "FAILED: $*" >&2; exit 1; }

# The way a Member installs it, recommended packages included.
apt-get update -qq
apt-get install -y -qq "/pkg/$DEB" >/tmp/apt.log 2>&1 || { tail -n 30 /tmp/apt.log >&2; fail "apt could not install the package"; }
[ "$(dpkg-query -W -f '${Status}' "$PACKAGE")" = "install ok installed" ] || fail "the package is not installed"
echo "    installed with apt: $(dpkg-query -W -f '${Package} ${Version} ${Architecture}' "$PACKAGE")"
[ -x "/usr/bin/$PACKAGE" ] || fail "/usr/bin/$PACKAGE is missing"
[ -f "/usr/share/applications/$PACKAGE.desktop" ] || fail "the .desktop entry is missing"
[ -f "/usr/share/icons/hicolor/256x256/apps/$PACKAGE.png" ] || fail "the icon is missing"
[ -z "$(dpkg-query -W -f '${Conffiles}' "$PACKAGE")" ] || fail "the package has conffiles"
ls /var/lib/dpkg/info/"$PACKAGE".{preinst,postinst,prerm,postrm} >/dev/null 2>&1 && fail "the package has maintainer scripts"

missing="$(ldd "/usr/bin/$PACKAGE" | grep 'not found' || true)"
[ -z "$missing" ] || fail "shared libraries do not resolve: $missing"
echo "    every shared library resolves ($(ldd "/usr/bin/$PACKAGE" | wc -l) of them)"

# Start it as an ordinary person would, on a display that exists only here.
apt-get install -y -qq --no-install-recommends xvfb x11-utils >/tmp/apt-x.log 2>&1 || { tail -n 30 /tmp/apt-x.log >&2; fail "could not install the virtual display"; }
useradd -m member
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for _ in $(seq 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.2; done
[ -e /tmp/.X11-unix/X99 ] || fail "the virtual display did not start"

runuser -u member -- env DISPLAY=:99 HOME=/home/member XDG_RUNTIME_DIR=/tmp "$PACKAGE" >/tmp/app.log 2>&1 &
app=$!
window=""
for _ in $(seq 120); do
    kill -0 "$app" 2>/dev/null || { cat /tmp/app.log >&2; fail "the program ended by itself"; }
    window="$(DISPLAY=:99 xwininfo -root -tree 2>/dev/null | grep -F "(\"$PACKAGE\" " | grep -F "\"$NAME" | head -n 1 || true)"
    [ -n "$window" ] && break
    sleep 1
done
[ -n "$window" ] || { cat /tmp/app.log >&2; fail "the program showed no window within two minutes"; }
echo "    window: $(printf '%s' "$window" | sed 's/^ *//')"
sleep "$STAY_UP"
kill -0 "$app" 2>/dev/null || { cat /tmp/app.log >&2; fail "the program did not stay up for $STAY_UP seconds"; }
pgrep -f WebKitWebProcess >/dev/null || { cat /tmp/app.log >&2; fail "the page's own process (WebKitWebProcess) is not running"; }
grep -qi 'panicked' /tmp/app.log && { cat /tmp/app.log >&2; fail "the program panicked"; }
echo "    started under a virtual display, showed its window, stayed up $STAY_UP s; its page process runs"
[ -d "/home/member/.config/$IDENTIFIER" ] || [ ! -e "/home/member/.config/$IDENTIFIER" ] || true
if [ -s /tmp/app.log ]; then
    echo "    what it printed ($(wc -l < /tmp/app.log) lines), first lines:"
    head -n 5 /tmp/app.log | sed 's/^/      /'
fi
# Quit takes the page process with it.
kill "$app" 2>/dev/null || true
for _ in $(seq 50); do kill -0 "$app" 2>/dev/null || break; sleep 0.1; done
kill -0 "$app" 2>/dev/null && fail "the program did not end when asked to"

# And it goes away again completely.
apt-get remove -y -qq "$PACKAGE" >/dev/null 2>&1 || fail "apt could not remove the package"
[ ! -e "/usr/bin/$PACKAGE" ] && [ ! -e "/usr/share/applications/$PACKAGE.desktop" ] || fail "files were left after removal"
echo "    removed with apt, nothing left in /usr"
VERIFY
        results+=("ok       Ubuntu $release, $arch, $how: installs with apt, libraries resolve, starts and stays up, removes")
    else
        results+=("FAILED   Ubuntu $release, $arch, $how")
        failed=1
    fi
    docker rm -f "$checker" >/dev/null 2>&1 || true
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
