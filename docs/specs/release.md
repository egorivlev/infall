# M10 — first real use

Until now Infall has only run on the computer it was written on. M10 changes nothing a Member can do in Infall; it makes Infall something the team can be given: an app that installs, a server that has been put on a clean machine by following the guide, and a backup that has been restored once.

## 1. The desktop app as something to install (macOS)

- `scripts/package-macos.sh` builds `dist/Infall-<version>.dmg` from a clean checkout with the tools macOS and Rust already bring (`cargo`, `sips`, `iconutil`, `codesign`, `hdiutil`). No `tauri-cli`, no new dependencies. (Since M12 it also needs Node.js, to build the web UI the app carries: section 7.)
- The build is a release build with the `custom-protocol` feature (the app's own files are served from inside the binary), without a web inspector.
- The bundle is `Infall.app`: identifier `app.qoop.desktop`, version from `desktop/src-tauri/Cargo.toml`, a real icon (`.icns` made from one square source image kept in the repository), `LSMinimumSystemVersion`, `NSHighResolutionCapable`, category "Productivity". It declares no entitlements it does not use.
- It is signed ad hoc (`codesign -s -`), which Apple silicon requires for any program to start. It is **not** signed with a Developer ID and **not** notarised: that needs a paid Apple account. The first start therefore needs the Member to allow it once; `desktop/README.md` says how, in the words the Member sees on screen, and says plainly what this warning means and does not mean.
- The script prints the SHA-256 of the `.dmg`, so that the person handing it out can say which file is the real one.
- App data stays where it is today (`~/Library/Application Support/app.qoop.desktop/`): an installed app and a development build share it. Nothing is migrated.

Not in M10: Developer ID signing, notarisation, auto-update, Windows and Linux packages, an app store.

## 2. The deploy guide, followed once

- `deploy/README.md` is followed literally on a clean Debian system with systemd, from an empty machine to a signed-in Admin. Every place where the guide was wrong, unclear or missing a step is fixed in the guide or the kit, not worked around.
- The rehearsal is repeatable: `scripts/rehearse-deploy.sh` does it again from nothing in a container and says at the end what it checked. It never touches a real server.
- A rehearsal has no public name, so Caddy cannot get a real certificate there: the rehearsal uses Caddy's own local authority and checks against it. This is the one deliberate difference from the guide, and the guide's Caddyfile stays as it is for a real domain.
- Checked at the end: the service is active under its own account and survives a restart of the machine's services; `/api/health` answers over HTTPS; the headers the guide promises are there; plain HTTP is redirected; the database file and the config file have the rights the guide says; a request body over the limit is refused.
- The body limit in the Caddyfile and the limits the server itself accepts must agree (a Run's result may be up to 2 MiB — api.md §15).

## 3. Backup, then restore

- The backup of the guide is taken from the running rehearsal server after real content exists (a Card, a Page with a block, a second Member).
- Then the database is destroyed, and the guide's restore steps bring it back from the encrypted file alone. Afterwards the Admin can sign in and the content is there.
- If the guide has no restore steps that work as written, it gets them.

## 4. The first day

The path a new team member walks, checked against the rehearsal server through the same API the page uses: the Admin signs in, creates an invite, the invite is accepted once (a second use is refused), the new Member signs in and creates a Card, the Admin sees it. What a person must do by hand on that path is written, in order, in one short page: `docs/first-day.md`, for the Admin and for the Member.

## 5. The desktop app for Ubuntu (M11)

- `scripts/package-linux.sh` builds `dist/infall_<version>_amd64.deb` (and, where it costs nothing extra, `_arm64.deb`) inside a container, so that it gives the same result from a Mac and from a Linux machine. No `tauri-cli`. The container and image names start with `qoop-package`; the script never touches other containers or images.
- Built against Ubuntu 22.04 so that the package installs on Ubuntu 22.04 and 24.04. `Depends` names exactly the shared libraries the program links (WebKitGTK 4.1, GTK 3 and what they bring); Python is a `Recommends`, because Infall works without it and only Runs need it.
- The package installs the program as `/usr/bin/infall`, a `.desktop` entry named Infall with the icon in the usual sizes, and nothing else. No service, no post-install script that changes the system.
- App data lives where the platform puts it for the identifier `app.qoop.desktop`.
- Checked by the script itself: the package installs with `apt` in a clean Ubuntu 22.04 and a clean 24.04 container, every shared library resolves, and the program starts and stays up under a virtual display. The script prints the SHA-256. (M12 extends this check: section 7.)
- Not signed, no repository, no auto-update, no Snap/Flatpak/AppImage.

## 6. The desktop app for Windows (M11)

- `scripts/package-windows.sh` builds `dist/Infall-<version>-x64-setup.exe` from a Mac or a Linux machine by cross-compiling. It uses tools whose licences need no acceptance on the builder's behalf (the GNU toolchain for Windows and NSIS), and says at the start which ones it needs and how to get them.
- The installer installs for the current person without administrator rights (under their local programs folder), adds a Start menu entry and an uninstaller entry, and removes exactly what it installed. It does not remove app data on uninstall.
- Infall on Windows needs Microsoft's WebView2 runtime, which Windows 11 has and current Windows 10 normally has. The installer checks for it and, if it is missing, says so in plain words with where to get it; it downloads nothing by itself.
- Not signed: Windows shows its "unknown publisher" warning. `desktop/README.md` says what the Member sees and does, as for macOS, and that the SHA-256 printed by the script is how to tell the real file.
- This package cannot be started on the machine that builds it. What was and was not checked (it compiles, links, the installer is assembled and its contents listed; **not** that it starts on Windows) is said plainly in `desktop/README.md` under "Unverified". Infall has never been started on Windows.

For both: what the Runner can and cannot do on that platform (finding Python, stopping a Run and everything it started, usage figures in the Runner monitor) is checked in the source and written down in `desktop/README.md`; nothing is claimed that the code does not do there.

## 7. The packages carry the server (M12)

The M11 packages could only ask for a server address, so a person without a server could do nothing with them. Since M12 the app carries the server for Local Workspaces ([ADR 0004](../adr/0004-server-embedded-in-the-desktop-app-for-local-workspaces.md), [local.md](local.md)), and the packages are built and checked for that.

- **What is built.** Each of the three scripts first builds the web UI (`npm ci` and `npm run build` in `web/`) and stops if `web/dist/index.html` is not there afterwards; the app's build embeds `web/dist` and fails without it. Then the release build compiles `crates/server` into the program, with its C parts: SQLite (bundled with `rusqlite`) and AWS-LC (`aws-lc-sys`, under `rustls`). Each script checks that the finished program holds the web UI it has just built.
- **What each build needs**, beyond M10 and M11: Node.js 22 (or 20.19 and newer) with npm, on the Mac or Linux machine for the macOS and Windows packages, and inside the build image for the Ubuntu one, which downloads it from nodejs.org and checks it against the published SHA-256. The C parts need only the C compiler each script already uses (the Command Line Tools' clang; Ubuntu's gcc and `crossbuild-essential`; `x86_64-w64-mingw32-gcc`). No cmake and no nasm: `aws-lc-sys` builds with the `cc` crate from bindings it ships, and for Windows x86-64 it links ready-made objects for its assembly (rustls turns on `prebuilt-nasm`).
- **What each script checks about the first start**, which is what failed for the person without a server:
  - macOS: the signed app, started with an empty home folder under a `sandbox-exec` profile that refuses every outgoing connection except to this computer, shows a window at least as large as the start screen's minimum, stays up ten seconds and does not panic. Nothing presses a button on the start screen.
  - Ubuntu: in a container with **no network at all** and a fresh home folder, the installed program shows its window and stays up; then a key press on the start screen creates a Tutorial Workspace, and the script checks that the program listens on `127.0.0.1` and nowhere else, that `/api/health` answers there, that `/api/local/enter` refuses a missing and a wrong key, and that the Workspace's database and the unpacked web UI are in the app's data folder.
  - Windows: only what can be read from the file (the program holds the web UI; its DLLs are Windows' own or shipped). That it starts without a server, or at all, is **not** checked: Infall has never been started on Windows.
- **Size.** The program is larger by the server, SQLite, AWS-LC and the web UI. The new sizes are written in `desktop/README.md` from a real build.
- **Data.** Local Workspaces live in the app's data directory (`desktop.md`, M12). Uninstalling, on every platform, leaves them there, as it leaves all app data.

Run in M12 (`desktop/README.md`, "Unverified: Workspaces on this computer"): the macOS script, to the end, start check passed. The Windows script once, before the start screen's caller check was fixed: it built and passed its file checks; nothing was started. The Ubuntu script once for arm64, on the same older tree: the package built, installed and started with no network, and the step that creates a Tutorial Workspace failed; it was not run again. Both are changed and not run since.

Not in M12: a check that clicks through the start screen on macOS (that needs the Accessibility permission), anything run on Windows, signing, auto-update.

## 8. Before handing out a release (M13)

Do these by hand, in the packaged app, on each platform it is handed out for. Each takes a minute. The scripts' start checks press nothing on the start screen, so none of this is covered by them.

1. **Export and import, round trip.** Open a Local Workspace with real content (a Card with a Page, a Source, a Checkpoint), add an OpenRouter key under **AI access** if there is one to hand, and go back to the start screen. Choose **Export…** in its row's **⋯** menu; the row says "Workspace file saved to …". **Import a workspace…** that file: a new Workspace opens with the same Board, Page, Source, History and Checkpoint, your name kept, and **no** OpenRouter key and no access tokens. The original Workspace is unchanged.
2. **A backup appears.** Create a new Local Workspace, go back to the start screen, open it again: its folder (**Show in folder**) has a file in `backups/`, and its row says "backed up …". Import that backup: it opens.
3. **Quitting leaves no crash.** Quit the app from its menu while a Local Workspace is open, and again from the start screen. It ends within a few seconds; macOS shows no "quit unexpectedly" report and nothing is left running (`pgrep -l qoop-desktop` prints nothing; on Windows, Task Manager).
4. **Out and in.** In any Workspace: **Export as Markdown** on a Page, **Print…** to a PDF, **Export BibTeX** on the Board, then **Import BibTeX…** of that file on the Board of another Workspace. **Look up** one DOI and one arXiv id (this one needs the network).

**The macOS start check and full-screen apps.** Until M13, `scripts/package-macos.sh` looked for the app's window only among the windows on the visible Space. With a full-screen app in front, the new window opens on another Space, the script saw no window and stopped with "no window of at least 720 x 560 within a minute". Since M13 it lists every window of the program at layer 0, on any Space, still requiring one of at least 720 × 560. If it still fails that way, run it from a normal desktop with no full-screen app in front, or, after starting the packaged app by hand and seeing its start screen, run it with `--no-verify`.

## 9. Windows and Ubuntu for real, and builds on every push (M16)

M16 in full needs a Windows machine and a real Ubuntu desktop ([the plan](../plans/2026-11-24-road-to-1.0.md)). This section says what was done without them, what a headless container can and cannot show, and what the first person at a real Windows machine checks.

### 9.1 Ubuntu in a container

Run on 24 November 2026 on an Apple silicon Mac, Docker in colima (2 processors, 4 GB, a 30 GB disk shared with other projects). **arm64 only, natively.** amd64 was not built or run: its containers are emulated here, and in M11 the emulated WebKit app was ended by the kernel for lack of memory in this same 4 GB machine; the continuous build checks amd64 natively instead (9.4).

**`scripts/package-linux.sh arm64`** built `infall_0.1.0_arm64.deb` from the M14 tree (6.9 MB; the program 21 MB) and installed it with `apt` in clean `ubuntu:22.04` and `ubuntu:24.04` containers; every shared library resolved (133 and 128 of them). After the fixes below, **every check of the script passed on both releases**, for the first time since M12: with no network and a fresh home the program showed its 920 × 640 window, stayed up, listened on nothing; Return on the start screen created a Tutorial Workspace whose server listened on `127.0.0.1` and nowhere else; `/api/health` answered `{"ok":true}`; `/api/local/enter` refused a missing and a wrong key; the database and the unpacked web UI were in `~/.local/share/app.qoop.desktop/`; no panic; `apt-get remove` left nothing in `/usr`. (SHA-256 of that build: `93fc89bf…0f07`; a build for testing, not to hand out.)

**By hand, in the same kind of container** (the installed package, `--network none` so that only `lo` exists, a fresh home, the app started as an ordinary user under Xvfb at 1280 × 900, driven with `xdotool`, screenshots with ImageMagick's `import`, looked at one by one). Ubuntu 24.04 (WebKitGTK 2.52.6, Python 3.12.3), everything below; Ubuntu 22.04 (WebKitGTK 2.50.4, Python 3.10.12), the first four:

1. The start screen appears as a 920 × 640 window named Infall, drawn correctly: the Infall menu bar, the four Preset tiles with the focus ring on **Tutorial**, Import, Sign in.
2. Return on the start screen creates a Tutorial Workspace: the main window shows the Tutorial's Board, the Tutorial panel at step 1 of 17, "Synced", and `127.0.0.1:<port>` at the bottom left. Its server listens on `127.0.0.1` only and `GET /api/health` answers `{"ok":true}`.
3. **A backup appears** right after the first opening: `workspaces/<id>/backups/backup-….infall` (owner-only, like the database and its key), and the start screen's row says "backed up … ago".
4. WebKitGTK renders the web UI: the Board with its Frames, Cards and Connections, a Page with KaTeX formulas and code, the dark theme, fonts, the AI and History controls. Nothing was seen out of place.
5. **The Runner finds the container's Python**: the Run's **Set up the Runner…** opens Runner settings, which list `/usr/bin/python3` (3.12.3); saving writes `runner.json`. **Run** opens the approval window in front of the main window, centred, naming the Run, the Workspace ("Tutorial (on this computer)"), `/usr/bin/python3` and a new temporary folder; **Run on this computer** executes the Tutorial's random-walk Run: the output is replaced by the new one, "Last run by you, … · current code, 0.4 s", the approval is remembered in `runner-approvals.json`, and no `python3` is left running.
6. **Export as Markdown** on the Page opens GTK's save dialog with "Random walk experiment.md" suggested; Return writes the file, whole. **Print…** opens GTK's print dialog (the web view's own `window.print()`, as desktop.md says for Linux); **Print to File** writes a one-page PDF.
7. **Switch Workspace…** from the menu goes back to the start screen and the Workspace's server stops (its port refuses connections).
8. **A Workspace file exports and imports** through the start screen, that is through the server crate's `export_workspace` and `import_workspace`: the row's **⋯** › **Export…** opens GTK's save dialog with `Tutorial.infall`, the row then says "Workspace file saved to /home/member/Tutorial.infall"; **Import a workspace…** of that file (GTK's open dialog, path typed with Ctrl+L) makes "Tutorial 2" and opens it, **by restarting the app** (the bridge was granted to the first Workspace's origin in this run): the restarted app showed the same Board on a new port.
9. **Quitting** with Ctrl+Q, from an open Workspace and from the start screen, ends the app within five seconds with no panic in its output and no process of it left running (its WebKit helpers remain as zombies only because a container's `sleep` as process 1 does not reap orphans; on a desktop the session does), and nothing listens any more.

**What a headless container cannot check**, and so was not: anything under GNOME or another desktop (the applications overview entry and its icon, matching the running window to `infall.desktop`, window decorations, placement — without a window manager every window opens at the top left, so the Runner settings window covered part of the main window — focus, the approval window staying on top), Wayland, a real graphics driver (WebKit drew without DRI3 here; the NVIDIA problem in desktop/README.md stays unchecked), HiDPI and fractional scaling, the system's light/dark preference (none reaches a container), D-Bus services (the log fills with harmless "dconf … dbus-launch" warnings; on a desktop there is a session bus), the portal file dialogs of Flatpak-era desktops (the GTK 3 dialogs were seen), a real printer, opening links in the system browser (`xdg-open` with no browser), sleep and resume, and amd64 at all.

**Defects found and fixed** (all in `scripts/package-linux.sh`):

- **The check could never see the Workspace's server.** It read the app's sockets from `/proc/<pid>/fd` as root, and root in a Docker container lacks `CAP_SYS_PTRACE` and may not read another user's open files: the list was always empty. So "listens on nothing before a Workspace is open" always passed, and "no Workspace server started within 90 seconds" always failed, although the Workspace had opened. It would have failed the M12 run (section 7) even had the start screen's caller check, the suspect then, been right. It now reads them as the app's own user.
- A full Docker disk made the image build fail with apt's "At least one invalid signature was encountered" for every source. The script now looks at the free space first and says so in plain words.
- A failed name lookup while installing made apt say "held broken packages". The check now retries each download (`Acquire::Retries`) and says when Ubuntu's archive could not be read. The image's own apt steps were not changed, so that the existing images stay valid.
- `QOOP_PACKAGE_CACHE` keeps the build output in a folder instead of the Docker volume: for the continuous build's cache, and for a Docker machine whose own disk is small.

### 9.2 Windows without a Windows machine

**Compiled, never started.** In an Ubuntu 22.04 container on the same Mac, the way the continuous build does it (9.4): `scripts/package-windows.sh` built `Infall-0.1.0-x64-setup.exe` (7.7 MB; `Infall.exe` 21 MB) with mingw-w64 8 and NSIS 3.08, its import check passed (Windows' own DLLs, `msvcrt.dll` as this toolchain's C runtime, and `WebView2Loader.dll`), and the program holds the web UI just built; then `cargo check --target x86_64-pc-windows-gnu --all-targets --features custom-protocol` in `desktop/src-tauri` passed without a warning, so the app, the Runner, the driver and **their tests** compile for Windows. That is the GNU target. **The MSVC target (`x86_64-pc-windows-msvc`) was not compiled here**: cross-checking it needs Microsoft's C runtime and SDK headers (`xwin`), which can only be had by accepting Microsoft's licence on the owner's behalf, and the C parts (SQLite, AWS-LC) must be compiled even for `cargo check`. The Rust code is the same for both targets (nothing in it looks at `target_env`); the continuous build's Windows job compiles and tests it with MSVC natively.

**Defect found and fixed**: with mingw-w64 older than 9 (Ubuntu 22.04's), SQLite did not compile (`'GetTickCount64' undeclared`): that mingw-w64 assumes Windows XP. `scripts/package-windows.sh` now compiles the C parts for Windows 10 and newer (`-D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00`), which is also what the installer requires.

**Read in the source, for Windows** (M12–M14 code, `desktop/src-tauri` and `crates/server`):

- **Data and config folders.** Tauri puts both in `%APPDATA%\app.qoop.desktop\` (the roaming profile), and WebView2's own data in `%LOCALAPPDATA%\app.qoop.desktop\EBWebView\`. macOS shares one folder for both too, so the file names are known not to collide (`workspaces.json`, `runner.json`, `runner-approvals.json`, `workspaces\`, `web\`). Local Workspaces in the *roaming* profile are synced at sign-in and sign-out on a company domain with roaming profiles; for a person at home it makes no difference. Not changed: moving them would need a migration, and it is a decision.
- **File names Windows forbids.** Names made from what a person typed go through `portable::safe_stem`/`safe_file_name`: `< > : " / \ | ? *` and control characters replaced, `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`9`, `LPT1`–`9` (also before the first dot) given a `_`, no dot or space at either end; tested. Backup names have no colon (`backup-2026-11-24-150405.infall`); Workspace folders are hex ids. Nothing found.
- **File dialogs.** `rfd` 0.17 uses the Windows common item dialog (COM) on Windows whatever its features say (`gtk3` matters only on Linux); dialogs get the asking window as their parent. Compiled; not seen.
- **Printing.** `window.print()` is WebView2's own (print preview, "Microsoft Print to PDF"); only macOS takes it over (`bridge::OWN_PRINT`). Not seen.
- **The firewall.** The embedded server and the port check bind `127.0.0.1` only (`Ipv4Addr::LOCALHOST` in `crates/server/src/local.rs` and `workspaces::choose_port`); Windows Defender Firewall asks about listeners on other addresses, so no question is expected. Not seen: section 9.3, step 5.
- **Finding Python.** `python.exe`, `python3.exe`, `py.exe` in `PATH` (`Path` matched without regard to case), then python.org's per-user folders `%LOCALAPPDATA%\Programs\Python\Python3*` (newest first) and its `Launcher`. The Microsoft Store's `python.exe` alias in `WindowsApps`, when no Store Python is installed, prints an error and fails the probe, so it is simply not listed. Fine as written.
- **Stopping processes.** A Run (and `claude`) is put into a job object right after it starts; Cancel, the end of a Run, closing the main window and quitting kill the job. A job without "kill on close" outlives Infall if Infall itself is killed hard, exactly as a process group outlives it on Unix; written down in desktop/README.md, not changed.
- **The AI sidebar** looks only for `claude.exe` (Claude Code's own installer); an npm install's `claude.cmd` is not found and `QOOP_CLAUDE_BIN` can name a program. As documented; not changed.

No other Windows defect was found by reading.

### 9.3 The first run on a real Windows machine (by hand)

Windows 10 22H2 or Windows 11, 64-bit, an ordinary account (not an administrator), with Python 3 from python.org installed for that account only and **not** added to `PATH` (the case the Runner's lookup is written for), and a second account on the same computer if one is to hand. Have Task Manager open on the **Details** tab and write down what each step shows; a step that fails is written down as it looked, with a screenshot, and the rest is done anyway where it can be.

1. **The file.** Download the installer from the continuous build's artifacts (or from the person who built it) the way a Member would, in Edge. Compare `Get-FileHash .\Infall-<version>-x64-setup.exe` with the SHA-256 the build printed. Note what Edge says about the download.
2. **SmartScreen.** Open it. Note the exact words of the blue window; **More info**, **Run anyway**. If Smart App Control blocks it instead, stop and note that: there is no way past it for an unsigned file.
3. **The installer.** No UAC question appears. If the WebView2 question appears, note it (it must not on Windows 11). It finishes; **Open Infall now** is ticked. `%LOCALAPPDATA%\Programs\Infall\` holds exactly `Infall.exe`, `WebView2Loader.dll`, `uninstall.exe`; the Start menu has **Infall** with its icon.
4. **The first start.** Infall opens its start screen, about 920 × 640, within a few seconds, with no console window flashing. Its title bar, the menu bar (Infall: Switch Workspace…, Runner settings…, and whatever Windows shows for the macOS-only items) and the tiles are drawn. Note anything cut off, scrolled sideways or blurry at 100 %, 125 % and 150 % display scaling. Task Manager: `Infall.exe` and `msedgewebview2.exe` processes.
5. **A Tutorial Workspace, with the network off.** Turn Wi-Fi off (or pull the cable). Press **Tutorial**. The main window opens on the Tutorial's Board within ten seconds. **No Windows Defender Firewall question appears** (the server listens on `127.0.0.1` only; a question here is a defect: write down its exact text). In PowerShell: `Get-NetTCPConnection -State Listen -OwningProcess (Get-Process Infall).Id` lists exactly one address, `127.0.0.1`, and a port between 20000 and 32000 (or, if none of those was free when the Workspace was made, one Windows chose). `%APPDATA%\app.qoop.desktop\` now holds `workspaces.json`, `web\index.html` and `workspaces\<id>\workspace.sqlite`; `%LOCALAPPDATA%\app.qoop.desktop\EBWebView\` exists.
6. **The page.** Open a Card with a Page; the formulas (KaTeX) and the fonts are drawn; the top bar is not hidden under the title bar; drag a Card, zoom the Board with Ctrl and the wheel; Settings opens and the three interface scales work. Network back on for the rest.
7. **A backup.** **Switch Workspace…** (menu), open the Tutorial again from the start screen: its row says "backed up …", and **Show in folder** opens Explorer on `%APPDATA%\app.qoop.desktop\workspaces\<id>\` with a `backups\backup-….infall` file.
8. **Export and import.** On the start screen, the row's **⋯** › **Export…**: the Windows save dialog opens over the Infall window (not behind it), suggests `Tutorial.infall`, and the file type list shows "Workspace file". Save it to Documents; the row says "Workspace file saved to C:\…". Try a name Windows forbids (`CON`, `a:b`): the dialog refuses or the file gets a safe name. **Import a workspace…** of that file: a second Workspace opens with the same Board. Import the backup from step 7 the same way.
9. **Print and save from a Page.** On a Page, **Print…**: WebView2's print preview opens; **Microsoft Print to PDF** writes a readable PDF. **Export as Markdown**: the save dialog opens and the file is written. **Export BibTeX** on the Board, **Import BibTeX…** of that file on the other Workspace.
10. **The Runner.** **Runner settings…**: the python.org Python is listed (from `%LOCALAPPDATA%\Programs\Python\Python3…\` and/or as `py.exe`), with its version; choose it and save. On the Tutorial Page with the Run (the random walk), press its run button: the approval window opens in front, names the code, and **Run on this computer** becomes available after its short wait. Run it: no console window flashes, output arrives, the result is saved with `os: windows`. Run it again and **Cancel** while it runs: it stops within a second. Write down whether the Runner monitor shows anything (it is expected to show no figures on Windows: desktop/README.md).
11. **A Run that leaves a process behind.** Put `import subprocess; subprocess.Popen(["python", "-c", "import time; time.sleep(600)"]); print("started")` in a Run and run it: after it ends, Task Manager shows no `python.exe` left from it.
12. **Quitting.** With a Workspace open and a long Run going (`import time; time.sleep(60)`), close the main window, then from the start screen close the app. Within five seconds Task Manager has no `Infall.exe`, no `msedgewebview2.exe` of Infall's, no `python.exe` of the Run; Windows shows no "stopped working" message. Start Infall again: the start screen lists both Workspaces.
13. **A second Workspace in one run of the app.** Open the Tutorial, **Switch Workspace…**, open the imported one: the app restarts itself into it (one short flicker) and opens it.
14. **A Team Workspace** if a server is reachable: **Sign in to a Team Workspace** with its address; the Board loads and the AI sidebar says whether Claude Code is installed (`claude.exe`).
15. **Another account, a non-ASCII name.** If possible, repeat steps 4 and 5 under an account whose name has a letter like `é` or `ö` (the profile path then has it too).
16. **Uninstall.** Settings › Apps › Installed apps › Infall › Uninstall: the three files, the folder, the Start menu entry and the list entry are gone; `%APPDATA%\app.qoop.desktop\` and `%LOCALAPPDATA%\app.qoop.desktop\` are still there. Install again over nothing, then install the same installer over the installed app while it is open: it asks to close Infall first.

What is written down goes into desktop/README.md, "Unverified: the Windows installer", replacing the items it settles.

### 9.4 Builds on every push

Two workflows in `.github/workflows/`, on every push, every pull request and by hand (`workflow_dispatch`), each cancelling its own older run on the same branch:

- **CI** (`ci.yml`): `cargo test --locked` at the root (server and core) on Ubuntu 24.04; in `web/` `npm ci`, `typecheck`, `lint`, `test`, `build`; and `cargo test --locked` in `desktop/src-tauri` on Ubuntu 24.04, macOS 15 (arm64) and Windows Server 2025 (x64, MSVC), each after building the web UI the app embeds. The Windows job is the first time the app's tests run on Windows at all; most Runner and driver tests are Unix-only (`cfg(unix)`) and are simply not compiled there.
- **Packages** (`package.yml`): `scripts/package-macos.sh --no-verify` on macOS 15 (arm64) and macOS 15 Intel (x64), the disk image renamed `Infall-<version>-<arch>.dmg`; `scripts/package-windows.sh` on Ubuntu 24.04 with Ubuntu's `mingw-w64` and `nsis`, as from any Linux machine; `scripts/package-linux.sh amd64` on Ubuntu 24.04 and `arm64` on Ubuntu 24.04 for Arm, each with the script's own checks (install in clean 22.04 and 24.04 containers, start with no network, open a Tutorial Workspace). The installers are kept as artifacts for 14 days (`infall-macos-arm64`, `infall-macos-x64`, `infall-windows-x64`, `infall-ubuntu-amd64`, `infall-ubuntu-arm64`); the job logs print their SHA-256.

Rust is pinned to the version the Ubuntu image uses (1.96.0), Node.js to 22. Caching: `actions/setup-node`'s npm cache; `Swatinem/rust-cache` for the native cargo builds (one cache per job); for the Ubuntu package, the script's build folder kept by `actions/cache` (`QOOP_PACKAGE_CACHE`, keyed by both `Cargo.lock` files and `web/package-lock.json`). The Docker image of the Ubuntu build is rebuilt every run (a few minutes on a hosted runner); caching it was judged not worth the extra machinery.

The macOS start check is left out (`--no-verify`): it opens a window on the runner's screen and lists it, which a shared runner is not to be relied on for. It is run by hand before a release (section 8).

**These workflows have never run**: the repository has no remote yet. They were checked with `actionlint` 1.7.12 (which also runs shellcheck on every `run:` step; no findings) and read against the inputs the current majors of each action declare (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`, `actions/upload-artifact@v7`, `Swatinem/rust-cache@v2`) and GitHub's list of hosted runner labels, all as of 24 November 2026. Expect the first run to find something. Cost: on a private repository the two macOS package jobs bill at ten times the Linux rate; if that matters, move `package.yml` to `push` on `main` only and to `workflow_dispatch`.
