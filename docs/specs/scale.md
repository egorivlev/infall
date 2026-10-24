# Infall at size

M15 (docs/plans/2026-11-24-road-to-1.0.md): a generator of large Workspaces, the numbers measured with one, what was fixed, and the guard that keeps the numbers from getting worse. Vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## 1. The generator

`cargo run --release -p qoop-server --example big_workspace -- generate --out big.db --file big.infall` writes a new Local Workspace database (`qoop_server::scale::generate`) and, with `--file`, a Workspace file of it that the desktop app's Import takes. The defaults are the M15 size: 2 000 Cards in 80 Frames, 6 000 Connections of all three kinds (some labelled), 200 Pages of text, formula, list and Run Blocks with their Sources attached (three of them "Lab notebook 1–3", 50 screens each, about 170 Blocks), 50 000 Changes, 12 Branches forked from `main` at different moments with every other one merged back (Conflicts decided for the Branch, half of the Merges with a Checkpoint), a Checkpoint on `main` every twelfth of the Changes and one halfway along most Branches, and 60 To-dos; `--cards`, `--connections`, `--pages`, `--long-pages`, `--screens`, `--changes`, `--branches`, `--todos` and `--seed` change that. Every Change is made through the core operations (`record_all`, `fork`, `checkpoint`, `plan_merge`, `apply_merge`) and saved through the store, so the result is an ordinary database. The Changes are by three authors in sessions over about eight months (seed 1: January to August 2026; 66 %, 20 % and 14 % of the Changes) — a few seconds to minutes apart within a session, hours or days between sessions — so they form Activities; edits are what the web UI sends (a move is two Sets, typing is several saves of a growing text, a deletion, a status). The same seed gives the same content (ids, texts, positions, authors, times); only the ids the core makes itself (Changes, Branches, Merge batches) differ. A Local Workspace has one Member, so the two other authors are ids without a Member, as in a Workspace whose collaborators have left. `big_workspace serve --db big.db --web web/dist` serves a database as a Local Workspace on 127.0.0.1 and prints its entry URL; `big_workspace measure --db big.db --web web/dist` times the server on a copy (section 2). The full size takes about half a second to generate in a release build; the database and the Workspace file are 24 MB each.

## 2. How the numbers were taken

Machine: MacBook with an Apple M4, 24 GB, macOS 26, on battery. Release build of the server; the web UI from `npm run build`. One generated Workspace (seed 1), copied fresh for every run; nothing touched a real Workspace.

- **Server**: `big_workspace measure` starts a Local Workspace on a copy (`start_local`, timed), enters it, and over the socket times `GET …/board` of `main` (twice), what History asks for when it opens (`…/changes?after=0`, `…/checkpoints`, `…/board?at=0` together), `GET /api/merges/plan` for the largest unmerged Branch (`second-site`, 2 123 Changes; `main` has 41 211) into `main`, 20 `POST …/ops` moving one Card (median and maximum), then `export_workspace` (also what a backup runs) and `import_workspace` of the file written. Before and after are the two builds run one after the other on the same database.
- **Browser**: `web/bench/board-at-size.mjs` starts Chrome for Testing 1243 with an empty profile at 1440 × 860 and drives it over the DevTools protocol with real input events: opens the entry URL and waits for the first Card element ("first Board"), waits until 500 ms pass with no long task ("interactive"), pans with the trackpad (wheel events every 16 ms for 2.5 s) at the fitted zoom, zooms in and out there, then zooms to 30 %, 60 % and 100 % around a Card found by search and pans at each, clicks a Card (time until it shows selected), drags it for a second, types "replication" into search one key at a time, opens Lab notebook 1 with O, types 38 characters into its eleventh Block, opens History, and opens the Merge review of `second-site` into `main`. Frame rate is from `requestAnimationFrame` (the display runs at 120 Hz; panning is paced by the input events, so 60 is the ceiling for pans); "long tasks" are the browser's Long Tasks (main thread busy over 50 ms). Typing and search are the time from a key to the next frame.
- With a window, Chrome stops producing frames when the window is hidden or the display sleeps, and the run times out; `HEADLESS=1` runs without a window. Headless Chrome paints far less than a window does, so it understates the cost of drawing (see the pan rows). Both are given; the "window" column is what a person at this machine sees.

## 3. Numbers

### Server (release build, same run)

| | before | after |
|---|---|---|
| Generating the Workspace | over 6 min, stopped unfinished | 0.5 s |
| Start (`start_local`) | 48 ms | 47 ms |
| First Board (`GET …/board`, 4.5 MB) | 37 ms (again: 36 ms) | 16 ms (again: 6 ms) |
| History requests (19.7 MB) | 72 ms | 69 ms |
| Merge preview (`GET /api/merges/plan`, 332 KB) | 43 ms | 35 ms |
| One edit (`POST …/ops`), median / max | 72 / 95 ms | 63 / 77 ms |
| Export = backup (24.1 MB file) | 143 ms | 134 ms |
| Import of that file | 72 ms | 71 ms |

An earlier run of both builds, with the machine slower (battery), gave 134 → 115 ms for one edit; the proportions hold. Of one edit, about 14 ms is writing the whole Workspace as JSON (24 MB) and most of the rest is SQLite writing it.

### Browser

| | before, window | after, window | before, headless | after, headless |
|---|---|---|---|---|
| First Board on screen | 1 019 ms | 589 ms | 851 ms | 481 ms |
| Interactive | 1 049 ms | 590 ms | 1 266 ms | 493 ms |
| Long tasks while loading | 234, 512 ms | 230, 156 ms | 212, 459, 66 ms | 196, 136 ms |
| Elements drawn at the start | 2 163 nodes, 6 352 edges | 953 nodes, 0 edges | same | same |
| Pan, fitted view (10 %) | 11 fps, frames up to 450 ms | 58 fps, longest task 66 ms | 55 fps | 58 fps |
| Zoom, fitted view | 13 fps, a 1.3 s task | 120 fps | 42 fps, a 0.5 s task | 116 fps |
| Zooming from 10 % to 30 % | — | — | tasks of 1.6 s, 0.6 s | none over 50 ms |
| Pan at 30 % | 16 fps, tasks to 650 ms | — | 8 fps, tasks to 500 ms | 60 fps |
| Pan at 60 % | 8 fps | — | 56 fps | 60 fps |
| Pan at 100 % | 26 fps, tasks to 520 ms | — | 52 fps | 60 fps |
| Click a Card → shown selected | 2 383 ms | 17 ms | 77 ms | 23 ms |
| Drag a Card | 1.5 fps, tasks to 1.4 s | 60 fps | 25 fps | 60 fps |
| Drop → next frame | 1 962 ms | 46 ms | 88 ms | 47 ms |
| Search, key → frame, mean / max | 954 / 1 731 ms | 16 / 19 ms | 36 / 68 ms | 17 / 22 ms |
| Open a 50-screen Page (171 Blocks) | 624 ms, tasks 158, 367 ms | 159 ms, a 108 ms task | 358 ms, tasks 99, 197 ms | 117 ms, a 71 ms task |
| Typing in it, key → frame, mean / max | 90 / 170 ms, a 60 ms task per key | 17 / 24 ms, none | 84 / 229 ms, a 55 ms task per key | 17 / 24 ms, none |
| Open History (baseline, see 5) | 695 ms, a 417 ms task | 530 ms, a 340 ms task | 672 ms, a 405 ms task | 512 ms, a 342 ms task |
| Open the Merge review | 407 ms, a 110 ms task | 317 ms | 443 ms, a 135 ms task | 308 ms |
| Bytes on first load | 6.0 MB | 6.0 MB | | |

"—": the window stopped getting frames during those steps in the runs that reached them (section 2); the headless column has them. The "after, window" pan and zoom rows at the fitted view were confirmed in three separate runs (54–60 fps panning, 112–120 fps zooming).

## 4. What was fixed

- **Only what is in view is drawn.** From 400 Cards, Frames and Connections on (`DRAW_IN_VIEW_FROM` in web/src/ui/board/index.tsx), React Flow draws only the elements in view (`onlyRenderVisibleElements`). Below that nothing changes. A Card focused from the keyboard that is not drawn yet is focused once it is (a few frames, while the view moves to it).
- **Connections from far away are one picture.** On a Board with 300 or more Connections (`OVERVIEW_FROM`), below the `full` zoom level every Connection is drawn as two paths in one SVG (web/src/ui/board/edges/ConnectionsOverview.tsx: the same lines, arrow heads and bars, following a Card while it is dragged) instead of one SVG per Connection. A trace of the slow pan showed the time going into Chrome's layerization of about 8 800 SVG roots on every frame. What changes for a person: on a large Board, below the `full` level (under 55 %), Connections have no labels and cannot be picked with a click; zooming in to the `full` level brings both back. Smaller Boards are unchanged.
- **The head Board is worked out once per head, not per request.** The core kept no Board: every edit replayed every Change of the Branch to check the new ones (`append_batch`), and every `GET …/board` replayed it again. `Workspace` now keeps the Board at each Branch's head (never stored, never compared, shared by clones until one of them records), and `Workspace::head_board` hands it out; `append_batch` applies the new ops to it in place. Generating the full Workspace went from over six minutes to half a second, and the Board request from replaying 50 000 Changes to none.
- **The Board is written straight to JSON.** `GET …/board` no longer copies every entity and builds a `serde_json::Value` of 4.5 MB before writing it, and it lets go of the Workspace lock before writing.

The interface scale and Board scale maths, the text-selection guard, and every existing test are unchanged.

## 5. Still below target, and why

- **Loading** blocks the main thread twice for about 150–230 ms (parsing 4.5 MB of Board, building the view models, drawing the first 950 Cards). The first Board is on screen in about 0.6 s, well inside the 2 s target, but those two tasks are over the 100 ms line. Next step if it matters: build the view models in a worker, or send the Board without the deleted entities' fields.
- **Each edit rewrites the whole Workspace.** The store keeps the Workspace as one JSON row, so every `POST …/ops` writes all 24 MB again (about 60–115 ms here, growing with history, and 24 MB of disk writes per edit). The UI does not wait for it (edits are applied at once and confirmed later), so nothing on screen stalls, but other requests wait behind the write. The fix is a table of Changes appended to, which is a schema change; it belongs with M18's schema work rather than here.
- **History** opens in about 0.5 s with one 340 ms task (all 50 000 Changes, 19.7 MB, grouped in the browser). Recorded as the baseline only: History and the Branches screen at this size are M15b's (docs/specs/branch-graph.md).
- **Opening a 50-screen Page** has one task of 70–110 ms (rendering 171 Blocks of Markdown and TeX).
- **Each Change** costs the browser about 25 ms of view-model work at this size (copying the entity map, rebuilding Cards and the Page index). It is under the 100 ms line and linear; it would need incremental view models to go further.

## 6. The guard

- `cargo test -p qoop-server --test scale` generates a Workspace a tenth of the size (`Size::small()`: 200 Cards, 600 Connections, 5 000 Changes, 4 Branches) and runs `measure` on it in the debug build, failing when generating takes over 8 s (0.2 s now; replaying per edit made it tens of seconds) or a request is several times slower than now (limits from 1.5 s for one edit to 5 s for export; now 15–80 ms).
- `web/src/ui/board/scale.test.ts` builds a 2 000-Card, 6 000-Connection Board in memory and fails when taking in one Change, rebuilding the nodes of a drag step, drawing the far-away Connections or a search gets clearly slower, or when a Change stops keeping the identity of what did not change.
- The core test `the_remembered_head_board_is_always_the_replayed_one` checks the remembered head Board against a replay after edits, refused batches, clones and forks.
- What needs a GPU (frame rates) is not in the suite: run `web/bench/board-at-size.mjs` against `big_workspace serve` and compare with the table above.

## 7. Not measured

A five-year-old laptop (the plan's yardstick; everything here is an M4, so the window numbers should be read as roughly three times better than such a machine would give); the desktop app's own webview (WKWebView on macOS, WebView2, WebKitGTK) — Chrome was used; Windows and Linux; two Members editing live at once; memory use over a long session; a Guest's Board; the Branches screen; Restore at this size.
