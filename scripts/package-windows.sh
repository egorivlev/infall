#!/usr/bin/env bash
# Builds dist/Infall-<version>-x64-setup.exe: the desktop app as something to install on
# Windows 10 and 11, 64-bit (docs/specs/release.md, section 6; desktop/README.md, "The Windows
# installer").
#
#   scripts/package-windows.sh
#
# Runs on a Mac or a Linux machine and cross-compiles; it does not run on Windows. No tauri-cli.
# It needs, besides cargo and python3 (to read tauri.conf.json; standard library only):
#
#   the Rust target      rustup target add x86_64-pc-windows-gnu
#   the GNU toolchain    macOS: brew install mingw-w64       Debian/Ubuntu: apt install mingw-w64
#   NSIS                 macOS: brew install makensis        Debian/Ubuntu: apt install nsis
#   Node.js and npm      22 (20.19 or newer also works), for the web UI: https://nodejs.org
#
# None of these asks anyone to accept a licence. Microsoft's own compiler and SDK are
# deliberately not used: they do.
#
# Run on macOS (Homebrew's mingw-w64, which links the Universal CRT) and, since M16, on Ubuntu
# 22.04 in a container (mingw-w64 8, NSIS 3.08, which link the older msvcrt.dll; both are part of
# Windows). The continuous build runs it on Ubuntu 24.04 (.github/workflows/package.yml).
#
# The app compiles the Infall server (crates/server) into itself. Its C parts are compiled by
# x86_64-w64-mingw32-gcc, the same compiler as above: SQLite (rusqlite's bundled copy) and
# AWS-LC (aws-lc-sys, the cryptography under rustls, which reqwest uses). Nothing else is needed
# for them, and this was tried on a Mac with neither cmake nor nasm installed:
#   - no cmake: aws-lc-sys builds with the `cc` crate, because it ships ready-made bindings for
#     x86_64-pc-windows-gnu;
#   - no nasm: AWS-LC's Windows x86-64 assembly is written for nasm, but rustls turns on
#     aws-lc-rs's `prebuilt-nasm` feature, so aws-lc-sys links object files that come with the
#     crate when `nasm` is not on PATH (when it is, it assembles them itself).
#
# What it does:
#   - builds the web UI: `npm ci` and `npm run build` in web/, which replace web/node_modules
#     and web/dist in this checkout. The web UI is the same files on every platform, so it is
#     built here, not for Windows. The app embeds web/dist when it is compiled (it serves it
#     from its own server for Local Workspaces, docs/specs/local.md), so the script stops if
#     web/dist/index.html is not there afterwards;
#   - `cargo build --release --locked --features custom-protocol --target x86_64-pc-windows-gnu`
#     (output in desktop/src-tauri/target/x86_64-pc-windows-gnu/). The program's icon, version
#     information and manifest are compiled in by tauri-build with mingw's windres, from
#     desktop/src-tauri/icons/icon.ico and tauri.conf.json;
#   - checks the program: 64-bit, no console window, every DLL it asks for is either part
#     of Windows or WebView2Loader.dll, which the installer ships next to it, and it holds the
#     web UI that was just built (the name of web/dist's hashed script must be inside it);
#   - puts the installer together with NSIS: for the current person, no administrator rights,
#     a Start menu entry, an uninstaller with its entry in Windows' list of installed apps;
#   - prints the SHA-256.
#
# Not signed. The result cannot be started on the machine that builds it, and this script does
# not pretend otherwise: see "Unverified: the Windows installer" in desktop/README.md.
# In particular, what the M11 installer got wrong (it only asked for a server address) is checked
# here only as far as a file can be read: the program holds the server and the web UI it would
# serve. That it starts with no server and no network, shows the start screen and opens a Local
# Workspace has NOT been checked on Windows; scripts/package-macos.sh and
# scripts/package-linux.sh check the same source on their platforms.
#
# The updater (docs/specs/release.md, section 11): when INFALL_UPDATE_PUBKEY (the public key
# from `tauri signer generate`) and INFALL_UPDATE_URL (the address of the feed's latest.json)
# are both set, the app is built with the `updater` feature and checks that feed; otherwise it
# has no updater at all, as before. Signing what is built for the feed is the release
# workflow's step (.github/workflows/package.yml), not this script's.
#   With the updater, the installer itself is what the updater downloads and runs.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_src="$root/desktop/src-tauri"
web="$root/web"
conf="$app_src/tauri.conf.json"
icon="$app_src/icons/icon.ico"
dist="$root/dist"
target="x86_64-pc-windows-gnu"
mingw="x86_64-w64-mingw32"

say() { printf '==> %s\n' "$*"; }
die() { printf 'package-windows: %s\n' "$*" >&2; exit 1; }

# --- Tools ------------------------------------------------------------------------------------
case "$(uname -s)" in
    Darwin) get_mingw="brew install mingw-w64"; get_nsis="brew install makensis" ;;
    *)      get_mingw="apt install mingw-w64 (or your distribution's mingw-w64 package)"
            get_nsis="apt install nsis (or your distribution's NSIS package)" ;;
esac
missing=()
need() { command -v "$1" >/dev/null || missing+=("'$1' was not found. Get it with: $2"); }
need cargo "https://rustup.rs"
need python3 "your system's Python 3 package"
need node "https://nodejs.org (22, or 20.19 or newer)"
need npm "https://nodejs.org (it comes with Node.js)"
need "$mingw-gcc" "$get_mingw"
need "$mingw-windres" "$get_mingw"
need "$mingw-objdump" "$get_mingw"
need makensis "$get_nsis"
if command -v shasum >/dev/null; then
    sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null; then
    sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
    missing+=("neither 'shasum' nor 'sha256sum' was found")
fi
# The target's standard library: asked of rustc itself, so this also works without rustup.
if command -v rustc >/dev/null; then
    libdir="$(rustc --print target-libdir --target "$target" 2>/dev/null || true)"
    if [ -z "$libdir" ] || [ ! -d "$libdir" ]; then
        missing+=("Rust cannot build for $target yet. Get it with: rustup target add $target")
    fi
fi
if [ "${#missing[@]}" -gt 0 ]; then
    printf 'package-windows: %s\n' "${missing[@]}" >&2
    exit 1
fi
[ -f "$icon" ] || die "the icon $icon is missing (python3 icons/make-icon.py --ico makes it)"
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

conf_value() {
    python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))[sys.argv[2]])' \
        "$conf" "$1"
}
name="$(conf_value productName)"
identifier="$(conf_value identifier)"
conf_version="$(conf_value version)"
[ "$conf_version" = "$version" ] \
    || die "Cargo.toml says version $version, tauri.conf.json says $conf_version; make them agree"
# Windows version resources want four numbers.
case "$version" in
    *[!0-9.]* | *.*.*.* | .* | *. | *..*) die "version $version is not of the form 1.2.3" ;;
    *.*.*) version4="$version.0" ;;
    *) die "version $version is not of the form 1.2.3" ;;
esac
# The publisher field: what tauri-build writes into the program as its company name
# (the second part of the identifier), so that the program and the installer agree.
publisher="$(printf '%s' "$identifier" | cut -d. -f2)"

setup="$dist/$name-$version-x64-setup.exe"
# The updater only when both of its values are given (see the top of this script).
features="custom-protocol"
if [ -n "${INFALL_UPDATE_PUBKEY:-}" ] && [ -n "${INFALL_UPDATE_URL:-}" ]; then
    features="$features,updater"
fi
say "$name $version ($identifier), Windows 10 and 11, x64"

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
# The C parts are compiled for Windows 10 and newer, whatever mingw-w64 assumes by itself: older
# mingw-w64 (Ubuntu 22.04's, version 8) assumes Windows XP, and SQLite then does not compile
# ("'GetTickCount64' undeclared", seen in M16); newer ones assume Windows 10 already.
say "Building (release, $features, $target)"
(
    cd "$app_src"
    CARGO_INCREMENTAL=0 \
    CFLAGS_x86_64_pc_windows_gnu="${CFLAGS_x86_64_pc_windows_gnu:-} -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00" \
        cargo build --release --locked -p "$binary" --features "$features" --target "$target"
)
out="$app_src/target/$target/release"
built="$out/$binary.exe"
# On this target the program asks Windows for WebView2Loader.dll when it starts; tauri-build
# copies the one that comes with the webview2-com-sys crate next to the program.
loader="$out/WebView2Loader.dll"
[ -f "$built" ] || die "the build did not produce $built"
[ -f "$loader" ] || die "the build did not put WebView2Loader.dll next to the program"

# --- Check the program ------------------------------------------------------------------------
say "Checking the program"
# (Read from a variable, not a pipe: with pipefail, a grep that stops early fails the pipe.)
headers="$("$mingw-objdump" -p "$built")"
grep -q 'file format pei-x86-64' <<<"$headers" \
    || die "$built is not a 64-bit Windows program"
# Subsystem 2 is "Windows GUI": no console window opens with the app. (3 would be a console.)
grep -Eq '^Subsystem[[:space:]]+00000002' <<<"$headers" \
    || die "$built would open a console window (its subsystem is not Windows GUI)"
grep -q 'file format pei-x86-64' <<<"$("$mingw-objdump" -p "$loader")" \
    || die "$loader is not a 64-bit Windows library"
# Every DLL the program names must be there on the Member's computer: part of Windows, or
# shipped by the installer. In particular nothing of the compiler's own (libgcc, libwinpthread,
# libstdc++), which no Windows has.
windows_dlls=" advapi32.dll bcrypt.dll bcryptprimitives.dll combase.dll comctl32.dll comdlg32.dll \
crypt32.dll dwmapi.dll gdi32.dll imm32.dll kernel32.dll msvcrt.dll ntdll.dll ole32.dll \
oleaut32.dll propsys.dll rpcrt4.dll secur32.dll shcore.dll shell32.dll shlwapi.dll user32.dll \
userenv.dll uxtheme.dll version.dll winmm.dll ws2_32.dll "
imports="$(sed -n 's/^[[:space:]]*DLL Name: //p' <<<"$headers" | sort -fu)"
[ -n "$imports" ] || die "could not read which DLLs $built needs"
shipped=0
for dll in $imports; do
    lower="$(printf '%s' "$dll" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
        webview2loader.dll) shipped=1; printf '    %-40s shipped by the installer\n' "$dll" ;;
        api-ms-win-*.dll) printf '    %-40s part of Windows\n' "$dll" ;;
        *)
            case "$windows_dlls" in
                *" $lower "*) printf '    %-40s part of Windows\n' "$dll" ;;
                *) die "the program needs $dll, which is neither part of Windows nor shipped" ;;
            esac ;;
    esac
done
[ "$shipped" = 1 ] || die "the program does not ask for WebView2Loader.dll; this script is out of date"
LC_ALL=C grep -qaF "$web_marker" "$built" \
    || die "the program does not hold the web UI that was just built (no $web_marker inside it)"
echo "    the program holds the web UI ($web_marker)"

# --- The installer ----------------------------------------------------------------------------
mkdir -p "$dist"
stage="$(mktemp -d "$dist/.stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
cp "$built" "$stage/$name.exe"
cp "$loader" "$stage/WebView2Loader.dll"
cp "$icon" "$stage/icon.ico"

# Everything the script knows comes in as /D definitions; the text below is NSIS as written.
cat > "$stage/installer.nsi" <<'NSI'
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
; For the person who runs it, without administrator rights: no UAC question.
RequestExecutionLevel user

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${IDENTIFIER}"
; Microsoft's documented place for the version of the Evergreen WebView2 runtime ("pv"):
; per machine (seen from a 32-bit program such as this installer, and by its full name on
; 64-bit Windows) and per person.
!define WEBVIEW2_KEY "Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define WEBVIEW2_PAGE "https://developer.microsoft.com/microsoft-edge/webview2/"

Name "${NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${NAME}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION4}"
VIFileVersion "${VERSION4}"
VIAddVersionKey "ProductName" "${NAME}"
VIAddVersionKey "FileDescription" "${NAME} installer"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "OriginalFilename" "${SETUPNAME}"
; No copyright line: tauri.conf.json names none, and the program has none either.
!pragma warning disable 9100

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${NAME}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${NAME} now"

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var WebView2

; $WebView2 becomes the installed runtime's version, or stays empty.
!macro ReadWebView2 ROOT KEY
    ${If} $WebView2 == ""
        ReadRegStr $WebView2 ${ROOT} "${KEY}" "pv"
        ${If} $WebView2 == "0.0.0.0"
            StrCpy $WebView2 ""
        ${EndIf}
    ${EndIf}
!macroend

; A running program cannot be replaced or removed: say so instead of failing halfway. It is
; given ten seconds to end first: the app's updater starts this installer and then quits.
!macro CloseAppFirst
    StrCpy $1 0
    ${Do}
        ${IfNot} ${FileExists} "$INSTDIR\${NAME}.exe"
            ${ExitDo}
        ${EndIf}
        ClearErrors
        FileOpen $0 "$INSTDIR\${NAME}.exe" a
        ${IfNot} ${Errors}
            FileClose $0
            ${ExitDo}
        ${EndIf}
        IntOp $1 $1 + 1
        ${If} $1 > 10
            ${ExitDo}
        ${EndIf}
        Sleep 1000
    ${Loop}
    ${Do}
        ${IfNot} ${FileExists} "$INSTDIR\${NAME}.exe"
            ${ExitDo}
        ${EndIf}
        ClearErrors
        FileOpen $0 "$INSTDIR\${NAME}.exe" a
        ${IfNot} ${Errors}
            FileClose $0
            ${ExitDo}
        ${EndIf}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
            "${NAME} is open. Close it, then choose Retry." /SD IDCANCEL IDRETRY +2
        Abort
    ${Loop}
!macroend

Function .onInit
    ${IfNot} ${RunningX64}
        MessageBox MB_OK|MB_ICONSTOP \
            "This ${NAME} is for 64-bit Windows on Intel or AMD processors (x64). This computer runs a different kind of Windows, so it cannot be installed here." /SD IDOK
        Abort
    ${EndIf}

    StrCpy $WebView2 ""
    SetRegView 32
    !insertmacro ReadWebView2 HKLM "SOFTWARE\${WEBVIEW2_KEY}"
    SetRegView 64
    !insertmacro ReadWebView2 HKLM "SOFTWARE\WOW6432Node\${WEBVIEW2_KEY}"
    !insertmacro ReadWebView2 HKCU "Software\${WEBVIEW2_KEY}"
    SetRegView default
    ${If} $WebView2 == ""
        MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
            "${NAME} shows its window with Microsoft's WebView2 runtime, and this computer does not seem to have it. Windows 11 comes with it; Windows 10 normally gets it with its updates.$\r$\n$\r$\nYou can get it from Microsoft (choose the Evergreen Bootstrapper):$\r$\n${WEBVIEW2_PAGE}$\r$\n$\r$\nThis installer downloads nothing. Without WebView2, ${NAME} will not start.$\r$\n$\r$\nInstall ${NAME} anyway?" \
            /SD IDYES IDYES +2
        Abort
    ${EndIf}
FunctionEnd

Section "Install"
    !insertmacro CloseAppFirst
    SetOutPath "$INSTDIR"
    File "${NAME}.exe"
    File "WebView2Loader.dll"
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; The Start menu of this person.
    SetShellVarContext current
    CreateShortcut "$SMPROGRAMS\${NAME}.lnk" "$INSTDIR\${NAME}.exe"

    ; The entry in Settings > Apps > Installed apps, for this person only.
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${NAME}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PUBLISHER}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${NAME}.exe,0"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
SectionEnd

; Removes exactly what the section above put there. The app's data (the list of Workspaces, the
; Local Workspaces themselves, the Runner's settings and approvals, what the web view keeps) is
; left alone: a Local Workspace exists nowhere else.
Section "Uninstall"
    !insertmacro CloseAppFirst
    Delete "$INSTDIR\${NAME}.exe"
    Delete "$INSTDIR\WebView2Loader.dll"
    Delete "$INSTDIR\uninstall.exe"
    ; Only if nothing else is in it.
    RMDir "$INSTDIR"

    SetShellVarContext current
    Delete "$SMPROGRAMS\${NAME}.lnk"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
NSI

say "Making the installer"
# makensis only writes a Unicode installer when the locale's character set is UTF-8 (in the
# plain "C" locale, 3.13 ends with std::bad_alloc), so it gets one if this shell has none.
nsis_locale="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
if [ "$(locale charmap 2>/dev/null || true)" != "UTF-8" ]; then
    nsis_locale=""
    available="$(locale -a 2>/dev/null || true)"
    for candidate in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8; do
        if grep -qx "$candidate" <<<"$available"; then
            nsis_locale="$candidate"
            break
        fi
    done
    [ -n "$nsis_locale" ] || die "no UTF-8 locale was found (locale -a); makensis needs one"
fi
rm -f "$setup"
(
    cd "$stage"
    LC_ALL="$nsis_locale" makensis -V2 -NOCD -INPUTCHARSET UTF8 \
        -DNAME="$name" -DVERSION="$version" -DVERSION4="$version4" \
        -DIDENTIFIER="$identifier" -DPUBLISHER="$publisher" \
        -DSETUPNAME="$(basename "$setup")" -DOUTFILE="$setup" \
        installer.nsi
)
[ -f "$setup" ] || die "makensis did not produce $setup"
grep -q 'file format pei-i386' <<<"$("$mingw-objdump" -p "$setup")" \
    || die "$setup is not a Windows program"

say "Done: $setup ($(du -h "$setup" | cut -f1 | tr -d ' '))"
say "In it: $name.exe ($(du -h "$stage/$name.exe" | cut -f1 | tr -d ' ')), WebView2Loader.dll, uninstall.exe"
printf 'SHA-256  %s\n' "$(sha256 "$setup")"
