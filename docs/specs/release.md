# M10 — first real use

Until now Infall has only run on the computer it was written on. M10 changes nothing a Member can do in Infall; it makes Infall something the team can be given: an app that installs, a server that has been put on a clean machine by following the guide, and a backup that has been restored once.

## 1. The desktop app as something to install (macOS)

- `scripts/package-macos.sh` builds `dist/Infall-<version>.dmg` from a clean checkout with the tools macOS and Rust already bring (`cargo`, `sips`, `iconutil`, `codesign`, `hdiutil`). No `tauri-cli`, no new dependencies. (Since M12 it also needs Node.js, to build the web UI the app carries: section 7.)
- The build is a release build with the `custom-protocol` feature (the app's own files are served from inside the binary), without a web inspector.
- The bundle is `Infall.app`: identifier `app.infall.desktop`, version from `desktop/src-tauri/Cargo.toml`, a real icon (`.icns` made from one square source image kept in the repository), `LSMinimumSystemVersion`, `NSHighResolutionCapable`, category "Productivity". It declares no entitlements it does not use.
- It is signed ad hoc (`codesign -s -`), which Apple silicon requires for any program to start. It is **not** signed with a Developer ID and **not** notarised: that needs a paid Apple account. The first start therefore needs the Member to allow it once; `desktop/README.md` says how, in the words the Member sees on screen, and says plainly what this warning means and does not mean.
- The script prints the SHA-256 of the `.dmg`, so that the person handing it out can say which file is the real one.
- App data is in `~/Library/Application Support/app.infall.desktop/`: an installed app and a development build share it. Builds from before the rename used `app.qoop.desktop`; the first start moves that folder's contents (desktop.md, "Names before the rename").

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

- `scripts/package-linux.sh` builds `dist/infall_<version>_amd64.deb` (and, where it costs nothing extra, `_arm64.deb`) inside a container, so that it gives the same result from a Mac and from a Linux machine. No `tauri-cli`. The container and image names start with `infall-package`; the script never touches other containers or images.
- Built against Ubuntu 22.04 so that the package installs on Ubuntu 22.04 and 24.04. `Depends` names exactly the shared libraries the program links (WebKitGTK 4.1, GTK 3 and what they bring); Python is a `Recommends`, because Infall works without it and only Runs need it.
- The package installs the program as `/usr/bin/infall`, a `.desktop` entry named Infall with the icon in the usual sizes, and nothing else. No service, no post-install script that changes the system.
- App data lives where the platform puts it for the identifier `app.infall.desktop`.
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
3. **Quitting leaves no crash.** Quit the app from its menu while a Local Workspace is open, and again from the start screen. It ends within a few seconds; macOS shows no "quit unexpectedly" report and nothing is left running (`pgrep -l infall-desktop` prints nothing; on Windows, Task Manager).
4. **Out and in.** In any Workspace: **Export as Markdown** on a Page, **Print…** to a PDF, **Export BibTeX** on the Board, then **Import BibTeX…** of that file on the Board of another Workspace. **Look up** one DOI and one arXiv id (this one needs the network).

Since M15 (0.9.0), one line each; the tutorial part named in brackets says how. A Team server for the M18 items: the container from `deploy/README.md` on `localhost` is enough.

**Undo (M15)**
5. Move one Card and five Cards, delete a Card with a Page, Sources and Connections, edit a title in place: ⌘Z and ⇧⌘Z take back and redo each, one press per gesture (part 1).
6. **Edit → Undo** and **Edit → Redo** in the menu name the step ("Undo Move 3 Cards") and do it; inside a text field they undo the typing (macOS, Windows; Linux has its own **Edit** menu).
7. A second window as another Member edits the same title: my ⌘Z leaves it and says "1 left as it is — <name> changed it since."; after a Merge into the open Branch ⌘Z says "Nothing to undo. To go further back, use History."

**Branch Graph (M15b)**
8. **Branches** draws every Branch from the first Change; start a Branch from a dot on a Branch that is not open, and one from a ◆; **Preview the Board** of a dot agrees with where it started (part 7).
9. **Add Checkpoint here** on an old dot; **Show every Change** lists as many Changes as the dot says; the same with the keyboard only (↑ ↓ ← → Enter N Esc).

**From alone to a team (M18)**
10. **Move to a Team server…** of a Tutorial Workspace onto an empty server: sign in as Admin, **Bring in … from this computer**, "The Workspace is in"; the row says **Moved to <host>**, **Open on the server** opens it, **Open this copy (read-only)** shows the bar and refuses edits (part 14).
11. On a fresh server, **Bring in a Workspace file…** of an export from the desktop app; then `infall-server import-workspace` of the same file on another fresh server.
12. **Export Workspace file…** (Settings → Workspace) as Admin; bring it into a second empty server; **Invite** a "not signed in yet" name, accept as that person: their Changes in History are theirs.
13. **Import a workspace…** of that Team file in the desktop app: a Local Workspace with you as its Member and the others as names.
14. Comments with an `@` mention between two Members in two windows: the badge, the short notice with **Open**, **For you**, **Resolve**, **Reopen**; a Guest sees none of it; the thread survives an export and import (part 15).

**PDFs (M19)**
15. **Attach PDF…** to a Source, **Open PDF**, **Find** a word, ⌘K finds a word from page 3 and opens the reader there; ⌘Z takes the attach back, ⇧⌘Z redoes it (part 16).
16. **Open in the system viewer** (desktop), **Save a copy** (browser); **Look up** an arXiv id, **Fetch the PDF from arXiv** (needs the network).
17. **Import BibTeX…** of a Zotero export with files: **Attach the PDFs…**, pick the folder, the PDFs land on their Sources.
18. **Export…** of a Workspace with PDFs: **Include PDFs (N files, X MB)** ticked imports with the PDFs; unticked, the reader says the server does not have the file.

**Runs (M19 Part 2, M19b)**
19. A Run in a second language (Julia or Q#): **Set up Julia** (or the Q# switch) in Runner settings, run it, **Stop** it, read the result line ("Julia …", "Q# · qdk …") (part 17).
20. The same code sent as another language asks for approval again; the approval window shows the language, the **Environment** and the command.
21. A Run naming an environment that exists here (a conda or `.venv` one) runs there and records its packages; one naming an unknown name opens Runner settings at the question, **Use it for “…”** is remembered and not asked again.
22. An app from before 0.9.0 against a Julia Run says "Update Infall on this computer to run Julia code." and runs nothing.

**The Board as a picture (M19 Part 3)**
23. **Export ▾** → **Board as SVG…** and **Board as PNG…** at 2×, with and without **Visible area only** and **Light background**; both open in another program and look like the Board (part 18).

**Updates (M20 groundwork), only in a build with an update feed**
24. **Check for updates…** finds a newer version from the feed, the start screen says "Restart to update", pressing it backs up every Local Workspace and starts the new version; a build without a feed has no such item.

**Windows data folder (0.9.0)**
25. On a Windows computer that had an earlier build: the first start moves the Local Workspaces from `%APPDATA%\app.infall.desktop\workspaces\` to `%LOCALAPPDATA%\app.infall.desktop\workspaces\`, they open, and nothing is left in the old place (section 9.3, step 5).

**The macOS start check and full-screen apps.** Until M13, `scripts/package-macos.sh` looked for the app's window only among the windows on the visible Space. With a full-screen app in front, the new window opens on another Space, the script saw no window and stopped with "no window of at least 720 x 560 within a minute". Since M13 it lists every window of the program at layer 0, on any Space, still requiring one of at least 720 × 560. If it still fails that way, run it from a normal desktop with no full-screen app in front, or, after starting the packaged app by hand and seeing its start screen, run it with `--no-verify`.

## 9. Windows and Ubuntu for real, and builds on every push (M16)

M16 in full needs a Windows machine and a real Ubuntu desktop ([the plan](../plans/2026-11-24-road-to-1.0.md)). This section says what was done without them, what a headless container can and cannot show, and what the first person at a real Windows machine checks.

### 9.1 Ubuntu in a container

Run on 26 November 2026, on the 0.9.0 tree after the rename (`21c5b11` and main up to `469d673`), on an Apple silicon Mac: Docker 29.5 in colima (macOS Virtualization.Framework, 2 processors, 4 GB, a 30 GB disk shared with other projects, about 2–3 GB of it free). Images `ubuntu:24.04` (24.04.5) and `ubuntu:22.04` (22.04.5), **arm64 natively**; amd64 through Docker's emulation for the start only. No real Ubuntu desktop was used: everything below is a container with Xvfb.

**Package: built and checked by the script.** `scripts/package-linux.sh arm64` built `infall_0.9.0_arm64.deb` (8.6 MB; `/usr/bin/infall` 27 MB) in 7 min 51 s from nothing (the release build itself 4 min 40 s, with `INFALL_PACKAGE_CACHE` on the Mac's disk), and **every check passed on 22.04 and on 24.04**: installed with `apt`, all shared libraries resolved (133 and 128), with no network and a fresh home it showed its 920 × 640 window named Infall (class `infall`), stayed up with its page process, listened on nothing; Return on the start screen created a Tutorial Workspace whose server listened on `127.0.0.1` only; `/api/health` answered `{"ok":true}`; `/api/local/enter` refused a missing and a wrong key; the database and the unpacked web UI were in `~/.local/share/app.infall.desktop/`; `apt-get remove` left nothing in `/usr`. `Depends` was the same line as before the rename (desktop/README.md). Run again at the end with every fix below (6 min 40 s): the same, and its new step passed on both releases — a stand-in package from before the rename was removed by `apt`. SHA-256 of that build `55e3341c…8317e` (a build for testing). `scripts/package-linux.sh amd64` cross-compiled `infall_0.9.0_amd64.deb` (9.3 MB; program 30 MB) in 6 min 34 s, the release build 3 min 56 s; its emulated checks could not run (below).

**By hand, the installed package** (a clean `ubuntu:24.04` container, `apt install ./infall_0.9.0_arm64.deb`, an ordinary user, Xvfb 1280 × 900, `xdotool`, screenshots with ImageMagick's `import`, looked at one by one; WebKitGTK 2.52.6):

1. The start screen: the Infall menu bar (Infall, Edit), "Create a workspace" with the four tiles and the focus ring on **Tutorial**, **Import a workspace…**, "Sign in to a Team Workspace". The window appeared within a second of the start.
2. Return creates a Tutorial Workspace: the main window (1280 × 860) shows the Tutorial's Board (three Frames, seven Cards, Connections), the Tutorial panel at step 1 of 18, "Synced" and `127.0.0.1:<port>` at the bottom left. `GET /` and `GET /api/health` answer on that port. Ctrl+Q quits; nothing of the app is left running.
3. **The data folders from before the rename move** (desktop.md, "Names before the rename"): with `~/.config/app.infall.desktop` and `~/.local/share/app.infall.desktop` renamed back to `app.qoop.desktop` after that first run, the next start moved both into the new folders (the old ones were gone), every file kept byte for byte (SHA-256 of all ten data files — the Workspace's database, its key and backup, the web view's local storage, cookies — and of `workspaces.json`, compared before and after), the start screen listed "Tutorial · LOCAL · opened just now · backed up just now", and Return opened it on the same port as before, the Board as it was. No panic.
4. A package from before the rename (a stand-in package named `qoop` with `/usr/bin/qoop`) is removed by `apt` when this one is installed (`Conflicts`/`Replaces: qoop`, new): "Removing qoop (0.8.0) ...".

The rest of what was operated by hand on 24 November (below) was not repeated: the page, the Runner windows, the dialogs and printing are the same code.

**amd64, emulated.** The amd64 package installed with `apt` in an emulated `ubuntu:24.04` and the program started and showed its window; the move of the old folders happened, byte for byte as on arm64. Then **the kernel ended it for lack of memory** (the emulated program at 1.0 GB resident, the Docker machine's 4 GB shared with other containers), before the start screen was drawn, both times — as in M11. The script's own emulated checks did not get that far: `apt` in the emulated containers failed with "At least one invalid signature was encountered", which here meant Docker's disk was full (it had 0 bytes free at that moment). So for amd64: **built (cross-compiled), installed, started; nothing on screen seen**. The continuous build checks amd64 natively (9.4, section 12).

**The tests on Linux**, in the same kind of container with the build libraries, Rust 1.96.0, Node.js 22.23.5 for the web UI, run as root, the container started with `--init` (without an init process, orphans are never collected and four tests of `driver/tests/stub.rs` see a dead child as "still running": a container's artefact, not a defect; a desktop session has one):

- `desktop/src-tauri` on **24.04**: `cargo fmt --check` clean; `cargo clippy --all-targets -- -D warnings` clean (after the fix below); `cargo test`: **294 passed, 0 failed** (app 120, driver 17 + stub 20, proc 1, runner 76, `real_python` 40, `real_toolchains` 20). On **22.04** the same: fmt and clippy clean, **294 passed, 0 failed**.
- The root workspace on 24.04: `cargo test --workspace`: **514 passed, 0 failed**, and the one ignored test (`a_literature_review_of_thirty_pdfs_exports_whole`) passed with `--include-ignored`.

**All six Run languages, for real** (the Runner's tests in `runner/tests/real_python.rs` and `real_toolchains.rs`, with `--nocapture` to see which program each used), on 24.04 arm64:

| Language | Program and version | How it was installed |
|---|---|---|
| Python | `/usr/bin/python3` 3.12.3 (found by the Runner's own lookup); and a venv of it with matplotlib 3.11.2, numpy 2.5.5 | `python3`, `python3-venv` |
| Q# | `qdk` 1.34.0 (with `pyqir` 0.12.8) in that venv: wheel `cp310-abi3-manylinux_2_28_aarch64`, so arm64 Linux has one | `pip install qdk` |
| JavaScript | `/usr/bin/node` v18.19.1 | `nodejs` |
| Shell | `/usr/bin/bash` 5.2.21 | (Ubuntu's) |
| Julia | `/usr/local/bin/julia` 1.13.4 | the official `julia-1.13.4-linux-aarch64.tar.gz`, SHA-256 checked |
| R | `/usr/bin/Rscript` 4.3.3 | `r-base-core` |

Run twice. With nothing set (the test Python is the one the Runner finds, without matplotlib or qdk): 60 passed, and **8 SKIPPED**, each for a missing package: five figure and package tests ("/usr/bin/python3 has no matplotlib") and three Q# tests ("no Python with qdk"). With `INFALL_TEST_PYTHON` set to the venv: **60 passed, nothing skipped**: the Q# samples run as qsharp-check.md says, a never-ending Q# loop is stopped at once, the "install qdk" sentence for an environment without it, matplotlib figures, the package list, and every Julia, R, node and bash test.

The same two runs on **22.04** arm64, with Ubuntu's Python 3.10.12 (the oldest `qdk` accepts; the venv with `qdk` 1.34.0, matplotlib 3.10.9, numpy 2.2.6), node v12.22.9, bash 5.1.16, Julia 1.13.4, R 4.1.2: 60 passed with the same 8 skips, and 60 passed with none.

What this showed about Linux in particular:

- **Stopping.** The stop of a Run's group, and of what left it (Julia's `Distributed` workers, a shell's background job under `set -m`), works with procps-ng 4.0.4's `ps -A -o pid= -o ppid= -o pgid=` (and the monitor's `-o rss= -o time= -o stat=`, `time` as `00:00:07`); `a_julia_run_with_distributed_workers_is_stopped_with_its_workers` and `stopping_a_run_also_ends_what_it_started_in_another_process_group` pass.
- **Locale.** The container sets no `LANG`/`LC_*`; the Runner gives command languages `LC_CTYPE=C.UTF-8` (Ubuntu has `C.utf8` built in; `locale -a` lists only `C`, `C.utf8`, `POSIX`), and R and Julia print and count `"αβγ"` correctly (`unicode_julia_or_r_prints_survives_with_or_without_a_locale`).
- **Finding programs.** All four presets were found on the login shell's `PATH` (`/usr/bin`, `/usr/local/bin`); a conda-like environment named by a Run was found, asked once and remembered. pyenv and a real conda on Linux were not installed.
- **R's `png()` headless.** A stock `r-base-core` depends on `libcairo2`, `libpango`, `libpangocairo`: `capabilities()` says `png TRUE, cairo TRUE, X11 FALSE`, `getOption("bitmapType")` is `"cairo"`, and `png()` writes a file with no display. The Run's figure from R works (`a_png_julia_or_r_writes_into_the_runs_folder_is_its_figure`).
- **Start-up times**, warm, while a build used both processors: Julia 0.13–0.21 s to `1+1`, 0.18 s with `using Distributed, Statistics, LinearAlgebra`; `Rscript -e 1` 0.08 s; node 0.04 s.

**Defects found and fixed** (26 November):

- **A traceback without its line on Ubuntu** (the CI failure of `the_chosen_folder_is_where_the_code_runs` on `ubuntu-latest`, section 12). Ubuntu's `python3` sets apport's `sys.excepthook` at start (`sitecustomize`); `runner.py` took any hook other than the built-in one for the code's own and called it, and apport's hands the error to the built-in printer, which reads the line from a file called `main.py` in the working directory — the folder's own `main.py` in that test. Reproduced in the container with `python3-apport` installed. Now only a hook the code set while it ran is used. Test: `an_excepthook_set_before_the_code_ran_does_not_replace_the_traceback` (a `.pth` file of a venv sets such a hook, so it runs on every system); it fails without the fix.
- **`cargo clippy -D warnings` failed on Linux** (and would on Windows): `use crate::chrome` and the traffic-light constants are used on macOS only. Now `cfg`-gated, as `chrome.rs` already was. Seen in the package build's warnings.
- **The test of what python-dateutil requires** assumed `six`; python-dateutil 4.0 (2026) requires `tzdata` instead. The test now asks the package what it requires.
- **The package and the old name**: `Conflicts`/`Replaces: qoop`, so that an earlier package is replaced rather than kept beside it (it would start again under the old identifier). The script's install step now installs a stand-in `qoop` package first and checks that `apt` removes it. Shown by hand first, then by the script's last arm64 run on 22.04 and 24.04.
- Not a defect, but what limited this run: the script's image takes about 2.6 GB of Docker's disk with the containerd image store (layers kept twice, packed and unpacked), more than its "about 3 GB" estimate suggests for a shared machine.

**Earlier, 24 November (the M14 tree, `infall_0.1.0_arm64.deb`)**, by hand in the same kind of container, beyond the above: Ubuntu 22.04 (WebKitGTK 2.50.4, Python 3.10.12) the first four of these, 24.04 all: a backup appears right after the first opening and the row says "backed up … ago"; WebKitGTK renders the Board, a Page with KaTeX formulas and code, the dark theme, fonts; Runner settings list `/usr/bin/python3`, the approval window names the Run, the Workspace, the interpreter and a new temporary folder, and the Tutorial's random-walk Run executes, nothing left running; **Export as Markdown** and **Export…** through GTK's save dialog, **Import a workspace…** through GTK's open dialog (by restarting the app into it), **Print…** to a PDF through GTK's print dialog; **Switch Workspace…** stops the Workspace's server; Ctrl+Q ends the app within five seconds. Defects found then, all in `scripts/package-linux.sh`: the check read the app's sockets as root, which a container forbids for another user's process, so it never saw the Workspace's server (it now reads them as the app's user); a full Docker disk made apt report "invalid signature" (the script now looks at the free space first); a failed name lookup made apt say "held broken packages" (retries, and a plain sentence); `INFALL_PACKAGE_CACHE` was added.

**Still unverified on Linux** (a container cannot show them, or they were not done): anything under GNOME or another desktop — the applications overview entry and its icon, matching the running window to `infall.desktop`, window decorations and placement (without a window manager every window opens at the top left), focus, the approval window staying on top, the tray (Infall has none) and the menu bar's look; Wayland; a real graphics driver (WebKit drew without DRI3 here; the NVIDIA workaround in desktop/README.md is untried); WebKitGTK's drawing of the Board at real sizes, fonts as a desktop configures them, HiDPI and fractional scaling, the system's light/dark preference; the portal file dialogs and a real printer; the Runner settings and approval windows operated by hand since 24 November (only the Runner's own code was tested today); opening links in the system browser; sleep and resume; the AI sidebar with a real `claude`; pyenv and conda layouts; and **amd64 beyond the start** — nothing of it has been seen on screen here, only in the continuous build's checks.

### 9.2 Windows without a Windows machine

**Compiled, never started.** In an Ubuntu 22.04 container on the same Mac, the way the continuous build does it (9.4): `scripts/package-windows.sh` built `Infall-0.1.0-x64-setup.exe` (7.7 MB; `Infall.exe` 21 MB) with mingw-w64 8 and NSIS 3.08, its import check passed (Windows' own DLLs, `msvcrt.dll` as this toolchain's C runtime, and `WebView2Loader.dll`), and the program holds the web UI just built; then `cargo check --target x86_64-pc-windows-gnu --all-targets --features custom-protocol` in `desktop/src-tauri` passed without a warning, so the app, the Runner, the driver and **their tests** compile for Windows. That is the GNU target. **The MSVC target (`x86_64-pc-windows-msvc`) was not compiled here**: cross-checking it needs Microsoft's C runtime and SDK headers (`xwin`), which can only be had by accepting Microsoft's licence on the owner's behalf, and the C parts (SQLite, AWS-LC) must be compiled even for `cargo check`. The Rust code is the same for both targets (nothing in it looks at `target_env`); the continuous build's Windows job compiles and tests it with MSVC natively.

**Defect found and fixed**: with mingw-w64 older than 9 (Ubuntu 22.04's), SQLite did not compile (`'GetTickCount64' undeclared`): that mingw-w64 assumes Windows XP. `scripts/package-windows.sh` now compiles the C parts for Windows 10 and newer (`-D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00`), which is also what the installer requires.

**Read in the source, for Windows** (M12–M14 code, `desktop/src-tauri` and `crates/server`):

- **Data and config folders.** Tauri puts both in `%APPDATA%\app.infall.desktop\` (the roaming profile), and WebView2's own data in `%LOCALAPPDATA%\app.infall.desktop\EBWebView\`. macOS shares one folder for both too, so the file names are known not to collide (`workspaces.json`, `runner.json`, `runner-approvals.json`, `workspaces\`, `web\`). Local Workspaces in the *roaming* profile are synced at sign-in and sign-out on a company domain with roaming profiles; for a person at home it makes no difference. **Decided (owner's default, 0.9.0): Local Workspaces' files move to `%LOCALAPPDATA%\app.infall.desktop\`**, the config files stay roaming; the first start after the update moves what is there, checked byte for byte, and leaves anything it cannot move in use where it is (desktop.md, M12, "Where things are kept"). Tested with temporary folders on every platform the tests run on; never run on Windows.
- **File names Windows forbids.** Names made from what a person typed go through `portable::safe_stem`/`safe_file_name`: `< > : " / \ | ? *` and control characters replaced, `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`9`, `LPT1`–`9` (also before the first dot) given a `_`, no dot or space at either end; tested. Backup names have no colon (`backup-2026-11-24-150405.infall`); Workspace folders are hex ids. Nothing found.
- **File dialogs.** `rfd` 0.17 uses the Windows common item dialog (COM) on Windows whatever its features say (`gtk3` matters only on Linux); dialogs get the asking window as their parent. Compiled; not seen.
- **Printing.** `window.print()` is WebView2's own (print preview, "Microsoft Print to PDF"); only macOS takes it over (`bridge::OWN_PRINT`). Not seen.
- **The firewall.** The embedded server and the port check bind `127.0.0.1` only (`Ipv4Addr::LOCALHOST` in `crates/server/src/local.rs` and `workspaces::choose_port`); Windows Defender Firewall asks about listeners on other addresses, so no question is expected. Not seen: section 9.3, step 5.
- **Finding Python.** `python.exe`, `python3.exe`, `py.exe` in `PATH` (`Path` matched without regard to case), then python.org's per-user folders `%LOCALAPPDATA%\Programs\Python\Python3*` (newest first) and its `Launcher`. The Microsoft Store's `python.exe` alias in `WindowsApps`, when no Store Python is installed, prints an error and fails the probe, so it is simply not listed. Fine as written.
- **Stopping processes.** A Run (and `claude`) is put into a job object right after it starts; Cancel, the end of a Run, closing the main window and quitting kill the job. A job without "kill on close" outlives Infall if Infall itself is killed hard, exactly as a process group outlives it on Unix; written down in desktop/README.md, not changed.
- **The AI sidebar** looks only for `claude.exe` (Claude Code's own installer); an npm install's `claude.cmd` is not found and `INFALL_CLAUDE_BIN` can name a program. As documented; not changed.

No other Windows defect was found by reading.

### 9.3 The first run on a real Windows machine (by hand)

Windows 10 22H2 or Windows 11, 64-bit, an ordinary account (not an administrator), with Python 3 from python.org installed for that account only and **not** added to `PATH` (the case the Runner's lookup is written for), and a second account on the same computer if one is to hand. Have Task Manager open on the **Details** tab and write down what each step shows; a step that fails is written down as it looked, with a screenshot, and the rest is done anyway where it can be.

1. **The file.** Download the installer from the continuous build's artifacts (or from the person who built it) the way a Member would, in Edge. Compare `Get-FileHash .\Infall-<version>-x64-setup.exe` with the SHA-256 the build printed. Note what Edge says about the download.
2. **SmartScreen.** Open it. Note the exact words of the blue window; **More info**, **Run anyway**. If Smart App Control blocks it instead, stop and note that: there is no way past it for an unsigned file.
3. **The installer.** No UAC question appears. If the WebView2 question appears, note it (it must not on Windows 11). It finishes; **Open Infall now** is ticked. `%LOCALAPPDATA%\Programs\Infall\` holds exactly `Infall.exe`, `WebView2Loader.dll`, `uninstall.exe`; the Start menu has **Infall** with its icon.
4. **The first start.** Infall opens its start screen, about 920 × 640, within a few seconds, with no console window flashing. Its title bar, the menu bar (Infall: Switch Workspace…, Runner settings…, and whatever Windows shows for the macOS-only items) and the tiles are drawn. Note anything cut off, scrolled sideways or blurry at 100 %, 125 % and 150 % display scaling. Task Manager: `Infall.exe` and `msedgewebview2.exe` processes.
5. **A Tutorial Workspace, with the network off.** Turn Wi-Fi off (or pull the cable). Press **Tutorial**. The main window opens on the Tutorial's Board within ten seconds. **No Windows Defender Firewall question appears** (the server listens on `127.0.0.1` only; a question here is a defect: write down its exact text). In PowerShell: `Get-NetTCPConnection -State Listen -OwningProcess (Get-Process Infall).Id` lists exactly one address, `127.0.0.1`, and a port between 20000 and 32000 (or, if none of those was free when the Workspace was made, one Windows chose). `%APPDATA%\app.infall.desktop\` now holds `workspaces.json`; `%LOCALAPPDATA%\app.infall.desktop\` holds `web\index.html`, `workspaces\<id>\workspace.sqlite` and `EBWebView\` (since 0.9.0; before, the first two were in `%APPDATA%`). If an earlier build was used on this computer, its Workspaces were moved there at this start: they are listed, and nothing of them is left in `%APPDATA%\app.infall.desktop\workspaces\`.
6. **The page.** Open a Card with a Page; the formulas (KaTeX) and the fonts are drawn; the top bar is not hidden under the title bar; drag a Card, zoom the Board with Ctrl and the wheel; Settings opens and the three interface scales work. Network back on for the rest.
7. **A backup.** **Switch Workspace…** (menu), open the Tutorial again from the start screen: its row says "backed up …", and **Show in folder** opens Explorer on `%LOCALAPPDATA%\app.infall.desktop\workspaces\<id>\` with a `backups\backup-….infall` file.
8. **Export and import.** On the start screen, the row's **⋯** › **Export…**: the Windows save dialog opens over the Infall window (not behind it), suggests `Tutorial.infall`, and the file type list shows "Workspace file". Save it to Documents; the row says "Workspace file saved to C:\…". Try a name Windows forbids (`CON`, `a:b`): the dialog refuses or the file gets a safe name. **Import a workspace…** of that file: a second Workspace opens with the same Board. Import the backup from step 7 the same way.
9. **Print and save from a Page.** On a Page, **Print…**: WebView2's print preview opens; **Microsoft Print to PDF** writes a readable PDF. **Export as Markdown**: the save dialog opens and the file is written. **Export BibTeX** on the Board, **Import BibTeX…** of that file on the other Workspace.
10. **The Runner.** **Runner settings…**: the python.org Python is listed (from `%LOCALAPPDATA%\Programs\Python\Python3…\` and/or as `py.exe`), with its version; choose it and save. On the Tutorial Page with the Run (the random walk), press its run button: the approval window opens in front, names the code, and **Run on this computer** becomes available after its short wait. Run it: no console window flashes, output arrives, the result is saved with `os: windows`. Run it again and **Cancel** while it runs: it stops within a second. Write down whether the Runner monitor shows anything (it is expected to show no figures on Windows: desktop/README.md).
11. **A Run that leaves a process behind.** Put `import subprocess; subprocess.Popen(["python", "-c", "import time; time.sleep(600)"]); print("started")` in a Run and run it: after it ends, Task Manager shows no `python.exe` left from it.
12. **Quitting.** With a Workspace open and a long Run going (`import time; time.sleep(60)`), close the main window, then from the start screen close the app. Within five seconds Task Manager has no `Infall.exe`, no `msedgewebview2.exe` of Infall's, no `python.exe` of the Run; Windows shows no "stopped working" message. Start Infall again: the start screen lists both Workspaces.
13. **A second Workspace in one run of the app.** Open the Tutorial, **Switch Workspace…**, open the imported one: the app restarts itself into it (one short flicker) and opens it.
14. **A Team Workspace** if a server is reachable: **Sign in to a Team Workspace** with its address; the Board loads and the AI sidebar says whether Claude Code is installed (`claude.exe`).
15. **Another account, a non-ASCII name.** If possible, repeat steps 4 and 5 under an account whose name has a letter like `é` or `ö` (the profile path then has it too).
16. **Uninstall.** Settings › Apps › Installed apps › Infall › Uninstall: the three files, the folder, the Start menu entry and the list entry are gone; `%APPDATA%\app.infall.desktop\` and `%LOCALAPPDATA%\app.infall.desktop\` are still there. Install again over nothing, then install the same installer over the installed app while it is open: it asks to close Infall first.

What is written down goes into desktop/README.md, "Unverified: the Windows installer", replacing the items it settles.

### 9.4 Builds on every push

Two workflows in `.github/workflows/`, on every push, every pull request and by hand (`workflow_dispatch`), each cancelling its own older run on the same branch:

- **CI** (`ci.yml`): `cargo test --locked` at the root (server and core) on Ubuntu 24.04; in `web/` `npm ci`, `typecheck`, `lint`, `test`, `build`; and `cargo test --locked` in `desktop/src-tauri` on Ubuntu 24.04, macOS 15 (arm64) and Windows Server 2025 (x64, MSVC), each after building the web UI the app embeds. The Windows job is the first time the app's tests run on Windows at all; most Runner and driver tests are Unix-only (`cfg(unix)`) and are simply not compiled there.
- **Packages** (`package.yml`): `scripts/package-macos.sh --no-verify` on macOS 15 (arm64) and macOS 15 Intel (x64), the disk image renamed `Infall-<version>-<arch>.dmg`; `scripts/package-windows.sh` on Ubuntu 24.04 with Ubuntu's `mingw-w64` and `nsis`, as from any Linux machine; `scripts/package-linux.sh amd64` on Ubuntu 24.04 and `arm64` on Ubuntu 24.04 for Arm, each with the script's own checks (install in clean 22.04 and 24.04 containers, start with no network, open a Tutorial Workspace). The installers are kept as artifacts for 14 days (`infall-macos-arm64`, `infall-macos-x64`, `infall-windows-x64`, `infall-ubuntu-amd64`, `infall-ubuntu-arm64`); the job logs print their SHA-256.

Rust is pinned to the version the Ubuntu image uses (1.96.0), Node.js to 22. Caching: `actions/setup-node`'s npm cache; `Swatinem/rust-cache` for the native cargo builds (one cache per job); for the Ubuntu package, the script's build folder kept by `actions/cache` (`INFALL_PACKAGE_CACHE`, keyed by both `Cargo.lock` files and `web/package-lock.json`). The Docker image of the Ubuntu build is rebuilt every run (a few minutes on a hosted runner); caching it was judged not worth the extra machinery.

The macOS start check is left out (`--no-verify`): it opens a window on the runner's screen and lists it, which a shared runner is not to be relied on for. It is run by hand before a release (section 8).

**Since then they have run on GitHub, and changed: section 12** describes the workflows as they are now (`ci.yml`, `package.yml`, `release.yml`, `image.yml`) and what their first runs on 26 November 2026 showed; the desktop test failures found there, and what was done about each, are at the end of this section. What follows is how they were first checked, before any run. They were checked with `actionlint` 1.7.12 (which also runs shellcheck on every `run:` step; no findings) and read against the inputs the current majors of each action declare (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`, `actions/upload-artifact@v7`, `Swatinem/rust-cache@v2`) and GitHub's list of hosted runner labels, all as of 24 November 2026. Expect the first run to find something. Cost: on a private repository the two macOS package jobs bill at ten times the Linux rate; if that matters, move `package.yml` to `push` on `main` only and to `workflow_dispatch`.

**The desktop test failures of the first CI runs (26 November 2026, section 12), and their fixes.** Not yet seen passing in CI.

- Ubuntu, `the_chosen_folder_is_where_the_code_runs`: apport's exception hook, set by Ubuntu's `python3` at start, printed the traceback without the code's line. Reproduced and fixed in a container (9.1), with a test that runs on every system.
- Windows, `bridge::tests::the_script_tells_the_app_what_undo_and_redo_would_do_and_nothing_more`: compared text with LF line endings to `bridge.js` as checked out, which Git for Windows had given CRLF. The workflow keeps line endings now and the root `.gitattributes` says `eol=lf`; the test also compares with `\r\n` made `\n`, so it no longer depends on the checkout. Not run on Windows.
- Windows, `files::tests::a_reference_managers_file_field_is_read`: a folder picked on Windows is kept as `fs::canonicalize` gives it, `\\?\C:\…`, and a Zotero `file` field writes its backslashes escaped. The field was split at `;` and then at `:` with the escapes taken away **both** times, so an escaped `\\` (the two backslashes of `\\?\` or of a network path `\\server\share`) became one and then the escape of what followed: `\\?\C:` became `\?\C:` and no file matched. The escapes are now taken away only at the second split (`files::split_at`), with a test of the string handling that runs on every system (`escaped_double_backslashes_of_windows_paths_survive`). That the whole test now passes on Windows is reasoned from the code, **not run on Windows**.
- macOS, `output_arrives_while_the_code_runs_about_ten_times_a_second` (41 and 42 events where at most 40 were allowed) and `what_the_code_says_through_qoop_arrives_with_the_samples` (a sample landed while a loop was still saying its thousand things), both passing on the next run: on a slow machine the code takes longer than it says. The first now allows about ten events a second of the time the prints really took (the 90 ms between events is still checked); the second allows samples of the loop's own values, in order, and still requires what was said after it. Also made robust: `python::tests::a_program_that_never_answers_is_given_up_on_and_killed` tries again with a three-second wait when the script had not even written its pid within 400 ms, and waits up to five seconds for the killed group to be collected instead of 100 ms.

## 10. The official container (M18)

[team-move.md](team-move.md), decision 8 and "Deploy". The container route comes first in `deploy/README.md`; the systemd route (sections 2 and 3) stays below it as the alternative, unchanged except that its Caddyfile also lets a Workspace file of up to 512 MiB through on `POST /api/workspace/import`.

### 10.1 The image

- Root `Dockerfile`, three stages: the web UI (`node:22-bookworm-slim`, on the build machine's own processor, since its output is the same everywhere), the server (`rust:1.96.0-slim-trixie`, `cargo build --release --locked -p infall-server`, built for the target processor), and a `debian:trixie-slim` runtime with `ca-certificates` and `sqlite3`. Cargo's registry and target folder and npm's cache are BuildKit cache mounts, so they never reach a layer and a rebuild compiles only what changed. `.dockerignore` is an allow-list: `Cargo.*`, `crates/`, `web/` (without `node_modules`, `dist`), `deploy/container/`.
- Runs as `infall` (uid/gid 10001), never root. Data in the volume `/data` (`INFALL_DB=/data/infall.db`); the UI in `/app/web`; listens on `0.0.0.0:8787` inside the container only. `HEALTHCHECK` asks `/api/health` through bash's `/dev/tcp` (there is no curl in the image).
- No secret in the image. `INFALL_SECRET_KEY` from the environment wins, then `INFALL_SECRET_KEY_FILE`, else the entrypoint makes `/data/secret-key` (mode 600) with `infall-server gen-secret-key` on first start. Backups leave it out (a backup alone must not open the sealed OpenRouter keys); the guide says how to keep a copy.
- The entrypoint (`deploy/container/entrypoint.sh`, installed as `infall`): `serve` (default), `health`, `backup` (a Workspace file), `backup-database` (a database copy), `backup-daemon`, `backup-health`, `list-backups`, `restore <file>|-` (database copies only), `import-workspace <file>|- --admin-email <e>` (a bare name from the backups volume, `-` from standard input, gzip or plain); anything else goes to `infall-server` (`create-admin`, `reset-password`, `export-workspace`, `gen-secret-key`).
- **Before an upgrade.** The data volume remembers which server last used it (the binary's SHA-256 and `INFALL_VERSION`). When a different one is about to open an existing database — by `serve` or by any `infall-server` subcommand — the entrypoint first makes a checked online copy into `/data/pre-upgrade/infall-<time>-from-<version>-schema<user_version>.db`, keeps the newest `INFALL_UPGRADE_KEEP` (3), and refuses to start if the copy fails. This also fires on a downgrade and on a database restored from elsewhere.

### 10.2 compose.yaml

- `deploy/compose.yaml`, project name `infall`: `server` (the image, `read_only`, `cap_drop: ALL`, `no-new-privileges`, not published), `caddy` (`caddy:2.11`, ports 80/443 and 443/udp, `deploy/container/Caddyfile`), `backup` (the same image, `backup-daemon`). Volumes `data`, `backups`, `caddy-data`, `caddy-config`. Settings in `deploy/.env` (from `.env.example`): `INFALL_DOMAIN`, `INFALL_IMAGE`, `INFALL_VERSION`, `INFALL_BACKUP_KEEP` (14), `INFALL_BACKUP_TIME` (03:30 UTC); optional ports, public origin, import limit, secret key.
- HTTPS from `INFALL_DOMAIN` alone: Caddy's automatic certificate for a real name, its own local authority for `localhost`. HSTS is not sent for `localhost` (it ignores ports and would stop every other `http://localhost` page in that browser). Body limits as the systemd Caddyfile: 512 MiB (`INFALL_MAX_IMPORT_MB`, also given to the server as `INFALL_MAX_IMPORT_MB`) on the import route, 2 MiB on `/api/branches/*/ops`, 1 MiB elsewhere.
- **Backups: a Workspace file every day, database copies besides** (since M18's verification). The daily job runs `infall-server export-workspace` (a Team file from a `VACUUM INTO` snapshot, safe while the server runs), checks it with `PRAGMA integrity_check`, gzips it and keeps the newest `INFALL_BACKUP_KEEP` as `infall-<UTC time>.infall.gz`. One at start when none is younger than 23 hours, then daily; the service is unhealthy when the newest is older than 26 hours. A Workspace file holds no emails, passwords, sessions, invites, tokens, AI keys or Guests, so putting it back (`import-workspace` onto an empty server) means inviting everyone again to claim their names; it also crosses versions and opens in the desktop app. For putting *this* server back as it was, sign-ins included, there are database copies (`infall-<time>.db.gz`: SQLite's online `.backup`, integrity check, gzip): `backup-database` by hand, daily as well with `INFALL_BACKUP_DATABASE=yes`, kept separately by the same count, put back with `restore`. Not encrypted (the systemd route's `age` step is described for copies that leave the host).
- **The copy before an upgrade stays a database copy**, deliberately: rolling back means the *old* server opening it, and an old server can open neither a migrated database nor a Workspace file of a newer schema (`422 newer_version`).
- `restore` refuses while the server answers, refuses a Workspace file (`PRAGMA application_id` of a Workspace file: nobody could sign in), keeps the replaced file as `infall.db.before-restore-<time>`, removes stale `-wal`/`-shm`, and checks integrity before anything is replaced. `-` reads the file from standard input, so files from outside Docker need no mount; a plain (not gzipped) database file is accepted too.

### 10.3 The image workflow

`.github/workflows/image.yml`: on `v*` tags builds `linux/amd64` on `ubuntu-24.04` and `linux/arm64` on `ubuntu-24.04-arm` (native, no emulation), pushes each by digest, and joins them into `<image>:<version>` and `:latest` (not for a pre-release such as `v1.2.0-rc.1`). On pull requests and by hand off a tag: the same builds, nothing pushed. Registry: the repository variable `INFALL_IMAGE` (with its host); unset, `ghcr.io/<owner>/infall` with `GITHUB_TOKEN`; for another registry the secrets `REGISTRY_USERNAME`/`REGISTRY_PASSWORD`. Build cache: `type=gha`, one scope per processor. Actions: `actions/checkout@v7`, `docker/setup-buildx-action@v4`, `docker/login-action@v4`, `docker/build-push-action@v7`, `actions/upload-artifact@v7`, `actions/download-artifact@v8` (majors as listed by their repositories on 25 November 2026). `actionlint` 1.7.12 with shellcheck reports nothing. **First runs on GitHub, 26 November 2026**, as the repository's Actions list shows them: on the tags `v0.9.0` and `v0.9.1`, both successful (so `ghcr.io/egorivlev/infall` received `0.9.0`, `0.9.1` and `latest`; no record says the image was then pulled and started from there; `v0.9.0` is the commit before the rename, and at `v0.9.1` the code still says version 0.9.0). The repository and its packages are private until it is made public; a package's visibility on GitHub is set apart from the repository's.

### 10.4 The rehearsal on this Mac (25 November 2026)

Docker 29.6 under colima (arm64), buildx 0.39, Compose 5.8, against `localhost` with Caddy's own certificate (host port 80 is taken by another program there, so `INFALL_HTTP_PORT=18080`; 443 as in the guide). What was done, in order, all through the guide's commands with `-p infall-rehearsal`:

1. `docker buildx build` of the image: 3 min 9 s from cold (cargo 160 s); 174 MB on disk, 40 MB compressed. A rebuild with only the runtime stage changed: 8 s.
2. `docker compose up -d`: `server` and `backup` healthy, Caddy got its local certificate; the backup job made its first copy at once.
3. `create-admin` with the password typed at the prompt (twice, in a terminal): `Created Admin …`.
4. Over HTTPS (`curl -k`): health `{"ok":true}`, sign-in, the main Branch's Board, a Card made; CSP, nosniff and Referrer-Policy headers present; `http://localhost:18080/` answered `308` to `https://localhost/`; a 1.1 MB body to `/api/auth/login` refused with `413` by Caddy, the same to `/api/workspace/import` passed on (the server, without that route yet, answered `502`).
5. `backup` by hand, a second Card, `restore` refused while the server ran; the copy taken out with `docker compose cp`; `down`, the data volume deleted, `restore -` from that file into a fresh volume, `up -d`: sign-in works, the Board has the first Card only. Again in place from the backups volume, then `restart`.
6. Upgrade: images `:1`, `:2`, `:3` (each a different build); changing `INFALL_VERSION` and `up -d` made the pre-upgrade copy and started the new one with the data intact. Back from 3 to 2 with the guide's rollback (restore of the pre-upgrade copy): works.
7. `reset-password` at the prompt; sign-in with the new password. `stop` ends the server gracefully (`shutting down`). Retention: with `INFALL_BACKUP_KEEP=2` the oldest copy was removed. Bad `INFALL_BACKUP_TIME`/`INFALL_BACKUP_KEEP` are refused with a sentence. The daily job sleeps until the next 03:30 UTC.

Not checked here: an amd64 image (only built on CI); a real domain and certificate; the browser UI through Caddy (the live connection's WebSocket upgrade on `/api/ws` was checked with curl: `101 Switching Protocols`); a host with only Docker's own firewall rules; `import-workspace` and the web import (the server does not have them yet); the workflow itself.

### 10.5 The rehearsal again, with M18 on main (25 November 2026)

Docker 29.5 under colima (arm64), the standalone `docker-buildx` 0.39 and `docker-compose` binaries from Homebrew (the CLI plugins are not linked there: `docker compose` is `docker-compose`), against `localhost` with Caddy's own certificate on host ports 18480/18443 (`INFALL_PUBLIC_ORIGIN=https://localhost:18443`). The compose folder must be under the home folder: colima does not share `/private/tmp`, and Caddy's file mount fails there. Images: `:m18-old` built from `47519b8` (main with all of M18) and `:m18-new` from this branch (same server, the new entrypoint); a rebuild after an entrypoint change took 2 s.

1. `up -d` on `:m18-old`; `create-admin` (password from `INFALL_ADMIN_PASSWORD` for the scripted run); a Team Workspace file (two Members, Comments, a resolved thread) brought in over HTTPS through Caddy with `POST /api/workspace/import`: `200`, Ben "not signed in yet"; an invite with `claims`, accepted: Ben signs in and the History authors are Ada and Ben.
2. Upgrade to `:m18-new` (`INFALL_VERSION`, `up -d`): the pre-upgrade copy `infall-…-from-m18-old-schema7.db` made and logged; data intact; the backup service at once wrote its first Workspace file while the server ran.
3. `backup` (Workspace file, 188 KB raw, 10 KB gzipped), `backup-database`, `list-backups` (both kinds, labelled), `backup-health` 0. `restore` of the Workspace file refused with the sentence; a Comment added after the database copy, `restore` of the copy with the server stopped: the Comment gone, Ben still signs in.
4. A second project with fresh volumes (ports 18481/18444): `create-admin` under another name, `import-workspace - --admin-email … < infall-….infall.gz` on the backup service: "The work of Ada Admin is now Ada Restorer's. Not signed in yet: Ben Member."; a second run refused (not empty); `restart server`; claim of Ben again: his Changes and Comment are his.
5. Rollback from `:m18-new` to `:m18-old` with the guide's commands (restore of the pre-upgrade copy): works; the old image made its own pre-upgrade copy of the newer one first.
6. Retention with `INFALL_BACKUP_KEEP=2` removes the oldest Workspace file and leaves the database copies alone; `INFALL_BACKUP_DATABASE=yes` makes both at start; a bad `INFALL_BACKUP_DATABASE` or `INFALL_BACKUP_KEEP` is refused with a sentence.

Found on the way: `docker compose run` without `--no-deps` recreates `server` when its image in `.env` differs from the running one (Compose's own behaviour); the guide's restore commands all carry `--no-deps`. Not checked here: amd64, a real domain, the web import in a real browser through Caddy (it was driven in a real browser against plain servers, and with curl through Caddy).

## 11. Updates (M20 groundwork)

The plan's rule: the app checks a signed feed, says a new version is there, installs it on restart, and Workspaces are backed up before the first start of a new version. Built 2026-11-25 without any account. Since M20 became the open-source release (26 November 2026: no paid signing, no download host), **the updater stays off**: no build is given a key or a feed, and no workflow signs or publishes update bundles (11.5 says what switching it on from GitHub Releases would take).

### 11.1 What the app does

- **Only a build that was given a key and a feed has an updater.** `cargo build --features updater` with both `INFALL_UPDATE_PUBKEY` (the public key) and `INFALL_UPDATE_URL` (the address of `latest.json`) set at build time; build.rs then sets `cfg(infall_updater)`. The packaging scripts turn the feature on by themselves when both variables are set. Any other build — every build until now, and `cargo test` — has no updater compiled in, no menu item, and says nothing about updates. The feed must be `https://` (build.rs refuses anything else, except `http://` to `127.0.0.1`, `localhost` or `[::1]`, for a test, with a warning).
- The values go into the updater plugin's configuration (`plugins.updater` in `tauri.conf.json`, whose `pubkey` and `endpoints` are left empty there and filled in at start from what the build was given; `windows.installMode` is `passive`). Plugin: `tauri-plugin-updater` 2.14.
- **When it checks:** at start, at most once a day (`updates.json` in the config folder; a failed check is tried again at the next start), and from **Check for updates…** in the app menu (any time; it answers in a message of the system's: ready, up to date, or could not reach the server). The request is a plain `GET` of the feed and then of the bundle: what any download sends (the address, a client name); nothing from a Workspace. *docs/privacy.md should say so once an updating build is handed out.*
- **What it does with a newer version:** downloads it, checks its signature against the key built in (a bundle that does not match is dropped), and keeps it in memory. The start screen then shows a quiet line, "Infall <version> is ready — Restart to update", with **Restart to update**. Nothing interrupts an open Workspace: the line is only on the start screen, and installing is refused while a Workspace is open.
- **Restart to update:** first **every Local Workspace gets a backup** now, due or not (`portable::back_up_now`, the same Workspace file and folder as the daily backups, newest seven kept). If any backup fails, nothing is installed and the line says which Workspace. Then the plugin installs: macOS replaces `Infall.app` with the one from the bundle and the app starts again; Windows runs the new installer (passive: a progress window) and the app ends; Ubuntu installs the new `.deb` with `dpkg -i` through `pkexec` (it asks for an administrator's password) and the app starts again.

### 11.2 The key pair

```sh
npx @tauri-apps/cli@2 signer generate -w ~/.tauri/infall-update.key
```

asks for a password and writes the private key (`infall-update.key`, encrypted with that password) and the public key (`infall-update.key.pub`). The public key is not secret: it is `INFALL_UPDATE_PUBKEY`, the repository variable of the same name. **The private key never goes into the repository**, nor into any file the build reads: it lives in a password manager (with its password, separately) and in the repository's secrets `TAURI_SIGNING_PRIVATE_KEY` (the file's content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Lose it and installed apps can never be updated again (a new key needs a new download by hand); leak it and anyone who can serve the feed can install their program — make a new pair and ship it at once.

### 11.3 What a release uploads

Per platform, an update bundle and its signature (`npx @tauri-apps/cli@2 signer sign <file>`, which writes `<file>.sig`), and one `latest.json` for all:

| Platform key in `latest.json` | Update bundle | Made by |
|---|---|---|
| `darwin-aarch64`, `darwin-x86_64` | `Infall-<version>-<arch>.app.tar.gz` (the signed `Infall.app`, gzipped tar) | `scripts/package-macos.sh` with the updater |
| `windows-x86_64` (and `-nsis`) | `Infall-<version>-x64-setup.exe` (the installer itself) | `scripts/package-windows.sh` |
| `linux-x86_64-deb`, `linux-aarch64-deb` | `infall_<version>_<arch>.deb` | `scripts/package-linux.sh`, which marks the program as installed from a `.deb` (as Tauri's bundler does) so the updater uses `dpkg` |

`latest.json` (written by `scripts/update-feed.py <folder> <version> <base-url>`):

```json
{ "version": "0.9.1", "notes": "…", "pub_date": "2026-12-01T12:00:00Z",
  "platforms": { "darwin-aarch64": { "signature": "<content of the .sig>", "url": "<base-url>/Infall-0.9.1-arm64.app.tar.gz" }, … } }
```

No workflow does this. Until 26 November 2026 `package.yml` had steps for it (build with the updater when the repository variables were set, sign each bundle with the secret key, write `latest.json` and draft a release); they were removed when the release workflow was written (section 12), so that the builds handed out are exactly the ones without an updater. `scripts/update-feed.py` and the scripts' `updater` switch are still there.

### 11.4 Seen, and not seen

Seen on this Mac (macOS 26.5, arm64), 25 November 2026: a throwaway key pair from `tauri signer generate`; a release build with the updater and `INFALL_UPDATE_URL=http://127.0.0.1:18732/latest.json`; a fake `Infall-0.9.1.app.tar.gz` signed with `tauri signer sign` and a `latest.json` served from the same machine. Started with an empty home folder, the 0.9.0 app asked for `latest.json`, downloaded the bundle, checked its signature and logged "version 0.9.1 is downloaded, checked and ready to install"; `updates.json` was written; started again at once, it asked nothing (the daily limit). The start screen's line and button were seen in the page with the app's answers stubbed, not in that running app (this environment cannot capture its window).

Not seen: installing an update on any system (macOS swapping the ad hoc signed bundle, Gatekeeper's view of it, the restart); Windows at all — the custom NSIS installer ignores the plugin's `/P`, `/UPDATE`, `/R` and `/ARGS` switches, shows its own pages and finishes with "Open Infall now" (it now waits up to ten seconds for the old program to end before asking); Ubuntu's `pkexec` prompt and the `.deb` marker in a real package; the workflow's signing and release steps.

### 11.5 What switching it on from GitHub Releases would take

Nothing of this is done; it is the owner's decision (the plan, M20, "Updates").

1. **A key pair** made once as in 11.2, by the owner, on their own computer. The public key becomes the repository variable `INFALL_UPDATE_PUBKEY`; the private key and its password the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and a copy in a password manager. It costs nothing; losing it means every installed app must be replaced by hand once.
2. **The feed address**: `INFALL_UPDATE_URL=https://github.com/egorivlev/infall/releases/latest/download/latest.json`. GitHub serves the newest *published, non-pre-release* release's file under that address, and only for a public repository. Every 0.x release is marked as a pre-release by `release.yml`, so either that marking is dropped or the feed lives elsewhere (a fixed tag such as `updates` whose `latest.json` is replaced at each release).
3. **The package jobs** pass both variables to the scripts (which then build with the `updater` feature) and, on a tag, sign each update bundle with `npx @tauri-apps/cli@2 signer sign` (the `.app.tar.gz` on macOS, the installer on Windows, the `.deb` on Ubuntu) and keep the `.sig` with it. The private key is given only to that step's environment.
4. **The release job** writes `latest.json` with `python3 scripts/update-feed.py release <version> https://github.com/egorivlev/infall/releases/download/v<version>` and attaches it and the `.sig` files to the release. The release must be published (not left as a draft) for the address in 2 to answer.
5. **docs/privacy.md** then says that the app checks the feed (11.1), and the README stops saying the apps do not update themselves.
6. **Before that**, the first update is tried by hand on each system (11.4, "Not seen"): macOS replacing an ad hoc signed bundle (Gatekeeper may treat the replaced app as new and ask again), Windows with the custom NSIS installer, Ubuntu with `pkexec`.

## 12. Releases on GitHub (M20)

The repository is `github.com/egorivlev/infall`. Four workflows in `.github/workflows/`; this section replaces the description of `ci.yml` and `package.yml` in 9.4 where they differ.

- **`ci.yml`**, on every push to a branch, every pull request, and by hand: the checks of CONTRIBUTING.md. The root workspace (`cargo fmt --check` on Ubuntu; `cargo clippy --all-targets -- -D warnings` and `cargo test --workspace` on Ubuntu 24.04, macOS 15 and Windows Server 2025), the web UI on Ubuntu (`npx tsc --noEmit -p tsconfig.app.json`, `npm run lint`, `npm test`, `npm run build`), and `desktop/src-tauri` on the same three systems (`cargo fmt --check` on Ubuntu, clippy and tests on all three, after building the web UI it embeds). `--no-fail-fast`, so one failing test file does not hide the rest. On Windows, git is told to keep line endings as committed (`core.autocrlf false`) before the checkout, since tests compare text from the repository. Tests that need a program the runner lacks print `SKIPPED` and pass: matplotlib, Julia, R and `qdk`, and node or bash where missing; most Runner and driver tests are Unix-only and not compiled on Windows.
- **`package.yml`**, on every push to a branch other than `main`, every pull request, by hand, and called by `release.yml` and `latest.yml`: the five installers as in 9.4 (`Infall-<version>-arm64.dmg`, `Infall-<version>-x64.dmg`, `Infall-<version>-x64-setup.exe`, `infall_<version>_amd64.deb`, `infall_<version>_arm64.deb`), as artifacts for 14 days, **without the updater** (11.5).
- **`latest.yml`**, on every push to `main` and by hand (added 27 November 2026): builds the five installers through `package.yml` and puts them, with `SHA256SUMS`, into one GitHub Release titled "Latest build (<version>, <commit>)" under the tag `latest`, marked as a pre-release and never as the repository's latest release. Each run deletes the previous release and its tag and makes them again at the new commit, so there is always exactly one. Its notes say which commit it is, that it is not a version and was checked by nobody, then the same table and opening instructions as a version's release. `package.yml` no longer runs by itself on pushes to `main`, so the packages are built once there. A newer push cancels a build still running.
- **`release.yml`**, on a tag `v*`: checks that the tag's version is the version in `desktop/src-tauri/Cargo.toml`, `tauri.conf.json` and `crates/server/Cargo.toml`, and that `CHANGELOG.md` has a section `## [<version>]`; builds the packages through `package.yml`; writes `SHA256SUMS` over the five files; and creates a **draft** GitHub Release named "Infall <version>" with the files and `SHA256SUMS`. Its notes are the CHANGELOG section (relative links turned into links to the tag's files), then `.github/release-notes-unsigned.md` (the files per system, the container image, what has been seen working where, how to check the SHA-256, and how to open an unsigned build on macOS, Windows and Ubuntu), then the checksums. Any 0.x version, and any version with a `-`, is marked as a pre-release. Run again on the same tag, it updates the draft's notes and replaces its files. Publishing the draft is a person's step, after the hand checks of section 8 on the files it holds.
- **`image.yml`**, on a tag `v*` (and on pull requests without pushing): the container image, section 10.3.

Every job asks only for the permissions it uses (`contents: read`; `contents: write` for the release job; `packages: write` for the image jobs) and no secret but the workflow's own `GITHUB_TOKEN`. Actions are pinned by major version (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`, `actions/upload-artifact@v7`, `actions/download-artifact@v8`, `Swatinem/rust-cache@v2`, and the Docker ones in 10.3). `actionlint` 1.7.12 with shellcheck reports nothing on the four files.

**How to make a release.** Set the version in `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/tauri.conf.json`, `crates/server/Cargo.toml` and `crates/core/Cargo.toml`; move CHANGELOG's "Unreleased" entries under `## [<version>] — <date>`; commit; `git tag -a v<version> -m "Infall <version>"`; push the commit and the tag. When the workflows are done, run section 8 on the draft's files, then publish it.

**What has run on GitHub**, as of 26 November 2026 (the repository's Actions list): the earlier versions of `ci.yml` and `package.yml` (9.4) on pushes of `main`, and `image.yml` on the tags `v0.9.0` and `v0.9.1`. `package.yml` built all five packages (the Ubuntu jobs with their full checks: installed in clean 22.04 and 24.04 containers, started with no network, a Tutorial Workspace opened, natively on amd64 and on arm64). `ci.yml` passed the server and web jobs both times and failed the desktop tests. Before the rename: on Ubuntu `the_chosen_folder_is_where_the_code_runs` (a `ZeroDivisionError` traceback in its output), on macOS `output_arrives_while_the_code_runs_about_ten_times_a_second` and `what_the_code_says_through_qoop_arrives_with_the_samples` (one progress sample too many; all three in `runner/tests/real_python.rs`), on Windows `bridge::tests::the_script_tells_the_app_what_undo_and_redo_would_do_and_nothing_more` (it looks for text with LF line endings, which git on Windows probably turned into CRLF at checkout; the workflow now keeps them as committed, which is not yet confirmed to fix it) and `files::tests::a_reference_managers_file_field_is_read` ("There is no such file in the folder you chose."). After the rename (`21c5b11`): the same on Ubuntu and Windows; macOS passed, so its two look timing-dependent. **The `ci.yml`, `package.yml` and `release.yml` of this section have not run yet.**

