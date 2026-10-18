#!/bin/bash
# Builds dist/Infall-<version>.dmg: the desktop app as something to install on macOS
# (docs/specs/release.md, section 1; desktop/README.md, "The macOS package").
#
#   scripts/package-macos.sh
#
# Uses only what macOS and Rust bring: cargo, sips, iconutil, plutil, codesign, hdiutil, shasum.
# No tauri-cli. The app is signed ad hoc: no Developer ID, no notarisation.
# The package is for the kind of Mac it is built on (Apple silicon or Intel), not both.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_src="$root/desktop/src-tauri"
conf="$app_src/tauri.conf.json"
icon_src="$app_src/icons/icon-1024.png"
dist="$root/dist"

say() { printf '==> %s\n' "$*"; }
die() { printf 'package-macos: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script only runs on macOS"
for tool in cargo sips iconutil plutil codesign hdiutil shasum xattr; do
    command -v "$tool" >/dev/null || die "'$tool' was not found"
done
[ -f "$icon_src" ] || die "the icon source $icon_src is missing"

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

# --- Assemble Infall.app ------------------------------------------------------------------------
mkdir -p "$dist"
stage="$(mktemp -d "$dist/.stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

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

# --- Disk image -------------------------------------------------------------------------------
say "Making the disk image"
ln -s /Applications "$stage/dmg/Applications"
rm -f "$dmg"
hdiutil create -quiet -volname "$name $version" -srcfolder "$stage/dmg" \
    -fs HFS+ -format UDZO -imagekey zlib-level=9 "$dmg"
hdiutil verify -quiet "$dmg" || die "the disk image does not verify"

say "Done: $dmg ($(du -h "$dmg" | cut -f1 | tr -d ' '))"
printf 'SHA-256  %s\n' "$(shasum -a 256 "$dmg" | cut -d' ' -f1)"
