# M10 — first real use

Until now Infall has only run on the computer it was written on. M10 changes nothing a Member can do in Infall; it makes Infall something the team can be given: an app that installs, a server that has been put on a clean machine by following the guide, and a backup that has been restored once.

## 1. The desktop app as something to install (macOS)

- `scripts/package-macos.sh` builds `dist/Infall-<version>.dmg` from a clean checkout with the tools macOS and Rust already bring (`cargo`, `sips`, `iconutil`, `codesign`, `hdiutil`). No `tauri-cli`, no new dependencies.
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
- Checked by the script itself: the package installs with `apt` in a clean Ubuntu 22.04 and a clean 24.04 container, every shared library resolves, and the program starts and stays up under a virtual display. The script prints the SHA-256.
- Not signed, no repository, no auto-update, no Snap/Flatpak/AppImage.

## 6. The desktop app for Windows (M11)

- `scripts/package-windows.sh` builds `dist/Infall-<version>-x64-setup.exe` from a Mac or a Linux machine by cross-compiling. It uses tools whose licences need no acceptance on the builder's behalf (the GNU toolchain for Windows and NSIS), and says at the start which ones it needs and how to get them.
- The installer installs for the current person without administrator rights (under their local programs folder), adds a Start menu entry and an uninstaller entry, and removes exactly what it installed. It does not remove app data on uninstall.
- Infall on Windows needs Microsoft's WebView2 runtime, which Windows 11 has and current Windows 10 normally has. The installer checks for it and, if it is missing, says so in plain words with where to get it; it downloads nothing by itself.
- Not signed: Windows shows its "unknown publisher" warning. `desktop/README.md` says what the Member sees and does, as for macOS, and that the SHA-256 printed by the script is how to tell the real file.
- This package cannot be started on the machine that builds it. What was and was not checked (it compiles, links, the installer is assembled and its contents listed; **not** that it starts on Windows) is said plainly in `desktop/README.md` under "Unverified".

For both: what the Runner can and cannot do on that platform (finding Python, stopping a Run and everything it started, usage figures in the Runner monitor) is checked in the source and written down in `desktop/README.md`; nothing is claimed that the code does not do there.
