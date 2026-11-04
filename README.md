# Infall

The product is called **Infall**; code, packages and paths still say `qoop` (`qoop-server`, `QOOP_*`, `/etc/qoop`), from its first name.

A self-hosted shared workspace where a small research team maps, extends, and tracks the state of a research project. Vocabulary: [CONTEXT.md](CONTEXT.md). Decisions: [docs/adr](docs/adr). Rules: [docs/specs](docs/specs).

## Two ways in

- **On your own, with no server.** Install the desktop app ([desktop/README.md](desktop/README.md): macOS, Ubuntu, Windows) and choose **Tutorial** under **Create a workspace** on its start screen. That makes a Local Workspace on your computer, with a sample Board and a hands-on Tutorial through every part of Infall. Nothing else is installed, nothing is typed, and no network is needed. A Local Workspace has one Member, you, and stays on that computer.
- **As a team.** Someone runs a server ([deploy/README.md](deploy/README.md)); everyone else is invited ([docs/first-day.md](docs/first-day.md)) and uses a browser or the desktop app's **Sign in to a Team Workspace**. A Team Workspace is the only way several people share a Board.

A Local Workspace cannot yet be moved onto a server.

## Getting work in and out

A Local Workspace exports to one Workspace file (`.infall`) from the start screen (**Export…**), and **Import a workspace…** makes a new Local Workspace from one; sign-ins, access tokens and the OpenRouter key are never in it. The desktop app also keeps the newest 7 daily copies of each Local Workspace by itself, in its folder (**Show in folder**). In any Workspace, a Page can be saved as Markdown or printed to PDF, and Sources go out and come in as BibTeX, which is what Zotero, Mendeley and JabRef export. **Look up** fills in a Source from its DOI or arXiv id. How: [the tutorial](docs/tutorial.md#12-getting-work-in-and-out), part 12.

What Infall talks to, and when: [docs/privacy.md](docs/privacy.md). In short, the Workspace's own server; the AI only once it is set up and used; Crossref or arXiv only when **Look up** is pressed; nothing else.

## What exists

| Part | Where | State |
|---|---|---|
| Versioning core: Changes, Branches, Checkpoints, Restore, Merge | `crates/core` | tested |
| Server: accounts by invite, Members and Guests, persistence, live updates, History, Merge review, Pages, Sources, To-dos, Suggestions, access tokens and the AI tool endpoint, Runs' results, Look up (M13) | `crates/server` | tested; contract in [docs/specs/api.md](docs/specs/api.md) |
| Web app: the Board (Cards, Frames, Connections), Undo and Redo of one's own gestures on the Board and in Pages (M15), the Branch Graph (every Branch's Activities, forks and Merges; start a Branch from any moment, M15b), History and Restore, Merge review, Pages with text, formulas, Visuals, Runs and Sources, To-dos, Suggestions, the AI sidebar and Pin, the Guest view, the Tour, Settings, Markdown, print and BibTeX (M13) | `web/` | tested |
| Desktop app: the server inside for Local Workspaces, the start screen, the hands-on Tutorial, the AI sidebar on Claude Code, the Runner and its monitor, Workspace files and backups (M13), Undo and Redo in the Edit menu (M15) | `desktop/` | see [desktop/README.md](desktop/README.md), including what has not been verified |
| Desktop app packages | `scripts/package-macos.sh`, `package-linux.sh`, `package-windows.sh` | an ad hoc signed `.dmg` (not notarised), an unsigned `.deb`, an unsigned installer that has never been started on Windows |
| Deployment kit: systemd, Caddy, backups, hardening | `deploy/` | rehearsed on a clean Debian 12 in a container (`scripts/rehearse-deploy.sh`); not yet run on a real VPS |
| For people: the first day, the tutorial, privacy | [docs/first-day.md](docs/first-day.md), [docs/tutorial.md](docs/tutorial.md), [docs/privacy.md](docs/privacy.md) | |
| Design source | `design/` | reference |

By milestone: M1 the Board; M2 History, Checkpoints, Restore, Branches; M3 Merge review; M4 Pages, Sources, To-dos; M5 the AI tool layer, access tokens, Suggestions; M6 Visuals and Guests; M7 the desktop app, the AI sidebar, Pin; M8 Runs and the Runner; M9 the Runner monitor; M10 the macOS package, the rehearsed deploy, the first day; M11 the Ubuntu and Windows packages, the Tour and the written tutorial; M12 Local Workspaces, the start screen, the hands-on Tutorial; M13 Workspace files, backups, Markdown, print, BibTeX and Look up ([docs/specs/portability.md](docs/specs/portability.md)); M14 known defects fixed and the rescue import; M15 Undo ([docs/specs/undo.md](docs/specs/undo.md)) and the Board at size ([docs/specs/scale.md](docs/specs/scale.md)); M15b the Branch Graph ([docs/specs/branch-graph.md](docs/specs/branch-graph.md)). Not there: moving a Local Workspace onto a server, PDFs inside Infall, code signing, updates.

## Run it locally

Needs Rust (1.96+) and Node (22+).

```bash
sh scripts/dev-server.sh
```

That creates `.dev/qoop.db` with an Admin `admin@qoop.test` on first run (the generated password is in `.dev/admin-password`, git-ignored) and serves the API on http://localhost:8787.

```bash
npm --prefix web install
```

```bash
npm --prefix web run dev
```

Open http://localhost:5173. To serve the built UI from the server itself instead, run `npm --prefix web run build` and open http://localhost:8787.

### The AI sidebar while developing

- In a browser the sidebar needs the OpenRouter path. Put a secret into `.dev/server.env` (git-ignored; read by `scripts/dev-server.sh`):
  `printf 'QOOP_SECRET_KEY=%s\n' "$(cargo run -q -p qoop-server -- gen-secret-key)" > .dev/server.env`, restart the server, then add your key under **AI access**.
- The desktop app (which runs the sidebar on your own Claude Code) lives in [desktop/](desktop/README.md). It carries the built web UI, so build that first: `npm --prefix web run build`, then `cd desktop/src-tauri && cargo run`. On its start screen, create a Local Workspace, or enter `http://localhost:8787` under **Sign in to a Team Workspace** to use the development server.

## Check everything

```bash
cargo test --workspace            # core + server
(cd desktop/src-tauri && cargo test)  # desktop app, separate workspace
```

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

```bash
npm --prefix web test
```

## Put it on a server

Follow [deploy/README.md](deploy/README.md), then [deploy/harden.md](deploy/harden.md).
