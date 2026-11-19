# Design brief for Claude Design (M17)

Paste everything below the line into Claude Design, with this repository attached. It replaces the prompt written on 23 November 2026: it covers every screen built without a designer through version 0.9.0 (M12–M19b).

---

You are redesigning the parts of Infall that were built by engineers without a designer. Infall is a desktop app (Tauri) and web UI for small research teams and for researchers working alone: a spatial Board of Cards joined by Connections and grouped in Frames; each Card opens into a Page (text, math, Simulations, Sources with PDFs); the work is versioned in Branches with History, Merge and Undo.

Read before designing — these are binding:

- `CONTEXT.md` — the product's vocabulary. Every word a person reads must use these terms exactly. Note the "Avoid" lists.
- `web/src/ui/DESIGN.md` and `web/src/styles/` — the existing design system: tokens, type (IBM Plex Sans, IBM Plex Mono, Source Serif 4, shipped locally), colour, both themes, the interface-scale / text-size / Board-scale settings, and the "room" rule that decides layout by window width divided by interface scale.
- `design/` — the Infall name and the black-hole mark.
- The specs in `docs/specs/` named under each item. Behaviour is settled; you are changing how it looks and reads, not what it does.

Constraints that hold everywhere: both themes; interface scale 80–150 % and text size 85–130 %; windows from 900 × 600; full keyboard use with visible focus; a label on every input; reduced motion; no network resources (fonts and everything else are local); the server's content policy forbids inline scripts and remote anything.

## What to redesign

Each item is functional today. Screenshots of the current state can be made by running the app (`dist/Infall-0.9.0.dmg`) and creating a Tutorial Workspace.

**A. Before a Workspace is open (desktop only; plain HTML/CSS/JS in `desktop/ui/`, no build step)**

1. **Start screen** — `index.html`, `setup.css`, `setup.js`; `docs/specs/local.md`, `portability.md`, `team-move.md`. Your workspaces (rows: name, Local/Team, Preset or address, opened, backed up, moved; a ⋯ menu with Rename, Export… with "Include PDFs", Show in folder, Move to a Team server…, Remove…), Import a workspace…, Create a workspace (four Preset tiles), Sign in to a Team Workspace, a notice line (a server that did not answer; an update that is ready). 920 × 640, down to 720 × 560. Known weakness: the hierarchy between the three parts; when a list exists the Preset tiles shrink to names. Decide what a first-time person sees and what a returning person sees.
2. **Runner settings window** — `runner.html`, `runner.js`, `runner.css`; `docs/specs/desktop.md` "Environments and Toolchains — as built". Python and working folder, environments and the names Runs ask for, languages (Q#, Julia, R, JavaScript, Shell, others by hand) with detected versions and "Check again". Dense and technical; it must still be understood by someone who has only ever typed `python script.py`.
3. **Run approval window** — `approval.html`, `approval.js`. Shows the code, the Workspace it comes from, the language, the environment and the exact program that will start. It is a security decision: what will run, from where, and with what must be unmistakable; the choice between "this once" and "remember" must be hard to get wrong.

**B. The shell of an open Workspace** (`web/src/ui/shell/`)

4. **Rail, top bar, account menu** — including the Local Workspace state, the moved read-only copy's bar ("Moved to <host>. This copy is read-only."), the folded rail in narrow rooms, the For you badge.
5. **Empty Team server's first screen** — `FirstScreen.tsx`; `team-move.md`. Start empty, Bring in a Workspace file…, the one-press move from the desktop app, progress, the answer with names to invite.
6. **Settings** — `web/src/ui/settings/`. Appearance (the three scales must be understood without reading docs), Board, AI access, Runs (languages and environments on this device), Workspace (Change name, Export Workspace file…, Switch workspace / Sign out), About (version, licences).
7. **Members and invites** — unclaimed names ("not signed in yet"), the invite that takes over a name, the page a person sees when accepting such an invite.

**C. Guidance**

8. **The hands-on Tutorial** — `web/src/ui/tutorial/handson/`; `local.md`. Eighteen steps in the rail, each with a title, one to three sentences, a "Try it" line, a ring on its target, Skip / Hide / Leave, the list of all steps, the missing-tool panel, the end summary. It must never cover Board content. Known weakness: it competes with the Frames list above it and can scroll inside the rail at the smallest window.
9. **The Tour** — `web/src/ui/tutorial/`. One family with the Tutorial, clearly the lighter thing.

**D. The Board** (`web/src/ui/board/`)

10. **Toolbars** — + Card / + Frame, Undo / Redo, BibTeX ▾, Export ▾, the zoom control, the counts; the short notes after an Undo ("Undid Move 3 Cards. 1 left as it is — Ana changed it since."); the brief "Board 120 %" indication.
11. **Cards at the three levels** — with the new marks they carry: the Comments count, a Source's PDF, a Run's language. And the far-away view of Connections on large Boards (`docs/specs/scale.md`): below 55 % zoom on Boards with 300 or more Connections they are drawn as one picture without labels — make that transition feel intended.
12. **Export the Board dialog** — SVG / PNG, Visible area only, Light background, scale.
13. **Import BibTeX dialog** — file or paste, what was found and what could not be read, attaching PDFs from a folder, progress, the report.

**E. The Page** (`web/src/ui/page/`, `web/src/ui/pdf/`)

14. **Page header and tools** — Undo / Redo, the ⋯ menu (Export as Markdown, Print…), the print layout.
15. **Sources** — the form with Look up and "Fetch the PDF from arXiv", a Source row with its PDF (name, pages, size, Open PDF, Replace…, Remove PDF), attaching by drop.
16. **The PDF reader** — page navigation, zoom, fit width, find, the no-text notice, Open in the system viewer / Save a copy. It takes the Page panel's place; decide how it relates to the Page it came from.
17. **The Run block** — language and environment when editing; the label ("Run · Julia"); "not set up on this computer" with Open Runner settings; waiting for a choice in the Runner window; the result line ("Python 3.12.3 · numpy 2.1.0, scipy 1.14.1 +5", "Q# · qdk 1.34.0") and the record line ("current code", "ran as Python", "ran in the default environment").
18. **Comments** — `page/comments/`; `team-move.md` decision 9. The thread, `@` completion, edit / delete, Resolve / Reopen, the collapsed resolved thread, the thread of a Card that was removed.

**F. Versioning**

19. **The Branch Graph** — `web/src/ui/branches/`; `docs/specs/branch-graph.md`. Lines, dots, forks, Merge lines, Checkpoint marks, Branch labels with their actions, the detail beside it, the name field that says where a Branch will start. The spec leaves colours, line shapes and spacing to you. It must stay readable with sixty Branches and thousands of rows, and for people who cannot tell the colours apart.
20. **History panel** — now that Activities end at Checkpoints and a preview can come from the graph ("Back to Branches").

**G. Lists outside versioning**

21. **To-dos and For you** — the two tabs, a mention row, the short notice when a mention arrives.

## How to work

- **Directions first, not finished screens.** For the start screen (1), the Tutorial (8) and the Branch Graph (19): two or three distinct directions each, as images or prototypes, with one line on what each optimises for. Wait for my choice.
- **Then the system before the screens.** The engineers added one-off pieces as they went: a row menu, a segmented control, a scale select, a settings row, a step card, a short note (toast), a chip, a count badge, a progress line, a confirmation inside a row, a dialog, a side panel that takes a panel's place. Name each, give it tokens and states, and show it once; the screens then use only these.
- **Then every item A–G**, light and dark, at the default and the smallest window, at 100 % and 150 % interface scale, with every state: empty, busy, error, confirmation, keyboard focus, read-only (a Guest; a moved copy).
- Stay inside the existing design system. Where it lacks something, propose the addition as a token or component so it is reused.
- Calm, deliberate, dense enough for researchers. Not a generic SaaS template: no gradients for decoration, no glass, no cartoon empty states, no emoji.
- Accessibility is not optional: visible focus, contrast in both themes, colour never the only signal, reduced-motion fallbacks, complete keyboard paths.
- Copy: verb-first buttons; errors that say what to do next and never blame; `CONTEXT.md` vocabulary throughout. Flag every existing string you would change and give the replacement. Known ones to settle: "Notes to yourself" (Comments in a Local Workspace), "This Team server is empty", "a file of references".
- Deliver so engineers can implement without guessing: per screen, the tokens and components used, spacing, type styles, the state list, and what changed from today. I approve each screen before it is implemented.
