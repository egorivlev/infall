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
