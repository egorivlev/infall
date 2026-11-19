# Changelog

What changed in Infall, newest first, written from the repository's history. Milestones are those of [the plan](docs/plans/2026-11-24-road-to-1.0.md) and the specs in `docs/specs/`. Dates are when the work landed.

**How much of this has been seen working.** Everything below passed its test suites on macOS. Most of it has been used by hand in the macOS app; Ubuntu has been run only in containers (arm64, headless: release.md §9.1); **Windows has never been started** — it compiles and its installer is assembled (release.md §9.2), nothing more. The continuous build (`.github/workflows/`) has never run: the repository has no remote yet. Where a milestone was checked less than that, its entry says so.

## 0.9.0 — the beta (unreleased)

The first version number that means something: the beta the plan sends to three researchers. Everything from 0.1.0 to here was numbered 0.1.0. 0.9.0 holds M18, M19 and M19b, built and merged on 25 November, on top of M15 and M15b below. The server's schema is version 8; a database or Workspace file of any earlier version is brought up to it.

**How much of 0.9.0 has been seen working.** Every zone was merged with its own test suites passing on macOS, as its builder reported; the web UI's new screens are tested against the fake server in jsdom, and some were looked at in a browser. At `7f62d3a`, `cargo test --workspace` (core and server) was run again: 506 tests, all passing; the web UI's and the desktop app's suites were not run again. **Nothing below has been run through by hand in the packaged app** (the checklist is release.md §8, items 5–25), nor on Windows or Linux. Where an entry was checked less than that, it says so.

### From alone to a team (M18, [team-move.md](docs/specs/team-move.md))

- **Move to a Team server…** on the start screen: a Local Workspace goes onto an **empty** Team server. The app writes its Workspace file and opens the server; the server's first screen offers the Admin **Bring in <name> from this computer**, one press. The local Member's Changes, Checkpoints, To-dos, Pins and Comments become the Admin's. The copy on this computer stays, marked **Moved to <host>**, and opens read-only (**Open on the server**, **Open this copy (read-only)**). *The whole move has not been seen end to end in the packaged app; its parts were tested apart.*
- **An empty Team server's first screen**: **Start empty** or **Bring in a Workspace file…**, with progress, and the names the file brought, each with **Invite**. The same on the command line: `qoop-server import-workspace <file> --admin-email <e>`.
- **Leaving a server**: an Admin's **Export Workspace file…** (Settings → Workspace), and `qoop-server export-workspace <dest>` (it records the oldest Admin as who exported). Every Branch, the history, Checkpoints, To-dos, Comments, Suggestions and PDFs; Members and Admins as names only; no emails, passwords, sessions, invites, access tokens, AI settings or Guests. The desktop app opens such a file as a Local Workspace with the exporter as its one Member; another empty Team server takes it in with everyone else as **not signed in yet**.
- **Members as names**: an invite can take over such a name (`claims`); whoever accepts becomes that Member, with everything under the name.
- **Comments**: one thread per Card in its Page, `@` mentions of Members, edit and delete one's own (an Admin any), resolve and reopen, a count on the Card. Outside versioning like To-dos, kept when the Card is removed, never shown to Guests; in a Local Workspace they are notes to oneself and travel with a move.
- **For you**: the Comments that mention you, beside To-dos, with an unseen count in the rail and a short notice when a mention arrives.
- **Changes stored append-only** (schema version 6, before M18 proper): an edit appends rows instead of rewriting the Workspace; migrated from every earlier version. Schema version 7 adds Comments, For you, names without an email and claims.
- **The official container** for a Team server: `deploy/compose.yaml` with Caddy and automatic HTTPS from one domain setting, daily backups (database copies, until the backup job uses `export-workspace`), a checked copy before every upgrade, the first Admin in one command. Rehearsed on this Mac against `localhost` (release.md §10.4); *not on a real domain; the image workflow has never run; no outsider has installed it yet*.
- Desktop bridge for the move: `moveHandover`, `moveFile`, `moveDone`; `saveBinaryFile` for files the page makes (a PNG, a Team Workspace's file).

### PDFs on Sources (M19 Part 1, [pdf-sources.md](docs/specs/pdf-sources.md))

- A Source carries one PDF: **Attach PDF…** or drop a file, **Open PDF**, **Replace…**, **Remove PDF**, each one step of Undo. Stored once by its SHA-256, in the Workspace's database (schema version 8), never duplicated; which PDF a Source has is ordinary Research Content. At most 100 MB a file (`QOOP_MAX_PDF_MB`), PDFs only.
- **The reader**, in the Page's place: pages, zoom, **Fit width**, **Find** (⌘F), text selection, **Open in the system viewer** (desktop) or **Save a copy** (browser); the page is remembered per PDF on this device. PDF.js ships with Infall.
- **Search**: the text is read in the browser once and stored beside the file; ⌘K finds words in PDFs, "in the PDF of <title>, page N".
- **Fetch the PDF from arXiv** after Look up found an arXiv paper: the server downloads it, sending only the id, on that button only. *Tested against a fake arXiv; once for real by hand is still to do.*
- **Import BibTeX…** with Zotero's, JabRef's or Mendeley's `file` fields: **Attach the PDFs…** from a folder you pick, in the desktop app (`pickFolder`, `readFileIn`, `openExternally`; the page never sees a path). In a browser the entries come in without their PDFs and the report says how many had one.
- **Workspace files carry the PDFs**: exports, backups, moves, Team files. **Export…** on the start screen asks "Include PDFs (N files, X MB)", ticked, when there are any.

### Runs in more than Python, an environment per Run (M19 Part 2 and M19b, [desktop.md](docs/specs/desktop.md))

- A Run names its **language** (`lang`; unset is Python) and, for Python and Q#, an **environment** (`env`); each Member decides on their own computer what those names start. Nothing is ever installed.
- **Runner settings**: environments found (conda, pyenv, `venv`/`.venv` in the folder, the `PATH`) or added by hand; **Names Runs ask for**, asked once when a Run names one this computer lacks; **Languages**: Q# through the default Python's `qdk`, presets for Julia, R, JavaScript (node) and Shell (bash; on Windows Git for Windows' bash), any other language as a program with `{file}` among its arguments.
- **The approval window** names the language, the environment and the interpreter or command; an approval is remembered per code, language, interpreter or program, and folder, so the same code as another language asks again. Approvals from before ask once more.
- **A result records what ran**: the Python version and up to 32 packages the code imported with what they need directly ("Python 3.12.3 · numpy 2.1.0, …"), Q#'s `qdk` version, another language's `--version`; and `[qoop] This environment has no package <name>.` when one is missing.
- An app from before 0.9.0 refuses a Run in another language ("Update Infall on this computer to run Julia code.") instead of running it as Python.
- Every Run starts with the documented usage-report switches of `qdk`/`qsharp`, `huggingface_hub` and `mlflow` turned off.
- *macOS only: Julia and R were not installed here, so their presets were tested with stand-ins; node, bash and Q# (qdk 1.28 and 1.34) ran for real. Windows and Linux not run.*

### The Board as a picture (M19 Part 3)

- **Export ▾** → **Board as SVG…** or **Board as PNG…** (1×, 2×, 4×), the whole Board or the visible area, on the theme's background or a light one, at the moment History shows.

### Desktop app

- **Windows: Local Workspaces live in the local app data folder** (`%LOCALAPPDATA%\app.qoop.desktop\`), not the roaming one; those an earlier version kept in `%APPDATA%` are moved on the first start, checked byte for byte, and any that cannot be moved stay where they are and are used from there. *Tested with folders on macOS; never run on Windows.*
- **Updates** (M20 groundwork): a build made with an update key and feed checks for a new version at most once a day and from **Check for updates…**, downloads it, checks its signature, and offers "Restart to update" on the start screen — never while a Workspace is open. Every Local Workspace is backed up before the update is installed. Today's builds have no key and no feed, so they have no updater and say nothing. *Seen on macOS against a feed served on the same machine: the check, the download and the signature check. Installing an update was not tried on any system.*
- Version 0.9.0 in the app and the server crates (`Cargo.toml`, `tauri.conf.json`).

## M15 — Undo, and the Board at size (24–25 Nov)

- **Undo and Redo** (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z) for every Board and Page gesture, undoing only your own recent Changes on the Branch, as new Changes. The desktop Edit menu names the step. The Tutorial has an Undo step; the Tour shows it.
- **The Board at size**: a generator for large Workspaces (2 000 Cards, 50 000 Changes), measurements (`docs/specs/scale.md`), and a Board that draws only what is in view. A test fails when the numbers regress.
- *The Edit menu's own items were seen in a scratch build; a real Cmd+Z in a frontmost window, Windows and Linux were not.*

## M15b — the Branch Graph (24 Nov)

- The Branches screen became the Branch Graph: every Branch from the first Change, forks and Merges drawn, Checkpoints marked; start a Branch from any point; preview the Board there. History's Activities end at Checkpoints.

## M16 (part) — Windows and Ubuntu without the machines (24 Nov)

- Ubuntu arm64 packaged and run in containers, every check of the script passing; fixes to that check.
- Windows: compiles for the GNU target, the installer is assembled; a fix for older mingw-w64.
- Continuous builds and tests on every push, for all three systems. *Never run (no remote).*
- *The real Windows and Ubuntu desktop runs are still to do (release.md §9.3).*

## M14 — Solid ground (24 Nov)

- The four known defects fixed (sideways scroll at 150 %, one session cookie for all Local Workspaces, raw database import, BibTeX case protection); a rescue import of a hand-copied `workspace.sqlite`; the plan to 1.0.

## M12 and M13 — Workspaces on this computer, getting work in and out (24 Nov)

- **Local Workspaces**: the server runs inside the desktop app; a start screen lists every Workspace and makes new ones from Presets (Tutorial, Blank, Literature review, Research project). No server, no sign-in.
- The hands-on **Tutorial**, **Settings** with three interface scales.
- **Workspace files** (`.infall`): export, import, and a backup of every Local Workspace each day it is opened (newest seven kept). Page as Markdown, printing, BibTeX out and in, **Look up** of a DOI or arXiv id.

## M11 — Ubuntu and Windows packages, the Tour (23 Nov)

- `.deb` for Ubuntu 22.04/24.04 and an installer for Windows, built by scripts without tauri-cli. A Tour of Infall and a written tutorial.

## M10 — First real use (23 Nov)

- The macOS disk image, signed ad hoc; the deploy guide followed on a clean Debian in a container, with backup and restore; the first-day page. The product's name became Infall.

## M9 — the Runner monitor (23 Nov)

- While a Run executes: processor, memory, graphics processor, time, and progress the code reports (`qoop.step`, `qoop.progress`, or a `tqdm` bar). *macOS; Linux paths tested only against hand-written text.*

## M8 — Runs and the Runner (22 Nov)

- Run blocks: code executed on the Member's own computer, only after they have read and approved it in the app's own window; output, figures and the environment captured into the Page.

## M7 — the desktop app and the AI sidebar (22 Nov)

- The Tauri shell around the web UI, with the AI sidebar running on the Member's own Claude Code (only Infall's tools allowed) or on OpenRouter; Pin an answer to a Page.

## M6 — Visuals and Guests (22 Nov)

- Visual blocks (sandboxed interactive figures) and a read-only Guest view of main.

## M5 — the AI tool layer (22 Nov)

- An MCP endpoint and access tokens; Suggestions an AI makes for a Member to accept.

## M4 — Pages, Sources and To-dos (22 Nov)

- A Page inside each Card (text, formulas, code, Sources), and To-dos.

## M3 — Merge (22 Nov)

- Merge review between Branches, with conflicts decided by hand and Merges that can be undone.

## M2 — History, Checkpoints, Restore, Branches (22 Nov)

- Every Change in History; Checkpoints; non-destructive Restore; Branches.

## M1 — the Board (22 Nov)

- The core model (Cards, Frames, Connections, Changes), the server, the web app with its live Board, the deploy kit.
