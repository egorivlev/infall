# The desktop app carries the server, for Workspaces that live on one computer

Until M12 the desktop app could only show a Team Workspace, so its first screen asked for a server address, and a person without a team had nothing to type there: the Windows installer was handed to someone who had no server, and the app was of no use to them. So the real server (`crates/server`) is linked into the desktop app and runs inside its process on `127.0.0.1`, one SQLite file per Local Workspace. The start screen offers a Local Workspace from a Preset, a Tutorial Workspace among them, next to signing in to a Team Workspace (docs/specs/local.md).

This replaces one consequence of [ADR 0002](0002-desktop-app-primary-browser-fallback.md): "One always-on server … is still required; the app is not standalone." It still holds for a Team Workspace, which is the only way several people share a Board. The rest of ADR 0002 is unchanged.

## Considered Options

- **A hosted demo server** — rejected: it has to be paid for, run and kept up, it needs the network, and what someone makes there is not theirs and does not stay on their computer. It gives a look at Infall, not a place to work.
- **A fake server inside the web UI** — rejected: a second implementation of the API, the Change log, Branches and Merge, which would have to be kept true to the real one by hand, and would differ from it exactly where it is hardest to see.
- **The server as a sidecar program** — rejected: a second executable to build, ship, sign and start on three platforms, and to supervise (find a free port, wait for it, stop it, notice when it dies), with its own failure modes on each.

## Consequences

- The app is bigger: it contains the server, SQLite and a TLS library, and the built web UI, which it unpacks to a directory of its own before serving it.
- The app now listens on a TCP port on `127.0.0.1` while a Local Workspace is open. Any program on the computer can connect to it. What stops them from acting as the Member is a secret made new at each start and known only to the app: without it nothing can sign in. Other accounts on the same computer can reach the port too, and are kept out the same way. Whatever runs as the Member can already read the Workspace's files directly.
- A Local Workspace is files on that computer, in the app's data directory. Nothing copies them anywhere: losing the computer or deleting the folder loses the Workspace, and removing it from the start screen deletes its files for good.
- A Local Workspace has one Member and no invites, Guests or passwords; there is no way yet to move it onto a server and turn it into a Team Workspace.
- The server must keep working when it is started in-process: no environment variables, no signal handlers, the caller's runtime, a clean stop. A change to the server is now also a change to the desktop app, and the app's packages are built from both.
