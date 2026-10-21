#!/bin/bash
# Builds dist/Infall-<version>.dmg: the desktop app as something to install on macOS
# (docs/specs/release.md, section 1; desktop/README.md, "The macOS package"), and checks it.
#
#   scripts/package-macos.sh               build, then the start check below
#   scripts/package-macos.sh --no-verify   build only, check nothing
#
# Uses what macOS and Rust bring (cargo, sips, iconutil, plutil, codesign, hdiutil, shasum) and
# Node.js with npm for the web UI. No tauri-cli. The app is signed ad hoc: no Developer ID, no
# notarisation. The package is for the kind of Mac it is built on (Apple silicon or Intel).
#
# What it does:
#   - builds the web UI: `npm ci` and `npm run build` in web/, which replace web/node_modules
#     and web/dist in this checkout. The app embeds web/dist when it is compiled (it serves it
#     from its own server for Local Workspaces, docs/specs/local.md), so the script stops if
#     web/dist/index.html is not there afterwards;
#   - `cargo build --release --locked --features custom-protocol` in desktop/src-tauri. That
#     compiles the Infall server (crates/server) into the app; its C parts (SQLite, and AWS-LC,
#     the cryptography under the TLS library) are compiled with the Command Line Tools' clang;
#     nothing else is needed for them (no cmake, no nasm);
#   - checks that the program holds the web UI it was built with (the name of web/dist's
#     hashed script must be inside it);
#   - puts Infall.app together, signs it ad hoc, makes the disk image, prints the SHA-256.
#
# The start check (skipped with --no-verify). It proves what the M11 packages did not have: that
# the app starts on a computer with no server and no network.
#   Checked: the signed program in Infall.app, started with a fresh, empty home folder (so no
#   saved server and no Workspaces), under `sandbox-exec` with a profile that refuses every
#   outgoing network connection except to this computer (127.0.0.1/::1), shows a window at
#   least as large as the start screen's minimum (720 x 560; the old address screen was
#   smaller), is still running ten seconds later, and has not panicked. The window is looked
#   for among all the program's windows, on any Space, so a full-screen app in front does not
#   make the check fail.
#   Not checked: anything on the start screen itself. Nothing here can press its buttons (that
#   needs the Accessibility permission, which a script must not ask for), so creating or opening
#   a Workspace, the embedded server and the hands-on Tutorial are not exercised. The Rust tests
#   (crates/server, desktop/src-tauri) cover the embedded server; scripts/package-linux.sh opens
#   a Tutorial Workspace in its own check. `sandbox-exec` is deprecated by Apple but works on
#   macOS 26; WebKit's own helper processes are started by launchd and are not under the profile.
#   The window appears on this Mac's screen for those seconds.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_src="$root/desktop/src-tauri"
web="$root/web"
conf="$app_src/tauri.conf.json"
icon_src="$app_src/icons/icon-1024.png"
dist="$root/dist"
# How long the started program must stay up, in seconds.
stay_up=10

say() { printf '==> %s\n' "$*"; }
die() { printf 'package-macos: %s\n' "$*" >&2; exit 1; }

verify=1
for arg in "$@"; do
    case "$arg" in
        --no-verify) verify=0 ;;
        -h | --help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown argument '$arg' (--no-verify)" ;;
    esac
done

[ "$(uname -s)" = "Darwin" ] || die "this script only runs on macOS"
for tool in cargo sips iconutil plutil codesign hdiutil shasum xattr; do
    command -v "$tool" >/dev/null || die "'$tool' was not found"
done
{ command -v node && command -v npm; } >/dev/null \
    || die "Node.js and npm were not found; the web UI needs Node.js 22 (20.19 or newer also works): https://nodejs.org"
if [ "$verify" = 1 ]; then
    command -v sandbox-exec >/dev/null || die "'sandbox-exec' was not found (the start check needs it; --no-verify skips the check)"
fi
[ -f "$icon_src" ] || die "the icon source $icon_src is missing"

# Vite 8 needs Node.js ^20.19 or >= 22.12.
node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_minor="${node_version#*.}"
node_minor="${node_minor%%.*}"
case "$node_major" in
    20) [ "$node_minor" -ge 19 ] ;;
    22) [ "$node_minor" -ge 12 ] ;;
    *) [ "$node_major" -gt 22 ] ;;
esac || die "Node.js $node_version is too old for the web UI build; it needs 22.12 or newer (or 20.19 or newer)"

# --- What is being packaged -------------------------------------------------------------------
# The version is the one in Cargo.toml ([package]); tauri.conf.json must say the same, because
# that is the version the running app reports.
version="$(awk '
    /^\[/ { in_package = ($0 == "[package]") }
    in_package && /^version[[:space:]]*=/ { gsub(/[" ]/, "", $0); sub(/^version=/, "", $0); print; exit }
' "$app_src/Cargo.toml")"
[ -n "$version" ] || die "no version found in $app_src/Cargo.toml"
binary="$(awk '
    /^\[/ { in_package = ($0 == "[package]") }
    in_package && /^name[[:space:]]*=/ { gsub(/[" ]/, "", $0); sub(/^name=/, "", $0); print; exit }
' "$app_src/Cargo.toml")"
[ -n "$binary" ] || die "no package name found in $app_src/Cargo.toml"

conf_value() { plutil -extract "$1" raw -o - "$conf"; }
name="$(conf_value productName)"
identifier="$(conf_value identifier)"
min_macos="$(conf_value bundle.macOS.minimumSystemVersion)"
conf_version="$(conf_value version)"
[ "$conf_version" = "$version" ] \
    || die "Cargo.toml says version $version, tauri.conf.json says $conf_version; make them agree"

arch="$(uname -m)"
dmg="$dist/$name-$version.dmg"
say "$name $version ($identifier), macOS $min_macos or newer, $arch"

mkdir -p "$dist"
stage="$(mktemp -d "$dist/.stage.XXXXXX")"
app_pid=""
finish() {
    if [ -n "$app_pid" ]; then kill "$app_pid" 2>/dev/null || true; fi
    rm -rf "$stage"
}
trap finish EXIT

# --- The web UI -------------------------------------------------------------------------------
# Built from web/package-lock.json exactly (npm ci). Whatever was in web/dist before is removed
# first, so an old build can never pass for this one.
say "Building the web UI (Node.js $node_version, npm ci, npm run build)"
rm -rf "$web/dist"
(
    cd "$web"
    npm ci --no-audit --no-fund --loglevel=error
    npm run build
)
[ -f "$web/dist/index.html" ] || die "the web UI build did not produce web/dist/index.html"
# The hashed name of the page's script: it must end up inside the program.
web_marker="$(sed -n 's/.*src="\/\(assets\/[^"]*\.js\)".*/\1/p' "$web/dist/index.html" | head -n 1)"
[ -n "$web_marker" ] || die "web/dist/index.html names no script under assets/; this script is out of date"

# --- Build ------------------------------------------------------------------------------------
# custom-protocol: the app's own files (desktop/ui) are served from inside the binary.
# No `devtools` feature anywhere, so there is no web inspector (see Cargo.toml).
say "Building (release, custom-protocol)"
(
    cd "$app_src"
    CARGO_INCREMENTAL=0 MACOSX_DEPLOYMENT_TARGET="$min_macos" \
        cargo build --release --locked -p "$binary" --features custom-protocol
)
built="$app_src/target/release/$binary"
[ -x "$built" ] || die "the build did not produce $built"
LC_ALL=C grep -qaF "$web_marker" "$built" \
    || die "the program does not hold the web UI that was just built (no $web_marker inside it)"
echo "    the program holds the web UI ($web_marker)"

# --- Assemble Infall.app ------------------------------------------------------------------------
app="$stage/dmg/$name.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$built" "$app/Contents/MacOS/$binary"
chmod 755 "$app/Contents/MacOS/$binary"

say "Making the icon"
iconset="$stage/$name.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
    double=$((size * 2))
    sips -z "$size" "$size" "$icon_src" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    sips -z "$double" "$double" "$icon_src" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil --convert icns --output "$app/Contents/Resources/$name.icns" "$iconset"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>$name</string>
    <key>CFBundleExecutable</key>
    <string>$binary</string>
    <key>CFBundleIconFile</key>
    <string>$name</string>
    <key>CFBundleIdentifier</key>
    <string>$identifier</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>$name</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$version</string>
    <key>CFBundleVersion</key>
    <string>$version</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.productivity</string>
    <key>LSMinimumSystemVersion</key>
    <string>$min_macos</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST
plutil -lint "$app/Contents/Info.plist" >/dev/null || die "the Info.plist is not valid"
printf 'APPL????' > "$app/Contents/PkgInfo"

# --- Sign (ad hoc) ----------------------------------------------------------------------------
# Apple silicon starts no program without a signature; an ad hoc one ("-") is enough for that
# and says nothing about who made the app. No entitlements: the app uses none.
say "Signing ad hoc"
xattr -cr "$app"
codesign --force --sign - --identifier "$identifier" --timestamp=none "$app"
codesign --verify --deep --strict "$app" || die "the signature does not verify"

# --- The start check: no server, no network ----------------------------------------------------
start_check() {
    say "Start check: a fresh home folder, no network but this computer's own"
    local home="$stage/home" log="$stage/app.log" profile="$stage/offline.sb" windows="" size=""
    mkdir -p "$home"
    # Everything allowed except outgoing connections; to this computer they are allowed, because
    # the app's own server listens on 127.0.0.1 and the page talks to it.
    cat > "$profile" <<'SB'
(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
SB
    # Which windows the program has, without the Screen Recording permission (sizes only).
    # Every window of the program at layer 0 (ordinary windows), not only those on the visible
    # Space: with a full-screen app in front, the new window opens on another Space, and a list
    # of on-screen windows would not have it (until M13 the check failed then). The price: a
    # window counts once it exists at that size, whether or not it is drawn yet.
    if command -v swiftc >/dev/null; then
        cat > "$stage/windows.swift" <<'SWIFT'
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
    if let b = w[kCGWindowBounds as String] as? [String: Any] { print("\(b["Width"] ?? 0) \(b["Height"] ?? 0)") }
}
SWIFT
        swiftc -O "$stage/windows.swift" -o "$stage/windows" 2>/dev/null && windows="$stage/windows"
    fi

    HOME="$home" TMPDIR="$stage/" sandbox-exec -f "$profile" "$app/Contents/MacOS/$binary" >"$log" 2>&1 &
    app_pid=$!
    if [ -n "$windows" ]; then
        for _ in $(seq 60); do
            kill -0 "$app_pid" 2>/dev/null || { cat "$log" >&2; die "start check: the program ended by itself"; }
            # Any window of the program that is big enough, as "width height". (The widest one
            # will not do: the program also owns full-width strips a few points high.)
            size="$("$windows" "$app_pid" | awk '$1 >= 720 && $2 >= 560 { print int($1), int($2); exit }')"
            if [ -n "$size" ]; then break; fi
            sleep 1
        done
        [ -n "$size" ] || { cat "$log" >&2; die "start check: no window of at least 720 x 560 within a minute"; }
        echo "    a window of ${size% *} x ${size#* } appeared"
    else
        echo "    (swiftc was not found: the window was not looked for, only the process)"
    fi
    sleep "$stay_up"
    kill -0 "$app_pid" 2>/dev/null || { cat "$log" >&2; die "start check: the program did not stay up for $stay_up seconds"; }
    if grep -qi 'panicked' "$log"; then cat "$log" >&2; die "start check: the program panicked"; fi
    echo "    still running after $stay_up s, no panic; outgoing network was refused except to this computer"
    kill "$app_pid" 2>/dev/null || true
    for _ in $(seq 50); do kill -0 "$app_pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$app_pid" 2>/dev/null && die "start check: the program did not end when asked to"
    wait "$app_pid" 2>/dev/null || true
    app_pid=""
    if [ -s "$log" ]; then
        echo "    what it printed ($(wc -l < "$log" | tr -d ' ') lines), first lines:"
        head -n 5 "$log" | sed 's/^/      /'
    fi
    rm -rf "$home"
}
if [ "$verify" = 1 ]; then
    start_check
else
    say "Start check skipped (--no-verify)"
fi

# --- Disk image -------------------------------------------------------------------------------
say "Making the disk image"
ln -s /Applications "$stage/dmg/Applications"
rm -f "$dmg"
hdiutil create -quiet -volname "$name $version" -srcfolder "$stage/dmg" \
    -fs HFS+ -format UDZO -imagekey zlib-level=9 "$dmg"
hdiutil verify -quiet "$dmg" || die "the disk image does not verify"

say "Done: $dmg ($(du -h "$dmg" | cut -f1 | tr -d ' '))"
printf 'SHA-256  %s\n' "$(shasum -a 256 "$dmg" | cut -d' ' -f1)"
