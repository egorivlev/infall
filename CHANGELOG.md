# Changelog

What changed in Infall, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/), and before 1.0 any version may change what came before it. The words are those of [CONTEXT.md](CONTEXT.md).

## [Unreleased]

### Added

- **The desktop app updates itself.** A build from this repository's releases looks for a newer one (at start and while it runs, at most once a day, and from **Infall → Check for updates…**), downloads it, checks it against the update key built into the app, and asks **Restart to update** or **Later**; the start screen keeps the line. Restarting backs up every Local Workspace first. **Infall → Get beta builds** follows the build of every change to `main` (the Latest build release, looked for every five minutes) instead of published versions. An app installed before this has no updater and is downloaded once more by hand. *Seen: the check, the download and the signature check against a feed on the same Mac. Not seen: an update installed on any system, the question over an open Workspace, the beta switch in a packaged app, the workflows that sign and publish the feed.* ([release.md §11](docs/specs/release.md#11-updates-m20-groundwork))
- **An outdated Team server is said.** A Team server's health check names its version, and the desktop app, when it opens a Team Workspace whose server is older than the app, says so once ("This workspace's server is outdated": everything that server has still works; what is newer appears once an Admin updates the server). A server too old for the app to work with is not opened, with a sentence asking for an Admin to update it; no server is that old today. *Seen as tests only.* ([desktop.md](docs/specs/desktop.md#an-outdated-team-server-built-2026-11-28))

### Changed

- A 0.x release on GitHub is no longer marked as a pre-release (a version like `1.2.0-rc.1` still is): installed apps update to the newest release that is not one.
- `GET /api/health` also answers the server's `version`. It is public, as the health check always was: anyone who can reach a Team server can read which version it runs.

## [0.9.0] — not yet released

The first version of Infall published as open source, under the Apache License 2.0, and the version three researchers are to try on real work before 1.0. Everything built until now is in it: the sections below list what is new since the internal builds of 0.1.0, and [Before 0.9.0](#before-090) lists what came before.

**What has been seen working where.** On macOS the app is built, packaged and used, and every part's tests pass. Ubuntu has been run only in containers (installed, started with no network, a Tutorial Workspace opened), not on a desktop. **Windows compiles and its installer is built, but Infall has never been started on Windows.** The screens added in this version were tested in a browser against a fake server and in development builds; they have not all been gone through by hand in the packaged app ([the release checklist](docs/specs/release.md#8-before-handing-out-a-release-m13)). Where an entry was checked less than that, it says so in italics.

**Upgrading.** The server's schema is version 8; a database or Workspace file of any earlier version is brought up to it when it is opened. A Team server is updated with `./update.sh` ([deploy/README.md](deploy/README.md)).

### Added: from alone to a team

- **Move to a Team server…** on the desktop app's start screen moves a Local Workspace onto an **empty** Team server: the app writes its Workspace file and opens the server, whose first screen offers the Admin **Bring in <name> from this computer**. The local Member's Changes, Checkpoints, To-dos, Pins and Comments become the Admin's. The copy on this computer stays, marked **Moved to <host>**, and opens read-only. *The whole move has not been seen end to end in the packaged app; its parts were tested apart.*
- **An empty Team server's first screen**: **Start empty** or **Bring in a Workspace file…**, with progress, and the names the file brought, each with **Invite**. The same on the command line: `infall-server import-workspace <file> --admin-email <e>`.
- **Leaving a server**: an Admin's **Export Workspace file…** (Settings → Workspace), and `infall-server export-workspace <dest>`. The file holds every Branch, the history, Checkpoints, To-dos, Comments, Suggestions and PDFs, with Members and Admins as names only: no emails, passwords, sessions, invites, access tokens, AI settings or Guests. The desktop app opens it as a Local Workspace; another empty Team server takes it in with everyone else as **not signed in yet**.
- **Members as names**: an invite can take over such a name, and whoever accepts it becomes that Member, with everything under the name.
- **Comments**: one thread per Card, `@` mentions of Members, edit and delete one's own (an Admin any), resolve and reopen, a count on the Card. Outside versioning like To-dos, kept when the Card is removed, never shown to Guests.
- **For you**: the Comments that mention you, beside To-dos, with an unseen count and a short notice when a mention arrives.
- **The official container** for a Team server: `deploy/compose.yaml` with Caddy and automatic HTTPS from one domain setting, a Workspace file as the daily backup (database copies besides, for putting the server back with its sign-ins), a checked copy of the database before every upgrade, the first Admin in one command, and `deploy/update.sh` to update it in one command. Images for amd64 and arm64 at `ghcr.io/egorivlev/infall`. *Rehearsed in containers against `localhost`, not yet on a real domain, and not yet installed by someone outside the project from the guide.*

### Added: PDFs on Sources

- A Source carries one PDF: **Attach PDF…** or drop a file, **Open PDF**, **Replace…**, **Remove PDF**, each one step of Undo. Stored once by its SHA-256 in the Workspace's database, never duplicated. At most 100 MB a file by default (`INFALL_MAX_PDF_MB`), PDFs only.
- **The reader**, in the Page's place: pages, zoom, **Fit width**, **Find** (⌘F / Ctrl+F), text selection, **Open in the system viewer** (desktop) or **Save a copy** (browser). PDF.js ships with Infall.
- **Search** (⌘K / Ctrl+K) finds words inside PDFs: "in the PDF of <title>, page N".
- **Fetch the PDF from arXiv** after **Look up** found an arXiv paper: the server downloads it, sending only the id, and only when that button is pressed. *Tested against a fake arXiv; not yet once for real by hand.*
- **Import BibTeX…** reads the `file` fields of Zotero, JabRef and Mendeley exports: in the desktop app, **Attach the PDFs…** from a folder you pick. In a browser the entries come in without their PDFs, and the report says how many had one.
- **Workspace files carry the PDFs**: exports, backups, moves. **Export…** on the start screen asks whether to include them.

### Added: Runs in more than Python, and an environment per Run

- A Run names its **language** (Python unless set) and, for Python and Q#, an **environment**; each Member decides on their own computer what those names start. Nothing is ever installed.
- **Runner settings**: Python environments found (conda, pyenv, `venv` / `.venv` in the folder, the `PATH`) or added by hand; names a Run asks for, asked once when a Run names one this computer lacks; **Languages**: Q# through the default Python's `qdk`, presets for Julia, R, JavaScript (node) and Shell (bash; on Windows Git for Windows' bash), and any other language as a program with `{file}` among its arguments. A program that is there but does not work (it crashes or fails when asked its version) is shown with the reason, and never offered first.
- **The approval window** names the language, the environment and the interpreter or command. An approval is remembered per code, language, interpreter or program, and folder, so the same code sent as another language asks again. Approvals from earlier versions ask once more.
- **A result records what ran**: the Python version and up to 32 packages the code imported ("Python 3.12.3 · numpy 2.1.0, …"), Q#'s `qdk` version, or another language's `--version`; and `[infall] This environment has no package <name>.` when one is missing.
- **Stop** also ends what a Run started outside its process group (Julia's `Distributed` workers, `run(detach(…))`, a shell's background jobs), on macOS and Linux.
- A Run in a language other than Python gets a UTF-8 locale when none is set, so that R prints "αβγ" as letters.
- Every Run starts with the documented usage-report switches of `qdk` / `qsharp`, `huggingface_hub` and `mlflow` turned off.
- An app older than 0.9.0 refuses a Run in another language ("Update Infall on this computer to run Julia code.") instead of running it as Python.
- *Run for real on macOS: Python, Q# (qdk 1.28 and 1.34), node, bash; tests against real Julia and R were added and skip where those programs are missing. Not run on Windows or on a Linux desktop.*

### Added: the Board as a picture

- **Export ▾** → **Board as SVG…** or **Board as PNG…** (1×, 2×, 4×), the whole Board or the visible area, on the theme's background or a light one, as of the moment History shows.

### Changed

- **The name in the code is Infall.** The programs, packages, folders, settings and the app's identifier (`app.infall.desktop`) were renamed from the working name `qoop`. What an earlier build left keeps working: the first start moves the app's folders from `app.qoop.desktop` (checked byte for byte, nothing written over); the page carries over its stored settings; Runs still find `QOOP_RUN_DIR` and `import qoop`; `qoop_pat_` access tokens are accepted; `QOOP_*` variables are read when the `INFALL_*` one is not set, with a warning. You sign in to a Team Workspace again once. Details: [desktop.md](docs/specs/desktop.md#names-before-the-rename), [api.md](docs/specs/api.md#names-before-the-rename). *Tested with temporary folders.*
- **Changes are stored append-only**: an edit appends rows instead of rewriting the whole Workspace, so an edit no longer gets slower as the history grows.
- **Windows: Local Workspaces live in the local app data folder** (`%LOCALAPPDATA%\app.infall.desktop\`), not the roaming one; those an earlier build kept in `%APPDATA%` are moved on the first start. *Tested with folders on macOS; never run on Windows.*
- The top bar's first row is 36 px; in the macOS app the window buttons sit in its middle, follow the interface scale, and give their room back in full screen.

### Fixed

- Found by running the web UI against the real server: History and Merge name PDF changes; search shows the matched word in its snippet; the reader shows the page of a find hit; the theme and interface scale no longer flash at their defaults when the page loads (the server's content security policy refused the inline script).
- A pending move to a server that is not empty, or by someone who is not its Admin, says why, and can be cancelled from the server's page.
- The invite page of a claimed name says whose work comes with it.
- The search field's focus ring is no longer hidden by the Branch stripe on a Branch other than main.

### Not in this version

- **Signed builds.** The macOS app is signed ad hoc and not notarised; the Windows installer and the Ubuntu package are unsigned. [README.md](README.md#install-from-a-release) says how to open them and how to check a download against its SHA-256.
- **Updates** were not in the builds of 0.9.0 made before 28 November 2026; see [Unreleased](#unreleased).

## Before 0.9.0

Internal milestones of the [plan](docs/plans/2026-11-24-road-to-1.0.md), all numbered 0.1.0 and never released. They are listed here for the record, in the names of their day (the code was still called `qoop`, so for example `qoop.step`).

### M15 — Undo, and the Board at size

- **Undo and Redo** (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z) for every Board and Page gesture, undoing only your own recent Changes on the Branch, as new Changes. The desktop Edit menu names the step. The Tutorial has an Undo step; the Tour shows it.
- **The Board at size**: a generator for large Workspaces (2 000 Cards, 50 000 Changes), measurements ([scale.md](docs/specs/scale.md)), and a Board that draws only what is in view. A test fails when the numbers regress.
- *The Edit menu's own items were seen in a development build; a real Cmd+Z in a frontmost packaged app, Windows and Linux were not.*

### M15b — the Branch Graph

- The Branches screen became the Branch Graph: every Branch from the first Change, forks and Merges drawn, Checkpoints marked; start a Branch from any point; preview the Board there. History's Activities end at Checkpoints.

### M16 (part) — Windows and Ubuntu without the machines

- Ubuntu arm64 packaged and run in containers, every check of the script passing; fixes to that check.
- Windows: compiles for the GNU target, the installer is assembled; a fix for older mingw-w64.
- Continuous builds and tests for all three systems ([.github/workflows](.github/workflows)).
- *The real Windows and Ubuntu desktop runs are still to do ([release.md §9.3](docs/specs/release.md#93-the-first-run-on-a-real-windows-machine-by-hand)).*

### M14 — Solid ground

- Four known defects fixed (sideways scroll at 150 %, one session cookie for all Local Workspaces, raw database import, BibTeX case protection); a rescue import of a hand-copied `workspace.sqlite`.

### M12 and M13 — Workspaces on this computer, getting work in and out

- **Local Workspaces**: the server runs inside the desktop app; a start screen lists every Workspace and makes new ones from Presets (Tutorial, Blank, Literature review, Research project). No server, no sign-in.
- The hands-on **Tutorial**, **Settings** with three interface scales.
- **Workspace files** (`.infall`): export, import, and a backup of every Local Workspace each day it is opened (newest seven kept). Page as Markdown, printing, BibTeX out and in, **Look up** of a DOI or arXiv id.

### M11 — Ubuntu and Windows packages, the Tour

- `.deb` for Ubuntu 22.04/24.04 and an installer for Windows, built by scripts without tauri-cli. A Tour of Infall and a written tutorial.

### M10 — First real use

- The macOS disk image, signed ad hoc; the deploy guide followed on a clean Debian in a container, with backup and restore; the first-day page. The product's name became Infall.

### M9 — the Runner monitor

- While a Run executes: processor, memory, graphics processor, time, and progress the code reports (`qoop.step`, `qoop.progress`, or a `tqdm` bar). *macOS; Linux paths tested only against hand-written text.*

### M8 — Runs and the Runner

- Run blocks: code executed on the Member's own computer, only after they have read and approved it in the app's own window; output, figures and the environment captured into the Page.

### M7 — the desktop app and the AI sidebar

- The Tauri shell around the web UI, with the AI sidebar running on the Member's own Claude Code (only Infall's tools allowed) or on OpenRouter; Pin an answer to a Page.

### M6 — Visuals and Guests

- Visual blocks (sandboxed interactive figures) and a read-only Guest view of main.

### M5 — the AI tool layer

- An MCP endpoint and access tokens; Suggestions an AI makes for a Member to accept.

### M4 — Pages, Sources and To-dos

- A Page inside each Card (text, formulas, code, Sources), and To-dos.

### M3 — Merge

- Merge review between Branches, with conflicts decided by hand and Merges that can be undone.

### M2 — History, Checkpoints, Restore, Branches

- Every Change in History; Checkpoints; non-destructive Restore; Branches.

### M1 — the Board

- The core model (Cards, Frames, Connections, Changes), the server, the web app with its live Board, the deploy kit.

[Unreleased]: https://github.com/egorivlev/infall/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/egorivlev/infall/releases/tag/v0.9.0
