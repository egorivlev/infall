# Changelog

What changed in Infall, newest first, written from the repository's history. Milestones are those of [the plan](docs/plans/2026-11-24-road-to-1.0.md) and the specs in `docs/specs/`. Dates are when the work landed.

**How much of this has been seen working.** Everything below passed its test suites on macOS. Most of it has been used by hand in the macOS app; Ubuntu has been run only in containers (arm64, headless: release.md §9.1); **Windows has never been started** — it compiles and its installer is assembled (release.md §9.2), nothing more. The continuous build (`.github/workflows/`) has never run: the repository has no remote yet. Where a milestone was checked less than that, its entry says so.

## 0.9.0 — the beta (unreleased)

The first version number that means something: the beta the plan sends to three researchers. Everything from 0.1.0 to here was numbered 0.1.0.

### Desktop app

- **PDFs from a folder you choose** (M19, decision 10): the bridge gains `pickFolder()`, `readFileIn(token, path)` and `openExternally({ suggestedName, bytes })`, so Import BibTeX can attach the PDFs a Zotero, JabRef or Mendeley export points at, and a PDF can be opened in the system's viewer. The page never sees a path; only PDFs inside the chosen folder, at most 100 MB, can be read. *The web UI that calls them is a separate zone; not seen end to end.*
- **Export… asks about PDFs** when the Workspace has any ("Include PDFs (N files, X MB)", on by default). *Waits for the server crate to count and export them; until then the question is never asked.*
- **Windows: Local Workspaces live in the local app data folder** (`%LOCALAPPDATA%\app.qoop.desktop\`), not the roaming one; those an earlier version kept in `%APPDATA%` are moved on the first start, checked byte for byte, and any that cannot be moved stay where they are and are used from there. *Tested with folders on macOS; never run on Windows.*
- **Updates** (M20 groundwork): a build made with an update key and feed checks for a new version at most once a day and from **Check for updates…**, downloads it, checks its signature, and offers "Restart to update" on the start screen — never while a Workspace is open. Every Local Workspace is backed up before the update is installed. Today's builds have no key and no feed, so they have no updater and say nothing. *Seen on macOS against a feed served on the same machine: the check, the download and the signature check. Installing an update was not tried on any system.*
- Version 0.9.0 in the app (`Cargo.toml`, `tauri.conf.json`).

## M19b and M19 Part 2 — Runs in more than Python, an environment per Run (25 Nov)

- A Run names its language and, for Python and Q#, an environment; each Member decides on their own computer what those names start (Toolchains). Q# through the `qdk` package, presets for Julia, R, JavaScript and Shell, any other language by hand.
- Runner settings: named environments (conda, pyenv, `.venv`, by hand), names Runs ask for, languages; the approval window names the language, environment and command; an approval is remembered per language and interpreter.
- A Run's result records Python and the versions of the packages its code imported.
- Every Run starts with the documented usage-report switches of common packages turned off.
- *macOS only. Windows and Linux not run.*

## M18 — From alone to a team (25 Nov)

- **Move to a Team server…**: a Local Workspace is handed to an empty Team server through the bridge (`moveHandover`, `moveFile`, `moveDone`); the copy left on this computer becomes read-only. `saveBinaryFile` for files the page makes.
- **Changes stored append-only** (schema version 6), with a migration from every earlier version: an edit no longer rewrites the whole Workspace.
- **The official container** for a Team server: `compose.yaml` with Caddy and HTTPS, daily backups, a checked copy before every upgrade. Rehearsed on this Mac; *the image workflow has never run*.
- *The server side of the move (taking a Workspace file in) is still being built at the time of writing; the move has not been seen end to end.*

## M19 Part 3 — the Board as an image (25 Nov)

- Export the Board as SVG and PNG.

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
