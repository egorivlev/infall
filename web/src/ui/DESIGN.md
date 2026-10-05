# Qoop UI — build brief for M1

The design source is in [/design](../../../design) (`.dc.html` mock-ups: markup with `{{ holes }}` and a script block of sample data). Read the relevant file before building a screen and match it: `Qoop Design System`, `Qoop Board`, `QBoardCanvas`, `QTopBar`, `QRail`, `Qoop Access`. Tokens are already in `src/styles/tokens.css` (dark is default; `[data-theme="light"]`; any `[data-branch]` other than `main` tints the chrome).

Audience: physicists. Dense, calm, precise — a scientific instrument, not a playful whiteboard. No gradients, glass, emoji, or decorative animation.

## Vocabulary (use exactly; see /CONTEXT.md)
Board, Frame, Card, Connection, Branch, Checkpoint, Member, Admin, Guest, Change. Never in UI copy: commit, link, node, canvas, task, chat, user, save/saved (use "Synced"), edit as a noun.

## Foundations
- Fonts (loaded in `index.html`): **IBM Plex Sans** — chrome and controls, 13px body. **IBM Plex Mono** — ids, timestamps, Branch names, Connection labels, and section labels (10px / 500 / uppercase / letter-spacing .07em). **Source Serif 4** — titles of screens and panels (e.g. 28/600), card-open panel title.
- Spacing scale 4, 8, 12, 16, 24, 32, 48. Radii: 3 chips, 5 Cards and buttons, 8 Frames and panels. Put these in CSS custom properties in your stylesheet.
- Controls: buttons 30px high (26 inline, 34–38 primary), inputs 32–36px, 1px `--q-line` borders. Primary = `--q-accent` background with `--q-accent-ink` text. Destructive text uses `--q-danger`; never a red-filled button.
- Focus: every interactive element shows a visible 2px `--q-accent` focus ring on keyboard focus (`:focus-visible`). Disabled = `--q-ink-3` text, transparent background, `cursor: not-allowed`.
- Motion: 120–160ms ease-out on opacity/transform only; none under `prefers-reduced-motion`.
- Real semantics: `<button>`, `<a href>`, `<input>` with `<label>`; `aria-label` on icon-only buttons with a `title` tooltip; text contrast ≥ 4.5:1.
- Styling: plain CSS files with the `--q-*` tokens (no CSS framework). One stylesheet per area.

## Status — never colour alone: colour + shape + word
| Status (wire) | Label | Shape | Token |
|---|---|---|---|
| `idea` | Idea | outlined diamond | `--q-st-idea` |
| `reading` | Reading | circle, right half filled | `--q-st-reading` |
| `understood` | Understood | filled circle | `--q-st-understood` |
| `open_question` | Open question | ring with "?" | `--q-st-question` |
| `dead_end` | Dead end · kept | horizontal dash + vertical bar | `--q-st-dead` |

Dead-end Cards look deliberately kept, not like errors: 135° hatch at ~9% mix, 5% tinted background, softened border, italic serif summary. No red, no strike-through. Build one `<StatusGlyph status size />` SVG component and reuse it everywhere.

## Chrome (shell)
- Grid: top bar 44px across the top; left rail 224px; the rest is the work area. Min window 1280px wide; no mobile layout, but nothing may overflow horizontally at 1280.
- Top bar (see `QTopBar`): logo + "Qoop"; Branch pill showing `main` (mono, 600) — in M1 it is display-only (no switcher menu; `title="Branches arrive in a later version"` is not needed, just make it non-interactive text in a bordered pill); search field "Search Cards" with ⌘K hint that filters Cards by title/summary and jumps to the chosen one; presence avatars ("On main" label + overlapping 24px circles with initials, `title` = name); theme toggle; account menu (name, role, "Sign out"; Admins also get "Members").
- Rail (see `QRail`): nav item "Board" (active) and, for Admins, "Members"; a "Frames" section listing each Frame with its Card count — click jumps the Board to that Frame; "+" adds a Frame; footer shows sync state from `useBoard().status`: "Synced" (green dot) / "Reconnecting…" (amber) / "Offline" and the host name.
- Do **not** show History, Checkpoint, To-dos, Suggestions, Sources or AI controls — they do not exist yet.

## Board (see `QBoardCanvas`, `Qoop Board` 1a/1b)
- Pan: drag empty space or two-finger scroll. Zoom: wheel/pinch, 10–200%, plus a small HUD bottom-right with −, %, +, "Fit". Dot grid 24px in `--q-grid`.
- Semantic zoom: ≥55% full Card; 30–55% compact (title + status glyph/short word, no summary); <30% tile (status-tinted block with glyph only; Connection labels hidden). Frame titles scale up as you zoom out so they stay legible.
- **Card** 224×132, radius 5, `--q-raised`, 1px `--q-line`; padding 9/11/8. Top row: status glyph + status word (mono 9.5px caps). Title 13/600/1.3 (2-line clamp). Summary 11.5/1.38 (2-line clamp), `--q-ink-2`. Selected: accent border + 2px `--q-accent-soft` ring.
- **Frame**: 1px `--q-line-soft` box, radius 8, faint fill, title above its top-left in sans 15/600 + Card count in mono. Membership is geometric (a Card whose centre is inside the Frame counts). Frames sit behind Cards.
- **Connection**: cubic curve between Card edge midpoints; 1.2px `--q-ink-3` at 60% opacity, full opacity `--q-ink-2` when touching the selected Card. `directed` → open chevron arrowhead at the `to` end; `contradicts` → short perpendicular bar cap at both ends; `related` → plain. Label chip at the midpoint: mono 10.5/500, `--q-canvas` background, 1px `--q-line-soft`, radius 3.

### Interactions (not in the mock-ups — these are the rules)
- Double-click empty space → new Card there (status `idea`), title immediately editable. Also a "+ Card" button in a small toolbar top-left of the Board, and "+ Frame" (creates a 520×360 Frame at the viewport centre).
- Click selects; Shift-click adds to selection; drag a selected Card moves all selected. Positions are sent once, on drop. Dragging a Frame moves only the Frame (Cards do not follow in M1). Frames resize from their corners.
- Double-click a Card's title or summary → edit in place; Enter (title) / ⌘Enter (summary) or blur confirms; Esc cancels. Empty title is allowed but shows the placeholder "Untitled" in `--q-ink-3`.
- Click the status glyph on a selected Card → small menu of the five statuses (glyph + word).
- Drag from a Card's edge handle (shown on hover/selection) to another Card → new Connection (`related`). Click a Connection to select; a small popover offers the three kinds and a label field.
- Delete/Backspace removes the selection (Cards, Frames, Connections) — immediately, no dialog, with an "Undo" toast for 6 s that restores them (`ops.restore`). Deleting a Card leaves its Connections alone (they hide by themselves).
- Selecting one Card opens a 320px inspector on the right edge of the Board: title, summary (multi-line), status picker, its Connections as a list ("→ Title", "— Title") that selects the other Card on click, and "Delete Card". This is the M1 stand-in for the Page panel.
- Keyboard: Tab moves between Cards in reading order; Enter edits the title; arrow keys nudge the selection by 8 (Shift: 24); ⌘A selects all Cards; Esc clears selection.
- Read-only (`useBoard().readOnly`): no creation, drag, edit or delete affordances at all.
- Failures: if `board.submit` rejects, show a toast "That Change could not be applied — the Board was updated meanwhile." with the server message in a `title`; never an alert.
- Empty Board: centred, quiet prompt — serif "Nothing on this Board yet", one line "Double-click anywhere to add the first Card.", and a "+ Card" button. No illustration.
- Loading: nothing for the first 150 ms, then a plain "Loading Board…" in `--q-ink-3`; no spinner art.

## Access screens (see `Qoop Access`)
- Login: centred 380px card on `--q-sunken`: logo, serif "Sign in to Qoop", Email, Password, "Sign in". Under it: "Forgot your password? Ask your Admin." Errors appear inline under the form, in plain words ("That email and password don't match." / "Too many attempts. Try again in a few minutes."). No sign-up link — accounts are by invite only.
- Accept invite (`/invite/<token>`): looks up the invite; shows "You're invited as a Member/Guest — <email>"; fields Name, Password (min 12, with the rule stated up front, not only on error), "Join Qoop". Expired/used invite → a calm full-card message "This invite is no longer valid. Ask your Admin for a new one."
- Members (Admin only; see 11c): table of Members (avatar, name, email, role; "Remove" with a confirm dialog that names the person; you cannot remove yourself), pending invites with "Revoke", and an invite form (Email, Role Member/Guest, "Access until" date shown only for Guest) — on success show the invite URL in a read-only field with a "Copy" button and the line "This is shown once. It expires in 7 days."

---

# M2 — Branches, Checkpoints, History, Restore

Design source: `design/QTopBar.dc.html` (Branch switcher, Checkpoint and History buttons), `design/Qoop Team.dc.html` screens **7a History timeline** and **8a Branches**, `design/Qoop Board.dc.html` screen **2a** (chrome on a non-main Branch). Data layer: [CONTRACT.md](../lib/CONTRACT.md) "M2". Everything in "Foundations" above still applies. Not in M2 (do not show): Compare, Merge, "vs main" numbers, the divergence graph, To-dos, AI.

Vocabulary: Branch, Checkpoint, History, Activity, Change, Restore. Never "commit", "version", "snapshot", "revert", "save".

## Routes (shell)
- `/` → Board of `main`. `/b/<encodeURIComponent(name)>` → Board of that Branch (names may contain `/`). `/branches` → Branches screen. `/members` as before.
- The Branch in the URL is the truth: the shell calls `board.open(name)` when it changes. Unknown Branch → quiet full-area message "There is no Branch called “x”." with a link "Go to main". `/branches` and `/members` keep the last Branch open (and its name in the top bar); links back to the Board go to that Branch.
- `data-branch={name}` on the shell root already tints the chrome for any Branch other than `main` (tokens do it); also show the 2px `--q-branch` line at the very top of the top bar on a non-main Branch.
- Guests: no switcher, no Checkpoint/History buttons, no `/branches` (redirect to `/`).

## Top bar
- **Branch pill → switcher** (`QTopBar` lines 20–45): a real `<button aria-haspopup="menu">` labelled "BRANCH <name>"; opens a 320px menu: section label "Branches", one row per Branch (name in mono 600 — `main` in ink, others in `--q-branch`; under it a meta line in `--q-ink-3`: "default Branch" for main, else "from <parent Branch name> · <creator first name> · <date>"; "✓" on the current one), a divider, then "New Branch from now…" and "All Branches…" (both go to `/branches`; the first focuses the name field). Arrow keys move, Enter chooses, Esc closes and returns focus. Choosing a Branch navigates to its route.
- **Checkpoint** button (diamond icon + "Checkpoint", title "Name this moment of the Branch"): opens a small popover with one labelled field "Checkpoint name", placeholder "e.g. Before decoder rewrite", buttons "Create Checkpoint" (primary) and "Cancel". Enter submits. On success: close and toast-free confirmation inline is not needed — the button briefly reads "◆ Created" for 2 s (aria-live polite). `409 name_taken` → inline "This Branch already has a Checkpoint with that name." Other failures → inline plain sentence.
- **History** button (clock icon + "History", `aria-pressed`): calls `historyPanel.toggle()` from `ui/bridge`; pressed look (`--q-hover` background, `--q-line` border) while open. If the Board is not showing, go to the Board first.

## Branches screen (`/branches`, 8a)
Two columns: list (fluid) and a 340px "New Branch" panel on the right.
- Header: serif 22/600 "Branches" + mono count "3 Branches".
- Table (grid rows, header in mono caps): **Branch** (name, mono 600, coloured as in the switcher; current one marked "open"), **Started from** ("—" for main; else "<parent name> · <date time>"; if a Checkpoint sits exactly at that moment on the parent: "◆ <Checkpoint name>"), **Created by** (name), **Changes** (mono count = `seq`), and an action cell: "Open" (link to the Branch route) — for main "default Branch" in `--q-ink-3` plus "Open".
- New Branch panel: serif 17/600 "New Branch"; the line "A Branch is a full copy of the Board. Work on it stays there until you Merge."; field "Name" (required, ≤ 60, trimmed); radio group "Start from": "Now — <open Branch> as of <time>" (default) or "A Checkpoint" with a `<select>` of the open Branch's Checkpoints, newest first, "◆ name · date" (radio disabled with the note "This Branch has no Checkpoints yet." when there are none); primary button "Create Branch and switch to it". On success navigate to the new Branch. `name_taken` → "A Branch with that name already exists." under the field. The Checkpoint list needs `history.open()` (call it on mount; do not close it if the History panel is open).
- Rail: add nav item "Branches" under "Board" (not for Guests).

## History panel (7a) — inside the Board area
- When `useHistoryPanel().open`: the Board area splits vertically — canvas above, a 286px panel below (1px `--q-line` top border, `--q-surface`). Call `history.open()` when it opens and `history.close()` when it closes or the Board unmounts. Esc (when focus is in the panel) closes it.
- Panel = timeline (fluid) + a 300px detail column on the right.
- **Timeline header**: "History of <branch>" (600) + mono "18 Activities · 76 Changes · 4 Checkpoints".
- **Lanes**: one row per Member who has Changes here (24px avatar with initials at the left, in their colour). The x axis is **Activity order, evenly spaced** (not linear time — real work comes in bursts); each Activity is a block in its author's lane, width 6 + 3×min(count, 12) px, coloured with the Member colour when at or before the scrub position and `--q-line` after it; the selected one has a 2px `--q-st-reading` outline. Restore Activities show a small "↺" glyph instead of a plain block. Each block is a `<button>` with `title`/`aria-label` "<Name> · <date time> · N Changes". A date tick row under the lanes labels the first Activity of each day ("14 Nov"). If there are more Activities than fit at ≥ 14px per step, the timeline scrolls horizontally and keeps the selected Activity in view.
- **Checkpoints**: a row above the lanes with a ◆ marker and the name (mono 10.5, truncated with a `title`) at the Activity that contains each Checkpoint; clicking one scrubs to exactly that Checkpoint's moment.
- **Scrubber**: an `<input type="range">` under the lanes, one step per Activity boundary: 0 … N, where N = now (`aria-valuetext` = the date/time or "now"). Position k < N previews the moment after Activity k (`history.preview(activities[k-1].toSeq)`; k = 0 → seq 0); k = N → `history.preview(null)`. Arrow keys step.
- **Detail column**: avatar + name + when (date, time range if it spans minutes); mono line "N Changes in this Activity"; the `lines` as a "· …" list; a divider; button "Restore <branch> to here" (outlined, not red); and the small print "Restoring adds new Changes that bring the Board back to this moment. Nothing is deleted — undo it from History at any time." At "now" the column instead says "This is the Board as it is now." with no button. Empty history: "No Changes on this Branch yet."
- **Restore**: one click, no dialog (it is undoable). While in flight the button reads "Restoring…" and is disabled. On success: scrub returns to now, and a toast "Restored <branch> to <when>." with an "Undo" action for 10 s that restores to the head seq from just before. Failure → toast with the plain message.
- **Preview on the canvas**: while `useHistory().preview` is set, the canvas renders the preview's Cards/Frames/Connections instead of the live Board, fully read-only (no creation, drag, edit, delete, handles, toolbar, or inspector edits — selecting a Card may show the inspector read-only or nothing; simplest: no inspector), slightly desaturated (`filter: saturate(.7)` on the canvas only), with a banner centred at the top: "Previewing **<branch>** at **<when>**" + mono chip "read-only" + button "Back to now". Pan and zoom keep working and the viewport must not jump when scrubbing.
- Loading: "Loading History…" after 150 ms. Error: plain sentence + "Try again".


---

# M3 — Merge review

Design source: `design/Qoop Merge.dc.html` (screen 9a — match it), and `design/Qoop Team.dc.html` 8a for the entry points. Data layer: [CONTRACT.md](../lib/CONTRACT.md) "M3" (`useMerge`, `merge`, `mergeOptions`). Vocabulary: Merge, Conflict, Branch, Checkpoint, Change, Restore. Never "pull request", "commit", "rebase", "resolve" as a noun, "ours/theirs".

## Entry points (Branches screen)
- Each non-main row gains actions next to "Open": "Merge into <parent>…" and "Update from <parent>…" (the reverse direction: brings the parent's newer work into this Branch). Both are links to the Merge route. Use `mergeOptions`.
- Route: `/merge?from=<encoded source name>&into=<encoded target name>`. Not for Guests (redirect to `/`). The top bar keeps showing the last open Branch.

## Screen (9a) — fills the work area, scrolls inside
- **Header bar** (sticky): serif "Merge **<source>** into **<target>**" (source in `--q-branch` unless it is main); under it one line: "<target> doesn’t change until you press Merge. A Checkpoint is created on <target> first." Then, right-aligned: "**k of n** Conflicts decided" with n small segments (accent when decided), "Cancel" (link back to `/branches`), and the primary button: disabled "Merge · k left" with `title="Decide all Conflicts first"` until all are decided, then "Merge into <target>"; "Merging…" while applying.
- **Left column, 240px** ("Review"): "✓ Merges automatically  N", then "Conflicts" with one anchor link per Conflict (short title, and "Needs a decision" in `--q-st-question` or "Decided · <side>"); clicking scrolls to it and moves focus to its heading.
- **Main column** (max 860px):
  - "Merges automatically" disclosure (`<button aria-expanded>`): summary line from `autoSummary`; expanded: one row per `AutoLine` — kind in mono caps, then what.
  - If `layoutKept > 0`, the note: "**Card positions follow <target>.** N Cards and Frames that were moved on <source> keep their <target> position and are not listed as Conflicts."
  - One block per Conflict: number "01", type chip ("Same field" / "Edited · deleted"), kind + title ("Card: Threshold ≈ 1%"), `headline`, and state at the right ("Needs a decision" / "✓ Decided: <target name>"). Undecided blocks have the `--q-st-question`-tinted border. Options as a radio group of large buttons (`role="radio"` in a `role="radiogroup"`, arrow keys move): one for <target> (first, as in the mock-up) and one for <source>, each with the Branch name, who/when if known (name · date), and the value (serif 15 for short text; a Status shows its glyph + word in status colour); if `canEdit`, a third "Edit by hand" which reveals a labelled textarea "Your value — this is what <target> will get", pre-filled with the source text; typing updates the choice (`{ custom }`).
  - Checkpoint: a labelled field "Checkpoint on <target> before merging" with `checkpointName`, placed under the Conflicts; `name_taken` → inline "<target> already has a Checkpoint with that name."
- **States**: loading "Preparing the Merge…" (after 150 ms). `nothingToMerge`: quiet message "<target> already has everything from <source>." + link back. `not_parent_and_child`: "A Branch can only be merged with the Branch it was started from." Unknown Branch: "There is no Branch called …". `replanned`: a notice at the top of the main column, `role="status"`: "A Branch changed while you were reviewing. The review was updated — check your decisions and Merge again." Other apply failures: inline plain sentence above the button area, never an alert.
- **After merging**: the header button reads "Merged ✓" (disabled) and a success banner replaces the notice area: "✓ Merged into <target>. Checkpoint “<name>” was created — Restore to it from History to undo." with links "Open <target>" and "Back to Branches". Options become read-only.
- Call `merge.open(from, into)` on mount/param change and `merge.close()` on unmount (StrictMode-safe).
