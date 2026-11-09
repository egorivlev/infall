# Infall desktop app

A [Tauri v2](https://v2.tauri.app/) app around the web UI that the Infall server serves, with the server itself inside. It opens a Workspace of either kind: a **Local Workspace**, which lives on this computer and is served by the server inside the app (M12; see [Workspaces on this computer](#workspaces-on-this-computer)), or a **Team Workspace** on a team's server. On top of the web UI it adds two things: the AI sidebar can run on the Member's own Claude Code (M7), and the **Runner** executes Runs on the Member's own computer (M8; see [The Runner](#the-runner) and [its security model](#the-runners-security-model-in-plain-words)). The contract is [`docs/specs/desktop.md`](../docs/specs/desktop.md) and, for Local Workspaces, [`docs/specs/local.md`](../docs/specs/local.md); the reasons are in ADR [0002](../docs/adr/0002-desktop-app-primary-browser-fallback.md), [0003](../docs/adr/0003-ai-through-subscriptions-and-a-shared-tool-layer.md) and [0004](../docs/adr/0004-server-embedded-in-the-desktop-app-for-local-workspaces.md).

```
desktop/
  ui/                      the app's own local windows (plain HTML/CSS/JS, no build step)
    index.html, setup.*    the start screen
    approval.html, .js     the Runner's approval window
    runner.html, .js       the Runner settings window
  src-tauri/               the app (Rust); a Cargo workspace of its own, excluded from the root one
    build.rs               declares the commands; puts the built web UI (web/dist) inside the program
    src/shell.rs           the Tauri layer: windows, menu, the commands, opening a Workspace
    src/bridge.js          defines window.qoopDesktop on the open Workspace's pages
    src/bridge.rs          who may call the bridge and the local windows' commands
    src/address.rs         server address rules, health check, navigation rule
    src/workspaces.rs      the list of Workspaces and where each Local Workspace's files are
    src/webui.rs           unpacks the web UI for the server inside the app
    icons/icon-1024.png    the one source image of the app icon (make-icon.py draws it)
    capabilities/          what each local window may call
    driver/                qoop-claude-driver: runs `claude`; no Tauri types
      tests/stub-claude.sh a stand-in `claude` for tests
    runner/                qoop-runner: the Runner; no Tauri types
      src/approvals.rs     the approval gate and the remembered approvals
      src/inspect.rs       what the approval window shows of the code
      src/exec.rs          the process, its output, figures, temporary directory
      src/monitor.rs       the Runner monitor: usage samples, `qoop` and progress bars (M9)
      src/runner.py        the program that runs the code (standard library only)
      src/qsharp_runner.py the program that runs Q# code through qdk (M19b)
      src/python.rs        finding and checking interpreters, the shell's environment, Q#'s probe
      src/envs.rs          Python environments: found, added, names a Run asks for (M19)
      src/toolchains.rs    language ids, presets, command Toolchains (M19b)
      src/settings.rs      runner.json: interpreter, folder, environments, names, languages
      tests/real_python.rs the Runner against a real Python
      tests/real_toolchains.rs environments, a fake Toolchain, node/bash/julia/R, Q#
    proc/                  qoop-proc: process groups and private folders, shared by both
```

## Prerequisites

- Rust 1.90 or newer (Tauri 2.12 needs it). Built and tested here with 1.96.
- Node.js 22 (20.19 or newer also works) with npm, to build the web UI first: the app carries it (`build.rs` stops with a message if `web/dist/index.html` is missing). The app also compiles the server (`crates/server`), whose C parts (SQLite, AWS-LC) need a C compiler; on macOS the Command Line Tools' one is enough, and no cmake or nasm is needed on any platform built here.
- macOS: the Xcode Command Line Tools are enough (`xcode-select --install`); full Xcode is not needed for a development build. Linux and Windows need the usual [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/); for what was built and checked there, see "The Ubuntu package" and "The Windows installer".
- The Tauri CLI (`cargo tauri`) is **not** needed: not to build, not to run, and not for the macOS package, which `scripts/package-macos.sh` puts together itself (see [The macOS package](#the-macos-package)).
- For the AI sidebar: Claude Code installed and signed in (`claude`), version 2.1.x. The flags below were read from 2.1.265.
- For the Runner: a Python 3 (3.8 or newer) of the Member's own. matplotlib only if Runs draw figures. The Runner tests use whatever Python 3 they find (see "Tests").

## Build and run in development

Build the web UI once (and again after changing it), then start the app:

```sh
npm --prefix web ci && npm --prefix web run build
cd desktop/src-tauri
cargo run
```

Every start shows the start screen. Under **Create a workspace**, a tile makes a Local Workspace and opens it; it is served by the server inside the app, from the web UI that was built into it, so a change to `web/` shows only after building both again. To use a development server instead, start it as usual (`cargo run -p qoop-server` from the repository root; it listens on `http://localhost:8787`) and enter `http://localhost:8787` under **Sign in to a Team Workspace**. The app checks `GET /api/health`, remembers the Workspace (macOS: `~/Library/Application Support/app.qoop.desktop/workspaces.json`) and shows the server's UI. **Infall → Switch Workspace…** brings the start screen back.

Checks:

```sh
cd desktop/src-tauri
cargo test                                   # driver (stub claude) + Runner (real Python) + app rules + Workspaces
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

A release build with plain cargo needs one feature, so that the app's own files are served from inside the binary (`cargo tauri build` would turn it on by itself):

```sh
cargo build --release --features custom-protocol
```

Release builds have no web inspector: the `devtools` feature of the `tauri` crate is off, and Tauri only enables the inspector by itself in debug builds.

To use a different `claude` (tests do this with the stub): `QOOP_CLAUDE_BIN=/path/to/claude cargo run`. Without it the app looks for `claude` on `PATH`, then in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin` (an app started from the Finder gets a short `PATH`).

## Workspaces on this computer

Since M12 the app opens with a **start screen** at every start (`desktop/ui/index.html`; the commands behind it are Contract C of [`local.md`](../docs/specs/local.md)). It has three parts:

- **Your workspaces**: every Workspace this app knows, the one opened most recently first. Click a name to open it; the **⋯** in its row has **Rename** and **Remove…** (since M13 also **Export…** and **Show in folder** for a Local Workspace). Removing asks first; for a Local Workspace it deletes its files for good, for a Team Workspace it only forgets the address. **Export…** writes a Workspace file, `<name>.infall`, where you choose, and the row then says "Workspace file saved to …"; **Show in folder** opens the Workspace's folder. Once a backup exists the row says when ("backed up today at …"). Removing a Local Workspace offers **Export first…**. Below the list (under **Create a workspace** while there is none), **Import a workspace…** makes a new Local Workspace from a `.infall` file and opens it; it never replaces one. It also takes a Local Workspace's own `workspace.sqlite` copied by hand (with the `workspace.sqlite-wal` beside it, when there is one), named "Recovered workspace"; that copy is only read, and is cleaned as an export is. A Workspace file holds no sign-ins, no access tokens and no AI settings (so no OpenRouter key). How to use them: [the tutorial](../docs/tutorial.md#12-getting-work-in-and-out), part 12; the contract: [`portability.md`](../docs/specs/portability.md) and [`desktop.md`](../docs/specs/desktop.md#m13--workspace-files-backups-saving-and-printing).
- **Create a workspace**: four tiles, **Tutorial** (a sample Board and a hands-on Tutorial through every part of Infall), **Blank**, **Literature review** and **Research project**. Each makes a Local Workspace and opens it.
- **Sign in to a Team Workspace**: the **Server address** of a team's server and **Sign in**, with the same address rules and health check as before. The app remembers it under the address's host name.

**A Local Workspace** is served by the Infall server compiled into the app (`crates/server`, started in the app's own process by `qoop_server::local::start_local`), on `127.0.0.1` at a port the system chooses, from the web UI that was built into the program (`build.rs` embeds `web/dist`; `src/webui.rs` unpacks it). It has one Member, named after your login name on this computer (`$USER`, on Windows `%USERNAME%`; `Me` if there is none), who is signed in without being asked anything; the name can be changed in the menu under your name. Members, invites, Guests, passwords and signing out do not exist there. The Workspace needs no network: the web UI carries its own fonts. **Look up** in the Source form is the one thing in it that reaches out, and only when pressed ([privacy](../docs/privacy.md)).

**One Workspace at a time.** **Infall → Switch Workspace…** (and the Tutorial's **Back to workspaces**) stops what is running (a `claude` run, a Run, the server of a Local Workspace), closes the main window and shows the start screen. The bridge is granted to the open Workspace's origin, and Tauri cannot take a grant back; so when you open a second Workspace in the same run of the app, the app starts itself again and opens that Workspace then. You see the app close and open once.

**Where the files are.** The list of Workspaces is `workspaces.json` in the app's config directory. Each Local Workspace is a folder `workspaces/<id>/` in the app's data directory: `workspace.sqlite` and, beside it, `workspace.sqlite.secret-key` (the key that seals an OpenRouter key added in that Workspace; owner-only on macOS and Linux). The unpacked web UI is `web/` in the data directory. On macOS both directories are `~/Library/Application Support/app.qoop.desktop/`; for Ubuntu and Windows see their sections. Since M13 the folder also holds `backups/`: when a Workspace is opened and its newest copy there is older than 24 hours, the app writes a new one, and keeps the newest 7. A copy is a Workspace file, the same as **Export…** makes; a failed copy never stops the Workspace from opening. **Show in folder** on the start screen opens the folder. To keep a copy elsewhere, use **Export…** rather than copying `workspace.sqlite` (a copy of the open database may be torn, and its newest Changes may sit in `workspace.sqlite-wal`). A copy made by hand can still be brought back with **Import a workspace…**. Each Local Workspace's sign-in cookie in the web view has a name of its own (`qoop_session_<id>`), since every one is served from `127.0.0.1`. **Remove** deletes the folder, backups included. A Local Workspace cannot yet be moved onto a server. The address an earlier version saved (`config.json`) appears once as a Team Workspace in the list.

**Runs in a Local Workspace.** Approvals are remembered per Workspace, not per address (see "The Runner"): a Team Workspace by its server's origin, a Local Workspace by its own identity in the list. A Local Workspace also keeps its port: the app remembers one per Workspace and asks for it at every start, so its address stays the same; if that port is taken, the Workspace opens on another one, and its approvals still hold, because they do not depend on the port. The approval window names the Workspace under **From**: a Local Workspace by its name, a Team Workspace by its server.

**What guards the server inside the app.** It listens on `127.0.0.1` only and only while a Local Workspace is open, so nothing outside this computer can reach it. Every program on this computer can connect to the port, under any account. To be signed in it must know the key in the address the app opens first (`/api/local/enter?key=…`): 256 random bits, new at every start, never written to disk; any other key, or none, is answered `404`. Signing in with a password is refused in a Local Workspace, so there is no other way in. What it does not guard against: a program running as you can read and change the Workspace's files directly, as it can all your files.

## The macOS package

`scripts/package-macos.sh` (run from anywhere in a clean checkout) builds `dist/Infall-<version>.dmg` and prints its SHA-256. `dist/` is not kept in git.

```sh
scripts/package-macos.sh
```

It needs what building the app needs (Rust, the Xcode Command Line Tools, Node.js with npm) and nothing else: `cargo`, `node`, `npm`, `sips`, `iconutil`, `plutil`, `codesign`, `hdiutil`, `shasum`, and `sandbox-exec` and `swiftc` for the start check. What it does:

0. Builds the web UI: `npm ci` and `npm run build` in `web/` (this replaces `web/node_modules` and `web/dist` in the checkout), and stops unless `web/dist/index.html` is there afterwards.
1. Reads the version from `src-tauri/Cargo.toml` and the name, identifier and oldest supported macOS from `src-tauri/tauri.conf.json`. It stops if the two files disagree about the version.
2. `cargo build --release --locked --features custom-protocol`, with the `[profile.release]` of `Cargo.toml`: symbols stripped, thin LTO, one codegen unit. This is for size only; optimisation level and panic behaviour are cargo's defaults. Since M12 the program contains the server, SQLite, AWS-LC and the web UI: a 19.6 MB program and a 9.6 MB disk image (M11: 9 MB and 4 MB). The script then checks that the program holds the web UI it has just built.
3. Puts `Infall.app` together by hand: the program in `Contents/MacOS/`, `Contents/Info.plist` (identifier `app.qoop.desktop`, version, `LSMinimumSystemVersion`, `NSHighResolutionCapable`, category Productivity), and `Contents/Resources/Infall.icns` made from `src-tauri/icons/icon-1024.png` with `sips` and `iconutil`. Nothing else is in the bundle: the pages of `desktop/ui`, `bridge.js`, `runner.py` and the web UI are inside the program, and it links only against libraries macOS ships (SQLite and AWS-LC are compiled in).
4. Signs it ad hoc (`codesign --sign -`), without entitlements and without the hardened runtime, and verifies the signature.
5. **The start check** (`--no-verify` skips it): starts the signed program from the bundle with a new, empty home folder (no Workspaces, no saved server) under `sandbox-exec`, with a profile that refuses every outgoing network connection except to this computer. It must show a window of at least 720 × 560 (the start screen's minimum; the old address screen was 520 × 420) within a minute, still run ten seconds later, and not panic. The window shows on the screen for those seconds. Not checked: anything on the start screen itself, because nothing here may press its buttons (that needs the Accessibility permission); so a Workspace is not created or opened by this check. `sandbox-exec` is deprecated by Apple and still works on macOS 26; WebKit's helper processes are started by the system and are not under its profile.
6. Makes a compressed disk image holding `Infall.app` and a link to `/Applications`, and verifies it.

**Oldest macOS: 11.0** (`bundle.macOS.minimumSystemVersion` in `tauri.conf.json`; the build and the `Info.plist` both take it from there). The package is built for the kind of Mac it is built on, here Apple silicon, and no Apple silicon Mac runs anything older than macOS 11; it is also the oldest version Rust itself builds for on Apple silicon. Tauri's own default (10.13) would only matter for an Intel build. Run and tested on macOS 26.5 only; see "Unverified".

**The icon.** `icons/icon-1024.png` is the source; the `.icns` is made from it on every packaging run and is not kept in git. `icons/icon.png` is a 256-pixel copy that Tauri builds into the program. `icons/make-icon.py` drew the source (the mark of the web UI's `Logo.tsx` in the dark theme's colours); it needs Pillow and is only needed to change the icon.

**Not there:** a Developer ID signature, notarisation, updates of any kind (a new version is a new `.dmg`, installed over the old one by hand; the app does not look for one), an Intel or universal build, an app store. (Ubuntu and Windows have packages of their own, below.) App data stays in `~/Library/Application Support/app.qoop.desktop/`, the same place a development build uses: the list of Workspaces, every Local Workspace, the Runner's files. An earlier version's saved server becomes a Team Workspace in the list; nothing else is migrated. Deleting the app from Applications leaves that folder, and the Local Workspaces in it, where they are.

### Installing it (for a Member)

1. Get `Infall-<version>.dmg` from the person who built it. To be sure it is the real file, ask them for its SHA-256 and compare: `shasum -a 256 ~/Downloads/Infall-<version>.dmg`.
2. Open the `.dmg` and drag **Infall** onto **Applications**. Eject the disk image.
3. Open Infall from Applications. The first time, macOS refuses (see below). After you have allowed it once, it opens like any other app.
4. Infall opens with its start screen. To try Infall on your own, press **Tutorial** under **Create a workspace**: no server, no account and no network are needed. To join your team, enter your team's server address (your Admin has it) under **Sign in to a Team Workspace** and press **Sign in**.

### The first start: allowing Infall once

A file that came from the internet is marked by macOS, and macOS only opens marked apps that Apple has checked ("notarised") for a developer with a paid Apple account. Infall is not: nobody has paid for that account yet. So the first start is stopped with a warning that Apple could not verify Infall (the sentence differs between macOS versions), with the buttons **Done** and **Move to Trash**. Click **Done**, then, on macOS 15 and 26:

1. Choose Apple menu > **System Settings**, then click **Privacy & Security** in the sidebar.
2. Scroll down to **Security**. There is a line saying Infall was blocked. Click the button next to it (**Open Anyway**; Apple's own page for macOS 26 calls it **Open**, followed by **Open Anyway**). The button is only there for about an hour after you tried to open Infall; if it is gone, try to open Infall again.
3. Enter your login password (or use Touch ID) when asked, and confirm that you want to open it.

This is needed once per installed copy, so again after installing a new version. On macOS 14 and older, Control-click Infall in Applications, choose **Open**, then **Open** again; on macOS 15 and newer that shortcut no longer exists. Apple's description: [Open a Mac app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

If no warning appears at all, the file reached you without the mark (for example from a shared folder); nothing is wrong. If macOS says Infall "is damaged", do not look for a way around it: the file changed on the way; get it again and compare the SHA-256.

**What the warning means.** Apple has not looked at this app and does not know who made it. macOS cannot tell you whether it is the app your team built. That is all.

**What it does not mean.** It does not mean macOS found something harmful. And allowing it does not switch anything off for other apps: the exception is for this one copy of Infall.

**What you are trusting instead** is the person who gave you the file. That is why the SHA-256 matters: the ad hoc signature inside the app only makes it startable on Apple silicon; anyone can make one, and it proves nothing about where the app came from. Do not allow an Infall that reached you some other way.

## The Windows installer

`scripts/package-windows.sh` (run from anywhere in the checkout, on a Mac or a Linux machine; not on Windows) builds `dist/Infall-<version>-x64-setup.exe` for 64-bit Windows 10 and 11 and prints its SHA-256. **The result has never been started: there was no Windows to start it on.** What that leaves open is listed under [Unverified: the Windows installer](#unverified-the-windows-installer-m11); read it before handing the file to anyone. Where older sections of this page say what Windows "would" do, this section is the newer one.

```sh
rustup target add x86_64-pc-windows-gnu
brew install mingw-w64 makensis        # Debian/Ubuntu: apt install mingw-w64 nsis
# and Node.js 22 (or 20.19 or newer) with npm, for the web UI
scripts/package-windows.sh
```

It cross-compiles with the GNU toolchain for Windows and puts the installer together with NSIS; neither asks anyone to accept a licence. Microsoft's own compiler and SDK are deliberately not used, because they do. The script checks for its tools first and says how to get each one that is missing (`cargo`, the Rust target, `x86_64-w64-mingw32-gcc`, `-windres`, `-objdump`, `makensis`, `python3` to read `tauri.conf.json`, `node` and `npm`, `shasum` or `sha256sum`). No `tauri-cli`. The server inside the app has C parts, SQLite and AWS-LC (the cryptography under `rustls`); mingw's gcc compiles both, and neither cmake nor nasm is needed: `aws-lc-sys` builds with the `cc` crate from bindings it ships for this target, and for its Windows assembly it links object files that come with the crate (`rustls` turns on its `prebuilt-nasm` feature; a `nasm` on `PATH` would be used instead). This was built on a Mac with neither installed. What it does:

0. Builds the web UI on the building machine (`npm ci`, `npm run build` in `web/`, replacing `web/node_modules` and `web/dist` there; the files are the same for every platform) and stops unless `web/dist/index.html` is there.
1. Reads the version from `src-tauri/Cargo.toml` and the name and identifier from `src-tauri/tauri.conf.json`, and stops if the two files disagree about the version.
2. `cargo build --release --locked --features custom-protocol --target x86_64-pc-windows-gnu` (output under `src-tauri/target/x86_64-pc-windows-gnu/`; about three and a half minutes from nothing here, with the server). `tauri-build` compiles the icon (`icons/icon.ico`), the version information and the application manifest into the program with mingw's `windres`. Release builds are Windows-subsystem programs (`src/main.rs`), so no console window opens with the app.
3. Checks the program with `objdump`: 64-bit, the Windows GUI subsystem, and every DLL it names is either part of Windows or `WebView2Loader.dll`. It stops at any other name, in particular the compiler's own libraries (`libgcc`, `libwinpthread`), which no Windows has. With Homebrew's mingw-w64 the C runtime it names is the Universal CRT (`api-ms-win-crt-*`), which is part of Windows 10 and 11. The script then checks that the program holds the web UI it has just built.
4. Runs `makensis` on an installer script that is written out in full inside the packaging script, and prints the SHA-256. Every run gives a different file, even from the same source (NSIS stores times): hand out one file and quote the SHA-256 of that one.

**Sizes** (M12, with the server and the web UI inside): `Infall.exe` 20 MB, the installer 7.0 MB (M11: 3.0 MB).

**What the installer does.** It runs as the person who started it and never asks for administrator rights (`RequestExecutionLevel user`). It puts three files into `%LOCALAPPDATA%\Programs\Infall\`: `Infall.exe`, `WebView2Loader.dll` (Microsoft's small loader for WebView2, which programs built with this toolchain load from their own folder; it comes with the `webview2-com-sys` crate) and `uninstall.exe`. It adds **Infall** to that person's Start menu and one entry to their list of installed apps (under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\app.qoop.desktop`). Nothing else: no service, no autostart, no file association, nothing for other accounts of the computer. Installing a new version over an old one replaces the files; if Infall is open, the installer says so and waits.

**WebView2.** Infall shows its window with Microsoft's WebView2 runtime. Windows 11 comes with it and Windows 10 normally has it through its updates. The installer looks for it where Microsoft documents it (the value `pv` under `…\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` in `HKLM\SOFTWARE\WOW6432Node` and in `HKCU\Software`). If it is not there, the installer says so, names Microsoft's page (<https://developer.microsoft.com/microsoft-edge/webview2/>, "Evergreen Bootstrapper") and asks whether to install Infall anyway. It downloads nothing. Without WebView2, Infall does not start.

**The icon.** `icons/icon.ico` (16 to 256 pixels) is made from `icons/icon-1024.png` by `python3 icons/make-icon.py --ico` and, unlike the `.icns`, is kept in git: `tauri-build` refuses to build for Windows without it. The program and the installer both use it.

**Not there:** a code signature of any kind (so the warning below), updates (a new version is a new installer; the app does not look for one), a build for Windows on ARM or for 32-bit Windows (the installer refuses there), an install for all accounts, an MSI, the Microsoft Store.

### Installing it on Windows (for a Member)

1. Get `Infall-<version>-x64-setup.exe` from the person who built it. To be sure it is the real file, ask them for its SHA-256 and compare. In PowerShell: `Get-FileHash .\Infall-<version>-x64-setup.exe` (or, in any prompt, `certutil -hashfile Infall-<version>-x64-setup.exe SHA256`).
2. Open the file. The first time, Windows stops it with a blue window titled **Windows protected your PC**, saying that Microsoft Defender SmartScreen prevented an unrecognized app from starting, with one button, **Don't run**. Click **More info** in the text. The window now shows the file's name and **Publisher: Unknown publisher**, and a second button: **Run anyway**. Click it.
3. The installer runs without further questions and offers to open Infall. Later, Infall is in the Start menu.
4. Infall opens with its start screen. To try Infall on your own, press **Tutorial** under **Create a workspace**: no server, no account and no network are needed. To join your team, enter your team's server address (your Admin has it) under **Sign in to a Team Workspace** and press **Sign in**.

Your browser may warn before that, when the download ends (Edge says the file "isn't commonly downloaded" and offers to keep it in the menu next to that message). If Windows instead says that **Smart App Control** blocked the file, there is no button to allow it: Smart App Control only lets signed programs run, and this one is not signed. Do not switch Smart App Control off for Infall (Windows cannot switch it back on without being reinstalled); tell the person who gave you the file.

**What the warning means.** Nobody has paid for the certificate that would put a publisher's name on the file, and too few people have run this exact file for Microsoft to have an opinion about it. Windows cannot tell you whether it is the installer your team built. That is all.

**What it does not mean.** It does not mean Windows found something harmful. And "Run anyway" switches nothing off: it is an answer for this one file.

**What you are trusting instead** is the person who gave you the file. That is why the SHA-256 matters: it is the only thing that ties the file in your Downloads folder to the one they built. Do not run an Infall installer that reached you some other way.

**To uninstall:** Settings > Apps > Installed apps (Windows 10: Apps & features) > Infall > Uninstall. It removes the three files, the folder if nothing else is in it, the Start menu entry and the list entry. It does **not** remove your data, which is in two places: `%APPDATA%\app.qoop.desktop\` (the list of Workspaces in `workspaces.json`, **every Local Workspace**, its backups included, under `workspaces\`, the unpacked web UI in `web\`, the Runner's `runner.json` and `runner-approvals.json`, and an older version's `config.json`) and `%LOCALAPPDATA%\app.qoop.desktop\` (what the web view keeps, your sign-in to a Team Workspace among it). A Local Workspace exists nowhere else: delete those two folders by hand only if you want it gone too.

### What the Runner does and does not do on Windows

Read in the source, not seen running. The code paths meant are in `proc/src/lib.rs`, `runner/src/python.rs`, `runner/src/exec.rs` and `runner/src/monitor.rs`.

- **Finding Python.** Runner settings list what answers like Python 3 as `python.exe`, `python3.exe` or `py.exe` (python.org's launcher, listed as the Python it would start) in the folders of `PATH`, then in `%LOCALAPPDATA%\Programs\Python\Python3…\` (where python.org's installer puts a Python for one person, also when it was not added to `PATH`) and in its `Launcher` folder. No shell is asked on Windows: the app uses the environment it was started with, which from the Start menu is the Member's own. Not looked for: conda and other Pythons that are on `PATH` only after something was "activated", and pyenv-win (its shims are batch files). Whether a Python from the Microsoft Store is listed is not known (its `python.exe` on `PATH` is a special kind of link). Any of these can be typed as a full path (`C:\…\python.exe`); it is accepted if `--version` answers `Python 3.…`. A conda Python started this way has not had its environment activated, and packages that need that may fail to import.
- **Starting a Run** works as on macOS: `python.exe -u -X utf8 runner.py main.py` with the same environment additions, in a new folder under the Member's temporary folder, without a console window. **The owner-only file modes do not exist on Windows**: the Run's folder, the approvals file and the file holding the AI sidebar's token are protected only by what they inherit from the Member's profile folder, which other ordinary accounts cannot read by default.
- **Stopping a Run and everything it started.** Windows has no process groups. Right after Python is started, the app puts it into a job object of its own, and stopping kills the job: Python and everything it has started since, at once. There is no polite request first (no `SIGTERM`, no half second): code cannot clean up, and `finally` blocks do not run. What is left running when the code ends by itself is killed the same way. What escapes: a program the code started in the instant before Python was in the job; anything the code has started by other means than starting it itself (a scheduled task, a service); and, as everywhere, a Run in progress when the app itself is killed hard keeps running. If Windows refuses the job, only Python itself is killed. The same holds for `claude`.
- **Reading what the code left behind** (figures, versions) does not follow links, as on macOS (`FILE_FLAG_OPEN_REPARSE_POINT`).
- **The Runner monitor shows nothing on Windows.** Its figures come from `ps`, `sysctl`, `ioreg` and `/proc`, none of which Windows has, and nothing was written to replace them: no processor, memory, process count or graphics figures. Because steps (`qoop.step`, `qoop.progress`) and progress bars travel with those figures, they do not arrive either. Output, figures, exit code and the result are not affected.
- **The AI sidebar** looks for `claude.exe` on `PATH`, in `%USERPROFILE%\.local\bin` and `%USERPROFILE%\.claude\local`. A `claude.cmd` (an npm install) is not found; `QOOP_CLAUDE_BIN` can name another program; a batch file is not expected to work with these arguments. Whether Claude Code on Windows takes the same flags and prints the same stream is as unverified as on macOS, and more so.

## The Ubuntu package

`scripts/package-linux.sh` (run from anywhere in a checkout, on a Mac or a Linux machine) builds `dist/infall_<version>_amd64.deb`, checks it and prints its SHA-256. `dist/` is not kept in git.

```sh
scripts/package-linux.sh                 # amd64: most Ubuntu laptops
scripts/package-linux.sh arm64           # arm64
scripts/package-linux.sh amd64 arm64     # both
scripts/package-linux.sh --no-verify …   # build only
scripts/package-linux.sh --clean         # remove what the script keeps in Docker
```

It needs Docker and nothing else; everything happens in containers, so it gives the same package from a Mac and from a Linux machine. No `tauri-cli`. What it does:

1. Reads the version from `src-tauri/Cargo.toml` and the name and identifier from `src-tauri/tauri.conf.json`, and stops if the two files disagree about the version. The package, the program and the icon are named after the product in lower case: `infall`.
2. Builds an image `qoop-package-linux:22.04-<arch>`: Ubuntu 22.04, Rust (1.96.0; `QOOP_PACKAGE_RUST` changes it), Node.js (22.23.5 from nodejs.org, checked against its published SHA-256; `QOOP_PACKAGE_NODE` changes it), and the libraries of the package's architecture (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev`, `libdbus-1-dev`). The image is always of the building computer's own kind. For the other kind of processor (amd64 on an Apple silicon Mac) it **cross-compiles** with Ubuntu's multiarch libraries and `crossbuild-essential`, which is as fast as a native build; nothing is compiled under emulation.
3. Copies what the app is built from into a container: `desktop/`, `crates/` (the server, which the app compiles in), `web/` without `node_modules` and `dist`, and the root `Cargo.toml` and `Cargo.lock` (the checkout is mounted read-only; `src-tauri/target` is neither read nor written). There it builds the web UI (`npm ci`, `npm run build`, npm's downloads kept in the volume) and stops unless `web/dist/index.html` exists, then runs `cargo build --release --locked --features custom-protocol --target <triple>`, with the same `[profile.release]` as the macOS package, and checks that the program holds the web UI just built. The server's C parts (SQLite, AWS-LC) are compiled by the image's gcc or, for the other architecture, `crossbuild-essential`'s; no cmake or nasm. Downloaded crates and build output are kept in the Docker volume `qoop-package-linux-cargo`. Since M12 the program is 20 MB and the arm64 package 6.0 MB (M11: 2.7 MB).
4. Puts the package together by hand with `dpkg-deb`: `/usr/bin/infall`, `/usr/share/applications/infall.desktop` (`Name=Infall`, `StartupWMClass=infall`, category Office) and `/usr/share/icons/hicolor/<size>/apps/infall.png` in eight sizes from 16 to 512, made from `src-tauri/icons/icon-1024.png`. Nothing else: no service, no maintainer scripts, no configuration files. `Depends` is what `dpkg-shlibdeps` finds the program linked against, on Ubuntu 22.04:

   ```
   libc6 (>= 2.34), libcairo2 (>= 1.10.0), libdbus-1-3 (>= 1.9.14), libgcc-s1 (>= 4.2), libgdk-pixbuf-2.0-0 (>= 2.36.9), libglib2.0-0 (>= 2.65.1), libgtk-3-0 (>= 3.21.5), libjavascriptcoregtk-4.1-0, libsoup-3.0-0 (>= 3.0.3), libwebkit2gtk-4.1-0 (>= 2.41.90)
   ```

   Ubuntu 24.04 renamed some of these (`libgtk-3-0t64`, `libglib2.0-0t64`, …), but its packages still provide the old names with their versions, so the same line installs there; no alternatives are needed, and the script checks that on every run. `Recommends: python3, xdg-utils, procps`: Infall works without Python and only Runs need it; `xdg-utils` opens links in the system browser; `procps` is the `ps` the Runner monitor reads.
5. Checks the result (see below) and prints the SHA-256. All time stamps inside the package are the program's own, so packaging the same build again gives the same file.

In Docker it creates only things named `qoop-package-linux…` (one image per architecture, one volume, and containers and a snapshot image per check that are removed when it ends) and pulls `ubuntu:22.04` and `ubuntu:24.04`. `--clean` removes the images and the volume again.

**Docker's own disk** (M16). A Docker machine on a Mac (colima, Docker Desktop) has a disk of its own, often 30 or 60 GB, shared by every image on it. When it is full, nothing says so: apt in the image build reports "At least one invalid signature was encountered" for every source and the image is not built. Since M16 the script first looks at the free space there and stops with a plain sentence when it is less than it needs (about 3 GB for an image not built yet, 4 GB per architecture for a volume not made yet, 2 GB for the checks). `QOOP_PACKAGE_CACHE=<folder>` keeps the downloaded crates, npm's cache and the build output in a folder of this computer instead of the volume; the continuous build uses it to cache them between runs. On a Mac that folder must be one Docker shares (under your home folder), and a build there is slower than in the volume (every file goes through the Docker machine's file sharing): in M16 the first arm64 build from nothing took over three hours that way on a Mac on battery with 2 processors for Docker, a network outage included; the rebuild after a change to the web UI about four minutes (3½ of them compiling and linking the app).

**What the script checks.** For each package, in a clean `ubuntu:22.04` and a clean `ubuntu:24.04` container of the package's architecture, in two steps. First, with the network: `apt-get install ./infall_….deb` succeeds; the files are there and there are no maintainer scripts; `ldd` finds every shared library; Xvfb and `xdotool` are installed for the second step. Then, from a snapshot of that container started with **no network at all** (`--network none`; the script checks that `lo` is the only interface) and an untouched home folder: started as an ordinary user on a virtual display, the program shows a window named Infall with the window class `infall`, is still running ten seconds later together with its page process, has not panicked, and listens on no port yet. Then the script presses Return in that window: on a fresh start screen the focus is on the first tile, **Tutorial** (`focusStart` in `desktop/ui/setup.js`), so this creates a Tutorial Workspace. Within 90 seconds the program must listen on `127.0.0.1` and on nothing else; `GET /api/health` there must answer `{"ok":true}`; `/api/local/enter` without a key and with a wrong one must answer `404`; `workspaces/<id>/workspace.sqlite` and the unpacked `web/index.html` must be in `~/.local/share/app.qoop.desktop/`; a window must still be shown and nothing may have panicked. Last: it ends when asked to, and `apt-get remove` leaves nothing in `/usr`. Not checked: what any screen looks like, whether the main window shows the Board, and anything in the Tutorial. **It passed for arm64 on both releases in M16** (docs/specs/release.md, section 9.1), after its socket check was fixed: until then it read the program's sockets as root, which a container does not allow for another user's process, and so never saw the Workspace's server. A package for the other kind of processor is checked in emulated containers (Docker's QEMU). If the Docker at hand cannot emulate, these checks are skipped and the script's summary says so. Emulating a WebKit app takes several times the memory of the real thing: in a Docker machine with 4 GB that also runs other containers, the emulated start was ended by the kernel for lack of memory (see "Unverified: the Ubuntu package"). Give Docker 8 GB, or build and check the package on a computer of its own kind.

**How long it takes** (Apple silicon Mac, Docker in a colima machine with 2 processors and 4 GB): the first amd64 run 13 minutes without the checks (8 for the image, 5 for the build); the first arm64 run after it 4 minutes; a run with nothing changed builds in under a second, and after a change to the app's own code in about a minute. The checks download WebKitGTK into each clean container, so they take as long as the network does: here between 3 and 20 minutes per container. The script keeps about 6 GB in Docker (two images that share most of their content, and the volume).

**Not there:** a signature, an apt repository, updates of any kind (a new version is a new `.deb` installed over the old one; the app does not look for one), Snap, Flatpak, AppImage, packages for other distributions.

### Installing it on Ubuntu (for a Member)

1. Get `infall_<version>_amd64.deb` from the person who built it (`arm64` only if your computer has an ARM processor; `dpkg --print-architecture` says which). To be sure it is the real file, ask them for its SHA-256 and compare: `sha256sum ~/Downloads/infall_<version>_amd64.deb`. The package is not signed: the SHA-256 and the person who gave it to you are all there is.
2. Install it. The `./` matters: without it `apt` looks for a package of that name in Ubuntu's own archive.

   ```sh
   cd ~/Downloads
   sudo apt install ./infall_<version>_amd64.deb
   ```

   `apt` shows the other packages it will add (WebKitGTK 4.1 and what it needs; a normal Ubuntu desktop already has most of it) and asks before it goes on.
3. Open **Infall** from the applications overview, or run `infall` in a terminal. It opens with its start screen. To try Infall on your own, press **Tutorial** under **Create a workspace**: no server, no account and no network are needed. To join your team, enter your team's server address (your Admin has it) under **Sign in to a Team Workspace** and press **Sign in**.

**What it needs:** Ubuntu 22.04 or 24.04 with its updates installed (the package wants WebKitGTK 2.42 or newer, which both releases deliver as a security update), on a 64-bit Intel/AMD computer (`amd64`) or an ARM one (`arm64`). For Runs, a Python 3.8 or newer: Ubuntu's own `python3` is enough and is installed along with Infall unless you tell `apt` not to; matplotlib (`sudo apt install python3-matplotlib`, or your own environment) only if Runs draw figures. For the AI sidebar, Claude Code (`claude`) installed and signed in.

**Removing it:** `sudo apt remove infall`. This removes exactly what the package installed. It does not remove your data.

**Where the data is** (per person, the same places a development build uses; nothing is removed with the package):

- `~/.config/app.qoop.desktop/`: the list of Workspaces (`workspaces.json`), the Runner's settings (`runner.json`) and the remembered approvals (`runner-approvals.json`); an older version's `config.json`. `$XDG_CONFIG_HOME` moves it.
- `~/.local/share/app.qoop.desktop/`: **every Local Workspace** (`workspaces/<id>/`: `workspace.sqlite`, its key file and, since M13, its `backups/`), the unpacked web UI (`web/`), and what the page keeps (your sign-in to a Team Workspace, the web view's storage and cache). `$XDG_DATA_HOME` moves it.

To forget everything, Local Workspaces included, which exist nowhere else: `rm -rf ~/.config/app.qoop.desktop ~/.local/share/app.qoop.desktop`.

**The menu** is a bar in each window with two menus: **Infall** (Switch Workspace…, Runner settings…, Quit (Ctrl+Q)) and **Edit** (Undo and Redo, greyed out unless the page names a step; no keyboard shortcuts on Linux, so Ctrl+Z reaches text fields — the page handles it). GTK cannot draw most of the items the macOS menu has (it would show them greyed out, Quit included), so on Linux they are left out (`build_menu` in `src/shell.rs`); copy and paste work from the keyboard and the page's own context menu.

### What the Runner does and does not do on Linux

Read in the source, and where it says so below, seen working in the installed package on Ubuntu 24.04 (arm64) in a container. All of the Runner's process handling is the same Unix code as on macOS.

- **Finding Python.** The same lookup as on macOS: `python3` and `python` on the `PATH` your shell gives (`$SHELL -l -i -c …`, then `-l -c`, then the app's own environment; without `$SHELL`: `/bin/zsh`, `/bin/bash`, `/bin/sh`, whichever exists first), then `~/.pyenv/shims`, `/opt/homebrew/bin` (never there on Linux, harmless), `/usr/local/bin`, `/usr/bin`. Seen: Runner settings listed Ubuntu's `/usr/bin/python3` (3.12.3), and saving the choice wrote `runner.json`. pyenv, conda and virtual environments are found if your shell puts them on `PATH`, exactly as on macOS; that was not tried on Linux.
- **Running and stopping.** A Run is started in a process group of its own; Cancel sends `SIGTERM` to the group, then `SIGKILL` after half a second; when a Run ends, whatever it left running in its group is killed. Seen: an approved Run printed its output, reported `os: linux`, and the `sleep 600` it had started was killed when it ended. The same limits as on macOS hold: a program that moves itself into another session (`os.setsid`) escapes, and if the app is killed hard, a Run in progress keeps running.
- **Usage figures in the Runner monitor.** Processor and memory work: the processes of the Run's group come from `ps` (`/bin/ps` or `/usr/bin/ps`, package `procps`), processor time from `/proc/<pid>/stat`, total memory from `/proc/meminfo`, cores from the system. Seen: about one sample a second with `cpu_percent` near 100 for a busy loop, `memory_bytes`, `processes: 2`. Without `ps` (a minimal system without `procps`) there are no samples at all, and the Run is otherwise unaffected. `cores` is the number of processors the app may use, which inside a container or under a CPU limit is less than the computer has.
- **Graphics processor.** Only NVIDIA, and only if `nvidia-smi` is on the `PATH` your shell gives: then the busiest card's utilisation and name are shown (the parser is tested against written-down answers, not against a real card). AMD and Intel graphics have no figure: the monitor simply shows none. Memory of the graphics card is not shown on any platform.
- **Figures, output, approval, the temporary folder (`0700`, files `0600`, links not followed)** are the same code as on macOS. The temporary folder is under `$TMPDIR` or `/tmp`.
- Not adapted to Linux: the two example texts in the Runner settings window (`/opt/homebrew/bin/python3`, `/Users/you/research`) are the macOS ones. They are only greyed-out examples.

## What is where: Tauri mechanisms used

Tauri **2.12.7** (`tauri-build` 2.7.6, `wry` 0.57.3). Version 3 exists only as an alpha and is not used.

| Need | Mechanism |
|---|---|
| Show the server's UI | The main window is created at run time with `WebviewUrl::External(<origin>)`. There are no windows in `tauri.conf.json`. |
| Start screen | A second, local window (`setup`) showing `desktop/ui/index.html`, with its own static capability (`capabilities/setup.json`): it may call M12's `start_view`, `workspace_create`, `workspace_connect`, `workspace_open`, `workspace_rename`, `workspace_remove` and M13's `workspace_export`, `workspace_import`, `workspace_reveal`, nothing else. |
| Approval window, Runner settings window | Local windows too (`runner-approval-<ticket>` showing `approval.html`, `runner-settings` showing `runner.html`), each with its own static capability (`capabilities/runner-approval.json`, `runner-settings.json`) that names only its own commands and only its own window labels. |
| Give the bridge to one origin, known only at run time | `build.rs` declares the app's commands in an app manifest, so each has a permission (`allow-claude-send`, …) and nothing may call a command without a capability. When the main window is created, the app adds a capability **at run time**: `app.add_capability(CapabilityBuilder::new("qoop-bridge").remote("<origin>/*").window("main").permission("allow-claude-status")…)`. Tauri checks the calling page's URL against it on every call. |
| Stream from Rust to the page | A Tauri `Channel<AiEvent>` passed to `claude_send`. No event-plugin permission is granted to the page. |
| Put `window.qoopDesktop` on the page | `WebviewWindowBuilder::initialization_script`, which runs in the **main frame only** (the all-frames variant is a separate method and is not used). |
| Keep the window on one origin | `on_navigation`: the configured origin (and `about:blank`, `about:srcdoc`, same-origin `blob:`) is allowed; everything else is refused and **nothing is opened** (a script in any frame can start a navigation). `on_new_window` (links with `target="_blank"`, which a sandboxed frame cannot use): always refused in the app and opened in the system browser, at most once every two seconds. |
| Open the system browser | `tauri_plugin_opener::open_url` called from Rust. The plugin is **not** registered with the app, so it adds no commands that a page could call. |

Every mechanism in this table was confirmed by reading the source of exactly these versions in the local cargo registry (`tauri-2.12.7/src/webview/mod.rs` for the access check of remote pages and the main-frame-only scripts, `src/ipc/protocol.rs` and `src/ipc/channel.rs` for the IPC and channel wire format, `src/ipc/capability_builder.rs`, `wry-0.57.3/src/wkwebview/` for what macOS reports about frames and navigations), and then by running it (see the smoke run below). The matching documentation pages: [Capabilities, including remote API access](https://v2.tauri.app/security/capabilities/), [Calling Rust: channels](https://v2.tauri.app/develop/calling-rust/#channels), [`Manager::add_capability`](https://docs.rs/tauri/2.12.7/tauri/trait.Manager.html#method.add_capability), [`CapabilityBuilder`](https://docs.rs/tauri/2.12.7/tauri/ipc/struct.CapabilityBuilder.html), [`WebviewWindowBuilder`](https://docs.rs/tauri/2.12.7/tauri/webview/struct.WebviewWindowBuilder.html), [`tauri_build::AppManifest`](https://docs.rs/tauri-build/2.7.6/tauri_build/struct.AppManifest.html).

## How the bridge is scoped

The server's pages are remote content and get no general access to the app. Layers, outermost first:

1. **Only eleven commands, only one origin, only the main window.** The run-time capability above grants `claude_status`, `claude_send`, `claude_cancel`, for the Runner `runner_status`, `runner_configure`, `runner_run`, `runner_cancel` (and since M19/M19b `runner_start`), since M12 `switch_workspace`, since M13 `save_file` (`saveFile`: the system's save dialog, at most 20 MB of text; the page never chooses the path) and `print_page` (on macOS, where the web view ignores `window.print()`, the bridge script makes `window.print()` call it), and since M15 `undo_state` (the bridge script tells the Edit menu what the page's Undo and Redo would do; not part of `window.qoopDesktop`), to `<origin>/*` in window `main` (plus Tauri's own two for moving and zooming the window from the page's top row). The origin is the open Workspace's: a team's server, or a Local Workspace's `http://127.0.0.1:<port>`. For remote pages Tauri refuses every command that no capability grants, so the setup commands, the approval and settings commands and every plugin command (events, windows, …) are refused.
2. **Top frame only.** Tauri's own IPC bootstrap (`window.__TAURI_INTERNALS__` and the per-run "invoke key" that every call must carry) and the bridge script are injected in the main frame only. A frame gets neither. The Visual sandbox frame (`/visual-frame`, `sandbox allow-scripts`) has an opaque origin, so it cannot reach into its parent to borrow them.
3. **A second key of the app's own.** The bridge script holds a random key (new on every start) in a closure and sends it with each call; the commands refuse calls without it (`bridge::check_caller`). This does not depend on Tauri's invoke key.
4. **A check inside every command**: the call must come from window `main` while that window's page is on the configured origin.
5. **The request is checked** before anything starts (`bridge::validate`): `tools.url` must be exactly `<configured origin>/mcp`, so Claude Code can only be pointed at the tool endpoint of the server the window shows; `resume` must look like a session id; sizes are bounded.
6. The bridge script itself returns early unless `window.top === window` and `location.origin` is the configured origin. `window.qoopDesktop` is frozen and cannot be replaced.

Known limits, stated plainly:

- **Tauri does not tell a command which frame called it.** On macOS the low-level message channel (`window.webkit.messageHandlers.ipc`) exists in every frame, and Tauri then sees the frame's URL, which for `/visual-frame` is on the configured origin. What stops a frame is that it has neither Tauri's invoke key nor the bridge key (layers 2 and 3). This was observed in a smoke run: a message posted from the sandboxed frame was dropped by Tauri for a wrong invoke key. (Tauri then prints the expected key on the app's standard error; that is Tauri's behaviour, and the page cannot read it.)
- **A run-time capability cannot be removed.** When a second Workspace is opened in the same run of the app, the app restarts itself and opens it then, so that only the new origin holds the grant (a run of the app grants the bridge to one origin only; each Local Workspace has a port of its own, so two Local Workspaces never share an origin).
- **A script in any frame can start a navigation**, and Tauri's navigation callback only gets the URL, not the frame. So navigations to other sites are refused without opening anything; only `target="_blank"` links (which the Visual sandbox cannot produce) reach the system browser.
- The server address must be `https://…`, or `http://` only for `localhost` and `127.0.0.1`, with no user name, password or path; the health check does not follow redirects.

## Undo and Redo in the Edit menu (M15)

The contract is [desktop.md, M15](../docs/specs/desktop.md#m15--undo-in-the-edit-menu). In short:

- **The keys are the page's.** The web UI handles Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z and Ctrl+Y as in a browser. It calls `preventDefault()` whenever it acts, and leaves the key alone in a field being edited. The menu takes no key it did not take before: ⌘Z and ⇧⌘Z on macOS, Ctrl+Z and Ctrl+Y on Windows, none on Linux.
- While the main window has focus and its page's `window.__infallUndo.state()` names a step, Undo and Redo are the app's own items, titled with it ("Undo Move 3 Cards"), and they call the page's `undo()` or `redo()`. Otherwise they are the system's own items, as before (macOS, Windows), or greyed out (Linux, where the menu bar now also has an **Edit** menu with these two items).
- The bridge script posts the page's state with `undo_state`, under the bridge's checks. The app only reads it.
- Where: `src/bridge.rs` has the rules (titles, which item, the script a click runs) and their tests. `src/bridge.js` watches the page. `EditMenu` in `src/shell.rs` swaps the items.
- Seen on macOS against a fake page: titles that follow the page, and one `undo()` or `redo()` per menu choice. Not yet seen: a real ⌘Z in a frontmost window, text undo in a field, Windows, Linux. Details are in the contract.

## How a run is executed

`qoop-claude-driver` starts `claude` directly with an argument vector (never through a shell), in its own process group, with this command line:

```
claude
  --print
  --output-format stream-json
  --include-partial-messages
  --verbose
  --input-format text
  --strict-mcp-config
  --mcp-config <work folder>/mcp-<pid>-<n>-<n>.json
  --tools ""
  --allowedTools mcp__qoop__list_branches,mcp__qoop__list_cards,mcp__qoop__get_card,mcp__qoop__list_connections,mcp__qoop__list_sources,mcp__qoop__list_suggestions,mcp__qoop__suggest_source,mcp__qoop__suggest_connection
  --permission-mode dontAsk
  --permission-prompts none
  --setting-sources ""
  --disable-slash-commands
  --no-chrome
  --append-system-prompt=<system>
  [--resume=<session id>]
```

with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` added to the environment, the prompt written to standard input, and the working directory set to an empty folder.

| Flag | What it is for |
|---|---|
| `--print` | Answer and exit; no interactive session. With nothing after the options, the prompt is read from standard input. |
| `--output-format stream-json` | One JSON event per line. |
| `--include-partial-messages` | Text arrives as it is written (→ `delta`). |
| `--verbose` | Older versions required it with `stream-json` in print mode. 2.1.265 does not mention it; it is kept for those. |
| `--input-format text` | The prompt on standard input is plain text (the default, made explicit). |
| `--mcp-config <file>` | The Infall tool endpoint: `{"mcpServers":{"qoop":{"type":"http","url":"<origin>/mcp","headers":{"Authorization":"Bearer <token>"}}}}`. The **token is only in this file**, never on the command line. The file is created with mode `0600` in a `0700` folder and deleted when the run ends, however it ends. |
| `--strict-mcp-config` | Only the servers in that file; the Member's own MCP servers are not loaded. |
| `--tools ""` | **Disables every built-in tool** (shell, file read/write/edit, web fetch, sub-agents, …). |
| `--allowedTools mcp__qoop__…` | The eight Infall tools may run without a permission prompt. |
| `--permission-prompts none` | Anything that would ask for permission is refused: nobody is there to answer. |
| `--permission-mode dontAsk` | The permission mode that does not ask. Together with the line above: what is not on the allow list does not run. |
| `--setting-sources ""` | Loads none of the user, project and local settings files, and so none of the hooks, plugins, permissions and environment they configure. |
| `--disable-slash-commands` | No skills or custom commands. |
| `--no-chrome` | No browser integration. |
| `--append-system-prompt=<system>` | The web UI's system text, appended to the default system prompt. Attached with `=` so the text can never be read as an option. |
| `--resume=<id>` | Continue the session of an earlier `done`. Only when given. |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | Do not load `CLAUDE.md` memory files (user and project instructions). |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Do not use Claude Code's automatic memory. |

Deliberately **not** used:

- `--bare`: it would switch off everything, but also the Member's login (it only accepts an API key), which is the whole point.
- `--safe-mode`: it also drops the servers given with `--mcp-config` (seen in the code of 2.1.265: in safe mode only SDK-type servers are kept), so the Infall tools would be gone.
- `--no-session-persistence`: `resume` needs the session on disk.
- `--dangerously-skip-permissions` or any bypass mode: never.

**The working directory.** It is `<temp dir>/qoop-desktop-claude-<uid>/cwd`: emptied before and after every run, owner-only, so every run starts in a fresh empty temporary directory, but **at the same path**. The path is kept stable on purpose: Claude Code stores sessions per working directory, and `--resume` would not find a session started in a differently named folder. The folder above it must be a real directory owned by the user (a symlink or someone else's folder is refused).

**What could not be switched off.** Administrator-managed (policy) settings of Claude Code always apply, including hooks set there. Claude Code's own start-up work (update check, telemetry, its session files under `~/.claude`) is left alone: the app does not manage the Member's Claude Code.

**Ending a run.** One run at a time. `cancel` asks the process group to stop (`SIGTERM`), waits up to 1.5 s, then kills the group (`SIGKILL`); the same happens after 120 s without any output (then with an `error` event), when the page is reloaded, when the window closes and when the app quits. After a normal result the process gets 3 s to exit by itself. A cancelled run delivers no further event; `send` then resolves.

**Events.** `delta`: text deltas. `tool`: the tool name without the `mcp__qoop__` prefix. `done`: the result line, with the session id and the model. `error`: a failed result (Claude Code's own sentence, bounded, with the token removed should it ever appear), an exit without a result, the silence timeout, or a start failure. Lines that are not JSON or have an unknown type are ignored.

The app never reads or stores Claude credentials. Its own network requests are the health check of a Team Workspace's address and, in a Local Workspace, what the server inside it does for the Workspace: the same as a team's server, which means only the OpenRouter path of the AI sidebar, once a key has been added there, and since M13 **Look up**, which asks Crossref or arXiv about one DOI or arXiv id when it is pressed ([privacy](../docs/privacy.md)).

## The Runner

A Run is a block of Python in a Page together with the output captured the last time someone executed it. The Runner is what executes it: on the Member's own computer, with the Member's own Python. The server never executes anything; the page receives the result from the app and records it through the server like any other edit.

What the server's page can do (`window.qoopDesktop.runner`): read which interpreter and folder are set (`status`), ask for the app's settings window (`configure`), ask for a Run of some code (`run`), and cancel that Run (`cancel`). It cannot choose the interpreter or the folder, and it cannot approve anything.

What happens on `run({ id, code, title }, onEvent)`:

1. **Is there a Python?** The interpreter is the one chosen in **Infall → Runner settings…**. Nothing is chosen until the Member chooses: the first Run opens that window, and gets `error`/`no_python` if it is closed without a choice.
2. **Approval.** If exactly this code (by SHA-256) was approved before for this Workspace, it goes straight on. Otherwise the page gets `approval` and the app opens its own window: the Run's title, the Workspace, the interpreter, the folder, and the complete code with line numbers. "Don't run" is the default button; closing the window, Escape, and the page going away all mean "Don't run" (`error`/`declined`). "Run on this computer" becomes available once the code has been scrolled to its end and has been on screen for a second.
3. **Execution.** The approved text is written to `main.py` in a new temporary directory (mode `0700`, files `0600`) and started as `<python> -u -X utf8 runner.py main.py` in a process group of its own. The working directory is the folder from the settings, or the temporary directory. The environment is the Member's shell environment plus `MPLBACKEND=Agg`, `PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8` and `QOOP_RUN_DIR`. The page gets `started`, then `output` events (at most about ten a second, each at most 16 000 characters), then `done`.
4. **Afterwards** the temporary directory is removed and whatever the code left running in its process group is killed.

`runner.py` (bundled in the app, standard library only) runs the code as `__main__`: tracebacks say `File "main.py", line N` with the right numbers and lines, `sys.exit(n)` gives exit code `n`, the working directory is first on `sys.path`. The code is always read as UTF-8 and compiled from text, so an encoding declaration inside it cannot make Python read something else than what was shown. When the code ends, normally or not, `runner.py` saves the matplotlib figures that are still open (only if the code itself imported `matplotlib.pyplot`): the first three, as PNG, with fewer dots per inch if a file would be over 120 000 bytes (160 000 base64 characters), and one `[qoop] …` line in the output for each figure it had to leave out. It also notes the Python version and the versions of the packages the code imports and of what those require directly (at most 32, M19), and adds `[qoop] This environment has no package <name>.` when the code stops on a package that is not installed. `plt.show()` does nothing in a Run (there is no screen); leave figures open and they are captured.

The result (`done`): exit code (`null` if stopped or killed by a signal), `stopped`, duration, the SHA-256 of the executed code, the output, the figures, and `env` (Python version, packages, `os`, `arch`). Standard output and standard error share one pipe, so their order is kept. The kept output is at most 64 000 characters (counted in UTF-16 units, so the limit holds however a reader counts): beyond that, the first and the last 32 000 are kept with one line in between saying how much is not shown, and `output_truncated` is set. Bytes that are not UTF-8 become U+FFFD.

There is **no time limit**. `cancel(id)` asks the process group to stop (`SIGTERM`), waits half a second, then kills the group (`SIGKILL`): `done` with `stopped: true`, `exit: null`, the output so far, no figures. Closing the main window, reloading or leaving the page, "Switch Workspace…" and quitting the app do the same. One Run at a time per app, counted from the moment it is asked for (`error`/`busy` otherwise; a Run asked for right after a cancel waits up to four seconds for the old one to be gone).

**Runner settings** (app menu, or `runner.configure()` from the page; kept in `runner.json` in the app's config directory, per device):

- *Python*: the interpreters found as `python3` or `python` on the `PATH` of the Member's shell, and in `~/.pyenv/shims`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`. Each is asked what it really is (so a pyenv shim is listed as the interpreter behind it) and listed once. Or the full path of another one, accepted when `<path> --version` answers `Python 3.…` within five seconds.
- *Folder* (optional): typed as a path; must be an existing directory.
- *Approvals*: how many are remembered, and a button to forget them all.

The shell's environment is read once per start of the app by running `$SHELL -l -i -c` (then `-l -c`, then the app's own environment). The contract says "the way a login shell would"; the interactive flag is added because many set-ups, the machine this was built on included, put pyenv or conda into the file that only interactive shells read.

**Environments and languages (M19, M19b).** A Run may name a Python environment (`env`) and a language (`lang`); the page asks with `runner.start`, which an older app does not have, so an older app refuses a Julia Run instead of running it as Python. Which environment a name means and which program a language starts is set in Runner settings, per device: conda environments, pyenv versions and the folder's `venv`/`.venv` are found by looking at the file system, others are added by hand; a name nobody chose yet opens the settings window once, and the answer is kept. Q# runs through the default Python's `qdk`; Julia, R, JavaScript (node) and Shell (bash; on Windows only Git for Windows' bash) are presets; any other language is a program, its arguments with `{file}`, and an extension. The approval window names the language, the environment and the exact command, and an approval holds only for that language and that interpreter or program. The contract, with exact shapes: docs/specs/desktop.md, "Environments and Toolchains — as built".

`QOOP_PYTHON_BIN=/path/to/python` overrides the chosen interpreter (for tests and smoke runs). It does not touch approval. **Nothing switches approval off**: no environment variable, no flag, no debug build. Tests approve through the same Rust calls the approval window makes.

## The Runner's security model, in plain words

**What you are protected from.** Code in a Run may have been written or changed by someone else, and the page that asks for it to be run is remote content. Neither can make anything run on your computer by itself:

- **Code runs only after you said yes to exactly that code**, in a window that belongs to the app. The page cannot draw that window, read it, click in it, or answer for you: the commands behind it are granted only to that window (Tauri capability), are checked again inside each command (window label and the app's own bundled page address), and the question a window can answer is fixed by its label. This was tried from a page in the smoke run: every such call was refused.
- **What you see is what runs.** The app hashes and writes out the very text it displayed. Characters you could not see (zero-width, direction controls, control characters, unusual spaces, and so on) are drawn as marked codes such as `U+202E`, and a notice says so. Text is drawn strictly left to right in file order, so right-to-left text cannot rearrange code. Long lines are wrapped, never cut. Lines are numbered the way Python counts them. Titles and code are shown as text, never interpreted as HTML.
- **A changed Run asks again.** Approval is remembered per Workspace and per SHA-256 of the code (`runner-approvals.json` in the app's config directory, newest 1 000). One changed character, by anyone, including you, is new code.
- **The page cannot choose where code runs.** Interpreter and folder come only from the settings window. The request has no field for them.
- **An accidental yes is hard.** "Don't run" has the focus; Enter, Escape and closing the window all decline; "Run" is refused by the app until the window has had the code for a second, and stays disabled until you have scrolled to the end.
- **Size is bounded.** Code over 100 000 characters is refused without a question.

**What you are not protected from. Read this part.**

- **There is no sandbox.** Approved code runs with your own rights: it can read, change and delete your files, use the network, and start other programs. Approval is the only barrier. Read the code.
- **A remembered approval is permanent until the code changes or you forget it.** After you approved some code once, the server's page can run that same code again, at any time and any number of times, without asking. If the server or the page is compromised, it can replay everything you ever approved, though only that. The approval does not record the interpreter or the folder: code approved while Runs used a temporary folder runs without a question in a folder you set later. Use "Forget them" in Runner settings when in doubt.
- **Look-alikes.** Letters from other alphabets that look like Latin ones, and Unicode letters that Python treats as the same as ASCII ones, are visible but not flagged. Code can also simply be misleading. The window shows the truth; it cannot read for you.
- **Nagging.** A page can ask again after you declined, as often as it likes, and can open the settings window. Every question still needs your yes.
- **The page learns** the path of your interpreter and folder (`status`), and everything the code prints or draws: the result goes to the server, to be shown to the team.
- **Your environment is passed on.** The code gets the environment of your shell, including any secrets you keep in environment variables.
- **A program can escape the stop.** Cancel kills the process group. A program that deliberately moves itself to another session (`os.setsid`, a daemon) is no longer in it. And if the app itself is killed hard (`kill -9`, a crash), a Run in progress keeps running.
- **Other programs running as you** can edit the app's files in its config directory (for instance add approvals). They already have your rights.

## Tests

`cargo test` in `desktop/src-tauri` runs:

- `driver` unit tests: the event mapping, the exact argument vector, the config file contents, redaction.
- `driver/tests/stub.rs`: the driver against `driver/tests/stub-claude.sh`, a shell script that records its arguments, standard input, working directory, environment and the MCP config file it was given, and prints canned streams (an answer with a tool call, an error, garbage lines, a crash, a hang, a process that ignores `SIGTERM`, one that lingers after its result). They assert: the token is in the file and not in the arguments; the file is `0600`, outside the working directory, and deleted afterwards; built-in tools are off and only the eight tools are allowed; the working directory is empty and emptied again; cancel stops the process and its child; the silence timeout (injected, short) ends the run; events map as specified.
- app unit tests: server address rules, the embedded server's origin, health check against a local socket, navigation rule, who may call the bridge and the commands of the app's own windows, request validation, the Edit menu's Undo and Redo (titles from the page's labels, which item when, the script a click runs), the list of Workspaces (making, naming, removing, the earlier `config.json`, damaged files), the Member's name, unpacking the embedded web UI.
- `runner` unit tests: the approval gate (nothing without a yes, remembered per server and hash, the newest 1 000, changed code asks again, decline, window closed, an answer only counts for the question it was given to, a yes that comes at once does not count), what the approval window is given (lines as Python counts them, invisible and direction characters, long lines, titles), settings, interpreter checks and lookup (with small stand-in programs), the shell environment, output handling (split multi-byte characters, non-UTF-8 bytes, head and tail, event spacing), and the checks on what a program leaves behind (links, sizes, PNG signature).
- `runner/tests/real_python.rs`: the Runner **against a real Python interpreter**, nothing stubbed; the "Member" answers through the same calls the approval window makes. Output and its order, exit codes, tracebacks, `SystemExit`, Unicode, truncation, event rate, a matplotlib figure captured as a real PNG, more than three figures, a figure too large, packages, cancel killing a child and grandchild of the code, a program that ignores `SIGTERM`, busy, the settings flow, the folder, an encoding declaration that tries to smuggle code in, programs that sabotage their own process.

  Which interpreter: `QOOP_TEST_PYTHON=/path/to/python3` if set; otherwise the first one the Runner's own lookup finds that has matplotlib, otherwise the first it finds. With none, each of these tests prints `SKIPPED: no Python 3 interpreter was found` and passes; without matplotlib the five figure tests print `SKIPPED: … has no matplotlib`. See the lines with `cargo test -- --nocapture`. Run here against 3.12.13 (with matplotlib 3.10.9: all 30 run) and against the system's 3.9.6 (no matplotlib: 25 run, 5 skipped).
- `runner/tests/real_toolchains.rs`: a Run naming a conda-like environment (a real venv in a fixture tree) runs there and is asked again in another interpreter; a name the device lacks is asked once and remembered; a fake language (a shell script) gets exactly its arguments, `{file}`, no Python variables, its figures and version; a language not set up is asked for and never run as Python; the presets' real programs that exist here (node and bash on the build machine; Julia and R skipped); the 13 Q# samples of docs/specs/qsharp-check.md, stopping an endless Q# loop, and the install sentences. Q# uses `QOOP_TEST_QSHARP_PYTHON` if set, else the test Python when it has `qdk`; run here with qdk 1.28.0 (pyenv 3.12.13) and with qdk 1.34.0 in a throwaway venv.

No test starts the real `claude`.

**Continuous builds** (M16, `.github/workflows/`): on every push and pull request, `ci.yml` runs these tests on Ubuntu, macOS and Windows, plus the server's and the web UI's suites, and `package.yml` builds every installer with the scripts above (macOS arm64 and x64, Windows x64 cross-compiled on Ubuntu, Ubuntu amd64 and arm64 with the script's checks) and keeps them as artifacts. **They have never run**: the repository has no remote yet. What they do and how they were checked is in docs/specs/release.md, section 9.4.

## Unverified against a real run

Nothing here has been run against the real `claude`: doing so would have spent the owner's subscription. The flags were read from `claude --help` (2.1.265); a few facts were read from the program's bundled code. The following are assumptions and must be checked with one real turn before relying on M7:

1. **The shape of the `stream-json` output.** `--help` does not specify it. The parser assumes, from the Claude Code SDK's documented message types:
   - `{"type":"system","subtype":"init","session_id":…,"model":…}` at the start;
   - with `--include-partial-messages`, `{"type":"stream_event","event":{…}}` lines wrapping API stream events: `content_block_delta` with `delta.type == "text_delta"` (→ `delta`), `content_block_start` with `content_block.type == "tool_use"` and a `name` (→ `tool`), `message_start` with `message.model`;
   - complete `{"type":"assistant","message":{"content":[…]}}` lines, used for text and tool calls only if no `stream_event` was seen;
   - a final `{"type":"result","subtype":"success"|"error_…","is_error":bool,"result":"…","session_id":"…"}` (→ `done` or `error`).
   If a real stream differs, text or tool events may be missing; unknown lines never break a run.
2. **`--tools ""` together with `--allowedTools mcp__qoop__…`** leaves the MCP tools usable while all built-in tools are gone. The help text says `--tools` is about "the built-in set", which is why MCP tools are expected to remain.
3. **`--permission-mode dontAsk` with `--permission-prompts none`** runs allow-listed tools and refuses the rest, without stalling.
4. **MCP tool names** are `mcp__qoop__<tool>` for a server named `qoop`, and the `http` server entry with a `headers` object is accepted by `--mcp-config`.
5. **`--setting-sources ""`** is accepted as "none" (read in the code of 2.1.265), and the two environment variables do what their names say (they occur in the code; their effect was not observed).
6. **Plugins and hooks** that reach Claude Code some other way than the three settings files (for example from administrator policy) are not switched off.
7. **`--resume`** finds the session from the stable working directory, and a resumed run keeps the same restrictions.
8. **The prompt on standard input** is taken as the whole prompt in print mode.
9. **`--verbose`** is harmless on versions that no longer need it.
10. **Not signed in**: what Claude Code prints then is unknown; the app shows its error sentence if it sends an error result, otherwise "Claude Code stopped before finishing the answer".

Other things not verified:

- **Clicking through the start screen** on macOS: nothing here could press its buttons (see "Unverified: Workspaces on this computer").
- **Opening the system browser**, the **Switch Workspace…** menu item and the restart into a second Workspace, and **stopping a run when the app quits** were not exercised on macOS (the code paths are simple; the kill itself is tested in the driver).
- **Linux and Windows.** In M7 only macOS (Apple Silicon) was built and run. Since M11 there are packages for both; what was checked on each, and what the code does differently there, is in "The Ubuntu package", "The Windows installer" and their "Unverified" sections. Signing and auto-update are still not there.
- If the app itself is killed hard (`kill -9`, a crash), a running `claude` is not stopped by it; it ends by itself.
- If the saved server does not answer when the app starts (within four seconds), the app opens its local screen instead of the main window, saying "Infall could not reach your server", with the saved address filled in: **Connect** tries again. (Until M11 the main window stayed blank.) A server that goes away while the app is open is not noticed by the app; the web UI says it is not synced.

What was verified in a short smoke run of the debug build on macOS, against a local fake server sending the real server's Content-Security-Policy headers, with the stub `claude`: the window opens the configured origin; `window.qoopDesktop` exists in the top frame, is frozen, and reports the app version; `status()` returns the stub's version; `send()` delivers `delta`/`tool`/`done` in order and resolves after the last event; a second `send` during a run gets an `error`; `cancel()` stops a hanging run and its child process and `send` resolves; a request naming another tool endpoint is refused; calls with a wrong key, the setup commands and plugin commands are refused from the page; the sandboxed `/visual-frame` has neither `window.qoopDesktop` nor `window.__TAURI_INTERNALS__`, cannot read its parent, and its direct message to the IPC channel is dropped; a frame that loads while a run is streaming does not interrupt the run. The release build (`--features custom-protocol`) was started the same way and behaved the same.

## Unverified: the Runner (M8)

Verified by a smoke run of the debug build on macOS (Apple Silicon), against a local fake server sending the real server's Content-Security-Policy, with an isolated home folder, `QOOP_PYTHON_BIN` pointing at a real Python 3.12 with matplotlib, and two approvals placed in the app's approvals file beforehand (as an earlier yes would have): `window.qoopDesktop.runner` exists, is frozen, has `status`, `configure`, `run`, `cancel`; `status()` reports the interpreter; an approved Run delivers `started`, `output`, `done` in order with Unicode output, one PNG figure, packages and `env`; a second Run during the first gets `busy`; `cancel()` stops a Run (`stopped: true`); code over the limit gets `failed`; code not approved before gets `approval`, the app's approval window opens, loads its bundled page and reads the code through its own command; while it is open, the page's direct calls to the approval and settings commands (with and without a key) are all refused by Tauri, and bridge calls with a wrong key are refused by the app; after the page cancels, the Run ends `declined` and the code never ran; a reload during a Run kills its process, and the reloaded page can run again at once; `configure()` opens the settings window, which loads and lists the interpreters found.

Not verified:

1. **Nobody clicked in the two windows inside the real app.** No tool here could press buttons in the app (the operating system did not grant control of it). So "Run on this computer", "Don't run", closing the approval window, and choosing and saving in the settings window have not been operated in the app's own webview. What stands behind them was tested separately: the pages' behaviour in a browser (Chromium) with a stand-in for the app (text is never interpreted as HTML, the Run button stays off until the end of the code and the wait, Escape declines, errors show), and the Rust behind each button in the tests above. **Before relying on M8, approve one Run and decline one by hand.**
2. **The look of the windows in the app's own webview** (WebKit): layout, dark mode, how marked characters and wrapped lines are drawn, whether the approval window comes to the front and stays on top.
3. **Quitting the app during a Run**, closing the main window during a Run, and the menu item were not exercised in the running app (the kill itself is tested; the page-reload path, which uses the same call, was exercised).
4. **Python 3.8.** The contract says 3.8 or newer; `runner.py` was run on 3.9.6 and 3.12.13 only.
5. **Linux and Windows.** Not built in M8. M11 built both and gave Windows its own code where the Unix paths do not apply (a job object instead of the process group, its own Python lookup, no-follow file reads); file modes still do not apply there. That Windows code has compiled and never run: see "Unverified: the Windows installer".
6. **Other shells than zsh** for reading the environment (fish, csh), and shell start-up files that wait for input: after eight seconds the app gives up on the interactive shell and tries the plain login shell, then its own environment.
7. **conda and virtual environments** in the interpreter list: the lookup logic is tested with stand-ins; only pyenv and the system Python were found for real.
8. **Very large or unusual figures** beyond the tests (animations, 3D, non-Agg backends set by the code).

## Unverified: the macOS package (M10)

Verified on the machine it was built on (Apple silicon, macOS 26.5): the script runs from the working tree to a `.dmg`; `codesign --verify --deep --strict`, `plutil -lint` and `hdiutil verify` pass; the image holds `Infall.app` and the link to `/Applications`; the program's oldest macOS is 11.0 (`vtool -show-build`) and it has no entitlements; the app copied out of the image starts from the Finder's launcher (`open`) with an isolated home folder, stays up and logs nothing, and writes its data only inside that home; started with a saved address of a local stand-in server over plain `http://localhost`, its main window loaded the page and `window.qoopDesktop` was there with version 0.1.0. `spctl --assess --type execute` says **rejected**, as it does for every ad hoc signed app: that is the verdict behind the first-start warning.

Not verified:

1. **The first-start warning itself and the way past it.** No copy carrying the download mark was opened here, so neither the warning nor the Privacy & Security step was seen on screen. The steps above follow Apple's help page for macOS 26 (read on 2026-11-23); the exact sentence of the warning, and whether the confirmation asks for a password or Touch ID, are not confirmed; the Control-click route for macOS 14 and older was not checked against anything. **Before handing the package out, download it once the way a Member will and walk the steps.**
2. **Any other Mac.** Not started on another computer, on macOS 11 to 15, or under another account. 11.0 is what the build declares, not something that was tried. Intel Macs cannot run this package at all.
3. **Dragging to Applications** in the Finder, and how the icon looks in the Dock, the Finder and the disk image window (the image has no background or arranged layout).
4. **A build from a truly clean checkout.** In M12 the script was run in a copy of the working tree without `target/`, `web/node_modules` and `web/dist` (every crate compiled from nothing, the web UI installed with `npm ci`), but with cargo's and npm's downloads already on this Mac, and not from a fresh clone.
5. **Installing a new version over an old one**, and the app's restart into a second Workspace when it runs from `/Applications`.
6. Nobody clicked anything in the packaged app (see the Runner's list above; the same holds here).

## Unverified: the Windows installer (M11)

**Infall has never been started on Windows.** Not the installer, not the program, not on any version. There was no Windows machine and no emulator where it was built. Everything a Member would see is therefore unverified, and the first person to run it is the test.

Verified on the Mac that built it (Apple silicon, Rust 1.96, Homebrew mingw-w64 and makensis 3.13): the script runs from the working tree to `dist/Infall-0.1.0-x64-setup.exe` (3.0 MB); `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings` is clean; the program is a PE32+ x86-64 file of the Windows GUI subsystem with the icon, the version information (`ProductName` Infall, `FileVersion` 0.1.0) and the Common Controls manifest inside; its import table names only Windows' own DLLs and `WebView2Loader.dll` (`ADVAPI32`, `KERNEL32`, `ntdll`, `bcrypt`, `bcryptprimitives`, `WS2_32`, `combase`, `comctl32`, `dwmapi`, `gdi32`, `imm32`, `ole32`, `oleaut32`, `shell32`, `shlwapi`, `user32`, and the Universal CRT's `api-ms-win-crt-*` and two `api-ms-win-core-*`), nothing of the compiler's; `makensis` reports the installer's contents as `Infall.exe`, `WebView2Loader.dll` and the uninstaller, with the registry values and the shortcut named above, and the uninstall section deleting exactly those; the installer is a PE32 program asking for the invoker's rights. No tool here could open the finished installer to list it independently (`7z` is not installed); the list is what `makensis` said it packed.

In M12 the script was run again (once, before the start screen's caller check in `src/bridge.rs` was fixed; not since), in a copy of the working tree without `target/`, `web/node_modules` and `web/dist`, on the same Mac without cmake or nasm: the web UI built, the program with the server inside compiled and linked (`dist/Infall-0.1.0-x64-setup.exe`, 7.0 MB; `Infall.exe` 20 MB), it holds the web UI, and its import table adds `crypt32` (the TLS library reading Windows' certificate store) and one more `api-ms-win-core-*` to the list above, all part of Windows. `cargo clippy` for Windows was not run again.

Not verified, in the order it would be met:

1. **That the installer runs at all**, what SmartScreen really shows for this file (the words above are Windows' usual ones for an unsigned download, not something seen for Infall), and whether antivirus software objects to an unsigned NSIS installer, as some do.
2. **The WebView2 check**: the registry places are Microsoft's documented ones; the question was never seen, on a computer with or without the runtime.
3. **That the program starts.** A Rust program for `x86_64-pc-windows-gnu`, linked by Homebrew's mingw-w64 against the Universal CRT, loading `WebView2Loader.dll` from its own folder: each part is ordinary, the combination was only linked here, never run. If it does not start, nothing below matters.
4. **Every window**: the start screen, the server's pages in WebView2 (the bridge reaches the app through `http://ipc.localhost` or Tauri's fallback when the page's security policy forbids that; neither was seen working), the approval window, Runner settings. The menu is a bar in each window on Windows; some of its predefined items (Hide, Services, …) do not exist there and what is shown in their place was not seen. How the page's top row sits under a Windows title bar was not seen either.
5. **The Runner on Windows, all of it**: that interpreters are found, that a Run starts without a console window flashing, that output and figures arrive, and that stopping kills the job. The job object is four calls into `kernel32` written by hand and compiled, never executed. `runner.py` has never run on Windows.
6. **The uninstaller**, the entry in Installed apps, installing over an older version, the Start menu entry and its icon at any size.
7. **Windows 10** in particular (the Universal CRT and WebView2 are assumed present), Windows on ARM (the installer refuses), and accounts whose name or profile path has non-ASCII characters.
8. **A build on Linux** was run in M16, in an Ubuntu 22.04 container (mingw-w64 8 with gcc 10, NSIS 3.08): it first failed, because that mingw-w64 assumes Windows XP and SQLite needs `GetTickCount64`; the script now compiles the C parts for Windows 10 (`_WIN32_WINNT=0x0A00`). Then the installer was built (7.7 MB, `Infall.exe` 21 MB), every import is Windows' own (this toolchain links `msvcrt.dll` instead of the Universal CRT) or `WebView2Loader.dll`, and `cargo check --target x86_64-pc-windows-gnu --all-targets` (the tests included) is clean without warnings. Nothing was started. The program from Linux differs from the one from macOS in its C runtime (`msvcrt.dll`), which is in every Windows; which of the two goes to the first tester is a choice, and the continuous build makes the Linux one.
9. The Rust tests were run on macOS only. The continuous build runs them on Windows (MSVC) on every push (`.github/workflows/ci.yml`); it has not run yet, and most of the Runner's tests are Unix-only.
10. **Everything of M12 on Windows**: that the start screen appears, that a Local Workspace is created and opened, that the server inside the app starts and listens on `127.0.0.1` (Windows Defender Firewall asks only about programs that listen on a network, not on `127.0.0.1` alone, so no question is expected; that was not seen), that the web UI is unpacked to `%APPDATA%\app.qoop.desktop\web\`, and that the app restarts itself into a second Workspace. The person this was first handed to had no server: whether Infall now works for such a person on Windows is exactly what has not been seen.

**The first run on a real Windows machine** follows the list in docs/specs/release.md, section 9.3; what it shows replaces the items here that it settles.

## Unverified: the Ubuntu package (M11)

Built on an Apple silicon Mac in Docker (colima, 2 processors, 4 GB). What was really seen:

- **Both packages build**: `infall_0.1.0_amd64.deb` (cross-compiled, 3.0 MB, a 10.9 MB program) and `infall_0.1.0_arm64.deb` (2.7 MB). `desktop-file-validate` passes and `dpkg-shlibdeps` gives the `Depends` line above for both.
- **amd64, emulated containers, by the script**: on Ubuntu 22.04 and on 24.04 the package installed with `apt`, every shared library resolved (`ldd`), and the program started and showed its window named Infall with window class `infall`. **Then both runs failed**: within the ten seconds the kernel ended the program for lack of memory (the emulated program had grown to 1 GB; the same program started natively stays at 160 MB). So "stays up" and "removes cleanly" are **not** confirmed for amd64, and the script, as it must, called the run failed.
- **arm64, a native Ubuntu 24.04 container, by hand** with the same steps the script takes: installed with `apt`; started as an ordinary user under Xvfb and stayed up with steady memory; a screenshot showed the first-start screen drawn correctly with the Infall menu; Runner settings listed `/usr/bin/python3` and saved it; connected to a stand-in server on `http://localhost:8787` (no Content-Security-Policy), the main window loaded the page, `window.qoopDesktop` was there, frozen, version 0.1.0; a Run was approved by clicking in the approval window and delivered `started`, `output`, five `stats` samples, `done` with `os: linux`; the process it left behind was killed; Quit from the menu ended the app. App data appeared in the two folders named above.

Not verified:

1. **amd64: the script's own checks have never passed.** arm64 passed them all on Ubuntu 22.04 and 24.04 in M16, and was then operated by hand there (docs/specs/release.md, section 9.1). amd64 was not built in M16; the continuous build (`.github/workflows/package.yml`) builds and checks it natively on every push, and has not run yet. **Before handing an amd64 package out, see every check say ok, in that build or on an amd64 machine.**
2. **A real Ubuntu desktop with a real display.** Nothing was started under GNOME, on Wayland, or with a real graphics driver. Not seen: the entry and icon in the applications overview, whether the running window is matched to the entry (`StartupWMClass=infall` follows what the window reported under Xvfb), window decorations, HiDPI, dark mode, the menu bar's look. WebKitGTK is known to show an empty window with some NVIDIA drivers; starting with `WEBKIT_DISABLE_DMABUF_RENDERER=1 infall` is the usual way around it, and was not needed or tried here.
3. **amd64 beyond "it starts".** No click was made in an amd64 build; everything operated by hand was the arm64 build.
4. **The tests on Linux.** Not run by hand. The continuous build runs `cargo test` for the desktop app on Ubuntu 24.04 (`.github/workflows/ci.yml`); it has not run yet.
5. **The server's real pages on Linux**: the stand-in server sent no Content-Security-Policy. On Linux the page talks to the app through a custom address (`ipc://localhost`) and falls back to another channel if the page's policy forbids it; neither was observed against the real server. The web UI leaves room for the macOS window buttons; how its top bar looks in a Linux window was not seen.
6. **The AI sidebar on Linux**: `claude` was not installed in the container (`status` said so correctly). The lookup also checks `~/.local/bin` and `~/.claude/local`.
7. **Cancel of a Run, matplotlib figures, pyenv/conda, and `nvidia-smi`** on Linux: same code as macOS (the graphics parser is tested on written-down answers), not exercised on Linux.
8. **Opening the system browser** (needs `xdg-utils`), **Switch Workspace…** and the restart into a second Workspace, and installing a new version over an old one.
9. **Ubuntu 22.04 without updates** cannot install the package (it needs WebKitGTK 2.42 or newer, which 22.04 only has as an update); other distributions and Debian were not tried.
10. **A build on a Linux machine** (amd64 host, arm64 cross-compiled): the script is written for it and it was never run there.

## Unverified: Workspaces on this computer (M12)

Seen on the Mac that built it (Apple silicon, macOS 26.5): `scripts/package-macos.sh` ran from the working tree to `dist/Infall-0.1.0.dmg` (9.6 MB), and before that from a copy of the tree without `target/`, `node_modules` and `dist`; both times the program held the web UI just built, and the start check passed: with an empty home folder and every outgoing connection refused except to this computer, the app showed a 920 × 640 window and stayed up. Outside the script, the release app was seen working on this Mac by the person who fixed the start screen's caller check: the start screen, a Tutorial Workspace on the server inside the app, a Visual, and **Switch Workspace…**.

Not verified:

1. **The packaged app from the `.dmg`, clicked through.** The start check presses nothing. Creating each of the four Presets, **Rename** and **Remove** (and that removing really deletes the folder), **Sign in to a Team Workspace** against a real server, the restart into a second Workspace, and the notice after a failure were not operated in the packaged app.
2. **The hands-on Tutorial** from its first step to its last, in any build. Its steps were still being written while this page was.
3. **Opening a Local Workspace with no network at all.** The start check runs only up to the start screen. That the Board loads without a network is expected (everything it needs comes from `127.0.0.1`, the fonts included) but was not seen.
4. **The Ubuntu package's check** failed in M12 ("no Workspace within 90 seconds" after Return on the start screen). In M16 the cause was found in the script, not the app: it could not read the program's sockets as root in a container. Fixed, it passed on arm64 for Ubuntu 22.04 and 24.04, and a Tutorial Workspace was then operated by hand there: the Board, a Page, Runner settings, the approval window and a real Run, Export as Markdown, Print to a PDF, Export… and Import a workspace… through GTK's dialogs, the restart into a second Workspace, Switch Workspace…, Quit (docs/specs/release.md, section 9.1). Nothing was built or run for amd64.
5. **Windows**: everything of M12 (see "Unverified: the Windows installer", item 10). The installer was built once in M12, in a copy of the tree from before the same fix, and never started.
6. **Two copies of the app at once**, a Local Workspace's files on a network or synced folder, and what happens to an open Workspace when the computer sleeps.
7. **Approvals in a Local Workspace** behave as described under "Workspaces on this computer" (per Workspace, whatever its port); that was read in the code, not seen.

## Open question: Anthropic's terms

ADR 0003: driving each Member's own Claude Code, under that Member's own login, from this app is **assumed acceptable for a private team**. That assumption has not been confirmed with Anthropic. It **must be re-checked against Anthropic's terms before any public release**, which will likely need a paid-API path instead of the Members' subscriptions.
