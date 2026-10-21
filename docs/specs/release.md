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
